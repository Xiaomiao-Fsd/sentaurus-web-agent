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

export async function runSshCommand(remoteCommand: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SshResult> {
  // Safety: remoteCommand must be constructed by backend allowlisted functions only.
  // Do not pass raw user input here.
  try {
    const result = await execa("ssh", [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      config.SENTAURUS_SSH_TARGET,
      remoteCommand
    ], { timeout: timeoutMs, reject: false });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, stdout: "", stderr: "", error: message };
  }
}
