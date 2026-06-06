import { isLuhnValid } from "../../config/secrets.js";
import type { CatalogParam, QueryCatalogEntry } from "../../dsl/types.js";

export function validateQueryParams(entry: QueryCatalogEntry, params: Record<string, unknown>): void {
  const specs = normalizeBindParamRecord(entry.params ?? {});
  const normalizedParams = normalizeBindParamRecord(params);
  for (const [name, spec] of Object.entries(specs)) {
    const value = normalizedParams[name];
    if (spec.required && (value === undefined || value === null || value === "")) {
      throw new Error(`Missing required query param '${name}'.`);
    }
    validateParamValue(name, value, spec);
  }
}

export function normalizeQueryCatalog(queries: Record<string, QueryCatalogEntry>): Record<string, QueryCatalogEntry> {
  return Object.fromEntries(Object.entries(queries).map(([id, entry]) => [id, normalizeQueryCatalogEntry(entry)]));
}

export function normalizeQueryCatalogEntry(entry: QueryCatalogEntry): QueryCatalogEntry {
  return {
    ...entry,
    params: entry.params ? normalizeBindParamRecord(entry.params) : undefined
  };
}

export function normalizeBindParamRecord<T>(value: Record<string, T>): Record<string, T> {
  const normalized: Record<string, T> = {};
  for (const [name, entry] of Object.entries(value)) {
    const bindName = normalizeBindParamName(name);
    if (bindName) normalized[bindName] = entry;
  }
  return normalized;
}

export function normalizeBindParamName(name: string): string {
  return String(name ?? "").trim().replace(/^:+/, "");
}

function validateParamValue(name: string, value: unknown, spec: CatalogParam): void {
  if (value === undefined || value === null) return;
  if (spec.type?.endsWith("[]")) {
    const expectedItemType = spec.type.slice(0, -"[]".length);
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) throw new Error(`Query param '${name}' must contain at least one value.`);
    for (const item of values) {
      if (typeof item !== expectedItemType) {
        throw new Error(`Query param '${name}' must be ${spec.type}; got ${typeof item} item.`);
      }
      validatePattern(name, item, spec);
      validateLuhn(name, item, spec);
    }
    return;
  }
  if (spec.type && typeof value !== spec.type) {
    throw new Error(`Query param '${name}' must be ${spec.type}; got ${typeof value}.`);
  }
  validatePattern(name, value, spec);
  validateLuhn(name, value, spec);
}

function validatePattern(name: string, value: unknown, spec: CatalogParam): void {
  if (spec.pattern && typeof value === "string" && !new RegExp(spec.pattern).test(value)) {
    throw new Error(`Query param '${name}' does not match ${spec.pattern}.`);
  }
}

function validateLuhn(name: string, value: unknown, spec: CatalogParam): void {
  if (!spec.luhn) return;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`Query param '${name}' must be a string or number for Luhn validation.`);
  }
  const digits = String(value).replace(/\D+/g, "");
  if (digits.length < 12 || digits.length > 19) {
    throw new Error(`Query param '${name}' must be 12-19 digits for Luhn validation.`);
  }
  if (!isLuhnValid(digits)) {
    throw new Error(`Query param '${name}' fails Luhn check.`);
  }
}
