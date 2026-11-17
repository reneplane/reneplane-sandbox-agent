import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { delimiter } from 'node:path';

/**
 * Starting and stopping the programs a mission needs. Every child is started without a window
 * (the agent itself runs hidden, so a visible console per service would pop up on Windows).
 */

export const isWindows = process.platform === 'win32';

export type Env = Record<string, string>;

/** The parent environment plus extra PATH entries (first wins) and variables */
export function buildEnv(pathFirst: string[], extra: Env = {}): Env {
  const base: Env = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) base[key] = value;
  // Windows env keys are case-insensitive; normalise PATH so we don't end up with Path and PATH
  const pathKey = Object.keys(base).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const current = base[pathKey] ?? '';
  delete base[pathKey];
  return { ...base, ...extra, PATH: [...pathFirst, current].filter(Boolean).join(delimiter) };
}

export interface Spawned {
  child: ChildProcess;
  /** Kill the process and everything it started */
  kill(): Promise<void>;
  exited: Promise<number | null>;
}

/** Start a long-running command through the shell, streaming its output line by line */
export function startCommand(
  command: string,
  options: { cwd: string; env: Env; onLine?: (line: string, stream: 'stdout' | 'stderr') => void },
): Spawned {
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    shell: true,
    windowsHide: true,
    // On POSIX a new process group lets us kill the whole tree with kill(-pid)
    detached: !isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  const child = spawn(command, spawnOptions);
  if (options.onLine) {
    pipeLines(child.stdout!, (line) => options.onLine!(line, 'stdout'));
    pipeLines(child.stderr!, (line) => options.onLine!(line, 'stderr'));
  }
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(-1));
  });
  return { child, exited, kill: () => killTree(child, exited) };
}

/** Run a command to completion; resolves with its exit code and output */
export async function runCommand(
  command: string,
  options: { cwd: string; env: Env; onLine?: (line: string, stream: 'stdout' | 'stderr') => void; timeoutMs?: number },
): Promise<{ code: number | null; output: string[] }> {
  const output: string[] = [];
  const spawned = startCommand(command, {
    ...options,
    onLine: (line, stream) => {
      output.push(line);
      options.onLine?.(line, stream);
    },
  });
  let timer: NodeJS.Timeout | undefined;
  if (options.timeoutMs) timer = setTimeout(() => void spawned.kill(), options.timeoutMs);
  const code = await spawned.exited;
  if (timer) clearTimeout(timer);
  return { code, output };
}

/** Run a program directly (no shell), for tools the agent controls, e.g. git or pg_ctl */
export function runFile(
  file: string,
  args: string[],
  options: { cwd?: string; env?: Env; input?: string; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs) timer = setTimeout(() => child.kill(), options.timeoutMs);
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    child.on('error', (error) => {
      stderr.push(Buffer.from(error.message));
      finish(-1);
    });
    child.on('close', (code) => finish(code));
    // A program that starts a server (pg_ctl start) hands its output pipes to that server, so they
    // never close. Once the program itself has exited, stop waiting for them after a moment.
    child.on('exit', (code) => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code);
      }, 300);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function killTree(child: ChildProcess, exited?: Promise<unknown>): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    const forced = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
    }, 5000);
    await exited;
    clearTimeout(forced);
    return;
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
}

function pipeLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(buffer[index] === '\r' ? index + 2 : index + 1);
      onLine(stripAnsiControl(line));
    }
  });
  stream.on('end', () => {
    if (buffer) onLine(stripAnsiControl(buffer));
  });
}

/** Keep colours for the IDE's log view, but drop cursor movement and screen clearing */
function stripAnsiControl(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;]*[ABCDEFGHJKSTfsu]|\u001b\[\?[0-9;]*[hl]|\u001bc/g, '');
}
