export const VM_AGENT_MODEL_IDS = [
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol"
] as const;

export type VmAgentModelId = typeof VM_AGENT_MODEL_IDS[number];

export const VM_AGENT_REASONING_EFFORT = "max" as const;
export const VM_AGENT_LLM_TIMEOUT_SECONDS = 600;

export function isVmAgentModelId(value: unknown): value is VmAgentModelId {
  return typeof value === "string" && (VM_AGENT_MODEL_IDS as readonly string[]).includes(value);
}

export function parseVmAgentModelId(value: unknown): VmAgentModelId {
  if (isVmAgentModelId(value)) return value;
  const error = new Error(`model must be one of: ${VM_AGENT_MODEL_IDS.join(", ")}`) as Error & { statusCode?: number };
  error.statusCode = 400;
  throw error;
}

export function vmAgentContextWindowTokens(model: string): 272000 | 353000 {
  return model.startsWith("gpt-5.6-") ? 353000 : 272000;
}

export function vmAgentModelCatalog(): Array<{ id: VmAgentModelId; contextWindowTokens: 272000 | 353000 }> {
  return VM_AGENT_MODEL_IDS.map((id) => ({ id, contextWindowTokens: vmAgentContextWindowTokens(id) }));
}

export function remoteVmAgentModelConfigScript(model: VmAgentModelId): string {
  const payload = Buffer.from(JSON.stringify({
    model,
    models: [model],
    reasoningEffort: VM_AGENT_REASONING_EFFORT,
    timeoutSeconds: VM_AGENT_LLM_TIMEOUT_SECONDS
  }), "utf8").toString("base64");

  return String.raw`# -*- coding: utf-8 -*-
import base64
import json
import os
import sys

ROOT = os.path.join(os.path.expanduser("~"), ".sentaurus-web-agent", "vm-agent")
ENV_PATH = os.path.join(ROOT, ".env")
REQUEST = json.loads(base64.b64decode("__MODEL_CONFIG_B64__").decode("utf-8"))
ALLOWED_MODELS = set(["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"])

model = REQUEST.get("model")
if model not in ALLOWED_MODELS:
    raise ValueError("unsupported VM agent model")

updates = {
    "LLM_MODEL": model,
    "LLM_MODELS": ",".join(REQUEST.get("models") or [model]),
    "LLM_API_STYLE": "openai-responses",
    "LLM_REASONING_EFFORT": "max",
    "VM_AGENT_LLM_TIMEOUT_SECONDS": str(int(REQUEST.get("timeoutSeconds") or 600)),
}

if not os.path.isdir(ROOT):
    os.makedirs(ROOT)

lines = []
if os.path.exists(ENV_PATH):
    with open(ENV_PATH, "r") as handle:
        lines = handle.read().splitlines()

output = []
written = set()
for line in lines:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in line:
        output.append(line)
        continue
    key = line.split("=", 1)[0].strip()
    if key in updates:
        if key not in written:
            output.append(key + "=" + updates[key])
            written.add(key)
        continue
    output.append(line)

for key in ["LLM_MODEL", "LLM_MODELS", "LLM_API_STYLE", "LLM_REASONING_EFFORT", "VM_AGENT_LLM_TIMEOUT_SECONDS"]:
    if key not in written:
        output.append(key + "=" + updates[key])

encoded = ("\n".join(output).rstrip("\n") + "\n").encode("utf-8")
temporary = ENV_PATH + ".model-" + str(os.getpid()) + ".tmp"
descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    with os.fdopen(descriptor, "wb") as handle:
        descriptor = None
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
finally:
    if descriptor is not None:
        os.close(descriptor)

if hasattr(os, "replace"):
    os.replace(temporary, ENV_PATH)
else:
    os.rename(temporary, ENV_PATH)
os.chmod(ENV_PATH, 0o600)
print(json.dumps({
    "ok": True,
    "model": model,
    "models": REQUEST.get("models") or [model],
    "reasoningEffort": "max",
    "contextWindowTokens": 353000 if model.startswith("gpt-5.6-") else 272000,
}, sort_keys=True))
`.replace("__MODEL_CONFIG_B64__", payload);
}
