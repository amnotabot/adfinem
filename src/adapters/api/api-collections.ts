import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { ApiOperationEntry, ApiRequestSpec, CatalogParam } from "../../dsl/types.js";

export interface ApiCollectionFile {
  version: 1;
  collections: ImportedApiCollection[];
}

export interface ImportedApiCollection {
  id: string;
  name: string;
  importedAt: string;
  variables?: Record<string, unknown>;
  requestCount: number;
  requests: ImportedApiRequest[];
}

export interface ImportedApiRequest {
  id: string;
  name: string;
  folderPath: string[];
  operationKey: string;
  description?: string;
  request: ApiRequestSpec;
  variables?: Record<string, unknown>;
  variableNames: string[];
}

export interface PostmanPreview {
  name: string;
  id: string;
  requestCount: number;
  folders: string[];
  variables: Record<string, unknown>;
  requests: Array<Pick<ImportedApiRequest, "id" | "name" | "folderPath" | "operationKey" | "variableNames"> & ApiRequestSpec>;
}

interface PostmanCollectionLike {
  info?: { name?: string; _postman_id?: string };
  item?: PostmanItemLike[];
  variable?: Array<{ key?: string; value?: unknown; disabled?: boolean }>;
  auth?: unknown;
}

interface PostmanItemLike {
  name?: string;
  item?: PostmanItemLike[];
  request?: PostmanRequestLike | string;
}

interface PostmanRequestLike {
  description?: unknown;
  method?: string;
  url?: unknown;
  header?: Array<{ key?: string; value?: unknown; disabled?: boolean }>;
  body?: {
    mode?: string;
    raw?: string;
    urlencoded?: Array<{ key?: string; value?: unknown; disabled?: boolean }>;
    formdata?: Array<{ key?: string; value?: unknown; disabled?: boolean }>;
  };
  auth?: unknown;
}

export function apiCollectionsPath(rootDir: string): string {
  return join(rootDir, "catalogs", "api-collections.json");
}

export async function loadApiCollections(rootDir: string): Promise<ApiCollectionFile> {
  try {
    const parsed = JSON.parse(await readFile(apiCollectionsPath(rootDir), "utf8")) as ApiCollectionFile;
    return normalizeCollectionFile(parsed);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { version: 1, collections: [] };
    throw error;
  }
}

