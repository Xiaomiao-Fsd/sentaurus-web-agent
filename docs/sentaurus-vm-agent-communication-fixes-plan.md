# Sentaurus VM Agent Communication Fix Plan

## Scope

This document gives implementation instructions for three observed issues:

1. On mobile, the agent progress panel does not show the detail area correctly after tapping `Show`.
2. The web UI only shows final agent answers. It should show a Codex-like running reasoning/progress summary while the agent is working, then collapse that summary above the final answer.
3. File attachments are currently visible to the VM agent mostly as file names. The VM agent must be able to read the actual text content of attached files, including files uploaded by the user and files produced by the VM agent when the user explicitly attaches or references them.

Important safety constraint for issue 2:

- Do not expose hidden model chain-of-thought.
- Implement visible reasoning summaries, working notes, and progress traces only.
- If the LLM provider exposes an approved reasoning summary field, it may be displayed. Do not request or display private chain-of-thought text.

## Current Relevant Files

Frontend:

- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/api/vmAgent.ts`
- `apps/web/src/api/runs.ts`

Backend:

- `apps/server/src/routes/vmAgent.ts`
- `apps/server/src/routes/runs.ts`
- `apps/server/src/services/vmAgent.ts`
- `apps/server/src/services/vmSessionFiles.ts`
- `apps/server/src/services/runStore.ts`

Shared types:

- `packages/shared/src/index.ts`

## Issue 1: Mobile Progress Detail Panel Is Hidden

### Observed Behavior

On mobile, tapping `Show` on the progress panel does not correctly reveal the detail table. The detail area is only briefly visible during the collapse animation.

### Likely Root Cause

The mobile CSS renders `.mobile-progress-backdrop` as a fixed element with a high `z-index`, while `.progress-panel` is positioned with a lower stacking context. The table wrapper is a descendant of `.progress-panel`, so even if `.progress-table-wrap` has a higher `z-index`, it can still be trapped inside the parent stacking context and rendered behind the backdrop.

Current relevant patterns:

- `App.tsx` renders `.mobile-progress-backdrop` when `!progressCollapsed`.
- `styles.css` sets `.mobile-progress-backdrop { z-index: 72; }`.
- `styles.css` sets mobile `.progress-panel { position: relative; z-index: 12; }`.
- `styles.css` sets `.progress-panel:not(.collapsed) .progress-table-wrap { position: fixed; z-index: 95; ... }`.

### Minimal Fix

In `apps/web/src/styles.css`, in the mobile media block:

1. Keep the backdrop below the open progress sheet.
2. Raise the progress panel stacking context while open.
3. Ensure the table wrapper is visible and receives pointer events.

Suggested CSS:

```css
@media (max-width: 760px) {
  .mobile-progress-backdrop {
    z-index: 70;
  }

  .progress-panel {
    position: relative;
    z-index: 12;
  }

  .progress-panel:not(.collapsed) {
    z-index: 90;
  }

  .progress-panel:not(.collapsed) .progress-table-wrap {
    position: fixed;
    right: 0.72rem;
    bottom: calc(5.2rem + env(safe-area-inset-bottom));
    left: 0.72rem;
    z-index: 100;
    max-height: min(62dvh, 420px);
    overflow: auto;
    opacity: 1;
    pointer-events: auto;
    visibility: visible;
    transform: translateY(0);
    border-color: var(--color-border);
    background: #ffffff;
    box-shadow: var(--shadow-float);
  }
}
```

### Preferred Fix

Replace the mobile table with a card-style progress sheet. A table with `min-width: 640px` is awkward on mobile and makes the `Detail` column hard to read.

Implementation:

1. Extract the progress UI from `App.tsx` into a `ProgressPanel` component.
2. Render a normal table on desktop.
3. Render stacked event cards on mobile:

```tsx
<div className="progress-event-list">
  {progressRows.map((row) => (
    <article className={`progress-event-card progress-${row.status}`} key={row.id}>
      <div className="progress-event-card-head">
        <strong>{progressLabel(row.stage)}</strong>
        <span>{row.status}</span>
      </div>
      <p className="progress-event-detail">{row.detail}</p>
      <div className="progress-event-meta">
        <span>{formatDate(row.createdAt)}</span>
        <span>{row.progress === null ? "-" : `${row.progress}%`}</span>
      </div>
    </article>
  ))}
