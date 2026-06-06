import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function writeJunitReport(result) {
    const failures = result.steps.filter((step) => step.status === "failed").length;
    const skipped = result.steps.filter((step) => step.status === "skipped").length;
    const totalSeconds = formatSeconds(result.durationMs);
    const cases = result.steps.map((step) => {
        const time = formatSeconds(stepDurationMs(step));
        const body = step.status === "failed"
            ? `<failure message="${xml(step.error?.message ?? "failed")}">${xml(step.error?.stack ?? "")}</failure>`
            : step.status === "skipped"
                ? `<skipped message="${xml(step.error?.message ?? "skipped")}"/>`
                : "";
        const timeAttr = time === undefined ? "" : ` time="${time}"`;
        return `  <testcase classname="${xml(result.scenarioId)}" name="${xml(step.stepId)}"${timeAttr}>${body}</testcase>`;
    }).join("\n");
    const suiteAttrs = [
        `name="${xml(result.scenarioId)}"`,
        `tests="${result.steps.length}"`,
        `failures="${failures}"`,
        `skipped="${skipped}"`,
        `timestamp="${xml(result.startedAt)}"`,
        totalSeconds === undefined ? "" : `time="${totalSeconds}"`
    ].filter(Boolean).join(" ");
    const xmlText = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite ${suiteAttrs}>
${cases}
</testsuite>
`;
    const path = join(result.evidenceDir, "junit.xml");
    await writeFile(path, xmlText, "utf8");
    return path;
}
function stepDurationMs(step) {
    const startedMs = Date.parse(step.startedAt);
    const endedMs = Date.parse(step.endedAt);
    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs))
        return undefined;
    return Math.max(0, endedMs - startedMs);
}
function formatSeconds(ms) {
    if (ms === undefined)
        return undefined;
    return (ms / 1000).toFixed(3);
}
function xml(value) {
    return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" }[char] ?? char));
}
