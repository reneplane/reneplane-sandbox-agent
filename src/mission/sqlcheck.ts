import type { QueryResult } from '../protocol.js';

/**
 * Comparing a learner's query result with the expected one, the same way on every engine:
 * column names case-insensitive, numbers compared as numbers (Postgres returns bigint and numeric as
 * strings, MySQL returns decimals as strings), trailing spaces ignored, NULL only equal to NULL.
 * Three checks, so a learner sees how close they are: the columns, the number of rows, the values.
 */

export interface ExpectedResult {
  orderMatters: boolean;
  columns: string[];
  rows: unknown[][];
}

export interface CheckOutcome {
  name: string;
  passed: boolean;
  message: string;
  expected: string | null;
  actual: string | null;
}

export function normalise(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isInteger(value) ? value : Number(value.toFixed(6));
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  const text = String(value).trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const number = Number(text);
    return Number.isInteger(number) ? number : Number(number.toFixed(6));
  }
  return text;
}

const show = (row: unknown[]) => `(${row.map((value) => (value === null ? 'NULL' : String(value))).join(', ')})`;

export function compareResult(result: QueryResult | null, error: string | null, expected: ExpectedResult): CheckOutcome[] {
  const columnsName = `Returns the columns ${expected.columns.join(', ')}`;
  const rowsName = `Returns ${expected.rows.length} rows`;
  const valuesName = 'The numbers match the expected report';
  if (error || !result) {
    const message = `The query failed: ${error ?? 'no result'}`;
    return [
      { name: columnsName, passed: false, message, expected: null, actual: null },
      { name: rowsName, passed: false, message, expected: null, actual: null },
      { name: valuesName, passed: false, message, expected: null, actual: null },
    ];
  }

  const actualColumns = result.columns.map((column) => column.toLowerCase());
  const wantedColumns = expected.columns.map((column) => column.toLowerCase());
  const missing = wantedColumns.filter((column) => !actualColumns.includes(column));
  const columns: CheckOutcome = {
    name: columnsName,
    passed: missing.length === 0 && actualColumns.length === wantedColumns.length,
    message: missing.length ? `Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` : `Expected exactly ${wantedColumns.length} columns`,
    expected: wantedColumns.join(', '),
    actual: actualColumns.join(', '),
  };

  // Rows as arrays in the expected column order (by name, whatever order the learner chose)
  const byName = (row: Record<string, unknown>) => {
    const lower = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
    return wantedColumns.map((column) => normalise(lower[column]));
  };
  const actualRows = result.rows.map(byName);
  const wantedRows = expected.rows.map((row) => row.map(normalise));

  const count: CheckOutcome = {
    name: rowsName,
    passed: actualRows.length === wantedRows.length,
    message: `Expected ${wantedRows.length} rows, got ${actualRows.length}`,
    expected: String(wantedRows.length),
    actual: String(actualRows.length),
  };

  let values: CheckOutcome;
  if (!columns.passed) {
    values = { name: valuesName, passed: false, message: 'Fix the columns first', expected: null, actual: null };
  } else if (expected.orderMatters) {
    const index = wantedRows.findIndex((row, position) => show(row) !== show(actualRows[position] ?? []));
    values =
      index === -1 && actualRows.length === wantedRows.length
        ? { name: valuesName, passed: true, message: '', expected: null, actual: null }
        : {
            name: valuesName,
            passed: false,
            message: index === -1 ? 'Extra rows after the expected ones' : `Row ${index + 1} differs`,
            expected: index === -1 ? null : show(wantedRows[index]!),
            actual: index === -1 ? show(actualRows[wantedRows.length]!) : actualRows[index] ? show(actualRows[index]!) : '(no row)',
          };
  } else {
    const remaining = actualRows.map(show);
    const missingRow = wantedRows.map(show).find((row) => {
      const at = remaining.indexOf(row);
      if (at === -1) return true;
      remaining.splice(at, 1);
      return false;
    });
    values =
      !missingRow && remaining.length === 0
        ? { name: valuesName, passed: true, message: '', expected: null, actual: null }
        : { name: valuesName, passed: false, message: missingRow ? 'A expected row is missing' : 'There are unexpected rows', expected: missingRow ?? null, actual: remaining[0] ?? null };
  }
  return [columns, count, values];
}
