import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, PATHS, updateConfig } from './config.js';
import { runDoctor } from './doctor.js';
import { launchScript, managedByService, redeemDevice, setup, startManaged, unregisterAutostart } from './install.js';
import { createLogger, logToConsole } from './log.js';
import { addPendingPairing } from './pairing.js';
import { STATUS_FILE, startServer } from './server.js';
import { downloadUpdate, pruneOldVersions, RESTART_EXIT_CODE, switchTo } from './update.js';
import { AGENT_VERSION } from './version.js';

/**
 * reneplane-local <command>
 *
 *   start              start in the background (what login runs); does nothing if already running
 *   serve              run in this terminal (logs to the console)
 *   stop | status      the running agent
 *   setup --token <t> --get <url>    what the install script runs after unpacking
 *   pair <token>       let the browser holding this install token pair
 *   doctor             check this computer
 *   config set <key> <value>
 *   uninstall [--all]  remove start-at-login and the agent (--all: also runtimes and missions)
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

/** The script to respawn: the installed launcher, or this file when running from a checkout */
function entryScript(): string {
  return existsSync(launchScript()) ? launchScript() : fileURLToPath(import.meta.url);
}

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

async function waitUntilStopped(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && (await control('status'))) await new Promise((resolve) => setTimeout(resolve, 500));
}

/** Start in the background: through launchd/systemd where they manage it, else a hidden supervisor */
async function startInBackground(): Promise<void> {
  if (await control('status')) return;
  if (managedByService() && (await startManaged())) return;
  const child = spawn(process.execPath, [entryScript(), 'supervise'], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
}

async function serve(): Promise<void> {
  logToConsole(process.stdout.isTTY ?? false);
  pruneOldVersions();
  const running = await startServer({ dev: flag('dev'), codebankDir: option('codebanks'), onStopRequested: () => void shutdown(0) });
  let stopping = false;
  async function shutdown(code: number) {
    if (stopping) return;
    stopping = true;
    log.info(code === RESTART_EXIT_CODE ? 'Restarting into the new version' : 'Stopping');
    await running.close();
    process.exit(code);
  }
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  // Finish registering this computer if the install couldn't reach get.reneplane.com
  const pending = loadConfig().pendingRedeem;
  if (pending) void redeemDevice(pending.token, pending.getUrl).then(() => log.info('Registered this computer'), () => undefined);

  // Updates: a few minutes after start, then every 6 hours; switch over once no mission is running
  const checkForUpdate = async () => {
    try {
      const version = await downloadUpdate();
      if (!version) return;
      switchTo(version);
      const restartWhenIdle = () => (running.busy() ? setTimeout(restartWhenIdle, 60_000) : void shutdown(RESTART_EXIT_CODE));
      restartWhenIdle();
    } catch (error) {
      log.warn('Update check failed', (error as Error).message);
    }
  };
  if (!flag('dev')) {
    setTimeout(() => void checkForUpdate(), 3 * 60_000);
    setInterval(() => void checkForUpdate(), 6 * 60 * 60_000);
  }
}

/** Keeps `serve` running on Windows (launchd and systemd do this elsewhere): restarts after a crash or an update */
async function supervise(): Promise<void> {
  let crashes: number[] = [];
  for (;;) {
    const child = spawn(process.execPath, [entryScript(), 'serve'], { windowsHide: true, stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    if (code === 0) return;
    if (code === RESTART_EXIT_CODE) continue;
    crashes = [...crashes.filter((at) => Date.now() - at < 10 * 60_000), Date.now()];
    log.warn(`Reneplane Local exited with code ${code}; restarting (${crashes.length} in 10 minutes)`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 2000 * 2 ** Math.min(crashes.length, 5))));
  }
}

async function main(): Promise<void> {
  switch (command) {
    case 'serve':
      return serve();

    case 'supervise':
      return supervise();

    case 'start': {
      const already = await control('status');
      await startInBackground();
      if (!flag('from-login')) console.log(already ? 'Reneplane Local is already running.' : 'Reneplane Local started.');
      return;
    }

    case 'setup': {
      const token = option('token');
      const getUrl = option('get') ?? 'https://get.reneplane.com';
      if (!token) throw new Error('setup needs --token');
      await setup({ token, getUrl });
      // A running older version stops; the new one starts
      if (await control('stop')) await waitUntilStopped();
      await startInBackground();
      console.log('Done, you can close this window.');
      return;
    }

    case 'stop': {
      const stopped = await control('stop');
      if (stopped) await waitUntilStopped();
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

    case 'uninstall': {
      if (await control('stop')) await waitUntilStopped();
      await unregisterAutostart();
      for (const dir of flag('all') ? [PATHS.home] : [PATHS.bin, join(PATHS.home, 'agent.json')]) rmSync(dir, { recursive: true, force: true });
      console.log(
        flag('all')
          ? 'Reneplane Local and everything it downloaded were removed.'
          : `Reneplane Local was removed. Your missions and downloaded runtimes are still in ${PATHS.home} (use --all to remove them too).`,
      );
      return;
    }

    case 'version':
    case '--version':
      console.log(AGENT_VERSION);
      return;

    default:
      console.error(`Unknown command "${command}". Commands: start, serve, stop, status, setup, pair, doctor, config, uninstall, version`);
      process.exitCode = 2;
  }
}

main().catch((error: Error) => {
  log.error('Fatal', error);
  console.error(error.message);
  process.exit(1);
});
