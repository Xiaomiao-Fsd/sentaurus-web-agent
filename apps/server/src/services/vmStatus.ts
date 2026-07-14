import type { VmStatus } from "@sentaurus-agent/shared";
import { config } from "../config.js";
import { runSshCommandFast } from "./sshClient.js";

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
    "for tool in sde sdevice sprocess swb inspect svisual; do echo TOOL:$tool; command -v $tool || true; done",
    "echo VM_STATUS_DONE"
  ].join("; ");
  const result = await runSshCommandFast(command, 6_000);
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const lines = raw.split(/\r?\n/);
  const ok = result.ok && lines.includes("SSH_OK");

  return {
    ok,
    checkedAt: new Date().toISOString(),
    sshTarget: config.SENTAURUS_SSH_TARGET,
    hostname: parseNextLine(lines, "HOSTNAME"),
    user: parseNextLine(lines, "USER"),
    sentaurusVersion: undefined,
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
