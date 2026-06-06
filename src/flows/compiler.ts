import type { Scenario, ScenarioStep } from "../dsl/types.js";
import type { CompiledFlow, FlowActionNode, FlowCompileOptions, FlowFile, FlowNode, FlowNodeType, FlowApiOperationNode, FlowParallelNode, FlowLoopNode } from "./types.js";

export function compileFlow(flow: FlowFile, options: FlowCompileOptions = {}): CompiledFlow {
  const environment = options.environment ?? flow.environment;
  const effectiveFlow = applyFlowEnvironmentInputs(flow, environment);
  const steps: ScenarioStep[] = [];
  const stepMap: CompiledFlow["stepMap"] = [];

  for (const node of orderedNodes(effectiveFlow)) {
    if (node.disabled) continue;
    const step = compileNode(node);
    steps.push(step);
    stepMap.push({ flowNodeId: node.id, scenarioStepId: step.id, type: node.type });

    if (node.type === "api_operation") {
      for (const postAction of node.postActions ?? []) {
        if (postAction.disabled) continue;
        const postStep = compileNode(postAction, node);
        steps.push(postStep);
        stepMap.push({
          flowNodeId: postAction.id,
          scenarioStepId: postStep.id,
          type: postAction.type,
          postActionOf: node.id
        });
      }
    }
    appendControlStepMap(node, stepMap);
  }

  const scenario: Scenario = {
    id: effectiveFlow.id,
    environment,
    variables: effectiveFlow.variables,
    steps
  };

  return { flow: effectiveFlow, scenario, stepMap };
}

export function applyFlowEnvironmentInputs(flow: FlowFile, environment = flow.environment): FlowFile {
  const inputSet = flow.environmentInputs?.[environment];
  if (!inputSet) return flow;
  const nodeInputs = inputSet.nodes ?? {};
  return {
    ...flow,
    variables: mergeRecords(flow.variables, inputSet.variables),
    nodes: flow.nodes.map((node) => applyNodeEnvironmentInputs(node, nodeInputs))
  };
}

export function orderedNodes(flow: FlowFile): FlowNode[] {
  if (!flow.edges?.length) return flow.nodes;
  if (flow.ui?.manualEdges) return flow.nodes;
  return linearOrderFromEdges(flow) ?? flow.nodes;
}

export function isCompleteLinearEdgeChain(flow: FlowFile): boolean {
  if (!flow.edges?.length) return true;
  if (flow.ui?.manualEdges) return false;
  return Boolean(linearOrderFromEdges(flow));
}

function linearOrderFromEdges(flow: FlowFile): FlowNode[] | undefined {
  if (!flow.edges?.length) return flow.nodes;
  if (flow.nodes.length <= 1) return flow.nodes;
  if (flow.edges.length !== flow.nodes.length - 1) return undefined;
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string>();
  const incoming = new Set<string>();
  for (const edge of flow.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) return undefined;
    if (outgoing.has(edge.from) || incoming.has(edge.to)) return undefined;
    outgoing.set(edge.from, edge.to);
    incoming.add(edge.to);
  }

  const starts = flow.nodes.filter((node) => !incoming.has(node.id));
  if (starts.length !== 1) return undefined;

  const ordered: FlowNode[] = [];
  const seen = new Set<string>();
  let current: FlowNode | undefined = starts[0];
  while (current && !seen.has(current.id)) {
    ordered.push(current);
    seen.add(current.id);
    const nextId = outgoing.get(current.id);
    current = nextId ? byId.get(nextId) : undefined;
  }

  return seen.size === flow.nodes.length ? ordered : undefined;
}

