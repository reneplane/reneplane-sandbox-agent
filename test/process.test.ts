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
