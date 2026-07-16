import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import type {
  VmAgentAgentsMdResponse,
  VmAgentAttachmentRef,
  VmAgentHistoryErrorCode,
  VmAgentMessage,
  VmAgentMessageAttachment,
  VmAgentModelId,
  VmAgentModelsResponse,
  VmAgentStatus
} from "@sentaurus-agent/shared";
import { config } from "../config.js";
import { safeRelativePath, safeRunId } from "../security/pathSafe.js";
import { resolveRunFile } from "./runStore.js";
import { runSshCommandWithInput, runSshCommandWithInputDownload, runSshCommandWithInputFast } from "./sshClient.js";
import { downloadVmSessionFile } from "./vmSessionFiles.js";
import {
  isVmAgentModelId,
  parseVmAgentModelId,
  remoteVmAgentModelConfigScript,
  VM_AGENT_MODEL_IDS,
  VM_AGENT_REASONING_EFFORT,
  vmAgentContextWindowTokens,
  vmAgentModelCatalog
} from "./vmAgentModels.js";

type VmAgentOperation = "status" | "start" | "send" | "history";

export type RemoteAgentRequest = {
  operation: VmAgentOperation;
  message?: string;
  sessionId?: string;
  turnId?: string;
  includeFolded?: boolean;
  protocolVersion?: number;
  attachments?: VmAgentAttachmentRef[];
  displayAttachments?: VmAgentMessageAttachment[];
  after?: number;
  limit?: number;
  historyBefore?: number;
  responseByteBudget?: number;
};

export type RemoteAgentPayload = {
  ok?: boolean;
  protocolVersion?: number;
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
  llmModel?: string;
  llmModels?: string[];
  llmReasoningEffort?: "max";
  llmContextWindowTokens?: number;
  llmContextTargetTokens?: number;
  llmContextHardTokens?: number;
  llmTimeoutSeconds?: number;
  maxAutodebugAttempts?: number;
  manualCount?: number;
  manualFiles?: string[];
  queueDepth?: number;
  sentaurusTools?: Record<string, string | null>;
  vmTime?: string;
  vmEpochMs?: number;
  hostTime?: string;
  hostEpochMs?: number;
  hostReceivedAt?: string;
  clockSkewMs?: number;
  clockSkewWarning?: boolean;
  messages?: unknown[];
  cursor?: number;
  truncated?: boolean;
  continuation?: string;
  rawCount?: number;
  compactedCount?: number;
  payloadBytes?: number;
  historyCompacted?: boolean;
  transportCompressedBytes?: number;
  transportUncompressedBytes?: number;
  bridgeError?: "timeout" | "queue" | "ssh" | "invalid_response";
  retryable?: boolean;
  raw?: string;
};

export class VmAgentHistoryError extends Error {
  readonly code: VmAgentHistoryErrorCode;
  readonly statusCode: 502 | 503 | 504;
  readonly retryable: boolean;
  readonly cursor: number;
  readonly status: VmAgentStatus;

  constructor(
    code: VmAgentHistoryErrorCode,
    message: string,
    statusCode: 502 | 503 | 504,
    cursor: number,
    status: VmAgentStatus,
    retryable = true
  ) {
    super(message);
    this.name = "VmAgentHistoryError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.cursor = cursor;
    this.status = status;
  }
}

export function isVmAgentHistoryError(value: unknown): value is VmAgentHistoryError {
  return value instanceof VmAgentHistoryError;
}

type EnrichedVmAgentAttachmentRef = VmAgentAttachmentRef & {
  contextStatus?: "inline" | "vm_path" | "metadata_only" | "not_found" | "too_large" | "unsupported" | "error";
  inlineText?: string;
  inlineTextTruncated?: boolean;
  vmPath?: string;
  inlineError?: string;
};

const agentName = "sentaurus-vm-agent";
const agentVersion = "0.9.2";
const defaultAgentsSource = readFileSync(new URL("../../remote/AGENTS.md", import.meta.url), "utf8");
const dfiseExtractorSource = readFileSync(new URL("../../remote/dfise_idvg_extract.py", import.meta.url), "utf8");
const dfiseExtractorSha256 = createHash("sha256").update(dfiseExtractorSource, "utf8").digest("hex");
const localWorkerSource = readFileSync(new URL("../../../../agent_worker.py", import.meta.url), "utf8");
const maxVmArtifactBytes = 50 * 1024 * 1024;
const maxInlineAttachmentBytes = 512 * 1024;
const maxInlineAttachmentTotalChars = 300_000;
const maxVmAgentsMdBytes = 256 * 1024;
const readableAttachmentExtensions = new Set([
  ".txt",
  ".md",
  ".yaml",
  ".yml",
  ".rst",
  ".log",
  ".out",
  ".err",
  ".csv",
  ".json",
  ".cmd",
  ".des",
  ".par",
  ".scm",
  ".tcl",
  ".sde",
  ".dat",
  ".plt"
]);
const vmArtifactExtensions = new Set([
  ".log",
  ".out",
  ".err",
  ".plt",
  ".tdr",
  ".grd",
  ".dat",
  ".csv",
  ".txt",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
  ".json",
  ".cmd",
  ".des",
  ".par",
  ".scm",
  ".tcl",
  ".bnd",
  ".sat"
]);

const quickStatusScript = String.raw`# -*- coding: utf-8 -*-
import getpass
import glob
import json
import os
import socket
import time

AGENT_NAME = "sentaurus-vm-agent"
AGENT_VERSION = "0.9.2"
HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".sentaurus-web-agent", "vm-agent")
QUEUE_DIR = os.path.join(ROOT, "queue")
MESSAGES_PATH = os.path.join(ROOT, "messages.jsonl")
PID_PATH = os.path.join(ROOT, "agent_worker.pid")
CONFIG_PATH = os.path.join(ROOT, "config.json")
ENV_PATH = os.path.join(ROOT, ".env")
MANUALS_DIR = os.path.join(ROOT, "manuals")
ALLOWED_MODELS = ["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]

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

def config_list(value):
    if value is None:
        return []
    raw_items = value if isinstance(value, list) else str(value).replace("\n", ",").split(",")
    items = []
    for item in raw_items:
        text = str(item).strip()
        if text and text not in items:
            items.append(text[:160])
    return items

def model_candidates(primary_model, configured_models):
    models = [item for item in config_list(configured_models) if item in ALLOWED_MODELS]
    primary = str(primary_model or "").strip()
    if primary not in ALLOWED_MODELS:
        primary = "gpt-5.5"
    if primary and primary not in models:
        models.insert(0, primary)
    return models or ["gpt-5.5"]

def config_int(env, file_config, env_key, file_key, fallback, minimum, maximum):
    raw = env.get(env_key)
    if raw is None:
        raw = file_config.get(file_key)
    if raw is None:
        raw = file_config.get(env_key)
    try:
        value = int(raw)
    except Exception:
        value = fallback
    return max(minimum, min(maximum, value))

def load_config():
    env = read_env_file(ENV_PATH)
    file_config = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r") as handle:
                file_config = json.load(handle)
        except Exception:
            file_config = {}
    primary_model = env.get("LLM_MODEL") or file_config.get("llmModel") or file_config.get("LLM_MODEL") or "gpt-5.5"
    if primary_model not in ALLOWED_MODELS:
        primary_model = "gpt-5.5"
    raw_models = env.get("LLM_MODELS") or file_config.get("llmModels") or file_config.get("LLM_MODELS")
    context_window = 353000 if primary_model.startswith("gpt-5.6-") else 272000
    return {
        "api_base": env.get("LLM_API_BASE") or file_config.get("llmApiBase") or file_config.get("LLM_API_BASE") or "",
        "api_key": env.get("LLM_API_KEY") or file_config.get("llmApiKey") or file_config.get("LLM_API_KEY") or "",
        "model": primary_model,
        "models": model_candidates(primary_model, raw_models),
        "api_style": env.get("LLM_API_STYLE") or file_config.get("llmApiStyle") or file_config.get("LLM_API_STYLE") or "chat-completions",
        "reasoning_effort": "max",
        "context_window_tokens": context_window,
        "context_target_tokens": (context_window * 85) // 100,
        "context_hard_tokens": (context_window * 95) // 100,
        "llm_timeout_seconds": config_int(env, file_config, "VM_AGENT_LLM_TIMEOUT_SECONDS", "vmAgentLlmTimeoutSeconds", 600, 30, 1800),
        "max_autodebug_attempts": config_int(env, file_config, "VM_AGENT_MAX_AUTODEBUG_ATTEMPTS", "vmAgentMaxAutodebugAttempts", 5, 1, 8),
    }

def read_pid():
    try:
        with open(PID_PATH, "r") as handle:
            for line in handle:
                line = line.strip()
                if line:
                    return int(line)
    except Exception:
        return None
    return None

def pid_alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False

def message_count():
    if not os.path.exists(MESSAGES_PATH):
        return 0
    count = 0
    with open(MESSAGES_PATH, "r") as handle:
        for line in handle:
            if line.strip():
                count += 1
    return count

def queue_depth():
    return len(glob.glob(os.path.join(QUEUE_DIR, "*.json"))) if os.path.isdir(QUEUE_DIR) else 0

def list_manuals():
    if not os.path.isdir(MANUALS_DIR):
        return []
    allowed = set([".txt", ".md", ".rst", ".cmd", ".des", ".par", ".scm", ".sde"])
    result = []
    for path in sorted(glob.glob(os.path.join(MANUALS_DIR, "*"))):
        name = os.path.basename(path)
        if os.path.isfile(path) and not name.startswith(".") and os.path.splitext(name)[1].lower() in allowed:
            result.append(name)
    return result

config = load_config()
pid = read_pid()
running = pid_alive(pid)
manuals = list_manuals()
payload = {
    "ok": True,
    "agent": AGENT_NAME,
    "version": AGENT_VERSION,
    "hostname": socket.gethostname(),
    "user": getpass.getuser(),
    "capabilities": ["relay_message", "history", "vm_worker", "vm_local_llm_config", "vm_model_switching", "sentaurus_session_output", "session_workflow_v1", "goal_lifecycle", "plan_mode"],
    "mailbox": "~/.sentaurus-web-agent/vm-agent",
    "messageCount": message_count(),
    "workerRunning": running,
    "workerPid": pid if running else None,
    "llmConfigured": bool(config.get("api_base") and config.get("api_key")),
    "llmModel": config.get("model"),
    "llmModels": config.get("models"),
    "llmReasoningEffort": config.get("reasoning_effort"),
    "llmContextWindowTokens": config.get("context_window_tokens"),
    "llmContextTargetTokens": config.get("context_target_tokens"),
    "llmContextHardTokens": config.get("context_hard_tokens"),
    "llmTimeoutSeconds": config.get("llm_timeout_seconds"),
    "maxAutodebugAttempts": config.get("max_autodebug_attempts"),
    "manualCount": len(manuals),
    "manualFiles": manuals[:20],
    "queueDepth": queue_depth(),
    "vmTime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "vmEpochMs": int(time.time() * 1000),
    "messages": [],
    "cursor": message_count(),
    "protocolVersion": 2,
}
print(json.dumps(payload, ensure_ascii=True, sort_keys=True))
print("REMOTE_AGENT_DONE")
`;

