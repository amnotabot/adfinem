import type { BatchCatalogEntry } from "../dsl/types.js";
import { BatchRunner, type BatchRunOptions } from "../adapters/unix/batch-runner.js";

export async function runBatch(batchRunner: BatchRunner, entry: BatchCatalogEntry, params: Record<string, unknown>, options?: BatchRunOptions) {
  return await batchRunner.run(entry, params, options);
}
