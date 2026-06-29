import fs from "node:fs/promises";
import path from "node:path";
import { VM_SESSION_INPUT_CATEGORY, VM_SESSION_OUTPUT_CATEGORIES } from "@sentaurus-agent/shared";
import type { VmSessionFilesResponse, VmSessionOutputCategory, VmSessionOutputFile } from "@sentaurus-agent/shared";
import { safeFileName, safeRelativePath, safeRunId } from "../security/pathSafe.js";
import { runSshCommandWithInput } from "./sshClient.js";

export const vmSessionOutputCategories: VmSessionOutputCategory[] = [...VM_SESSION_OUTPUT_CATEGORIES];

const maxSessionFileBytes = 50 * 1024 * 1024;
const allowedSessionExtensions = new Set([
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
  ".json",
  ".cmd",
  ".des",
  ".par",
  ".scm",
  ".tcl",
  ".bnd",
  ".sat",
  ".md",
  ".rst",
  ".sde",
  ".pdf"
]);

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

type RemoteSessionFilesPayload = {
  ok?: boolean;
  error?: string;
  statusCode?: number;
  categories?: VmSessionOutputCategory[];
  files?: VmSessionOutputFile[];
  path?: string;
  category?: VmSessionOutputCategory;
  fileName?: string;
  size?: number;
  modifiedAt?: string;
  contentB64?: string;
};

export type VmSessionDownloadedFile = {
  category: VmSessionOutputCategory;
  path: string;
  fileName: string;
  size: number;
  contentType: string;
  data: Buffer;
};

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function badRequestFrom(err: unknown): Error & { statusCode: number } {
  return httpError(400, err instanceof Error ? err.message : "Invalid VM session file request");
}

function checkedSessionId(sessionId: string): string {
  try {
    return safeRunId(sessionId);
  } catch (err) {
    throw badRequestFrom(err);
  }
}

function checkedRelativePath(filePath: string): string {
  try {
    return safeRelativePath(filePath);
  } catch (err) {
    throw badRequestFrom(err);
  }
}

function checkedFileName(filename: string): string {
  try {
    return safeFileName(filename);
  } catch (err) {
    throw badRequestFrom(err);
  }
}

function extensionOf(name: string): string {
  const base = name.split("/").at(-1) || name;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

function assertAllowedExtension(name: string): void {
  if (!allowedSessionExtensions.has(extensionOf(name))) {
    throw httpError(400, "File extension is not allowlisted");
  }
}

function safeCategory(value: string): VmSessionOutputCategory {
  if (!vmSessionOutputCategories.includes(value as VmSessionOutputCategory)) {
    throw httpError(400, "Invalid output category");
  }
  return value as VmSessionOutputCategory;
}

function parseRemoteJson(raw: string): RemoteSessionFilesPayload {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) throw httpError(502, `VM session file command did not return JSON: ${raw.slice(0, 500)}`);
  return JSON.parse(jsonLine) as RemoteSessionFilesPayload;
}

function payloadScript(template: string, request: unknown): string {
  const requestB64 = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  return template.replace("__REQUEST_B64__", requestB64);
}

