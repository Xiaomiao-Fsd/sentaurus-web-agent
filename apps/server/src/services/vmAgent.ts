import type { VmAgentMessage, VmAgentStatus } from "@sentaurus-agent/shared";
import { config } from "../config.js";
import { safeRelativePath, safeRunId } from "../security/pathSafe.js";
import { runSshCommandWithInput } from "./sshClient.js";

type VmAgentOperation = "status" | "start" | "send" | "history";

type RemoteAgentRequest = {
  operation: VmAgentOperation;
  message?: string;
  sessionId?: string;
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
  llmModel?: string;
  llmModels?: string[];
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
  raw?: string;
};

const agentName = "sentaurus-vm-agent";
const agentVersion = "0.4.6";
const maxVmArtifactBytes = 50 * 1024 * 1024;
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
  ".json",
  ".cmd",
  ".des",
  ".par",
  ".scm",
  ".tcl",
  ".bnd",
  ".sat"
]);

type VmRunArtifactDownload = {
  path: string;
  fileName: string;
  size: number;
  data: Buffer;
};

const remoteWorkerScript = String.raw`# -*- coding: utf-8 -*-
import datetime
import glob
import getpass
import json
import os
import re
import signal
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
AGENT_VERSION = "0.4.6"
HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".sentaurus-web-agent", "vm-agent")
QUEUE_DIR = os.path.join(ROOT, "queue")
DONE_DIR = os.path.join(ROOT, "processed")
MESSAGES_PATH = os.path.join(ROOT, "messages.jsonl")
AUDIT_PATH = os.path.join(ROOT, "audit.jsonl")
HEARTBEAT_PATH = os.path.join(ROOT, "worker.heartbeat")
CONFIG_PATH = os.path.join(ROOT, "config.json")
ENV_PATH = os.path.join(ROOT, ".env")
MANUALS_DIR = os.path.join(ROOT, "manuals")
LLM_HARD_TIMEOUT_SECONDS = 120

class HardTimeout(Exception):
    pass
RUNS_DIR = os.path.join(HOME, "STDB", "web-agent-runs")
SESSION_OUTPUT_ROOT = os.path.join(HOME, "STDB", "web-agent-sessions")
OUTPUT_CATEGORY_INPUT = u"我的输入"
OUTPUT_CATEGORY_RESULTS = u"仿真结果文件"
OUTPUT_CATEGORY_LOGS = u"仿真日志文件"
OUTPUT_CATEGORY_PARAMS = u"仿真参数文件"
OUTPUT_CATEGORY_OTHER = u"其它文件"
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

def run_with_timeout(seconds, label, fn, *args):
    if not hasattr(signal, "SIGALRM") or seconds <= 0:
        return fn(*args)
    def timeout_handler(signum, frame):
        raise HardTimeout("%s timed out after %ss" % (label, seconds))
    previous_handler = signal.signal(signal.SIGALRM, timeout_handler)
    signal.alarm(seconds)
    try:
        return fn(*args)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_handler)

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

def append_progress(session_id, stage, status, detail, progress=None, run_id=""):
    meta = {
        "kind": "progress",
        "sessionId": safe_text(session_id, 160),
        "progressStage": safe_text(stage, 80),
        "progressStatus": safe_text(status, 40),
        "progressDetail": safe_text(detail, 500),
    }
    if progress is not None:
        try:
            meta["progress"] = max(0, min(100, int(progress)))
        except Exception:
            pass
    if run_id:
        meta["runId"] = safe_text(run_id, 180)
    content = "Progress: %s %s - %s" % (stage, status, detail)
    return append_message("system", content, "vm-agent-progress", meta, "progress")

def read_all_messages():
    messages = []
    if not os.path.exists(MESSAGES_PATH):
        return messages
    with open(MESSAGES_PATH, "r") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                messages.append(json.loads(line))
            except Exception:
                pass
    return messages

def session_context(session_id, current_id="", limit=12, content_limit=900):
    session_id = safe_text(session_id, 160).strip()
    current_id = safe_text(current_id, 200).strip()
    if not session_id:
        return "(no browser session id provided)"
    messages = []
    for item in read_all_messages():
        meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
        if safe_text(meta.get("sessionId"), 160).strip() != session_id:
            continue
        if current_id and item.get("id") == current_id:
            continue
        messages.append(item)
    if not messages:
        return "(no earlier messages in this browser session)"
    lines = []
    for item in messages[-limit:]:
        meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
        content = safe_text(item.get("content"), content_limit).replace("\n", " | ")
        header = "[%s] %s kind=%s" % (item.get("createdAt") or "unknown-time", item.get("role") or "unknown-role", meta.get("kind") or "unknown")
        if meta.get("runId"):
            header += " runId=%s" % meta.get("runId")
        if meta.get("runStatus"):
            header += " runStatus=%s" % meta.get("runStatus")
        lines.append(header + ": " + content)
    return "\n".join(lines)

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
    models = config_list(configured_models)
    primary = safe_text(primary_model, 160).strip()
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
    raw_models = env.get("LLM_MODELS") or file_config.get("llmModels") or file_config.get("LLM_MODELS")
    return {
        "api_base": env.get("LLM_API_BASE") or file_config.get("llmApiBase") or file_config.get("LLM_API_BASE") or "",
        "api_key": env.get("LLM_API_KEY") or file_config.get("llmApiKey") or file_config.get("LLM_API_KEY") or "",
        "model": primary_model,
        "models": model_candidates(primary_model, raw_models),
        "api_style": env.get("LLM_API_STYLE") or file_config.get("llmApiStyle") or file_config.get("LLM_API_STYLE") or "chat-completions",
        "max_autodebug_attempts": config_int(env, file_config, "VM_AGENT_MAX_AUTODEBUG_ATTEMPTS", "vmAgentMaxAutodebugAttempts", 5, 1, 8),
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

def safe_file_name(name):
    name = safe_text(name, 180).strip()
    if not name or os.path.basename(name) != name or name.startswith(".") or ".." in name:
        raise ValueError("invalid file name: %s" % name)
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._@()+,-]{0,159}$", name):
        raise ValueError("file name contains unsupported characters: %s" % name)
    return name

def safe_run_slug(text):
    text = safe_text(text, 80).lower()
    text = re.sub(r"[^a-z0-9_-]+", "-", text).strip("-")
    return text[:48] or "sentaurus-job"

def write_utf8(path, text):
    ensure_dir(os.path.dirname(path))
    if isinstance(text, unicode) if sys.version_info[0] < 3 else False:
        raw = text.encode("utf-8")
    else:
        try:
            raw = text.encode("utf-8")
        except AttributeError:
            raw = text
    with open(path, "wb") as handle:
        handle.write(raw)

def read_file_tail(path, limit=1800):
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - limit))
            raw = handle.read(limit)
    except Exception:
        return ""
    try:
        return raw.decode("utf-8", "replace")
    except AttributeError:
        return raw

def sentaurus_command_for_step(tool, entry):
    tools = sentaurus_tools()
    path = tools.get(tool)
    if not path:
        raise ValueError("Sentaurus tool not found in PATH: %s" % tool)
    if tool == "sde":
        return [path, "-e", "-l", entry]
    if tool == "sprocess":
        return [path, "-b", entry]
    if tool == "sdevice":
        return [path, entry]
    if tool == "inspect":
        return [path, "-batch", "-f", entry]
    raise ValueError("unsupported Sentaurus runner tool: %s" % tool)

def run_step(run_dir, step, index, timeout_seconds=1800):
    tool = safe_text(step.get("tool"), 40).strip().lower()
    entry = safe_file_name(step.get("input") or step.get("entry") or step.get("entryFile"))
    if tool not in ["sde", "sprocess", "sdevice", "inspect"]:
        raise ValueError("unsupported runner tool: %s" % tool)
    entry_path = os.path.join(run_dir, entry)
    if not os.path.exists(entry_path):
        raise ValueError("runner entry file does not exist: %s" % entry)
    log_base = "%02d_%s_%s" % (index, tool, os.path.splitext(entry)[0])
    stdout_path = os.path.join(run_dir, "logs", log_base + ".out")
    stderr_path = os.path.join(run_dir, "logs", log_base + ".err")
    args = sentaurus_command_for_step(tool, entry)
    started = time.time()
    out = open(stdout_path, "wb")
    err = open(stderr_path, "wb")
    try:
        proc = subprocess.Popen(args, cwd=run_dir, stdout=out, stderr=err)
        while proc.poll() is None:
            if time.time() - started > timeout_seconds:
                try:
                    proc.kill()
                except Exception:
                    pass
                return {
                    "tool": tool,
                    "input": entry,
                    "exitCode": -1,
                    "timedOut": True,
                    "seconds": int(time.time() - started),
                    "stdout": os.path.relpath(stdout_path, run_dir),
                    "stderr": os.path.relpath(stderr_path, run_dir),
                    "stdoutTail": read_file_tail(stdout_path),
                    "stderrTail": read_file_tail(stderr_path),
                }
            time.sleep(0.5)
        exit_code = proc.returncode
    finally:
        out.close()
        err.close()
    return {
        "tool": tool,
        "input": entry,
        "exitCode": exit_code,
        "timedOut": False,
        "seconds": int(time.time() - started),
        "stdout": os.path.relpath(stdout_path, run_dir),
        "stderr": os.path.relpath(stderr_path, run_dir),
        "stdoutTail": read_file_tail(stdout_path),
        "stderrTail": read_file_tail(stderr_path),
    }

def collect_run_artifacts(run_dir, limit=80):
    allowed = set([".log", ".out", ".err", ".plt", ".tdr", ".grd", ".dat", ".csv", ".txt", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".json", ".cmd", ".des", ".par", ".scm", ".tcl", ".bnd", ".sat", ".md", ".rst", ".sde"])
    artifacts = []
    for root, _dirs, files in os.walk(run_dir):
        for name in files:
            if name.startswith("."):
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in allowed:
                continue
            path = os.path.join(root, name)
            try:
                size = os.path.getsize(path)
            except Exception:
                size = 0
            artifacts.append({"path": os.path.relpath(path, run_dir), "size": size})
    artifacts.sort(key=lambda item: item.get("path"))
    return artifacts[:limit]

def output_category_for_artifact(rel_path):
    lowered = safe_text(rel_path, 400).replace("\\", "/").lower()
    name = os.path.basename(lowered)
    ext = os.path.splitext(name)[1]
    if lowered.startswith("logs/") or ext in [".log", ".out", ".err"] or name in ["run_result.json"]:
        return OUTPUT_CATEGORY_LOGS
    if ext in [".cmd", ".des", ".par", ".scm", ".tcl", ".sde"] or name in ["run_request.json", "setup.json"]:
        return OUTPUT_CATEGORY_PARAMS
    if ext in [".plt", ".tdr", ".grd", ".dat", ".csv", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bnd", ".sat"]:
        return OUTPUT_CATEGORY_RESULTS
    return OUTPUT_CATEGORY_OTHER

def safe_artifact_rel_parts(rel_path):
    parts = safe_text(rel_path, 500).replace("\\", "/").split("/")
    clean = []
    for part in parts:
        if not part:
            continue
        clean.append(safe_file_name(part))
    if not clean:
        raise ValueError("empty artifact path")
    return clean

def sync_run_artifacts_to_session_output(session_id, run_id, run_dir, artifacts):
    session_id = safe_text(session_id, 180).strip()
    run_id = safe_text(run_id, 180).strip()
    if not session_id or not re.match(r"^run_[A-Za-z0-9_-]+$", session_id):
        return 0
    synced = 0
    root = os.path.abspath(os.path.join(SESSION_OUTPUT_ROOT, session_id, "output"))
    for category in [OUTPUT_CATEGORY_INPUT, OUTPUT_CATEGORY_RESULTS, OUTPUT_CATEGORY_LOGS, OUTPUT_CATEGORY_PARAMS, OUTPUT_CATEGORY_OTHER]:
        ensure_dir(os.path.join(root, category))
    for item in artifacts or []:
        rel_path = safe_text(item.get("path"), 500).replace("\\", "/")
        try:
            parts = safe_artifact_rel_parts(rel_path)
            source = os.path.abspath(os.path.join(run_dir, *parts))
            run_base = os.path.abspath(run_dir)
            if source != run_base and not source.startswith(run_base + os.sep):
                continue
            if not os.path.isfile(source):
                continue
            category = output_category_for_artifact(rel_path)
            dest = os.path.abspath(os.path.join(root, category, safe_file_name(run_id), *parts))
            category_base = os.path.abspath(os.path.join(root, category))
            if dest != category_base and not dest.startswith(category_base + os.sep):
                continue
            ensure_dir(os.path.dirname(dest))
            shutil.copy2(source, dest)
            synced += 1
        except Exception as exc:
            audit("session_output_sync_skipped", {"sessionId": session_id, "runId": run_id, "path": rel_path, "error": safe_text(str(exc), 400)})
    if synced:
        audit("session_output_synced", {"sessionId": session_id, "runId": run_id, "count": synced})
    return synced

def sync_session_setup_to_output(session_id, setup):
    session_id = safe_text(session_id, 180).strip()
    if not session_id or not setup or not re.match(r"^run_[A-Za-z0-9_-]+$", session_id):
        return
    try:
        root = os.path.abspath(os.path.join(SESSION_OUTPUT_ROOT, session_id, "output", OUTPUT_CATEGORY_PARAMS))
        ensure_dir(root)
        target = os.path.abspath(os.path.join(root, "setup.json"))
        if not target.startswith(root + os.sep):
            return
        write_utf8(target, json.dumps(setup, ensure_ascii=True, indent=2, sort_keys=True) + "\n")
        audit("session_setup_synced", {"sessionId": session_id})
    except Exception as exc:
        audit("session_setup_sync_failed", {"sessionId": session_id, "error": safe_text(str(exc), 400)})

def extract_run_request(reply):
    start_tag = "<SENTAURUS_RUN_REQUEST>"
    end_tag = "</SENTAURUS_RUN_REQUEST>"
    start = reply.find(start_tag)
    end = reply.find(end_tag, start + len(start_tag)) if start >= 0 else -1
    if start < 0 or end < 0:
        return None, reply
    body = reply[start + len(start_tag):end].strip()
    visible = (reply[:start] + reply[end + len(end_tag):]).strip()
    request = json.loads(body)
    if not isinstance(request, dict):
        raise ValueError("run request must be a JSON object")
    return request, visible

def run_request_file_count(run_request):
    if not isinstance(run_request, dict):
        return 0
    files = run_request.get("files")
    if not isinstance(files, list):
        return 0
    return len([item for item in files if isinstance(item, dict) and safe_text(item.get("content"), 200).strip()])

def sentaurus_tool_steps(run_request):
    if not isinstance(run_request, dict):
        return []
    steps = run_request.get("steps")
    if not isinstance(steps, list):
        return []
    allowed = set(["sde", "sprocess", "sdevice", "inspect"])
    result = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        tool = safe_text(step.get("tool"), 40).strip().lower()
        entry = safe_text(step.get("input") or step.get("entry") or step.get("entryFile"), 180).strip()
        if tool in allowed and entry:
            result.append({"tool": tool, "input": entry})
    return result

def run_request_validation_error(run_request, visible_reply, user_text):
    if not run_request:
        return ""
    file_count = run_request_file_count(run_request)
    steps = sentaurus_tool_steps(run_request)
    if file_count == 0:
        return "Run request contains no complete input file content."
    if not steps:
        return "Run request contains no executable Sentaurus tool step."
    raw = (safe_text(visible_reply, 3000) + "\n" + safe_text(user_text, 3000)).lower()
    continuation_markers = [
        "next step", "continue", "then run", "then execute", "after that", "will run",
        u"\u9700\u8981\u540e\u7eed", u"\u4e0b\u4e00\u6b65", u"\u7ee7\u7eed",
        u"\u518d\u8fd0\u884c", u"\u7136\u540e\u8fd0\u884c", u"\u968f\u540e\u8fd0\u884c", u"\u540e\u7eed\u6267\u884c",
    ]
    final_markers = [
        "extract", "curve", "result", "plot",
        u"\u8f93\u51fa", u"\u7ed3\u679c", u"\u66f2\u7ebf", u"\u63d0\u53d6",
    ]
    has_continuation = any(marker in raw for marker in continuation_markers)
    asks_for_final = any(marker in raw for marker in final_markers)
    tools = [step.get("tool") for step in steps]
    if has_continuation and asks_for_final and "sdevice" not in tools and "inspect" not in tools:
        return "Run request appears incomplete: it promises later simulation/result extraction but only includes early setup steps."
    return ""

def format_validation_rejection(error_text, visible_reply):
    lines = []
    if visible_reply:
        lines.append(safe_text(visible_reply, 1600))
        lines.append("")
    lines.append("I did not start Sentaurus because the generated run request was incomplete.")
    lines.append("- validation: %s" % safe_text(error_text, 500))
    lines.append("- next step: provide the missing deck/files/assumptions, or ask me to create a complete self-contained SDE/SDevice/Inspect flow.")
    return "\n".join(lines)

def repair_run_request_reply(user_text, original_reply, validation_error, session_id="", current_message_id=""):
    config = load_config()
    if not llm_configured(config):
        return None, {"kind": "run_request_validation_error", "llmConfigured": False}
    repair_prompt = "\n".join([
        "Repair your previous Sentaurus response before it reaches the allowlisted runner.",
        "",
        "Validation error:",
        safe_text(validation_error, 1000),
        "",
        "User request:",
        safe_text(user_text, 3000),
        "",
        "Previous response:",
        safe_text(original_reply, 12000),
        "",
        "Return a concise corrected answer.",
        "If you can produce a complete self-contained executable flow, include exactly one complete <SENTAURUS_RUN_REQUEST> JSON block with every file content and all required steps.",
        "If the flow still needs missing files, geometry, bias, or physics assumptions, do not include any run request; ask for the missing information instead.",
        "Do not promise to run later steps unless they are included in the run request.",
    ])
    try:
        reply, meta = run_with_timeout(LLM_HARD_TIMEOUT_SECONDS, "VM agent run-request repair", call_llm, repair_prompt, config, session_id, current_message_id)
        meta["kind"] = "llm"
        meta["runRequestRepair"] = True
        return reply, meta
    except Exception as exc:
        return None, {"kind": "run_request_validation_error", "llmConfigured": True, "error": safe_text(str(exc), 1000)}

def extract_json_tag(reply, tag_name):
    start_tag = "<%s>" % tag_name
    end_tag = "</%s>" % tag_name
    start = reply.find(start_tag)
    end = reply.find(end_tag, start + len(start_tag)) if start >= 0 else -1
    if start < 0 or end < 0:
        return None, reply
    body = reply[start + len(start_tag):end].strip()
    visible = (reply[:start] + reply[end + len(end_tag):]).strip()
    value = json.loads(body)
    if not isinstance(value, dict):
        raise ValueError("%s must be a JSON object" % tag_name)
    return value, visible

def setup_text(value, limit=500):
    text = safe_text(value, limit).strip()
    return text or None

def normalize_simulation_setup(value):
    setup = {}
    for key in ["deviceType", "gateBias", "drainBias", "sourceBulk", "geometry", "dopingOrImplant", "physicsModels", "mesh", "temperature", "notes"]:
        item = setup_text(value.get(key), 500)
        if item:
            setup[key] = item
    goals = setup_text(value.get("simulationGoals"), 800)
    if goals:
        setup["simulationGoals"] = goals
    outputs = value.get("expectedOutputs")
    if isinstance(outputs, list):
        clean_outputs = []
        for item in outputs[:24]:
            text = setup_text(item, 220)
            if text:
                clean_outputs.append(text)
        if clean_outputs:
            setup["expectedOutputs"] = clean_outputs
    setup["updatedAt"] = setup_text(value.get("updatedAt"), 80) or now_iso()
    setup["updatedBy"] = "vm-agent"
    return setup

def setup_from_run_request(request):
    files = request.get("files") or []
    steps = request.get("steps") or []
    file_names = []
    for item in files[:12]:
        if isinstance(item, dict):
            name = setup_text(item.get("name"), 120)
            if name:
                file_names.append(name)
    step_names = []
    for item in steps[:8]:
        if isinstance(item, dict):
            tool = setup_text(item.get("tool"), 40) or "sentaurus"
            entry = setup_text(item.get("input") or item.get("entry") or item.get("entryFile"), 120) or "input"
            step_names.append("%s %s" % (tool, entry))
    setup = {
        "deviceType": setup_text(request.get("deviceType") or request.get("title"), 180) or "Sentaurus TCAD task",
        "simulationGoals": setup_text(request.get("goal") or request.get("objective") or request.get("title"), 800) or "Run the allowlisted Sentaurus deck and collect generated outputs.",
        "expectedOutputs": [
            "Sentaurus stdout/stderr logs",
            "run_result.json manifest",
            "Generated .plt/.tdr/.csv/.png artifacts when produced by the deck",
        ],
        "notes": "Derived from the VM run request%s%s." % (
            " with files: " + ", ".join(file_names) if file_names else "",
            " and steps: " + "; ".join(step_names) if step_names else "",
        ),
        "updatedAt": now_iso(),
        "updatedBy": "vm-agent",
    }
    for key in ["gateBias", "drainBias", "sourceBulk", "geometry", "dopingOrImplant", "physicsModels", "mesh", "temperature"]:
        value = setup_text(request.get(key), 500)
        if value:
            setup[key] = value
    return setup

def execute_run_request(request, session_id=""):
    ensure_dir(RUNS_DIR)
    title = safe_text(request.get("title") or session_id or "sentaurus-job", 120)
    run_id = "run_%s_%s_%s" % (datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"), safe_run_slug(title), uuid.uuid4().hex[:6])
    run_dir = os.path.join(RUNS_DIR, run_id)
    if not os.path.abspath(run_dir).startswith(os.path.abspath(RUNS_DIR) + os.sep):
        raise ValueError("refusing unsafe run directory")
    ensure_dir(run_dir)
    ensure_dir(os.path.join(run_dir, "logs"))
    ensure_dir(os.path.join(run_dir, "artifacts"))
    files = request.get("files") or []
    if not isinstance(files, list) or not files:
        raise ValueError("run request requires a non-empty files array")
    if len(files) > 30:
        raise ValueError("run request has too many files")
    total_chars = 0
    allowed_ext = set([".cmd", ".des", ".par", ".scm", ".tcl", ".txt", ".dat"])
    written = []
    for file_item in files:
        if not isinstance(file_item, dict):
            raise ValueError("each run file must be an object")
        name = safe_file_name(file_item.get("name"))
        ext = os.path.splitext(name)[1].lower()
        if ext not in allowed_ext:
            raise ValueError("unsupported run file extension: %s" % name)
        content = safe_text(file_item.get("content"), 240000)
        total_chars += len(content)
        if total_chars > 600000:
            raise ValueError("run request files are too large")
        write_utf8(os.path.join(run_dir, name), content)
        written.append(name)
    steps = request.get("steps") or []
    if not isinstance(steps, list) or not steps:
        tool = safe_text(request.get("tool"), 40).strip().lower()
        entry = request.get("entryFile") or request.get("input")
        if tool and entry:
            steps = [{"tool": tool, "input": entry}]
    if not isinstance(steps, list) or not steps:
        raise ValueError("run request requires steps or tool+entryFile")
    if len(steps) > 8:
        raise ValueError("run request has too many steps")
    manifest = {
        "id": run_id,
        "title": title,
        "createdAt": now_iso(),
        "sessionId": session_id,
        "files": written,
        "steps": steps,
        "status": "running",
    }
    write_utf8(os.path.join(run_dir, "run_request.json"), json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True) + "\n")
    audit("sentaurus_run_started", {"runId": run_id, "title": title, "sessionId": session_id})
    append_progress(session_id, "runner_prepare", "completed", "Prepared run directory %s with %s file(s)" % (run_id, len(written)), 50, run_id)
    step_results = []
    ok = True
    step_count = max(1, len(steps))
    for index, step in enumerate(steps, 1):
        tool = safe_text(step.get("tool"), 40).strip().lower()
        entry = safe_file_name(step.get("input") or step.get("entry") or step.get("entryFile"))
        step_start_progress = 55 + int(((index - 1) / float(step_count)) * 35)
        append_progress(session_id, "sentaurus_step", "running", "Step %s/%s: %s %s" % (index, step_count, tool, entry), step_start_progress, run_id)
        result = run_step(run_dir, step, index)
        step_results.append(result)
        if result.get("exitCode") != 0:
            ok = False
            append_progress(session_id, "sentaurus_step", "failed", "Step %s/%s: %s %s exit %s" % (index, step_count, result.get("tool"), result.get("input"), result.get("exitCode")), step_start_progress, run_id)
            break
        append_progress(session_id, "sentaurus_step", "completed", "Step %s/%s: %s %s exit 0 in %ss" % (index, step_count, result.get("tool"), result.get("input"), result.get("seconds")), min(95, step_start_progress + max(1, int(35 / float(step_count)))), run_id)
    manifest["status"] = "succeeded" if ok else "failed"
    manifest["finishedAt"] = now_iso()
    manifest["stepResults"] = step_results
    artifacts = collect_run_artifacts(run_dir)
    manifest["artifacts"] = artifacts
    write_utf8(os.path.join(run_dir, "run_result.json"), json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True) + "\n")
    artifacts = collect_run_artifacts(run_dir)
    manifest["artifacts"] = artifacts
    manifest["sessionOutputSyncedCount"] = sync_run_artifacts_to_session_output(session_id, run_id, run_dir, artifacts)
    write_utf8(os.path.join(run_dir, "run_result.json"), json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True) + "\n")
    sync_run_artifacts_to_session_output(session_id, run_id, run_dir, [{"path": "run_result.json", "size": 0}])
    audit("sentaurus_run_finished", {"runId": run_id, "ok": ok, "steps": step_results})
    append_progress(session_id, "artifacts", "completed" if ok else "failed", "Collected %s artifact/log file(s)" % len(artifacts), 100 if ok else 95, run_id)
    return manifest

def format_run_result(result):
    lines = []
    ok = result.get("status") == "succeeded"
    lines.append("Sentaurus simulation completed." if ok else "Sentaurus simulation finished with errors.")
    lines.append("The VM agent has finished the allowlisted run and this is the final result notification.")
    lines.append("- run id: %s" % result.get("id"))
    lines.append("- status: %s" % result.get("status"))
    lines.append("- VM directory: %s" % os.path.join(RUNS_DIR, result.get("id")))
    lines.append("- steps:")
    for step in result.get("stepResults") or []:
        lines.append("  - %s %s -> exit %s in %ss" % (step.get("tool"), step.get("input"), step.get("exitCode"), step.get("seconds")))
        if step.get("stderrTail") and step.get("exitCode") != 0:
            lines.append("    stderr tail: %s" % safe_text(step.get("stderrTail").replace("\n", " | "), 500))
    artifacts = result.get("artifacts") or []
    lines.append("- artifacts/logs: %s file(s)" % len(artifacts))
    for item in artifacts[:18]:
        lines.append("  - %s (%s bytes)" % (item.get("path"), item.get("size")))
    if len(artifacts) > 18:
        lines.append("  - ... %s more" % (len(artifacts) - 18))
    return "\n".join(lines)

def run_dir_for_result(result):
    run_id = safe_text(result.get("id"), 180).strip()
    return os.path.join(RUNS_DIR, run_id) if run_id else ""

def first_failed_step(result):
    for step in result.get("stepResults") or []:
        if step.get("timedOut") or step.get("exitCode") != 0:
            return step
    return None

def safe_read_run_file(result, rel_path, limit=8000):
    run_dir = os.path.abspath(run_dir_for_result(result))
    rel_path = safe_text(rel_path, 240).strip().replace("\\", "/")
    if not run_dir or not rel_path or os.path.isabs(rel_path) or ".." in rel_path.split("/"):
        return ""
    target = os.path.abspath(os.path.join(run_dir, rel_path))
    if target != run_dir and not target.startswith(run_dir + os.sep):
        return ""
    return read_file_tail(target, limit)

def request_file_content(run_request, name, limit=8000):
    name = safe_text(name, 180).strip()
    for item in run_request.get("files") or []:
        if isinstance(item, dict) and safe_text(item.get("name"), 180).strip() == name:
            return safe_text(item.get("content"), limit)
    return ""

def step_diagnostic(step):
    if not step:
        return "no failed step recorded"
    parts = [
        "%s %s" % (step.get("tool"), step.get("input")),
        "exit %s" % step.get("exitCode"),
    ]
    if step.get("timedOut"):
        parts.append("timed out")
    if step.get("stderrTail"):
        parts.append("stderr: %s" % safe_text(step.get("stderrTail").replace("\n", " | "), 500))
    elif step.get("stdoutTail"):
        parts.append("stdout: %s" % safe_text(step.get("stdoutTail").replace("\n", " | "), 500))
    return "; ".join(parts)

def attempt_summary_line(result):
    attempt = result.get("autoDebugAttempt") or "?"
    failed = first_failed_step(result)
    suffix = " ok" if result.get("status") == "succeeded" else " failed: " + step_diagnostic(failed)
    return "attempt %s run %s status %s%s" % (attempt, result.get("id"), result.get("status"), suffix)

def attempts_meta(attempts):
    items = []
    for result in attempts:
        failed = first_failed_step(result)
        failed_item = None
        if failed:
            failed_item = {
                "tool": failed.get("tool"),
                "input": failed.get("input"),
                "exitCode": failed.get("exitCode"),
                "timedOut": bool(failed.get("timedOut")),
                "stderrTail": safe_text((failed.get("stderrTail") or "").replace("\n", " | "), 500),
            }
        items.append({
            "attempt": result.get("autoDebugAttempt"),
            "runId": result.get("id"),
            "status": result.get("status"),
            "failedStep": failed_item,
            "artifacts": result.get("artifacts") or [],
        })
    return items

def is_recoverable_run_failure(result):
    if result.get("status") != "failed":
        return False
    failed = first_failed_step(result)
    if not failed:
        return False
    text = ("%s\n%s" % (failed.get("stderrTail") or "", failed.get("stdoutTail") or "")).lower()
    nonrecoverable = [
        "license",
        "no space left",
        "disk quota",
        "permission denied",
        "operation not permitted",
        "command not found",
        "not found in path",
        "sentaurus tool not found",
        "killed",
    ]
    return not any(marker in text for marker in nonrecoverable)

def build_repair_prompt(original_user_text, previous_run_request, result, attempts):
    failed = first_failed_step(result)
    failed_input = safe_text(failed.get("input"), 180).strip() if failed else ""
    failed_deck = safe_read_run_file(result, failed_input, 12000) if failed_input else ""
    if not failed_deck and failed_input:
        failed_deck = request_file_content(previous_run_request, failed_input, 12000)
    artifacts = result.get("artifacts") or []
    artifact_lines = []
    for item in artifacts[:40]:
        artifact_lines.append("- %s (%s bytes)" % (item.get("path"), item.get("size")))
    history_lines = [attempt_summary_line(item) for item in attempts]
    lines = [
        "Auto-debug a failed Sentaurus allowlisted runner attempt and produce a corrected run request.",
        "",
        "Original user request:",
        safe_text(original_user_text, 3000),
        "",
        "Attempt history:",
        "\n".join(history_lines) or "none",
        "",
        "Failed attempt:",
        "- run id: %s" % result.get("id"),
        "- status: %s" % result.get("status"),
        "- VM directory: %s" % run_dir_for_result(result),
        "- failed step: %s" % step_diagnostic(failed),
        "",
        "Previous run request JSON:",
        safe_text(json.dumps(previous_run_request, ensure_ascii=True, indent=2, sort_keys=True), 16000),
        "",
        "Failed input deck content (%s):" % (failed_input or "unknown"),
        safe_text(failed_deck, 12000) or "(not readable)",
        "",
        "Failed step stdout tail:",
        safe_text((failed or {}).get("stdoutTail"), 3000) or "(empty)",
        "",
        "Failed step stderr tail:",
        safe_text((failed or {}).get("stderrTail"), 5000) or "(empty)",
        "",
        "Generated artifacts/logs from failed attempt:",
        "\n".join(artifact_lines) or "(none)",
        "",
        "Repair instructions:",
        "- Diagnose the concrete deck/syntax/contact/solve/convergence issue from the logs.",
        "- Keep the original simulation goal and change only what is necessary.",
        "- Do not use shell commands or unsafe paths.",
        "- Use only allowed tools: sde, sprocess, sdevice, inspect.",
        "- Use only safe ASCII file names without spaces and extensions .cmd, .des, .par, .scm, .tcl, .txt, or .dat.",
        "- If convergence failed, adjust solver, physics, or sweep settings conservatively.",
        "",
        "Durable SDE/SDevice generation guardrails:",
        deck_generation_guardrails(),
        "",
        "- Do not ask the user for confirmation if a safe fix is possible.",
        "- Return a concise diagnostic plus exactly one corrected <SENTAURUS_RUN_REQUEST> JSON block.",
        "- You may also include one updated <SIMULATION_SETUP> JSON block.",
    ]
    return "\n".join(lines)

def format_autodebug_reply(visible_reply, attempts, stop_reason, repair_notes):
    final = attempts[-1] if attempts else {}
    if len(attempts) <= 1 and final.get("status") == "succeeded":
        return (visible_reply + "\n\n" if visible_reply else "") + format_run_result(final)
    lines = []
    if visible_reply:
        lines.append(safe_text(visible_reply, 1400))
        lines.append("")
    if final.get("status") == "succeeded":
        lines.append("Auto-debug completed successfully.")
        lines.append("- attempts: %s" % len(attempts))
        lines.append("- successful run id: %s" % final.get("id"))
    else:
        lines.append("Auto-debug stopped after %s attempt(s)." % len(attempts))
        lines.append("- reason: %s" % (stop_reason or "retry budget reached"))
        lines.append("- last run id: %s" % final.get("id"))
        lines.append("- last status: %s" % final.get("status"))
    failed_attempts = [item for item in attempts if item.get("status") != "succeeded"]
    if failed_attempts:
        lines.append("- failed attempts:")
        for item in failed_attempts:
            failed = first_failed_step(item)
            lines.append("  - attempt %s: %s (%s)" % (item.get("autoDebugAttempt"), item.get("id"), step_diagnostic(failed)))
    if repair_notes:
        lines.append("- repair notes:")
        for note in repair_notes[-3:]:
            lines.append("  - %s" % safe_text(note.replace("\n", " | "), 500))
    lines.append("")
    lines.append(format_run_result(final))
    if final.get("status") != "succeeded":
        lines.append("")
        lines.append("Suggested next step: review the failed deck/logs above or provide the missing process/device assumptions so the next repair has better constraints.")
    return "\n".join(lines)

def run_with_autodebug(original_user_text, initial_run_request, visible_reply, session_id, current_message_id, initial_setup=None):
    config = load_config()
    max_attempts = int(config.get("max_autodebug_attempts") or 5)
    run_request = initial_run_request
    attempts = []
    repair_notes = []
    latest_setup = initial_setup
    stop_reason = ""
    for attempt_no in range(1, max_attempts + 1):
        append_progress(session_id, "runner", "running", "Attempt %s/%s: executing allowlisted Sentaurus run request" % (attempt_no, max_attempts), 45, "")
        result = execute_run_request(run_request, session_id)
        result["autoDebugAttempt"] = attempt_no
        attempts.append(result)
        if result.get("status") == "succeeded":
            if attempt_no > 1:
                append_progress(session_id, "autodebug", "completed", "Auto-debug succeeded on attempt %s/%s" % (attempt_no, max_attempts), 100, result.get("id"))
            return format_autodebug_reply(visible_reply, attempts, "", repair_notes), result, attempts, latest_setup, ""
        if attempt_no >= max_attempts:
            stop_reason = "retry budget reached"
            break
        if not is_recoverable_run_failure(result):
            stop_reason = "failure was not considered safely recoverable"
            break
        append_progress(session_id, "autodebug", "running", "Attempt %s failed; diagnosing logs and repairing deck" % attempt_no, 95, result.get("id"))
        repair_prompt = build_repair_prompt(original_user_text, run_request, result, attempts)
        try:
            repair_reply, _repair_meta = run_with_timeout(LLM_HARD_TIMEOUT_SECONDS, "VM agent auto-debug repair LLM call", call_llm, repair_prompt, config, session_id, current_message_id)
            repair_setup, repair_without_setup = extract_json_tag(repair_reply, "SIMULATION_SETUP")
            if repair_setup:
                latest_setup = normalize_simulation_setup(repair_setup)
            next_run_request, repair_visible = extract_run_request(repair_without_setup)
            if repair_visible:
                repair_notes.append(repair_visible)
            if not next_run_request:
                stop_reason = "repair LLM did not produce a corrected run request"
                append_progress(session_id, "repair_llm", "failed", stop_reason, 100, result.get("id"))
                break
            run_request = next_run_request
            append_progress(session_id, "repair_llm", "completed", "Repair request ready for attempt %s/%s" % (attempt_no + 1, max_attempts), 45, result.get("id"))
        except Exception as exc:
            stop_reason = "repair LLM failed: %s" % safe_text(str(exc), 500)
            append_progress(session_id, "repair_llm", "failed", stop_reason, 100, result.get("id"))
            break
    final = attempts[-1] if attempts else {}
    append_progress(session_id, "autodebug", "failed", stop_reason or "auto-debug stopped without a successful run", 100, final.get("id"))
    return format_autodebug_reply(visible_reply, attempts, stop_reason, repair_notes), final, attempts, latest_setup, stop_reason

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

def manual_priority_file(name):
    lowered = name.lower()
    return lowered.startswith("00") or lowered.startswith("01") or lowered.startswith("readme") or "mission" in lowered or "index" in lowered or "quickstart" in lowered

def manual_query_tokens(user_text):
    raw = safe_text(user_text, 2000).lower()
    separators = "\t\r\n ,.;:()[]{}<>/\\|+-=*\"'~!@#$%^&?"
    for char in separators:
        raw = raw.replace(char, " ")
    tokens = []
    for token in raw.split():
        if len(token) >= 4 and token not in tokens:
            tokens.append(token)
    domain_tokens = [
        "sde", "sdevice", "sprocess", "svisual", "inspect", "swb", "smesh", "tdx",
        "mesh", "electrode", "contact", "doping", "physics", "solve", "plot", "current",
        "extract", "threshold", "mobility", "recombination", "avalanche", "quantum", "deck",
        "tdr", "plt", "cmd", "des", "parameter", "workbench", "simulation", u"仿真", u"网格", u"电极", u"掺杂",
    ]
    for token in domain_tokens:
        if token in raw and token not in tokens:
            tokens.append(token)
    return tokens[:24]

def read_manual_file_excerpt(name, max_chars):
    path = os.path.join(MANUALS_DIR, name)
    try:
        with open(path, "rb") as handle:
            raw = handle.read(max_chars)
    except Exception:
        return ""
    try:
        text = raw.decode("utf-8", "replace")
    except AttributeError:
        text = raw
    return safe_text(text, max_chars).strip()

def read_manual_matches(name, tokens, max_matches=12):
    if not tokens:
        return []
    path = os.path.join(MANUALS_DIR, name)
    matches = []
    try:
        with open(path, "rb") as handle:
            for line_number, raw in enumerate(handle, 1):
                try:
                    line = raw.decode("utf-8", "replace")
                except AttributeError:
                    line = raw
                stripped = safe_text(line, 1000).strip()
                if not stripped:
                    continue
                lowered = stripped.lower()
                score = sum(1 for token in tokens if token in lowered)
                if score > 0:
                    matches.append((score, line_number, stripped))
    except Exception:
        return []
    matches.sort(key=lambda item: (-item[0], item[1]))
    return matches[:max_matches]

def read_manual_context(user_text="", limit=24000):
    files = list_manuals()
    if not files:
        return "No VM-local Sentaurus manuals are installed yet. If the user provides manuals, place converted text/markdown files in ~/.sentaurus-web-agent/vm-agent/manuals/."
    remaining = limit
    sections = []
    for name in files:
        if not manual_priority_file(name):
            continue
        if remaining <= 0:
            break
        text = read_manual_file_excerpt(name, min(remaining, 8000))
        text = safe_text(text, min(remaining, 8000)).strip()
        if not text:
            continue
        sections.append("[Manual: %s]\n%s" % (name, text))
        remaining -= len(text)
    tokens = manual_query_tokens(user_text)
    match_sections = []
    for name in files:
        if remaining <= 0:
            break
        if manual_priority_file(name):
            continue
        matches = read_manual_matches(name, tokens, 8)
        if not matches:
            continue
        lines = ["[Manual matches: %s]" % name]
        for score, line_number, text in matches:
            lines.append("L%s: %s" % (line_number, text))
        section = "\n".join(lines)
        match_sections.append(section)
        remaining -= len(section)
    sections.extend(match_sections)
    return "\n\n".join(sections) or "Manual files exist, but no readable text was found."

def skill_snapshot():
    instances = list_instances()
    manuals = list_manuals()
    return {
        "hostname": socket.gethostname(),
        "user": getpass.getuser(),
        "sentaurusTools": sentaurus_tools(),
        "instanceCount": len(instances),
        "latestInstance": instances[-1] if instances else None,
        "manualCount": len(manuals),
        "manualFiles": manuals[:20],
        "coreMission": "build Sentaurus simulation tasks, prepare decks/data, run allowlisted Sentaurus jobs, and export logs/artifacts/results",
        "safeSkills": ["vm_status", "sentaurus_tools", "list_agent_instances", "sentaurus_manual_context", "simulation_setup", "sentaurus_run_request"],
        "realJobExecution": "available through a VM-local allowlisted runner when the assistant emits a valid <SENTAURUS_RUN_REQUEST> JSON block; arbitrary shell is not allowed",
        "deckGenerationGuardrails": deck_generation_guardrails(),
    }

def wants_skill_reply(text):
    lowered = text.lower().strip()
    match = re.match(r"^/(skill|status|tools|instances?|sentaurus-status)(?:\s|$)", lowered)
    return bool(match)

def local_skill_reply(text):
    snapshot = skill_snapshot()
    lines = [
        "VM Sentaurus skill status:",
        "- core mission: %s" % snapshot.get("coreMission"),
        "- host: %s as %s" % (snapshot.get("hostname"), snapshot.get("user")),
        "- latest instance: %s" % (snapshot.get("latestInstance") or "none"),
        "- instance count: %s" % snapshot.get("instanceCount"),
        "- manual files: %s" % (", ".join(snapshot.get("manualFiles") or []) or "none installed"),
        "- safe skills: %s" % ", ".join(snapshot.get("safeSkills")),
        "- real job execution: %s" % snapshot.get("realJobExecution"),
        "- tools:",
    ]
    for name, path in sorted(snapshot.get("sentaurusTools").items()):
        lines.append("  - %s: %s" % (name, path or "not found"))
    return "\n".join(lines)

def deck_generation_guardrails():
    return "\n".join([
        "- Prefer known-good minimal SDE/SDevice patterns over complex overlapping geometry.",
        "- Never reuse the same name for a geometry region and a contact/electrode. Use region names like R.Source, R.Channel, R.Drain, R.GateOx, R.GatePoly and contact names like source, drain, gate, substrate.",
        "- Avoid an explicit gate polysilicon region unless it is required; a top gate contact on oxide/channel boundary is safer for minimal 2D decks.",
        "- Use non-overlapping source/channel/drain rectangles and simple oxide/body stacks to avoid ACIS PM_UNBALANCED_STATES failures.",
        "- Prefer define-contact-set plus define-2d-contact on explicit edges. Avoid broad set-contact-boundary-edges patterns unless the edge selection is proven.",
        "- Use a proven mesh sequence: (sde:save-model \"name\") then (sde:build-mesh \"snmesh\" \"-a\" \"name_msh\") or the known-good three-argument form (sde:build-mesh \"snmesh\" \"\" \"name\"). Never call (sde:build-mesh \"snmesh\" \"name\") because SDE treats the second argument as an option.",
        "- For DIBL/Id-Vg, prefer two separate SDevice files or clearly separated solve sections for low/high drain bias. Add Inspect only after SDE and SDevice produce valid .plt files.",
        "- If a previous run failed with duplicate region/contact names, PM_UNBALANCED_STATES, or unknown snmesh option, repair those exact patterns before changing physics goals.",
    ])

def chat_completions_url(api_base):
    base = api_base.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return base + "/chat/completions"

def responses_url(api_base):
    base = api_base.rstrip("/")
    if base.endswith("/responses"):
        return base
    return base + "/responses"

def parse_responses_text(data):
    if data.get("output_text"):
        return data.get("output_text")
    parts = []
    for item in data.get("output", []) or []:
        if item.get("text"):
            parts.append(item.get("text"))
        for content in item.get("content", []) or []:
            text = content.get("text") or content.get("content")
            if text:
                parts.append(text)
    for choice in data.get("choices", []) or []:
        message = choice.get("message") or {}
        text = message.get("content") or choice.get("text")
        if text:
            parts.append(text)
    return "\n".join(parts).strip()

def call_llm_model(user_text, config, model, system):
    api_style = (config.get("api_style") or "chat-completions").lower()
    if api_style in ["openai-responses", "responses"]:
        payload = {
            "model": model,
            "input": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_text},
            ],
        }
        body = json.dumps(payload).encode("utf-8")
        request = urllib2.Request(responses_url(config.get("api_base")), body, {
            "content-type": "application/json",
            "authorization": "Bearer %s" % config.get("api_key"),
            "user-agent": "sentaurus-vm-agent/0.4.6",
        })
        response = urllib2.urlopen(request, timeout=90).read()
        try:
            text = response.decode("utf-8", "replace")
        except AttributeError:
            text = response
        parsed = parse_responses_text(json.loads(text))
        if not parsed:
            raise Exception("LLM returned no content")
        return parsed

    payload = {
        "model": model,
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
        "user-agent": "sentaurus-vm-agent/0.4.6",
    })
    response = urllib2.urlopen(request, timeout=90).read()
    try:
        text = response.decode("utf-8", "replace")
    except AttributeError:
        text = response
    data = json.loads(text)
    parsed = data.get("choices", [{}])[0].get("message", {}).get("content") or data.get("choices", [{}])[0].get("text")
    if not parsed:
        raise Exception("LLM returned no content")
    return parsed

def call_llm(user_text, config, session_id="", current_message_id=""):
    snapshot = skill_snapshot()
    manual_context = read_manual_context(user_text)
    recent_session_context = session_context(session_id, current_message_id)
    system = (
        "You are the Sentaurus TCAD simulation agent running inside the CentOS VM. "
        "Your core mission is to help the user establish complete Sentaurus simulation tasks: clarify the device/process objective, "
        "create or revise SDE/SProcess/SDevice/SWB decks and parameter data, prepare run directories and extraction plans, "
        "invoke Sentaurus only through the VM-local allowlisted runner, monitor logs, and export results/artifacts/metrics back to the user. "
        "Real execution is available only by emitting a valid <SENTAURUS_RUN_REQUEST> JSON block; arbitrary shell commands are forbidden. "
        "Never claim that a Sentaurus job has run unless an allowlisted runner actually ran it and produced logs/artifacts. "
        "When the user explicitly asks you to run/simulate and you can create a self-contained minimal Sentaurus deck, include a concise human explanation, one simulation setup block, and exactly one run request block. "
        "The setup block schema is: <SIMULATION_SETUP>{\"deviceType\":\"...\",\"gateBias\":\"...\",\"drainBias\":\"...\",\"sourceBulk\":\"...\",\"geometry\":\"...\",\"dopingOrImplant\":\"...\",\"physicsModels\":\"...\",\"mesh\":\"...\",\"temperature\":\"...\",\"simulationGoals\":\"...\",\"expectedOutputs\":[\"file or curve\"],\"notes\":\"...\"}</SIMULATION_SETUP>. "
        "Populate the setup block with actual assumptions from the same browser session; omit unknown fields instead of inventing critical process/device parameters. "
        "The block schema is: <SENTAURUS_RUN_REQUEST>{\"title\":\"short-title\",\"files\":[{\"name\":\"main.cmd\",\"content\":\"...\"}],\"steps\":[{\"tool\":\"sde|sprocess|sdevice|inspect\",\"input\":\"main.cmd\"}]}</SENTAURUS_RUN_REQUEST>. "
        "A run request is executable only when it contains every file content needed by at least one complete step chain. "
        "Do not emit placeholder files, references to missing uploads, or an SDE-only setup while promising later SDevice/Inspect execution. Ask for missing data instead. "
        "Never say that the agent will continue with later run steps unless those steps are included in the same run request. "
        "Use only safe ASCII file names without spaces, and only .cmd, .des, .par, .scm, .tcl, .txt, or .dat files. "
        "If the required deck cannot be made self-contained, ask for the missing files/assumptions instead of emitting a run request. "
        "Use the installed tool paths and VM state in the snapshot. Ask for missing physics/process assumptions instead of inventing critical parameters. "
        "Before saying previous files, run directories, decks, or results are unavailable, inspect the recent browser-session context below. "
        "If the user says 'continue', 'that project', or similar, resolve it from the same-session context whenever possible. "
        "The browser and host backend only relay messages; API credentials stay inside this VM. "
        "Current VM skill snapshot: " + json.dumps(snapshot, ensure_ascii=True, sort_keys=True) + "\n\n" +
        "Durable SDE/SDevice generation guardrails:\n" + deck_generation_guardrails() + "\n\n" +
        "Recent browser-session context, newest last:\n" + recent_session_context + "\n\n" +
        "VM-local Sentaurus manual/context excerpts:\n" + manual_context
    )
    models = config.get("models") or [config.get("model") or "gpt-5.5"]
    errors = []
    for index, model in enumerate(models):
        try:
            reply = call_llm_model(user_text, config, model, system)
            meta = {
                "kind": "llm",
                "llmConfigured": True,
                "model": model,
                "apiStyle": config.get("api_style"),
                "modelCandidates": ",".join(models),
            }
            if index > 0:
                meta["fallbackFrom"] = ",".join(models[:index])
                meta["fallbackCount"] = index
            return reply, meta
        except Exception as exc:
            error_text = safe_text(str(exc), 500)
            errors.append("%s: %s" % (model, error_text))
            audit("llm_model_failed", {"model": model, "error": error_text})
    raise Exception("; ".join(errors) or "no LLM model candidates configured")

def reply_for(text, session_id="", current_message_id=""):
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
        return run_with_timeout(LLM_HARD_TIMEOUT_SECONDS, "VM agent LLM call", call_llm, text, config, session_id, current_message_id)
    except Exception as exc:
        return "VM agent LLM call failed inside CentOS: %s" % safe_text(str(exc), 1000), {"kind": "llm_error", "llmConfigured": True, "modelCandidates": ",".join(config.get("models") or [])}

def process_queue_file(path):
    session_id = ""
    try:
        with open(path, "r") as handle:
            item = json.load(handle)
        text = safe_text(item.get("content"), 4000)
        incoming_meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
        session_id = safe_text(incoming_meta.get("sessionId"), 160).strip()
        audit("queue_processing_started", {"file": os.path.basename(path), "sessionId": session_id})
        append_progress(session_id, "received", "running", "Worker picked up queued request", 5)
        if wants_skill_reply(text):
            append_progress(session_id, "skill", "running", "Handling local slash-command skill", 20)
        else:
            append_progress(session_id, "llm_context", "running", "Building session history and manual context", 12)
        reply, meta = reply_for(text, session_id, item.get("id") or "")
        simulation_setup, setup_visible_reply = extract_json_tag(reply, "SIMULATION_SETUP")
        if simulation_setup:
            simulation_setup = normalize_simulation_setup(simulation_setup)
            meta["simulationSetupJson"] = json.dumps(simulation_setup, ensure_ascii=True, sort_keys=True)
        run_request, visible_reply = extract_run_request(setup_visible_reply)
        validation_error = run_request_validation_error(run_request, visible_reply, text)
        if validation_error:
            append_progress(session_id, "run_validation", "failed", validation_error, 100)
            repaired_reply, repaired_meta = repair_run_request_reply(text, reply, validation_error, session_id, item.get("id") or "")
            meta = repaired_meta
            if repaired_reply:
                repaired_setup, repaired_visible_reply = extract_json_tag(repaired_reply, "SIMULATION_SETUP")
                if repaired_setup:
                    simulation_setup = normalize_simulation_setup(repaired_setup)
                run_request, visible_reply = extract_run_request(repaired_visible_reply)
                validation_error = run_request_validation_error(run_request, visible_reply, text)
            else:
                run_request = None
                visible_reply = ""
            if validation_error:
                run_request = None
                visible_reply = format_validation_rejection(validation_error, visible_reply or repaired_reply or reply)
                meta["kind"] = "run_request_validation_error"
            reply = visible_reply
        if simulation_setup:
            meta["simulationSetupJson"] = json.dumps(simulation_setup, ensure_ascii=True, sort_keys=True)
        elif run_request:
            simulation_setup = setup_from_run_request(run_request)
            meta["simulationSetupJson"] = json.dumps(simulation_setup, ensure_ascii=True, sort_keys=True)
        if meta.get("kind") == "sentaurus_skill":
            append_progress(session_id, "skill", "completed", "Local skill reply is ready", 100)
        elif meta.get("kind") == "llm_error":
            append_progress(session_id, "llm", "failed", "LLM call failed; see agent message", 100)
        else:
            append_progress(session_id, "llm", "completed", "LLM produced %s" % ("a Sentaurus run request" if run_request else "a chat reply"), 35)
        if run_request:
            reply, result, attempts, simulation_setup, stop_reason = run_with_autodebug(text, run_request, visible_reply, session_id, item.get("id") or "", simulation_setup)
            artifacts = result.get("artifacts") or []
            meta["kind"] = "sentaurus_run"
            meta["runId"] = result.get("id")
            meta["vmRunId"] = result.get("id")
            meta["runStatus"] = result.get("status")
            meta["vmRunStatus"] = result.get("status")
            meta["vmRunArtifactCount"] = len(artifacts)
            meta["vmRunArtifactsJson"] = json.dumps(artifacts, ensure_ascii=True, sort_keys=True)
            meta["autoDebugAttemptCount"] = len(attempts)
            meta["autoDebugAttemptsJson"] = json.dumps(attempts_meta(attempts), ensure_ascii=True, sort_keys=True)
            append_progress(session_id, "final", "completed" if result.get("status") == "succeeded" else "failed", "Final simulation result appended to chat", 100, result.get("id") or "")
            if stop_reason:
                meta["autoDebugStoppedReason"] = stop_reason
            if simulation_setup:
                meta["simulationSetupJson"] = json.dumps(simulation_setup, ensure_ascii=True, sort_keys=True)
        elif meta.get("kind") != "llm_error":
            append_progress(session_id, "reply", "completed", "Agent reply is ready", 100)
        if session_id:
            meta["sessionId"] = session_id
            if simulation_setup:
                sync_session_setup_to_output(session_id, simulation_setup)
        append_message("agent", reply, "vm-agent-worker", meta)
        shutil.move(path, os.path.join(DONE_DIR, os.path.basename(path)))
        audit("queue_processed", {"file": os.path.basename(path), "replyKind": meta.get("kind")})
    except Exception as exc:
        error_meta = {"kind": "worker_error"}
        if session_id:
            error_meta["sessionId"] = session_id
            append_progress(session_id, "worker", "failed", "Worker failed to process queued message", 100)
        append_message("system", "VM agent worker failed to process a message: %s" % safe_text(str(exc), 1000), "vm-agent-worker", error_meta)
        try:
            shutil.move(path, os.path.join(DONE_DIR, "failed_" + os.path.basename(path)))
        except Exception:
            pass

def main():
    for path in [ROOT, QUEUE_DIR, DONE_DIR, MANUALS_DIR]:
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
import signal
import socket
import subprocess
import sys
import time
import uuid

AGENT_NAME = "sentaurus-vm-agent"
AGENT_VERSION = "0.4.6"
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
MANUALS_DIR = os.path.join(ROOT, "manuals")
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

def read_messages(after=0, limit=50, session_id=""):
    cursor = 0
    messages = []
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
    models = config_list(configured_models)
    primary = safe_text(primary_model, 160).strip()
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
    raw_models = env.get("LLM_MODELS") or file_config.get("llmModels") or file_config.get("LLM_MODELS")
    return {
        "api_base": env.get("LLM_API_BASE") or file_config.get("llmApiBase") or file_config.get("LLM_API_BASE") or "",
        "api_key": env.get("LLM_API_KEY") or file_config.get("llmApiKey") or file_config.get("LLM_API_KEY") or "",
        "model": primary_model,
        "models": model_candidates(primary_model, raw_models),
        "api_style": env.get("LLM_API_STYLE") or file_config.get("llmApiStyle") or file_config.get("LLM_API_STYLE") or "chat-completions",
        "max_autodebug_attempts": config_int(env, file_config, "VM_AGENT_MAX_AUTODEBUG_ATTEMPTS", "vmAgentMaxAutodebugAttempts", 5, 1, 8),
    }

def llm_configured():
    config = load_config()
    return bool(config.get("api_base") and config.get("api_key"))

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
    ensure_dir(MANUALS_DIR)
    worker_source = base64.b64decode(WORKER_SOURCE_B64)
    with open(WORKER_PATH, "wb") as handle:
        handle.write(worker_source)
    os.chmod(WORKER_PATH, 0o700)
    if not os.path.exists(CONFIG_EXAMPLE_PATH):
        with open(CONFIG_EXAMPLE_PATH, "w") as handle:
            handle.write(json.dumps({
                "llmApiBase": "https://your-openai-compatible-base/v1",
                "llmApiKey": "put-real-key-here-inside-vm-only",
                "llmModel": "gpt-5.5",
                "llmModels": ["gpt-5.5", "gpt-5.4"],
                "llmApiStyle": "chat-completions",
                "vmAgentMaxAutodebugAttempts": 5
            }, indent=2, sort_keys=True) + "\n")
    if not os.path.exists(ENV_EXAMPLE_PATH):
        with open(ENV_EXAMPLE_PATH, "w") as handle:
            handle.write("LLM_API_BASE=https://your-openai-compatible-base/v1\nLLM_API_KEY=put-real-key-here-inside-vm-only\nLLM_MODEL=gpt-5.5\nLLM_MODELS=gpt-5.5,gpt-5.4\nLLM_API_STYLE=chat-completions\nVM_AGENT_MAX_AUTODEBUG_ATTEMPTS=5\n")

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
    write_worker_files()
    if os.path.exists(STOP_PATH):
        os.unlink(STOP_PATH)
    running, pid = worker_running()
    if running and force_restart:
        stop_worker(pid)
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
    llm_config = load_config()
    manuals = list_manuals()
    return {
        "ok": True,
        "agent": AGENT_NAME,
        "version": AGENT_VERSION,
        "hostname": socket.gethostname(),
        "user": getpass.getuser(),
        "capabilities": ["relay_message", "history", "vm_worker", "vm_local_llm_config", "sentaurus_skills", "sentaurus_run_request", "sentaurus_autodebug", "sentaurus_session_output"],
        "instanceCount": len(instances),
        "latestInstance": instances[-1] if instances else None,
        "mailbox": "~/.sentaurus-web-agent/vm-agent",
        "messageCount": message_count(),
        "workerRunning": running,
        "workerPid": pid if running else None,
        "llmConfigured": bool(llm_config.get("api_base") and llm_config.get("api_key")),
        "llmModel": llm_config.get("model"),
        "llmModels": llm_config.get("models"),
        "maxAutodebugAttempts": llm_config.get("max_autodebug_attempts"),
        "manualCount": len(manuals),
        "manualFiles": manuals[:20],
        "queueDepth": queue_depth(),
        "sentaurusTools": sentaurus_tools(),
        "vmTime": now_iso(),
        "vmEpochMs": int(time.time() * 1000),
    }

def enqueue_message(content, session_id=None):
    ensure_dir(QUEUE_DIR)
    meta = {"kind": "web_message", "queuedFor": "vm-agent-worker"}
    session_id = safe_text(session_id, 160).strip()
    if session_id:
        meta["sessionId"] = session_id
    message = append_message("user", content, "web", meta, "web")
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
    session_id = safe_text(request.get("sessionId"), 160).strip()
    messages = []

    if operation == "start":
        pid = start_worker(True)
        messages = [append_message("agent", "CentOS VM agent worker is running. Browser/host will only relay messages; LLM credentials are read inside the VM.", "vm-agent-control", {"kind": "worker_ready", "pid": pid})]
    elif operation == "send":
        incoming = safe_text(request.get("message"), 4000)
        if not incoming.strip():
            raise ValueError("message is required")
        start_worker()
        messages = [enqueue_message(incoming, session_id)]
    elif operation == "history":
        messages, _cursor = read_messages(after, limit, session_id)
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

const remoteArtifactDownloadScript = String.raw`# -*- coding: utf-8 -*-
import base64
import json
import os
import re
import sys

