import type { VmAgentMessage, VmAgentStatus } from "@sentaurus-agent/shared";
import { config } from "../config.js";
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
  manualCount?: number;
  manualFiles?: string[];
  queueDepth?: number;
  sentaurusTools?: Record<string, string | null>;
  messages?: unknown[];
  cursor?: number;
  raw?: string;
};

const agentName = "sentaurus-vm-agent";
const agentVersion = "0.4.4";

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
AGENT_VERSION = "0.4.4"
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
        "stderrTail": read_file_tail(stderr_path),
    }

def collect_run_artifacts(run_dir, limit=80):
    allowed = set([".log", ".out", ".err", ".plt", ".tdr", ".grd", ".dat", ".csv", ".txt", ".png", ".jpg", ".jpeg", ".json", ".cmd", ".par", ".scm", ".tcl", ".bnd", ".sat"])
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
    artifacts = collect_run_artifacts(run_dir)
    manifest["status"] = "succeeded" if ok else "failed"
    manifest["finishedAt"] = now_iso()
    manifest["stepResults"] = step_results
    manifest["artifacts"] = artifacts
    write_utf8(os.path.join(run_dir, "run_result.json"), json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True) + "\n")
    audit("sentaurus_run_finished", {"runId": run_id, "ok": ok, "steps": step_results})
    append_progress(session_id, "artifacts", "completed" if ok else "failed", "Collected %s artifact/log file(s)" % len(artifacts), 100 if ok else 95, run_id)
    return manifest

def format_run_result(result):
    lines = []
    ok = result.get("status") == "succeeded"
    lines.append("✅ Sentaurus simulation completed." if ok else "⚠️ Sentaurus simulation finished with errors.")
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
        "safeSkills": ["vm_status", "sentaurus_tools", "list_agent_instances", "sentaurus_manual_context", "sentaurus_run_request"],
        "realJobExecution": "available through a VM-local allowlisted runner when the assistant emits a valid <SENTAURUS_RUN_REQUEST> JSON block; arbitrary shell is not allowed",
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
            "user-agent": "sentaurus-vm-agent/0.3",
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
        "user-agent": "sentaurus-vm-agent/0.3",
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
        "When the user explicitly asks you to run/simulate and you can create a self-contained minimal Sentaurus deck, include a concise human explanation followed by exactly one run request block. "
        "The block schema is: <SENTAURUS_RUN_REQUEST>{\"title\":\"short-title\",\"files\":[{\"name\":\"main.cmd\",\"content\":\"...\"}],\"steps\":[{\"tool\":\"sde|sprocess|sdevice|inspect\",\"input\":\"main.cmd\"}]}</SENTAURUS_RUN_REQUEST>. "
        "Use only safe ASCII file names without spaces, and only .cmd, .des, .par, .scm, .tcl, .txt, or .dat files. "
        "If the required deck cannot be made self-contained, ask for the missing files/assumptions instead of emitting a run request. "
        "Use the installed tool paths and VM state in the snapshot. Ask for missing physics/process assumptions instead of inventing critical parameters. "
        "Before saying previous files, run directories, decks, or results are unavailable, inspect the recent browser-session context below. "
        "If the user says 'continue', 'that project', or similar, resolve it from the same-session context whenever possible. "
        "The browser and host backend only relay messages; API credentials stay inside this VM. "
        "Current VM skill snapshot: " + json.dumps(snapshot, ensure_ascii=True, sort_keys=True) + "\n\n" +
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
        run_request, visible_reply = extract_run_request(reply)
        if meta.get("kind") == "sentaurus_skill":
            append_progress(session_id, "skill", "completed", "Local skill reply is ready", 100)
        elif meta.get("kind") == "llm_error":
            append_progress(session_id, "llm", "failed", "LLM call failed; see agent message", 100)
        else:
            append_progress(session_id, "llm", "completed", "LLM produced %s" % ("a Sentaurus run request" if run_request else "a chat reply"), 35)
        if run_request:
            append_progress(session_id, "runner", "running", "Executing allowlisted Sentaurus run request", 45)
            result = execute_run_request(run_request, session_id)
            reply = (visible_reply + "\n\n" if visible_reply else "") + format_run_result(result)
            meta["kind"] = "sentaurus_run"
            meta["runId"] = result.get("id")
            meta["runStatus"] = result.get("status")
            append_progress(session_id, "final", "completed" if result.get("status") == "succeeded" else "failed", "Final simulation result appended to chat", 100, result.get("id") or "")
        elif meta.get("kind") != "llm_error":
            append_progress(session_id, "reply", "completed", "Agent reply is ready", 100)
        if session_id:
            meta["sessionId"] = session_id
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
AGENT_VERSION = "0.4.4"
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
                "llmApiStyle": "chat-completions"
            }, indent=2, sort_keys=True) + "\n")
    if not os.path.exists(ENV_EXAMPLE_PATH):
        with open(ENV_EXAMPLE_PATH, "w") as handle:
            handle.write("LLM_API_BASE=https://your-openai-compatible-base/v1\nLLM_API_KEY=put-real-key-here-inside-vm-only\nLLM_MODEL=gpt-5.5\nLLM_MODELS=gpt-5.5,gpt-5.4\nLLM_API_STYLE=chat-completions\n")

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
        "capabilities": ["relay_message", "history", "vm_worker", "vm_local_llm_config", "sentaurus_skills", "sentaurus_run_request"],
        "instanceCount": len(instances),
        "latestInstance": instances[-1] if instances else None,
        "mailbox": "~/.sentaurus-web-agent/vm-agent",
        "messageCount": message_count(),
        "workerRunning": running,
        "workerPid": pid if running else None,
        "llmConfigured": bool(llm_config.get("api_base") and llm_config.get("api_key")),
        "llmModel": llm_config.get("model"),
        "llmModels": llm_config.get("models"),
        "manualCount": len(manuals),
        "manualFiles": manuals[:20],
        "queueDepth": queue_depth(),
        "sentaurusTools": sentaurus_tools(),
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

function remoteAgentScript(request: RemoteAgentRequest): string {
  const encodedRequest = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  const encodedWorker = Buffer.from(remoteWorkerScript, "utf8").toString("base64");
  return remoteControlScript
    .replace("__REQUEST_B64__", encodedRequest)
    .replace("__WORKER_SOURCE_B64__", encodedWorker);
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
    llmModel: payload.llmModel,
    llmModels: payload.llmModels,
    manualCount: payload.manualCount,
    manualFiles: payload.manualFiles,
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
  const result = await runSshCommandWithInput("python -", remoteAgentScript(request), 20_000);
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

export async function sendVmAgentMessage(message: string, sessionId?: string): Promise<{ status: VmAgentStatus; message: VmAgentMessage; messages: VmAgentMessage[]; cursor: number }> {
  const payload = await callVmAgent({ operation: "send", message, sessionId });
  const status = payload.ok === false ? errorStatus(payload.error || "VM agent message failed", payload.raw) : toStatus(payload);
  const messages = normalizeMessages(payload.messages);
  const representative = [...messages].reverse().find((item) => item.role === "agent") || messages[0] || fallbackAgentMessage("Message queued for the CentOS VM agent.");
  return { status, message: representative, messages, cursor: payload.cursor || 0 };
}
