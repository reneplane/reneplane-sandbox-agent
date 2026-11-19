import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Mission } from '../mission/mission.js';
import { BundleSource } from '../mission/source.js';
import { parseWorkspace } from '../mission/workspace.js';
import type { AgentEvent, RunResult } from '../protocol.js';
import { runFile } from '../util/process.js';
import { tarGz } from '../util/tar.js';
import { ADAPTERS, checkRules, hardcodedConfig } from './adapters.js';
import { buildTemplate, compileVariant, scratch, sha256File, walk, type CompileContext } from './compile.js';
import { buildStarterRepo, writeBundle } from './history.js';
import { matchesAny, splitPatch } from './patch.js';
import { project, ProjectionError } from './project.js';
import { listFiles, unusualEntries } from './repo.js';
import { parseSeed, seedSql } from './seed.js';
import { loadCodebank, loadStackGrade, SpecError, type LoadedCodebank } from './spec.js';

/**
 * `reneplane-local codebank check`: is this repository fit to connect to the workspace? Three levels,
 * each only if the one before passed:
 *
 *   structure   files, schemas and the contract (seconds; every push)
 *   stacks      each stack's healthy product boots, migrates, seeds and passes its visible tests
 *   problems    each problem × stack: the starter boots and fails as expected; the reference passes
 *
 * Booting uses the agent's own Mission engine, exactly what runs on a learner's computer. The hidden
 * tests are run by the grader when a release is compiled, not here.
 */

export type Status = 'pass' | 'fail' | 'warn' | 'skip';

export interface CheckResult {
  id: string;
  title: string;
  status: Status;
  detail?: string;
  /** The last lines of output when something failed */
  log?: string[];
  durationMs?: number;
}

export interface CheckReport {
  codebank: string;
  commit: string;
  level: 'quick' | 'full';
  ok: boolean;
  summary: string;
  durationMs: number;
  results: CheckResult[];
}

export interface CheckOptions {
  root: string;
  level: 'quick' | 'full';
  stacks?: string[];
  problems?: string[];
  gitFor: CompileContext['gitFor'];
  onResult?: (result: CheckResult) => void;
  onProgress?: (line: string) => void;
  /** Keep the work folder (projections, repos, missions) for a look afterwards */
  keep?: boolean;
}

const BOOT_BUDGET_MS = 3 * 60_000;

export async function checkCodebank(options: CheckOptions): Promise<CheckReport> {
  const started = Date.now();
  const results: CheckResult[] = [];
  const add = (result: CheckResult) => {
    results.push(result);
    options.onResult?.(result);
    return result;
  };
  const git = await options.gitFor(options.root);
  const commit = (await git.run(['rev-parse', 'HEAD']).catch(() => 'uncommitted')).trim();

  let codebank: LoadedCodebank;
  try {
    codebank = loadCodebank(options.root);
    add({ id: 'spec', title: 'codebank.yaml and problem.yaml files', status: 'pass', detail: `${Object.keys(codebank.spec.stacks).length} stacks, ${codebank.problems.length} problems` });
  } catch (error) {
    add({ id: 'spec', title: 'codebank.yaml and problem.yaml files', status: 'fail', detail: error instanceof SpecError ? error.message : (error as Error).message });
    return finish(options, 'unknown', commit, results, started);
  }

  const work = scratch('reneplane-check-');
  const context: CompileContext = { codebank, git, gitFor: options.gitFor, work, onProgress: options.onProgress };
  const stacks = Object.keys(codebank.spec.stacks).filter((stack) => !options.stacks || options.stacks.includes(stack));
  const problems = codebank.problems.filter((problem) => !options.problems || options.problems.includes(problem.spec.id));

  await structure(context, stacks, problems, add);
  if (options.level === 'full' && results.every((result) => result.status !== 'fail')) {
    const docker = await hasDocker();
    for (const stack of stacks) await checkStack(context, stack, docker, add, options.onProgress);
    for (const problem of problems) {
      for (const stack of Object.keys(problem.spec.stacks).filter((name) => stacks.includes(name))) {
        await checkProblem(context, problem.spec.id, stack, docker, add, options.onProgress);
      }
    }
  }
  if (!options.keep) {
    const { rmSync } = await import('node:fs');
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } else options.onProgress?.(`work folder kept: ${work}`);
  return finish(options, codebank.spec.id, commit, results, started);
}

