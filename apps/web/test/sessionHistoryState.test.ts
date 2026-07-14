import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { VmAgentHistoryResponse } from "@sentaurus-agent/shared";
import {
  assertHistoryResponse,
  completedSessionHistoryState,
  failedSessionHistoryState,
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


test("frontend context meter references the 1M model window", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /const REFERENCE_CONTEXT_TOKENS = 1_000_000/);
  assert.match(source, /function estimateTextTokens/);
  assert.match(source, /of 1.0m/);
});