</div>
```

Acceptance criteria:

- On a 390px wide viewport, tapping `Show` displays a readable progress detail sheet.
- The backdrop is behind the sheet.
- The `Detail` text is visible without relying on a collapse animation.
- Tapping the backdrop closes the panel.

## Issue 2: Add Visible Running Reasoning Summary

### Observed Behavior

The UI only shows final agent replies. While the VM agent is working, the user sees progress events but not a Codex-like reasoning/progress summary.

### Safety Requirement

Do not expose hidden chain-of-thought. Implement a visible working summary instead:

- short status notes,
- plan summaries,
- tool/run progress,
- model-approved reasoning summaries if available,
- final collapsed summary above the answer.

Do not prompt the model to reveal private chain-of-thought.

### Data Model Changes

In `packages/shared/src/index.ts`, either keep the loose `meta` type or add explicit optional metadata fields through helper types.

Use these meta keys:

```ts
meta: {
  kind: "agent_thinking" | "agent_reasoning_summary" | "llm" | string;
  sessionId?: string;
  requestMessageId?: string;
  thinkingStatus?: "running" | "completed" | "failed";
  thinkingStage?: string;
  collapsedByDefault?: boolean;
}
```

### Backend Worker Changes

File: `apps/server/src/services/vmAgent.ts`

The remote worker already appends progress messages with `append_progress`. Add visible reasoning summary messages as normal messages with `meta.kind`.

Recommended helper inside the remote worker script:

```python
def append_thinking(session_id, request_id, stage, content, status="running", collapsed=False):
    meta = {
        "kind": "agent_thinking",
        "sessionId": safe_text(session_id, 160),
        "requestMessageId": safe_text(request_id, 200),
        "thinkingStage": safe_text(stage, 80),
        "thinkingStatus": safe_text(status, 40),
        "collapsedByDefault": bool(collapsed),
    }
    return append_message("system", safe_text(content, 1800), "vm-agent-thinking", meta, "thinking")
```

Add calls in `process_queue_file`:

1. Before context building:

```python
append_thinking(session_id, item.get("id") or "", "context", "Reviewing session history, VM state, manuals, and uploaded file references.")
```

2. Before LLM call:

```python
append_thinking(session_id, item.get("id") or "", "llm", "Preparing a Sentaurus-aware response. If a run request is needed, it must be self-contained and allowlisted.")
```

3. Before validation / run execution:

```python
append_thinking(session_id, item.get("id") or "", "validation", "Checking whether the proposed run request is complete and safe to execute.")
```

4. Before final answer:

```python
append_thinking(session_id, item.get("id") or "", "complete", "Work summary is ready. Final answer follows below.", "completed", True)
```

If implementing true streaming later, update `call_llm_model` to use provider streaming only for approved visible summary text. Do not stream hidden reasoning fields.

### Optional LLM Prompt Addition

In `call_llm`, add a requirement for a short visible summary, not hidden chain-of-thought:

```text
When useful, include a concise <AGENT_REASONING_SUMMARY> block with 3-6 bullet points summarizing the visible plan, assumptions, files considered, and safety checks. Do not include private chain-of-thought.
```

Then parse it after the LLM reply:

```python
reasoning_summary, visible_reply = extract_json_or_text_tag(reply, "AGENT_REASONING_SUMMARY")
```

If a summary exists, append it as:

```python
append_message(
    "system",
    reasoning_summary,
    "vm-agent-thinking",
    {
        "kind": "agent_reasoning_summary",
        "sessionId": session_id,
        "requestMessageId": item.get("id") or "",
        "thinkingStatus": "completed",
        "collapsedByDefault": True,
    },
    "thinking"
)
```

If adding a tag parser is too much for the first pass, skip this optional step and rely on progress/thinking messages.

### Frontend Changes

File: `apps/web/src/App.tsx`

1. Identify thinking messages:

```ts
function isThinkingMessage(message: VmAgentMessage): boolean {
  return message.meta?.kind === "agent_thinking" || message.meta?.kind === "agent_reasoning_summary";
}
```

2. Do not render thinking messages as normal chat bubbles.
3. Group thinking messages by `requestMessageId`.
4. Render a `ThinkingPanel`:

Behavior:

- While waiting for an agent reply: expanded by default.
- After the final agent reply arrives: collapsed by default above the final answer.
- User can expand/collapse manually.

Suggested UI:

```tsx
<ThinkingPanel
  messages={thinkingMessagesForRequest}
  defaultCollapsed={!waitingForAgentReply}
