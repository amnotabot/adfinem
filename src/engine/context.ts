import type { Scenario } from "../dsl/types.js";

export class RunContext {
  private readonly values = new Map<string, unknown>();

  constructor(scenario: Scenario) {
    for (const [key, value] of Object.entries(scenario.variables ?? {})) {
      this.values.set(key, value);
    }
    for (const [key, value] of Object.entries(scenario.tenant ?? {})) {
      this.values.set(`tenant.${key}`, value);
    }
  }

  set(name: string, value: unknown): void {
    this.values.set(name, value);
  }

  get(name: string): unknown {
    return this.values.get(name);
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.values);
  }

  restore(snapshot: Record<string, unknown>): void {
    this.values.clear();
    for (const [key, value] of Object.entries(snapshot)) this.values.set(key, value);
  }

  resolve<T>(value: T): T {
    return this.resolveValue(value) as T;
  }

  private resolveValue(value: unknown): unknown {
    if (typeof value === "string") {
        const exact = /^\$\{([^}]+)\}$/.exec(value);
      if (exact) {
        const resolved = this.values.get(exact[1]);
        if (resolved === undefined || resolved === null) {
          throw new Error(`Variable '${exact[1]}' is not available in run context.`);
        }
        return resolved;
      }
      const postmanExact = /^\{\{([A-Za-z0-9_.-]+)\}\}$/.exec(value);
      if (postmanExact) {
        const resolved = this.values.get(postmanExact[1]);
        if (resolved === undefined || resolved === null) {
          throw new Error(`Variable '${postmanExact[1]}' is not available in run context.`);
        }
        return resolved;
      }
      return value
        .replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
          const resolved = this.values.get(name);
          if (resolved === undefined || resolved === null) {
            throw new Error(`Variable '${name}' is not available in run context.`);
          }
          return String(resolved);
        })
        .replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (_match, name: string) => {
        const resolved = this.values.get(name);
        if (resolved === undefined || resolved === null) {
          throw new Error(`Variable '${name}' is not available in run context.`);
        }
        return String(resolved);
      });
    }
    if (Array.isArray(value)) return value.map((item) => this.resolveValue(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.resolveValue(entry)]));
    }
    return value;
  }
}
