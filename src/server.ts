import type { DebugCommand } from './debug/session.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_PORTS, ensureDirs, loadConfig, PATHS } from './config.js';
import { runDoctor } from './doctor.js';
import { createLogger } from './log.js';
import { MissionManager, type MissionClient } from './mission/manager.js';
import type { MissionOptions } from './mission/mission.js';
import { addPendingPairing, authenticate } from './pairing.js';
import { cacheUsage } from './cache.js';
import { addPack, isPackId, listPacks, removePack, type PackId } from './packs/index.js';
import { sessionsOnDisk } from './session/store.js';
import {
  AgentError,
  Methods,
  PROTOCOL_VERSION,
  RequestFrame,
  SUPPORTED_PROTOCOLS,
  type AgentEvent,
  type MethodName,
  type ResponseFrame,
} from './protocol.js';
import { isAllowedHost, isAllowedOrigin, randomToken, sameHash, sha256 } from './security.js';
import { verifySessionToken, type CloudConfig } from './cloud.js';
import { isPortFree } from './util/ports.js';
import { AGENT_VERSION } from './version.js';

const log = createLogger('server');

export interface ServerOptions extends MissionOptions {
  /** Cloud mode (src/cloud.ts): listen publicly, authenticate with the engine's session token */
  cloud?: CloudConfig | null;
  onSessionEnded?: () => void;
  /** Called when the CLI asks the agent to stop */
  onStopRequested?: () => void;
}

export interface RunningServer {
  port: number;
  /** A mission's programs are running: don't restart under it */
  busy(): boolean;
  /** The open mission, if any */
  activeAttempt(): string | null;
  /** An event to every connected IDE (pack progress) */
  broadcast(event: AgentEvent, data: unknown): void;
  close(): Promise<void>;
}

/** The status file the CLI reads to find the running agent */
export const STATUS_FILE = () => join(PATHS.home, 'agent.json');

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  // A brand-new computer has no ~/.reneplane yet
  ensureDirs();
  const cloud = options.cloud ?? null;
  const manager = new MissionManager({ ...options, cloud: Boolean(cloud), ...(cloud ? { previewUrl: cloud.previewUrl } : {}) });
  let port = cloud?.port ?? 0;
  for (const candidate of cloud ? [] : DEFAULT_PORTS) {
    if (await isPortFree(candidate)) {
      port = candidate;
      break;
    }
  }
  if (!port) throw new Error(`Ports ${DEFAULT_PORTS.join(', ')} are all in use. Is Reneplane Local already running?`);
  const hostOk = (host: string | undefined) => isAllowedHost(host, port) || (cloud?.publicHost !== null && cloud?.publicHost !== undefined && host === cloud.publicHost);

  const policy = () => ({ dev: options.dev, allowPreviewOrigins: loadConfig().allowPreviewOrigins });
  const server: Server = createServer((request, response) => void handleHttp(request, response));
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });

  async function handleHttp(request: IncomingMessage, response: ServerResponse) {
    if (!hostOk(request.headers.host)) return deny(response, 'bad host');
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);

    // The CLI on this computer: proves itself with the control token from config.json (only this user can read it)
    if (url.pathname.startsWith('/control/')) {
      const token = request.headers['x-reneplane-control'];
      if (request.headers.origin || typeof token !== 'string' || !sameHash(sha256(token), sha256(loadConfig().controlToken))) {
        return deny(response, 'bad control token');
      }
      const body = await readBody(request);
      if (url.pathname === '/control/status') {
        const mission = manager.current();
        return json(response, 200, { agent: 'reneplane-local', version: AGENT_VERSION, port, pid: process.pid, mission: mission?.attemptId ?? null, packsInUse: manager.packsInUse() });
      }
      if (url.pathname === '/control/pair') {
        addPendingPairing(String((JSON.parse(body || '{}') as { token?: string }).token ?? ''));
        return json(response, 200, { ok: true });
      }
      if (url.pathname === '/control/stop') {
        json(response, 200, { ok: true });
        options.onStopRequested?.();
        return;
      }
      return json(response, 404, { error: 'unknown control command' });
    }

    // Browsers: only the workspace, and only a version probe
    const origin = request.headers.origin;
    if (!isAllowedOrigin(origin, policy())) return deny(response, `origin ${origin ?? '(none)'}`);
    const cors = { 'access-control-allow-origin': origin!, vary: 'origin' };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET', 'access-control-allow-private-network': 'true' }).end();
      return;
    }
    if (url.pathname === '/health') return json(response, 200, { agent: 'reneplane-local', version: AGENT_VERSION, protocol: PROTOCOL_VERSION }, cors);
    return json(response, 404, { error: 'not found' }, cors);
  }

  server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    if (!hostOk(request.headers.host) || !isAllowedOrigin(origin, policy())) {
      log.warn(`Refused a WebSocket from origin ${origin ?? '(none)'} host ${request.headers.host ?? '(none)'}`);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => new Session(ws, manager, origin!, cloud));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // On a learner's computer only ever 127.0.0.1; a cloud agent's container is reached from outside
    server.listen(port, cloud?.host ?? '127.0.0.1', () => resolve());
  });
  writeFileSync(STATUS_FILE(), JSON.stringify({ port, pid: process.pid, version: AGENT_VERSION, startedAt: new Date().toISOString() }));
  log.info(`Reneplane Local ${AGENT_VERSION} listening on 127.0.0.1:${port}${options.dev ? ' (dev: localhost:5175 allowed)' : ''}`);

  return {
    port,
    busy: () => manager.current()?.isRunning ?? false,
    activeAttempt: () => manager.current()?.attemptId ?? null,
    broadcast: (event, data) => manager.broadcastAll(event, data),
    close: async () => {
      for (const client of sockets.clients) client.close(1001, 'Agent stopping');
      await manager.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(STATUS_FILE(), { force: true });
    },
  };
}