/>
```

Suggested content:

- title: `Agent working`
- running label: `Running`
- completed label: `Reasoning summary`
- rows: stage, status, timestamp, content

Acceptance criteria:

- During a long VM agent request, the user sees a visible running work summary.
- After the final answer, the summary is collapsed above the result.
- Hidden model chain-of-thought is not displayed.
- Existing progress events still work.

## Issue 3: Let VM Agent Read Attachment Contents

### Observed Behavior

When files are attached, the UI uploads them and sends a text line like:

```text
Attachments uploaded to this session: file1.cmd, file2.txt.
```

The VM agent receives the file names but not the file contents in the queued request.

Current flow:

1. Frontend uploads files with `uploadRunFile(selectedRunId, file)`.
2. Backend saves the file under the run input area.
3. Backend tries to sync the file to the VM session output input category.
4. Frontend sends only the visible text plus file names through `/api/vm/agent/messages`.
5. VM worker calls the LLM with the text only.

### Target Behavior

The VM agent must be able to read actual file contents for:

1. User-uploaded files attached to the current message.
2. VM-generated files or artifacts that the user explicitly attaches or selects for the next message.

The VM agent should not blindly read all session files. Only explicitly attached files should be included, with strict extension and size limits.

### Shared Type Changes

File: `packages/shared/src/index.ts`

Add:

```ts
export type VmAgentAttachmentSource = "run-input" | "vm-session-file" | "vm-run-artifact";

export type VmAgentAttachmentRef = {
  id: string;
  source: VmAgentAttachmentSource;
  name: string;
  path: string;
  size: number;
  runId?: string;
  category?: VmSessionOutputCategory;
  contentType?: string;
};

export type VmAgentMessageRequest = {
  message: string;
  sessionId?: string;
  attachments?: VmAgentAttachmentRef[];
};
```

Keep `VmAgentMessage.meta` as-is unless stricter typing is required.

### Frontend API Change

File: `apps/web/src/api/vmAgent.ts`

Change:

```ts
export async function sendVmAgentMessage(message: string, sessionId?: string): Promise<VmAgentMessageResponse>
```

to:

```ts
export async function sendVmAgentMessage(
  message: string,
  sessionId?: string,
  attachments: VmAgentAttachmentRef[] = []
): Promise<VmAgentMessageResponse> {
  return requestJson("/api/vm/agent/messages", {
    method: "POST",
    body: JSON.stringify({ message, sessionId, attachments })
  });
}
```

### Frontend Upload Flow Change

File: `apps/web/src/App.tsx`

After each `uploadRunFile(selectedRunId, file)`, create an attachment ref and pass it to `sendVmAgentMessage`.

The current code records only:

```ts
uploadedAttachments.push({
  id,
  name: file.name,
  size: file.size,
  uploadedAt: new Date().toISOString()
});
```

Change the local type so uploaded attachments also carry a VM-readable ref:

```ts
const attachmentRefs: VmAgentAttachmentRef[] = [];

