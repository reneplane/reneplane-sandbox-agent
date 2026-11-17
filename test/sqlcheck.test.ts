import { describe, expect, it } from 'vitest';
import { compareResult, normalise, type ExpectedResult } from '../src/mission/sqlcheck.js';

const expected: ExpectedResult = {
  orderMatters: true,
  columns: ['month', 'orders', 'gross_paise'],
  rows: [
    ['2026-08', 2, 200000],
    ['2026-09', 3, 410000],
  ],
};

const result = (columns: string[], rows: Record<string, unknown>[]) => ({ command: 'SELECT', columns, rows, rowCount: rows.length, durationMs: 1 });

describe('SQL result comparison', () => {
  it('treats numbers the same on every engine (Postgres bigint and MySQL decimal arrive as strings)', () => {
    expect(normalise('200000')).toBe(200000);
    expect(normalise('410000.00')).toBe(410000);
    expect(normalise(3)).toBe(3);
    expect(normalise(null)).toBeNull();
    expect(normalise('2026-08 ')).toBe('2026-08');
  });

  it('passes the right answer, whatever the column case or order', () => {
    const checks = compareResult(
      result(['GROSS_PAISE', 'Month', 'orders'], [
        { GROSS_PAISE: '200000', Month: '2026-08', orders: '2' },
        { GROSS_PAISE: '410000', Month: '2026-09', orders: '3' },
      ]),
      null,
      expected,
    );
    expect(checks.map((check) => check.passed)).toEqual([true, true, true]);
  });

  it('shows the first row that differs (the double-counting bug)', () => {
    const checks = compareResult(
      result(['month', 'orders', 'gross_paise'], [
        { month: '2026-08', orders: 3, gross_paise: 280000 },
        { month: '2026-09', orders: 3, gross_paise: 410000 },
      ]),
      null,
      expected,
    );
    expect(checks.map((check) => check.passed)).toEqual([true, true, false]);
    expect(checks[2]).toMatchObject({ message: 'Row 1 differs', expected: '(2026-08, 2, 200000)', actual: '(2026-08, 3, 280000)' });
  });

  it('names a missing column, and reports a failed query on every check', () => {
    const missing = compareResult(result(['month', 'orders'], [{ month: '2026-08', orders: 2 }]), null, expected);
    expect(missing[0]).toMatchObject({ passed: false, message: 'Missing column: gross_paise' });
    const failed = compareResult(null, 'relation "orderz" does not exist', expected);
    expect(failed.every((check) => !check.passed && check.message.includes('orderz'))).toBe(true);
  });

  it('compares as a multiset when order does not matter', () => {
    const unordered = { ...expected, orderMatters: false };
    const checks = compareResult(
      result(['month', 'orders', 'gross_paise'], [
        { month: '2026-09', orders: 3, gross_paise: 410000 },
        { month: '2026-08', orders: 2, gross_paise: 200000 },
      ]),
      null,
      unordered,
    );
    expect(checks.every((check) => check.passed)).toBe(true);
  });
});
