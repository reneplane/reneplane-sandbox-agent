import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import type { Git } from '../mission/git.js';
import { mapPatchPaths, splitPatch } from './patch.js';
import { commitDiff, laterCommitsTouching, listFiles, problemCommits } from './repo.js';
import { parseSeed, seedSql } from './seed.js';
import type { LoadedCodebank, LoadedProblem } from './spec.js';

/**
 * A learner tree: what one stack of the codebank looks like on a learner's computer.
 *
 *   stacks/<stack>/**          → **            (minus .reneplane/grade.yaml: that's the grader's)
 *   <mount source>/**          → <mount>/**    (shared/frontend → frontend)
 *   problems/<ID>/<file>       → <learner path> (a problem's own files, e.g. answer.sql)
 *   shared/seed/seed.json      → <stack seed>  (generated SQL for the stack's engine)
 *
 * The reference side is `main` as it is. The starter side is `main` with the problem's commit taken
 * back (only the parts that land in this tree), or with the problem's hand-written break.patch.
 */

export type Side = 'main' | 'starter' | 'reference';

export interface Projection {
  dir: string;
  /** Learner paths of executable files (mvnw): git needs telling on Windows */
  executables: string[];
}

export class ProjectionError extends Error {}

const GRADE_FILE = '.reneplane/grade.yaml';

/** Which learner path a codebank path becomes in this stack's tree, or null when it isn't part of it */
export function learnerPath(codebank: LoadedCodebank, stack: string, path: string, problem?: LoadedProblem): string | null {
  const stackPrefix = `stacks/${stack}/`;
  if (path.startsWith(stackPrefix)) {
    const rest = path.slice(stackPrefix.length);
    return rest === GRADE_FILE ? null : rest;
  }
  for (const [mount, source] of Object.entries(codebank.spec.mounts)) {
    if (path.startsWith(`${source}/`)) return `${mount}/${path.slice(source.length + 1)}`;
  }
  if (problem) {
    for (const [target, source] of Object.entries(problem.spec.files)) {
      if (path === `${problem.dir}/${source.replace('{stack}', stack)}`) return target;
    }
  }
  return null;
}

export async function project(git: Git, codebank: LoadedCodebank, stack: string, dest: string, options: { problem?: LoadedProblem; side?: Side } = {}): Promise<Projection> {
  const { problem, side = 'main' } = options;
  const stackSpec = codebank.spec.stacks[stack];
  if (!stackSpec) throw new ProjectionError(`No stack ${stack} in codebank.yaml`);
  mkdirSync(dest, { recursive: true });

  const executables: string[] = [];
  for (const file of await listFiles(git)) {
    const target = learnerPath(codebank, stack, file.path, problem);
    if (target === null) continue;
    const to = join(dest, ...target.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(codebank.root, ...file.path.split('/')), to);
    if (file.executable) {
      executables.push(target);
      if (process.platform !== 'win32') chmodSync(to, 0o755);
    }
  }
  if (problem) {
    for (const [target, source] of Object.entries(problem.spec.files)) {
      if (!existsSync(join(dest, ...target.split('/')))) throw new ProjectionError(`${problem.dir}/problem.yaml: files.${target}: ${problem.dir}/${source.replace('{stack}', stack)} doesn't exist`);
    }
  }

  if (codebank.spec.seed && stackSpec.seed) {
    const seed = parseSeed(readFileSync(join(codebank.root, ...codebank.spec.seed.split('/')), 'utf8'), codebank.spec.seed);
    const target = join(dest, ...stackSpec.seed.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, seedSql(seed, stackSpec.engine));
  }

  if (problem && side === 'starter') await breakTree(git, codebank, stack, problem, dest);
  if (problem) applyProblemSettings(dest, problem);
  return { dir: dest, executables: executables.sort() };
}

/** Turn `main` into the starter: undo the problem's commit (this tree's part of it), or apply break.patch */
async function breakTree(git: Git, codebank: LoadedCodebank, stack: string, problem: LoadedProblem, dest: string): Promise<void> {
  const breakFile = join(codebank.root, ...problem.dir.split('/'), stack, 'break.patch');
  if (existsSync(breakFile)) {
    await applyIn(git, dest, readFileSync(breakFile, 'utf8'), false, `${problem.dir}/${stack}/break.patch doesn't apply to main any more`);
    return;
  }
  const commits = await problemCommits(git, problem.spec.id);
  if (commits.length === 0) {
    throw new ProjectionError(`${problem.spec.id}: no commit has the trailer "Reneplane-Problem: ${problem.spec.id}" and there is no ${problem.dir}/${stack}/break.patch`);
  }
  if (commits.length > 1) {
    throw new ProjectionError(`${problem.spec.id}: ${commits.length} commits carry its trailer (${commits.map((commit) => commit.sha.slice(0, 7)).join(', ')}); a problem is one squashed commit`);
  }
  const commit = commits[0]!;
  const diff = await commitDiff(git, commit.sha);
  if (codebank.spec.seed && splitPatch(diff).some((file) => file.paths.includes(codebank.spec.seed!))) {
    throw new ProjectionError(`${problem.spec.id}: its commit ${commit.sha.slice(0, 7)} changes ${codebank.spec.seed}; seed changes can't be part of a problem yet (use break.patch)`);
  }
  const mapped = mapPatchPaths(diff, (path) => learnerPath(codebank, stack, path, problem));
  if (!mapped.trim()) throw new ProjectionError(`${problem.spec.id}: its commit ${commit.sha.slice(0, 7)} changes nothing in the ${stack} stack`);
  try {
    await applyIn(git, dest, mapped, true, '');
  } catch {
    const paths = splitPatch(diff).flatMap((file) => file.paths);
    const later = await laterCommitsTouching(git, commit.sha, paths);
    throw new ProjectionError(
      `${problem.spec.id}: its commit ${commit.sha.slice(0, 7)} no longer reverts cleanly on main for ${stack}` +
        (later.length ? `; later commits touch the same files: ${later.join('; ')}` : '') +
        `. Fix those commits, or describe the starter with ${problem.dir}/${stack}/break.patch instead.`,
    );
  }
}

async function applyIn(git: Git, dir: string, patch: string, reverse: boolean, failure: string): Promise<void> {
  try {
    // Outside any repository on purpose: the ceiling stops git from finding one above the temp folder
    await git.run(['apply', '--binary', '--whitespace=nowarn', ...(reverse ? ['-R'] : []), '-'], { cwd: dir, input: patch, env: { GIT_CEILING_DIRECTORIES: dirname(dir) } });
  } catch (error) {
    throw new ProjectionError(failure || (error as Error).message);
  }
}

/** The problem's branch and preview go into the stack's workspace.yaml (comments kept) */
function applyProblemSettings(dest: string, problem: LoadedProblem): void {
  for (const name of ['workspace.yaml']) {
    const file = join(dest, '.reneplane', name);
    if (!existsSync(file)) continue;
    const document = parseDocument(readFileSync(file, 'utf8'));
    document.set('branch', problem.spec.branch);
    if (problem.spec.preview && document.get('preview')) document.setIn(['preview', 'path'], problem.spec.preview);
    writeFileSync(file, document.toString());
  }
}
