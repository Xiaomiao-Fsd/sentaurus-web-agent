import type { VmStatus } from "@sentaurus-agent/shared";
import { config } from "../config.js";
import { runSshCommand } from "./sshClient.js";

function parseTool(lines: string[], name: string): string | null {
  const prefix = `TOOL:${name}=`;
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) || null;
}

export async function getVmStatus(): Promise<VmStatus> {
  const command = [
    "set -e",
    "echo SSH_OK",
    "echo HOSTNAME=$(hostname)",
    "echo USER=$(whoami)",
    "for t in sde sdevice sprocess swb inspect svisual; do p=$(command -v $t || true); echo TOOL:$t=$p; done",
    "echo SENTAURUS_VERSION_START",
    "sdevice -v 2>&1 | head -8 || true",
    "echo SENTAURUS_VERSION_END"
  ].join("; ");
  const result = await runSshCommand(command, 20_000);
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const lines = raw.split(/\r?\n/);
  const ok = result.ok && lines.includes("SSH_OK");
  const versionStart = lines.indexOf("SENTAURUS_VERSION_START");
  const versionEnd = lines.indexOf("SENTAURUS_VERSION_END");
  const version = versionStart >= 0 && versionEnd > versionStart
    ? lines.slice(versionStart + 1, versionEnd).join("\n")
    : undefined;

  return {
    ok,
    checkedAt: new Date().toISOString(),
    sshTarget: config.SENTAURUS_SSH_TARGET,
    hostname: lines.find((line) => line.startsWith("HOSTNAME="))?.slice("HOSTNAME=".length),
    user: lines.find((line) => line.startsWith("USER="))?.slice("USER=".length),
    sentaurusVersion: version,
    tools: {
      sde: parseTool(lines, "sde"),
      sdevice: parseTool(lines, "sdevice"),
      sprocess: parseTool(lines, "sprocess"),
      swb: parseTool(lines, "swb"),
      inspect: parseTool(lines, "inspect"),
      svisual: parseTool(lines, "svisual")
    },
    error: ok ? undefined : (result.error || result.stderr || "SSH/Sentaurus check failed"),
    raw
  };
}
