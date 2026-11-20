import { describe, expect, it } from 'vitest';
import { buildEnv, isWindows, runCommand } from '../src/util/process.js';

describe('runCommand', () => {
  // A command that leaves a background process holding its output pipe: before the group sweep,
  // runCommand returned but the process could never exit (a CI job hung for an hour on dotnet)
  it.skipIf(isWindows)('stops what the command left running in the background', async () => {
    const started = Date.now();
    const result = await runCommand('sleep 30 & echo $! >&2; echo done', { cwd: process.cwd(), env: buildEnv([]) });
    expect(result.code).toBe(0);
    expect(result.output).toContain('done');
    const straggler = Number(result.output.find((line) => /^\d+$/.test(line)));
    expect(straggler).toBeGreaterThan(0);
    expect(() => process.kill(straggler, 0)).toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('returns the exit code and output of a plain command', async () => {
    const result = await runCommand('echo hello', { cwd: process.cwd(), env: buildEnv([]) });
    expect(result.code).toBe(0);
    expect(result.output.map((line) => line.trim())).toContain('hello');
  });
});

describe('isPortFree', () => {
  // Vite on "localhost" binds only ::1 on Windows: such a port must not be handed to a mission
  it('counts a port taken only on ::1 as taken', async () => {
    const { createServer } = await import('node:net');
    const { isPortFree } = await import('../src/util/ports.js');
    const server = createServer();
    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(0, '::1', () => resolve(true));
    });
    if (!listening) return; // no IPv6 loopback here: nothing to check
    const { port } = server.address() as { port: number };
    expect(await isPortFree(port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await isPortFree(port)).toBe(true);
  });
});
