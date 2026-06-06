import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config as loadDotEnv } from "dotenv";
import YAML from "yaml";

export interface EnvironmentConfig {
  name: string;
  apiBaseUrl?: string;
  apiTlsInsecure?: boolean;
  oracle: {
    user?: string;
    password?: string;
    connectString?: string;
  };
  sshHosts: Record<string, {
    host?: string;
    username?: string;
    password?: string;
    privateKeyPath?: string;
    shell?: string;
    loginShell?: boolean;
  }>;
}

export interface EditableEnvironmentConfig {
  apiBaseUrl?: string;
  apiTlsInsecure?: boolean;
  oracle?: {
    user?: string;
    password?: string;
    connectString?: string;
  };
  sshHosts?: Record<string, {
    host?: string;
    username?: string;
    password?: string;
    privateKeyPath?: string;
    shell?: string;
    loginShell?: boolean;
  }>;
}

export type EnvironmentFile = Record<string, EditableEnvironmentConfig>;

export function getEnvironment(name?: string, rootDir = process.cwd()): EnvironmentConfig {
  loadWorkspaceDotEnv(rootDir);
  const resolvedName = name || process.env.ADFINEM_ENV || "local";
  const raw = readFileSync(environmentConfigPath(rootDir), "utf8");
  const configs = interpolateEnv(YAML.parse(raw)) as Record<string, EnvironmentConfig>;
  const config = configs[resolvedName];

  if (!config) {
    const available = Object.keys(configs).filter((key) => key && typeof configs[key] === "object");
    const suffix = available.length
      ? ` Available: ${available.join(", ")}.`
      : " No environments are defined yet.";
    throw new Error(`Unknown environment '${resolvedName}'.${suffix} Add it to config/environments.yaml or pass --env.`);
  }

  return {
    name: resolvedName,
    apiBaseUrl: blankToUndefined(config.apiBaseUrl),
    apiTlsInsecure: booleanValue(config.apiTlsInsecure),
    oracle: {
      user: blankToUndefined(config.oracle?.user),
      password: blankToUndefined(config.oracle?.password),
      connectString: blankToUndefined(config.oracle?.connectString)
    },
    sshHosts: Object.fromEntries(Object.entries(config.sshHosts ?? {}).map(([hostRef, host]) => [hostRef, {
      host: blankToUndefined(host.host),
      username: blankToUndefined(host.username),
      password: blankToUndefined(host.password),
      privateKeyPath: blankToUndefined(host.privateKeyPath),
      shell: blankToUndefined(host.shell),
      loginShell: booleanValue(host.loginShell)
    }]))
  };
}

export function listEnvironmentNames(rootDir = process.cwd()): string[] {
  try {
    return Object.keys(loadEnvironmentFile(rootDir));
  } catch {
    return [];
  }
}

export function environmentConfigPath(rootDir = process.cwd()): string {
  return join(rootDir, "config", "environments.yaml");
}

export function loadEnvironmentFile(rootDir = process.cwd()): EnvironmentFile {
  loadWorkspaceDotEnv(rootDir);
  const raw = readFileSync(environmentConfigPath(rootDir), "utf8");
  const parsed = YAML.parse(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") return {};
  return Object.fromEntries(
    Object.entries(parsed)
      .filter(([name, value]) => name && value && typeof value === "object" && !Array.isArray(value))
      .map(([name, value]) => [name, normalizeEditableEnvironment(value as Record<string, unknown>)])
  );
}

export async function writeEnvironmentFile(rootDir: string, environments: EnvironmentFile): Promise<void> {
  const outputPath = environmentConfigPath(rootDir);
  const normalized = Object.fromEntries(
    Object.entries(environments)
      .filter(([name]) => isValidEnvironmentName(name))
      .map(([name, config]) => [name, normalizeEditableEnvironment(config as Record<string, unknown>)])
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, YAML.stringify(normalized, { defaultKeyType: "PLAIN", defaultStringType: "QUOTE_DOUBLE" }), "utf8");
}

export function isValidEnvironmentName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(name);
}

export function assertValidEnvironmentName(name: string): void {
  if (!isValidEnvironmentName(name)) {
    throw new Error("Environment name must start with a letter and contain only letters, numbers, underscore, or hyphen.");
  }
}

function interpolateEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) return value.map(interpolateEnv);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, interpolateEnv(entry)]));
  }
  return value;
}

function loadWorkspaceDotEnv(rootDir: string): void {
  loadDotEnv({ path: join(rootDir, ".env"), override: true });
}

function blankToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

function normalizeEditableEnvironment(value: Record<string, unknown>): EditableEnvironmentConfig {
  const oracle = objectValue(value.oracle);
  const sshHosts = objectValue(value.sshHosts);
  return {
    apiBaseUrl: optionalString(value.apiBaseUrl),
    apiTlsInsecure: optionalBoolean(value.apiTlsInsecure),
    oracle: {
      user: optionalString(oracle?.user),
      password: optionalString(oracle?.password),
      connectString: optionalString(oracle?.connectString)
    },
    sshHosts: Object.fromEntries(
      Object.entries(sshHosts ?? {})
        .filter(([, entry]) => entry && typeof entry === "object" && !Array.isArray(entry))
        .map(([hostRef, entry]) => {
          const host = entry as Record<string, unknown>;
          return [hostRef, {
            host: optionalString(host.host),
            username: optionalString(host.username),
            password: optionalString(host.password),
            privateKeyPath: optionalString(host.privateKeyPath),
            shell: optionalString(host.shell),
            loginShell: optionalBoolean(host.loginShell)
          }];
        })
    )
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return optionalBoolean(value);
}
