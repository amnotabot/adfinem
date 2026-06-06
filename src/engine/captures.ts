import { JSONPath } from "jsonpath-plus";

export function extractCaptures(payload: unknown, specs: Record<string, string> | undefined): Record<string, unknown> {
  const captures: Record<string, unknown> = {};
  for (const [name, expression] of Object.entries(specs ?? {})) {
    const value = extractCaptureValue(payload, expression);
    if (value !== undefined) captures[name] = value;
  }
  return captures;
}

export function mergeCaptureSpecs(...specs: Array<Record<string, string> | undefined>): Record<string, string> {
  return Object.assign({}, ...specs.filter(Boolean));
}

function extractCaptureValue(payload: unknown, expression: string): unknown {
  const { expression: trimmed, required } = parseCaptureExpression(expression);
  if (!trimmed) throw new Error("Capture expression must not be empty.");
  try {
    if (trimmed.startsWith("literal:")) return trimmed.slice("literal:".length);
    if (trimmed.startsWith("regex:")) return extractRegexCapture(payload, trimmed);
    return extractJsonPathCapture(payload, normalizeJsonPath(trimmed), trimmed);
  } catch (error) {
    if (!required && isCaptureNoMatch(error)) return undefined;
    throw error;
  }
}

function parseCaptureExpression(expression: string): { expression: string; required: boolean } {
  const trimmed = expression.trim();
  if (trimmed.startsWith("optional:")) {
    return { expression: trimmed.slice("optional:".length).trim(), required: false };
  }
  return { expression: trimmed, required: true };
}

function extractJsonPathCapture(payload: unknown, jsonPath: string, original: string): unknown {
  const json = payload as string | number | boolean | object | unknown[] | null;
  const values = JSONPath({ path: jsonPath, json, wrap: true }) as unknown as unknown[];
  if (values.length === 0) throw new Error(`Capture expression '${original}' did not match any value.`);
  return values.length === 1 ? values[0] : values;
}

function extractRegexCapture(payload: unknown, expression: string): string {
  const parts = expression.split(":");
  if (parts.length < 3) {
    throw new Error(`Invalid regex capture '${expression}'. Use regex:<jsonpath>:<pattern>.`);
  }
  const sourcePath = parts[1]?.trim() || "$";
  const pattern = parts.slice(2).join(":");
  const source = extractJsonPathCapture(payload, normalizeJsonPath(sourcePath), sourcePath);
  const match = String(source ?? "").match(new RegExp(pattern, "m"));
  if (!match) throw new Error(`Regex capture '${expression}' did not match.`);
  return match[1] ?? match[0];
}

function normalizeJsonPath(expression: string): string {
  if (expression.startsWith("$")) return expression;
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:[.[].*)?$/.test(expression)) return `$.${expression}`;
  throw new Error(`Unsupported capture expression '${expression}'. Use JSONPath, simple property path, literal:, or regex:.`);
}

function isCaptureNoMatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /did not match any value|did not match\./i.test(message);
}
