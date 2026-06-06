import type { ApiOperationEntry } from "../../dsl/types.js";

export class SoapClient {
  async execute(_operation: ApiOperationEntry, _input: Record<string, unknown>): Promise<never> {
    throw new Error("SOAP execution is reserved in the architecture but not implemented in this first slice.");
  }
}
