// Dev helper: a whole debug session through the running agent, as the IDE would drive it.
// Boots the mission, starts debugging with one breakpoint, sends an API request through the agent,
// waits for the stop, prints the stack and variables, steps over once, continues, and stops debugging.
//   RENEPLANE_HOME=~/.reneplane-dev npx tsx scripts/dev-debug.ts <attemptId> <repo> <ref> <file> <line> [POST /api/orders/1042/cancel] [variantId]
import WebSocket from 'ws';
import { addPendingPairing } from '../src/pairing.js';
import { randomToken } from '../src/security.js';

const [attemptId = 'att_dbg1', repo = 'reneplane/codebank-shopkart-node', ref = 'shop-142-v1', file = '', lineText = '1', method = 'POST', path = '/api/orders/1042/cancel', variantId = 'dev'] =
  process.argv.slice(2);
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
const waiters: { event: string; match: (data: unknown) => boolean; resolve: (data: unknown) => void }[] = [];
ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString());
  if ('event' in frame) {
    if (frame.event === 'debug.state') console.log(`  state: ${frame.data.state}${frame.data.message ? ` (${frame.data.message})` : ''}`);
    if (frame.event === 'debug.event') console.log(`  event: ${frame.data.event} ${JSON.stringify(frame.data.body).slice(0, 160)}`);
    if (frame.event === 'log' && frame.data.level === 'error') console.log(`  log[${frame.data.source}] ${frame.data.message}`);
    for (const waiter of [...waiters]) {
      if (waiter.event === frame.event && waiter.match(frame.data)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame.data);
      }
    }
    return;
  }
  pending.get(frame.id)?.(frame);
});
const call = <T>(name: string, params: unknown = {}) =>
  new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (frame) => (frame.ok ? resolve(frame.result as T) : reject(new Error(frame.error?.message))));
    ws.send(JSON.stringify({ id, s: session || undefined, method: name, params }));
  });
const waitFor = (event: string, match: (data: never) => boolean, timeoutMs = 120_000) =>
  new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    waiters.push({ event, match: match as (data: unknown) => boolean, resolve: (data) => (clearTimeout(timer), resolve(data)) });
  });
const stoppedEvent = () => waitFor('debug.event', (data: { event: string }) => data.event === 'stopped') as Promise<{ body: { threadId: number; reason: string } }>;

try {
  session = (await call<{ sessionToken: string }>('hello', { protocol: 1, client: 'dev-debug', pairToken })).sessionToken;
  await call('mission.plan', { attemptId, missionId: 'mission', variantId, codebank: { repo, ref } });
  console.log('booting…');
  await call('mission.boot', { attemptId });
  console.log('debug.start…');
  const started = Date.now();
  const result = await call<{ adapter: string; breakpoints: Record<string, unknown> }>('debug.start', { breakpoints: [{ path: file, lines: [Number(lineText)] }] });
  console.log(`debugging (${result.adapter}) after ${Math.round((Date.now() - started) / 1000)} s; breakpoints ${JSON.stringify(result.breakpoints)}`);

  const stop = stoppedEvent();
  const response = call<{ status: number; body: unknown }>('http', { method, path });
  const hit = await stop;
  console.log(`stopped (${hit.body.reason}) on thread ${hit.body.threadId}`);
  const { stackFrames } = await call<{ stackFrames: { id: number; name: string; line: number; source?: { path: string | null; external: boolean } }[] }>('debug.request', {
    command: 'stackTrace',
    arguments: { threadId: hit.body.threadId, levels: 6 },
  });
  for (const frame of stackFrames) console.log(`  frame ${frame.name} ${frame.source?.path ?? '(external)'}:${frame.line}`);
  const { scopes } = await call<{ scopes: { name: string; variablesReference: number }[] }>('debug.request', { command: 'scopes', arguments: { frameId: stackFrames[0]!.id } });
  const { variables } = await call<{ variables: { name: string; value: string; variablesReference: number }[] }>('debug.request', {
    command: 'variables',
    arguments: { variablesReference: scopes[0]!.variablesReference },
  });
  console.log(`  ${scopes[0]!.name}: ${variables.map((variable) => `${variable.name}=${variable.value.slice(0, 50)}`).join(', ')}`);
  const nested = variables.find((variable) => variable.variablesReference > 0 && variable.name !== 'this');
  if (nested) {
    const inner = await call<{ variables: { name: string; value: string }[] }>('debug.request', { command: 'variables', arguments: { variablesReference: nested.variablesReference } });
    console.log(`  ${nested.name} → ${inner.variables.slice(0, 6).map((variable) => `${variable.name}=${variable.value.slice(0, 40)}`).join(', ')}`);
  }
  const evaluated = await call<{ result: string }>('debug.request', { command: 'evaluate', arguments: { expression: variables.find((variable) => variable.name !== 'this')?.name ?? 'this', frameId: stackFrames[0]!.id, context: 'hover' } }).catch(
    (error: Error) => ({ result: `(evaluate failed: ${error.message})` }),
  );
  console.log(`  evaluate → ${evaluated.result.slice(0, 80)}`);

  const step = stoppedEvent().catch(() => null);
  await call('debug.request', { command: 'next', arguments: { threadId: hit.body.threadId } });
  const stepped = await Promise.race([step, new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000))]);
  // Later stops (Python hits a `with` line again on exit, other requests) just carry on
  const autoContinue = () =>
    void stoppedEvent().then(async (again) => {
      console.log(`  (stopped again at a breakpoint, continuing)`);
      await call('debug.request', { command: 'continue', arguments: { threadId: again.body.threadId } }).catch(() => undefined);
      autoContinue();
    }, () => undefined);
  if (stepped) {
    const top = await call<{ stackFrames: { name: string; line: number }[] }>('debug.request', { command: 'stackTrace', arguments: { threadId: stepped.body.threadId, levels: 1 } });
    console.log(`after step over: ${top.stackFrames[0]?.name}:${top.stackFrames[0]?.line}`);
    autoContinue();
    await call('debug.request', { command: 'continue', arguments: { threadId: stepped.body.threadId } });
  } else {
    console.log('after step over: left the learner code');
    autoContinue();
  }
  console.log(`API answered ${JSON.stringify(await response).slice(0, 160)}`);

  await call('debug.stop');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  console.log('services:', JSON.stringify(await call('services.list')));
} catch (error) {
  console.log('FAILED:', (error as Error).message);
} finally {
  ws.close();
  process.exit(0);
}
