import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { VmAgentHistoryResponse } from "@sentaurus-agent/shared";
import { mergeMessageList } from "../src/messageStreams.js";
import {
  assertHistoryResponse,
  completedSessionHistoryState,
  failedSessionHistoryState,
  filterConcurrentWorkerArtifacts,
  historyErrorDetails,
  isCurrentHistoryRequest,
  isHistoryBootstrapSettled,
  loadingSessionHistoryState,
  shouldLoadSelectedSessionHistory
} from "../src/sessionHistory.js";

const okStatus = {
  ok: true,
  agent: "sentaurus-vm-agent",
  version: "0.5.0",
  hostname: "vm",
  user: "tester",
  connected: true
};

test("hydration waits for the selected session attempt", () => {
  assert.equal(isHistoryBootstrapSettled(false, "run-a", null), false);
  assert.equal(isHistoryBootstrapSettled(true, "run-a", null), false);
  assert.equal(isHistoryBootstrapSettled(true, "run-a", "run-b"), false);
  assert.equal(isHistoryBootstrapSettled(true, "run-a", "run-a"), true);
  assert.equal(isHistoryBootstrapSettled(true, null, null), true);
});

test("stale history responses cannot replace a newer selection", () => {
  assert.equal(isCurrentHistoryRequest(4, 4, "run-a", "run-a"), true);
  assert.equal(isCurrentHistoryRequest(5, 4, "run-a", "run-a"), false);
  assert.equal(isCurrentHistoryRequest(4, 4, "run-b", "run-a"), false);
});

test("automatic hydration only runs for a session without cached history state", () => {
  assert.equal(shouldLoadSelectedSessionHistory(undefined), true);
  assert.equal(shouldLoadSelectedSessionHistory({ phase: "idle" }), true);
  assert.equal(shouldLoadSelectedSessionHistory({ phase: "loading" }), false);
  assert.equal(shouldLoadSelectedSessionHistory({ phase: "ready", cursor: 20 }), false);
  assert.equal(shouldLoadSelectedSessionHistory({ phase: "empty", cursor: 20 }), false);
  assert.equal(shouldLoadSelectedSessionHistory({ phase: "failed", cursor: 20 }), false);
  assert.equal(shouldLoadSelectedSessionHistory({ phase: "truncated", cursor: 20 }), false);
});

test("failed retry preserves the last valid message count and cursor", () => {
  const previous = { phase: "ready" as const, messageCount: 12, cursor: 345 };
  const loading = loadingSessionHistoryState(previous, true);
  assert.equal(loading.phase, "loading");
  assert.equal(loading.retrying, true);
  assert.equal(loading.messageCount, 12);
  assert.equal(loading.cursor, 345);

  const failed = failedSessionHistoryState(loading, {
    message: "history timed out",
    retryable: true
  });
  assert.deepEqual(failed, {
    phase: "failed",
    error: "history timed out",
    retryable: true,
    retrying: false,
    messageCount: 12,
    cursor: 345
  });
});

