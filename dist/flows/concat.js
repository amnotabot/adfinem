import { orderedNodes } from "./compiler.js";
export function concatFlows(flows, options) {
    if (flows.length < 2)
        throw new Error("At least two flows are required to concatenate.");
    const environment = options.environment ?? commonEnvironment(flows);
    const variables = mergeVariables(flows, Boolean(options.allowVariableOverrides));
    const usedIds = new Set();
    const nodes = [];
    for (const flow of flows) {
        const sourceNodes = orderedNodes(flow);
        const sourceIds = collectNodeIds(sourceNodes);
        const needsPrefix = prefixRequired(options.nodePrefixMode ?? "auto", sourceIds, usedIds);
        const prefix = `${sanitizeId(flow.id)}_`;
        const idMap = new Map();
        for (const id of sourceIds) {
            const mapped = needsPrefix ? uniqueId(`${prefix}${id}`, usedIds) : uniqueId(id, usedIds);
            idMap.set(id, mapped);
            usedIds.add(mapped);
        }
        for (const node of sourceNodes) {
            nodes.push(rewriteNode(node, idMap));
        }
    }
    return {
        version: 1,
        id: options.id,
        name: options.name,
        environment,
        variables,
        nodes,
        edges: buildTimelineEdges(nodes)
    };
}
function commonEnvironment(flows) {
    const environments = [...new Set(flows.map((flow) => flow.environment))];
    if (environments.length === 1)
        return environments[0];
    throw new Error(`Input flows use different environments (${environments.join(", ")}). Pass --env to choose the generated flow environment.`);
}
function mergeVariables(flows, allowOverrides) {
    const merged = {};
    const sources = new Map();
    for (const flow of flows) {
        for (const [name, value] of Object.entries(flow.variables ?? {})) {
            if (Object.prototype.hasOwnProperty.call(merged, name) && stableJson(merged[name]) !== stableJson(value) && !allowOverrides) {
                throw new Error(`Variable '${name}' has different values in '${sources.get(name)}' and '${flow.id}'. Pass --allow-variable-overrides to keep the later value.`);
            }
            merged[name] = value;
            sources.set(name, flow.id);
        }
    }
    return Object.keys(merged).length ? merged : undefined;
}
function prefixRequired(mode, sourceIds, usedIds) {
    if (mode === "always")
        return true;
    if (mode === "never")
        return false;
    for (const id of sourceIds) {
        if (usedIds.has(id))
            return true;
    }
    return false;
}
function collectNodeIds(nodes) {
    const ids = new Set();
    for (const node of nodes) {
        ids.add(node.id);
        if (node.type === "api_operation") {
            for (const postAction of node.postActions ?? [])
                ids.add(postAction.id);
        }
    }
    return ids;
}
function rewriteNode(node, idMap) {
    const rewritten = rewriteValue(node, idMap);
    rewritten.id = idMap.get(node.id) ?? node.id;
    if (rewritten.type === "api_operation") {
        rewritten.postActions = rewritten.postActions?.map((action) => ({
            ...action,
            id: idMap.get(action.id) ?? action.id
        }));
    }
    return rewritten;
}
function rewriteValue(value, idMap) {
    if (typeof value === "string")
        return rewriteReferences(value, idMap);
    if (Array.isArray(value))
        return value.map((entry) => rewriteValue(entry, idMap));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteValue(entry, idMap)]));
    }
    return value;
}
function rewriteReferences(value, idMap) {
    return value.replace(/\$\{([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\}/g, (match, nodeId, outputName) => {
        const mapped = idMap.get(nodeId);
        return mapped ? `\${${mapped}.${outputName}}` : match;
    });
}
function buildTimelineEdges(nodes) {
    if (nodes.length < 2)
        return undefined;
    return nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: nodes[index + 1].id }));
}
function uniqueId(seed, usedIds) {
    let candidate = sanitizeId(seed);
    let suffix = 2;
    while (usedIds.has(candidate)) {
        candidate = `${sanitizeId(seed)}_${suffix}`;
        suffix += 1;
    }
    return candidate;
}
function sanitizeId(value) {
    const normalized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    return normalized || "flow";
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
