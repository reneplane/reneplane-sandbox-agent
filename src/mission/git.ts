import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitCommit } from '../protocol.js';
import { gitBinary, type Runtime } from '../runtimes/index.js';
import { buildEnv, runFile, type Env } from '../util/process.js';

/** The bundled Git (dugite-native), never the system one, so a fresh Mac never sees the Xcode prompt */
export class Git {
  readonly env: Env;
  private readonly binary: string;

  constructor(
    runtime: Runtime,
    private readonly cwd: string,
  ) {
    this.binary = gitBinary(runtime);
    this.env = buildEnv(runtime.path, {
      ...runtime.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      LC_ALL: 'C',
    });
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
    await this.run(['clone', '--quiet', '--no-checkout', source, this.cwd], { cwd: tmpdir(), timeoutMs: 10 * 60_000 });
    await this.run(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '-b', branch, ref]);
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
      return await this.run(['diff', '--cached', '--binary', '--no-color', ref], { env });
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
