import { useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  Background,
  BaseEdge,
  Connection,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  FileCheck,
  FolderOpen,
  History,
  Maximize2,
  Minimize2,
  Play,
  Plus,
  Save,
  Search,
  Server,
  Settings,
  TerminalSquare,
  Trash2,
  Upload,
  X
} from "lucide-react";

type NodeType = "api_operation" | "db_query" | "db_assert" | "db_execute" | "unix_batch" | "parallel" | "loop";
type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
type ApiBodyMode = "none" | "json" | "raw" | "formdata" | "urlencoded";
type ExpectedOutcome = "positive" | "negative" | "setup" | "teardown";
type EvidenceVisibilityMode = "raw" | "redacted";
type LoopDateFormat = "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";
type LoopDateAdvanceMode = "days" | "months" | "nth_day_of_month" | "first_of_month" | "end_of_month";

interface ApiRequestSpec {
  method?: ApiMethod;
  path?: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  rawBody?: string;
  bodyMode?: ApiBodyMode;
  auth?: unknown;
  acceptStatuses?: number[];
}

type ApiAssertion =
  | { type: "status"; operator?: "in" | "="; value: number | number[] }
  | { type: "jsonpath_exists"; path: string }
  | { type: "jsonpath_equals"; path: string; value: unknown }
  | { type: "jsonpath_contains"; path: string; value: unknown }
  | { type: "header_exists"; header: string }
  | { type: "header_equals"; header: string; value: string }
  | { type: "body_contains"; value: string }
  | { type: "body_not_contains"; value: string };

interface FlowNode {
  id: string;
  label?: string;
  type: NodeType;
  operation?: string;
  query?: string;
  batch?: string;
  retry?: {
    attempts?: number;
    delaySeconds?: number;
  };
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
  postActions?: FlowNode[];
  branches?: FlowBranch[];
  join?: "all" | "any" | "fail_fast";
  loop?: LoopSpec;
  nodes?: FlowNode[];
}

interface FlowBranch {
  id: string;
  label?: string;
  nodes: FlowNode[];
}

interface LoopSpec {
  mode: "count" | "foreach";
  count?: number | string;
  items?: unknown;
  itemName?: string;
  maxIterations?: number;
  dateCursor?: LoopDateCursor;
}

interface LoopDateCursor {
  outputName?: string;
  start?: string;
  inputFormat?: LoopDateFormat;
  outputFormat?: LoopDateFormat;
  advance?: {
    mode: LoopDateAdvanceMode;
    amount?: number;
    day?: number;
  };
}

interface FlowFile {
  version: 1;
  id: string;
  name?: string;
  environment: string;
  variables?: Record<string, unknown>;
  environmentInputs?: Record<string, FlowEnvironmentInputSet>;
  nodes: FlowNode[];
  edges?: Array<{ from: string; to: string }>;
  ui?: {
    positions?: Record<string, { x: number; y: number }>;
    manualEdges?: boolean;
  };
}

interface FlowEnvironmentInputSet {
  variables?: Record<string, unknown>;
  nodes?: Record<string, Record<string, unknown>>;
}

interface Catalogs {
  apiOperations: Record<string, ApiOperationEntry>;
  queries: Record<string, QueryCatalogEntry>;
  batches: Record<string, BatchCatalogEntry>;
}

type CatalogParamType = "string" | "number" | "boolean" | "string[]" | "number[]" | "boolean[]";

interface CatalogParamSpec {
  required?: boolean;
  type?: CatalogParamType;
  pattern?: string;
  luhn?: boolean;
}

interface QueryExpectationSpec {
  type: "number" | "string" | "boolean" | "rowCount";
  column?: string;
  operator: "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains";
  value: unknown;
}

interface QueryCatalogEntry {
  description?: string;
  mode?: "query" | "execute";
  sql: string;
  params?: Record<string, CatalogParamSpec>;
  expect?: QueryExpectationSpec;
  captures?: Record<string, string>;
  maxRows?: number;
}

interface BatchCatalogEntry {
  description?: string;
  hostRef: string;
  command: string;
  fixedArgs?: Array<string | number | boolean>;
  workingDirectory?: string;
  useWorkingDirectory?: boolean;
  environment?: Record<string, string | number | boolean>;
  args?: Array<CatalogParamSpec & { name: string }>;
  inputFiles?: BatchInputFileSpec[];
  outputFiles?: BatchOutputFileSpec[];
  timeoutSeconds?: number;
  success?: {
    exitCodes?: number[];
    requiredOutput?: string[];
  };
  captures?: Record<string, string>;
}

interface BatchInputFileSpec {
  name: string;
  required?: boolean;
  remotePath?: string;
  paramName?: string;
  appendAsArg?: boolean;
}

interface BatchOutputFileSpec {
  name: string;
  required?: boolean;
  source?: "stdout" | "stderr" | "both" | "explicit";
  pathPattern?: string;
  remotePath?: string;
  download?: boolean;
  decrypt?: {
    command?: string;
    outputRemotePath?: string;
    required?: boolean;
  };
}

interface BatchInputFileValue {
  fileName?: string;
  localPath?: string;
  remotePath?: string;
  sizeBytes?: number;
}

interface ApiOperationEntry extends ApiRequestSpec {
  description?: string;
  type: "rest" | "soap";
  requestTemplate?: string;
  captures?: Record<string, string>;
  params?: Record<string, { required?: boolean; type?: string }>;
  assertions?: ApiAssertion[];
  source?: {
    collectionId?: string;
    collectionName?: string;
    requestId?: string;
    folderPath?: string[];
  };
}

interface ImportedApiCollection {
  id: string;
  name: string;
  importedAt: string;
  variables?: Record<string, unknown>;
  requestCount: number;
  requests: ImportedApiRequest[];
}

interface ImportedApiRequest {
  id: string;
  name: string;
  folderPath: string[];
  operationKey: string;
  description?: string;
  request: ApiRequestSpec;
  variables?: Record<string, unknown>;
  variableNames: string[];
}

interface FlowListItem {
  id: string;
  name?: string;
  environment: string;
}

interface EnvironmentRecord {
  name: string;
  apiBaseUrl?: string;
  apiTlsInsecure?: boolean;
  oracle?: {
    user?: string;
    password?: string;
    connectString?: string;
  };
  sshHosts?: Record<string, {
    host?: string;
    username?: string;
    password?: string;
    privateKeyPath?: string;
    shell?: string;
    loginShell?: boolean;
  }>;
}

interface RunState {
  id: string;
  flowId: string;
  status: "running" | "stopping" | "passed" | "failed" | "cancelled";
  startedAt?: string;
  endedAt?: string;
  evidenceDir?: string;
  error?: string;
  currentStepId?: string;
  currentStepStartedAt?: string;
  updatedAt?: string;
  result?: { steps?: RunStepResult[] };
}

interface RunStepResult {
  stepId: string;
  status: string;
  captures?: Record<string, unknown>;
  error?: { message: string; rawOutput?: string };
  api?: ApiStepEvidence;
  unix?: UnixStepEvidence;
}

interface ApiStepEvidence {
  visibility: EvidenceVisibilityMode;
  expectedOutcome: ExpectedOutcome;
  acceptStatuses: number[];
  statusAccepted: boolean;
  request?: ApiRequestEvidence;
  resolvedRequest?: ApiRequestEvidence;
  response?: ApiResponseEvidence;
  transportError?: { kind: string; message: string; code?: string; retryable?: boolean };
  assertionResults: Array<{ assertion: ApiAssertion; passed: boolean; expected?: unknown; actual?: unknown; message?: string }>;
  evidenceCaptures: Array<{ name: string; expression: string; required: boolean; status: string; published: boolean; value?: unknown; message?: string }>;
  publishedCaptures: Record<string, unknown>;
  finalStatus: "passed" | "failed";
  failureReason?: string;
}

interface ApiRequestEvidence {
  method?: ApiMethod;
  path?: string;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  auth?: unknown;
  body?: unknown;
}

interface ApiResponseEvidence {
  status: number;
  statusText: string;
  headers: Record<string, unknown>;
  body?: unknown;
  bodyText?: string;
  bodyJson?: unknown;
  contentType?: string;
  durationMs: number;
  sizeBytes: number;
  bodyTruncated?: boolean;
  bodyPreviewKind: "json" | "text" | "binary" | "empty";
}

interface UnixAttemptEvidence {
  attempt: number;
  startedAt: string;
  endedAt: string;
  command: string;
  displayCommand?: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  tracePath?: string;
  errno?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  status: "passed" | "failed";
  error?: string;
}

