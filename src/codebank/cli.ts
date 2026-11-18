import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkCodebank, type CheckResult } from './check.js';
import { compileRelease, scratch } from './compile.js';
import { gitFor } from './repo.js';
import { loadCodebank } from './spec.js';
import { initCodebank, newProblem } from './init.js';

/**
 * reneplane-local codebank <command>     (run inside a codebank checkout, or pass --dir)
 *
 *   check [--quick] [--stack s,…] [--problem ID,…] [--json report.json] [--keep]
 *                       is this repository fit to connect to the workspace?
 *   compile --out <dir> [--release v2026.11.1] [--stack s,…] [--problem ID,…] [--keep]
 *                       build the starter and grader bundles and release.json
 *   init <dir> --name <Name> --stack <id> [--stack <id>…]
 *                       start a new codebank from the templates
 *
 * reneplane-local problem new <ID> --from-commit <sha> [--dir <codebank>]
 *                       write problems/<ID>/problem.yaml for a commit carrying the problem's trailer
 */

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function list(args: string[], name: string): string[] | undefined {
  const values = args.flatMap((arg, index) => (arg === `--${name}` && args[index + 1] ? args[index + 1]!.split(',') : []));
  return values.length ? values : undefined;
}

const MARK: Record<CheckResult['status'], string> = { pass: '✓', fail: '✗', warn: '!', skip: '-' };

function printResult(result: CheckResult): void {
  const time = result.durationMs ? ` (${Math.round(result.durationMs / 1000)} s)` : '';
  console.log(`${MARK[result.status]} ${result.title}${time}${result.detail ? `\n    ${result.detail}` : ''}`);
  if (result.status === 'fail' && result.log?.length) {
    console.log(`    last output:\n${result.log.map((line) => `      ${line}`).join('\n')}`);
  }
}

export async function codebankCommand(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  const dir = resolve(option(rest, 'dir') ?? process.cwd());
  switch (command) {
    case 'check': {
      const report = await checkCodebank({
        root: dir,
        level: rest.includes('--quick') ? 'quick' : 'full',
        stacks: list(rest, 'stack'),
        problems: list(rest, 'problem'),
        gitFor,
        keep: rest.includes('--keep'),
        onResult: printResult,
        onProgress: (line) => console.log(`  … ${line}`),
      });
      const json = option(rest, 'json');
      if (json) writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`\n${report.summary} (${Math.round(report.durationMs / 1000)} s)`);
      return report.ok ? 0 : 1;
    }
    case 'compile': {
      const out = option(rest, 'out');
      if (!out) throw new Error('compile needs --out <dir>');
      const codebank = loadCodebank(dir);
      const git = await gitFor(dir);
      const work = scratch('reneplane-compile-');
      const release = await compileRelease(
        { codebank, git, gitFor, work, onProgress: (line) => console.log(`  … ${line}`) },
        resolve(out),
        { release: option(rest, 'release') ?? 'dev', problems: list(rest, 'problem'), stacks: list(rest, 'stack') },
      );
      for (const problem of release.problems) {
        for (const variant of problem.variants) {
          console.log(`${problem.id} ${variant.variant}: starter ${variant.starter.sha256.slice(0, 12)} (${Math.round(variant.starter.size / 1024)} KB), grader ${variant.grader.sha256.slice(0, 12)}, requires ${variant.requires.join(' ') || 'nothing'}`);
        }
      }
      if (!rest.includes('--keep')) {
        const { rmSync } = await import('node:fs');
        rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } else console.log(`work folder kept: ${work}`);
      console.log(`\nwrote ${resolve(out)}/release.json`);
      return 0;
    }
    case 'init': {
      const target = rest.find((arg, index) => !arg.startsWith('--') && !rest[index - 1]?.startsWith('--'));
      const name = option(rest, 'name');
      const stacks = list(rest, 'stack');
      if (!target || !name || !stacks) throw new Error('Usage: reneplane-local codebank init <dir> --name <Name> --stack <id> [--stack <id>…]');
      initCodebank(resolve(target), name, stacks);
      console.log(`Created ${resolve(target)}. Next: cd into it, git init, commit, then reneplane-local codebank check`);
      return 0;
    }
    default:
      console.error('Usage: reneplane-local codebank check|compile|init (see reneplane-local codebank help)');
      return 2;
  }
}

export async function problemCommand(args: string[]): Promise<number> {
  const [command, id, ...rest] = args;
  if (command !== 'new' || !id) {
    console.error('Usage: reneplane-local problem new <ID> --from-commit <sha> [--dir <codebank>]');
    return 2;
  }
  const sha = option(rest, 'from-commit');
  if (!sha) throw new Error('problem new needs --from-commit <sha>');
  const file = await newProblem(resolve(option(rest, 'dir') ?? process.cwd()), id, sha);
  console.log(`Wrote ${file}. Fill in the title, brief, allow lists and hidden suite, then run reneplane-local codebank check.`);
  return 0;
}
