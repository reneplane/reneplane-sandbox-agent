import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Git } from '../mission/git.js';
import { START_TAG } from '../mission/source.js';
import type { Projection } from './project.js';

/**
 * The learner's repository: a curated history that ends exactly at the starter.
 *
 * history/<stack>/*.patch is a `git format-patch` series (author, date and message in each file),
 * replayed in order. Then one last commit (problem.yaml's history.head) makes the tree exactly the
 * starter, whatever later changes to main did; with no history at all, that's an "Initial import".
 * Everything has fixed authors and dates, so the same inputs always give the same commits.
 */

export interface HeadCommit {
  message: string;
  author: string;
  date: string;
}

const IMPORT: HeadCommit = { message: 'Initial import', author: 'Reneplane <codebank@reneplane.com>', date: '2026-01-01T00:00:00Z' };

function identity(person: string, date: string): Record<string, string> {
  const match = person.match(/^(.+?) <(.+)>$/);
  if (!match) throw new Error(`"${person}" isn't "Name <email>"`);
  const [, name = '', email = ''] = match;
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: date };
}

/** The author line of a format-patch file: "From: Ravi Kumar <ravi@shopkart.example>" */
function patchAuthor(text: string, file: string): string {
  const line = text.split('\n').find((candidate) => candidate.startsWith('From: '));
  if (!line) throw new Error(`${file} has no From: line (make it with git format-patch)`);
  return line.slice('From: '.length).trim();
}

export interface StarterRepo {
  dir: string;
  startCommit: string;
}

/** Build the learner's repo in `dir` from the history series and the starter projection */
export async function buildStarterRepo(options: {
  git: (cwd: string) => Promise<Git>;
  dir: string;
  branch: string;
  historyDir: string | null;
  head?: HeadCommit;
  starter: Projection;
}): Promise<StarterRepo> {
  const { dir, branch, starter } = options;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = await options.git(dir);
  await git.run(['init', '-q', '-b', branch]);
  await git.run(['config', 'core.autocrlf', 'false']);

  const series = options.historyDir && existsSync(options.historyDir) ? readdirSync(options.historyDir).filter((name) => name.endsWith('.patch')).sort() : [];
  for (const name of series) {
    const file = join(options.historyDir!, name);
    const text = readFileSync(file, 'utf8');
    const author = patchAuthor(text, name);
    try {
      // The committer is the author, at the author's date, as if they had committed it themselves
      const [, name = '', email = ''] = author.match(/^(.+?) <(.+)>$/) ?? [];
      await git.run(['am', '-q', '--committer-date-is-author-date', '--whitespace=nowarn', file], { env: { GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } });
    } catch (error) {
      await git.run(['am', '--abort']).catch(() => undefined);
      throw new Error(`history ${name} doesn't apply on the commits before it: ${(error as Error).message}`);
    }
  }

  // The head commit: the working tree becomes exactly the starter
  const hasHistory = series.length > 0;
  if (hasHistory) await git.run(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.']);
  for (const entry of readdirSync(dir)) if (entry !== '.git') rmSync(join(dir, entry), { recursive: true, force: true });
  for (const entry of readdirSync(starter.dir)) cpSync(join(starter.dir, entry), join(dir, entry), { recursive: true });
  await git.run(['add', '-A', '--force']);
  for (const path of starter.executables) await git.run(['update-index', '--chmod=+x', '--', path]);
  const changed = !hasHistory || (await git.run(['diff', '--cached', '--name-only', 'HEAD'])).trim() !== '';
  if (changed) {
    const head = options.head ?? IMPORT;
    await git.run(['commit', '-q', '--no-verify', '-m', head.message], { env: identity(head.author, head.date) });
  }
  await git.run(['tag', START_TAG]);
  const startCommit = (await git.run(['rev-parse', 'HEAD'])).trim();
  return { dir, startCommit };
}

/** A git bundle of the repo (packed single-threaded, so the same repo gives the same file) */
export async function writeBundle(git: Git, branch: string, out: string): Promise<void> {
  await git.run(['-c', 'pack.threads=1', 'bundle', 'create', '-q', out, 'HEAD', `refs/heads/${branch}`, `refs/tags/${START_TAG}`]);
  await git.run(['bundle', 'verify', '-q', out]);
}

/**
 * Nothing from the answer may be in the learner's repo: no blob of a file the reference changes (in
 * any commit of the curated history, not just the last), and no problem trailers in messages.
 */
export async function findLeaks(git: Git, reference: Projection, changedPaths: string[]): Promise<string[]> {
  const leaks: string[] = [];
  const objects = new Set((await git.run(['rev-list', '--objects', '--all'])).split('\n').map((line) => line.split(' ')[0]!).filter(Boolean));
  for (const path of changedPaths) {
    const file = join(reference.dir, ...path.split('/'));
    if (!existsSync(file)) continue;
    const blob = (await git.run(['hash-object', '--no-filters', file])).trim();
    if (objects.has(blob)) leaks.push(`the reference version of ${path} is in the learner's history`);
  }
  const messages = await git.run(['log', '--all', '--format=%B']);
  if (/^Reneplane-[A-Za-z]+:/m.test(messages)) leaks.push("a commit message in the learner's history carries a Reneplane- trailer");
  return leaks;
}
