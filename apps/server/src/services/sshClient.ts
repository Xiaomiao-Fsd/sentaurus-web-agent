import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";

export type SshResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
  error?: string;
  errorCode?: "VM_SSH_QUEUE_TIMEOUT" | "VM_SSH_ABORTED";
  lane?: SshLane;
  enqueuedAt?: number;
  startedAt?: number;
  queueWaitMs?: number;
  executionMs?: number;
  dedupeKey?: string;
};

export type SshLane = "interactive" | "status" | "history" | "files";

export type SshRunOptions = {
  lane?: SshLane;
  queueDeadlineMs?: number;
  dedupeKey?: string;
  signal?: AbortSignal;
};

export type SshFileDownloadMetadata = {
  path: string;
  fileName: string;
  size: number;
  sha256: string;
};

export type SshFileDownloadResult = SshResult & {
  data?: Buffer;
  metadata?: SshFileDownloadMetadata;
  statusCode?: number;
};

export type SshLocalCommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
) => Promise<SshResult>;

const DEFAULT_TIMEOUT_MS = 12_000;
const defaultQueueDeadlineMs: Record<SshLane, number> = {
  interactive: 5_000,
  status: 1_000,
  history: 10_000,
  files: 10_000
};

const fatalSshErrorPatterns = [
  /Permission denied \([^)]+\)\.?/i,
  /Could not resolve hostname/i,
  /Connection timed out/i,
  /Connection refused/i,
  /No route to host/i,
  /Host key verification failed/i
];

const completionMarkers = [
  "VM_STATUS_DONE",
  "REMOTE_AGENT_DONE",
  "REMOTE_ARTIFACT_DONE"
];

const laneQueues: Record<SshLane, Promise<void>> = {
  interactive: Promise.resolve(),
  status: Promise.resolve(),
  history: Promise.resolve(),
  files: Promise.resolve()
};
type SshFlight = {
  promise: Promise<SshResult>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
  lane: SshLane;
  enqueuedAt: number;
  dedupeKey?: string;
  key?: string;
};

const sshSingleFlight = new Map<string, SshFlight>();

const sshOptions = [
  "-o", "BatchMode=yes",
  "-o", "PreferredAuthentications=publickey",
  "-o", "PasswordAuthentication=no",
  "-o", "KbdInteractiveAuthentication=no",
  "-o", "GSSAPIAuthentication=no",
  "-o", "NumberOfPasswordPrompts=0",
  "-o", "ConnectTimeout=8",
  "-o", "ConnectionAttempts=1",
  "-o", "ServerAliveInterval=4",
  "-o", "ServerAliveCountMax=1",
  "-o", "StrictHostKeyChecking=accept-new"
];

function errorString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value === undefined || value === null) return "";
  return String(value);
}

function hasFatalSshError(stderr: string): boolean {
  return fatalSshErrorPatterns.some((pattern) => pattern.test(stderr));
}

function buildSshError(stderr: string, exitCode?: number, suffix?: string): string {
  return [
    stderr.trim(),
    exitCode !== undefined ? `ssh exited with code ${exitCode}` : "",
    suffix || ""
  ].filter(Boolean).join("; ") || "VM SSH command failed";
}

function hasCompletionMarker(stdout: string): boolean {
  return completionMarkers.some((marker) => stdout.includes(marker));
}

function hasCompleteJsonPayload(stdout: string): boolean {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const payload = JSON.parse(trimmed) as Record<string, unknown>;
      if ("ok" in payload || "agent" in payload || "contentB64" in payload) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.killed) return;
  if (process.platform === "win32" && typeof child.pid === "number") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
  }
  if (!child.killed) child.kill("SIGKILL");
}

function abortedResult(lane?: SshLane, enqueuedAt?: number, dedupeKey?: string): SshResult {
  return {
    ok: false,
    stdout: "",
    stderr: "",
    errorCode: "VM_SSH_ABORTED",
    error: "VM_SSH_ABORTED: SSH request no longer has an active consumer",
    lane,
    enqueuedAt,
    queueWaitMs: enqueuedAt === undefined ? undefined : Date.now() - enqueuedAt,
    executionMs: 0,
    dedupeKey
  };
}

