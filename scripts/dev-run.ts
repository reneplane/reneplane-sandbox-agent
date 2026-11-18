// Dev helper: copy a fix into a running mission's working tree (optional), then run its visible tests.
//   RENEPLANE_HOME=~/.reneplane-dev npx tsx scripts/dev-run.ts <attemptId> <repo> <ref> [fixDir]
import { cpSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { PATHS } from '../src/config.js';
import { addPendingPairing } from '../src/pairing.js';
import { randomToken } from '../src/security.js';

const [attemptId = 'att_dev1', repo = 'reneplane/codebank-shopkart-node', ref = 'shop-142-v1', fixDir, variantId = 'dev'] = process.argv.slice(2);
const pairToken = randomToken(32);
addPendingPairing(pairToken);

const ws = new WebSocket(`ws://127.0.0.1:${process.env.AGENT_PORT ?? 47811}/`, { headers: { Origin: 'http://localhost:5175' } });
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});
let nextId = 1;
let session = '';
const pending = new Map<number, (frame: { ok: boolean; result?: unknown; error?: { message: string } }) => void>();
ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString());
  if ('event' in frame) {
    if (frame.event === 'log' && frame.data.level === 'error') console.log(`  log[${frame.data.source}] ${frame.data.message}`);
    return;
  }
  pending.get(frame.id)?.(frame);
});
const call = <T>(method: string, params: unknown = {}) =>
  new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (frame) => (frame.ok ? resolve(frame.result as T) : reject(new Error(frame.error?.message))));
    ws.send(JSON.stringify({ id, s: session || undefined, method, params }));
  });

session = (await call<{ sessionToken: string }>('hello', { protocol: 1, client: 'dev-run', pairToken })).sessionToken;
await call('mission.plan', { attemptId, missionId: 'mission', variantId, codebank: { repo, ref } });
await call('mission.boot', { attemptId });

if (fixDir) {
  const target = join(PATHS.missions, attemptId, 'repo');
  for (const entry of readdirSync(fixDir)) cpSync(join(fixDir, entry), join(target, entry), { recursive: true });
  // Copies can keep the source's old timestamps; incremental builds (Maven, MSBuild) would then skip them
  const now = new Date();
  const touch = (rel: string) =>
    readdirSync(join(fixDir, rel)).forEach((name) =>
      statSync(join(fixDir, rel, name)).isDirectory() ? touch(join(rel, name)) : utimesSync(join(target, rel, name), now, now),
    );
  touch('');
  console.log(`copied ${fixDir} into ${target}`);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  console.log('migrate:', await call<string[]>('db.migrate'));
}

const run = await call<{ passed: number; failed: number; build: { ok: boolean; log: string[] }; checks: { name: string; status: string; layer: string; message: string | null }[] }>('run');
console.log(`build ok: ${run.build.ok}; ${run.passed} passed, ${run.failed} failed`);
for (const check of run.checks) console.log(`  ${check.status.padEnd(7)} [${check.layer}] ${check.name}${check.message ? ` — ${check.message}` : ''}`);
if (!run.build.ok) console.log(run.build.log.join('\n'));
ws.close();
process.exit(0);
