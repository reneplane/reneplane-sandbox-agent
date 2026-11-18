import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bytes used under `path`, counting each file once. Links are never followed: npm workspaces and
 * Windows junctions point back into the project or into shared stores, and following them would count
 * (or, in a cleaner, delete) things that aren't there.
 */
export function dirSize(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      const child = join(current, name);
      let stat;
      try {
        stat = lstatSync(child);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) stack.push(child);
      else total += stat.size;
    }
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
