import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { AgentError } from '../protocol.js';

/**
 * Resolve a repo-relative path from the IDE to an absolute path inside `root`, or refuse.
 * Rejects absolute paths, drive letters, `..` segments, NUL bytes, and anything whose real location
 * (after following symlinks of the nearest existing parent) is outside the root.
 */
export function resolveInside(root: string, repoPath: string): string {
  if (!repoPath || repoPath.includes('\0')) throw outside(repoPath);
  const normalised = repoPath.replace(/\\/g, '/');
  if (isAbsolute(normalised) || /^[A-Za-z]:/.test(normalised) || normalised.startsWith('/')) throw outside(repoPath);
  if (normalised.split('/').some((segment) => segment === '..')) throw outside(repoPath);
  if (normalised.split('/').some((segment) => segment === '.git')) throw outside(repoPath);

  const target = resolve(root, normalised);
  if (!isWithin(root, target)) throw outside(repoPath);

  // Follow symlinks on the deepest part that exists, so a link inside the repo can't point outside it
  const realRoot = realpathSync(root);
  let probe = target;
  while (true) {
    try {
      const real = realpathSync(probe);
      if (!isWithin(realRoot, real)) throw outside(repoPath);
      break;
    } catch (error) {
      if (error instanceof AgentError) throw error;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return target;
}

export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/** Repo paths always use forward slashes, whatever the OS */
export function toRepoPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

function outside(path: string): AgentError {
  return new AgentError('outside_workspace', `"${path}" is outside the mission folder`);
}
