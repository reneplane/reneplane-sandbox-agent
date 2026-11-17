import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, updateConfig } from './config.js';
import { runDoctor } from './doctor.js';
import { createLogger, logToConsole } from './log.js';
import { addPendingPairing } from './pairing.js';
import { STATUS_FILE, startServer } from './server.js';
import { AGENT_VERSION } from './version.js';

/**
 * reneplane-local <command>
 *
 *   start              start in the background (what login runs); does nothing if already running
 *   serve              run in this terminal (logs to the console)
 *   stop | status      the running agent
 *   pair <token>       let the browser holding this install token pair (the install script runs this)
 *   doctor             check this computer
 *   config set <key> <value>
 *
 * Options for serve: --dev (also accept http://localhost:5175), --codebanks <dir> (dev: clone codebanks from <dir>)
 */

const log = createLogger('main');
const [command = 'serve', ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);
const option = (name: string) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
};

async function control(path: string, body?: unknown): Promise<unknown> {
  if (!existsSync(STATUS_FILE())) return null;
  const { port } = JSON.parse(readFileSync(STATUS_FILE(), 'utf8')) as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/control/${path}`, {
      method: 'POST',
      headers: { 'x-reneplane-control': loadConfig().controlToken, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(3000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  switch (command) {
    case 'serve': {
      logToConsole(true);
      const running = await startServer({
        dev: flag('dev'),
        codebankDir: option('codebanks'),
        onStopRequested: () => void shutdown(),
      });
      let stopping = false;
      async function shutdown() {
        if (stopping) return;
        stopping = true;
        log.info('Stopping');
        await running.close();
        process.exit(0);
      }
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      return;
    }

    case 'start': {
      if (await control('status')) {
        console.log('Reneplane Local is already running.');
        return;
      }
      // Respawn detached and hidden, then exit: at login this keeps the console window to a brief flash
      const script = fileURLToPath(import.meta.url);
      const child = spawn(process.execPath, [script, 'serve', ...rest.filter((arg) => arg !== '--from-login')], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      });
      child.unref();
      if (!flag('from-login')) console.log('Reneplane Local started.');
      return;
    }

    case 'stop': {
      const stopped = await control('stop');
      console.log(stopped ? 'Reneplane Local stopped.' : 'Reneplane Local is not running.');
      return;
    }

    case 'status': {
      const status = await control('status');
      console.log(status ? JSON.stringify(status, null, 2) : 'Reneplane Local is not running.');
      process.exitCode = status ? 0 : 1;
      return;
    }

    case 'pair': {
      const token = rest[0] ?? '';
      // Prefer telling the running agent; fall back to the config file it reads on every hello
      if (!(await control('pair', { token }))) addPendingPairing(token);
      console.log('Paired. Go back to the workspace tab.');
      return;
    }

    case 'doctor': {
      const report = await runDoctor();
      console.log(`Reneplane Local ${report.agentVersion} on ${report.platform}-${report.arch}`);
      for (const check of report.checks) {
        const mark = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', info: '    ' }[check.status];
        console.log(`${mark} ${check.label}: ${check.detail}${check.fix ? `\n       ${check.fix}` : ''}`);
      }
      return;
    }

    case 'config': {
      const [action, key, value] = rest;
      if (action === 'set' && key === 'allowPreviewOrigins' && (value === 'true' || value === 'false')) {
        updateConfig((config) => {
          config.allowPreviewOrigins = value === 'true';
        });
        console.log(`allowPreviewOrigins = ${value}`);
        return;
      }
      console.error('Usage: reneplane-local config set allowPreviewOrigins true|false');
      process.exitCode = 2;
      return;
    }

    case 'version':
    case '--version':
      console.log(AGENT_VERSION);
      return;

    default:
      console.error(`Unknown command "${command}". Commands: start, serve, stop, status, pair, doctor, config, version`);
      process.exitCode = 2;
  }
}

main().catch((error: Error) => {
  log.error('Fatal', error);
  console.error(error.message);
  process.exit(1);
});
