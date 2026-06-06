import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Agent as HttpsAgent } from "node:https";
import axios from "axios";
import { JSONPath } from "jsonpath-plus";
import { evidenceVisibilityMode } from "../../config/secrets.js";
import { mergeApiRequest } from "./api-collections.js";
import { normalizeJsonRawBody } from "./body-utils.js";
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 500;
const TRANSIENT_STATUS_CODES = new Set([502, 503, 504]);
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNABORTED"]);
const RESPONSE_PREVIEW_LIMIT_BYTES = 128_000;
export class RestClient {
    env;
    rootDir;
    client;
    constructor(env, rootDir) {
        this.env = env;
        this.rootDir = rootDir;
        this.client = axios.create({
            baseURL: env.apiBaseUrl,
            timeout: 60_000,
            httpsAgent: env.apiTlsInsecure ? new HttpsAgent({ rejectUnauthorized: false }) : undefined
        });
    }
    async execute(operation, input, requestOverride, assertions = [], explicitCaptures = {}, options = {}) {
        if (!this.env.apiBaseUrl)
            throw new Error("ADFINEM_API_BASE_URL is required for API execution.");
        if (operation.type !== "rest")
            throw new Error(`Operation type '${operation.type}' is not supported by RestClient.`);
        const request = withGeneratedHeaders(renderRequestSpec(mergeApiRequest(operation, requestOverride), input));
        if (!request.method || !request.path)
            throw new Error("REST operation must define method and path.");
        const body = operation.requestTemplate && !request.rawBody && request.body === undefined
            ? await this.loadTemplate(operation.requestTemplate, input)
            : requestBody(request, input);
        const response = await this.requestWithRetry(operation, request, body);
        const responseEvidence = normalizeHttpResponse(response);
        const expectedOutcome = options.expectedOutcome ?? "positive";
        const acceptStatuses = normalizeAcceptStatuses(request);
        const statusAccepted = isStatusAccepted(response.status, acceptStatuses);
        const assertionResults = evaluateApiAssertions(response, [...(operation.assertions ?? []), ...assertions]);
        const assertionsPassed = assertionResults.every((assertion) => assertion.passed);
        const captureForEvidence = statusAccepted && assertionsPassed ? true : options.captureOnFailure !== false;
        const evidenceCaptures = captureForEvidence
            ? extractJsonCaptureResults(response.data, operation.captures ?? {}, explicitCaptures)
            : skippedCaptureResults(operation.captures ?? {}, explicitCaptures, "Step failed before capture publishing and captureOnFailure is false.");
        const requiredCaptureFailures = evidenceCaptures.filter((capture) => capture.required && capture.status !== "extracted" && captureForEvidence);
        const passed = statusAccepted && assertionsPassed && requiredCaptureFailures.length === 0;
        const publishedCaptures = passed ? captureResultsToRecord(evidenceCaptures) : {};
        for (const capture of evidenceCaptures) {
            capture.published = Object.prototype.hasOwnProperty.call(publishedCaptures, capture.name);
        }
        const failureReason = passed
            ? undefined
            : failureReasonFor(response.status, acceptStatuses, assertionResults, requiredCaptureFailures);
        const requestEvidence = requestEvidenceFor(request, body);
        const apiEvidence = {
            visibility: options.visibility ?? evidenceVisibilityMode(),
            expectedOutcome,
            acceptStatuses,
            statusAccepted,
            request: requestEvidence,
            resolvedRequest: requestEvidence,
            response: responseEvidence,
            assertionResults,
            evidenceCaptures,
            publishedCaptures,
            finalStatus: passed ? "passed" : "failed",
            failureReason
        };
        return {
            response: response.data,
            captures: publishedCaptures,
            evidencePayload: apiEvidence,
            apiEvidence
        };
    }
    async requestWithRetry(operation, request, body) {
        const method = request.method;
        const allowRetry = operation.idempotent !== false;
        const maxAttempts = allowRetry ? DEFAULT_RETRY_ATTEMPTS : 0;
        let lastError;
        for (let attempt = 0; attempt <= maxAttempts; attempt++) {
            try {
                const started = Date.now();
                const response = await this.client.request({
                    method,
                    url: requestPathForBase(request.path, this.env.apiBaseUrl),
                    headers: request.headers,
                    data: ["POST", "PUT", "PATCH"].includes(method) ? body : undefined,
                    params: method === "GET" || method === "DELETE" || method === "HEAD"
                        ? { ...(request.query ?? {}), ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}) }
                        : request.query,
                    validateStatus: () => true
                });
                response.durationMs = Date.now() - started;
                if (allowRetry && TRANSIENT_STATUS_CODES.has(response.status) && attempt < maxAttempts) {
                    await sleep(DEFAULT_RETRY_DELAY_MS * (attempt + 1));
                    continue;
                }
                return response;
            }
            catch (error) {
                lastError = error;
                if (!allowRetry || !isTransientError(error) || attempt >= maxAttempts)
                    throw error;
                await sleep(DEFAULT_RETRY_DELAY_MS * (attempt + 1));
            }
        }
        throw lastError ?? new Error("REST request failed without an error instance.");
    }
    async loadTemplate(relativePath, input) {
        const path = join(this.rootDir, relativePath);
        let raw;
        try {
            raw = await readFile(path, "utf8");
        }
        catch (error) {
            const err = error;
            if (err.code === "ENOENT") {
                throw new Error(`API request template '${relativePath}' was not found at ${path}.`);
            }
            throw error;
        }
        const rendered = raw.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_match, name) => {
            const value = input[name];
            if (value === undefined || value === null)
                throw new Error(`API template variable '${name}' was not supplied.`);
            return jsonEscape(String(value));
        });
        try {
            return JSON.parse(rendered);
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            throw new Error(`API request template '${relativePath}' did not parse as JSON after substitution: ${err.message}`);
        }
    }
}
function requestEvidenceFor(request, body) {
    return {
        method: request.method,
        path: request.path,
        headers: request.headers,
        query: request.query,
        auth: request.auth,
        body
    };
}
function normalizeHttpResponse(response) {
    const contentType = headerValue(response, "content-type") ?? "";
    const { body, bodyText, bodyJson, sizeBytes, bodyTruncated, bodyPreviewKind } = responseBodyPreview(response.data, contentType);
    return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(Object.entries(response.headers ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value])),
        body,
        bodyText,
        bodyJson,
        contentType,
        durationMs: response.durationMs ?? 0,
        sizeBytes,
        bodyTruncated,
        bodyPreviewKind
    };
}
function responseBodyPreview(data, contentType) {
    if (data === undefined || data === null || data === "") {
        return { body: data, sizeBytes: 0, bodyPreviewKind: "empty" };
    }
    const binary = isBinaryContentType(contentType);
    const rawText = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    const sizeBytes = Buffer.byteLength(rawText ?? "", "utf8");
    const bodyTruncated = sizeBytes > RESPONSE_PREVIEW_LIMIT_BYTES;
    if (binary) {
        return {
            body: `[binary ${contentType || "application/octet-stream"}; ${sizeBytes} bytes]`,
            bodyText: undefined,
            bodyJson: undefined,
            sizeBytes,
            bodyTruncated,
            bodyPreviewKind: "binary"
        };
    }
    const previewText = bodyTruncated ? rawText.slice(0, RESPONSE_PREVIEW_LIMIT_BYTES) : rawText;
    if (typeof data === "object") {
        return {
            body: bodyTruncated ? previewText : data,
            bodyText: previewText,
            bodyJson: bodyTruncated ? undefined : data,
            sizeBytes,
            bodyTruncated,
            bodyPreviewKind: "json"
        };
    }
    if (looksLikeJsonText(data)) {
        try {
            const parsed = JSON.parse(data);
            return {
                body: bodyTruncated ? previewText : parsed,
                bodyText: previewText,
                bodyJson: bodyTruncated ? undefined : parsed,
                sizeBytes,
                bodyTruncated,
                bodyPreviewKind: "json"
            };
        }
        catch {
            // Fall through to text.
        }
    }
    return {
        body: previewText,
        bodyText: previewText,
        sizeBytes,
        bodyTruncated,
        bodyPreviewKind: "text"
    };
}
function isBinaryContentType(contentType) {
    const normalized = contentType.toLowerCase();
    if (!normalized)
        return false;
    if (normalized.includes("json") || normalized.startsWith("text/") || normalized.includes("xml") || normalized.includes("html"))
        return false;
    return true;
}
function looksLikeJsonText(value) {
    return typeof value === "string" && /^[\s\r\n]*[{\[]/.test(value);
}
function normalizeAcceptStatuses(request) {
    return [...new Set([...(request.acceptStatuses ?? request.acceptedStatuses ?? [])]
            .map((status) => Number(status))
            .filter((status) => Number.isInteger(status) && status >= 100 && status <= 599))];
}
function isStatusAccepted(status, acceptStatuses) {
    return acceptStatuses.length > 0 ? acceptStatuses.includes(status) : status >= 200 && status < 300;
}
function failureReasonFor(status, acceptStatuses, assertions, captureFailures) {
    if (!isStatusAccepted(status, acceptStatuses)) {
        return `Status ${status} is not in Accepted statuses ${acceptStatuses.length ? `[${acceptStatuses.join(", ")}]` : "2xx"}.`;
    }
    const failedAssertion = assertions.find((assertion) => !assertion.passed);
    if (failedAssertion)
        return failedAssertion.message ?? "One or more response assertions failed.";
    const failedCapture = captureFailures[0];
    if (failedCapture)
        return failedCapture.message ?? `Required capture '${failedCapture.name}' was not extracted.`;
    return "API step failed.";
}
function jsonEscape(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function isTransientError(error) {
    if (!error || typeof error !== "object")
        return false;
    const candidate = error;
    if (candidate.response?.status && TRANSIENT_STATUS_CODES.has(candidate.response.status))
        return true;
    return Boolean(candidate.code && TRANSIENT_NETWORK_CODES.has(candidate.code));
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function requestBody(request, input) {
    if (request.rawBody !== undefined) {
        const rawBody = request.bodyMode === "json" ? normalizeJsonRawBody(request.rawBody) : request.rawBody;
        const rendered = renderTemplateString(rawBody, input);
        if (request.bodyMode === "json") {
            try {
                return JSON.parse(rendered);
            }
            catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                throw new Error(`API request JSON body did not parse after variable substitution: ${err.message}`);
            }
        }
        return rendered;
    }
    if (request.body !== undefined)
        return renderValue(request.body, input);
    return input;
}
function renderRequestSpec(request, input) {
    return renderValue(request, input);
}
function renderValue(value, input) {
    if (typeof value === "string")
        return renderTemplateString(value, input);
    if (Array.isArray(value))
        return value.map((entry) => renderValue(entry, input));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renderValue(entry, input)]));
    }
    return value;
}
function renderTemplateString(value, input) {
    return value
        .replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_match, name) => renderedInputValue(input, name))
        .replace(/\{\{([A-Za-z0-9_$.-]+)\}\}/g, (_match, name) => renderedInputValue(input, name));
}
function renderedInputValue(input, name) {
    const generated = postmanGeneratedValue(name);
    if (generated !== undefined)
        return generated;
    const value = input[name];
    if (value === undefined || value === null)
        throw new Error(`API request variable '${name}' was not supplied.`);
    return typeof value === "string" ? value : JSON.stringify(value);
}
function postmanGeneratedValue(name) {
    if (name === "$guid" || name === "$randomUUID")
        return randomUUID();
    if (name === "$timestamp")
        return String(Math.floor(Date.now() / 1000));
    if (name === "$isoTimestamp")
        return new Date().toISOString();
    if (name === "$randomInt")
        return String(Math.floor(Math.random() * 1000));
    return undefined;
}
export function withGeneratedHeaders(request) {
    const headers = {
        ...generatedHeadersFor(request),
        ...(request.headers ?? {})
    };
    return Object.keys(headers).length ? { ...request, headers } : request;
}
function generatedHeadersFor(request) {
    const headers = { Accept: "*/*", "Cache-Control": "no-cache" };
    if (request.bodyMode === "json")
        headers["Content-Type"] = "application/json";
    if (request.bodyMode === "urlencoded")
        headers["Content-Type"] = "application/x-www-form-urlencoded";
    return headers;
}
export function requestPathForBase(path, baseUrl) {
    if (!baseUrl || !path.startsWith("/"))
        return path;
    try {
        const basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
        if (!basePath || basePath === "/")
            return path;
        const lowerPath = path.toLowerCase();
        const lowerBase = basePath.toLowerCase();
        if (lowerPath === lowerBase)
            return "/";
        if (lowerPath.startsWith(`${lowerBase}/`))
            return path.slice(basePath.length) || "/";
        return path;
    }
    catch {
        return path;
    }
}
export function evaluateApiAssertions(response, assertions) {
    return assertions.map((assertion) => evaluateApiAssertion(response, assertion));
}
function evaluateApiAssertion(response, assertion) {
    try {
        if (assertion.type === "status") {
            const accepted = Array.isArray(assertion.value) ? assertion.value : [assertion.value];
            const operator = assertion.operator ?? (Array.isArray(assertion.value) ? "in" : "=");
            const passed = operator === "in" ? accepted.includes(response.status) : response.status === assertion.value;
            return {
                assertion,
                passed,
                expected: accepted,
                actual: response.status,
                message: passed ? undefined : `API status assertion failed: got ${response.status}, expected ${accepted.join(", ")}.`
            };
        }
        if (assertion.type === "jsonpath_exists") {
            const values = jsonPathValues(response.data, assertion.path);
            return {
                assertion,
                passed: values.length > 0,
                expected: "exists",
                actual: values.length,
                message: values.length > 0 ? undefined : `API JSONPath assertion failed: '${assertion.path}' did not match.`
            };
        }
        if (assertion.type === "jsonpath_equals") {
            const values = jsonPathValues(response.data, assertion.path);
            const passed = values.some((value) => stableJson(value) === stableJson(assertion.value));
            return {
                assertion,
                passed,
                expected: assertion.value,
                actual: values.length === 1 ? values[0] : values,
                message: passed ? undefined : `API JSONPath assertion failed: '${assertion.path}' did not equal ${JSON.stringify(assertion.value)}.`
            };
        }
        if (assertion.type === "jsonpath_contains") {
            const values = jsonPathValues(response.data, assertion.path);
            const passed = values.some((value) => String(value).includes(String(assertion.value)));
            return {
                assertion,
                passed,
                expected: assertion.value,
                actual: values.length === 1 ? values[0] : values,
                message: passed ? undefined : `API JSONPath assertion failed: '${assertion.path}' did not contain ${JSON.stringify(assertion.value)}.`
            };
        }
        if (assertion.type === "header_exists") {
            const actual = headerValue(response, assertion.header);
            return {
                assertion,
                passed: actual !== undefined,
                expected: "present",
                actual,
                message: actual !== undefined ? undefined : `API header assertion failed: '${assertion.header}' was not present.`
            };
        }
        if (assertion.type === "header_equals") {
            const actual = headerValue(response, assertion.header);
            return {
                assertion,
                passed: actual === assertion.value,
                expected: assertion.value,
                actual,
                message: actual === assertion.value ? undefined : `API header assertion failed: '${assertion.header}' was ${JSON.stringify(actual)}, expected ${JSON.stringify(assertion.value)}.`
            };
        }
        if (assertion.type === "body_contains" || assertion.type === "body_not_contains") {
            const body = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
            const contains = body.includes(assertion.value);
            const passed = assertion.type === "body_contains" ? contains : !contains;
            return {
                assertion,
                passed,
                expected: assertion.type === "body_contains" ? `contains ${assertion.value}` : `does not contain ${assertion.value}`,
                actual: contains ? "contains" : "does not contain",
                message: passed ? undefined : `API body assertion failed: body ${assertion.type === "body_contains" ? "did not contain" : "contained"} ${JSON.stringify(assertion.value)}.`
            };
        }
    }
    catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return { assertion, passed: false, message: err.message };
    }
    return { assertion, passed: false, message: `Unsupported assertion type '${assertion.type ?? "unknown"}'.` };
}
export function assertApiResponse(response, assertions) {
    const failed = evaluateApiAssertions(response, assertions).find((result) => !result.passed);
    if (failed)
        throw new Error(failed.message ?? "API response assertion failed.");
}
function jsonPathValues(data, path) {
    return JSONPath({ path, json: data, wrap: true });
}
function headerValue(response, name) {
    const normalized = name.toLowerCase();
    for (const [header, value] of Object.entries(response.headers ?? {})) {
        if (header.toLowerCase() !== normalized)
            continue;
        return Array.isArray(value) ? value.join(", ") : value === undefined ? undefined : String(value);
    }
    return undefined;
}
function stableJson(value) {
    if (!value || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
        .join(",")}}`;
}
export function extractJsonCaptures(data, captureSpec) {
    return captureResultsToRecord(extractJsonCaptureResults(data, {}, captureSpec));
}
export function extractJsonCaptureResults(data, catalogCaptures, explicitCaptures) {
    const results = [];
    const explicit = new Set(Object.keys(explicitCaptures));
    for (const [name, rawExpr] of Object.entries({ ...catalogCaptures, ...explicitCaptures })) {
        const parsed = parseCaptureExpression(rawExpr);
        const required = explicit.has(name) && parsed.required;
        try {
            const result = JSONPath({ path: parsed.path, json: data, wrap: true });
            if (result.length === 0) {
                results.push({
                    name,
                    expression: rawExpr,
                    source: "bodyJson",
                    required,
                    status: "missing",
                    published: false,
                    message: `Capture '${name}' did not match '${parsed.path}'.${responseFieldHint(data)}`
                });
                continue;
            }
            const value = parsed.mode === "array" ? result : parsed.mode === "scalar" ? result[0] : result.length === 1 ? result[0] : result;
            results.push({ name, expression: rawExpr, source: "bodyJson", required, status: "extracted", published: false, value });
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            results.push({ name, expression: rawExpr, source: "bodyJson", required, status: "error", published: false, message: err.message });
        }
    }
    return results;
}
function skippedCaptureResults(catalogCaptures, explicitCaptures, message) {
    const explicit = new Set(Object.keys(explicitCaptures));
    return Object.entries({ ...catalogCaptures, ...explicitCaptures }).map(([name, expression]) => ({
        name,
        expression,
        source: "bodyJson",
        required: explicit.has(name) && !expression.trim().startsWith("optional:"),
        status: "missing",
        published: false,
        message
    }));
}
function captureResultsToRecord(results) {
    return Object.fromEntries(results
        .filter((result) => result.status === "extracted")
        .map((result) => [result.name, result.value]));
}
function parseCaptureExpression(expression) {
    let trimmed = expression.trim();
    let required = true;
    if (trimmed.startsWith("optional:")) {
        required = false;
        trimmed = trimmed.slice("optional:".length).trim();
    }
    if (trimmed.startsWith("array:"))
        return { path: trimmed.slice("array:".length).trim(), mode: "array", required };
    if (trimmed.startsWith("scalar:"))
        return { path: trimmed.slice("scalar:".length).trim(), mode: "scalar", required };
    return { path: trimmed, mode: "auto", required };
}
function responseFieldHint(data) {
    const hints = collectJsonPathHints(data, "$", 0).slice(0, 10);
    return hints.length ? ` Available response fields include: ${hints.join(", ")}.` : "";
}
function collectJsonPathHints(value, prefix, depth) {
    if (!value || typeof value !== "object" || depth > 1)
        return [];
    if (Array.isArray(value)) {
        const first = value[0];
        return first && typeof first === "object" ? collectJsonPathHints(first, `${prefix}[0]`, depth + 1) : [];
    }
    const hints = [];
    for (const [key, entry] of Object.entries(value)) {
        const path = `${prefix}.${key}`;
        hints.push(path);
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            hints.push(...collectJsonPathHints(entry, path, depth + 1));
        }
    }
    return hints;
}
