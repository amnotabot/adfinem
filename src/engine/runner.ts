import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiStepEvidence, Catalogs, EvidenceVisibilityMode, LoopDateCursor, LoopDateFormat, QueryCatalogEntry, RunResult, Scenario, ScenarioStep, StepLayer, StepResult, UnixStepEvidence } from "../dsl/types.js";
import type { EnvironmentConfig } from "../config/environments.js";
import { EvidenceWriter } from "./evidence.js";
import { RunContext } from "./context.js";
import { cancelledStep, durationBetween, failedStep, hashInput, isCancellationError } from "./step-result.js";
import { RestClient } from "../adapters/api/rest-client.js";
import { SoapClient } from "../adapters/api/soap-client.js";
import { OracleClient } from "../adapters/db/oracle-client.js";
import { assertQueryResult } from "../adapters/db/assertions.js";
import { SshClient } from "../adapters/unix/ssh-client.js";
import { BatchRunner } from "../adapters/unix/batch-runner.js";
import { runBatch } from "../actions/run-eod.js";
import { writeHtmlReport } from "../reports/html-report.js";
import { writeJunitReport } from "../reports/junit-report.js";
import { extractCaptures, mergeCaptureSpecs } from "./captures.js";
import { applyEvidenceVisibility, evidenceVisibilityMode } from "../config/secrets.js";

export interface RunnerOptions {
  rootDir: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  onStepStart?: (event: { stepId: string; layer: StepLayer; startedAt: string; index: number }) => void;
  onStepResult?: (result: StepResult) => void;
}

export class ScenarioRunner {
  private readonly context: RunContext;
  private readonly evidence: EvidenceWriter;
  private readonly restClient: RestClient;
  private readonly soapClient: SoapClient;
  private readonly oracleClient: OracleClient;
  private readonly batchRunner: BatchRunner;
  private readonly visibility: EvidenceVisibilityMode;

