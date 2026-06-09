import type { VmAgentMessage, VmAgentStatus } from "@sentaurus-agent/shared";
import { config } from "../config.js";
import { runSshCommand } from "./sshClient.js";

type VmAgentOperation = "status" | "start" | "send" | "history";

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
  workerRunning?: boolean;
  workerPid?: number | null;
  llmConfigured?: boolean;
  queueDepth?: number;
  sentaurusTools?: Record<string, string | null>;
  messages?: unknown[];
  cursor?: number;
  raw?: string;
};

const agentName = "sentaurus-vm-agent";
const agentVersion = "0.3.0";

const remoteWorkerScript = String.raw`# -*- coding: utf-8 -*-
import datetime
import glob
import getpass
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import uuid

try:
    import urllib2
except ImportError:
    import urllib.request as urllib2

AGENT_NAME = "sentaurus-vm-agent"
AGENT_VERSION = "0.3.0"
HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".sentaurus-web-agent", "vm-agent")
QUEUE_DIR = os.path.join(ROOT, "queue")
DONE_DIR = os.path.join(ROOT, "processed")
MESSAGES_PATH = os.path.join(ROOT, "messages.jsonl")
AUDIT_PATH = os.path.join(ROOT, "audit.jsonl")
HEARTBEAT_PATH = os.path.join(ROOT, "worker.heartbeat")
CONFIG_PATH = os.path.join(ROOT, "config.json")
ENV_PATH = os.path.join(ROOT, ".env")
STOP_PATH = os.path.join(ROOT, "stop")

try:
    string_types = (basestring,)
except NameError:
    string_types = (str,)

def now_iso():
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

def ensure_dir(path):
    if not os.path.isdir(path):
        os.makedirs(path)

def safe_text(value, limit=12000):
    if value is None:
        return ""
    if not isinstance(value, string_types):
        value = str(value)
    return value[:limit]

def message_id(prefix):
    return "%s_%s_%s" % (prefix, datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"), uuid.uuid4().hex[:8])

def append_jsonl(path, payload):
    ensure_dir(os.path.dirname(path))
    with open(path, "a") as handle:
        handle.write(json.dumps(payload, ensure_ascii=True, sort_keys=True) + "\n")

def audit(event, detail):
    append_jsonl(AUDIT_PATH, {"at": now_iso(), "agent": AGENT_NAME, "event": event, "detail": detail})

def append_message(role, content, source, meta=None, id_prefix=None):
    message = {
        "id": message_id(id_prefix or ("vm" if role == "agent" else "web")),
        "role": role,
        "source": source,
        "content": safe_text(content, 4000),
        "createdAt": now_iso(),
        "meta": meta or {},
    }
    append_jsonl(MESSAGES_PATH, message)
    audit("message", {"id": message.get("id"), "role": role, "source": source, "kind": (meta or {}).get("kind")})
    return message

def read_env_file(path):
    data = {}
    if not os.path.exists(path):
        return data
    with open(path, "r") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            data[key.strip()] = value.strip().strip('"').strip("'")
    return data

def load_config():
    env = read_env_file(ENV_PATH)
    file_config = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r") as handle:
                file_config = json.load(handle)
        except Exception:
            file_config = {}
    return {
        "api_base": env.get("LLM_API_BASE") or file_config.get("llmApiBase") or file_config.get("LLM_API_BASE") or "",
        "api_key": env.get("LLM_API_KEY") or file_config.get("llmApiKey") or file_config.get("LLM_API_KEY") or "",
        "model": env.get("LLM_MODEL") or file_config.get("llmModel") or file_config.get("LLM_MODEL") or "gpt-5.5",
    }

def llm_configured(config):
    return bool(config.get("api_base") and config.get("api_key"))

def command_output(command, timeout_seconds=12):
    started = time.time()
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    while proc.poll() is None:
        if time.time() - started > timeout_seconds:
            try:
                proc.kill()
            except Exception:
                pass
            return "timeout"
        time.sleep(0.1)
    out, err = proc.communicate()
    text = out or err or b""
    try:
        return text.decode("utf-8", "replace").strip()
    except AttributeError:
        return text.strip()

def which(tool):
    return command_output(["bash", "-lc", "command -v %s || true" % tool], 4) or None

def sentaurus_tools():
    return {
        "sde": which("sde"),
        "sdevice": which("sdevice"),
        "sprocess": which("sprocess"),
        "swb": which("swb"),
        "inspect": which("inspect"),
        "svisual": which("svisual"),
    }

def list_instances():
    root = os.path.join(HOME, "STDB", "agent_instances")
    instances = sorted([path for path in glob.glob(os.path.join(root, "*")) if os.path.isdir(path)])
    return [os.path.basename(path) for path in instances]

def skill_snapshot():
    instances = list_instances()
    return {
        "hostname": socket.gethostname(),
        "user": getpass.getuser(),
        "sentaurusTools": sentaurus_tools(),
        "instanceCount": len(instances),
        "latestInstance": instances[-1] if instances else None,
        "safeSkills": ["vm_status", "sentaurus_tools", "list_agent_instances"],
        "realJobExecution": "disabled until an allowlisted job runner is implemented",
    }

def wants_skill_reply(text):
    lowered = text.lower()
    tokens = ["/skill", "status", "sentaurus", "sdevice", "sde", "swb", "tools", "instance", u"状态", u"工具", u"实例", u"仿真"]
    return any(token in lowered for token in tokens)

def local_skill_reply(text):
    snapshot = skill_snapshot()
    lines = [
        "VM Sentaurus skill status:",
        "- host: %s as %s" % (snapshot.get("hostname"), snapshot.get("user")),
        "- latest instance: %s" % (snapshot.get("latestInstance") or "none"),
        "- instance count: %s" % snapshot.get("instanceCount"),
        "- safe skills: %s" % ", ".join(snapshot.get("safeSkills")),
        "- real job execution: %s" % snapshot.get("realJobExecution"),
        "- tools:",
    ]
    for name, path in sorted(snapshot.get("sentaurusTools").items()):
        lines.append("  - %s: %s" % (name, path or "not found"))
    return "\n".join(lines)

def chat_completions_url(api_base):
    base = api_base.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return base + "/chat/completions"

def call_llm(user_text, config):
    snapshot = skill_snapshot()
    system = (
        "You are a Sentaurus TCAD agent running inside the CentOS VM. "
        "The browser and host backend only relay messages; API credentials stay inside this VM. "
        "You have these safe Sentaurus skills available as context: vm_status, sentaurus_tools, list_agent_instances. "
        "Do not claim to run real Sentaurus jobs unless an allowlisted job runner is explicitly implemented. "
        "Current VM skill snapshot: " + json.dumps(snapshot, ensure_ascii=True, sort_keys=True)
    )
    payload = {
        "model": config.get("model") or "gpt-5.5",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_text},
        ],
        "temperature": 0.2,
    }
    body = json.dumps(payload).encode("utf-8")
    request = urllib2.Request(chat_completions_url(config.get("api_base")), body, {
        "content-type": "application/json",
        "authorization": "Bearer %s" % config.get("api_key"),
    })
    response = urllib2.urlopen(request, timeout=90).read()
    try:
        text = response.decode("utf-8", "replace")
    except AttributeError:
        text = response
    data = json.loads(text)
    return data.get("choices", [{}])[0].get("message", {}).get("content") or "LLM returned no content."

def reply_for(text):
    config = load_config()
    if wants_skill_reply(text):
        return local_skill_reply(text), {"kind": "sentaurus_skill", "llmConfigured": llm_configured(config)}
    if not llm_configured(config):
        return (
            "VM agent is running inside CentOS, but LLM config is not set inside the VM yet. "
            "Put LLM_API_BASE, LLM_API_KEY, and optional LLM_MODEL in ~/.sentaurus-web-agent/vm-agent/.env "
            "or config.json. Sentaurus safe skills are already available; ask for status/tools to test them."
        ), {"kind": "config_required", "llmConfigured": False}
    try:
        return call_llm(text, config), {"kind": "llm", "llmConfigured": True, "model": config.get("model")}
    except Exception as exc:
        return "VM agent LLM call failed inside CentOS: %s" % safe_text(str(exc), 1000), {"kind": "llm_error", "llmConfigured": True}

def process_queue_file(path):
    try:
        with open(path, "r") as handle:
            item = json.load(handle)
        text = safe_text(item.get("content"), 4000)
        reply, meta = reply_for(text)
        append_message("agent", reply, "vm-agent-worker", meta)
        shutil.move(path, os.path.join(DONE_DIR, os.path.basename(path)))
        audit("queue_processed", {"file": os.path.basename(path), "replyKind": meta.get("kind")})
    except Exception as exc:
        append_message("system", "VM agent worker failed to process a message: %s" % safe_text(str(exc), 1000), "vm-agent-worker", {"kind": "worker_error"})
        try:
            shutil.move(path, os.path.join(DONE_DIR, "failed_" + os.path.basename(path)))
        except Exception:
            pass

def main():
    for path in [ROOT, QUEUE_DIR, DONE_DIR]:
        ensure_dir(path)
    append_message("agent", "Sentaurus VM agent worker started. API credentials are read only from VM-local config.", "vm-agent-worker", {"kind": "worker_started"})
    while not os.path.exists(STOP_PATH):
        with open(HEARTBEAT_PATH, "w") as handle:
            handle.write(now_iso())
        files = sorted(glob.glob(os.path.join(QUEUE_DIR, "*.json")))
        for path in files:
            process_queue_file(path)
        time.sleep(1)
    audit("worker_stopped", {})

if __name__ == "__main__":
    main()
`;

