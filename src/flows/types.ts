import type { ApiAssertion, ApiRequestSpec, ExpectedOutcome, LoopSpec, ParallelJoinMode, Scenario, ScenarioStep } from "../dsl/types.js";

export type FlowNodeType = "api_operation" | "db_query" | "db_assert" | "db_execute" | "unix_batch" | "parallel" | "loop";

export interface FlowFile {
  version: 1;
  id: string;
  name?: string;
  environment: string;
  variables?: Record<string, unknown>;
  environmentInputs?: Record<string, FlowEnvironmentInputSet>;
  nodes: FlowNode[];
  edges?: FlowEdge[];
  ui?: FlowUi;
}

export interface FlowUi {
  positions?: Record<string, FlowPosition>;
  manualEdges?: boolean;
}

export interface FlowPosition {
  x: number;
  y: number;
}

export interface FlowEnvironmentInputSet {
  variables?: Record<string, unknown>;
  nodes?: Record<string, Record<string, unknown>>;
}

export interface FlowEdge {
  from: string;
  to: string;
}

export type FlowNode = FlowApiOperationNode | FlowActionNode | FlowParallelNode | FlowLoopNode;

export interface FlowBaseNode {
  id: string;
  label?: string;
  type: FlowNodeType;
  input?: Record<string, unknown>;
  params?: Record<string, unknown>;
  request?: ApiRequestSpec;
  assertions?: ApiAssertion[];
  capture?: Record<string, string>;
  continueOnFailure?: boolean;
  expectedOutcome?: ExpectedOutcome;
  captureOnFailure?: boolean;
  disabled?: boolean;
  section?: string;
}

export interface FlowApiOperationNode extends FlowBaseNode {
  type: "api_operation";
  operation: string;
  postActions?: FlowActionNode[];
}

export type FlowActionNode = FlowDbQueryNode | FlowDbAssertNode | FlowDbExecuteNode | FlowUnixBatchNode;
export type FlowExecutableNode = FlowApiOperationNode | FlowActionNode;

export interface FlowDbQueryNode extends FlowBaseNode {
  type: "db_query";
  query: string;
}

export interface FlowDbAssertNode extends FlowBaseNode {
  type: "db_assert";
  query: string;
}

export interface FlowDbExecuteNode extends FlowBaseNode {
  type: "db_execute";
  query: string;
}

export interface FlowUnixBatchNode extends FlowBaseNode {
  type: "unix_batch";
  batch: string;
  retry?: {
    attempts?: number;
    delaySeconds?: number;
  };
}

export interface FlowBranch {
  id: string;
  label?: string;
  nodes: FlowNode[];
}

export interface FlowParallelNode extends FlowBaseNode {
  type: "parallel";
  branches: FlowBranch[];
  join?: ParallelJoinMode;
}

export interface FlowLoopNode extends FlowBaseNode {
  type: "loop";
  loop: LoopSpec;
  nodes: FlowNode[];
}

export interface FlowValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface CompiledFlow {
  flow: FlowFile;
  scenario: Scenario;
  stepMap: Array<{
    flowNodeId: string;
    scenarioStepId: string;
    type: FlowNodeType;
    postActionOf?: string;
  }>;
}

export interface FlowCompileOptions {
  environment?: string;
}

export type FlowScenarioStep = ScenarioStep & {
  flowNodeId?: string;
  postActionOf?: string;
};
