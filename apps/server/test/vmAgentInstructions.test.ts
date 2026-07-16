import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Fastify from "fastify";
import type { VmAgentInstructionsResponse } from "@sentaurus-agent/shared";
import { config } from "../src/config.js";
import { vmAgentRoutes } from "../src/routes/vmAgent.js";
import { remoteAgentScript } from "../src/services/vmAgent.js";
import {
  validateVmAgentInstructionsContent,
  VM_AGENT_INSTRUCTIONS_MAX_BYTES
} from "../src/services/vmAgentInstructions.js";

const response: VmAgentInstructionsResponse = {
  ok: true,
  content: "# VM instructions\n",
  fileName: "AGENTS.md",
  path: "~/.sentaurus-web-agent/vm-agent/AGENTS.md",
  size: 18,
  maxBytes: VM_AGENT_INSTRUCTIONS_MAX_BYTES,
  updatedAt: "2026-07-14T00:00:00Z"
};

test("default VM AGENTS.md templates stay aligned and cover the simulation workflow", () => {
  const serverTemplate = readFileSync(new URL("../remote/AGENTS.md", import.meta.url), "utf8");
  const installerTemplate = readFileSync(new URL("../../../vm-worker/AGENTS.example.md", import.meta.url), "utf8");

  assert.equal(serverTemplate, installerTemplate);
  assert.ok(Buffer.byteLength(serverTemplate, "utf8") <= VM_AGENT_INSTRUCTIONS_MAX_BYTES);

  const connectScript = remoteAgentScript({ operation: "start" });
  const encodedTemplate = connectScript.match(/^AGENTS_SOURCE_B64 = "([A-Za-z0-9+/=]+)"$/m)?.[1];
  assert.ok(encodedTemplate);
  assert.equal(Buffer.from(encodedTemplate, "base64").toString("utf8"), serverTemplate);
  assert.match(connectScript, /if not os\.path\.lexists\(AGENTS_PATH\):/);
  assert.match(connectScript, /os\.O_WRONLY \| os\.O_CREAT \| os\.O_EXCL/);

  for (const requiredSection of [
    "## 3. 完成定义",
    "SDE -> mesh -> SDevice -> extraction/plot",
    "`dfise-idvg-v1`",
    "## 7. 绘图与数据质量",
    "## 8. 数据对比规则",
    "## 9. 论文阅读与仿真复现",
    "## 10. 模糊需求与参数优化",
    "## 12. 最终回复格式",
    "每段约 100 到 200 个中文字符",
    "当前阶段与完成进度"
  ]) {
    assert.match(serverTemplate, new RegExp(requiredSection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("AGENTS.md validation uses UTF-8 bytes and rejects invalid bodies", () => {
  assert.equal(validateVmAgentInstructionsContent("plain text"), "plain text");
  assert.throws(() => validateVmAgentInstructionsContent(null), /content must be a string/);
  assert.throws(
    () => validateVmAgentInstructionsContent("界".repeat(Math.ceil(VM_AGENT_INSTRUCTIONS_MAX_BYTES / 3) + 1)),
    /limited/
  );
});

test("AGENTS.md routes require auth and validate before writing", async () => {
  let savedContent = "";
  const app = Fastify();
  await app.register(vmAgentRoutes, {
    getVmAgentAgentsMd: async () => response,
    saveVmAgentAgentsMd: async (content) => {
      savedContent = String(content);
      return { ...response, content: savedContent, size: Buffer.byteLength(savedContent, "utf8") };
    }
  });

  const unauthorized = await app.inject({ method: "GET", url: "/api/vm/agent/agents-md" });
  assert.equal(unauthorized.statusCode, 401);

  const headers = { authorization: `Bearer ${config.AUTH_TOKEN}` };
  const loaded = await app.inject({ method: "GET", url: "/api/vm/agent/agents-md", headers });
  assert.equal(loaded.statusCode, 200);
  assert.equal(loaded.json().fileName, "AGENTS.md");

  const updated = await app.inject({
    method: "PUT",
    url: "/api/vm/agent/agents-md",
    headers,
    payload: { content: "updated" }
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(savedContent, "updated");

  const invalid = await app.inject({
    method: "PUT",
    url: "/api/vm/agent/agents-md",
    headers,
    payload: { content: 12 }
  });
  assert.equal(invalid.statusCode, 400);

  const oversized = await app.inject({
    method: "PUT",
    url: "/api/vm/agent/agents-md",
    headers,
    payload: { content: "x".repeat(VM_AGENT_INSTRUCTIONS_MAX_BYTES + 1) }
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(savedContent, "updated");

  await app.close();
});