  constructor(
    private readonly scenario: Scenario,
    private readonly catalogs: Catalogs,
    private readonly env: EnvironmentConfig,
    private readonly options: RunnerOptions
  ) {
    this.context = new RunContext(scenario);
    const runId = `${scenario.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    this.visibility = evidenceVisibilityMode();
    this.evidence = new EvidenceWriter(join(options.rootDir, "evidence", runId), this.visibility);
    this.restClient = new RestClient(env, options.rootDir);
    this.soapClient = new SoapClient();
    this.oracleClient = new OracleClient(env);
    this.batchRunner = new BatchRunner(new SshClient(env), options.rootDir);
  }

  async run(): Promise<RunResult> {
    await this.evidence.init();
    const startedAt = new Date().toISOString();
    const steps: StepResult[] = [];

    let cursor = 0;
    for (const step of this.scenario.steps) {
      if (this.isStopped()) {
        steps.push(cancelledStep(step.id, this.layerFor(step), new Date().toISOString(), step.input ?? step.params ?? {}));
        for (const skipped of this.scenario.steps.slice(steps.length)) {
          steps.push(this.skipStep(skipped, `Skipped because run was stopped before step '${step.id}'.`));
        }
        break;
      }
      const results = await this.executePlanStep(step, cursor);
      cursor += results.length;
      steps.push(...results);
      const controlResult = results[0] ?? results[results.length - 1];
      if (results.some((result) => result.status === "cancelled")) {
        for (const skipped of this.scenario.steps.slice(steps.length)) {
          steps.push(this.skipStep(skipped, `Skipped because run was stopped during step '${step.id}'.`));
        }
        break;
      }
      if (controlResult?.status === "failed" && !step.continueOnFailure) {
        for (const skipped of this.scenario.steps.slice(steps.length)) {
          steps.push(this.skipStep(skipped, `Skipped because previous step '${step.id}' failed.`));
        }
        break;
      }
    }

    const endedAt = new Date().toISOString();
    const startedMs = Date.parse(startedAt);
    const endedMs = Date.parse(endedAt);
    const durationMs = Number.isFinite(startedMs) && Number.isFinite(endedMs)
      ? Math.max(0, endedMs - startedMs)
      : undefined;
    const result: RunResult = {
      scenarioId: this.scenario.id,
      runId: basename(this.evidence.runDir) || this.scenario.id,
      status: steps.some((step) => step.status === "cancelled")
        ? "cancelled"
        : steps.some((step) => step.status === "failed") ? "failed" : "passed",
      startedAt,
      endedAt,
      evidenceDir: this.evidence.runDir,
      steps,
      durationMs
    };

    const visibleResult = applyEvidenceVisibility(result, this.visibility);
    const runResultPath = await this.evidence.writeJson("run-result.json", visibleResult);
    const reportPath = await writeHtmlReport(visibleResult);
    const junitPath = await writeJunitReport(visibleResult);
    await this.evidence.writeJson("evidence-manifest.json", buildEvidenceManifest(result, {
      runResultPath,
      reportPath,
      junitPath
    }));
    return visibleResult;
  }

  private async executePlanStep(step: ScenarioStep, index: number): Promise<StepResult[]> {
    if (step.control === "parallel" || step.action === "__parallel") return this.executeParallelStep(step, index);
    if (step.control === "loop" || step.action === "__loop") return this.executeLoopStep(step, index);
    return [await this.executeStep(step, index)];
  }

  private async executeParallelStep(step: ScenarioStep, index: number): Promise<StepResult[]> {
    const startedAt = new Date().toISOString();
    const branches = step.branches ?? [];
    const branchResults = await Promise.all(branches.map(async (branch, branchIndex) => {
      const results: StepResult[] = [];
      let localIndex = index + branchIndex + 1;
      for (const branchStep of branch.steps) {
        if (this.isStopped()) {
          results.push(cancelledStep(branchStep.id, this.layerFor(branchStep), new Date().toISOString(), branchStep.input ?? branchStep.params ?? {}));
          break;
        }
        const next = await this.executePlanStep(branchStep, localIndex);
        localIndex += next.length;
        results.push(...next);
        const failed = next[0]?.status === "failed" || next.some((result) => result.status === "cancelled");
        if (failed && !branchStep.continueOnFailure) break;
      }
      return { branch, results };
    }));

    const flattened = branchResults.flatMap((branch) => branch.results);
    const join = step.join ?? "all";
    const branchPassed = branchResults.map((branch) => branch.results.length > 0 && !branch.results.some((result) => result.status === "failed" || result.status === "cancelled"));
    const passed = join === "any" ? branchPassed.some(Boolean) : branchPassed.every(Boolean);
    const endedAt = new Date().toISOString();
    const group: StepResult = {
      stepId: step.id,
      layer: "engine",
      status: flattened.some((result) => result.status === "cancelled") ? "cancelled" : passed ? "passed" : "failed",
      startedAt,
      endedAt,
      durationMs: durationBetween(startedAt, endedAt),
      inputHash: hashInput({ branches: branches.map((branch) => branch.id), join }),
      captures: {},
      evidence: [],
      error: passed ? undefined : {
        message: `Parallel block '${step.id}' failed using '${join}' join semantics.`
      }
    };
    return [group, ...flattened];
  }

  private async executeLoopStep(step: ScenarioStep, index: number): Promise<StepResult[]> {
    const startedAt = new Date().toISOString();
    const iterations = this.loopIterations(step);
    const allResults: StepResult[] = [];
    const aggregate = new Map<string, unknown[]>();
    let failed = false;
    const loopSteps = step.steps ?? [];

    for (let i = 0; i < iterations.items.length; i += 1) {
      if (this.isStopped()) {
        allResults.push(cancelledStep(`${step.id}_${i}`, "engine", new Date().toISOString(), {}));
        failed = true;
        break;
      }
      this.context.set(`${step.id}.index`, i);
      this.context.set(`${step.id}.number`, i + 1);
      this.context.set(`${step.id}.total`, iterations.items.length);
      this.context.set(`${step.id}.item`, iterations.items[i]);
      if (iterations.itemName) {
        this.context.set(iterations.itemName, iterations.items[i]);
        this.context.set(`${step.id}.${iterations.itemName}`, iterations.items[i]);
      }
      const dateCursor = step.loop?.dateCursor;
      if (dateCursor) {
        const outputName = loopDateOutputName(dateCursor);
        const value = computeLoopDateCursorValue(dateCursor, i, (candidate) => this.context.resolve(candidate));
        this.context.set(outputName, value);
        this.context.set(`${step.id}.${outputName}`, value);
        this.context.set(`${step.id}[${i}].${outputName}`, value);
        this.context.set(`${step.id}.${i}.${outputName}`, value);
        this.context.set(`${step.id}.last.${outputName}`, value);
        const aggregateKey = `${step.id}.all.${outputName}`;
        const values = aggregate.get(aggregateKey) ?? [];
        values.push(value);
        aggregate.set(aggregateKey, values);
        this.context.set(aggregateKey, values);
      }

      for (const child of loopSteps) {
        const scopedChild = scopedLoopStep(child, step.id, i);
        const childResults = await this.executePlanStep(scopedChild, index + allResults.length + 1);
        allResults.push(...childResults);
        const publishable = childResults.filter((result) => result.status === "passed");
        for (const result of publishable) {
          for (const [capture, value] of Object.entries(result.captures)) {
            this.context.set(`${child.id}.${capture}`, value);
            this.context.set(`${step.id}[${i}].${child.id}.${capture}`, value);
            this.context.set(`${step.id}.${i}.${child.id}.${capture}`, value);
            this.context.set(`${step.id}.last.${child.id}.${capture}`, value);
            const aggregateKey = `${step.id}.all.${child.id}.${capture}`;
            const values = aggregate.get(aggregateKey) ?? [];
            values.push(value);
            aggregate.set(aggregateKey, values);
            this.context.set(aggregateKey, values);
          }
        }
        if (childResults[0]?.status === "failed" && !child.continueOnFailure) {
          failed = true;
          break;
        }
      }
      if (failed && !step.continueOnFailure) break;
    }

    const endedAt = new Date().toISOString();
    const group: StepResult = {
      stepId: step.id,
      layer: "engine",
      status: allResults.some((result) => result.status === "cancelled") ? "cancelled" : failed ? "failed" : "passed",
      startedAt,
      endedAt,
      durationMs: durationBetween(startedAt, endedAt),
      inputHash: hashInput(step.loop ?? {}),
      captures: Object.fromEntries(aggregate),
      evidence: [],
      error: failed ? { message: `Loop '${step.id}' failed before completing all iterations.` } : undefined
    };
    return [group, ...allResults];
  }

  private loopIterations(step: ScenarioStep): { items: unknown[]; itemName?: string } {
    const spec = step.loop ?? { mode: "count", count: 1 };
    const maxIterations = spec.maxIterations ?? 1000;
    if (spec.mode === "count") {
      const resolved = this.context.resolve(spec.count ?? 1);
      const count = Number(resolved);
      if (!Number.isInteger(count) || count < 0) throw new Error(`Loop '${step.id}' count must resolve to a non-negative integer.`);
      if (count > maxIterations) throw new Error(`Loop '${step.id}' count ${count} exceeds maxIterations ${maxIterations}.`);
      return { items: Array.from({ length: count }, (_value, index) => index), itemName: spec.itemName };
    }
    const resolved = this.context.resolve(spec.items);
    const items = Array.isArray(resolved) ? resolved : resolved === undefined || resolved === null ? [] : [resolved];
    if (items.length > maxIterations) throw new Error(`Loop '${step.id}' foreach item count ${items.length} exceeds maxIterations ${maxIterations}.`);
    return { items, itemName: spec.itemName ?? "item" };
  }

  private async executeStep(step: ScenarioStep, index: number): Promise<StepResult> {
    const startedAt = new Date().toISOString();
    const layer = this.layerFor(step);
    let resolvedInput: unknown = step.input ?? step.params ?? {};
    const evidence: string[] = [];
    let inputEvidenceWritten = false;
    this.options.onStepStart?.({ stepId: step.id, layer, startedAt, index });
    const finish = (result: StepResult): StepResult => {
      this.options.onStepResult?.(result);
      return result;
    };

    try {
      resolvedInput = this.context.resolve(step.input ?? step.params ?? {});
      evidence.push(await this.evidence.writeJson(`${step.id}.input.json`, resolvedInput));
      inputEvidenceWritten = true;
      if (this.options.dryRun) {
        const captures = await this.dryRunCaptures(step);
        this.publishCaptures(step.id, captures);
        const dryPayload = { step, resolvedInput, captures, context: this.context.snapshot() };
        evidence.push(await this.evidence.writeJson(`${step.id}.dry-run.json`, dryPayload));
        return finish(this.passedStep(step.id, layer, startedAt, resolvedInput, captures, evidence));
      }

      const result = await this.dispatch(step, resolvedInput as Record<string, unknown>, evidence, index);
      if (result.status === "failed") {
        return finish(this.failedEvaluatedStep(step.id, layer, startedAt, resolvedInput, result.captures, evidence, result.message ?? "Step failed.", result.api, result.unix));
      }
      this.publishCaptures(step.id, result.captures);
      return finish(this.passedStep(step.id, layer, startedAt, resolvedInput, result.captures, evidence, result.api, result.unix));
    } catch (error) {
      if (!inputEvidenceWritten) {
        const unresolvedInput = await this.evidence.writeJson(`${step.id}.input-unresolved.json`, resolvedInput).catch(() => undefined);
        if (unresolvedInput) evidence.push(unresolvedInput);
      }
      if (isCancellationError(error)) {
        return finish(cancelledStep(step.id, layer, startedAt, resolvedInput, evidence));
      }
      const failureEvidence = await this.writeFailureCheckpoint(step, startedAt, resolvedInput, error).catch(() => undefined);
      if (failureEvidence) evidence.push(failureEvidence);
      return finish(failedStep(step.id, layer, startedAt, resolvedInput, error, evidence));
    }
  }

  private async dispatch(step: ScenarioStep, input: Record<string, unknown>, evidence: string[], index: number): Promise<DispatchResult> {
    if (step.via === "api") {
      const operation = this.catalogs.apiOperations[step.action];
      if (!operation) throw new Error(`Unknown API operation '${step.action}'.`);
      const request = step.request ? this.context.resolve(step.request) : undefined;
      const result = operation.type === "soap"
        ? await this.soapClient.execute(operation, input)
        : await this.restClient.execute(operation, input, request, step.assertions ?? [], step.capture ?? {}, {
          expectedOutcome: step.expectedOutcome,
          captureOnFailure: step.captureOnFailure,
          visibility: this.visibility
        });
      if (operation.type === "soap") {
        const captures = { ...result.captures, ...pickExplicitCaptures(result.response, step.capture ?? {}) };
        evidence.push(await this.evidence.writeJson(`${step.id}.api.json`, result.evidencePayload));
        return { status: "passed", captures };
      }
      const api = result.apiEvidence;
      const stepFolder = stepEvidenceFolder(index, step.id);
      evidence.push(await this.evidence.writeJson(`${step.id}.api.json`, result.evidencePayload));
      if (api.request) evidence.push(await this.evidence.writeJsonPath(`${stepFolder}/request.json`, { request: api.request, resolvedRequest: api.resolvedRequest }));
      if (api.response) evidence.push(await this.evidence.writeJsonPath(`${stepFolder}/response.json`, api.response));
      evidence.push(await this.evidence.writeJsonPath(`${stepFolder}/assertions.json`, api.assertionResults));
      evidence.push(await this.evidence.writeJsonPath(`${stepFolder}/captures.json`, api.evidenceCaptures));
      return {
        status: api.finalStatus,
        captures: result.captures,
        api,
        message: api.failureReason
      };
    }

    if (step.action === "db_assert" || step.action === "db_query" || step.action === "db_execute") {
      if (!step.query) throw new Error(`${step.action} requires query.`);
      const entry = this.catalogs.queries[step.query];
      const stepFolder = stepEvidenceFolder(index, step.id);
      if (step.action === "db_execute") {
        if (entry.mode !== "execute") throw new Error(`DB Action Library template '${step.query}' must be marked mode: execute.`);
        const result = await this.oracleClient.execute(entry, input);
        const payload = { query: step.query, ...result };
        const captureResult = evaluateCaptures(payload, mergeCaptureSpecs(entry.captures, step.capture));
        const evidencePayload = { ...payload, captures: captureResult.captures, captureError: errorSummary(captureResult.error) };
        evidence.push(await this.evidence.writeJson(`${step.id}.db-execute.json`, evidencePayload));
        evidence.push(await this.evidence.writeJsonPath(`${stepFolder}/db-execute.json`, evidencePayload));
        if (captureResult.error) {
          return { status: "failed", captures: {}, message: dbCaptureFailureMessage(payload, captureResult.error) };
        }
        return { status: "passed", captures: captureResult.captures };
      }
      const rows = await this.oracleClient.query(entry, input);
      const payload = { query: step.query, rowCount: rows.length, rows };
      const assertionResult = evaluateDbExpectation(step.action, entry, rows);
      const captureResult = evaluateCaptures(payload, mergeCaptureSpecs(entry.captures, step.capture));
      const evidencePayload = {
        ...payload,
        assertionError: errorSummary(assertionResult.error),
        captures: captureResult.captures,
        captureError: errorSummary(captureResult.error)
      };
      evidence.push(await this.evidence.writeJson(`${step.id}.db.json`, evidencePayload));
      evidence.push(await this.evidence.writeJsonPath(`${stepFolder}/db.json`, evidencePayload));
      if (assertionResult.error) {
        return { status: "failed", captures: {}, message: dbQueryFailureMessage(payload, assertionResult.error) };
      }
      if (captureResult.error) {
        return { status: "failed", captures: {}, message: dbCaptureFailureMessage(payload, captureResult.error) };
      }
      return { status: "passed", captures: captureResult.captures };
    }

    if (step.action === "unix_batch") {
      if (!step.batch) throw new Error("unix_batch requires batch.");
      const stepFolder = stepEvidenceFolder(index, step.id);
      const result = await runBatch(this.batchRunner, this.catalogs.batches[step.batch], input, {
        attempts: step.retry?.attempts,
        delayMs: step.retry?.delaySeconds === undefined ? undefined : step.retry.delaySeconds * 1000,
        downloadDir: join(this.evidence.runDir, ...stepFolder.split("/"), "files"),
        signal: this.options.signal
      });
      evidence.push(await this.evidence.writeJson(`${step.id}.unix.json`, result));
      evidence.push(await this.evidence.writeJsonPath(`${stepFolder}/unix.json`, result));
      if (result.status !== "passed") {
        const last = result.attempts[result.attempts.length - 1];
        return {
          status: "failed",
          captures: {},
          unix: result,
          message: last?.error ?? `Batch '${step.batch}' failed.`
        };
      }
      const captures = extractCaptures(result, mergeCaptureSpecs(this.catalogs.batches[step.batch].captures, step.capture));
      if (Object.keys(captures).length > 0) {
        evidence.push(await this.evidence.writeJson(`${step.id}.unix-captures.json`, captures));
      }
      return { status: "passed", captures, unix: result };
    }

    throw new Error(`No executor for action '${step.action}' via '${step.via ?? ""}'.`);
  }

  private passedStep(stepId: string, layer: StepLayer, startedAt: string, input: unknown, captures: Record<string, unknown>, evidence: string[], api?: ApiStepEvidence, unix?: UnixStepEvidence): StepResult {
    const endedAt = new Date().toISOString();
    return {
      stepId,
      layer,
      status: "passed",
      startedAt,
      endedAt,
      durationMs: durationBetween(startedAt, endedAt),
      inputHash: hashInput(input),
      captures,
      evidence,
      api,
      unix
    };
  }

  private failedEvaluatedStep(stepId: string, layer: StepLayer, startedAt: string, input: unknown, captures: Record<string, unknown>, evidence: string[], message: string, api?: ApiStepEvidence, unix?: UnixStepEvidence): StepResult {
    const endedAt = new Date().toISOString();
    return {
      stepId,
      layer,
      status: "failed",
      startedAt,
      endedAt,
      durationMs: durationBetween(startedAt, endedAt),
      inputHash: hashInput(input),
      captures,
      evidence,
      api,
      unix,
      error: {
        message,
        rawOutput: api?.response
          ? `HTTP ${api.response.status} ${api.response.statusText}`
          : unix
            ? unixFailureSummary(unix)
            : undefined
      }
    };
  }

  private skipStep(step: ScenarioStep, reason: string): StepResult {
    const now = new Date().toISOString();
    return {
      stepId: step.id,
      layer: this.layerFor(step),
      status: "skipped",
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      inputHash: hashInput({}),
      captures: {},
      evidence: [],
      error: {
        message: reason
      }
    };
  }

  private async writeFailureCheckpoint(step: ScenarioStep, startedAt: string, input: unknown, error: unknown): Promise<string> {
    const err = error instanceof Error ? error : new Error(String(error));
    const context = this.context.snapshot();

    return await this.evidence.writeJson(`${step.id}.failure.json`, {
      step,
      input,
      error: {
        message: err.message,
        stack: err.stack
      },
      context,
      startedAt
    });
  }

  private layerFor(step: ScenarioStep): StepLayer {
    if (step.control || step.via === "control") return "engine";
    if (step.action === "db_assert" || step.action === "db_query" || step.action === "db_execute") return "db";
    if (step.action === "unix_batch") return "unix";
    if (step.via === "api") return "api";
    return "engine";
  }

  private async dryRunCaptures(step: ScenarioStep): Promise<Record<string, unknown>> {
    const captures: Record<string, unknown> = {};
    if (step.via === "api") {
      for (const name of Object.keys(this.catalogs.apiOperations[step.action]?.captures ?? {})) {
        captures[name] = `<dry-run:${name}>`;
      }
    }
    if (step.query) {
      for (const name of Object.keys(this.catalogs.queries[step.query]?.captures ?? {})) {
        captures[name] = `<dry-run:${name}>`;
      }
    }
    if (step.batch) {
      for (const name of Object.keys(this.catalogs.batches[step.batch]?.captures ?? {})) {
        captures[name] = `<dry-run:${name}>`;
      }
    }
    for (const name of Object.keys(step.capture ?? {})) {
      captures[name] = `<dry-run:${name}>`;
    }
    return captures;
  }

  private publishCaptures(stepId: string, captures: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(captures)) {
      this.context.set(name, value);
      this.context.set(`${stepId}.${name}`, value);
    }
  }

  private isStopped(): boolean {
    return Boolean(this.options.signal?.aborted);
  }
}

function scopedLoopStep(step: ScenarioStep, loopId: string, index: number): ScenarioStep {
  const scopedId = `${loopId}_${index}_${step.id}`;
  if (step.control === "parallel" || step.control === "loop" || step.action === "__parallel" || step.action === "__loop") {
    return {
      ...step,
      id: scopedId,
      branches: step.branches?.map((branch) => ({
        ...branch,
        steps: branch.steps.map((child) => scopedLoopStep(child, loopId, index))
      })),
      steps: step.steps?.map((child) => scopedLoopStep(child, loopId, index))
    };
  }
  return {
    ...step,
    id: scopedId
  };
}

function loopDateOutputName(cursor: LoopDateCursor): string {
  return cursor.outputName?.trim() || "business_date";
}

function computeLoopDateCursorValue(cursor: LoopDateCursor, index: number, resolve: <T>(value: T) => T): string {
  const startValue = resolve(cursor.start ?? "");
  if (typeof startValue !== "string" || !startValue.trim()) {
    throw new Error("Loop business date start value is required.");
  }
  const inputFormat = cursor.inputFormat ?? detectLoopDateFormat(startValue);
  const outputFormat = cursor.outputFormat ?? inputFormat;
  const base = parseLoopDate(startValue, inputFormat);
  const advance = cursor.advance ?? { mode: "months", amount: 1 };
  const amount = Math.max(1, Number(advance.amount ?? 1));
  let next: Date;

  if (advance.mode === "days") {
    next = addDays(base, amount * index);
  } else if (advance.mode === "months") {
    next = addMonthsClamped(base, amount * index);
  } else {
    const monthBase = addMonthsClamped(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1)), amount * index);
    if (advance.mode === "first_of_month") {
      next = monthBase;
    } else if (advance.mode === "end_of_month") {
      next = new Date(Date.UTC(monthBase.getUTCFullYear(), monthBase.getUTCMonth(), daysInMonth(monthBase.getUTCFullYear(), monthBase.getUTCMonth())));
    } else {
      const requestedDay = Math.max(1, Math.min(31, Number(advance.day ?? base.getUTCDate())));
      next = new Date(Date.UTC(monthBase.getUTCFullYear(), monthBase.getUTCMonth(), Math.min(requestedDay, daysInMonth(monthBase.getUTCFullYear(), monthBase.getUTCMonth()))));
    }
  }

  return formatLoopDate(next, outputFormat);
}

function detectLoopDateFormat(value: string): LoopDateFormat {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "YYYY-MM-DD";
  return "DD/MM/YYYY";
}

function parseLoopDate(value: string, format: LoopDateFormat): Date {
  const trimmed = value.trim();
  let year: number;
  let month: number;
  let day: number;
  if (format === "YYYY-MM-DD") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (!match) throw new Error(`Loop business date '${value}' must match YYYY-MM-DD.`);
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
    if (!match) throw new Error(`Loop business date '${value}' must match ${format}.`);
    year = Number(match[3]);
    if (format === "DD/MM/YYYY") {
      day = Number(match[1]);
      month = Number(match[2]);
    } else {
      month = Number(match[1]);
      day = Number(match[2]);
    }
  }

  const maxDay = daysInMonth(year, month - 1);
  if (month < 1 || month > 12 || day < 1 || day > maxDay) {
    throw new Error(`Loop business date '${value}' is not a valid calendar date.`);
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function formatLoopDate(date: Date, format: LoopDateFormat): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  if (format === "YYYY-MM-DD") return `${year}-${month}-${day}`;
  if (format === "MM/DD/YYYY") return `${month}/${day}/${year}`;
  return `${day}/${month}/${year}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function addMonthsClamped(date: Date, months: number): Date {
  const targetMonth = date.getUTCMonth() + months;
  const first = new Date(Date.UTC(date.getUTCFullYear(), targetMonth, 1));
  const day = Math.min(date.getUTCDate(), daysInMonth(first.getUTCFullYear(), first.getUTCMonth()));
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), day));
}

