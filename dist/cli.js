#!/usr/bin/env node
import { Command } from "commander";
import { access, cp, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { getEnvironment, listEnvironmentNames } from "./config/environments.js";
import { loadCatalogs, loadScenario } from "./dsl/parser.js";
import { validateScenarioReferences } from "./dsl/validator.js";
import { ensureEvidenceRoot, ScenarioRunner } from "./engine/runner.js";
import { OracleClient } from "./adapters/db/oracle-client.js";
import { RestClient } from "./adapters/api/rest-client.js";
import { SoapClient } from "./adapters/api/soap-client.js";
import { BatchRunner } from "./adapters/unix/batch-runner.js";
import { SshClient } from "./adapters/unix/ssh-client.js";
import { assertDb } from "./actions/assert-db.js";
import { runBatch } from "./actions/run-eod.js";
import { extractCaptures, mergeCaptureSpecs } from "./engine/captures.js";
import { formatKnownError } from "./engine/known-errors.js";
import { compileFlow } from "./flows/compiler.js";
import { loadFlow, readFlowSource, writeFlow } from "./flows/parser.js";
import { validateFlow } from "./flows/validator.js";
import { concatFlows } from "./flows/concat.js";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = resolve(process.env.ADFINEM_PROJECT_ROOT ?? process.cwd());
const program = new Command();
program
    .name("adfinem")
    .description("Adfinem deterministic API, database, and Unix scenario runner")
    .version("0.1.1");
program
    .command("init")
    .argument("[directory]", "Project directory to create or update", ".")
    .description("Create a starter Adfinem project with catalogs, config, scenarios, flows, docs, and templates")
    .option("--force", "Overwrite starter files that already exist")
    .action(async (directory, options) => {
    await handleErrors(async () => {
        const targetRoot = resolve(process.cwd(), directory);
        await mkdir(targetRoot, { recursive: true });
        const entries = ["catalogs", "config", "flows", "scenarios", "templates", "docs", ".env.example"];
        const copied = [];
        const skipped = [];
        for (const entry of entries) {
            const source = join(packageRoot, entry);
            const target = join(targetRoot, entry);
            if (!options.force && await pathExists(target)) {
                skipped.push(entry);
                continue;
            }
            await cp(source, target, { recursive: true, force: Boolean(options.force) });
            copied.push(entry);
        }
        console.log(`Adfinem project ready: ${targetRoot}`);
        if (copied.length > 0)
            console.log(`Created: ${copied.join(", ")}`);
        if (skipped.length > 0)
            console.log(`Skipped existing: ${skipped.join(", ")} (use --force to overwrite)`);
        console.log("Next:");
        console.log(`  cd ${targetRoot}`);
        console.log("  adfinem validate scenarios/smoke/account-processing-smoke.yaml");
        console.log("  adfinem app");
    });
});
program
    .command("app")
    .description("Start the Adfinem web workbench for the current project")
    .option("--project <dir>", "Project root containing catalogs, config, scenarios, and flows", ".")
    .option("--port <port>", "Port to bind; defaults to 4177 with fallback ports", parseInteger)
    .action(async (options) => {
    await handleErrors(async () => {
        process.env.ADFINEM_PROJECT_ROOT = resolve(process.cwd(), options.project);
        process.env.ADFINEM_WEB_DIST = join(packageRoot, "web-dist");
        if (options.port !== undefined)
            process.env.ADFINEM_RUNNER_PORT = String(options.port);
        await import("./app/server.js");
    });
});
program
    .command("validate")
    .argument("<scenario>", "Scenario YAML path")
    .action(async (scenarioPath) => {
    await handleErrors(async () => {
        const { scenario, errors } = await validateScenario(scenarioPath);
        if (errors.length > 0) {
            console.error(`Scenario '${scenario.id}' is invalid:`);
            for (const error of errors)
                console.error(`- ${error}`);
            process.exitCode = 1;
            return;
        }
        console.log(`Scenario '${scenario.id}' is valid.`);
    });
});
program
    .command("run")
    .argument("<scenario>", "Scenario YAML path")
    .option("--env <env>", "Environment name; defaults to scenario.environment")
    .option("--dry-run", "Validate and record planned execution without external side effects")
    .action(async (scenarioPath, options) => {
    await handleErrors(async () => {
        const { scenario, catalogs, errors } = await validateScenario(scenarioPath);
        if (errors.length > 0) {
            console.error(`Scenario '${scenario.id}' is invalid:`);
            for (const error of errors)
                console.error(`- ${error}`);
            process.exitCode = 1;
            return;
        }
        await ensureEvidenceRoot(rootDir);
        const env = getEnvironment(options.env ?? scenario.environment, rootDir);
        const runner = new ScenarioRunner(scenario, catalogs, env, { rootDir, dryRun: options.dryRun });
        const result = await runner.run();
        console.log(`Run ${result.status}: ${result.scenarioId}`);
        console.log(`Evidence: ${result.evidenceDir}`);
        if (result.status === "failed")
            process.exitCode = 1;
    });
});
program
    .command("validate-flow")
    .argument("<flow>", "Flow YAML path")
    .description("Validate a flow artifact without executing it")
    .action(async (flowPath) => {
    await handleErrors(async () => {
        const fullFlowPath = resolve(process.cwd(), flowPath);
        const flow = await loadFlow(fullFlowPath);
        const catalogs = await loadCatalogs(rootDir);
        const validation = await validateFlow(flow, catalogs, rootDir);
        if (validation.warnings.length > 0) {
            console.warn(`Flow '${flow.id}' warnings:`);
            for (const warning of validation.warnings)
                console.warn(`- ${warning}`);
        }
        if (!validation.ok) {
            console.error(`Flow '${flow.id}' is invalid:`);
            for (const error of validation.errors)
                console.error(`- ${error}`);
            process.exitCode = 1;
            return;
        }
        console.log(`Flow '${flow.id}' is valid.`);
    });
});
program
    .command("compile-flow")
    .argument("<flow>", "Flow YAML path")
    .description("Compile a flow artifact to the scenario structure used by the runner")
    .option("--env <env>", "Override the flow environment in the compiled scenario")
    .option("--output <file>", "Optional output path for the compiled scenario JSON")
    .action(async (flowPath, options) => {
    await handleErrors(async () => {
        const flow = await loadFlow(resolve(process.cwd(), flowPath));
        const catalogs = await loadCatalogs(rootDir);
        const validation = await validateFlow(flow, catalogs, rootDir, options.env ?? flow.environment);
        if (!validation.ok) {
            console.error(`Flow '${flow.id}' is invalid:`);
            for (const error of validation.errors)
                console.error(`- ${error}`);
            process.exitCode = 1;
            return;
        }
        const compiled = compileFlow(flow, { environment: options.env });
        const payload = {
            flow: { id: flow.id, name: flow.name, version: flow.version },
            stepMap: compiled.stepMap,
            scenario: compiled.scenario
        };
        if (options.output) {
            const outputPath = resolve(process.cwd(), options.output);
            await writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");
            console.log(`Compiled flow written: ${outputPath}`);
            return;
        }
        console.log(JSON.stringify(payload, null, 2));
    });
});
program
    .command("concat-flows")
    .argument("<output>", "Output flow YAML path")
    .argument("<flows...>", "Two or more input flow YAML paths")
    .description("Generate a new flow by concatenating existing flow artifacts")
    .option("--id <id>", "Generated flow id; defaults to the output file name")
    .option("--name <name>", "Generated flow display name")
    .option("--env <env>", "Generated flow environment; required when input flows use different environments")
    .option("--prefix-node-ids <mode>", "Node id prefix mode: auto, always, or never", "auto")
    .option("--allow-variable-overrides", "Allow later input flows to overwrite conflicting variables")
    .action(async (output, flowPaths, options) => {
    await handleErrors(async () => {
        if (flowPaths.length < 2)
            throw new Error("concat-flows requires at least two input flow files.");
        const prefixMode = parsePrefixMode(options.prefixNodeIds);
        const inputFlows = await Promise.all(flowPaths.map((path) => loadFlow(resolve(process.cwd(), path))));
        const outputPath = resolve(process.cwd(), output);
        const flow = concatFlows(inputFlows, {
            id: options.id ?? flowIdFromOutput(outputPath),
            name: options.name,
            environment: options.env,
            nodePrefixMode: prefixMode,
            allowVariableOverrides: options.allowVariableOverrides
        });
        await writeFlow(outputPath, flow);
        const catalogs = await loadCatalogs(rootDir);
        const validation = await validateFlow(flow, catalogs, rootDir, options.env ?? flow.environment);
        if (validation.warnings.length > 0) {
            console.warn(`Generated flow '${flow.id}' warnings:`);
            for (const warning of validation.warnings)
                console.warn(`- ${warning}`);
        }
        if (!validation.ok) {
            console.error(`Generated flow '${flow.id}' was written but is invalid:`);
            for (const error of validation.errors)
                console.error(`- ${error}`);
            process.exitCode = 1;
            return;
        }
        console.log(`Concatenated flow written: ${outputPath}`);
        console.log(`Flow '${flow.id}' is valid.`);
    });
});
program
    .command("run-flow")
    .argument("<flow>", "Flow YAML path")
    .description("Compile and execute a flow artifact")
    .option("--env <env>", "Override the flow environment")
    .option("--dry-run", "Validate and record planned execution without external side effects")
    .action(async (flowPath, options) => {
    await handleErrors(async () => {
        const fullFlowPath = resolve(process.cwd(), flowPath);
        const flow = await loadFlow(fullFlowPath);
        const catalogs = await loadCatalogs(rootDir);
        const validation = await validateFlow(flow, catalogs, rootDir);
        if (validation.warnings.length > 0) {
            console.warn(`Flow '${flow.id}' warnings:`);
            for (const warning of validation.warnings)
                console.warn(`- ${warning}`);
        }
        if (!validation.ok) {
            console.error(`Flow '${flow.id}' is invalid:`);
            for (const error of validation.errors)
                console.error(`- ${error}`);
            process.exitCode = 1;
            return;
        }
        const compiled = compileFlow(flow, { environment: options.env });
        await ensureEvidenceRoot(rootDir);
        const env = getEnvironment(options.env ?? compiled.scenario.environment, rootDir);
        const runner = new ScenarioRunner(compiled.scenario, catalogs, env, { rootDir, dryRun: options.dryRun });
        const result = await runner.run();
        await writeFile(join(result.evidenceDir, "flow.yaml"), await readFlowSource(fullFlowPath), "utf8");
        await writeFile(join(result.evidenceDir, "compiled-flow.json"), JSON.stringify({
            flow: compiled.flow,
            stepMap: compiled.stepMap,
            scenario: compiled.scenario
        }, null, 2), "utf8");
        console.log(`Flow run ${result.status}: ${flow.id}`);
        console.log(`Evidence: ${result.evidenceDir}`);
        if (result.status === "failed")
            process.exitCode = 1;
    });
});
program
    .command("compile")
    .argument("<text>", "Business scenario text")
    .option("--env <env>", "Environment name", "local")
    .action((text, options) => {
    console.log("# LLM compiler placeholder");
    console.log("# Deterministic API/DB/Unix runner is implemented first; wire an LLM provider after the Action Library is stable.");
    console.log(`environment: ${options.env}`);
    console.log(`description: ${JSON.stringify(text)}`);
});
program
    .command("api-call")
    .argument("<operation>", "API operation key from the Action Library")
    .description("Run an allowlisted API operation and print response/captures")
    .option("--env <env>", "Environment name; defaults to ADFINEM_ENV or local")
    .option("--params <json>", "JSON object with API parameters", "{}")
    .option("--param <name=value>", "API parameter; repeat to pass multiple values", collectOption, [])
    .option("--capture <name=expr>", "Additional capture expression; repeatable", collectOption, [])
    .action(async (operationName, options) => {
    await handleErrors(async () => {
        const env = getEnvironment(options.env, rootDir);
        const catalogs = await loadCatalogs(rootDir);
        const operation = catalogs.apiOperations[operationName];
        if (!operation)
            throw new Error(`Unknown API operation '${operationName}'.`);
        const params = parseParamsOptions(options.params, options.param);
        const result = operation.type === "soap"
            ? await new SoapClient().execute(operation, params)
            : await new RestClient(env, rootDir).execute(operation, params);
        const captures = {
            ...result.captures,
            ...extractCaptures(result.response, parseCaptureOptions(options.capture))
        };
        console.log(JSON.stringify({ operation: operationName, response: result.response, captures }, null, 2));
    });
});
program
    .command("db-query")
    .argument("<query>", "Query template key from the Action Library")
    .description("Run an allowlisted Oracle query template and print rows/captures")
    .option("--env <env>", "Environment name; defaults to ADFINEM_ENV or local")
    .option("--params <json>", "JSON object with query bind parameters", "{}")
    .option("--param <name=value>", "Bind parameter; repeat for arrays, for example --param case_id=CASE-1001 --param case_id=CASE-1002", collectOption, [])
    .option("--capture <name=expr>", "Additional capture expression; repeatable", collectOption, [])
    .action(async (queryName, options) => {
    await handleErrors(async () => {
        const env = getEnvironment(options.env, rootDir);
        const catalogs = await loadCatalogs(rootDir);
        const entry = catalogs.queries[queryName];
        if (!entry)
            throw new Error(`Unknown query '${queryName}'.`);
        const params = parseParamsOptions(options.params, options.param);
        const rows = await new OracleClient(env).query(entry, params);
        const payload = { query: queryName, rowCount: rows.length, rows };
        const captures = extractCaptures(payload, mergeCaptureSpecs(entry.captures, parseCaptureOptions(options.capture)));
        console.log(JSON.stringify({ ...payload, captures }, null, 2));
    });
});
program
    .command("db-execute")
    .argument("<query>", "Executable DB template key from the Action Library")
    .description("Run an allowlisted Oracle execute/PLSQL template")
    .option("--env <env>", "Environment name; defaults to ADFINEM_ENV or local")
    .option("--params <json>", "JSON object with bind parameters", "{}")
    .option("--param <name=value>", "Bind parameter; repeat to pass multiple values", collectOption, [])
    .option("--capture <name=expr>", "Additional capture expression; repeatable", collectOption, [])
    .action(async (queryName, options) => {
    await handleErrors(async () => {
        const env = getEnvironment(options.env, rootDir);
        const catalogs = await loadCatalogs(rootDir);
        const entry = catalogs.queries[queryName];
        if (!entry)
            throw new Error(`Unknown DB executable '${queryName}'.`);
        if (entry.mode !== "execute")
            throw new Error(`DB Action Library template '${queryName}' must be marked mode: execute.`);
        const params = parseParamsOptions(options.params, options.param);
        const result = await new OracleClient(env).execute(entry, params);
        const payload = { query: queryName, ...result };
        const captures = extractCaptures(payload, mergeCaptureSpecs(entry.captures, parseCaptureOptions(options.capture)));
        console.log(JSON.stringify({ ...payload, captures }, null, 2));
    });
});
program
    .command("db-assert")
    .argument("<query>", "Query template key from the Action Library")
    .description("Run an allowlisted Oracle query template and enforce its expect block")
    .option("--env <env>", "Environment name; defaults to ADFINEM_ENV or local")
    .option("--params <json>", "JSON object with query bind parameters", "{}")
    .option("--param <name=value>", "Bind parameter; repeat for arrays, for example --param case_id=CASE-1001 --param case_id=CASE-1002", collectOption, [])
    .action(async (queryName, options) => {
    await handleErrors(async () => {
        const env = getEnvironment(options.env, rootDir);
        const catalogs = await loadCatalogs(rootDir);
        const entry = catalogs.queries[queryName];
        if (!entry)
            throw new Error(`Unknown query '${queryName}'.`);
        if (!entry.expect)
            throw new Error(`Query '${queryName}' has no expect block.`);
        const params = parseParamsOptions(options.params, options.param);
        const rows = await assertDb(new OracleClient(env), entry, params);
        console.log(JSON.stringify({ query: queryName, rowCount: rows.length, rows }, null, 2));
    });
});
program
    .command("run-batch")
    .argument("<batch>", "Batch template key from the Action Library")
    .description("Run an allowlisted Unix batch template over SSH")
    .option("--env <env>", "Environment name; defaults to ADFINEM_ENV or local")
    .option("--params <json>", "JSON object with batch parameters", "{}")
    .option("--param <name=value>", "Batch parameter; repeat to pass multiple values", collectOption, [])
    .option("--attempts <count>", "Retry attempts", parseInteger)
    .option("--delay-seconds <seconds>", "Delay between attempts", parseInteger)
    .option("--capture <name=expr>", "Additional capture expression; repeatable", collectOption, [])
    .action(async (batchName, options) => {
    await handleErrors(async () => {
        const env = getEnvironment(options.env, rootDir);
        const catalogs = await loadCatalogs(rootDir);
        const entry = catalogs.batches[batchName];
        if (!entry)
            throw new Error(`Unknown batch '${batchName}'.`);
        const params = parseParamsOptions(options.params, options.param);
        const result = await runBatch(new BatchRunner(new SshClient(env)), entry, params, {
            attempts: options.attempts,
            delayMs: options.delaySeconds === undefined ? undefined : options.delaySeconds * 1000
        });
        const captures = extractCaptures(result, mergeCaptureSpecs(entry.captures, parseCaptureOptions(options.capture)));
        console.log(JSON.stringify({ ...result, captures }, null, 2));
        if (result.status === "failed")
            process.exitCode = 1;
    });
});
await program.parseAsync(process.argv);
async function validateScenario(scenarioPath) {
    const fullScenarioPath = resolve(process.cwd(), scenarioPath);
    const scenario = await loadScenario(fullScenarioPath);
    const catalogs = await loadCatalogs(rootDir);
    const knownEnvironments = listEnvironmentNames(rootDir);
    const validation = validateScenarioReferences(scenario, catalogs, { knownEnvironments });
    if (validation.warnings) {
        for (const warning of validation.warnings)
            console.warn(`Warning: ${warning}`);
    }
    return { scenario, catalogs, errors: validation.errors };
}
function flowIdFromOutput(path) {
    const fileName = basename(path)
        .replace(/\.flow\.ya?ml$/i, "")
        .replace(/\.ya?ml$/i, "");
    return fileName.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "combined_flow";
}
function parsePrefixMode(value) {
    if (value === "auto" || value === "always" || value === "never")
        return value;
    throw new Error(`Invalid --prefix-node-ids '${value}'. Use auto, always, or never.`);
}
async function handleErrors(fn) {
    try {
        await fn();
    }
    catch (error) {
        if (error instanceof ZodError) {
            console.error("Schema validation failed:");
            for (const issue of error.issues)
                console.error(`- ${issue.path.join(".")}: ${issue.message}`);
        }
        else {
            const err = error instanceof Error ? error : new Error(String(error));
            console.error(formatKnownError(err));
            if (process.env.DEBUG)
                console.error(err.stack);
        }
        process.exitCode = 1;
    }
}
function parseInteger(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0)
        throw new Error(`Invalid integer: ${value}`);
    return parsed;
}
async function pathExists(path) {
    return access(path).then(() => true).catch(() => false);
}
function collectOption(value, previous) {
    return [...previous, value];
}
function parseJsonObject(value, label) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new Error(`Invalid JSON for ${label}: ${err.message}. ${jsonArgumentHint(label)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${label} must be a JSON object.`);
    }
    return parsed;
}
function jsonArgumentHint(label) {
    if (label === "--params") {
        return "In PowerShell, prefer repeated --param name=value options instead of --params JSON.";
    }
    return "In PowerShell, wrap JSON in single quotes or escape double quotes.";
}
function parseParamsOptions(jsonValue, paramValues) {
    const params = parseJsonObject(jsonValue || "{}", "--params");
    for (const value of paramValues ?? []) {
        const separator = value.indexOf("=");
        if (separator <= 0)
            throw new Error(`Invalid --param '${value}'. Use name=value.`);
        const name = value.slice(0, separator).trim();
        const rawValue = value.slice(separator + 1).trim();
        if (!name || !rawValue)
            throw new Error(`Invalid --param '${value}'. Both name and value are required.`);
        appendParamValue(params, name, parseParamValue(rawValue));
    }
    return params;
}
function appendParamValue(params, name, value) {
    if (name in params) {
        const existing = params[name];
        params[name] = Array.isArray(existing) ? [...existing, value] : [existing, value];
        return;
    }
    params[name] = value;
}
function parseParamValue(value) {
    if (value.startsWith("json:")) {
        try {
            return JSON.parse(value.slice("json:".length));
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            throw new Error(`Invalid JSON value for --param '${value}': ${err.message}. Use json: only for valid JSON scalars/arrays/objects.`);
        }
    }
    if (value.includes(","))
        return value.split(",").map((entry) => entry.trim()).filter(Boolean);
    return value;
}
function parseCaptureOptions(values) {
    const captures = {};
    for (const value of values ?? []) {
        const separator = value.indexOf("=");
        if (separator <= 0)
            throw new Error(`Invalid --capture '${value}'. Use name=expression.`);
        const name = value.slice(0, separator).trim();
        const expression = value.slice(separator + 1).trim();
        if (!name || !expression)
            throw new Error(`Invalid --capture '${value}'. Both name and expression are required.`);
        captures[name] = expression;
    }
    return captures;
}
