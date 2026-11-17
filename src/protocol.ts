import { z } from 'zod';

/**
 * The wire protocol between the IDE (workspace.reneplane.com) and the agent, over one WebSocket.
 *
 * Mirrored in reneplane-workspace-web at src/contracts/agent.ts. Change both together, and bump
 * PROTOCOL_VERSION for anything that isn't backwards compatible.
 *
 *   IDE → agent   { id, s, method, params }      s = session token from `hello` (every message but hello)
 *   agent → IDE   { id, ok: true, result }  |  { id, ok: false, error: { code, message } }
 *   agent → IDE   { event, data }                 pushed: logs, file changes, terminal output, …
 */

export const PROTOCOL_VERSION = 1;

export const RequestFrame = z.object({
  id: z.number().int().nonnegative(),
  s: z.string().optional(),
  method: z.string().max(64),
  params: z.unknown().optional(),
});
export type RequestFrame = z.infer<typeof RequestFrame>;

export type ResponseFrame =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } };

export interface EventFrame {
  event: AgentEvent;
  data: unknown;
}

// ---- shared shapes -------------------------------------------------------------------------------

export const DatabaseEngine = z.enum(['postgres', 'mysql', 'sqlserver']);
export type DatabaseEngine = z.infer<typeof DatabaseEngine>;

const SafeId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** Only Reneplane's own codebank repos can be opened, at a tag or commit */
export const Codebank = z.object({
  repo: z.string().regex(/^reneplane\/codebank-[a-z0-9-]{1,60}$/),
  ref: z.string().regex(/^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,99}$/),
});
export type Codebank = z.infer<typeof Codebank>;

export const MissionOpen = z.object({
  attemptId: SafeId,
  missionId: SafeId,
  variantId: SafeId,
  codebank: Codebank,
});
export type MissionOpen = z.infer<typeof MissionOpen>;

export interface BootStep {
  id: string;
  label: string;
  detail?: string;
}

export interface MissionPlan {
  repo: { name: string; branch: string };
  bootSteps: BootStep[];
  preview: { url: string } | null;
  database: { engine: DatabaseEngine; location: 'local' | 'remote'; label: string };
}

export type ServiceState = 'starting' | 'running' | 'stopped' | 'error';
export interface ServiceInfo {
  name: 'frontend' | 'backend' | 'database';
  label: string;
  address: string;
  state: ServiceState;
}

export interface LogEvent {
  source: 'frontend' | 'backend' | 'database' | 'runner';
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface QueryResult {
  command: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
}

export interface TableInfo {
  name: string;
  columns: { name: string; type: string; nullable: boolean; isPrimaryKey: boolean; default: string | null }[];
  rowCount: number;
  foreignKeys: { column: string; references: { table: string; column: string } }[];
}

export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface TestCheck {
  id: string;
  name: string;
  layer: 'frontend' | 'backend' | 'database';
  status: 'passed' | 'failed' | 'skipped' | 'error';
  durationMs: number;
  message: string | null;
  expected: string | null;
  actual: string | null;
}

export interface RunResult {
  id: string;
  startedAt: string;
  durationMs: number;
  build: { ok: boolean; log: string[] };
  checks: TestCheck[];
  passed: number;
  failed: number;
}

// ---- methods -------------------------------------------------------------------------------------

const RepoPath = z.string().min(1).max(400);
const Empty = z.object({}).optional();

export const Methods = {
  hello: z.object({
    protocol: z.number().int(),
    client: z.string().max(64),
    /** Issued by the agent on first pairing; proves this browser was paired before */
    deviceKey: z.string().max(200).optional(),
    /** The one-time install token, used once to pair this browser */
    pairToken: z.string().max(200).optional(),
  }),
  doctor: Empty,
  'mission.plan': MissionOpen,
  'mission.boot': z.object({ attemptId: SafeId }),
  'mission.close': z.object({ attemptId: SafeId }),
  'fs.snapshot': Empty,
  'fs.original': Empty,
  'fs.write': z.object({ path: RepoPath, content: z.string().max(5_000_000) }),
  'fs.remove': z.object({ path: RepoPath }),
  'term.open': z.object({ cols: z.number().int().min(10).max(500), rows: z.number().int().min(4).max(300) }),
  'term.input': z.object({ termId: z.number().int(), data: z.string().max(100_000) }),
  'term.resize': z.object({ termId: z.number().int(), cols: z.number().int().min(10).max(500), rows: z.number().int().min(4).max(300) }),
  'term.close': z.object({ termId: z.number().int() }),
  'db.query': z.object({ sql: z.string().max(200_000) }),
  'db.schema': Empty,
  'db.reset': Empty,
  'db.migrate': Empty,
  run: Empty,
  'services.list': Empty,
  http: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().regex(/^\/[^\s]*$/).max(2000),
    body: z.unknown().optional(),
  }),
  'git.log': Empty,
  'git.commit': z.object({ message: z.string().min(1).max(2000) }),
  'git.status': Empty,
  'git.diff': Empty,
} as const;

export type MethodName = keyof typeof Methods;

export type AgentEvent =
  | 'boot.step'
  | 'fs.change'
  | 'term.output'
  | 'term.exit'
  | 'log'
  | 'services.change'
  | 'run.line'
  | 'git.change'
  | 'mission.stopped';

/** Error codes the IDE reacts to; anything else is shown as its message */
export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_paired'
  | 'unknown_method'
  | 'no_mission'
  | 'mission_busy'
  | 'outside_workspace'
  | 'database_unavailable'
  | 'failed';

export class AgentError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
