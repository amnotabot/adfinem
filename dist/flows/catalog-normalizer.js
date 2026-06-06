import { normalizeBindParamRecord } from "../adapters/db/query-catalog.js";
import { batchInputFileParamNames } from "../adapters/unix/batch-input-files.js";
export function normalizeFlowCatalogParams(flow, catalogs) {
    return {
        ...flow,
        nodes: flow.nodes.map((node) => normalizeNode(node, flow, catalogs))
    };
}
function normalizeNode(node, flow, catalogs) {
    if (node.type === "api_operation") {
        return {
            ...node,
            postActions: node.postActions?.map((action) => normalizeAction(action, flow, catalogs))
        };
    }
    if (node.type === "parallel") {
        return {
            ...node,
            branches: node.branches.map((branch) => ({
                ...branch,
                nodes: branch.nodes.map((child) => normalizeNode(child, flow, catalogs))
            }))
        };
    }
    if (node.type === "loop") {
        return {
            ...node,
            nodes: node.nodes.map((child) => normalizeNode(child, flow, catalogs))
        };
    }
    return normalizeAction(node, flow, catalogs);
}
function normalizeAction(node, flow, catalogs) {
    if (node.type === "db_query" || node.type === "db_assert" || node.type === "db_execute") {
        const specs = catalogs.queries[node.query]?.params;
        if (!specs || Object.keys(specs).length === 0)
            return node;
        return {
            ...node,
            params: normalizeNamedParams(normalizeBindParamRecord(node.params ?? node.input ?? {}), normalizeBindParamRecord(specs))
        };
    }
    if (node.type === "unix_batch") {
        const batch = catalogs.batches[node.batch];
        const args = batch?.args ?? [];
        const fileParamNames = batchInputFileParamNames(batch);
        if (args.length === 0 && fileParamNames.length === 0)
            return node;
        return {
            ...node,
            params: normalizeNamedArgs(node.params ?? node.input ?? {}, args, fileParamNames)
        };
    }
    return node;
}
function normalizeNamedParams(current, specs) {
    const normalized = {};
    for (const [name, spec] of Object.entries(specs)) {
        if (current[name] !== undefined) {
            normalized[name] = current[name];
            continue;
        }
        if (spec.required) {
            normalized[name] = "";
        }
    }
    return normalized;
}
function normalizeNamedArgs(current, args, extraNames = []) {
    const allowed = new Set([...args.map((arg) => arg.name), ...extraNames]);
    return Object.fromEntries(Object.entries(current).filter(([name]) => allowed.has(name)));
}
