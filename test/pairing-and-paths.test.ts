import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// Point the agent at a throwaway home before its modules load
const home = mkdtempSync(join(tmpdir(), 'reneplane-test-'));
process.env.RENEPLANE_HOME = home;

const { addPendingPairing, authenticate } = await import('../src/pairing.js');
const { resolveInside } = await import('../src/util/paths.js');
const { randomToken } = await import('../src/security.js');

describe('pairing', () => {
  it('pairs once with an install token, then knows the browser by its device key', () => {
    const token = randomToken(32);
    addPendingPairing(token);
    const first = authenticate({ pairToken: token });
    expect(first.newlyPaired).toBe(true);
    expect(authenticate({ deviceKey: first.deviceKey }).newlyPaired).toBe(false);
    // The token is used up
    expect(() => authenticate({ pairToken: token })).toThrow(/not paired/);
  });

  it('refuses unknown, malformed and expired tokens', () => {
    expect(() => authenticate({ pairToken: randomToken(32) })).toThrow(/not paired/);
    expect(() => authenticate({ pairToken: 'short' })).toThrow(/not paired/);
    expect(() => authenticate({ deviceKey: randomToken(32) })).toThrow(/not paired/);
    expect(() => addPendingPairing('not a token!')).toThrow();

    const token = randomToken(32);
    const longAgo = Date.now() - 60 * 60 * 1000;
    addPendingPairing(token, longAgo);
    expect(() => authenticate({ pairToken: token })).toThrow(/not paired/);
  });
});

describe('resolveInside', () => {
  const root = join(home, 'missions', 'att_1', 'repo');
  beforeAll(() => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(home, 'secret.txt'), 'nope');
  });

  it('resolves normal repo paths', () => {
    expect(resolveInside(root, 'src/app.ts')).toBe(join(root, 'src', 'app.ts'));
    expect(resolveInside(root, 'new/folder/file.sql')).toBe(join(root, 'new', 'folder', 'file.sql'));
  });

  it('refuses anything that leaves the mission folder', () => {
    for (const path of ['../secret.txt', 'src/../../secret.txt', '/etc/passwd', 'C:/Windows/win.ini', 'C:\\Windows\\win.ini', '..\\secret.txt', '', 'a\0b']) {
      expect(() => resolveInside(root, path), path).toThrow(/outside the mission folder/);
    }
  });

  it('refuses the .git folder', () => {
    expect(() => resolveInside(root, '.git/config')).toThrow(/outside the mission folder/);
  });

  it('refuses a symlink inside the repo that points outside it', () => {
    try {
      symlinkSync(home, join(root, 'escape'), 'junction');
    } catch {
      return; // creating links needs a privilege on some Windows setups; nothing to test then
    }
    expect(() => resolveInside(root, 'escape/secret.txt')).toThrow(/outside the mission folder/);
  });
});