function finish(options: CheckOptions, id: string, commit: string, results: CheckResult[], started: number): CheckReport {
  const failed = results.filter((result) => result.status === 'fail').length;
  const warned = results.filter((result) => result.status === 'warn').length;
  const passed = results.filter((result) => result.status === 'pass').length;
  const ok = failed === 0;
  const summary = ok
    ? `Reneplane-ready: ${passed} checks passed${warned ? `, ${warned} warnings` : ''}`
    : `Not ready: ${failed} failing, ${passed} passed${warned ? `, ${warned} warnings` : ''}`;
  return { codebank: id, commit, level: options.level, ok, summary, durationMs: Date.now() - started, results };
}

// ---- structure -------------------------------------------------------------------------------------

async function structure(context: CompileContext, stacks: string[], problems: LoadedCodebank['problems'], add: (result: CheckResult) => CheckResult): Promise<void> {
  const { codebank, git } = context;
  const files = await listFiles(git);
  const paths = files.map((file) => file.path);

  // Paths every OS and every tool handles the same way
  const quoted = paths.filter((path) => !/^[\x20-\x7e]+$/.test(path) || /["\\]/.test(path));
  const lower = new Map<string, string>();
  const collisions: string[] = [];
  for (const path of paths) {
    const key = path.toLowerCase();
    if (lower.has(key)) collisions.push(`${lower.get(key)} / ${path}`);
    lower.set(key, path);
  }
  const unusual = await unusualEntries(git);
  const pathIssues = [
    ...quoted.map((path) => `${path}: use plain ASCII names`),
    ...collisions.map((pair) => `${pair} differ only by case (Windows and macOS can't hold both)`),
    ...unusual.map((path) => `${path}: symlinks and submodules aren't supported`),
  ];
  add({ id: 'paths', title: 'File names', status: pathIssues.length ? 'fail' : 'pass', detail: pathIssues.slice(0, 10).join('; ') || `${paths.length} files` });

  const attributes = existsSync(join(codebank.root, '.gitattributes')) ? readFileSync(join(codebank.root, '.gitattributes'), 'utf8') : '';
  // Files copied in on Windows keep CRLF until git checks them out again; projections read the working
  // tree, so they'd ship CRLF and patches made from the (LF) history wouldn't apply to them
  const crlf = (await git.run(['ls-files', '--eol']))
    .split('\n')
    .filter((line) => /^i\/lf\s+w\/crlf\s/.test(line) && !/eol=crlf/.test(line))
    .map((line) => line.split('\t').pop()!);
  const endingIssues = [
    ...(/^\*\s+text=auto(\s+eol=lf)?\s*$/m.test(attributes) ? [] : ['.gitattributes needs "* text=auto eol=lf" so Windows checkouts and diffs match everyone else']),
    ...(crlf.length ? [`${crlf.length} files have CRLF in the working tree but LF in git (${crlf.slice(0, 3).join(', ')}…); run: git rm -r -q --cached . && git reset -q --hard`] : []),
  ];
  add({ id: 'line-endings', title: 'Line endings', status: endingIssues.length ? 'fail' : 'pass', detail: endingIssues.join('; ') || undefined });

  add({
    id: 'workflow',
    title: 'CI workflow',
    status: existsSync(join(codebank.root, '.github', 'workflows', 'reneplane.yml')) ? 'pass' : 'warn',
    detail: existsSync(join(codebank.root, '.github', 'workflows', 'reneplane.yml')) ? undefined : '.github/workflows/reneplane.yml is missing: without it the platform never hears about this codebank',
  });

  if (codebank.spec.seed) {
    try {
      const seed = parseSeed(readFileSync(join(codebank.root, ...codebank.spec.seed.split('/')), 'utf8'), codebank.spec.seed);
      for (const engine of new Set(Object.values(codebank.spec.stacks).map((stack) => stack.engine))) seedSql(seed, engine);
      add({ id: 'seed', title: 'Seed data', status: 'pass', detail: `${seed.tables.length} tables` });
    } catch (error) {
      add({ id: 'seed', title: 'Seed data', status: 'fail', detail: (error as Error).message });
    }
  }

  for (const stack of stacks) {
    const spec = codebank.spec.stacks[stack]!;
    const id = `stack:${stack}`;
    try {
      const tree = await project(git, codebank, stack, join(context.work, 'structure', stack));
      const treeFiles = walk(tree.dir);
      const issues = checkRules(spec.adapter, tree.dir, (pattern) => treeFiles.filter((path) => pattern.test(path)));
      const workspaceFile = join(tree.dir, '.reneplane', 'workspace.yaml');
      if (!existsSync(workspaceFile)) issues.push('.reneplane/workspace.yaml is missing');
      else {
        try {
          const workspace = parseWorkspace(readFileSync(workspaceFile, 'utf8'));
          if (workspace.database.engine !== spec.engine) issues.push(`workspace.yaml says ${workspace.database.engine}, codebank.yaml says ${spec.engine}`);
          if (spec.adapter !== 'sql' && !workspace.services.backend) issues.push('workspace.yaml has no backend service');
          if (workspace.services.backend && !/\/health/.test(workspace.services.backend.ready)) issues.push('the backend service should be ready at a health endpoint (GET /api/health)');
        } catch (error) {
          issues.push(`.reneplane/workspace.yaml: ${(error as Error).message}`);
        }
      }
      for (const path of treeFiles.filter((file) => ADAPTERS[spec.adapter].sources.test(file) && !/(^|\/)(node_modules|target|bin|obj|\.venv)\//.test(file))) {
        const lines = readFileSync(join(tree.dir, path), 'utf8').split('\n');
        lines.forEach((line, index) => {
          const found = hardcodedConfig(line);
          if (found) issues.push(`${path}:${index + 1}: ${found}`);
        });
      }
      if (problems.some((problem) => problem.spec.kind === 'app' && problem.spec.stacks[stack])) {
        if (!loadStackGrade(codebank.root, stack)) issues.push(`stacks/${stack}/.reneplane/grade.yaml is missing (how the grader builds this stack)`);
      }
      add({ id, title: `Stack ${stack}: structure`, status: issues.length ? 'fail' : 'pass', detail: issues.slice(0, 12).join('; ') || spec.label });
    } catch (error) {
      add({ id, title: `Stack ${stack}: structure`, status: 'fail', detail: (error as Error).message });
    }
  }

  for (const problem of problems) {
    const base = join(codebank.root, ...problem.dir.split('/'));
    const issues: string[] = [];
    if (!existsSync(join(base, ...problem.spec.brief.split('/')))) issues.push(`brief ${problem.spec.brief} is missing`);
    if (!existsSync(join(base, ...problem.spec.hidden.split('/')))) issues.push(`hidden suite ${problem.spec.hidden} is missing`);
    for (const stack of Object.keys(problem.spec.stacks).filter((name) => stacks.includes(name))) {
      try {
        const starter = await project(git, codebank, stack, join(context.work, 'structure', `${problem.spec.id}-${stack}`), { problem, side: 'starter' });
        if (!walk(starter.dir).length) issues.push(`${stack}: the starter is empty`);
      } catch (error) {
        issues.push(error instanceof ProjectionError ? error.message : `${stack}: ${(error as Error).message}`);
      }
    }
    add({ id: `problem:${problem.spec.id}`, title: `Problem ${problem.spec.id}: structure`, status: issues.length ? 'fail' : 'pass', detail: issues.join('; ') || problem.spec.title });
  }
}

// ---- booting ---------------------------------------------------------------------------------------

async function hasDocker(): Promise<boolean> {
  const result = await runFile('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20_000 }).catch(() => null);
  return result?.code === 0;
}

interface Booted {
  mission: Mission;
  logs: string[];
  bootMs: number;
}

/** Start a mission from a bundle file, the way a learner's agent would (minus the IDE) */
async function bootBundle(context: CompileContext, bundleFile: string, attemptId: string, variantId: string, onProgress?: (line: string) => void): Promise<Booted> {
  const logs: string[] = [];
  const root = join(context.work, 'missions');
  const emit = (event: AgentEvent, data: unknown) => {
    if (event === 'log') {
      const entry = data as { source: string; message: string };
      logs.push(`[${entry.source}] ${entry.message}`);
      if (logs.length > 200) logs.shift();
    } else if (event === 'boot.step') {
      const step = data as { id: string; status: string; detail?: string };
      if (step.status === 'active' && !step.detail) onProgress?.(`    ${step.id}`);
    } else if (event === 'run.line') {
      logs.push(`[tests] ${(data as { line: string }).line}`);
      if (logs.length > 200) logs.shift();
    }
  };
  const source = new BundleSource({ url: pathToFileURL(bundleFile).href, sha256: sha256File(bundleFile) }, { dir: join(root, attemptId, 'bundle'), dev: true, allowedHosts: [] });
  const mission = new Mission({ attemptId, missionId: 'check', variantId }, source, emit, { dev: true, root, watchFiles: false, mssql: 'docker' });
  const started = Date.now();
  try {
    await mission.plan();
    await mission.boot();
  } catch (error) {
    await mission.dispose().catch(() => undefined);
    throw Object.assign(error as Error, { logs });
  }
  return { mission, logs, bootMs: Date.now() - started };
}

function failedChecks(run: RunResult): string[] {
  return run.checks.filter((check) => check.status === 'failed' || check.status === 'error').map((check) => `${check.layer}: ${check.name}${check.message ? ` (${check.message.split('\n')[0]!.slice(0, 160)})` : ''}`);
}

async function checkStack(context: CompileContext, stack: string, docker: boolean, add: (result: CheckResult) => CheckResult, onProgress?: (line: string) => void): Promise<void> {
  const { codebank } = context;
  const spec = codebank.spec.stacks[stack]!;
  const id = `boot:${stack}`;
  const title = `Stack ${stack}: healthy product boots and passes its visible tests`;
  if (spec.engine === 'sqlserver' && !docker) {
    add({ id, title, status: 'skip', detail: 'SQL Server stacks are checked with Docker (SQL Server Express); Docker is not running' });
    return;
  }
  onProgress?.(`booting ${stack} (main)`);
  const started = Date.now();
  let booted: Booted | null = null;
  try {
    const tree = await project(context.git, codebank, stack, join(context.work, 'main', stack, 'tree'));
    const repo = await buildStarterRepo({ git: context.gitFor, dir: join(context.work, 'main', stack, 'repo'), branch: 'main', historyDir: null, starter: tree });
    const repoGit = await context.gitFor(repo.dir);
    const bundle = join(context.work, 'main', stack, 'repo.bundle');
    await writeBundle(repoGit, 'main', bundle);
    const workspaceText = readFileSync(join(tree.dir, '.reneplane', 'workspace.yaml'), 'utf8');
    const template = spec.engine === 'sqlserver' ? await buildTemplate(spec, tree.dir, parseWorkspace(workspaceText), join(context.work, 'main', stack), onProgress) : null;
    const manifest = { format: 1, codebank: codebank.spec.id, release: 'check', problem: '(main)', variant: stack, kind: spec.adapter === 'sql' ? 'sql' : 'app', branch: 'main', startCommit: repo.startCommit, requires: [], minAgentVersion: '0.0.0' };
    const file = join(context.work, 'main', stack, 'main.tar.gz');
    writeFileSync(
      file,
      tarGz([
        { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        { path: 'repo.bundle', data: readFileSync(bundle) },
        { path: 'workspace.yaml', data: Buffer.from(workspaceText) },
        ...(template ? [{ path: 'template.sql', data: Buffer.from(template) }] : []),
      ]),
    );
    booted = await bootBundle(context, file, `chk-main-${stack}`, stack, onProgress);
    if (spec.adapter === 'sql') {
      // A SQL stack is its schema and data; the queries and their expected results come with each problem
      const tables = await booted.mission.schema();
      add({ id, title: `Stack ${stack}: the schema and data load`, status: tables.length ? 'pass' : 'fail', durationMs: Date.now() - started, detail: `${tables.length} tables, ${tables.reduce((sum, table) => sum + table.rowCount, 0)} rows` });
      return;
    }
    const run = await booted.mission.run();
    const failures = failedChecks(run);
    const status: Status = !run.build.ok || failures.length ? 'fail' : booted.bootMs > BOOT_BUDGET_MS ? 'warn' : 'pass';
    add({
      id,
      title,
      status,
      durationMs: Date.now() - started,
      detail: !run.build.ok
        ? 'the build failed'
        : failures.length
          ? `visible tests fail on the healthy product: ${failures.join('; ')}`
          : `${run.passed} visible tests pass; booted in ${Math.round(booted.bootMs / 1000)} s${booted.bootMs > BOOT_BUDGET_MS ? ' (over the 3-minute budget)' : ''}`,
      log: status === 'fail' ? (run.build.ok ? booted.logs.slice(-40) : run.build.log.slice(-40)) : undefined,
    });
  } catch (error) {
    add({ id, title, status: 'fail', durationMs: Date.now() - started, detail: (error as Error).message.split('\n')[0], log: ((error as { logs?: string[] }).logs ?? (error as Error).message.split('\n')).slice(-40) });
  } finally {
    await booted?.mission.dispose().catch(() => undefined);
  }
}

async function checkProblem(context: CompileContext, problemId: string, stack: string, docker: boolean, add: (result: CheckResult) => CheckResult, onProgress?: (line: string) => void): Promise<void> {
  const { codebank } = context;
  const problem = codebank.problems.find((candidate) => candidate.spec.id === problemId)!;
  const spec = codebank.spec.stacks[stack]!;
  const id = `solve:${problemId}:${stack}`;
  const title = `${problemId} on ${stack}: the starter fails as expected and the reference passes`;
  if (spec.engine === 'sqlserver' && !docker) {
    add({ id, title, status: 'skip', detail: 'SQL Server stacks are checked with Docker (SQL Server Express); Docker is not running' });
    return;
  }
  onProgress?.(`booting ${problemId} on ${stack} (starter, then reference)`);
  const started = Date.now();
  let booted: Booted | null = null;
  try {
    const out = join(context.work, 'out');
    const { compiled, work } = await compileVariant(context, problem, stack, out, 'check');

    const allow = problem.spec.stacks[stack]!.allow;
    const outside = splitPatch(work.referencePatch)
      .flatMap((file) => file.paths)
      .filter((path) => !matchesAny(path, allow));
    if (outside.length) throw new Error(`the reference changes files learners may not change (add them to allow, or keep them out of the fix): ${outside.join(', ')}`);

    booted = await bootBundle(context, join(out, compiled.starter.file), `chk-${problemId}-${stack}`.replace(/[^A-Za-z0-9_-]/g, '-'), stack, onProgress);
    const starterRun = await booted.mission.run();
    if (!starterRun.build.ok) throw Object.assign(new Error('the starter does not build'), { logs: starterRun.build.log });
    const starterFailures = failedChecks(starterRun);
    const expected = problem.spec.stacks[stack]!.expectFailing;
    if (expected) {
      const notFailing = expected.filter((name) => !starterFailures.some((failure) => failure.includes(name)));
      if (notFailing.length) throw new Error(`these visible tests should fail on the starter but don't: ${notFailing.join('; ')}`);
    } else if (!starterFailures.length) {
      throw new Error('every visible test passes on the starter: the learner would have nothing to fix (or the tests miss the problem)');
    }

    onProgress?.('    applying the reference');
    await booted.mission.applyWork(work.referencePatch);
    const referenceRun = await booted.mission.run();
    const referenceFailures = failedChecks(referenceRun);
    if (!referenceRun.build.ok || referenceFailures.length) {
      throw Object.assign(new Error(`the reference doesn't pass the visible tests: ${referenceRun.build.ok ? referenceFailures.join('; ') : 'the build failed'}`), {
        logs: referenceRun.build.ok ? booted.logs : referenceRun.build.log,
      });
    }
    const slow = booted.bootMs > BOOT_BUDGET_MS;
    add({
      id,
      title,
      status: slow ? 'warn' : 'pass',
      durationMs: Date.now() - started,
      detail: `starter: ${starterFailures.length} failing as expected; reference: ${referenceRun.passed} passing; changes ${compiled.referenceChanges.length} files; booted in ${Math.round(booted.bootMs / 1000)} s${slow ? ' (over the 3-minute budget)' : ''}`,
    });
  } catch (error) {
    add({ id, title, status: 'fail', durationMs: Date.now() - started, detail: (error as Error).message.split('\n')[0], log: ((error as { logs?: string[] }).logs ?? booted?.logs ?? (error as Error).message.split('\n')).slice(-40) });
  } finally {
    await booted?.mission.dispose().catch(() => undefined);
  }
}
