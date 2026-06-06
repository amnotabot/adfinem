import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyEvidenceVisibility, evidenceVisibilityMode } from "../config/secrets.js";
import type { EvidenceVisibilityMode } from "../dsl/types.js";

export class EvidenceWriter {
  constructor(public readonly runDir: string, private readonly visibility: EvidenceVisibilityMode = evidenceVisibilityMode()) {}

  async init(): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
  }

  async writeJson(name: string, value: unknown): Promise<string> {
    const path = join(this.runDir, sanitizeName(name));
    await writeFile(path, JSON.stringify(applyEvidenceVisibility(value, this.visibility), null, 2), "utf8");
    return path;
  }

  async writeJsonPath(relativePath: string, value: unknown): Promise<string> {
    const path = join(this.runDir, ...relativePath.split(/[\\/]+/).map(sanitizeName));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(applyEvidenceVisibility(value, this.visibility), null, 2), "utf8");
    return path;
  }

  async writeText(name: string, value: string): Promise<string> {
    const path = join(this.runDir, sanitizeName(name));
    await writeFile(path, value, "utf8");
    return path;
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}
