# Sentaurus VM Agent Codex-Style Worklog Plan

Date: 2026-07-02
Scope: design only. Do not modify VM worker, host backend, or Web frontend until this plan is confirmed.

## Goal

Make Sentaurus VM Agent replies behave more like Codex:

- show live, Chinese, user-visible work summaries while the task is running;
- show file operations as separate events, e.g. `Created gate_zoom.tcl`, `Edited run_request.json`, `Read SVisualTcl.log`;
- keep final conclusions and attachments in separate final bubbles;
- after completion, fold intermediate worklog events behind a `Worked for <duration>` expander;
- avoid exposing hidden model chain-of-thought; all displayed thinking must be explicit public worklog / reasoning summary text.

## Non-Goals

- Do not expose hidden chain-of-thought or raw provider reasoning tokens.
- Do not mix artifact image previews into the main final text bubble.
- Do not rely on prompt-only formatting for UI structure.
- Do not change QQBot/media routing for this issue.

## Current Problem

Today the VM worker often combines several logically different parts into one visible `agent` message:

1. LLM visible pre-run explanation.
2. Auto-debug status summary.
3. Sentaurus runner final result.
4. Artifact/log list.
5. Suggested next step.

The Web frontend renders one `VmAgentMessage` as one bubble, so this becomes one long English message. This is not hidden chain-of-thought leakage; it is a message-structure problem.

## Target UX

During a run:

```text
VM: 我先检查当前 session 里已有的 TDR 文件，确认 PNG 导出要加载哪个结果文件。
VM: Read output/仿真结果文件/utb28nm_B_low_des.tdr
VM: Created gate_zoom.tcl
VM: Running svisual -batchx gate_zoom.tcl
```

After completion:

```text
VM: Sentaurus PNG 导出失败：`gate_zoom.tcl` 试图加载 `utb28nm_B_low_des.tdr`，但该文件不存在或不在运行目录。

Worked for 1m 42s ▸
Files
- Created `gate_zoom.tcl`
- Read `SVisualTcl.log`
- Produced `run_result.json`
```

When expanded, `Worked for ...` shows the intermediate public worklog messages and tool/run summaries.

## Message Model

Extend `VmAgentMessage.meta` with a stable event contract. Keep existing `role`, `content`, `attachments`, and `sequence`.

### New `meta.kind` Values

| kind | role | visible during run | default after final | purpose |
| --- | --- | --- | --- | --- |
| `worklog_summary` | `agent` | yes | folded | Chinese public reasoning summary |
| `file_operation` | `agent` | yes | folded + file list | file read/write/edit/create/delete event |
| `tool_run` | `agent` | yes | folded | allowlisted tool execution, e.g. `svisual` |
| `run_progress` | `system` or `agent` | yes | folded | concise progress event |
| `run_final` | `agent` | yes | visible | final user-facing conclusion |
| `run_diagnostic` | `agent` | optional | folded | auto-debug / failure diagnostic details |
| `vm_agent_attachments` | `agent` | yes | visible | attachment-only message with images/files |
| `agent_trace` | `system` | optional debug | hidden/folded | raw trace/debug details, disabled by default |

### Common Metadata

Every run-related message should include:

```json
{
  "kind": "worklog_summary",
  "sessionId": "run_... or UI session id",
  "runId": "run_... if available",
  "turnId": "turn_YYYYMMDDTHHMMSSZ_xxxxx",
  "groupId": "turn_YYYYMMDDTHHMMSSZ_xxxxx",
  "phase": "planning|file|tool|debug|final|attachment",
  "foldable": true,
  "collapsedByDefault": true,
  "publicWorklog": true,
  "displayLanguage": "zh-CN"
}
```

Notes:

- `turnId` groups all messages produced by one user request.
- `groupId` is the fold group. Usually same as `turnId`.
- `publicWorklog: true` means the text is safe to show. It is not hidden chain-of-thought.
- `collapsedByDefault` should be true for intermediate events, false for `run_final` and attachment messages.

### File Operation Metadata

```json
{
  "kind": "file_operation",
  "operation": "created|edited|read|deleted|uploaded|published",
  "path": "gate_zoom.tcl",
  "category": "仿真参数文件|仿真结果文件|仿真日志文件|我的输入|其它文件",
  "size": 240,
  "foldable": true,
  "collapsedByDefault": true
}
```

Use concise content:

```text
Created `gate_zoom.tcl`
Edited `run_request.json`
Read `SVisualTcl.log`
Published `utb28nm_B_gate_zoom_window.png`
```

### Tool Run Metadata

