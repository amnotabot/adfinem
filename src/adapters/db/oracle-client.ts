import type { EnvironmentConfig } from "../../config/environments.js";
import type { DbExecuteResult, QueryCatalogEntry } from "../../dsl/types.js";
import { assertQueryResult } from "./assertions.js";
import { normalizeBindParamRecord, validateQueryParams } from "./query-catalog.js";

type OracleDbModule = {
  OUT_FORMAT_OBJECT: unknown;
  getConnection(config: { user?: string; password?: string; connectString?: string }): Promise<{
    execute(sql: string, binds: Record<string, unknown>, options: Record<string, unknown>): Promise<{ rows?: Record<string, unknown>[] }>;
    close(): Promise<void>;
  }>;
};

export class OracleClient {
  constructor(private readonly env: EnvironmentConfig) {}

  async query(entry: QueryCatalogEntry, params: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const bindParams = normalizeBindParamRecord(params);
    validateQueryParams(entry, bindParams);
    if (!this.env.oracle.user || !this.env.oracle.password || !this.env.oracle.connectString) {
      throw new Error("ADFINEM_DB_USER, ADFINEM_DB_PASSWORD, and ADFINEM_DB_CONNECT_STRING are required for DB execution.");
    }

    const oracledb = await loadOracleDbModule();
    const connection = await oracledb.getConnection(this.env.oracle);
    try {
      const prepared = expandArrayBinds(entry.sql, bindParams);
      const result = await connection.execute(prepared.sql, prepared.binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return limitRows(result.rows ?? [], entry.maxRows);
    } finally {
      await closeQuietly(connection);
    }
  }

  async assert(entry: QueryCatalogEntry, params: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const rows = await this.query(entry, params);
    assertQueryResult(entry, rows);
    return rows;
  }

  async execute(entry: QueryCatalogEntry, params: Record<string, unknown>): Promise<DbExecuteResult> {
    const bindParams = normalizeBindParamRecord(params);
    validateQueryParams(entry, bindParams);
    if (!this.env.oracle.user || !this.env.oracle.password || !this.env.oracle.connectString) {
      throw new Error("ADFINEM_DB_USER, ADFINEM_DB_PASSWORD, and ADFINEM_DB_CONNECT_STRING are required for DB execution.");
    }

    const oracledb = await loadOracleDbModule();
    const connection = await oracledb.getConnection(this.env.oracle);
    try {
      const prepared = expandArrayBinds(entry.sql, bindParams);
      const result = await connection.execute(prepared.sql, prepared.binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        autoCommit: true
      });
      const execution = result as { rowsAffected?: number; outBinds?: Record<string, unknown> };
      return {
        status: "passed",
        rowsAffected: execution.rowsAffected,
        outBinds: execution.outBinds
      };
    } finally {
      await closeQuietly(connection);
    }
  }
}

async function closeQuietly(connection: { close(): Promise<void> }): Promise<void> {
  try {
    await connection.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Connection close failures must not mask the operation error from the surrounding try.
    console.warn(`Oracle connection close failed: ${message}`);
  }
}

let oracleDbModule: OracleDbModule | undefined;

async function loadOracleDbModule(): Promise<OracleDbModule> {
  if (oracleDbModule) return oracleDbModule;
  try {
    const imported = await import("oracledb") as unknown;
    oracleDbModule = normalizeOracleDbModule(imported);
    return oracleDbModule;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Could not load optional dependency 'oracledb'. Run 'npm install' and ensure Oracle client libraries are available. Original error: ${err.message}`);
  }
}

function normalizeOracleDbModule(imported: unknown): OracleDbModule {
  const moduleValue = imported as OracleDbModule & { default?: OracleDbModule };
  const candidate = typeof moduleValue.getConnection === "function" ? moduleValue : moduleValue.default;
  if (!candidate || typeof candidate.getConnection !== "function") {
    throw new Error("Loaded 'oracledb', but it did not expose getConnection().");
  }
  return candidate;
}

function limitRows(rows: Record<string, unknown>[], maxRows: number | undefined): Record<string, unknown>[] {
  if (maxRows === undefined) return rows;
  return rows.slice(0, maxRows);
}

function expandArrayBinds(sql: string, params: Record<string, unknown>): { sql: string; binds: Record<string, unknown> } {
  const binds: Record<string, unknown> = {};
  let expandedSql = sql;

  for (const [name, value] of Object.entries(params)) {
    if (!Array.isArray(value)) {
      binds[name] = value;
      continue;
    }

    if (value.length === 0) {
      throw new Error(`Query param '${name}' must contain at least one value.`);
    }

    const placeholders = value.map((entry, index) => {
      const bindName = `${name}_${index}`;
      binds[bindName] = entry;
      return `:${bindName}`;
    });
    expandedSql = expandedSql.replace(new RegExp(`:${escapeRegExp(name)}\\b`, "g"), placeholders.join(", "));
  }

  return { sql: expandedSql, binds };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
