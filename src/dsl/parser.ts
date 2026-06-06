import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { scenarioSchema, queryCatalogSchema, batchCatalogSchema, apiOperationsCatalogSchema } from "./schema.js";
import type { Catalogs, QueryCatalogEntry, Scenario } from "./types.js";
import { importedOperationsFromCollections, loadApiCollections } from "../adapters/api/api-collections.js";
import { normalizeQueryCatalog } from "../adapters/db/query-catalog.js";

export async function loadYamlFile<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return YAML.parse(raw) as T;
}

export async function loadScenario(path: string): Promise<Scenario> {
  const parsed = await loadYamlFile<unknown>(path);
  return scenarioSchema.parse(parsed) as Scenario;
}

export async function loadCatalogs(rootDir: string): Promise<Catalogs> {
  const queries = normalizeQueryCatalog(queryCatalogSchema.parse(await loadYamlFile<unknown>(`${rootDir}/catalogs/queries.yaml`)) as Record<string, QueryCatalogEntry>);
  const batches = batchCatalogSchema.parse(await loadYamlFile<unknown>(`${rootDir}/catalogs/batches.yaml`));
  const apiOperations = apiOperationsCatalogSchema.parse(await loadYamlFile<unknown>(`${rootDir}/catalogs/api-operations.yaml`));
  const importedApiOperations = importedOperationsFromCollections(await loadApiCollections(rootDir));
  return { queries, batches, apiOperations: { ...apiOperations, ...importedApiOperations } } as Catalogs;
}
