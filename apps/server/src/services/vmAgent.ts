import type { VmAgentMessage, VmAgentStatus } from "@sentaurus-agent/shared";
import { config } from "../config.js";
import { runSshCommand } from "./sshClient.js";

type RemoteAgentPayload = {
  agent?: string;
  version?: string;
  hostname?: string;
  user?: string;
  capabilities?: string[];
  instanceCount?: number;
  latestInstance?: string | null;
  message?: string;
};

const agentName = "sentaurus-vm-agent-ssh-bridge";
const agentVersion = "0.1.0";

function remotePython(script: string): string {
  return `python - <<'PY'\n${script}\nPY`;
}

function parseRemoteJson(raw: string): RemoteAgentPayload {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) throw new Error(`VM agent did not return JSON: ${raw.slice(0, 500)}`);
  return JSON.parse(jsonLine) as RemoteAgentPayload;
}

function toStatus(payload: RemoteAgentPayload, raw: string): VmAgentStatus {
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    sshTarget: config.SENTAURUS_SSH_TARGET,
    connected: true,
    agent: payload.agent || agentName,
    version: payload.version || agentVersion,
    hostname: payload.hostname,
    user: payload.user,
    capabilities: payload.capabilities || [],
    instanceCount: payload.instanceCount,
    latestInstance: payload.latestInstance ?? null,
    raw
  };
}

function errorStatus(message: string, raw = ""): VmAgentStatus {
  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    sshTarget: config.SENTAURUS_SSH_TARGET,
    connected: false,
    error: message,
    raw
  };
}

function agentMessage(content: string, meta?: VmAgentMessage["meta"]): VmAgentMessage {
  return {
    id: `vm_msg_${Date.now()}`,
    role: "agent",
    content,
    createdAt: new Date().toISOString(),
    meta
  };
}

const statusScript = `
import glob
import json
import os
import socket
import subprocess

def cmd_out(cmd):
    try:
        p = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, _err = p.communicate()
        return out.decode("utf-8", "replace").strip() if hasattr(out, "decode") else out.strip()
    except Exception:
        return ""

home = os.path.expanduser("~")
instances = sorted(glob.glob(os.path.join(home, "STDB", "agent_instances", "*")))
payload = {
    "agent": "${agentName}",
    "version": "${agentVersion}",
    "hostname": socket.gethostname(),
    "user": cmd_out("whoami"),
    "capabilities": ["hello", "echo", "vm_status", "agent_instances", "sentaurus_tools"],
    "instanceCount": len(instances),
    "latestInstance": instances[-1] if instances else None,
}
payload["message"] = "hello from %s on %s; latest instance: %s" % (
    payload["agent"],
    payload["hostname"],
    payload["latestInstance"] or "none",
)
print(json.dumps(payload))
`;

export async function getVmAgentStatus(): Promise<VmAgentStatus> {
  const result = await runSshCommand(remotePython(statusScript), 20_000);
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!result.ok) return errorStatus(result.error || result.stderr || "VM agent status check failed", raw);
  try {
    return toStatus(parseRemoteJson(raw), raw);
  } catch (err) {
    return errorStatus(err instanceof Error ? err.message : String(err), raw);
  }
}

export async function connectVmAgent(): Promise<{ status: VmAgentStatus; message?: VmAgentMessage }> {
  const result = await runSshCommand(remotePython(statusScript), 20_000);
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!result.ok) return { status: errorStatus(result.error || result.stderr || "VM agent connect failed", raw) };
  try {
    const payload = parseRemoteJson(raw);
    return {
      status: toStatus(payload, raw),
      message: agentMessage(payload.message || "VM agent ready.", {
        agent: payload.agent || agentName,
        hostname: payload.hostname || null,
        latestInstance: payload.latestInstance || null
      })
    };
  } catch (err) {
    return { status: errorStatus(err instanceof Error ? err.message : String(err), raw) };
  }
}

export async function sendVmAgentMessage(message: string): Promise<{ status: VmAgentStatus; message: VmAgentMessage }> {
  const encoded = Buffer.from(message, "utf8").toString("base64");
  const script = `
import base64
import glob
import json
import os
import socket
import subprocess

def cmd_out(cmd):
    try:
        p = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, _err = p.communicate()
        return out.decode("utf-8", "replace").strip() if hasattr(out, "decode") else out.strip()
    except Exception:
        return ""

incoming = base64.b64decode("${encoded}").decode("utf-8", "replace")
home = os.path.expanduser("~")
instances = sorted(glob.glob(os.path.join(home, "STDB", "agent_instances", "*")))
hostname = socket.gethostname()
user = cmd_out("whoami")
latest = instances[-1] if instances else None
content = "VM agent received message on %s as %s. Latest instance: %s. Echo: %s" % (
    hostname,
    user,
    latest or "none",
    incoming[:600],
)
payload = {
    "agent": "${agentName}",
    "version": "${agentVersion}",
    "hostname": hostname,
    "user": user,
    "capabilities": ["hello", "echo", "vm_status", "agent_instances", "sentaurus_tools"],
    "instanceCount": len(instances),
    "latestInstance": latest,
    "message": content,
}
print(json.dumps(payload))
`;
  const result = await runSshCommand(remotePython(script), 20_000);
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!result.ok) {
    const status = errorStatus(result.error || result.stderr || "VM agent message failed", raw);
    return { status, message: agentMessage(status.error || "VM agent message failed") };
  }
  try {
    const payload = parseRemoteJson(raw);
    return {
      status: toStatus(payload, raw),
      message: agentMessage(payload.message || "VM agent acknowledged the message.", {
        agent: payload.agent || agentName,
        hostname: payload.hostname || null,
        latestInstance: payload.latestInstance || null
      })
    };
  } catch (err) {
    const status = errorStatus(err instanceof Error ? err.message : String(err), raw);
    return { status, message: agentMessage(status.error || "VM agent message failed") };
  }
}