interface UnixStepEvidence {
  command: string;
  displayCommand?: string;
  status: "passed" | "failed";
  fileUploads?: Array<{
    name: string;
    fileName?: string;
    localPath?: string;
    remotePath: string;
    sizeBytes: number;
    paramName?: string;
    appendedAsArg?: boolean;
    status: "uploaded" | "failed";
    error?: string;
  }>;
  fileDownloads?: Array<{
    name: string;
    source?: "stdout" | "stderr" | "both" | "explicit";
    remotePath?: string;
    localPath?: string;
    sizeBytes?: number;
    status: "downloaded" | "failed" | "skipped";
    error?: string;
    decryptCommand?: string;
    decryptedRemotePath?: string;
    decryptExitCode?: number;
    decryptStdout?: string;
    decryptStderr?: string;
  }>;
  attempts: UnixAttemptEvidence[];
  stdout: string;
  stderr: string;
  exitCode?: number;
  tracePath?: string;
  errno?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

interface RunHistoryItem {
  runId: string;
  scenarioId: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  failedStep?: string;
  evidenceDir: string;
  reportPath?: string;
}

interface OutputReference {
  ref: string;
  label: string;
}

const emptyFlow = (): FlowFile => ({
  version: 1,
  id: "new_flow",
  name: "New flow",
  environment: "local",
  variables: {},
  nodes: [],
  edges: []
});

const apiTabs = ["Request", "Headers", "Query", "Body", "Auth", "Captures", "Assertions"] as const;
type ApiTab = typeof apiTabs[number];
const panelTabs = ["Edit", "Inputs", "Captures", "Assertions", "Run"] as const;
type PanelTab = typeof panelTabs[number];
type ValidationState = { ok?: boolean; errors?: string[]; warnings?: string[] };
const typesWithoutAssertions: ReadonlySet<NodeType> = new Set(["unix_batch"]);
const quickApiStorageKey = "adfinem-workbench.quick-api-operations";
let graphElkPromise: Promise<any> | undefined;
const workflowGraphNodeWidth = 280;
const workflowGraphNodeHeight = 104;
const workflowInsertNodeWidth = 136;
const workflowInsertNodeHeight = 30;
const workflowJoinNodeWidth = 116;
const workflowJoinNodeHeight = 30;

type InsertDropPayload =
  | { kind: "api-request"; request: ImportedApiRequest }
  | { kind: "api-operation"; operation: string }
  | { kind: "api-collection"; collectionId: string }
  | { kind: "db-template-picker"; type: "db_query" | "db_execute" }
  | { kind: "db-template"; type: "db_query" | "db_execute"; query: string }
  | { kind: "unix-batch-picker" }
  | { kind: "unix-batch"; batch: string }
  | { kind: "reusable-flow"; flowId: string }
  | { kind: "control"; control: "parallel" | "loop-count" | "loop-foreach" };

type DbTemplatePickerState = {
  type: "db_query" | "db_execute";
  insertIndex?: number;
};

type BatchTemplatePickerState = {
  insertIndex?: number;
};

type RepeatRangeTarget = {
  id: string;
  label: string;
};

export function App() {
  const [catalogs, setCatalogs] = useState<Catalogs | undefined>();
  const [collections, setCollections] = useState<ImportedApiCollection[]>([]);
  const [flows, setFlows] = useState<FlowListItem[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentRecord[]>([]);
  const [flow, setFlow] = useState<FlowFile>(emptyFlow());
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [message, setMessage] = useState("");
  const [validation, setValidation] = useState<ValidationState>();
  const [run, setRun] = useState<RunState | undefined>();
  const [runHistory, setRunHistory] = useState<RunHistoryItem[]>([]);
  const [showEnvironmentManager, setShowEnvironmentManager] = useState(false);
  const [showDbQueryManager, setShowDbQueryManager] = useState(false);
  const [showUnixBatchManager, setShowUnixBatchManager] = useState(false);
  const [selectedBatches, setSelectedBatches] = useState<Record<string, boolean>>({});
  const [selectedCollection, setSelectedCollection] = useState<ImportedApiCollection | undefined>();
  const [dbTemplatePicker, setDbTemplatePicker] = useState<DbTemplatePickerState | undefined>();
  const [batchTemplatePicker, setBatchTemplatePicker] = useState<BatchTemplatePickerState | undefined>();
  const [collectionSearch, setCollectionSearch] = useState("");
  const [selectedRequests, setSelectedRequests] = useState<Record<string, boolean>>({});
  const [insertIndex, setInsertIndex] = useState<number | undefined>();
  const [apiTab, setApiTab] = useState<ApiTab>("Request");
  const [quickApiKeys, setQuickApiKeys] = useState<string[]>(() => loadQuickApiKeys());
  const [flowEditorFullscreen, setFlowEditorFullscreen] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!run || run.status !== "running") return;
    const timer = window.setInterval(async () => {
      const next = await api<RunState>(`/api/runs/${run.id}`);
      setRun(next);
      if (next.status !== "running" && next.status !== "stopping") {
        if (next.status === "passed") setMessage("");
        void refreshRunHistory(flow.id);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [run, flow.id]);

  const selected = useMemo(() => findNode(flow, selectedId), [flow, selectedId]);
  const outputs = useMemo(() => outputReferencesForSelection(flow, selectedId, catalogs), [flow, selectedId, catalogs]);
  const selectedLoopAncestors = useMemo(() => selectedId ? loopAncestorIds(flow.nodes, selectedId) : [], [flow.nodes, selectedId]);
  const selectedParentLoop = useMemo(() => {
    const id = selectedLoopAncestors[selectedLoopAncestors.length - 1];
    const node = findNode(flow, id);
    return node?.type === "loop" ? node : undefined;
  }, [flow, selectedLoopAncestors]);
  const selectedRepeatRangeTargets = useMemo(() => repeatRangeTargets(flow, selectedId), [flow, selectedId]);
  const apiOperations = useMemo(() => catalogs?.apiOperations ?? {}, [catalogs]);
  const staticApiKeys = useMemo(() => Object.entries(apiOperations)
    .filter(([, operation]) => !operation.source?.collectionId)
    .map(([key]) => key), [apiOperations]);
  const quickApiSet = useMemo(() => new Set(quickApiKeys), [quickApiKeys]);
  const validQuickApiKeys = useMemo(() => quickApiKeys.filter((key) => apiOperations[key]), [quickApiKeys, apiOperations]);
  const availableQuickApiKeys = useMemo(() => staticApiKeys.filter((key) => !quickApiSet.has(key)), [staticApiKeys, quickApiSet]);
  const batchKeys = useMemo(() => Object.keys(catalogs?.batches ?? {}), [catalogs]);
  const selectedBatchKeys = useMemo(() => batchKeys.filter((batch) => selectedBatches[batch]), [batchKeys, selectedBatches]);

  useEffect(() => {
    if (selected?.type === "api_operation") setApiTab("Request");
  }, [selected?.id, selected?.type]);

  useEffect(() => {
    if (quickApiKeys.length === 0 && staticApiKeys.length > 0 && !window.localStorage.getItem(quickApiStorageKey)) {
      setQuickApiKeys(staticApiKeys.slice(0, 4));
    }
  }, [quickApiKeys.length, staticApiKeys]);

  useEffect(() => {
    window.localStorage.setItem(quickApiStorageKey, JSON.stringify(quickApiKeys));
  }, [quickApiKeys]);

  async function refresh(loadFirstFlow = true) {
    const [catalogResponse, flowResponse, environmentResponse, collectionResponse] = await Promise.all([
      api<Catalogs>("/api/catalogs"),
      api<{ flows: FlowListItem[] }>("/api/flows"),
      api<{ environments: EnvironmentRecord[] }>("/api/environments"),
      api<{ collections: ImportedApiCollection[] }>("/api/api-collections")
    ]);
    setCatalogs(catalogResponse);
    setFlows(flowResponse.flows);
    setEnvironments(environmentResponse.environments);
    setCollections(collectionResponse.collections);
    if (loadFirstFlow && flowResponse.flows[0]) await loadFlow(flowResponse.flows[0].id);
    else await refreshRunHistory(flow.id);
  }

  async function refreshFlowList() {
    const flowResponse = await api<{ flows: FlowListItem[] }>("/api/flows");
    setFlows(flowResponse.flows);
  }

  async function refreshCollections() {
    const [catalogResponse, collectionResponse] = await Promise.all([
      api<Catalogs>("/api/catalogs"),
      api<{ collections: ImportedApiCollection[] }>("/api/api-collections")
    ]);
    setCatalogs(catalogResponse);
    setCollections(collectionResponse.collections);
  }

  function setDbQueries(queries: Record<string, QueryCatalogEntry>) {
    setCatalogs((current) => current ? { ...current, queries } : current);
  }

  async function saveDbQuery(currentId: string | undefined, id: string, query: QueryCatalogEntry) {
    const response = await api<{ id: string; query: QueryCatalogEntry; queries: Record<string, QueryCatalogEntry> }>(
      currentId ? `/api/db-queries/${encodeURIComponent(currentId)}` : "/api/db-queries",
      { method: currentId ? "PUT" : "POST", body: { id, query } }
    );
    setDbQueries(response.queries);
    setMessage(`Saved DB ${response.query.mode === "execute" ? "execute" : "query"} ${response.id}`);
    return response;
  }

  async function saveUnixBatch(currentId: string | undefined, id: string, batch: BatchCatalogEntry) {
    const response = await api<{ id: string; batch: BatchCatalogEntry; batches: Record<string, BatchCatalogEntry> }>(
      currentId ? `/api/unix-batches/${encodeURIComponent(currentId)}` : "/api/unix-batches",
      { method: currentId ? "PUT" : "POST", body: { id, batch } }
    );
    setCatalogs((current) => current ? { ...current, batches: response.batches } : current);
    setMessage(`Saved Unix batch ${response.id}`);
    return response;
  }

  async function deleteUnixBatch(id: string) {
    const response = await api<{ batches: Record<string, BatchCatalogEntry> }>(`/api/unix-batches/${encodeURIComponent(id)}`, { method: "DELETE" });
    setCatalogs((current) => current ? { ...current, batches: response.batches } : current);
    setMessage(`Deleted Unix batch ${id}`);
    return response;
  }

  async function deleteDbQuery(id: string) {
    const response = await api<{ queries: Record<string, QueryCatalogEntry> }>(`/api/db-queries/${encodeURIComponent(id)}`, { method: "DELETE" });
    setDbQueries(response.queries);
    setMessage(`Deleted DB query ${id}`);
    return response;
  }

  async function refreshRunHistory(flowId = flow.id) {
    const response = await api<{ runs: RunHistoryItem[] }>(`/api/runs/history?flowId=${encodeURIComponent(flowId)}`);
    setRunHistory(response.runs);
  }

  async function loadFlow(id: string) {
    const response = await api<{ flow: FlowFile }>(`/api/flows/${encodeURIComponent(id)}`);
    setFlow(normalizeLoadedFlow(response.flow));
    setSelectedId(response.flow.nodes[0]?.id);
    setValidation(undefined);
    setRun(undefined);
    setMessage(`Loaded ${response.flow.id}`);
    await refreshRunHistory(response.flow.id);
  }

  async function saveFlow(): Promise<FlowFile> {
    try {
      const normalized = normalizeFlowForSave(flow, catalogs);
      const response = await api<{ flow: FlowFile; validation?: { ok: boolean; errors: string[]; warnings: string[] } }>(`/api/flows/${encodeURIComponent(normalized.id)}`, { method: "PUT", body: normalized });
      setFlow(normalizeLoadedFlow(response.flow));
      if (!findNode(response.flow, selectedId)) setSelectedId(response.flow.nodes[0]?.id);
      if (response.validation) setValidation(response.validation);
      await refreshFlowList();
      setMessage(`Saved ${response.flow.id}`);
      return response.flow;
    } catch (error) {
      const payload = apiErrorPayload(error);
      const serverValidation = validationFromPayload(payload);
      if (serverValidation) setValidation(serverValidation);
      setMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function validateCurrentFlow() {
    const saved = await saveFlow();
    const response = await api<{ ok: boolean; errors: string[]; warnings: string[] }>(`/api/flows/${encodeURIComponent(saved.id)}/validate`, { method: "POST" });
    setValidation(response);
    setMessage(response.ok ? "Flow is valid" : "Flow needs fixes");
  }

  function applyValidationReferenceFixes() {
    const fixes = staleReferenceFixes(validation);
    if (!fixes.length) return;
    setFlow((current) => applyReferenceFixes(current, fixes));
    setValidation(undefined);
    setMessage(`Updated ${fixes.length} stale reference${fixes.length === 1 ? "" : "s"}. Save or run to validate again.`);
  }

  async function runFlow(dryRun: boolean, startFrom?: string, runScope: "from" | "only" = "from") {
    let saved: FlowFile;
    try {
      saved = await saveFlow();
    } catch {
      setMessage("Run blocked - fix validation errors below to continue.");
      return;
    }
    const response = await api<{ runId: string; status: "running" }>(`/api/flows/${encodeURIComponent(saved.id)}/run`, { method: "POST", body: { env: saved.environment, dryRun, startFrom, runScope } });
    setRun({ id: response.runId, flowId: saved.id, status: response.status });
    setMessage("");
  }

  async function stopRun() {
    if (!run || (run.status !== "running" && run.status !== "stopping")) return;
    const response = await api<{ runId: string; status: RunState["status"] }>(`/api/runs/${encodeURIComponent(run.id)}/stop`, { method: "POST" });
    setRun((current) => current ? { ...current, status: response.status } : current);
    setMessage("Stop requested.");
  }

  async function deleteCurrentFlow(id: string) {
    const item = flows.find((entry) => entry.id === id);
    if (!window.confirm(`Delete workflow '${item?.name ?? id}'? This removes the flow YAML file.`)) return;
    const response = await api<{ flows: FlowListItem[] }>(`/api/flows/${encodeURIComponent(id)}`, { method: "DELETE" });
    setFlows(response.flows);
    if (flow.id === id) {
      if (response.flows[0]) await loadFlow(response.flows[0].id);
      else {
        setFlow(emptyFlow());
        setSelectedId(undefined);
        setRunHistory([]);
      }
    }
    setMessage(`Deleted workflow ${id}`);
  }

  async function importCollectionFile(file: File | undefined) {
    if (!file) return;
    const collection = JSON.parse(await file.text()) as unknown;
    const response = await api<{ collection: ImportedApiCollection; collections: ImportedApiCollection[] }>("/api/api-collections/import", {
      method: "POST",
      body: { collection }
    });
    setCollections(response.collections);
    await refreshCollections();
    setMessage(`Imported ${response.collection.name} (${response.collection.requestCount} requests)`);
  }

  async function importPostmanEnvironment(file: File | undefined) {
    if (!file) return;
    const environment = JSON.parse(await file.text()) as unknown;
    const response = await api<{ name: string; values: Record<string, unknown> }>("/api/postman-environments/import", {
      method: "POST",
      body: { environment }
    });
    updateEnvironmentVariables({ ...environmentVariables(flow, flow.environment), ...response.values });
    setMessage(`Imported ${Object.keys(response.values).length} variables from ${response.name}`);
  }

  async function saveEnvironment(currentName: string, next: EnvironmentRecord) {
    const response = await api<{ environments: EnvironmentRecord[]; environment: EnvironmentRecord }>(`/api/environments/${encodeURIComponent(currentName)}`, {
      method: "PUT",
      body: {
        name: next.name,
        config: environmentConfigForSave(next)
      }
    });
    setEnvironments(response.environments);
    updateFlow({ environment: response.environment.name });
    setMessage(`Saved environment ${response.environment.name}`);
  }

  function updateFlow(patch: Partial<FlowFile>) {
    setFlow((current) => {
      const next = { ...current, ...patch };
      if (patch.id !== undefined && patch.name === undefined && isDefaultFlowName(current.name) && patch.id !== "new_flow") {
        next.name = patch.id;
      }
      return rebuildEdges(next);
    });
  }

  function updateEnvironmentVariables(next: Record<string, unknown>) {
    setFlow((current) => updateFlowEnvironmentInputs(current, current.environment, { variables: stringifyRecord(next) }));
  }

  function updateEnvironmentNodeInputs(nodeId: string, next: Record<string, unknown>) {
    setFlow((current) => updateFlowEnvironmentNodeInputs(current, current.environment, nodeId, stringifyRecord(next)));
  }

  function updateNode(id: string, patch: Partial<FlowNode>) {
    setFlow((current) => rebuildEdges({
      ...current,
      nodes: current.nodes.map((node) => patchNodeDeep(node, id, patch))
    }));
  }

  function updateCanvasPosition(id: string, position: { x: number; y: number }) {
    setFlow((current) => ({
      ...current,
      ui: {
        ...(current.ui ?? {}),
        positions: {
          ...(current.ui?.positions ?? {}),
          [id]: position
        }
      }
    }));
  }

  function updateFlowEdges(edges: Array<{ from: string; to: string }>) {
    setFlow((current) => ({
      ...current,
      edges: uniqueGraphEdges(edges),
      ui: {
        ...(current.ui ?? {}),
        manualEdges: true
      }
    }));
  }

  function addAcceptedStatus(stepId: string, status: number) {
    const node = findNode(flow, stepId);
    if (!node || node.type !== "api_operation") return;
    const current = node.request?.acceptStatuses ?? [];
    const next = [...new Set([...current, status])].sort((a, b) => a - b);
    updateNode(stepId, { request: cleanRequest({ ...(node.request ?? {}), acceptStatuses: next }) });
    setMessage(`Added ${status} to Accepted statuses for ${node.label ?? node.id}`);
  }

  function insertNodes(nodes: FlowNode[], index = flow.nodes.length) {
    if (!nodes.length) return;
    setFlow((current) => {
      const safeIndex = Math.max(0, Math.min(index, current.nodes.length));
      return rebuildEdges({ ...current, nodes: [...current.nodes.slice(0, safeIndex), ...nodes, ...current.nodes.slice(safeIndex)] });
    });
    const selectedNode = nodes[nodes.length - 1];
    setSelectedId(selectedNode?.id);
    if (selectedNode?.type === "api_operation") setApiTab("Request");
  }

  function addNode(node: FlowNode, index?: number) {
    insertNodes([node], index ?? insertIndex ?? flow.nodes.length);
    setInsertIndex(undefined);
  }

  function addDbTemplateStep(type: "db_query" | "db_execute", query: string, index?: number) {
    addNode(queryNode(type, query, catalogs), index);
    setDbTemplatePicker(undefined);
  }

  function addBatchTemplateStep(batch: string, index?: number) {
    addBatchTemplateSteps([batch], index);
  }

  function addBatchTemplateSteps(batches: string[], index?: number) {
    const nodes = batches.map((batch) => batchNode(batch, catalogs));
    insertNodes(nodes, index ?? insertIndex ?? flow.nodes.length);
    setBatchTemplatePicker(undefined);
    setInsertIndex(undefined);
  }

  function addSelectedBatchNodes(index?: number) {
    const nodes = selectedBatchKeys.map((batch) => batchNode(batch, catalogs));
    insertNodes(nodes, index ?? insertIndex ?? flow.nodes.length);
    setSelectedBatches({});
    setInsertIndex(undefined);
  }

  function addPostAction(parentId: string, action: FlowNode) {
    setFlow((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === parentId ? { ...node, postActions: [...(node.postActions ?? []), action] } : node)
    }));
    setSelectedId(action.id);
  }

  function wrapNodeInLoop(id: string, mode: "count" | "foreach") {
    const ancestors = loopAncestorIds(flow.nodes, id);
    if (ancestors.length > 0) {
      setMessage(`Step '${id}' is already inside loop '${ancestors[ancestors.length - 1]}'. Select that loop to change count/items or unwrap it first.`);
      return;
    }
    const wrapper = loopNode(mode);
    setFlow((current) => {
      const result = wrapNodeInLoopDeep(current.nodes, id, wrapper);
      if (!result.wrapped) return current;
      return rebuildEdges({
        ...current,
        nodes: result.nodes,
        edges: current.edges ? remapEdgesForWrappedNode(current.edges, id, wrapper.id) : undefined,
        ui: {
          ...(current.ui ?? {}),
          positions: {
            ...(current.ui?.positions ?? {}),
            [wrapper.id]: current.ui?.positions?.[id] ?? current.ui?.positions?.[wrapper.id] ?? { x: 0, y: 0 }
          }
        }
      });
    });
    setSelectedId(id);
    setMessage(`Added ${mode === "count" ? "fixed-count" : "foreach"} repeat settings to the selected step.`);
  }

  function wrapRangeInLoop(startId: string, endId: string, mode: "count" | "foreach") {
    const wrapper = loopNode(mode);
    const result = wrapTopLevelRangeInLoop(flow.nodes, startId, endId, wrapper);
    if (!result.wrapped) {
      setMessage("Choose a downstream top-level step in the same workflow section to create a repeat range.");
      return;
    }
    const startPosition = flow.ui?.positions?.[startId];
    setFlow((current) => rebuildEdges({
      ...current,
      nodes: result.nodes,
      edges: current.edges ? remapEdgesForWrappedRange(current.edges, result.wrappedIds, wrapper.id) : undefined,
      ui: {
        ...(current.ui ?? {}),
        positions: {
          ...(current.ui?.positions ?? {}),
          [wrapper.id]: startPosition ?? current.ui?.positions?.[wrapper.id] ?? { x: 0, y: 0 }
        }
      }
    }));
    setSelectedId(startId);
    setMessage(`Added ${mode === "count" ? "fixed-count" : "foreach"} repeat settings to ${result.count} steps.`);
  }

  function unwrapLoop(id: string) {
    const result = unwrapLoopDeep(flow.nodes, id);
    if (!result.unwrapped) return;
    setFlow((current) => rebuildEdges({ ...current, nodes: result.nodes, edges: undefined }));
    setSelectedId(result.selectId);
    setMessage(`Unwrapped loop ${id}; child steps remain in the workflow.`);
  }

  function removeNode(id: string) {
    setFlow((current) => rebuildEdges({
      ...current,
      nodes: removeNodeDeep(current.nodes, id)
    }));
    setSelectedId(undefined);
  }

  function duplicateNode(id: string) {
    const result = duplicateNodeDeep(flow.nodes, id);
    if (!result.copiedId) return;
    setFlow((current) => rebuildEdges({ ...current, nodes: result.nodes }));
    setSelectedId(result.copiedId);
  }

  function moveNode(id: string, direction: -1 | 1) {
    setFlow((current) => {
      const result = moveNodeDeep(current.nodes, id, direction);
      return result.moved ? rebuildEdges({ ...current, nodes: result.nodes }) : current;
    });
  }

  function addReusableFlow(source: FlowListItem, index = flow.nodes.length) {
    void api<{ flow: FlowFile }>(`/api/flows/${encodeURIComponent(source.id)}`).then((response) => {
      const section = `Subflow: ${source.name ?? source.id}`;
      const nodes = response.flow.nodes.map((node) => {
        const clone = cloneNodeWithFreshIds(node, response.flow.id);
        return {
          ...clone,
          section: clone.section ?? section,
          postActions: clone.postActions?.map((action) => ({ ...action, section: action.section ?? section }))
        };
      });
      insertNodes(nodes, index);
      setMessage(`Added reusable flow block ${source.name ?? source.id}`);
    });
  }

  function openCollection(collection: ImportedApiCollection, index = insertIndex ?? flow.nodes.length) {
    setSelectedCollection(collection);
    setInsertIndex(index);
    setSelectedRequests({});
    setCollectionSearch("");
  }

  function addCollectionRequests(requests: ImportedApiRequest[]) {
    addCollectionRequestsAt(requests, insertIndex ?? flow.nodes.length);
  }

  function addCollectionRequestsAt(requests: ImportedApiRequest[], index: number) {
    const nodes = requests.map((request) => apiOperationNodeFromImportedRequest(request));
    insertNodes(nodes, index);
    setSelectedCollection(undefined);
    setSelectedRequests({});
    setInsertIndex(undefined);
  }

  function addQuickApi(operation: string) {
    if (!operation || quickApiKeys.includes(operation)) return;
    setQuickApiKeys((current) => [...current, operation]);
  }

  function removeQuickApi(operation: string) {
    setQuickApiKeys((current) => current.filter((key) => key !== operation));
  }

  function openAddStepPanel(index: number) {
    setInsertIndex(index);
    setSelectedId(undefined);
    setSelectedCollection(undefined);
    setMessage("");
  }

  function handleInsertDrop(event: React.DragEvent, index: number) {
    const payload = readInsertDropPayload(event);
    if (!payload) return;
    event.preventDefault();
    if (payload.kind === "api-request") {
      addCollectionRequestsAt([payload.request], index);
      return;
    }
    if (payload.kind === "api-operation") {
      addNode(apiOperationNode(payload.operation, apiOperations[payload.operation]), index);
      return;
    }
    if (payload.kind === "api-collection") {
      const collection = collections.find((item) => item.id === payload.collectionId);
      if (collection) openCollection(collection, index);
      return;
    }
    if (payload.kind === "db-template-picker") {
      setDbTemplatePicker({ type: payload.type, insertIndex: index });
      return;
    }
    if (payload.kind === "db-template") {
      addDbTemplateStep(payload.type, payload.query, index);
      return;
    }
    if (payload.kind === "unix-batch-picker") {
      setBatchTemplatePicker({ insertIndex: index });
      return;
    }
    if (payload.kind === "unix-batch") {
      addNode(batchNode(payload.batch, catalogs), index);
      return;
    }
    if (payload.kind === "reusable-flow") {
      const reusable = flows.find((item) => item.id === payload.flowId);
      if (reusable) addReusableFlow(reusable, index);
      return;
    }
    if (payload.kind === "control") {
      const node = payload.control === "parallel"
        ? parallelNode()
        : loopNode(payload.control === "loop-count" ? "count" : "foreach");
      addNode(node, index);
    }
  }

  const selectedCollectionRequests = selectedCollection?.requests.filter((request) => {
    const haystack = `${request.name} ${request.folderPath.join(" ")} ${request.request.method ?? ""} ${request.request.path ?? ""}`.toLowerCase();
    return haystack.includes(collectionSearch.toLowerCase());
  }) ?? [];

  return (
    <div className="workbench-shell">
      <aside className="project-explorer">
        <div className="brand">
          <div className="mark">P</div>
          <div>
            <h1>Adfinem Workbench</h1>
            <p>API, DB, Unix workflow tests</p>
          </div>
        </div>

        <ExplorerSection title="Flows">
          <button className="tool-button" onClick={() => { setFlow(emptyFlow()); setSelectedId(undefined); setRunHistory([]); }}>
            <Plus size={16} /> New workflow
          </button>
          <div className="item-list dense">
            {flows.map((item) => (
              <div key={item.id} className={`flow-row ${item.id === flow.id ? "selected" : ""}`}>
                <button onClick={() => void loadFlow(item.id)} title={item.id}>
                  <FileCheck size={15} />
                  <span className="flow-row-text">
                    <strong>{flowListTitle(item)}</strong>
                    {flowListSubtitle(item) && <small>{flowListSubtitle(item)}</small>}
                  </span>
                </button>
                <button className="icon-button danger-plain" title="Delete workflow" onClick={() => void deleteCurrentFlow(item.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </ExplorerSection>

        <ExplorerSection title="API Collections">
          <label className="upload-button">
            <Upload size={15} /> Import API request collection
            <input type="file" accept=".json,application/json" onChange={(event) => void importCollectionFile(event.target.files?.[0])} />
          </label>
          {collections.map((collection) => (
            <button
              key={collection.id}
              className="collection-card"
              draggable
              onDragStart={(event) => writeInsertDropPayload(event, { kind: "api-collection", collectionId: collection.id })}
              onClick={() => openCollection(collection)}
              title="Click to browse, or drag onto the canvas to choose an insert position."
            >
              <FolderOpen size={16} />
              <span>{collection.name}</span>
              <small>{collection.requestCount} requests</small>
            </button>
          ))}
        </ExplorerSection>

        <ExplorerSection title="DB / Unix Actions">
          <button onClick={() => setShowDbQueryManager(true)}>
            <Settings size={15} /> Manage DB queries
          </button>
          <button onClick={() => setShowUnixBatchManager(true)}>
            <Settings size={15} /> Manage Unix batches
          </button>
          <button
            draggable
            onDragStart={(event) => writeInsertDropPayload(event, { kind: "db-template-picker", type: "db_query" })}
            onClick={() => setDbTemplatePicker({ type: "db_query" })}
            title="Click to choose a DB query, or drag onto the canvas."
          >
            <Database size={15} /> Add DB query
          </button>
          <button
            draggable
            onDragStart={(event) => writeInsertDropPayload(event, { kind: "db-template-picker", type: "db_execute" })}
            onClick={() => setDbTemplatePicker({ type: "db_execute" })}
            title="Click to choose a DB execute template, or drag onto the canvas."
          >
            <Database size={15} /> Add DB execute
          </button>
          <button
            draggable
            onDragStart={(event) => writeInsertDropPayload(event, { kind: "unix-batch-picker" })}
            onClick={() => setBatchTemplatePicker({})}
            title="Choose the Unix batch template to add."
          >
            <TerminalSquare size={15} /> Add Unix batch
          </button>
          {batchKeys.length > 0 && (
            <div className="batch-picker">
              <div className="batch-picker-title">Batch templates</div>
              {batchKeys.map((batch) => (
                <label
                  className="batch-check"
                  key={batch}
                  draggable
                  onDragStart={(event) => writeInsertDropPayload(event, { kind: "unix-batch", batch })}
                  title={`${catalogs?.batches[batch]?.description ?? batch}. Drag onto the canvas to add this batch.`}
                >
                  <input
                    type="checkbox"
                    checked={Boolean(selectedBatches[batch])}
                    onChange={(event) => setSelectedBatches((current) => ({ ...current, [batch]: event.target.checked }))}
                  />
                  <span>{batch}</span>
                </label>
              ))}
              <button disabled={!selectedBatchKeys.length} onClick={() => addSelectedBatchNodes()}>
                <Plus size={15} /> Add selected batches
              </button>
            </div>
          )}
        </ExplorerSection>

        <ExplorerSection title="Reusable Flows">
          {flows.filter((item) => item.id !== flow.id).map((item) => (
            <button
              key={item.id}
              draggable
              onDragStart={(event) => writeInsertDropPayload(event, { kind: "reusable-flow", flowId: item.id })}
              onClick={() => addReusableFlow(item)}
              title="Click to append, or drag onto the canvas."
            >
              <Copy size={15} /> {item.name ?? item.id}
            </button>
          ))}
        </ExplorerSection>

        <ExplorerSection title="Recent Runs">
          <RunHistoryList runs={runHistory} />
        </ExplorerSection>
      </aside>

      <main className="workbench-main">
        <header className="topbar">
          <div className="flow-title">
            <input value={flow.name ?? ""} onChange={(event) => updateFlow({ name: event.target.value })} />
            <label>Flow ID <input className="flow-id-input" value={flow.id} onChange={(event) => updateFlow({ id: event.target.value })} /></label>
          </div>
          <div className="actions">
            <select className="env-select" value={flow.environment} onChange={(event) => updateFlow({ environment: event.target.value })}>
              {environmentOptions(environments, flow.environment).map((envName) => <option key={envName}>{envName}</option>)}
            </select>
            <label className="upload-button light">
              <Upload size={15} /> Import Postman env
              <input type="file" accept=".json,application/json" onChange={(event) => void importPostmanEnvironment(event.target.files?.[0])} />
            </label>
            <button onClick={() => setShowEnvironmentManager((current) => !current)}><Settings size={16} /> Environments</button>
            <button onClick={() => void saveFlow()}><Save size={16} /> Save</button>
            <button onClick={() => void validateCurrentFlow()}><FileCheck size={16} /> Validate</button>
            <button onClick={() => void runFlow(true)}>Dry run</button>
            <button className="primary" onClick={() => void runFlow(false)}><Play size={16} /> Run</button>
            {run && (run.status === "running" || run.status === "stopping") && (
              <button className="danger compact" onClick={() => void stopRun()}>Stop</button>
            )}
          </div>
        </header>

        {showEnvironmentManager && (
          <EnvironmentManager
            environments={environments}
            activeName={flow.environment}
            onSelect={(name) => updateFlow({ environment: name })}
            onSave={(currentName, next) => void saveEnvironment(currentName, next)}
            onClose={() => setShowEnvironmentManager(false)}
          />
        )}

        <FlowSettingsCard
          environmentName={flow.environment}
          variables={environmentVariables(flow, flow.environment)}
          onChange={updateEnvironmentVariables}
        />

        <div className="builder-layout">
          <WorkflowCanvas
            flow={flow}
            catalogs={catalogs}
            apiOperations={apiOperations}
            selectedId={selectedId}
            insertIndex={insertIndex}
            run={run}
            onSelect={setSelectedId}
            onInsert={openAddStepPanel}
            onDrop={handleInsertDrop}
            onMove={moveNode}
            onDuplicate={duplicateNode}
            onToggleDisabled={(id, disabled) => updateNode(id, { disabled })}
            onRemove={removeNode}
            onPositionChange={updateCanvasPosition}
            onEdgesChange={updateFlowEdges}
            fullscreen={flowEditorFullscreen}
            onFullscreenChange={setFlowEditorFullscreen}
          />

          <aside className="inspector">
            {insertIndex !== undefined ? (
              <AddStepPanel
                insertIndex={insertIndex}
                collections={collections}
                quickApiKeys={validQuickApiKeys}
                availableQuickApiKeys={availableQuickApiKeys}
                apiOperations={apiOperations}
                catalogs={catalogs}
                onClose={() => setInsertIndex(undefined)}
                onOpenCollection={(collection) => openCollection(collection, insertIndex)}
                onAddQuickApi={addQuickApi}
                onRemoveQuickApi={removeQuickApi}
                onAddApi={(operation) => addNode(apiOperationNode(operation, apiOperations[operation]), insertIndex)}
                onChooseDbTemplate={(type) => setDbTemplatePicker({ type, insertIndex })}
                onChooseBatchTemplate={() => setBatchTemplatePicker({ insertIndex })}
                onAddControl={(node) => addNode(node, insertIndex)}
              />
            ) : (
              <>
                {selected ? (
                  <NodeEditor
                    node={selected}
                    flowId={flow.id}
                    index={Math.max(0, flattenedTimeline(flow).findIndex((item) => item.node.id === selected.id))}
                    total={Math.max(1, flattenedTimeline(flow).length)}
                    catalogs={catalogs}
                    outputs={outputs}
                    apiTab={apiTab}
                    onApiTabChange={setApiTab}
                    onChange={(patch) => updateNode(selected.id, patch)}
                    onRemove={() => removeNode(selected.id)}
                    onDuplicate={() => duplicateNode(selected.id)}
                    onMove={(direction) => moveNode(selected.id, direction)}
                    onAddPostAction={(action) => addPostAction(selected.id, action)}
                    onWrapInLoop={(mode) => wrapNodeInLoop(selected.id, mode)}
                    onWrapRangeInLoop={(endId, mode) => wrapRangeInLoop(selected.id, endId, mode)}
                    repeatRangeTargets={selectedRepeatRangeTargets}
                    onUnwrapLoop={() => unwrapLoop(selected.id)}
                    parentLoop={selectedParentLoop}
                    onParentLoopChange={(patch) => {
                      if (selectedParentLoop) updateNode(selectedParentLoop.id, patch);
                    }}
                    onUnwrapParentLoop={() => {
                      if (selectedParentLoop) unwrapLoop(selectedParentLoop.id);
                    }}
                    loopAncestors={selectedLoopAncestors}
                    onSave={() => saveFlow()}
                    onRunFrom={(dryRun) => void runFlow(dryRun, selected.id)}
                    onRunOnly={(dryRun) => void runFlow(dryRun, selected.id, "only")}
                    environmentName={flow.environment}
                    environmentInput={environmentNodeInputs(flow, flow.environment, selected.id)}
                    onEnvironmentInputChange={(next) => updateEnvironmentNodeInputs(selected.id, next)}
                  />
                ) : (
                  <EmptyInspector />
                )}
              </>
            )}

            <ValidationPanel validation={validation} onApplyReferenceFixes={applyValidationReferenceFixes} />
            {message && <div className="message">{message}</div>}
          </aside>
        </div>
        <RunDock
          run={run}
          flowId={flow.id}
          flowNodes={flow.nodes}
          selectedId={selectedId}
          recentRun={runHistory[0]}
          onRerun={() => void runFlow(false)}
          onRerunFromFailure={(stepId) => void runFlow(false, stepId, "from")}
          onJumpToStep={setSelectedId}
          onAcceptStatus={(stepId, status) => addAcceptedStatus(stepId, status)}
        />
      </main>

      {showDbQueryManager && catalogs && (
        <DbQueryManager
          queries={catalogs.queries}
          onClose={() => setShowDbQueryManager(false)}
          onSave={(currentId, id, query) => saveDbQuery(currentId, id, query)}
          onDelete={(id) => deleteDbQuery(id)}
        />
      )}

      {showUnixBatchManager && catalogs && (
        <UnixBatchManager
          batches={catalogs.batches}
          onClose={() => setShowUnixBatchManager(false)}
          onSave={saveUnixBatch}
          onDelete={deleteUnixBatch}
        />
      )}

      {dbTemplatePicker && catalogs && (
        <DbTemplatePicker
          type={dbTemplatePicker.type}
          catalogs={catalogs}
          onClose={() => setDbTemplatePicker(undefined)}
          onManage={() => {
            setDbTemplatePicker(undefined);
            setShowDbQueryManager(true);
          }}
          onAdd={(query) => addDbTemplateStep(dbTemplatePicker.type, query, dbTemplatePicker.insertIndex)}
        />
      )}

      {batchTemplatePicker && catalogs && (
        <UnixBatchPicker
          catalogs={catalogs}
          onClose={() => setBatchTemplatePicker(undefined)}
          onManage={() => {
            setBatchTemplatePicker(undefined);
            setShowUnixBatchManager(true);
          }}
          onAdd={(batches) => addBatchTemplateSteps(batches, batchTemplatePicker.insertIndex)}
        />
      )}

      {selectedCollection && (
        <CollectionPicker
          collection={selectedCollection}
          requests={selectedCollectionRequests}
          selected={selectedRequests}
          search={collectionSearch}
          onSearch={setCollectionSearch}
          onToggle={(id, checked) => setSelectedRequests((current) => ({ ...current, [id]: checked }))}
          onAdd={(requests) => addCollectionRequests(requests)}
          onDragRequest={(event, request) => writeInsertDropPayload(event, { kind: "api-request", request })}
          onClose={() => setSelectedCollection(undefined)}
        />
      )}
    </div>
  );
}

function ExplorerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

interface WorkflowGraphModel {
  nodes: WorkflowGraphModelNode[];
  edges: WorkflowGraphModelEdge[];
}

interface WorkflowGraphModelNode {
  id: string;
  type: "workflow" | "insert" | "andJoin";
  width: number;
  height: number;
  data: Record<string, unknown>;
}

interface WorkflowGraphModelEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  className?: string;
  deletable?: boolean;
}

interface WorkflowCanvasProps {
  flow: FlowFile;
  catalogs?: Catalogs;
  apiOperations: Record<string, ApiOperationEntry>;
  selectedId?: string;
  insertIndex?: number;
  run?: RunState;
  onSelect: (id: string) => void;
  onInsert: (index: number) => void;
  onDrop: (event: React.DragEvent, index: number) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onDuplicate: (id: string) => void;
  onToggleDisabled: (id: string, disabled: boolean) => void;
  onRemove: (id: string) => void;
  onPositionChange: (id: string, position: { x: number; y: number }) => void;
  onEdgesChange: (edges: Array<{ from: string; to: string }>) => void;
  fullscreen: boolean;
  onFullscreenChange: (fullscreen: boolean) => void;
}

function WorkflowCanvas(props: WorkflowCanvasProps) {
  const { fullscreen, onFullscreenChange } = props;
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onFullscreenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, onFullscreenChange]);

  return (
    <section className={`workflow-canvas flow-canvas ${fullscreen ? "fullscreen" : ""}`}>
      <div className="canvas-toolbar">
        <div>
          <strong>Flow editor</strong>
          {fullscreen && <span>Esc exits full screen</span>}
        </div>
        <button
          className="icon-text-button"
          onClick={() => onFullscreenChange(!fullscreen)}
          title={fullscreen ? "Exit full screen" : "Full screen flow editor"}
        >
          {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          {fullscreen ? "Exit full screen" : "Full screen"}
        </button>
      </div>
      <ReactFlowProvider>
        <WorkflowCanvasInner {...props} />
      </ReactFlowProvider>
    </section>
  );
}

function WorkflowCanvasInner({
  flow,
  catalogs,
  apiOperations,
  selectedId,
  insertIndex,
  run,
  onSelect,
  onInsert,
  onDrop,
  onMove,
  onDuplicate,
  onToggleDisabled,
  onRemove,
  onPositionChange,
  onEdgesChange
}: WorkflowCanvasProps) {
  const reactFlow = useReactFlow();
  const visibleRunNodeIds = useMemo(() => allFlowNodes(flow.nodes).map((node) => node.id), [flow.nodes]);
  const runStatuses = useMemo(() => runStatusMap(run, visibleRunNodeIds), [run, visibleRunNodeIds]);
  const graphModel = useMemo(() => buildWorkflowGraphModel(flow), [flow]);
  const layoutKey = useMemo(() => graphLayoutKey(graphModel), [graphModel]);
  const [layout, setLayout] = useState<{ nodes: any[]; edges: any[] }>({ nodes: [], edges: [] });

  useEffect(() => {
    let cancelled = false;
    layoutWorkflowGraph(graphModel).then((next) => {
      if (!cancelled) setLayout(next);
    });
    return () => {
      cancelled = true;
    };
  }, [layoutKey]);

  useEffect(() => {
    if (!layout.nodes.length) return;
    const timer = window.setTimeout(() => reactFlow.fitView({ padding: 0.16, duration: 250, minZoom: 0.45, maxZoom: 1 }), 40);
    return () => window.clearTimeout(timer);
  }, [layoutKey, layout.nodes.length, reactFlow]);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<any>([]);
  const [rfEdges, setRfEdges, onRfEdgesChange] = useEdgesState<any>([]);

  const nodes = useMemo(() => layout.nodes.map((item) => {
    if (item.type === "sectionLane") return item;
    if (item.type === "insert") {
      return {
        ...item,
        data: {
          ...item.data,
          active: insertIndex === item.data.index,
          onInsert,
          onDrop
        }
      };
    }
    if (item.type === "andJoin") return item;

    const node = item.data.node as FlowNode;
    const savedPosition = flow.ui?.positions?.[node.id];
    return {
      ...item,
      position: savedPosition ?? item.position,
      selected: selectedId === node.id,
      data: {
        ...item.data,
        node,
        apiOperations,
        selected: selectedId === node.id,
        runStatus: runStatuses[node.id],
        missingInputs: missingInputNames(node, catalogs, environmentNodeInputs(flow, flow.environment, node.id)),
        isLast: item.data.topIndex === flow.nodes.length - 1,
        onSelect,
        onMove,
        onDuplicate,
        onToggleDisabled,
        onRemove
      }
    };
  }), [layout.nodes, insertIndex, onInsert, onDrop, selectedId, apiOperations, runStatuses, catalogs, flow, onSelect, onMove, onDuplicate, onToggleDisabled, onRemove]);

  const edges = useMemo(() => layout.edges.map((edge) => ({
    ...edge,
    animated: run?.status === "running" || run?.status === "stopping",
    data: {
      ...(edge.data ?? {}),
      deletable: Boolean(edge.deletable),
      onDelete: (edgeId: string) => deleteEdgeById(edgeId)
    }
  })), [layout.edges, run?.status]);

  useEffect(() => setRfNodes(nodes), [nodes, setRfNodes]);
  useEffect(() => setRfEdges(edges), [edges, setRfEdges]);

  function connectNodes(connection: Connection) {
    if (!connection.source || !connection.target || connection.source.startsWith("insert:") || connection.target.startsWith("insert:")) return;
    const next = uniqueGraphEdges([...currentWorkflowEdges(flow), { from: connection.source, to: connection.target }]);
    onEdgesChange(next);
    setRfEdges((current) => addEdge({
      ...connection,
      sourceHandle: "source-bottom",
      targetHandle: "target-top",
      id: `edge:${connection.source}:${connection.target}`,
      type: "editable",
      markerEnd: { type: MarkerType.ArrowClosed },
      deletable: true,
      selectable: true,
      data: { deletable: true, onDelete: (edgeId: string) => deleteEdgeById(edgeId) }
    }, current));
  }

  function deleteEdgeById(edgeId: string) {
    if (removeEdgesByIds([edgeId])) {
      setRfEdges((current) => current.filter((item) => item.id !== edgeId));
    }
  }

  function removeEdgesByIds(edgeIds: string[]): boolean {
    const removed = edgeIds
      .map(edgePairFromId)
      .filter((edge): edge is { from: string; to: string } => Boolean(edge));
    if (!removed.length) return false;
    const removedKeys = new Set(removed.map((edge) => `${edge.from}->${edge.to}`));
    const currentEdges = currentWorkflowEdges(flow);
    const nextEdges = currentEdges.filter((edge) => !removedKeys.has(`${edge.from}->${edge.to}`));
    if (nextEdges.length !== currentEdges.length) {
      onEdgesChange(nextEdges);
      return true;
    }
    return false;
  }

  function handleRfEdgesChange(changes: any[]) {
    onRfEdgesChange(changes);
    const removedIds = changes
      .filter((change) => change?.type === "remove" && typeof change.id === "string")
      .map((change) => change.id);
    if (removedIds.length) removeEdgesByIds(removedIds);
  }

  function nearestInsertIndex(event: React.DragEvent): number {
    const insertNodes = layout.nodes.filter((item) => item.type === "insert");
    if (!insertNodes.length) return flow.nodes.length;
    const point = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const nearest = insertNodes.reduce<{ index: number; distance: number } | undefined>((best, item) => {
      const centerX = item.position.x + workflowInsertNodeWidth / 2;
      const centerY = item.position.y + workflowInsertNodeHeight / 2;
      const dx = centerX - point.x;
      const dy = centerY - point.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const index = Number(item.data?.index ?? flow.nodes.length);
      return !best || distance < best.distance ? { index, distance } : best;
    }, undefined);
    return nearest?.index ?? flow.nodes.length;
  }

  function handleGraphDragOver(event: React.DragEvent) {
    if (!hasInsertDropPayload(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleGraphDrop(event: React.DragEvent) {
    if (!hasInsertDropPayload(event)) return;
    onDrop(event, nearestInsertIndex(event));
  }

  if (flow.nodes.length === 0) {
    return (
      <div
        className="empty-state graph-empty"
        onDragOver={handleGraphDragOver}
        onDrop={(event) => onDrop(event, 0)}
      >
        <strong>No steps yet</strong>
        <span>Drag an API request, DB query, Unix batch, or control block here, or insert a step manually.</span>
        <button onClick={() => onInsert(0)}><Plus size={14} /> Insert step</button>
      </div>
    );
  }

  return (
    <ReactFlow
      className="workflow-graph"
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={workflowNodeTypes}
      fitView
      fitViewOptions={{ padding: 0.16, minZoom: 0.45, maxZoom: 1 }}
      minZoom={0.45}
      maxZoom={1.6}
      connectionRadius={88}
      nodesDraggable
      nodesConnectable
      elementsSelectable
      onNodesChange={onNodesChange}
      onEdgesChange={handleRfEdgesChange}
      onConnect={connectNodes}
      onEdgeDoubleClick={(event, edge) => {
        event.preventDefault();
        deleteEdgeById(edge.id);
      }}
      deleteKeyCode={["Backspace", "Delete"]}
      edgeTypes={workflowEdgeTypes}
      onNodeDragStop={(_, node) => {
        if (node.type === "workflow") onPositionChange(node.id, node.position);
      }}
      onNodeClick={(_, node) => {
        if (node.type === "workflow") onSelect((node.data as { node: FlowNode }).node.id);
      }}
      onDragOver={handleGraphDragOver}
      onDrop={handleGraphDrop}
    >
      <Background gap={18} color="#dce3ec" />
      <MiniMap pannable zoomable nodeStrokeWidth={3} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function WorkflowGraphNode({ data }: { data: any }) {
  const node = data.node as FlowNode;
  const typeClass = nodeVisualType(node);
  const missingInputs = (data.missingInputs ?? []) as string[];
  const runStatus = data.runStatus as string | undefined;
  const parentLabel = data.parentLabel as string | undefined;
  const parentKind = data.parentKind as string | undefined;
  const parentLoopSummaries = (data.parentLoopSummaries ?? (data.parentLoopSummary ? [data.parentLoopSummary] : [])) as string[];
  const selected = Boolean(data.selected);
  const disabled = Boolean(node.disabled);
  const topIndex = Number(data.topIndex ?? -1);
  const isPostAction = parentKind === "postAction";
  const isNestedControlChild = parentKind === "loop" || parentKind === "parallel";
  const kicker = isPostAction
    ? "AND branch"
    : node.type === "parallel" || node.type === "loop"
        ? "Control"
        : node.section
          ? "Section lane"
          : "Step";
  const parentText = parentKind === "loop"
    ? "inside repeat"
    : parentKind === "parallel"
      ? `branch of ${parentLabel}`
      : parentLabel
        ? `after ${parentLabel}`
        : undefined;

  function stop(event: React.MouseEvent) {
    event.stopPropagation();
  }

  return (
    <div className={`graph-node ${typeClass} ${selected ? "selected" : ""} ${disabled ? "disabled" : ""} ${runStatus ?? ""} ${missingInputs.length ? "missing" : ""}`}>
      <GraphConnectionHandles />
      <button className="graph-node-main" onClick={() => data.onSelect(node.id)}>
        <NodeIcon type={node.type} />
        <div>
          <div className="graph-node-kicker">
            <span>{kicker}</span>
            {runStatus && <span className={`run-dot ${runStatus}`}>{runStatus}</span>}
          </div>
          <strong>{node.label || node.id}</strong>
          <small>{nodeSummary(node, data.apiOperations ?? {})}</small>
          {parentText && <em>{parentText}</em>}
        </div>
      </button>
      <div className="graph-node-badges">
        <span>{nodeTypeBadge(node)}</span>
        {parentKind === "loop" && parentLoopSummaries.map((summary, index) => (
          <span key={`${summary}-${index}`} className="loop-badge" title={`Repeated by ${summary}`}>
            {index === 0 ? "repeat" : "nested"} {String(summary)}
          </span>
        ))}
        {disabled && <span className="warn">disabled</span>}
        {missingInputs.length > 0 && <span className="warn" title={missingInputs.join(", ")}>{missingInputs.length} missing</span>}
      </div>
      {!isPostAction && (
        <div className="graph-node-actions" onClick={stop}>
          <button className="icon-button" title="Move up" disabled={!isNestedControlChild && topIndex <= 0} onClick={() => data.onMove(node.id, -1)}><ChevronUp size={14} /></button>
          <button className="icon-button" title="Move down" disabled={!isNestedControlChild && Boolean(data.isLast)} onClick={() => data.onMove(node.id, 1)}><ChevronDown size={14} /></button>
          <button className="icon-button" title="Duplicate" onClick={() => data.onDuplicate(node.id)}><Copy size={14} /></button>
          <button className="icon-button" title={disabled ? "Enable" : "Disable"} onClick={() => data.onToggleDisabled(node.id, !disabled)}>{disabled ? "On" : "Off"}</button>
          <button className="icon-button danger-plain" title="Remove step" onClick={() => data.onRemove(node.id)}><Trash2 size={14} /></button>
        </div>
      )}
    </div>
  );
}

function GraphConnectionHandles() {
  return (
    <>
      <Handle id="target-top" className="graph-port graph-port-target graph-port-top" type="target" position={Position.Top} />
      <Handle id="source-bottom" className="graph-port graph-port-source graph-port-bottom" type="source" position={Position.Bottom} />
    </>
  );
}

function InsertGraphNode({ data }: { data: any }) {
  return (
    <div
      className={`graph-insert-node ${data.active ? "active" : ""}`}
      onDragOver={(event) => {
        if (hasInsertDropPayload(event)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => data.onDrop(event, data.index)}
    >
      <Handle type="target" position={Position.Top} />
      <button onClick={() => data.onInsert(data.index)}><Plus size={14} /> Insert step</button>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function AndJoinGraphNode() {
  return (
    <div className="graph-and-join">
      <Handle type="target" position={Position.Top} />
      <span>AND join</span>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function SectionLaneNode({ data }: { data: any }) {
  return (
    <div className={`graph-section-lane ${data.subflow ? "subflow" : ""}`}>
      <strong>{data.label}</strong>
      <span>{data.subflow ? "Reusable flow block" : "Section lane"}</span>
    </div>
  );
}

const workflowNodeTypes = {
  workflow: WorkflowGraphNode,
  insert: InsertGraphNode,
  andJoin: AndJoinGraphNode,
  sectionLane: SectionLaneNode
};

function WorkflowEditableEdge(props: any) {
  const [hovered, setHovered] = useState(false);
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition
  });
  const deletable = Boolean(props.data?.deletable);
  const label = props.label as React.ReactNode;
  const controlsVisible = Boolean(label || hovered || props.selected);
  return (
    <>
      <BaseEdge id={props.id} path={edgePath} markerEnd={props.markerEnd} style={props.style} />
      {deletable && (
        <path
          className="graph-edge-hitbox"
          d={edgePath}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        />
      )}
      {(label || deletable) && (
        <EdgeLabelRenderer>
          <div
            className={`graph-edge-controls nodrag nopan ${controlsVisible ? "visible" : ""}`}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`
            }}
          >
            {label && <span>{label}</span>}
            {deletable && (
              <button
                type="button"
                className="graph-edge-delete"
                title="Delete edge"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.data?.onDelete?.(props.id);
                }}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const workflowEdgeTypes = {
  editable: WorkflowEditableEdge
};

function AddStepPanel({
  insertIndex,
  collections,
  quickApiKeys,
  availableQuickApiKeys,
  apiOperations,
  catalogs,
  onClose,
  onOpenCollection,
  onAddQuickApi,
  onRemoveQuickApi,
  onAddApi,
  onChooseDbTemplate,
  onChooseBatchTemplate,
  onAddControl
}: {
  insertIndex: number;
  collections: ImportedApiCollection[];
  quickApiKeys: string[];
  availableQuickApiKeys: string[];
  apiOperations: Record<string, ApiOperationEntry>;
  catalogs?: Catalogs;
  onClose: () => void;
  onOpenCollection: (collection: ImportedApiCollection) => void;
  onAddQuickApi: (operation: string) => void;
  onRemoveQuickApi: (operation: string) => void;
  onAddApi: (operation: string) => void;
  onChooseDbTemplate: (type: "db_query" | "db_execute") => void;
  onChooseBatchTemplate: () => void;
  onAddControl: (node: FlowNode) => void;
}) {
  const [apiToAdd, setApiToAdd] = useState(availableQuickApiKeys[0] ?? "");
  const hasReadQueries = queryKeysForNodeType(catalogs, "db_query").length > 0;
  const hasExecuteQueries = queryKeysForNodeType(catalogs, "db_execute").length > 0;
  const hasBatches = Object.keys(catalogs?.batches ?? {}).length > 0;

  useEffect(() => {
    if (!apiToAdd || !availableQuickApiKeys.includes(apiToAdd)) setApiToAdd(availableQuickApiKeys[0] ?? "");
  }, [apiToAdd, availableQuickApiKeys]);

  return (
    <section className="add-step-panel">
      <div className="panel-title-row">
        <div>
          <h2>Add Step</h2>
          <p>Inserting at position {insertIndex + 1}. You can also drag a request from a collection onto the highlighted insert point.</p>
        </div>
        <button onClick={onClose}>Close</button>
      </div>

      <div className="add-step-section">
        <h3>API Collections</h3>
        {collections.length === 0 ? (
          <p className="field-help">Import a Postman collection from the left panel first.</p>
        ) : collections.map((collection) => (
          <button key={collection.id} className="collection-add-row" onClick={() => onOpenCollection(collection)}>
            <FolderOpen size={16} />
            <span>{collection.name}</span>
            <small>{collection.requestCount} requests</small>
          </button>
        ))}
      </div>

      <div className="add-step-section">
        <h3>Quick APIs</h3>
        {quickApiKeys.length === 0 ? (
          <p className="field-help">Choose local operations below to pin them here for one-click access.</p>
        ) : quickApiKeys.map((operation) => (
          <div key={operation} className="quick-api-row">
            <button
              draggable
              onDragStart={(event) => writeInsertDropPayload(event, { kind: "api-operation", operation })}
              onClick={() => onAddApi(operation)}
            >
              <Server size={15} /> {operation}
            </button>
            <button className="icon-button danger-plain" title="Remove quick API" onClick={() => onRemoveQuickApi(operation)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {availableQuickApiKeys.length > 0 && (
          <div className="quick-config-row">
            <select value={apiToAdd} onChange={(event) => setApiToAdd(event.target.value)}>
              {availableQuickApiKeys.map((operation) => <option key={operation} value={operation}>{operationLabel(operation, apiOperations[operation])}</option>)}
            </select>
            <button onClick={() => onAddQuickApi(apiToAdd)} disabled={!apiToAdd}><Plus size={14} /> Pin</button>
          </div>
        )}
      </div>

      <div className="add-step-section">
        <h3>DB / Unix</h3>
        <div className="button-grid">
          <button
            disabled={!hasReadQueries}
            draggable={hasReadQueries}
            onDragStart={(event) => writeInsertDropPayload(event, { kind: "db-template-picker", type: "db_query" })}
            onClick={() => onChooseDbTemplate("db_query")}
          ><Database size={15} /> Choose DB query</button>
          <button
            disabled={!hasExecuteQueries}
            draggable={hasExecuteQueries}
            onDragStart={(event) => writeInsertDropPayload(event, { kind: "db-template-picker", type: "db_execute" })}
            onClick={() => onChooseDbTemplate("db_execute")}
          ><Database size={15} /> Choose DB execute</button>
          <button
            disabled={!hasBatches}
            draggable={hasBatches}
            onDragStart={(event) => writeInsertDropPayload(event, { kind: "unix-batch-picker" })}
            onClick={() => onChooseBatchTemplate()}
          ><TerminalSquare size={15} /> Choose Unix batch</button>
        </div>
      </div>
      <div className="add-step-section">
        <h3>Control Flow</h3>
        <div className="button-grid">
          <button
            draggable
            onDragStart={(event) => writeInsertDropPayload(event, { kind: "control", control: "parallel" })}
            onClick={() => onAddControl(parallelNode())}
          ><Copy size={15} /> Parallel block</button>
          <button
            draggable
            onDragStart={(event) => writeInsertDropPayload(event, { kind: "control", control: "loop-count" })}
            onClick={() => onAddControl(loopNode("count"))}
          ><Copy size={15} /> Fixed-count loop</button>
          <button
            draggable
            onDragStart={(event) => writeInsertDropPayload(event, { kind: "control", control: "loop-foreach" })}
            onClick={() => onAddControl(loopNode("foreach"))}
          ><Copy size={15} /> Foreach loop</button>
        </div>
      </div>
    </section>
  );
}

function DbTemplatePicker({
  type,
  catalogs,
  onClose,
  onManage,
  onAdd
}: {
  type: "db_query" | "db_execute";
  catalogs: Catalogs;
  onClose: () => void;
  onManage: () => void;
  onAdd: (query: string) => void;
}) {
  const [search, setSearch] = useState("");
  const templateIds = queryKeysForNodeType(catalogs, type);
  const modeLabel = type === "db_execute" ? "DB execute" : "DB query";
  const visibleIds = templateIds.filter((id) => {
    const entry = catalogs.queries[id];
    const haystack = `${id} ${entry.description ?? ""} ${entry.sql ?? ""}`.toLowerCase();
    return haystack.includes(search.toLowerCase());
  });

  return (
    <div className="side-drawer-shell db-template-shell">
      <section className="collection-modal db-template-modal">
        <header>
          <div>
            <h2>Add {modeLabel}</h2>
            <p>Choose the exact template to add to this workflow. Nothing is inserted until you pick one.</p>
          </div>
          <button onClick={onClose}>Close</button>
        </header>

        <div className="search-row">
          <Search size={15} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${modeLabel} templates`} />
        </div>

        <div className="db-template-list">
          {visibleIds.length === 0 ? (
            <div className="empty-state compact">
              <strong>No {modeLabel} templates found</strong>
              <span>{templateIds.length === 0 ? "Create one in the DB Query Library first." : "Try a different search."}</span>
            </div>
          ) : visibleIds.map((id) => {
            const entry = catalogs.queries[id];
            const paramCount = Object.keys(entry.params ?? {}).length;
            const captureCount = Object.keys(entry.captures ?? {}).length;
            return (
              <button
                key={id}
                className="db-template-row"
                draggable
                onDragStart={(event) => writeInsertDropPayload(event, { kind: "db-template", type, query: id })}
                onClick={() => onAdd(id)}
              >
                <div>
                  <strong>{id}</strong>
                  {entry.description && <span>{entry.description}</span>}
                  <code>{sqlPreview(entry.sql)}</code>
                </div>
                <div className="db-template-meta">
                  <small>{paramCount} params</small>
                  <small>{captureCount} captures</small>
                  <b>Add</b>
                </div>
              </button>
            );
          })}
        </div>

        <footer>
          <button onClick={onManage}><Settings size={14} /> Manage templates</button>
          <button onClick={onClose}>Cancel</button>
        </footer>
      </section>
    </div>
  );
}

function UnixBatchPicker({
  catalogs,
  onClose,
  onManage,
  onAdd
}: {
  catalogs: Catalogs;
  onClose: () => void;
  onManage: () => void;
  onAdd: (batches: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const batchIds = Object.keys(catalogs.batches).sort();
  const visibleIds = batchIds.filter((id) => {
    const entry = catalogs.batches[id];
    const haystack = `${id} ${entry.description ?? ""} ${entry.hostRef ?? ""} ${entry.command ?? ""} ${(entry.fixedArgs ?? []).join(" ")}`.toLowerCase();
    return haystack.includes(search.toLowerCase());
  });
  const selectedIds = batchIds.filter((id) => selected[id]);

  function toggleBatch(id: string, checked = !selected[id]) {
    setSelected((current) => ({ ...current, [id]: checked }));
  }

  return (
    <div className="side-drawer-shell db-template-shell">
      <section className="collection-modal db-template-modal">
        <header>
          <div>
            <h2>Add Unix Batch</h2>
            <p>Select one or more batch templates, then add them together at the chosen insert position.</p>
          </div>
          <button onClick={onClose}>Close</button>
        </header>

        <div className="search-row">
          <Search size={15} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Unix batch templates" />
        </div>

        <div className="db-template-list">
          {visibleIds.length === 0 ? (
            <div className="empty-state compact">
              <strong>No Unix batch templates found</strong>
              <span>{batchIds.length === 0 ? "Create one in the Unix Batch Library first." : "Try a different search."}</span>
            </div>
          ) : visibleIds.map((id) => {
            const entry = catalogs.batches[id];
            const argCount = entry.args?.length ?? 0;
            const fixedArgCount = entry.fixedArgs?.length ?? 0;
            return (
              <div
                key={id}
                className={`db-template-row selectable ${selected[id] ? "selected" : ""}`}
                draggable
                onDragStart={(event) => writeInsertDropPayload(event, { kind: "unix-batch", batch: id })}
                onClick={() => toggleBatch(id)}
              >
                <input
                  type="checkbox"
                  checked={Boolean(selected[id])}
                  onChange={(event) => toggleBatch(id, event.target.checked)}
                  onClick={(event) => event.stopPropagation()}
                  aria-label={`Select ${id}`}
                />
                <div>
                  <strong>{id}</strong>
                  {entry.description && <span>{entry.description}</span>}
                  <code>{batchCommandPreview(entry)}</code>
                </div>
                <div className="db-template-meta">
                  <small>{entry.hostRef}</small>
                  <small>{fixedArgCount} fixed / {argCount} runtime args</small>
                  <button
                    className="link-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onAdd([id]);
                    }}
                  >
                    Add one
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <footer>
          <button onClick={onManage}><Settings size={14} /> Manage templates</button>
          <div className="button-row right">
            <button onClick={() => {
              const visibleSet = new Set(visibleIds);
              const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected[id]);
              setSelected((current) => ({
                ...current,
                ...Object.fromEntries([...visibleSet].map((id) => [id, !allVisibleSelected]))
              }));
            }}>
              {visibleIds.length > 0 && visibleIds.every((id) => selected[id]) ? "Clear visible" : "Select visible"}
            </button>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" disabled={selectedIds.length === 0} onClick={() => onAdd(selectedIds)}>
              <Plus size={14} /> Add selected ({selectedIds.length})
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function CollectionPicker({
  collection,
  requests,
  selected,
  search,
  onSearch,
  onToggle,
  onAdd,
  onDragRequest,
  onClose
}: {
  collection: ImportedApiCollection;
  requests: ImportedApiRequest[];
  selected: Record<string, boolean>;
  search: string;
  onSearch: (value: string) => void;
  onToggle: (id: string, checked: boolean) => void;
  onAdd: (requests: ImportedApiRequest[]) => void;
  onDragRequest: (event: React.DragEvent, request: ImportedApiRequest) => void;
  onClose: () => void;
}) {
  const chosen = requests.filter((request) => selected[request.id]);
  return (
    <div className="side-drawer-shell">
      <section className="collection-modal">
        <header>
          <div>
            <h2>{collection.name}</h2>
            <p>{collection.requestCount} requests imported {new Date(collection.importedAt).toLocaleString()}</p>
          </div>
          <button onClick={onClose}>Close</button>
        </header>
        <div className="search-row">
          <Search size={16} />
          <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search folder, request, method, or path" />
        </div>
        <div className="request-list">
          {requests.map((request) => (
            <div
              key={request.id}
              className="request-row"
              draggable
              onDragStart={(event) => onDragRequest(event, request)}
              title="Drag this request onto an insert point, or click Add."
            >
              <label>
                <input type="checkbox" checked={Boolean(selected[request.id])} onChange={(event) => onToggle(request.id, event.target.checked)} />
                <span className={`method ${request.request.method ?? "GET"}`}>{request.request.method ?? "GET"}</span>
                <strong>{request.name}</strong>
                <small>{request.folderPath.join(" / ") || "Root"}</small>
                <code>{request.request.path ?? "/"}</code>
              </label>
              <button onClick={() => onAdd([request])}>Add</button>
            </div>
          ))}
        </div>
        <footer>
          <button disabled={!chosen.length} className="primary" onClick={() => onAdd(chosen)}>Add selected ({chosen.length})</button>
        </footer>
      </section>
    </div>
  );
}

function DbQueryManager({
  queries,
  onClose,
  onSave,
  onDelete
}: {
  queries: Record<string, QueryCatalogEntry>;
  onClose: () => void;
  onSave: (currentId: string | undefined, id: string, query: QueryCatalogEntry) => Promise<{ id: string; query: QueryCatalogEntry; queries: Record<string, QueryCatalogEntry> }>;
  onDelete: (id: string) => Promise<{ queries: Record<string, QueryCatalogEntry> }>;
}) {
  const queryIds = Object.keys(queries).sort();
  const firstId = queryIds[0];
  const [editingId, setEditingId] = useState<string | undefined>(firstId);
  const [draftId, setDraftId] = useState(firstId ?? "new_db_query");
  const [draft, setDraft] = useState<QueryCatalogEntry>(firstId ? cloneDbQuery(queries[firstId]) : defaultDbQuery());
  const [isNew, setIsNew] = useState(!firstId);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("");

  const visibleIds = queryIds.filter((id) => {
    const entry = queries[id];
    const text = `${id} ${entry.description ?? ""} ${entry.mode ?? "query"}`.toLowerCase();
    return text.includes(filter.toLowerCase());
  });

  function selectQuery(id: string) {
    setEditingId(id);
    setDraftId(id);
    setDraft(cloneDbQuery(queries[id]));
    setIsNew(false);
  }

  function newQuery(mode: "query" | "execute" = "query") {
    const id = uniqueDbQueryId(queries, mode === "execute" ? "new_db_execute" : "new_db_query");
    setEditingId(undefined);
    setDraftId(id);
    setDraft(defaultDbQuery(mode));
    setIsNew(true);
  }

  async function saveCurrent() {
    try {
      setSaving(true);
      const response = await onSave(isNew ? undefined : editingId, draftId.trim(), cleanDbQueryDraft(draft));
      setEditingId(response.id);
      setDraftId(response.id);
      setDraft(cloneDbQuery(response.query));
      setIsNew(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function deleteCurrent() {
    if (!editingId) {
      newQuery();
      return;
    }
    if (!window.confirm(`Delete DB query '${editingId}' from catalogs/queries.yaml?`)) return;
    try {
      const response = await onDelete(editingId);
      const nextId = Object.keys(response.queries).sort()[0];
      if (nextId) {
        setEditingId(nextId);
        setDraftId(nextId);
        setDraft(cloneDbQuery(response.queries[nextId]));
        setIsNew(false);
      } else {
        newQuery();
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="side-drawer-shell db-query-shell">
      <section className="collection-modal db-query-modal">
        <header>
          <div>
            <h2>DB Query Library</h2>
            <p>Manage templates stored in <code>catalogs/queries.yaml</code>. Query reads rows; Execute runs updates, PL/SQL, setup, or cleanup.</p>
          </div>
          <button onClick={onClose}>Close</button>
        </header>

        <div className="db-query-manager">
          <aside className="db-query-list">
            <div className="search-row">
              <Search size={15} />
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search DB templates" />
            </div>
            <div className="db-query-create">
              <button onClick={() => newQuery("query")}><Plus size={14} /> New query</button>
              <button onClick={() => newQuery("execute")}><Plus size={14} /> New execute</button>
            </div>
            <div className="db-query-items">
              {visibleIds.map((id) => (
                <button key={id} className={id === editingId && !isNew ? "selected" : ""} onClick={() => selectQuery(id)}>
                  <strong>{id}</strong>
                  <span>{queries[id].mode === "execute" ? "execute" : "query"}</span>
                  {queries[id].description && <small>{queries[id].description}</small>}
                </button>
              ))}
            </div>
          </aside>

          <div className="db-query-form">
            <div className="form-grid three">
              <label>Template ID<input value={draftId} onChange={(event) => setDraftId(event.target.value)} placeholder="case_by_external_id" /></label>
              <label>Mode
                <select value={draft.mode ?? "query"} onChange={(event) => setDraft((current) => ({ ...current, mode: event.target.value as "query" | "execute", expect: event.target.value === "execute" ? undefined : current.expect }))}>
                  <option value="query">DB query</option>
                  <option value="execute">DB execute</option>
                </select>
              </label>
              <label>Max rows<input type="number" min="1" value={draft.maxRows ?? ""} onChange={(event) => setDraft((current) => ({ ...current, maxRows: event.target.value ? Number(event.target.value) : undefined }))} /></label>
            </div>

            <label>Description<input value={draft.description ?? ""} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label>

            <label>SQL
              <textarea className="sql-editor" value={draft.sql} onChange={(event) => setDraft((current) => ({ ...current, sql: event.target.value }))} spellCheck={false} />
            </label>

            <QueryParamsEditor value={draft.params ?? {}} onChange={(params) => setDraft((current) => ({ ...current, params }))} />
            <QueryCapturesEditor value={draft.captures ?? {}} onChange={(captures) => setDraft((current) => ({ ...current, captures }))} />
            {draft.mode !== "execute" && <QueryExpectationEditor value={draft.expect} onChange={(expect) => setDraft((current) => ({ ...current, expect }))} />}

            <div className="button-row right">
              <button className="danger" onClick={() => void deleteCurrent()} disabled={saving}><Trash2 size={14} /> Delete</button>
              <button className="primary" onClick={() => void saveCurrent()} disabled={saving}><Save size={14} /> Save DB template</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function UnixBatchManager({
  batches,
  onClose,
  onSave,
  onDelete
}: {
  batches: Record<string, BatchCatalogEntry>;
  onClose: () => void;
  onSave: (currentId: string | undefined, id: string, batch: BatchCatalogEntry) => Promise<{ id: string; batch: BatchCatalogEntry; batches: Record<string, BatchCatalogEntry> }>;
  onDelete: (id: string) => Promise<{ batches: Record<string, BatchCatalogEntry> }>;
}) {
  const batchIds = Object.keys(batches).sort();
  const firstId = batchIds[0];
  const [editingId, setEditingId] = useState<string | undefined>(firstId);
  const [draftId, setDraftId] = useState(firstId ?? "new_unix_batch");
  const [draft, setDraft] = useState<BatchCatalogEntry>(firstId ? cloneUnixBatch(batches[firstId]) : defaultUnixBatch());
  const [isNew, setIsNew] = useState(!firstId);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("");

  const visibleIds = batchIds.filter((id) => {
    const entry = batches[id];
    const text = `${id} ${entry.description ?? ""} ${entry.hostRef ?? ""} ${entry.command ?? ""}`.toLowerCase();
    return text.includes(filter.toLowerCase());
  });

  function selectBatch(id: string) {
    setEditingId(id);
    setDraftId(id);
    setDraft(cloneUnixBatch(batches[id]));
    setIsNew(false);
  }

  function newBatch() {
    const id = uniqueKey(batches, "new_unix_batch");
    setEditingId(undefined);
    setDraftId(id);
    setDraft(defaultUnixBatch());
    setIsNew(true);
  }

  async function saveCurrent() {
    try {
      setSaving(true);
      const response = await onSave(isNew ? undefined : editingId, draftId.trim(), cleanUnixBatchDraft(draft));
      setEditingId(response.id);
      setDraftId(response.id);
      setDraft(cloneUnixBatch(response.batch));
      setIsNew(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function deleteCurrent() {
    if (!editingId) {
      newBatch();
      return;
    }
    if (!window.confirm(`Delete Unix batch '${editingId}' from catalogs/batches.yaml?`)) return;
    try {
      const response = await onDelete(editingId);
      const nextId = Object.keys(response.batches).sort()[0];
      if (nextId) {
        setEditingId(nextId);
        setDraftId(nextId);
        setDraft(cloneUnixBatch(response.batches[nextId]));
        setIsNew(false);
      } else {
        newBatch();
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="side-drawer-shell db-query-shell">
      <section className="collection-modal db-query-modal">
        <header>
          <div>
            <h2>Unix Batch Library</h2>
            <p>Manage templates stored in <code>catalogs/batches.yaml</code>. Inspect host, working directory, command, args, success rules, and captures.</p>
          </div>
          <button onClick={onClose}>Close</button>
        </header>

        <div className="db-query-manager">
          <aside className="db-query-list">
            <div className="search-row">
              <Search size={15} />
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search Unix batches" />
            </div>
            <div className="db-query-create single">
              <button onClick={() => newBatch()}><Plus size={14} /> New batch</button>
            </div>
            <div className="db-query-items">
              {visibleIds.map((id) => (
                <button key={id} className={id === editingId && !isNew ? "selected" : ""} onClick={() => selectBatch(id)}>
                  <strong>{id}</strong>
                  <span>batch</span>
                  <small>{batches[id].description || `${batches[id].hostRef}: ${batches[id].command}`}</small>
                </button>
              ))}
            </div>
          </aside>

          <div className="db-query-form">
            <div className="form-grid three">
              <label>Template ID<input value={draftId} onChange={(event) => setDraftId(event.target.value)} placeholder="daily_processing" /></label>
              <label>Host ref<input value={draft.hostRef ?? ""} onChange={(event) => setDraft((current) => ({ ...current, hostRef: event.target.value }))} placeholder="qa_worker" /></label>
              <label>Timeout seconds<input type="number" min="1" value={draft.timeoutSeconds ?? ""} onChange={(event) => setDraft((current) => ({ ...current, timeoutSeconds: event.target.value ? Number(event.target.value) : undefined }))} /></label>
            </div>

            <label>Description<input value={draft.description ?? ""} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label>

            <div className="form-grid two">
              <label>Working directory<input value={draft.workingDirectory ?? ""} onChange={(event) => setDraft((current) => ({ ...current, workingDirectory: event.target.value }))} placeholder="${ADFINEM_BATCH_WORKDIR}" /></label>
              <label className="checkbox-label">
                <input type="checkbox" checked={Boolean(draft.useWorkingDirectory)} onChange={(event) => setDraft((current) => ({ ...current, useWorkingDirectory: event.target.checked || undefined }))} />
                Run from working directory
              </label>
            </div>
            <p className="field-help">By default the command runs exactly as pasted after SSH login. Enable working directory only if the template must prepend <code>cd ... &&</code>.</p>

            <CommandLineEditor
              batchKey={`${editingId ?? "new"}:${draftId}`}
              value={draft}
              onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
            />

            <div className="request-summary-panel">
              <strong>Command preview</strong>
              <code>{batchCommandPreview(draft)}</code>
              <span>Executable: <code>{draft.command || "-"}</code></span>
              <span>Fixed args: <code>{(draft.fixedArgs ?? []).map(String).join(" ") || "-"}</code></span>
            </div>

            <BatchArgsEditor value={draft.args ?? []} onChange={(args) => setDraft((current) => ({ ...current, args }))} />
            <BatchInputFilesEditor value={draft.inputFiles ?? []} onChange={(inputFiles) => setDraft((current) => ({ ...current, inputFiles }))} />
            <BatchOutputFilesEditor value={draft.outputFiles ?? []} onChange={(outputFiles) => setDraft((current) => ({ ...current, outputFiles }))} />
            <BatchSuccessEditor value={draft.success} onChange={(success) => setDraft((current) => ({ ...current, success }))} />
            <BatchEnvironmentEditor value={draft.environment ?? {}} onChange={(environment) => setDraft((current) => ({ ...current, environment }))} />
            <QueryCapturesEditor value={draft.captures ?? {}} onChange={(captures) => setDraft((current) => ({ ...current, captures }))} />

            <div className="button-row right">
              <button className="danger" onClick={() => void deleteCurrent()} disabled={saving}><Trash2 size={14} /> Delete</button>
              <button className="primary" onClick={() => void saveCurrent()} disabled={saving}><Save size={14} /> Save Unix batch</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function CommandLineEditor({
  batchKey,
  value,
  onChange
}: {
  batchKey: string;
  value: BatchCatalogEntry;
  onChange: (patch: Pick<BatchCatalogEntry, "command" | "fixedArgs">) => void;
}) {
  const [text, setText] = useState(commandLineText(value));

  useEffect(() => {
    setText(commandLineText(value));
  }, [batchKey]);

  return (
    <label>Command line
      <textarea
        className="command-line-editor"
        value={text}
        placeholder="sh -x reconcile_nightly.sh reconcile_nightly.log"
        onChange={(event) => {
          const nextText = event.target.value;
          setText(nextText);
          onChange(commandLinePatch(nextText));
        }}
        spellCheck={false}
      />
      <span className="field-help">
        Paste the Unix command exactly as you would run it after SSH login. The workbench stores the first token as the executable and the rest as fixed args.
      </span>
    </label>
  );
}

const catalogParamTypes: CatalogParamType[] = ["string", "number", "boolean", "string[]", "number[]", "boolean[]"];
const expectationTypes: QueryExpectationSpec["type"][] = ["number", "string", "boolean", "rowCount"];
const expectationOperators: QueryExpectationSpec["operator"][] = ["=", "!=", ">", ">=", "<", "<=", "contains"];

function QueryParamsEditor({ value, onChange }: { value: Record<string, CatalogParamSpec>; onChange: (next: Record<string, CatalogParamSpec>) => void }) {
  const entries = Object.entries(value);
  function patchParam(name: string, patch: Partial<CatalogParamSpec>) {
    onChange({ ...value, [name]: cleanParamSpec({ ...(value[name] ?? {}), ...patch }) });
  }
  return (
    <section className="db-sub-editor">
      <div className="db-sub-head">
        <h3>Parameters</h3>
        <button onClick={() => onChange({ ...value, [uniqueKey(value, "param")]: { required: true, type: "string" } })}><Plus size={14} /> Add parameter</button>
      </div>
      {entries.length > 0 && <div className="db-param-row header"><span>Name</span><span>Type</span><span>Required</span><span>Pattern</span><span>Luhn</span><span /></div>}
      {entries.map(([name, param]) => (
        <div className="db-param-row" key={name}>
          <input value={name} onChange={(event) => renameKey(value, name, bindParamName(event.target.value), onChange)} />
          <select value={param.type ?? "string"} onChange={(event) => patchParam(name, { type: event.target.value as CatalogParamType })}>
            {catalogParamTypes.map((type) => <option key={type}>{type}</option>)}
          </select>
          <input type="checkbox" checked={Boolean(param.required)} onChange={(event) => patchParam(name, { required: event.target.checked })} />
          <input value={param.pattern ?? ""} onChange={(event) => patchParam(name, { pattern: event.target.value })} placeholder="optional regex" />
          <input type="checkbox" checked={Boolean(param.luhn)} onChange={(event) => patchParam(name, { luhn: event.target.checked })} />
          <button onClick={() => { const next = { ...value }; delete next[name]; onChange(next); }}>x</button>
        </div>
      ))}
      {entries.length === 0 && <p className="field-help">No bind parameters. Add parameters for SQL binds such as <code>:caseId</code>.</p>}
    </section>
  );
}

function BatchArgsEditor({ value, onChange }: { value: Array<CatalogParamSpec & { name: string }>; onChange: (next: Array<CatalogParamSpec & { name: string }>) => void }) {
  function patchArg(index: number, patch: Partial<CatalogParamSpec & { name: string }>) {
    onChange(value.map((arg, itemIndex) => itemIndex === index ? { ...arg, ...cleanParamSpec({ ...arg, ...patch }), name: patch.name ?? arg.name } : arg));
  }

  return (
    <section className="db-sub-editor">
      <div className="db-sub-head">
        <h3>Runtime args</h3>
        <button onClick={() => onChange([...value, { name: `arg_${value.length + 1}`, type: "string" }])}><Plus size={14} /> Add arg</button>
      </div>
      {value.length > 0 && <div className="db-param-row header"><span>Name</span><span>Type</span><span>Required</span><span>Pattern</span><span>Luhn</span><span /></div>}
      {value.map((arg, index) => (
        <div className="db-param-row" key={index}>
          <input value={arg.name} onChange={(event) => patchArg(index, { name: event.target.value })} />
          <select value={arg.type ?? "string"} onChange={(event) => patchArg(index, { type: event.target.value as CatalogParamType })}>
            {catalogParamTypes.map((type) => <option key={type}>{type}</option>)}
          </select>
          <input type="checkbox" checked={Boolean(arg.required)} onChange={(event) => patchArg(index, { required: event.target.checked })} />
          <input value={arg.pattern ?? ""} onChange={(event) => patchArg(index, { pattern: event.target.value })} placeholder="optional regex" />
          <input type="checkbox" checked={Boolean(arg.luhn)} onChange={(event) => patchArg(index, { luhn: event.target.checked })} />
          <button onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}>x</button>
        </div>
      ))}
      {value.length === 0 && <p className="field-help">No runtime args. Fixed args and command alone will be used.</p>}
    </section>
  );
}

function BatchInputFilesEditor({ value, onChange }: { value: BatchInputFileSpec[]; onChange: (next: BatchInputFileSpec[]) => void }) {
  function patchFile(index: number, patch: Partial<BatchInputFileSpec>) {
    onChange(value.map((file, itemIndex) => itemIndex === index ? cleanBatchInputFile({ ...file, ...patch }) : file));
  }

  return (
    <section className="db-sub-editor">
      <div className="db-sub-head">
        <h3>Input files</h3>
        <button onClick={() => onChange([...value, { name: `input_file_${value.length + 1}`, required: true, paramName: `input_file_${value.length + 1}` }])}>
          <Plus size={14} /> Add input file
        </button>
      </div>
      <p className="field-help">Define the file slot here. The workflow step uploads the selected local file to the Unix deposit path supplied in that step; this template path is only an optional default. A path ending in <code>/</code> is treated as a directory and the file name is appended. Use <code>{`\${fileName}`}</code> in paths, and place <code>{`\${paramName}`}</code> in fixed args when the command needs the uploaded file path.</p>
      {value.length > 0 && <div className="batch-file-row header"><span>Name</span><span>Default deposit path</span><span>Param name</span><span>Required</span><span>Append</span><span /></div>}
      {value.map((file, index) => (
        <div className="batch-file-row" key={index}>
          <input value={file.name} onChange={(event) => patchFile(index, { name: event.target.value })} placeholder="input_file" />
          <input value={file.remotePath ?? ""} onChange={(event) => patchFile(index, { remotePath: event.target.value })} placeholder="/remote/deposit/path/${fileName}" />
          <input value={file.paramName ?? ""} onChange={(event) => patchFile(index, { paramName: event.target.value })} placeholder={file.name || "arg_name"} />
          <input type="checkbox" checked={file.required !== false} onChange={(event) => patchFile(index, { required: event.target.checked ? true : false })} />
          <input type="checkbox" checked={Boolean(file.appendAsArg)} onChange={(event) => patchFile(index, { appendAsArg: event.target.checked || undefined })} />
          <button onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}>x</button>
        </div>
      ))}
      {value.length === 0 && <p className="field-help">No SFTP input files. Add one when the remote batch needs the app to upload a local file before the command starts.</p>}
    </section>
  );
}

function BatchOutputFilesEditor({ value, onChange }: { value: BatchOutputFileSpec[]; onChange: (next: BatchOutputFileSpec[]) => void }) {
  function patchFile(index: number, patch: Partial<BatchOutputFileSpec>) {
    onChange(value.map((file, itemIndex) => itemIndex === index ? cleanBatchOutputFile({ ...file, ...patch }) : file));
  }

  return (
    <section className="db-sub-editor">
      <div className="db-sub-head">
        <h3>Generated files</h3>
        <button onClick={() => onChange([...value, { name: `output_file_${value.length + 1}`, required: true, source: "stderr", pathPattern: "FICHIER\\s*:\\s*(\\S+)", download: true }])}>
          <Plus size={14} /> Add generated file
        </button>
      </div>
      <p className="field-help">For batches that print an output file path, define where to find that path, optional decrypt command, and whether to download the final file into run evidence. Decrypt command supports <code>{`\${remotePath}`}</code> and <code>{`\${decryptedRemotePath}`}</code>.</p>
      {value.map((file, index) => (
        <div className="batch-output-card" key={index}>
          <div className="form-grid four">
            <label>Name<input value={file.name} onChange={(event) => patchFile(index, { name: event.target.value })} placeholder="generated_file" /></label>
            <label>Source
              <select value={file.source ?? "stderr"} onChange={(event) => patchFile(index, { source: event.target.value as BatchOutputFileSpec["source"] })}>
                <option value="stderr">stderr</option>
                <option value="stdout">stdout</option>
                <option value="both">stdout + stderr</option>
                <option value="explicit">explicit path</option>
              </select>
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={file.required !== false} onChange={(event) => patchFile(index, { required: event.target.checked ? true : false })} />
              Required
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={file.download !== false} onChange={(event) => patchFile(index, { download: event.target.checked ? true : false })} />
              Download
            </label>
          </div>
          <div className="form-grid two">
            <label>Path regex<input value={file.pathPattern ?? ""} onChange={(event) => patchFile(index, { pathPattern: event.target.value })} placeholder="FICHIER\\s*:\\s*(\\S+)" /></label>
            <label>Explicit remote path<input value={file.remotePath ?? ""} onChange={(event) => patchFile(index, { remotePath: event.target.value })} placeholder="/remote/output/file.dat" /></label>
          </div>
          <div className="form-grid two">
            <label>Decrypt command<input value={file.decrypt?.command ?? ""} onChange={(event) => patchFile(index, { decrypt: cleanDecryptSpec({ ...(file.decrypt ?? {}), command: event.target.value }) })} placeholder="decrypt_tool ${remotePath} ${decryptedRemotePath}" /></label>
            <label>Decrypted output path<input value={file.decrypt?.outputRemotePath ?? ""} onChange={(event) => patchFile(index, { decrypt: cleanDecryptSpec({ ...(file.decrypt ?? {}), outputRemotePath: event.target.value }) })} placeholder="${remotePath}.dec" /></label>
          </div>
          <div className="button-row right">
            <label className="checkbox-label compact">
              <input type="checkbox" checked={file.decrypt?.required !== false} onChange={(event) => patchFile(index, { decrypt: cleanDecryptSpec({ ...(file.decrypt ?? {}), required: event.target.checked ? true : false }) })} />
              Decrypt must pass
            </label>
            <button onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
          </div>
        </div>
      ))}
      {value.length === 0 && <p className="field-help">No generated files configured. Add one when the batch prints a file path that should be retrieved or decrypted after the command finishes.</p>}
    </section>
  );
}

function BatchStepFilesEditor({
  flowId,
  nodeId,
  specs,
  value,
  onChange
}: {
  flowId: string;
  nodeId: string;
  specs: BatchInputFileSpec[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const fileValues = Object.fromEntries(specs
    .map((spec) => [spec.name, batchInputFileValue(value[spec.name])] as const)
    .filter((entry): entry is [string, BatchInputFileValue] => Boolean(entry[1])));

  function patchFile(name: string, patch: Partial<BatchInputFileValue>) {
    const current = batchInputFileValue(value[name]) ?? {};
    onChange({ ...fileValues, [name]: cleanObject({ ...current, ...patch }) });
  }

  async function selectFile(spec: BatchInputFileSpec, file: File | undefined) {
    if (!file) return;
    setUploading((current) => ({ ...current, [spec.name]: true }));
    try {
      const contentBase64 = await fileToBase64(file);
      const upload = await api<{ fileName: string; localPath: string; sizeBytes: number }>("/api/batch-input-files", {
        method: "POST",
        body: {
          flowId,
          stepId: nodeId,
          inputName: spec.name,
          fileName: file.name,
          contentBase64
        }
      });
      patchFile(spec.name, {
        fileName: upload.fileName,
        localPath: upload.localPath,
        sizeBytes: upload.sizeBytes,
        remotePath: batchInputFileValue(value[spec.name])?.remotePath ?? spec.remotePath
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading((current) => ({ ...current, [spec.name]: false }));
    }
  }

  return (
    <section className="db-sub-editor batch-step-files">
      <div className="db-sub-head">
        <h3>SFTP input files</h3>
      </div>
      <p className="field-help">Choose the local file and the Unix deposit path for this workflow step. A path ending in <code>/</code> is treated as a directory and the file name is appended. At run time the workbench uploads the file there over SFTP, then exposes that final remote path to the command parameter.</p>
      {specs.map((spec) => {
        const current = batchInputFileValue(value[spec.name]);
        const remotePath = current?.remotePath ?? spec.remotePath ?? "";
        return (
          <div className="batch-step-file-card" key={spec.name}>
            <div>
              <strong>{spec.name}</strong>
              {spec.required !== false && <span className="data-chip">required</span>}
              {(spec.paramName || spec.name) && <small>command param: <code>{spec.paramName || spec.name}</code>{spec.appendAsArg ? " + appended arg" : ""}</small>}
            </div>
            <label>Unix deposit path
              <input value={remotePath} onChange={(event) => patchFile(spec.name, { remotePath: event.target.value })} placeholder="/remote/deposit/path/${fileName}" />
            </label>
            <div className="batch-file-picker-row">
              <input
                type="file"
                onChange={(event) => void selectFile(spec, event.target.files?.[0])}
                disabled={Boolean(uploading[spec.name])}
              />
              {current?.localPath ? (
                <span><b>{current.fileName}</b> {formatBytes(current.sizeBytes)} stored at <code>{current.localPath}</code></span>
              ) : (
                <span>No file selected</span>
              )}
              {current?.localPath && <button onClick={() => {
                const next = { ...fileValues };
                delete next[spec.name];
                onChange(next);
              }}>Clear</button>}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function BatchSuccessEditor({ value, onChange }: { value?: BatchCatalogEntry["success"]; onChange: (next?: BatchCatalogEntry["success"]) => void }) {
  const current = value ?? { exitCodes: [0] };
  const enabled = Boolean(value);
  return (
    <section className="db-sub-editor">
      <div className="db-sub-head">
        <h3>Success rules</h3>
        <label className="toggle-line compact-toggle">
          <input type="checkbox" checked={enabled} onChange={(event) => onChange(event.target.checked ? current : undefined)} />
          Custom success criteria
        </label>
      </div>
      {enabled && (
        <div className="form-grid two">
          <label>Allowed exit codes
            <input value={(current.exitCodes ?? []).join(", ")} onChange={(event) => onChange({ ...current, exitCodes: parseNumberList(event.target.value) })} placeholder="0" />
            <span className="field-help">Use <code>0, 1</code> for batch scripts where exit 1 is normal success; exit 99 will still fail unless listed.</span>
          </label>
          <label>Required output lines
            <textarea className="small-code-editor" value={(current.requiredOutput ?? []).join("\n")} onChange={(event) => onChange({ ...current, requiredOutput: parseTextLines(event.target.value) })} spellCheck={false} />
          </label>
        </div>
      )}
    </section>
  );
}

function BatchEnvironmentEditor({ value, onChange }: { value: Record<string, string | number | boolean>; onChange: (next: Record<string, string | number | boolean>) => void }) {
  return (
    <section className="db-sub-editor">
      <div className="db-sub-head">
        <h3>Environment variables</h3>
        <button onClick={() => onChange({ ...value, [uniqueKey(value, "VAR_NAME")]: "" })}><Plus size={14} /> Add env var</button>
      </div>
      <MappingEditor value={value} outputs={[]} onChange={(next) => onChange(stringifyRecord(next) as Record<string, string | number | boolean>)} />
      {Object.keys(value).length === 0 && <p className="field-help">Optional environment prefix for the remote command.</p>}
    </section>
  );
}

function QueryCapturesEditor({ value, onChange }: { value: Record<string, string>; onChange: (next: Record<string, string>) => void }) {
  const entries = Object.entries(value);
  return (
    <section className="db-sub-editor">
      <div className="db-sub-head">
        <h3>Captures</h3>
        <button onClick={() => onChange({ ...value, [uniqueKey(value, "output")]: "$.rows[0].COLUMN_NAME" })}><Plus size={14} /> Add capture</button>
      </div>
      {entries.length > 0 && <div className="db-capture-row header"><span>Name</span><span>JSONPath</span><span /></div>}
      {entries.map(([name, expression]) => (
        <div className="db-capture-row" key={name}>
          <input value={name} onChange={(event) => renameKey(value, name, event.target.value, onChange)} />
          <input value={expression} onChange={(event) => onChange({ ...value, [name]: event.target.value })} placeholder="$.rows[0].CARD_NUMBER" />
          <button onClick={() => { const next = { ...value }; delete next[name]; onChange(next); }}>x</button>
        </div>
      ))}
      {entries.length === 0 && <p className="field-help">Captures are optional. Add them only when later steps need DB output.</p>}
    </section>
  );
}

function QueryExpectationEditor({ value, onChange }: { value?: QueryExpectationSpec; onChange: (next?: QueryExpectationSpec) => void }) {
  const enabled = Boolean(value);
  const current = value ?? { type: "rowCount", operator: ">", value: 0 } satisfies QueryExpectationSpec;
  return (
    <section className="db-sub-editor">
      <div className="db-sub-head">
        <h3>Expectation</h3>
        <label className="toggle-line compact-toggle">
          <input type="checkbox" checked={enabled} onChange={(event) => onChange(event.target.checked ? current : undefined)} />
          Assert DB result
        </label>
      </div>
      {enabled && (
        <div className="db-expect-row">
          <label>Type
            <select value={current.type} onChange={(event) => onChange({ ...current, type: event.target.value as QueryExpectationSpec["type"], column: event.target.value === "rowCount" ? undefined : current.column })}>
              {expectationTypes.map((type) => <option key={type}>{type}</option>)}
            </select>
          </label>
          <label>Column
            <input disabled={current.type === "rowCount"} value={current.column ?? ""} onChange={(event) => onChange({ ...current, column: event.target.value })} placeholder="CNT" />
          </label>
          <label>Operator
            <select value={current.operator} onChange={(event) => onChange({ ...current, operator: event.target.value as QueryExpectationSpec["operator"] })}>
              {expectationOperators.map((operator) => <option key={operator}>{operator}</option>)}
            </select>
          </label>
          <label>Value
            <input value={String(current.value ?? "")} onChange={(event) => onChange({ ...current, value: parseExpectationValue(event.target.value, current.type) })} />
          </label>
        </div>
      )}
    </section>
  );
}

function NodeEditor({
  node,
  flowId,
  index,
  total,
  catalogs,
  outputs,
  apiTab,
  onApiTabChange,
  onChange,
  onRemove,
  onDuplicate,
  onMove,
  onAddPostAction,
  onWrapInLoop,
  onWrapRangeInLoop,
  repeatRangeTargets,
  onUnwrapLoop,
  parentLoop,
  onParentLoopChange,
  onUnwrapParentLoop,
  loopAncestors,
  onSave,
  onRunFrom,
  onRunOnly,
  environmentName,
  environmentInput,
  onEnvironmentInputChange
}: {
  node: FlowNode;
  flowId: string;
  index: number;
  total: number;
  catalogs?: Catalogs;
  outputs: OutputReference[];
  apiTab: ApiTab;
  onApiTabChange: (tab: ApiTab) => void;
  onChange: (patch: Partial<FlowNode>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onMove: (direction: -1 | 1) => void;
  onAddPostAction: (action: FlowNode) => void;
  onWrapInLoop: (mode: "count" | "foreach") => void;
  onWrapRangeInLoop: (endId: string, mode: "count" | "foreach") => void;
  repeatRangeTargets: RepeatRangeTarget[];
  onUnwrapLoop: () => void;
  parentLoop?: FlowNode;
  onParentLoopChange: (patch: Partial<FlowNode>) => void;
  onUnwrapParentLoop: () => void;
  loopAncestors: string[];
  onSave: () => Promise<FlowFile>;
  onRunFrom: (dryRun: boolean) => void;
  onRunOnly: (dryRun: boolean) => void;
  environmentName: string;
  environmentInput: Record<string, unknown>;
  onEnvironmentInputChange: (next: Record<string, unknown>) => void;
}) {
  const [panelTab, setPanelTab] = useState<PanelTab>("Edit");
  const showAssertions = !typesWithoutAssertions.has(node.type);
  const capCount = Object.keys(node.capture ?? {}).length;
  const assertCount = node.assertions?.length ?? 0;
  const inputCount = Object.values(node.input ?? node.params ?? {}).filter((value) => value !== undefined && value !== null && String(value) !== "").length;

  useEffect(() => {
    setPanelTab("Edit");
  }, [node.id]);

  useEffect(() => {
    if (panelTab === "Assertions" && !showAssertions) setPanelTab("Edit");
  }, [panelTab, showAssertions]);

  return (
    <div className="node-editor v2">
      <div className="step-header-sticky">
        <StepHeaderCard
          node={node}
          index={index}
          total={total}
          apiOperations={catalogs?.apiOperations ?? {}}
          onChange={onChange}
          onRemove={onRemove}
          onDuplicate={onDuplicate}
          onMove={onMove}
        />
        <div className="panel-tabs">
          {panelTabs.map((tab) => {
            if (tab === "Assertions" && !showAssertions) {
              return <button key={tab} className="off" disabled>{tab}</button>;
            }
            const tabLabel = tab === "Inputs" && node.type === "api_operation" ? "Variables" : tab;
            const count = tab === "Inputs"
              ? inputCount
              : tab === "Captures"
                ? capCount
                : tab === "Assertions"
                  ? assertCount
                  : 0;
            return (
              <button key={tab} className={panelTab === tab ? "on" : ""} onClick={() => setPanelTab(tab)}>
                {tabLabel}{count > 0 && <span className="data-chip">{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="panel-body">
        {panelTab === "Edit" && (
          <EditPane
            node={node}
            catalogs={catalogs}
            outputs={outputs}
            apiTab={apiTab}
            onApiTabChange={onApiTabChange}
            onChange={onChange}
            onAddPostAction={onAddPostAction}
            onWrapInLoop={onWrapInLoop}
            onWrapRangeInLoop={onWrapRangeInLoop}
            repeatRangeTargets={repeatRangeTargets}
            onUnwrapLoop={onUnwrapLoop}
            parentLoop={parentLoop}
            onParentLoopChange={onParentLoopChange}
            onUnwrapParentLoop={onUnwrapParentLoop}
            loopAncestors={loopAncestors}
            onSave={onSave}
            onRunOnly={onRunOnly}
          />
        )}
        {panelTab === "Inputs" && (
          <InputsPane
            node={node}
            flowId={flowId}
            catalogs={catalogs}
            outputs={outputs}
            onChange={onChange}
            environmentName={environmentName}
            environmentInput={environmentInput}
            onEnvironmentInputChange={onEnvironmentInputChange}
          />
        )}
        {panelTab === "Captures" && (
          <CaptureEditor
            node={node}
            catalogs={catalogs}
            operation={catalogs?.apiOperations[node.operation ?? ""]}
            value={node.capture ?? {}}
            onChange={(next) => onChange({ capture: stringifyRecord(next) })}
          />
        )}
        {panelTab === "Assertions" && showAssertions && (
          <AssertionsEditor value={node.assertions ?? []} onChange={(assertions) => onChange({ assertions })} />
        )}
        {panelTab === "Run" && (
          <RunScopePane onRunOnly={onRunOnly} onRunFrom={onRunFrom} />
        )}
      </div>
    </div>
  );
}

function EditPane({
  node,
  catalogs,
  outputs,
  apiTab,
  onApiTabChange,
  onChange,
  onAddPostAction,
  onWrapInLoop,
  onWrapRangeInLoop,
  repeatRangeTargets,
  onUnwrapLoop,
  parentLoop,
  onParentLoopChange,
  onUnwrapParentLoop,
  loopAncestors,
  onSave,
  onRunOnly
}: {
  node: FlowNode;
  catalogs?: Catalogs;
  outputs: OutputReference[];
  apiTab: ApiTab;
  onApiTabChange: (tab: ApiTab) => void;
  onChange: (patch: Partial<FlowNode>) => void;
  onAddPostAction: (action: FlowNode) => void;
  onWrapInLoop: (mode: "count" | "foreach") => void;
  onWrapRangeInLoop: (endId: string, mode: "count" | "foreach") => void;
  repeatRangeTargets: RepeatRangeTarget[];
  onUnwrapLoop: () => void;
  parentLoop?: FlowNode;
  onParentLoopChange: (patch: Partial<FlowNode>) => void;
  onUnwrapParentLoop: () => void;
  loopAncestors: string[];
  onSave: () => Promise<FlowFile>;
  onRunOnly: (dryRun: boolean) => void;
}) {
  const queryKeys = queryKeysForNodeType(catalogs, node.type);
  const batchKeys = Object.keys(catalogs?.batches ?? {});
  const loopAttributePanel = parentLoop?.type === "loop" ? (
    <LoopAttributePanel
      loopNode={parentLoop}
      onChange={onParentLoopChange}
      onUnwrap={onUnwrapParentLoop}
    />
  ) : undefined;

  if (node.type === "api_operation") {
    return (
      <div className="edit-pane">
        {loopAttributePanel}
        <ApiRequestEditor
          node={node}
          catalogs={catalogs}
          outputs={outputs}
          apiTab={apiTab}
          onApiTabChange={onApiTabChange}
          onChange={onChange}
          onSave={onSave}
          onRunOnly={onRunOnly}
        />
        <div className="button-row">
          <button onClick={() => onAddPostAction(queryNode("db_query", firstReadQuery(catalogs) ?? "case_by_external_id", catalogs))}>
            <Plus size={14} /> Post DB query
          </button>
          <button onClick={() => onAddPostAction(queryNode("db_execute", firstExecutableQuery(catalogs) ?? "set_business_date", catalogs))}>
            <Plus size={14} /> Post DB execute
          </button>
          <button onClick={() => onAddPostAction(batchNode(firstKey(catalogs?.batches) ?? "daily_processing", catalogs))}>
            <Plus size={14} /> Post batch
          </button>
        </div>
        <RepeatStepPanel onWrapInLoop={onWrapInLoop} onWrapRangeInLoop={onWrapRangeInLoop} loopAncestors={loopAncestors} rangeTargets={repeatRangeTargets} />
      </div>
    );
  }

  if (node.type === "db_query" || node.type === "db_assert" || node.type === "db_execute") {
    return (
      <div className="edit-pane">
        {loopAttributePanel}
        <label>Query
          <select value={queryKeys.includes(node.query ?? "") ? node.query ?? "" : ""} onChange={(event) => onChange({ query: event.target.value, params: defaultQueryParams(catalogs, event.target.value) })}>
            {!queryKeys.includes(node.query ?? "") && <option value="">Choose a {node.type === "db_execute" ? "DB execute" : "DB query"} template</option>}
            {queryKeys.map((key) => <option key={key}>{key}</option>)}
          </select>
        </label>
        <label>Mode
          <select value={node.type} onChange={(event) => {
            const nextType = event.target.value as NodeType;
            const nextQuery = firstQueryForNodeType(catalogs, nextType) ?? node.query;
            onChange({ type: nextType, query: nextQuery, params: defaultQueryParams(catalogs, nextQuery ?? "") });
          }}>
            <option value="db_query">DB query</option>
            <option value="db_assert">DB assert</option>
            <option value="db_execute">DB execute</option>
          </select>
        </label>
        <RepeatStepPanel onWrapInLoop={onWrapInLoop} onWrapRangeInLoop={onWrapRangeInLoop} loopAncestors={loopAncestors} rangeTargets={repeatRangeTargets} />
      </div>
    );
  }

  if (node.type === "parallel" || node.type === "loop") {
    return (
      <ControlFlowEditor
        node={node}
        catalogs={catalogs}
        loopAncestors={loopAncestors}
        onChange={onChange}
        onUnwrapLoop={onUnwrapLoop}
      />
    );
  }

  return (
    <div className="edit-pane">
      {loopAttributePanel}
      <label>Batch
        <select value={node.batch ?? ""} onChange={(event) => onChange({ batch: event.target.value, params: defaultBatchParams(catalogs, event.target.value) })}>
          {batchKeys.map((key) => <option key={key}>{key}</option>)}
        </select>
      </label>
      <div className="form-grid two">
        <label>Attempts<input type="number" min={1} value={node.retry?.attempts ?? ""} onChange={(event) => onChange({ retry: { ...(node.retry ?? {}), attempts: optionalNumber(event.target.value) } })} /></label>
        <label>Delay seconds<input type="number" min={0} value={node.retry?.delaySeconds ?? ""} onChange={(event) => onChange({ retry: { ...(node.retry ?? {}), delaySeconds: optionalNumber(event.target.value) } })} /></label>
      </div>
      <RepeatStepPanel onWrapInLoop={onWrapInLoop} onWrapRangeInLoop={onWrapRangeInLoop} loopAncestors={loopAncestors} rangeTargets={repeatRangeTargets} />
    </div>
  );
}

function RepeatStepPanel({
  onWrapInLoop,
  onWrapRangeInLoop,
  loopAncestors,
  rangeTargets
}: {
  onWrapInLoop: (mode: "count" | "foreach") => void;
  onWrapRangeInLoop: (endId: string, mode: "count" | "foreach") => void;
  loopAncestors: string[];
  rangeTargets: RepeatRangeTarget[];
}) {
  const insideLoop = loopAncestors.length > 0;
  const parentLoop = loopAncestors[loopAncestors.length - 1];
  const [endId, setEndId] = useState(rangeTargets[0]?.id ?? "");

  useEffect(() => {
    setEndId((current) => rangeTargets.some((target) => target.id === current) ? current : rangeTargets[0]?.id ?? "");
  }, [rangeTargets]);

  return (
    <section className="repeat-step-panel">
      <div>
        <strong>Repeat this step</strong>
        {insideLoop ? (
          <p>This step is already inside loop <code>{parentLoop}</code>. Wrapping it again would create nested loops and multiply execution count.</p>
        ) : (
          <p>Wrap the selected API, DB, or Unix step in a loop, then configure count/items on the new loop node.</p>
        )}
      </div>
      <div className="button-row">
        <button disabled={insideLoop} title={insideLoop ? "Select the parent loop to change count/items, or unwrap that loop first." : undefined} onClick={() => onWrapInLoop("count")}><Copy size={14} /> Fixed-count loop</button>
        <button disabled={insideLoop} title={insideLoop ? "Select the parent loop to change count/items, or unwrap that loop first." : undefined} onClick={() => onWrapInLoop("foreach")}><Copy size={14} /> Foreach loop</button>
      </div>
      {!insideLoop && rangeTargets.length > 0 && (
        <div className="repeat-range-box">
          <label>Repeat range through
            <select value={endId} onChange={(event) => setEndId(event.target.value)}>
              {rangeTargets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
            </select>
          </label>
          <div className="button-row">
            <button disabled={!endId} onClick={() => onWrapRangeInLoop(endId, "count")}><Copy size={14} /> Fixed-count range</button>
            <button disabled={!endId} onClick={() => onWrapRangeInLoop(endId, "foreach")}><Copy size={14} /> Foreach range</button>
          </div>
        </div>
      )}
    </section>
  );
}

function InputsPane({
  node,
  flowId,
  catalogs,
  outputs,
  onChange,
  environmentName,
  environmentInput,
  onEnvironmentInputChange
}: {
  node: FlowNode;
  flowId: string;
  catalogs?: Catalogs;
  outputs: OutputReference[];
  onChange: (patch: Partial<FlowNode>) => void;
  environmentName: string;
  environmentInput: Record<string, unknown>;
  onEnvironmentInputChange: (next: Record<string, unknown>) => void;
}) {
  const params = node.type === "api_operation" ? node.input ?? node.params ?? {} : node.params ?? node.input ?? {};
  const apiNode = node.type === "api_operation";
  const unixNode = node.type === "unix_batch";
  const batchInputFiles = unixNode ? catalogs?.batches[node.batch ?? ""]?.inputFiles ?? [] : [];
  const fileInputNames = new Set(batchInputFiles.flatMap((file) => [file.name, file.paramName].filter(Boolean) as string[]));
  const mappingParams = unixNode && fileInputNames.size > 0
    ? Object.fromEntries(Object.entries(params).filter(([key]) => !fileInputNames.has(key)))
    : params;
  const fileParams = unixNode && fileInputNames.size > 0
    ? Object.fromEntries(Object.entries(params).filter(([key]) => fileInputNames.has(key)))
    : {};
  const catalogKeys = catalogParamKeys(node, catalogs);
  const visibleCatalogKeys = unixNode
    ? catalogKeys.filter((key) => !fileInputNames.has(key))
    : catalogKeys;
  return (
    <div className="inputs-pane">
      <h3>{apiNode ? "Template Variables" : "Step Inputs"}</h3>
      <p className="field-help">
        {apiNode
          ? <>Optional fallback values for imported <code>{`{{variable}}`}</code> placeholders. To chain API calls, insert previous outputs directly in the Request editor body, headers, query, or path.</>
          : unixNode
            ? <>Unix batch args are optional per step. Type a literal value, insert a previous output only when needed, or delete the row to omit that command argument.</>
            : <>Values here feed this selected step. Use the Source menu to insert previous captures as <code>{`\${previous_step.output}`}</code>.</>}
      </p>
      {unixNode && batchInputFiles.length > 0 && (
        <BatchStepFilesEditor
          flowId={flowId}
          nodeId={node.id}
          specs={batchInputFiles}
          value={params}
          onChange={(nextFileParams) => onChange({ params: { ...mappingParams, ...nextFileParams } })}
        />
      )}
      <MappingEditor
        value={mappingParams}
        outputs={outputs}
        lockedKeys={unixNode ? [] : visibleCatalogKeys}
        suggestedKeys={unixNode ? visibleCatalogKeys : []}
        onChange={(next) => onChange(node.type === "api_operation" ? { input: next } : { params: { ...fileParams, ...next } })}
      />
      <h3>Inputs For {environmentName}</h3>
      <p className="field-help">Environment inputs are reusable defaults for this workflow and environment.</p>
      <MappingEditor value={environmentInput} outputs={outputs} onChange={onEnvironmentInputChange} />
    </div>
  );
}

function LoopAttributePanel({
  loopNode,
  onChange,
  onUnwrap
}: {
  loopNode: FlowNode;
  onChange: (patch: Partial<FlowNode>) => void;
  onUnwrap: () => void;
}) {
  const loop = loopNode.loop ?? { mode: "count", count: 1 };
  const children = loopNode.nodes ?? [];
  return (
    <section className="repeat-step-panel loop-attribute-panel">
      <div className="db-sub-head">
        <h3>Repeat settings</h3>
        <button className="danger-plain" onClick={onUnwrap}><Minimize2 size={14} /> Remove repeat</button>
      </div>
      <p>
        These settings repeat {children.length === 1 ? "this step" : `${children.length} steps in this range`}. The loop is a step attribute in the designer; it is compiled as a control block only at runtime.
      </p>
      <div className="form-grid two">
        <label>Loop mode
          <select value={loop.mode} onChange={(event) => onChange({ loop: { ...loop, mode: event.target.value as "count" | "foreach" } })}>
            <option value="count">fixed count</option>
            <option value="foreach">foreach</option>
          </select>
        </label>
        <label>Item variable<input value={loop.itemName ?? "item"} onChange={(event) => onChange({ loop: { ...loop, itemName: event.target.value } })} /></label>
      </div>
      {loop.mode === "count" ? (
        <label>Count<input value={String(loop.count ?? 1)} onChange={(event) => onChange({ loop: { ...loop, count: event.target.value } })} /></label>
      ) : (
        <label>Items expression<input value={String(loop.items ?? "${items}")} onChange={(event) => onChange({ loop: { ...loop, items: event.target.value } })} /></label>
      )}
      <label>Max iterations<input type="number" min={1} value={loop.maxIterations ?? 100} onChange={(event) => onChange({ loop: { ...loop, maxIterations: optionalNumber(event.target.value) } })} /></label>
      <LoopDateCursorEditor
        loopId={loopNode.id}
        value={loop.dateCursor}
        onChange={(dateCursor) => onChange({ loop: { ...loop, dateCursor } })}
      />
    </section>
  );
}

function ControlFlowEditor({
  node,
  catalogs,
  loopAncestors,
  onChange,
  onUnwrapLoop
}: {
  node: FlowNode;
  catalogs?: Catalogs;
  loopAncestors: string[];
  onChange: (patch: Partial<FlowNode>) => void;
  onUnwrapLoop: () => void;
}) {
  const firstApi = Object.keys(catalogs?.apiOperations ?? {})[0];
  const readQuery = firstReadQuery(catalogs);
  const batch = firstKey(catalogs?.batches);

  function starterChild(): FlowNode | undefined {
    if (firstApi) return apiOperationNode(firstApi, catalogs?.apiOperations[firstApi]);
    if (readQuery) return queryNode("db_query", readQuery, catalogs);
    if (batch) return batchNode(batch, catalogs);
    return undefined;
  }

  if (node.type === "parallel") {
    const branches = node.branches ?? [];
    return (
      <div className="edit-pane control-editor">
        <label>Join behavior
          <select value={node.join ?? "all"} onChange={(event) => onChange({ join: event.target.value as "all" | "any" | "fail_fast" })}>
            <option value="all">wait for all branches</option>
            <option value="any">pass when any branch passes</option>
            <option value="fail_fast">fail fast</option>
          </select>
        </label>
        <p className="field-help">Parallel branches run after prior workflow steps. Use unique child step ids so captures remain unambiguous.</p>
        {branches.map((branch, branchIndex) => (
          <section className="control-branch" key={branch.id}>
            <div className="db-sub-head">
              <input value={branch.label ?? branch.id} onChange={(event) => {
                const next = branches.map((entry, index) => index === branchIndex ? { ...entry, label: event.target.value } : entry);
                onChange({ branches: next });
              }} />
              <button onClick={() => {
                const child = starterChild();
                if (!child) return;
                const next = branches.map((entry, index) => index === branchIndex ? { ...entry, nodes: [...entry.nodes, child] } : entry);
                onChange({ branches: next });
              }}><Plus size={14} /> Add child</button>
            </div>
            <div className="nested-step-list">
              {branch.nodes.map((child, childIndex) => (
                <div key={child.id}>
                  <span>{child.label ?? child.id}</span>
                  <small>{child.type}</small>
                  <button onClick={() => {
                    const next = branches.map((entry, index) => index === branchIndex ? { ...entry, nodes: entry.nodes.filter((_, itemIndex) => itemIndex !== childIndex) } : entry);
                    onChange({ branches: next });
                  }}>x</button>
                </div>
              ))}
            </div>
          </section>
        ))}
        <button onClick={() => onChange({ branches: [...branches, { id: uniqueId("branch"), label: `Branch ${branches.length + 1}`, nodes: [] }] })}><Plus size={14} /> Add branch</button>
      </div>
    );
  }

  const loop = node.loop ?? { mode: "count", count: 1 };
  const children = node.nodes ?? [];
  const nestedLoops = children.filter((child) => child.type === "loop");
  const parentLoop = loopAncestors[loopAncestors.length - 1];
  return (
    <div className="edit-pane control-editor">
      {parentLoop && (
        <div className="loop-warning">
          This loop is inside <code>{parentLoop}</code>. Counts multiply across nested loops.
        </div>
      )}
      {nestedLoops.length > 0 && (
        <div className="loop-warning">
          This loop contains nested loop{nestedLoops.length === 1 ? "" : "s"} <code>{nestedLoops.map((child) => child.id).join(", ")}</code>. A count of <code>{String(loop.count ?? 1)}</code> around child loop counts multiplies executions.
        </div>
      )}
      <div className="form-grid two">
        <label>Loop mode
          <select value={loop.mode} onChange={(event) => onChange({ loop: { ...loop, mode: event.target.value as "count" | "foreach" } })}>
            <option value="count">fixed count</option>
            <option value="foreach">foreach</option>
          </select>
        </label>
        <label>Item variable<input value={loop.itemName ?? "item"} onChange={(event) => onChange({ loop: { ...loop, itemName: event.target.value } })} /></label>
      </div>
      {loop.mode === "count" ? (
        <label>Count<input value={String(loop.count ?? 1)} onChange={(event) => onChange({ loop: { ...loop, count: event.target.value } })} /></label>
      ) : (
        <label>Items expression<input value={String(loop.items ?? "${items}")} onChange={(event) => onChange({ loop: { ...loop, items: event.target.value } })} /></label>
      )}
      <label>Max iterations<input type="number" min={1} value={loop.maxIterations ?? 100} onChange={(event) => onChange({ loop: { ...loop, maxIterations: optionalNumber(event.target.value) } })} /></label>
      <LoopDateCursorEditor
        loopId={node.id}
        value={loop.dateCursor}
        onChange={(dateCursor) => onChange({ loop: { ...loop, dateCursor } })}
      />
      <p className="field-help">Loop children can reference <code>{`\${${node.id}.index}`}</code>, <code>{`\${${node.id}.item}`}</code>, and later steps can use indexed outputs such as <code>{`\${${node.id}[0].child.output}`}</code> or <code>{`\${${node.id}.last.child.output}`}</code>.</p>
      <button className="danger-plain loop-unwrap-button" onClick={onUnwrapLoop}>
        <Minimize2 size={14} /> Unwrap loop, keep child steps
      </button>
      <div className="nested-step-list">
        {children.map((child, index) => (
          <div key={child.id}>
            <span>{child.label ?? child.id}</span>
            <small>{child.type}</small>
            <button onClick={() => onChange({ nodes: children.filter((_, itemIndex) => itemIndex !== index) })}>x</button>
          </div>
        ))}
      </div>
      <button onClick={() => {
        const child = starterChild();
        if (child) onChange({ nodes: [...children, child] });
      }}><Plus size={14} /> Add child step</button>
    </div>
  );
}

function LoopDateCursorEditor({
  loopId,
  value,
  onChange
}: {
  loopId: string;
  value?: LoopDateCursor;
  onChange: (next: LoopDateCursor | undefined) => void;
}) {
  const enabled = Boolean(value);
  const cursor = value ?? defaultLoopDateCursor();
  const advance = cursor.advance ?? { mode: "months", amount: 1 };

  function patch(patchValue: Partial<LoopDateCursor>) {
    onChange({ ...cursor, ...patchValue });
  }

  function patchAdvance(patchValue: Partial<NonNullable<LoopDateCursor["advance"]>>) {
    onChange({ ...cursor, advance: { ...advance, ...patchValue } });
  }

  return (
    <section className="loop-date-settings">
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onChange(event.target.checked ? defaultLoopDateCursor() : undefined)}
        />
        Business date per iteration
      </label>
      {enabled && (
        <>
          <div className="form-grid two">
            <label>Output name
              <input value={cursor.outputName ?? "business_date"} onChange={(event) => patch({ outputName: event.target.value || "business_date" })} />
            </label>
            <label>Start date
              <input value={cursor.start ?? ""} placeholder="05/02/2027" onChange={(event) => patch({ start: event.target.value })} />
            </label>
            <label>Input format
              <select value={cursor.inputFormat ?? "DD/MM/YYYY"} onChange={(event) => patch({ inputFormat: event.target.value as LoopDateFormat })}>
                <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                <option value="MM/DD/YYYY">MM/DD/YYYY</option>
              </select>
            </label>
            <label>Output format
              <select value={cursor.outputFormat ?? "DD/MM/YYYY"} onChange={(event) => patch({ outputFormat: event.target.value as LoopDateFormat })}>
                <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                <option value="MM/DD/YYYY">MM/DD/YYYY</option>
              </select>
            </label>
            <label>Advance
              <select value={advance.mode} onChange={(event) => patchAdvance({ mode: event.target.value as LoopDateAdvanceMode })}>
                <option value="days">every N days</option>
                <option value="months">same day every N months</option>
                <option value="nth_day_of_month">Nth day of each month</option>
                <option value="first_of_month">first day of month</option>
                <option value="end_of_month">end of month</option>
              </select>
            </label>
            <label>{advance.mode === "days" ? "Days" : "Months"}
              <input type="number" min={1} value={advance.amount ?? 1} onChange={(event) => patchAdvance({ amount: optionalNumber(event.target.value) ?? 1 })} />
            </label>
            {advance.mode === "nth_day_of_month" && (
              <label>Day of month
                <input type="number" min={1} max={31} value={advance.day ?? 1} onChange={(event) => patchAdvance({ day: optionalNumber(event.target.value) ?? 1 })} />
              </label>
            )}
          </div>
          <p className="field-help">
            Put the real DB <code>set_business_date</code> step inside this loop and set its <code>business_date</code> input to <code>{`\${${loopId}.${loopDateOutputName(cursor)}}`}</code>. The loop also exposes bare <code>{`\${${loopDateOutputName(cursor)}}`}</code> to child steps.
          </p>
        </>
      )}
    </section>
  );
}

function RunScopePane({ onRunOnly, onRunFrom }: {
  onRunOnly: (dryRun: boolean) => void;
  onRunFrom: (dryRun: boolean) => void;
}) {
  return (
    <div className="button-row">
      <button onClick={() => onRunOnly(true)}>Dry run only</button>
      <button onClick={() => onRunOnly(false)}>Run only</button>
      <button onClick={() => onRunFrom(true)}>Dry run from here</button>
      <button onClick={() => onRunFrom(false)}>Run from here</button>
    </div>
  );
}

function ApiRequestEditor({
  node,
  catalogs,
  outputs,
  apiTab,
  onApiTabChange,
  onChange,
  onSave,
  onRunOnly
}: {
  node: FlowNode;
  catalogs?: Catalogs;
  outputs: OutputReference[];
  apiTab: ApiTab;
  onApiTabChange: (tab: ApiTab) => void;
  onChange: (patch: Partial<FlowNode>) => void;
  onSave: () => Promise<FlowFile>;
  onRunOnly: (dryRun: boolean) => void;
}) {
  const apiKeys = Object.keys(catalogs?.apiOperations ?? {});
  const operation = catalogs?.apiOperations[node.operation ?? ""];
  const request = withGeneratedRequestHeaders({
    ...operationToRequestSpec(operation),
    ...(node.request ?? {}),
    headers: { ...(operation?.headers ?? {}), ...(node.request?.headers ?? {}) },
    query: { ...(operation?.query ?? {}), ...(node.request?.query ?? {}) }
  });
  const sourceLabel = operation?.source?.collectionName
    ? `${operation.source.collectionName}${operation.source.folderPath?.length ? ` / ${operation.source.folderPath.join(" / ")}` : ""}`
    : "Local template";
  const overrides = useMemo(() => computeOverrides(node, operation), [node, operation]);
  const [showOverrides, setShowOverrides] = useState(false);
  const [popoutOpen, setPopoutOpen] = useState(false);
  const [selectedOutputRef, setSelectedOutputRef] = useState("");
  const pathRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const selectedOutputToken = selectedOutputRef ? `\${${selectedOutputRef}}` : "";

  useEffect(() => {
    if (selectedOutputRef && outputs.some((output) => output.ref === selectedOutputRef)) return;
    setSelectedOutputRef(outputs[0]?.ref ?? "");
  }, [outputs, selectedOutputRef]);

  useEffect(() => {
    if (!popoutOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPopoutOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popoutOpen]);

  function patchRequest(patch: Partial<ApiRequestSpec>) {
    onChange({ request: cleanRequest({ ...(node.request ?? operationToRequestSpec(operation)), ...patch }) });
  }

  function insertOutputIntoBody() {
    if (!selectedOutputToken) return;
    const current = bodyText(request);
    const textarea = bodyRef.current;
    const start = textarea?.selectionStart ?? current.length;
    const end = textarea?.selectionEnd ?? start;
    const next = `${current.slice(0, start)}${selectedOutputToken}${current.slice(end)}`;
    patchRequest({ rawBody: next, body: undefined });
    window.requestAnimationFrame(() => {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(start + selectedOutputToken.length, start + selectedOutputToken.length);
    });
  }

  function insertOutputIntoPath() {
    if (!selectedOutputToken) return;
    const current = request.path ?? "";
    const input = pathRef.current;
    const start = input?.selectionStart ?? current.length;
    const end = input?.selectionEnd ?? start;
    const next = `${current.slice(0, start)}${selectedOutputToken}${current.slice(end)}`;
    patchRequest({ path: next });
    window.requestAnimationFrame(() => {
      pathRef.current?.focus();
      pathRef.current?.setSelectionRange(start + selectedOutputToken.length, start + selectedOutputToken.length);
    });
  }

  function resetRequest() {
    const diffs = computeOverrides(node, operation);
    if (diffs.length > 0) {
      const message = `Reset will discard ${diffs.length} override${diffs.length === 1 ? "" : "s"}:\n\n${diffs.map((diff) => `- ${diff.path}`).join("\n")}\n\nContinue?`;
      if (!window.confirm(message)) return;
    }
    onChange({ request: operationToRequestSpec(operation) });
    setShowOverrides(false);
  }

  function changeTemplate(nextKey: string) {
    const diffs = computeOverrides(node, operation);
    if (diffs.length > 0) {
      const message = `Switching template will discard ${diffs.length} override${diffs.length === 1 ? "" : "s"} on this step:\n\n${diffs.map((diff) => `- ${diff.path}`).join("\n")}\n\nContinue?`;
      if (!window.confirm(message)) return;
    }
    const nextOperation = catalogs?.apiOperations[nextKey];
    onChange({
      operation: nextKey,
      label: node.label || nextKey,
      request: operationToRequestSpec(nextOperation),
      input: defaultApiInputs(nextOperation),
      assertions: nextOperation?.assertions,
      capture: undefined
    });
    setShowOverrides(false);
  }

  return (
    <>
    {popoutOpen && <button className="api-editor-backdrop" aria-label="Close large API editor" onClick={() => setPopoutOpen(false)} />}
    <section className={`api-request-editor ${popoutOpen ? "popout expanded" : ""}`}>
      {!popoutOpen && (
        <div className="api-editor-launchbar">
          <div>
            <strong>{request.method ?? "GET"} {request.path ?? "/"}</strong>
            <span>Use the large editor for body, headers, captures, and assertions.</span>
          </div>
          <button className="primary" onClick={() => setPopoutOpen(true)}><Maximize2 size={15} /> Open large editor</button>
        </div>
      )}

      <div className="tpl-card">
        <div className="tpl-head">
          <span className="tpl-lbl">Source template</span>
          <select className="tpl-select" value={node.operation ?? ""} onChange={(event) => changeTemplate(event.target.value)}>
            {apiKeys.map((key) => <option key={key} value={key}>{operationLabel(key, catalogs?.apiOperations[key])}</option>)}
          </select>
        </div>
        <div className="tpl-meta">{sourceLabel}</div>
      </div>

      {overrides.length > 0 && (
        <div className="override-banner">
          <span className="override-dot" />
          <span><b>{overrides.length} field{overrides.length === 1 ? "" : "s"} overridden</b> from this template</span>
          <button className="link" onClick={() => setShowOverrides((value) => !value)}>{showOverrides ? "Hide" : "Review"} changes</button>
          <button className="link danger" onClick={resetRequest}>Reset all</button>
        </div>
      )}

      {showOverrides && overrides.length > 0 && (
        <div className="override-diff">
          {overrides.map((override) => (
            <div className="diff-line" key={override.path}>
              <span className="diff-path">{override.path}</span>
              <span className="diff-from">{displayValue(override.from)}</span>
              <span className="diff-arrow">-&gt;</span>
              <span className="diff-to">{displayValue(override.to)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="request-editor-header">
        <div>
          <h3>API Request Editor</h3>
          <p>Editable request for this workflow step</p>
        </div>
        <div className="request-editor-actions">
          <span className={`method ${request.method ?? "GET"}`}>{request.method ?? "GET"}</span>
          <button onClick={() => void onSave()}><Save size={14} /> Save</button>
          <button onClick={() => onRunOnly(false)}><Play size={14} /> Run</button>
          <button onClick={() => void onSave().then(() => onRunOnly(false))}><Play size={14} /> Save & Run</button>
          <button className={popoutOpen ? "" : "primary"} onClick={() => setPopoutOpen((value) => !value)}>
            {popoutOpen ? <><Minimize2 size={14} /> Dock editor</> : <><Maximize2 size={14} /> Open large editor</>}
          </button>
          {popoutOpen && <button aria-label="Close large API editor" onClick={() => setPopoutOpen(false)}><X size={14} /></button>}
        </div>
      </div>

      <div className="request-url-row">
        <select value={request.method ?? "GET"} onChange={(event) => patchRequest({ method: event.target.value as ApiMethod })}>
          {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((method) => <option key={method}>{method}</option>)}
        </select>
        <input ref={pathRef} value={request.path ?? ""} onChange={(event) => patchRequest({ path: event.target.value })} placeholder="/api/path" />
      </div>

      <div className="api-sub-tabs">
        {apiTabs.map((tab) => (
          <button key={tab} className={apiTab === tab ? "active" : ""} onClick={() => onApiTabChange(tab)}>{tab}</button>
        ))}
      </div>

      {outputs.length > 0 && (
        <div className="request-output-toolbar">
          <span>Previous output</span>
          <select value={selectedOutputRef} onChange={(event) => setSelectedOutputRef(event.target.value)}>
            {outputs.map((output) => <option key={output.ref} value={output.ref}>{output.label}</option>)}
          </select>
          <code>{selectedOutputToken}</code>
          <button onClick={() => copyToClipboard(selectedOutputToken)} disabled={!selectedOutputToken}>Copy ref</button>
          {apiTab === "Request" && <button onClick={insertOutputIntoPath} disabled={!selectedOutputToken}>Insert in path</button>}
          {apiTab === "Body" && <button onClick={insertOutputIntoBody} disabled={!selectedOutputToken}>Insert in body</button>}
        </div>
      )}

      {apiTab === "Request" && (
        <div className="editor-pane">
          <div className="form-grid two">
            <label>Expected outcome
              <select value={node.expectedOutcome ?? "positive"} onChange={(event) => onChange({ expectedOutcome: event.target.value as ExpectedOutcome })}>
                <option value="positive">Positive</option>
                <option value="negative">Negative</option>
                <option value="setup">Setup</option>
                <option value="teardown">Teardown</option>
              </select>
            </label>
            <label className="toggle-line">
              <input type="checkbox" checked={node.captureOnFailure ?? true} onChange={(event) => onChange({ captureOnFailure: event.target.checked })} />
              Capture HTTP response evidence on failure
            </label>
          </div>
          <label>Accepted statuses
            <input value={(request.acceptStatuses ?? []).join(", ")} onChange={(event) => patchRequest({ acceptStatuses: parseStatusList(event.target.value) })} placeholder="200, 201, 409" />
          </label>
          <div className="request-summary-panel">
            <strong>{request.method ?? "GET"} {request.path ?? "/"}</strong>
            <span>{Object.keys(request.headers ?? {}).length} headers</span>
            <span>{Object.keys(request.query ?? {}).length} query params</span>
            <span>{request.bodyMode ?? "none"} body</span>
          </div>
        </div>
      )}

      {apiTab === "Headers" && (
        <RecordEditor value={request.headers ?? {}} outputs={outputs} onChange={(headers) => patchRequest({ headers: stringifyRecord(headers) })} keyLabel="Header" valueLabel="Value" />
      )}

      {apiTab === "Query" && (
        <RecordEditor value={request.query ?? {}} outputs={outputs} onChange={(query) => patchRequest({ query })} keyLabel="Parameter" valueLabel="Value" />
      )}

      {apiTab === "Body" && (
        <div className="editor-pane">
          <label>Body mode
            <select value={request.bodyMode ?? "none"} onChange={(event) => patchRequest({ bodyMode: event.target.value as ApiBodyMode })}>
              <option value="none">None</option>
              <option value="json">JSON</option>
              <option value="raw">Raw text</option>
              <option value="urlencoded">URL encoded</option>
              <option value="formdata">Form data</option>
            </select>
          </label>
          <textarea ref={bodyRef} value={bodyText(request)} onChange={(event) => patchRequest({ rawBody: event.target.value, body: undefined })} spellCheck={false} />
          <div className="button-row">
            <button disabled={(request.bodyMode ?? "none") !== "json"} onClick={() => {
              try {
                patchRequest({ rawBody: JSON.stringify(JSON.parse(bodyText(request)) as unknown, null, 2), bodyMode: "json", body: undefined });
              } catch {
                window.alert("Body is not valid JSON.");
              }
            }}>Format JSON</button>
          </div>
        </div>
      )}

      {apiTab === "Auth" && (
        <div className="editor-pane">
          <textarea value={jsonText(request.auth)} onChange={(event) => patchRequest({ auth: parseJsonLoose(event.target.value) })} spellCheck={false} />
        </div>
      )}

      {apiTab === "Captures" && (
        <CaptureEditor node={node} catalogs={catalogs} operation={operation} value={node.capture ?? {}} onChange={(next) => onChange({ capture: stringifyRecord(next) })} />
      )}

      {apiTab === "Assertions" && (
        <AssertionsEditor value={node.assertions ?? []} onChange={(assertions) => onChange({ assertions })} />
      )}
    </section>
    </>
  );
}

function AssertionsEditor({ value, onChange }: { value: ApiAssertion[]; onChange: (next: ApiAssertion[]) => void }) {
  return (
    <div className="assertion-editor">
      {value.map((assertion, index) => (
        <div className="assertion-row" key={index}>
          <select value={assertion.type} onChange={(event) => {
            const type = event.target.value as ApiAssertion["type"];
            const next = [...value];
            next[index] = defaultAssertion(type);
            onChange(next);
          }}>
            <option value="status">Status</option>
            <option value="jsonpath_exists">JSONPath exists</option>
            <option value="jsonpath_equals">JSONPath equals</option>
            <option value="jsonpath_contains">JSONPath contains</option>
            <option value="header_exists">Header exists</option>
            <option value="header_equals">Header equals</option>
            <option value="body_contains">Body contains</option>
            <option value="body_not_contains">Body does not contain</option>
          </select>
          <input
            value={assertionTarget(assertion)}
            placeholder="Status, JSONPath, or header"
            onChange={(event) => {
              const next = [...value];
              next[index] = setAssertionTarget(assertion, event.target.value);
              onChange(next);
            }}
          />
          <input
            value={assertionValueText(assertion)}
            placeholder="Expected value"
            onChange={(event) => {
              const next = [...value];
              next[index] = setAssertionValue(assertion, event.target.value);
              onChange(next);
            }}
          />
          <button onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}>x</button>
        </div>
      ))}
      <button onClick={() => onChange([...value, defaultAssertion("status")])}><Plus size={14} /> Add assertion</button>
    </div>
  );
}

function RecordEditor({
  value,
  onChange,
  keyLabel,
  valueLabel,
  outputs = []
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  keyLabel: string;
  valueLabel: string;
  outputs?: OutputReference[];
}) {
  const hasOutputs = outputs.length > 0;
  return (
    <div className={`record-editor ${hasOutputs ? "with-output" : ""}`}>
      {Object.entries(value).length > 0 && (
        <div className="record-header">
          <span>{keyLabel}</span>
          <span>{valueLabel}</span>
          {hasOutputs && <span>Source</span>}
          <span />
        </div>
      )}
      {Object.entries(value).map(([key, entry], index) => (
        <div className="record-row" key={index}>
          <input value={key} onChange={(event) => renameKey(value, key, event.target.value, onChange)} />
          <input value={String(entry ?? "")} onChange={(event) => onChange({ ...value, [key]: event.target.value })} />
          {hasOutputs && (
            <select
              value=""
              title="Use output from a previous step"
              onChange={(event) => {
                if (!event.target.value) return;
                onChange({ ...value, [key]: `\${${event.target.value}}` });
              }}
            >
              <option value="">Use output...</option>
              {outputs.map((output) => <option key={output.ref} value={output.ref}>{output.label}</option>)}
            </select>
          )}
          <button onClick={() => { const next = { ...value }; delete next[key]; onChange(next); }}>x</button>
        </div>
      ))}
      <button onClick={() => onChange({ ...value, new_key: "" })}><Plus size={14} /> Add</button>
    </div>
  );
}

function CaptureEditor({
  node,
  catalogs,
  operation,
  value,
  onChange
}: {
  node: FlowNode;
  catalogs?: Catalogs;
  operation?: ApiOperationEntry;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const entries = Object.entries(value);
  const firstCapture = entries[0]?.[0] || "output";
  const reference = `\${${node.id}.${firstCapture}}`;
  const quickCaptures = capturePresetsFor(node, operation, catalogs);
  const help = captureHelpFor(node);

  function addCapture(seed = quickCaptures[0]?.name ?? "output", expression = quickCaptures[0]?.expression ?? "$.result.id") {
    const key = uniqueCaptureName(value, seed);
    onChange({ ...value, [key]: expression });
  }

  return (
    <div className="capture-editor">
      <div className="capture-help">
        <strong>Step outputs</strong>
        <p>Capture values from this step response, then use them in later inputs as <code>{reference}</code>.</p>
        <p>{help}</p>
      </div>
      <div className="capture-quick">
        {quickCaptures.map((capture) => (
          <button key={capture.name} onClick={() => addCapture(capture.name, capture.expression)} disabled={Object.prototype.hasOwnProperty.call(value, capture.name)}>
            <Plus size={14} /> {capture.name}
          </button>
        ))}
      </div>
      {entries.length > 0 && (
        <div className="capture-header">
          <span>Output name</span>
          <span>Extract from response</span>
          <span>Reference</span>
          <span />
        </div>
      )}
      {entries.map(([key, entry], index) => (
        <div className="capture-row" key={index}>
          <input
            value={key}
            placeholder="token"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => renameKey(value, key, event.target.value, onChange)}
          />
          <input
            value={String(entry ?? "")}
            placeholder="$.token"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => onChange({ ...value, [key]: event.target.value })}
          />
          <code>{key ? `\${${node.id}.${key}}` : "-"}</code>
          <button aria-label={`Remove capture ${key || index}`} onClick={() => { const next = { ...value }; delete next[key]; onChange(next); }}>x</button>
        </div>
      ))}
      <button onClick={() => addCapture()}><Plus size={14} /> Add capture</button>
    </div>
  );
}

function MappingEditor({
  value,
  outputs,
  lockedKeys = [],
  suggestedKeys = [],
  onChange
}: {
  value: Record<string, unknown>;
  outputs: OutputReference[];
  lockedKeys?: string[];
  suggestedKeys?: string[];
  onChange: (next: Record<string, unknown>) => void;
}) {
  const entries = Object.entries(value);
  const locked = new Set(lockedKeys);
  const missingSuggestions = suggestedKeys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  return (
    <div className="mapping-editor">
      {entries.length > 0 && (
        <div className="mapping-header">
          <span>Name</span>
          <span>Value</span>
          <span>Source</span>
          <span />
        </div>
      )}
      {entries.map(([key, entry], index) => {
        const isLocked = locked.has(key);
        return (
          <div className="mapping-row" key={index} data-locked={isLocked ? "true" : undefined}>
            <input
              value={key}
              disabled={isLocked}
              title={isLocked ? "Template variable names are fixed; edit the value or use an environment override." : undefined}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => renameKey(value, key, event.target.value, onChange)}
            />
            <input
              value={String(entry ?? "")}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => onChange({ ...value, [key]: event.target.value })}
            />
            <select
              className="mapping-output-select"
              value=""
              title={outputs.length ? "Use output from a previous step" : "No previous step outputs are available for this node"}
              disabled={outputs.length === 0}
              onChange={(event) => {
                if (!event.target.value) return;
                onChange({ ...value, [key]: `\${${event.target.value}}` });
              }}
            >
              <option value="">{outputs.length ? "Use previous output..." : "No prior outputs"}</option>
              {outputs.map((output) => <option key={output.ref} value={output.ref}>{output.label}</option>)}
            </select>
            <button onClick={() => { const next = { ...value }; delete next[key]; onChange(next); }}>x</button>
          </div>
        );
      })}
      {missingSuggestions.length > 0 && (
        <div className="suggested-param-row">
          {missingSuggestions.map((key) => (
            <button key={key} onClick={() => onChange({ ...value, [key]: "" })}><Plus size={14} /> Add {key}</button>
          ))}
        </div>
      )}
      {lockedKeys.length === 0 && (
        <button onClick={() => onChange({ ...value, [uniqueKey(value, "param")]: "" })}><Plus size={14} /> Add mapping</button>
      )}
    </div>
  );
}

function ValidationPanel({ validation, onApplyReferenceFixes }: { validation?: ValidationState; onApplyReferenceFixes?: () => void }) {
  if (!validation) return null;
  const fixes = staleReferenceFixes(validation);
  return (
    <section className={`validation ${validation.ok ? "ok" : "bad"}`}>
      <div className="validation-title-row">
        <h2>{validation.ok ? "Valid" : "Validation"}</h2>
        {fixes.length > 0 && onApplyReferenceFixes && (
          <button onClick={onApplyReferenceFixes}>
            Fix stale reference{fixes.length === 1 ? "" : "s"}
          </button>
        )}
      </div>
      {fixes.length > 0 && (
        <p className="field-help">
          Suggested repair: {fixes.map((fix) => `${fix.fromStep} -> ${fix.toStep}`).join(", ")}
        </p>
      )}
      {(validation.errors ?? []).map((error) => <p key={error}>{error}</p>)}
      {(validation.warnings ?? []).map((warning) => <p key={warning}>{warning}</p>)}
    </section>
  );
}

const dockHeightKey = (flowId: string) => `adfinem-workbench.run-dock.height.${flowId}`;
const dockCollapsedKey = (flowId: string) => `adfinem-workbench.run-dock.collapsed.${flowId}`;
const defaultDockHeightPct = 28;
const maxDefaultDockHeightPct = 34;

function RunDock({
  run,
  flowId,
  flowNodes,
  selectedId,
  recentRun,
  onRerun,
  onRerunFromFailure,
  onJumpToStep,
  onAcceptStatus
}: {
  run?: RunState;
  flowId: string;
  flowNodes: FlowNode[];
  selectedId?: string;
  recentRun?: RunHistoryItem;
  onRerun: () => void;
  onRerunFromFailure: (stepId: string) => void;
  onJumpToStep: (stepId: string) => void;
  onAcceptStatus: (stepId: string, status: number) => void;
}) {
  const [heightPct, setHeightPct] = useState<number>(() => readDockHeight(flowId));
  const [collapsed, setCollapsed] = useState<boolean>(() => readBool(dockCollapsedKey(flowId), !run));

  useEffect(() => {
    setHeightPct(readDockHeight(flowId));
    setCollapsed(readBool(dockCollapsedKey(flowId), !run));
  }, [flowId]);

  useEffect(() => {
    window.localStorage.setItem(dockHeightKey(flowId), String(heightPct));
  }, [heightPct, flowId]);

  useEffect(() => {
    window.localStorage.setItem(dockCollapsedKey(flowId), String(collapsed));
  }, [collapsed, flowId]);

  useEffect(() => {
    if (run?.status === "running" || run?.status === "failed") setCollapsed(false);
  }, [run?.status]);

  const verdict = run ?? recentRun;
  if (!verdict) return null;

  const status = verdict.status;
  const steps = run?.result?.steps ?? [];
  const runNodeIds = allFlowNodes(flowNodes).map((node) => node.id);
  const currentVisibleStepId = run?.currentStepId ? visibleNodeIdForRunStep(run.currentStepId, runNodeIds) : undefined;
  const firstFailure = steps.find((step) => step.status === "failed");
  const evidenceStep = firstFailure ?? [...steps].reverse().find((step) => step.api || step.unix);
  const selectedDiffersFromFailure = Boolean(firstFailure && selectedId && firstFailure.stepId !== selectedId);
  const historyFailure = !("result" in verdict) ? verdict.failedStep : undefined;
  const hasStepDetails = steps.length > 0;
  const canExpand = Boolean(run) || hasStepDetails;
  const expanded = !collapsed && canExpand;

  return (
    <section className={`run-dock ${status} ${expanded ? "" : "collapsed"}`} style={expanded ? { height: `${heightPct}%` } : undefined}>
      {expanded && <div className="run-dock-resize" onMouseDown={(event) => startDockResize(event, setHeightPct)} />}
      <header className="run-dock-head">
        <span className={`run-dock-status ${status}`}>{statusGlyph(status)}</span>
        <div className="run-dock-title">
          <b>Run {status}</b>
          {firstFailure && <span> at <code>{firstFailure.stepId}</code></span>}
          {!firstFailure && historyFailure && <span> at <code>{historyFailure}</code></span>}
          {!firstFailure && currentVisibleStepId && <span> running <code>{currentVisibleStepId}</code></span>}
          <small> - {stepCountSummary(verdict, flowNodes)}</small>
        </div>
        <div className="run-dock-actions">
          {verdict.evidenceDir && <button onClick={() => copyToClipboard(verdict.evidenceDir)}>Copy path</button>}
          {verdict.evidenceDir && <button onClick={() => openFolder(verdict.evidenceDir)}>Open folder</button>}
          {firstFailure && <button onClick={() => onRerunFromFailure(firstFailure.stepId)}>Re-run from failure</button>}
          <button onClick={onRerun}>Re-run</button>
          <button disabled={!canExpand} onClick={() => setCollapsed((value) => !value)}>{expanded ? "Collapse" : "Expand"}</button>
        </div>
      </header>
      {expanded && (
        <div className="run-dock-body">
          <div className="run-dock-col">
            <h6>Steps - {steps.length} of {flowNodes.length}</h6>
            {steps.length === 0 && (
              <p className="field-help">Run is starting. Step evidence will appear here as soon as the runner reports the first result.</p>
            )}
            {currentVisibleStepId && !steps.some((step) => visibleNodeIdForRunStep(step.stepId, runNodeIds) === currentVisibleStepId && step.status === "running") && (
              <div className="run-dock-step running">
                <span className="idx">...</span>
                <span className="dot running" />
                <button className="step-name" onClick={() => onJumpToStep(currentVisibleStepId)}>{currentVisibleStepId}</button>
                <strong>running</strong>
              </div>
            )}
            {steps.map((step, index) => (
              <div key={step.stepId} className={`run-dock-step ${step.status}`}>
                <span className="idx">{index + 1}</span>
                <span className={`dot ${step.status}`} />
                <button className="step-name" onClick={() => onJumpToStep(step.stepId)}>{step.stepId}</button>
                <strong>{step.status}</strong>
                {step.error?.message && <span className="err">{step.error.message}</span>}
              </div>
            ))}
          </div>
          {firstFailure && (
            <div className="run-dock-col detail">
              <h6>Failure detail - {firstFailure.stepId}</h6>
              {selectedDiffersFromFailure && (
                <p className="field-help">
                  You are editing <code>{selectedId}</code>; this evidence is for the failed run step <code>{firstFailure.stepId}</code>.
                </p>
              )}
              <pre>{firstFailure.error?.message}{firstFailure.error?.rawOutput ? `\n\n${firstFailure.error.rawOutput}` : ""}</pre>
            </div>
          )}
          {evidenceStep?.api && (
            <ApiEvidencePanel
              step={evidenceStep}
              onAcceptStatus={(statusCode) => onAcceptStatus(evidenceStep.stepId, statusCode)}
            />
          )}
          {evidenceStep?.unix && !evidenceStep.api && (
            <UnixEvidencePanel step={evidenceStep} />
          )}
        </div>
      )}
    </section>
  );
}

function UnixEvidencePanel({ step }: { step: RunStepResult }) {
  const [tab, setTab] = useState<"Command" | "Stdout" | "Stderr" | "Attempts">("Command");
  const unix = step.unix;
  if (!unix) return null;
  const last = unix.attempts[unix.attempts.length - 1];
  const displayCommand = unix.displayCommand ?? last?.displayCommand ?? unix.command;
  const scriptTracePath = unix.tracePath ?? last?.tracePath;
  const scriptErrno = unix.errno ?? last?.errno;
  const commandDisplay = [
    unix.fileUploads?.length
      ? `SFTP uploads\n${unix.fileUploads.map((upload) => `${upload.name}: ${upload.fileName ?? "-"} -> ${upload.remotePath} (${formatBytes(upload.sizeBytes) || "0 B"})${upload.paramName ? ` as ${upload.paramName}` : ""}${upload.appendedAsArg ? " / appended arg" : ""}${upload.status === "failed" ? ` / failed: ${upload.error ?? ""}` : ""}`).join("\n")}`
      : undefined,
    unix.fileDownloads?.length
      ? `Generated files\n${unix.fileDownloads.map((file) => [
        `${file.name}: ${file.remotePath ?? "-"}${file.decryptedRemotePath ? ` -> ${file.decryptedRemotePath}` : ""}`,
        file.localPath ? `downloaded to ${file.localPath}` : undefined,
        file.sizeBytes !== undefined ? formatBytes(file.sizeBytes) : undefined,
        file.decryptCommand ? `decrypt: ${file.decryptCommand}${file.decryptExitCode !== undefined ? ` (exit ${file.decryptExitCode})` : ""}` : undefined,
        file.status === "failed" ? `failed: ${file.error ?? ""}` : file.status
      ].filter(Boolean).join(" / ")).join("\n")}`
      : undefined,
    `Command\n${displayCommand}`,
    unix.command !== displayCommand ? `Shell-safe command sent over SSH\n${unix.command}` : undefined,
    scriptTracePath ? `Script-reported trace path\n${scriptTracePath}` : undefined,
    scriptErrno ? `Script-reported ERRNO\n${scriptErrno}` : undefined
  ].filter(Boolean).join("\n\n");
  return (
    <div className="run-dock-col api-evidence">
      <h6>Unix evidence - {step.stepId}</h6>
      <div className="api-evidence-summary">
        <strong className={unix.status === "passed" ? "ok" : "bad"}>{unix.status}</strong>
        {last?.exitCode !== undefined && <span>Exit {last.exitCode}</span>}
        {scriptErrno && <span>ERRNO {scriptErrno}</span>}
        <span>{unix.attempts.length} attempt{unix.attempts.length === 1 ? "" : "s"}</span>
        {unix.stdoutTruncated && <span>stdout truncated</span>}
        {unix.stderrTruncated && <span>stderr truncated</span>}
      </div>
      {last?.error && <p className="api-evidence-reason">{last.error}</p>}
      <div className="api-evidence-tabs">
        {(["Command", "Stdout", "Stderr", "Attempts"] as const).map((item) => (
          <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>
        ))}
      </div>
      {tab === "Command" && <EvidencePre value={commandDisplay} />}
      {tab === "Stdout" && <EvidencePre value={unix.stdout || "No stdout captured."} />}
      {tab === "Stderr" && <EvidencePre value={unix.stderr || "No stderr captured."} />}
      {tab === "Attempts" && <EvidencePre value={unix.attempts} />}
    </div>
  );
}

function ApiEvidencePanel({ step, onAcceptStatus }: { step: RunStepResult; onAcceptStatus: (status: number) => void }) {
  const [tab, setTab] = useState<"Body" | "Headers" | "Request" | "Assertions" | "Captures" | "Post-actions">("Body");
  const api = step.api;
  if (!api) return null;
  const response = api.response;
  return (
    <div className="run-dock-col api-evidence">
      <h6>API evidence - {step.stepId}</h6>
      <div className="api-evidence-summary">
        <span>Evidence: {api.visibility}</span>
        {response && <strong className={api.statusAccepted ? "ok" : "bad"}>HTTP {response.status}</strong>}
        {response && <span>{response.durationMs}ms</span>}
        {response && <span>{formatBytes(response.sizeBytes)}{response.bodyTruncated ? " truncated" : ""}</span>}
        <span>{api.expectedOutcome}</span>
        <span>Accepted: {api.acceptStatuses.length ? api.acceptStatuses.join(", ") : "2xx"}</span>
        {response && !api.statusAccepted && <button onClick={() => onAcceptStatus(response.status)}>Add status {response.status}</button>}
      </div>
      {api.failureReason && <p className="api-evidence-reason">{api.failureReason}</p>}
      <div className="api-evidence-tabs">
        {(["Body", "Headers", "Request", "Assertions", "Captures", "Post-actions"] as const).map((item) => (
          <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>
        ))}
      </div>
      {tab === "Body" && <EvidencePre value={responseBodyDisplay(response)} />}
      {tab === "Headers" && <EvidencePre value={response?.headers ?? {}} />}
      {tab === "Request" && <EvidencePre value={{ request: api.request, resolvedRequest: api.resolvedRequest }} />}
      {tab === "Assertions" && (
        <div className="evidence-table">
          {api.assertionResults.length === 0 ? <p>No assertions configured.</p> : api.assertionResults.map((assertion, index) => (
            <div key={index} className={assertion.passed ? "passed" : "failed"}>
              <strong>{assertion.passed ? "passed" : "failed"}</strong>
              <code>{assertionSummary(assertion.assertion)}</code>
              {assertion.message && <span>{assertion.message}</span>}
            </div>
          ))}
        </div>
      )}
      {tab === "Captures" && (
        <div className="evidence-table">
          {api.evidenceCaptures.length === 0 ? <p>No captures configured.</p> : api.evidenceCaptures.map((capture) => (
            <div key={capture.name} className={capture.published ? "passed" : capture.status === "extracted" ? "warn" : "failed"}>
              <strong>{capture.name}</strong>
              <code>{capture.expression}</code>
              <span>{capture.status}{capture.published ? " / published" : capture.status === "extracted" ? " / not published" : ""}</span>
              {capture.value !== undefined && <code>{displayEvidenceValue(capture.value)}</code>}
              {capture.message && <span>{capture.message}</span>}
            </div>
          ))}
        </div>
      )}
      {tab === "Post-actions" && <p className="field-help">No post-action evidence for this API step.</p>}
    </div>
  );
}

function EvidencePre({ value }: { value: unknown }) {
  return <pre className="evidence-pre">{typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2)}</pre>;
}

function responseBodyDisplay(response: ApiResponseEvidence | undefined): unknown {
  if (!response) return "No HTTP response was received.";
  if (response.bodyPreviewKind === "binary") return `${response.body}\nContent-Type: ${response.contentType || "unknown"}\nSize: ${formatBytes(response.sizeBytes)}`;
  if (response.bodyJson !== undefined) return response.bodyJson;
  return response.bodyText ?? response.body ?? "";
}

function assertionSummary(assertion: ApiAssertion): string {
  if (assertion.type === "status") return `status ${Array.isArray(assertion.value) ? assertion.value.join(", ") : assertion.value}`;
  if ("path" in assertion) return `${assertion.type} ${assertion.path}`;
  if ("header" in assertion) return `${assertion.type} ${assertion.header}`;
  return `${assertion.type} ${assertion.value}`;
}

function displayEvidenceValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function formatBytes(value: number | undefined): string {
  if (!value) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function readNumber(key: string, defaultValue: number): number {
  const value = Number(window.localStorage.getItem(key) ?? "");
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

function readDockHeight(flowId: string): number {
  return Math.min(maxDefaultDockHeightPct, Math.max(18, readNumber(dockHeightKey(flowId), defaultDockHeightPct)));
}

function readBool(key: string, defaultValue: boolean): boolean {
  const value = window.localStorage.getItem(key);
  return value == null ? defaultValue : value === "true";
}

function copyToClipboard(text: string) {
  void navigator.clipboard?.writeText(text);
}

function openFolder(path: string) {
  void api<{ ok: boolean }>("/api/open-path", { method: "POST", body: { path } }).catch((error) => {
    window.alert(error instanceof Error ? error.message : String(error));
  });
}

function statusGlyph(status: string): string {
  if (status === "passed") return "OK";
  if (status === "failed") return "!";
  if (status === "running" || status === "stopping") return "...";
  return "-";
}

function stepCountSummary(verdict: RunState | RunHistoryItem, nodes: FlowNode[]): string {
  const completed = "result" in verdict ? verdict.result?.steps?.length : undefined;
  const total = nodes.length;
  const count = typeof completed === "number"
    ? `${completed} of ${total}`
    : verdict.status === "passed" && total > 0
      ? `${total} of ${total}`
      : `${total} step${total === 1 ? "" : "s"}`;
  const duration = "durationMs" in verdict && verdict.durationMs != null ? ` - ${(verdict.durationMs / 1000).toFixed(1)}s` : "";
  return `${count}${duration}`;
}

function startDockResize(event: React.MouseEvent<HTMLElement>, setHeightPct: (next: number) => void) {
  event.preventDefault();
  const startY = event.clientY;
  const startHeight = (event.currentTarget.parentElement as HTMLElement).offsetHeight;
  const total = window.innerHeight;
  const onMove = (moveEvent: MouseEvent) => {
    const next = startHeight + (startY - moveEvent.clientY);
    setHeightPct(Math.min(70, Math.max(15, (next / total) * 100)));
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function RunHistoryList({ runs }: { runs: RunHistoryItem[] }) {
  if (!runs.length) return <p className="field-help">No completed runs for this workflow yet.</p>;
  return (
    <div className="run-history">
      {runs.slice(0, 8).map((run) => (
        <div key={run.runId} className={`history-row ${run.status}`}>
          <History size={14} />
          <div>
            <strong>{run.status}</strong>
            <span>{run.startedAt ? new Date(run.startedAt).toLocaleString() : run.runId}</span>
            {run.failedStep && <small>Failed at {run.failedStep}</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

function EnvironmentManager({
  environments,
  activeName,
  onSelect,
  onSave,
  onClose
}: {
  environments: EnvironmentRecord[];
  activeName: string;
  onSelect: (name: string) => void;
  onSave: (currentName: string, next: EnvironmentRecord) => void;
  onClose: () => void;
}) {
  const current = environments.find((env) => env.name === activeName) ?? defaultEnvironment(activeName);
  const [editingName, setEditingName] = useState(current.name);
  const [draft, setDraft] = useState<EnvironmentRecord>(cloneEnvironment(current));
  const sshHosts = draft.sshHosts ?? {};

  function patchDraft(patch: Partial<EnvironmentRecord>) {
    setDraft((value) => ({ ...value, ...patch }));
  }

  function patchOracle(patch: NonNullable<EnvironmentRecord["oracle"]>) {
    setDraft((value) => ({ ...value, oracle: { ...(value.oracle ?? {}), ...patch } }));
  }

  function patchSshHost(hostRef: string, patch: NonNullable<EnvironmentRecord["sshHosts"]>[string]) {
    setDraft((value) => ({
      ...value,
      sshHosts: {
        ...(value.sshHosts ?? {}),
        [hostRef]: { ...(value.sshHosts?.[hostRef] ?? {}), ...patch }
      }
    }));
  }

  function renameSshHost(oldRef: string, newRef: string) {
    const next: NonNullable<EnvironmentRecord["sshHosts"]> = {};
    for (const [key, value] of Object.entries(sshHosts)) next[key === oldRef ? newRef : key] = value;
    patchDraft({ sshHosts: next });
  }

  function removeSshHost(hostRef: string) {
    const next = { ...sshHosts };
    delete next[hostRef];
    patchDraft({ sshHosts: next });
  }

  return (
    <section className="environment-manager">
      <div className="environment-manager-header">
        <div>
          <h2>Environment Management</h2>
          <p>Edit the same environment file used by CLI runs: <code>config/environments.yaml</code>.</p>
        </div>
        <button onClick={onClose}>Close</button>
      </div>
      <div className="environment-manager-body">
        <div className="environment-list">
          {environments.map((env) => (
            <button key={env.name} className={env.name === editingName ? "selected" : ""} onClick={() => {
              setEditingName(env.name);
              setDraft(cloneEnvironment(env));
              onSelect(env.name);
            }}>
              {env.name}
            </button>
          ))}
          <button onClick={() => {
            const next = defaultEnvironment(uniqueEnvironmentName(environments));
            setEditingName(next.name);
            setDraft(next);
            onSelect(next.name);
          }}>
            <Plus size={15} /> New environment
          </button>
        </div>

        <div className="environment-form">
          <div className="form-grid two">
            <label>Name<input value={draft.name} onChange={(event) => patchDraft({ name: event.target.value })} /></label>
            <label>API base URL<input value={draft.apiBaseUrl ?? ""} onChange={(event) => patchDraft({ apiBaseUrl: event.target.value })} /></label>
            <label className="toggle-line">
              <input type="checkbox" checked={Boolean(draft.apiTlsInsecure)} onChange={(event) => patchDraft({ apiTlsInsecure: event.target.checked })} />
              Allow expired/self-signed API TLS certificates
            </label>
          </div>

          <h3>Oracle</h3>
          <div className="form-grid three">
            <label>User<input value={draft.oracle?.user ?? ""} onChange={(event) => patchOracle({ user: event.target.value })} /></label>
            <label>Password<input value={draft.oracle?.password ?? ""} onChange={(event) => patchOracle({ password: event.target.value })} /></label>
            <label>Connect string<input value={draft.oracle?.connectString ?? ""} onChange={(event) => patchOracle({ connectString: event.target.value })} /></label>
          </div>

          <h3>SSH Hosts</h3>
          {Object.entries(sshHosts).map(([hostRef, host]) => (
            <div className="ssh-host-row" key={hostRef}>
              <label>Host ref<input value={hostRef} onChange={(event) => renameSshHost(hostRef, event.target.value)} /></label>
              <label>Host<input value={host.host ?? ""} onChange={(event) => patchSshHost(hostRef, { host: event.target.value })} /></label>
              <label>User<input value={host.username ?? ""} onChange={(event) => patchSshHost(hostRef, { username: event.target.value })} /></label>
              <label>Password<input value={host.password ?? ""} onChange={(event) => patchSshHost(hostRef, { password: event.target.value })} /></label>
              <label>Private key<input value={host.privateKeyPath ?? ""} onChange={(event) => patchSshHost(hostRef, { privateKeyPath: event.target.value })} /></label>
              <label>Shell<input value={host.shell ?? ""} onChange={(event) => patchSshHost(hostRef, { shell: event.target.value })} placeholder="bash" /></label>
              <label className="toggle-line">
                <input type="checkbox" checked={Boolean(host.loginShell)} onChange={(event) => patchSshHost(hostRef, { loginShell: event.target.checked })} />
                Run commands in login shell
              </label>
              <button onClick={() => removeSshHost(hostRef)}>Remove</button>
            </div>
          ))}
          <button onClick={() => patchSshHost(uniqueHostRef(sshHosts), {})}><Plus size={15} /> Add SSH host</button>

          <div className="button-row right">
            <button className="primary" onClick={() => onSave(editingName, draft)}><Save size={15} /> Save environment</button>
          </div>
        </div>
      </div>
    </section>
  );
}

function FlowSettingsCard({
  environmentName,
  variables,
  onChange
}: {
  environmentName: string;
  variables: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = Object.keys(variables).length;
  return (
    <section className={`flow-settings-card ${open ? "open" : ""}`}>
      <button className="flow-settings-head" onClick={() => setOpen((value) => !value)}>
        <span>Workflow inputs</span>
        <strong>{environmentName}</strong>
        <small>{count} variable{count === 1 ? "" : "s"}</small>
        <span>{open ? "Hide" : "Edit"}</span>
      </button>
      {open && (
        <div className="flow-settings-body">
          <MappingEditor value={variables} outputs={[]} onChange={onChange} />
          <p className="field-help">Postman environment imports and workflow-level variables live here for the selected environment.</p>
        </div>
      )}
    </section>
  );
}

function EmptyInspector() {
  return (
    <section className="empty-inspector">
      <h2>No Step Selected</h2>
      <p>Select a step on the canvas, or click an insert point to add a new API, DB, or Unix action.</p>
    </section>
  );
}

function StepHeaderCard({
  node,
  index,
  total,
  apiOperations,
  onChange,
  onRemove,
  onDuplicate,
  onMove
}: {
  node: FlowNode;
  index: number;
  total: number;
  apiOperations: Record<string, ApiOperationEntry>;
  onChange: (patch: Partial<FlowNode>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const typeClass = nodeVisualType(node);
  const typeLabel = node.type === "api_operation" ? "api_operation" : node.type;
  const editLabel = typeClass === "control" ? "control block" : "step";
  return (
    <div className={`step-header-card ${typeClass}`}>
      <div className="type-icon">{typeClass === "api" ? "API" : typeClass === "db" ? "DB" : typeClass === "control" ? "CTL" : "BAT"}</div>
      <div className="step-header-body">
        <div className="step-header-eyebrow">Editing {editLabel} - #{index + 1} of {total}</div>
        <div className="step-header-name">
          <input className="step-name-inline" value={node.label ?? ""} onChange={(event) => onChange({ label: event.target.value })} placeholder={node.id} />
          <span className={`type-tag ${typeClass}`}>{typeLabel}</span>
        </div>
        <div className="pill-strip">
          <span className="pill">id: {node.id}</span>
          <button className={`pill toggle ${node.disabled ? "off" : "on"}`} onClick={() => onChange({ disabled: !node.disabled })}>
            {node.disabled ? "disabled" : "enabled"}
          </button>
          <button className={`pill toggle ${node.continueOnFailure ? "on" : ""}`} onClick={() => onChange({ continueOnFailure: !node.continueOnFailure })}>
            continue on fail: {node.continueOnFailure ? "on" : "off"}
          </button>
          <input className="section-inline" value={node.section ?? ""} onChange={(event) => onChange({ section: event.target.value || undefined })} placeholder="section" />
          {node.type === "api_operation" && node.operation && (
            <span className="pill" title={node.operation}>tpl: {operationLabel(node.operation, apiOperations[node.operation])}</span>
          )}
        </div>
      </div>
      <div className="step-header-menu">
        <button className="icon-button" onClick={() => setMenuOpen((value) => !value)} aria-label="Step actions">...</button>
        {menuOpen && (
          <div className="step-header-menu-pop" onMouseLeave={() => setMenuOpen(false)}>
            <button onClick={() => { onMove(-1); setMenuOpen(false); }} disabled={index === 0}>Move up</button>
            <button onClick={() => { onMove(1); setMenuOpen(false); }} disabled={index === total - 1}>Move down</button>
            <button onClick={() => { onDuplicate(); setMenuOpen(false); }}>Duplicate</button>
            <hr />
            <button className="danger" onClick={() => { onRemove(); setMenuOpen(false); }}>Remove step</button>
          </div>
        )}
      </div>
    </div>
  );
}

function NodeIcon({ type }: { type: NodeType }) {
  if (type === "api_operation") return <Server size={18} />;
  if (type.startsWith("db")) return <Database size={18} />;
  if (type === "parallel" || type === "loop") return <Copy size={18} />;
  return <TerminalSquare size={18} />;
}

function nodeVisualType(node: FlowNode): "api" | "db" | "batch" | "control" {
  if (node.type === "api_operation") return "api";
  if (node.type === "unix_batch") return "batch";
  if (node.type === "parallel" || node.type === "loop") return "control";
  return "db";
}

function nodeTypeBadge(node: FlowNode): string {
  if (node.type === "api_operation") return "API";
  if (node.type === "unix_batch") return "Unix";
  if (node.type === "parallel") return "Parallel";
  if (node.type === "loop") return "Control";
  return "DB";
}

function apiOperationNode(name: string, operation?: ApiOperationEntry): FlowNode {
  return {
    id: uniqueId(name),
    label: operationLabel(name, operation),
    type: "api_operation",
    operation: name,
    input: defaultApiInputs(operation),
    request: operationToRequestSpec(operation),
    assertions: operation?.assertions
  };
}

function apiOperationNodeFromImportedRequest(request: ImportedApiRequest): FlowNode {
  return {
    id: uniqueId(request.name),
    label: request.name,
    type: "api_operation",
    operation: request.operationKey,
    input: Object.fromEntries(request.variableNames.map((name) => [name, request.variables?.[name] ?? ""])),
    request: request.request
  };
}

function queryNode(type: "db_query" | "db_assert" | "db_execute", query: string, catalogs?: Catalogs): FlowNode {
  return { id: uniqueId(query), label: query, type, query, params: defaultQueryParams(catalogs, query) };
}

function batchNode(batch: string, catalogs?: Catalogs): FlowNode {
  return { id: uniqueId(batch), label: batch, type: "unix_batch", batch, params: defaultBatchParams(catalogs, batch) };
}

function parallelNode(): FlowNode {
  const id = uniqueId("parallel");
  return {
    id,
    label: "Parallel block",
    type: "parallel",
    join: "all",
    branches: [
      { id: "branch_a", label: "Branch A", nodes: [] },
      { id: "branch_b", label: "Branch B", nodes: [] }
    ]
  };
}

function loopNode(mode: "count" | "foreach" = "count"): FlowNode {
  return {
    id: uniqueId(mode === "count" ? "count_loop" : "foreach_loop"),
    label: mode === "count" ? "Fixed-count loop" : "Foreach loop",
    type: "loop",
    loop: mode === "count"
      ? { mode: "count", count: 3, itemName: "item", maxIterations: 100 }
      : { mode: "foreach", items: "${items}", itemName: "item", maxIterations: 100 },
    nodes: []
  };
}

function defaultLoopDateCursor(): LoopDateCursor {
  return {
    outputName: "business_date",
    start: "",
    inputFormat: "DD/MM/YYYY",
    outputFormat: "DD/MM/YYYY",
    advance: {
      mode: "months",
      amount: 1
    }
  };
}

function loopDateOutputName(cursor: LoopDateCursor): string {
  return cursor.outputName?.trim() || "business_date";
}

function nodeSummary(node: FlowNode, apiOperations: Record<string, ApiOperationEntry>): string {
  if (node.type === "api_operation") {
    const request = { ...operationToRequestSpec(apiOperations[node.operation ?? ""]), ...(node.request ?? {}) };
    return `${request.method ?? "API"} ${request.path ?? node.operation ?? ""}`;
  }
  if (node.type === "parallel") return `${node.branches?.length ?? 0} branches / join ${node.join ?? "all"}`;
  if (node.type === "loop") {
    const base = node.loop?.mode === "foreach" ? `foreach ${String(node.loop.items ?? "")}` : `count ${String(node.loop?.count ?? 0)}`;
    return node.loop?.dateCursor ? `${base} / date ${loopDateOutputName(node.loop.dateCursor)}` : base;
  }
  return node.operation ?? node.query ?? node.batch ?? node.type;
}

function loopSummary(node: FlowNode): string {
  if (node.type !== "loop") return "";
  if (node.loop?.mode === "foreach") return `foreach ${String(node.loop.items ?? "")}`;
  return `count ${String(node.loop?.count ?? 0)}`;
}

function findNode(flow: FlowFile, id?: string): FlowNode | undefined {
  if (!id) return undefined;
  for (const node of allFlowNodes(flow.nodes)) {
    if (node.id === id) return node;
    const post = node.postActions?.find((action) => action.id === id);
    if (post) return post;
  }
  return undefined;
}

function allFlowNodes(nodes: FlowNode[]): FlowNode[] {
  const items: FlowNode[] = [];
  for (const node of nodes) {
    items.push(node);
    for (const action of node.postActions ?? []) items.push(action);
    if (node.type === "parallel") {
      for (const branch of node.branches ?? []) items.push(...allFlowNodes(branch.nodes));
    }
    if (node.type === "loop") items.push(...allFlowNodes(node.nodes ?? []));
  }
  return items;
}

function patchNodeDeep(node: FlowNode, id: string, patch: Partial<FlowNode>): FlowNode {
  if (node.id === id) return { ...node, ...patch };
  return {
    ...node,
    postActions: node.postActions?.map((action) => patchNodeDeep(action, id, patch)),
    branches: node.branches?.map((branch) => ({
      ...branch,
      nodes: branch.nodes.map((child) => patchNodeDeep(child, id, patch))
    })),
    nodes: node.nodes?.map((child) => patchNodeDeep(child, id, patch))
  };
}

function removeNodeDeep(nodes: FlowNode[], id: string): FlowNode[] {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) => ({
      ...node,
      postActions: node.postActions?.filter((action) => action.id !== id).map((action) => patchNodeDeep(action, "__never__", {})),
      branches: node.branches?.map((branch) => ({ ...branch, nodes: removeNodeDeep(branch.nodes, id) })),
      nodes: node.nodes ? removeNodeDeep(node.nodes, id) : undefined
    }));
}

function duplicateNodeDeep(nodes: FlowNode[], id: string): { nodes: FlowNode[]; copiedId?: string } {
  const directIndex = nodes.findIndex((node) => node.id === id);
  if (directIndex >= 0) {
    const copy = cloneNodeForDuplicate(nodes[directIndex]);
    return {
      nodes: [...nodes.slice(0, directIndex + 1), copy, ...nodes.slice(directIndex + 1)],
      copiedId: copy.id
    };
  }

  let copiedId: string | undefined;
  const nextNodes = nodes.map((node) => {
    if (copiedId) return node;
    const postResult = node.postActions ? duplicateNodeDeep(node.postActions, id) : undefined;
    if (postResult?.copiedId) {
      copiedId = postResult.copiedId;
      return { ...node, postActions: postResult.nodes };
    }

    if (node.branches) {
      const branches = node.branches.map((branch) => {
        if (copiedId) return branch;
        const result = duplicateNodeDeep(branch.nodes, id);
        if (result.copiedId) copiedId = result.copiedId;
        return { ...branch, nodes: result.nodes };
      });
      if (copiedId) return { ...node, branches };
    }

    if (node.nodes) {
      const result = duplicateNodeDeep(node.nodes, id);
      if (result.copiedId) {
        copiedId = result.copiedId;
        return { ...node, nodes: result.nodes };
      }
    }

    return node;
  });
  return { nodes: nextNodes, copiedId };
}

function moveNodeDeep(nodes: FlowNode[], id: string, direction: -1 | 1): { nodes: FlowNode[]; moved: boolean } {
  const index = nodes.findIndex((node) => node.id === id);
  if (index >= 0) {
    const target = index + direction;
    if (target < 0 || target >= nodes.length) return { nodes, moved: false };
    const next = [...nodes];
    const [node] = next.splice(index, 1);
    next.splice(target, 0, node);
    return { nodes: next, moved: true };
  }

  let moved = false;
  const nextNodes = nodes.map((node) => {
    if (moved) return node;
    const postResult = node.postActions ? moveNodeDeep(node.postActions, id, direction) : undefined;
    if (postResult?.moved) {
      moved = true;
      return { ...node, postActions: postResult.nodes };
    }

    if (node.branches) {
      const branches = node.branches.map((branch) => {
        if (moved) return branch;
        const result = moveNodeDeep(branch.nodes, id, direction);
        if (result.moved) moved = true;
        return { ...branch, nodes: result.nodes };
      });
      if (moved) return { ...node, branches };
    }

    if (node.nodes) {
      const result = moveNodeDeep(node.nodes, id, direction);
      if (result.moved) {
        moved = true;
        return { ...node, nodes: result.nodes };
      }
    }

    return node;
  });
  return { nodes: nextNodes, moved };
}

function cloneNodeForDuplicate(node: FlowNode): FlowNode {
  const copy = deepClone(node);
  refreshNodeIds(copy, uniqueId(copy.id));
  copy.label = `${node.label ?? node.id} copy`;
  return copy;
}

function refreshNodeIds(node: FlowNode, id: string): void {
  node.id = id;
  node.postActions = node.postActions?.map((action) => {
    refreshNodeIds(action, uniqueId(action.id));
    return action;
  });
  node.branches = node.branches?.map((branch) => ({
    ...branch,
    id: uniqueId(branch.id),
    nodes: branch.nodes.map((child) => {
      refreshNodeIds(child, uniqueId(child.id));
      return child;
    })
  }));
  node.nodes = node.nodes?.map((child) => {
    refreshNodeIds(child, uniqueId(child.id));
    return child;
  });
}

function wrapNodeInLoopDeep(nodes: FlowNode[], id: string, wrapper: FlowNode): { nodes: FlowNode[]; wrapped: boolean } {
  let wrapped = false;
  const nextNodes = nodes.map((node) => {
    if (node.id === id) {
      wrapped = true;
      return { ...wrapper, nodes: [node] };
    }

    const nextBranches = node.branches?.map((branch) => {
      const result = wrapNodeInLoopDeep(branch.nodes, id, wrapper);
      if (result.wrapped) wrapped = true;
      return { ...branch, nodes: result.nodes };
    });
    const nextChildNodes = node.nodes ? wrapNodeInLoopDeep(node.nodes, id, wrapper) : undefined;
    if (nextChildNodes?.wrapped) wrapped = true;

    return {
      ...node,
      branches: nextBranches,
      nodes: nextChildNodes?.nodes ?? node.nodes
    };
  });
  return { nodes: nextNodes, wrapped };
}

function wrapTopLevelRangeInLoop(nodes: FlowNode[], startId: string, endId: string, wrapper: FlowNode): { nodes: FlowNode[]; wrapped: boolean; count: number; wrappedIds: Set<string> } {
  const startIndex = nodes.findIndex((node) => node.id === startId);
  const endIndex = nodes.findIndex((node) => node.id === endId);
  if (startIndex < 0 || endIndex < startIndex) return { nodes, wrapped: false, count: 0, wrappedIds: new Set() };
  const range = nodes.slice(startIndex, endIndex + 1);
  if (range.length === 0 || range.some((node) => node.type === "loop")) return { nodes, wrapped: false, count: 0, wrappedIds: new Set() };
  const wrappedIds = new Set(range.map((node) => node.id));
  const loop = {
    ...wrapper,
    nodes: range
  };
  return {
    nodes: [...nodes.slice(0, startIndex), loop, ...nodes.slice(endIndex + 1)],
    wrapped: true,
    count: range.length,
    wrappedIds
  };
}

function remapEdgesForWrappedNode(edges: Array<{ from: string; to: string }>, nodeId: string, wrapperId: string): Array<{ from: string; to: string }> {
  return uniqueGraphEdges(edges.map((edge) => ({
    from: edge.from === nodeId ? wrapperId : edge.from,
    to: edge.to === nodeId ? wrapperId : edge.to
  })));
}

function remapEdgesForWrappedRange(edges: Array<{ from: string; to: string }>, wrappedIds: Set<string>, wrapperId: string): Array<{ from: string; to: string }> {
  return uniqueGraphEdges(edges.flatMap((edge) => {
    const fromWrapped = wrappedIds.has(edge.from);
    const toWrapped = wrappedIds.has(edge.to);
    if (fromWrapped && toWrapped) return [];
    return [{
      from: fromWrapped ? wrapperId : edge.from,
      to: toWrapped ? wrapperId : edge.to
    }];
  }));
}

function unwrapLoopDeep(nodes: FlowNode[], id: string): { nodes: FlowNode[]; unwrapped: boolean; selectId?: string } {
  const directIndex = nodes.findIndex((node) => node.id === id);
  if (directIndex >= 0 && nodes[directIndex].type === "loop") {
    const children = nodes[directIndex].nodes ?? [];
    return {
      nodes: [...nodes.slice(0, directIndex), ...children, ...nodes.slice(directIndex + 1)],
      unwrapped: true,
      selectId: children[0]?.id
    };
  }

  let unwrapped = false;
  let selectId: string | undefined;
  const nextNodes = nodes.map((node) => {
    if (unwrapped) return node;
    if (node.branches) {
      const branches = node.branches.map((branch) => {
        if (unwrapped) return branch;
        const result = unwrapLoopDeep(branch.nodes, id);
        if (result.unwrapped) {
          unwrapped = true;
          selectId = result.selectId;
        }
        return { ...branch, nodes: result.nodes };
      });
      if (unwrapped) return { ...node, branches };
    }
    if (node.nodes) {
      const result = unwrapLoopDeep(node.nodes, id);
      if (result.unwrapped) {
        unwrapped = true;
        selectId = result.selectId;
        return { ...node, nodes: result.nodes };
      }
    }
    return node;
  });

  return { nodes: nextNodes, unwrapped, selectId };
}

function loopAncestorIds(nodes: FlowNode[], id: string, ancestors: string[] = []): string[] {
  for (const node of nodes) {
    if (node.id === id) return ancestors;
    for (const action of node.postActions ?? []) {
      if (action.id === id) return ancestors;
    }
    if (node.type === "parallel") {
      for (const branch of node.branches ?? []) {
        const result = loopAncestorIds(branch.nodes, id, ancestors);
        if (result.length > 0 || branch.nodes.some((child) => child.id === id)) return result;
      }
    }
    if (node.type === "loop") {
      const nextAncestors = [...ancestors, node.id];
      const result = loopAncestorIds(node.nodes ?? [], id, nextAncestors);
      if (result.length > 0 || (node.nodes ?? []).some((child) => child.id === id)) return result;
    }
  }
  return [];
}

function repeatRangeTargets(flow: FlowFile, selectedId: string | undefined): RepeatRangeTarget[] {
  if (!selectedId) return [];
  const startIndex = flow.nodes.findIndex((node) => node.id === selectedId);
  if (startIndex < 0) return [];
  return flow.nodes.slice(startIndex + 1).map((node) => ({
    id: node.id,
    label: `${node.label || node.id} (${node.type})`
  }));
}

function rebuildEdges(flow: FlowFile): FlowFile {
  if (flow.ui?.manualEdges && flow.edges !== undefined) {
    const ids = new Set(flow.nodes.map((node) => node.id));
    return { ...flow, edges: uniqueGraphEdges((flow.edges ?? []).filter((edge) => ids.has(edge.from) && ids.has(edge.to))) };
  }
  const ui = flow.ui?.manualEdges ? { ...flow.ui, manualEdges: undefined } : flow.ui;
  if (flow.edges?.length && !isLinearSequence(flow)) {
    const ids = new Set(flow.nodes.map((node) => node.id));
    return {
      ...flow,
      edges: uniqueGraphEdges(flow.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))),
      ui: {
        ...(flow.ui ?? {}),
        manualEdges: true
      }
    };
  }
  return { ...flow, ui, edges: linearWorkflowEdges(flow.nodes) };
}

function linearWorkflowEdges(nodes: FlowNode[]): Array<{ from: string; to: string }> {
  return nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: nodes[index + 1].id }));
}

function currentWorkflowEdges(flow: FlowFile): Array<{ from: string; to: string }> {
  if (flow.ui?.manualEdges) return flow.edges ?? [];
  return flow.edges?.length ? flow.edges : linearWorkflowEdges(flow.nodes);
}

function isLinearSequence(flow: FlowFile): boolean {
  const expected = linearWorkflowEdges(flow.nodes).map((edge) => `${edge.from}->${edge.to}`);
  const actual = (flow.edges ?? []).map((edge) => `${edge.from}->${edge.to}`);
  return expected.length === actual.length && expected.every((edge, index) => edge === actual[index]);
}

function edgePairFromId(id: string): { from: string; to: string } | undefined {
  const match = id.match(/^edge:([^:]+):([^:]+)$/);
  if (!match) return undefined;
  const [, from, to] = match;
  if (!from || !to || from.startsWith("insert:") || to.startsWith("insert:") || from.startsWith("join:") || to.startsWith("join:")) return undefined;
  if (from.startsWith("parallel-join:") || to.startsWith("parallel-join:")) return undefined;
  return { from, to };
}

function uniqueGraphEdges(edges: Array<{ from: string; to: string }>): Array<{ from: string; to: string }> {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    if (!edge.from || !edge.to || edge.from === edge.to) return false;
    const key = `${edge.from}->${edge.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function environmentVariables(flow: FlowFile, environment: string): Record<string, unknown> {
  return flow.environmentInputs?.[environment]?.variables ?? {};
}

function environmentNodeInputs(flow: FlowFile, environment: string, nodeId: string): Record<string, unknown> {
  return flow.environmentInputs?.[environment]?.nodes?.[nodeId] ?? {};
}

function updateFlowEnvironmentInputs(flow: FlowFile, environment: string, patch: FlowEnvironmentInputSet): FlowFile {
  const current = flow.environmentInputs?.[environment] ?? {};
  return {
    ...flow,
    environmentInputs: {
      ...(flow.environmentInputs ?? {}),
      [environment]: cleanEnvironmentInputSet({
        ...current,
        ...patch,
        nodes: patch.nodes ?? current.nodes
      })
    }
  };
}

function updateFlowEnvironmentNodeInputs(flow: FlowFile, environment: string, nodeId: string, next: Record<string, unknown>): FlowFile {
  const current = flow.environmentInputs?.[environment] ?? {};
  const nodes = {
    ...(current.nodes ?? {}),
    [nodeId]: next
  };
  return updateFlowEnvironmentInputs(flow, environment, {
    ...current,
    nodes
  });
}

function cleanEnvironmentInputSet(inputSet: FlowEnvironmentInputSet): FlowEnvironmentInputSet {
  const variables = withoutEmptyEntries(inputSet.variables ?? {});
  const nodes = Object.fromEntries(
    Object.entries(inputSet.nodes ?? {})
      .map(([nodeId, values]) => [nodeId, withoutEmptyEntries(values)] as const)
      .filter(([, values]) => Object.keys(values).length > 0)
  );
  return {
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
    ...(Object.keys(nodes).length > 0 ? { nodes } : {})
  };
}

function withoutEmptyEntries(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key, entry]) => key.trim() && entry !== undefined && entry !== null && String(entry) !== "")
  );
}

function outputReferencesForSelection(flow: FlowFile, selectedId: string | undefined, catalogs: Catalogs | undefined): OutputReference[] {
  const items = flattenedTimeline(flow).filter((item) => !item.node.disabled);
  const selectedIndex = selectedId ? items.findIndex((item) => item.node.id === selectedId) : items.length;
  const priorItems = selectedIndex >= 0 ? items.slice(0, selectedIndex) : items;
  const refs: OutputReference[] = [];
  const seen = new Set<string>();

  for (const item of priorItems) {
    for (const output of nodeOutputNames(item.node, catalogs)) {
      const ref = `${item.node.id}.${output}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      refs.push({ ref, label: `${item.node.label || item.node.id} / ${output}` });
    }
  }

  return refs;
}

function flattenedTimeline(flow: FlowFile): Array<{ node: FlowNode; parentId?: string }> {
  const items: Array<{ node: FlowNode; parentId?: string }> = [];
  for (const node of flow.nodes) {
    items.push({ node });
    for (const postAction of node.postActions ?? []) items.push({ node: postAction, parentId: node.id });
    if (node.type === "parallel") {
      for (const branch of node.branches ?? []) {
        for (const child of allFlowNodes(branch.nodes)) items.push({ node: child, parentId: node.id });
      }
    }
    if (node.type === "loop") {
      for (const child of allFlowNodes(node.nodes ?? [])) items.push({ node: child, parentId: node.id });
    }
  }
  return items;
}

function buildWorkflowGraphModel(flow: FlowFile): WorkflowGraphModel {
  const nodes: WorkflowGraphModelNode[] = [];
  const edges: WorkflowGraphModelEdge[] = [];
  const explicitEdges = Boolean(flow.ui?.manualEdges) || (flow.edges ?? []).length > 0;
  const nodeIds = new Set<string>();
  const loopEndpoints = new Map<string, { first: string; last: string }>();

  const addNode = (node: WorkflowGraphModelNode) => {
    nodeIds.add(node.id);
    nodes.push(node);
  };
  const addEdge = (source: string, target: string, label?: string, className?: string, storedFrom = source, storedTo = target) => {
    if (!nodeIds.has(source) || !nodeIds.has(target)) return;
    edges.push({ id: `edge:${storedFrom}:${storedTo}`, source, target, label, className, deletable: isEditableWorkflowEdge(source, target, className) });
  };

  const insertId = (index: number) => `insert:${index}`;
  addNode({
    id: insertId(0),
    type: "insert",
    width: workflowInsertNodeWidth,
    height: workflowInsertNodeHeight,
    data: { index: 0 }
  });

  let previousId = insertId(0);
  flow.nodes.forEach((node, index) => {
    if (node.type === "loop") {
      const projected = addProjectedLoop(node, index);
      const first = projected.first ?? previousId;
      const last = projected.last ?? previousId;
      if (!explicitEdges && projected.first) addEdge(previousId, first);
      const nextInsertId = insertId(index + 1);
      addNode({
        id: nextInsertId,
        type: "insert",
        width: workflowInsertNodeWidth,
        height: workflowInsertNodeHeight,
        data: { index: index + 1 }
      });
      if (!explicitEdges) addEdge(last, nextInsertId);
      previousId = nextInsertId;
      return;
    }

    const savedPosition = flow.ui?.positions?.[node.id];
    addNode({
      id: node.id,
      type: "workflow",
      width: workflowGraphNodeWidth,
      height: workflowGraphNodeHeight,
      data: {
        node,
        topIndex: index,
        section: node.section,
        savedPosition
      }
    });
    if (!explicitEdges) addEdge(previousId, node.id);

    const postActions = node.postActions ?? [];
    let nextSource = node.id;
    if (postActions.length > 0) {
      const joinId = `join:${node.id}`;
      for (const action of postActions) {
        addNode({
          id: action.id,
          type: "workflow",
          width: workflowGraphNodeWidth,
          height: workflowGraphNodeHeight,
          data: {
            node: action,
            topIndex: index,
            parentId: node.id,
            parentKind: "postAction",
            parentLabel: node.label || node.id,
            section: action.section ?? node.section
          }
        });
        addEdge(node.id, action.id, "AND", "and-edge");
        addEdge(action.id, joinId, undefined, "and-edge");
      }
      addNode({
        id: joinId,
        type: "andJoin",
        width: workflowJoinNodeWidth,
        height: workflowJoinNodeHeight,
        data: { parentId: node.id }
      });
      nextSource = joinId;
    }

    if (node.type === "parallel" && (node.branches?.length ?? 0) > 0) {
      const joinId = `parallel-join:${node.id}`;
      for (const branch of node.branches ?? []) {
        for (const child of branch.nodes) {
          if (child.type === "loop") {
            const projected = addProjectedLoop(child, index);
            if (projected.first && projected.last) {
              addEdge(node.id, projected.first, branch.label ?? "branch", "and-edge");
              addEdge(projected.last, joinId, undefined, "and-edge");
            }
          } else {
            addNestedGraphNode(child, node, index, branch.label ?? branch.id);
            addEdge(node.id, child.id, branch.label ?? "branch", "and-edge");
            addEdge(child.id, joinId, undefined, "and-edge");
          }
        }
      }
      addNode({
        id: joinId,
        type: "andJoin",
        width: workflowJoinNodeWidth,
        height: workflowJoinNodeHeight,
        data: { parentId: node.id }
      });
      nextSource = joinId;
    }

    if (node.type === "loop" && (node.nodes?.length ?? 0) > 0) {
      let loopPrevious = node.id;
      for (const child of node.nodes ?? []) {
        addNestedGraphNode(child, node, index, "loop");
        addEdge(loopPrevious, child.id, loopPrevious === node.id ? "loop" : undefined, "loop-edge");
        loopPrevious = child.id;
      }
      addEdge(loopPrevious, node.id, "next", "loop-edge");
      nextSource = loopPrevious;
    }

    const nextInsertId = insertId(index + 1);
    addNode({
      id: nextInsertId,
      type: "insert",
      width: workflowInsertNodeWidth,
      height: workflowInsertNodeHeight,
      data: { index: index + 1 }
    });
    if (!explicitEdges) addEdge(nextSource, nextInsertId);
    previousId = nextInsertId;
  });

  if (explicitEdges) {
    for (const edge of flow.edges ?? []) {
      const source = loopEndpoints.get(edge.from)?.last ?? edge.from;
      const target = loopEndpoints.get(edge.to)?.first ?? edge.to;
      addEdge(source, target, undefined, undefined, edge.from, edge.to);
    }
  }

  return { nodes, edges };

  function addProjectedLoop(loop: FlowNode, topIndex: number, loopStack: string[] = []): { first?: string; last?: string } {
    const children = loop.nodes ?? [];
    const endpoints: Array<{ first?: string; last?: string }> = [];
    const summary = loopSummary(loop);
    const nextLoopStack = summary ? [...loopStack, summary] : loopStack;
    for (const child of children) {
      if (child.type === "loop") {
        endpoints.push(addProjectedLoop(child, topIndex, nextLoopStack));
      } else {
        addNestedGraphNode(child, loop, topIndex, loop.label || summary, summary, nextLoopStack);
        endpoints.push({ first: child.id, last: child.id });
      }
    }
    const visible = endpoints.filter((entry): entry is { first: string; last: string } => Boolean(entry.first && entry.last));
    for (let i = 0; i < visible.length - 1; i += 1) {
      addEdge(visible[i].last, visible[i + 1].first, undefined, "loop-edge");
    }
    const first = visible[0]?.first;
    const last = visible[visible.length - 1]?.last;
    if (first && last) loopEndpoints.set(loop.id, { first, last });
    return { first, last };
  }

  function addNestedGraphNode(child: FlowNode, parent: FlowNode, topIndex: number, parentLabel: string, parentLoopSummary?: string, parentLoopSummaries?: string[]) {
    addNode({
      id: child.id,
      type: "workflow",
      width: workflowGraphNodeWidth,
      height: workflowGraphNodeHeight,
      data: {
        node: child,
        topIndex,
        parentId: parent.id,
        parentKind: parent.type,
        parentLabel,
        parentLoopSummary,
        parentLoopSummaries,
        section: child.section ?? parent.section,
        savedPosition: flow.ui?.positions?.[child.id]
      }
    });
  }
}

function graphLayoutKey(model: WorkflowGraphModel): string {
  return JSON.stringify({
    nodes: model.nodes.map((node) => {
      const flowNode = node.data.node as FlowNode | undefined;
      return [node.id, node.type, flowNode?.type, flowNode?.section, node.data.parentId, node.data.index];
    }),
    edges: model.edges.map((edge) => [edge.source, edge.target, edge.label])
  });
}

async function layoutWorkflowGraph(model: WorkflowGraphModel): Promise<{ nodes: any[]; edges: any[] }> {
  const elk = await getGraphElk();
  const graph = await elk.layout({
    id: "workflow-root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "36",
      "elk.layered.spacing.nodeNodeBetweenLayers": "46",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX"
    },
    children: model.nodes.map((node) => ({
      id: node.id,
      width: node.width,
      height: node.height
    })),
    edges: model.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target]
    }))
  } as any);

  const positions = new Map<string, { x: number; y: number }>();
  for (const child of graph.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }

  const workflowNodes = model.nodes.map((node, index) => ({
    id: node.id,
    type: node.type,
    position: node.type === "workflow" && node.data.savedPosition ? node.data.savedPosition as { x: number; y: number } : positions.get(node.id) ?? { x: 0, y: index * 140 },
    draggable: node.type === "workflow",
    selectable: node.type === "workflow",
    data: node.data,
    style: { width: node.width, height: node.height }
  }));

  const sectionLanes = buildSectionLaneNodes(model.nodes, positions);
  const reactFlowEdges = model.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: "source-bottom",
    targetHandle: "target-top",
    type: "editable",
    label: edge.label,
    className: edge.className,
    deletable: Boolean(edge.deletable),
    selectable: Boolean(edge.deletable),
    markerEnd: { type: MarkerType.ArrowClosed },
    data: { deletable: Boolean(edge.deletable) },
    style: edge.className === "and-edge"
      ? { stroke: "#6d5d00", strokeWidth: 2 }
      : edge.className === "loop-edge"
        ? { stroke: "#0f6b5f", strokeWidth: 2, strokeDasharray: "6 4" }
        : { stroke: "#94a3b8", strokeWidth: 2 },
    labelStyle: { fill: edge.className === "loop-edge" ? "#0f6b5f" : "#6d5d00", fontWeight: 700 }
  }));

  return { nodes: [...sectionLanes, ...workflowNodes], edges: reactFlowEdges };
}

function isEditableWorkflowEdge(source: string, target: string, className?: string): boolean {
  if (className) return false;
  if (source.startsWith("insert:") || target.startsWith("insert:")) return false;
  if (source.startsWith("join:") || target.startsWith("join:")) return false;
  if (source.startsWith("parallel-join:") || target.startsWith("parallel-join:")) return false;
  return !source.includes(":") && !target.includes(":");
}

async function getGraphElk(): Promise<any> {
  graphElkPromise ??= import("elkjs/lib/elk.bundled.js").then((module) => {
    const ElkCtor = module.default ?? module;
    return new ElkCtor();
  });
  return graphElkPromise;
}

function buildSectionLaneNodes(nodes: WorkflowGraphModelNode[], positions: Map<string, { x: number; y: number }>): any[] {
  const sections = new Map<string, Array<{ node: WorkflowGraphModelNode; position: { x: number; y: number } }>>();
  for (const node of nodes) {
    if (node.type !== "workflow") continue;
    const section = String(node.data.section ?? "").trim();
    if (!section) continue;
    const position = positions.get(node.id);
    if (!position) continue;
    const items = sections.get(section) ?? [];
    items.push({ node, position });
    sections.set(section, items);
  }

  return [...sections.entries()].map(([section, items]) => {
    const minX = Math.min(...items.map((item) => item.position.x));
    const minY = Math.min(...items.map((item) => item.position.y));
    const maxX = Math.max(...items.map((item) => item.position.x + item.node.width));
    const maxY = Math.max(...items.map((item) => item.position.y + item.node.height));
    const subflow = section.toLowerCase().startsWith("subflow:");
    return {
      id: `lane:${safeGraphId(section)}`,
      type: "sectionLane",
      position: { x: minX - 42, y: minY - 54 },
      data: { label: section, subflow },
      draggable: false,
      selectable: false,
      zIndex: -10,
      style: {
        width: Math.max(360, maxX - minX + 84),
        height: Math.max(170, maxY - minY + 96)
      }
    };
  });
}

function safeGraphId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "section";
}

function runStatusMap(run: RunState | undefined, nodeIds: string[] = []): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const step of run?.result?.steps ?? []) {
    statuses[visibleNodeIdForRunStep(step.stepId, nodeIds)] = step.status;
  }
  if ((run?.status === "running" || run?.status === "stopping") && run.currentStepId) {
    statuses[visibleNodeIdForRunStep(run.currentStepId, nodeIds)] = "running";
  }
  return statuses;
}

function visibleNodeIdForRunStep(stepId: string, nodeIds: string[]): string {
  if (nodeIds.includes(stepId)) return stepId;
  const ordered = [...nodeIds].sort((a, b) => b.length - a.length);
  return ordered.find((id) => stepId.endsWith(`_${id}`)) ?? stepId;
}

function missingInputNames(node: FlowNode, catalogs: Catalogs | undefined, environmentInput: Record<string, unknown>): string[] {
  const values = node.type === "api_operation" ? node.input ?? node.params ?? {} : node.params ?? node.input ?? {};
  if (node.type === "unix_batch") {
    const batch = catalogs?.batches[node.batch ?? ""];
    const missingArgs = catalogParamKeys(node, catalogs).filter((key) => (
      Object.prototype.hasOwnProperty.call(values, key)
      && isEmptyInputValue(values[key])
      && isEmptyInputValue(environmentInput[key])
    ));
    const missingFiles = (batch?.inputFiles ?? [])
      .filter((file) => file.required !== false && !hasBatchInputFileValue(values[file.name]) && isEmptyInputValue(environmentInput[file.name]))
      .map((file) => file.name);
    return [...missingArgs, ...missingFiles];
  }
  return catalogParamKeys(node, catalogs).filter((key) => {
    const stepValue = values[key];
    const envValue = environmentInput[key];
    return isEmptyInputValue(stepValue) && isEmptyInputValue(envValue);
  });
}

function isEmptyInputValue(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

function nodeOutputNames(node: FlowNode, catalogs: Catalogs | undefined): string[] {
  if (node.type === "api_operation") {
    return uniqueStrings([...Object.keys(catalogs?.apiOperations[node.operation ?? ""]?.captures ?? {}), ...Object.keys(node.capture ?? {})]);
  }
  if (node.type === "db_query" || node.type === "db_assert" || node.type === "db_execute") {
    return uniqueStrings([...Object.keys(catalogs?.queries[node.query ?? ""]?.captures ?? {}), ...Object.keys(node.capture ?? {})]);
  }
  if (node.type === "unix_batch") {
    return uniqueStrings([...Object.keys(catalogs?.batches[node.batch ?? ""]?.captures ?? {}), ...Object.keys(node.capture ?? {})]);
  }
  return Object.keys(node.capture ?? {});
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function defaultDbQuery(mode: "query" | "execute" = "query"): QueryCatalogEntry {
  return {
    mode,
    description: "",
    sql: mode === "execute"
      ? "begin\n  -- call procedure or update setup data here\n  null;\nend;"
      : "select *\nfrom table_name\nwhere id = :id",
    params: mode === "query" ? { id: { required: true, type: "string" } } : {},
    captures: {},
    expect: mode === "query" ? { type: "rowCount", operator: ">", value: 0 } : undefined
  };
}

function defaultUnixBatch(): BatchCatalogEntry {
  return {
    description: "",
    hostRef: "qa_worker",
    command: "sh",
    fixedArgs: [],
    useWorkingDirectory: false,
    args: [],
    inputFiles: [],
    outputFiles: [],
    timeoutSeconds: 3600,
    success: { exitCodes: [0] },
    captures: {}
  };
}

function cloneUnixBatch(entry: BatchCatalogEntry): BatchCatalogEntry {
  return deepClone(entry);
}

function cleanUnixBatchDraft(entry: BatchCatalogEntry): BatchCatalogEntry {
  const args = (entry.args ?? [])
    .map((arg) => ({ name: arg.name.trim(), ...cleanParamSpec(arg) }))
    .filter((arg) => arg.name);
  const inputFiles = (entry.inputFiles ?? [])
    .map(cleanBatchInputFile)
    .filter((file) => file.name);
  const outputFiles = (entry.outputFiles ?? [])
    .map(cleanBatchOutputFile)
    .filter((file) => file.name);
  const environment = Object.fromEntries(Object.entries(entry.environment ?? {})
    .filter(([name, value]) => name.trim() && value !== undefined && value !== null && String(value).trim() !== "")
    .map(([name, value]) => [name.trim(), value]));
  const captures = Object.fromEntries(Object.entries(entry.captures ?? {})
    .filter(([name, expression]) => name.trim() && expression.trim())
    .map(([name, expression]) => [name.trim(), expression.trim()]));
  return cleanObject({
    description: entry.description?.trim() || undefined,
    hostRef: entry.hostRef.trim(),
    command: entry.command.trim(),
    fixedArgs: (entry.fixedArgs ?? []).filter((value) => String(value).trim() !== ""),
    workingDirectory: entry.workingDirectory?.trim() || undefined,
    useWorkingDirectory: entry.useWorkingDirectory === true ? true : undefined,
    environment: Object.keys(environment).length ? environment : undefined,
    args: args.length ? args : undefined,
    inputFiles: inputFiles.length ? inputFiles : undefined,
    outputFiles: outputFiles.length ? outputFiles : undefined,
    timeoutSeconds: entry.timeoutSeconds && entry.timeoutSeconds > 0 ? entry.timeoutSeconds : undefined,
    success: cleanBatchSuccess(entry.success),
    captures: Object.keys(captures).length ? captures : undefined
  }) as BatchCatalogEntry;
}

function cleanBatchInputFile(file: BatchInputFileSpec): BatchInputFileSpec {
  return cleanObject({
    name: file.name?.trim(),
    required: file.required === false ? false : file.required ? true : undefined,
    remotePath: file.remotePath?.trim() || undefined,
    paramName: file.paramName?.trim() || undefined,
    appendAsArg: file.appendAsArg || undefined
  }) as BatchInputFileSpec;
}

function cleanBatchOutputFile(file: BatchOutputFileSpec): BatchOutputFileSpec {
  return cleanObject({
    name: file.name?.trim(),
    required: file.required === false ? false : file.required ? true : undefined,
    source: file.source || undefined,
    pathPattern: file.pathPattern?.trim() || undefined,
    remotePath: file.remotePath?.trim() || undefined,
    download: file.download === false ? false : file.download ? true : undefined,
    decrypt: cleanDecryptSpec(file.decrypt)
  }) as BatchOutputFileSpec;
}

function cleanDecryptSpec(decrypt: BatchOutputFileSpec["decrypt"] | undefined): BatchOutputFileSpec["decrypt"] | undefined {
  if (!decrypt) return undefined;
  const cleaned = cleanObject({
    command: decrypt.command?.trim() || undefined,
    outputRemotePath: decrypt.outputRemotePath?.trim() || undefined,
    required: decrypt.required === false ? false : decrypt.required ? true : undefined
  });
  return Object.keys(cleaned).length ? cleaned as BatchOutputFileSpec["decrypt"] : undefined;
}

function cleanBatchSuccess(success: BatchCatalogEntry["success"] | undefined): BatchCatalogEntry["success"] | undefined {
  if (!success) return undefined;
  const exitCodes = (success.exitCodes ?? []).filter((value) => Number.isInteger(value));
  const requiredOutput = (success.requiredOutput ?? []).map((value) => value.trim()).filter(Boolean);
  const cleaned = cleanObject({
    exitCodes: exitCodes.length ? exitCodes : undefined,
    requiredOutput: requiredOutput.length ? requiredOutput : undefined
  });
  return Object.keys(cleaned).length ? cleaned as BatchCatalogEntry["success"] : undefined;
}

function cloneDbQuery(entry: QueryCatalogEntry): QueryCatalogEntry {
  return deepClone(entry);
}

function cleanDbQueryDraft(entry: QueryCatalogEntry): QueryCatalogEntry {
  const params = Object.fromEntries(Object.entries(entry.params ?? {})
    .filter(([name]) => name.trim())
    .map(([name, param]) => [bindParamName(name), cleanParamSpec(param)])
    .filter(([name]) => name));
  const captures = Object.fromEntries(Object.entries(entry.captures ?? {})
    .filter(([name, expression]) => name.trim() && expression.trim())
    .map(([name, expression]) => [name.trim(), expression.trim()]));
  return cleanObject({
    description: entry.description?.trim() || undefined,
    mode: entry.mode ?? "query",
    sql: entry.sql.trim(),
    params: Object.keys(params).length ? params : undefined,
    captures: Object.keys(captures).length ? captures : undefined,
    expect: entry.mode === "execute" ? undefined : cleanExpectation(entry.expect),
    maxRows: entry.maxRows && entry.maxRows > 0 ? entry.maxRows : undefined
  }) as QueryCatalogEntry;
}

function cleanParamSpec(param: CatalogParamSpec): CatalogParamSpec {
  return cleanObject({
    required: param.required === undefined ? undefined : Boolean(param.required),
    type: param.type || undefined,
    pattern: param.pattern?.trim() || undefined,
    luhn: param.luhn || undefined
  }) as CatalogParamSpec;
}

function cleanExpectation(expect: QueryExpectationSpec | undefined): QueryExpectationSpec | undefined {
  if (!expect) return undefined;
  return cleanObject({
    type: expect.type,
    column: expect.type === "rowCount" ? undefined : expect.column?.trim(),
    operator: expect.operator,
    value: expect.value
  }) as QueryExpectationSpec;
}

function parseExpectationValue(value: string, type: QueryExpectationSpec["type"]): unknown {
  if (type === "number" || type === "rowCount") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
  }
  if (type === "boolean") return value === "true" ? true : value === "false" ? false : value;
  return value;
}

function uniqueDbQueryId(queries: Record<string, QueryCatalogEntry>, seed: string): string {
  return uniqueKey(queries, seed);
}

function uniqueKey(value: Record<string, unknown>, seed: string): string {
  if (!Object.prototype.hasOwnProperty.call(value, seed)) return seed;
  let index = 2;
  while (Object.prototype.hasOwnProperty.call(value, `${seed}_${index}`)) index += 1;
  return `${seed}_${index}`;
}

function cleanObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ""));
}

function bindParamName(name: string): string {
  return String(name ?? "").trim().replace(/^:+/, "");
}

function captureHelpFor(node: FlowNode): React.ReactNode {
  if (node.type === "db_query" || node.type === "db_assert") {
    return <>DB query output is shaped as <code>{`{ rowCount, rows }`}</code>. Capture SQL columns with <code>{`$.rows[0].COLUMN_NAME`}</code> or capture row count with <code>$.rowCount</code>.</>;
  }
  if (node.type === "db_execute") {
    return <>DB execute output is shaped as <code>{`{ rowsAffected, outBinds }`}</code>. Capture affected rows with <code>$.rowsAffected</code> or out binds with <code>{`$.outBinds.NAME`}</code>.</>;
  }
  if (node.type === "unix_batch") {
    return <>Unix output includes exit code, stdout, and stderr. Capture with paths like <code>$.exitCode</code> or <code>regex:$.stdout:pattern</code>.</>;
  }
  return <>Use auth token captures on authentication steps. Business API steps usually capture fields like <code>$.case.id</code> or <code>$.result.id</code>.</>;
}

function capturePresetsFor(node: FlowNode, operation: ApiOperationEntry | undefined, catalogs: Catalogs | undefined): Array<{ name: string; expression: string }> {
  if (node.type === "db_query" || node.type === "db_assert") {
    const entry = catalogs?.queries[node.query ?? ""];
    const catalogCaptures = Object.entries(entry?.captures ?? {}).map(([name, expression]) => ({ name, expression }));
    const columnCaptures = inferSqlSelectColumns(entry?.sql).map((column) => ({
      name: camelFromSqlName(column),
      expression: `$.rows[0].${column}`
    }));
    return uniqueCapturePresets([
      ...catalogCaptures,
      ...columnCaptures,
      { name: "rowCount", expression: "$.rowCount" }
    ]);
  }
  if (node.type === "db_execute") {
    const entry = catalogs?.queries[node.query ?? ""];
    return uniqueCapturePresets([
      ...Object.entries(entry?.captures ?? {}).map(([name, expression]) => ({ name, expression })),
      { name: "rowsAffected", expression: "$.rowsAffected" }
    ]);
  }
  if (node.type === "unix_batch") {
    const entry = catalogs?.batches[node.batch ?? ""];
    return uniqueCapturePresets([
      ...Object.entries(entry?.captures ?? {}).map(([name, expression]) => ({ name, expression })),
      { name: "exitCode", expression: "$.exitCode" },
      { name: "stdout", expression: "$.stdout" }
    ]);
  }
  const context = [
    node.id,
    node.label,
    node.operation,
    operation?.description,
    operation?.path
  ].filter(Boolean).join(" ").toLowerCase();
  const responseInfo = [
    { name: "resultID", expression: "$.result.id" },
    { name: "errorCode", expression: "$.responseInfo.errorCode" },
    { name: "errorDescription", expression: "$.responseInfo.errorDescription" },
    { name: "responseUID", expression: "$.responseInfo.responseUID" }
  ];
  if (/(token|auth|login)/i.test(context)) {
    return [
      { name: "token", expression: "$.token" },
      { name: "accessToken", expression: "$.accessToken" },
      ...responseInfo
    ];
  }
  if (/(case|account|record|activity)/i.test(context)) {
    return [
      { name: "caseId", expression: "$.case.id" },
      ...responseInfo
    ];
  }
  return responseInfo;
}

function uniqueCapturePresets(values: Array<{ name: string; expression: string }>): Array<{ name: string; expression: string }> {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value.name || seen.has(value.name)) return false;
    seen.add(value.name);
    return true;
  });
}

function inferSqlSelectColumns(sql: string | undefined): string[] {
  if (!sql) return [];
  const match = sql.match(/\bselect\b([\s\S]+?)\bfrom\b/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((part) => {
      const cleaned = part.trim();
      const alias = cleaned.match(/\bas\s+([A-Za-z_][A-Za-z0-9_$#]*)\b/i)?.[1]
        ?? cleaned.match(/\s+([A-Za-z_][A-Za-z0-9_$#]*)$/)?.[1]
        ?? cleaned.match(/^([A-Za-z_][A-Za-z0-9_$#]*)$/)?.[1];
      return alias?.toUpperCase();
    })
    .filter((column): column is string => Boolean(column));
}

function camelFromSqlName(name: string): string {
  return name.toLowerCase().replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

function uniqueCaptureName(value: Record<string, unknown>, seed: string): string {
  if (!Object.prototype.hasOwnProperty.call(value, seed)) return seed;
  let index = 2;
  while (Object.prototype.hasOwnProperty.call(value, `${seed}_${index}`)) index += 1;
  return `${seed}_${index}`;
}

function renameKey(value: Record<string, unknown>, oldKey: string, newKey: string, onChange: (next: Record<string, unknown>) => void) {
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) next[key === oldKey ? newKey : key] = entry;
  onChange(next);
}

function defaultApiInputs(operation: ApiOperationEntry | undefined): Record<string, string> {
  return Object.fromEntries(Object.keys(operation?.params ?? {}).map((key) => [key, ""]));
}

function defaultQueryParams(catalogs: Catalogs | undefined, query: string): Record<string, string> {
  return Object.fromEntries(Object.keys(catalogs?.queries[query]?.params ?? {}).map((key) => [bindParamName(key), ""]));
}

function defaultBatchParams(catalogs: Catalogs | undefined, batch: string): Record<string, string> {
  void catalogs;
  void batch;
  return {};
}

function batchInputFileParamNames(batch: BatchCatalogEntry | undefined): string[] {
  return (batch?.inputFiles ?? []).flatMap((file) => {
    const names = [file.name];
    if (file.paramName && file.paramName !== file.name) names.push(file.paramName);
    return names;
  }).filter(Boolean);
}

function batchInputFileValue(value: unknown): BatchInputFileValue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as BatchInputFileValue;
}

function hasBatchInputFileValue(value: unknown): boolean {
  const file = batchInputFileValue(value);
  return Boolean(file?.localPath);
}

function catalogParamKeys(node: FlowNode, catalogs: Catalogs | undefined): string[] {
  if (node.type === "api_operation" && node.operation) return Object.keys(catalogs?.apiOperations[node.operation]?.params ?? {});
  if ((node.type === "db_query" || node.type === "db_assert" || node.type === "db_execute") && node.query) {
    return Object.keys(catalogs?.queries[node.query]?.params ?? {}).map(bindParamName).filter(Boolean);
  }
  if (node.type === "unix_batch" && node.batch) {
    const batch = catalogs?.batches[node.batch];
    const fileBackedArgs = new Set((batch?.inputFiles ?? []).map((file) => file.paramName || file.name));
    return (batch?.args ?? []).map((arg) => arg.name).filter((name) => !fileBackedArgs.has(name));
  }
  return [];
}

function normalizeFlowForSave(flow: FlowFile, catalogs: Catalogs | undefined): FlowFile {
  return cleanFlowUiMetadata({
    ...flow,
    name: isDefaultFlowName(flow.name) && flow.id !== "new_flow" ? flow.id : flow.name,
    environmentInputs: cleanEnvironmentInputs(flow.environmentInputs),
    nodes: flow.nodes.map((node) => normalizeNodeForSave(node, catalogs))
  });
}

function normalizeLoadedFlow(flow: FlowFile): FlowFile {
  const normalized = isDefaultFlowName(flow.name) && flow.id !== "new_flow"
    ? { ...flow, name: flow.id }
    : flow;
  return cleanFlowUiMetadata(normalized);
}

function cleanFlowUiMetadata(flow: FlowFile): FlowFile {
  if (!flow.ui?.positions) return flow;
  const ids = new Set(allFlowNodes(flow.nodes).map((node) => node.id));
  const positions = Object.fromEntries(Object.entries(flow.ui.positions).filter(([id]) => ids.has(id)));
  const hasPositions = Object.keys(positions).length > 0;
  const ui = {
    ...flow.ui,
    positions: hasPositions ? positions : undefined
  };
  return {
    ...flow,
    ui: Object.values(ui).some((value) => value !== undefined) ? ui : undefined
  };
}

function isDefaultFlowName(name: string | undefined): boolean {
  return !name || name.trim().toLowerCase() === "new flow";
}

function flowListTitle(item: FlowListItem): string {
  return isDefaultFlowName(item.name) ? item.id : item.name ?? item.id;
}

function flowListSubtitle(item: FlowListItem): string | undefined {
  return !isDefaultFlowName(item.name) && item.name !== item.id ? item.id : undefined;
}

function cleanEnvironmentInputs(value: FlowFile["environmentInputs"]): FlowFile["environmentInputs"] {
  const entries = Object.entries(value ?? {})
    .map(([environment, inputSet]) => [environment, cleanEnvironmentInputSet(inputSet)] as const)
    .filter(([environment, inputSet]) => environment.trim() && (Object.keys(inputSet.variables ?? {}).length > 0 || Object.keys(inputSet.nodes ?? {}).length > 0));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeNodeForSave(node: FlowNode, catalogs: Catalogs | undefined): FlowNode {
  if (node.type === "api_operation") {
    return {
      ...node,
      postActions: node.postActions?.map((action) => normalizeActionForSave(action, catalogs))
    };
  }
  if (node.type === "parallel") {
    return {
      ...node,
      branches: (node.branches ?? []).map((branch) => ({
        ...branch,
        nodes: branch.nodes.map((child) => normalizeNodeForSave(child, catalogs))
      }))
    };
  }
  if (node.type === "loop") {
    return {
      ...node,
      nodes: (node.nodes ?? []).map((child) => normalizeNodeForSave(child, catalogs))
    };
  }
  return normalizeActionForSave(node, catalogs);
}

function normalizeActionForSave(node: FlowNode, catalogs: Catalogs | undefined): FlowNode {
  if (node.type === "api_operation" && node.operation) {
    return {
      ...node,
      input: normalizeCatalogParams(node.input ?? node.params ?? {}, Object.keys(catalogs?.apiOperations[node.operation]?.params ?? {})),
      request: cleanRequest(node.request ?? {})
    };
  }
  if ((node.type === "db_query" || node.type === "db_assert" || node.type === "db_execute") && node.query) {
    const params = catalogs?.queries[node.query]?.params;
    if (!params || Object.keys(params).length === 0) return node;
    return {
      ...node,
      params: normalizeCatalogParams(node.params ?? node.input ?? {}, Object.keys(params), bindParamName)
    };
  }

  if (node.type === "unix_batch" && node.batch) {
    const batch = catalogs?.batches[node.batch];
    const args = batch?.args ?? [];
    const fileParamNames = batchInputFileParamNames(batch);
    if (args.length === 0 && fileParamNames.length === 0) return node;
    return {
      ...node,
      params: normalizePresentCatalogParams(node.params ?? node.input ?? {}, [...args.map((arg) => arg.name), ...fileParamNames])
    };
  }

  return node;
}

function normalizeCatalogParams(current: Record<string, unknown>, names: string[], normalizeName: (name: string) => string = (name) => name): Record<string, unknown> {
  if (!names.length) return current;
  const normalizedCurrent = Object.fromEntries(Object.entries(current).map(([name, value]) => [normalizeName(name), value]));
  return Object.fromEntries(names.map((rawName) => {
    const name = normalizeName(rawName);
    if (normalizedCurrent[name] !== undefined) return [name, normalizedCurrent[name]];
    return [name, ""];
  }));
}

function normalizePresentCatalogParams(current: Record<string, unknown>, names: string[], normalizeName: (name: string) => string = (name) => name): Record<string, unknown> {
  if (!names.length) return current;
  const allowed = new Set(names.map(normalizeName));
  return Object.fromEntries(
    Object.entries(current)
      .map(([name, value]) => [normalizeName(name), value] as const)
      .filter(([name]) => allowed.has(name))
  );
}

function operationToRequestSpec(operation: ApiOperationEntry | undefined): ApiRequestSpec {
  if (!operation) return {};
  return cleanRequest({
    method: operation.method,
    path: operation.path,
    headers: operation.headers,
    query: operation.query,
    body: operation.body,
    rawBody: operation.rawBody,
    bodyMode: operation.bodyMode,
    auth: operation.auth,
    acceptStatuses: operation.acceptStatuses
  });
}

function withGeneratedRequestHeaders(request: ApiRequestSpec): ApiRequestSpec {
  const headers = {
    ...generatedRequestHeaders(request),
    ...(request.headers ?? {})
  };
  return Object.keys(headers).length ? { ...request, headers } : request;
}

function generatedRequestHeaders(request: ApiRequestSpec): Record<string, string> | undefined {
  const headers: Record<string, string> = {
    Accept: "*/*",
    "Cache-Control": "no-cache"
  };
  if (request.bodyMode === "json") headers["Content-Type"] = "application/json";
  if (request.bodyMode === "urlencoded") headers["Content-Type"] = "application/x-www-form-urlencoded";
  return Object.keys(headers).length ? headers : undefined;
}

interface RequestOverride {
  path: string;
  from: unknown;
  to: unknown;
}

function computeOverrides(node: FlowNode, operation: ApiOperationEntry | undefined): RequestOverride[] {
  const template = operationToRequestSpec(operation);
  const instance = node.request ?? template;
  const overrides: RequestOverride[] = [];
  const diff = (path: string, from: unknown, to: unknown) => {
    if (from === to) return;
    if (to === undefined && (from === undefined || from === "")) return;
    overrides.push({ path, from, to });
  };

  diff("method", template.method, instance.method);
  diff("path", template.path, instance.path);
  diff("bodyMode", template.bodyMode, instance.bodyMode);
  diff("body", bodyText(template), bodyText(instance));
  diff("acceptStatuses", JSON.stringify(template.acceptStatuses ?? []), JSON.stringify(instance.acceptStatuses ?? []));

  for (const key of new Set([...Object.keys(template.headers ?? {}), ...Object.keys(instance.headers ?? {})])) {
    diff(`headers.${key}`, template.headers?.[key], instance.headers?.[key]);
  }

  for (const key of new Set([...Object.keys(template.query ?? {}), ...Object.keys(instance.query ?? {})])) {
    diff(`query.${key}`, template.query?.[key], instance.query?.[key]);
  }

  return overrides;
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "string") return value.length > 64 ? `${value.slice(0, 60)}...` : value;
  return JSON.stringify(value);
}

function batchCommandPreview(batch: BatchCatalogEntry): string {
  const env = Object.entries(batch.environment ?? {}).map(([name, value]) => `${name}=${String(value)}`).join(" ");
  const fixed = (batch.fixedArgs ?? []).map(String);
  const runtime = (batch.args ?? []).map((arg) => `<${arg.name}>`);
  const command = [batch.command || "<command>", ...fixed, ...runtime].join(" ");
  const withEnv = env ? `${env} ${command}` : command;
  return batch.useWorkingDirectory && batch.workingDirectory ? `cd ${batch.workingDirectory} && ${withEnv}` : withEnv;
}

function commandLineText(batch: BatchCatalogEntry): string {
  return shellJoin([batch.command, ...(batch.fixedArgs ?? []).map(String)].filter(Boolean));
}

function commandLinePatch(value: string): Pick<BatchCatalogEntry, "command" | "fixedArgs"> {
  const parts = parseShellWords(value);
  const [command = "", ...fixedArgs] = parts;
  return {
    command,
    fixedArgs: fixedArgs.length ? fixedArgs : []
  };
}

function parseShellWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current) words.push(current);
  return words;
}

function shellJoin(parts: string[]): string {
  return parts.map((part) => /^[A-Za-z0-9_./:=@%+-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`).join(" ");
}

function batchFixedArgsText(value: Array<string | number | boolean> | undefined): string {
  return (value ?? []).map(String).join("\n");
}

function parseScalarLines(value: string): Array<string | number | boolean> | undefined {
  const lines = parseTextLines(value).map(parseScalar);
  return lines.length ? lines : undefined;
}

function parseScalar(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  const numeric = Number(value);
  return value.trim() !== "" && Number.isFinite(numeric) && String(numeric) === value.trim() ? numeric : value;
}

function sqlPreview(sql: string | undefined): string {
  return (sql ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ")
    .slice(0, 220);
}

function cleanRequest(request: ApiRequestSpec): ApiRequestSpec {
  const normalized = {
    ...request,
    rawBody: request.bodyMode === "json" && typeof request.rawBody === "string"
      ? stripStandaloneBackslashLines(request.rawBody)
      : request.rawBody
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => {
    if (value === undefined || value === null) return false;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return false;
    return true;
  })) as ApiRequestSpec;
}

function stripStandaloneBackslashLines(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !/^\s*\\\s*$/.test(line))
    .join("\n");
}

function firstKey(value: Record<string, unknown> | undefined): string | undefined {
  return Object.keys(value ?? {})[0];
}

function firstExecutableQuery(catalogs: Catalogs | undefined): string | undefined {
  return Object.entries(catalogs?.queries ?? {}).find(([, entry]) => entry.mode === "execute")?.[0];
}

function firstReadQuery(catalogs: Catalogs | undefined): string | undefined {
  return Object.entries(catalogs?.queries ?? {}).find(([, entry]) => entry.mode !== "execute")?.[0];
}

function queryKeysForNodeType(catalogs: Catalogs | undefined, type: NodeType): string[] {
  return Object.entries(catalogs?.queries ?? {})
    .filter(([, entry]) => type === "db_execute" ? entry.mode === "execute" : entry.mode !== "execute")
    .map(([key]) => key);
}

function firstQueryForNodeType(catalogs: Catalogs | undefined, type: NodeType): string | undefined {
  return type === "db_execute" ? firstExecutableQuery(catalogs) : firstReadQuery(catalogs);
}

function uniqueId(seed: string): string {
  return `${seed.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}_${Date.now().toString(36).slice(-5)}`;
}

function environmentOptions(environments: EnvironmentRecord[], activeName: string): string[] {
  return uniqueStrings([activeName, ...environments.map((env) => env.name)]).filter(Boolean);
}

function environmentConfigForSave(env: EnvironmentRecord): Omit<EnvironmentRecord, "name"> {
  return {
    apiBaseUrl: env.apiBaseUrl ?? "",
    apiTlsInsecure: Boolean(env.apiTlsInsecure),
    oracle: {
      user: env.oracle?.user ?? "",
      password: env.oracle?.password ?? "",
      connectString: env.oracle?.connectString ?? ""
    },
    sshHosts: Object.fromEntries(Object.entries(env.sshHosts ?? {}).map(([hostRef, host]) => [hostRef, {
      host: host.host ?? "",
      username: host.username ?? "",
      password: host.password ?? "",
      privateKeyPath: host.privateKeyPath ?? "",
      shell: host.shell ?? "",
      loginShell: Boolean(host.loginShell)
    }]))
  };
}

function cloneEnvironment(env: EnvironmentRecord): EnvironmentRecord {
  return JSON.parse(JSON.stringify(env)) as EnvironmentRecord;
}

function defaultEnvironment(name = "NewEnv"): EnvironmentRecord {
  return {
    name,
    apiBaseUrl: "",
    apiTlsInsecure: false,
    oracle: {
      user: "",
      password: "",
      connectString: ""
    },
    sshHosts: {
      qa_worker: {
        host: "",
        username: "",
        password: "",
        privateKeyPath: "",
        shell: "bash",
        loginShell: true
      }
    }
  };
}

function uniqueEnvironmentName(environments: EnvironmentRecord[]): string {
  const existing = new Set(environments.map((env) => env.name));
  let index = 1;
  while (existing.has(`NewEnv${index}`)) index += 1;
  return `NewEnv${index}`;
}

function uniqueHostRef(hosts: NonNullable<EnvironmentRecord["sshHosts"]>): string {
  let index = 1;
  while (hosts[`host_${index}`]) index += 1;
  return `host_${index}`;
}

function stringifyRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry ?? "")]));
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStatusList(value: string): number[] | undefined {
  const statuses = value.split(",").map((entry) => Number(entry.trim())).filter((entry) => Number.isInteger(entry));
  return statuses.length ? statuses : undefined;
}

function parseNumberList(value: string): number[] | undefined {
  const numbers = value.split(",").map((entry) => Number(entry.trim())).filter((entry) => Number.isInteger(entry));
  return numbers.length ? numbers : undefined;
}

function parseTextLines(value: string): string[] {
  return value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

function bodyText(request: ApiRequestSpec): string {
  if (request.rawBody !== undefined) return request.rawBody;
  if (request.body !== undefined) return typeof request.body === "string" ? request.body : JSON.stringify(request.body, null, 2);
  return "";
}

function jsonText(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function parseJsonLoose(value: string): unknown {
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function defaultAssertion(type: ApiAssertion["type"]): ApiAssertion {
  if (type === "status") return { type, value: 200 };
  if (type === "header_exists") return { type, header: "content-type" };
  if (type === "header_equals") return { type, header: "content-type", value: "" };
  if (type === "body_contains" || type === "body_not_contains") return { type, value: "" };
  if (type === "jsonpath_exists") return { type, path: "$" };
  if (type === "jsonpath_contains") return { type, path: "$", value: "" };
  return { type, path: "$", value: "" };
}

function assertionTarget(assertion: ApiAssertion): string {
  if ("path" in assertion) return assertion.path;
  if ("header" in assertion) return assertion.header;
  if (assertion.type === "body_contains" || assertion.type === "body_not_contains") return assertion.value;
  return Array.isArray(assertion.value) ? assertion.value.join(",") : String(assertion.value);
}

function assertionValueText(assertion: ApiAssertion): string {
  if (assertion.type === "status") return Array.isArray(assertion.value) ? assertion.value.join(",") : String(assertion.value);
  if ("value" in assertion) return typeof assertion.value === "string" ? assertion.value : JSON.stringify(assertion.value);
  return "";
}

function setAssertionTarget(assertion: ApiAssertion, value: string): ApiAssertion {
  if ("path" in assertion) return { ...assertion, path: value };
  if ("header" in assertion) return { ...assertion, header: value };
  if (assertion.type === "body_contains" || assertion.type === "body_not_contains") return { ...assertion, value };
  if (assertion.type === "status") return { ...assertion, value: parseStatusList(value) ?? 200 };
  return assertion;
}

function setAssertionValue(assertion: ApiAssertion, value: string): ApiAssertion {
  if (assertion.type === "status") return { ...assertion, value: parseStatusList(value) ?? 200 };
  if (assertion.type === "jsonpath_equals" || assertion.type === "jsonpath_contains") return { ...assertion, value: parseJsonLoose(value) };
  if (assertion.type === "header_equals") return { ...assertion, value };
  if (assertion.type === "body_contains" || assertion.type === "body_not_contains") return { ...assertion, value };
  return assertion;
}

function operationLabel(key: string, operation: ApiOperationEntry | undefined): string {
  const prefix = operation?.method && operation?.path ? `${operation.method} ${operation.path}` : key;
  return operation?.source?.collectionName ? `${operation.source.collectionName} / ${prefix}` : prefix;
}

function cloneNodeWithFreshIds(node: FlowNode, prefix: string): FlowNode {
  const clone = deepClone(node);
  clone.id = uniqueId(`${prefix}_${node.id}`);
  clone.postActions = clone.postActions?.map((action) => ({ ...action, id: uniqueId(`${prefix}_${action.id}`) }));
  return clone;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function loadQuickApiKeys(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(quickApiStorageKey) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function writeInsertDropPayload(event: React.DragEvent, payload: InsertDropPayload) {
  const encoded = JSON.stringify(payload);
  event.dataTransfer.setData("application/x-adfinem-insert-step", encoded);
  event.dataTransfer.setData("text/plain", encoded);
  event.dataTransfer.effectAllowed = "copy";
}

function readInsertDropPayload(event: React.DragEvent): InsertDropPayload | undefined {
  const raw = event.dataTransfer.getData("application/x-adfinem-insert-step") || event.dataTransfer.getData("text/plain");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as InsertDropPayload;
    if (parsed.kind === "api-request" && parsed.request) return parsed;
    if (parsed.kind === "api-operation" && parsed.operation) return parsed;
    if (parsed.kind === "api-collection" && parsed.collectionId) return parsed;
    if (parsed.kind === "db-template-picker" && parsed.type) return parsed;
    if (parsed.kind === "db-template" && parsed.type && parsed.query) return parsed;
    if (parsed.kind === "unix-batch-picker") return parsed;
    if (parsed.kind === "unix-batch" && parsed.batch) return parsed;
    if (parsed.kind === "reusable-flow" && parsed.flowId) return parsed;
    if (parsed.kind === "control" && parsed.control) return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

function hasInsertDropPayload(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("application/x-adfinem-insert-step");
}

type ReferenceFix = { fromStep: string; toStep: string };

function staleReferenceFixes(validation?: ValidationState): ReferenceFix[] {
  const fixes = new Map<string, ReferenceFix>();
  const pattern = /references unknown step '([^']+)' in '([^']+)'\. Did you mean '([^']+)'\?/g;
  for (const message of validation?.errors ?? []) {
    for (const match of message.matchAll(pattern)) {
      const fromStep = match[1];
      const toStep = match[3];
      if (fromStep && toStep && fromStep !== toStep) fixes.set(`${fromStep}->${toStep}`, { fromStep, toStep });
    }
  }
  return [...fixes.values()];
}

function applyReferenceFixes(flow: FlowFile, fixes: ReferenceFix[]): FlowFile {
  return replaceReferences(flow, fixes) as FlowFile;
}

function replaceReferences(value: unknown, fixes: ReferenceFix[]): unknown {
  if (typeof value === "string") {
    return fixes.reduce((current, fix) => (
      current.replace(new RegExp(`\\$\\{${escapeRegExp(fix.fromStep)}\\.`, "g"), `\${${fix.toStep}.`)
    ), value);
  }
  if (Array.isArray(value)) return value.map((item) => replaceReferences(item, fixes));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceReferences(entry, fixes)]));
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const json = await response.json();
  if (!response.ok) {
    const error = new Error(json.error ?? JSON.stringify(json)) as Error & { payload?: unknown };
    error.payload = json;
    throw error;
  }
  return json as T;
}

function apiErrorPayload(error: unknown): unknown {
  return error && typeof error === "object" && "payload" in error
    ? (error as { payload?: unknown }).payload
    : undefined;
}

function validationFromPayload(payload: unknown): { ok: boolean; errors: string[]; warnings: string[] } | undefined {
  if (!payload || typeof payload !== "object" || !("validation" in payload)) return undefined;
  const validation = (payload as { validation?: unknown }).validation;
  if (!validation || typeof validation !== "object") return undefined;
  const candidate = validation as { ok?: unknown; errors?: unknown; warnings?: unknown };
  if (typeof candidate.ok !== "boolean" || !Array.isArray(candidate.errors) || !Array.isArray(candidate.warnings)) return undefined;
  return {
    ok: candidate.ok,
    errors: candidate.errors.map(String),
    warnings: candidate.warnings.map(String)
  };
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
