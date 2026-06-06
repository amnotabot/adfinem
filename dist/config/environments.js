import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config as loadDotEnv } from "dotenv";
import YAML from "yaml";
export function getEnvironment(name, rootDir = process.cwd()) {
    loadWorkspaceDotEnv(rootDir);
    const resolvedName = name || process.env.ADFINEM_ENV || "local";
    const raw = readFileSync(environmentConfigPath(rootDir), "utf8");
    const configs = interpolateEnv(YAML.parse(raw));
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
export function listEnvironmentNames(rootDir = process.cwd()) {
    try {
        return Object.keys(loadEnvironmentFile(rootDir));
    }
    catch {
        return [];
    }
}
export function environmentConfigPath(rootDir = process.cwd()) {
    return join(rootDir, "config", "environments.yaml");
}
export function loadEnvironmentFile(rootDir = process.cwd()) {
    loadWorkspaceDotEnv(rootDir);
    const raw = readFileSync(environmentConfigPath(rootDir), "utf8");
    const parsed = YAML.parse(raw);
    if (!parsed || typeof parsed !== "object")
        return {};
    return Object.fromEntries(Object.entries(parsed)
        .filter(([name, value]) => name && value && typeof value === "object" && !Array.isArray(value))
        .map(([name, value]) => [name, normalizeEditableEnvironment(value)]));
}
export async function writeEnvironmentFile(rootDir, environments) {
    const outputPath = environmentConfigPath(rootDir);
    const normalized = Object.fromEntries(Object.entries(environments)
        .filter(([name]) => isValidEnvironmentName(name))
        .map(([name, config]) => [name, normalizeEditableEnvironment(config)]));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, YAML.stringify(normalized, { defaultKeyType: "PLAIN", defaultStringType: "QUOTE_DOUBLE" }), "utf8");
}
export function isValidEnvironmentName(name) {
    return /^[A-Za-z][A-Za-z0-9_-]*$/.test(name);
}
export function assertValidEnvironmentName(name) {
    if (!isValidEnvironmentName(name)) {
        throw new Error("Environment name must start with a letter and contain only letters, numbers, underscore, or hyphen.");
    }
}
function interpolateEnv(value) {
    if (typeof value === "string") {
        return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, name) => process.env[name] ?? "");
    }
    if (Array.isArray(value))
        return value.map(interpolateEnv);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, interpolateEnv(entry)]));
    }
    return value;
}
function loadWorkspaceDotEnv(rootDir) {
    loadDotEnv({ path: join(rootDir, ".env"), override: true });
}
function blankToUndefined(value) {
    return value && value.trim() ? value : undefined;
}
function normalizeEditableEnvironment(value) {
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
        sshHosts: Object.fromEntries(Object.entries(sshHosts ?? {})
            .filter(([, entry]) => entry && typeof entry === "object" && !Array.isArray(entry))
            .map(([hostRef, entry]) => {
            const host = entry;
            return [hostRef, {
                    host: optionalString(host.host),
                    username: optionalString(host.username),
                    password: optionalString(host.password),
                    privateKeyPath: optionalString(host.privateKeyPath),
                    shell: optionalString(host.shell),
                    loginShell: optionalBoolean(host.loginShell)
                }];
        }))
    };
}
function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function optionalString(value) {
    return value === undefined || value === null ? undefined : String(value);
}
function optionalBoolean(value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    if (typeof value === "boolean")
        return value;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized))
        return true;
    if (["0", "false", "no", "off"].includes(normalized))
        return false;
    return undefined;
}
function booleanValue(value) {
    return optionalBoolean(value);
}