const remoteControlScript = String.raw`# -*- coding: utf-8 -*-
import base64
import datetime
import glob
import getpass
import json
import os
import socket
import subprocess
import sys
import time
import uuid

AGENT_NAME = "sentaurus-vm-agent"
AGENT_VERSION = "0.3.0"
REQUEST_B64 = "__REQUEST_B64__"
WORKER_SOURCE_B64 = "__WORKER_SOURCE_B64__"

try:
    string_types = (basestring,)
except NameError:
    string_types = (str,)

HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".sentaurus-web-agent", "vm-agent")
QUEUE_DIR = os.path.join(ROOT, "queue")
DONE_DIR = os.path.join(ROOT, "processed")
MESSAGES_PATH = os.path.join(ROOT, "messages.jsonl")
AUDIT_PATH = os.path.join(ROOT, "audit.jsonl")
WORKER_PATH = os.path.join(ROOT, "agent_worker.py")
PID_PATH = os.path.join(ROOT, "agent_worker.pid")
LOG_PATH = os.path.join(ROOT, "agent_worker.log")
CONFIG_EXAMPLE_PATH = os.path.join(ROOT, "config.example.json")
ENV_EXAMPLE_PATH = os.path.join(ROOT, ".env.example")
CONFIG_PATH = os.path.join(ROOT, "config.json")
ENV_PATH = os.path.join(ROOT, ".env")
STOP_PATH = os.path.join(ROOT, "stop")

def now_iso():
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

def ensure_dir(path):
    if not os.path.isdir(path):
        os.makedirs(path)

def load_json_b64(value):
    raw = base64.b64decode(value)
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

def append_jsonl(path, payload):
    ensure_dir(os.path.dirname(path))
    with open(path, "a") as handle:
        handle.write(json.dumps(payload, ensure_ascii=True, sort_keys=True) + "\n")

def audit(event, detail):
    append_jsonl(AUDIT_PATH, {"at": now_iso(), "agent": AGENT_NAME, "event": event, "detail": detail})

def append_message(role, content, source, meta=None, id_prefix=None):
    message = {
        "id": message_id(id_prefix or ("vm" if role == "agent" else "web")),
        "role": role,
        "source": source,
        "content": safe_text(content, 4000),
        "createdAt": now_iso(),
        "meta": meta or {},
    }
    append_jsonl(MESSAGES_PATH, message)
    audit("message", {"id": message.get("id"), "role": role, "source": source, "kind": (meta or {}).get("kind")})
    return message

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

def command_output(command, timeout_seconds=6):
    started = time.time()
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    while proc.poll() is None:
        if time.time() - started > timeout_seconds:
            try:
                proc.kill()
            except Exception:
                pass
            return "timeout"
        time.sleep(0.1)
    out, err = proc.communicate()
    text = out or err or b""
    try:
        return text.decode("utf-8", "replace").strip()
    except AttributeError:
        return text.strip()

def which(tool):
    return command_output(["bash", "-lc", "command -v %s || true" % tool], 4) or None

def sentaurus_tools():
    return {
        "sde": which("sde"),
        "sdevice": which("sdevice"),
        "sprocess": which("sprocess"),
        "swb": which("swb"),
        "inspect": which("inspect"),
        "svisual": which("svisual"),
    }

def list_instances():
    root = os.path.join(HOME, "STDB", "agent_instances")
    instances = sorted([path for path in glob.glob(os.path.join(root, "*")) if os.path.isdir(path)])
    return [os.path.basename(path) for path in instances]

def queue_depth():
    ensure_dir(QUEUE_DIR)
    return len(glob.glob(os.path.join(QUEUE_DIR, "*.json")))

def read_env_file(path):
    data = {}
    if not os.path.exists(path):
        return data
    with open(path, "r") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            data[key.strip()] = value.strip().strip('"').strip("'")
    return data

def llm_configured():
    env = read_env_file(ENV_PATH)
    file_config = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r") as handle:
                file_config = json.load(handle)
        except Exception:
            file_config = {}
    api_base = env.get("LLM_API_BASE") or file_config.get("llmApiBase") or file_config.get("LLM_API_BASE")
    api_key = env.get("LLM_API_KEY") or file_config.get("llmApiKey") or file_config.get("LLM_API_KEY")
    return bool(api_base and api_key)

def read_pid():
    if not os.path.exists(PID_PATH):
        return None
    try:
        with open(PID_PATH, "r") as handle:
            return int(handle.read().strip())
    except Exception:
        return None

def pid_alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False

def worker_running():
    pid = read_pid()
    return pid_alive(pid), pid

def write_worker_files():
    ensure_dir(ROOT)
    ensure_dir(QUEUE_DIR)
    ensure_dir(DONE_DIR)
    worker_source = base64.b64decode(WORKER_SOURCE_B64)
    with open(WORKER_PATH, "wb") as handle:
        handle.write(worker_source)
    os.chmod(WORKER_PATH, 0o700)
    if not os.path.exists(CONFIG_EXAMPLE_PATH):
        with open(CONFIG_EXAMPLE_PATH, "w") as handle:
            handle.write(json.dumps({
                "llmApiBase": "https://your-openai-compatible-base/v1",
                "llmApiKey": "put-real-key-here-inside-vm-only",
                "llmModel": "gpt-5.5"
            }, indent=2, sort_keys=True) + "\n")
    if not os.path.exists(ENV_EXAMPLE_PATH):
        with open(ENV_EXAMPLE_PATH, "w") as handle:
            handle.write("LLM_API_BASE=https://your-openai-compatible-base/v1\nLLM_API_KEY=put-real-key-here-inside-vm-only\nLLM_MODEL=gpt-5.5\n")

def start_worker():
    write_worker_files()
    if os.path.exists(STOP_PATH):
        os.unlink(STOP_PATH)
    running, pid = worker_running()
    if running:
        return pid
    log = open(LOG_PATH, "ab")
    kwargs = {"stdout": log, "stderr": log, "cwd": ROOT, "close_fds": True}
    if hasattr(os, "setsid"):
        kwargs["preexec_fn"] = os.setsid
    proc = subprocess.Popen([sys.executable or "python", WORKER_PATH], **kwargs)
    with open(PID_PATH, "w") as handle:
        handle.write(str(proc.pid))
    audit("worker_started", {"pid": proc.pid})
    time.sleep(0.2)
    return proc.pid

def build_status():
    instances = list_instances()
    running, pid = worker_running()
    return {
        "ok": True,
        "agent": AGENT_NAME,
        "version": AGENT_VERSION,
        "hostname": socket.gethostname(),
        "user": getpass.getuser(),
        "capabilities": ["relay_message", "history", "vm_worker", "vm_local_llm_config", "sentaurus_skills"],
        "instanceCount": len(instances),
        "latestInstance": instances[-1] if instances else None,
        "mailbox": "~/.sentaurus-web-agent/vm-agent",
        "messageCount": message_count(),
        "workerRunning": running,
        "workerPid": pid if running else None,
        "llmConfigured": llm_configured(),
        "queueDepth": queue_depth(),
        "sentaurusTools": sentaurus_tools(),
    }

def enqueue_message(content):
    ensure_dir(QUEUE_DIR)
    message = append_message("user", content, "web", {"kind": "web_message", "queuedFor": "vm-agent-worker"}, "web")
    queue_path = os.path.join(QUEUE_DIR, message["id"] + ".json")
    with open(queue_path, "w") as handle:
        handle.write(json.dumps(message, ensure_ascii=True, sort_keys=True) + "\n")
    audit("message_queued", {"id": message.get("id"), "queueFile": os.path.basename(queue_path)})
    return message

def handle(request):
    ensure_dir(ROOT)
    operation = request.get("operation") or "status"
    after = int(request.get("after") or 0)
    limit = int(request.get("limit") or 50)
    messages = []

    if operation == "start":
        pid = start_worker()
        messages = [append_message("agent", "CentOS VM agent worker is running. Browser/host will only relay messages; LLM credentials are read inside the VM.", "vm-agent-control", {"kind": "worker_ready", "pid": pid})]
    elif operation == "send":
        incoming = safe_text(request.get("message"), 4000)
        if not incoming.strip():
            raise ValueError("message is required")
        start_worker()
        messages = [enqueue_message(incoming)]
    elif operation == "history":
        messages, _cursor = read_messages(after, limit)
    elif operation == "status":
        messages, _cursor = read_messages(max(0, message_count() - limit), limit)
    else:
        raise ValueError("unsupported operation: %s" % operation)

    status = build_status()
    _all, cursor = read_messages(0, 0)
    payload = status.copy()
    payload["messages"] = messages
    payload["cursor"] = cursor
    return payload

try:
    print(json.dumps(handle(load_json_b64(REQUEST_B64)), ensure_ascii=True, sort_keys=True))
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
  const encodedRequest = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  const encodedWorker = Buffer.from(remoteWorkerScript, "utf8").toString("base64");
  const script = remoteControlScript
    .replace("__REQUEST_B64__", encodedRequest)
    .replace("__WORKER_SOURCE_B64__", encodedWorker);
  return remotePython(script);
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
    workerRunning: payload.workerRunning,
    workerPid: payload.workerPid,
    llmConfigured: payload.llmConfigured,
    queueDepth: payload.queueDepth,
    sentaurusTools: payload.sentaurusTools,
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
  const payload = await callVmAgent({ operation: "start" });
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
  const representative = [...messages].reverse().find((item) => item.role === "agent") || messages[0] || fallbackAgentMessage("Message queued for the CentOS VM agent.");
  return { status, message: representative, messages, cursor: payload.cursor || 0 };
}
