import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { flowFileSchema } from "./schema.js";
import type { FlowFile } from "./types.js";

const yamlOptions = { defaultStringType: "PLAIN", defaultKeyType: "PLAIN", lineWidth: 0 } as const;

export async function loadFlow(path: string): Promise<FlowFile> {
  const parsed = YAML.parse(await readFile(path, "utf8")) as unknown;
  return flowFileSchema.parse(parsed) as FlowFile;
}

export async function readFlowSource(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function writeFlow(path: string, flow: FlowFile): Promise<void> {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  const validated = flowFileSchema.parse(flow) as FlowFile;
  await writeFile(outputPath, YAML.stringify(validated, yamlOptions), "utf8");
}

export function flowToYaml(flow: FlowFile): string {
  return YAML.stringify(flowFileSchema.parse(flow), yamlOptions);
}
