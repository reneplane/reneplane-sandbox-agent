import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { PATHS, updateConfig } from './config.js';
import { createLogger } from './log.js';
import { addPendingPairing } from './pairing.js';
import { runFile } from './util/process.js';
import { AGENT_VERSION } from './version.js';

/**
 * What the one-line install command does after unpacking: pair the browser that holds the install
 * token, register this computer with get.reneplane.com (a signed device token for the SQL Server
 * pool and the grader), and start at login. No admin rights anywhere.
 *
 *   Windows  HKCU Run entry → the signed node.exe runs launch.mjs start (a brief console flash, then hidden)
 *   macOS    ~/Library/LaunchAgents/com.reneplane.local.plist (restarted by launchd if it crashes)
 *   Linux    ~/.config/systemd/user/reneplane-local.service (restarted by systemd if it crashes)
 */

const log = createLogger('install');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'ReneplaneLocal';
const PLIST = () => join(homedir(), 'Library', 'LaunchAgents', 'com.reneplane.local.plist');
const UNIT = () => join(homedir(), '.config', 'systemd', 'user', 'reneplane-local.service');

export const launchScript = () => join(PATHS.bin, 'launch.mjs');

export async function setup(options: { token: string; getUrl: string }): Promise<void> {
  addPendingPairing(options.token);
  await installCommandShim().catch((error: Error) => log.warn('Could not add reneplane-local to PATH', error.message));
  await redeemDevice(options.token, options.getUrl).catch((error: Error) => {
    // Not fatal: local missions work without it; the agent retries when it starts
    log.warn('Could not register this computer yet', error.message);
    updateConfig((config) => {
      config.pendingRedeem = { token: options.token, getUrl: options.getUrl };
    });
    console.log('  (Could not reach Reneplane to register this computer; it will retry. Local missions work now.)');
  });
  await registerAutostart();
}

/** Swap the one-time install token for a long-lived device token signed by get.reneplane.com */
export async function redeemDevice(token: string, getUrl: string): Promise<void> {
  const response = await fetch(`${getUrl}/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, platform: process.platform, arch: process.arch, version: AGENT_VERSION }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`get.reneplane.com answered ${response.status}`);
  const { deviceToken } = (await response.json()) as { deviceToken: string };
  updateConfig((config) => {
    config.deviceToken = deviceToken;
    config.pendingRedeem = null;
  });
}

export async function registerAutostart(): Promise<void> {
  const node = process.execPath;
  const launch = launchScript();
  if (process.platform === 'win32') {
    const command = `"${node}" "${launch}" start --from-login`;
    const result = await runFile('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', command, '/f']);
    if (result.code !== 0) throw new Error(`Couldn't register start at login: ${result.stderr.trim()}`);
    return;
  }
  if (process.platform === 'darwin') {
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    mkdirSync(PATHS.logs, { recursive: true });
    writeFileSync(
      PLIST(),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.reneplane.local</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${launch}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${join(PATHS.logs, 'launchd.log')}</string>
  <key>StandardErrorPath</key><string>${join(PATHS.logs, 'launchd.log')}</string>
</dict>
</plist>
`,
    );
    const domain = `gui/${userInfo().uid}`;
    await runFile('launchctl', ['bootout', domain, PLIST()]);
    const result = await runFile('launchctl', ['bootstrap', domain, PLIST()]);
    if (result.code !== 0) throw new Error(`launchctl couldn't load the agent: ${result.stderr.trim()}`);
    return;
  }
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(
    UNIT(),
    `[Unit]
Description=Reneplane Local (runs Reneplane Workspace missions)

[Service]
ExecStart="${node}" "${launch}" serve
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`,
  );
  await runFile('systemctl', ['--user', 'daemon-reload']);
  const result = await runFile('systemctl', ['--user', 'enable', '--now', 'reneplane-local.service']);
  if (result.code !== 0) throw new Error(`systemd couldn't start the agent: ${result.stderr.trim()}`);
}

/** A `reneplane-local` command in new terminals: a shim in ~/.reneplane/bin, put on the user's PATH */
export async function installCommandShim(): Promise<void> {
  if (process.platform === 'win32') {
    writeFileSync(join(PATHS.bin, 'reneplane-local.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0launch.mjs" %*\r\n');
    // .NET's SetEnvironmentVariable updates the user PATH and tells running apps (setx truncates long paths)
    const script = `$bin = '${PATHS.bin.replace(/'/g, "''")}'; $path = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not $path) { $path = '' }; if (($path -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', (($path.TrimEnd(';') + ';' + $bin).TrimStart(';')), 'User') }`;
    await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return;
  }
  const shim = join(PATHS.bin, 'reneplane-local');
  writeFileSync(shim, `#!/bin/sh\nexec "${join(PATHS.bin, 'node')}" "${join(PATHS.bin, 'launch.mjs')}" "$@"\n`, { mode: 0o755 });
  // ~/.local/bin is on PATH in most Linux shells and many macOS setups
  const local = join(homedir(), '.local', 'bin');
  mkdirSync(local, { recursive: true });
  rmSync(join(local, 'reneplane-local'), { force: true });
  await runFile('ln', ['-s', shim, join(local, 'reneplane-local')]);
}

/** True when the OS service manager starts and restarts the agent (macOS, Linux) */
export function managedByService(): boolean {
  return (process.platform === 'darwin' && existsSync(PLIST())) || (process.platform === 'linux' && existsSync(UNIT()));
}

export async function startManaged(): Promise<boolean> {
  if (process.platform === 'darwin' && existsSync(PLIST())) {
    return (await runFile('launchctl', ['kickstart', `gui/${userInfo().uid}/com.reneplane.local`])).code === 0;
  }
  if (process.platform === 'linux' && existsSync(UNIT())) {
    return (await runFile('systemctl', ['--user', 'start', 'reneplane-local.service'])).code === 0;
  }
  return false;
}

export async function unregisterAutostart(): Promise<void> {
  if (process.platform === 'win32') {
    await runFile('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
  } else if (process.platform === 'darwin') {
    await runFile('launchctl', ['bootout', `gui/${userInfo().uid}`, PLIST()]);
    rmSync(PLIST(), { force: true });
  } else {
    await runFile('systemctl', ['--user', 'disable', '--now', 'reneplane-local.service']);
    rmSync(UNIT(), { force: true });
  }
}