export async function writeApiCollections(rootDir: string, file: ApiCollectionFile): Promise<void> {
  const outputPath = apiCollectionsPath(rootDir);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(normalizeCollectionFile(file), null, 2)}\n`, "utf8");
}

export async function importPostmanCollection(rootDir: string, payload: unknown): Promise<ImportedApiCollection> {
  const collection = parsePostmanCollection(payload);
  const file = await loadApiCollections(rootDir);
  const remaining = file.collections.filter((item) => item.id !== collection.id);
  await writeApiCollections(rootDir, { version: 1, collections: [...remaining, collection] });
  return collection;
}

export function parsePostmanCollection(payload: unknown): ImportedApiCollection {
  const source = asObject(payload) as PostmanCollectionLike;
  const name = String(source.info?.name || "Imported API Collection").trim();
  const collectionId = sanitizeId(source.info?._postman_id || `${name}_${shortHash(JSON.stringify(payload))}`);
  const variables = postmanVariables(source.variable);
  const requests: ImportedApiRequest[] = [];
  const rootAuth = source.auth;

  function visit(items: PostmanItemLike[] | undefined, folderPath: string[], inheritedAuth: unknown): void {
    for (const item of items ?? []) {
      if (Array.isArray(item.item)) {
        visit(item.item, [...folderPath, String(item.name || "Folder")], inheritedAuth);
        continue;
      }
      const request = typeof item.request === "string" ? undefined : item.request;
      if (!request) continue;
      const requestId = uniqueRequestId(collectionId, folderPath, item.name || request.method || "request", requests.length);
      const spec = postmanRequestSpec(request, inheritedAuth);
      const variableNames = [...new Set([
        ...findTemplateVariables(spec),
        ...Object.keys(variables)
      ])].sort((a, b) => a.localeCompare(b));
      requests.push({
        id: requestId,
        name: String(item.name || requestId),
        folderPath,
        operationKey: `pm_${collectionId}_${requestId}`,
        description: descriptionText(request.description),
        request: spec,
        variables,
        variableNames
      });
    }
  }

  visit(source.item, [], rootAuth);

  return {
    id: collectionId,
    name,
    importedAt: new Date().toISOString(),
    variables,
    requestCount: requests.length,
    requests
  };
}

export function previewPostmanCollection(payload: unknown): PostmanPreview {
  const collection = parsePostmanCollection(payload);
  return {
    name: collection.name,
    id: collection.id,
    requestCount: collection.requestCount,
    variables: collection.variables ?? {},
    folders: [...new Set(collection.requests.map((request) => request.folderPath.join(" / ")).filter(Boolean))].sort(),
    requests: collection.requests.map((request) => ({
      id: request.id,
      name: request.name,
      folderPath: request.folderPath,
      operationKey: request.operationKey,
      variableNames: request.variableNames,
      ...request.request
    }))
  };
}

export function importedOperationsFromCollections(file: ApiCollectionFile): Record<string, ApiOperationEntry> {
  const operations: Record<string, ApiOperationEntry> = {};
  for (const collection of file.collections) {
    for (const request of collection.requests) {
      operations[request.operationKey] = {
        type: "rest",
        description: request.description || `${collection.name}${request.folderPath.length ? ` / ${request.folderPath.join(" / ")}` : ""} / ${request.name}`,
        ...request.request,
        params: paramsFromVariables(request.variableNames),
        source: {
          collectionId: collection.id,
          collectionName: collection.name,
          requestId: request.id,
          folderPath: request.folderPath
        }
      };
    }
  }
  return operations;
}

export function operationToRequestSpec(operation: ApiOperationEntry | undefined): ApiRequestSpec {
  if (!operation) return {};
  return {
    method: operation.method,
    path: operation.path,
    headers: operation.headers,
    query: operation.query,
    body: operation.body,
    rawBody: operation.rawBody,
    bodyMode: operation.bodyMode,
    auth: operation.auth,
    acceptStatuses: operation.acceptStatuses
  };
}

export function mergeApiRequest(base: ApiOperationEntry, override?: ApiRequestSpec): ApiRequestSpec {
  const source = operationToRequestSpec(base);
  return cleanRequest({
    ...source,
    ...(override ?? {}),
    headers: mergeRecord(source.headers, override?.headers),
    query: mergeRecord(source.query, override?.query),
    acceptStatuses: override?.acceptStatuses ?? source.acceptStatuses
  });
}

function postmanRequestSpec(request: PostmanRequestLike, inheritedAuth: unknown): ApiRequestSpec {
  const url = parsePostmanUrl(request.url);
  const body = parsePostmanBody(request.body);
  return cleanRequest({
    method: normalizeMethod(request.method),
    path: url.path,
    query: url.query,
    headers: mergeRecord(generatedPostmanHeaders(body), keyValueRecord(request.header)),
    auth: request.auth ?? inheritedAuth,
    ...body
  });
}

function parsePostmanUrl(value: unknown): { path?: string; query?: Record<string, unknown> } {
  if (typeof value === "string") return pathAndQueryFromRaw(value);
  const url = asObject(value);
  const raw = optionalString(url.raw);
  const query = keyValueRecord(url.query as Array<{ key?: string; value?: unknown; disabled?: boolean }> | undefined);
  if (raw) {
    const parsed = pathAndQueryFromRaw(raw);
    return { path: parsed.path, query: mergeRecord(parsed.query, query) };
  }
  const pathParts = Array.isArray(url.path) ? url.path.map(String) : [];
  return {
    path: pathParts.length ? `/${pathParts.join("/")}` : undefined,
    query
  };
}

function pathAndQueryFromRaw(raw: string): { path?: string; query?: Record<string, unknown> } {
  const trimmed = raw.trim();
  const withoutBase = trimmed.replace(/^\{\{[^}]+\}\}/, "");
  try {
    const url = new URL(trimmed.replace(/^\{\{[^}]+\}\}/, "http://postman.local"));
    return { path: url.pathname, query: Object.fromEntries(url.searchParams.entries()) };
  } catch {
    const [path, qs] = withoutBase.split("?");
    return {
      path: path.startsWith("/") ? path : `/${path}`,
      query: qs ? Object.fromEntries(new URLSearchParams(qs).entries()) : undefined
    };
  }
}

function parsePostmanBody(body: PostmanRequestLike["body"]): Pick<ApiRequestSpec, "body" | "rawBody" | "bodyMode"> {
  if (!body?.mode) return { bodyMode: "none" };
  if (body.mode === "raw") {
    const rawBody = body.raw ?? "";
    const trimmed = rawBody.trim();
    if (trimmed && looksLikeJson(trimmed)) {
      return { bodyMode: "json", rawBody };
    }
    return { bodyMode: "raw", rawBody };
  }
  if (body.mode === "urlencoded") {
    return { bodyMode: "urlencoded", body: keyValueRecord(body.urlencoded) ?? {} };
  }
  if (body.mode === "formdata") {
    return { bodyMode: "formdata", body: keyValueRecord(body.formdata) ?? {} };
  }
  return { bodyMode: "raw", rawBody: body.raw ?? "" };
}

function normalizeMethod(value: unknown): ApiRequestSpec["method"] {
  const method = String(value || "GET").toUpperCase();
  if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) {
    return method as ApiRequestSpec["method"];
  }
  return "GET";
}

function keyValueRecord(items: Array<{ key?: string; value?: unknown; disabled?: boolean }> | undefined): Record<string, string> | undefined {
  const entries = (items ?? [])
    .filter((item) => !item.disabled && item.key)
    .map((item) => [String(item.key), String(item.value ?? "")] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function generatedPostmanHeaders(body: Pick<ApiRequestSpec, "body" | "rawBody" | "bodyMode">): Record<string, string> | undefined {
  const headers: Record<string, string> = {
    Accept: "*/*",
    "Cache-Control": "no-cache"
  };
  if (body.bodyMode === "json") headers["Content-Type"] = "application/json";
  if (body.bodyMode === "urlencoded") headers["Content-Type"] = "application/x-www-form-urlencoded";
  return Object.keys(headers).length ? headers : undefined;
}

function postmanVariables(items: Array<{ key?: string; value?: unknown; disabled?: boolean }> | undefined): Record<string, unknown> {
  return Object.fromEntries((items ?? [])
    .filter((item) => !item.disabled && item.key)
    .map((item) => [String(item.key), item.value ?? ""]));
}

function findTemplateVariables(value: unknown): string[] {
  const names: string[] = [];
  const visit = (current: unknown) => {
    if (typeof current === "string") {
      for (const match of current.matchAll(/\{\{([A-Za-z0-9_.-]+)\}\}/g)) names.push(match[1]);
      for (const match of current.matchAll(/\$\{([A-Za-z0-9_.-]+)\}/g)) names.push(match[1]);
      return;
    }
    if (Array.isArray(current)) current.forEach(visit);
    if (current && typeof current === "object") Object.values(current).forEach(visit);
  };
  visit(value);
  return names;
}

function paramsFromVariables(variableNames: string[]): Record<string, CatalogParam> | undefined {
  if (!variableNames.length) return undefined;
  return Object.fromEntries(variableNames.map((name) => [name, { required: false, type: "string" } satisfies CatalogParam]));
}

function normalizeCollectionFile(file: ApiCollectionFile): ApiCollectionFile {
  return {
    version: 1,
    collections: Array.isArray(file.collections) ? file.collections.map((collection) => ({
      ...collection,
      requestCount: collection.requests?.length ?? collection.requestCount ?? 0,
      requests: collection.requests ?? []
    })) : []
  };
}

function cleanRequest(request: ApiRequestSpec): ApiRequestSpec {
  return Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined && value !== null && !(typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0))) as ApiRequestSpec;
}

function mergeRecord<T>(base: Record<string, T> | undefined, override: Record<string, T> | undefined): Record<string, T> | undefined {
  const merged = { ...(base ?? {}), ...(override ?? {}) };
  return Object.keys(merged).length ? merged : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function looksLikeJson(value: string): boolean {
  return value.startsWith("{") || value.startsWith("[");
}

function descriptionText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const description = asObject(value);
  return optionalString(description.content);
}

function uniqueRequestId(collectionId: string, folderPath: string[], name: string, index: number): string {
  return sanitizeId(`${folderPath.join("_")}_${name}_${index || ""}`) || `${collectionId}_request_${index + 1}`;
}

function sanitizeId(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "collection";
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}
