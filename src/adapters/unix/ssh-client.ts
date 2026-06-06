import { readFile } from "node:fs/promises";
import { posix as posixPath } from "node:path";
import { Client, type SFTPWrapper } from "ssh2";
import type { EnvironmentConfig } from "../../config/environments.js";
import { cancellationError } from "../../engine/step-result.js";

export interface SshExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;

export class SshClient {
  constructor(private readonly env: EnvironmentConfig) {}

  async execute(hostRef: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<SshExecutionResult> {
    const host = this.hostConfig(hostRef);
    const privateKey = await this.privateKey(host);
    if (signal?.aborted) throw cancellationError();

    const execCommand = buildSshExecCommand(host, command);

    return await new Promise<SshExecutionResult>((resolve, reject) => {
      const client = new Client();
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const abort = () => finish(() => reject(cancellationError()));

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
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
          stream.on("close", (code: number | null) => {
            exitCode = code ?? 0;
            finish(() => resolve({ stdout, stderr, exitCode, stdoutTruncated, stderrTruncated }));
          });
          stream.on("data", (data: Buffer) => {
            const result = appendLimited(stdout, data);
            stdout = result.value;
            stdoutTruncated = stdoutTruncated || result.truncated;
          });
          stream.stderr.on("data", (data: Buffer) => {
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

  async uploadFile(hostRef: string, remotePath: string, content: Buffer, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const host = this.hostConfig(hostRef);
    const privateKey = await this.privateKey(host);
    if (signal?.aborted) throw cancellationError();

    await new Promise<void>((resolve, reject) => {
      const client = new Client();
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const abort = () => finish(() => reject(cancellationError()));

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
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
            .then(() => new Promise<void>((writeResolve, writeReject) => {
              sftp.writeFile(remotePath, content, (writeError) => {
                if (writeError) writeReject(writeError);
                else writeResolve();
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

  async downloadFile(hostRef: string, remotePath: string, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
    const host = this.hostConfig(hostRef);
    const privateKey = await this.privateKey(host);
    if (signal?.aborted) throw cancellationError();

    return await new Promise<Buffer>((resolve, reject) => {
      const client = new Client();
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const abort = () => finish(() => reject(cancellationError()));

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
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
            if (readError) finish(() => reject(readError));
            else finish(() => resolve(content));
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

  private hostConfig(hostRef: string): NonNullable<EnvironmentConfig["sshHosts"][string]> {
    const host = this.env.sshHosts[hostRef];
    if (!host) throw new Error(`Unknown SSH hostRef '${hostRef}'.`);
    if (!host.host || !host.username) throw new Error(`SSH host '${hostRef}' requires host and username.`);
    return host;
  }

  private async privateKey(host: NonNullable<EnvironmentConfig["sshHosts"][string]>): Promise<string | undefined> {
    return host.privateKeyPath ? await readFile(host.privateKeyPath, "utf8") : undefined;
  }
}

export function buildSshExecCommand(
  host: { shell?: string; loginShell?: boolean },
  command: string
): string {
  if (!host.loginShell) return command;
  const shell = host.shell?.trim() || "bash";
  return `${shellQuote(shell)} -lc ${shellQuote(command)}`;
}

function appendLimited(current: string, chunk: Buffer): { value: string; truncated: boolean } {
  const next = current + chunk.toString("utf8");
  const nextBytes = Buffer.byteLength(next, "utf8");
  if (nextBytes <= MAX_CAPTURE_BYTES) return { value: next, truncated: false };
  const buffer = Buffer.from(next, "utf8");
  const tail = buffer.subarray(buffer.length - MAX_CAPTURE_BYTES);
  return { value: tail.toString("utf8"), truncated: true };
}

async function mkdirpSftp(sftp: SFTPWrapper, directory: string): Promise<void> {
  if (!sftp || !directory || directory === "." || directory === "/") return;
  const absolute = directory.startsWith("/");
  const parts = directory.split("/").filter(Boolean);
  let current = absolute ? "/" : "";
  for (const part of parts) {
    current = current === "/" ? `/${part}` : current ? `${current}/${part}` : part;
    if (await sftpPathExists(sftp, current)) continue;
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(current, (error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "EEXIST") reject(error);
        else resolve();
      });
    });
  }
}

async function sftpPathExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    sftp.stat(path, (error) => resolve(!error));
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