type VmRunArtifactDownload = {
  path: string;
  fileName: string;
  size: number;
  data: Buffer;
};

type VmAgentAgentsMdPayload = {
  ok?: boolean;
  error?: string;
  statusCode?: number;
  path?: string;
  exists?: boolean;
  content?: string;
  size?: number;
  updatedAt?: string;
  sha256?: string;
};

const remoteControlScript = String.raw`# -*- coding: utf-8 -*-
import base64
import datetime
import glob
import getpass
import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import time
import uuid
import zlib

AGENT_NAME = "sentaurus-vm-agent"
AGENT_VERSION = "0.9.2"
REQUEST_B64 = "__REQUEST_B64__"
WORKER_SOURCE_B64 = "__WORKER_SOURCE_B64__"
AGENTS_SOURCE_B64 = "__AGENTS_SOURCE_B64__"
DFISE_EXTRACTOR_SOURCE_B64 = "__DFISE_EXTRACTOR_SOURCE_B64__"
DFISE_EXTRACTOR_SHA256 = "__DFISE_EXTRACTOR_SHA256__"

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
AGENTS_PATH = os.path.join(ROOT, "AGENTS.md")
DFISE_EXTRACTOR_PATH = os.path.join(ROOT, "dfise_idvg_extract.py")
CAPABILITIES_DIR = os.path.join(ROOT, "capabilities")
DFISE_CAPABILITY_PATH = os.path.join(CAPABILITIES_DIR, "dfise-plt-postprocess-v1.json")
PID_PATH = os.path.join(ROOT, "agent_worker.pid")
LOG_PATH = os.path.join(ROOT, "agent_worker.log")
CONFIG_EXAMPLE_PATH = os.path.join(ROOT, "config.example.json")
ENV_EXAMPLE_PATH = os.path.join(ROOT, ".env.example")
CONFIG_PATH = os.path.join(ROOT, "config.json")
ENV_PATH = os.path.join(ROOT, ".env")
ALLOWED_MODELS = ["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]
MANUALS_DIR = os.path.join(ROOT, "manuals")
STOP_PATH = os.path.join(ROOT, "stop")
MAX_ATTACHMENT_CONTEXT_CHARS = 600000

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

def emit_payload(payload):
    serialized = json.dumps(payload, ensure_ascii=True, sort_keys=True)
    if payload.get("historyCompacted"):
        raw = serialized.encode("utf-8")
        compressed = zlib.compress(raw, 6)
        encoded = base64.b64encode(compressed)
        try:
            encoded = encoded.decode("ascii")
        except AttributeError:
            pass
        print(json.dumps({
            "ok": True,
            "transportEncoding": "zlib-base64-json",
            "payloadB64": encoded,
            "compressedBytes": len(compressed),
            "uncompressedBytes": len(raw),
        }, ensure_ascii=True, sort_keys=True))
    else:
        print(serialized)

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

def append_message(role, content, source, meta=None, id_prefix=None, display_attachments=None):
    message = {
        "id": message_id(id_prefix or ("vm" if role == "agent" else "web")),
        "role": role,
        "source": source,
        "content": safe_text(content, 4000),
        "createdAt": now_iso(),
        "meta": meta or {},
    }
    if isinstance(display_attachments, list) and display_attachments:
        message["attachments"] = display_attachments[:12]
    append_jsonl(MESSAGES_PATH, message)
    audit("message", {"id": message.get("id"), "role": role, "source": source, "kind": (meta or {}).get("kind")})
    return message

def read_messages(after=0, limit=50, session_id=""):
    cursor = 0
    messages = []
    incremental = after > 0
    session_id = safe_text(session_id, 160).strip()
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
                    item = json.loads(line)
                except Exception:
                    continue
                if session_id:
                    meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
                    if safe_text(meta.get("sessionId"), 160).strip() != session_id:
                        continue
                item["sequence"] = cursor
                messages.append(item)
                if incremental and limit > 0 and len(messages) >= limit:
                    return messages, cursor
    if not incremental and limit > 0 and len(messages) > limit:
        messages = messages[-limit:]
    return messages, cursor

def message_meta(item):
    value = item.get("meta") if isinstance(item, dict) else {}
    return value if isinstance(value, dict) else {}

def message_kind(item):
    return safe_text(message_meta(item).get("kind"), 120).strip()

def is_legacy_reasoning_config_echo(item):
    meta = message_meta(item)
    if message_kind(item) != "agent_reasoning_summary":
        return False
    try:
        summary_index = int(meta.get("summaryIndex") or 0)
    except Exception:
        summary_index = 0
    content = safe_text(item.get("content"), 8).strip().lower()
    return summary_index > 1 and len(content) == 1 and content in "detailed"

def message_stream_state(item):
    meta = message_meta(item)
    return safe_text(meta.get("streamState") or meta.get("status"), 120).strip().lower()

def message_turn_id(item):
    meta = message_meta(item)
    return safe_text(meta.get("turnId") or meta.get("groupId"), 180).strip()

def message_target_id(item, turn_id_value=""):
    meta = message_meta(item)
    target = safe_text(meta.get("targetMessageId") or meta.get("messageId") or meta.get("streamId"), 220).strip()
    if target:
        return target
    return ("assistant_%s" % turn_id_value) if turn_id_value else ""

def is_response_delta(item):
    meta = message_meta(item)
    kind = message_kind(item)
    return item.get("role") == "agent" and not kind.startswith("agent_reasoning_summary_") and (kind == "agent_response_delta" or meta.get("delta") is True)

def is_response_terminal(item):
    if item.get("role") != "agent":
        return False
    meta = message_meta(item)
    kind = message_kind(item)
    if kind.startswith("agent_reasoning_summary_"):
        return False
    state = message_stream_state(item)
    has_stream_identity = bool(message_target_id(item, message_turn_id(item)))
    return (
        kind in ["agent_response_done", "agent_response_error"]
        or meta.get("done") is True
        or (has_stream_identity and state in ["done", "completed", "final", "error"])
    )

def is_response_stream_message(item):
    if item.get("role") != "agent":
        return False
    meta = message_meta(item)
    kind = message_kind(item)
    if kind.startswith("agent_reasoning_summary_"):
        return False
    state = message_stream_state(item)
    has_stream_identity = bool(message_target_id(item, message_turn_id(item)))
    return (
        is_response_delta(item)
        or is_response_terminal(item)
        or kind == "agent_response_stream"
        or meta.get("done") is False
        or (has_stream_identity and state in ["queued", "running", "streaming"])
    )

def attachment_key(attachment):
    if not isinstance(attachment, dict):
        return ""
    parts = [
        safe_text(attachment.get("source"), 220),
        safe_text(attachment.get("runId"), 220),
        safe_text(attachment.get("category"), 220),
        safe_text(attachment.get("path"), 1000),
    ]
    primary = ":".join(parts)
    if primary.replace(":", ""):
        return primary
    return ":".join([
        safe_text(attachment.get("id"), 220),
        safe_text(attachment.get("name"), 500),
    ])

def compacted_attachments(group):
    attachments = []
    seen = set()
    for item in group:
        values = item.get("attachments") if isinstance(item, dict) else None
        if not isinstance(values, list):
            continue
        for attachment in values:
            key = attachment_key(attachment)
            if not key or key in seen:
                continue
            seen.add(key)
            attachments.append(attachment)
    return attachments

def message_sequence(item):
    value = item.get("sequence") if isinstance(item, dict) else 0
    try:
        return int(value or 0)
    except Exception:
        return 0

def compact_delta_content(deltas, max_content_chars):
    content = ""
    truncated = False
    for item in deltas:
        chunk = item.get("content") if isinstance(item.get("content"), string_types) else ""
        if not chunk:
            continue
        meta = message_meta(item)
        if meta.get("append") is True:
            content += chunk
        elif meta.get("append") is False or chunk.startswith(content):
            content = chunk
        elif content.startswith(chunk) or content.endswith(chunk):
            continue
        else:
            content += chunk
        if len(content) > max_content_chars:
            content = content[:max_content_chars]
            truncated = True
            break
    return content, truncated

def compact_session_history(messages, max_content_chars=1048576):
    messages = [item for item in messages if not isinstance(item, dict) or not is_legacy_reasoning_config_echo(item)]
    groups = {}
    stream_sequences = set()
    for item in messages:
        if not isinstance(item, dict) or not is_response_stream_message(item):
            continue
        turn_id_value = message_turn_id(item)
        target_id = message_target_id(item, turn_id_value)
        if not target_id:
            continue
        key = "%s:%s" % (turn_id_value, target_id)
        groups.setdefault(key, []).append(item)
        stream_sequences.add(message_sequence(item))

    if not groups:
        return list(messages), False

    compacted = []
    any_content_truncated = False
    for key, group in groups.items():
        group.sort(key=message_sequence)
        terminal = None
        for item in reversed(group):
            if is_response_terminal(item):
                terminal = item
                break
        deltas = [item for item in group if is_response_delta(item)]
        first = group[0]
        last = terminal or group[-1]
        terminal_content = terminal.get("content") if terminal and isinstance(terminal.get("content"), string_types) else ""
        if terminal_content:
            content = terminal_content
            content_truncated = False
        else:
            content, content_truncated = compact_delta_content(deltas, max_content_chars)
        if not content and isinstance(last.get("content"), string_types):
            content = last.get("content")
        if len(content) > max_content_chars:
            content = content[:max_content_chars]
            content_truncated = True
        any_content_truncated = any_content_truncated or content_truncated

        turn_id_value = message_turn_id(last) or message_turn_id(first)
        target_id = message_target_id(last, turn_id_value) or message_target_id(first, turn_id_value) or last.get("id")
        merged_meta = {}
        merged_meta.update(message_meta(first))
        merged_meta.update(message_meta(last))
        merged_meta["kind"] = "agent_response_done" if terminal else "agent_response_stream"
        if turn_id_value:
            merged_meta["turnId"] = turn_id_value
        if target_id:
            merged_meta["targetMessageId"] = target_id
        merged_meta["streamState"] = "done" if terminal else "streaming"
        merged_meta["done"] = bool(terminal)
        merged_meta["compacted"] = True
        merged_meta["deltaCount"] = len(deltas)
        if content_truncated:
            merged_meta["contentTruncated"] = True
            merged_meta["contentLimitChars"] = max_content_chars

        compacted_item = dict(last)
        compacted_item["id"] = target_id or last.get("id")
        compacted_item["role"] = "agent"
        compacted_item["content"] = content
        compacted_item["createdAt"] = first.get("createdAt") or last.get("createdAt")
        if first.get("vmCreatedAt"):
            compacted_item["vmCreatedAt"] = first.get("vmCreatedAt")
        compacted_item["sequence"] = message_sequence(last)
        compacted_item["meta"] = merged_meta
        attachments = compacted_attachments(group)
        if attachments:
            compacted_item["attachments"] = attachments
        elif "attachments" in compacted_item:
            del compacted_item["attachments"]
        compacted.append(compacted_item)

    preserved = [
        item for item in messages
        if not isinstance(item, dict) or message_sequence(item) not in stream_sequences
    ]
    combined = preserved + compacted
    combined.sort(key=message_sequence)
    return combined, any_content_truncated

def json_bytes(value):
    encoded = json.dumps(value, ensure_ascii=True, sort_keys=True)
    try:
        return len(encoded.encode("utf-8"))
    except AttributeError:
        return len(encoded)

def fit_message_to_budget(item, byte_budget):
    if json_bytes(item) <= byte_budget:
        return item, False
    fitted = dict(item)
    content = fitted.get("content") if isinstance(fitted.get("content"), string_types) else ""
    meta = dict(message_meta(fitted))
    meta["contentTruncated"] = True
    meta["originalContentChars"] = len(content)
    fitted["meta"] = meta
    suffix = "\n\n[History message truncated to fit the transport budget.]"
    low = 0
    high = len(content)
    while low < high:
        middle = (low + high + 1) // 2
        fitted["content"] = content[:middle] + suffix
        if json_bytes(fitted) <= byte_budget:
            low = middle
        else:
            high = middle - 1
    fitted["content"] = content[:low] + suffix
    return fitted, True

def trim_history_response(messages, limit, byte_budget):
    limited = list(messages)
    truncated = False
    continuation = None
    if limit > 0 and len(limited) > limit:
        limited = limited[-limit:]
        truncated = True

    retained_reversed = []
    payload_bytes = 2
    for item in reversed(limited):
        remaining_budget = max(16384, byte_budget - payload_bytes - 1)
        fitted_item, item_truncated = fit_message_to_budget(item, remaining_budget)
        item_bytes = json_bytes(fitted_item) + (1 if retained_reversed else 0)
        if retained_reversed and payload_bytes + item_bytes > byte_budget:
            truncated = True
            break
        retained_reversed.append(fitted_item)
        payload_bytes += item_bytes
        truncated = truncated or item_truncated
    retained = list(reversed(retained_reversed))
    if len(retained) < len(limited):
        truncated = True
    if truncated and retained:
        continuation = str(message_sequence(retained[0]))
    return retained, truncated, continuation, payload_bytes

def read_compacted_session_history(session_id, limit=5000, history_before=0, byte_budget=4194304):
    raw_messages, cursor = read_messages(0, 0, session_id)
    if history_before > 0:
        raw_messages = [item for item in raw_messages if message_sequence(item) < history_before]
    compacted, content_truncated = compact_session_history(raw_messages, max(65536, byte_budget // 2))
    messages, truncated, continuation, payload_bytes = trim_history_response(compacted, limit, byte_budget)
    truncated = truncated or content_truncated
    return messages, cursor, {
        "historyCompacted": True,
        "rawCount": len(raw_messages),
        "compactedCount": len(compacted),
        "payloadBytes": payload_bytes,
        "truncated": truncated,
        "continuation": continuation,
    }

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

def list_manuals():
    if not os.path.isdir(MANUALS_DIR):
        return []
    allowed = [".txt", ".md", ".rst", ".cmd", ".des", ".par", ".scm", ".sde"]
    files = []
    for path in sorted(glob.glob(os.path.join(MANUALS_DIR, "*"))):
        if not os.path.isfile(path):
            continue
        name = os.path.basename(path)
        if name.startswith("."):
            continue
        if os.path.splitext(name)[1].lower() in allowed:
            files.append(name)
    return files

def queue_depth():
    ensure_dir(QUEUE_DIR)
    return len(glob.glob(os.path.join(QUEUE_DIR, "*.json")))

def normalize_attachment_ref(value):
    if not isinstance(value, dict):
        return None
    source = safe_text(value.get("source"), 60).strip()
    if source not in ["run-input", "vm-session-file", "vm-run-artifact"]:
        return None
    ref = {
        "id": safe_text(value.get("id") or "%s:%s" % (source, value.get("path") or ""), 180),
        "source": source,
        "name": safe_text(value.get("name") or value.get("path") or "attachment", 180),
        "path": safe_text(value.get("path"), 500).replace("\\", "/"),
        "size": int(value.get("size") or 0),
    }
    if value.get("runId"):
        ref["runId"] = safe_text(value.get("runId"), 180)
    if value.get("category"):
        ref["category"] = safe_text(value.get("category"), 180)
    if value.get("contentType"):
        ref["contentType"] = safe_text(value.get("contentType"), 120)
    if value.get("inlineText"):
        ref["inlineText"] = safe_text(value.get("inlineText"), MAX_ATTACHMENT_CONTEXT_CHARS)
    if value.get("inlineTextTruncated"):
        ref["inlineTextTruncated"] = bool(value.get("inlineTextTruncated"))
    if value.get("contextStatus"):
        ref["contextStatus"] = safe_text(value.get("contextStatus"), 80)
    if value.get("vmPath"):
        ref["vmPath"] = safe_text(value.get("vmPath"), 800)
    if value.get("inlineError"):
        ref["inlineError"] = safe_text(value.get("inlineError"), 300)
    return ref

def normalize_attachment_refs(values):
    if not isinstance(values, list):
        return []
    refs = []
    for value in values[:8]:
        ref = normalize_attachment_ref(value)
        if ref:
            refs.append(ref)
    return refs

def attachment_diag(ref):
    item = {
        "id": safe_text(ref.get("id"), 180),
        "source": safe_text(ref.get("source"), 60),
        "name": safe_text(ref.get("name"), 180),
        "path": safe_text(ref.get("path"), 500),
        "size": int(ref.get("size") or 0),
    }
    if ref.get("runId"):
        item["runId"] = safe_text(ref.get("runId"), 180)
    if ref.get("category"):
        item["category"] = safe_text(ref.get("category"), 180)
    if ref.get("inlineText"):
        item["inline"] = True
        item["inlineSize"] = len(safe_text(ref.get("inlineText"), MAX_ATTACHMENT_CONTEXT_CHARS))
    if ref.get("contextStatus"):
        item["contextStatus"] = safe_text(ref.get("contextStatus"), 80)
    if ref.get("vmPath"):
        item["vmPath"] = safe_text(ref.get("vmPath"), 800)
    if ref.get("inlineTextTruncated"):
        item["truncated"] = True
    if ref.get("inlineError"):
        item["error"] = safe_text(ref.get("inlineError"), 300)
    return item

def normalize_display_attachment(value):
    if not isinstance(value, dict):
        return None
    source = safe_text(value.get("source"), 60).strip()
    if source not in ["run-input", "vm-session-file", "vm-run-artifact"]:
        return None
    item = {
        "id": safe_text(value.get("id") or "%s:%s" % (source, value.get("path") or ""), 180),
        "kind": "image" if value.get("kind") == "image" else "file",
        "name": safe_text(value.get("name") or value.get("path") or "attachment", 180),
        "size": int(value.get("size") or 0),
        "source": source,
        "path": safe_text(value.get("path"), 500).replace("\\", "/"),
    }
    if value.get("contentType"):
        item["contentType"] = safe_text(value.get("contentType"), 120)
    if value.get("runId"):
        item["runId"] = safe_text(value.get("runId"), 180)
    if value.get("category"):
        item["category"] = safe_text(value.get("category"), 180)
    return item

def normalize_display_attachments(values):
    if not isinstance(values, list):
        return []
    result = []
    for value in values[:12]:
        item = normalize_display_attachment(value)
        if item:
            result.append(item)
    return result

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

def config_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        raw_items = value
    else:
        raw_items = safe_text(value, 2000).replace("\n", ",").split(",")
    items = []
    for item in raw_items:
        item = safe_text(item, 160).strip()
        if item and item not in items:
            items.append(item)
    return items

def model_candidates(primary_model, configured_models):
    models = [item for item in config_list(configured_models) if item in ALLOWED_MODELS]
    primary = safe_text(primary_model, 160).strip()
    if primary not in ALLOWED_MODELS:
        primary = "gpt-5.5"
    if primary and primary not in models:
        models.insert(0, primary)
    if not models:
        models = ["gpt-5.5"]
    return models

def config_int(env, file_config, env_key, file_key, fallback, minimum, maximum):
    raw = env.get(env_key)
    if raw is None:
        raw = file_config.get(file_key)
    if raw is None:
        raw = file_config.get(env_key)
    try:
        value = int(raw)
    except Exception:
        value = fallback
    return max(minimum, min(maximum, value))

def load_config():
    env = read_env_file(ENV_PATH)
    file_config = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r") as handle:
                file_config = json.load(handle)
        except Exception:
            file_config = {}
    primary_model = env.get("LLM_MODEL") or file_config.get("llmModel") or file_config.get("LLM_MODEL") or "gpt-5.5"
    if primary_model not in ALLOWED_MODELS:
        primary_model = "gpt-5.5"
    raw_models = env.get("LLM_MODELS") or file_config.get("llmModels") or file_config.get("LLM_MODELS")
    context_window = 353000 if primary_model.startswith("gpt-5.6-") else 272000
    return {
        "api_base": env.get("LLM_API_BASE") or file_config.get("llmApiBase") or file_config.get("LLM_API_BASE") or "",
        "api_key": env.get("LLM_API_KEY") or file_config.get("llmApiKey") or file_config.get("LLM_API_KEY") or "",
        "model": primary_model,
        "models": model_candidates(primary_model, raw_models),
        "api_style": env.get("LLM_API_STYLE") or file_config.get("llmApiStyle") or file_config.get("LLM_API_STYLE") or "chat-completions",
        "reasoning_effort": "max",
        "context_window_tokens": context_window,
        "context_target_tokens": (context_window * 85) // 100,
        "context_hard_tokens": (context_window * 95) // 100,
        "llm_timeout_seconds": config_int(env, file_config, "VM_AGENT_LLM_TIMEOUT_SECONDS", "vmAgentLlmTimeoutSeconds", 600, 30, 1800),
        "max_autodebug_attempts": config_int(env, file_config, "VM_AGENT_MAX_AUTODEBUG_ATTEMPTS", "vmAgentMaxAutodebugAttempts", 5, 1, 8),
    }

def llm_configured():
    config = load_config()
    return bool(config.get("api_base") and config.get("api_key"))

def read_worker_pids():
    if not os.path.exists(PID_PATH):
        return []
    values = []
    try:
        with open(PID_PATH, "r") as handle:
            for line in handle:
                line = line.strip()
                if line:
                    pid = int(line)
                    if pid not in values:
                        values.append(pid)
    except Exception:
        return []
    return values

def pid_alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False

def worker_running():
    pids = [pid for pid in read_worker_pids() if pid_alive(pid)]
    return bool(pids), (pids[0] if pids else None)

def write_worker_files():
    ensure_dir(ROOT)
    ensure_dir(QUEUE_DIR)
    ensure_dir(DONE_DIR)
    ensure_dir(MANUALS_DIR)
    ensure_dir(CAPABILITIES_DIR)
    worker_source = base64.b64decode(WORKER_SOURCE_B64)
    with open(WORKER_PATH, "wb") as handle:
        handle.write(worker_source)
    os.chmod(WORKER_PATH, 0o700)
    if not os.path.lexists(AGENTS_PATH):
        agents_source = base64.b64decode(AGENTS_SOURCE_B64)
        descriptor = None
        try:
            descriptor = os.open(AGENTS_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                descriptor = None
                handle.write(agents_source)
        except OSError:
            if not os.path.lexists(AGENTS_PATH):
                raise
        finally:
            if descriptor is not None:
                os.close(descriptor)
    extractor_source = base64.b64decode(DFISE_EXTRACTOR_SOURCE_B64)
    extractor_hash = hashlib.sha256(extractor_source).hexdigest()
    if extractor_hash != DFISE_EXTRACTOR_SHA256:
        raise ValueError("DF-ISE extractor source hash mismatch")
    with open(DFISE_EXTRACTOR_PATH, "wb") as handle:
        handle.write(extractor_source)
    os.chmod(DFISE_EXTRACTOR_PATH, 0o700)
    with open(DFISE_CAPABILITY_PATH, "w") as handle:
        handle.write(json.dumps({
            "ruleId": "dfise-plt-postprocess-v1",
            "extractorVersion": "dfise-idvg-extract/1",
            "metricProfile": "tcad-idvg-v1",
            "extractorSha256": extractor_hash,
            "parserPath": DFISE_EXTRACTOR_PATH,
            "rules": [
                "Use the fixed dfise-idvg-v1 postprocess for readable DF-ISE .plt Id-Vg extraction.",
                "Do not generate Inspect cv_* extraction or dynamic Tcl/Python parsers.",
                "Read actual drain biases from file content and reject expected-bias mismatches.",
                "Support max-adjacent-slope-v1 and two-point-log-interpolation-v1 SS definitions.",
                "Allow the DIBL constant-current target to differ from the Vth target.",
                "Declare success only when all required finite metrics are present.",
                "Publish non-image outputs as general files and PNG outputs as images."
            ]
        }, ensure_ascii=True, indent=2, sort_keys=True) + "\n")
    if not os.path.exists(CONFIG_EXAMPLE_PATH):
        with open(CONFIG_EXAMPLE_PATH, "w") as handle:
            handle.write(json.dumps({
                "llmApiBase": "https://your-openai-compatible-base/v1",
                "llmApiKey": "put-real-key-here-inside-vm-only",
                "llmModel": "gpt-5.5",
                "llmModels": ["gpt-5.5"],
                "llmApiStyle": "openai-responses",
                "llmReasoningEffort": "max",
                "llmReasoningSummary": "auto",
                "vmAgentLlmTimeoutSeconds": 600,
                "vmAgentMaxAutodebugAttempts": 5
            }, indent=2, sort_keys=True) + "\n")
    if not os.path.exists(ENV_EXAMPLE_PATH):
        with open(ENV_EXAMPLE_PATH, "w") as handle:
            handle.write("LLM_API_BASE=https://your-openai-compatible-base/v1\nLLM_API_KEY=put-real-key-here-inside-vm-only\nLLM_MODEL=gpt-5.5\nLLM_MODELS=gpt-5.5\nLLM_API_STYLE=openai-responses\nLLM_REASONING_EFFORT=max\nLLM_REASONING_SUMMARY=auto\nVM_AGENT_LLM_TIMEOUT_SECONDS=600\nVM_AGENT_MAX_AUTODEBUG_ATTEMPTS=5\n")

def stop_worker(pid):
    if not pid:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        return
    deadline = time.time() + 3
    while time.time() < deadline:
        if not pid_alive(pid):
            return
        time.sleep(0.1)
    try:
        os.kill(pid, signal.SIGKILL)
    except Exception:
        pass

def start_worker(force_restart=False):
    pids = [pid for pid in read_worker_pids() if pid_alive(pid)]
    if pids and not force_restart:
        return pids[0]
    worker_count = max(1, len(pids))
    for pid in pids:
        stop_worker(pid)
    write_worker_files()
    if os.path.exists(STOP_PATH):
        os.unlink(STOP_PATH)
    log = open(LOG_PATH, "ab")
    kwargs = {"stdout": log, "stderr": log, "cwd": ROOT, "close_fds": True}
    if hasattr(os, "setsid"):
        kwargs["preexec_fn"] = os.setsid
    started_pids = []
    try:
        for _index in range(worker_count):
            proc = subprocess.Popen([sys.executable or "python", WORKER_PATH], **kwargs)
            started_pids.append(proc.pid)
    finally:
        log.close()
    with open(PID_PATH, "w") as handle:
        handle.write("\n".join([str(pid) for pid in started_pids]) + "\n")
    audit("worker_started", {"pid": started_pids[0], "pids": started_pids, "count": len(started_pids)})
    time.sleep(0.2)
    return started_pids[0]

def build_status(message_count_value=None):
    instances = list_instances()
    running, pid = worker_running()
    llm_config = load_config()
    manuals = list_manuals()
    return {
        "ok": True,
        "agent": AGENT_NAME,
        "version": AGENT_VERSION,
        "hostname": socket.gethostname(),
        "user": getpass.getuser(),
        "capabilities": ["relay_message", "history", "vm_worker", "vm_local_llm_config", "vm_model_switching", "sentaurus_skills", "sentaurus_run_request", "sentaurus_autodebug", "sentaurus_session_output", "session_workflow_v1", "goal_lifecycle", "plan_mode"],
        "instanceCount": len(instances),
        "latestInstance": instances[-1] if instances else None,
        "mailbox": "~/.sentaurus-web-agent/vm-agent",
        "messageCount": message_count() if message_count_value is None else message_count_value,
        "workerRunning": running,
        "workerPid": pid if running else None,
        "llmConfigured": bool(llm_config.get("api_base") and llm_config.get("api_key")),
        "llmModel": llm_config.get("model"),
        "llmModels": llm_config.get("models"),
        "llmReasoningEffort": llm_config.get("reasoning_effort"),
        "llmContextWindowTokens": llm_config.get("context_window_tokens"),
        "llmContextTargetTokens": llm_config.get("context_target_tokens"),
        "llmContextHardTokens": llm_config.get("context_hard_tokens"),
        "llmTimeoutSeconds": llm_config.get("llm_timeout_seconds"),
        "maxAutodebugAttempts": llm_config.get("max_autodebug_attempts"),
        "manualCount": len(manuals),
        "manualFiles": manuals[:20],
        "queueDepth": queue_depth(),
        "sentaurusTools": sentaurus_tools(),
        "vmTime": now_iso(),
        "vmEpochMs": int(time.time() * 1000),
    }

def enqueue_message(content, session_id=None, turn_id_value="", attachments=None, display_attachments=None):
    ensure_dir(QUEUE_DIR)
    meta = {"kind": "web_message", "queuedFor": "vm-agent-worker"}
    session_id = safe_text(session_id, 160).strip()
    if session_id:
        meta["sessionId"] = session_id
    turn_id_value = safe_text(turn_id_value, 180).strip() or turn_id()
    meta["turnId"] = turn_id_value
    meta["groupId"] = turn_id_value
    meta["protocolVersion"] = 2
    attachment_refs = normalize_attachment_refs(attachments)
    if attachment_refs:
        meta["attachmentCount"] = len(attachment_refs)
        meta["attachmentsJson"] = json.dumps([attachment_diag(ref) for ref in attachment_refs], ensure_ascii=True, sort_keys=True)
    display_refs = normalize_display_attachments(display_attachments)
    message = append_message("user", content, "web", meta, "web", display_refs)
    if attachment_refs:
        message["contextAttachments"] = attachment_refs
    queue_path = os.path.join(QUEUE_DIR, message["id"] + ".json")
    with open(queue_path, "w") as handle:
        handle.write(json.dumps(message, ensure_ascii=True, sort_keys=True) + "\n")
    audit("message_queued", {"id": message.get("id"), "queueFile": os.path.basename(queue_path), "attachmentCount": len(attachment_refs)})
    return message

def handle(request):
    ensure_dir(ROOT)
    operation = request.get("operation") or "status"
    after = int(request.get("after") or 0)
    limit = int(request.get("limit") or 50)
    session_id = safe_text(request.get("sessionId"), 160).strip()
    history_before = max(0, int(request.get("historyBefore") or 0))
    response_byte_budget = max(65536, min(int(request.get("responseByteBudget") or 4194304), 16777216))
    messages = []
    cursor = 0
    history_meta = {}

    if operation == "start":
        pid = start_worker(True)
        messages = [append_message("agent", "CentOS VM agent worker is running. Browser/host will only relay messages; LLM credentials are read inside the VM.", "vm-agent-control", {"kind": "worker_ready", "pid": pid})]
    elif operation == "send":
        incoming = safe_text(request.get("message"), 4000)
        if not incoming.strip():
            raise ValueError("message is required")
        start_worker()
        messages = [enqueue_message(incoming, session_id, request.get("turnId"), request.get("attachments"), request.get("displayAttachments"))]
    elif operation == "history":
        if after == 0 and session_id:
            messages, cursor, history_meta = read_compacted_session_history(
                session_id,
                limit,
                history_before,
                response_byte_budget,
            )
        else:
            messages, cursor = read_messages(after, limit, session_id)
    elif operation == "status":
        count = message_count()
        messages, cursor = read_messages(max(0, count - limit), limit)
    else:
        raise ValueError("unsupported operation: %s" % operation)

    if cursor <= 0:
        _all, cursor = read_messages(0, 0)
    status = build_status(cursor)
    payload = status.copy()
    payload["messages"] = messages
    payload["cursor"] = cursor
    payload["protocolVersion"] = 2
    payload.update(history_meta)
    return payload

try:
    emit_payload(handle(load_json_b64(REQUEST_B64)))
    print("REMOTE_AGENT_DONE")
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
    print("REMOTE_AGENT_DONE")
    sys.exit(0)
`;

