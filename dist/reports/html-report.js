import { writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
export async function writeHtmlReport(result) {
    const totals = countByStatus(result.steps);
    const rows = result.steps.map((step) => {
        const duration = formatDuration(stepDurationMs(step));
        const evidence = renderEvidenceLinks(step, result.evidenceDir);
        const error = step.error?.message ? `<pre class="error">${escapeHtml(step.error.message)}</pre>` : "";
        return `    <tr>
      <td>${escapeHtml(step.stepId)}</td>
      <td>${escapeHtml(step.layer)}</td>
      <td class="${step.status}">${escapeHtml(step.status)}</td>
      <td>${duration}</td>
      <td>${evidence}</td>
      <td>${error}</td>
    </tr>`;
    }).join("\n");
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(result.scenarioId)} ${escapeHtml(result.status)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #222; }
    h1 { margin-bottom: 4px; }
    .meta { color: #555; margin-bottom: 16px; }
    .summary { display: flex; gap: 12px; margin: 12px 0 18px; flex-wrap: wrap; }
    .summary span { padding: 4px 10px; border-radius: 4px; background: #f1f3f5; font-size: 13px; }
    table { border-collapse: collapse; width: 100%; font-size: 14px; }
    th, td { border: 1px solid #ccc; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #fafafa; }
    .passed { color: #087a2f; font-weight: bold; }
    .failed { color: #b00020; font-weight: bold; }
    .skipped { color: #777; font-weight: bold; }
    pre.error { white-space: pre-wrap; margin: 0; color: #b00020; font-family: Consolas, Menlo, monospace; font-size: 12px; }
    ul.evidence { margin: 0; padding-left: 16px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(result.scenarioId)}</h1>
  <div class="meta">Run <strong>${escapeHtml(result.runId)}</strong> &mdash; status <strong class="${result.status}">${escapeHtml(result.status)}</strong></div>
  <div class="meta">Started ${escapeHtml(result.startedAt)} &middot; ended ${escapeHtml(result.endedAt)} &middot; duration ${formatDuration(result.durationMs)}</div>
  <div class="summary">
    <span>total: ${result.steps.length}</span>
    <span class="passed">passed: ${totals.passed}</span>
    <span class="failed">failed: ${totals.failed}</span>
    <span class="skipped">skipped: ${totals.skipped}</span>
  </div>
  <table>
    <thead><tr><th>Step</th><th>Layer</th><th>Status</th><th>Duration</th><th>Evidence</th><th>Error</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>`;
    const path = join(result.evidenceDir, "report.html");
    await writeFile(path, html, "utf8");
    return path;
}
function countByStatus(steps) {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    for (const step of steps) {
        if (step.status === "passed")
            passed += 1;
        else if (step.status === "failed")
            failed += 1;
        else if (step.status === "skipped")
            skipped += 1;
    }
    return { passed, failed, skipped };
}
function stepDurationMs(step) {
    const startedMs = Date.parse(step.startedAt);
    const endedMs = Date.parse(step.endedAt);
    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs))
        return undefined;
    return Math.max(0, endedMs - startedMs);
}
function formatDuration(ms) {
    if (ms === undefined)
        return "&mdash;";
    if (ms < 1000)
        return `${ms} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
}
function renderEvidenceLinks(step, evidenceDir) {
    if (!step.evidence?.length)
        return "&mdash;";
    const items = step.evidence.map((path) => {
        const href = relativeOrAbsolute(path, evidenceDir);
        const label = basename(path);
        return `<li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></li>`;
    }).join("");
    return `<ul class="evidence">${items}</ul>`;
}
function relativeOrAbsolute(target, base) {
    try {
        const rel = relative(base, target);
        if (!rel || rel.startsWith(".."))
            return target;
        return rel.replace(/\\/g, "/");
    }
    catch {
        return target;
    }
}
function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[char] ?? char));
}