/** One IDE tab's connection */
class Session implements MissionClient {
  attemptId: string | null = null;
  private authenticated = false;
  private readonly sessionToken = randomToken(24);
  private readonly terminals = new Set<number>();
  /** Cloud mode: the one attempt this connection's session token allows */
  private allowedAttempt: string | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly manager: MissionManager,
    origin: string,
    private readonly cloud: CloudConfig | null = null,
  ) {
    log.info(`IDE connected from ${origin}`);
    ws.on('message', (data) => void this.onMessage(data.toString()));
    ws.on('close', () => {
      if (this.authenticated) this.manager.detach(this);
      const mission = this.manager.current();
      if (mission?.attemptId === this.attemptId) for (const id of this.terminals) mission.terminal.close(id);
    });
    // An unauthenticated socket gets 10 seconds to say hello
    setTimeout(() => {
      if (!this.authenticated && ws.readyState === ws.OPEN) ws.close(4401, 'hello expected');
    }, 10_000);
  }

  send(event: AgentEvent, data: unknown): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify({ event, data }));
  }

  private reply(frame: ResponseFrame): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private async onMessage(raw: string): Promise<void> {
    let frame: RequestFrame;
    try {
      frame = RequestFrame.parse(JSON.parse(raw));
    } catch {
      this.ws.close(4400, 'bad frame');
      return;
    }
    if (!this.authenticated && frame.method !== 'hello') {
      this.ws.close(4401, 'hello expected');
      return;
    }
    if (this.authenticated && frame.s !== this.sessionToken) {
      this.ws.close(4401, 'bad session token');
      return;
    }
    try {
      const result = await this.dispatch(frame);
      this.reply({ id: frame.id, ok: true, result: result ?? null });
    } catch (error) {
      const known = error instanceof AgentError;
      if (!known) log.error(`${frame.method} failed`, error);
      this.reply({ id: frame.id, ok: false, error: { code: known ? error.code : 'failed', message: (error as Error).message } });
      if (known && (error.code === 'not_paired' || error.code === 'unauthorized')) setTimeout(() => this.ws.close(4403, error.code), 50);
    }
  }

  private async dispatch(frame: RequestFrame): Promise<unknown> {
    const method = frame.method as MethodName;
    const schema = Methods[method];
    if (!schema) throw new AgentError('unknown_method', `Unknown method ${frame.method}`);
    const parsed = schema.safeParse(frame.params ?? {});
    if (!parsed.success) throw new AgentError('bad_request', `Bad parameters for ${method}: ${parsed.error.issues[0]?.message ?? ''}`);
    const params = parsed.data as never;

    switch (method) {
      case 'hello':
        return this.hello(params);
      case 'doctor':
        return runDoctor();
      case 'mission.plan':
        if (this.allowedAttempt && (params as { attemptId: string }).attemptId !== this.allowedAttempt) throw new AgentError('unauthorized', 'This session is for another attempt');
        if (this.cloud && !('session' in (params as object))) throw new AgentError('bad_request', 'Cloud agents only open sessions');
        return this.manager.plan(params, this);
      case 'mission.boot':
        return this.mission().boot();
      case 'mission.close':
        return this.manager.close((params as { attemptId: string }).attemptId);
      case 'packs.list':
        return packsReport();
      case 'packs.add':
        return this.addPacks((params as { ids: string[] }).ids);
      case 'packs.remove': {
        const { id } = params as { id: string };
        if (!isPackId(id)) throw new AgentError('bad_request', `Unknown pack ${id}`);
        if (this.manager.packsInUse().includes(id)) throw new AgentError('pack_in_use', 'The open mission uses it; close the mission first');
        removePack(id);
        forgetReport();
        return packsReport();
      }
    }

    const mission = this.mission();
    switch (method) {
      case 'fs.snapshot':
        return mission.snapshot();
      case 'fs.original':
        return mission.original();
      case 'fs.write': {
        const { path, content } = params as { path: string; content: string };
        return mission.writeFile(path, content);
      }
      case 'fs.remove':
        return mission.removeFile((params as { path: string }).path);
      case 'term.open': {
        const { cols, rows } = params as { cols: number; rows: number };
        const termId = mission.openTerminal(cols, rows);
        this.terminals.add(termId);
        return { termId };
      }
      case 'term.input': {
        const { termId, data } = params as { termId: number; data: string };
        return this.ownTerminal(termId) && mission.terminal.input(termId, data);
      }
      case 'term.resize': {
        const { termId, cols, rows } = params as { termId: number; cols: number; rows: number };
        return this.ownTerminal(termId) && mission.terminal.resize(termId, cols, rows);
      }
      case 'term.close': {
        const { termId } = params as { termId: number };
        this.terminals.delete(termId);
        return mission.terminal.close(termId);
      }
      case 'db.query':
        return mission.query((params as { sql: string }).sql);
      case 'db.schema':
        return mission.schema();
      case 'db.reset':
        return mission.reset();
      case 'db.migrate':
        return mission.migrate();
      case 'run':
        return mission.run();
      case 'services.list':
        return mission.services_list();
      case 'http':
        return mission.http(params);
      case 'git.log':
        return mission.gitLog();
      case 'git.commit':
        return mission.gitCommit((params as { message: string }).message);
      case 'git.status':
        return mission.gitStatus();
      case 'git.diff':
        return mission.gitDiff();
      case 'debug.start':
        return mission.debugStart((params as { breakpoints: { path: string; lines: number[] }[] }).breakpoints);
      case 'debug.stop':
        return mission.debugStop();
      case 'debug.restart':
        return mission.debugRestart();
      case 'debug.setBreakpoints': {
        const { path, lines } = params as { path: string; lines: number[] };
        return mission.debugSetBreakpoints(path, lines);
      }
      case 'debug.request': {
        const { command, arguments: args } = params as { command: DebugCommand; arguments: Record<string, unknown> };
        return mission.debugRequest(command, args);
      }
    }
    throw new AgentError('unknown_method', `Unknown method ${method}`);
  }

  /** Add packs one after another; every connected IDE sees the progress (its badges turn amber, then green) */
  private async addPacks(ids: string[]) {
    const unknown = ids.filter((id) => !isPackId(id));
    if (unknown.length) throw new AgentError('bad_request', `Unknown packs: ${unknown.join(', ')}`);
    for (const id of ids as PackId[]) {
      try {
        await addPack(id, (detail) => this.manager.broadcastAll('packs.progress', { id, detail }));
        this.manager.broadcastAll('packs.progress', { id, done: true });
      } catch (error) {
        this.manager.broadcastAll('packs.progress', { id, error: (error as Error).message });
        throw error;
      } finally {
        forgetReport();
      }
    }
    return packsReport();
  }

  private hello(params: { protocol: number; client: string; deviceKey?: string; pairToken?: string; sessionToken?: string }) {
    if (!SUPPORTED_PROTOCOLS.includes(params.protocol)) {
      throw new AgentError(
        'outdated',
        params.protocol > PROTOCOL_VERSION
          ? 'This version of Reneplane Local is older than the workspace. Run: reneplane-local update (or the install command again)'
          : 'The workspace page is older than Reneplane Local; reload it',
      );
    }
    if (this.cloud) {
      // No pairing in the cloud: the engine signed this session for one attempt
      const session = verifySessionToken(params.sessionToken, this.cloud.sessionSecret);
      if (!session) throw new AgentError('unauthorized', 'This session token is not valid (or has expired); reopen the mission');
      this.allowedAttempt = session.attemptId;
      this.authenticated = true;
      this.manager.attach(this);
      return { agentVersion: AGENT_VERSION, protocol: PROTOCOL_VERSION, platform: process.platform, arch: process.arch, sessionToken: this.sessionToken, mode: 'cloud' };
    }
    const { deviceKey, newlyPaired } = authenticate({ deviceKey: params.deviceKey, pairToken: params.pairToken });
    this.authenticated = true;
    this.manager.attach(this);
    return {
      agentVersion: AGENT_VERSION,
      protocol: PROTOCOL_VERSION,
      platform: process.platform,
      arch: process.arch,
      sessionToken: this.sessionToken,
      deviceKey: newlyPaired ? deviceKey : undefined,
      mode: 'local',
    };
  }

  private mission() {
    return this.manager.mission(this);
  }

  private ownTerminal(termId: number): boolean {
    if (!this.terminals.has(termId)) throw new AgentError('bad_request', 'Not your terminal');
    return true;
  }
}

function deny(response: ServerResponse, reason: string): void {
  log.warn(`Refused an HTTP request: ${reason}`);
  response.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden');
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size < 64 * 1024) chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// ---- packs and disk use ------------------------------------------------------------------------------

let report: { at: number; value: unknown } | null = null;

/** Packs, the cache and session folders, with sizes; walking folders takes a moment, so it's kept a minute */
function packsReport(): unknown {
  if (!report || Date.now() - report.at > 60_000) report = { at: Date.now(), value: { packs: listPacks(), cache: cacheUsage(), sessions: sessionsOnDisk() } };
  return report.value;
}

function forgetReport(): void {
  report = null;
}