const remoteArtifactDownloadScript = String.raw`# -*- coding: utf-8 -*-
import base64
import hashlib
import json
import os
import re
import sys

REQUEST_B64 = "__ARTIFACT_REQUEST_B64__"
HOME = os.path.expanduser("~")
RUNS_DIR = os.path.join(HOME, "STDB", "web-agent-runs")
MAX_BYTES = __MAX_VM_ARTIFACT_BYTES__
STAGED_PATH = "__ARTIFACT_STAGED_PATH__"
ALLOWED_EXT = set([".log", ".out", ".err", ".plt", ".tdr", ".grd", ".dat", ".csv", ".txt", ".png", ".jpg", ".jpeg", ".json", ".cmd", ".des", ".par", ".scm", ".tcl", ".bnd", ".sat"])

try:
    string_types = (basestring,)
except NameError:
    string_types = (str,)

def respond(payload):
    print(json.dumps(payload, ensure_ascii=True, sort_keys=True))
    print("REMOTE_ARTIFACT_DONE")

def cleanup_staged():
    try:
        if os.path.isfile(STAGED_PATH):
            os.remove(STAGED_PATH)
    except Exception:
        pass

def fail(message, status_code=400):
    cleanup_staged()
    respond({"ok": False, "error": message, "statusCode": status_code})
    sys.exit(0)

def safe_text(value, limit=1000):
    if value is None:
        return ""
    if not isinstance(value, string_types):
        value = str(value)
    return value[:limit]

def load_request():
    raw = base64.b64decode(REQUEST_B64)
    try:
        text = raw.decode("utf-8")
    except AttributeError:
        text = raw
    return json.loads(text)

def safe_segments(rel_path):
    rel_path = safe_text(rel_path, 1000).strip().replace("\\", "/")
    if not rel_path or rel_path.startswith("/") or re.match(r"^[A-Za-z]:/", rel_path):
        fail("invalid artifact path")
    parts = []
    for part in rel_path.split("/"):
        if not part or part in [".", ".."] or part.startswith("."):
            fail("invalid artifact path segment")
        if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._@()+, -]{0,159}$", part):
            fail("artifact path contains unsupported characters")
        parts.append(part)
    return parts

def sha256_path(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()

try:
    if not re.match(r"^/tmp/sentaurus-web-artifact-[A-Za-z0-9-]{12,120}$", STAGED_PATH):
        fail("invalid artifact staging path", 500)
    request = load_request()
    run_id = safe_text(request.get("runId"), 180).strip()
    if not re.match(r"^run_[A-Za-z0-9_-]+$", run_id):
        fail("invalid VM run id")
    parts = safe_segments(request.get("path"))
    ext = os.path.splitext(parts[-1])[1].lower()
    if ext not in ALLOWED_EXT:
        fail("artifact extension is not allowlisted")
    run_dir = os.path.realpath(os.path.join(RUNS_DIR, run_id))
    target = os.path.realpath(os.path.join(run_dir, *parts))
    if target != run_dir and not target.startswith(run_dir + os.sep):
        fail("artifact path escapes run directory")
    if not os.path.isfile(target):
        fail("artifact not found", 404)
    size = os.path.getsize(target)
    if size > MAX_BYTES:
        fail("artifact is too large to download through the web relay", 413)
    if os.path.lexists(STAGED_PATH):
        fail("artifact staging path already exists", 500)
    with open(target, "rb") as source:
        with open(STAGED_PATH, "wb") as destination:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                destination.write(chunk)
    staged_size = os.path.getsize(STAGED_PATH)
    if staged_size != size or staged_size > MAX_BYTES:
        fail("artifact staging size mismatch", 500)
    respond({
        "ok": True,
        "path": "/".join(parts),
        "fileName": os.path.basename(target),
        "size": staged_size,
        "sha256": sha256_path(STAGED_PATH),
    })
except SystemExit:
    raise
except Exception as exc:
    fail(str(exc), 500)
`;

