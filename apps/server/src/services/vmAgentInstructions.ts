import { readFileSync } from "node:fs";
import type { VmAgentInstructionsResponse } from "@sentaurus-agent/shared";
import { runSshCommandWithInput } from "./sshClient.js";

export const VM_AGENT_INSTRUCTIONS_MAX_BYTES = 64 * 1024;
export const VM_AGENT_INSTRUCTIONS_FILE = "AGENTS.md" as const;

export const defaultVmAgentInstructions = readFileSync(
  new URL("../../remote/AGENTS.md", import.meta.url),
  "utf8"
);

type InstructionsOperation = "get" | "put";

type RemoteInstructionsPayload = {
  ok?: boolean;
  error?: string;
  statusCode?: number;
  content?: string;
  fileName?: string;
  path?: string;
  size?: number;
  maxBytes?: number;
  updatedAt?: string | null;
};

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

export function validateVmAgentInstructionsContent(value: unknown): string {
  if (typeof value !== "string") {
    throw httpError(400, "content must be a string");
  }
  const size = Buffer.byteLength(value, "utf8");
  if (size > VM_AGENT_INSTRUCTIONS_MAX_BYTES) {
    throw httpError(413, `AGENTS.md is limited to ${VM_AGENT_INSTRUCTIONS_MAX_BYTES} UTF-8 bytes`);
  }
  return value;
}

function remoteInstructionsScript(operation: InstructionsOperation, content?: string): string {
  const request = {
    operation,
    contentB64: operation === "put" ? Buffer.from(content || "", "utf8").toString("base64") : undefined,
    defaultContentB64: Buffer.from(defaultVmAgentInstructions, "utf8").toString("base64")
  };
  const requestB64 = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  return String.raw`# -*- coding: utf-8 -*-
import base64
import datetime
import json
import os
import sys
import uuid

REQUEST_B64 = "${requestB64}"
MAX_BYTES = ${VM_AGENT_INSTRUCTIONS_MAX_BYTES}
HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".sentaurus-web-agent", "vm-agent")
TARGET = os.path.join(ROOT, "AGENTS.md")

def respond(payload):
    print(json.dumps(payload, ensure_ascii=True, sort_keys=True))
    print("REMOTE_AGENTS_DONE")

def fail(message, status_code=400):
    respond({"ok": False, "error": message, "statusCode": status_code})
    sys.exit(0)

def ensure_root():
    if not os.path.isdir(ROOT):
        os.makedirs(ROOT)

def validate_target():
    ensure_root()
    if os.path.lexists(TARGET) and os.path.islink(TARGET):
        fail("AGENTS.md must not be a symbolic link", 409)
    root_real = os.path.realpath(ROOT)
    parent_real = os.path.realpath(os.path.dirname(TARGET))
    if parent_real != root_real:
        fail("AGENTS.md target escaped the VM agent root", 500)

def decode_b64(value):
    try:
        return base64.b64decode(value or "")
    except Exception:
        fail("AGENTS.md content encoding is invalid", 400)

def validate_data(data):
    if len(data) > MAX_BYTES:
        fail("AGENTS.md exceeds the maximum size", 413)
    try:
        return data.decode("utf-8")
    except Exception:
        fail("AGENTS.md must contain valid UTF-8", 422)

def atomic_write(data):
    validate_data(data)
    temporary = os.path.join(ROOT, ".AGENTS.md.%s.tmp" % uuid.uuid4().hex)
    descriptor = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = None
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.rename(temporary, TARGET)
        os.chmod(TARGET, 0o600)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if os.path.exists(temporary):
            os.unlink(temporary)

def response_payload():
    with open(TARGET, "rb") as handle:
        data = handle.read(MAX_BYTES + 1)
    content = validate_data(data)
    modified = datetime.datetime.utcfromtimestamp(os.path.getmtime(TARGET)).replace(microsecond=0).isoformat() + "Z"
    return {
        "ok": True,
        "content": content,
        "fileName": "AGENTS.md",
        "path": "~/.sentaurus-web-agent/vm-agent/AGENTS.md",
        "size": len(data),
        "maxBytes": MAX_BYTES,
        "updatedAt": modified,
    }

try:
    request_raw = base64.b64decode(REQUEST_B64)
    try:
        request_text = request_raw.decode("utf-8")
    except AttributeError:
        request_text = request_raw
    request = json.loads(request_text)
    validate_target()
    operation = request.get("operation")
    if operation == "get":
        if not os.path.exists(TARGET):
            atomic_write(decode_b64(request.get("defaultContentB64")))
    elif operation == "put":
        atomic_write(decode_b64(request.get("contentB64")))
    else:
        fail("unsupported AGENTS.md operation", 400)
    respond(response_payload())
except SystemExit:
    raise
except Exception as exc:
    fail(str(exc), 500)
`;
}

function parseRemoteInstructions(raw: string): RemoteInstructionsPayload {
  const jsonLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) throw httpError(502, `VM AGENTS.md service did not return JSON: ${raw.slice(0, 300)}`);
  return JSON.parse(jsonLine) as RemoteInstructionsPayload;
}

async function callRemoteInstructions(operation: InstructionsOperation, content?: string): Promise<VmAgentInstructionsResponse> {
  const result = await runSshCommandWithInput("python", remoteInstructionsScript(operation, content), 15_000);
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!result.ok) {
    throw httpError(502, result.error || result.stderr || "VM AGENTS.md SSH call failed");
  }
  const payload = parseRemoteInstructions(raw);
  if (payload.ok === false) {
    throw httpError(typeof payload.statusCode === "number" ? payload.statusCode : 502, payload.error || "VM AGENTS.md operation failed");
  }
  if (typeof payload.content !== "string") throw httpError(502, "VM AGENTS.md response was incomplete");
  return {
    ok: true,
    content: payload.content,
    fileName: VM_AGENT_INSTRUCTIONS_FILE,
    path: payload.path || "~/.sentaurus-web-agent/vm-agent/AGENTS.md",
    size: typeof payload.size === "number" ? payload.size : Buffer.byteLength(payload.content, "utf8"),
    maxBytes: VM_AGENT_INSTRUCTIONS_MAX_BYTES,
    updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : null
  };
}

export async function getVmAgentInstructions(): Promise<VmAgentInstructionsResponse> {
  return callRemoteInstructions("get");
}

export async function putVmAgentInstructions(content: unknown): Promise<VmAgentInstructionsResponse> {
  return callRemoteInstructions("put", validateVmAgentInstructionsContent(content));
}
