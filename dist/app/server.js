import { createServer } from "node:http";
import { access, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { assertValidEnvironmentName, getEnvironment, loadEnvironmentFile, writeEnvironmentFile } from "../config/environments.js";
import { loadCatalogs } from "../dsl/parser.js";
import { batchCatalogSchema, queryCatalogSchema } from "../dsl/schema.js";
import { validateScenarioReferences } from "../dsl/validator.js";
import { ScenarioRunner, ensureEvidenceRoot } from "../engine/runner.js";
import { normalizeFlowCatalogParams } from "../flows/catalog-normalizer.js";
import { compileFlow } from "../flows/compiler.js";
import { concatFlows } from "../flows/concat.js";
import { loadFlow, writeFlow } from "../flows/parser.js";
import { validateFlow } from "../flows/validator.js";
import { importPostmanCollection, loadApiCollections, previewPostmanCollection } from "../adapters/api/api-collections.js";
import { normalizeBindParamRecord, normalizeQueryCatalog } from "../adapters/db/query-catalog.js";
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const flowsDir = join(rootDir, "flows");
const evidenceDir = join(rootDir, "evidence");
const batchInputFilesDir = join(rootDir, "data", "batch-input-files");
const webDistDir = join(rootDir, "web-dist");
const queriesFile = join(rootDir, "catalogs", "queries.yaml");
const batchesFile = join(rootDir, "catalogs", "batches.yaml");
const catalogYamlOptions = { defaultStringType: "PLAIN", defaultKeyType: "PLAIN", lineWidth: 0 };
const defaultPort = 4177;
const configuredPort = process.env.ADFINEM_RUNNER_PORT ? Number(process.env.ADFINEM_RUNNER_PORT) : undefined;
const port = configuredPort ?? defaultPort;
const runs = new Map();
const runControllers = new Map();
const server = createServer(async (req, res) => {
    try {
        if (!req.url)
            return sendJson(res, 404, { error: "Not found" });
        const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
        if (url.pathname.startsWith("/api/")) {
            await handleApi(req, res, url);
            return;
        }
        await serveStatic(res, url.pathname);
    }
    catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        sendJson(res, 500, { error: err.message, stack: process.env.DEBUG ? err.stack : undefined });
    }
});
void listenWithFallback(server, port, configuredPort === undefined ? 10 : 0).catch((error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`Could not start Adfinem app: ${err.message}`);
    process.exitCode = 1;
});
async function listenWithFallback(appServer, firstPort, fallbackPorts) {
    for (let offset = 0; offset <= fallbackPorts; offset++) {
        const candidate = firstPort + offset;
        const started = await tryListen(appServer, candidate);
        if (started) {
            if (candidate !== firstPort) {
                console.warn(`Port ${firstPort} is already in use; using ${candidate} instead.`);
            }
            console.log(`Adfinem app: http://localhost:${candidate}`);
            return;
        }
    }
    const endPort = firstPort + fallbackPorts;
    const range = fallbackPorts > 0 ? `${firstPort}-${endPort}` : String(firstPort);
    console.error(`Could not start Adfinem app. Port ${range} is already in use.`);
    process.exitCode = 1;
}
async function tryListen(appServer, candidatePort) {
    return await new Promise((resolve, reject) => {
        const onError = (error) => {
            appServer.off("listening", onListening);
            if (error.code === "EADDRINUSE") {
                resolve(false);
                return;
            }
            reject(error);
        };
        const onListening = () => {
            appServer.off("error", onError);
            resolve(true);
        };
        appServer.once("error", onError);
        appServer.once("listening", onListening);
        appServer.listen(candidatePort);
    });
}
async function handleApi(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/environments") {
        sendJson(res, 200, { environments: environmentListResponse() });
        return;
    }
    const environmentMatch = /^\/api\/environments\/([^/]+)$/.exec(url.pathname);
    if (environmentMatch) {
        const currentName = decodeURIComponent(environmentMatch[1]);
        if (req.method === "PUT") {
            const body = await readJsonBody(req);
            const nextName = (body.name || currentName).trim();
            try {
                assertValidEnvironmentName(currentName);
                assertValidEnvironmentName(nextName);
            }
            catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                sendJson(res, 400, { error: err.message });
                return;
            }
            const environments = loadEnvironmentFile(rootDir);
            const config = body.config ?? environmentConfigFromRequest(body);
            if (nextName !== currentName)
                delete environments[currentName];
            environments[nextName] = config;
            await writeEnvironmentFile(rootDir, environments);
            sendJson(res, 200, { environments: environmentListResponse(), environment: { name: nextName, ...loadEnvironmentFile(rootDir)[nextName] } });
            return;
        }
    }
    if (req.method === "GET" && url.pathname === "/api/catalogs") {
        const catalogs = await loadCatalogs(rootDir);
        sendJson(res, 200, {
            apiOperations: catalogs.apiOperations,
            queries: catalogs.queries,
            batches: catalogs.batches
        });
        return;
    }
    if (req.method === "GET" && url.pathname === "/api/db-queries") {
        sendJson(res, 200, { queries: await loadDbQueryCatalog() });
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/db-queries") {
        const body = await readJsonBody(req);
        const id = assertCatalogId(body.id);
        const entry = normalizeQueryCatalogEntry(body.query ?? body);
        const queries = await loadDbQueryCatalog();
        if (queries[id])
            return sendJson(res, 409, { error: `DB query '${id}' already exists.` });
        queries[id] = entry;
        await writeDbQueryCatalog(queries);
        sendJson(res, 201, { id, query: entry, queries });
        return;
    }
    const dbQueryMatch = /^\/api\/db-queries\/([^/]+)$/.exec(url.pathname);
    if (dbQueryMatch) {
        const currentId = assertCatalogId(decodeURIComponent(dbQueryMatch[1]));
        if (req.method === "PUT") {
            const body = await readJsonBody(req);
            const nextId = assertCatalogId(body.id || currentId);
            const entry = normalizeQueryCatalogEntry(body.query ?? body);
            const queries = await loadDbQueryCatalog();
            if (!queries[currentId])
                return sendJson(res, 404, { error: `Unknown DB query '${currentId}'.` });
            if (nextId !== currentId && queries[nextId])
                return sendJson(res, 409, { error: `DB query '${nextId}' already exists.` });
            delete queries[currentId];
            queries[nextId] = entry;
            await writeDbQueryCatalog(queries);
            sendJson(res, 200, { id: nextId, query: entry, queries });
            return;
        }
        if (req.method === "DELETE") {
            const queries = await loadDbQueryCatalog();
            if (!queries[currentId])
                return sendJson(res, 404, { error: `Unknown DB query '${currentId}'.` });
            delete queries[currentId];
            await writeDbQueryCatalog(queries);
            sendJson(res, 200, { queries });
            return;
        }
    }
    if (req.method === "GET" && url.pathname === "/api/unix-batches") {
        sendJson(res, 200, { batches: await loadUnixBatchCatalog() });
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/batch-input-files") {
        const body = await readJsonBody(req);
        const upload = await saveBatchInputFile(body);
        sendJson(res, 201, upload);
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/unix-batches") {
        const body = await readJsonBody(req);
        const id = assertCatalogId(body.id);
        const entry = normalizeUnixBatchCatalogEntry(body.batch ?? body);
        const batches = await loadUnixBatchCatalog();
        if (batches[id])
            return sendJson(res, 409, { error: `Unix batch '${id}' already exists.` });
        batches[id] = entry;
        await writeUnixBatchCatalog(batches);
        sendJson(res, 201, { id, batch: entry, batches });
        return;
    }
    const unixBatchMatch = /^\/api\/unix-batches\/([^/]+)$/.exec(url.pathname);
    if (unixBatchMatch) {
        const currentId = assertCatalogId(decodeURIComponent(unixBatchMatch[1]));
        if (req.method === "PUT") {
            const body = await readJsonBody(req);
            const nextId = assertCatalogId(body.id || currentId);
            const entry = normalizeUnixBatchCatalogEntry(body.batch ?? body);
            const batches = await loadUnixBatchCatalog();
            if (!batches[currentId])
                return sendJson(res, 404, { error: `Unknown Unix batch '${currentId}'.` });
            if (nextId !== currentId && batches[nextId])
                return sendJson(res, 409, { error: `Unix batch '${nextId}' already exists.` });
            delete batches[currentId];
            batches[nextId] = entry;
            await writeUnixBatchCatalog(batches);
            sendJson(res, 200, { id: nextId, batch: entry, batches });
            return;
        }
        if (req.method === "DELETE") {
            const batches = await loadUnixBatchCatalog();
            if (!batches[currentId])
                return sendJson(res, 404, { error: `Unknown Unix batch '${currentId}'.` });
            delete batches[currentId];
            await writeUnixBatchCatalog(batches);
            sendJson(res, 200, { batches });
            return;
        }
    }
    if (req.method === "GET" && url.pathname === "/api/api-collections") {
        sendJson(res, 200, await loadApiCollections(rootDir));
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/api-collections/preview") {
        const body = await readJsonBody(req);
        sendJson(res, 200, previewPostmanCollection(body.collection ?? body));
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/api-collections/import") {
        const body = await readJsonBody(req);
        const collection = await importPostmanCollection(rootDir, body.collection ?? body);
        sendJson(res, 200, { collection, collections: (await loadApiCollections(rootDir)).collections });
        return;
    }
    const collectionRequestsMatch = /^\/api\/api-collections\/([^/]+)\/requests$/.exec(url.pathname);
    if (req.method === "GET" && collectionRequestsMatch) {
        const collectionId = decodeURIComponent(collectionRequestsMatch[1]);
        const file = await loadApiCollections(rootDir);
        const collection = file.collections.find((item) => item.id === collectionId);
        sendJson(res, collection ? 200 : 404, collection ? { collection, requests: collection.requests } : { error: "Unknown API collection." });
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/postman-environments/import") {
        const body = await readJsonBody(req);
        sendJson(res, 200, parsePostmanEnvironment(body.environment ?? body));
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/open-path") {
        const body = await readJsonBody(req);
        const target = resolve(rootDir, body.path ?? "");
        if (!isInsidePath(evidenceDir, target)) {
            sendJson(res, 400, { error: "Path must be under the evidence directory." });
            return;
        }
        openLocalPath(target);
        sendJson(res, 200, { ok: true });
        return;
    }
    if (req.method === "GET" && url.pathname === "/api/flows") {
        sendJson(res, 200, { flows: await listFlows() });
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/flows/concat") {
        const body = await readJsonBody(req);
        const flowIds = body.flowIds ?? [];
        if (flowIds.length < 2)
            return sendJson(res, 400, { error: "Select at least two flows to concatenate." });
        const inputFlows = await Promise.all(flowIds.map(async (id) => loadFlow(await resolveFlowPath(id))));
        const outputId = body.outputId?.trim() || `${inputFlows.map((flow) => flow.id).join("_")}_combined`;
        const flow = concatFlows(inputFlows, {
            id: outputId,
            name: body.name,
            environment: body.environment,
            nodePrefixMode: parsePrefixMode(body.nodePrefixMode ?? "auto"),
            allowVariableOverrides: body.allowVariableOverrides
        });
        const catalogs = await loadCatalogs(rootDir);
        const validation = await validateFlow(flow, catalogs, rootDir);
        if (!validation.ok)
            return sendJson(res, 400, { error: "Generated flow is invalid.", validation });
        const outputPath = await resolveFlowPath(outputId, true);
        await writeFlow(outputPath, flow);
        sendJson(res, 200, { flow, validation });
        return;
    }
    const flowMatch = /^\/api\/flows\/([^/]+)(?:\/(validate|compile|run))?$/.exec(url.pathname);
    if (flowMatch) {
        const flowId = decodeURIComponent(flowMatch[1]);
        const action = flowMatch[2];
        if (req.method === "GET" && !action) {
            sendJson(res, 200, { flow: await loadFlow(await resolveFlowPath(flowId)) });
            return;
        }
        if (req.method === "DELETE" && !action) {
            await deleteFlow(flowId);
            sendJson(res, 200, { flows: await listFlows() });
            return;
        }
        if (req.method === "PUT" && !action) {
            const body = await readJsonBody(req);
            const outputPath = await resolveFlowPath(flowId, true);
            const catalogs = await loadCatalogs(rootDir);
            const normalized = normalizeFlowCatalogParams({ ...body, id: body.id || flowId }, catalogs);
            const validation = await validateFlow(normalized, catalogs, rootDir);
            if (!validation.ok) {
                sendJson(res, 400, {
                    error: "Flow is invalid; it was not saved.",
                    validation
                });
                return;
            }
            await writeFlow(outputPath, normalized);
            sendJson(res, 200, { flow: await loadFlow(outputPath), validation });
            return;
        }
        if (req.method === "POST" && action === "validate") {
            const catalogs = await loadCatalogs(rootDir);
            const flow = normalizeFlowCatalogParams(await loadFlow(await resolveFlowPath(flowId)), catalogs);
            sendJson(res, 200, await validateFlow(flow, catalogs, rootDir));
            return;
        }
        if (req.method === "POST" && action === "compile") {
            const body = await readJsonBody(req).catch(() => ({}));
            const catalogs = await loadCatalogs(rootDir);
            const flow = normalizeFlowCatalogParams(await loadFlow(await resolveFlowPath(flowId)), catalogs);
            const validation = await validateFlow(flow, catalogs, rootDir, body.env ?? flow.environment);
            if (!validation.ok)
                return sendJson(res, 400, validation);
            sendJson(res, 200, compileFlow(flow, { environment: body.env }));
            return;
        }
        if (req.method === "POST" && action === "run") {
            const body = await readJsonBody(req).catch(() => ({}));
            const catalogs = await loadCatalogs(rootDir);
            const flow = normalizeFlowCatalogParams(await loadFlow(await resolveFlowPath(flowId)), catalogs);
            const runId = `${flow.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
            const controller = new AbortController();
            runControllers.set(runId, controller);
            runs.set(runId, { id: runId, flowId: flow.id, status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: { steps: [] } });
            void runFlow(flow, body.env, Boolean(body.dryRun), runId, body.startFrom?.trim() || undefined, body.runScope, controller.signal);
            sendJson(res, 202, { runId, status: "running" });
            return;
        }
    }
    if (req.method === "GET" && url.pathname === "/api/runs/history") {
        sendJson(res, 200, { runs: await listRunHistory(url.searchParams.get("flowId") ?? undefined) });
        return;
    }
    const runMatch = /^\/api\/runs\/([^/]+)(?:\/(stop))?$/.exec(url.pathname);
    if (runMatch) {
        const runId = decodeURIComponent(runMatch[1]);
        const action = runMatch[2];
        if (req.method === "GET" && !action) {
            const run = runs.get(runId);
            sendJson(res, run ? 200 : 404, run ?? { error: "Unknown run." });
            return;
        }
        if (req.method === "POST" && action === "stop") {
            const run = runs.get(runId);
            if (!run) {
                sendJson(res, 404, { error: "Unknown run." });
                return;
            }
            const controller = runControllers.get(runId);
            if (controller && !controller.signal.aborted && (run.status === "running" || run.status === "stopping")) {
                controller.abort();
                runs.set(runId, { ...run, status: "stopping" });
                sendJson(res, 202, { runId, status: "stopping" });
                return;
            }
            sendJson(res, 200, { runId, status: run.status });
            return;
        }
    }
    sendJson(res, 404, { error: "Not found" });
}
function environmentListResponse() {
    return Object.keys(loadEnvironmentFile(rootDir)).map((name) => {
        const env = getEnvironment(name, rootDir);
        return {
            name,
            apiBaseUrl: env.apiBaseUrl,
            apiTlsInsecure: env.apiTlsInsecure,
            oracle: env.oracle,
            sshHosts: env.sshHosts
        };
    });
}
async function loadDbQueryCatalog() {
    const parsed = YAML.parse(await readFile(queriesFile, "utf8"));
    return normalizeQueryCatalog(queryCatalogSchema.parse(parsed ?? {}));
}
async function writeDbQueryCatalog(queries) {
    const validated = normalizeQueryCatalog(queryCatalogSchema.parse(queries));
    await writeFile(queriesFile, YAML.stringify(validated, catalogYamlOptions), "utf8");
}
async function loadUnixBatchCatalog() {
    const parsed = YAML.parse(await readFile(batchesFile, "utf8"));
    return batchCatalogSchema.parse(parsed ?? {});
}
async function writeUnixBatchCatalog(batches) {
    const validated = batchCatalogSchema.parse(batches);
    await writeFile(batchesFile, YAML.stringify(validated, catalogYamlOptions), "utf8");
}
function assertCatalogId(value) {
    const id = String(value ?? "").trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        throw new Error("DB query id must use only letters, numbers, underscores, and hyphens.");
    }
    return id;
}
function normalizeQueryCatalogEntry(value) {
    const entry = {
        description: emptyToUndefined(value.description),
        mode: value.mode === "execute" ? "execute" : value.mode === "query" ? "query" : undefined,
        sql: String(value.sql ?? "").trim(),
        params: normalizeOptionalBindParams(emptyRecordToUndefined(value.params)),
        expect: value.expect,
        captures: emptyRecordToUndefined(value.captures),
        maxRows: value.maxRows === undefined || value.maxRows === null || value.maxRows === 0 ? undefined : Number(value.maxRows)
    };
    return queryCatalogSchema.parse({ candidate: removeUndefined(entry) }).candidate;
}
function normalizeUnixBatchCatalogEntry(value) {
    const entry = {
        description: emptyToUndefined(value.description),
        hostRef: String(value.hostRef ?? "").trim(),
        command: String(value.command ?? "").trim(),
        fixedArgs: normalizeScalarArray(value.fixedArgs),
        workingDirectory: emptyToUndefined(value.workingDirectory),
        useWorkingDirectory: value.useWorkingDirectory === true ? true : undefined,
        environment: emptyRecordToUndefined(value.environment),
        args: normalizeBatchArgs(value.args),
        inputFiles: normalizeBatchInputFiles(value.inputFiles),
        outputFiles: normalizeBatchOutputFiles(value.outputFiles),
        timeoutSeconds: value.timeoutSeconds === undefined || value.timeoutSeconds === null || value.timeoutSeconds === 0 ? undefined : Number(value.timeoutSeconds),
        success: normalizeBatchSuccess(value.success),
        captures: emptyRecordToUndefined(value.captures)
    };
    return batchCatalogSchema.parse({ candidate: removeUndefined(entry) }).candidate;
}
function normalizeBatchInputFiles(inputFiles) {
    const entries = (inputFiles ?? [])
        .map((file) => ({
        name: String(file.name ?? "").trim(),
        required: file.required === undefined ? undefined : Boolean(file.required),
        remotePath: emptyToUndefined(file.remotePath),
        paramName: emptyToUndefined(file.paramName),
        appendAsArg: file.appendAsArg || undefined
    }))
        .filter((file) => file.name);
    return entries.length ? entries : undefined;
}
function normalizeBatchOutputFiles(outputFiles) {
    const entries = (outputFiles ?? [])
        .map((file) => ({
        name: String(file.name ?? "").trim(),
        required: file.required === undefined ? undefined : Boolean(file.required),
        source: file.source,
        pathPattern: emptyToUndefined(file.pathPattern),
        remotePath: emptyToUndefined(file.remotePath),
        download: file.download === undefined ? undefined : Boolean(file.download),
        decrypt: file.decrypt ? removeUndefined({
            command: emptyToUndefined(file.decrypt.command),
            outputRemotePath: emptyToUndefined(file.decrypt.outputRemotePath),
            required: file.decrypt.required === undefined ? undefined : Boolean(file.decrypt.required)
        }) : undefined
    }))
        .filter((file) => file.name);
    return entries.length ? entries : undefined;
}
function normalizeScalarArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const items = value
        .map((entry) => typeof entry === "number" || typeof entry === "boolean" ? entry : String(entry ?? "").trim())
        .filter((entry) => entry !== "");
    return items.length ? items : undefined;
}
function normalizeBatchArgs(args) {
    const entries = (args ?? [])
        .map((arg) => ({
        name: String(arg.name ?? "").trim(),
        required: arg.required === undefined ? undefined : Boolean(arg.required),
        type: arg.type,
        pattern: emptyToUndefined(arg.pattern),
        luhn: arg.luhn || undefined
    }))
        .filter((arg) => arg.name);
    return entries.length ? entries : undefined;
}
function normalizeBatchSuccess(success) {
    if (!success)
        return undefined;
    const exitCodes = (success.exitCodes ?? []).map(Number).filter(Number.isInteger);
    const requiredOutput = (success.requiredOutput ?? []).map((value) => String(value ?? "").trim()).filter(Boolean);
    const normalized = {
        exitCodes: exitCodes.length ? exitCodes : undefined,
        requiredOutput: requiredOutput.length ? requiredOutput : undefined
    };
    return Object.keys(removeUndefined(normalized)).length ? removeUndefined(normalized) : undefined;
}
function normalizeOptionalBindParams(value) {
    if (!value)
        return undefined;
    const normalized = normalizeBindParamRecord(value);
    return Object.keys(normalized).length ? normalized : undefined;
}
function emptyToUndefined(value) {
    const text = String(value ?? "").trim();
    return text ? text : undefined;
}
function emptyRecordToUndefined(value) {
    if (!value)
        return undefined;
    const entries = Object.entries(value).filter(([key, entry]) => key.trim() && entry !== undefined && entry !== null && String(entry).trim() !== "");
    return entries.length ? Object.fromEntries(entries) : undefined;
}
async function saveBatchInputFile(body) {
    const flowId = safeStorageSegment(body.flowId, "flow");
    const stepId = safeStorageSegment(body.stepId, "step");
    const inputName = safeStorageSegment(body.inputName, "input");
    const fileName = safeFileName(body.fileName);
    const rawContent = String(body.contentBase64 ?? "");
    if (!rawContent)
        throw new Error("No file content was provided.");
    const base64 = rawContent.includes(",") ? rawContent.slice(rawContent.indexOf(",") + 1) : rawContent;
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length === 0)
        throw new Error("Uploaded file is empty.");
    const maxBytes = 50 * 1024 * 1024;
    if (buffer.length > maxBytes)
        throw new Error(`Batch input file exceeds ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    const targetDir = resolve(batchInputFilesDir, flowId, stepId, inputName);
    if (!isInsidePath(batchInputFilesDir, targetDir))
        throw new Error("Invalid batch input file target.");
    await mkdir(targetDir, { recursive: true });
    const targetPath = resolve(targetDir, `${Date.now()}_${fileName}`);
    if (!isInsidePath(batchInputFilesDir, targetPath))
        throw new Error("Invalid batch input file path.");
    await writeFile(targetPath, buffer);
    return {
        fileName,
        localPath: relative(rootDir, targetPath).replace(/\\/g, "/"),
        sizeBytes: buffer.length
    };
}
function safeStorageSegment(value, fallback) {
    const normalized = String(value ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
    return normalized || fallback;
}
function safeFileName(value) {
    const name = basename(String(value ?? "input.dat")).replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^_+|_+$/g, "");
    return name || "input.dat";
}
function removeUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
function environmentConfigFromRequest(body) {
    return {
        apiBaseUrl: body.apiBaseUrl,
        apiTlsInsecure: body.apiTlsInsecure,
        oracle: body.oracle,
        sshHosts: body.sshHosts
    };
}
async function listFlows() {
    await mkdir(flowsDir, { recursive: true });
    const entries = await readdir(flowsDir);
    const flows = [];
    for (const entry of entries.filter((name) => name.endsWith(".flow.yaml") || name.endsWith(".flow.yml"))) {
        const path = join(flowsDir, entry);
        const flow = await loadFlow(path).catch(() => undefined);
        if (flow)
            flows.push({ id: flow.id, name: flowListName(flow), environment: flow.environment, path });
    }
    return flows;
}
function flowListName(flow) {
    const name = flow.name?.trim();
    if (!name || (name.toLowerCase() === "new flow" && flow.id !== "new_flow"))
        return undefined;
    return name;
}
async function deleteFlow(flowId) {
    const path = await resolveFlowPath(flowId);
    const normalizedFlowsDir = resolve(flowsDir).toLowerCase();
    const normalizedPath = resolve(path).toLowerCase();
    if (!normalizedPath.startsWith(`${normalizedFlowsDir}\\`) && normalizedPath !== normalizedFlowsDir) {
        throw new Error(`Refusing to delete flow outside flows directory: ${path}`);
    }
    await unlink(path);
}
async function listRunHistory(flowId) {
    if (!(await fileExists(evidenceDir)))
        return [];
    const entries = await readdir(evidenceDir, { withFileTypes: true });
    const runs = [];
    for (const entry of entries.filter((item) => item.isDirectory())) {
        const runResultPath = join(evidenceDir, entry.name, "run-result.json");
        try {
            const result = JSON.parse(await readFile(runResultPath, "utf8"));
            if (flowId && result.scenarioId !== flowId)
                continue;
            runs.push({
                runId: result.runId ?? entry.name,
                scenarioId: result.scenarioId ?? entry.name,
                status: result.status ?? "unknown",
                startedAt: result.startedAt ?? "",
                endedAt: result.endedAt,
                durationMs: result.durationMs,
                failedStep: result.steps?.find((step) => step.status === "failed")?.stepId,
                evidenceDir: result.evidenceDir ?? join(evidenceDir, entry.name),
                reportPath: join(evidenceDir, entry.name, "report.html")
            });
        }
        catch {
            // Ignore evidence folders that are not completed runner outputs.
        }
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50);
}
function parsePostmanEnvironment(payload) {
    const source = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : {};
    const rawValues = Array.isArray(source.values) ? source.values : Array.isArray(source.variable) ? source.variable : [];
    const values = Object.fromEntries(rawValues
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .map((item) => item)
        .filter((item) => item.key && item.disabled !== true)
        .map((item) => [String(item.key), item.value ?? ""]));
    return {
        name: String(source.name || "Postman environment"),
        values
    };
}
async function runFlow(flow, envOverride, dryRun, runId, startFrom, runScope = "from", signal) {
    const state = runs.get(runId);
    if (!state)
        return;
    try {
        const catalogs = await loadCatalogs(rootDir);
        const selectedEnvironment = envOverride ?? flow.environment;
        const validation = await validateFlow(flow, catalogs, rootDir, selectedEnvironment);
        if (!validation.ok)
            throw new Error(validation.errors.join("\n"));
        const compiled = compileFlow(flow, { environment: selectedEnvironment });
        const scenario = sliceScenarioFromFlowNode(compiled, startFrom, runScope);
        const scenarioValidation = validateScenarioReferences(scenario, catalogs);
        if (!scenarioValidation.ok)
            throw new Error(scenarioValidation.errors.join("\n"));
        await ensureEvidenceRoot(rootDir);
        const env = getEnvironment(selectedEnvironment, rootDir);
        const runner = new ScenarioRunner(scenario, catalogs, env, {
            rootDir,
            dryRun,
            signal,
            onStepStart: (event) => updateRunProgress(runId, {
                currentStepId: event.stepId,
                currentStepStartedAt: event.startedAt
            }),
            onStepResult: (step) => appendRunStepResult(runId, step)
        });
        const result = await runner.run();
        runs.set(runId, {
            ...state,
            status: result.status,
            endedAt: new Date().toISOString(),
            currentStepId: undefined,
            currentStepStartedAt: undefined,
            updatedAt: new Date().toISOString(),
            evidenceDir: result.evidenceDir,
            result
        });
    }
    catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        runs.set(runId, {
            ...state,
            status: err.name === "AbortError" ? "cancelled" : "failed",
            endedAt: new Date().toISOString(),
            error: err.message
        });
    }
    finally {
        runControllers.delete(runId);
    }
}
function updateRunProgress(runId, patch) {
    const current = runs.get(runId);
    if (!current || (current.status !== "running" && current.status !== "stopping"))
        return;
    runs.set(runId, {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
        result: normalizePartialRunResult(current.result)
    });
}
function appendRunStepResult(runId, step) {
    const current = runs.get(runId);
    if (!current || (current.status !== "running" && current.status !== "stopping"))
        return;
    const result = normalizePartialRunResult(current.result);
    const existing = result.steps ?? [];
    runs.set(runId, {
        ...current,
        currentStepId: current.currentStepId === step.stepId ? undefined : current.currentStepId,
        currentStepStartedAt: current.currentStepId === step.stepId ? undefined : current.currentStepStartedAt,
        updatedAt: new Date().toISOString(),
        result: {
            ...result,
            steps: [...existing.filter((item) => item.stepId !== step.stepId), step]
        }
    });
}
function normalizePartialRunResult(result) {
    if (!result || typeof result !== "object")
        return { steps: [] };
    const steps = Array.isArray(result.steps)
        ? result.steps
        : [];
    return { ...result, steps };
}
function sliceScenarioFromFlowNode(compiled, startFrom, runScope = "from") {
    if (!startFrom)
        return compiled.scenario;
    const mapEntry = compiled.stepMap.find((entry) => entry.flowNodeId === startFrom || entry.scenarioStepId === startFrom);
    if (!mapEntry) {
        throw new Error(`Cannot start flow from '${startFrom}': no flow node or compiled step with that ID exists.`);
    }
    const startIndex = compiled.scenario.steps.findIndex((step) => step.id === mapEntry.scenarioStepId);
    if (startIndex < 0) {
        throw new Error(`Cannot start flow from '${startFrom}': compiled step '${mapEntry.scenarioStepId}' was not found.`);
    }
    return {
        ...compiled.scenario,
        id: `${compiled.scenario.id}-${runScope === "only" ? "only" : "from"}-${safeRunSegment(startFrom)}`,
        steps: runScope === "only" ? [compiled.scenario.steps[startIndex]] : compiled.scenario.steps.slice(startIndex)
    };
}
function safeRunSegment(value) {
    return value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "step";
}
async function resolveFlowPath(flowId, allowNew = false) {
    const direct = flowPath(flowId);
    if (await fileExists(direct))
        return direct;
    await mkdir(flowsDir, { recursive: true });
    const entries = await readdir(flowsDir);
    for (const entry of entries.filter((name) => name.endsWith(".flow.yaml") || name.endsWith(".flow.yml"))) {
        const candidate = join(flowsDir, entry);
        const flow = await loadFlow(candidate).catch(() => undefined);
        if (flow?.id === flowId || entry === flowId)
            return candidate;
    }
    if (allowNew)
        return direct;
    throw new Error(`Unknown flow '${flowId}'.`);
}
function flowPath(flowId) {
    const safe = flowId.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(flowsDir, safe.endsWith(".flow.yaml") ? safe : `${safe}.flow.yaml`);
}
function parsePrefixMode(value) {
    if (value === "auto" || value === "always" || value === "never")
        return value;
    throw new Error(`Invalid node prefix mode '${value}'.`);
}
function isInsidePath(parent, child) {
    const rel = relative(parent, child);
    return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}