const remoteAgentsMdScript = String.raw`# -*- coding: utf-8 -*-
import base64
import datetime
import hashlib
import json
import os
import sys
import tempfile

try:
    string_types = (basestring,)
except NameError:
    string_types = (str,)

REQUEST_B64 = "__REQUEST_B64__"
HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".sentaurus-web-agent", "vm-agent")
TARGET_PATH = os.path.join(ROOT, "AGENTS.md")
MAX_BYTES = __MAX_VM_AGENTS_MD_BYTES__

def load_request():
    raw = base64.b64decode(REQUEST_B64)
    return json.loads(raw.decode("utf-8"))

def ensure_dir(path):
    if not os.path.isdir(path):
        os.makedirs(path)

def fail(message, status_code=400):
    print(json.dumps({"ok": False, "error": message, "statusCode": status_code}, ensure_ascii=True, sort_keys=True))
    sys.exit(0)

def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()

def emit_payload(content, exists):
    payload = {
        "ok": True,
        "path": TARGET_PATH,
        "exists": bool(exists),
        "content": content,
        "size": len(content.encode("utf-8")),
        "sha256": sha256_text(content),
    }
    if exists and os.path.exists(TARGET_PATH):
        stat = os.stat(TARGET_PATH)
        payload["updatedAt"] = datetime.datetime.utcfromtimestamp(stat.st_mtime).replace(microsecond=0).isoformat() + "Z"
    print(json.dumps(payload, ensure_ascii=True, sort_keys=True))

try:
    request = load_request()
    operation = (request.get("operation") or "get").strip().lower()
    if operation == "get":
        if not os.path.exists(TARGET_PATH):
            emit_payload("", False)
        else:
            with open(TARGET_PATH, "rb") as handle:
                emit_payload(handle.read().decode("utf-8", "replace"), True)
    elif operation == "put":
        content = request.get("content")
        if not isinstance(content, string_types):
            fail("content must be a string")
        content_bytes = content.encode("utf-8")
        if len(content_bytes) > MAX_BYTES:
            fail("AGENTS.md content exceeds the VM relay size limit", 413)
        ensure_dir(ROOT)
        fd, temp_path = tempfile.mkstemp(prefix="agents-md-", dir=ROOT)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(content_bytes)
            os.rename(temp_path, TARGET_PATH)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        emit_payload(content, True)
    else:
        fail("unsupported operation", 400)
except SystemExit:
    raise
except Exception as exc:
    fail(str(exc), 500)
`;

