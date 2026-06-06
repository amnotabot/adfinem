export type StepStatus = "passed" | "failed" | "skipped" | "cancelled";
export type StepLayer = "api" | "db" | "unix" | "dsl" | "engine";

export interface Scenario {
  id: string;
  environment: string;
  tenant?: Record<string, string>;
  variables?: Record<string, unknown>;
  steps: ScenarioStep[];
}

export interface ScenarioStep {
  id: string;
  action: string;
  via?: string;
  retry?: {
    attempts?: number;
    delaySeconds?: number;
  };
  input?: Record<string, unknown>;
  params?: Record<string, unknown>;
  query?: string;
  batch?: string;
  request?: ApiRequestSpec;
  assertions?: ApiAssertion[];
  capture?: Record<string, string>;
  continueOnFailure?: boolean;
  expectedOutcome?: ExpectedOutcome;
  captureOnFailure?: boolean;
  control?: ControlStep;
  branches?: ScenarioBranch[];
  steps?: ScenarioStep[];
  loop?: LoopSpec;
  join?: ParallelJoinMode;
}

export type ControlStep = "parallel" | "loop";
export type ParallelJoinMode = "all" | "any" | "fail_fast";

export interface ScenarioBranch {
  id: string;
  label?: string;
  steps: ScenarioStep[];
}

export interface LoopSpec {
  mode: "count" | "foreach";
  count?: number | string;
  items?: unknown;
  itemName?: string;
  maxIterations?: number;
  dateCursor?: LoopDateCursor;
}

export type LoopDateFormat = "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";
export type LoopDateAdvanceMode = "days" | "months" | "nth_day_of_month" | "first_of_month" | "end_of_month";

