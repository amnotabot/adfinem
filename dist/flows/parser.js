import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { flowFileSchema } from "./schema.js";
const yamlOptions = { defaultStringType: "PLAIN", defaultKeyType: "PLAIN", lineWidth: 0 };
export async function loadFlow(path) {
    const parsed = YAML.parse(await readFile(path, "utf8"));
    return flowFileSchema.parse(parsed);
}
export async function readFlowSource(path) {
    return readFile(path, "utf8");
}
export async function writeFlow(path, flow) {
    const outputPath = resolve(path);
    await mkdir(dirname(outputPath), { recursive: true });
    const validated = flowFileSchema.parse(flow);
    await writeFile(outputPath, YAML.stringify(validated, yamlOptions), "utf8");
}
export function flowToYaml(flow) {
    return YAML.stringify(flowFileSchema.parse(flow), yamlOptions);
}