for (const file of attachments) {
  const uploaded = await uploadRunFile(selectedRunId, file);
  const ref: VmAgentAttachmentRef = {
    id: `${file.name}_${file.size}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    source: "vm-session-file",
    name: uploaded.file.name,
    path: uploaded.file.name,
    size: uploaded.file.size,
    runId: selectedRunId,
    category: INPUT_SESSION_CATEGORY
  };
  attachmentRefs.push(ref);
}

const response = await sendVmAgentMessage(visibleText, selectedRunId, attachmentRefs);
```

Important:

- Reuse the same category that `syncInputFileToVmSession` writes to on the VM.
- If category names are currently mojibake in the source, define a shared constant and use it consistently instead of duplicating string literals.

### Attach VM-Generated Files

The displayed artifact chips should have an action such as `Use in next prompt` or `Attach`.

For VM run artifacts:

```ts
{
  source: "vm-run-artifact",
  runId: file.runId,
  path: file.path,
  name: file.path.split("/").at(-1) || file.path,
  size: file.size
}
```

For session output files:

```ts
{
  source: "vm-session-file",
  runId: selectedRunId,
  category: file.category,
  path: file.path,
  name: file.name,
  size: file.size
}
```

These refs should be added to the same pending attachment list as local uploads, but mark them as existing VM files so they are not uploaded again.

### Backend Route Change

File: `apps/server/src/routes/vmAgent.ts`

Change body type:

```ts
app.post<{ Body: VmAgentMessageRequest }>("/api/vm/agent/messages", async (request) => {
  requireAuth(request);
  const message = request.body?.message?.trim();
  const attachments = Array.isArray(request.body?.attachments) ? request.body.attachments : [];
  ...
  const result = await sendVmAgentMessage(message, parseSessionId(request.body?.sessionId), attachments);
  return { ok: result.status.ok, ...result };
});
```

Validate:

- max attachment count, for example 8.
- attachment path must be safe relative path.
- allowed source values only.
- category must be one of known session output categories.
- extension must be readable or known binary.

### Backend Service Change

File: `apps/server/src/services/vmAgent.ts`

Extend:

```ts
type RemoteAgentRequest = {
  operation: VmAgentOperation;
  message?: string;
  sessionId?: string;
  attachments?: VmAgentAttachmentRef[];
  after?: number;
  limit?: number;
};
```

Change:

```ts
export async function sendVmAgentMessage(message: string, sessionId?: string)
```

to:

```ts
export async function sendVmAgentMessage(
  message: string,
  sessionId?: string,
  attachments: VmAgentAttachmentRef[] = []
)
```

Pass attachments into:

```ts
callVmAgent({ operation: "send", message, sessionId, attachments })
```

### Remote Control Script Change

Inside the remote control script in `apps/server/src/services/vmAgent.ts`:

1. Add attachments to `enqueue_message`.
2. Store them on the queued JSON message.

Suggested remote code:

```python
def normalize_attachment(item):
    if not isinstance(item, dict):
        return None
    source = safe_text(item.get("source"), 40)
    if source not in ["run-input", "vm-session-file", "vm-run-artifact"]:
        return None
    return {
        "id": safe_text(item.get("id"), 200),
        "source": source,
        "name": safe_text(item.get("name"), 240),
        "path": safe_text(item.get("path"), 600),
        "size": item.get("size") if isinstance(item.get("size"), int) else 0,
        "runId": safe_text(item.get("runId"), 200),
        "category": safe_text(item.get("category"), 240),
        "contentType": safe_text(item.get("contentType"), 120),
    }

def normalize_attachments(items):
    result = []
    for item in (items or [])[:8]:
        normalized = normalize_attachment(item)
        if normalized:
            result.append(normalized)
    return result
```

Update:

```python
def enqueue_message(content, session_id=None, attachments=None):
    ...
    normalized_attachments = normalize_attachments(attachments)
    if normalized_attachments:
        message["attachments"] = normalized_attachments
        message["meta"]["attachmentsJson"] = json.dumps(normalized_attachments, ensure_ascii=True, sort_keys=True)
```

Update handler:

```python
elif operation == "send":
    incoming = safe_text(request.get("message"), 4000)
    attachments = normalize_attachments(request.get("attachments") or [])
    ...
    messages = [enqueue_message(incoming, session_id, attachments)]
```

### Remote Worker: Read Attachment Contents

Inside `remoteWorkerScript` in `apps/server/src/services/vmAgent.ts`, add helpers.

Allowed text extensions:

```python
READABLE_ATTACHMENT_EXT = set([
    ".cmd", ".des", ".par", ".scm", ".tcl", ".txt", ".dat", ".csv", ".json",
    ".log", ".out", ".err", ".md", ".rst", ".sde"
])
MAX_ATTACHMENT_BYTES = 256 * 1024
MAX_ATTACHMENT_TOTAL_CHARS = 600000
```

Path resolver:

```python
def safe_attachment_segments(rel_path):
    rel_path = safe_text(rel_path, 1000).strip().replace("\\", "/")
    if not rel_path or rel_path.startswith("/") or ".." in rel_path.split("/"):
        return None
    parts = []
    for part in rel_path.split("/"):
        if not part or part in [".", ".."] or part.startswith("."):
            return None
        if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._@()+, -]{0,159}$", part):
            return None
        parts.append(part)
    return parts

def attachment_abs_path(session_id, attachment):
    source = attachment.get("source")
    rel_parts = safe_attachment_segments(attachment.get("path") or attachment.get("name") or "")
    if not rel_parts:
        return None
    if source == "vm-session-file":
        category = safe_text(attachment.get("category"), 240)
        if not category:
            return None
        root = os.path.abspath(os.path.join(SESSION_OUTPUT_ROOT, session_id, "output", category))
        target = os.path.abspath(os.path.join(root, *rel_parts))
        return target if target == root or target.startswith(root + os.sep) else None
    if source == "vm-run-artifact":
        run_id = safe_text(attachment.get("runId"), 200)
        if not re.match(r"^run_[A-Za-z0-9_-]+$", run_id):
            return None
        root = os.path.abspath(os.path.join(RUNS_DIR, run_id))
        target = os.path.abspath(os.path.join(root, *rel_parts))
        return target if target == root or target.startswith(root + os.sep) else None
    return None
```

Text reader:

```python
def read_attachment_text(path):
    ext = os.path.splitext(path)[1].lower()
    if ext not in READABLE_ATTACHMENT_EXT:
        return None, "binary-or-unsupported"
    if not os.path.isfile(path):
        return None, "not-found"
    size = os.path.getsize(path)
    if size > MAX_ATTACHMENT_BYTES:
        return None, "too-large"
    with open(path, "rb") as handle:
        raw = handle.read(MAX_ATTACHMENT_BYTES)
    return raw.decode("utf-8", "replace"), ""
```

Context builder:

```python
def attachment_context(session_id, attachments):
    lines = []
    total = 0
    for item in attachments[:8]:
        path = attachment_abs_path(session_id, item)
        label = safe_text(item.get("name") or item.get("path"), 240)
        lines.append("## Attachment: %s" % label)
        if not path:
            lines.append("(invalid or unsupported attachment reference)")
            continue
        text, error = read_attachment_text(path)
        if error:
            lines.append("(%s; path: %s)" % (error, safe_text(path, 500)))
            continue
        remaining = MAX_ATTACHMENT_TOTAL_CHARS - total
        if remaining <= 0:
            lines.append("(attachment context limit reached)")
            break
        clipped = safe_text(text, min(remaining, 120000))
        total += len(clipped)
        lines.append("```")
        lines.append(clipped)
        lines.append("```")
    return "\n".join(lines)
```

In `process_queue_file`:

```python
attachments = item.get("attachments") if isinstance(item.get("attachments"), list) else []
attachment_text = attachment_context(session_id, attachments)
if attachment_text:
    text = text + "\n\nAttached file contents available to the VM agent:\n" + attachment_text
```

Also append a visible thinking message:

```python
if attachments:
    append_thinking(session_id, item.get("id") or "", "attachments", "Reading %s attached file reference(s) from the VM session workspace." % len(attachments))
```

### Handling Binary Files

For images, PDFs, `.tdr`, `.plt`, and other binary files:

- Do not inject raw binary into the LLM prompt.
- Include metadata only: name, size, path, source.
- If text extraction is needed later, implement dedicated extractors per format.

### Acceptance Criteria

1. Upload a `.txt` file containing a unique phrase. Ask the VM agent to quote or summarize the attached file. The agent must respond using the actual content, not only the file name.
2. Upload a `.cmd` or `.des` deck and ask the VM agent to inspect it. The agent must mention specific statements from the deck.
3. Attach a VM-generated `.log`, `.out`, `.err`, `.json`, or `.csv` file using `Use in next prompt`. The agent must read its actual content.
4. Attach a binary file. The agent should receive metadata and explain that content extraction is unsupported, not hallucinate the contents.
5. Oversized attachments are clipped or rejected with a clear message.

## End-To-End Validation Checklist

Run:

```bash
npm run typecheck
npm run build
```

Manual checks:

1. Mobile progress:
   - Open the app at 390px width.
   - Start or load a session with progress events.
   - Tap `Show`.
   - Confirm detail rows or cards are visible.

2. Visible reasoning summary:
   - Send a request that takes long enough to wait for the agent.
   - Confirm a visible `Agent working` or `Reasoning summary` panel appears while running.
   - Confirm the panel collapses above the final answer.
   - Confirm no hidden chain-of-thought is displayed.

3. Attachment content:
   - Attach a text file with known contents.
   - Ask the agent what is in the file.
   - Confirm the response uses the file content.

4. Existing behavior:
   - Session creation still works.
   - VM agent start/history/stream still works.
   - Upload/download still works.
   - Artifact previews still work.
   - Run progress and final run result messages still work.
