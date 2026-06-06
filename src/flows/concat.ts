import { orderedNodes } from "./compiler.js";
import type { FlowEdge, FlowFile, FlowNode } from "./types.js";

export type FlowNodePrefixMode = "auto" | "always" | "never";

export interface ConcatFlowsOptions {
  id: string;
  name?: string;
  environment?: string;
  nodePrefixMode?: FlowNodePrefixMode;
  allowVariableOverrides?: boolean;
}

export function concatFlows(flows: FlowFile[], options: ConcatFlowsOptions): FlowFile {
  if (flows.length < 2) throw new Error("At least two flows are required to concatenate.");

  const environment = options.environment ?? commonEnvironment(flows);
  const variables = mergeVariables(flows, Boolean(options.allowVariableOverrides));
  const usedIds = new Set<string>();
  const nodes: FlowNode[] = [];

  for (const flow of flows) {
    const sourceNodes = orderedNodes(flow);
    const sourceIds = collectNodeIds(sourceNodes);
    const needsPrefix = prefixRequired(options.nodePrefixMode ?? "auto", sourceIds, usedIds);
    const prefix = `${sanitizeId(flow.id)}_`;
    const idMap = new Map<string, string>();

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

function commonEnvironment(flows: FlowFile[]): string {
  const environments = [...new Set(flows.map((flow) => flow.environment))];
  if (environments.length === 1) return environments[0];
  throw new Error(`Input flows use different environments (${environments.join(", ")}). Pass --env to choose the generated flow environment.`);
}

function mergeVariables(flows: FlowFile[], allowOverrides: boolean): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  const sources = new Map<string, string>();

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

function prefixRequired(mode: FlowNodePrefixMode, sourceIds: Set<string>, usedIds: Set<string>): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  for (const id of sourceIds) {
    if (usedIds.has(id)) return true;
  }
  return false;
}

function collectNodeIds(nodes: FlowNode[]): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    ids.add(node.id);
    if (node.type === "api_operation") {
      for (const postAction of node.postActions ?? []) ids.add(postAction.id);
    }
  }
  return ids;
}

function rewriteNode(node: FlowNode, idMap: Map<string, string>): FlowNode {
  const rewritten = rewriteValue(node, idMap) as FlowNode;
  rewritten.id = idMap.get(node.id) ?? node.id;
  if (rewritten.type === "api_operation") {
    rewritten.postActions = rewritten.postActions?.map((action) => ({
      ...action,
      id: idMap.get(action.id) ?? action.id
    }));
  }
  return rewritten;
}

function rewriteValue(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value === "string") return rewriteReferences(value, idMap);
  if (Array.isArray(value)) return value.map((entry) => rewriteValue(entry, idMap));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteValue(entry, idMap)]));
  }
  return value;
}

function rewriteReferences(value: string, idMap: Map<string, string>): string {
  return value.replace(/\$\{([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\}/g, (match, nodeId: string, outputName: string) => {
    const mapped = idMap.get(nodeId);
    return mapped ? `\${${mapped}.${outputName}}` : match;
  });
}

function buildTimelineEdges(nodes: FlowNode[]): FlowEdge[] | undefined {
  if (nodes.length < 2) return undefined;
  return nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: nodes[index + 1].id }));
}

function uniqueId(seed: string, usedIds: Set<string>): string {
  let candidate = sanitizeId(seed);
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${sanitizeId(seed)}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function sanitizeId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "flow";
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}