REQUEST_B64 = "__ARTIFACT_REQUEST_B64__"
HOME = os.path.expanduser("~")
RUNS_DIR = os.path.join(HOME, "STDB", "web-agent-runs")
MAX_BYTES = __MAX_VM_ARTIFACT_BYTES__
ALLOWED_EXT = set([".log", ".out", ".err", ".plt", ".tdr", ".grd", ".dat", ".csv", ".txt", ".png", ".jpg", ".jpeg", ".json", ".cmd", ".des", ".par", ".scm", ".tcl", ".bnd", ".sat"])

try:
    string_types = (basestring,)
except NameError:
    string_types = (str,)

def respond(payload):
    print(json.dumps(payload, ensure_ascii=True, sort_keys=True))

def fail(message, status_code=400):
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

try:
    request = load_request()
    run_id = safe_text(request.get("runId"), 180).strip()
    if not re.match(r"^run_[A-Za-z0-9_-]+$", run_id):
        fail("invalid VM run id")
    parts = safe_segments(request.get("path"))
    ext = os.path.splitext(parts[-1])[1].lower()
    if ext not in ALLOWED_EXT:
        fail("artifact extension is not allowlisted")
    run_dir = os.path.abspath(os.path.join(RUNS_DIR, run_id))
    target = os.path.abspath(os.path.join(run_dir, *parts))
    if target != run_dir and not target.startswith(run_dir + os.sep):
        fail("artifact path escapes run directory")
    if not os.path.isfile(target):
        fail("artifact not found", 404)
    size = os.path.getsize(target)
    if size > MAX_BYTES:
        fail("artifact is too large to download through the web relay", 413)
    with open(target, "rb") as handle:
        content = base64.b64encode(handle.read())
    try:
        content = content.decode("ascii")
    except AttributeError:
        pass
    respond({
        "ok": True,
        "path": "/".join(parts),
        "fileName": os.path.basename(target),
        "size": size,
        "contentB64": content,
    })