export function contentTypeForName(name: string): string {
  switch (extensionOf(name)) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".pdf": return "application/pdf";
    case ".json": return "application/json; charset=utf-8";
    case ".csv": return "text/csv; charset=utf-8";
    case ".txt":
    case ".log":
    case ".out":
    case ".err":
    case ".cmd":
    case ".des":
    case ".par":
    case ".scm":
    case ".tcl":
    case ".md":
    case ".rst":
    case ".sde":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

const remoteListScript = String.raw`# -*- coding: utf-8 -*-
import base64
import datetime
import json
import os
import re
import sys

REQUEST_B64 = "__REQUEST_B64__"
HOME = os.path.expanduser("~")
SESSIONS_DIR = os.path.join(HOME, "STDB", "web-agent-sessions")

def load_request():
    raw = base64.b64decode(REQUEST_B64)
    return json.loads(raw.decode("utf-8"))

def fail(message, status_code=400):
    print(json.dumps({"ok": False, "error": message, "statusCode": status_code}, ensure_ascii=True, sort_keys=True))
    sys.exit(0)

def valid_segment(value):
    return bool(re.match(r"^[A-Za-z0-9][A-Za-z0-9._@()+, -]{0,159}$", value or ""))

def safe_rel(parts):
    clean = []
    for part in parts:
        if not part or part in [".", ".."] or part.startswith(".") or not valid_segment(part):
            fail("invalid session file path")
        clean.append(part)
    return "/".join(clean)

try:
    req = load_request()
    session_id = req.get("sessionId") or ""
    categories = req.get("categories") or []
    allowed_ext = set(req.get("allowedExtensions") or [])
    image_ext = set(req.get("imageExtensions") or [])
    if not re.match(r"^run_[A-Za-z0-9_-]+$", session_id):
        fail("invalid session id")
    root = os.path.join(SESSIONS_DIR, session_id, "output")
    files = []
    for category in categories:
        category_dir = os.path.abspath(os.path.join(root, category))
        if not category_dir.startswith(os.path.abspath(root) + os.sep):
            fail("invalid category path")
        if not os.path.isdir(category_dir):
            os.makedirs(category_dir)
        for dirpath, dirnames, filenames in os.walk(category_dir):
            dirnames[:] = [item for item in dirnames if item and not item.startswith(".") and valid_segment(item)]
            for name in filenames:
                if not name or name.startswith(".") or not valid_segment(name):
                    continue
                ext = os.path.splitext(name)[1].lower()
                if ext not in allowed_ext:
                    continue
                full = os.path.abspath(os.path.join(dirpath, name))
                if not full.startswith(category_dir + os.sep):
                    continue
                rel = os.path.relpath(full, category_dir).replace(os.sep, "/")
                safe_rel(rel.split("/"))
                stat = os.stat(full)
                files.append({
                    "category": category,
                    "path": rel,
                    "name": name,
                    "size": stat.st_size,
                    "modifiedAt": datetime.datetime.utcfromtimestamp(stat.st_mtime).replace(microsecond=0).isoformat() + "Z",
                    "isImage": ext in image_ext,
                })
    files.sort(key=lambda item: (categories.index(item.get("category")) if item.get("category") in categories else 999, item.get("path")))
    print(json.dumps({"ok": True, "categories": categories, "files": files}, ensure_ascii=True, sort_keys=True))
except SystemExit:
    raise
except Exception as exc:
    fail(str(exc), 500)
`;

const remoteDownloadScript = String.raw`# -*- coding: utf-8 -*-
import base64
import json
import os
import re
import sys

REQUEST_B64 = "__REQUEST_B64__"
HOME = os.path.expanduser("~")
SESSIONS_DIR = os.path.join(HOME, "STDB", "web-agent-sessions")

def load_request():
    raw = base64.b64decode(REQUEST_B64)
    return json.loads(raw.decode("utf-8"))

def fail(message, status_code=400):
    print(json.dumps({"ok": False, "error": message, "statusCode": status_code}, ensure_ascii=True, sort_keys=True))
    sys.exit(0)

def valid_segment(value):
    return bool(re.match(r"^[A-Za-z0-9][A-Za-z0-9._@()+, -]{0,159}$", value or ""))

def ensure_dir(path):
    if not os.path.isdir(path):
        os.makedirs(path)

try:
    req = load_request()
    session_id = req.get("sessionId") or ""
    category = req.get("category") or ""
    rel_path = (req.get("path") or "").replace("\\", "/")
    categories = req.get("categories") or []
    allowed_ext = set(req.get("allowedExtensions") or [])
    max_bytes = int(req.get("maxBytes") or 0)
    if not re.match(r"^run_[A-Za-z0-9_-]+$", session_id):
        fail("invalid session id")
    if category not in categories:
        fail("invalid output category")
    parts = rel_path.split("/")
    for part in parts:
        if not part or part in [".", ".."] or part.startswith(".") or not valid_segment(part):
            fail("invalid session file path")
    ext = os.path.splitext(parts[-1])[1].lower()
    if ext not in allowed_ext:
        fail("file extension is not allowlisted")
    category_dir = os.path.abspath(os.path.join(SESSIONS_DIR, session_id, "output", category))
    target = os.path.abspath(os.path.join(category_dir, *parts))
    if not target.startswith(category_dir + os.sep):
        fail("file path escapes output category")
    if not os.path.isfile(target):
        fail("file not found", 404)
    size = os.path.getsize(target)
    if max_bytes > 0 and size > max_bytes:
        fail("file is too large to download through the web relay", 413)
    with open(target, "rb") as handle:
        content = base64.b64encode(handle.read()).decode("ascii")
    print(json.dumps({
        "ok": True,
        "category": category,
        "path": rel_path,
        "fileName": os.path.basename(target),
        "size": size,
        "contentB64": content,
    }, ensure_ascii=True, sort_keys=True))
except SystemExit:
    raise
except Exception as exc:
    fail(str(exc), 500)
`;

const remoteSyncInputScript = String.raw`# -*- coding: utf-8 -*-
import base64
import json
import os
import re
import sys

REQUEST_B64 = "__REQUEST_B64__"
HOME = os.path.expanduser("~")
SESSIONS_DIR = os.path.join(HOME, "STDB", "web-agent-sessions")

def load_request():
    raw = base64.b64decode(REQUEST_B64)
    return json.loads(raw.decode("utf-8"))

def fail(message, status_code=400):
    print(json.dumps({"ok": False, "error": message, "statusCode": status_code}, ensure_ascii=True, sort_keys=True))
    sys.exit(0)

def valid_segment(value):
    return bool(re.match(r"^[A-Za-z0-9][A-Za-z0-9._@()+, -]{0,159}$", value or ""))

def ensure_dir(path):
    if not os.path.isdir(path):
        os.makedirs(path)

try:
    req = load_request()
    session_id = req.get("sessionId") or ""
    category = req.get("category") or ""
    filename = req.get("fileName") or ""
    categories = req.get("categories") or []
    allowed_ext = set(req.get("allowedExtensions") or [])
    content_b64 = req.get("contentB64") or ""
    if not re.match(r"^run_[A-Za-z0-9_-]+$", session_id):
        fail("invalid session id")
    if category not in categories:
        fail("invalid output category")
    if not valid_segment(filename) or filename.startswith("."):
        fail("invalid file name")
    ext = os.path.splitext(filename)[1].lower()
    if ext not in allowed_ext:
        fail("file extension is not allowlisted")
    category_dir = os.path.abspath(os.path.join(SESSIONS_DIR, session_id, "output", category))
    ensure_dir(category_dir)
    target = os.path.abspath(os.path.join(category_dir, filename))
    if not target.startswith(category_dir + os.sep):
        fail("file path escapes output category")
    with open(target, "wb") as handle:
        handle.write(base64.b64decode(content_b64))
    print(json.dumps({"ok": True, "category": category, "path": filename, "fileName": filename, "size": os.path.getsize(target)}, ensure_ascii=True, sort_keys=True))
except SystemExit:
    raise
except Exception as exc:
    fail(str(exc), 500)
`;

async function runRemoteSessionScript(script: string): Promise<RemoteSessionFilesPayload> {
  const result = await runSshCommandWithInput("python -", script, 90_000);
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!result.ok) {
    throw httpError(502, result.error || result.stderr || "VM session file SSH command failed");
  }
  const payload = parseRemoteJson(raw);
  if (payload.ok === false) {
    throw httpError(typeof payload.statusCode === "number" ? payload.statusCode : 400, payload.error || "VM session file command failed");
  }
  return payload;
}

