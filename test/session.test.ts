import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'reneplane-test-'));
process.env.RENEPLANE_HOME = home;
process.env.RENEPLANE_SYSTEM_GIT = '1';
const { Autosaver, sendSave } = await import('../src/session/autosave.js');
const { sweepSessions, writeMeta, sessionDir } = await import('../src/session/store.js');
const { enforceCap, recordUse } = await import('../src/cache.js');
const { verifySessionToken, publicUrl } = await import('../src/cloud.js');
const { versionAtLeast } = await import('../src/mission/manager.js');
const { exportLegacyMissions } = await import('../src/legacy.js');
const { updateConfig, PATHS } = await import('../src/config.js');

/**
 * A stand-in for the engine's autosave endpoint: answers by attempt id, records what it was sent.
 *   att_saves…    saves (revision + 1)      att_offline…  503      att_replaced…  409 session_replaced
 */
const received: { attemptId: string; body: { baseRevision: number; diff: string } }[] = [];
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      const attemptId = request.url!.split('/')[3]!;
      const body = JSON.parse(text);
      received.push({ attemptId, body });
      const send = (status: number, value: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (attemptId.startsWith('att_offline')) return send(503, { error: 'internal' });
      if (attemptId.startsWith('att_replaced')) return send(409, { error: 'session_replaced', message: 'opened elsewhere' });
      send(200, { revision: body.baseRevision + 1, savedAt: new Date().toISOString(), unchanged: false });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const target = (attemptId: string, revision = 0) => ({ attemptId, autosaveUrl: `${base}/v1/attempts/${attemptId}/autosave`, token: 's1.test', revision });

describe('autosave', () => {
  it('tells saved, offline and replaced apart', async () => {
    expect((await sendSave(target('att_saves0000000001'), 'diff')).outcome).toBe('saved');
    expect((await sendSave(target('att_offline000000001'), 'diff')).outcome).toBe('offline');
    expect((await sendSave(target('att_replaced0000001'), 'diff')).outcome).toBe('replaced');
    expect((await sendSave(target('att_saves0000000001'), 'x'.repeat(200_001))).outcome).toBe('too_large');
    expect((await sendSave({ ...target('att_x0000000000001'), autosaveUrl: 'http://127.0.0.1:1/nothing' }, 'diff')).outcome).toBe('offline');
  });

  it('skips work that hasn’t changed since the last save, and stops once replaced', async () => {
    let diff = 'saved before';
    const results: string[] = [];
    const saver = new Autosaver(target('att_saves0000000002', 3), 'saved before', async () => diff, (result) => results.push(result.outcome));
    expect((await saver.save()).outcome).toBe('unchanged');
    diff = 'new work';
    expect((await saver.save()).outcome).toBe('saved');
    expect(saver.revision).toBe(4);
    expect(received.at(-1)!.body).toMatchObject({ baseRevision: 3, diff: 'new work' });

    const replaced = new Autosaver(target('att_replaced0000002'), null, async () => 'mine', () => undefined);
    expect((await replaced.save()).outcome).toBe('replaced');
    expect(replaced.stopped).toBe(true);
  });
});

/** A closed session's folder: a repo at reneplane-start with one uncommitted change, and its session.json */
function closedSession(attemptId: string, minutesAgo = 30) {
  const repo = join(sessionDir(attemptId), 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'answer.sql'), 'SELECT 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'starter');
  git('tag', 'reneplane-start');
  writeFileSync(join(repo, 'answer.sql'), 'SELECT 2;\n');
  writeMeta({ ...target(attemptId), missionId: 'm', variantId: 'v', activeAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), unsyncedSince: null });
}

describe('the session sweeper', () => {
  it('saves and deletes closed sessions, keeps offline ones, and turns replaced ones into patches', async () => {
    closedSession('att_saves0000000003');
    closedSession('att_offline000000003');
    closedSession('att_replaced0000003');
    closedSession('att_saves0000000004', 1); // its IDE may still come back
    closedSession('att_saves0000000005');

    await sweepSessions('att_saves0000000005'); // the open one is never touched

    expect(existsSync(sessionDir('att_saves0000000003'))).toBe(false);
    expect(received.some((item) => item.attemptId === 'att_saves0000000003' && item.body.diff.includes('+SELECT 2;'))).toBe(true);
    expect(JSON.parse(readFileSync(join(sessionDir('att_offline000000003'), 'session.json'), 'utf8')).unsyncedSince).not.toBeNull();
    expect(existsSync(sessionDir('att_replaced0000003'))).toBe(false);
    const patches = readdirSync(PATHS.legacy).filter((name) => name.startsWith('att_replaced0000003'));
    expect(readFileSync(join(PATHS.legacy, patches[0]!), 'utf8')).toContain('+SELECT 2;');
    expect(existsSync(sessionDir('att_saves0000000004'))).toBe(true);
    expect(existsSync(sessionDir('att_saves0000000005'))).toBe(true);
  });
});

