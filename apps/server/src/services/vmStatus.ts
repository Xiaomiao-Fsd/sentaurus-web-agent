import type { VmStatus } from "@sentaurus-agent/shared";
import { config } from "../config.js";
import { runSshCommand } from "./sshClient.js";

function parseTool(lines: string[], name: string): string | null {
  const marker = `TOOL:${name}`;
  const index = lines.indexOf(marker);
  if (index < 0) return null;
  const value = lines[index + 1]?.trim();
  return value && value.startsWith("/") ? value : null;
}

function parseNextLine(lines: string[], marker: string): string | undefined {
  const index = lines.indexOf(marker);
  return index >= 0 ? lines[index + 1]?.trim() || undefined : undefined;
}

export async function getVmStatus(): Promise<VmStatus> {
  const command = [
    "echo SSH_OK",
    "echo HOSTNAME",
    "hostname",
    "echo USER",
    "whoami",
    "echo TOOL:sde",
    "which sde",
    "echo TOOL:sdevice",
    "which sdevice",
    "echo TOOL:sprocess",
    "which sprocess",
    "echo TOOL:swb",
    "which swb",
    "echo TOOL:inspect",
    "which inspect",
    "echo TOOL:svisual",
    "which svisual",
    "echo SENTAURUS_VERSION_START",
    "timeout 5s sdevice -v | head -8",
    "echo SENTAURUS_VERSION_END",
    "echo VM_STATUS_DONE"
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
    hostname: parseNextLine(lines, "HOSTNAME"),
    user: parseNextLine(lines, "USER"),
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
