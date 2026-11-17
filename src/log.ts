import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './config.js';

/** The agent's own log: ~/.reneplane/logs/agent.log (rotated at 5 MB), and stdout when attached to a terminal */

const FILE = () => join(PATHS.logs, 'agent.log');
const MAX_BYTES = 5 * 1024 * 1024;
let toConsole = process.stdout.isTTY ?? false;

export function logToConsole(enabled: boolean): void {
  toConsole = enabled;
}

function write(level: string, scope: string, message: string, extra?: unknown): void {
  const detail = extra instanceof Error ? ` ${extra.stack ?? extra.message}` : extra === undefined ? '' : ` ${safeJson(extra)}`;
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${message}${detail}`;
  if (toConsole) (level === 'ERROR' ? console.error : console.log)(line);
  try {
    const file = FILE();
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
    appendFileSync(file, `${line}\n`);
  } catch {
    // Logging must never take the agent down
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(scope: string) {
  return {
    info: (message: string, extra?: unknown) => write('INFO', scope, message, extra),
    warn: (message: string, extra?: unknown) => write('WARN', scope, message, extra),
    error: (message: string, extra?: unknown) => write('ERROR', scope, message, extra),
  };
}
