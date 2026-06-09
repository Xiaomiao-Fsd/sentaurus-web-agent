import type { VmAgentMessage, VmAgentStatus } from "@sentaurus-agent/shared";
import { config } from "../config.js";
import { runSshCommand } from "./sshClient.js";

type VmAgentOperation = "status" | "hello" | "send" | "history";

type RemoteAgentRequest = {
  operation: VmAgentOperation;
  message?: string;
  after?: number;
  limit?: number;
};

type RemoteAgentPayload = {
  ok?: boolean;
  error?: string;
  agent?: string;
  version?: string;
  hostname?: string;
  user?: string;
  capabilities?: string[];
  instanceCount?: number;
  latestInstance?: string | null;
  mailbox?: string;
  messageCount?: number;
  messages?: unknown[];
  cursor?: number;
  raw?: string;
};

const agentName = "sentaurus-vm-agent-mailbox";
const agentVersion = "0.2.0";

const remoteAgentScript = String.raw`# -*- coding: utf-8 -*-
import base64
import datetime
import glob
import getpass
import json
import os
import socket
import sys
import uuid

AGENT_NAME = "sentaurus-vm-agent-mailbox"
AGENT_VERSION = "0.2.0"
REQUEST_B64 = "__REQUEST_B64__"

try:
    string_types = (basestring,)
except NameError:
    string_types = (str,)

def now_iso():
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

def ensure_dir(path):
    if not os.path.isdir(path):
        os.makedirs(path)

def load_request():
    raw = base64.b64decode(REQUEST_B64)
    try:
        text = raw.decode("utf-8")
    except AttributeError:
        text = raw
    return json.loads(text)

def safe_text(value, limit=4000):
    if value is None:
        return ""
    if not isinstance(value, string_types):
        value = str(value)
    return value[:limit]

def message_id(prefix):
    return "%s_%s_%s" % (prefix, datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"), uuid.uuid4().hex[:8])

HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".sentaurus-web-agent", "vm-agent")
MESSAGES_PATH = os.path.join(ROOT, "messages.jsonl")
AUDIT_PATH = os.path.join(ROOT, "audit.jsonl")

def list_instances():
    root = os.path.join(HOME, "STDB", "agent_instances")
    instances = sorted([path for path in glob.glob(os.path.join(root, "*")) if os.path.isdir(path)])
    latest = os.path.basename(instances[-1]) if instances else None
    return instances, latest

def append_jsonl(path, payload):
    ensure_dir(os.path.dirname(path))
    with open(path, "a") as handle:
        handle.write(json.dumps(payload, ensure_ascii=True, sort_keys=True) + "\n")

def audit(event, detail):
    append_jsonl(AUDIT_PATH, {
        "at": now_iso(),
        "event": event,
        "detail": detail,
        "agent": AGENT_NAME,
    })

def append_message(message):
    append_jsonl(MESSAGES_PATH, message)
    audit("message", {"id": message.get("id"), "role": message.get("role"), "source": message.get("source")})

def read_messages(after=0, limit=50):
    cursor = 0
    messages = []
    if os.path.exists(MESSAGES_PATH):
        with open(MESSAGES_PATH, "r") as handle:
            for line in handle:
                cursor += 1
                if cursor <= after:
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    messages.append(json.loads(line))
                except Exception:
                    pass
    if limit > 0 and len(messages) > limit:
        messages = messages[-limit:]
    return messages, cursor

def message_count():
    _messages, cursor = read_messages(0, 0)
    return cursor

def build_status():
    instances, latest = list_instances()
    return {
        "ok": True,
        "agent": AGENT_NAME,
        "version": AGENT_VERSION,
        "hostname": socket.gethostname(),
        "user": getpass.getuser(),
        "capabilities": ["hello", "message", "history", "status", "agent_instances"],
        "instanceCount": len(instances),
        "latestInstance": latest,
        "mailbox": "~/.sentaurus-web-agent/vm-agent",
        "messageCount": message_count(),
    }

def make_message(role, content, source, meta=None):
    return {
        "id": message_id("vm" if role == "agent" else "web"),
        "role": role,
        "source": source,
        "content": safe_text(content, 4000),
        "createdAt": now_iso(),
        "meta": meta or {},
    }

def agent_reply(incoming, status):
    lowered = incoming.lower()
    wants_status = any(token in lowered for token in ["status", u"状态", "hello", "ready", "instance", u"实例"])
    if wants_status:
        return "VM agent ready on %s as %s. instances=%s, latest=%s, mailbox=%s" % (
            status.get("hostname") or "unknown",
            status.get("user") or "unknown",
            status.get("instanceCount"),
            status.get("latestInstance") or "none",
            status.get("mailbox"),
        )
    return "VM agent received your message and wrote it to the VM mailbox. Echo: %s" % safe_text(incoming, 600)

def handle(request):
    ensure_dir(ROOT)
    operation = request.get("operation") or "status"
    after = int(request.get("after") or 0)
    limit = int(request.get("limit") or 50)

    if operation == "hello":
        status = build_status()
        reply = make_message(
            "agent",
            "VM agent ready on %s as %s. Latest instance: %s" % (
                status.get("hostname") or "unknown",
                status.get("user") or "unknown",
                status.get("latestInstance") or "none",
            ),
            "vm",
            {"kind": "hello", "latestInstance": status.get("latestInstance")},
        )
        append_message(reply)
        messages = [reply]
    elif operation == "send":
        incoming = safe_text(request.get("message"), 4000)
        if not incoming.strip():
            raise ValueError("message is required")
        user_message = make_message("user", incoming, "web", {"kind": "web_message"})
        append_message(user_message)
        status = build_status()
        reply = make_message("agent", agent_reply(incoming, status), "vm", {"kind": "ack", "latestInstance": status.get("latestInstance")})
        append_message(reply)
        messages = [user_message, reply]
    elif operation == "history":
        messages, _cursor = read_messages(after, limit)
    elif operation == "status":
        messages, _cursor = read_messages(max(0, message_count() - limit), limit)
    else:
        raise ValueError("unsupported operation: %s" % operation)

    status = build_status()
    _recent, cursor = read_messages(0, 0)
    payload = status.copy()
    payload["messages"] = messages
    payload["cursor"] = cursor
    return payload

try:
    print(json.dumps(handle(load_request()), ensure_ascii=True, sort_keys=True))
except Exception as exc:
    error_payload = {
        "ok": False,
        "agent": AGENT_NAME,
        "version": AGENT_VERSION,
        "error": str(exc),
        "messages": [],
        "cursor": 0,
    }
    print(json.dumps(error_payload, ensure_ascii=True, sort_keys=True))
    sys.exit(0)
`;