function shouldRetry(result: SshResult): boolean {
  const text = [result.stderr, result.error].filter(Boolean).join("\n");
  return /Connection to .* port 22 timed out/i.test(text) || /Connection timed out/i.test(text);
}

async function runSshOnce(remoteCommand: string, timeoutMs: number, input?: string, signal?: AbortSignal): Promise<SshResult> {
  if (signal?.aborted) return abortedResult();
  return await new Promise<SshResult>((resolve) => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "sentaurus-ssh-"));
    const stdoutPath = path.join(tempDir, "stdout.txt");
    const stderrPath = path.join(tempDir, "stderr.txt");
    const stdoutFd = openSync(stdoutPath, "w+");
    const stderrFd = openSync(stderrPath, "w+");

    const readText = (filePath: string) => {
      try {
        return readFileSync(filePath, "utf8");
      } catch {
        return "";
      }
    };

    const readOutput = () => ({
      stdout: readText(stdoutPath),
      stderr: readText(stderrPath)
    });

    const cleanup = () => {
      try {
        closeSync(stdoutFd);
      } catch {
        // Already closed.
      }
      try {
        closeSync(stderrFd);
      } catch {
        // Already closed.
      }
      rmSync(tempDir, { recursive: true, force: true });
    };

    const child = spawn("ssh", [
      ...sshOptions,
      config.SENTAURUS_SSH_TARGET,
      remoteCommand
    ], { stdio: [input === undefined ? "ignore" : "pipe", stdoutFd, stderrFd] });

    let settled = false;

    let timeout: NodeJS.Timeout | undefined;
    let outputPoll: NodeJS.Timeout | undefined;
    const onAbort = () => {
      const { stdout, stderr } = readOutput();
      stopChild();
      finish({ ...abortedResult(), stdout, stderr });
    };

    const finish = (result: SshResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (outputPoll) clearInterval(outputPoll);
      signal?.removeEventListener("abort", onAbort);
      cleanup();
      resolve(result);
    };

    const stopChild = () => terminateProcessTree(child);

    timeout = setTimeout(() => {
      const { stdout, stderr } = readOutput();
      stopChild();
      finish({
        ok: false,
        stdout,
        stderr,
        error: buildSshError(stderr, undefined, `ssh command timed out after ${timeoutMs}ms`)
      });
    }, timeoutMs);

    outputPoll = setInterval(() => {
      const { stdout, stderr } = readOutput();
      if (hasFatalSshError(stderr)) {
        stopChild();
        finish({ ok: false, stdout, stderr, error: buildSshError(stderr) });
        return;
      }
      if (hasCompletionMarker(stdout) || hasCompleteJsonPayload(stdout)) {
        stopChild();
        finish({ ok: true, stdout, stderr });
      }
    }, 100);

    child.on("error", (err) => {
      const { stdout, stderr } = readOutput();
      finish({ ok: false, stdout, stderr, error: errorString(err) || "Failed to start ssh" });
    });

    child.on("close", (code) => {
      if (settled) return;
      const { stdout, stderr } = readOutput();
      const exitCode = typeof code === "number" ? code : undefined;
      finish({
        ok: exitCode === 0,
        stdout,
        stderr,
        exitCode,
        error: exitCode === 0 ? undefined : buildSshError(stderr, exitCode)
      });
    });

    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function runLocalCommand(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<SshResult> {
  if (signal?.aborted) return abortedResult();
  return await new Promise<SshResult>((resolve) => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "sentaurus-local-"));
    const stdoutPath = path.join(tempDir, "stdout.txt");
    const stderrPath = path.join(tempDir, "stderr.txt");
    const stdoutFd = openSync(stdoutPath, "w+");
    const stderrFd = openSync(stderrPath, "w+");

    const readText = (filePath: string) => {
      try {
        return readFileSync(filePath, "utf8");
      } catch {
        return "";
      }
    };

    const cleanup = () => {
      try {
        closeSync(stdoutFd);
      } catch {
        // Already closed.
      }
      try {
        closeSync(stderrFd);
      } catch {
        // Already closed.
      }
      rmSync(tempDir, { recursive: true, force: true });
    };

    const child = spawn(command, args, { stdio: ["ignore", stdoutFd, stderrFd] });
    let settled = false;

    let timeout: NodeJS.Timeout | undefined;
    const onAbort = () => {
      terminateProcessTree(child);
      finish({
        ...abortedResult(),
        stdout: readText(stdoutPath),
        stderr: readText(stderrPath)
      });
    };

    const finish = (result: SshResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      cleanup();
      resolve(result);
    };

    timeout = setTimeout(() => {
      terminateProcessTree(child);
      finish({
        ok: false,
        stdout: readText(stdoutPath),
        stderr: readText(stderrPath),
        error: `${command} command timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);

    child.on("error", (err) => {
      finish({
        ok: false,
        stdout: readText(stdoutPath),
        stderr: readText(stderrPath),
        error: errorString(err) || `Failed to start ${command}`
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      const stdout = readText(stdoutPath);
      const stderr = readText(stderrPath);
      const exitCode = typeof code === "number" ? code : undefined;
      finish({
        ok: exitCode === 0,
        stdout,
        stderr,
        exitCode,
        error: exitCode === 0 ? undefined : buildSshError(stderr, exitCode)
      });
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function runLocalCommandAttempts(
  command: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  retry: boolean,
  runner: SshLocalCommandRunner
): Promise<SshResult> {
  const first = await runner(command, args, timeoutMs, signal);
  if (!retry || signal?.aborted || !shouldRetry(first)) return first;
  await new Promise((resolve) => setTimeout(resolve, 500));
  return await runner(command, args, timeoutMs, signal);
}

function parseFileDownloadMetadata(raw: string): SshFileDownloadResult {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) {
    return { ok: false, stdout: raw, stderr: "", error: `VM file staging did not return JSON: ${raw.slice(0, 500)}` };
  }
  try {
    const payload = JSON.parse(jsonLine) as Partial<SshFileDownloadMetadata> & {
      ok?: boolean;
      error?: string;
      statusCode?: number;
    };
    if (payload.ok === false) {
      return {
        ok: false,
        stdout: raw,
        stderr: "",
        error: payload.error || "VM file staging failed",
        statusCode: typeof payload.statusCode === "number" ? payload.statusCode : undefined
      };
    }
    if (
      typeof payload.path !== "string"
      || typeof payload.fileName !== "string"
      || typeof payload.size !== "number"
      || !Number.isSafeInteger(payload.size)
      || payload.size < 0
      || typeof payload.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(payload.sha256)
    ) {
      return { ok: false, stdout: raw, stderr: "", error: "VM file staging response was incomplete" };
    }
    return {
      ok: true,
      stdout: raw,
      stderr: "",
      metadata: {
        path: payload.path,
        fileName: payload.fileName,
        size: payload.size,
        sha256: payload.sha256
      }
    };
  } catch (error) {
    return {
      ok: false,
      stdout: raw,
      stderr: "",
      error: `VM file staging returned invalid JSON: ${errorString(error)}`
    };
  }
}

function safeRemoteDownloadPath(remotePath: string): boolean {
  return /^\/tmp\/sentaurus-web-artifact-[A-Za-z0-9-]{12,120}$/.test(remotePath);
}

export async function executeSshCommandWithInputDownload(
  remoteCommand: string,
  input: string,
  remoteDownloadPath: string,
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
  runner: SshLocalCommandRunner = runLocalCommand
): Promise<SshFileDownloadResult> {
  if (!safeRemoteDownloadPath(remoteDownloadPath)) {
    return { ok: false, stdout: "", stderr: "", error: "Unsafe remote download staging path" };
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return { ok: false, stdout: "", stderr: "", error: "Invalid remote download size limit" };
  }
  const tempDir = mkdtempSync(path.join(tmpdir(), "sentaurus-download-"));
  const localScriptPath = path.join(tempDir, "stage.py");
  const localDownloadPath = path.join(tempDir, "artifact.bin");
  const remoteScriptPath = `/tmp/sentaurus-web-agent-${Date.now()}-${Math.random().toString(36).slice(2)}.py`;
  let result: SshFileDownloadResult = { ok: false, stdout: "", stderr: "", error: "VM file download did not run" };
  writeFileSync(localScriptPath, input, "utf8");

  try {
    const upload = await runLocalCommandAttempts("scp", [
      ...sshOptions,
      localScriptPath,
      `${config.SENTAURUS_SSH_TARGET}:${remoteScriptPath}`
    ], timeoutMs, signal, true, runner);
    if (!upload.ok) {
      result = upload;
      return result;
    }

    const scriptCommand = remoteCommand.trim().replace(/\s+-\s*$/, "") || "python";
    const stage = await runLocalCommandAttempts("ssh", [
      ...sshOptions,
      config.SENTAURUS_SSH_TARGET,
      `trap 'rm -f -- ${remoteScriptPath}' EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; ${scriptCommand} ${remoteScriptPath}`
    ], timeoutMs, signal, true, runner);
    if (!stage.ok) {
      result = stage;
      return result;
    }

    const metadataResult = parseFileDownloadMetadata([stage.stdout, stage.stderr].filter(Boolean).join("\n"));
    if (!metadataResult.ok || !metadataResult.metadata) {
      result = metadataResult;
      return result;
    }
    if (metadataResult.metadata.size > maxBytes) {
      result = {
        ok: false,
        stdout: stage.stdout,
        stderr: stage.stderr,
        error: `VM artifact exceeds ${maxBytes} byte download limit`,
        statusCode: 413
      };
      return result;
    }

    const download = await runLocalCommandAttempts("scp", [
      ...sshOptions,
      `${config.SENTAURUS_SSH_TARGET}:${remoteDownloadPath}`,
      localDownloadPath
    ], timeoutMs, signal, true, runner);
    if (!download.ok) {
      result = download;
      return result;
    }

    const localSize = statSync(localDownloadPath).size;
    if (localSize !== metadataResult.metadata.size || localSize > maxBytes) {
      result = {
        ok: false,
        stdout: download.stdout,
        stderr: download.stderr,
        error: `Downloaded artifact size mismatch: expected ${metadataResult.metadata.size}, got ${localSize}`
      };
      return result;
    }
    const data = readFileSync(localDownloadPath);
    const localSha256 = createHash("sha256").update(data).digest("hex");
    if (localSha256 !== metadataResult.metadata.sha256) {
      result = {
        ok: false,
        stdout: download.stdout,
        stderr: download.stderr,
        error: "Downloaded artifact SHA-256 mismatch"
      };
      return result;
    }
    result = {
      ok: true,
      stdout: stage.stdout,
      stderr: stage.stderr,
      exitCode: 0,
      data,
      metadata: metadataResult.metadata
    };
    return result;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    const cleanup = await runLocalCommandAttempts("ssh", [
      ...sshOptions,
      config.SENTAURUS_SSH_TARGET,
      `rm -f -- ${remoteScriptPath} ${remoteDownloadPath}`
    ], 5_000, undefined, true, runner);
    if (!cleanup.ok && result.ok) {
      result.ok = false;
      result.data = undefined;
      result.error = cleanup.error || cleanup.stderr || "Failed to clean VM download staging files";
    }
  }
}

export async function runSshCommandWithInputDownload(
  remoteCommand: string,
  input: string,
  remoteDownloadPath: string,
  maxBytes: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: SshRunOptions = {}
): Promise<SshFileDownloadResult> {
  return await scheduleSsh(
    (signal) => executeSshCommandWithInputDownload(
      remoteCommand,
      input,
      remoteDownloadPath,
      maxBytes,
      timeoutMs,
      signal
    ),
    options
  ) as SshFileDownloadResult;
}

async function runSshAttempts(remoteCommand: string, timeoutMs: number, input?: string, retry = true, signal?: AbortSignal): Promise<SshResult> {
  const first = await runSshOnce(remoteCommand, timeoutMs, input, signal);
  if (!retry || signal?.aborted || !shouldRetry(first)) return first;
  await new Promise((resolve) => setTimeout(resolve, 500));
  return await runSshOnce(remoteCommand, timeoutMs, input, signal);
}

function queueTimeoutResult(
  lane: SshLane,
  enqueuedAt: number,
  queueDeadlineMs: number,
  dedupeKey?: string
): SshResult {
  return {
    ok: false,
    stdout: "",
    stderr: "",
    errorCode: "VM_SSH_QUEUE_TIMEOUT",
    error: `VM_SSH_QUEUE_TIMEOUT: ${lane} lane exceeded ${queueDeadlineMs}ms queue deadline`,
    lane,
    enqueuedAt,
    queueWaitMs: Date.now() - enqueuedAt,
    executionMs: 0,
    dedupeKey
  };
}

function attachFlightConsumer(flight: SshFlight, signal?: AbortSignal): Promise<SshResult> {
  flight.consumers += 1;
  return new Promise<SshResult>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      flight.consumers = Math.max(0, flight.consumers - 1);
      if (!flight.settled && flight.consumers === 0) {
        flight.controller.abort();
        if (flight.key && sshSingleFlight.get(flight.key) === flight) sshSingleFlight.delete(flight.key);
      }
    };
    const onAbort = () => {
      signal?.removeEventListener("abort", onAbort);
      release();
      resolve(abortedResult(flight.lane, flight.enqueuedAt, flight.dedupeKey));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    flight.promise.then((result) => {
      signal?.removeEventListener("abort", onAbort);
      release();
      resolve(result);
    }, (error) => {
      signal?.removeEventListener("abort", onAbort);
      release();
      reject(error);
    });
  });
}

export async function scheduleSsh(
  run: (signal: AbortSignal) => Promise<SshResult>,
  options: SshRunOptions = {}
): Promise<SshResult> {
  const lane = options.lane || "interactive";
  const queueDeadlineMs = options.queueDeadlineMs ?? defaultQueueDeadlineMs[lane];
  const singleFlightKey = options.dedupeKey ? `${lane}:${options.dedupeKey}` : "";
  if (singleFlightKey) {
    const active = sshSingleFlight.get(singleFlightKey);
    if (active && !active.controller.signal.aborted) return await attachFlightConsumer(active, options.signal);
    if (active) sshSingleFlight.delete(singleFlightKey);
  }

  const enqueuedAt = Date.now();
  const controller = new AbortController();
  let queueExpired = false;
  let queueTimer: NodeJS.Timeout | undefined;
  const predecessor = laneQueues[lane];
  const execute = async () => {
    if (controller.signal.aborted) return abortedResult(lane, enqueuedAt, options.dedupeKey);
    if (queueExpired) return queueTimeoutResult(lane, enqueuedAt, queueDeadlineMs, options.dedupeKey);
    if (queueTimer) clearTimeout(queueTimer);
    const startedAt = Date.now();
    const result = await run(controller.signal);
    const timed: SshResult = {
      ...result,
      lane,
      enqueuedAt,
      startedAt,
      queueWaitMs: startedAt - enqueuedAt,
      executionMs: Date.now() - startedAt,
      dedupeKey: options.dedupeKey
    };
    console.info(JSON.stringify({
      event: "vm_ssh_timing",
      lane,
      dedupeKey: options.dedupeKey,
      ok: timed.ok,
      errorCode: timed.errorCode,
      queueWaitMs: timed.queueWaitMs,
      executionMs: timed.executionMs
    }));
    return timed;
  };
  const execution = predecessor.then(execute, execute);
  laneQueues[lane] = execution.then(() => undefined, () => undefined);

  const deadline = new Promise<SshResult>((resolve) => {
    queueTimer = setTimeout(() => {
      queueExpired = true;
      resolve(queueTimeoutResult(lane, enqueuedAt, queueDeadlineMs, options.dedupeKey));
    }, queueDeadlineMs);
  });
  let cancelListener: (() => void) | undefined;
  const cancelled = new Promise<SshResult>((resolve) => {
    cancelListener = () => resolve(abortedResult(lane, enqueuedAt, options.dedupeKey));
    controller.signal.addEventListener("abort", cancelListener, { once: true });
  });
  const scheduled = Promise.race([execution, deadline, cancelled]).finally(() => {
    if (queueTimer) clearTimeout(queueTimer);
    if (cancelListener) controller.signal.removeEventListener("abort", cancelListener);
  });
  const flight: SshFlight = {
    promise: scheduled,
    controller,
    consumers: 0,
    settled: false,
    lane,
    enqueuedAt,
    dedupeKey: options.dedupeKey,
    key: singleFlightKey || undefined
  };
  if (singleFlightKey) {
    sshSingleFlight.set(singleFlightKey, flight);
  }
  scheduled.finally(() => {
    flight.settled = true;
    if (singleFlightKey && sshSingleFlight.get(singleFlightKey) === flight) {
      sshSingleFlight.delete(singleFlightKey);
    }
  }).catch(() => undefined);
  return await attachFlightConsumer(flight, options.signal);
}

async function runSsh(
  remoteCommand: string,
  timeoutMs: number,
  input?: string,
  retry = true,
  options: SshRunOptions = {}
): Promise<SshResult> {
  return await scheduleSsh((signal) => runSshAttempts(remoteCommand, timeoutMs, input, retry, signal), options);
}

export async function runSshCommand(remoteCommand: string, timeoutMs = DEFAULT_TIMEOUT_MS, options: SshRunOptions = {}): Promise<SshResult> {
  // Safety: remoteCommand must be constructed by backend allowlisted functions only.
  // Do not pass raw user input here.
  return runSsh(remoteCommand, timeoutMs, undefined, true, options);
}

export async function runSshCommandFast(remoteCommand: string, timeoutMs = 5_000, options: SshRunOptions = {}): Promise<SshResult> {
  // Safety: remoteCommand must be constructed by backend allowlisted functions only.
  // Fast status probes avoid retrying so unavailable VMs fail quickly.
  return runSsh(remoteCommand, timeoutMs, undefined, false, { lane: "status", queueDeadlineMs: 1_000, ...options });
}

export async function runSshCommandWithInput(
  remoteCommand: string,
  input: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: SshRunOptions = {}
): Promise<SshResult> {
  // Safety: input must be constructed by backend allowlisted functions only.
  // Use this for large generated scripts so Windows hosts do not exceed command-line length limits.
  return runSshCommandWithInputInternal(remoteCommand, input, timeoutMs, true, options);
}

export async function runSshCommandWithInputFast(
  remoteCommand: string,
  input: string,
  timeoutMs = 5_000,
  options: SshRunOptions = {}
): Promise<SshResult> {
  // Safety: input must be constructed by backend allowlisted functions only.
  // Fast status probes avoid retrying so unavailable VMs fail quickly.
  return runSshCommandWithInputInternal(remoteCommand, input, timeoutMs, false, { lane: "status", queueDeadlineMs: 1_000, ...options });
}

async function runSshCommandWithInputInternal(
  remoteCommand: string,
  input: string,
  timeoutMs: number,
  retry: boolean,
  options: SshRunOptions
): Promise<SshResult> {
  return await scheduleSsh(async (signal) => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "sentaurus-upload-"));
    const localPath = path.join(tempDir, "script.py");
    const remotePath = `/tmp/sentaurus-web-agent-${Date.now()}-${Math.random().toString(36).slice(2)}.py`;
    let uploaded = false;
    let executionResult: SshResult | undefined;
    writeFileSync(localPath, input, "utf8");

    try {
      const copyResult = await runLocalCommand("scp", [
        ...sshOptions,
        localPath,
        `${config.SENTAURUS_SSH_TARGET}:${remotePath}`
      ], timeoutMs, signal);
      if (!copyResult.ok) return copyResult;
      uploaded = true;

      const scriptCommand = remoteCommand.trim().replace(/\s+-\s*$/, "") || "python";
      const command = `trap 'rm -f -- ${remotePath}' EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; ${scriptCommand} ${remotePath}`;
      executionResult = await runSshAttempts(command, timeoutMs, undefined, retry, signal);
      return executionResult;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (uploaded && (!executionResult || !executionResult.ok)) {
        await runLocalCommand("ssh", [
          ...sshOptions,
          config.SENTAURUS_SSH_TARGET,
          `rm -f -- ${remotePath}`
        ], 5_000);
      }
    }
  }, options);
}
