import { normalizeJsonRawBody } from "../adapters/api/body-utils.js";
import { normalizeBindParamRecord } from "../adapters/db/query-catalog.js";
import { batchArgParamsForValidation, batchInputFiles, hasBatchInputFilePayload } from "../adapters/unix/batch-input-files.js";
import { applyFlowEnvironmentInputs, compileFlow, isCompleteLinearEdgeChain, orderedNodes } from "./compiler.js";
import { validateScenarioReferences } from "../dsl/validator.js";
export async function validateFlow(flow, catalogs, rootDir, environment = flow.environment) {
    const effectiveFlow = applyFlowEnvironmentInputs(flow, environment);
    const errors = [];
    const warnings = [];
    const seenIds = new Set();
    const nodeIds = new Set(effectiveFlow.nodes.map((node) => node.id));
    for (const node of effectiveFlow.nodes) {
        validateUniqueId(node.id, seenIds, errors);
        if (node.disabled) {
            warnings.push(`Flow node '${node.id}' is disabled and will be skipped.`);
        }
        if (node.type === "api_operation") {
            if (!catalogs.apiOperations[node.operation]) {
                errors.push(`Flow node '${node.id}' references unknown API operation '${node.operation}'.`);
            }
            for (const postAction of node.postActions ?? []) {
                validateUniqueId(postAction.id, seenIds, errors);
                if (postAction.disabled)
                    warnings.push(`Flow action '${postAction.id}' is disabled and will be skipped.`);
                validateAction(postAction, catalogs, errors);
            }
        }
        else if (node.type === "parallel" || node.type === "loop") {
            validateControlNode(node, catalogs, errors, warnings, seenIds);
        }
        else {
            validateAction(node, catalogs, errors);
        }
    }
    validateEdges(effectiveFlow, nodeIds, errors, warnings);
    validateReferences(effectiveFlow, catalogs, errors, warnings);
    const compiled = compileFlow(flow, { environment });
    if (compiled.scenario.steps.length > 0) {
        const scenarioValidation = validateScenarioReferences(compiled.scenario, catalogs);
        for (const error of scenarioValidation.errors)
            errors.push(`Compiled scenario: ${error}`);
    }
    else {
        warnings.push("Flow has no enabled steps.");
    }
    return { ok: errors.length === 0, errors, warnings };
}
function validateUniqueId(id, seenIds, errors) {
    if (seenIds.has(id))
        errors.push(`Duplicate flow node/action id '${id}'.`);
    seenIds.add(id);
}
function validateAction(node, catalogs, errors) {
    if ((node.type === "db_query" || node.type === "db_assert" || node.type === "db_execute") && !catalogs.queries[node.query]) {
        errors.push(`Flow action '${node.id}' references unknown query '${node.query}'.`);
    }
    if (node.type === "db_assert" && catalogs.queries[node.query] && !catalogs.queries[node.query].expect) {
        errors.push(`Flow action '${node.id}' uses db_assert but query '${node.query}' has no expect block.`);
    }
    if (node.type === "db_execute" && catalogs.queries[node.query] && catalogs.queries[node.query].mode !== "execute") {
        errors.push(`Flow action '${node.id}' uses db_execute but query '${node.query}' is not marked mode: execute.`);
    }
    if (node.type === "unix_batch" && !catalogs.batches[node.batch]) {
        errors.push(`Flow action '${node.id}' references unknown batch '${node.batch}'.`);
    }
}
function validateEdges(flow, nodeIds, errors, warnings) {
    if (!flow.edges?.length)
        return;
    for (const edge of flow.edges) {
        if (!nodeIds.has(edge.from))
            errors.push(`Flow edge references unknown source node '${edge.from}'.`);
        if (!nodeIds.has(edge.to))
            errors.push(`Flow edge references unknown target node '${edge.to}'.`);
    }
    if (flow.ui?.manualEdges) {
        warnings.push("Manual canvas edges are view-only. Execution follows saved node order unless steps are wrapped in explicit Parallel or Loop blocks.");
        return;
    }
    if (flow.edges.length !== Math.max(0, flow.nodes.length - 1)) {
        warnings.push("Edges are non-linear; fan-out/fan-in is displayed on the canvas while top-level execution still follows node order unless using explicit Parallel blocks.");
        return;
    }
    if (!isCompleteLinearEdgeChain(flow)) {
        warnings.push("Edges do not form one complete top-level sequence; the canvas will display them, but execution follows the saved node order unless using explicit Parallel or Loop blocks.");
    }
}
function validateControlNode(node, catalogs, errors, warnings, seenIds, loopAncestors = []) {
    if (node.type === "parallel") {
        if (node.branches.length === 0)
            errors.push(`Parallel node '${node.id}' must contain at least one branch.`);
        for (const branch of node.branches) {
            if (branch.nodes.length === 0)
                warnings.push(`Parallel node '${node.id}' branch '${branch.id}' has no steps.`);
            for (const child of branch.nodes) {
                validateUniqueId(child.id, seenIds, errors);
                if (child.type === "parallel" || child.type === "loop")
                    validateControlNode(child, catalogs, errors, warnings, seenIds, loopAncestors);
                else if (child.type === "api_operation") {
                    if (!catalogs.apiOperations[child.operation])
                        errors.push(`Flow node '${child.id}' references unknown API operation '${child.operation}'.`);
                }
                else
                    validateAction(child, catalogs, errors);
            }
        }
    }
    if (node.type === "loop") {
        const parentLoop = loopAncestors[loopAncestors.length - 1];
        if (parentLoop) {
            warnings.push(`Nested repeat: ${loopDesignerName(node)} is inside ${loopDesignerName(parentLoop)}. Counts multiply across nested repeats; unwrap one repeat if this was accidental.`);
        }
        if (node.nodes.length === 0)
            errors.push(`Loop node '${node.id}' must contain at least one child step.`);
        if (node.loop.mode === "count" && node.loop.count === undefined)
            errors.push(`Loop node '${node.id}' count mode requires count.`);
        if (node.loop.mode === "foreach" && node.loop.items === undefined)
            errors.push(`Loop node '${node.id}' foreach mode requires items.`);
        for (const child of node.nodes) {
            validateUniqueId(child.id, seenIds, errors);
            if (child.type === "parallel" || child.type === "loop")
                validateControlNode(child, catalogs, errors, warnings, seenIds, [...loopAncestors, node]);
            else if (child.type === "api_operation") {
                if (!catalogs.apiOperations[child.operation])
                    errors.push(`Flow node '${child.id}' references unknown API operation '${child.operation}'.`);
            }
            else
                validateAction(child, catalogs, errors);
        }
    }
}
function loopDesignerName(node) {
    const summary = node.type === "loop" ? loopSummary(node) : node.label ?? node.id;
    const firstAction = node.type === "loop" ? firstVisibleLoopChildName(node) : undefined;
    return firstAction ? `${summary} repeat around '${firstAction}'` : `${summary} repeat`;
}
function loopSummary(node) {
    if (node.type !== "loop")
        return node.label ?? node.id;
    if (node.loop.mode === "foreach")
        return `foreach ${String(node.loop.items ?? "")}`.trim();
    return `count ${String(node.loop.count ?? 0)}`;
}
function firstVisibleLoopChildName(node) {
    if (node.type !== "loop")
        return undefined;
    for (const child of node.nodes ?? []) {
        if (child.type === "loop") {
            const nested = firstVisibleLoopChildName(child);
            if (nested)
                return nested;
        }
        else {
            return child.label ?? child.id;
        }
    }
    return undefined;
}
function validateReferences(flow, catalogs, errors, warnings) {
    const availableBare = new Set(Object.keys(flow.variables ?? {}));
    const availableNodeIds = new Set();
    const ordered = orderedNodes(flow);
    const allNodeIds = new Set(ordered.flatMap((node) => [node.id, ...(node.type === "api_operation" ? (node.postActions ?? []).map((action) => action.id) : [])]));
    const loopNodes = new Map(allFlowNodes(flow.nodes).filter((node) => node.type === "loop").map((node) => [node.id, node]));
    const disabledNodeIds = new Set(ordered.flatMap((node) => [
        ...(node.disabled ? [node.id] : []),
        ...(node.type === "api_operation" ? (node.postActions ?? []).filter((action) => action.disabled).map((action) => action.id) : [])
    ]));
    const outputsByNode = new Map();
    for (const node of ordered) {
        outputsByNode.set(node.id, outputNamesFor(node, catalogs));
        if (node.type === "api_operation") {
            for (const action of node.postActions ?? [])
                outputsByNode.set(action.id, outputNamesFor(action, catalogs));
        }
    }
    for (const node of ordered) {
        if (node.disabled)
            continue;
        if (node.type === "parallel" || node.type === "loop") {
            publishExpectedOutputs(node, catalogs, availableBare, warnings);
            availableNodeIds.add(node.id);
            continue;
        }
        validateNodeReferences(node, availableBare, availableNodeIds, allNodeIds, disabledNodeIds, outputsByNode, loopNodes, catalogs, errors, warnings);
        validateRequiredInputs(node, catalogs, errors, warnings);
        validateApiStepIntent(node, warnings);
        publishExpectedOutputs(node, catalogs, availableBare, warnings);
        availableNodeIds.add(node.id);
        if (node.type === "api_operation") {
            for (const postAction of node.postActions ?? []) {
                if (postAction.disabled)
                    continue;
                validateNodeReferences(postAction, availableBare, availableNodeIds, allNodeIds, disabledNodeIds, outputsByNode, loopNodes, catalogs, errors, warnings);
                validateRequiredInputs(postAction, catalogs, errors, warnings);
                validateApiStepIntent(postAction, warnings);
                publishExpectedOutputs(postAction, catalogs, availableBare, warnings);
                availableNodeIds.add(postAction.id);
            }
        }
    }
}
function validateNodeReferences(node, availableBare, availableNodeIds, allNodeIds, disabledNodeIds, outputsByNode, loopNodes, catalogs, errors, warnings) {
    const localInputs = new Set(Object.keys(node.input ?? node.params ?? {}));
    for (const ref of findRefs(referencePayload(node))) {
        const loopRef = parseLoopReference(ref);
        if (loopRef) {
            const loopNode = loopNodes.get(loopRef.loopId);
            if (loopNode) {
                if (!availableNodeIds.has(loopRef.loopId)) {
                    errors.push(`Flow node '${node.id}' references '${ref}' before loop '${loopRef.loopId}' has produced outputs.`);
                    continue;
                }
                if (!isKnownLoopOutput(loopNode, loopRef.outputName, catalogs)) {
                    errors.push(`Flow node '${node.id}' references unknown loop output '${loopRef.outputName}' from '${loopRef.loopId}'.`);
                }
                continue;
            }
        }
        const dot = ref.indexOf(".");
        if (dot > 0) {
            const nodeId = ref.slice(0, dot);
            const outputName = ref.slice(dot + 1);
            if (!allNodeIds.has(nodeId)) {
                errors.push(`Flow node '${node.id}' references unknown step '${nodeId}' in '${ref}'.${nearestSuggestion(nodeId, [...allNodeIds])}`);
                continue;
            }
            if (disabledNodeIds.has(nodeId)) {
                warnings.push(`Flow node '${node.id}' references disabled step '${nodeId}' in '${ref}'.`);
            }
            if (!availableNodeIds.has(nodeId)) {
                errors.push(`Flow node '${node.id}' references '${ref}' before '${nodeId}' has produced outputs.`);
                continue;
            }
            const outputs = outputsByNode.get(nodeId) ?? [];
            if (outputs.length > 0 && !outputs.includes(outputName)) {
                errors.push(`Flow node '${node.id}' references unknown output '${outputName}' from '${nodeId}'. Available outputs: ${outputs.join(", ")}.${nearestSuggestion(outputName, outputs)}`);
            }
            continue;
        }
        if (!availableBare.has(ref) && !localInputs.has(ref)) {
            errors.push(`Flow node '${node.id}' references unknown variable or capture '${ref}'. Use a namespaced reference like previous_node.${ref} when possible.`);
        }
    }
}
function parseLoopReference(ref) {
    const indexed = ref.match(/^([A-Za-z0-9_-]+)\[\d+\]\.(.+)$/);
    if (indexed)
        return { loopId: indexed[1], outputName: indexed[2] };
    const dot = ref.indexOf(".");
    if (dot <= 0)
        return undefined;
    return { loopId: ref.slice(0, dot), outputName: ref.slice(dot + 1) };
}
function isKnownLoopOutput(loopNode, outputName, catalogs) {
    if (loopNode.type !== "loop")
        return false;
    const normalized = outputName.replace(/^(last|all|\d+)\./, "");
    const known = new Set();
    const dateOutput = loopDateOutputName(loopNode);
    if (dateOutput)
        known.add(dateOutput);
    for (const child of allFlowNodes(loopNode.nodes ?? [])) {
        for (const output of outputNamesFor(child, catalogs)) {
            known.add(`${child.id}.${output}`);
        }
    }
    return known.has(outputName) || known.has(normalized);
}
function allFlowNodes(nodes) {
    const result = [];
    for (const node of nodes) {
        result.push(node);
        if (node.type === "api_operation")
            result.push(...(node.postActions ?? []));
        if (node.type === "parallel") {
            for (const branch of node.branches)
                result.push(...allFlowNodes(branch.nodes));
        }
        if (node.type === "loop")
            result.push(...allFlowNodes(node.nodes));
    }
    return result;
}
function outputNamesFor(node, catalogs) {
    if (node.type === "api_operation")
        return uniqueStrings([...Object.keys(catalogs.apiOperations[node.operation]?.captures ?? {}), ...Object.keys(node.capture ?? {})]);
    if (node.type === "db_query" || node.type === "db_assert" || node.type === "db_execute")
        return uniqueStrings([...Object.keys(catalogs.queries[node.query]?.captures ?? {}), ...Object.keys(node.capture ?? {})]);
    if (node.type === "unix_batch")
        return uniqueStrings([...Object.keys(catalogs.batches[node.batch]?.captures ?? {}), ...Object.keys(node.capture ?? {})]);
    if (node.type === "loop")
        return uniqueStrings([loopDateOutputName(node) ?? "", ...Object.keys(node.capture ?? {})]);
    if (node.type === "parallel")
        return uniqueStrings([...Object.keys(node.capture ?? {})]);
    return [];
}
function uniqueStrings(values) {
    return [...new Set(values.filter(Boolean))];
}
function nearestSuggestion(value, candidates) {
    const nearest = candidates
        .map((candidate) => ({ candidate, distance: levenshtein(value, candidate) }))
        .sort((a, b) => a.distance - b.distance)[0];
    return nearest && nearest.distance <= Math.max(2, Math.floor(value.length / 3)) ? ` Did you mean '${nearest.candidate}'?` : "";
}
function levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++)
        dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return dp[a.length][b.length];
}
function referencePayload(node) {
    if (node.type !== "api_operation")
        return node;
    const { postActions: _postActions, ...payload } = node;
    return payload;
}
function validateRequiredInputs(node, catalogs, errors, warnings) {
    const params = node.params ?? node.input ?? {};
    if (node.type === "api_operation" && !catalogs.apiOperations[node.operation]) {
        errors.push(`Flow node '${node.id}' references unknown API operation '${node.operation}'.`);
    }
    if (node.type === "api_operation") {
        validateParams(node.id, params, catalogs.apiOperations[node.operation]?.params, errors, "API variable");
        validateApiRequestBody(node, errors);
        validateTemplateBinding(node, catalogs, warnings);
    }
    if (node.type === "db_query" || node.type === "db_assert" || node.type === "db_execute") {
        validateParams(node.id, normalizeBindParamRecord(params), normalizeBindParamRecord(catalogs.queries[node.query]?.params ?? {}), errors, "query param");
    }
    if (node.type === "unix_batch") {
        const batch = catalogs.batches[node.batch];
        validateBatchInputFiles(node.id, params, batch, errors);
        validateArgs(node.id, batchArgParamsForValidation(params, batch), batch?.args ?? [], errors);
    }
}
function validateParams(nodeId, params, specs, errors, label) {
    for (const [name, spec] of Object.entries(specs ?? {})) {
        const value = params[name];
        if (spec.required && (value === undefined || value === null || value === "")) {
            errors.push(`Flow node '${nodeId}' is missing required ${label} '${name}'.`);
        }
    }
}
function validateArgs(nodeId, params, args, errors) {
    for (const arg of args) {
        if (!Object.prototype.hasOwnProperty.call(params, arg.name))
            continue;
        const value = params[arg.name];
        if (arg.required !== false && (value === undefined || value === null || value === "")) {
            errors.push(`Flow node '${nodeId}' is missing required batch arg '${arg.name}'.`);
        }
    }
}
function validateBatchInputFiles(nodeId, params, batch, errors) {
    for (const file of batchInputFiles(batch)) {
        const value = params[file.name];
        if (file.required !== false && !hasBatchInputFilePayload(value)) {
            errors.push(`Flow node '${nodeId}' is missing required batch input file '${file.name}'.`);
        }
        const remotePath = value && typeof value === "object" && !Array.isArray(value)
            ? value.remotePath
            : undefined;
        if (hasBatchInputFilePayload(value) && !file.remotePath && !remotePath) {
            errors.push(`Flow node '${nodeId}' batch input file '${file.name}' needs a remote path.`);
        }
    }
}
function publishExpectedOutputs(node, catalogs, availableBare, _warnings) {
    if (node.type === "api_operation") {
        for (const key of Object.keys(catalogs.apiOperations[node.operation]?.captures ?? {}))
            availableBare.add(key);
    }
    if (node.type === "db_query" || node.type === "db_assert" || node.type === "db_execute") {
        for (const key of Object.keys(catalogs.queries[node.query]?.captures ?? {}))
            availableBare.add(key);
    }
    if (node.type === "unix_batch") {
        for (const key of Object.keys(catalogs.batches[node.batch]?.captures ?? {}))
            availableBare.add(key);
    }
    if (node.type === "loop") {
        const outputName = loopDateOutputName(node);
        if (outputName)
            availableBare.add(outputName);
    }
    for (const key of Object.keys(node.capture ?? {}))
        availableBare.add(key);
}
function loopDateOutputName(node) {
    return node.type === "loop" && node.loop.dateCursor ? node.loop.dateCursor.outputName?.trim() || "business_date" : undefined;
}
function findRefs(value) {
    const refs = [];
    const visit = (current) => {
        if (typeof current === "string") {
            for (const match of current.matchAll(/\$\{([^}]+)\}/g))
                refs.push(match[1]);
            for (const match of current.matchAll(/\{\{([A-Za-z0-9_.-]+)\}\}/g))
                refs.push(match[1]);
        }
        else if (Array.isArray(current)) {
            current.forEach(visit);
        }
        else if (current && typeof current === "object") {
            Object.values(current).forEach(visit);
        }
    };
    visit(value);
    return refs;
}
function validateTemplateBinding(node, catalogs, warnings) {
    if (node.type !== "api_operation" || !node.request)
        return;
    const template = catalogs.apiOperations[node.operation];
    if (!template)
        return;
    if (node.request.method && template.method && node.request.path && template.path) {
        const sameMethod = node.request.method === template.method;
        const samePath = normalizeTemplatePath(node.request.path) === normalizeTemplatePath(template.path);
        if (!sameMethod && !samePath) {
            warnings.push(`Flow node '${node.id}' may be bound to the wrong source template: workflow request is ${node.request.method} ${node.request.path}, template is ${template.method} ${template.path}.`);
        }
        else if (!samePath && template.source?.collectionId) {
            warnings.push(`Flow node '${node.id}' path differs from imported source template: workflow path is ${node.request.path}, template path is ${template.path}. Review before trusting override counts.`);
        }
    }
}
function normalizeTemplatePath(path) {
    return path.toLowerCase().replace(/\/+/g, "/").replace(/\/$/, "");
}
function validateApiRequestBody(node, errors) {
    if (node.type !== "api_operation" || node.request?.bodyMode !== "json" || node.request.rawBody === undefined)
        return;
    const placeholder = "null";
    const rendered = normalizeJsonRawBody(node.request.rawBody)
        .replace(/\$\{[A-Za-z0-9_.-]+\}/g, placeholder)
        .replace(/\{\{[A-Za-z0-9_.-]+\}\}/g, placeholder);
    try {
        JSON.parse(rendered);
    }
    catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(`Flow node '${node.id}' has invalid JSON request body: ${err.message}`);
    }
}
function validateApiStepIntent(node, warnings) {
    if (node.type !== "api_operation")
        return;
    if (node.expectedOutcome === "negative") {
        if (!node.request?.acceptStatuses?.length) {
            warnings.push(`Flow node '${node.id}' is a negative API test but has no Accepted statuses configured.`);
        }
        if (!node.assertions?.length) {
            warnings.push(`Flow node '${node.id}' is a negative API test but has no response assertions.`);
        }
    }
    const authorization = node.request?.headers
        ? Object.entries(node.request.headers).find(([key]) => key.toLowerCase() === "authorization")?.[1]
        : undefined;
    if (typeof authorization === "string" && /\$\{[^}]*token[^}]*\}/i.test(authorization) && !/^Bearer\s+\$\{/i.test(authorization.trim())) {
        warnings.push(`Flow node '${node.id}' Authorization header uses a token reference without a Bearer prefix.`);
    }
}