```json
{
  "kind": "tool_run",
  "tool": "svisual",
  "commandLabel": "svisual -batchx gate_zoom.tcl",
  "status": "running|succeeded|failed",
  "exitCode": 0,
  "durationMs": 12000,
  "foldable": true,
  "collapsedByDefault": true
}
```

Do not expose arbitrary shell commands. Only show allowlisted Sentaurus runner labels.

### Final Message Metadata

```json
{
  "kind": "run_final",
  "sessionId": "...",
  "runId": "run_...",
  "turnId": "turn_...",
  "groupId": "turn_...",
  "runStatus": "succeeded|failed",
  "foldable": false,
  "collapsedByDefault": false,
  "summaryOfGroup": true,
  "worklogDurationMs": 102000
}
```

Final content should be Chinese-first and short:

```text
PNG 导出失败：`gate_zoom.tcl` 加载的 `utb28nm_B_low_des.tdr` 不存在或路径不对。

建议下一步：先在当前 session 输出目录中确认可用 `.tdr` 文件名，再重新生成 `svisual` Tcl。
```

### Attachment Message Metadata

Keep attachment preview separate:

```json
{
  "kind": "vm_agent_attachments",
  "sessionId": "...",
  "runId": "run_...",
  "turnId": "turn_...",
  "groupId": "turn_...",
  "attachmentCount": 1,
  "imageAttachmentCount": 1,
  "foldable": false,
  "collapsedByDefault": false
}
```

Content:

```text
Published 1 VM image attachment.
```

## Unified Upload / Command Contract

The host backend currently talks to the CentOS VM by running a Python script over SSH with a JSON request. Keep that pattern, but make the request and response event-aware.

### Host to VM Request

All operations should pass this JSON to `remoteAgentScript(request)`:

```json
{
  "operation": "send|history|status|start",
  "message": "user prompt when operation=send",
  "sessionId": "selected UI session id",
  "turnId": "turn_YYYYMMDDTHHMMSSZ_xxxxx",
  "after": 123,
  "limit": 100,
  "includeFolded": true,
  "protocolVersion": 2
}
```

Rules:

- `sessionId` remains the UI/session scope.
- `turnId` is generated by the host for `send` and forwarded to the VM worker.
- `protocolVersion: 2` enables structured worklog messages.
- `includeFolded` lets the host request all messages; Web decides whether to fold.
- Keep `message` max length validation on the host side.

### VM to Host Response

For `send`, `history`, and stream polling, return:

```json
{
  "ok": true,
  "protocolVersion": 2,
  "cursor": 456,
  "messages": [
    {
      "id": "vm_...",
      "role": "agent",
      "content": "我先检查当前 session 里有哪些可用的 TDR 文件。",
      "createdAt": "2026-07-02T03:25:00Z",
      "sequence": 430,
      "meta": {
        "kind": "worklog_summary",
        "sessionId": "...",
        "turnId": "turn_...",
        "groupId": "turn_...",
        "phase": "planning",
        "foldable": true,
        "collapsedByDefault": true,
        "publicWorklog": true,
        "displayLanguage": "zh-CN"
      }
    }
  ]
}
```

Rules:

- `messages` must be an array; never pack multiple semantic stages into one long string.
- `sequence` must be monotonically increasing from `messages.jsonl`.
- `content` must be UTF-8 text and safe for direct Web rendering.
- `attachments` must stay on dedicated attachment messages.
- The VM worker should not upload text through artifact endpoints. Text goes only through `messages.jsonl` and `/api/vm/agent/messages` / stream.

## CentOS VM Worker Plan

File: embedded Python worker inside `apps/server/src/services/vmAgent.ts`.

### 1. Add Message Helpers

Add helpers around `append_message`:

- `append_worklog(session_id, turn_id, phase, text, run_id=None)`
- `append_file_operation(session_id, turn_id, operation, path, category=None, size=None, run_id=None)`
- `append_tool_run(session_id, turn_id, tool, command_label, status, exit_code=None, duration_ms=None, run_id=None)`
- `append_run_final(session_id, turn_id, content, result, duration_ms=None)`
- `append_attachment_message(session_id, turn_id, attachments, meta)`

Each helper should write one JSONL message immediately, not wait until the end.

### 2. Generate `turnId`

- Prefer host-provided `turnId` in queued message `meta`.
- If missing, VM worker generates `turn_<utc>_<shortid>`.
- Copy `turnId` into every message produced for the user request.

### 3. Public Worklog Instead of Hidden CoT

Add prompt instruction:

