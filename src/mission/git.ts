import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PATHS } from '../config.js';
import type { GitCommit } from '../protocol.js';
import { gitBinary, type Runtime } from '../runtimes/index.js';
import { buildEnv, runFile, type Env } from '../util/process.js';

/**
 * The agent's own git calls. They use the bundled Git (dugite-native), never the system one, so a fresh
 * Mac never sees the Xcode prompt, and an empty config of their own: settings in the learner's
 * ~/.gitconfig (diff.noprefix, diff.external, color.diff=always, core.autocrlf, …) must never change a
 * diff the grader parses or a patch the agent applies. The learner's terminal keeps their normal git.
 */
export class Git {
  readonly env: Env;
  private readonly binary: string;

  constructor(
    runtime: Runtime,
    readonly cwd: string,
  ) {
    this.binary = gitBinary(runtime);
    this.env = buildEnv(runtime.path, { ...runtime.env, ...isolatedGitEnv() });
  }

  /** Tests and tools: the git on PATH, with the same isolation */
  static system(cwd: string): Git {
    const git = Object.create(Git.prototype) as Git;
    Object.assign(git, { cwd, binary: process.platform === 'win32' ? 'git.exe' : 'git', env: buildEnv([], isolatedGitEnv()) });
    return git;
  }

  async run(args: string[], options: { cwd?: string; input?: string; env?: Env; timeoutMs?: number } = {}): Promise<string> {
    const result = await runFile(this.binary, args, {
      cwd: options.cwd ?? this.cwd,
      env: { ...this.env, ...options.env },
      input: options.input,
      timeoutMs: options.timeoutMs ?? 120_000,
    });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout;
  }

