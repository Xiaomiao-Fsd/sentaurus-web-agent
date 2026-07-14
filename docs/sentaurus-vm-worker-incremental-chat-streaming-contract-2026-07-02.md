# Sentaurus VM Worker Incremental Chat Streaming Contract

This note is for OpenClaw's VM worker change. The web client now accepts incremental assistant output, but the VM worker must publish partial messages instead of waiting until the full LLM answer is complete.

## Goal

- User message should appear immediately after send.
- The worklog timer should start while the worker is generating.
- Assistant text should grow incrementally in the chat panel, similar to Codex/VSCode output.
- Final completion should stop the active timer and leave one normal assistant message in the turn.

## Current Bottleneck

The host server calls the VM agent with `operation: "send"` and waits for a complete JSON payload. The existing SSE endpoint only forwards new history messages. If the VM worker stores only one final assistant message, the web UI can only display the full response at the end.

## Required VM Worker Protocol

### 1. Return quickly from `operation: "send"`

`send` should enqueue the request and return in a few seconds, not wait for LLM completion.

Return at minimum:

```json
{
  "ok": true,
  "protocolVersion": 3,
  "cursor": 123,
  "messages": [
    {
      "id": "user_<turnId>",
      "role": "user",
      "content": "original user text",
      "createdAt": "2026-07-02T05:00:00Z",
      "sequence": 123,
      "meta": {
        "sessionId": "run_...",
        "turnId": "turn_...",
        "kind": "user_message"
      }
    }
  ]
}
```

### 2. Persist every incremental event in history

Each generated chunk must be written to the same history/mailbox that `operation: "history"` reads. Every event needs a strictly increasing `sequence` / cursor so the host SSE poll can forward it.

Use a stable assistant message id per turn:

```text
assistant_<turnId>
```

### 3. Emit assistant deltas while generating

For each LLM text chunk, publish a message like:

```json
{
  "id": "delta_<turnId>_0001",
  "role": "agent",
  "content": "partial text chunk",
  "createdAt": "2026-07-02T05:00:01Z",
  "sequence": 124,
  "meta": {
    "kind": "agent_response_delta",
    "sessionId": "run_...",
    "turnId": "turn_...",
    "streamId": "assistant_<turnId>",
    "targetMessageId": "assistant_<turnId>",
    "append": true,
    "delta": true,
    "done": false,
    "streamState": "streaming"
  }
}
```

The web client appends `content` onto `targetMessageId`, so individual delta ids can be unique.

### 4. Emit worklog/progress as foldable messages

Progress, tool calls, file operations, and Sentaurus steps should keep using foldable worklog messages:

```json
{
  "id": "worklog_<turnId>_0002",
  "role": "agent",
  "content": "Step 1/3: sde main.cmd started",
  "createdAt": "2026-07-02T05:00:02Z",
  "sequence": 125,
  "meta": {
    "kind": "progress",
    "sessionId": "run_...",
    "turnId": "turn_...",
    "foldable": true,
    "status": "running",
    "progress": 33
  }
}
```

These messages appear in the collapsible work record under the user's question.

### 5. Emit one terminal assistant message

When generation finishes, publish either a full final replacement or an empty done marker.

Preferred full final replacement:

```json
{
  "id": "assistant_<turnId>",
  "role": "agent",
  "content": "complete final assistant answer",
  "createdAt": "2026-07-02T05:00:30Z",
  "sequence": 180,
  "meta": {
    "kind": "agent_response_done",
    "sessionId": "run_...",
    "turnId": "turn_...",
    "streamId": "assistant_<turnId>",
    "targetMessageId": "assistant_<turnId>",
    "append": false,
    "done": true,
    "streamState": "done"
  }
}
```

Acceptable empty done marker:

```json
{
  "id": "done_<turnId>",
  "role": "agent",
  "content": "",
  "createdAt": "2026-07-02T05:00:30Z",
  "sequence": 180,
  "meta": {
    "kind": "agent_response_done",
    "sessionId": "run_...",
    "turnId": "turn_...",
    "targetMessageId": "assistant_<turnId>",
    "done": true,
    "streamState": "done"
  }
}
```

### 6. Emit terminal errors

If generation fails, publish a terminal message so the web UI stops waiting:

```json
{
  "id": "assistant_<turnId>",
  "role": "system",
  "content": "LLM request failed: ...",
  "createdAt": "2026-07-02T05:00:30Z",
  "sequence": 180,
  "meta": {
    "kind": "llm_error",
    "sessionId": "run_...",
    "turnId": "turn_...",
    "done": true,
    "streamState": "error"
  }
}
```

## History API Requirements

`operation: "history"` must:

- Return all unseen delta/worklog/done messages when `after` is supplied.
- Preserve `sequence` ordering across user, worklog, delta, and final events.
- Support `sessionId` filtering for active chat refresh.
- Return the current accumulated assistant message or all deltas when `after=0`, so refreshing the browser reconstructs the visible draft/final response.

## Web Compatibility Notes

The web client already handles:

- `agent_response_delta` by appending chunk content to `targetMessageId`.
- `agent_response_stream` as an in-progress assistant draft.
- `agent_response_done` / `agent_response_error` as terminal assistant states.
- Existing `messages` SSE batches.
- Future direct SSE event names: `message`, `message_delta`, and `message_done`.

No host-side token stream is strictly required if VM history updates every chunk and the existing host SSE polls history once per second.