export async function listVmSessionFiles(sessionId: string): Promise<VmSessionFilesResponse> {
  const safeSessionId = checkedSessionId(sessionId);
  const payload = await runRemoteSessionScript(payloadScript(remoteListScript, {
    sessionId: safeSessionId,
    categories: vmSessionOutputCategories,
    allowedExtensions: [...allowedSessionExtensions],
    imageExtensions: [...imageExtensions]
  }));
  return {
    categories: payload.categories || vmSessionOutputCategories,
    files: Array.isArray(payload.files) ? payload.files : []
  };
}

export async function downloadVmSessionFile(sessionId: string, category: string, filePath: string): Promise<VmSessionDownloadedFile> {
  const safeSessionId = checkedSessionId(sessionId);
  const safeOutputCategory = safeCategory(category);
  const safePath = checkedRelativePath(filePath);
  assertAllowedExtension(safePath);
  const payload = await runRemoteSessionScript(payloadScript(remoteDownloadScript, {
    sessionId: safeSessionId,
    category: safeOutputCategory,
    path: safePath,
    categories: vmSessionOutputCategories,
    allowedExtensions: [...allowedSessionExtensions],
    maxBytes: maxSessionFileBytes
  }));
  if (typeof payload.contentB64 !== "string" || typeof payload.path !== "string" || typeof payload.fileName !== "string" || !payload.category) {
    throw httpError(502, "VM session file response was incomplete");
  }
  const data = Buffer.from(payload.contentB64, "base64");
  return {
    category: payload.category,
    path: payload.path,
    fileName: payload.fileName,
    size: typeof payload.size === "number" ? payload.size : data.byteLength,
    contentType: contentTypeForName(payload.fileName),
    data
  };
}

export async function syncInputFileToVmSession(sessionId: string, filename: string, localPath: string): Promise<void> {
  const safeSessionId = checkedSessionId(sessionId);
  const safeName = checkedFileName(filename);
  assertAllowedExtension(safeName);
  const data = await fs.readFile(localPath);
  if (data.byteLength > maxSessionFileBytes) {
    throw httpError(413, "File is too large to sync into the VM session output folder");
  }
  await runRemoteSessionScript(payloadScript(remoteSyncInputScript, {
    sessionId: safeSessionId,
    category: VM_SESSION_INPUT_CATEGORY,
    fileName: path.basename(safeName),
    categories: vmSessionOutputCategories,
    allowedExtensions: [...allowedSessionExtensions],
    contentB64: data.toString("base64")
  }));
}