function daysInMonth(year: number, zeroBasedMonth: number): number {
  return new Date(Date.UTC(year, zeroBasedMonth + 1, 0)).getUTCDate();
}

interface DispatchResult {
  status: "passed" | "failed";
  captures: Record<string, unknown>;
  api?: ApiStepEvidence;
  unix?: UnixStepEvidence;
  message?: string;
}

function unixFailureSummary(unix: UnixStepEvidence): string | undefined {
  const last = unix.attempts[unix.attempts.length - 1];
  if (!last) return undefined;
  const displayCommand = last.displayCommand ?? unix.displayCommand ?? last.command;
  const parts = [
    `Command: ${displayCommand}`,
    last.command && last.command !== displayCommand
      ? `Shell-safe command: ${last.command}`
      : undefined,
    last.exitCode === undefined ? undefined : `Exit code: ${last.exitCode}`,
    last.tracePath ? `Script trace path: ${last.tracePath}` : undefined,
    last.errno ? `Script ERRNO: ${last.errno}` : undefined,
    last.stdout ? `stdout:\n${last.stdout}` : undefined,
    last.stderr ? `stderr:\n${last.stderr}` : undefined
  ].filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}

function stepEvidenceFolder(index: number, stepId: string): string {
  return `steps/${String(index + 1).padStart(2, "0")}_${stepId}`;
}

