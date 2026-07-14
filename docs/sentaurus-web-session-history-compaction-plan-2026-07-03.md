# Sentaurus Web Session History Compaction Plan

Date: 2026-07-03

Target owner: downstream web/backend agent

Scope:

- Host backend history API
- Web frontend history fetch limits
- Compatibility with VM worker incremental streaming protocol

This plan is based on OpenClaw feedback: the current history limit is too low, so refreshing the page can miss older session messages. OpenClaw recommends host-side session history compaction: merge incremental assistant deltas into one `assistant_<turnId>` message before returning session history.

## Problem

The VM worker now supports or is expected to support incremental assistant output:

- `agent_response_delta` messages for token/chunk updates
- optional progress/worklog messages
- `agent_response_done` terminal messages

This is good for live streaming, but it increases history volume. A single assistant answer can produce hundreds or thousands of delta messages.

Current web/backend limits are too low:

- Backend route `parseLimit(...)` caps history requests at `1000`.
- Backend service `getVmAgentMessages(...)` defaults to `50`.
- Frontend selected-session refresh uses `limit: 500`.
- Frontend pending-reply full polling uses `limit: 500`.
- Frontend selected-session load uses `limit: 500`.
- Global refresh uses `limit: 100`.

Result:

When the browser refreshes, the frontend may only receive recent delta fragments and miss the original user message, earlier assistant content, or terminal done message. The chat then looks incomplete even if VM history contains the data.

## Current Code Locations

Backend route:

```text
apps/server/src/routes/vmAgent.ts
```

Relevant current behavior:

```ts
function parseLimit(value: unknown, fallback = 50): number {
  ...
  return Math.min(parsed, 1000);
}
```

Backend service:

```text
apps/server/src/services/vmAgent.ts
```

Relevant functions:

```text
normalizeMessages(...)
getVmAgentMessages(after = 0, limit = 50, sessionId?)
sendVmAgentMessage(...)
```

Frontend:

```text
apps/web/src/App.tsx
apps/web/src/api/vmAgent.ts
```

Relevant current calls:

```ts
getVmAgentMessages(0, { limit: 500, sessionId: selectedRunId })
getVmAgentMessages(0, { limit: 500, sessionId: requestedSessionId })
getVmAgentMessages(0, { limit: 500, sessionId: selectedRunId })
getVmAgentMessages(0, { limit: 100 })
getVmAgentMessages(vmAgentCursorRef.current, { limit: 100 })
```

## Goals

1. Page refresh should reconstruct a complete readable session transcript.
2. Incremental live streaming should continue to work without waiting for final LLM completion.
3. Backend should compact delta-heavy history into stable assistant messages for full session history reads.
4. Frontend should request enough history for long sessions.
5. No arbitrary VM file access, command execution, or unsafe protocol change.

## Required Backend Change

### 1. Increase accepted history limit to 5000

Change backend route limit cap:

```ts
return Math.min(parsed, 5000);
```

Recommended constants:

```ts
const defaultHistoryLimit = 50;
const maxHistoryLimit = 5000;
```

Keep a default for lightweight calls, but allow frontend session refresh to request 5000.

### 2. Add host-side session history compaction

Add a compaction step after `normalizeMessages(...)` and before returning messages from `getVmAgentMessages(...)`.

Recommended behavior:

- Apply compaction only for full session history reads:
  - `after === 0`
  - `sessionId` is provided
- Do not compact incremental live batches where `after > 0`.
  - Live SSE/poll batches should still forward raw delta/done messages so the frontend can stream text in real time.

Implementation sketch:

```ts
export async function getVmAgentMessages(after = 0, limit = 50, sessionId?: string) {
  const payload = await callVmAgent({ operation: "history", after, limit, sessionId, includeFolded: true, protocolVersion: 2 });
  const status = payload.ok === false ? errorStatus(...) : toStatus(payload);
  const messages = normalizeMessages(payload.messages, payload);
  const compacted = after === 0 && sessionId ? compactSessionHistory(messages) : messages;
  return { status, messages: compacted, cursor: payload.cursor || after };
}
```

