import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { VmAgentWorkflowResponse } from "@sentaurus-agent/shared";
import { config } from "../src/config.js";
import { vmAgentRoutes } from "../src/routes/vmAgent.js";
import { remoteVmAgentWorkflowScript } from "../src/services/vmAgentWorkflow.js";

const initial: VmAgentWorkflowResponse = {
  ok: true,
  capabilities: ["session_workflow_v1", "goal_lifecycle", "plan_mode"],
  workflow: {
    version: 1,
    revision: 0,
    sessionId: "run_test",
    goal: null,
    plan: { mode: "default", steps: [] }
  }
};

test("workflow relay uses a fixed worker path and encodes only structured input", () => {
  const script = remoteVmAgentWorkflowScript({
    operation: "patch",
    sessionId: "run_test",
    action: "goal.set",
    payload: { objective: "Calibrate threshold" }
  });
  assert.match(script, /WORKER_PATH = os\.path\.join\(HOME, "\.sentaurus-web-agent", "vm-agent", "agent_worker\.py"\)/);
  assert.doesNotMatch(script, /Calibrate threshold/);
  const encoded = script.match(/^REQUEST_B64 = "([A-Za-z0-9+/=]+)"$/m)?.[1];
  assert.ok(encoded);
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")), {
    action: "goal.set",
    operation: "patch",
    payload: { objective: "Calibrate threshold" },
    sessionId: "run_test"
  });
});

test("workflow routes require auth and validate actions before relaying", async () => {
  const updates: unknown[] = [];
  const app = Fastify();
  await app.register(vmAgentRoutes, {
    getVmAgentWorkflow: async () => initial,
    updateVmAgentWorkflow: async (_sessionId, update) => {
      updates.push(update);
      return {
        ...initial,
        workflow: {
            ...initial.workflow,
            revision: 1,
            goal: {
            objective: update.action === "goal.set" ? update.payload.objective : "goal",
            status: "active",
            createdAt: "2026-07-15T00:00:00Z",
            updatedAt: "2026-07-15T00:00:00Z"
          }
        }
      };
    }
  });

  assert.equal((await app.inject({ method: "GET", url: "/api/vm/agent/sessions/run_test/workflow" })).statusCode, 401);
  const headers = { authorization: `Bearer ${config.AUTH_TOKEN}` };
  const loaded = await app.inject({ method: "GET", url: "/api/vm/agent/sessions/run_test/workflow", headers });
  assert.equal(loaded.statusCode, 200);
  assert.equal(loaded.json().workflow.revision, 0);

  const updated = await app.inject({
    method: "PATCH",
    url: "/api/vm/agent/sessions/run_test/workflow",
    headers,
    payload: { action: "goal.set", expectedRevision: 0, payload: { objective: "Calibrate threshold" } }
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().workflow.goal.objective, "Calibrate threshold");
  assert.deepEqual(updates, [{ action: "goal.set", expectedRevision: 0, payload: { objective: "Calibrate threshold" } }]);

  const invalidAction = await app.inject({
    method: "PATCH",
    url: "/api/vm/agent/sessions/run_test/workflow",
    headers,
    payload: { action: "shell.run", payload: {} }
  });
  assert.equal(invalidAction.statusCode, 400);

  const invalidRevision = await app.inject({
    method: "PATCH",
    url: "/api/vm/agent/sessions/run_test/workflow",
    headers,
    payload: { action: "plan.enter", expectedRevision: -1 }
  });
  assert.equal(invalidRevision.statusCode, 400);

  const missingObjective = await app.inject({
    method: "PATCH",
    url: "/api/vm/agent/sessions/run_test/workflow",
    headers,
    payload: { action: "goal.set", payload: {} }
  });
  assert.equal(missingObjective.statusCode, 400);

  const invalidPlan = await app.inject({
    method: "PATCH",
    url: "/api/vm/agent/sessions/run_test/workflow",
    headers,
    payload: {
      action: "plan.set",
      payload: {
        steps: [
          { id: "one", step: "First", status: "in_progress" },
          { id: "two", step: "Second", status: "in_progress" }
        ]
      }
    }
  });
  assert.equal(invalidPlan.statusCode, 400);
  assert.equal(updates.length, 1);
  await app.close();
});
