import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { remoteAgentScript } from "../src/services/vmAgent.js";

const execFileAsync = promisify(execFile);

function embeddedWorkerSource(): string {
  const controlScript = remoteAgentScript({ operation: "status" });
  const encoded = controlScript.match(/^WORKER_SOURCE_B64 = "([A-Za-z0-9+/=]+)"$/m)?.[1];
  assert.ok(encoded, "remote control script should contain the encoded worker source");
  return Buffer.from(encoded, "base64").toString("utf8");
}

test("VM worker commands persist goals and isolate side context", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "sentaurus-worker-command-test-"));
  const scriptPath = path.join(temporaryHome, "worker_test.py");
  const harness = String.raw`
ensure_dir(ROOT)
with open(GLOBAL_AGENTS_PATH, "w") as handle:
    handle.write("AGENT_TEST_MARKER\n")

parsed_goal = parse_local_command("/goal Calibrate threshold")
parsed_side = parse_local_command("/side inspect independently")
set_reply, set_meta = local_goal_reply("session_a", parsed_goal.get("args"))
active_after_set = session_goal_text("session_a")

append_jsonl(MESSAGES_PATH, {
    "id": "main-message",
    "role": "user",
    "content": "MAIN_CONTEXT_MARKER",
    "createdAt": now_iso(),
    "meta": {"sessionId": "session_a"},
})
append_jsonl(MESSAGES_PATH, {
    "id": "side-message",
    "role": "agent",
    "content": "SIDE_CONTEXT_MARKER",
    "createdAt": now_iso(),
    "meta": {"sessionId": "session_a", "contextScope": "side", "kind": "side_investigation"},
})

normal_recent = session_context("session_a")
normal_agents = read_global_agents_context()
normal_goal = session_goal_text("session_a")
normal_prompt = build_llm_system_prompt({}, normal_recent, "manual", normal_goal, normal_agents)
side_prompt = build_side_investigation_prompt({}, normal_recent, "manual", normal_goal, normal_agents)
complete_reply, complete_meta = local_goal_reply("session_a", "clear")

print("WORKER_COMMAND_RESULT=" + json.dumps({
    "goalName": parsed_goal.get("name"),
    "sideName": parsed_side.get("name"),
    "sideArgument": parsed_side.get("args"),
    "setKind": set_meta.get("kind"),
    "activeAfterSet": active_after_set,
    "completeKind": complete_meta.get("kind"),
    "activeAfterComplete": session_goal_text("session_a"),
    "normalHasAgents": "AGENT_TEST_MARKER" in normal_prompt,
    "sideHasAgents": "AGENT_TEST_MARKER" in side_prompt,
    "normalHasGoal": "Calibrate threshold" in normal_prompt,
    "sideHasGoal": "Calibrate threshold" in side_prompt,
    "normalHasMain": "MAIN_CONTEXT_MARKER" in normal_recent,
    "normalHasSide": "SIDE_CONTEXT_MARKER" in normal_recent,
    "sideDeclaresIsolation": "side investigation" in side_prompt,
}, ensure_ascii=True, sort_keys=True))
`;

  try {
    await writeFile(scriptPath, `${embeddedWorkerSource()}\n${harness}`, "utf8");
    const { stdout } = await execFileAsync(process.env.PYTHON || "python", [scriptPath], {
      env: {
        ...process.env,
        HOME: temporaryHome,
        USERPROFILE: temporaryHome,
        SENTAURUS_VM_AGENT_IMPORT_ONLY: "1"
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 20_000
    });
    const line = stdout.split(/\r?\n/).find((item) => item.startsWith("WORKER_COMMAND_RESULT="));
    assert.ok(line, `worker harness did not return its result: ${stdout.slice(0, 500)}`);
    const result = JSON.parse(line.slice("WORKER_COMMAND_RESULT=".length)) as Record<string, unknown>;
    assert.deepEqual(result, {
      activeAfterComplete: "",
      activeAfterSet: "Calibrate threshold",
      completeKind: "goal_cleared",
      goalName: "goal",
      normalHasAgents: true,
      normalHasGoal: true,
      normalHasMain: true,
      normalHasSide: false,
      setKind: "goal_updated",
      sideArgument: "inspect independently",
      sideDeclaresIsolation: true,
      sideHasAgents: true,
      sideHasGoal: true,
      sideName: "side"
    });
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});
