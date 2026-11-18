// Dev helper: start one debug adapter against a mission's code, stop at a breakpoint, print the stack and
// variables, continue. Exercises src/debug/adapters.ts without the IDE.
//   RENEPLANE_HOME=~/.reneplane-dev npx tsx scripts/dev-debug-probe.ts dotnet <repoDir> <file> <line>
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { DebugProtocol } from '../src/debug/dap.js';
import { startDotnetAdapter, type StartedAdapter } from '../src/debug/adapters.js';
import { ensureRuntime } from '../src/runtimes/index.js';
import { buildEnv } from '../src/util/process.js';

const [kind = 'dotnet', repoDir = '', file = '', lineText = '1'] = process.argv.slice(2);
const line = Number(lineText);
const absolute = join(repoDir, file);

function run(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function stopped(dap: DebugProtocol, timeoutMs = 60_000): Promise<{ reason: string; threadId: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no stopped event')), timeoutMs);
    dap.onEvent((event, body) => {
      if (event === 'output') process.stdout.write(`  [output] ${String((body as { output: string }).output)}`);
      if (event !== 'stopped') return;
      clearTimeout(timer);
      resolve(body as { reason: string; threadId: number });
    });
  });
}

async function inspect(dap: DebugProtocol, threadId: number): Promise<void> {
  const { stackFrames } = await dap.request<{ stackFrames: { id: number; name: string; line: number; source?: { path?: string } }[] }>('stackTrace', { threadId, levels: 5 });
  for (const frame of stackFrames) console.log(`  frame ${frame.name} ${frame.source?.path ?? '(no source)'}:${frame.line}`);
  const { scopes } = await dap.request<{ scopes: { name: string; variablesReference: number }[] }>('scopes', { frameId: stackFrames[0]!.id });
  for (const scope of scopes.slice(0, 2)) {
    const { variables } = await dap.request<{ variables: { name: string; value: string; type?: string; variablesReference: number }[] }>('variables', { variablesReference: scope.variablesReference });
    console.log(`  scope ${scope.name}: ${variables.slice(0, 8).map((variable) => `${variable.name}=${variable.value.slice(0, 60)}`).join(', ')}`);
  }
}