### 3. Compaction rules

Group incremental assistant events by:

```text
turnId
targetMessageId || streamId || assistant_<turnId>
```

Recognize delta messages when any of these are true:

```ts
message.role === "agent" && message.meta?.kind === "agent_response_delta"
message.role === "agent" && message.meta?.delta === true
```

Recognize terminal messages when any of these are true:

```ts
message.meta?.kind === "agent_response_done"
message.meta?.kind === "agent_response_error"
message.meta?.done === true
message.meta?.streamState === "done"
message.meta?.streamState === "error"
```

For each assistant stream group:

1. Concatenate delta `content` in `sequence` order.
2. If a terminal done message has non-empty `content`, use that as the final content.
3. Otherwise use concatenated delta content.
4. Emit exactly one visible assistant message:

```json
{
  "id": "assistant_<turnId>",
  "role": "agent",
  "content": "merged assistant text",
  "createdAt": "first delta or done timestamp",
  "sequence": "terminal sequence or latest delta sequence",
  "meta": {
    "kind": "agent_response_done",
    "sessionId": "run_...",
    "turnId": "turn_...",
    "targetMessageId": "assistant_<turnId>",
    "streamState": "done",
    "compacted": true,
    "deltaCount": 123
  }
}
```

If the stream is not done yet, emit a draft:

```json
{
  "id": "assistant_<turnId>",
  "role": "agent",
  "content": "merged partial assistant text",
  "meta": {
    "kind": "agent_response_stream",
    "streamState": "streaming",
    "compacted": true
  }
}
```

### 4. Preserve non-delta messages

Keep these messages as separate history entries:

- user messages
- normal non-delta agent messages
- tool/worklog/progress messages
- Sentaurus run completion messages
- system errors

However, remove raw delta messages and empty done markers from the full session history response after they have been merged into `assistant_<turnId>`.

Do not duplicate final assistant content:

- If a full `assistant_<turnId>` final message already exists, prefer it over concatenated deltas.
- Drop raw delta messages for that same `turnId` in compacted history.

### 5. Preserve attachments

When compacting a stream group:

1. Prefer attachments from the terminal `agent_response_done` message.
2. If absent, use the latest delta message with attachments.
3. If multiple deltas contain attachments, de-duplicate by:

```text
source + runId + category + path
```

Final compacted message should still support:

```json
"attachments": [...]
```

### 6. Preserve ordering

After compaction, sort returned messages by:

1. `sequence` when both messages have numeric sequence
2. `createdAt` timestamp fallback

The compacted assistant message should appear at the assistant turn's logical final position:

- terminal done sequence if present
- latest delta sequence otherwise

## Required Frontend Change

### 1. Add history limit constants

In `apps/web/src/App.tsx`, define constants near existing stream constants:

```ts
const SESSION_HISTORY_LIMIT = 5000;
const GLOBAL_HISTORY_LIMIT = 500;
const STREAM_BATCH_LIMIT = 500;
```

### 2. Replace selected-session full history calls

Change these selected-session full refresh calls from 500 to 5000:

```ts
getVmAgentMessages(0, { limit: SESSION_HISTORY_LIMIT, sessionId: selectedRunId })
getVmAgentMessages(0, { limit: SESSION_HISTORY_LIMIT, sessionId: requestedSessionId })
getVmAgentMessages(0, { limit: SESSION_HISTORY_LIMIT, sessionId: selectedRunId })
```

Known locations in `apps/web/src/App.tsx`:

- manual history refresh
- pending-reply fallback full polling
- selected session load effect

### 3. Increase non-session/global history cautiously

For global history refresh:

```ts
getVmAgentMessages(0, { limit: GLOBAL_HISTORY_LIMIT })
```

Do not use 5000 globally unless needed, because global history can mix many sessions.

### 4. Keep stream batches separate

For incremental `after > cursor` polling:

```ts
getVmAgentMessages(vmAgentCursorRef.current, { limit: STREAM_BATCH_LIMIT })
```

