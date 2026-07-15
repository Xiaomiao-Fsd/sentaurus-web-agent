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
parsed_response = parse_responses_result({
    "output": [
        {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Public decision summary"}], "content": [{"text": "SECRET_RAW_REASONING"}]},
        {"type": "message", "content": [{"type": "output_text", "text": "Final answer"}]},
    ],
})

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
    "reasoningSummaryMode": payload.get("reasoning", {}).get("summary"),
    "parsedText": parsed_response.get("text"),
    "parsedSummaries": parsed_response.get("reasoningSummaries"),
    "rawReasoningHidden": "SECRET_RAW_REASONING" not in parsed_response.get("text", ""),
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
      parsedSummaries: ["Public decision summary"],
      parsedText: "Final answer",
      rawReasoningHidden: true,
      reasoning: "max",
      reasoningSummaryMode: "auto",
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

test("VM worker final reply is grounded in extracted metrics and publishes a safe execution summary", async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "sentaurus-worker-final-test-"));
  const scriptPath = path.join(temporaryHome, "worker_final_test.py");
  const harness = String.raw`
ensure_dir(ROOT)
failed_attempt = {
    "id": "run_failed",
    "status": "incomplete",
    "autoDebugAttempt": 1,
    "stepResults": [],
    "postprocessResults": [{
        "kind": "dfise-idvg-v1",
        "status": "incomplete",
        "exitCode": 0,
        "errorCode": "VTH_NOT_COVERED",
        "errorMessage": "target not covered",
        "request": {"lowInput": "low.plt", "highInput": "high.plt"},
    }],
}
successful_result = {
    "id": "run_success",
    "status": "succeeded",
    "autoDebugAttempt": 2,
    "stepResults": [
        {"tool": "sde", "input": "device.cmd", "exitCode": 0, "seconds": 8},
        {"tool": "sdevice", "input": "low.cmd", "exitCode": 0, "seconds": 47},
        {"tool": "sdevice", "input": "high.cmd", "exitCode": 0, "seconds": 55},
    ],
    "postprocessResults": [{
        "kind": "dfise-idvg-v1",
        "status": "ok",
        "exitCode": 0,
        "methods": {"ss": "two-point-log-interpolation-v1"},
        "request": {
            "ssMethod": "two-point-log-interpolation-v1",
            "ssCurrentMinAperUm": 1e-9,
            "ssCurrentMaxAperUm": 1e-8,
            "vthCurrentAperUm": 1e-7,
            "diblCurrentAperUm": 1e-7,
        },
        "inputs": {
            "low": {"actualVd": 0.05, "validPointCount": 259},
            "high": {"actualVd": 1.05, "validPointCount": 259},
        },
        "metrics": {
            "vthLowV": -0.281312715615,
            "vthHighV": -0.369251666394,
            "ssLowMvPerDec": 84.037617809,
            "ssHighMvPerDec": 88.9451122835,
            "diblMvPerV": 87.9389507793,
            "vgLowAtSsMinV": -0.448935783325,
            "vgLowAtSsMaxV": -0.364898165516,
            "vgHighAtSsMinV": -0.53,
            "vgHighAtSsMaxV": -0.441,
            "vgLowAtDiblCurrentV": -0.281312715615,
            "vgHighAtDiblCurrentV": -0.369251666394,
        },
        "outputs": {
            "plot": "artifacts/idvg_plot.png",
            "csv": "artifacts/idvg_extracted.csv",
            "metricsJson": "artifacts/idvg_metrics.json",
            "report": "artifacts/idvg_report.txt",
        },
    }],
    "artifacts": [],
}
attempts = [failed_attempt, successful_result]
final_reply = concise_run_final_reply("PRE_RUN_SHOULD_NOT_APPEAR", successful_result, attempts, "")
summary = execution_reasoning_summary(successful_result, attempts)
explicit_contract = explicit_idvg_contract("For SS, use Id=1e-8 to 1e-9 A/um.")
wrong_request = {"postprocess": [{
    "kind": "dfise-idvg-v1",
    "ssMethod": "max-adjacent-slope-v1",
    "ssCurrentMinAperUm": 1e-12,
    "ssCurrentMaxAperUm": 1e-7,
}]}
apply_locked_idvg_contract(wrong_request, explicit_contract)
initial_contract_request = {"postprocess": [{
    "kind": "dfise-idvg-v1",
    "ssMethod": "two-point-log-interpolation-v1",
    "ssCurrentMinAperUm": 1e-9,
    "ssCurrentMaxAperUm": 1e-8,
    "diblCurrentAperUm": 1e-7,
}]}
locked_contract = locked_idvg_contract("", initial_contract_request)
repair_request = {"postprocess": [{"kind": "dfise-idvg-v1"}]}
apply_locked_idvg_contract(repair_request, locked_contract)
append_reasoning_summary("session_final", "turn_final", "final", summary, "run_success")
reasoning_messages = [item for item in read_all_messages() if item.get("meta", {}).get("kind") == "agent_reasoning_summary"]
print("WORKER_FINAL_RESULT=" + json.dumps({
    "finalReply": final_reply,
    "summary": summary,
    "reasoningCount": len(reasoning_messages),
    "reasoningSource": reasoning_messages[-1].get("source") if reasoning_messages else "",
    "explicitContract": explicit_contract,
    "correctedSpec": wrong_request.get("postprocess", [{}])[0],
    "repairSpec": repair_request.get("postprocess", [{}])[0],
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
    const line = stdout.split(/\r?\n/).find((item) => item.startsWith("WORKER_FINAL_RESULT="));
    assert.ok(line, `worker final harness did not return its result: ${stdout.slice(0, 500)}`);
    const result = JSON.parse(line.slice("WORKER_FINAL_RESULT=".length)) as Record<string, any>;
    assert.doesNotMatch(result.finalReply, /PRE_RUN_SHOULD_NOT_APPEAR/);
    assert.match(result.finalReply, /SS_low=84\.037618 mV\/dec/);
    assert.match(result.finalReply, /DIBL=87\.938951 mV\/V/);
    assert.match(result.finalReply, /Id=1e-09 -> 1e-08 A\/um/);
    assert.match(result.finalReply, /artifacts\/idvg_metrics\.json/);
    assert.match(result.summary, /VTH_NOT_COVERED/);
    assert.deepEqual(result.explicitContract, {
      ssCurrentMaxAperUm: 1e-8,
      ssCurrentMinAperUm: 1e-9,
      ssMethod: "two-point-log-interpolation-v1"
    });
    assert.equal(result.correctedSpec.ssMethod, "two-point-log-interpolation-v1");
    assert.equal(result.correctedSpec.ssCurrentMinAperUm, 1e-9);
    assert.equal(result.correctedSpec.ssCurrentMaxAperUm, 1e-8);
    assert.equal(result.repairSpec.diblCurrentAperUm, 1e-7);
    assert.equal(result.repairSpec.ssMethod, "two-point-log-interpolation-v1");
    assert.equal(result.reasoningCount, 1);
    assert.equal(result.reasoningSource, "vm-agent-thinking");
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
parsed_plan = parse_local_command("/plan")
parsed_side = parse_local_command("/side inspect independently")
set_reply, set_meta = local_goal_reply("session_a", parsed_goal.get("args"))
active_after_set = session_goal_text("session_a")
paused_reply, paused_meta = local_goal_reply("session_a", "pause")
active_while_paused = session_goal_text("session_a")
paused_workflow_has_goal_text = "Calibrate threshold" in workflow_prompt_context(read_session_workflow("session_a"))
resumed_reply, resumed_meta = local_goal_reply("session_a", "resume")
plan_reply, plan_meta = local_plan_reply("session_a", "")
workflow_in_plan = read_session_workflow("session_a")
workflow_with_steps = apply_workflow_action("session_a", "plan.set", {
    "explanation": "Inspect before execution",
    "steps": [
        {"id": "inspect", "step": "Inspect inputs", "status": "in_progress"},
        {"id": "run", "step": "Run simulation", "status": "pending"},
    ],
})
plan_invariant_error = ""
try:
    apply_workflow_action("session_a", "plan.step", {"stepId": "run", "status": "in_progress"})
except Exception as exc:
    plan_invariant_error = str(exc)
stale_revision_error = ""
try:
    apply_workflow_action("session_a", "goal.pause", {}, 0)
except Exception as exc:
    stale_revision_error = str(exc)
workflow_lock_exists = os.path.exists(session_workflow_path("session_a") + ".lock")
apply_workflow_action("session_empty_plan", "plan.enter")
empty_plan_approve_error = ""
try:
    apply_workflow_action("session_empty_plan", "plan.approve")
except Exception as exc:
    empty_plan_approve_error = str(exc)
empty_plan_reply, empty_plan_meta = reply_for("/plan approve", "session_empty_plan")
approval_proposal = apply_workflow_action("session_approval", "plan.set", {
    "steps": [{"id": "inspect", "step": "Inspect inputs", "status": "pending"}],
})
approved_workflow = apply_workflow_action("session_approval", "plan.approve", {}, approval_proposal.get("revision"))
corrupt_workflow_path = session_workflow_path("session_corrupt")
with open(corrupt_workflow_path, "w") as handle:
    handle.write("{broken")
corrupt_workflow_error = ""
try:
    apply_workflow_action("session_corrupt", "goal.set", {"objective": "must not overwrite"})
except Exception as exc:
    corrupt_workflow_error = str(exc)
with open(corrupt_workflow_path, "r") as handle:
    corrupt_workflow_preserved = handle.read() == "{broken"

ensure_dir(QUEUE_DIR)
ensure_dir(DONE_DIR)
blocked_run_calls = []
def reply_for(_text, _session_id="", _current_message_id=""):
    if _session_id == "session_race":
        apply_workflow_action(_session_id, "plan.enter")
        return "<SENTAURUS_RUN_REQUEST>{\"title\":\"blocked\",\"files\":[{\"name\":\"main.cmd\",\"content\":\"File {}\"}],\"steps\":[{\"tool\":\"sdevice\",\"input\":\"main.cmd\"}]}</SENTAURUS_RUN_REQUEST>", {"kind": "llm"}
    return "Planning only\n<SENTAURUS_RUN_REQUEST>{\"title\":\"blocked\",\"files\":[{\"name\":\"main.cmd\",\"content\":\"File {}\"}],\"steps\":[{\"tool\":\"sdevice\",\"input\":\"main.cmd\"}]}</SENTAURUS_RUN_REQUEST>", {"kind": "llm"}
def run_with_autodebug(*_args, **_kwargs):
    blocked_run_calls.append(True)
    raise Exception("plan mode must not execute")
blocked_queue_path = os.path.join(QUEUE_DIR, "plan-blocked.json")
with open(blocked_queue_path, "w") as handle:
    handle.write(json.dumps({
        "id": "plan-blocked",
        "content": "run despite plan mode",
        "meta": {"sessionId": "session_a", "turnId": "turn_plan_blocked"},
    }))
blocked_processed = process_queue_file(blocked_queue_path)
blocked_messages = [item for item in read_all_messages() if item.get("meta", {}).get("turnId") == "turn_plan_blocked" and item.get("role") == "agent"]
blocked_visible = blocked_messages[-1].get("content") if blocked_messages else ""
blocked_errors = [item.get("content") for item in read_all_messages() if item.get("meta", {}).get("kind") == "worker_error"]

race_queue_path = os.path.join(QUEUE_DIR, "plan-race.json")
with open(race_queue_path, "w") as handle:
    handle.write(json.dumps({
        "id": "plan-race",
        "content": "run while another client enters plan mode",
        "meta": {"sessionId": "session_race", "turnId": "turn_plan_race"},
    }))
race_processed = process_queue_file(race_queue_path)
race_messages = [item for item in read_all_messages() if item.get("meta", {}).get("turnId") == "turn_plan_race" and item.get("role") == "agent"]
race_visible = race_messages[-1].get("content") if race_messages else ""

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
    "planName": parsed_plan.get("name"),
    "sideName": parsed_side.get("name"),
    "sideArgument": parsed_side.get("args"),
    "setKind": set_meta.get("kind"),
    "activeAfterSet": active_after_set,
    "activeWhilePaused": active_while_paused,
    "approvedPlanHasTimestamp": bool(approved_workflow.get("plan", {}).get("approvedAt")),
    "approvedPlanMode": approved_workflow.get("plan", {}).get("mode"),
    "emptyPlanApproveError": empty_plan_approve_error,
    "emptyPlanCommandError": empty_plan_meta.get("kind"),
    "emptyPlanReplyHasReason": "no steps to approve" in empty_plan_reply,
    "pausedStatus": paused_meta.get("goalStatus"),
    "pausedWorkflowHasGoalText": paused_workflow_has_goal_text,
    "resumedStatus": resumed_meta.get("goalStatus"),
    "planMode": workflow_in_plan.get("plan", {}).get("mode"),
    "planKind": plan_meta.get("kind"),
    "planStepCount": len(workflow_with_steps.get("plan", {}).get("steps") or []),
    "planInvariantError": plan_invariant_error,
    "staleRevisionError": stale_revision_error,
    "workflowLockExists": workflow_lock_exists,
    "planBlockedProcessed": blocked_processed,
    "planBlockedError": blocked_errors[-1] if blocked_errors else "",
    "planBlockedRunCalls": len(blocked_run_calls),
    "planBlockedVisibleHasRunTag": "SENTAURUS_RUN_REQUEST" in blocked_visible,
    "planRaceMode": read_session_workflow("session_race").get("plan", {}).get("mode"),
    "planRaceProcessed": race_processed,
    "planRaceBlockNotice": "execution and file publication were blocked" in race_visible,
    "planRaceVisibleHasRunTag": "SENTAURUS_RUN_REQUEST" in race_visible,
    "structuredOnlySuppressed": "suppressed for this read-only response" in strip_structured_reply_blocks("<SENTAURUS_RUN_REQUEST>{\"title\":\"blocked\"}</SENTAURUS_RUN_REQUEST>"),
    "unterminatedStructuredSuppressed": "suppressed for this read-only response" in strip_structured_reply_blocks("<SENTAURUS_RUN_REQUEST>{broken"),
    "completeKind": complete_meta.get("kind"),
    "corruptWorkflowRejected": corrupt_workflow_error.startswith("workflow state is unreadable:"),
    "corruptWorkflowPreserved": corrupt_workflow_preserved,
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
      activeWhilePaused: "",
      approvedPlanHasTimestamp: true,
      approvedPlanMode: "default",
      completeKind: "goal_cleared",
      corruptWorkflowPreserved: true,
      corruptWorkflowRejected: true,
      emptyPlanApproveError: "plan has no steps to approve",
      emptyPlanCommandError: "command_error",
      emptyPlanReplyHasReason: true,
      goalName: "goal",
      normalHasAgents: true,
      normalHasGoal: true,
      normalHasMain: true,
      normalHasSide: false,
      pausedStatus: "paused",
      pausedWorkflowHasGoalText: false,
      planInvariantError: "plan may contain at most one in_progress step",
      planBlockedProcessed: true,
      planBlockedError: "",
      planBlockedRunCalls: 0,
      planBlockedVisibleHasRunTag: false,
      planKind: "plan_mode",
      planMode: "plan",
      planName: "plan",
      planRaceBlockNotice: true,
      planRaceMode: "plan",
      planRaceProcessed: true,
      planRaceVisibleHasRunTag: false,
      planStepCount: 2,
      resumedStatus: "active",
      setKind: "goal_updated",
      sideArgument: "inspect independently",
      sideDeclaresIsolation: true,
      sideHasAgents: true,
      sideHasGoal: true,
      sideName: "side",
      staleRevisionError: "workflow_conflict: expected revision 0 but found 5",
      structuredOnlySuppressed: true,
      unterminatedStructuredSuppressed: true,
      workflowLockExists: true
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
