import { execa } from "execa";
import { config } from "../config.js";

export type SshResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
  error?: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;

function errorString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value === undefined || value === null) return "";
  return String(value);
}

function caughtSshError(err: unknown): SshResult {
  const record = err && typeof err === "object" ? err as Record<string, unknown> : {};
  const stdout = errorString(record.stdout);
  const stderr = errorString(record.stderr);
  const shortMessage = errorString(record.shortMessage);
  const message = errorString(err);
  const exitCode = typeof record.exitCode === "number" ? record.exitCode : undefined;
  const signal = errorString(record.signal);
  const timedOut = record.timedOut === true;
  const details = [
    shortMessage || message,
    timedOut ? "ssh command timed out" : "",
    signal ? `signal: ${signal}` : "",
    exitCode !== undefined ? `exit code: ${exitCode}` : ""
  ].filter(Boolean).join("; ");
  return { ok: false, stdout, stderr, exitCode, error: details || "VM SSH command failed" };
}

async function runSsh(remoteCommand: string, timeoutMs: number, input?: string): Promise<SshResult> {
  try {
    const result = await execa("ssh", [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      config.SENTAURUS_SSH_TARGET,
      remoteCommand
    ], { timeout: timeoutMs, reject: false, input });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      error: result.exitCode === 0 ? undefined : [result.stderr, `ssh exited with code ${result.exitCode}`].filter(Boolean).join("; ")
    };
  } catch (err) {
    return caughtSshError(err);
  }
}

export async function runSshCommand(remoteCommand: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SshResult> {
  // Safety: remoteCommand must be constructed by backend allowlisted functions only.
  // Do not pass raw user input here.
  return runSsh(remoteCommand, timeoutMs);
}

export async function runSshCommandWithInput(remoteCommand: string, input: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SshResult> {
  // Safety: input must be constructed by backend allowlisted functions only.
  // Use this for large generated scripts so Windows hosts do not exceed command-line length limits.
  return runSsh(remoteCommand, timeoutMs, input);
}