This is for live updates and should not require full 5000 unless the stream falls far behind. A value around 500 is enough and avoids heavy repeated SSH payloads.

### 5. No frontend compaction required

The frontend already has incremental merge logic for:

- `agent_response_delta`
- `agent_response_stream`
- `agent_response_done`
- `agent_response_error`

The new backend compaction is for `after=0` full refresh reconstruction. The frontend should receive a normal `assistant_<turnId>` message and merge it like any other message.

## API Contract

### Full session history request

Request:

```http
GET /api/vm/agent/messages?after=0&limit=5000&sessionId=run_...
```

Expected response:

```json
{
  "ok": true,
  "cursor": 12345,
  "messages": [
    {
      "id": "user_<turnId>",
      "role": "user",
      "content": "original prompt",
      "meta": {
        "sessionId": "run_...",
        "turnId": "turn_...",
        "kind": "user_message"
      }
    },
    {
      "id": "assistant_<turnId>",
      "role": "agent",
      "content": "full reconstructed assistant answer",
      "meta": {
        "sessionId": "run_...",
        "turnId": "turn_...",
        "kind": "agent_response_done",
        "compacted": true,
        "deltaCount": 200
      }
    }
  ]
}
```

Raw `delta_<turnId>_NNNN` entries should not appear in this full compacted history unless they could not be safely compacted.

### Incremental stream request

Request:

```http
GET /api/vm/agent/messages?after=<cursor>&limit=500
```

Expected response:

```json
{
  "messages": [
    {
      "id": "delta_<turnId>_0001",
      "role": "agent",
      "content": "new chunk",
      "meta": {
        "kind": "agent_response_delta",
        "turnId": "turn_...",
        "targetMessageId": "assistant_<turnId>",
        "delta": true
      }
    }
  ]
}
```

Raw deltas should still be available for live streaming.

## Acceptance Criteria

1. Browser refresh on a long streamed session shows old user and assistant messages.
2. Full session history request uses `limit=5000`.
3. Backend accepts `limit=5000` instead of capping at 1000.
4. Full session history response returns one compacted `assistant_<turnId>` per streamed assistant turn.
5. Raw delta messages are not shown as hundreds of separate bubbles after refresh.
6. Live streaming still updates incrementally while the assistant is generating.
7. Attachments on final assistant messages survive compaction.
8. Progress/worklog messages remain available and foldable.
9. Existing non-streamed assistant replies still render exactly once.
10. No arbitrary VM access or shell execution behavior changes.

## Suggested Tests

### Test A: long streamed turn refresh

Create a session with one user message and at least 200 assistant delta messages.

Expected:

- `GET /api/vm/agent/messages?after=0&limit=5000&sessionId=...` returns one compacted `assistant_<turnId>`.
- The assistant content equals the concatenated deltas or final done content.
- Frontend refresh shows one assistant bubble, not hundreds of chunks.

### Test B: live stream compatibility

Start a new VM agent response.

Expected:

- SSE/polling with `after > 0` still receives raw deltas.
- The visible assistant bubble grows incrementally.
- Done event finalizes the same assistant bubble.

### Test C: attachment preservation

Make a streamed assistant turn end with an image attachment.

Expected:

- Compacted history message keeps the image attachment.
- Refresh still shows the image preview.

### Test D: mixed old and new message formats

Use a session containing:

- old normal `agent` messages
- `progress` messages
- `agent_response_delta` messages
- `agent_response_done` messages
- `sentaurus_run` messages

Expected:

- Old normal messages remain visible.
- Progress remains foldable/hidden according to existing UI.
- Delta/done pairs compact into one assistant message.
- Sentaurus run outputs still show artifacts.

## Implementation Notes

- Keep compaction deterministic and side-effect free in the host backend.
- Do not rewrite VM history files from the host during compaction.
- Compaction should be a response-shaping layer, not destructive storage migration.
- If VM worker later adds native compacted history support, host compaction can become a compatibility fallback.
- Log or mark compacted messages with `meta.compacted = true` for debugging.

