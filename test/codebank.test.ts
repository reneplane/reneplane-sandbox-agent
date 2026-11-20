import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// A throwaway agent home, and the system git (no download) for the tooling's git calls
const home = mkdtempSync(join(tmpdir(), 'reneplane-test-'));
process.env.RENEPLANE_HOME = home;
process.env.RENEPLANE_SYSTEM_GIT = '1';
const { checkCodebank } = await import('../src/codebank/check.js');
const { compileRelease, scratch } = await import('../src/codebank/compile.js');
const { gitFor } = await import('../src/codebank/repo.js');
const { loadCodebank } = await import('../src/codebank/spec.js');
const { project } = await import('../src/codebank/project.js');
const { mapPatchPaths, matchesAny } = await import('../src/codebank/patch.js');
const { seedSql, parseSeed } = await import('../src/codebank/seed.js');
const { tarGz } = await import('../src/util/tar.js');

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Author', '-c', 'user.email=author@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const BUGGY = 'SELECT month, COUNT(*) AS orders FROM orders GROUP BY month;\n';
const FIXED = 'SELECT month, COUNT(DISTINCT id) AS orders FROM orders GROUP BY month ORDER BY month;\n';

/** A one-stack SQL codebank with one problem: a buggy commit, then the fix carrying the trailer */
function fixtureCodebank(): string {
  const root = mkdtempSync(join(tmpdir(), 'reneplane-codebank-'));
  roots.push(root);
  write(root, {
    '.gitattributes': '* text=auto eol=lf\n',
    'codebank.yaml': 'format: 1\nid: demo\nname: Demo\nstacks:\n  postgres: { adapter: sql, label: PostgreSQL 16, engine: postgres }\n',
    'stacks/postgres/schema.sql': 'CREATE TABLE orders (id int PRIMARY KEY, month text);\n',
    'stacks/postgres/seed.sql': "INSERT INTO orders VALUES (1, '2026-08');\n",
    'stacks/postgres/.reneplane/workspace.yaml':
      'version: 1\nname: demo\nbranch: main\ndatabase:\n  engine: postgres\n  name: demo\n  schema: schema.sql\n  seed: seed.sql\nservices: {}\ntest:\n  - name: The result\n    layer: database\n    sql: { answer: answer.sql, expected: expected.json }\n',
    'problems/DEMO-1/problem.yaml':
      'id: DEMO-1\nslug: demo-1-orders\nkind: sql\ntype: bug\ntitle: Orders are counted twice\ndifficulty: easy\nbranch: demo/orders\nstacks:\n  postgres: { allow: [answer.sql] }\nfiles:\n  answer.sql: "{stack}/answer.sql"\n  expected.json: example-output.json\nhidden: hidden/datasets.mjs\nsql: { columns: [month, orders] }\nhistory:\n  head: { message: Monthly orders report, author: "Dee Author <dee@example.com>", date: "2026-10-01T10:00:00+05:30" }\n',
    'problems/DEMO-1/brief.md': '# Orders are counted twice\n',
    'problems/DEMO-1/example-output.json': '{"rows": [["2026-08", 1]]}\n',
    'problems/DEMO-1/hidden/datasets.mjs': "export const datasets = [{ id: 'empty', name: 'No orders', category: 'Edge cases', seed: '' }];\n",
    'problems/DEMO-1/postgres/answer.sql': BUGGY,
  });
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'Demo before DEMO-1');
  writeFileSync(join(root, 'problems/DEMO-1/postgres/answer.sql'), FIXED);
  sh(root, 'commit', '-q', '-am', 'fix: count each order once\n\nReneplane-Problem: DEMO-1\nReneplane-Type: bug');
  return root;
}