function openLocalPath(target) {
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
    execFile(command, args, { windowsHide: true }, () => undefined);
}
async function fileExists(path) {
    return access(path).then(() => true).catch(() => false);
}
async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8").trim();
    return (text ? JSON.parse(text) : {});
}
function sendJson(res, status, value) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value, null, 2));
}
async function serveStatic(res, pathname) {
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const fullPath = resolve(webDistDir, relative);
    if (!fullPath.startsWith(webDistDir))
        return sendJson(res, 403, { error: "Forbidden" });
    try {
        const info = await stat(fullPath);
        if (info.isDirectory())
            return serveStatic(res, `${pathname.replace(/\/$/, "")}/index.html`);
        res.writeHead(200, { "content-type": mimeType(fullPath) });
        createReadStream(fullPath).pipe(res);
    }
    catch {
        if (pathname !== "/")
            return serveStatic(res, "/");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<h1>Adfinem Test Runner</h1><p>Build the web app first with <code>npm run web:build</code>.</p>");
    }
}
function mimeType(path) {
    switch (extname(path).toLowerCase()) {
        case ".html": return "text/html; charset=utf-8";
        case ".js": return "text/javascript; charset=utf-8";
        case ".css": return "text/css; charset=utf-8";
        case ".svg": return "image/svg+xml";
        case ".png": return "image/png";
        case ".json": return "application/json; charset=utf-8";
        default: return "application/octet-stream";
    }
}
