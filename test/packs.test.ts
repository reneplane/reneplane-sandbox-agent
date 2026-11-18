import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Point the agent at a throwaway home before its modules load
const home = mkdtempSync(join(tmpdir(), 'reneplane-test-'));
process.env.RENEPLANE_HOME = home;
const { packsFor, packState, runtimesFor, isPackId } = await import('../src/packs/index.js');
const { pruneRuntimes, runtimeDir, runtimeVersion } = await import('../src/runtimes/index.js');

const app = (runtimes: Record<string, string>, engine: 'postgres' | 'mysql' | 'sqlserver', frontend = true) => ({
  runtimes,
  services: frontend ? { frontend: {} as never } : {},
  database: { engine, name: 'shopkart' },
});

describe('which packs a workspace needs', () => {
  it('derives them from the backend runtime, the frontend and a local engine', () => {
    expect(packsFor(app({ node: '22' }, 'postgres'))).toEqual(['node22', 'postgres16']);
    expect(packsFor(app({ python: '3.12' }, 'postgres'))).toEqual(['node22', 'python312-uv', 'postgres16']);
    expect(packsFor(app({ java: '21' }, 'mysql'))).toEqual(['node22', 'jdk21-maven', 'mysql84']);
    // SQL Server is Reneplane's pool: no engine pack
    expect(packsFor(app({ dotnet: '10' }, 'sqlserver'))).toEqual(['node22', 'dotnet10']);
    // A SQL practice problem on MySQL: only the engine
    expect(packsFor(app({}, 'mysql', false))).toEqual(['mysql84']);
  });

  it('starts a mission with git plus the packs’ required runtimes (debuggers are optional)', () => {
    expect(runtimesFor(['jdk21-maven', 'mysql84'])).toEqual(['git', 'java', 'maven', 'mysql']);
    expect(runtimesFor(['dotnet10'])).toEqual(['git', 'dotnet']);
  });

  it('knows its pack ids', () => {
    expect(isPackId('jdk21-maven')).toBe(true);
    expect(isPackId('jdk21')).toBe(false);
  });

  it('reports a pack installed only when every required runtime is', () => {
    expect(packState('postgres16')).toBe('missing');
    mkdirSync(runtimeDir('postgres'), { recursive: true });
    writeFileSync(join(runtimeDir('postgres'), '.complete'), 'now');
    expect(packState('postgres16')).toBe('installed');
  });
});

describe('pruning runtimes', () => {
  it('removes old versions, leftovers and archives, and keeps current runtimes and uv’s Python', () => {
    const runtimes = join(home, 'runtimes');
    const current = `node-${runtimeVersion('node')}`;
    for (const dir of [current, 'node-20.0.0', 'mysql-8.0.1', 'dotnet-9.0.100.unpacking', 'python', 'unrelated-folder', '.downloads']) {
      mkdirSync(join(runtimes, dir), { recursive: true });
    }
    writeFileSync(join(runtimes, '.downloads', 'node.zip'), 'archive');

    const removed = pruneRuntimes();

    expect(removed.sort()).toEqual(['.downloads/node.zip', 'dotnet-9.0.100.unpacking', 'mysql-8.0.1', 'node-20.0.0']);
    for (const kept of [current, 'python', 'unrelated-folder', '.downloads']) expect(existsSync(join(runtimes, kept))).toBe(true);
  });
});
