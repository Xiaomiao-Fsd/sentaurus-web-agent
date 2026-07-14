# -*- coding: utf-8 -*-
import base64
import datetime
import errno
import glob
import getpass
import hashlib
import json
import math
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

try:
    import fcntl
except ImportError:
    fcntl = None

AGENT_NAME = "sentaurus-vm-agent"
AGENT_VERSION = "0.6.0"
DFISE_EXTRACTOR_VERSION = "dfise-idvg-extract/1"
DFISE_METRIC_PROFILE = "tcad-idvg-v1"
DFISE_MIN_SS_WINDOW_POINTS = 7
DFISE_MIN_SS_ADJACENT_PAIRS = 6
DFISE_EXTRACTOR_SHA256 = "e44a9e6ebc22b04b6ec77474fd6188336283cf73e237a1006666a1765fbfac4e"
HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".sentaurus-web-agent", "vm-agent")
DFISE_EXTRACTOR_PATH = os.path.join(ROOT, "dfise_idvg_extract.py")
QUEUE_DIR = os.path.join(ROOT, "queue")
DONE_DIR = os.path.join(ROOT, "processed")
MESSAGES_PATH = os.path.join(ROOT, "messages.jsonl")
AUDIT_PATH = os.path.join(ROOT, "audit.jsonl")
HEARTBEAT_PATH = os.path.join(ROOT, "worker.heartbeat")
CONFIG_PATH = os.path.join(ROOT, "config.json")
ENV_PATH = os.path.join(ROOT, ".env")
MANUALS_DIR = os.path.join(ROOT, "manuals")
GOALS_DIR = os.path.join(ROOT, "goals")
GLOBAL_AGENTS_PATH = os.path.join(ROOT, "AGENTS.md")
LLM_HARD_TIMEOUT_SECONDS = 120
VM_CONTEXT_WINDOW_TOKENS = 1000000
VM_CONTEXT_TARGET_TOKENS = 850000
VM_CONTEXT_HARD_TOKENS = 950000

class HardTimeout(Exception):
    pass
RUNS_DIR = os.path.join(HOME, "STDB", "web-agent-runs")
SESSION_OUTPUT_ROOT = os.path.join(HOME, "STDB", "web-agent-sessions")
OUTPUT_CATEGORY_INPUT = u"\u6211\u7684\u8f93\u5165"
OUTPUT_CATEGORY_RESULTS = u"\u4eff\u771f\u7ed3\u679c\u6587\u4ef6"
OUTPUT_CATEGORY_LOGS = u"\u4eff\u771f\u65e5\u5fd7\u6587\u4ef6"
OUTPUT_CATEGORY_PARAMS = u"\u4eff\u771f\u53c2\u6570\u6587\u4ef6"
OUTPUT_CATEGORY_OTHER = u"\u5176\u5b83\u6587\u4ef6"
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

def safe_session_key(session_id):
    session_id = safe_text(session_id, 160).strip()
    if not session_id:
        return ""
    return re.sub(r"[^A-Za-z0-9_.:-]", "_", session_id)[:160]

def session_goal_path(session_id):
    key = safe_session_key(session_id)
    if not key:
        return ""
    return os.path.join(GOALS_DIR, key + ".json")

def read_json_file(path, fallback=None):
    if not path or not os.path.exists(path):
        return fallback
    try:
        with open(path, "r") as handle:
            return json.load(handle)
    except Exception:
        return fallback

def read_session_goal_record(session_id):
    path = session_goal_path(session_id)
    value = read_json_file(path, {})
    if not isinstance(value, dict):
        return None
    goal_text = safe_text(value.get("goal"), 2000).strip()
    if not goal_text:
        return None
    return {
        "goal": goal_text,
        "updatedAt": safe_text(value.get("updatedAt"), 80) or now_iso(),
    }

def session_goal_text(session_id, limit=2000):
    record = read_session_goal_record(session_id)
    return safe_text(record.get("goal"), limit).strip() if record else ""

