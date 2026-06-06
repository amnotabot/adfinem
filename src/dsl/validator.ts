import type { CatalogArg, CatalogParam, Catalogs, Scenario, ScenarioStep } from "./types.js";
import { registeredActions } from "../config/registry.js";
import { normalizeBindParamRecord } from "../adapters/db/query-catalog.js";
import { batchArgParamsForValidation, batchInputFiles, hasBatchInputFilePayload } from "../adapters/unix/batch-input-files.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings?: string[];
}

export function validateScenarioReferences(scenario: Scenario, catalogs: Catalogs, options: { knownEnvironments?: string[] } = {}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (options.knownEnvironments && options.knownEnvironments.length > 0
      && !options.knownEnvironments.includes(scenario.environment)) {
    warnings.push(
      `Scenario environment '${scenario.environment}' is not declared in config/environments.yaml. Known: ${options.knownEnvironments.join(", ")}.`
    );
  }
  const stepIds = new Set<string>();
  const availableVariables = new Set<string>(Object.keys(scenario.variables ?? {}));
  for (const key of Object.keys(scenario.tenant ?? {})) {
    availableVariables.add(`tenant.${key}`);
  }

  for (const step of scenario.steps) {
    if (step.control === "parallel" || step.action === "__parallel") {
      validateControlStep(step, catalogs, errors, warnings, stepIds, availableVariables);
      continue;
    }
    if (step.control === "loop" || step.action === "__loop") {
      validateControlStep(step, catalogs, errors, warnings, stepIds, availableVariables);
      const outputName = step.loop?.dateCursor?.outputName?.trim() || (step.loop?.dateCursor ? "business_date" : undefined);
      if (outputName) {
        availableVariables.add(outputName);
        availableVariables.add(`${step.id}.${outputName}`);
        availableVariables.add(`${step.id}.last.${outputName}`);
        availableVariables.add(`${step.id}.all.${outputName}`);
      }
      for (const [childId, captureName] of loopChildCaptureNames(step, catalogs)) {
        availableVariables.add(`${childId}.${captureName}`);
        availableVariables.add(`${step.id}.last.${childId}.${captureName}`);
        availableVariables.add(`${step.id}.all.${childId}.${captureName}`);
      }
      continue;
    }
    if (stepIds.has(step.id)) {
      errors.push(`Duplicate step id '${step.id}'.`);
    }
    stepIds.add(step.id);

    const action = registeredActions[step.action];
    if (!action) {
      if (step.via === "api" && catalogs.apiOperations[step.action]) {
        validateApiStep(step, catalogs, errors);
      } else {
        errors.push(`Step '${step.id}' uses unknown action '${step.action}'.`);
        continue;
      }
    } else if (step.via && !action.supportedVia.includes(step.via)) {
      errors.push(`Step '${step.id}' action '${step.action}' does not support via '${step.via}'. Supported: ${action.supportedVia.join(", ")}.`);
    }

    if (step.action === "db_assert" || step.action === "db_query" || step.action === "db_execute") {
      if (!step.query) errors.push(`Step '${step.id}' must specify query.`);
      if (step.query && !catalogs.queries[step.query]) errors.push(`Step '${step.id}' references unknown query '${step.query}'.`);
      if (step.action === "db_assert" && step.query && catalogs.queries[step.query] && !catalogs.queries[step.query].expect) {
        errors.push(`Step '${step.id}' uses db_assert but query '${step.query}' has no expect block.`);
      }
      if (step.action === "db_execute" && step.query && catalogs.queries[step.query]?.mode !== "execute") {
        errors.push(`Step '${step.id}' uses db_execute but query '${step.query}' is not marked mode: execute.`);
      }
      if (step.query && catalogs.queries[step.query]) {
        validateParams(
          step,
          normalizeBindParamRecord(catalogs.queries[step.query].params ?? {}),
          normalizeBindParamRecord(step.params ?? step.input ?? {}),
          errors,
          "query"
        );
      }
    }

    if (step.action === "unix_batch") {
      if (!step.batch) errors.push(`Step '${step.id}' must specify batch.`);
      if (step.batch && !catalogs.batches[step.batch]) errors.push(`Step '${step.id}' references unknown batch '${step.batch}'.`);
      if (step.batch && catalogs.batches[step.batch]) {
        const batch = catalogs.batches[step.batch];
        const params = step.params ?? step.input ?? {};
        validateBatchInputFiles(step, batch, params, errors);
        validateArgs(step, batch.args ?? [], batchArgParamsForValidation(params, batch), errors);
      }
    }

    if (step.via === "api") validateApiStep(step, catalogs, errors);

    const localVariables = new Set(Object.keys(step.input ?? step.params ?? {}));
    for (const variable of findVariableRefs(step)) {
      if (!availableVariables.has(variable) && !localVariables.has(variable)) {
        errors.push(`Step '${step.id}' references unknown variable '${variable}'.`);
      }
    }

    const apiCatalogCaptures = step.via === "api" ? catalogs.apiOperations[step.action]?.captures ?? {} : {};
    const queryCatalogCaptures = step.query ? catalogs.queries[step.query]?.captures ?? {} : {};
    const batchCatalogCaptures = step.batch ? catalogs.batches[step.batch]?.captures ?? {} : {};
    for (const captureName of [
      ...Object.keys(apiCatalogCaptures),
      ...Object.keys(queryCatalogCaptures),
      ...Object.keys(batchCatalogCaptures),
      ...Object.keys(step.capture ?? {})
    ]) {
      availableVariables.add(captureName);
      availableVariables.add(`${step.id}.${captureName}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings: warnings.length ? warnings : undefined };
}

function validateApiStep(step: ScenarioStep, catalogs: Catalogs, errors: string[]): void {
  const operation = catalogs.apiOperations[step.action];
  if (!operation) {
    errors.push(`Step '${step.id}' uses via api but no API operation '${step.action}' exists in api-operations.yaml.`);
    return;
  }
  validateParams(step, operation.params, step.input ?? step.params ?? {}, errors, "API variable");
}

function validateControlStep(
  step: ScenarioStep,
  catalogs: Catalogs,
  errors: string[],
  warnings: string[],
  stepIds: Set<string>,
  availableVariables: Set<string>
): void {
  if (stepIds.has(step.id)) errors.push(`Duplicate step id '${step.id}'.`);
  stepIds.add(step.id);
  if (step.control === "parallel" || step.action === "__parallel") {
    if (!step.branches?.length) errors.push(`Parallel step '${step.id}' must contain at least one branch.`);
    for (const branch of step.branches ?? []) {
      const nested = validateScenarioReferences({ id: `${step.id}_${branch.id}`, environment: "nested", variables: Object.fromEntries([...availableVariables].map((key) => [key, "available"])), steps: branch.steps }, catalogs);
      errors.push(...nested.errors.map((error) => `Parallel '${step.id}' branch '${branch.id}': ${error}`));
      warnings.push(...(nested.warnings ?? []).map((warning) => `Parallel '${step.id}' branch '${branch.id}': ${warning}`));
    }
  }
  if (step.control === "loop" || step.action === "__loop") {
    if (!step.steps?.length) errors.push(`Loop step '${step.id}' must contain at least one child step.`);
    if (step.loop?.mode === "count" && step.loop.count === undefined) errors.push(`Loop step '${step.id}' mode count requires loop.count.`);
    if (step.loop?.mode === "foreach" && step.loop.items === undefined) errors.push(`Loop step '${step.id}' mode foreach requires loop.items.`);
    const loopVariables = new Set(availableVariables);
    loopVariables.add(`${step.id}.index`);
    loopVariables.add(`${step.id}.number`);
    loopVariables.add(`${step.id}.total`);
    loopVariables.add(`${step.id}.item`);
    if (step.loop?.itemName) {
      loopVariables.add(step.loop.itemName);
      loopVariables.add(`${step.id}.${step.loop.itemName}`);
    }
    const outputName = step.loop?.dateCursor?.outputName?.trim() || (step.loop?.dateCursor ? "business_date" : undefined);
    if (outputName) {
      loopVariables.add(outputName);
      loopVariables.add(`${step.id}.${outputName}`);
      loopVariables.add(`${step.id}.last.${outputName}`);
      loopVariables.add(`${step.id}.all.${outputName}`);
    }
    const nested = validateScenarioReferences({ id: `${step.id}_loop`, environment: "nested", variables: Object.fromEntries([...loopVariables].map((key) => [key, "available"])), steps: step.steps ?? [] }, catalogs);
    errors.push(...nested.errors.map((error) => `Loop '${step.id}': ${error}`));
    warnings.push(...(nested.warnings ?? []).map((warning) => `Loop '${step.id}': ${warning}`));
  }
}

function loopChildCaptureNames(step: ScenarioStep, catalogs: Catalogs): Array<[string, string]> {
  const captures: Array<[string, string]> = [];
  const visit = (child: ScenarioStep) => {
    const catalogCaptures = child.via === "api"
      ? catalogs.apiOperations[child.action]?.captures ?? {}
      : child.query
        ? catalogs.queries[child.query]?.captures ?? {}
        : child.batch
          ? catalogs.batches[child.batch]?.captures ?? {}
          : {};
    for (const captureName of [...Object.keys(catalogCaptures), ...Object.keys(child.capture ?? {})]) {
      captures.push([child.id, captureName]);
    }
    if (child.control === "loop" || child.action === "__loop") {
      for (const nested of child.steps ?? []) visit(nested);
    }
    if (child.control === "parallel" || child.action === "__parallel") {
      for (const branch of child.branches ?? []) {
        for (const nested of branch.steps) visit(nested);
      }
    }
  };
  for (const child of step.steps ?? []) visit(child);
  return captures;
}

function validateParams(step: ScenarioStep, specs: Record<string, CatalogParam> | undefined, params: Record<string, unknown>, errors: string[], label: string): void {
  for (const [name, spec] of Object.entries(specs ?? {})) {
    const value = params[name];
    if (spec.required && (value === undefined || value === null || value === "")) {
      errors.push(`Step '${step.id}' is missing required ${label} param '${name}'.`);
      continue;
    }
    validateValue(step.id, name, value, spec, errors);
  }
}

function validateArgs(step: ScenarioStep, specs: CatalogArg[], params: Record<string, unknown>, errors: string[]): void {
  for (const spec of specs) {
    if (!Object.prototype.hasOwnProperty.call(params, spec.name)) continue;
    const value = params[spec.name];
    if (spec.required !== false && (value === undefined || value === null || value === "")) {
      errors.push(`Step '${step.id}' is missing required batch arg '${spec.name}'.`);
      continue;
    }
    validateValue(step.id, spec.name, value, spec, errors);
  }
}

function validateBatchInputFiles(step: ScenarioStep, batch: Catalogs["batches"][string], params: Record<string, unknown>, errors: string[]): void {
  for (const file of batchInputFiles(batch)) {
    const value = params[file.name];
    if (file.required !== false && !hasBatchInputFilePayload(value)) {
      errors.push(`Step '${step.id}' is missing required batch input file '${file.name}'.`);
    }
    const remotePath = value && typeof value === "object" && !Array.isArray(value)
      ? (value as { remotePath?: unknown }).remotePath
      : undefined;
    if (hasBatchInputFilePayload(value) && !file.remotePath && !remotePath) {
      errors.push(`Step '${step.id}' batch input file '${file.name}' needs a remote path.`);
    }
  }
}

function validateValue(stepId: string, name: string, value: unknown, spec: CatalogParam, errors: string[]): void {
  if (value === undefined || value === null) return;
  if (typeof value === "string" && /^\$\{[A-Za-z0-9_.-]+\}$/.test(value)) return;
  if (spec.type?.endsWith("[]")) {
    const expectedItemType = spec.type.slice(0, -"[]".length);
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) {
      errors.push(`Step '${stepId}' param '${name}' must contain at least one value.`);
      return;
    }
    for (const item of values) {
      if (typeof item !== expectedItemType) {
        errors.push(`Step '${stepId}' param '${name}' must be ${spec.type}; got ${typeof item} item.`);
      }
      if (spec.pattern && typeof item === "string" && !new RegExp(spec.pattern).test(item)) {
        errors.push(`Step '${stepId}' param '${name}' does not match ${spec.pattern}.`);
      }
    }
    return;
  }
  if (spec.type && typeof value !== spec.type) {
    errors.push(`Step '${stepId}' param '${name}' must be ${spec.type}; got ${typeof value}.`);
  }
  if (spec.pattern && typeof value === "string" && !new RegExp(spec.pattern).test(value)) {
    errors.push(`Step '${stepId}' param '${name}' does not match ${spec.pattern}.`);
  }
}

function findVariableRefs(value: unknown): string[] {
  const refs: string[] = [];
  const visit = (current: unknown) => {
    if (typeof current === "string") {
      for (const match of current.matchAll(/\$\{([A-Za-z0-9_.-]+)\}/g)) refs.push(match[1]);
      for (const match of current.matchAll(/\{\{([A-Za-z0-9_.-]+)\}\}/g)) refs.push(match[1]);
    } else if (Array.isArray(current)) {
      current.forEach(visit);
    } else if (current && typeof current === "object") {
      Object.values(current).forEach(visit);
    }
  };
  visit(value);
  return refs;
}
