import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Point the agent at a throwaway home before its modules load
const home = mkdtempSync(join(tmpdir(), 'reneplane-test-'));
process.env.RENEPLANE_HOME = home;
const { Git } = await import('../src/mission/git.js');

/**
 * A saved diff must come back byte-for-byte on a fresh checkout, whatever the files are: the learner
 * resumes on another day (or computer) from nothing but the starter bundle and that diff.
 */

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

function tree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(root, path).split(sep).join('/')] = readFileSync(path).toString('base64');
    }
  };
  walk(root);
  return files;
}

describe('restoring a saved diff', () => {
  const root = mkdtempSync(join(tmpdir(), 'reneplane-restore-test-'));
  const origin = join(root, 'origin');
  const learner = join(root, 'learner');
  const fresh = join(root, 'fresh');

  beforeAll(() => {
    execFileSync('git', ['init', '-q', '-b', 'main', origin]);
    writeFileSync(join(origin, '.gitattributes'), '* text=auto eol=lf\n*.cmd text eol=crlf\n*.bin binary\n');
    writeFileSync(join(origin, 'a.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(origin, 'run.cmd'), '@echo off\r\necho start\r\n');
    writeFileSync(join(origin, 'image.bin'), Buffer.from([0, 1, 2, 3, 255, 0, 10, 13]));
    writeFileSync(join(origin, 'gone.txt'), 'delete me\n');
    writeFileSync(join(origin, 'old-name.txt'), 'a file that gets renamed, with enough lines\nto be detected\nas a rename\nby git\n');
    sh(origin, 'add', '-A');
    sh(origin, 'commit', '-q', '-m', 'starter');
    sh(origin, 'tag', 'reneplane-start');

    // The learner's session: edits of every kind, one of them committed
    sh(root, 'clone', '-q', origin, learner);
    writeFileSync(join(learner, 'a.txt'), 'one\n2\nthree\nfour\n');
    sh(learner, 'commit', '-q', '-am', 'my first change');
    writeFileSync(join(learner, 'run.cmd'), '@echo off\r\necho start\r\necho more\r\n');
    writeFileSync(join(learner, 'image.bin'), Buffer.from([9, 8, 7, 0, 0, 255]));
    rmSync(join(learner, 'gone.txt'));
    sh(learner, 'mv', 'old-name.txt', 'new-name.txt');
    writeFileSync(join(learner, 'src-new.ts'), 'export const added = true;\n');

    sh(root, 'clone', '-q', origin, fresh);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('puts back edits, CRLF files, binaries, deletions, renames and new files', async () => {
    const patch = await Git.system(learner).diffSince('reneplane-start');
    expect(patch).toContain('diff --git a/');
    expect(patch).toContain('GIT binary patch');

    const git = Git.system(fresh);
    await git.restore('reneplane-start', patch);

    expect(tree(fresh)).toEqual(tree(learner));
    // HEAD is the starter again; everything is a working-tree change
    expect(sh(fresh, 'rev-parse', 'HEAD').trim()).toBe(sh(fresh, 'rev-parse', 'reneplane-start').trim());
    expect((await git.diffSince('reneplane-start')).trim()).toBe(patch.trim());
  });

  it('refuses to restore over existing changes', async () => {
    const dirty = join(root, 'dirty');
    sh(root, 'clone', '-q', origin, dirty);
    writeFileSync(join(dirty, 'a.txt'), 'local edit\n');
    await expect(Git.system(dirty).restore('reneplane-start', 'diff --git a/x b/x\n')).rejects.toThrow(/fresh checkout/);
  });

  it('ignores the learner’s git settings when diffing', async () => {
    writeFileSync(join(home, 'not-used'), '');
    const patch = await Git.system(learner).diffSince('reneplane-start');
    // Stable prefixes and full hashes whatever ~/.gitconfig says
    expect(patch).toMatch(/^diff --git a\/\S+ b\/\S+$/m);
    expect(patch).toMatch(/^index [0-9a-f]{40}\.\.[0-9a-f]{40}/m);
  });
});
