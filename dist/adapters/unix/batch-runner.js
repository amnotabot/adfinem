import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildBatchCommandDetails } from "./batch-catalog.js";
import { hasBatchInputFilePayload, isBatchInputFileValue } from "./batch-input-files.js";
import { cancellationError, isCancellationError } from "../../engine/step-result.js";
export class BatchRunner {
    ssh;
    rootDir;
    constructor(ssh, rootDir = process.cwd()) {
        this.ssh = ssh;
        this.rootDir = rootDir;
    }
    async run(entry, params, options = {}) {
        const uploadPlan = await this.uploadInputFiles(entry, params, options);
        const { command, displayCommand } = buildBatchCommandDetails(entry, uploadPlan.params, uploadPlan.appendedArgs);
        const maxAttempts = Math.max(1, options.attempts ?? 1);
        const delayMs = Math.max(0, options.delayMs ?? 0);
        const attempts = [];
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (options.signal?.aborted)
                throw cancellationError();
            const startedAt = new Date().toISOString();
            try {
                const result = await this.ssh.execute(entry.hostRef, command, (entry.timeoutSeconds ?? 3600) * 1000, options.signal);
                const endedAt = new Date().toISOString();
                const status = batchSucceeded(entry, result) ? "passed" : "failed";
                const diagnostics = extractBatchDiagnostics(result.stdout, result.stderr);
                const attemptResult = {
                    attempt,
                    startedAt,
                    endedAt,
                    command,
                    displayCommand,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    exitCode: result.exitCode,
                    tracePath: diagnostics.tracePath,
                    errno: diagnostics.errno,
                    stdoutTruncated: result.stdoutTruncated,
                    stderrTruncated: result.stderrTruncated,
                    status,
                    error: status === "failed" ? batchFailureMessage(entry, result) : undefined
                };
                attempts.push(attemptResult);
                if (status === "passed")
                    break;
            }
            catch (error) {
                if (isCancellationError(error))
                    throw error;
                const err = error instanceof Error ? error : new Error(String(error));
                attempts.push({
                    attempt,
                    startedAt,
                    endedAt: new Date().toISOString(),
                    command,
                    displayCommand,
                    stdout: "",
                    stderr: "",
                    status: "failed",
                    error: err.message
                });
            }
            if (attempt < maxAttempts && delayMs > 0)
                await sleep(delayMs, options.signal);
        }
        const summary = summarizeBatch(command, displayCommand, attempts, uploadPlan.fileUploads);
        return await this.withOutputFiles(entry, uploadPlan.params, summary, options);
    }
    async uploadInputFiles(entry, params, options) {
        const inputFiles = entry.inputFiles ?? [];
        if (inputFiles.length === 0)
            return { params, appendedArgs: [], fileUploads: undefined };
        const commandParams = { ...params };
        const appendedArgs = [];
        const fileUploads = [];
        const timeoutMs = Math.max(30_000, (entry.timeoutSeconds ?? 3600) * 1000);
        for (const spec of inputFiles) {
            const value = params[spec.name];
            if (!hasBatchInputFilePayload(value)) {
                if (spec.required !== false)
                    throw new Error(`Batch input file '${spec.name}' is required.`);
                continue;
            }
            const file = normalizeInputFileValue(value);
            const fileName = file.fileName || (file.localPath ? basename(file.localPath) : spec.name);
            const remotePath = resolveRemotePath(spec, file, commandParams, fileName);
            const content = await readInputFileContent(this.rootDir, file);
            const upload = {
                name: spec.name,
                fileName,
                localPath: file.localPath,
                remotePath,
                sizeBytes: content.byteLength,
                paramName: spec.paramName || spec.name,
                appendedAsArg: spec.appendAsArg === true || undefined,
                status: "uploaded"
            };
            try {
                await this.ssh.uploadFile(entry.hostRef, remotePath, content, timeoutMs, options.signal);
            }
            catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                fileUploads.push({ ...upload, status: "failed", error: err.message });
                throw new Error(`SFTP upload failed for batch input file '${spec.name}' to '${remotePath}': ${err.message}`);
            }
            fileUploads.push(upload);
            commandParams[spec.paramName || spec.name] = remotePath;
            if (spec.appendAsArg)
                appendedArgs.push(remotePath);
        }
        return { params: commandParams, appendedArgs, fileUploads };
    }
    async withOutputFiles(entry, params, summary, options) {
        const outputFiles = entry.outputFiles ?? [];
        if (outputFiles.length === 0)
            return summary;
        const timeoutMs = Math.max(30_000, (entry.timeoutSeconds ?? 3600) * 1000);
        const last = summary.attempts[summary.attempts.length - 1];
        const fileDownloads = [];
        for (const spec of outputFiles) {
            fileDownloads.push(await this.retrieveOutputFile(entry, spec, params, last, timeoutMs, options));
        }
        const requiredFailure = fileDownloads.find((file) => file.status === "failed" && fileRequired(file.name, outputFiles));
        if (requiredFailure && last) {
            last.status = "failed";
            last.error = requiredFailure.error ?? `Batch output file '${requiredFailure.name}' was not retrieved.`;
            summary.status = "failed";
        }
        return { ...summary, fileDownloads };
    }
    async retrieveOutputFile(entry, spec, params, last, timeoutMs, options) {
        const source = spec.source ?? (spec.remotePath ? "explicit" : "stderr");
        const baseEvidence = { name: spec.name, source, status: "skipped" };
        try {
            const remotePath = resolveOutputRemotePath(spec, params, last);
            if (!remotePath) {
                if (spec.required === false)
                    return { ...baseEvidence, status: "skipped", error: "No generated file path was found." };
                return { ...baseEvidence, status: "failed", error: `Batch output file '${spec.name}' path was not found in ${source}.` };
            }
            const templateVars = outputTemplateVars(spec, remotePath, params);
            const decryptCommandTemplate = spec.decrypt?.command?.trim();
            let decryptCommand;
            let downloadRemotePath = remotePath;
            let decryptExitCode;
            let decryptStdout;
            let decryptStderr;
            let decryptedRemotePath;
            if (decryptCommandTemplate) {
                decryptedRemotePath = resolveTemplate(spec.decrypt?.outputRemotePath || "${remotePath}.dec", {
                    ...templateVars,
                    decryptedRemotePath: `${remotePath}.dec`
                });
                decryptCommand = resolveTemplate(decryptCommandTemplate, {
                    ...templateVars,
                    decryptedRemotePath
                });
                const decrypt = await this.ssh.execute(entry.hostRef, decryptCommand, timeoutMs, options.signal);
                decryptExitCode = decrypt.exitCode;
                decryptStdout = decrypt.stdout;
                decryptStderr = decrypt.stderr;
                if (decrypt.exitCode !== 0 && spec.decrypt?.required !== false) {
                    return {
                        ...baseEvidence,
                        remotePath,
                        decryptCommand,
                        decryptedRemotePath,
                        decryptExitCode,
                        decryptStdout,
                        decryptStderr,
                        status: "failed",
                        error: `Decrypt command failed with exit code ${decrypt.exitCode}.`
                    };
                }
                if (decrypt.exitCode === 0)
                    downloadRemotePath = decryptedRemotePath;
            }
            if (spec.download === false) {
                return {
                    ...baseEvidence,
                    remotePath,
                    decryptCommand,
                    decryptedRemotePath,
                    decryptExitCode,
                    decryptStdout,
                    decryptStderr,
                    status: "skipped"
                };
            }
            if (!options.downloadDir) {
                return { ...baseEvidence, remotePath: downloadRemotePath, status: "failed", error: "No local evidence download directory was configured." };
            }
            const content = await this.ssh.downloadFile(entry.hostRef, downloadRemotePath, timeoutMs, options.signal);
            const localPath = await writeDownloadedFile(options.downloadDir, spec.name, downloadRemotePath, content);
            return {
                ...baseEvidence,
                remotePath,
                localPath,
                sizeBytes: content.byteLength,
                decryptCommand,
                decryptedRemotePath,
                decryptExitCode,
                decryptStdout,
                decryptStderr,
                status: "downloaded"
            };
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            return { ...baseEvidence, status: "failed", error: err.message };
        }
    }
}
function batchSucceeded(entry, result) {
    const allowedExitCodes = entry.success?.exitCodes ?? [0];
    if (!allowedExitCodes.includes(result.exitCode))
        return false;
    for (const required of entry.success?.requiredOutput ?? []) {
        if (!result.stdout.includes(required) && !result.stderr.includes(required)) {
            return false;
        }
    }
    return true;
}
function batchFailureMessage(entry, result) {
    const allowedExitCodes = entry.success?.exitCodes ?? [0];
    if (!allowedExitCodes.includes(result.exitCode)) {
        const output = summarizeCommandOutput(result.stderr || result.stdout);
        return output
            ? `Batch failed with exit code ${result.exitCode}: ${output}`
            : `Batch failed with exit code ${result.exitCode}.`;
    }
    for (const required of entry.success?.requiredOutput ?? []) {
        if (!result.stdout.includes(required) && !result.stderr.includes(required)) {
            return `Batch output did not contain required text '${required}'.`;
        }
    }
    return "Batch did not satisfy success criteria.";
}
function summarizeCommandOutput(value) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= 300)
        return normalized;
    return `${normalized.slice(0, 297)}...`;
}
function summarizeBatch(command, displayCommand, attempts, fileUploads) {
    const last = attempts[attempts.length - 1];
    return {
        command,
        displayCommand,
        status: last?.status ?? "failed",
        fileUploads,
        attempts,
        stdout: last?.stdout ?? "",
        stderr: last?.stderr ?? "",
        exitCode: last?.exitCode,
        tracePath: last?.tracePath,
        errno: last?.errno,
        stdoutTruncated: last?.stdoutTruncated,
        stderrTruncated: last?.stderrTruncated
    };
}
function fileRequired(name, specs) {
    return specs.find((spec) => spec.name === name)?.required !== false;
}
function normalizeInputFileValue(value) {
    if (typeof value === "string")
        return { localPath: value, fileName: basename(value) };
    if (isBatchInputFileValue(value))
        return value;
    throw new Error("Batch input file value must be a selected file object.");
}
function resolveRemotePath(spec, value, params, fileName) {
    const template = value.remotePath || spec.remotePath;
    if (!template?.trim())
        throw new Error(`Batch input file '${spec.name}' needs a remote path.`);
    const baseName = fileName.includes(".") ? fileName.slice(0, fileName.lastIndexOf(".")) : fileName;
    const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1) : "";
    const rendered = template.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_match, name) => {
        if (name === "fileName")
            return fileName;
        if (name === "baseName")
            return baseName;
        if (name === "extension")
            return extension;
        if (name === "inputName")
            return spec.name;
        const value = params[name] ?? process.env[name];
        if (value === undefined || value === null)
            throw new Error(`Batch input file '${spec.name}' remote path references unknown value '${name}'.`);
        return String(value);
    });
    return /[\\/]$/.test(rendered) ? `${rendered}${fileName}` : rendered;
}
function resolveOutputRemotePath(spec, params, last) {
    if (spec.remotePath?.trim()) {
        return resolveTemplate(spec.remotePath, outputTemplateVars(spec, spec.remotePath, params));
    }
    if (!last)
        return undefined;
    const source = spec.source ?? "stderr";
    const output = source === "stdout"
        ? last.stdout
        : source === "both"
            ? `${last.stdout}\n${last.stderr}`
            : last.stderr;
    const pattern = spec.pathPattern?.trim() || "(\\/[^\\s'\"<>]+)";
    const match = new RegExp(pattern, "m").exec(output);
    return (match?.[1] ?? match?.[0])?.trim();
}
function outputTemplateVars(spec, remotePath, params) {
    const fileName = remoteBaseName(remotePath) || `${spec.name}.out`;
    const dot = fileName.lastIndexOf(".");
    return {
        ...params,
        outputName: spec.name,
        remotePath,
        fileName,
        baseName: dot > 0 ? fileName.slice(0, dot) : fileName,
        extension: dot > 0 ? fileName.slice(dot + 1) : ""
    };
}
function resolveTemplate(value, params) {
    return value.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_match, name) => {
        const next = params[name] ?? process.env[name];
        if (next === undefined || next === null)
            throw new Error(`Batch output file template references unknown value '${name}'.`);
        return String(next);
    });
}
async function writeDownloadedFile(downloadDir, outputName, remotePath, content) {
    const safeOutputName = sanitizePathPart(outputName || "output");
    const safeFileName = sanitizePathPart(remoteBaseName(remotePath) || `${safeOutputName}.out`);
    const localPath = join(downloadDir, safeOutputName, safeFileName);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, content);
    return localPath;
}
function remoteBaseName(remotePath) {
    return remotePath.split(/[\\/]/).filter(Boolean).pop() ?? "";
}
function sanitizePathPart(value) {
    return value.replace(/[^A-Za-z0-9_.-]/g, "_") || "file";
}
async function readInputFileContent(rootDir, value) {
    if (value.contentBase64) {
        const base64 = value.contentBase64.includes(",") ? value.contentBase64.slice(value.contentBase64.indexOf(",") + 1) : value.contentBase64;
        return Buffer.from(base64, "base64");
    }
    if (!value.localPath)
        throw new Error("Batch input file has no local file path.");
    const path = isAbsolute(value.localPath) ? resolve(value.localPath) : resolve(rootDir, value.localPath);
    const uploadsRoot = resolve(rootDir, "data", "batch-input-files");
    const rel = relative(uploadsRoot, path);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error("Batch input file path must be under data/batch-input-files.");
    }
    return await readFile(path);
}
function extractBatchDiagnostics(stdout, stderr) {
    const output = `${stdout}\n${stderr}`;
    const tracePath = output.match(/FICHIER\s*:\s*(.+)/i)?.[1]?.trim();
    const errno = output.match(/ERRNO\s*:\s*([^\s]+)/i)?.[1]?.trim();
    return { tracePath, errno };
}
async function sleep(ms, signal) {
    if (signal?.aborted)
        throw cancellationError();
    await new Promise((resolve, reject) => {
        const timer = setTimeout(done, ms);
        const abort = () => {
            clearTimeout(timer);
            reject(cancellationError());
        };
        function done() {
            signal?.removeEventListener("abort", abort);
            resolve();
        }
        signal?.addEventListener("abort", abort, { once: true });
    });
}
