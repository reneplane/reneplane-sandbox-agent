import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { buildEnv, killTree, type Env } from '../util/process.js';
import { pickPort } from '../util/ports.js';
import { DapConnection, DapError, type DebugProtocol } from './dap.js';

/**
 * Starting a debug adapter for each stack and getting it to the point where breakpoints work:
 *   node     vscode-js-debug's DAP server, attached to `node --inspect`; it opens a child session
 *            (startDebugging) that does the real work
 *   python   debugpy, which the backend runs in-process (python -m debugpy --listen …); we attach
 *   dotnet   netcoredbg over stdio; it launches the built app itself
 *   java     our own JDWP bridge (jdwp.ts), attached to the JVM's -agentlib:jdwp port
 * Paths here are absolute; the session maps them to and from repo paths.
 */

export type AdapterKind = 'node' | 'python' | 'dotnet' | 'java';

export interface Capabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsEvaluateForHovers?: boolean;
  supportsSetVariable?: boolean;
  supportsTerminateRequest?: boolean;
  [key: string]: unknown;
}

export interface FileBreakpoints {
  /** Absolute path */
  path: string;
  lines: number[];
}

export interface BreakpointResult {
  line: number;
  verified: boolean;
  message?: string;
}

export interface StartedAdapter {
  dap: DebugProtocol;
  capabilities: Capabilities;
  breakpoints: Map<string, BreakpointResult[]>;
  /** Disconnects; adapters that launched the app stop it too */
  dispose(): Promise<void>;
}

const INITIALIZE = {
  clientID: 'reneplane',
  clientName: 'Reneplane',
  pathFormat: 'path',
  linesStartAt1: true,
  columnsStartAt1: true,
  supportsVariableType: true,
  supportsVariablePaging: false,
  supportsRunInTerminalRequest: false,
  supportsStartDebuggingRequest: true,
  supportsProgressReporting: false,
  supportsInvalidatedEvent: false,
  locale: 'en',
};

function waitForEvent(dap: DebugProtocol, name: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new DapError(`The debugger didn't send "${name}"`));
    }, timeoutMs);
    dap.onEvent((event, body) => {
      if (done || event !== name) return;
      done = true;
      clearTimeout(timer);
      resolve(body);
    });
  });
}

export async function setFileBreakpoints(dap: DebugProtocol, file: FileBreakpoints): Promise<BreakpointResult[]> {
  const response = await dap.request<{ breakpoints: { line?: number; verified: boolean; message?: string }[] }>('setBreakpoints', {
    source: { path: file.path },
    breakpoints: file.lines.map((line) => ({ line })),
    lines: file.lines,
    sourceModified: false,
  });
  return file.lines.map((line, index) => {
    const result = response.breakpoints?.[index];
    return { line: result?.line ?? line, verified: Boolean(result?.verified), message: result?.message };
  });
}

/**
 * The DAP start-up sequence: initialize → attach/launch → (initialized) → breakpoints →
 * configurationDone. Most adapters only answer attach/launch after configurationDone.
 */
export async function handshake(
  dap: DebugProtocol,
  adapterID: string,
  request: 'attach' | 'launch',
  configuration: Record<string, unknown>,
  breakpoints: FileBreakpoints[],
): Promise<{ capabilities: Capabilities; breakpoints: Map<string, BreakpointResult[]> }> {
  const initialized = waitForEvent(dap, 'initialized', 60_000);
  const capabilities = await dap.request<Capabilities>('initialize', { ...INITIALIZE, adapterID });
  const started = dap.request(request, configuration, 120_000);
  started.catch(() => undefined);
  await Promise.race([initialized, started.then(() => initialized)]);
  const results = new Map<string, BreakpointResult[]>();
  for (const file of breakpoints) results.set(file.path, await setFileBreakpoints(dap, file));
  // js-debug wants exception breakpoints set (even to none) before configurationDone
  await dap.request('setExceptionBreakpoints', { filters: [] }).catch(() => undefined);
  if (capabilities.supportsConfigurationDoneRequest !== false) await dap.request('configurationDone').catch(() => undefined);
  await started;
  return { capabilities, breakpoints: results };
}

