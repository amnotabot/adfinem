import { readFile } from "node:fs/promises";
import { posix as posixPath } from "node:path";
import { Client } from "ssh2";
import { cancellationError } from "../../engine/step-result.js";
const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
export class SshClient {
    env;
    constructor(env) {
        this.env = env;
    }
    async execute(hostRef, command, timeoutMs, signal) {
        const host = this.hostConfig(hostRef);
        const privateKey = await this.privateKey(host);
        if (signal?.aborted)
            throw cancellationError();
        const execCommand = buildSshExecCommand(host, command);
        return await new Promise((resolve, reject) => {
            const client = new Client();
            let timer;
            let settled = false;
            const abort = () => finish(() => reject(cancellationError()));
            const finish = (fn) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                client.end();
                fn();
            };
            signal?.addEventListener("abort", abort, { once: true });
            client.on("ready", () => {
                timer = setTimeout(() => {
                    finish(() => reject(new Error(`SSH command timed out after ${timeoutMs}ms.`)));
                }, timeoutMs);
                client.exec(execCommand, (err, stream) => {
                    if (err) {
                        finish(() => reject(err));
                        return;
                    }
                    let stdout = "";
                    let stderr = "";
                    let stdoutTruncated = false;
                    let stderrTruncated = false;
                    let exitCode = 0;
                    stream.on("close", (code) => {
                        exitCode = code ?? 0;
                        finish(() => resolve({ stdout, stderr, exitCode, stdoutTruncated, stderrTruncated }));
                    });
                    stream.on("data", (data) => {
                        const result = appendLimited(stdout, data);
                        stdout = result.value;
                        stdoutTruncated = stdoutTruncated || result.truncated;
                    });
                    stream.stderr.on("data", (data) => {
                        const result = appendLimited(stderr, data);
                        stderr = result.value;
                        stderrTruncated = stderrTruncated || result.truncated;
                    });
                });
            });
            client.on("error", (error) => finish(() => reject(error)));
            client.connect({
                host: host.host,
                username: host.username,
                password: host.password,
                privateKey,
                readyTimeout: Math.min(timeoutMs, 30_000)
            });
        });
    }
    async uploadFile(hostRef, remotePath, content, timeoutMs, signal) {
        const host = this.hostConfig(hostRef);
        const privateKey = await this.privateKey(host);
        if (signal?.aborted)
            throw cancellationError();
        await new Promise((resolve, reject) => {
            const client = new Client();
            let timer;
            let settled = false;
            const abort = () => finish(() => reject(cancellationError()));
            const finish = (fn) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                client.end();
                fn();
            };
            signal?.addEventListener("abort", abort, { once: true });
            client.on("ready", () => {
                timer = setTimeout(() => {
                    finish(() => reject(new Error(`SFTP upload timed out after ${timeoutMs}ms.`)));
                }, timeoutMs);
                client.sftp((err, sftp) => {
                    if (err) {
                        finish(() => reject(err));
                        return;
                    }
                    void mkdirpSftp(sftp, posixPath.dirname(remotePath))
                        .then(() => new Promise((writeResolve, writeReject) => {
                        sftp.writeFile(remotePath, content, (writeError) => {
                            if (writeError)
                                writeReject(writeError);
                            else
                                writeResolve();
                        });
                    }))
                        .then(() => finish(resolve))
                        .catch((uploadError) => finish(() => reject(uploadError)));
                });
            });
            client.on("error", (error) => finish(() => reject(error)));
            client.connect({
                host: host.host,
                username: host.username,
                password: host.password,
                privateKey,
                readyTimeout: Math.min(timeoutMs, 30_000)
            });
        });
    }
    async downloadFile(hostRef, remotePath, timeoutMs, signal) {
        const host = this.hostConfig(hostRef);
        const privateKey = await this.privateKey(host);
        if (signal?.aborted)
            throw cancellationError();
        return await new Promise((resolve, reject) => {
            const client = new Client();
            let timer;
            let settled = false;
            const abort = () => finish(() => reject(cancellationError()));
            const finish = (fn) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                signal?.removeEventListener("abort", abort);
                client.end();
                fn();
            };
            signal?.addEventListener("abort", abort, { once: true });
            client.on("ready", () => {
                timer = setTimeout(() => {
                    finish(() => reject(new Error(`SFTP download timed out after ${timeoutMs}ms.`)));
                }, timeoutMs);
                client.sftp((err, sftp) => {
                    if (err) {
                        finish(() => reject(err));
                        return;
                    }
                    sftp.readFile(remotePath, (readError, content) => {
                        if (readError)
                            finish(() => reject(readError));
                        else
                            finish(() => resolve(content));
                    });
                });
            });
            client.on("error", (error) => finish(() => reject(error)));
            client.connect({
                host: host.host,
                username: host.username,
                password: host.password,
                privateKey,
                readyTimeout: Math.min(timeoutMs, 30_000)
            });
        });
    }
    hostConfig(hostRef) {
        const host = this.env.sshHosts[hostRef];
        if (!host)
            throw new Error(`Unknown SSH hostRef '${hostRef}'.`);
        if (!host.host || !host.username)
            throw new Error(`SSH host '${hostRef}' requires host and username.`);
        return host;
    }
    async privateKey(host) {
        return host.privateKeyPath ? await readFile(host.privateKeyPath, "utf8") : undefined;
    }
}
export function buildSshExecCommand(host, command) {
    if (!host.loginShell)
        return command;
    const shell = host.shell?.trim() || "bash";
    return `${shellQuote(shell)} -lc ${shellQuote(command)}`;
}
function appendLimited(current, chunk) {
    const next = current + chunk.toString("utf8");
    const nextBytes = Buffer.byteLength(next, "utf8");
    if (nextBytes <= MAX_CAPTURE_BYTES)
        return { value: next, truncated: false };
    const buffer = Buffer.from(next, "utf8");
    const tail = buffer.subarray(buffer.length - MAX_CAPTURE_BYTES);
    return { value: tail.toString("utf8"), truncated: true };
}
async function mkdirpSftp(sftp, directory) {
    if (!sftp || !directory || directory === "." || directory === "/")
        return;
    const absolute = directory.startsWith("/");
    const parts = directory.split("/").filter(Boolean);
    let current = absolute ? "/" : "";
    for (const part of parts) {
        current = current === "/" ? `/${part}` : current ? `${current}/${part}` : part;
        if (await sftpPathExists(sftp, current))
            continue;
        await new Promise((resolve, reject) => {
            sftp.mkdir(current, (error) => {
                if (error && error.code !== "EEXIST")
                    reject(error);
                else
                    resolve();
            });
        });
    }
}
async function sftpPathExists(sftp, path) {
    return await new Promise((resolve) => {
        sftp.stat(path, (error) => resolve(!error));
    });
}
function shellQuote(value) {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