function pickExplicitCaptures(data: unknown, captureSpec: Record<string, string> | undefined): Record<string, unknown> {
  if (!captureSpec) return {};
  return extractCaptures(data, captureSpec);
}

function evaluateCaptures(payload: unknown, captureSpec: Record<string, string> | undefined): { captures: Record<string, unknown>; error?: Error } {
  try {
    return { captures: extractCaptures(payload, captureSpec) };
  } catch (error) {
    return { captures: {}, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function evaluateDbExpectation(action: string, entry: QueryCatalogEntry, rows: Record<string, unknown>[]): { error?: Error } {
  if (action !== "db_assert") return {};
  try {
    assertQueryResult(entry, rows);
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function errorSummary(error: Error | undefined): { message: string; stack?: string } | undefined {
  return error ? { message: error.message, stack: error.stack } : undefined;
}

function dbQueryFailureMessage(payload: { query: string; rowCount?: number; rows?: Record<string, unknown>[] }, error: Error): string {
  return `${error.message} ${dbPayloadDetails(payload)}`;
}

function dbCaptureFailureMessage(payload: { query: string; rowCount?: number; rows?: Record<string, unknown>[] }, error: Error): string {
  return `${error.message} ${dbPayloadDetails(payload)}`;
}

function dbPayloadDetails(payload: { query: string; rowCount?: number; rows?: Record<string, unknown>[] }): string {
  const rowCount = payload.rowCount ?? payload.rows?.length;
  const columns = availableColumns(payload.rows ?? []);
  const parts = [`DB query '${payload.query}' returned ${rowCount ?? 0} row${rowCount === 1 ? "" : "s"}.`];
  if ((rowCount ?? 0) === 0) parts.push("No rows were available to capture from.");
  if (columns.length > 0) parts.push(`Available columns: ${columns.join(", ")}.`);
  return parts.join(" ");
}

function availableColumns(rows: Record<string, unknown>[]): string[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row)))];
}

export async function ensureEvidenceRoot(rootDir: string): Promise<void> {
  await mkdir(join(rootDir, "evidence"), { recursive: true });
}

export function defaultRootDir(): string {
  return join(fileURLToPath(new URL("../..", import.meta.url)));
}

function buildEvidenceManifest(result: RunResult, paths: {
  runResultPath: string;
  reportPath: string;
  junitPath: string;
}): Record<string, unknown> {
  return {
    version: 1,
    scenarioId: result.scenarioId,
    runId: result.runId,
    status: result.status,
    evidenceModel: {
      flowEvidenceDir: result.evidenceDir,
      note: "Flow evidence contains scenario reports and per-step API, DB, and Unix evidence."
    },
    topLevelFiles: paths,
    steps: result.steps.map((step) => ({
      stepId: step.stepId,
      layer: step.layer,
      status: step.status,
      evidence: step.evidence
    }))
  };
}
