import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { VmAgentInstructionsResponse } from "@sentaurus-agent/shared";
import { config } from "../src/config.js";
import { vmAgentRoutes } from "../src/routes/vmAgent.js";
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