function remotePython(script: string): string {
  return `python - <<'PY'\n${script}\nPY`;
}

function remoteAgentCommand(request: RemoteAgentRequest): string {
  const encoded = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  return remotePython(remoteAgentScript.replace("__REQUEST_B64__", encoded));
}

function parseRemoteJson(raw: string): RemoteAgentPayload {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) throw new Error(`VM agent did not return JSON: ${raw.slice(0, 500)}`);
  return JSON.parse(jsonLine) as RemoteAgentPayload;
}

function normalizeMessages(messages: unknown[] | undefined): VmAgentMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const item = message as Partial<VmAgentMessage> & { source?: string };
    const role = item.role === "user" || item.role === "agent" || item.role === "system" ? item.role : "agent";
    return [{
      id: typeof item.id === "string" ? item.id : `vm_msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      role,
      content: typeof item.content === "string" ? item.content : "",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
      meta: item.meta
    }];
  });
}

function toStatus(payload: RemoteAgentPayload): VmAgentStatus {
  return {
    ok: payload.ok !== false,
    checkedAt: new Date().toISOString(),
    sshTarget: config.SENTAURUS_SSH_TARGET,
    connected: payload.ok !== false,
    agent: payload.agent || agentName,
    version: payload.version || agentVersion,
    hostname: payload.hostname,
    user: payload.user,
    capabilities: payload.capabilities || [],
    instanceCount: payload.instanceCount,
    latestInstance: payload.latestInstance ?? null,
    mailbox: payload.mailbox,
    messageCount: payload.messageCount,
    error: payload.error,
    raw: payload.raw
  };
}

function errorStatus(message: string, raw = ""): VmAgentStatus {
  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    sshTarget: config.SENTAURUS_SSH_TARGET,
    connected: false,
    error: message,
    raw: raw.slice(0, 500)
  };
}

function fallbackAgentMessage(content: string): VmAgentMessage {
  return {
    id: `vm_msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    role: "agent",
    content,
    createdAt: new Date().toISOString()
  };
}

async function callVmAgent(request: RemoteAgentRequest): Promise<RemoteAgentPayload> {
  const result = await runSshCommand(remoteAgentCommand(request), 20_000);
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!result.ok) {
    return { ok: false, error: result.error || result.stderr || "VM agent SSH call failed", raw: raw.slice(0, 500), messages: [], cursor: 0 };
  }
  try {
    return parseRemoteJson(raw);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), raw: raw.slice(0, 500), messages: [], cursor: 0 };
  }
}

export async function getVmAgentStatus(): Promise<VmAgentStatus> {
  const payload = await callVmAgent({ operation: "status", limit: 20 });
  return payload.ok === false ? errorStatus(payload.error || "VM agent status check failed", payload.raw) : toStatus(payload);
}

export async function connectVmAgent(): Promise<{ status: VmAgentStatus; messages: VmAgentMessage[]; message?: VmAgentMessage; cursor: number }> {
  const payload = await callVmAgent({ operation: "hello" });
  const status = payload.ok === false ? errorStatus(payload.error || "VM agent connect failed", payload.raw) : toStatus(payload);
  const messages = normalizeMessages(payload.messages);
  return { status, messages, message: messages.find((item) => item.role === "agent"), cursor: payload.cursor || 0 };
}

export async function getVmAgentMessages(after = 0, limit = 50): Promise<{ status: VmAgentStatus; messages: VmAgentMessage[]; cursor: number }> {
  const payload = await callVmAgent({ operation: "history", after, limit });
  const status = payload.ok === false ? errorStatus(payload.error || "VM agent history failed", payload.raw) : toStatus(payload);
  return { status, messages: normalizeMessages(payload.messages), cursor: payload.cursor || after };
}

export async function sendVmAgentMessage(message: string): Promise<{ status: VmAgentStatus; message: VmAgentMessage; messages: VmAgentMessage[]; cursor: number }> {
  const payload = await callVmAgent({ operation: "send", message });
  const status = payload.ok === false ? errorStatus(payload.error || "VM agent message failed", payload.raw) : toStatus(payload);
  const messages = normalizeMessages(payload.messages);
  const reply = [...messages].reverse().find((item) => item.role === "agent") || fallbackAgentMessage(status.error || "VM agent message failed");
  return { status, message: reply, messages, cursor: payload.cursor || 0 };
}