function compileNode(node: FlowNode | FlowActionNode, postActionOf?: FlowApiOperationNode): ScenarioStep {
  if (node.type === "api_operation") {
    return cleanStep({
      id: node.id,
      action: node.operation,
      via: "api",
      input: node.input ?? node.params,
      request: node.request,
      assertions: node.assertions,
      capture: node.capture,
      continueOnFailure: node.continueOnFailure,
      expectedOutcome: node.expectedOutcome,
      captureOnFailure: node.captureOnFailure
    });
  }

  if (node.type === "db_query" || node.type === "db_assert" || node.type === "db_execute") {
    return cleanStep({
      id: node.id,
      action: node.type,
      via: "db",
      query: node.query,
      params: node.params ?? node.input,
      assertions: node.assertions,
      capture: node.capture,
      continueOnFailure: node.continueOnFailure,
      expectedOutcome: node.expectedOutcome,
      captureOnFailure: node.captureOnFailure
    });
  }

  if (node.type === "unix_batch") {
    return cleanStep({
      id: node.id,
      action: "unix_batch",
      via: "unix",
      batch: node.batch,
      params: node.params ?? node.input,
      retry: node.retry,
      assertions: node.assertions,
      capture: node.capture,
      continueOnFailure: node.continueOnFailure,
      expectedOutcome: node.expectedOutcome,
      captureOnFailure: node.captureOnFailure
    });
  }

  if (node.type === "parallel") {
    return cleanStep({
      id: node.id,
      action: "__parallel",
      via: "control",
      control: "parallel",
      join: node.join ?? "all",
      continueOnFailure: node.continueOnFailure,
      branches: node.branches.map((branch) => ({
        id: branch.id,
        label: branch.label,
        steps: branch.nodes.filter((child) => !child.disabled).map((child) => compileNode(child))
      }))
    });
  }

  if (node.type === "loop") {
    return cleanStep({
      id: node.id,
      action: "__loop",
      via: "control",
      control: "loop",
      loop: node.loop,
      continueOnFailure: node.continueOnFailure,
      steps: node.nodes.filter((child) => !child.disabled).map((child) => compileNode(child))
    });
  }

  const unsupported = node as { type?: string };
  throw new Error(`Unsupported flow node type '${unsupported.type ?? "unknown"}'${postActionOf ? ` after '${postActionOf.id}'` : ""}.`);
}

function applyNodeEnvironmentInputs(node: FlowNode, nodeInputs: Record<string, Record<string, unknown>>): FlowNode {
  if (node.type === "api_operation") {
    const overrides = nodeInputs[node.id];
    return {
      ...node,
      input: mergeRecords(node.input ?? node.params, overrides),
      postActions: node.postActions?.map((action) => applyActionEnvironmentInputs(action, nodeInputs))
    };
  }
  if (node.type === "parallel") {
    return {
      ...node,
      branches: node.branches.map((branch) => ({
        ...branch,
        nodes: branch.nodes.map((child) => applyNodeEnvironmentInputs(child, nodeInputs))
      }))
    };
  }
  if (node.type === "loop") {
    return {
      ...node,
      nodes: node.nodes.map((child) => applyNodeEnvironmentInputs(child, nodeInputs))
    };
  }
  return applyActionEnvironmentInputs(node, nodeInputs);
}

function applyActionEnvironmentInputs(node: FlowActionNode, nodeInputs: Record<string, Record<string, unknown>>): FlowActionNode {
  const overrides = nodeInputs[node.id];
  if (!overrides) return node;
  return {
    ...node,
    params: mergeRecords(node.params ?? node.input, overrides)
  };
}

function mergeRecords(base?: Record<string, unknown>, overrides?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!base && !overrides) return undefined;
  return {
    ...(base ?? {}),
    ...(overrides ?? {})
  };
}

function cleanStep(step: ScenarioStep): ScenarioStep {
  return Object.fromEntries(Object.entries(step).filter(([, value]) => value !== undefined)) as ScenarioStep;
}

export function flowNodeOutputPrefix(id: string): string {
  return `${id}.`;
}

export function nodeTypeLabel(type: FlowNodeType): string {
  return type.replace(/_/g, " ");
}

function appendControlStepMap(node: FlowNode, stepMap: CompiledFlow["stepMap"]): void {
  if (node.type === "parallel") {
    for (const branch of node.branches) {
      for (const child of branch.nodes) {
        if (child.disabled) continue;
        stepMap.push({ flowNodeId: child.id, scenarioStepId: child.id, type: child.type });
        appendControlStepMap(child, stepMap);
      }
    }
  }
  if (node.type === "loop") {
    for (const child of node.nodes) {
      if (child.disabled) continue;
      stepMap.push({ flowNodeId: child.id, scenarioStepId: child.id, type: child.type });
      appendControlStepMap(child, stepMap);
    }
  }
}
