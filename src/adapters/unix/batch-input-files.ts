import type { BatchCatalogEntry, BatchInputFileSpec, BatchInputFileValue } from "../../dsl/types.js";

export function batchInputFiles(entry: BatchCatalogEntry | undefined): BatchInputFileSpec[] {
  return entry?.inputFiles ?? [];
}

export function batchInputFileParamNames(entry: BatchCatalogEntry | undefined): string[] {
  return batchInputFiles(entry).flatMap((file) => {
    const names = [file.name];
    if (file.paramName && file.paramName !== file.name) names.push(file.paramName);
    return names;
  });
}

export function batchFileBackedArgNames(entry: BatchCatalogEntry | undefined): Set<string> {
  return new Set(batchInputFiles(entry).map((file) => file.paramName || file.name));
}

export function isBatchInputFileValue(value: unknown): value is BatchInputFileValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function hasBatchInputFilePayload(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (!isBatchInputFileValue(value)) return false;
  return Boolean(value.localPath || value.contentBase64);
}

export function batchArgParamsForValidation(params: Record<string, unknown>, entry: BatchCatalogEntry | undefined): Record<string, unknown> {
  const next = { ...params };
  for (const file of batchInputFiles(entry)) {
    const value = params[file.name];
    if (!hasBatchInputFilePayload(value)) continue;
    next[file.paramName || file.name] = isBatchInputFileValue(value)
      ? value.remotePath || file.remotePath || "__uploaded_input_file__"
      : file.remotePath || "__uploaded_input_file__";
  }
  return next;
}