test("only a successful empty response becomes the empty state", () => {
  const response: VmAgentHistoryResponse = {
    ok: true,
    status: okStatus,
    messages: [],
    cursor: 22
  };
  assert.doesNotThrow(() => assertHistoryResponse(response));
  assert.deepEqual(completedSessionHistoryState(response), {
    phase: "empty",
    retryable: false,
    retrying: false,
    messageCount: 0,
    cursor: 22
  });

  const failedResponse: VmAgentHistoryResponse = {
    ok: false,
    status: { ...okStatus, ok: false, connected: false, error: "bridge failed" },
    messages: [],
    cursor: 22,
    error: "VM_HISTORY_BRIDGE_FAILED",
    message: "bridge failed",
    retryable: true
  };
  assert.throws(() => assertHistoryResponse(failedResponse), /bridge failed/);
  const error = (() => {
    try {
      assertHistoryResponse(failedResponse);
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  assert.deepEqual(historyErrorDetails(error, "fallback"), {
    message: "bridge failed",
    retryable: true,
    status: failedResponse.status
  });
});

test("concurrent worker artifacts collapse to one final without hiding unrelated errors or attachments", () => {
  const turnId = "turn-race";
  const messages = [
    { id: "web-1", role: "user", content: "question", createdAt: "2026-07-14T08:36:21Z", meta: { turnId } },
    { id: "worklog-1", role: "agent", content: "Calling model", createdAt: "2026-07-14T08:36:21Z", meta: { kind: "worklog_summary", turnId, phase: "planning" } },
    { id: "worklog-2", role: "agent", content: "Calling model", createdAt: "2026-07-14T08:36:22Z", meta: { kind: "worklog_summary", turnId, phase: "planning" } },
    { id: "final_1", role: "agent", content: "first accepted reply", createdAt: "2026-07-14T08:37:46Z", meta: { kind: "llm", turnId } },
    { id: "final_2", role: "agent", content: "second raced reply", createdAt: "2026-07-14T08:37:48Z", meta: { kind: "llm", turnId } },
    { id: "attach-1", role: "agent", content: "Published attachment", createdAt: "2026-07-14T08:37:48Z", meta: { kind: "vm_agent_attachments", turnId } },
    { id: "race-error", role: "system", content: "VM agent worker failed to process a message: [Errno 2] No such file or directory: '/home/user/.sentaurus-web-agent/vm-agent/queue/web_test.json'", createdAt: "2026-07-14T08:37:48Z", meta: { kind: "worker_error", sessionId: "run-a" } },
    { id: "real-error", role: "system", content: "VM agent worker failed to process a message: provider unavailable", createdAt: "2026-07-14T08:38:00Z", meta: { kind: "worker_error", sessionId: "run-a" } }
  ] as Parameters<typeof filterConcurrentWorkerArtifacts>[0];

  assert.deepEqual(filterConcurrentWorkerArtifacts(messages).map((message) => message.id), [
    "web-1",
    "worklog-1",
    "final_1",
    "attach-1",
    "real-error"
  ]);
});

test("frontend merges reasoning deltas into one completed thinking item", () => {
  const base = { role: "agent" as const, createdAt: "2026-07-15T00:00:00Z" };
  const messages = [
    { ...base, id: "delta-1", content: "Plan", meta: { kind: "agent_reasoning_summary_delta", sessionId: "run-a", turnId: "turn-a", targetMessageId: "reasoning-1", append: true, delta: true, thinkingStatus: "streaming" } },
    { ...base, id: "delta-2", content: " safely", meta: { kind: "agent_reasoning_summary_delta", sessionId: "run-a", turnId: "turn-a", targetMessageId: "reasoning-1", append: true, delta: true, thinkingStatus: "streaming" } },
    { ...base, id: "done", content: "Plan safely", meta: { kind: "agent_reasoning_summary_done", sessionId: "run-a", turnId: "turn-a", targetMessageId: "reasoning-1", done: true, streamState: "done", thinkingStatus: "completed" } },
    { ...base, id: "legacy-echo", content: "d", meta: { kind: "agent_reasoning_summary", sessionId: "run-a", turnId: "turn-a", summaryIndex: 2, thinkingStatus: "completed" } }
  ];
  const merged = mergeMessageList([], messages);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, "reasoning-1");
  assert.equal(merged[0]?.content, "Plan safely");
  assert.equal(merged[0]?.meta?.kind, "agent_reasoning_summary");
  assert.equal(merged[0]?.meta?.thinkingStatus, "completed");
  assert.equal(merged[0]?.meta?.done, true);
});


test("frontend context meter references the 1M model window", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /const REFERENCE_CONTEXT_TOKENS = 1_000_000/);
  assert.match(source, /function estimateTextTokens/);
  assert.match(source, /of 1.0m/);
});
