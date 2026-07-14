import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import Fastify from "fastify";
import type { VmAgentModelsResponse, VmAgentStatus } from "@sentaurus-agent/shared";
import { config } from "../src/config.js";
import { vmAgentRoutes } from "../src/routes/vmAgent.js";
import {
  parseVmAgentModelId,
  remoteVmAgentModelConfigScript,
  VM_AGENT_MODEL_IDS,
  VM_AGENT_REASONING_EFFORT,
  vmAgentContextWindowTokens,
  vmAgentModelCatalog
} from "../src/services/vmAgentModels.js";

const execFileAsync = promisify(execFile);

function response(currentModel: "gpt-5.5" | "gpt-5.6-sol" = "gpt-5.5"): VmAgentModelsResponse {
  const status: VmAgentStatus = {
    ok: true,
    checkedAt: "2026-07-14T00:00:00Z",
    sshTarget: "sentaurus-centos7",
    connected: true,
    workerRunning: true,
    llmModel: currentModel,
    llmModels: [currentModel],
    llmReasoningEffort: "max",
    llmContextWindowTokens: vmAgentContextWindowTokens(currentModel)
  };
  return {
    ok: true,
    currentModel,
    activeModels: [currentModel],
    reasoningEffort: "max",
    contextWindowTokens: vmAgentContextWindowTokens(currentModel),
    models: vmAgentModelCatalog(),
    status
  };
}

test("VM model catalog is closed and applies model-family context windows", () => {
  assert.deepEqual(VM_AGENT_MODEL_IDS, [
    "gpt-5.4",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol"
  ]);
  assert.equal(VM_AGENT_REASONING_EFFORT, "max");
  assert.equal(vmAgentContextWindowTokens("gpt-5.4"), 272000);
  assert.equal(vmAgentContextWindowTokens("gpt-5.5"), 272000);
  assert.equal(vmAgentContextWindowTokens("gpt-5.6-luna"), 353000);
  assert.equal(vmAgentContextWindowTokens("gpt-5.6-terra"), 353000);
  assert.equal(vmAgentContextWindowTokens("gpt-5.6-sol"), 353000);
  assert.throws(() => parseVmAgentModelId("gpt-5.6-unknown"), /model must be one of/);
});

test("remote model configuration preserves secrets and atomically replaces model fields", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "sentaurus-model-config-test-"));
  const root = path.join(temporaryHome, ".sentaurus-web-agent", "vm-agent");
  const envPath = path.join(root, ".env");
  const scriptPath = path.join(temporaryHome, "set_model.py");
  await mkdir(root, { recursive: true });
  await writeFile(envPath, [
    "LLM_API_BASE=https://example.invalid/v1",
    "LLM_API_KEY=keep-this-secret",
    "LLM_MODEL=gpt-5.5",
    "LLM_MODELS=gpt-5.5,gpt-5.4",
    "LLM_MODEL=duplicate-must-disappear",
    "CUSTOM_SETTING=preserved"
  ].join("\n") + "\n", "utf8");
  await chmod(envPath, 0o600);
  await writeFile(scriptPath, remoteVmAgentModelConfigScript("gpt-5.6-terra"), "utf8");

  try {
    const { stdout } = await execFileAsync(process.env.PYTHON || "python", [scriptPath], {
      env: { ...process.env, HOME: temporaryHome, USERPROFILE: temporaryHome },
      timeout: 20_000
    });
    const result = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const updated = await readFile(envPath, "utf8");
    assert.equal(result.model, "gpt-5.6-terra");
    assert.equal(result.reasoningEffort, "max");
    assert.equal(result.contextWindowTokens, 353000);
    assert.match(updated, /^LLM_API_KEY=keep-this-secret$/m);
    assert.match(updated, /^CUSTOM_SETTING=preserved$/m);
    assert.match(updated, /^LLM_MODEL=gpt-5\.6-terra$/m);
    assert.match(updated, /^LLM_MODELS=gpt-5\.6-terra$/m);
    assert.match(updated, /^LLM_API_STYLE=openai-responses$/m);
    assert.match(updated, /^LLM_REASONING_EFFORT=max$/m);
    assert.equal((updated.match(/^LLM_MODEL=/gm) || []).length, 1);
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test("model routes require auth, reject unknown models, and call the injected switcher", async () => {
  let selected = "";
  const app = Fastify();
  await app.register(vmAgentRoutes, {
    getVmAgentModels: async () => response(),
    setVmAgentModel: async (model) => {
      selected = String(model);
      return response(model === "gpt-5.6-sol" ? model : "gpt-5.5");
    }
  });
  const headers = { authorization: `Bearer ${config.AUTH_TOKEN}` };

  assert.equal((await app.inject({ method: "GET", url: "/api/vm/agent/models" })).statusCode, 401);
  const listed = await app.inject({ method: "GET", url: "/api/vm/agent/models", headers });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().models.length, 5);

  const switched = await app.inject({
    method: "PUT",
    url: "/api/vm/agent/model",
    headers,
    payload: { model: "gpt-5.6-sol" }
  });
  assert.equal(switched.statusCode, 200);
  assert.equal(switched.json().currentModel, "gpt-5.6-sol");
  assert.equal(selected, "gpt-5.6-sol");

  const invalid = await app.inject({
    method: "PUT",
    url: "/api/vm/agent/model",
    headers,
    payload: { model: "gpt-5.6-unknown" }
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(selected, "gpt-5.6-sol");
  await app.close();
});