```text
Do not reveal hidden chain-of-thought. When useful, write short Chinese public worklog summaries for the user. Each summary should describe the next observable action or decision in 1-2 sentences.
```

Preferred visible worklog examples:

- `我先确认这次 PNG 导出应该加载哪个 TDR 文件，避免 svisual 读取旧路径。`
- `我发现当前 run manifest 里没有目标 PNG，接下来检查 SVisual 日志定位失败原因。`

Avoid:

- raw reasoning traces;
- long English debug dumps;
- provider hidden reasoning;
- unbounded logs.

### 4. Split Current Final Reply Builder

Replace the current single-string final flow:

```text
visible_reply + auto-debug report + format_run_result(final)
```

with structured events:

1. Optional `worklog_summary` for the LLM visible pre-run explanation.
2. `tool_run` for each Sentaurus step.
3. `run_diagnostic` for auto-debug stop reason and failed attempts.
4. `run_final` for short Chinese result.
5. `vm_agent_attachments` for images/files.

Keep full raw details in artifacts/logs, not in the final bubble.

### 5. Emit File Operations

Emit file events at these points:

- when run request files are written into `run_dir`;
- when `run_request.json` and `run_result.json` are written;
- when artifacts are collected;
- when files are synced to session output categories;
- when `VM_SESSION_FILE` publishes generated/session files.

Examples:

```text
Created `gate_zoom.tcl`
Created `run_request.json`
Read `SVisualTcl.log`
Published `utb28nm_B_gate_zoom_window.png`
```

### 6. Keep Progress Compatible

Existing `append_progress` can stay for the progress table. It should not be the only source of chat-visible worklog.

Mapping:

- `append_progress(... phase="runner" ...)` remains system progress.
- add separate `append_tool_run(... status="running")` when a tool starts.
- add separate `append_tool_run(... status="failed|succeeded")` when it ends.

### 7. Failure Summary Rules

For failed runs, final `run_final` should include:

- failed operation;
- exact missing file / failed tool / exit code;
- one concise next step;
- no full artifact list unless short.

Detailed artifact lists belong in folded `run_diagnostic` or file list.

## Host Backend Plan

Files:

- `apps/server/src/services/vmAgent.ts`
- `apps/server/src/routes/vmAgent.ts`
- `packages/shared/src/index.ts`

### 1. Extend TypeScript Types

Add typed metadata helpers without breaking existing messages:

```ts
export type VmAgentMessageKind =
  | "worklog_summary"
  | "file_operation"
  | "tool_run"
  | "run_progress"
  | "run_final"
  | "run_diagnostic"
  | "vm_agent_attachments"
  | "agent_trace"
  | string;

export type VmAgentMessageMeta = {
  kind?: VmAgentMessageKind;
  sessionId?: string;
  runId?: string;
  turnId?: string;
  groupId?: string;
  phase?: string;
  foldable?: boolean;
  collapsedByDefault?: boolean;
  publicWorklog?: boolean;
  displayLanguage?: string;
  operation?: string;
  path?: string;
  category?: string;
  tool?: string;
  commandLabel?: string;
  status?: string;
  exitCode?: number;
  durationMs?: number;
  worklogDurationMs?: number;
  summaryOfGroup?: boolean;
};
```

Then change `VmAgentMessage.meta` to `VmAgentMessageMeta & Record<string, unknown>` if convenient.

### 2. Generate and Forward `turnId`

In `sendVmAgentMessage(message, sessionId)`:

- generate `turnId` once on host;
- include it in the `send` request to `remoteAgentScript`;
- include it in the queued user message meta on VM side.

Suggested format:

```ts
turn_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}_${Math.random().toString(36).slice(2, 8)}
```

### 3. Normalize Metadata Safely

`normalizeMessages` should preserve these new metadata fields and attachments. It should not coerce unknown structured metadata to strings.

Validation rules:

- accept `meta.kind` as string;
- accept booleans/numbers/strings/null;
- drop functions/objects only if unsafe;
- preserve `attachments` exactly as currently normalized.

### 4. Keep SSE Compatible

`/api/vm/agent/messages/stream` already polls `getVmAgentMessages(cursor)`. Keep the endpoint but make sure:

- `limit` is large enough for bursts of small worklog messages;
- stream events preserve `cursor`;
- client receives messages in sequence order;
- no worklog text is uploaded through file/artifact endpoints.

### 5. Optional Aggregation Endpoint

Not required initially, but useful later:

```http
GET /api/vm/agent/messages/groups?sessionId=...&after=...
```

This could return messages grouped by `turnId`. For now, do grouping in Web frontend to avoid backend complexity.