export interface LoopDateCursor {
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

export interface QueryCatalogEntry {
  description?: string;
  mode?: "query" | "execute";
  sql: string;
  params?: Record<string, CatalogParam>;
  expect?: QueryExpectation;
  captures?: Record<string, string>;
  maxRows?: number;
}

export interface DbExecuteResult {
  status: "passed";
  rowsAffected?: number;
  outBinds?: Record<string, unknown>;
}

export interface QueryExpectation {
  type: "number" | "string" | "boolean" | "rowCount";
  column?: string;
  operator: "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains";
  value: unknown;
}

export interface BatchCatalogEntry {
  description?: string;
  hostRef: string;
  command: string;
  fixedArgs?: Array<string | number | boolean>;
  workingDirectory?: string;
  useWorkingDirectory?: boolean;
  environment?: Record<string, string | number | boolean>;
  args?: CatalogArg[];
  inputFiles?: BatchInputFileSpec[];
  outputFiles?: BatchOutputFileSpec[];
  timeoutSeconds?: number;
  success?: {
    exitCodes?: number[];
    requiredOutput?: string[];
  };
  captures?: Record<string, string>;
}

export interface BatchInputFileSpec {
  name: string;
  required?: boolean;
  remotePath?: string;
  paramName?: string;
  appendAsArg?: boolean;
}

export interface BatchOutputFileSpec {
  name: string;
  required?: boolean;
  source?: "stdout" | "stderr" | "both" | "explicit";
  pathPattern?: string;
  remotePath?: string;
  download?: boolean;
  decrypt?: BatchOutputDecryptSpec;
}

export interface BatchOutputDecryptSpec {
  command?: string;
  outputRemotePath?: string;
  required?: boolean;
}

export interface BatchInputFileValue {
  fileName?: string;
  localPath?: string;
  contentBase64?: string;
  remotePath?: string;
  sizeBytes?: number;
}

export interface BatchFileDownloadEvidence {
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
}

export interface BatchFileUploadEvidence {
  name: string;
  fileName?: string;
  localPath?: string;
  remotePath: string;
  sizeBytes: number;
  paramName?: string;
  appendedAsArg?: boolean;
  status: "uploaded" | "failed";
  error?: string;
}

export interface ApiOperationEntry {
  description?: string;
  type: "rest" | "soap";
  method?: ApiHttpMethod;
  path?: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  rawBody?: string;
  bodyMode?: ApiBodyMode;
  auth?: unknown;
  params?: Record<string, CatalogParam>;
  assertions?: ApiAssertion[];
  requestTemplate?: string;
  captures?: Record<string, string>;
  acceptStatuses?: number[];
  idempotent?: boolean;
  source?: {
    collectionId?: string;
    collectionName?: string;
    requestId?: string;
    folderPath?: string[];
  };
}

export type ApiHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
export type ApiBodyMode = "none" | "json" | "raw" | "formdata" | "urlencoded";

export interface ApiRequestSpec {
  method?: ApiHttpMethod;
  path?: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  rawBody?: string;
  bodyMode?: ApiBodyMode;
  auth?: unknown;
  acceptStatuses?: number[];
}

export type ApiAssertion =
  | { type: "status"; operator?: "in" | "="; value: number | number[] }
  | { type: "jsonpath_exists"; path: string }
  | { type: "jsonpath_equals"; path: string; value: unknown }
  | { type: "jsonpath_contains"; path: string; value: unknown }
  | { type: "header_exists"; header: string }
  | { type: "header_equals"; header: string; value: string }
  | { type: "body_contains"; value: string }
  | { type: "body_not_contains"; value: string };

export type ExpectedOutcome = "positive" | "negative" | "setup" | "teardown";
export type EvidenceVisibilityMode = "raw" | "redacted";

export interface ApiAssertionResult {
  assertion: ApiAssertion;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  message?: string;
}

export interface CaptureResult {
  name: string;
  expression: string;
  source: "bodyJson" | "bodyText" | "header" | "status" | "cookie";
  required: boolean;
  status: "extracted" | "missing" | "error";
  published: boolean;
  value?: unknown;
  message?: string;
}

export interface ApiRequestEvidence {
  method?: ApiHttpMethod;
  path?: string;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  auth?: unknown;
  body?: unknown;
}

export interface ApiResponseEvidence {
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

export interface ApiTransportErrorEvidence {
  kind: "dns" | "timeout" | "tls" | "connection" | "invalid_url" | "runtime" | "unknown";
  message: string;
  code?: string;
  stackSafe?: string;
  timeoutMs?: number;
  retryable: boolean;
}

export interface ApiStepEvidence {
  visibility: EvidenceVisibilityMode;
  expectedOutcome: ExpectedOutcome;
  acceptStatuses: number[];
  statusAccepted: boolean;
  request?: ApiRequestEvidence;
  resolvedRequest?: ApiRequestEvidence;
  response?: ApiResponseEvidence;
  transportError?: ApiTransportErrorEvidence;
  assertionResults: ApiAssertionResult[];
  evidenceCaptures: CaptureResult[];
  publishedCaptures: Record<string, unknown>;
  finalStatus: "passed" | "failed";
  failureReason?: string;
}

export interface CatalogParam {
  required?: boolean;
  type?: "string" | "number" | "boolean" | "string[]" | "number[]" | "boolean[]";
  pattern?: string;
  luhn?: boolean;
}

export interface CatalogArg extends CatalogParam {
  name: string;
}

export interface Catalogs {
  queries: Record<string, QueryCatalogEntry>;
  batches: Record<string, BatchCatalogEntry>;
  apiOperations: Record<string, ApiOperationEntry>;
}

export interface StepResult {
  stepId: string;
  layer: StepLayer;
  status: StepStatus;
  startedAt: string;
  endedAt: string;
  durationMs?: number;
  inputHash: string;
  captures: Record<string, unknown>;
  evidence: string[];
  api?: ApiStepEvidence;
  unix?: UnixStepEvidence;
  error?: {
    message: string;
    stack?: string;
    rawOutput?: string;
  };
}

export interface UnixAttemptEvidence {
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

export interface UnixStepEvidence {
  command: string;
  displayCommand?: string;
  status: "passed" | "failed";
  fileUploads?: BatchFileUploadEvidence[];
  fileDownloads?: BatchFileDownloadEvidence[];
  attempts: UnixAttemptEvidence[];
  stdout: string;
  stderr: string;
  exitCode?: number;
  tracePath?: string;
  errno?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export type RunStatus = "passed" | "failed" | "cancelled";

export interface RunResult {
  scenarioId: string;
  runId: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string;
  evidenceDir: string;
  steps: StepResult[];
  durationMs?: number;
}
