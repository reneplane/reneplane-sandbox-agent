import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { RunResult, TestCheck } from '../protocol.js';
import { runCommand, type Env } from '../util/process.js';
import { render, shellCommand, type Vars, type WorkspaceFile } from './workspace.js';

/**
 * Run the visible tests and turn their JUnit XML into the IDE's RunResult. One parser covers Vitest,
 * pytest, Maven Surefire and dotnet test (JUnit logger), so every stack reports the same way.
 */

type Step = WorkspaceFile['test'][number];

export async function runTests(options: {
  steps: Step[];
  repo: string;
  outRoot: string;
  vars: Vars;
  env: Env;
  onLine: (line: string) => void;
}): Promise<RunResult> {
  const started = Date.now();
  const id = `run_${started.toString(36)}`;
  const out = join(options.outRoot, id);
  rmSync(options.outRoot, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const vars = { ...options.vars, out };

  const checks: TestCheck[] = [];
  const buildLog: string[] = [];
  let buildOk = true;

  for (const step of options.steps) {
    // Reports inside the repo (e.g. Surefire's target/surefire-reports) are relative to the repo root.
    // Clear them first, so a build that fails can't be read as the previous run's results.
    const report = resolve(options.repo, render(step.junit, vars));
    rmSync(report, { recursive: true, force: true });
    options.onLine(`\u001b[2m$ ${render(step.run, { ...vars, 'db.password': '••••' })}\u001b[0m`);
    const result = await runCommand(shellCommand(render(step.run, vars)), {
      cwd: join(options.repo, step.cwd),
      env: options.env,
      onLine: options.onLine,
      timeoutMs: 15 * 60_000,
    });
    const found = readJunit(report, step.layer, checks.length);
    if (!found.length && result.code !== 0) {
      // No report and a failure exit: it didn't compile or couldn't start, so no test ran
      buildOk = false;
      buildLog.push(`${step.name} failed before any test ran (exit code ${result.code}):`, ...result.output.slice(-40));
    }
    checks.push(...found);
  }

  const passed = checks.filter((check) => check.status === 'passed').length;
  const failed = checks.filter((check) => check.status === 'failed' || check.status === 'error').length;
  return {
    id,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    build: { ok: buildOk, log: buildLog },
    checks,
    passed,
    failed,
  };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  isArray: (name) => name === 'testsuite' || name === 'testcase',
  // pytest writes line breaks in attributes as &#10;
  htmlEntities: true,
});

interface XmlCase {
  name?: string;
  classname?: string;
  time?: string;
  failure?: unknown;
  error?: unknown;
  skipped?: unknown;
}

/**
 * Read a test report: JUnit XML (Vitest, pytest, Surefire), or a TRX file from `dotnet test`, which
 * keeps xUnit's [Fact(DisplayName = …)] names and its Expected/Actual lines.
 */
export function readJunit(location: string, layer: TestCheck['layer'], offset = 0): TestCheck[] {
  if (!existsSync(location)) return [];
  const files = statSync(location).isDirectory()
    ? readdirSync(location)
        .filter((file) => file.endsWith('.xml') || file.endsWith('.trx'))
        .map((file) => join(location, file))
    : [location];
  const checks: TestCheck[] = [];
  for (const file of files) {
    const document = parser.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (document.TestRun) {
      checks.push(...readTrx(document.TestRun as Record<string, unknown>, layer, offset + checks.length));
      continue;
    }
    for (const testcase of collectCases(document)) {
      const failure = testcase.failure ?? testcase.error;
      const status: TestCheck['status'] = failure !== undefined ? (testcase.error !== undefined ? 'error' : 'failed') : testcase.skipped !== undefined ? 'skipped' : 'passed';
      const detail = failure === undefined ? null : describeFailure(failure);
      checks.push({
        id: `t${offset + checks.length + 1}`,
        name: displayName(testcase),
        layer,
        status,
        durationMs: Math.round(Number(testcase.time ?? 0) * 1000),
        message: detail?.message ?? null,
        expected: detail?.expected ?? null,
        actual: detail?.actual ?? null,
      });
    }
  }
  return checks;
}