except SystemExit:
    raise
except Exception as exc:
    fail(str(exc), 500)
`;

function remoteAgentScript(request: RemoteAgentRequest): string {
  const encodedRequest = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  const encodedWorker = Buffer.from(remoteWorkerScript, "utf8").toString("base64");
  return remoteControlScript
    .replace("__REQUEST_B64__", encodedRequest)
    .replace("__WORKER_SOURCE_B64__", encodedWorker);
}

function remoteArtifactScript(runId: string, artifactPath: string): string {
  const encodedRequest = Buffer.from(JSON.stringify({ runId, path: artifactPath }), "utf8").toString("base64");
  return remoteArtifactDownloadScript
    .replace("__ARTIFACT_REQUEST_B64__", encodedRequest)
    .replace("__MAX_VM_ARTIFACT_BYTES__", String(maxVmArtifactBytes));
}

function parseRemoteJson(raw: string): RemoteAgentPayload {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) throw new Error(`VM agent did not return JSON: ${raw.slice(0, 500)}`);
  return JSON.parse(jsonLine) as RemoteAgentPayload;
}

type RemoteArtifactPayload = {
  ok?: boolean;
  error?: string;
  statusCode?: number;
  path?: string;
  fileName?: string;
  size?: number;
  contentB64?: string;
};

function parseRemoteArtifactJson(raw: string): RemoteArtifactPayload {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) throw httpError(502, `VM artifact download did not return JSON: ${raw.slice(0, 500)}`);
  return JSON.parse(jsonLine) as RemoteArtifactPayload;
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

function normalizeMessages(messages: unknown[] | undefined, payload: RemoteAgentPayload): VmAgentMessage[] {
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
    llmModel: payload.llmModel,
    llmModels: payload.llmModels,
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

async function callVmAgent(request: RemoteAgentRequest): Promise<RemoteAgentPayload> {
  const result = await runSshCommandWithInput("python -", remoteAgentScript(request), 20_000);
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const hostEpochMs = Date.now();
  if (!result.ok) {
    return hostTiming({ ok: false, error: result.error || result.stderr || "VM agent SSH call failed", raw: raw.slice(0, 500), messages: [], cursor: 0 }, hostEpochMs);
  }
  try {
    return hostTiming(parseRemoteJson(raw), hostEpochMs);
  } catch (err) {
    return hostTiming({ ok: false, error: err instanceof Error ? err.message : String(err), raw: raw.slice(0, 500), messages: [], cursor: 0 }, hostEpochMs);
  }
}

export async function downloadVmRunArtifact(runId: string, artifactPath: string): Promise<VmRunArtifactDownload> {
  const safe = validateVmArtifactRequest(runId, artifactPath);
  const result = await runSshCommandWithInput("python -", remoteArtifactScript(safe.runId, safe.artifactPath), 90_000);
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!result.ok) {
    throw httpError(502, result.error || result.stderr || "VM artifact SSH download failed");
  }
  const payload = parseRemoteArtifactJson(raw);
  if (payload.ok === false) {
    const statusCode = typeof payload.statusCode === "number" ? payload.statusCode : 400;
    throw httpError(statusCode, payload.error || "VM artifact download failed");
  }
  if (typeof payload.contentB64 !== "string" || typeof payload.path !== "string" || typeof payload.fileName !== "string") {
    throw httpError(502, "VM artifact download response was incomplete");
  }
  const data = Buffer.from(payload.contentB64, "base64");
  const size = typeof payload.size === "number" && Number.isFinite(payload.size) ? payload.size : data.byteLength;
  return {
    path: payload.path,
    fileName: payload.fileName,
    size,
    data
  };
}

export async function getVmAgentStatus(): Promise<VmAgentStatus> {
  const payload = await callVmAgent({ operation: "status", limit: 20 });
  return payload.ok === false ? errorStatus(payload.error || "VM agent status check failed", payload.raw) : toStatus(payload);
}

export async function connectVmAgent(): Promise<{ status: VmAgentStatus; messages: VmAgentMessage[]; message?: VmAgentMessage; cursor: number }> {
  const payload = await callVmAgent({ operation: "start" });
  const status = payload.ok === false ? errorStatus(payload.error || "VM agent connect failed", payload.raw) : toStatus(payload);
  const messages = normalizeMessages(payload.messages, payload);
  return { status, messages, message: messages.find((item) => item.role === "agent"), cursor: payload.cursor || 0 };
}

export async function getVmAgentMessages(after = 0, limit = 50, sessionId?: string): Promise<{ status: VmAgentStatus; messages: VmAgentMessage[]; cursor: number }> {
  const payload = await callVmAgent({ operation: "history", after, limit, sessionId });
  const status = payload.ok === false ? errorStatus(payload.error || "VM agent history failed", payload.raw) : toStatus(payload);
  return { status, messages: normalizeMessages(payload.messages, payload), cursor: payload.cursor || after };
}

export async function sendVmAgentMessage(message: string, sessionId?: string): Promise<{ status: VmAgentStatus; message: VmAgentMessage; messages: VmAgentMessage[]; cursor: number }> {
  const payload = await callVmAgent({ operation: "send", message, sessionId });
  const status = payload.ok === false ? errorStatus(payload.error || "VM agent message failed", payload.raw) : toStatus(payload);
  const messages = normalizeMessages(payload.messages, payload);
  const representative = [...messages].reverse().find((item) => item.role === "agent") || messages[0] || fallbackAgentMessage("Message queued for the CentOS VM agent.");
  return { status, message: representative, messages, cursor: payload.cursor || 0 };
}
