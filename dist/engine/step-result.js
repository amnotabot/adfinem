import { createHash } from "node:crypto";
import { explainKnownError } from "./known-errors.js";
export function hashInput(value) {
    return createHash("sha256").update(JSON.stringify(value ?? {})).digest("hex");
}
export function durationBetween(startedAt, endedAt) {
    const startedMs = Date.parse(startedAt);
    const endedMs = Date.parse(endedAt);
    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs))
        return undefined;
    return Math.max(0, endedMs - startedMs);
}
export function failedStep(stepId, layer, startedAt, input, error, evidence = []) {
    const err = error instanceof Error ? error : new Error(String(error));
    const explained = explainKnownError(err);
    const endedAt = new Date().toISOString();
    return {
        stepId,
        layer,
        status: "failed",
        startedAt,
        endedAt,
        durationMs: durationBetween(startedAt, endedAt),
        inputHash: hashInput(input),
        captures: {},
        evidence,
        error: {
            message: explained.message,
            stack: err.stack,
            rawOutput: explained.hints.length > 0 ? `Hints:\n${explained.hints.map((hint) => `- ${hint}`).join("\n")}` : undefined
        }
    };
}
export function cancelledStep(stepId, layer, startedAt, input, evidence = []) {
    const endedAt = new Date().toISOString();
    return {
        stepId,
        layer,
        status: "cancelled",
        startedAt,
        endedAt,
        durationMs: durationBetween(startedAt, endedAt),
        inputHash: hashInput(input),
        captures: {},
        evidence,
        error: {
            message: "Run was stopped by user request."
        }
    };
}
export function isCancellationError(error) {
    return error instanceof Error && error.name === "AbortError";
}
export function cancellationError() {
    const error = new Error("Run was stopped by user request.");
    error.name = "AbortError";
    return error;
}
