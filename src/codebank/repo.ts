import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { agentGit, type Git } from '../mission/git.js';

/**
 * Git questions about the codebank itself (the author's checkout). The tooling reads the working tree,
 * so an author can check before committing; CI checks a clean checkout, which is the committed state.
 */

/** The bundled git, like everything else the agent runs; tests use the system git */
export async function gitFor(cwd: string): Promise<Git> {
  return agentGit(cwd);
}

export interface CodebankFile {
  /** Path in the codebank, forward slashes */
  path: string;
  executable: boolean;
}

/** Files in the working tree that git would commit: tracked and untracked, minus ignored and deleted */
export async function listFiles(git: Git): Promise<CodebankFile[]> {
  const staged = await git.run(['ls-files', '-z', '-s']);
  const modes = new Map<string, string>();
  for (const entry of staged.split('\0').filter(Boolean)) {
    const [info, path] = entry.split('\t') as [string, string];
    modes.set(path, info.split(' ')[0]!);
  }
  const listed = (await git.run(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate'])).split('\0').filter(Boolean);
  const files: CodebankFile[] = [];
  for (const path of listed) {
    const full = join(git.cwd, ...path.split('/'));
    if (!existsSync(full) || !lstatSync(full).isFile()) continue;
    const mode = modes.get(path);
    // Untracked files: the file system knows (macOS, Linux); Windows has no executable bit
    const executable = mode ? mode === '100755' : process.platform !== 'win32' && (lstatSync(full).mode & 0o111) !== 0;
    files.push({ path, executable });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Symlinks, submodules and anything else that isn't a plain file, as tracked by git */
export async function unusualEntries(git: Git): Promise<string[]> {
  const staged = await git.run(['ls-files', '-z', '-s']);
  return staged
    .split('\0')
    .filter(Boolean)
    .filter((entry) => !/^100(644|755) /.test(entry))
    .map((entry) => entry.split('\t')[1]!);
}

export interface ProblemCommit {
  sha: string;
  subject: string;
  type: string | null;
}

/** Commits on HEAD carrying `Reneplane-Problem: <id>` (there must be exactly one per problem) */
export async function problemCommits(git: Git, problemId: string): Promise<ProblemCommit[]> {
  const out = await git.run([
    'log',
    '-z',
    '--format=%H%x1f%s%x1f%(trailers:key=Reneplane-Problem,valueonly,separator=%x2C)%x1f%(trailers:key=Reneplane-Type,valueonly,separator=%x2C)',
    'HEAD',
  ]);
  return out
    .split('\0')
    .filter(Boolean)
    .map((record) => record.replace(/^\n/, '').split('\x1f'))
    .filter(([, , problems = '']) => problems.split(',').map((value) => value.trim()).includes(problemId))
    .map(([sha = '', subject = '', , type = '']) => ({ sha, subject, type: type.trim() || null }));
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** What a commit changed, one section per file, binary-safe, without rename detection */
export async function commitDiff(git: Git, sha: string): Promise<string> {
  const parents = (await git.run(['rev-list', '--parents', '-n', '1', sha])).trim().split(' ').slice(1);
  const base = parents[0] ?? EMPTY_TREE;
  return git.run(['diff', '--no-renames', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', base, sha]);
}

/** Commits after `sha` on HEAD that touch any of `paths` (they're what can stop a revert applying) */
export async function laterCommitsTouching(git: Git, sha: string, paths: string[]): Promise<string[]> {
  if (!paths.length) return [];
  const out = await git.run(['log', '--format=%h %s', `${sha}..HEAD`, '--', ...paths]);
  return out.split('\n').filter(Boolean);
}

export async function headSha(git: Git): Promise<string> {
  return (await git.run(['rev-parse', 'HEAD'])).trim();
}
