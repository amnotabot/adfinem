import type { QueryCatalogEntry } from "../../dsl/types.js";

export function assertQueryResult(entry: QueryCatalogEntry, rows: Record<string, unknown>[]): void {
  const expectation = entry.expect;
  if (!expectation) return;

  let actual: unknown;
  if (expectation.type === "rowCount") {
    actual = rows.length;
  } else {
    if (!expectation.column) {
      throw new Error(`DB expectation type '${expectation.type}' requires a column.`);
    }
    if (rows.length === 0) {
      throw new Error(`DB assertion '${expectation.column} ${expectation.operator} ${formatValue(expectation.value)}' failed: query returned no rows.`);
    }
    actual = rows[0][expectation.column];
  }

  if (!compare(actual, expectation.operator, expectation.value)) {
    const target = expectation.type === "rowCount" ? "rowCount" : expectation.column;
    throw new Error(`DB assertion failed: expected ${target} ${expectation.operator} ${formatValue(expectation.value)}, got ${formatValue(actual)}.`);
  }
}

function compare(actual: unknown, operator: string, expected: unknown): boolean {
  switch (operator) {
    case "=": return equalsLoose(actual, expected);
    case "!=": return !equalsLoose(actual, expected);
    case ">": return numericCompare(actual, expected, (a, b) => a > b);
    case ">=": return numericCompare(actual, expected, (a, b) => a >= b);
    case "<": return numericCompare(actual, expected, (a, b) => a < b);
    case "<=": return numericCompare(actual, expected, (a, b) => a <= b);
    case "contains": {
      if (actual === null || actual === undefined) return false;
      const actualNumber = toFiniteNumber(actual);
      const expectedNumber = toFiniteNumber(expected);
      if (actualNumber !== undefined && expectedNumber !== undefined) {
        return String(actualNumber).includes(String(expectedNumber));
      }
      return String(actual).includes(String(expected ?? ""));
    }
    default: throw new Error(`Unsupported assertion operator '${operator}'.`);
  }
}

function equalsLoose(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || actual === undefined) return expected === actual;
  if (expected === null || expected === undefined) return false;
  const actualNumber = toFiniteNumber(actual);
  const expectedNumber = toFiniteNumber(expected);
  if (actualNumber !== undefined && expectedNumber !== undefined) {
    return actualNumber === expectedNumber;
  }
  return String(actual) === String(expected);
}

function numericCompare(actual: unknown, expected: unknown, op: (a: number, b: number) => boolean): boolean {
  const actualNumber = toFiniteNumber(actual);
  const expectedNumber = toFiniteNumber(expected);
  if (actualNumber === undefined || expectedNumber === undefined) return false;
  return op(actualNumber, expectedNumber);
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}
