import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("standalone VM worker source matches the embedded worker source", async () => {
  const standaloneWorkerSource = await readFile(
    new URL("../../../vm-worker/agent_worker.py", import.meta.url),
    "utf8"
  );
  assert.equal(standaloneWorkerSource, embeddedWorkerSource());
});

test("VM worker enforces the model library, max reasoning, and context windows", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "sentaurus-worker-model-test-"));
  const scriptPath = path.join(temporaryHome, "worker_model_test.py");
  const harness = String.raw`
ensure_dir(ROOT)
with open(ENV_PATH, "w") as handle:
    handle.write("LLM_API_BASE=https://example.invalid/v1\n")
    handle.write("LLM_API_KEY=test-key\n")
    handle.write("LLM_MODEL=gpt-5.4\n")
    handle.write("LLM_MODELS=gpt-5.4,gpt-5.6-unknown\n")
    handle.write("LLM_API_STYLE=openai-responses\n")
config_54 = load_config()

with open(ENV_PATH, "w") as handle:
    handle.write("LLM_API_BASE=https://example.invalid/v1\n")
    handle.write("LLM_API_KEY=test-key\n")
    handle.write("LLM_MODEL=gpt-5.6-sol\n")
    handle.write("LLM_MODELS=gpt-5.6-sol\n")
    handle.write("LLM_API_STYLE=openai-responses\n")
config_56 = load_config()
payload = responses_request_payload("user", config_56, config_56.get("model"), "system")

print("WORKER_MODEL_RESULT=" + json.dumps({
    "allowedModels": ALLOWED_MODELS,
    "model54": config_54.get("model"),
    "models54": config_54.get("models"),
    "window54": config_54.get("context_window_tokens"),
    "target54": config_54.get("context_target_tokens"),
    "hard54": config_54.get("context_hard_tokens"),
    "model56": config_56.get("model"),
    "models56": config_56.get("models"),
    "window56": config_56.get("context_window_tokens"),
    "target56": config_56.get("context_target_tokens"),
    "hard56": config_56.get("context_hard_tokens"),
    "reasoning": payload.get("reasoning", {}).get("effort"),
    "timeout": config_56.get("llm_timeout_seconds"),
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
    const line = stdout.split(/\r?\n/).find((item) => item.startsWith("WORKER_MODEL_RESULT="));
    assert.ok(line, `worker model harness did not return its result: ${stdout.slice(0, 500)}`);
    assert.deepEqual(JSON.parse(line.slice("WORKER_MODEL_RESULT=".length)), {
      allowedModels: ["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
      hard54: 258400,
      hard56: 335350,
      model54: "gpt-5.4",
      model56: "gpt-5.6-sol",
      models54: ["gpt-5.4"],
      models56: ["gpt-5.6-sol"],
      reasoning: "max",
      target54: 231200,
      target56: 300050,
      timeout: 600,
      window54: 272000,
      window56: 353000
    });
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

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

test("VM worker silently skips queue files claimed by another worker", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "sentaurus-worker-queue-test-"));
  const scriptPath = path.join(temporaryHome, "worker_queue_test.py");
  const harness = String.raw`
ensure_dir(QUEUE_DIR)
captured_messages = []

def capture_message(*args, **kwargs):
    captured_messages.append({"args": args, "kwargs": kwargs})
    return {}

append_message = capture_message
missing_path = os.path.join(QUEUE_DIR, "missing.json")
missing_result = process_queue_file(missing_path)

queue_path = os.path.join(QUEUE_DIR, "queued.json")
with open(queue_path, "w") as handle:
    handle.write(json.dumps({"id": "queued", "content": "test", "meta": {}}))

class BusyFileLock(object):
    LOCK_EX = 1
    LOCK_NB = 2

    @staticmethod
    def flock(_fd, _operation):
        raise IOError(errno.EAGAIN, "already claimed")

previous_fcntl = fcntl
fcntl = BusyFileLock()
busy_result = process_queue_file(queue_path)
fcntl = previous_fcntl

claimed_handle = open_queue_file_for_processing(queue_path)
claimed_payload = json.load(claimed_handle) if claimed_handle is not None else None
if claimed_handle is not None:
    claimed_handle.close()

print("WORKER_QUEUE_RESULT=" + json.dumps({
    "missingResult": missing_result,
    "busyResult": busy_result,
    "capturedMessageCount": len(captured_messages),
    "queueStillExists": os.path.exists(queue_path),
    "claimedId": claimed_payload.get("id") if claimed_payload else None,
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
    const line = stdout.split(/\r?\n/).find((item) => item.startsWith("WORKER_QUEUE_RESULT="));
    assert.ok(line, `worker harness did not return its result: ${stdout.slice(0, 500)}`);
    assert.deepEqual(JSON.parse(line.slice("WORKER_QUEUE_RESULT=".length)), {
      busyResult: false,
      capturedMessageCount: 0,
      claimedId: "queued",
      missingResult: false,
      queueStillExists: true
    });
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
});