interface TrxResult {
  testName?: string;
  outcome?: string;
  duration?: string;
  Output?: { ErrorInfo?: { Message?: string; StackTrace?: string } };
}

function readTrx(run: Record<string, unknown>, layer: TestCheck['layer'], offset: number): TestCheck[] {
  const results = (run.Results as { UnitTestResult?: TrxResult | TrxResult[] } | undefined)?.UnitTestResult;
  const list = Array.isArray(results) ? results : results ? [results] : [];
  return list.map((result, index) => {
    const outcome = String(result.outcome ?? '');
    const status: TestCheck['status'] = outcome === 'Passed' ? 'passed' : outcome === 'Failed' ? 'failed' : outcome === 'Error' ? 'error' : 'skipped';
    const full = String(result.Output?.ErrorInfo?.Message ?? '').trim();
    const detail = status === 'failed' || status === 'error' ? describeText(full) : null;
    const [hours = '0', minutes = '0', seconds = '0'] = String(result.duration ?? '0:0:0').split(':');
    return {
      id: `t${offset + index + 1}`,
      name: String(result.testName ?? 'test'),
      layer,
      status,
      durationMs: Math.round((Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000),
      message: detail?.message ?? null,
      expected: detail?.expected ?? null,
      actual: detail?.actual ?? null,
    };
  });
}

function collectCases(node: unknown): XmlCase[] {
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const cases: XmlCase[] = [];
  if (Array.isArray(record.testcase)) cases.push(...(record.testcase as XmlCase[]));
  for (const [key, value] of Object.entries(record)) {
    if (key === 'testcase') continue;
    if (Array.isArray(value)) value.forEach((child) => cases.push(...collectCases(child)));
    else if (typeof value === 'object') cases.push(...collectCases(value));
  }
  return cases;
}

/** "describe > it" from Vitest, "test_x" from pytest, "method" from Surefire: keep it readable */
function displayName(testcase: XmlCase): string {
  const name = String(testcase.name ?? 'test');
  if (/^test_/.test(name)) return name.replace(/^test_/, '').replace(/_/g, ' ');
  return name;
}

function describeFailure(failure: unknown): { message: string; expected: string | null; actual: string | null } {
  const node = Array.isArray(failure) ? failure[0] : failure;
  const attributes = typeof node === 'object' && node ? (node as Record<string, string>) : {};
  const text = typeof node === 'string' ? node : (attributes['#text'] ?? '');
  return describeText(attributes.message ?? text);
}

function describeText(full: string): { message: string; expected: string | null; actual: string | null } {
  // xUnit: "Assert.Equal() Failure: Values differ\nExpected: 6\nActual:   4"
  const xunit = /Expected:\s*(.+?)\r?\n\s*Actual:\s*(.+)/.exec(full);
  const firstLine = full.split('\n').find((line) => line.trim())?.trim() ?? 'Failed';
  if (xunit) return { message: `${firstLine} (expected ${xunit[1]!.trim()}, got ${xunit[2]!.trim()})`, expected: xunit[1]!.trim(), actual: xunit[2]!.trim() };
  const message = firstLine;
  // Vitest/Jest: "expected 4 to be 6"; JUnit/AssertJ: "expected: <6> but was: <4>"; pytest: "assert 4 == 6"
  const jest = /expected (.+?) to (?:be|equal|deeply equal) (.+)$/i.exec(message);
  if (jest) return { message, expected: jest[2]!.trim(), actual: jest[1]!.trim() };
  const junit = /expected:?\s*<(.+?)>\s*but was:?\s*<(.+?)>/i.exec(message);
  if (junit) return { message, expected: junit[1]!, actual: junit[2]! };
  return { message, expected: null, actual: null };
}