/** Node: js-debug's server, attached to the inspector the backend opened (node --inspect=…) */
export async function startNodeAdapter(options: {
  jsDebugDir: string;
  nodeBinary: string;
  inspectPort: number;
  repoDir: string;
  breakpoints: FileBreakpoints[];
  onLog: (line: string) => void;
}): Promise<StartedAdapter> {
  const serverPort = await pickPort(47900, new Set());
  const server = spawn(options.nodeBinary, [join(options.jsDebugDir, 'src', 'dapDebugServer.js'), String(serverPort), '127.0.0.1'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (chunk: Buffer) => options.onLog(chunk.toString().trim()));
  const parent = await DapConnection.connectTcp(serverPort);

  // js-debug answers the parent attach by asking us to open a child session for the actual target
  let resolveChild!: (child: StartedAdapter) => void;
  let rejectChild!: (error: Error) => void;
  const childReady = new Promise<StartedAdapter>((resolve, reject) => {
    resolveChild = resolve;
    rejectChild = reject;
  });
  parent.onReverseRequest = async (command, args) => {
    if (command !== 'startDebugging') throw new DapError(`${command} is not supported`);
    const { configuration, request } = args as { configuration: Record<string, unknown>; request: 'attach' | 'launch' };
    const child = await DapConnection.connectTcp(serverPort);
    void handshake(child, 'pwa-node', request, configuration, options.breakpoints).then(
      ({ capabilities, breakpoints }) =>
        resolveChild({
          dap: child,
          capabilities,
          breakpoints,
          dispose: async () => {
            await child.request('disconnect', { terminateDebuggee: false }, 3000).catch(() => undefined);
            child.close();
            parent.close();
            await killTree(server);
          },
        }),
      rejectChild,
    );
    return {};
  };

  await handshake(
    parent,
    'pwa-node',
    'attach',
    {
      type: 'pwa-node',
      request: 'attach',
      name: 'backend',
      address: '127.0.0.1',
      port: options.inspectPort,
      cwd: options.repoDir,
      sourceMaps: true,
      skipFiles: ['<node_internals>/**', '**/node_modules/**'],
      resolveSourceMapLocations: ['**', '!**/node_modules/**'],
      continueOnAttach: true,
      attachExistingChildren: false,
    },
    [],
  ).catch((error: Error) => rejectChild(error));
  const timeout = setTimeout(() => rejectChild(new DapError("The JavaScript debugger couldn't attach to the backend")), 30_000);
  try {
    return await childReady;
  } catch (error) {
    parent.close();
    await killTree(server);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Python: debugpy runs inside the backend (python -m debugpy --listen 127.0.0.1:<port> …) */
export async function startPythonAdapter(options: { port: number; repoDir: string; breakpoints: FileBreakpoints[] }): Promise<StartedAdapter> {
  const dap = await DapConnection.connectTcp(options.port, 60_000);
  const { capabilities, breakpoints } = await handshake(dap, 'debugpy', 'attach', {
    name: 'backend',
    type: 'debugpy',
    request: 'attach',
    justMyCode: true,
    subProcess: false,
    redirectOutput: false,
    showReturnValue: true,
    cwd: options.repoDir,
  }, options.breakpoints);
  return {
    dap,
    capabilities,
    breakpoints,
    dispose: async () => {
      await dap.request('disconnect', { terminateDebuggee: false }, 3000).catch(() => undefined);
      dap.close();
    },
  };
}

/** .NET: netcoredbg launches the built app (dotnet <dll>) and debugs it */
export async function startDotnetAdapter(options: {
  netcoredbgDir: string;
  program: string;
  cwd: string;
  env: Env;
  path: string[];
  breakpoints: FileBreakpoints[];
  onLog: (line: string) => void;
}): Promise<StartedAdapter & { process: ChildProcess }> {
  const binary = join(options.netcoredbgDir, process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg');
  const env = buildEnv(options.path, options.env);
  const adapter = spawn(binary, ['--interpreter=vscode'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
  adapter.stderr?.on('data', (chunk: Buffer) => options.onLog(chunk.toString().trim()));
  const dap = new DapConnection(adapter.stdout!, adapter.stdin!, () => adapter.kill());
  const { capabilities, breakpoints } = await handshake(dap, 'coreclr', 'launch', {
    name: 'backend',
    type: 'coreclr',
    request: 'launch',
    program: options.program,
    args: [],
    cwd: options.cwd,
    env: options.env,
    stopAtEntry: false,
    justMyCode: true,
    enableStepFiltering: true,
    console: 'internalConsole',
  }, options.breakpoints);
  return {
    dap,
    capabilities,
    breakpoints,
    process: adapter,
    dispose: async () => {
      await dap.request('disconnect', { terminateDebuggee: true }, 5000).catch(() => undefined);
      dap.close();
      await killTree(adapter);
    },
  };
}
