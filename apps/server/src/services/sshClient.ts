import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";

export type SshResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
  error?: string;
};

const DEFAULT_TIMEOUT_MS = 12_000;

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

let sshQueue = Promise.resolve();

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

function shouldRetry(result: SshResult): boolean {
  const text = [result.stderr, result.error].filter(Boolean).join("\n");
  return /Connection to .* port 22 timed out/i.test(text) || /Connection timed out/i.test(text);
}

async function runSshOnce(remoteCommand: string, timeoutMs: number, input?: string): Promise<SshResult> {
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

    const finish = (result: SshResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(outputPoll);
      cleanup();
      resolve(result);
    };

    const stopChild = () => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    };

    const timeout = setTimeout(() => {
      const { stdout, stderr } = readOutput();
      stopChild();
      finish({
        ok: false,
        stdout,
        stderr,
        error: buildSshError(stderr, undefined, `ssh command timed out after ${timeoutMs}ms`)
      });
    }, timeoutMs);

    const outputPoll = setInterval(() => {
      const { stdout, stderr } = readOutput();
      if (hasFatalSshError(stderr)) {
        stopChild();
        finish({ ok: false, stdout, stderr, error: buildSshError(stderr) });
        return;
      }
      if (hasCompletionMarker(stdout)) {
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
  });
}

async function runLocalCommand(command: string, args: string[], timeoutMs: number): Promise<SshResult> {
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

    const finish = (result: SshResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanup();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
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
  });
}

async function runSsh(remoteCommand: string, timeoutMs: number, input?: string): Promise<SshResult> {
  const run = async () => {
    const first = await runSshOnce(remoteCommand, timeoutMs, input);
    if (!shouldRetry(first)) return first;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await runSshOnce(remoteCommand, timeoutMs, input);
  };

  const result = sshQueue.then(run, run);
  sshQueue = result.then(() => undefined, () => undefined);
  return await result;
}

export async function runSshCommand(remoteCommand: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SshResult> {
  // Safety: remoteCommand must be constructed by backend allowlisted functions only.
  // Do not pass raw user input here.
  return runSsh(remoteCommand, timeoutMs);
}

export async function runSshCommandWithInput(remoteCommand: string, input: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SshResult> {
  // Safety: input must be constructed by backend allowlisted functions only.
  // Use this for large generated scripts so Windows hosts do not exceed command-line length limits.
  const tempDir = mkdtempSync(path.join(tmpdir(), "sentaurus-upload-"));
  const localPath = path.join(tempDir, "script.py");
  const remotePath = `/tmp/sentaurus-web-agent-${Date.now()}-${Math.random().toString(36).slice(2)}.py`;
  writeFileSync(localPath, input, "utf8");

  try {
    const copyResult = await runLocalCommand("scp", [
      ...sshOptions,
      localPath,
      `${config.SENTAURUS_SSH_TARGET}:${remotePath}`
    ], timeoutMs);
    if (!copyResult.ok) return copyResult;

    const command = `python ${remotePath}; code=$?; rm -f ${remotePath}; exit $code`;
    return await runSsh(command, timeoutMs);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
