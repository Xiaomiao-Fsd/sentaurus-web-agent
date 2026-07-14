import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("server source wires AGENTS.md relay and local worker sync", () => {
  const serviceSource = readFileSync(new URL("../src/services/vmAgent.ts", import.meta.url), "utf8");
  const routeSource = readFileSync(new URL("../src/routes/vmAgent.ts", import.meta.url), "utf8");
  const workerSource = readFileSync(new URL("../../../agent_worker.py", import.meta.url), "utf8");

  assert.match(serviceSource, /const localWorkerSource = readFileSync\(new URL\("\.\.\/\.\.\/\.\.\/\.\.\/agent_worker\.py"/);
  assert.match(serviceSource, /remoteAgentsMdScript/);
  assert.match(serviceSource, /export async function getVmAgentAgentsMd/);
  assert.match(serviceSource, /export async function saveVmAgentAgentsMd/);

  assert.match(routeSource, /"\/api\/vm\/agent\/agents-md"/);
  assert.match(routeSource, /app\.put<\{ Body: VmAgentAgentsMdUpdateRequest \}>\("\/api\/vm\/agent\/agents-md"/);

  assert.match(workerSource, /GLOBAL_AGENTS_PATH/);
  assert.match(workerSource, /def read_global_agents_context/);
  assert.match(workerSource, /def side_investigation_reply/);
  assert.match(workerSource, /def local_goal_reply/);
  assert.match(workerSource, /def excluded_from_main_context/);
  assert.match(workerSource, /command\.get\("name"\) in \["status", "help", "goal", "side"\]/);
});