describe('the cache cap', () => {
  it('clears whole ecosystems, least recently used first, never while a session is open', () => {
    updateConfig((config) => void (config.cacheCapGB = 0.000001)); // about 1 KB
    for (const [dir, size] of [['npm', 2000], ['m2', 2000], ['uv', 10]] as const) {
      mkdirSync(join(PATHS.cache, dir), { recursive: true });
      writeFileSync(join(PATHS.cache, dir, 'package.tgz'), 'x'.repeat(size));
    }
    recordUse(['jdk21-maven']);
    recordUse(['node22']); // npm used most recently
    expect(enforceCap(true)).toEqual([]);
    // Never used (uv) goes first, then the older (Maven); npm last, and only because the cap is tiny
    expect(enforceCap(false)).toEqual(['uv', 'maven', 'npm']);
    expect(existsSync(join(PATHS.cache, 'm2'))).toBe(false);
  });
});

describe('cloud agents', () => {
  const secret = 'cloud-session-secret-0123456789abcdef0123456789';
  // Exactly how the engine signs one (reneplane-engine src/lib/tokens.ts)
  const token = (attemptId: string, exp: number, key = secret) => {
    const payload = `${attemptId}.1.${exp}`;
    return `s1.${payload}.${createHmac('sha256', key).update(`session:${payload}`).digest('base64url')}`;
  };
  const later = Math.floor(Date.now() / 1000) + 3600;

  it('accept a session token the engine signed, for that attempt only', () => {
    expect(verifySessionToken(token('att_cloud0000000001', later), secret)).toEqual({ attemptId: 'att_cloud0000000001', gen: 1 });
    expect(verifySessionToken(token('att_cloud0000000001', later, `${secret}x`), secret)).toBeNull();
    expect(verifySessionToken(token('att_cloud0000000001', 1_700_000_000), secret)).toBeNull();
    expect(verifySessionToken('v1.device.token.sig', secret)).toBeNull();
  });

  it('serve previews on public URLs', () => {
    expect(publicUrl('https://{port}-s1.preview.example/', 5173)).toBe('https://5173-s1.preview.example');
    expect(publicUrl('http://localhost:{port}', 8000)).toBe('http://localhost:8000');
  });
});

describe('versions and old missions', () => {
  it('compares versions, and lets dev builds through', () => {
    expect(versionAtLeast('0.3.0', '0.3.0')).toBe(true);
    expect(versionAtLeast('0.3.1', '0.3.0')).toBe(true);
    expect(versionAtLeast('0.2.9', '0.3.0')).toBe(false);
    expect(versionAtLeast('0.10.0', '0.9.0')).toBe(true);
    expect(versionAtLeast('0.0.0-dev', '9.9.9')).toBe(true);
  });

  it('exports 0.2 mission folders as patches and removes them', async () => {
    const dir = join(PATHS.missions, 'att_old0000000001');
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: repo, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'starter');
    git('tag', 'shop-142-v1');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ open: { codebank: { repo: 'reneplane/codebank-x', ref: 'shop-142-v1' } } }));
    const recent = join(PATHS.missions, 'att_recent00000001');
    mkdirSync(recent, { recursive: true });
    writeFileSync(join(recent, 'state.json'), '{}');
    const old = new Date(Date.now() - 20 * 86_400_000);
    utimesSync(join(dir, 'state.json'), old, old);

    expect(await exportLegacyMissions({ all: false, active: null })).toEqual(['att_old0000000001']);
    expect(readFileSync(join(PATHS.legacy, 'att_old0000000001.patch'), 'utf8')).toContain('+two');
    expect(existsSync(recent)).toBe(true);
    expect(await exportLegacyMissions({ all: true, active: null })).toEqual(['att_recent00000001']);
  });
});
