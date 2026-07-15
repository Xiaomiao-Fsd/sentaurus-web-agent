import { createHash } from "node:crypto";
import type {
  VmAgentWorkflow,
  VmAgentWorkflowResponse,
  VmAgentWorkflowUpdateRequest
} from "@sentaurus-agent/shared";
import { runSshCommandWithInput } from "./sshClient.js";

type WorkflowRelayPayload = {
  ok?: boolean;
  error?: string;
  statusCode?: number;
  workflow?: VmAgentWorkflow;
  capabilities?: string[];
};

const workflowCapabilities = ["session_workflow_v1", "goal_lifecycle", "plan_mode"];

const remoteWorkflowRelay = String.raw`# -*- coding: utf-8 -*-
import base64
import json
import os
import re
import sys

try:
    string_types = (basestring,)
except NameError:
    string_types = (str,)

REQUEST_B64 = "__REQUEST_B64__"
HOME = os.path.expanduser("~")
WORKER_PATH = os.path.join(HOME, ".sentaurus-web-agent", "vm-agent", "agent_worker.py")

def fail(message, status_code=400):
    print(json.dumps({"ok": False, "error": message, "statusCode": status_code}, ensure_ascii=True, sort_keys=True))
    sys.exit(0)

def load_worker():
    if not os.path.isfile(WORKER_PATH):
        fail("VM agent worker does not support workflow state yet; run connect first", 409)
    os.environ["SENTAURUS_VM_AGENT_IMPORT_ONLY"] = "1"
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("sentaurus_vm_agent_workflow", WORKER_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except ImportError:
        import imp
        return imp.load_source("sentaurus_vm_agent_workflow", WORKER_PATH)

try:
    request = json.loads(base64.b64decode(REQUEST_B64).decode("utf-8"))
    session_id = request.get("sessionId") or ""
    if not isinstance(session_id, string_types) or not re.match(r"^[A-Za-z0-9_.:-]{1,160}$", session_id):
        fail("sessionId contains unsupported characters")
    worker = load_worker()
    if not hasattr(worker, "read_session_workflow") or not hasattr(worker, "apply_workflow_action"):
        fail("VM agent worker does not support workflow state yet; run connect first", 409)
    operation = (request.get("operation") or "get").strip().lower()
    if operation == "get":
        workflow = worker.read_session_workflow(session_id)
    elif operation == "patch":
        workflow = worker.apply_workflow_action(
            session_id,
            request.get("action") or "",
            request.get("payload") if isinstance(request.get("payload"), dict) else {},
            request.get("expectedRevision"),
        )
    else:
        fail("unsupported workflow operation")
    print(json.dumps({
        "ok": True,
        "workflow": workflow,
        "capabilities": ["session_workflow_v1", "goal_lifecycle", "plan_mode"],
    }, ensure_ascii=True, sort_keys=True))
except SystemExit:
    raise
except ValueError as exc:
    message = str(exc)
    status_code = 409 if message.startswith("workflow_conflict:") else 500 if message.startswith("workflow state ") else 400
    fail(message, status_code)
except Exception as exc:
    fail(str(exc), 500)
`;

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

export function remoteVmAgentWorkflowScript(request: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  return remoteWorkflowRelay.replace("__REQUEST_B64__", encoded);
}

function parseRelayPayload(raw: string): WorkflowRelayPayload {
  const jsonLine = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse()
    .find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) throw httpError(502, `VM workflow relay did not return JSON: ${raw.slice(0, 500)}`);
  return JSON.parse(jsonLine) as WorkflowRelayPayload;
}

async function callWorkflowRelay(
  request: Record<string, unknown>,
  signal?: AbortSignal
): Promise<VmAgentWorkflowResponse> {
  const serialized = JSON.stringify(request);
  const result = await runSshCommandWithInput(
    "python",
    remoteVmAgentWorkflowScript(request),
    20_000,
    {
      lane: "interactive",
      queueDeadlineMs: 10_000,
      dedupeKey: `vm-agent-workflow:${createHash("sha256").update(serialized).digest("hex")}`,
      signal
    }
  );
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!result.ok) throw httpError(502, result.error || result.stderr || "VM workflow relay failed");
  const payload = parseRelayPayload(raw);
  if (payload.ok !== true || !payload.workflow) {
    throw httpError(payload.statusCode || 502, payload.error || "VM workflow relay returned an incomplete response");
  }
  return {
    ok: true,
    workflow: payload.workflow,
    capabilities: payload.capabilities || workflowCapabilities
  };
}

export function getVmAgentWorkflow(sessionId: string, signal?: AbortSignal): Promise<VmAgentWorkflowResponse> {
  return callWorkflowRelay({ operation: "get", sessionId }, signal);
}

export function updateVmAgentWorkflow(
  sessionId: string,
  update: VmAgentWorkflowUpdateRequest,
  signal?: AbortSignal
): Promise<VmAgentWorkflowResponse> {
  return callWorkflowRelay({ operation: "patch", sessionId, ...update }, signal);
}
