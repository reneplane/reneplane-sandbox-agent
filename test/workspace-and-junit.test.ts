import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJunit } from '../src/mission/tests.js';
import { parseWorkspace, render, shellCommand } from '../src/mission/workspace.js';

describe('workspace.yaml', () => {
  const yaml = `
version: 1
name: shopkart
branch: bug/142a
database: { engine: postgres, name: shopkart, seed: db/seed.sql }
migrate: { run: npm run migrate, applied: "^applied (\\\\S+)$" }
services:
  backend: { label: Express, run: npm run dev, port: 8000, ready: /api/health }
test:
  - { name: Backend, layer: backend, run: npx vitest run, junit: "{{out}}/backend.xml" }
env:
  DATABASE_URL: postgres://{{db.user}}:{{db.password}}@{{db.host}}:{{db.port}}/{{db.name}}
`;

  it('parses and fills defaults', () => {
    const workspace = parseWorkspace(yaml);
    expect(workspace.services.backend?.cwd).toBe('.');
    expect(workspace.setup).toEqual([]);
    expect(workspace.preview).toBeNull();
  });

  it('rejects an invalid file with the path of the problem', () => {
    expect(() => parseWorkspace(yaml.replace('engine: postgres', 'engine: oracle'))).toThrow(/database\.engine/);
  });

  it('runs ./scripts through cmd.exe on Windows', () => {
    expect(shellCommand('./mvnw -q test', 'win32')).toBe('.\\mvnw -q test');
    expect(shellCommand('cd backend && ./mvnw test', 'win32')).toBe('cd backend && .\\mvnw test');
    expect(shellCommand('npm run dev -- --port 5173', 'win32')).toBe('npm run dev -- --port 5173');
    expect(shellCommand('./mvnw test', 'linux')).toBe('./mvnw test');
  });

  it('fills variables and refuses unknown ones', () => {
    expect(render('postgres://{{db.user}}@{{db.host}}:{{db.port}}', { 'db.user': 'shop', 'db.host': '127.0.0.1', 'db.port': 54329 })).toBe(
      'postgres://shop@127.0.0.1:54329',
    );
    expect(() => render('{{db.secret}}', {})).toThrow(/unknown variable \{\{db\.secret\}\}/);
  });
});

describe('JUnit reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'junit-'));

  it('reads Vitest output: passes, failures with expected/actual', () => {
    const file = join(dir, 'vitest.xml');
    writeFileSync(
      file,
      `<?xml version="1.0"?>
<testsuites name="vitest" tests="3" failures="1">
  <testsuite name="test/orders.spec.ts" tests="3">
    <testcase classname="test/orders.spec.ts" name="POST /api/orders/:id/cancel &gt; restores stock" time="0.12">
      <failure message="expected 4 to be 6 // Object.is equality" type="AssertionError">AssertionError: expected 4 to be 6</failure>
    </testcase>
    <testcase classname="test/orders.spec.ts" name="GET /api/orders &gt; lists newest first" time="0.03"/>
    <testcase classname="test/orders.spec.ts" name="skipped one" time="0"><skipped/></testcase>
  </testsuite>
</testsuites>`,
    );
    const checks = readJunit(file, 'backend');
    expect(checks.map((check) => check.status)).toEqual(['failed', 'passed', 'skipped']);
    expect(checks[0]).toMatchObject({ name: 'POST /api/orders/:id/cancel > restores stock', layer: 'backend', expected: '6 // Object.is equality', actual: '4', durationMs: 120 });
  });

  it('reads pytest and Surefire output, including a folder of reports', () => {
    writeFileSync(
      join(dir, 'TEST-pytest.xml'),
      `<testsuites><testsuite name="pytest"><testcase classname="tests.test_orders" name="test_refuses_shipped_orders" time="0.2"><failure message="assert 200 == 409">...</failure></testcase></testsuite></testsuites>`,
    );
    writeFileSync(
      join(dir, 'TEST-OrdersTest.xml'),
      `<testsuite name="OrdersTest"><testcase name="restoresStock" classname="shopkart.OrdersTest" time="0.5"><failure message="expected: &lt;6&gt; but was: &lt;4&gt;"/></testcase></testsuite>`,
    );
    const checks = readJunit(dir, 'backend').filter((check) => check.name !== 'POST /api/orders/:id/cancel > restores stock');
    const pytest = checks.find((check) => check.name === 'refuses shipped orders');
    const surefire = checks.find((check) => check.name === 'restoresStock');
    expect(pytest?.status).toBe('failed');
    expect(surefire).toMatchObject({ status: 'failed', expected: '6', actual: '4' });
  });

  it('reads dotnet test TRX with display names and xUnit expected/actual', () => {
    const file = join(dir, 'backend.trx');
    writeFileSync(
      file,
      `<?xml version="1.0" encoding="utf-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult testName="POST /api/orders/{id}/cancel restores stock" outcome="Failed" duration="00:00:01.2500000">
      <Output><ErrorInfo><Message>Assert.Equal() Failure: Values differ
Expected: 6
Actual:   4</Message></ErrorInfo></Output>
    </UnitTestResult>
    <UnitTestResult testName="GET /api/orders lists newest first" outcome="Passed" duration="00:00:00.0300000" />
  </Results>
</TestRun>`,
    );
    const checks = readJunit(file, 'backend');
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({ name: 'POST /api/orders/{id}/cancel restores stock', status: 'failed', expected: '6', actual: '4', durationMs: 1250 });
    expect(checks[0]!.message).toBe('Assert.Equal() Failure: Values differ (expected 6, got 4)');
    expect(checks[1]).toMatchObject({ status: 'passed' });
  });

  it('returns nothing when there is no report (the build failed)', () => {
    expect(readJunit(join(dir, 'missing.xml'), 'frontend')).toEqual([]);
  });
});