function remoteAgentsMdRequestScript(operation: "get" | "put", content = ""): string {
  const encodedRequest = Buffer.from(JSON.stringify({ operation, content }), "utf8").toString("base64");
  return remoteAgentsMdScript
    .replace("__REQUEST_B64__", encodedRequest)
    .replace("__MAX_VM_AGENTS_MD_BYTES__", String(maxVmAgentsMdBytes));
}

function parseVmAgentAgentsMdPayload(raw: string): VmAgentAgentsMdPayload {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) throw httpError(502, `VM AGENTS.md relay did not return JSON: ${raw.slice(0, 500)}`);
  return JSON.parse(jsonLine) as VmAgentAgentsMdPayload;
}

export function remoteAgentScript(request: RemoteAgentRequest): string {
  const encodedRequest = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  const workerSource = localWorkerSource.replace(
    /DFISE_EXTRACTOR_SHA256\s*=\s*"[0-9a-f]+"/,
    `DFISE_EXTRACTOR_SHA256 = "${dfiseExtractorSha256}"`
  );
  const encodedWorker = Buffer.from(workerSource, "utf8").toString("base64");
  const encodedAgents = Buffer.from(defaultAgentsSource, "utf8").toString("base64");
  const encodedExtractor = Buffer.from(dfiseExtractorSource, "utf8").toString("base64");
  return remoteControlScript
    .replace("__REQUEST_B64__", encodedRequest)
    .replace("__WORKER_SOURCE_B64__", encodedWorker)
    .replace("__AGENTS_SOURCE_B64__", encodedAgents)
    .replace("__DFISE_EXTRACTOR_SOURCE_B64__", encodedExtractor)
    .replace("__DFISE_EXTRACTOR_SHA256__", dfiseExtractorSha256);
}

