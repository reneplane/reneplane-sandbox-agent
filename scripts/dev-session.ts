// Dev helper: a whole session against an engine, the way the IDE drives it (protocol 2).
//   RENEPLANE_HOME=~/.reneplane-dev npx tsx scripts/dev-session.ts [problem] [variant] [file to edit]
//   ENGINE=http://localhost:8787 by default (wrangler dev --env dev in reneplane-engine)
//
// Opens a session from the starter bundle, edits a file, waits for the autosave, closes (the folder must
// go), then reopens: the edit must come back from the saved work.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { PATHS } from '../src/config.js';
import { addPendingPairing } from '../src/pairing.js';
import { randomToken } from '../src/security.js';

const [problem = 'shop-163-revenue-refunds', variant = 'postgres', file = 'answer.sql'] = process.argv.slice(2);
const engine = process.env.ENGINE ?? 'http://localhost:8787';

async function api<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const response = await fetch(`${engine}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), origin: 'http://localhost:5175' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

const pairToken = randomToken(32);
addPendingPairing(pairToken);
const ws = new WebSocket(`ws://127.0.0.1:${process.env.AGENT_PORT ?? 47811}/`, { headers: { Origin: 'http://localhost:5175' } });
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});
let nextId = 1;
let s = '';
const pending = new Map<number, (frame: { ok: boolean; result?: unknown; error?: { code: string; message: string } }) => void>();
const events: { event: string; data: any }[] = [];
ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString());
  if ('event' in frame) {
    events.push(frame);
    if (frame.event === 'session.saved') console.log(`  saved: ${JSON.stringify(frame.data)}`);
    if (frame.event === 'log' && frame.data.level === 'error') console.log(`  log[${frame.data.source}] ${frame.data.message}`);
    return;
  }
  pending.get(frame.id)?.(frame);
});
const call = <T>(method: string, params: unknown = {}) =>
  new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (frame) => (frame.ok ? resolve(frame.result as T) : reject(new Error(`${method}: ${frame.error?.code} ${frame.error?.message}`))));
    ws.send(JSON.stringify({ id, s: s || undefined, method, params }));
  });
const waitFor = async (predicate: () => boolean, label: string, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const hello = await call<{ sessionToken: string; protocol: number; mode: string }>('hello', { protocol: 2, client: 'dev-session', pairToken });
s = hello.sessionToken;
console.log(`agent speaks protocol ${hello.protocol} (${hello.mode})`);
const packs = await call<{ packs: { id: string; state: string }[] }>('packs.list');
console.log(`packs: ${packs.packs.map((pack) => `${pack.id}=${pack.state}`).join(' ')}`);

const { token } = await api<{ token: string }>('POST', '/v1/learners');
const { attempt } = await api<{ attempt: { id: string; problemId: string } }>('POST', '/v1/attempts', token, { problem, variant });
console.log(`attempt ${attempt.id} (${attempt.problemId} on ${variant})`);

async function open(label: string) {
  const session = await api<any>('POST', `/v1/attempts/${attempt.id}/session`, token, { agentVersion: 'dev' });
  console.log(`${label}: bundle ${session.bundle.sha256.slice(0, 12)}, saved revision ${session.saved.revision}${session.saved.diff ? ' (with saved work)' : ''}`);
  const plan = await call<{ bootSteps: { id: string }[] }>('mission.plan', {
    attemptId: attempt.id,
    missionId: attempt.problemId,
    variantId: variant,
    session: { bundle: session.bundle, token: session.session.token, autosaveUrl: session.session.autosaveUrl, autosaveSeconds: 10, saved: session.saved, templateRef: session.templateRef, minAgentVersion: session.minAgentVersion },
  });
  console.log(`  boot steps: ${plan.bootSteps.map((step) => step.id).join(', ')}`);
  await call('mission.boot', { attemptId: attempt.id });
  return session;
}

await open('first open');
const files = await call<Record<string, string>>('fs.snapshot');
const edited = `${files[file]}\n-- edited by dev-session at ${new Date().toISOString()}\n`;
await call('fs.write', { path: file, content: edited });
await waitFor(() => events.some((event) => event.event === 'session.saved' && event.data.revision >= 1), 'the autosave');
await call('mission.close', { attemptId: attempt.id });
const folder = join(PATHS.sessions, attempt.id);
await waitFor(() => !existsSync(folder), 'the session folder to be deleted', 30_000);
console.log(`closed: ${folder} deleted`);

const again = await open('reopen');
if (!again.saved.diff?.includes('edited by dev-session')) throw new Error('The engine did not return the saved work');
const restored = await call<Record<string, string>>('fs.snapshot');
if (restored[file] !== edited) throw new Error(`${file} was not restored`);
console.log(`restored: ${file} has the edit`);
const run = await call<{ passed: number; failed: number }>('run');
console.log(`visible tests: ${run.passed} passed, ${run.failed} failed`);
await call('mission.close', { attemptId: attempt.id });
await waitFor(() => !existsSync(folder), 'the session folder to be deleted', 30_000);
console.log('PASSED');
ws.close();
process.exit(0);