let adapter: StartedAdapter | null = null;
try {
  if (kind === 'dotnet') {
    const dotnet = await ensureRuntime('dotnet');
    const netcoredbg = await ensureRuntime('netcoredbg');
    const env = buildEnv(dotnet.path, dotnet.env);
    const out = join(repoDir, '.reneplane-out', 'debug');
    console.log('building…');
    if ((await run('dotnet', ['build', 'ShopKart.Api', '--artifacts-path', out, '-nologo', '-v', 'q'], join(repoDir, 'backend'), env)) !== 0) throw new Error('build failed');
    const waiting = { promise: null as Promise<{ reason: string; threadId: number }> | null };
    adapter = await startDotnetAdapter({
      netcoredbgDir: netcoredbg.dir,
      program: join(out, 'bin', 'ShopKart.Api', 'debug', 'ShopKart.Api.dll'),
      cwd: join(repoDir, 'backend', 'ShopKart.Api'),
      env: { ...dotnet.env, DATABASE_URL: 'Server=tcp:127.0.0.1,1;Database=x;User Id=x;Password=x;Encrypt=True;TrustServerCertificate=True', PORT: '8077' },
      path: dotnet.path,
      breakpoints: [{ path: absolute, lines: [line] }],
      onLog: (text) => console.log(`  [netcoredbg] ${text}`),
    });
    console.log('capabilities:', Object.keys(adapter.capabilities).filter((key) => adapter!.capabilities[key] === true).slice(0, 8).join(', '));
    console.log('breakpoints:', JSON.stringify([...adapter.breakpoints.values()]));
    waiting.promise = stopped(adapter.dap);
    const hit = await waiting.promise;
    console.log(`stopped: ${hit.reason} on thread ${hit.threadId}`);
    await inspect(adapter.dap, hit.threadId);
    await adapter.dap.request('continue', { threadId: hit.threadId });
    const health = await fetch('http://127.0.0.1:8077/api/health').then((response) => response.text()).catch((error: Error) => error.message);
    console.log('after continue, /api/health:', health);
  } else {
    // node / python: start the backend with its debugger port open, attach, then call /api/health
    const debugPort = kind === 'node' ? 9339 : kind === 'java' ? 5005 : 5679;
    let command: string;
    let args: string[];
    let env: Record<string, string>;
    if (kind === 'java') {
      const java = await ensureRuntime('java');
      env = buildEnv(java.path, { ...java.env, DATABASE_URL: 'jdbc:mysql://127.0.0.1:1/x', DB_USER: 'x', DB_PASSWORD: 'x', SERVER_PORT: '8078' });
      command = process.platform === 'win32' ? String.raw`.\mvnw.cmd` : './mvnw';
      args = ['-B', '-q', 'spring-boot:run', `"-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:${debugPort}"`, '"-Dspring-boot.run.arguments=--spring.flyway.enabled=false"'];
    } else if (kind === 'node') {
      const node = await ensureRuntime('node');
      env = buildEnv(node.path, { DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x', PORT: '8078' });
      command = 'node';
      args = [`--inspect=127.0.0.1:${debugPort}`, '--import', 'tsx', 'src/server.ts'];
    } else {
      const uv = await ensureRuntime('uv');
      const debugpy = await ensureRuntime('debugpy');
      env = buildEnv(uv.path, { ...uv.env, PYTHONPATH: debugpy.dir, DATABASE_URL: 'postgresql+psycopg://x:x@127.0.0.1:1/x' });
      command = 'uv';
      args = ['run', '--frozen', 'python', '-m', 'debugpy', '--listen', `127.0.0.1:${debugPort}`, '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8078'];
    }
    const backend = spawn(command, args, { cwd: join(repoDir, 'backend'), env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    backend.stdout.on('data', (chunk: Buffer) => process.stdout.write(`  [backend] ${chunk}`));
    backend.stderr.on('data', (chunk: Buffer) => process.stdout.write(`  [backend] ${chunk}`));
    try {
      const { startNodeAdapter, startPythonAdapter } = await import('../src/debug/adapters.js');
      if (kind === 'node') {
        const jsdebug = await ensureRuntime('jsdebug');
        const node = await ensureRuntime('node');
        await new Promise((resolve) => setTimeout(resolve, 2500));
        adapter = await startNodeAdapter({
          jsDebugDir: jsdebug.dir,
          nodeBinary: join(node.path[0]!, process.platform === 'win32' ? 'node.exe' : 'node'),
          inspectPort: debugPort,
          repoDir,
          breakpoints: [{ path: absolute, lines: [line] }],
          onLog: (text) => console.log(`  [js-debug] ${text}`),
        });
      } else if (kind === 'java') {
        const { JavaDebugBridge } = await import('../src/debug/java.js');
        const { handshake } = await import('../src/debug/adapters.js');
        for (let attempt = 0; attempt < 90; attempt += 1) {
          const up = await fetch('http://127.0.0.1:8078/api/health', { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
          if (up) break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        const bridge = await JavaDebugBridge.attach({ port: debugPort, sourceRoots: [join(repoDir, 'backend', 'src', 'main', 'java')] });
        const result = await handshake(bridge, 'java', 'attach', {}, [{ path: absolute, lines: [line] }]);
        adapter = { dap: bridge, ...result, dispose: async () => void (await bridge.request('disconnect', {}).catch(() => undefined)) };
      } else {
        adapter = await startPythonAdapter({ port: debugPort, repoDir, breakpoints: [{ path: absolute, lines: [line] }] });
      }
      console.log('breakpoints:', JSON.stringify([...adapter.breakpoints.values()]));
      const hitting = stopped(adapter.dap);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const up = await fetch('http://127.0.0.1:8078/api/health', { signal: AbortSignal.timeout(500) }).then(() => true, (error: Error) => error.name === 'TimeoutError');
        if (up) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const request = fetch('http://127.0.0.1:8078/api/health').then((response) => response.text());
      const hit = await hitting;
      console.log(`stopped: ${hit.reason} on thread ${hit.threadId}`);
      await inspect(adapter.dap, hit.threadId);
      // Step over once, then let every later stop (the readiness probe's requests hit it too) carry on
      const stepped = stopped(adapter.dap, 8000).catch(() => null);
      await adapter.dap.request('next', { threadId: hit.threadId });
      const afterStep = await stepped;
      const dap = adapter.dap;
      dap.onEvent((event, body) => {
        if (event === 'stopped') void dap.request('continue', { threadId: (body as { threadId: number }).threadId });
      });
      if (afterStep) {
        const top = await dap.request<{ stackFrames: { name: string; line: number }[] }>('stackTrace', { threadId: afterStep.threadId, levels: 1 });
        console.log(`after step (${afterStep.reason}): ${top.stackFrames[0]?.name}:${top.stackFrames[0]?.line}`);
        await dap.request('continue', { threadId: afterStep.threadId });
      } else {
        console.log('after step: left the learner code, running on');
      }
      console.log('after continue, /api/health:', await request);
    } finally {
      await adapter?.dispose();
      adapter = null;
      const { killTree } = await import('../src/util/process.js');
      await killTree(backend);
    }
  }
} catch (error) {
  console.log("PROBE FAILED:", (error as Error).stack ?? error);
} finally {
  await adapter?.dispose();
  process.exit(0);
}