export function remoteArtifactScript(runId: string, artifactPath: string, stagedPath: string): string {
  const encodedRequest = Buffer.from(JSON.stringify({ runId, path: artifactPath }), "utf8").toString("base64");
  return remoteArtifactDownloadScript
    .replace("__ARTIFACT_REQUEST_B64__", encodedRequest)
    .replace("__ARTIFACT_STAGED_PATH__", stagedPath)
    .replace("__MAX_VM_ARTIFACT_BYTES__", String(maxVmArtifactBytes));
}

export function parseRemoteJson(raw: string): RemoteAgentPayload {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) throw new Error(`VM agent did not return JSON: ${raw.slice(0, 500)}`);
  const parsed = JSON.parse(jsonLine) as RemoteAgentPayload & {
    transportEncoding?: string;
    payloadB64?: string;
    compressedBytes?: number;
    uncompressedBytes?: number;
  };
  if (parsed.transportEncoding !== "zlib-base64-json") return parsed;
  if (typeof parsed.payloadB64 !== "string") throw new Error("VM agent compressed response is missing payloadB64");
  const payload = JSON.parse(inflateSync(Buffer.from(parsed.payloadB64, "base64")).toString("utf8")) as RemoteAgentPayload;
  return {
    ...payload,
    transportCompressedBytes: parsed.compressedBytes,
    transportUncompressedBytes: parsed.uncompressedBytes
  };
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function artifactExtension(artifactPath: string): string {
  const name = artifactPath.split("/").at(-1) || "";
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : "";
}

function localAttachmentExtension(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return extension || artifactExtension(filePath);
}

function metadataOnlyAttachment(ref: VmAgentAttachmentRef, status: EnrichedVmAgentAttachmentRef["contextStatus"], reason: string): EnrichedVmAgentAttachmentRef {
  return { ...ref, contextStatus: status, inlineError: reason };
}

function inlineTextAttachment(ref: VmAgentAttachmentRef, data: Buffer, remainingChars: number): EnrichedVmAgentAttachmentRef {
  const extension = localAttachmentExtension(ref.path || ref.name);
  if (!readableAttachmentExtensions.has(extension)) {
    return metadataOnlyAttachment(ref, "metadata_only", "extension is not readable text");
  }
  if (remainingChars <= 0) {
    return metadataOnlyAttachment(ref, "too_large", "inline attachment character budget exhausted");
  }
  const byteLimit = Math.min(maxInlineAttachmentBytes, data.byteLength, Math.max(0, remainingChars * 4));
  const rawText = data.subarray(0, byteLimit).toString("utf8");
  const inlineText = rawText.slice(0, remainingChars);
  return {
    ...ref,
    contextStatus: "inline",
    inlineText,
    inlineTextTruncated: data.byteLength > byteLimit || rawText.length > remainingChars,
    size: data.byteLength
  };
}

async function enrichRunInputAttachment(ref: VmAgentAttachmentRef, remainingChars: number): Promise<EnrichedVmAgentAttachmentRef> {
  const enriched: EnrichedVmAgentAttachmentRef = { ...ref };
  if (!ref.runId) return { ...enriched, contextStatus: "error", inlineError: "run-input attachment requires runId" };
  const safeRun = safeRunId(ref.runId);
  const safePath = safeRelativePath(ref.path);
  try {
    const localPath = await resolveRunFile(safeRun, "input", safePath);
    const data = await fs.readFile(localPath);
    return inlineTextAttachment({ ...enriched, path: safePath, runId: safeRun }, data, remainingChars);
  } catch (err) {
    return { ...enriched, contextStatus: "not_found", inlineError: err instanceof Error ? err.message : String(err) };
  }
}

async function enrichVmSessionAttachment(ref: VmAgentAttachmentRef, remainingChars: number): Promise<EnrichedVmAgentAttachmentRef> {
  if (!ref.runId) return { ...ref, contextStatus: "error", inlineError: "vm-session-file attachment requires runId" };
  if (!ref.category) return { ...ref, contextStatus: "error", inlineError: "vm-session-file attachment requires category" };
  try {
    const file = await downloadVmSessionFile(ref.runId, ref.category, ref.path);
    return inlineTextAttachment({ ...ref, path: file.path, name: file.fileName, size: file.size }, file.data, remainingChars);
  } catch (err) {
    return { ...ref, contextStatus: "not_found", inlineError: err instanceof Error ? err.message : String(err) };
  }
}

async function enrichVmRunArtifactAttachment(ref: VmAgentAttachmentRef, remainingChars: number): Promise<EnrichedVmAgentAttachmentRef> {
  if (!ref.runId) return { ...ref, contextStatus: "error", inlineError: "vm-run-artifact attachment requires runId" };
  try {
    const artifact = await downloadVmRunArtifact(ref.runId, ref.path);
    return inlineTextAttachment({ ...ref, path: artifact.path, name: artifact.fileName, size: artifact.size }, artifact.data, remainingChars);
  } catch (err) {
    return { ...ref, contextStatus: "not_found", inlineError: err instanceof Error ? err.message : String(err) };
  }
}

async function enrichAttachmentsForVm(attachments: VmAgentAttachmentRef[]): Promise<EnrichedVmAgentAttachmentRef[]> {
  const enriched: EnrichedVmAgentAttachmentRef[] = [];
  let remainingChars = maxInlineAttachmentTotalChars;
  for (const ref of attachments.slice(0, 8)) {
    let item: EnrichedVmAgentAttachmentRef;
    if (ref.source === "run-input") {
      item = await enrichRunInputAttachment(ref, remainingChars);
    } else if (ref.source === "vm-session-file") {
      item = await enrichVmSessionAttachment(ref, remainingChars);
    } else if (ref.source === "vm-run-artifact") {
      item = await enrichVmRunArtifactAttachment(ref, remainingChars);
    } else {
      item = { ...ref, contextStatus: "unsupported", inlineError: "unsupported attachment source" };
    }
    if (item.inlineText) remainingChars = Math.max(0, remainingChars - item.inlineText.length);
    enriched.push(item);
  }
  return enriched;
}

function validateVmArtifactRequest(runId: string, artifactPath: string): { runId: string; artifactPath: string } {
  try {
    const safeRun = safeRunId(runId);
    const safePath = safeRelativePath(artifactPath);
    const extension = artifactExtension(safePath);
    if (!vmArtifactExtensions.has(extension)) {
      throw new Error("Artifact extension is not allowlisted");
    }
    return { runId: safeRun, artifactPath: safePath };
  } catch (err) {
    throw httpError(400, err instanceof Error ? err.message : "Invalid VM artifact path");
  }
}

function parseEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hostTiming(payload: RemoteAgentPayload, hostEpochMs = Date.now()): RemoteAgentPayload {
  const hostTime = new Date(hostEpochMs).toISOString();
  const vmEpochMs = typeof payload.vmEpochMs === "number" && Number.isFinite(payload.vmEpochMs)
    ? payload.vmEpochMs
    : parseEpochMs(payload.vmTime);
  const clockSkewMs = typeof vmEpochMs === "number" ? vmEpochMs - hostEpochMs : undefined;
  return {
    ...payload,
    hostTime,
    hostEpochMs,
    hostReceivedAt: hostTime,
    vmEpochMs,
    clockSkewMs,
    clockSkewWarning: typeof clockSkewMs === "number" ? Math.abs(clockSkewMs) > 30_000 : undefined
  };
}

function adjustedTimestamp(value: unknown, clockSkewMs: number | undefined, fallback: string): string {
  const vmEpochMs = parseEpochMs(value);
  if (typeof vmEpochMs === "number" && typeof clockSkewMs === "number") {
    return new Date(vmEpochMs - clockSkewMs).toISOString();
  }
  return typeof value === "string" && value.trim() ? value : fallback;
}

function normalizeMessageMeta(value: unknown): VmAgentMessage["meta"] {
  if (!value || typeof value !== "object") return undefined;
  const meta: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      meta[key] = item;
    }
  }
  return Object.keys(meta).length > 0 ? meta as VmAgentMessage["meta"] : undefined;
}

function normalizeDisplayAttachments(value: unknown): VmAgentMessage["attachments"] {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.flatMap((item): NonNullable<VmAgentMessage["attachments"]> => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const source = typeof record.source === "string" && record.source.trim() ? record.source.trim() : undefined;
    const kind = typeof record.kind === "string" && record.kind.trim() ? record.kind.trim() : undefined;
    const path = typeof record.path === "string" && record.path.trim() ? record.path.trim().replace(/\\/g, "/") : undefined;
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : path?.split("/").at(-1);
    if (!path && !name) return [];
    return [{
      id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : source && path ? `${source}:${path}` : undefined,
      kind,
      name,
      size: typeof record.size === "number" && Number.isFinite(record.size) ? record.size : undefined,
      contentType: typeof record.contentType === "string" ? record.contentType : undefined,
      source,
      path,
      runId: typeof record.runId === "string" ? record.runId : undefined,
      category: typeof record.category === "string" ? record.category : undefined,
      width: typeof record.width === "number" ? record.width : undefined,
      height: typeof record.height === "number" ? record.height : undefined,
      thumbnailPath: typeof record.thumbnailPath === "string" ? record.thumbnailPath : undefined
    }];
  });
  return attachments.length ? attachments : undefined;
}

