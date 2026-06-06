import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyEvidenceVisibility, evidenceVisibilityMode } from "../config/secrets.js";
export class EvidenceWriter {
    runDir;
    visibility;
    constructor(runDir, visibility = evidenceVisibilityMode()) {
        this.runDir = runDir;
        this.visibility = visibility;
    }
    async init() {
        await mkdir(this.runDir, { recursive: true });
    }
    async writeJson(name, value) {
        const path = join(this.runDir, sanitizeName(name));
        await writeFile(path, JSON.stringify(applyEvidenceVisibility(value, this.visibility), null, 2), "utf8");
        return path;
    }
    async writeJsonPath(relativePath, value) {
        const path = join(this.runDir, ...relativePath.split(/[\\/]+/).map(sanitizeName));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(applyEvidenceVisibility(value, this.visibility), null, 2), "utf8");
        return path;
    }
    async writeText(name, value) {
        const path = join(this.runDir, sanitizeName(name));
        await writeFile(path, value, "utf8");
        return path;
    }
}
function sanitizeName(name) {
    return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}