  /** Clone `source` at `ref`, then start the learner's branch there */
  async clone(source: string, ref: string, branch: string): Promise<void> {
    // autocrlf is set for the clone itself: set afterwards, the first checkout would already have used it
    await this.run(['clone', '--quiet', '--no-checkout', '-c', 'core.autocrlf=false', source, this.cwd], { cwd: tmpdir(), timeoutMs: 10 * 60_000 });
    await this.run(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '-b', branch, ref]);
    await this.configureLearner();
  }

  /**
   * Clone a starter bundle and start the learner's branch at its tag. The tag must point at
   * `expectedCommit` (from the bundle's manifest), and the clone keeps no remote: origin would only be
   * a path inside the session folder.
   */
  async cloneBundle(bundle: string, tag: string, branch: string, expectedCommit: string): Promise<void> {
    // Cloning checks the bundle (`git bundle verify` would need a repository to run in)
    await this.run(['clone', '--quiet', '--no-checkout', '-c', 'core.autocrlf=false', bundle, this.cwd], { cwd: tmpdir(), timeoutMs: 5 * 60_000 });
    const tagged = (await this.run(['rev-parse', `refs/tags/${tag}^{commit}`])).trim();
    if (tagged !== expectedCommit) throw new Error(`The starter bundle's ${tag} is ${tagged}, expected ${expectedCommit}`);
    await this.run(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '-B', branch, tag]);
    await this.run(['remote', 'remove', 'origin']);
    await this.configureLearner();
  }

  private async configureLearner(): Promise<void> {
    await this.run(['config', 'user.name', 'You']);
    await this.run(['config', 'user.email', 'you@reneplane.local']);
    await this.run(['config', 'core.autocrlf', 'false']);
  }

  async show(ref: string, path: string): Promise<string> {
    return this.run(['show', `${ref}:${path}`]);
  }

  async log(): Promise<GitCommit[]> {
    const out = await this.run(['log', '-z', '--format=%h%x1f%an%x1f%aI%x1f%s', 'HEAD']);
    return out
      .split('\0')
      .filter(Boolean)
      .map((record) => {
        const [hash = '', author = '', date = '', message = ''] = record.replace(/^\n/, '').split('\x1f');
        return { hash, author, date, message };
      });
  }

  async status(): Promise<{ path: string; change: 'modified' | 'added' | 'deleted' }[]> {
    const out = await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const entries = out.split('\0').filter(Boolean);
    const changes: { path: string; change: 'modified' | 'added' | 'deleted' }[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      if (code.startsWith('R') || code.startsWith('C')) {
        // Renames: "R  new\0old"
        const from = entries[index + 1];
        index += 1;
        changes.push({ path, change: 'added' });
        if (from) changes.push({ path: from, change: 'deleted' });
      } else if (code === '??' || code.includes('A')) changes.push({ path, change: 'added' });
      else if (code.includes('D')) changes.push({ path, change: 'deleted' });
      else changes.push({ path, change: 'modified' });
    }
    return changes;
  }

  /** Commit everything; null when there was nothing to commit */
  async commit(message: string): Promise<GitCommit | null> {
    if (!(await this.status()).length) return null;
    await this.run(['add', '-A']);
    await this.run(['commit', '--quiet', '--no-verify', '-m', message]);
    return (await this.log())[0] ?? null;
  }

  /**
   * Everything the learner changed since the pinned ref (committed or not, new files included), as a
   * patch for the grader. Uses a throwaway index so the learner's staging area is left alone.
   */
  async diffSince(ref: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'reneplane-index-'));
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    try {
      await this.run(['read-tree', 'HEAD'], { env });
      await this.run(['add', '-A'], { env });
      return await this.run(['diff', '--cached', ...STABLE_DIFF, ref], { env });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Put a saved diff back on a fresh working tree at `base` (resuming a session, or the checker trying
   * the reference). It goes through a throwaway index rather than `git apply` on the files, so files
   * checked out with CRLF (.gitattributes eol=crlf), binaries, deletions and renames all apply against
   * the normalised content the diff was made from. Afterwards HEAD is `base` again and the changes are
   * ordinary working-tree changes (the learner's own commits come back uncommitted).
   */
  async restore(base: string, patch: string): Promise<void> {
    if (!patch.trim()) return;
    // Untracked output (test reports, build folders) is fine; changed tracked files are not
    if ((await this.run(['status', '--porcelain', '--untracked-files=no'])).trim()) throw new Error('The working tree has changes already; restoring needs a fresh checkout');
    const dir = mkdtempSync(join(tmpdir(), 'reneplane-restore-'));
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    try {
      await this.run(['read-tree', base], { env });
      await this.run(['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], { env, input: patch });
      const tree = (await this.run(['write-tree'], { env })).trim();
      const commit = (await this.run(['commit-tree', tree, '-p', base, '-m', 'restore'], { env: COMMIT_IDENTITY })).trim();
      await this.run(['reset', '--quiet', '--hard', commit]);
      await this.run(['reset', '--quiet', base]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Tracked and untracked (not ignored) files in the working tree */
  async workingFiles(): Promise<string[]> {
    const out = await this.run(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate']);
    return out.split('\0').filter(Boolean);
  }

  /** The text files at `ref`, by path, read in one batch */
  async filesAt(ref: string, isText: (path: string, data: Buffer) => boolean): Promise<Record<string, string>> {
    const paths = (await this.run(['ls-tree', '-r', '-z', '--name-only', ref])).split('\0').filter(Boolean);
    const contents = await this.catFiles(paths.map((path) => `${ref}:${path}`));
    const files: Record<string, string> = {};
    paths.forEach((path, index) => {
      const data = contents[index];
      if (data && isText(path, data)) files[path] = data.toString('utf8');
    });
    return files;
  }

  private catFiles(specs: string[]): Promise<(Buffer | null)[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ['cat-file', '--batch'], { cwd: this.cwd, env: this.env, windowsHide: true });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('error', reject);
      child.on('close', () => {
        const out = Buffer.concat(chunks);
        const results: (Buffer | null)[] = [];
        let offset = 0;
        for (let index = 0; index < specs.length; index += 1) {
          const newline = out.indexOf(0x0a, offset);
          if (newline < 0) break;
          const header = out.subarray(offset, newline).toString('utf8');
          offset = newline + 1;
          if (header.endsWith(' missing')) {
            results.push(null);
            continue;
          }
          const size = Number(header.split(' ')[2]);
          results.push(out.subarray(offset, offset + size));
          offset += size + 1;
        }
        resolve(results);
      });
      child.stdin.end(`${specs.join('\n')}\n`);
    });
  }
}

/** Diff options that give the same output whatever git config is around: the grader parses it */
const STABLE_DIFF = ['--binary', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--full-index'];

const COMMIT_IDENTITY: Env = {
  GIT_AUTHOR_NAME: 'Reneplane',
  GIT_AUTHOR_EMAIL: 'agent@reneplane.local',
  GIT_COMMITTER_NAME: 'Reneplane',
  GIT_COMMITTER_EMAIL: 'agent@reneplane.local',
};

function isolatedGitEnv(): Env {
  if (!existsSync(PATHS.gitconfig)) {
    mkdirSync(dirname(PATHS.gitconfig), { recursive: true });
    writeFileSync(PATHS.gitconfig, "# Reneplane Local: the agent's own git calls read this instead of ~/.gitconfig (kept empty on purpose)\n");
  }
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: PATHS.gitconfig,
    LC_ALL: 'C',
  };
}

/** The agent's git for a folder: the bundled one, or the system git when RENEPLANE_SYSTEM_GIT=1 (tests, CI tools) */
export async function agentGit(cwd: string): Promise<Git> {
  if (process.env.RENEPLANE_SYSTEM_GIT === '1') return Git.system(cwd);
  const { ensureRuntime } = await import('../runtimes/index.js');
  return new Git(await ensureRuntime('git'), cwd);
}