export function normalizeMessages(messages: unknown[] | undefined, payload: RemoteAgentPayload): VmAgentMessage[] {
  if (!Array.isArray(messages)) return [];
  const hostReceivedAt = payload.hostReceivedAt || new Date().toISOString();
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const item = message as Partial<VmAgentMessage> & { source?: string; sequence?: unknown };
    const role = item.role === "user" || item.role === "agent" || item.role === "system" ? item.role : "agent";
    const vmCreatedAt = typeof item.createdAt === "string" ? item.createdAt : undefined;
    const sequence = typeof item.sequence === "number" && Number.isFinite(item.sequence) ? item.sequence : undefined;
    return [{
      id: typeof item.id === "string" ? item.id : `vm_msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      role,
      content: typeof item.content === "string" ? item.content : "",
      createdAt: adjustedTimestamp(vmCreatedAt, payload.clockSkewMs, hostReceivedAt),
      vmCreatedAt,
      hostReceivedAt,
      sequence,
      meta: normalizeMessageMeta(item.meta),
      attachments: normalizeDisplayAttachments(item.attachments)
    }];
  });
}

function normalizedMessageKind(message: VmAgentMessage): string {
  return typeof message.meta?.kind === "string" ? message.meta.kind : "";
}

function isLegacyReasoningConfigEcho(message: VmAgentMessage): boolean {
  const summaryIndex = typeof message.meta?.summaryIndex === "number" ? message.meta.summaryIndex : 0;
  return normalizedMessageKind(message) === "agent_reasoning_summary"
    && summaryIndex > 1
    && /^[detail]$/i.test(message.content.trim());
}

function normalizedStreamState(message: VmAgentMessage): string {
  const value = message.meta?.streamState ?? message.meta?.status;
  return typeof value === "string" ? value.toLowerCase() : "";
}

function normalizedTurnId(message: VmAgentMessage): string | undefined {
  const value = message.meta?.turnId ?? message.meta?.groupId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedTargetMessageId(message: VmAgentMessage, turnId?: string): string | undefined {
  const target = message.meta?.targetMessageId ?? message.meta?.messageId ?? message.meta?.streamId;
  if (typeof target === "string" && target.trim()) return target.trim();
  return turnId ? `assistant_${turnId}` : undefined;
}

function isResponseDelta(message: VmAgentMessage): boolean {
  const kind = normalizedMessageKind(message);
  return message.role === "agent" && !kind.startsWith("agent_reasoning_summary_") && (kind === "agent_response_delta" || message.meta?.delta === true);
}

function isResponseTerminal(message: VmAgentMessage): boolean {
  const kind = normalizedMessageKind(message);
  if (kind.startsWith("agent_reasoning_summary_")) return false;
  const state = normalizedStreamState(message);
  const hasStreamIdentity = !!normalizedTargetMessageId(message, normalizedTurnId(message));
  return message.role === "agent" && (
    kind === "agent_response_done"
    || kind === "agent_response_error"
    || message.meta?.done === true
    || (hasStreamIdentity && (state === "done" || state === "completed" || state === "final" || state === "error"))
  );
}

function isResponseStreamMessage(message: VmAgentMessage): boolean {
  if (message.role !== "agent") return false;
  const kind = normalizedMessageKind(message);
  if (kind.startsWith("agent_reasoning_summary_")) return false;
  const state = normalizedStreamState(message);
  const hasStreamIdentity = !!normalizedTargetMessageId(message, normalizedTurnId(message));
  return isResponseDelta(message)
    || isResponseTerminal(message)
    || kind === "agent_response_stream"
    || message.meta?.done === false
    || (hasStreamIdentity && (state === "queued" || state === "running" || state === "streaming"));
}

function messageSortValue(message: VmAgentMessage): number {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortMessagesBySequence(messages: VmAgentMessage[]): VmAgentMessage[] {
  return [...messages].sort((a, b) => {
    const aSequence = typeof a.sequence === "number" && Number.isFinite(a.sequence) ? a.sequence : null;
    const bSequence = typeof b.sequence === "number" && Number.isFinite(b.sequence) ? b.sequence : null;
    if (aSequence !== null && bSequence !== null && aSequence !== bSequence) return aSequence - bSequence;
    return messageSortValue(a) - messageSortValue(b);
  });
}

function attachmentKey(attachment: NonNullable<VmAgentMessage["attachments"]>[number]): string {
  return [
    attachment.source || "",
    attachment.runId || "",
    attachment.category || "",
    attachment.path || "",
    attachment.id || "",
    attachment.name || ""
  ].join(":");
}

function compactedAttachments(messages: VmAgentMessage[]): VmAgentMessage["attachments"] {
  const terminal = [...messages].reverse().find((message) => isResponseTerminal(message) && message.attachments?.length);
  if (terminal?.attachments?.length) return terminal.attachments;

  const byKey = new Map<string, NonNullable<VmAgentMessage["attachments"]>[number]>();
  for (const message of messages) {
    for (const attachment of message.attachments || []) byKey.set(attachmentKey(attachment), attachment);
  }
  return byKey.size > 0 ? [...byKey.values()] : undefined;
}

function compactSessionHistory(messages: VmAgentMessage[]): VmAgentMessage[] {
  const sorted = sortMessagesBySequence(messages.filter((message) => !isLegacyReasoningConfigEcho(message)));
  const streamGroups = new Map<string, VmAgentMessage[]>();
  const streamMessageIds = new Set<string>();

  for (const message of sorted) {
    if (!isResponseStreamMessage(message)) continue;
    const turnId = normalizedTurnId(message);
    const targetMessageId = normalizedTargetMessageId(message, turnId);
    if (!targetMessageId) continue;
    const groupKey = `${turnId || ""}:${targetMessageId}`;
    const group = streamGroups.get(groupKey) || [];
    group.push(message);
    streamGroups.set(groupKey, group);
    streamMessageIds.add(message.id);
  }

  if (streamGroups.size === 0) return sorted;

  const compacted: VmAgentMessage[] = [];
  for (const [groupKey, group] of streamGroups) {
    const groupSorted = sortMessagesBySequence(group);
    const terminal = [...groupSorted].reverse().find(isResponseTerminal);
    const deltaMessages = groupSorted.filter(isResponseDelta);
    const finalWithContent = terminal && terminal.content.trim() ? terminal : undefined;
    const [turnId, targetMessageId] = groupKey.split(":");
    const content = finalWithContent ? finalWithContent.content : deltaMessages.map((message) => message.content).join("");
    const lastMessage = terminal || groupSorted.at(-1);
    const firstMessage = groupSorted[0];
    if (!lastMessage || !firstMessage || !content) continue;

    compacted.push({
      ...lastMessage,
      id: targetMessageId || normalizedTargetMessageId(lastMessage, turnId) || lastMessage.id,
      role: "agent",
      content,
      createdAt: firstMessage.createdAt,
      vmCreatedAt: firstMessage.vmCreatedAt,
      sequence: lastMessage.sequence,
      meta: {
        ...firstMessage.meta,
        ...lastMessage.meta,
        kind: terminal ? "agent_response_done" : "agent_response_stream",
        turnId: turnId || normalizedTurnId(lastMessage),
        targetMessageId: targetMessageId || normalizedTargetMessageId(lastMessage, turnId),
        streamState: terminal ? "done" : "streaming",
        done: !!terminal,
        compacted: true,
        deltaCount: deltaMessages.length
      },
      attachments: compactedAttachments(groupSorted)
    });
  }

  const preserved = sorted.filter((message) => !streamMessageIds.has(message.id));
  return sortMessagesBySequence([...preserved, ...compacted]);
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
    llmModel: payload.llmModel,
    llmModels: payload.llmModels,
    llmReasoningEffort: payload.llmReasoningEffort,
    llmContextWindowTokens: payload.llmContextWindowTokens,
    llmContextTargetTokens: payload.llmContextTargetTokens,
    llmContextHardTokens: payload.llmContextHardTokens,
    llmTimeoutSeconds: payload.llmTimeoutSeconds,
    maxAutodebugAttempts: payload.maxAutodebugAttempts,
    manualCount: payload.manualCount,
    manualFiles: payload.manualFiles,
    queueDepth: payload.queueDepth,
    sentaurusTools: payload.sentaurusTools,
    vmTime: payload.vmTime,
    vmEpochMs: payload.vmEpochMs,
    hostTime: payload.hostTime,
    hostEpochMs: payload.hostEpochMs,
    clockSkewMs: payload.clockSkewMs,
    clockSkewWarning: payload.clockSkewWarning,
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
    hostTime: new Date().toISOString(),
    hostEpochMs: Date.now(),
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

function createTurnId(): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  return `turn_${stamp}_${Math.random().toString(36).slice(2, 8)}`;
}

async function callVmAgent(request: RemoteAgentRequest, signal?: AbortSignal): Promise<RemoteAgentPayload> {
  const timeoutMs = request.operation === "history" ? config.VM_AGENT_HISTORY_TIMEOUT_MS : 20_000;
  const historyKey = request.operation === "history"
    ? `${request.sessionId || "global"}:${request.after || 0}:${request.limit || 0}:${request.historyBefore || 0}`
    : undefined;
  const result = await runSshCommandWithInput("python", remoteAgentScript(request), timeoutMs, {
    lane: request.operation === "history" ? "history" : "interactive",
    queueDeadlineMs: request.operation === "history" ? (request.after ? 2_000 : 10_000) : 5_000,
    dedupeKey: historyKey,
    signal
  });
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const hostEpochMs = Date.now();
  if (!result.ok) {
    const error = result.error || result.stderr || "VM agent SSH call failed";
    return hostTiming({
      ok: false,
      error,
      raw: raw.slice(0, 500),
      messages: [],
      cursor: request.after || 0,
      bridgeError: result.errorCode === "VM_SSH_QUEUE_TIMEOUT" ? "queue" : /timed out/i.test(error) ? "timeout" : "ssh",
      retryable: true
    }, hostEpochMs);
  }
  try {
    return hostTiming(parseRemoteJson(raw), hostEpochMs);
  } catch (err) {
    return hostTiming({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      raw: raw.slice(0, 500),
      messages: [],
      cursor: request.after || 0,
      bridgeError: "invalid_response",
      retryable: true
    }, hostEpochMs);
  }
}

async function callVmAgentQuickStatus(): Promise<RemoteAgentPayload> {
  const result = await runSshCommandWithInputFast("python", quickStatusScript, 6_000, {
    lane: "status",
    queueDeadlineMs: 1_000,
    dedupeKey: "vm-agent-status"
  });
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const hostEpochMs = Date.now();
  if (!result.ok) {
    return hostTiming({ ok: false, error: result.error || result.stderr || "VM agent quick status SSH call failed", raw: raw.slice(0, 500), messages: [], cursor: 0 }, hostEpochMs);
  }
  try {
    return hostTiming(parseRemoteJson(raw), hostEpochMs);
  } catch (err) {
    return hostTiming({ ok: false, error: err instanceof Error ? err.message : String(err), raw: raw.slice(0, 500), messages: [], cursor: 0 }, hostEpochMs);
  }
}

export async function downloadVmRunArtifact(runId: string, artifactPath: string, signal?: AbortSignal): Promise<VmRunArtifactDownload> {
  const safe = validateVmArtifactRequest(runId, artifactPath);
  const stagedPath = `/tmp/sentaurus-web-artifact-${Date.now()}-${randomUUID().replace(/-/g, "")}`;
  const result = await runSshCommandWithInputDownload(
    "python",
    remoteArtifactScript(safe.runId, safe.artifactPath, stagedPath),
    stagedPath,
    maxVmArtifactBytes,
    90_000,
    {
      lane: "files",
      queueDeadlineMs: 20_000,
      dedupeKey: `artifact:${safe.runId}:${safe.artifactPath}`,
      signal
    }
  );
  if (!result.ok) {
    throw httpError(result.statusCode || 502, result.error || result.stderr || "VM artifact SSH download failed");
  }
  if (!result.data || !result.metadata) {
    throw httpError(502, "VM artifact download response was incomplete");
  }
  return {
    path: result.metadata.path,
    fileName: result.metadata.fileName,
    size: result.metadata.size,
    data: result.data
  };
}

export async function getVmAgentAgentsMd(signal?: AbortSignal): Promise<VmAgentAgentsMdResponse> {
  const result = await runSshCommandWithInput("python", remoteAgentsMdRequestScript("get"), 20_000, {
    lane: "files",
    queueDeadlineMs: 10_000,
    dedupeKey: "vm-agent-agents-md:get",
    signal
  });
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!result.ok) {
    throw httpError(502, result.error || result.stderr || "VM AGENTS.md read failed");
  }
  const payload = parseVmAgentAgentsMdPayload(raw);
  if (payload.ok === false) {
    throw httpError(payload.statusCode || 502, payload.error || "VM AGENTS.md read failed");
  }
  return {
    ok: true,
    path: payload.path || "~/.sentaurus-web-agent/vm-agent/AGENTS.md",
    exists: payload.exists === true,
    content: typeof payload.content === "string" ? payload.content : "",
    size: typeof payload.size === "number" && Number.isFinite(payload.size) ? payload.size : 0,
    updatedAt: payload.updatedAt,
    sha256: payload.sha256
  };
}

export async function saveVmAgentAgentsMd(content: string, signal?: AbortSignal): Promise<VmAgentAgentsMdResponse> {
  const normalized = typeof content === "string" ? content : "";
  if (Buffer.byteLength(normalized, "utf8") > maxVmAgentsMdBytes) {
    throw httpError(413, "AGENTS.md content exceeds the VM relay size limit");
  }
  const result = await runSshCommandWithInput("python", remoteAgentsMdRequestScript("put", normalized), 20_000, {
    lane: "files",
    queueDeadlineMs: 10_000,
    dedupeKey: `vm-agent-agents-md:put:${createHash("sha256").update(normalized, "utf8").digest("hex")}`,
    signal
  });
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!result.ok) {
    throw httpError(502, result.error || result.stderr || "VM AGENTS.md save failed");
  }
  const payload = parseVmAgentAgentsMdPayload(raw);
  if (payload.ok === false) {
    throw httpError(payload.statusCode || 502, payload.error || "VM AGENTS.md save failed");
  }
  return {
    ok: true,
    path: payload.path || "~/.sentaurus-web-agent/vm-agent/AGENTS.md",
    exists: payload.exists !== false,
    content: typeof payload.content === "string" ? payload.content : normalized,
    size: typeof payload.size === "number" && Number.isFinite(payload.size) ? payload.size : Buffer.byteLength(normalized, "utf8"),
    updatedAt: payload.updatedAt,
    sha256: payload.sha256
  };
}

export async function getVmAgentStatus(): Promise<VmAgentStatus> {
  const payload = await callVmAgentQuickStatus();
  return payload.ok === false ? errorStatus(payload.error || "VM agent status check failed", payload.raw) : toStatus(payload);
}

export async function connectVmAgent(signal?: AbortSignal): Promise<{ status: VmAgentStatus; messages: VmAgentMessage[]; message?: VmAgentMessage; cursor: number }> {
  const payload = await callVmAgent({ operation: "start", includeFolded: true, protocolVersion: 2 }, signal);
  const status = payload.ok === false ? errorStatus(payload.error || "VM agent connect failed", payload.raw) : toStatus(payload);
  const messages = normalizeMessages(payload.messages, payload);
  return { status, messages, message: messages.find((item) => item.role === "agent"), cursor: payload.cursor || 0 };
}

function vmAgentModelsResponse(status: VmAgentStatus): VmAgentModelsResponse {
  const currentModel: VmAgentModelId = isVmAgentModelId(status.llmModel) ? status.llmModel : "gpt-5.5";
  return {
    ok: status.ok,
    currentModel,
    activeModels: (status.llmModels || [currentModel]).filter(isVmAgentModelId),
    reasoningEffort: VM_AGENT_REASONING_EFFORT,
    contextWindowTokens: vmAgentContextWindowTokens(currentModel),
    models: vmAgentModelCatalog(),
    status
  };
}

export async function getVmAgentModels(): Promise<VmAgentModelsResponse> {
  return vmAgentModelsResponse(await getVmAgentStatus());
}

async function writeVmAgentModelConfig(model: VmAgentModelId, signal?: AbortSignal): Promise<void> {
  const result = await runSshCommandWithInput("python", remoteVmAgentModelConfigScript(model), 20_000, {
    lane: "interactive",
    queueDeadlineMs: 10_000,
    dedupeKey: `vm-agent-model:${model}`,
    signal
  });
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!result.ok) throw httpError(502, result.error || result.stderr || "VM model configuration failed");
  const jsonLine = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse()
    .find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) throw httpError(502, `VM model configuration returned invalid output: ${raw.slice(0, 300)}`);
  const payload = JSON.parse(jsonLine) as { ok?: boolean; model?: string; error?: string };
  if (payload.ok !== true || payload.model !== model) {
    throw httpError(502, payload.error || "VM model configuration was not applied");
  }
}

export async function setVmAgentModel(modelValue: unknown, signal?: AbortSignal): Promise<VmAgentModelsResponse> {
  const model = parseVmAgentModelId(modelValue);
  await writeVmAgentModelConfig(model, signal);
  const connected = await connectVmAgent(signal);
  if (!connected.status.ok || connected.status.llmModel !== model) {
    throw httpError(502, connected.status.error || `VM worker restarted but did not activate ${model}`);
  }
  return vmAgentModelsResponse(connected.status);
}

let lastKnownHistoryCursor = 0;

export async function getVmAgentMessages(after = 0, limit = 50, sessionId?: string, signal?: AbortSignal): Promise<{
  status: VmAgentStatus;
  messages: VmAgentMessage[];
  cursor: number;
  truncated?: boolean;
  continuation?: string;
  rawCount?: number;
  compactedCount?: number;
  payloadBytes?: number;
  historyCompacted?: boolean;
  transportCompressedBytes?: number;
  transportUncompressedBytes?: number;
}> {
  const payload = await callVmAgent({
    operation: "history",
    after,
    limit,
    sessionId,
    includeFolded: true,
    protocolVersion: 2,
    responseByteBudget: config.VM_AGENT_HISTORY_MAX_RESPONSE_BYTES
  }, signal);
  if (payload.ok === false) {
    const status = errorStatus(payload.error || "VM agent history failed", payload.raw);
    const queueTimedOut = payload.bridgeError === "queue";
    const timedOut = payload.bridgeError === "timeout" || /timed out/i.test(payload.error || "");
    const cursor = Math.max(after, lastKnownHistoryCursor, typeof payload.cursor === "number" ? payload.cursor : 0);
    throw new VmAgentHistoryError(
      queueTimedOut ? "VM_SSH_QUEUE_TIMEOUT" : timedOut ? "VM_HISTORY_TIMEOUT" : "VM_HISTORY_BRIDGE_FAILED",
      payload.error || "VM agent history failed",
      queueTimedOut ? 503 : timedOut ? 504 : 502,
      cursor,
      status,
      payload.retryable !== false
    );
  }
  const status = toStatus(payload);
  const messages = normalizeMessages(payload.messages, payload);
  const shapedMessages = after === 0 && sessionId && payload.historyCompacted !== true
    ? compactSessionHistory(messages)
    : messages;
  const cursor = typeof payload.cursor === "number" ? payload.cursor : after;
  lastKnownHistoryCursor = Math.max(lastKnownHistoryCursor, cursor);
  return {
    status,
    messages: shapedMessages,
    cursor,
    truncated: payload.truncated,
    continuation: payload.continuation,
    rawCount: payload.rawCount,
    compactedCount: payload.compactedCount,
    payloadBytes: payload.payloadBytes,
    historyCompacted: payload.historyCompacted,
    transportCompressedBytes: payload.transportCompressedBytes,
    transportUncompressedBytes: payload.transportUncompressedBytes
  };
}

export async function sendVmAgentMessage(message: string, sessionId?: string, attachments: VmAgentAttachmentRef[] = [], displayAttachments: VmAgentMessageAttachment[] = []): Promise<{ status: VmAgentStatus; message: VmAgentMessage; messages: VmAgentMessage[]; cursor: number }> {
  const enrichedAttachments = await enrichAttachmentsForVm(attachments);
  const turnId = createTurnId();
  const payload = await callVmAgent({ operation: "send", message, sessionId, turnId, includeFolded: true, protocolVersion: 2, attachments: enrichedAttachments, displayAttachments });
  const status = payload.ok === false ? errorStatus(payload.error || "VM agent message failed", payload.raw) : toStatus(payload);
  const messages = normalizeMessages(payload.messages, payload);
  const representative = [...messages].reverse().find((item) => item.role === "agent") || messages[0] || fallbackAgentMessage("Message queued for the CentOS VM agent.");
  return { status, message: representative, messages, cursor: payload.cursor || 0 };
}
