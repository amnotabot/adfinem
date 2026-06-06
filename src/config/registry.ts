export interface RegisteredAction {
  layer: "api" | "db" | "unix" | "engine";
  supportedVia: string[];
}

export const registeredActions: Record<string, RegisteredAction> = {
  db_assert: {
    layer: "db",
    supportedVia: ["db"]
  },
  db_query: {
    layer: "db",
    supportedVia: ["db"]
  },
  db_execute: {
    layer: "db",
    supportedVia: ["db"]
  },
  unix_batch: {
    layer: "unix",
    supportedVia: ["unix"]
  }
};
