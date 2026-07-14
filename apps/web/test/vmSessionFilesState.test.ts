import assert from "node:assert/strict";
import test from "node:test";
import { vmSessionFilesCompletionState } from "../src/vmSessionFilesState.js";

test("stale session-files completion cannot clear a replacement request loading state", () => {
  const stale = {};
  const replacement = {};
  assert.deepEqual(vmSessionFilesCompletionState(replacement, stale), {
    ownsActiveRequest: false,
    shouldClearLoading: false
  });
});

test("active or final session-files completion clears loading state", () => {
  const request = {};
  assert.deepEqual(vmSessionFilesCompletionState(request, request), {
    ownsActiveRequest: true,
    shouldClearLoading: true
  });
  assert.deepEqual(vmSessionFilesCompletionState(null, request), {
    ownsActiveRequest: false,
    shouldClearLoading: true
  });
});
