import { config } from "../config.js";
import { runSshCommand } from "./sshClient.js";

export async function prepareRemoteRun(remoteDir: string): Promise<{ ok: boolean; message: string }> {
  if (!config.realJobsEnabled) {
    return {
      ok: false,
      message: "Real jobs are disabled. Set ENABLE_REAL_JOBS=1 only after reviewing command allowlists and cancellation behavior."
    };
  }
  if (!remoteDir.startsWith(config.SENTAURUS_REMOTE_BASE + "/run_")) {
    throw new Error("Refusing to prepare remote directory outside configured run base");
  }
  const escaped = remoteDir.replace(/'/g, "'\\''");
  const result = await runSshCommand(`mkdir -p '${escaped}'/input '${escaped}'/logs '${escaped}'/artifacts && echo READY`);
  return { ok: result.ok, message: result.ok ? result.stdout : (result.error || result.stderr) };
}
