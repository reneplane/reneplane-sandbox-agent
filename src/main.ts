import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
import { addPack, isPackId, listPacks, PACK_IDS, removePack, type PackId } from './packs/index.js';
import { pruneRuntimes } from './runtimes/index.js';
import { formatBytes } from './util/disk.js';

/**
 * reneplane-local <command>
 *
 *   start              start in the background (what login runs); does nothing if already running
 *   serve              run in this terminal (logs to the console)
 *   stop | status      the running agent
 *   setup --token <t> --get <url>    what the install script runs after unpacking
 *   pair <token>       let the browser holding this install token pair
 *   doctor             check this computer
 *   packs              the stack packs and what they use on disk
 *   add <pack…>        install stack packs (e.g. add jdk21-maven mysql84)
 *   remove <pack>      delete a stack pack
 *   codebank check|compile|init     authoring tools (see src/codebank/cli.ts)
 *   problem new <ID> --from-commit <sha>
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
  // Before any mission runs: what earlier versions downloaded and no longer need
  pruneRuntimes();
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
      const targets = flag('all') ? [PATHS.home] : [PATHS.bin, join(PATHS.home, 'agent.json')];
      if (process.platform === 'win32') {
        // This command runs on bin\node.exe, which Windows won't delete while it runs: remove the rest
        // now, and the folders a moment after this process exits
        for (const target of targets) {
          if (target === PATHS.home) {
            for (const entry of readdirSync(PATHS.home)) if (join(PATHS.home, entry) !== PATHS.bin) rmSync(join(PATHS.home, entry), { recursive: true, force: true });
          } else if (target !== PATHS.bin) rmSync(target, { recursive: true, force: true });
        }
        const folder = flag('all') ? PATHS.home : PATHS.bin;
        // cmd.exe parses its own quotes: pass the command line verbatim (/s keeps the outer quotes simple)
        spawn('cmd.exe', ['/d', '/s', '/c', `"ping -n 4 127.0.0.1 >nul & rmdir /s /q "${folder}""`], { detached: true, windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
      } else {
        for (const target of targets) rmSync(target, { recursive: true, force: true });
      }
      console.log(
        flag('all')
          ? 'Reneplane Local and everything it downloaded were removed.'
          : `Reneplane Local was removed. Your missions and downloaded runtimes are still in ${PATHS.home} (use --all to remove them too).`,
      );
      return;
    }

    case 'packs': {
      for (const pack of listPacks()) {
        const state = pack.state === 'installed' ? `installed, ${formatBytes(pack.sizeBytes)}` : pack.state === 'unavailable' ? 'not available on this computer' : 'not installed';
        console.log(`${pack.id.padEnd(14)} ${pack.label.padEnd(15)} ${state}`);
      }
      return;
    }

    case 'add': {
      const ids = rest.filter((arg) => !arg.startsWith('--'));
      const unknown = ids.filter((id) => !isPackId(id));
      if (!ids.length || unknown.length) {
        console.error(`Usage: reneplane-local add <pack…>   packs: ${PACK_IDS.join(', ')}${unknown.length ? `\nUnknown: ${unknown.join(', ')}` : ''}`);
        process.exitCode = 2;
        return;
      }
      for (const id of ids as PackId[]) {
        let last = '';
        const info = await addPack(id, (detail) => {
          if (detail !== last && process.stdout.isTTY) process.stdout.write(`\r${id}: ${detail}`.padEnd(70).slice(0, 70));
          last = detail;
        });
        if (process.stdout.isTTY) process.stdout.write('\r'.padEnd(71) + '\r');
        console.log(`${info.label} is ready (${formatBytes(info.sizeBytes)})`);
      }
      return;
    }

    case 'remove': {
      const id = rest[0] ?? '';
      if (!isPackId(id)) {
        console.error(`Usage: reneplane-local remove <pack>   packs: ${PACK_IDS.join(', ')}`);
        process.exitCode = 2;
        return;
      }
      const status = (await control('status')) as { packsInUse?: PackId[] } | null;
      removePack(id, status?.packsInUse ?? []);
      console.log(`${id} removed.`);
      return;
    }

    case 'codebank': {
      // Authoring tools: loaded only when used, so the agent itself starts as fast as before
      const { codebankCommand } = await import('./codebank/cli.js');
      process.exitCode = await codebankCommand(rest);
      return;
    }

    case 'problem': {
      const { problemCommand } = await import('./codebank/cli.js');
      process.exitCode = await problemCommand(rest);
      return;
    }

    case 'version':
    case '--version':
      console.log(AGENT_VERSION);
      return;

    default:
      console.error(`Unknown command "${command}". Commands: start, serve, stop, status, setup, pair, doctor, packs, add, remove, codebank, problem, config, uninstall, version`);
      process.exitCode = 2;
  }
}

main().catch((error: Error) => {
  log.error('Fatal', error);
  console.error(error.message);
  process.exit(1);
});