## Web Frontend Plan

Files:

- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/api/vmAgent.ts`

### 1. Group Messages by `turnId`

In the message list, compute groups:

- messages without `turnId` render as today;
- messages with same `turnId` form one run group;
- within each group:
  - `run_final` and `vm_agent_attachments` stay visible;
  - foldable messages go into a `WorklogFold` component;
  - file operations are summarized in a `Files` subsection.

### 2. Worklog Fold Component

Component behavior:

```tsx
<WorklogFold
  durationMs={final.meta?.worklogDurationMs}
  defaultOpen={false}
  messages={foldableMessages}
  fileOperations={fileOperations}
/>
```

Collapsed label:

```text
Worked for 1m 42s ▸
```

Expanded content:

- chronological worklog messages;
- tool run statuses;
- file operations;
- diagnostics.

### 3. File List UI

Show file operations under the fold label or final bubble:

```text
Files
- Created `gate_zoom.tcl`
- Read `SVisualTcl.log`
- Produced `run_result.json`
```

Click behavior can reuse existing artifact/session-file download URLs when metadata has enough path/category/runId info.

### 4. Bubble Rules

CSS should make these visually distinct:

- final answer: normal VM bubble;
- attachments: image/file card bubble;
- worklog fold: compact secondary panel;
- file operation rows: small monospace chips;
- failed tool events: warning style.

### 5. Backward Compatibility

If old messages do not have `turnId` or new `kind`, render exactly as today.

If a single old long `sentaurus_run` message is received, optionally detect sections and show it as legacy final text, but do not attempt aggressive parsing in the first implementation.

## Prompt / Language Policy

Add to VM worker system prompt:

```text
User-facing replies should be Chinese by default unless the user asks otherwise.
Do not reveal hidden chain-of-thought. If progress visibility is useful, write concise public worklog summaries in Chinese.
Public worklog summaries must describe observable actions, decisions, and status, not private reasoning traces.
Final answers should be concise and separated from progress, diagnostics, and attachments.
```

This keeps the UX Chinese-first without relying on hidden reasoning.

## Implementation Order

1. Add shared metadata types and host `turnId` forwarding.
2. Add CentOS VM worker append helpers for structured messages.
3. Convert run execution events into `tool_run` and `file_operation` messages.
4. Convert final result builder into `run_final` + `run_diagnostic` + `vm_agent_attachments`.
5. Add Web grouping by `turnId` and `WorklogFold` rendering.
6. Add CSS styling for folded worklogs and file chips.
7. Validate with a failed `svisual` run and a successful PNG export run.

## Validation Checklist

### Unit / Type Checks

- `npm run typecheck`
- `npm run build`
- extract embedded `remoteWorkerScript` and run `python3 -m py_compile` on it
- `git diff --check`

### Manual Behavior Checks

Use a test prompt that triggers `svisual` PNG export.

Expected during run:

- Chinese worklog messages appear in real time;
- file operations appear as separate small events;
- tool run status appears separately;
- no raw hidden reasoning appears.

Expected after run:

- final result appears as one concise visible bubble;
- intermediate messages are folded under `Worked for <duration>`;
- files list is visible and accurate;
- image attachments render in a separate attachment bubble;
- old messages still render normally.

### Data Checks

Inspect `/api/vm/agent/messages?sessionId=...`:

- messages share one `turnId`;
- foldable events have `meta.foldable: true`;
- final message has `meta.kind: "run_final"`;
- attachment message has `attachments` and `meta.kind: "vm_agent_attachments"`;
- no multi-stage response is packed into one long string.

## Risks and Mitigations

### Risk: Too Many Chat Messages

Mitigation:

- throttle worklog summaries;
- emit only phase changes and file/tool boundaries;
- keep detailed logs in files, not chat.

### Risk: Hidden CoT Leakage

Mitigation:

- never display provider reasoning tokens;
- only display model-authored public summaries;
- mark them with `publicWorklog: true`.

### Risk: Frontend Breaks Old Sessions

Mitigation:

- render old messages unchanged when `turnId` is absent;
- keep `meta.kind` optional.

### Risk: VM/Host Protocol Drift

Mitigation:

- use `protocolVersion: 2`;
- keep old `send/history/status/start` operations;
- default missing fields safely.

## Recommended Final Design

Implement this as a structured event stream, not as prompt-formatted Markdown.

The key rule is:

> One semantic event equals one `VmAgentMessage`.

That gives the Web frontend enough structure to render Codex-style folding while keeping VM execution logs, final answers, and attachments cleanly separated.
