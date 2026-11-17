// Dev helper: drive a running dev agent the way the IDE does, end to end.
//   RENEPLANE_HOME=~/.reneplane-dev npx tsx scripts/dev-client.ts [attemptId] [repo] [ref]
// The agent must be running with --dev (it accepts Origin http://localhost:5175).
import WebSocket from 'ws';
import { addPendingPairing } from '../src/pairing.js';
import { randomToken } from '../src/security.js';

const attemptId = process.argv[2] ?? 'att_dev1';
const repo = process.argv[3] ?? 'reneplane/codebank-shopkart-node';
const ref = process.argv[4] ?? 'shop-142-v1';
const port = Number(process.env.AGENT_PORT ?? 47811);

const pairToken = randomToken(32);
addPendingPairing(pairToken);

const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Origin: 'http://localhost:5175' } });
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

let nextId = 1;
let session = '';
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const terminalOutput: string[] = [];
ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString());
  if ('event' in frame) {
    if (frame.event === 'boot.step') console.log('  boot', frame.data.status.padEnd(6), frame.data.id, frame.data.detail ?? '');
    else if (frame.event === 'term.output') terminalOutput.push(frame.data.data);
    else if (frame.event === 'log' && frame.data.level !== 'info') console.log(`  log[${frame.data.source}] ${frame.data.message}`);
    return;
  }
  const waiter = pending.get(frame.id);
  pending.delete(frame.id);
  if (frame.ok) waiter?.resolve(frame.result);
  else waiter?.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
});

function call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, s: session || undefined, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve: resolve as (value: unknown) => void, reject }));
}

const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
  const started = Date.now();
  const result = await work();
  console.log(`✓ ${label} (${Date.now() - started} ms)`);
  return result;
};

const hello = await timed('hello (pairing)', () => call<{ sessionToken: string; deviceKey?: string; agentVersion: string }>('hello', { protocol: 1, client: 'dev-client', pairToken }));
session = hello.sessionToken;
console.log('  agent', hello.agentVersion, 'deviceKey issued:', Boolean(hello.deviceKey));

const plan = await timed('mission.plan', () =>
  call<{ bootSteps: { id: string; label: string }[]; preview: { url: string } | null }>('mission.plan', {
    attemptId,
    missionId: 'shop-142-cancel-restock',
    variantId: 'node-postgres',
    codebank: { repo, ref },
  }),
);
console.log('  steps:', plan.bootSteps.map((step) => step.label).join(' → '));
console.log('  preview:', plan.preview?.url);

await timed('mission.boot', () => call('mission.boot', { attemptId }));

const files = await timed('fs.snapshot', () => call<Record<string, string>>('fs.snapshot'));
console.log('  files:', Object.keys(files).length);
const original = await timed('fs.original', () => call<Record<string, string>>('fs.original'));
console.log('  original files:', Object.keys(original).length);

const schema = await timed('db.schema', () => call<{ name: string; rowCount: number }[]>('db.schema'));
console.log('  tables:', schema.map((table) => `${table.name}(${table.rowCount})`).join(', '));
const orders = await timed('db.query', () => call<{ rows: unknown[] }>('db.query', { sql: 'SELECT id, status FROM orders ORDER BY id' }));
console.log('  orders:', JSON.stringify(orders.rows));

const api = await timed('http GET /api/orders/1042', () => call<{ status: number; body: unknown }>('http', { method: 'GET', path: '/api/orders/1042' }));
console.log('  ', api.status, JSON.stringify(api.body).slice(0, 120));

if (plan.preview) {
  const page = await fetch(plan.preview.url.replace('localhost', '127.0.0.1'));
  console.log(`✓ preview ${plan.preview.url} → ${page.status}`, (await page.text()).includes('<div id="root">') ? '(Vite page)' : '');
  const proxied = await fetch(`${new URL(plan.preview.url).origin.replace('localhost', '127.0.0.1')}/api/orders`);
  console.log(`✓ preview /api proxy → ${proxied.status}`);
}

const run = await timed('run (visible tests)', () => call<{ passed: number; failed: number; build: { ok: boolean; log: string[] }; checks: { name: string; status: string; layer: string; message: string | null }[] }>('run'));
console.log(`  build ok: ${run.build.ok}; ${run.passed} passed, ${run.failed} failed`);
for (const check of run.checks) console.log(`   ${check.status.padEnd(7)} [${check.layer}] ${check.name}${check.message ? ` — ${check.message}` : ''}`);
if (!run.build.ok) console.log(run.build.log.join('\n'));

const { termId } = await timed('term.open', () => call<{ termId: number }>('term.open', { cols: 120, rows: 30 }));
await call('term.input', { termId, data: 'git log --oneline -3\r' });
await new Promise((resolve) => setTimeout(resolve, 3500));
await call('term.close', { termId });
console.log('  terminal said:', JSON.stringify(terminalOutput.join('').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').slice(-400)));

await call('fs.write', { path: 'db/migrations/004_add_cancelled_at.sql', content: 'ALTER TABLE orders ADD COLUMN cancelled_at timestamptz;\n' });
const applied = await timed('db.migrate', () => call<string[]>('db.migrate'));
console.log('  applied:', applied);
const status = await timed('git.status', () => call('git.status'));
console.log('  status:', JSON.stringify(status));
const diff = await timed('git.diff', () => call<string>('git.diff'));
console.log('  diff:', diff.split('\n').slice(0, 6).join(' | '));
await timed('db.reset', () => call('db.reset'));
await call('fs.remove', { path: 'db/migrations/004_add_cancelled_at.sql' });

const refused = await call('fs.write', { path: '../outside.txt', content: 'x' }).catch((error: Error) => error.message);
console.log('✓ path escape refused:', refused);

ws.close();
process.exit(0);
