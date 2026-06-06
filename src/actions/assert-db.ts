import type { QueryCatalogEntry } from "../dsl/types.js";
import { OracleClient } from "../adapters/db/oracle-client.js";

export async function assertDb(oracle: OracleClient, entry: QueryCatalogEntry, params: Record<string, unknown>) {
  return await oracle.assert(entry, params);
}
