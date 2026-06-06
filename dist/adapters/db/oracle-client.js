import { assertQueryResult } from "./assertions.js";
import { normalizeBindParamRecord, validateQueryParams } from "./query-catalog.js";
export class OracleClient {
    env;
    constructor(env) {
        this.env = env;
    }
    async query(entry, params) {
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
        }
        finally {
            await closeQuietly(connection);
        }
    }
    async assert(entry, params) {
        const rows = await this.query(entry, params);
        assertQueryResult(entry, rows);
        return rows;
    }
    async execute(entry, params) {
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
            const execution = result;
            return {
                status: "passed",
                rowsAffected: execution.rowsAffected,
                outBinds: execution.outBinds
            };
        }
        finally {
            await closeQuietly(connection);
        }
    }
}
async function closeQuietly(connection) {
    try {
        await connection.close();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Connection close failures must not mask the operation error from the surrounding try.
        console.warn(`Oracle connection close failed: ${message}`);
    }
}
let oracleDbModule;
async function loadOracleDbModule() {
    if (oracleDbModule)
        return oracleDbModule;
    try {
        const imported = await import("oracledb");
        oracleDbModule = normalizeOracleDbModule(imported);
        return oracleDbModule;
    }
    catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new Error(`Could not load optional dependency 'oracledb'. Run 'npm install' and ensure Oracle client libraries are available. Original error: ${err.message}`);
    }
}
function normalizeOracleDbModule(imported) {
    const moduleValue = imported;
    const candidate = typeof moduleValue.getConnection === "function" ? moduleValue : moduleValue.default;
    if (!candidate || typeof candidate.getConnection !== "function") {
        throw new Error("Loaded 'oracledb', but it did not expose getConnection().");
    }
    return candidate;
}
function limitRows(rows, maxRows) {
    if (maxRows === undefined)
        return rows;
    return rows.slice(0, maxRows);
}
function expandArrayBinds(sql, params) {
    const binds = {};
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
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
