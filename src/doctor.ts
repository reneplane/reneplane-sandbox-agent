import { existsSync, statfsSync } from 'node:fs';
import { cpus, freemem, release, totalmem, version } from 'node:os';
import { join } from 'node:path';
import { loadConfig, PATHS } from './config.js';
import { installedRuntimes, LABELS } from './runtimes/index.js';
import { runFile } from './util/process.js';
import { AGENT_VERSION } from './version.js';

/** The Doctor: is this computer ready for missions, and if not, what to do about it */

export interface DoctorCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  agentVersion: string;
  platform: string;
  arch: string;
  checks: DoctorCheck[];
}

const GB = 1024 ** 3;

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const ram = totalmem() / GB;
  const free = freemem() / GB;
  checks.push({
    id: 'ram',
    label: 'Memory',
    status: ram < 3.5 ? 'fail' : ram < 7.5 || free < 1 ? 'warn' : 'ok',
    detail: `${ram.toFixed(1)} GB total, ${free.toFixed(1)} GB free right now`,
    fix:
      free < 1
        ? 'Your computer is almost out of memory, so tests and servers may crash. Close apps you are not using (IDEs, Docker, browsers with many tabs), then try again.'
        : ram < 7.5
          ? 'Node, Python and SQL missions run fine; Java and .NET may be slow. Close other heavy apps while you work.'
          : undefined,
  });

  const cores = cpus().length;
  checks.push({ id: 'cpu', label: 'Processor', status: cores >= 4 ? 'ok' : 'warn', detail: `${cores} cores` });

  try {
    const stats = statfsSync(PATHS.home);
    const free = (stats.bavail * stats.bsize) / GB;
    checks.push({
      id: 'disk',
      label: 'Free disk space',
      status: free >= 20 ? 'ok' : free >= 8 ? 'warn' : 'fail',
      detail: `${free.toFixed(0)} GB free`,
      fix: free < 20 ? 'Each stack needs 0.5–2 GB the first time. Free up space, or remove runtimes you no longer use.' : undefined,
    });
  } catch {
    // statfs isn't available everywhere
  }

  checks.push({ id: 'os', label: 'Operating system', status: 'ok', detail: `${version()} (${release()})` });

  if (process.platform === 'win32') {
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const hasRuntime = existsSync(join(system, 'vcruntime140.dll')) && existsSync(join(system, 'msvcp140.dll'));
    checks.push({
      id: 'vcruntime',
      label: 'Microsoft Visual C++ runtime',
      status: hasRuntime ? 'ok' : 'fail',
      detail: hasRuntime ? 'Installed' : 'Missing: PostgreSQL and MySQL need it',
      fix: hasRuntime ? undefined : 'Install the "Visual C++ Redistributable for Visual Studio 2015–2022 (x64)" from Microsoft: https://aka.ms/vs/17/release/vc_redist.x64.exe',
    });
  }

  for (const runtime of installedRuntimes()) {
    checks.push({
      id: `runtime:${runtime.name}`,
      label: `${LABELS[runtime.name]} ${runtime.version}`,
      status: 'info',
      detail: runtime.installed ? 'Downloaded' : 'Downloads the first time a mission needs it',
    });
  }

  const docker = await runFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 5000 });
  checks.push({
    id: 'docker',
    label: 'Docker',
    status: 'info',
    detail: docker.code === 0 ? `Running (${docker.stdout.trim()}). Not needed for missions.` : 'Not running. Not needed for missions.',
  });

  const config = loadConfig();
  if (config.allowPreviewOrigins) {
    checks.push({
      id: 'preview-origins',
      label: 'Preview sites allowed',
      status: 'warn',
      detail: 'This agent also accepts Reneplane preview sites (*.reneplane-workspace.pages.dev). For testers only.',
      fix: 'Turn it off with: reneplane-local config set allowPreviewOrigins false',
    });
  }

  return { agentVersion: AGENT_VERSION, platform: process.platform, arch: process.arch, checks };
}
