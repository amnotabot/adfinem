import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { scenarioSchema, queryCatalogSchema, batchCatalogSchema, apiOperationsCatalogSchema } from "./schema.js";
import { importedOperationsFromCollections, loadApiCollections } from "../adapters/api/api-collections.js";
import { normalizeQueryCatalog } from "../adapters/db/query-catalog.js";
export async function loadYamlFile(path) {
    const raw = await readFile(path, "utf8");
    return YAML.parse(raw);
}
export async function loadScenario(path) {
    const parsed = await loadYamlFile(path);
    return scenarioSchema.parse(parsed);
}
export async function loadCatalogs(rootDir) {
    const queries = normalizeQueryCatalog(queryCatalogSchema.parse(await loadYamlFile(`${rootDir}/catalogs/queries.yaml`)));
    const batches = batchCatalogSchema.parse(await loadYamlFile(`${rootDir}/catalogs/batches.yaml`));
    const apiOperations = apiOperationsCatalogSchema.parse(await loadYamlFile(`${rootDir}/catalogs/api-operations.yaml`));
    const importedApiOperations = importedOperationsFromCollections(await loadApiCollections(rootDir));
    return { queries, batches, apiOperations: { ...apiOperations, ...importedApiOperations } };
}