describe('codebank structure check', () => {
  it('passes a well-formed codebank', async () => {
    const report = await checkCodebank({ root: fixtureCodebank(), level: 'quick', gitFor });
    const failed = report.results.filter((result) => result.status === 'fail');
    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('names the later commit that stops a problem from reverting', async () => {
    const root = fixtureCodebank();
    writeFileSync(join(root, 'problems/DEMO-1/postgres/answer.sql'), FIXED.replace('ORDER BY month', 'ORDER BY month DESC'));
    sh(root, 'commit', '-q', '-am', 'Newest month first');
    const report = await checkCodebank({ root, level: 'quick', gitFor });
    const problem = report.results.find((result) => result.id === 'problem:DEMO-1')!;
    expect(problem.status).toBe('fail');
    expect(problem.detail).toMatch(/no longer reverts cleanly.*Newest month first.*break\.patch/);
  });

  it('refuses a problem without a commit or a break.patch, and a missing hidden suite', async () => {
    const root = fixtureCodebank();
    rmSync(join(root, 'problems/DEMO-1/hidden'), { recursive: true });
    sh(root, 'add', '-A');
    sh(root, 'commit', '-q', '--amend', '-m', 'fix: no trailer this time');
    const report = await checkCodebank({ root, level: 'quick', gitFor });
    const detail = report.results.find((result) => result.id === 'problem:DEMO-1')!.detail!;
    expect(detail).toMatch(/hidden suite hidden\/datasets\.mjs is missing/);
    expect(detail).toMatch(/no commit has the trailer "Reneplane-Problem: DEMO-1"/);
  });

  it('reports schema mistakes with the file and the field', async () => {
    const root = fixtureCodebank();
    writeFileSync(join(root, 'codebank.yaml'), 'format: 1\nid: Demo Bank\nname: Demo\nstacks: {}\n');
    const report = await checkCodebank({ root, level: 'quick', gitFor });
    expect(report.ok).toBe(false);
    expect(report.results[0]!.detail).toMatch(/^codebank\.yaml: id:/);
  });
});

describe('projecting learner trees', () => {
  it('builds the starter by taking the problem commit back, and the reference from main', async () => {
    const root = fixtureCodebank();
    const codebank = loadCodebank(root);
    const git = await gitFor(root);
    const problem = codebank.problems[0]!;
    const work = scratch('reneplane-test-project-');
    roots.push(work);
    const starter = await project(git, codebank, 'postgres', join(work, 'starter'), { problem, side: 'starter' });
    const reference = await project(git, codebank, 'postgres', join(work, 'reference'), { problem, side: 'reference' });
    expect(readFileSync(join(starter.dir, 'answer.sql'), 'utf8')).toBe(BUGGY);
    expect(readFileSync(join(reference.dir, 'answer.sql'), 'utf8')).toBe(FIXED);
    expect(readFileSync(join(starter.dir, 'expected.json'), 'utf8')).toContain('2026-08');
    // The problem's branch goes into the learner's workspace.yaml
    expect(readFileSync(join(starter.dir, '.reneplane/workspace.yaml'), 'utf8')).toMatch(/^branch: demo\/orders$/m);
  });
});

describe('compiling', () => {
  it('gives the same bundles for the same commit, with the answer only in the grader bundle', async () => {
    const root = fixtureCodebank();
    const codebank = loadCodebank(root);
    const git = await gitFor(root);
    const compile = async () => {
      const out = scratch('reneplane-test-out-');
      roots.push(out);
      const work = scratch('reneplane-test-work-');
      roots.push(work);
      return compileRelease({ codebank, git, gitFor, work }, out, { release: 'v1' });
    };
    const first = await compile();
    const second = await compile();
    const [a, b] = [first.problems[0]!.variants[0]!, second.problems[0]!.variants[0]!];
    expect(a.starter.sha256).toBe(b.starter.sha256);
    expect(a.grader.sha256).toBe(b.grader.sha256);
    expect(a.requires).toEqual(['postgres16']);
    expect(a.referenceChanges).toEqual(['answer.sql']);
    expect(first.problems[0]!.brief).toContain('counted twice');
  });
});

describe('seed generation', () => {
  const seed = parseSeed(
    JSON.stringify({
      tables: [
        { name: 'customers', identity: true, columns: ['id', 'name', 'vip'], rows: [[1, "O'Brien", true]] },
        { name: 'orders', columns: ['id', 'created_at'], rows: [[7, { $ago: '3 hours' }]] },
      ],
    }),
    'seed.json',
  );

  it('writes each engine’s dialect', () => {
    const postgres = seedSql(seed, 'postgres');
    expect(postgres).toContain("(1, 'O''Brien', true)");
    expect(postgres).toContain("now() - interval '3 hours'");
    expect(postgres).toContain("SELECT setval(pg_get_serial_sequence('customers', 'id')");
    expect(seedSql(seed, 'mysql')).toContain('NOW(6) - INTERVAL 3 HOUR');
    const sqlserver = seedSql(seed, 'sqlserver');
    expect(sqlserver).toContain('SET IDENTITY_INSERT customers ON;');
    expect(sqlserver).toContain("(1, 'O''Brien', 1)");
    expect(sqlserver).toContain('DATEADD(hour, -3, SYSDATETIMEOFFSET())');
  });

  it('refuses rows that don’t match their columns', () => {
    const bad = parseSeed(JSON.stringify({ tables: [{ name: 't', columns: ['a', 'b'], rows: [[1]] }] }), 'seed.json');
    expect(() => seedSql(bad, 'postgres')).toThrow(/row 1: 1 values for 2 columns/);
  });
});

describe('patches', () => {
  it('moves a codebank commit onto one stack’s learner tree', () => {
    const patch = [
      'diff --git a/stacks/node-postgres/backend/x.ts b/stacks/node-postgres/backend/x.ts',
      'index 1111111..2222222 100644',
      '--- a/stacks/node-postgres/backend/x.ts',
      '+++ b/stacks/node-postgres/backend/x.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/stacks/java-mysql/backend/Y.java b/stacks/java-mysql/backend/Y.java',
      'index 1111111..2222222 100644',
      '--- a/stacks/java-mysql/backend/Y.java',
      '+++ b/stacks/java-mysql/backend/Y.java',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');
    const moved = mapPatchPaths(patch, (path) => (path.startsWith('stacks/node-postgres/') ? path.slice('stacks/node-postgres/'.length) : null));
    expect(moved).toContain('diff --git a/backend/x.ts b/backend/x.ts');
    expect(moved).toContain('+++ b/backend/x.ts');
    expect(moved).not.toContain('Y.java');
  });

  it('matches allow globs the way the grader does', () => {
    expect(matchesAny('backend/src/orders/service.ts', ['backend/src/**'])).toBe(true);
    expect(matchesAny('db/migrations/004_x.sql', ['db/migrations/*.sql'])).toBe(true);
    expect(matchesAny('db/migrations/nested/x.sql', ['db/migrations/*.sql'])).toBe(false);
    expect(matchesAny('package.json', ['backend/**'])).toBe(false);
  });
});

describe('bundles', () => {
  it('writes the same archive for the same files, which any tar can read', () => {
    const files = [
      { path: 'b.txt', data: Buffer.from('second') },
      { path: 'a/deep/file.json', data: Buffer.from('{}') },
    ];
    const one = tarGz(files);
    expect(tarGz([...files].reverse()).equals(one)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'reneplane-tar-'));
    roots.push(dir);
    writeFileSync(join(dir, 'x.tar.gz'), one);
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xzf', 'x.tar.gz'], { cwd: dir });
    expect(readFileSync(join(dir, 'a/deep/file.json'), 'utf8')).toBe('{}');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('second');
  });
});

describe('codebank init', () => {
  // The templates are the starting point an author gets; the full check of all four runs in CI
  // (.github/workflows/templates.yml). Here: the files fit together and pass the structure check.
  it('creates a codebank from the chosen templates that passes the structure check', async () => {
    const { initCodebank, availableTemplates } = await import('../src/codebank/init.js');
    expect(availableTemplates()).toEqual(['dotnet-sqlserver', 'java-mysql', 'node-postgres', 'python-postgres']);
    const root = join(mkdtempSync(join(tmpdir(), 'reneplane-init-')), 'notes');
    initCodebank(root, 'Notes', ['node-postgres', 'java-mysql']);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'Initial import'], { cwd: root });

    const codebank = loadCodebank(root);
    expect(Object.keys(codebank.spec.stacks)).toEqual(['node-postgres', 'java-mysql']);
    // The example problem keeps only the chosen stacks, and the file stays valid YAML after them
    expect(Object.keys(codebank.problems[0]!.spec.stacks)).toEqual(['node-postgres', 'java-mysql']);
    expect(codebank.problems[0]!.spec.hidden).toBe('hidden/behaviours.mjs');

    const report = await checkCodebank({ root, level: 'quick', gitFor });
    expect(report.results.filter((result) => result.status === 'fail')).toEqual([]);
  });
});
