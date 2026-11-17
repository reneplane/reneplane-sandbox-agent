import { existsSync, mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveInside } from '../util/paths.js';
import type { Git } from './git.js';

/** The learner's files as the IDE sees them: text only, build output and dependencies left out */

const MAX_TEXT_BYTES = 1_000_000;
const IGNORED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  'bin',
  'obj',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'coverage',
  '.vite',
  '.gradle',
  '.idea',
  '.vs',
  '.reneplane-out',
]);

export function isIgnoredPath(repoPath: string): boolean {
  return repoPath.split('/').some((segment) => IGNORED_SEGMENTS.has(segment));
}

export function isTextContent(path: string, data: Buffer): boolean {
  if (data.length > MAX_TEXT_BYTES) return false;
  if (/\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|jar|zip|gz|exe|dll|so|dylib|class|pdf)$/i.test(path)) return false;
  return !data.subarray(0, 8000).includes(0);
}

export class MissionFiles {
  private watcher: FSWatcher | null = null;
  private pending = new Map<string, NodeJS.Timeout>();
  /** Last content we reported per path, so saves from the IDE don't echo back */
  private known = new Map<string, string | null>();

  constructor(
    private readonly root: string,
    private readonly git: Git,
  ) {}

  async snapshot(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const path of await this.git.workingFiles()) {
      if (isIgnoredPath(path)) continue;
      const absolute = join(this.root, path);
      try {
        if (!statSync(absolute).isFile()) continue;
        const data = readFileSync(absolute);
        if (isTextContent(path, data)) files[path] = normalise(data.toString('utf8'));
      } catch {
        // deleted between listing and reading
      }
    }
    for (const [path, content] of Object.entries(files)) this.known.set(path, content);
    return files;
  }

  async original(ref: string): Promise<Record<string, string>> {
    const files = await this.git.filesAt(ref, isTextContent);
    for (const path of Object.keys(files)) files[path] = normalise(files[path]!);
    return files;
  }

  write(path: string, content: string): void {
    const absolute = resolveInside(this.root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    this.known.set(path, content);
    writeFileSync(absolute, content);
  }

  remove(path: string): void {
    const absolute = resolveInside(this.root, path);
    this.known.set(path, null);
    rmSync(absolute, { force: true });
  }

  /** Report changes made outside the IDE: the terminal, a formatter, git checkout, … */
  watch(onChange: (path: string, content: string | null) => void): void {
    this.unwatch();
    this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const path = filename.toString().replace(/\\/g, '/');
      if (isIgnoredPath(path)) return;
      clearTimeout(this.pending.get(path));
      this.pending.set(
        path,
        setTimeout(() => {
          this.pending.delete(path);
          const absolute = join(this.root, path);
          let content: string | null = null;
          if (existsSync(absolute)) {
            try {
              if (!statSync(absolute).isFile()) return;
              const data = readFileSync(absolute);
              if (!isTextContent(path, data)) return;
              content = normalise(data.toString('utf8'));
            } catch {
              return;
            }
          }
          if (this.known.get(path) === content) return;
          this.known.set(path, content);
          onChange(path, content);
        }, 120),
      );
    });
    this.watcher.on('error', () => undefined);
  }

  unwatch(): void {
    this.watcher?.close();
    this.watcher = null;
    this.pending.forEach((timer) => clearTimeout(timer));
    this.pending.clear();
  }
}

function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