def write_session_goal(session_id, goal_text):
    path = session_goal_path(session_id)
    if not path:
        raise ValueError("sessionId is required for /goal")
    record = {
        "goal": safe_text(goal_text, 2000).strip(),
        "updatedAt": now_iso(),
    }
    if not record["goal"]:
        raise ValueError("goal text cannot be empty")
    ensure_dir(GOALS_DIR)
    temp_path = path + ".tmp.%s" % uuid.uuid4().hex[:8]
    try:
        with open(temp_path, "w") as handle:
            handle.write(json.dumps(record, ensure_ascii=True, sort_keys=True))
            handle.flush()
            os.fsync(handle.fileno())
        os.rename(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
    return record

def clear_session_goal(session_id):
    path = session_goal_path(session_id)
    if not path or not os.path.exists(path):
        return False
    os.remove(path)
    return True

def read_global_agents_context(limit=48000):
    if not os.path.exists(GLOBAL_AGENTS_PATH):
        return "(No VM-root AGENTS.md file is installed yet.)"
    try:
        with open(GLOBAL_AGENTS_PATH, "r") as handle:
            return safe_text(handle.read(), limit)
    except Exception as exc:
        return "(Failed to read VM-root AGENTS.md: %s)" % safe_text(str(exc), 300)

def message_id(prefix):
    return "%s_%s_%s" % (prefix, datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"), uuid.uuid4().hex[:8])

def turn_id():
    return "turn_%s_%s" % (datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"), uuid.uuid4().hex[:6])

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

def append_thinking(session_id, request_message_id, stage, detail, status="running", collapsed=False):
    meta = {
        "kind": "agent_thinking",
        "sessionId": safe_text(session_id, 160),
        "requestMessageId": safe_text(request_message_id, 180),
        "thinkingStage": safe_text(stage, 80),
        "thinkingStatus": safe_text(status, 40),
        "collapsedByDefault": bool(collapsed),
    }
    content = "%s: %s" % (safe_text(stage, 80), safe_text(detail, 900))
    return append_message("system", content, "vm-agent-thinking", meta, "thinking")

def base_worklog_meta(kind, session_id, turn_id_value, phase, run_id=""):
    meta = {
        "kind": kind,
        "sessionId": safe_text(session_id, 160),
        "turnId": safe_text(turn_id_value, 180),
        "groupId": safe_text(turn_id_value, 180),
        "phase": safe_text(phase, 80),
        "foldable": kind not in ["run_final", "vm_agent_attachments"],
        "collapsedByDefault": kind not in ["run_final", "vm_agent_attachments"],
        "publicWorklog": True,
        "displayLanguage": "zh-CN",
    }
    if run_id:
        meta["runId"] = safe_text(run_id, 180)
    return meta

def append_worklog(session_id, turn_id_value, phase, text, run_id=""):
    meta = base_worklog_meta("worklog_summary", session_id, turn_id_value, phase, run_id)
    return append_message("agent", text, "vm-agent-worklog", meta, "worklog")

def append_file_operation(session_id, turn_id_value, operation, path, category=None, size=None, run_id=""):
    file_path = safe_text(path, 500).replace("\\", "/")
    op = safe_text(operation, 40).strip().lower() or "touched"
    label = {"created": "Created", "edited": "Edited", "read": "Read", "deleted": "Deleted", "uploaded": "Uploaded", "published": "Published", "produced": "Produced"}.get(op, op.capitalize())
    meta = base_worklog_meta("file_operation", session_id, turn_id_value, "file", run_id)
    meta["operation"] = op
    meta["path"] = file_path
    if category:
        meta["category"] = safe_text(category, 180)
    if size is not None:
        try:
            meta["size"] = max(0, int(size))
        except Exception:
            pass
    return append_message("agent", "%s %s" % (label, file_path), "vm-agent-worklog", meta, "file")

def append_tool_run(session_id, turn_id_value, tool, command_label, status, exit_code=None, duration_ms=None, run_id=""):
    meta = base_worklog_meta("tool_run", session_id, turn_id_value, "tool", run_id)
    meta["tool"] = safe_text(tool, 80)
    meta["commandLabel"] = safe_text(command_label, 240)
    meta["status"] = safe_text(status, 40)
    if exit_code is not None:
        try:
            meta["exitCode"] = int(exit_code)
        except Exception:
            pass
    if duration_ms is not None:
        try:
            meta["durationMs"] = max(0, int(duration_ms))
        except Exception:
            pass
    content = "%s %s" % (safe_text(status, 40).capitalize(), safe_text(command_label, 240))
    return append_message("agent", content, "vm-agent-worklog", meta, "tool")

def append_run_diagnostic(session_id, turn_id_value, text, run_id=""):
    meta = base_worklog_meta("run_diagnostic", session_id, turn_id_value, "debug", run_id)
    return append_message("agent", text, "vm-agent-worklog", meta, "diag")

def append_run_final(session_id, turn_id_value, content, result, duration_ms=None):
    run_id_value = safe_text(result.get("id"), 180) if isinstance(result, dict) else ""
    meta = base_worklog_meta("run_final", session_id, turn_id_value, "final", run_id_value)
    meta["foldable"] = False
    meta["collapsedByDefault"] = False
    meta["summaryOfGroup"] = True
    status = safe_text(result.get("status"), 80) if isinstance(result, dict) else ""
    if status:
        meta["runStatus"] = status
    if duration_ms is not None:
        try:
            meta["worklogDurationMs"] = max(0, int(duration_ms))
        except Exception:
            pass
    return append_message("agent", content, "vm-agent-worker", meta, "final")

def append_attachment_message(session_id, turn_id_value, attachments, meta):
    attachment_meta = meta.copy() if isinstance(meta, dict) else {}
    attachment_meta["kind"] = "vm_agent_attachments"
    attachment_meta["sessionId"] = safe_text(session_id, 160)
    attachment_meta["turnId"] = safe_text(turn_id_value, 180)
    attachment_meta["groupId"] = safe_text(turn_id_value, 180)
    attachment_meta["phase"] = "attachment"
    attachment_meta["foldable"] = False
    attachment_meta["collapsedByDefault"] = False
    attachment_meta["attachmentCount"] = len(attachments or [])
    attachment_meta["imageAttachmentCount"] = len([item for item in attachments or [] if isinstance(item, dict) and item.get("kind") == "image"])
    return append_message("agent", "Published %s VM attachment%s." % (len(attachments or []), "" if len(attachments or []) == 1 else "s"), "vm-agent-worker", attachment_meta, "attach", attachments)

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

def non_progress_session_message(item):
    meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
    if meta.get("kind") in ["progress", "agent_thinking", "agent_reasoning_summary"]:
        return False
    if item.get("source") == "vm-agent-progress":
        return False
    if item.get("source") == "vm-agent-thinking":
        return False
    return True

def parse_local_command(text):
    stripped = safe_text(text, 4000).strip()
    if not stripped.startswith("/"):
        return None
    parts = stripped[1:].split(None, 1)
    name = safe_text(parts[0], 80).strip().lower() if parts else ""
    args = parts[1] if len(parts) > 1 else ""
    aliases = {
        "skill": "status",
        "status": "status",
        "tools": "status",
        "instance": "status",
        "instances": "status",
        "sentaurus-status": "status",
        "help": "help",
        "goal": "goal",
        "side": "side",
    }
    if name not in aliases:
        return None
    return {"name": aliases[name], "raw": name, "args": args}

def excluded_from_main_context(item):
    meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
    if meta.get("kind") in ["sentaurus_skill", "local_help", "goal_status", "goal_updated", "goal_cleared", "goal_error", "side_investigation"]:
        return True
    command = parse_local_command(item.get("content"))
    return bool(command and command.get("name") in ["status", "help", "goal", "side"])

def context_lower(value, limit=8000):
    try:
        return safe_text(value, limit).lower()
    except Exception:
        return ""

def context_has_important_keywords(item):
    meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
    text = context_lower(item.get("content"), 8000) + " " + context_lower(meta.get("simulationSetupJson"), 4000)
    keywords = [
        "28nm", "28 nm", "mosfet", "nmos", "fdsoi", "utb", "id-vg", "idvg",
        "vth", "ss", "dibl", "ion", "ioff", "calibrat", "target", "baseline",
        u"\u76ee\u6807", u"\u6821\u51c6", u"\u57fa\u7ebf", u"\u7ed3\u679c", u"\u66f2\u7ebf", u"\u8f6c\u79fb\u7279\u6027", u"\u9608\u503c", u"\u4e9a\u9608\u503c",
    ]
    for keyword in keywords:
        if keyword in text:
            return True
    return False

def compact_artifact_names(value, limit=900):
    if not value:
        return ""
    artifacts = None
    try:
        artifacts = json.loads(value) if isinstance(value, string_types) else value
    except Exception:
        artifacts = None
    if isinstance(artifacts, list):
        names = []
        for item in artifacts[:14]:
            if not isinstance(item, dict):
                continue
            path = safe_text(item.get("path"), 180)
            size = item.get("size")
            if path:
                names.append("%s (%s bytes)" % (path, size if size is not None else "unknown"))
        if len(artifacts) > 14:
            names.append("... %s more" % (len(artifacts) - 14))
        return safe_text(", ".join(names), limit)
    return safe_text(value, limit).replace("\n", " | ")

def compact_setup(value, limit=1100):
    if not value:
        return ""
    return safe_text(value, limit).replace("\n", " | ")

def session_context_line(item, content_limit=1200):
    meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
    content = safe_text(item.get("content"), content_limit).replace("\n", " | ")
    header = "[%s] %s kind=%s" % (item.get("createdAt") or "unknown-time", item.get("role") or "unknown-role", meta.get("kind") or "unknown")
    run_id = meta.get("runId") or meta.get("vmRunId")
    run_status = meta.get("runStatus") or meta.get("vmRunStatus")
    if run_id:
        header += " runId=%s" % safe_text(run_id, 180)
    if run_status:
        header += " runStatus=%s" % safe_text(run_status, 40)
    return header + ": " + content

def session_state_digest(messages, recent_messages):
    recent_ids = {}
    for item in recent_messages:
        if item.get("id"):
            recent_ids[item.get("id")] = True
    run_messages = []
    important_older = []
    for item in messages:
        meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
        if meta.get("kind") == "sentaurus_run" or meta.get("runId") or meta.get("vmRunId") or meta.get("simulationSetupJson"):
            run_messages.append(item)
        if item.get("id") not in recent_ids and context_has_important_keywords(item):
            important_older.append(item)

    lines = []
    if run_messages:
        lines.append("Latest same-session Sentaurus run state (newest last; progress events omitted):")
        for item in run_messages[-6:]:
            meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
            run_id = meta.get("runId") or meta.get("vmRunId") or "unknown-run"
            run_status = meta.get("runStatus") or meta.get("vmRunStatus") or "unknown-status"
            lines.append("- [%s] %s status=%s" % (item.get("createdAt") or "unknown-time", safe_text(run_id, 180), safe_text(run_status, 60)))
            setup = compact_setup(meta.get("simulationSetupJson"), 1300)
            if setup:
                lines.append("  setup: %s" % setup)
            artifacts = compact_artifact_names(meta.get("vmRunArtifactsJson") or meta.get("artifacts"), 1000)
            if artifacts:
                lines.append("  artifacts: %s" % artifacts)
    if important_older:
        lines.append("Important older same-session messages that may define goals/targets/results:")
        for item in important_older[-8:]:
            lines.append("- " + session_context_line(item, 900))
    return "\n".join(lines)

def session_context(session_id, current_id="", limit=24, content_limit=1200):
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
        if not non_progress_session_message(item):
            continue
        if excluded_from_main_context(item):
            continue
        messages.append(item)
    if not messages:
        return "(no earlier non-progress messages in this browser session)"
    recent_messages = messages[-limit:]
    lines = []
    digest = session_state_digest(messages, recent_messages)
    if digest:
        lines.append("[Same-session durable context summary]\n" + digest)
    lines.append("[Recent non-progress same-session messages, newest last]")
    for item in recent_messages:
        lines.append(session_context_line(item, content_limit))
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

def sha256_path(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()

def finite_number(value):
    try:
        return not math.isnan(float(value)) and not math.isinf(float(value))
    except Exception:
        return False

def postprocess_float(spec, key, default_value, minimum, maximum):
    raw = spec.get(key)
    if raw is None:
        return default_value
    try:
        value = float(raw)
    except Exception:
        raise ValueError("%s must be numeric" % key)
    if not finite_number(value) or value < minimum or value > maximum:
        raise ValueError("%s is outside the allowed range" % key)
    return value

def normalize_dfise_postprocess(spec):
    if not isinstance(spec, dict):
        raise ValueError("postprocess item must be an object")
    allowed_keys = set([
        "kind", "lowInput", "highInput", "expectedLowVd", "expectedHighVd",
        "biasToleranceV", "vthCurrentAperUm", "ssCurrentMinAperUm",
        "ssCurrentMaxAperUm", "minimumPointCount", "outputPrefix", "metricProfile",
    ])
    unknown = sorted([safe_text(key, 120) for key in spec.keys() if key not in allowed_keys])
    if unknown:
        raise ValueError("dfise-idvg-v1 contains unsupported field(s): %s" % ", ".join(unknown))
    if safe_text(spec.get("kind"), 80).strip() != "dfise-idvg-v1":
        raise ValueError("unsupported postprocess kind")
    low_input = safe_file_name(spec.get("lowInput"))
    high_input = safe_file_name(spec.get("highInput"))
    if os.path.splitext(low_input)[1].lower() != ".plt" or os.path.splitext(high_input)[1].lower() != ".plt":
        raise ValueError("dfise-idvg-v1 inputs must be .plt files")
    output_prefix = safe_text(spec.get("outputPrefix") or "idvg", 100).strip()
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$", output_prefix):
        raise ValueError("dfise-idvg-v1 outputPrefix is invalid")
    metric_profile = safe_text(spec.get("metricProfile") or DFISE_METRIC_PROFILE, 80).strip()
    if metric_profile != DFISE_METRIC_PROFILE:
        raise ValueError("unsupported metricProfile: %s" % metric_profile)
    minimum_points = int(postprocess_float(spec, "minimumPointCount", 20, 3, 100000))
    normalized = {
        "kind": "dfise-idvg-v1",
        "lowInput": low_input,
        "highInput": high_input,
        "expectedLowVd": postprocess_float(spec, "expectedLowVd", None, -1000, 1000),
        "expectedHighVd": postprocess_float(spec, "expectedHighVd", None, -1000, 1000),
        "biasToleranceV": postprocess_float(spec, "biasToleranceV", 1e-6, 1e-12, 1),
        "vthCurrentAperUm": postprocess_float(spec, "vthCurrentAperUm", 1e-7, 1e-30, 1e6),
        "ssCurrentMinAperUm": postprocess_float(spec, "ssCurrentMinAperUm", 1e-12, 1e-30, 1e6),
        "ssCurrentMaxAperUm": postprocess_float(spec, "ssCurrentMaxAperUm", 1e-7, 1e-30, 1e6),
        "minimumPointCount": minimum_points,
        "outputPrefix": output_prefix,
        "metricProfile": metric_profile,
    }
    if normalized["ssCurrentMinAperUm"] >= normalized["ssCurrentMaxAperUm"]:
        raise ValueError("ssCurrentMinAperUm must be lower than ssCurrentMaxAperUm")
    return normalized

def normalize_postprocess_request(request):
    values = request.get("postprocess") or []
    if not isinstance(values, list):
        raise ValueError("postprocess must be an array")
    if len(values) > 4:
        raise ValueError("run request has too many postprocess items")
    return [normalize_dfise_postprocess(item) for item in values]

def stage_postprocess_input(run_dir, session_id, name):
    target = os.path.abspath(os.path.join(run_dir, safe_file_name(name)))
    run_base = os.path.abspath(run_dir)
    if target != run_base and not target.startswith(run_base + os.sep):
        raise ValueError("postprocess input escapes run directory")
    if os.path.isfile(target):
        return target
    session_id = safe_text(session_id, 180).strip()
    if not session_id or not re.match(r"^run_[A-Za-z0-9_-]+$", session_id):
        raise ValueError("postprocess input is missing from the run and no valid session input is available: %s" % name)
    source_root = os.path.abspath(os.path.join(SESSION_OUTPUT_ROOT, session_id, "output", OUTPUT_CATEGORY_INPUT))
    source = os.path.abspath(os.path.join(source_root, safe_file_name(name)))
    if source != source_root and not source.startswith(source_root + os.sep):
        raise ValueError("postprocess session input escapes input category")
    if not os.path.isfile(source):
        raise ValueError("postprocess input does not exist: %s" % name)
    shutil.copy2(source, target)
    return target

def parse_last_json_line(text):
    for line in reversed(safe_text(text, 1000000).splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    return value
            except Exception:
                pass
    return None

def run_captured_process(args, cwd, timeout_seconds):
    started = time.time()
    proc = subprocess.Popen(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    timed_out = False
    while proc.poll() is None:
        if time.time() - started > timeout_seconds:
            timed_out = True
            try:
                proc.kill()
            except Exception:
                pass
            break
        time.sleep(0.1)
    stdout, stderr = proc.communicate()
    try:
        stdout = stdout.decode("utf-8", "replace")
    except AttributeError:
        pass
    try:
        stderr = stderr.decode("utf-8", "replace")
    except AttributeError:
        pass
    return {
        "exitCode": -1 if timed_out else proc.returncode,
        "timedOut": timed_out,
        "seconds": int(time.time() - started),
        "stdout": stdout or "",
        "stderr": stderr or "",
    }

def validate_dfise_success(run_dir, low_path, high_path, payload, request):
    if payload.get("status") != "ok":
        return False, safe_text(((payload.get("error") or {}).get("code") if isinstance(payload.get("error"), dict) else "") or "POSTPROCESS_INCOMPLETE", 120)
    if payload.get("metricProfile") != DFISE_METRIC_PROFILE:
        return False, "UNSUPPORTED_METRIC_PROFILE"
    if payload.get("extractorVersion") != DFISE_EXTRACTOR_VERSION:
        return False, "EXTRACTOR_VERSION_MISMATCH"
    metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
    required_metrics = ["vthLowV", "vthHighV", "ssLowMvPerDec", "ssHighMvPerDec", "diblMvPerV"]
    if not all(finite_number(metrics.get(key)) for key in required_metrics):
        return False, "NONFINITE_METRIC"
    for window_key, pair_key in [
        ("ssLowWindowPointCount", "ssLowAdjacentPairCount"),
        ("ssHighWindowPointCount", "ssHighAdjacentPairCount"),
    ]:
        if int(metrics.get(window_key) or 0) < DFISE_MIN_SS_WINDOW_POINTS or int(metrics.get(pair_key) or 0) < DFISE_MIN_SS_ADJACENT_PAIRS:
            return False, "SS_WINDOW_NOT_COVERED"
    inputs = payload.get("inputs") if isinstance(payload.get("inputs"), dict) else {}
    low = inputs.get("low") if isinstance(inputs.get("low"), dict) else {}
    high = inputs.get("high") if isinstance(inputs.get("high"), dict) else {}
    low_hash = sha256_path(low_path)
    high_hash = sha256_path(high_path)
    if low.get("sha256") != low_hash or high.get("sha256") != high_hash:
        return False, "INPUT_HASH_MISMATCH"
    minimum_points = int(request.get("minimumPointCount") or 20)
    if int(low.get("validPointCount") or 0) < minimum_points or int(high.get("validPointCount") or 0) < minimum_points:
        return False, "INSUFFICIENT_POINTS"
    tolerance = float(request.get("biasToleranceV") or 1e-6)
    for item, expected_key in [(low, "expectedLowVd"), (high, "expectedHighVd")]:
        expected = request.get(expected_key)
        if expected is not None:
            if not finite_number(item.get("actualVd")) or abs(float(item.get("actualVd")) - float(expected)) > tolerance:
                return False, "BIAS_MISMATCH"
    artifact_root = os.path.abspath(os.path.join(run_dir, "artifacts"))
    outputs = payload.get("outputs") if isinstance(payload.get("outputs"), dict) else {}
    required_outputs = {
        "csv": ".csv",
        "metricsJson": ".json",
        "metricsDat": ".dat",
        "report": ".txt",
        "plot": ".png",
    }
    resolved_outputs = {}
    for key, expected_ext in required_outputs.items():
        output_path = os.path.abspath(safe_text(outputs.get(key), 1000))
        if output_path == artifact_root or not output_path.startswith(artifact_root + os.sep):
            return False, "OUTPUT_PATH_INVALID"
        if os.path.splitext(output_path)[1].lower() != expected_ext:
            return False, "OUTPUT_PATH_INVALID"
        if not os.path.isfile(output_path) or os.path.getsize(output_path) <= 0:
            return False, "OUTPUT_MISSING"
        resolved_outputs[key] = output_path
    try:
        with open(resolved_outputs["metricsJson"], "rb") as handle:
            metrics_file = json.load(handle)
        if metrics_file.get("status") != "ok":
            return False, "POSTPROCESS_INCOMPLETE"
        file_inputs = metrics_file.get("inputs") if isinstance(metrics_file.get("inputs"), dict) else {}
        file_low = file_inputs.get("low") if isinstance(file_inputs.get("low"), dict) else {}
        file_high = file_inputs.get("high") if isinstance(file_inputs.get("high"), dict) else {}
        if file_low.get("sha256") != low_hash or file_high.get("sha256") != high_hash:
            return False, "INPUT_HASH_MISMATCH"
        file_metrics = metrics_file.get("metrics") if isinstance(metrics_file.get("metrics"), dict) else {}
        for key in required_metrics:
            if not finite_number(file_metrics.get(key)):
                return False, "NONFINITE_METRIC"
            expected = float(metrics.get(key))
            actual = float(file_metrics.get(key))
            if abs(actual - expected) > max(1e-12, abs(expected) * 1e-12):
                return False, "METRICS_OUTPUT_MISMATCH"
        with open(resolved_outputs["csv"], "rb") as handle:
            csv_text = handle.read().decode("utf-8", "replace")
        csv_lines = [line for line in csv_text.splitlines() if line.strip()]
        if not csv_lines or csv_lines[0].strip() != "Vg_V,Id_low_A_per_um,Id_high_A_per_um,Vd_low_V,Vd_high_V":
            return False, "CSV_OUTPUT_INVALID"
        if len(csv_lines) - 1 < minimum_points:
            return False, "CSV_OUTPUT_INCOMPLETE"
        with open(resolved_outputs["report"], "rb") as handle:
            report_text = handle.read().decode("utf-8", "replace")
        if ("low.sha256=%s" % low_hash) not in report_text or ("high.sha256=%s" % high_hash) not in report_text:
            return False, "INPUT_HASH_MISMATCH"
    except Exception:
        return False, "OUTPUT_VALIDATION_FAILED"
    return True, ""

def run_dfise_postprocess(run_dir, session_id, spec, index, timeout_seconds=120):
    normalized = normalize_dfise_postprocess(spec)
    low_path = stage_postprocess_input(run_dir, session_id, normalized["lowInput"])
    high_path = stage_postprocess_input(run_dir, session_id, normalized["highInput"])
    if not os.path.isfile(DFISE_EXTRACTOR_PATH):
        raise ValueError("fixed DF-ISE extractor is not deployed")
    extractor_hash = sha256_path(DFISE_EXTRACTOR_PATH)
    if extractor_hash != DFISE_EXTRACTOR_SHA256:
        raise ValueError("fixed DF-ISE extractor hash mismatch")
    version_result = run_captured_process([sys.executable or "python", DFISE_EXTRACTOR_PATH, "--version"], run_dir, 10)
    if version_result.get("exitCode") != 0 or safe_text(version_result.get("stdout"), 200).strip() != DFISE_EXTRACTOR_VERSION:
        raise ValueError("fixed DF-ISE extractor version mismatch")
    output_prefix = os.path.join(run_dir, "artifacts", normalized["outputPrefix"])
    args = [
        sys.executable or "python", DFISE_EXTRACTOR_PATH,
        "--low", low_path,
        "--high", high_path,
        "--bias-tolerance", repr(normalized["biasToleranceV"]),
        "--vth-current", repr(normalized["vthCurrentAperUm"]),
        "--ss-current-min", repr(normalized["ssCurrentMinAperUm"]),
        "--ss-current-max", repr(normalized["ssCurrentMaxAperUm"]),
        "--min-points", str(normalized["minimumPointCount"]),
        "--metric-profile", normalized["metricProfile"],
        "--output-prefix", output_prefix,
        "--stdout-json",
    ]
    if normalized["expectedLowVd"] is not None:
        args.extend(["--expected-low-vd", repr(normalized["expectedLowVd"])])
    if normalized["expectedHighVd"] is not None:
        args.extend(["--expected-high-vd", repr(normalized["expectedHighVd"])])
    process = run_captured_process(args, run_dir, timeout_seconds)
    payload = parse_last_json_line(process.get("stdout"))
    semantic_status = safe_text((payload or {}).get("status"), 80) or "failed"
    error_payload = (payload or {}).get("error") if isinstance((payload or {}).get("error"), dict) else {}
    error_code = safe_text(error_payload.get("code"), 120)
    output_success, validation_error = validate_dfise_success(run_dir, low_path, high_path, payload or {}, normalized)
    success = process.get("exitCode") == 0 and not process.get("timedOut") and output_success
    if not success and not error_code:
        if process.get("timedOut"):
            error_code = "POSTPROCESS_TIMEOUT"
        elif process.get("exitCode") != 0:
            error_code = validation_error or "POSTPROCESS_FAILED"
        else:
            error_code = validation_error or "POSTPROCESS_FAILED"
    outputs = {}
    for key, value in (((payload or {}).get("outputs") or {}).items() if isinstance((payload or {}).get("outputs"), dict) else []):
        output_path = os.path.abspath(safe_text(value, 1000))
        if output_path.startswith(os.path.abspath(run_dir) + os.sep):
            outputs[key] = os.path.relpath(output_path, run_dir)
    if success:
        result_status = "ok"
    elif semantic_status in ["incomplete", "invalid-input"]:
        result_status = semantic_status
    elif error_code in ["INSUFFICIENT_POINTS", "NO_VALID_POINTS", "NONFINITE_METRIC", "SS_WINDOW_NOT_COVERED", "VTH_NOT_COVERED"]:
        result_status = "incomplete"
    elif error_code in ["BIAS_MISMATCH", "BIAS_ORDER_INVALID", "DATASET_NOT_FOUND", "INVALID_ARGUMENT", "MALFORMED_DATA_BLOCK", "UNSUPPORTED_METRIC_PROFILE", "UNSUPPORTED_SS_METHOD"]:
        result_status = "invalid-input"
    else:
        result_status = "failed"
    return {
        "kind": "dfise-idvg-v1",
        "index": index,
        "status": result_status,
        "exitCode": process.get("exitCode"),
        "timedOut": bool(process.get("timedOut")),
        "seconds": process.get("seconds"),
        "stdoutTail": safe_text(process.get("stdout"), 4000),
        "stderrTail": safe_text(process.get("stderr"), 4000),
        "errorCode": error_code or None,
        "errorMessage": safe_text(error_payload.get("message"), 500) or None,
        "extractorVersion": (payload or {}).get("extractorVersion") or DFISE_EXTRACTOR_VERSION,
        "extractorSha256": extractor_hash,
        "metricProfile": (payload or {}).get("metricProfile") or DFISE_METRIC_PROFILE,
        "inputs": (payload or {}).get("inputs"),
        "metrics": (payload or {}).get("metrics"),
        "outputs": outputs,
        "request": normalized,
    }

def collect_run_artifacts(run_dir, limit=80):
    allowed = set([".log", ".out", ".err", ".plt", ".tdr", ".grd", ".dat", ".csv", ".txt", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".json", ".cmd", ".des", ".par", ".scm", ".tcl", ".bnd", ".sat", ".md", ".rst", ".sde"])
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
    if ext in [".plt", ".tdr", ".grd", ".dat", ".csv", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bnd", ".sat"]:
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

READABLE_ATTACHMENT_EXTENSIONS = set([".txt", ".md", ".rst", ".log", ".out", ".err", ".csv", ".json", ".cmd", ".des", ".par", ".scm", ".tcl", ".sde", ".dat", ".plt", ".svg"])
BINARY_ATTACHMENT_EXTENSIONS = set([".tdr", ".grd", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf", ".bnd", ".sat"])
MAX_ATTACHMENT_READ_BYTES = 256 * 1024
MAX_ATTACHMENT_CONTEXT_CHARS = 600000
IMAGE_EXTENSIONS = set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"])
SESSION_FILE_EXTENSIONS = READABLE_ATTACHMENT_EXTENSIONS | BINARY_ATTACHMENT_EXTENSIONS

def content_type_for_ext(ext):
    if ext == ".png":
        return "image/png"
    if ext in [".jpg", ".jpeg"]:
        return "image/jpeg"
    if ext == ".webp":
        return "image/webp"
    if ext == ".gif":
        return "image/gif"
    if ext == ".svg":
        return "image/svg+xml"
    if ext == ".csv":
        return "text/csv"
    if ext in [".txt", ".md", ".rst", ".log", ".out", ".err", ".cmd", ".des", ".par", ".scm", ".tcl", ".sde", ".dat", ".plt"]:
        return "text/plain"
    if ext == ".json":
        return "application/json"
    if ext == ".pdf":
        return "application/pdf"
    return "application/octet-stream"

def display_attachments_for_artifacts(run_id, artifacts, limit=12):
    result = []
    run_id = safe_text(run_id, 180).strip()
    for item in artifacts or []:
        rel = safe_text(item.get("path"), 500).replace("\\", "/")
        ext = os.path.splitext(rel)[1].lower()
        if ext not in SESSION_FILE_EXTENSIONS:
            continue
        name = os.path.basename(rel)
        kind = "image" if ext in IMAGE_EXTENSIONS else "file"
        result.append({
            "id": safe_text(("artifact_%s_%s" % (run_id, rel)).replace("/", "_"), 180),
            "kind": kind,
            "name": name,
            "size": int(item.get("size") or 0),
            "contentType": content_type_for_ext(ext),
            "source": "vm-run-artifact",
            "path": rel,
            "runId": run_id,
        })
    return result[:limit]

def extract_vm_session_files(reply):
    start_tag = "<VM_SESSION_FILE>"
    end_tag = "</VM_SESSION_FILE>"
    specs = []
    visible = safe_text(reply, 20000)
    while True:
        start = visible.find(start_tag)
        end = visible.find(end_tag, start + len(start_tag)) if start >= 0 else -1
        if start < 0 or end < 0:
            break
        body = visible[start + len(start_tag):end].strip()
        try:
            payload = json.loads(body)
            if isinstance(payload, dict):
                specs.append(payload)
        except Exception as exc:
            audit("vm_session_file_parse_failed", {"error": safe_text(str(exc), 400), "body": safe_text(body, 500)})
        visible = (visible[:start] + visible[end + len(end_tag):]).strip()
    return specs, visible

def normalize_session_file_category(value):
    raw = safe_text(value, 120).strip()
    lowered = raw.lower()
    aliases = {
        "device structure": OUTPUT_CATEGORY_RESULTS,
        "structure": OUTPUT_CATEGORY_RESULTS,
        "structure image": OUTPUT_CATEGORY_RESULTS,
        "simulation image": OUTPUT_CATEGORY_RESULTS,
        "image": OUTPUT_CATEGORY_RESULTS,
        "plot": OUTPUT_CATEGORY_RESULTS,
        "result": OUTPUT_CATEGORY_RESULTS,
        "results": OUTPUT_CATEGORY_RESULTS,
        "png": OUTPUT_CATEGORY_RESULTS,
        "jpg": OUTPUT_CATEGORY_RESULTS,
        "jpeg": OUTPUT_CATEGORY_RESULTS,
        "webp": OUTPUT_CATEGORY_RESULTS,
        "gif": OUTPUT_CATEGORY_RESULTS,
    }
    categories = [OUTPUT_CATEGORY_INPUT, OUTPUT_CATEGORY_RESULTS, OUTPUT_CATEGORY_LOGS, OUTPUT_CATEGORY_PARAMS, OUTPUT_CATEGORY_OTHER]
    if raw in categories:
        return raw
    return aliases.get(lowered) or aliases.get(raw) or OUTPUT_CATEGORY_RESULTS

def safe_source_file_path(path):
    path = safe_text(path, 1200).strip()
    if not path:
        raise ValueError("sourcePath is required")
    source = os.path.abspath(os.path.expanduser(path))
    stdb_root = os.path.abspath(os.path.join(HOME, "STDB"))
    if source != stdb_root and not source.startswith(stdb_root + os.sep):
        raise ValueError("sourcePath must stay under ~/STDB")
    if not os.path.isfile(source):
        raise ValueError("sourcePath does not exist")
    ext = os.path.splitext(source)[1].lower()
    if ext not in SESSION_FILE_EXTENSIONS:
        raise ValueError("sourcePath extension is not allowlisted")
    return source

def safe_generated_file_name(value, default_name="generated.png"):
    name = safe_file_name(value or default_name)
    ext = os.path.splitext(name)[1].lower()
    if ext not in SESSION_FILE_EXTENSIONS:
        raise ValueError("published file extension is not allowlisted")
    return name

def image_bytes_from_session_file_spec(spec):
    content_b64 = spec.get("contentBase64") or spec.get("contentB64")
    if content_b64:
        encoded = safe_text(content_b64, 12 * 1024 * 1024).strip()
        if encoded.startswith("data:") and "," in encoded:
            encoded = encoded.split(",", 1)[1]
        encoded = "".join(encoded.split())
        encoded = encoded.replace("-", "+").replace("_", "/")
        try:
            encoded_bytes = encoded.encode("ascii") if not isinstance(encoded, str) else encoded
        except Exception:
            raise ValueError("contentBase64 contains non-ASCII characters")
        missing_padding = len(encoded_bytes) % 4
        if missing_padding:
            encoded_bytes += "=" * (4 - missing_padding)
        try:
            data = base64.decodestring(encoded_bytes)
        except Exception:
            try:
                data = base64.b64decode(encoded_bytes)
            except Exception:
                try:
                    data = base64.urlsafe_b64decode(encoded_bytes)
                except Exception:
                    raise ValueError("contentBase64 is not valid base64")
        if len(data) > 8 * 1024 * 1024:
            raise ValueError("contentBase64 image is too large")
        return data

    content = spec.get("content")
    if isinstance(content, string_types):
        text = safe_text(content, 2 * 1024 * 1024)
        if text.lstrip().startswith("<svg"):
            return text.encode("utf-8")
    return None

def validate_image_bytes(name, data):
    ext = os.path.splitext(name)[1].lower()
    if ext == ".png" and not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("contentBase64 does not contain a PNG image")
    if ext in [".jpg", ".jpeg"] and not data.startswith(b"\xff\xd8"):
        raise ValueError("contentBase64 does not contain a JPEG image")
    if ext == ".webp" and not (data.startswith(b"RIFF") and data[8:12] == b"WEBP"):
        raise ValueError("contentBase64 does not contain a WebP image")
    if ext == ".gif" and not (data.startswith(b"GIF87a") or data.startswith(b"GIF89a")):
        raise ValueError("contentBase64 does not contain a GIF image")
    if ext == ".svg" and not data.lstrip().startswith(b"<svg"):
        raise ValueError("content does not contain an SVG image")

def resolve_run_artifact_path(spec):
    run_id = safe_text(spec.get("runId") or spec.get("vmRunId"), 180).strip()
    artifact_path = safe_text(spec.get("artifactPath") or spec.get("artifact_path"), 500).strip()
    if not run_id or not artifact_path:
        return None
    if not re.match(r"^run_[A-Za-z0-9_-]+$", run_id):
        raise ValueError("runId is invalid")
    parts = safe_artifact_rel_parts(artifact_path)
    source = os.path.abspath(os.path.join(RUNS_DIR, run_id, *parts))
    run_dir = os.path.abspath(os.path.join(RUNS_DIR, run_id))
    if source != run_dir and not source.startswith(run_dir + os.sep):
        raise ValueError("artifactPath escapes run directory")
    if not os.path.isfile(source):
        raise ValueError("artifactPath does not exist")
    ext = os.path.splitext(source)[1].lower()
    if ext not in SESSION_FILE_EXTENSIONS:
        raise ValueError("artifactPath extension is not allowlisted")
    return source

def publish_vm_session_file(session_id, spec):
    session_id = safe_text(session_id, 180).strip()
    if not session_id or not re.match(r"^run_[A-Za-z0-9_-]+$", session_id):
        raise ValueError("sessionId is required to publish a VM session file")
    generated_bytes = image_bytes_from_session_file_spec(spec)
    artifact_source = resolve_run_artifact_path(spec)
    source_path_value = spec.get("sourcePath") or spec.get("path") or ""
    source = artifact_source or (None if generated_bytes is not None else safe_source_file_path(source_path_value))
    default_name = os.path.basename(source) if source else "generated.png"
    name = safe_generated_file_name(spec.get("name") or default_name)
    ext = os.path.splitext(name)[1].lower()
    category = normalize_session_file_category(spec.get("category"))
    category_dir = os.path.abspath(os.path.join(SESSION_OUTPUT_ROOT, session_id, "output", category))
    ensure_dir(category_dir)
    target = os.path.abspath(os.path.join(category_dir, name))
    if target == category_dir or not target.startswith(category_dir + os.sep):
        raise ValueError("published file escapes output category")
    if generated_bytes is not None:
        if ext in IMAGE_EXTENSIONS:
            validate_image_bytes(name, generated_bytes)
        with open(target, "wb") as handle:
            handle.write(generated_bytes)
    else:
        shutil.copy2(source, target)
    size = os.path.getsize(target)
    return {
        "id": safe_text(("vm_session_%s_%s_%s" % (session_id, category, name)).replace("/", "_").replace(" ", "_"), 180),
        "kind": "image" if ext in IMAGE_EXTENSIONS else "file",
        "name": name,
        "size": size,
        "contentType": content_type_for_ext(ext),
        "source": "vm-session-file",
        "path": name,
        "runId": session_id,
        "category": category,
    }

def safe_attachment_rel_parts(rel_path):
    parts = safe_text(rel_path, 500).replace("\\", "/").split("/")
    clean = []
    for part in parts:
        part = safe_text(part, 180).strip()
        if not part or part in [".", ".."] or part.startswith(".") or ".." in part:
            raise ValueError("invalid attachment path")
        if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._@()+, -]{0,159}$", part):
            raise ValueError("attachment path contains unsupported characters")
        clean.append(part)
    if not clean:
        raise ValueError("empty attachment path")
    return clean

def attachment_abs_path(session_id, ref):
    source = safe_text(ref.get("source"), 60).strip()
    rel_path = safe_text(ref.get("path"), 500).replace("\\", "/")
    parts = safe_attachment_rel_parts(rel_path)
    if source in ["vm-session-file", "run-input"]:
        category = safe_text(ref.get("category") or OUTPUT_CATEGORY_INPUT, 180).strip()
        if category not in [OUTPUT_CATEGORY_INPUT, OUTPUT_CATEGORY_RESULTS, OUTPUT_CATEGORY_LOGS, OUTPUT_CATEGORY_PARAMS, OUTPUT_CATEGORY_OTHER]:
            raise ValueError("unsupported session output category")
        if not session_id or not re.match(r"^run_[A-Za-z0-9_-]+$", session_id):
            raise ValueError("invalid session id for session attachment")
        base = os.path.abspath(os.path.join(SESSION_OUTPUT_ROOT, session_id, "output", category))
        target = os.path.abspath(os.path.join(base, *parts))
        if target != base and target.startswith(base + os.sep):
            return target
        raise ValueError("attachment path escapes session output category")
    if source == "vm-run-artifact":
        run_id = safe_text(ref.get("runId"), 180).strip()
        if not re.match(r"^run_[A-Za-z0-9_-]+$", run_id):
            raise ValueError("invalid artifact run id")
        base = os.path.abspath(os.path.join(RUNS_DIR, run_id))
        target = os.path.abspath(os.path.join(base, *parts))
        if target != base and target.startswith(base + os.sep):
            return target
        raise ValueError("attachment path escapes run artifact directory")
    raise ValueError("unsupported attachment source")

def read_attachment_text(path):
    ext = os.path.splitext(path)[1].lower()
    size = os.path.getsize(path)
    if ext in BINARY_ATTACHMENT_EXTENSIONS:
        return "", {"binary": True, "size": size, "ext": ext}
    if ext not in READABLE_ATTACHMENT_EXTENSIONS:
        return "", {"skipped": "extension not readable", "size": size, "ext": ext}
    with open(path, "rb") as handle:
        raw = handle.read(min(size, MAX_ATTACHMENT_READ_BYTES))
    text = raw.decode("utf-8", "replace") if sys.version_info[0] >= 3 else raw.decode("utf-8", "replace")
    if size > MAX_ATTACHMENT_READ_BYTES:
        text += "\n[truncated after %s bytes]" % MAX_ATTACHMENT_READ_BYTES
    return text, {"binary": False, "size": size, "ext": ext}

def attachment_context(session_id, attachments):
    if not isinstance(attachments, list) or not attachments:
        return "", []
    chunks = []
    summaries = []
    used = 0
    for index, ref in enumerate(attachments[:8], 1):
        if not isinstance(ref, dict):
            continue
        name = safe_text(ref.get("name") or ref.get("path") or ("attachment-%s" % index), 180)
        source = safe_text(ref.get("source"), 60)
        status = safe_text(ref.get("contextStatus") or "vm_path", 80)
        inline_text = safe_text(ref.get("inlineText"), MAX_ATTACHMENT_CONTEXT_CHARS)
        if inline_text:
            truncated = bool(ref.get("inlineTextTruncated"))
            summaries.append({
                "name": name,
                "path": safe_text(ref.get("path"), 500),
                "source": source,
                "contextStatus": status or "inline",
                "inline": True,
                "size": len(inline_text),
                "truncated": truncated,
            })
            if used < MAX_ATTACHMENT_CONTEXT_CHARS:
                remaining = MAX_ATTACHMENT_CONTEXT_CHARS - used
                clipped = inline_text[:remaining]
                used += len(clipped)
                chunks.append("### %s\nsource: %s\nstatus: %s\ntruncated: %s\n\n--- begin attachment text ---\n%s\n--- end attachment text ---" % (name, source, status or "inline", "true" if truncated else "false", clipped))
            continue
        try:
            vm_path = safe_text(ref.get("vmPath"), 800)
            path = vm_path if vm_path else attachment_abs_path(session_id, ref)
            if not os.path.isfile(path):
                raise ValueError("file not found")
            text, info = read_attachment_text(path)
            rel = safe_text(ref.get("path"), 500)
            file_status = "vm_path" if text else "metadata_only"
            summaries.append({"name": name, "path": rel, "source": source, "contextStatus": file_status, "size": info.get("size"), "binary": bool(info.get("binary")), "skipped": info.get("skipped"), "synced": bool(text)})
            if text and used < MAX_ATTACHMENT_CONTEXT_CHARS:
                remaining = MAX_ATTACHMENT_CONTEXT_CHARS - used
                clipped = text[:remaining]
                used += len(clipped)
                chunks.append("### %s\nsource: %s\nstatus: vm_path\npath: %s\ntruncated: %s\n\n--- begin attachment text ---\n%s\n--- end attachment text ---" % (name, source, rel, "true" if len(text) > len(clipped) else "false", clipped))
        except Exception as exc:
            summaries.append({
                "name": name,
                "path": safe_text(ref.get("path"), 500),
                "source": source,
                "contextStatus": safe_text(ref.get("contextStatus") or "not_found", 80),
                "error": safe_text(ref.get("inlineError") or str(exc), 300),
            })
    if not chunks and summaries:
        chunks.append("### Attachment diagnostics\n--- begin attachment diagnostics json ---\n%s\n--- end attachment diagnostics json ---" % json.dumps(summaries, ensure_ascii=True, sort_keys=True))
    return "[Attachment context]\n\n" + "\n\n".join(chunks), summaries

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

def unicode_text(value, limit=6000):
    text = safe_text(value, limit)
    if sys.version_info[0] < 3:
        try:
            if isinstance(text, str):
                return text.decode("utf-8", "replace")
        except Exception:
            pass
    return text

def estimate_context_tokens(value):
    text = unicode_text(value, 2000000)
    ascii_count = 0
    non_ascii_count = 0
    for char in text:
        try:
            code = ord(char)
        except Exception:
            code = 128
        if code < 128:
            ascii_count += 1
        else:
            non_ascii_count += 1
    return int(math.ceil(ascii_count / 4.0 + non_ascii_count))

def fit_text_to_token_budget(value, token_budget, marker):
    text = unicode_text(value, 2000000)
    token_budget = max(0, int(token_budget or 0))
    if estimate_context_tokens(text) <= token_budget:
        return text
    marker = unicode_text(marker, 1000)
    low = 0
    high = len(text)
    while low < high:
        middle = (low + high + 1) // 2
        candidate = text[:middle] + marker
        if estimate_context_tokens(candidate) <= token_budget:
            low = middle
        else:
            high = middle - 1
    return text[:low] + marker

def lowered_text(value, limit=6000):
    try:
        return unicode_text(value, limit).lower()
    except Exception:
        return u""

def preview_run_steps(run_request):
    if not isinstance(run_request, dict):
        return []
    steps = run_request.get("steps")
    if not isinstance(steps, list) or not steps:
        tool = safe_text(run_request.get("tool"), 40).strip().lower()
        entry = run_request.get("entryFile") or run_request.get("input")
        if tool and entry:
            steps = [{"tool": tool, "input": entry}]
    allowed = set(["sde", "sprocess", "sdevice", "inspect"])
    result = []
    if isinstance(steps, list):
        for step in steps:
            if not isinstance(step, dict):
                continue
            tool = safe_text(step.get("tool"), 40).strip().lower()
            entry = safe_text(step.get("input") or step.get("entry") or step.get("entryFile"), 180).strip()
            if tool in allowed and entry:
                result.append({"tool": tool, "input": entry})
    return result

def preview_run_postprocess(run_request):
    if not isinstance(run_request, dict):
        return []
    values = run_request.get("postprocess")
    if not isinstance(values, list):
        return []
    result = []
    for item in values:
        if isinstance(item, dict) and safe_text(item.get("kind"), 80).strip() == "dfise-idvg-v1":
            result.append(item)
    return result

def run_request_file_summary(run_request, limit=12000):
    if not isinstance(run_request, dict):
        return u""
    parts = []
    files = run_request.get("files")
    if isinstance(files, list):
        for item in files:
            if not isinstance(item, dict):
                continue
            parts.append(unicode_text(item.get("name"), 200))
            parts.append(unicode_text(item.get("content"), max(1000, limit // 3)))
            if len(u"\n".join(parts)) > limit:
                break
    return lowered_text(u"\n".join(parts), limit)

def run_request_file_count(run_request):
    if not isinstance(run_request, dict):
        return 0
    files = run_request.get("files")
    if not isinstance(files, list):
        return 0
    return len([item for item in files if isinstance(item, dict) and safe_text(item.get("content"), 200).strip()])

def contains_any(text, phrases):
    return any(phrase and phrase in text for phrase in phrases)

def has_future_work_promise(visible_reply):
    text = lowered_text(visible_reply, 8000)
    phrases = [
        "will continue", "i will continue", "i'll continue", "after that i will",
        "then i will", "next i will", "follow up", "continue with", "later i will",
        "next step", "then run", "then execute", "after that",
        u"\u7ee7\u7eed", u"\u4e0b\u4e00\u6b65", u"\u4e4b\u540e", u"\u7136\u540e",
        u"\u540e\u7eed", u"\u518d\u8fd0\u884c", u"\u968f\u540e\u8fd0\u884c",
    ]
    return contains_any(text, phrases)

def user_requested_final_data(user_text):
    text = lowered_text(user_text, 8000)
    phrases = [
        "extract", "result", "curve", "final", "complete", "plot", "plt", "csv",
        "id-vg", "idvg", "sdevice", "simulation result",
        u"\u8f93\u51fa", u"\u7ed3\u679c", u"\u66f2\u7ebf", u"\u63d0\u53d6",
        u"\u6570\u636e", u"\u6700\u7ec8", u"\u5b8c\u6574", u"\u4eff\u771f",
    ]
    return contains_any(text, phrases)

def validate_run_request_against_reply(user_text, visible_reply, run_request):
    if not run_request:
        return None
    postprocess = preview_run_postprocess(run_request)
    if run_request_file_count(run_request) == 0 and not postprocess:
        return "Run request contains no complete input file content."
    steps = preview_run_steps(run_request)
    if not steps and not postprocess:
        return "Run request contains no executable Sentaurus tool step or fixed postprocess."
    tool_set = set([step.get("tool") for step in steps if step.get("tool")])
    visible = lowered_text(visible_reply, 10000)
    file_text = run_request_file_summary(run_request, 16000)
    future_promise = has_future_work_promise(visible_reply)
    user_wants_result = user_requested_final_data(user_text)
    missing = []

    visible_mentions_sdevice = contains_any(visible, ["sdevice", "id-vg", "idvg", "device simulation", "drain sweep", "gate sweep"])
    if visible_mentions_sdevice and "sdevice" not in tool_set:
        missing.append("sdevice")

    visible_mentions_extract = contains_any(visible, [
        "inspect", "csv", ".csv", ".plt", "extract", "curve", "result", "data extraction",
        u"\u63d0\u53d6", u"\u66f2\u7ebf", u"\u6570\u636e", u"\u7ed3\u679c",
    ])
    if visible_mentions_extract and "inspect" not in tool_set and "sdevice" not in tool_set and not postprocess:
        missing.append("inspect/extraction")

    steps_only_sde = bool(steps) and all(step.get("tool") == "sde" for step in steps)
    file_mentions_later_sdevice = contains_any(file_text, ["sdevice", "id-vg", "idvg", "inspect"])
    if steps_only_sde and not postprocess and user_wants_result and (future_promise or visible_mentions_sdevice or file_mentions_later_sdevice):
        missing.append("complete device/extraction flow")

    if missing:
        unique_missing = []
        for item in missing:
            if item not in unique_missing:
                unique_missing.append(item)
        return (
            "Refusing to execute an incomplete Sentaurus run request: the visible reply promises future work "
            "or final extracted data, but the JSON run request does not include the required step(s): %s. "
            "A run request is atomic; include every required SDE/SProcess/SDevice/Inspect step now, or ask for missing assumptions without emitting a run request."
        ) % ", ".join(unique_missing)

    if future_promise and user_wants_result and not postprocess and "sdevice" not in tool_set and "inspect" not in tool_set and "sprocess" not in tool_set:
        return (
            "Refusing to execute a preliminary-only Sentaurus run request after a final-result request. "
            "Do not promise autonomous continuation outside the JSON block; emit a complete workflow or ask for missing assumptions."
        )
    return None

def run_request_validation_error(run_request, visible_reply, user_text):
    return validate_run_request_against_reply(user_text, visible_reply, run_request) or ""

def format_validation_rejection(error_text, visible_reply=""):
    lines = []
    if visible_reply:
        lines.append(safe_text(visible_reply, 1600))
        lines.append("")
    lines.append("I did not start Sentaurus because the generated run request was incomplete.")
    lines.append("- validation: %s" % safe_text(error_text, 500))
    lines.append("- next step: provide the missing deck/files/assumptions, or ask me to create a complete self-contained SDE/SDevice/Inspect flow.")
    return "\n".join(lines)

def build_validation_repair_prompt(user_text, original_reply, validation_error):
    return "\n".join([
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
        "If you can produce a complete self-contained executable flow, include exactly one complete <SENTAURUS_RUN_REQUEST> JSON block with every file content and every required ordered step.",
        "If the flow still needs missing files, geometry, bias, physics assumptions, simulation steps, or extraction steps, do not include any run request; ask for the missing information instead.",
        "Do not promise to run or extract later unless those steps are included in the same run request.",
    ])

def repair_run_request_reply(user_text, original_reply, validation_error, session_id="", current_message_id=""):
    config = load_config()
    if not llm_configured(config):
        return None, {"kind": "run_request_validation_error", "llmConfigured": False}
    repair_prompt = build_validation_repair_prompt(user_text, original_reply, validation_error)
    try:
        reply, meta = run_with_timeout(LLM_HARD_TIMEOUT_SECONDS, "VM agent run-request repair", call_llm, repair_prompt, config, session_id, current_message_id)
        meta["kind"] = "llm"
        meta["runRequestRepair"] = True
        meta["validationError"] = safe_text(validation_error, 1000)
        return reply, meta
    except Exception as exc:
        return None, {"kind": "run_request_validation_error", "llmConfigured": True, "error": safe_text(str(exc), 1000), "validationError": safe_text(validation_error, 1000)}

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
    for key in ["deviceType", "gateBias", "drainBias", "sourceBulk", "geometry", "dopingOrImplant", "physicsModels", "mesh", "temperature", "notes", "extractorVersion", "metricProfile", "postprocessStatus", "postprocessErrorCode"]:
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
    input_hashes = value.get("inputHashes")
    if isinstance(input_hashes, dict):
        clean_hashes = {}
        for key, item in input_hashes.items():
            name = setup_text(key, 120)
            digest = setup_text(item, 128)
            if name and digest and re.match(r"^[a-fA-F0-9]{64}$", digest):
                clean_hashes[name] = digest.lower()
        if clean_hashes:
            setup["inputHashes"] = clean_hashes
    actual_biases = value.get("actualBiases")
    if isinstance(actual_biases, dict):
        clean_biases = {}
        for key in ["lowVd", "highVd"]:
            if finite_number(actual_biases.get(key)):
                clean_biases[key] = float(actual_biases.get(key))
        if clean_biases:
            setup["actualBiases"] = clean_biases
    setup["updatedAt"] = setup_text(value.get("updatedAt"), 80) or now_iso()
    setup["updatedBy"] = "vm-agent"
    return setup

def enrich_setup_from_postprocess(setup, result):
    setup = dict(setup or {})
    values = result.get("postprocessResults") or []
    if not values:
        return setup
    item = values[-1]
    setup["extractorVersion"] = safe_text(item.get("extractorVersion") or DFISE_EXTRACTOR_VERSION, 120)
    setup["metricProfile"] = safe_text(item.get("metricProfile") or DFISE_METRIC_PROFILE, 120)
    setup["postprocessStatus"] = safe_text(item.get("status") or "failed", 80)
    if item.get("errorCode"):
        setup["postprocessErrorCode"] = safe_text(item.get("errorCode"), 120)
    inputs = item.get("inputs") if isinstance(item.get("inputs"), dict) else {}
    hashes = {}
    biases = {}
    for label, bias_key in [("low", "lowVd"), ("high", "highVd")]:
        input_item = inputs.get(label) if isinstance(inputs.get(label), dict) else {}
        if input_item.get("sha256"):
            hashes[label] = safe_text(input_item.get("sha256"), 128)
        if finite_number(input_item.get("actualVd")):
            biases[bias_key] = float(input_item.get("actualVd"))
    if hashes:
        setup["inputHashes"] = hashes
    if biases:
        setup["actualBiases"] = biases
    setup["updatedAt"] = now_iso()
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
    postprocess = preview_run_postprocess(request)
    if postprocess:
        setup["extractorVersion"] = DFISE_EXTRACTOR_VERSION
        setup["metricProfile"] = DFISE_METRIC_PROFILE
        setup["postprocessStatus"] = "pending"
    for key in ["gateBias", "drainBias", "sourceBulk", "geometry", "dopingOrImplant", "physicsModels", "mesh", "temperature"]:
        value = setup_text(request.get(key), 500)
        if value:
            setup[key] = value
    return setup

def execute_run_request(request, session_id="", turn_id_value=""):
    ensure_dir(RUNS_DIR)
    title = safe_text(request.get("title") or session_id or "sentaurus-job", 120)
    run_id = "run_%s_%s_%s" % (datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"), safe_run_slug(title), uuid.uuid4().hex[:6])
    run_dir = os.path.join(RUNS_DIR, run_id)
    if not os.path.abspath(run_dir).startswith(os.path.abspath(RUNS_DIR) + os.sep):
        raise ValueError("refusing unsafe run directory")
    ensure_dir(run_dir)
    ensure_dir(os.path.join(run_dir, "logs"))
    ensure_dir(os.path.join(run_dir, "artifacts"))
    append_worklog(session_id, turn_id_value, "file", "Creating this Sentaurus run directory and writing deck files returned by the model.", run_id)
    postprocess = normalize_postprocess_request(request)
    files = request.get("files") or []
    if not isinstance(files, list):
        raise ValueError("run request files must be an array")
    if not files and not postprocess:
        raise ValueError("run request requires files or fixed postprocess inputs")
    if len(files) > 30:
        raise ValueError("run request has too many files")
    total_chars = 0
    allowed_ext = set([".cmd", ".des", ".par", ".scm", ".tcl", ".txt", ".dat", ".plt"])
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
        append_file_operation(session_id, turn_id_value, "created", name, OUTPUT_CATEGORY_PARAMS, len(content), run_id)
    steps = request.get("steps") or []
    if not isinstance(steps, list) or not steps:
        tool = safe_text(request.get("tool"), 40).strip().lower()
        entry = request.get("entryFile") or request.get("input")
        if tool and entry:
            steps = [{"tool": tool, "input": entry}]
    if not isinstance(steps, list):
        raise ValueError("run request steps must be an array")
    if not steps and not postprocess:
        raise ValueError("run request requires steps or postprocess")
    if len(steps) > 8:
        raise ValueError("run request has too many steps")
    manifest = {
        "id": run_id,
        "title": title,
        "createdAt": now_iso(),
        "sessionId": session_id,
        "files": written,
        "steps": steps,
        "postprocess": postprocess,
        "status": "running",
    }
    write_utf8(os.path.join(run_dir, "run_request.json"), json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True) + "\n")
    append_file_operation(session_id, turn_id_value, "created", "run_request.json", OUTPUT_CATEGORY_PARAMS, 0, run_id)
    audit("sentaurus_run_started", {"runId": run_id, "title": title, "sessionId": session_id})
    append_progress(session_id, "runner_prepare", "completed", "Prepared run directory %s with %s file(s)" % (run_id, len(written)), 50, run_id)
    step_results = []
    postprocess_results = []
    ok = True
    step_count = max(1, len(steps))
    for index, step in enumerate(steps, 1):
        tool = safe_text(step.get("tool"), 40).strip().lower()
        entry = safe_file_name(step.get("input") or step.get("entry") or step.get("entryFile"))
        step_start_progress = 55 + int(((index - 1) / float(step_count)) * 35)
        append_progress(session_id, "sentaurus_step", "running", "Step %s/%s: %s %s" % (index, step_count, tool, entry), step_start_progress, run_id)
        append_tool_run(session_id, turn_id_value, tool, "%s %s" % (tool, entry), "running", None, None, run_id)
        result = run_step(run_dir, step, index)
        step_results.append(result)
        duration_ms = int(float(result.get("seconds") or 0) * 1000)
        if result.get("exitCode") != 0:
            ok = False
            append_progress(session_id, "sentaurus_step", "failed", "Step %s/%s: %s %s exit %s" % (index, step_count, result.get("tool"), result.get("input"), result.get("exitCode")), step_start_progress, run_id)
            append_tool_run(session_id, turn_id_value, result.get("tool") or tool, "%s %s" % (result.get("tool") or tool, result.get("input") or entry), "failed", result.get("exitCode"), duration_ms, run_id)
            if result.get("stderrTail"):
                append_run_diagnostic(session_id, turn_id_value, "Sentaurus step failed: %s %s exit %s. Log tail: %s" % (result.get("tool") or tool, result.get("input") or entry, result.get("exitCode"), safe_text(result.get("stderrTail").replace("\n", " | "), 500)), run_id)
            break
        append_progress(session_id, "sentaurus_step", "completed", "Step %s/%s: %s %s exit 0 in %ss" % (index, step_count, result.get("tool"), result.get("input"), result.get("seconds")), min(95, step_start_progress + max(1, int(35 / float(step_count)))), run_id)
        append_tool_run(session_id, turn_id_value, result.get("tool") or tool, "%s %s" % (result.get("tool") or tool, result.get("input") or entry), "succeeded", result.get("exitCode"), duration_ms, run_id)
    if ok:
        for index, spec in enumerate(postprocess, 1):
            append_progress(session_id, "postprocess", "running", "Postprocess %s/%s: fixed dfise-idvg-v1 extractor" % (index, len(postprocess)), 92, run_id)
            append_tool_run(session_id, turn_id_value, "dfise-idvg-v1", "fixed tcad-idvg-v1 postprocess", "running", None, None, run_id)
            result = run_dfise_postprocess(run_dir, session_id, spec, index)
            postprocess_results.append(result)
            semantic_ok = result.get("status") == "ok" and result.get("exitCode") == 0
            append_tool_run(session_id, turn_id_value, "dfise-idvg-v1", "fixed tcad-idvg-v1 postprocess", "succeeded" if semantic_ok else "failed", result.get("exitCode"), int(float(result.get("seconds") or 0) * 1000), run_id)
            if semantic_ok:
                append_progress(session_id, "postprocess", "completed", "Fixed DF-ISE extraction completed with all required metrics", 98, run_id)
            else:
                ok = False
                append_progress(session_id, "postprocess", "failed", "Fixed DF-ISE extraction returned %s (%s)" % (result.get("status"), result.get("errorCode") or "unknown"), 98, run_id)
                append_run_diagnostic(session_id, turn_id_value, "DF-ISE postprocess failed semantic validation: %s %s" % (result.get("errorCode") or "unknown", result.get("errorMessage") or ""), run_id)
                break
    manifest["postprocessResults"] = postprocess_results
    if ok:
        manifest["status"] = "succeeded"
    elif postprocess_results and postprocess_results[-1].get("status") == "incomplete":
        manifest["status"] = "incomplete"
    elif postprocess_results and postprocess_results[-1].get("status") == "invalid-input":
        manifest["status"] = "failed-postcondition"
    else:
        manifest["status"] = "failed"
    manifest["finishedAt"] = now_iso()
    manifest["stepResults"] = step_results
    artifacts = collect_run_artifacts(run_dir)
    manifest["artifacts"] = artifacts
    write_utf8(os.path.join(run_dir, "run_result.json"), json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True) + "\n")
    append_file_operation(session_id, turn_id_value, "produced", "run_result.json", OUTPUT_CATEGORY_RESULTS, 0, run_id)
    artifacts = collect_run_artifacts(run_dir)
    manifest["artifacts"] = artifacts
    manifest["sessionOutputSyncedCount"] = sync_run_artifacts_to_session_output(session_id, run_id, run_dir, artifacts)
    write_utf8(os.path.join(run_dir, "run_result.json"), json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True) + "\n")
    sync_run_artifacts_to_session_output(session_id, run_id, run_dir, [{"path": "run_result.json", "size": 0}])
    for artifact in artifacts[:16]:
        append_file_operation(session_id, turn_id_value, "produced", artifact.get("path"), None, artifact.get("size"), run_id)
    audit("sentaurus_run_finished", {"runId": run_id, "ok": ok, "status": manifest.get("status"), "steps": step_results, "postprocess": postprocess_results})
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

def concise_run_final_reply(visible_reply, result, attempts=None, stop_reason=""):
    attempts = attempts or []
    status = result.get("status")
    run_id = safe_text(result.get("id"), 180)
    failed = first_failed_step(result)
    prefix = safe_text(visible_reply, 900).strip()
    lines = []
    if status == "succeeded":
        lines.append("Sentaurus run completed with status: succeeded.")
        if run_id:
            lines.append("")
            lines.append("Run ID: %s." % run_id)
        if attempts and len(attempts) > 1:
            lines.append("Auto-debug attempted %s time(s); the final attempt succeeded." % len(attempts))
        lines.append("")
        lines.append("Next step: review attached/output curves, logs, and run_result.json.")
    else:
        if failed:
            lines.append("Sentaurus run failed: %s %s exit %s." % (failed.get("tool"), failed.get("input"), failed.get("exitCode")))
            stderr_tail = safe_text((failed.get("stderrTail") or "").replace("\n", " | "), 260)
            if stderr_tail:
                lines.append("")
                lines.append("Key log tail: %s" % stderr_tail)
        else:
            lines.append("Sentaurus run did not complete successfully.")
        if stop_reason:
            lines.append("")
            lines.append("Stop reason: %s." % safe_text(stop_reason, 260))
        lines.append("")
        lines.append("Next step: inspect worklog, failed step, and generated files, then retry with corrected deck/files.")
    if prefix:
        return prefix + "\n\n" + "\n".join(lines)
    return "\n".join(lines)

def run_dir_for_result(result):
    run_id = safe_text(result.get("id"), 180).strip()
    return os.path.join(RUNS_DIR, run_id) if run_id else ""

def first_failed_step(result):
    for step in result.get("stepResults") or []:
        if step.get("timedOut") or step.get("exitCode") != 0:
            return step
    for item in result.get("postprocessResults") or []:
        if item.get("status") != "ok" or item.get("exitCode") != 0:
            request = item.get("request") if isinstance(item.get("request"), dict) else {}
            return {
                "tool": item.get("kind") or "dfise-idvg-v1",
                "input": "%s + %s" % (request.get("lowInput") or "low.plt", request.get("highInput") or "high.plt"),
                "exitCode": item.get("exitCode"),
                "timedOut": bool(item.get("timedOut")),
                "stdoutTail": item.get("stdoutTail"),
                "stderrTail": item.get("stderrTail") or ("%s: %s" % (item.get("errorCode") or "POSTPROCESS_FAILED", item.get("errorMessage") or "")),
                "postprocessErrorCode": item.get("errorCode"),
            }
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
    if result.get("status") in ["incomplete", "failed-postcondition"]:
        failed = first_failed_step(result) or {}
        return failed.get("postprocessErrorCode") in ["BIAS_MISMATCH", "SS_WINDOW_NOT_COVERED", "VTH_NOT_COVERED", "INSUFFICIENT_POINTS", "NO_VALID_POINTS"]
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
        "- For DF-ISE .plt extraction, keep kind=dfise-idvg-v1 and only adjust lowInput/highInput, expected biases, outputPrefix, or the SDevice sweep that produces the inputs.",
        "- Never generate, edit, replace, or inline the fixed dfise_idvg_extract.py parser. Never replace it with Inspect cv_* or dynamic Tcl parsing.",
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

def run_with_autodebug(original_user_text, initial_run_request, visible_reply, session_id, current_message_id, turn_id_value="", initial_setup=None):
    config = load_config()
    max_attempts = int(config.get("max_autodebug_attempts") or 5)
    run_request = initial_run_request
    attempts = []
    repair_notes = []
    latest_setup = initial_setup
    stop_reason = ""
    for attempt_no in range(1, max_attempts + 1):
        append_progress(session_id, "runner", "running", "Attempt %s/%s: executing allowlisted Sentaurus run request" % (attempt_no, max_attempts), 45, "")
        append_worklog(session_id, turn_id_value, "tool", "Starting Sentaurus attempt %s/%s and recording files/tool steps." % (attempt_no, max_attempts))
        result = execute_run_request(run_request, session_id, turn_id_value)
        result["autoDebugAttempt"] = attempt_no
        attempts.append(result)
        if result.get("status") == "succeeded":
            if attempt_no > 1:
                append_progress(session_id, "autodebug", "completed", "Auto-debug succeeded on attempt %s/%s" % (attempt_no, max_attempts), 100, result.get("id"))
                append_run_diagnostic(session_id, turn_id_value, "Auto-debug succeeded after attempt %s." % attempt_no, result.get("id"))
            return format_autodebug_reply(visible_reply, attempts, "", repair_notes), result, attempts, latest_setup, ""
        if attempt_no >= max_attempts:
            stop_reason = "retry budget reached"
            break
        if not is_recoverable_run_failure(result):
            stop_reason = "failure was not considered safely recoverable"
            break
        append_progress(session_id, "autodebug", "running", "Attempt %s failed; diagnosing logs and repairing deck" % attempt_no, 95, result.get("id"))
        append_worklog(session_id, turn_id_value, "debug", "Run attempt failed; reading failed-step logs and trying to generate a safe repair deck.", result.get("id"))
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
                append_run_diagnostic(session_id, turn_id_value, "Auto-debug did not return a new executable run request.", result.get("id"))
                break
            run_request = next_run_request
            append_progress(session_id, "repair_llm", "completed", "Repair request ready for attempt %s/%s" % (attempt_no + 1, max_attempts), 45, result.get("id"))
            append_worklog(session_id, turn_id_value, "debug", "Generated repaired run request; preparing next attempt.", result.get("id"))
        except Exception as exc:
            stop_reason = "repair LLM failed: %s" % safe_text(str(exc), 500)
            append_progress(session_id, "repair_llm", "failed", stop_reason, 100, result.get("id"))
            append_run_diagnostic(session_id, turn_id_value, "Auto-debug repair call failed: %s" % safe_text(str(exc), 500), result.get("id"))
            break
    final = attempts[-1] if attempts else {}
    append_progress(session_id, "autodebug", "failed", stop_reason or "auto-debug stopped without a successful run", 100, final.get("id"))
    append_run_diagnostic(session_id, turn_id_value, "Auto-debug stopped: %s" % (stop_reason or "no successful run"), final.get("id"))
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
        "tdr", "plt", "cmd", "des", "parameter", "workbench", "simulation", u"\u4eff\u771f", u"\u7f51\u683c", u"\u7535\u6781", u"\u63ba\u6742",
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
        "safeSkills": ["vm_status", "sentaurus_tools", "list_agent_instances", "sentaurus_manual_context", "simulation_setup", "sentaurus_run_request", "session_goal", "side_investigation", "global_agents_md"],
        "realJobExecution": "available through a VM-local allowlisted runner when the assistant emits a valid <SENTAURUS_RUN_REQUEST> JSON block; arbitrary shell is not allowed",
        "deckGenerationGuardrails": deck_generation_guardrails(),
    }

def wants_skill_reply(text):
    return parse_local_command(text) is not None

def local_help_reply():
    return "\n".join([
        u"VM worker slash commands:",
        u"- /help: show this summary.",
        u"- /status: show VM worker status, tools, manuals, and safe skills.",
        u"- /goal: show the durable goal saved for this browser session.",
        u"- /goal clear: clear the durable goal for this browser session.",
        u"- /goal <text>: replace the durable goal for this browser session.",
        u"- /side <question>: run a side investigation without replacing the main thread or durable goal.",
    ])

def local_skill_reply(text):
    snapshot = skill_snapshot()
    agents_exists = os.path.exists(GLOBAL_AGENTS_PATH)
    lines = [
        "VM Sentaurus skill status:",
        "- core mission: %s" % snapshot.get("coreMission"),
        "- host: %s as %s" % (snapshot.get("hostname"), snapshot.get("user")),
        "- latest instance: %s" % (snapshot.get("latestInstance") or "none"),
        "- instance count: %s" % snapshot.get("instanceCount"),
        "- manual files: %s" % (", ".join(snapshot.get("manualFiles") or []) or "none installed"),
        "- VM-root AGENTS.md: %s" % ("installed" if agents_exists else "not installed"),
        "- safe skills: %s" % ", ".join(snapshot.get("safeSkills")),
        "- real job execution: %s" % snapshot.get("realJobExecution"),
        "- tools:",
    ]
    for name, path in sorted(snapshot.get("sentaurusTools").items()):
        lines.append("  - %s: %s" % (name, path or "not found"))
    return "\n".join(lines)

def local_goal_reply(session_id, args):
    if not safe_text(session_id, 160).strip():
        return u"/goal requires a browser session id; select or create a session first.", {"kind": "goal_error"}
    command_arg = safe_text(args, 2000).strip()
    if not command_arg or command_arg.lower() in ["show", "status"]:
        record = read_session_goal_record(session_id)
        if not record:
            return u"This session has no durable goal yet. Use /goal <text> to set one.", {"kind": "goal_status"}
        return u"Current durable goal:\n- %s\n- updated: %s" % (record.get("goal"), record.get("updatedAt")), {"kind": "goal_status", "sessionGoal": record.get("goal")}
    if command_arg.lower() in ["clear", "none", "reset", "off"]:
        cleared = clear_session_goal(session_id)
        return (u"Cleared the durable goal for this session." if cleared else u"This session did not have a durable goal to clear."), {"kind": "goal_cleared", "sessionGoal": ""}
    record = write_session_goal(session_id, command_arg)
    return u"Saved durable goal for this session:\n- %s" % record.get("goal"), {"kind": "goal_updated", "sessionGoal": record.get("goal"), "sessionGoalUpdatedAt": record.get("updatedAt")}

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

def build_side_investigation_prompt(snapshot, recent_session_context, manual_context, current_goal, agents_context):
    return (
        u"You are the Sentaurus TCAD simulation agent running inside the CentOS VM. "
        u"This turn is a /side investigation: answer the side question directly, do not replace the main thread, and do not modify the durable session goal. "
        u"Do not emit <SIMULATION_SETUP>, <SENTAURUS_RUN_REQUEST>, or promise autonomous follow-up work. "
        u"Use Chinese by default unless the user asks otherwise. Keep the answer concise, practical, and clearly scoped as a side note. "
        u"Current VM skill snapshot: " + unicode_text(json.dumps(snapshot, ensure_ascii=True, sort_keys=True), 120000) + u"\n\n" +
        u"Durable session goal:\n" + unicode_text(current_goal or "(No durable goal set for this session.)", 12000) + u"\n\n" +
        u"VM-root AGENTS.md instructions:\n" + unicode_text(agents_context, 120000) + u"\n\n" +
        u"Recent browser-session main-thread context, newest last:\n" + unicode_text(recent_session_context, 250000) + u"\n\n" +
        u"VM-local Sentaurus manual/context excerpts:\n" + unicode_text(manual_context, 180000)
    )

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
    user_text = unicode_text(user_text, 1000000)
    system = unicode_text(system, 1000000)
    model = safe_text(model, 200)
    api_style = (config.get("api_style") or "chat-completions").lower()
    if api_style in ["openai-responses", "responses"]:
        payload = {
            "model": model,
            "input": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_text},
            ],
        }
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        request = urllib2.Request(responses_url(config.get("api_base")), body, {
            "content-type": "application/json",
            "authorization": "Bearer %s" % config.get("api_key"),
            "user-agent": "sentaurus-vm-agent/0.6.0",
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
    body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    request = urllib2.Request(chat_completions_url(config.get("api_base")), body, {
        "content-type": "application/json",
        "authorization": "Bearer %s" % config.get("api_key"),
        "user-agent": "sentaurus-vm-agent/0.6.0",
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

def build_llm_system_prompt(snapshot, recent_session_context, manual_context, current_goal, agents_context):
    return (
        u"You are the Sentaurus TCAD simulation agent running inside the CentOS VM. "
        "Your core mission is to help the user establish complete Sentaurus simulation tasks: clarify the device/process objective, "
        "create or revise SDE/SProcess/SDevice/SWB decks and parameter data, prepare run directories and extraction plans, "
        "invoke Sentaurus only through the VM-local allowlisted runner, monitor logs, and export results/artifacts/metrics back to the user. "
        "Real execution is available only by emitting a valid <SENTAURUS_RUN_REQUEST> JSON block; arbitrary shell commands are forbidden. "
        "Never claim that a Sentaurus job has run unless an allowlisted runner actually ran it and produced logs/artifacts. "
        "When the user explicitly asks you to run/simulate and you can create a self-contained minimal Sentaurus deck, include a concise human explanation, one simulation setup block, and exactly one run request block. "
        "The setup block schema is: <SIMULATION_SETUP>{\"deviceType\":\"...\",\"gateBias\":\"...\",\"drainBias\":\"...\",\"sourceBulk\":\"...\",\"geometry\":\"...\",\"dopingOrImplant\":\"...\",\"physicsModels\":\"...\",\"mesh\":\"...\",\"temperature\":\"...\",\"simulationGoals\":\"...\",\"expectedOutputs\":[\"file or curve\"],\"notes\":\"...\"}</SIMULATION_SETUP>. "
        "Populate the setup block with actual assumptions from the same browser session; omit unknown fields instead of inventing critical process/device parameters. "
        "The block schema is: <SENTAURUS_RUN_REQUEST>{\"title\":\"short-title\",\"files\":[{\"name\":\"main.cmd\",\"content\":\"...\"}],\"steps\":[{\"tool\":\"sde|sprocess|sdevice|inspect\",\"input\":\"main.cmd\"}],\"postprocess\":[{\"kind\":\"dfise-idvg-v1\",\"lowInput\":\"idvg_low.plt\",\"highInput\":\"idvg_high.plt\",\"expectedLowVd\":0.05,\"expectedHighVd\":0.8,\"outputPrefix\":\"idvg_step0005\"}]}</SENTAURUS_RUN_REQUEST>. "
        "A run request is atomic: the worker will execute only the JSON block you provide and will not automatically continue later based on visible text. "
        "Never say you will continue, follow up, add SDevice later, extract data later, or send final results later unless every required file and ordered step is already present in the same run request. "
        "For requests asking for final simulation results, Id-Vg curves, .plt/.csv data, or extraction, do not emit an SDE-only request; include SDevice and/or Inspect extraction steps, or ask for missing assumptions. "
        "Use only safe ASCII file names without spaces, and only .cmd, .des, .par, .scm, .tcl, .txt, or .dat files. "
        "Capability rule dfise-plt-postprocess-v1: for readable DF-ISE .plt Id-Vg extraction, use only the fixed typed dfise-idvg-v1 postprocess; do not generate Inspect cv_* extraction or dynamic Tcl/Python parsers; read actual Vd from file content; reject expected-bias mismatch; require finite Vth_low, Vth_high, SS_low, SS_high, and DIBL before success; publish CSV/JSON/DAT/TXT/PLT through general file attachments and PNG/SVG through image preview. "
        "If the required deck cannot be made self-contained, ask for the missing files/assumptions instead of emitting a run request. "
        "Use the installed tool paths and VM state in the snapshot. Ask for missing physics/process assumptions instead of inventing critical parameters. "
        "Before saying previous files, run directories, decks, or results are unavailable, inspect the recent browser-session context below. "
        "If the user says 'continue', 'that project', or similar, resolve it from the same-session context whenever possible. "
        "User-facing replies should be Chinese by default unless the user asks otherwise. "
        "Do not reveal hidden chain-of-thought. If progress visibility is useful, write concise public worklog summaries in Chinese. "
        "Public worklog summaries must describe observable actions, decisions, and status, not private reasoning traces. "
        "Final answers should be concise and separated from progress, diagnostics, and attachments. "
        u"Publish real outputs with <VM_SESSION_FILE>. PNG/JPEG/WebP/GIF/SVG are image previews; CSV/JSON/DAT/TXT/PLT/PDF and other allowlisted artifacts are general downloadable files. A run artifact may use {\"category\":\"仿真结果文件\",\"name\":\"safe-name.csv\",\"runId\":\"run_...\",\"artifactPath\":\"artifacts/safe-name.csv\"}; a safe ~/STDB file may use sourcePath. Do not send non-images through image-only assumptions. "
        "The browser and host backend only relay messages; API credentials stay inside this VM. "
        u"Current VM skill snapshot: " + unicode_text(json.dumps(snapshot, ensure_ascii=True, sort_keys=True), 200000) + u"\n\n" +
        u"Durable session goal:\n" + unicode_text(current_goal or "(No durable goal set for this session.)", 24000) + u"\n\n" +
        u"VM-root AGENTS.md instructions:\n" + unicode_text(agents_context, 200000) + u"\n\n" +
        u"Durable SDE/SDevice generation guardrails:\n" + unicode_text(deck_generation_guardrails(), 200000) + u"\n\n" +
        u"Recent browser-session context, newest last:\n" + unicode_text(recent_session_context, 400000) + u"\n\n" +
        u"VM-local Sentaurus manual/context excerpts:\n" + unicode_text(manual_context, 400000)
    )

def call_llm(user_text, config, session_id="", current_message_id=""):
    snapshot = skill_snapshot()
    manual_context = read_manual_context(user_text)
    recent_session_context = session_context(session_id, current_message_id)
    current_goal = session_goal_text(session_id)
    agents_context = read_global_agents_context()
    system = build_llm_system_prompt(snapshot, recent_session_context, manual_context, current_goal, agents_context)
    context_tokens = estimate_context_tokens(system) + estimate_context_tokens(user_text)
    if context_tokens > VM_CONTEXT_TARGET_TOKENS:
        user_tokens = estimate_context_tokens(user_text)
        available = max(80000, VM_CONTEXT_TARGET_TOKENS - user_tokens - 60000)
        session_budget = int(available * 0.56)
        manual_budget = int(available * 0.2)
        agents_budget = int(available * 0.16)
        recent_session_context = fit_text_to_token_budget(recent_session_context, session_budget, u"\n\n[Same-session context compressed to fit the 1.0M-token model window.]")
        manual_context = fit_text_to_token_budget(manual_context, manual_budget, u"\n\n[Manual context compressed to fit the 1.0M-token model window.]")
        agents_context = fit_text_to_token_budget(agents_context, agents_budget, u"\n\n[VM-root AGENTS.md context compressed to fit the 1.0M-token model window.]")
        system = build_llm_system_prompt(snapshot, recent_session_context, manual_context, current_goal, agents_context)
        if estimate_context_tokens(system) + user_tokens > VM_CONTEXT_HARD_TOKENS:
            system = fit_text_to_token_budget(system, max(40000, VM_CONTEXT_HARD_TOKENS - user_tokens - 5000), u"\n\n[System prompt hard-truncated to protect the 1.0M-token model window.]")
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

def strip_structured_reply_blocks(reply):
    setup, stripped = extract_json_tag(reply, "SIMULATION_SETUP")
    run_request, stripped = extract_run_request(stripped)
    return safe_text(stripped, 4000).strip() or safe_text(reply, 4000).strip()

def side_investigation_reply(side_prompt, config, session_id="", current_message_id=""):
    question = safe_text(side_prompt, 4000).strip()
    if not question:
        return u"Usage: /side <question>. This runs a side investigation without replacing the main thread.", {"kind": "side_investigation", "llmConfigured": llm_configured(config)}
    if not llm_configured(config):
        return (
            "VM agent is running inside CentOS, but LLM config is not set inside the VM yet. "
            "Put LLM_API_BASE, LLM_API_KEY, and optional LLM_MODEL in ~/.sentaurus-web-agent/vm-agent/.env or config.json."
        ), {"kind": "config_required", "llmConfigured": False}
    snapshot = skill_snapshot()
    manual_context = read_manual_context(question)
    recent_session_context = session_context(session_id, current_message_id)
    current_goal = session_goal_text(session_id)
    agents_context = read_global_agents_context()
    system = build_side_investigation_prompt(snapshot, recent_session_context, manual_context, current_goal, agents_context)
    models = config.get("models") or [config.get("model") or "gpt-5.5"]
    errors = []
    for index, model in enumerate(models):
        try:
            reply = call_llm_model(question, config, model, system)
            meta = {
                "kind": "side_investigation",
                "llmConfigured": True,
                "model": model,
                "apiStyle": config.get("api_style"),
                "modelCandidates": ",".join(models),
            }
            if index > 0:
                meta["fallbackFrom"] = ",".join(models[:index])
                meta["fallbackCount"] = index
            return u"[Side]\n" + strip_structured_reply_blocks(reply), meta
        except Exception as exc:
            error_text = safe_text(str(exc), 500)
            errors.append("%s: %s" % (model, error_text))
            audit("side_llm_model_failed", {"model": model, "error": error_text})
    raise Exception("; ".join(errors) or "no LLM model candidates configured")

def handle_local_command(text, config, session_id="", current_message_id=""):
    command = parse_local_command(text)
    if not command:
        return None
    name = command.get("name")
    args = command.get("args") or ""
    if name == "help":
        return local_help_reply(), {"kind": "local_help", "llmConfigured": llm_configured(config)}
    if name == "status":
        return local_skill_reply(text), {"kind": "sentaurus_skill", "llmConfigured": llm_configured(config)}
    if name == "goal":
        return local_goal_reply(session_id, args)
    if name == "side":
        return run_with_timeout(LLM_HARD_TIMEOUT_SECONDS, "VM agent side investigation", side_investigation_reply, args, config, session_id, current_message_id)
    return local_help_reply(), {"kind": "local_help", "llmConfigured": llm_configured(config)}

def reply_for(text, session_id="", current_message_id=""):
    config = load_config()
    try:
        command_reply = handle_local_command(text, config, session_id, current_message_id)
        if command_reply:
            return command_reply
    except Exception as exc:
        return "VM agent side investigation failed inside CentOS: %s" % safe_text(str(exc), 1000), {"kind": "llm_error", "llmConfigured": llm_configured(config), "modelCandidates": ",".join(config.get("models") or [])}
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

def open_queue_file_for_processing(path):
    try:
        handle = open(path, "r")
    except (IOError, OSError) as exc:
        if getattr(exc, "errno", None) == errno.ENOENT:
            return None
        raise
    if fcntl is None:
        return handle
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (IOError, OSError) as exc:
        handle.close()
        if getattr(exc, "errno", None) in [errno.EACCES, errno.EAGAIN]:
            return None
        raise
    return handle

def process_queue_file(path):
    session_id = ""
    queue_handle = None
    try:
        queue_handle = open_queue_file_for_processing(path)
        if queue_handle is None:
            return False
        item = json.load(queue_handle)
        user_text = unicode_text(item.get("content"), 4000)
        text = user_text
        incoming_meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
        session_id = safe_text(incoming_meta.get("sessionId"), 160).strip()
        request_turn_id = safe_text(incoming_meta.get("turnId"), 180).strip() or turn_id()
        started_at = time.time()
        request_message_id = item.get("id") or ""
        attachments = item.get("contextAttachments") if isinstance(item.get("contextAttachments"), list) else item.get("attachments") if isinstance(item.get("attachments"), list) else []
        display_attachments = []
        audit("queue_processing_started", {"file": os.path.basename(path), "sessionId": session_id, "workerPid": os.getpid()})
        append_progress(session_id, "received", "running", "Worker picked up queued request", 5)
        append_worklog(session_id, request_turn_id, "planning", "Received this request; preparing context and attachments before deciding whether Sentaurus execution is needed.")
        if attachments:
            append_worklog(session_id, request_turn_id, "file", "Reading %s attachment reference(s); readable text enters context, images/binaries stay metadata-only." % len(attachments))
            attachment_text, attachment_summaries = attachment_context(session_id, attachments)
            incoming_meta["attachmentsJson"] = json.dumps(attachment_summaries, ensure_ascii=True, sort_keys=True)
            if attachment_text:
                text = user_text + u"\n\n" + unicode_text(attachment_text, MAX_ATTACHMENT_CONTEXT_CHARS)
            append_worklog(session_id, request_turn_id, "file", "Attachment context ready: %s readable/reference item(s)." % len(attachment_summaries))
        command = parse_local_command(user_text)
        if command and command.get("name") == "side":
            append_progress(session_id, "side", "running", "Running an independent side investigation", 20)
            append_worklog(session_id, request_turn_id, "planning", "Running a side investigation while keeping the main thread and durable goal unchanged.")
        elif command:
            append_progress(session_id, "skill", "running", "Handling local slash-command skill", 20)
            append_worklog(session_id, request_turn_id, "planning", "Handling this local VM skill request without exposing API credentials.")
        else:
            append_progress(session_id, "llm_context", "running", "Building session history and manual context", 12)
            append_worklog(session_id, request_turn_id, "planning", "Building same-session history context and Sentaurus manual context.")
        append_worklog(session_id, request_turn_id, "planning", "Calling the VM-local configured model to generate a reply or safe run request.")
        reply, meta = reply_for(text, session_id, request_message_id)
        published_file_specs, reply_without_session_files = extract_vm_session_files(reply)
        published_display_attachments = []
        publish_errors = []
        for spec in published_file_specs:
            try:
                published_display_attachments.append(publish_vm_session_file(session_id, spec))
                if published_display_attachments[-1]:
                    append_file_operation(session_id, request_turn_id, "published", published_display_attachments[-1].get("path"), published_display_attachments[-1].get("category"), published_display_attachments[-1].get("size"), session_id)
                append_progress(session_id, "attachment_publish", "completed", "Published file %s to session output" % safe_text(spec.get("name") or os.path.basename(safe_text(spec.get("sourcePath"), 500)), 180), 100)
            except Exception as exc:
                append_progress(session_id, "attachment_publish", "failed", "Failed to publish file: %s" % safe_text(str(exc), 300), 100)
                publish_errors.append(safe_text(str(exc), 300))
                append_run_diagnostic(session_id, request_turn_id, "File publish failed: %s" % safe_text(str(exc), 300))
                audit("vm_session_file_publish_failed", {"sessionId": session_id, "error": safe_text(str(exc), 500), "spec": spec})
        reply = reply_without_session_files
        simulation_setup = None
        visible_reply = strip_structured_reply_blocks(reply) if command else reply
        run_request = None
        if not command:
            simulation_setup, setup_visible_reply = extract_json_tag(reply, "SIMULATION_SETUP")
            if simulation_setup:
                simulation_setup = normalize_simulation_setup(simulation_setup)
                meta["simulationSetupJson"] = json.dumps(simulation_setup, ensure_ascii=True, sort_keys=True)
            run_request, visible_reply = extract_run_request(setup_visible_reply)
            append_worklog(session_id, request_turn_id, "planning", "Checking whether the model returned a safely executable Sentaurus run request.")
            validation_error = run_request_validation_error(run_request, visible_reply, text)
            if validation_error:
                append_progress(session_id, "run_validation", "failed", validation_error, 100)
                append_worklog(session_id, request_turn_id, "debug", "Run request needs repair before execution; attempting safe completion/correction.")
                repaired_reply, repaired_meta = repair_run_request_reply(text, reply, validation_error, session_id, request_message_id)
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
            append_worklog(session_id, request_turn_id, "tool", "Run request passed validation; executing allowlisted Sentaurus flow and collecting outputs.")
            reply, result, attempts, simulation_setup, stop_reason = run_with_autodebug(text, run_request, visible_reply, session_id, request_message_id, request_turn_id, simulation_setup)
            simulation_setup = enrich_setup_from_postprocess(simulation_setup or setup_from_run_request(run_request), result)
            artifacts = result.get("artifacts") or []
            display_attachments = display_attachments_for_artifacts(result.get("id") or "", artifacts)
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
            reply = visible_reply or reply
        display_attachments = (published_display_attachments + display_attachments)[:12]
        if published_display_attachments:
            session_files_meta = []
            for item in published_display_attachments:
                session_files_meta.append({
                    "category": item.get("category"),
                    "path": item.get("path"),
                    "name": item.get("name"),
                    "size": item.get("size"),
                    "contentType": item.get("contentType"),
                    "isImage": item.get("kind") == "image",
                })
            meta["vmSessionFilesJson"] = json.dumps(session_files_meta, ensure_ascii=True, sort_keys=True)
        if session_id:
            meta["sessionId"] = session_id
            if simulation_setup:
                sync_session_setup_to_output(session_id, simulation_setup)
        duration_ms = int((time.time() - started_at) * 1000)
        append_worklog(session_id, request_turn_id, "final", "Final response generated; conclusions and attachments are kept separate from folded worklog.")
        has_reply_text = bool(safe_text(reply, 4000).strip())
        publish_error_text = ""
        if publish_errors:
            publish_error_text = "Failed to publish %s file attachment%s: %s" % (len(publish_errors), "" if len(publish_errors) == 1 else "s", "; ".join(publish_errors[:3]))
        if display_attachments:
            text_meta = meta.copy()
            text_meta["suppressAttachmentPreview"] = True
            if has_reply_text:
                final_text = concise_run_final_reply(visible_reply, result, attempts, stop_reason) if run_request else safe_text(reply, 4000)
                append_run_final(session_id, request_turn_id, final_text, result if run_request else {"status": "completed"}, duration_ms)
            if publish_error_text:
                publish_meta = {"kind": "vm_agent_attachment_publish_error"}
                if session_id:
                    publish_meta["sessionId"] = session_id
                append_run_diagnostic(session_id, request_turn_id, publish_error_text, result.get("id") if run_request else "")
            append_attachment_message(session_id, request_turn_id, display_attachments, meta)
        else:
            if has_reply_text or not publish_error_text:
                if run_request:
                    append_run_final(session_id, request_turn_id, concise_run_final_reply(visible_reply, result, attempts, stop_reason), result, duration_ms)
                else:
                    reply_meta = meta.copy()
                    reply_meta["turnId"] = request_turn_id
                    reply_meta["groupId"] = request_turn_id
                    reply_meta["sessionId"] = session_id
                    reply_meta["kind"] = reply_meta.get("kind") or "run_final"
                    reply_meta["foldable"] = False
                    reply_meta["collapsedByDefault"] = False
                    append_message("agent", reply, "vm-agent-worker", reply_meta, "final")
            if publish_error_text:
                publish_meta = {"kind": "vm_agent_attachment_publish_error"}
                if session_id:
                    publish_meta["sessionId"] = session_id
                append_run_diagnostic(session_id, request_turn_id, publish_error_text, result.get("id") if run_request else "")
        shutil.move(path, os.path.join(DONE_DIR, os.path.basename(path)))
        audit("queue_processed", {"file": os.path.basename(path), "replyKind": meta.get("kind"), "workerPid": os.getpid()})
        return True
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
        return False
    finally:
        if queue_handle is not None:
            try:
                queue_handle.close()
            except Exception:
                pass

def main():
    for path in [ROOT, QUEUE_DIR, DONE_DIR, MANUALS_DIR, GOALS_DIR]:
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

if __name__ == "__main__" and os.environ.get("SENTAURUS_VM_AGENT_IMPORT_ONLY") != "1":
    main()
