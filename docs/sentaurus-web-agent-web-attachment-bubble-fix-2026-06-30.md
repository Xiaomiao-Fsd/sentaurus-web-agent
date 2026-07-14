# Sentaurus Web Agent Web Attachment Bubble Fix

Date: 2026-06-30
Local source of truth:

```text
/home/XiaomiaoClaw/.openclaw/workspace/projects/sentaurus-web-agent
```

This handoff is intentionally ASCII-only.

## Problem

The VM worker was changed to append multiple `agent` messages for one request: text, publish-error notice, and attachment/image preview message.

However, the web UI can still look like it merged multiple VM agent replies into one bubble because the text message meta still contains artifact/session-file JSON fields. The frontend derives previews from message meta, so the text bubble can re-render the same attachments even when a separate attachment message exists.

Result: multiple backend messages exist, but the browser visually shows image previews under the text bubble, making it look as if everything is still one combined bubble.

## Commits To Apply Or Recreate

Local commits in order:

```text
9192103 Fix VM agent image attachment publishing
5e2a565 Track VM session file publish payloads
9642b6e Split VM agent reply and attachment messages
c2b8b60 Separate VM attachment preview messages
```

If the remote repo is not identical, recreate the changes by behavior rather than cherry-picking blindly.

## Required Backend Contract

File:

```text
apps/server/src/services/vmAgent.ts
```

The worker should emit separate agent messages for one processed queue item:

1. Text message(s): normal reply content.
2. Publish error message: visible error if VM session file publishing failed.
3. Attachment message: a separate message with `attachments`.

Important behavior:

- Text messages that have a separate attachment message must include:

```json
{"suppressAttachmentPreview": true}
```

inside `message.meta`.

- Attachment messages should use:

```json
{"kind":"vm_agent_attachments"}
```

inside `message.meta` and should include an `attachments` array.

- The attachment message may also carry the renderable meta fields, for backward compatibility:

```text
vmSessionFilesJson
vmRunArtifactsJson
autoDebugAttemptsJson
```

- The text message can still keep run/status context fields, but the frontend must not render previews from those fields when `suppressAttachmentPreview` is true.

## Required Shared Type Change

File:

```text
packages/shared/src/index.ts
```

Add optional `attachments` to `VmAgentMessage` and define `VmAgentAttachment`.

Expected shape:

```ts
export type VmAgentMessage = {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  createdAt: string;
  vmCreatedAt?: string;
  hostReceivedAt?: string;
  sequence?: number;
  meta?: Record<string, string | number | boolean | null>;
  attachments?: VmAgentAttachment[];
};

export type VmAgentAttachment = {
  id?: string;
  kind?: string;
  source?: string;
  category?: string;
  name?: string;
  path?: string;
  runId?: string;
  size?: number;
  contentType?: string;
};
```

## Required Web Changes

### 1. Normalize message attachments from the backend

File:

```text
apps/server/src/services/vmAgent.ts
```

Host-side TypeScript normalization should preserve `message.attachments` from the VM worker. There should be a helper equivalent to:

```ts
function normalizeAttachments(value: unknown): VmAgentMessage["attachments"] {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const attachment = {
      id: typeof record.id === "string" ? record.id : undefined,
      kind: typeof record.kind === "string" ? record.kind : undefined,
      source: typeof record.source === "string" ? record.source : undefined,
      category: typeof record.category === "string" ? record.category : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
      path: typeof record.path === "string" ? record.path : undefined,
      runId: typeof record.runId === "string" ? record.runId : undefined,
      size: typeof record.size === "number" && Number.isFinite(record.size) ? record.size : undefined,
      contentType: typeof record.contentType === "string" ? record.contentType : undefined
    };
    return attachment.path || attachment.name ? [attachment] : [];
  });
  return attachments.length > 0 ? attachments : undefined;
}
```

Then `normalizeMessages(...)` must set:

```ts
attachments: normalizeAttachments((message as { attachments?: unknown }).attachments)
```

### 2. Frontend should respect suppressAttachmentPreview

File:

```text
apps/web/src/App.tsx
```

Add helper:

```ts
function suppressAttachmentPreview(message: VmAgentMessage): boolean {
  return message.meta?.suppressAttachmentPreview === true;
}
```

At the start of both helpers, return no previews if this flag is set:

```ts
function vmArtifactsForMessage(message: VmAgentMessage): SessionVmArtifact[] {
  if (suppressAttachmentPreview(message)) return [];
  // existing logic...
}

function vmSessionFilesForMessage(message: VmAgentMessage): MessageVmSessionFile[] {
  if (suppressAttachmentPreview(message)) return [];
  // existing logic...
}
```

### 3. Frontend should read attachments directly

File:

```text
apps/web/src/App.tsx
```

`vmArtifactsForMessage(message)` should also read direct attachments:

```ts
if (Array.isArray(message.attachments)) {
  for (const item of message.attachments) {
    if (item.source !== "vm-run-artifact") continue;
    const runId = setupText(item.runId) || messageRunId(message);
    const artifactPath = setupText(item.path);
    if (!runId || !artifactPath) continue;
    const size = typeof item.size === "number" && Number.isFinite(item.size) ? item.size : 0;
    artifacts.push({ path: artifactPath, size, runId, messageId: message.id, createdAt: message.createdAt });
  }
}
```

`vmSessionFilesForMessage(message)` should combine meta JSON plus direct attachments with `source === "vm-session-file"`, then dedupe by `category:path`.

Also infer `isImage` from file extension if `record.isImage` is missing:

```ts
const isImage = typeof record.isImage === "boolean" ? record.isImage : isImagePath(name) || isImagePath(filePath);
```

### 4. Add visual separation for consecutive agent messages

File:

```text
apps/web/src/styles.css
```

Add styles similar to:

```css
.message-row.agent + .message-row.agent,
.message-row.trace + .message-row.agent,
.message-row.agent + .message-row.trace {
  margin-top: -0.45rem;
}

.message-row.agent + .message-row.agent .avatar {
  opacity: 0;
}

.message-row.agent + .message-row.agent .message-bubble {
  border-top-left-radius: 9px;
}

.message-row.agent .message-bubble:has(.chat-image-with-link),
.message-row.agent .message-bubble:has(.message-attachments) {
  border-color: rgba(20, 184, 166, 0.32);
  background: #f7fffd;
}
```

If browser support for `:has(...)` is a concern in the remote deployment target, replace it with an explicit class in JSX, for example `message-bubble has-attachments`, when `attachments.length > 0 || messageVmArtifacts.length > 0 || messageVmSessionFiles.length > 0`.

## Why Web-Only CSS Is Not Enough

CSS can make consecutive messages look more separated, but it does not prevent duplicate preview rendering.

The key fix is data-level:

- Text message gets `meta.suppressAttachmentPreview = true`.
- Attachment message owns the renderable `attachments` and artifact/session-file preview metadata.
- Frontend preview helpers return empty arrays for suppressed text messages.

Without that, the text bubble can still show image previews from `vmRunArtifactsJson` or `vmSessionFilesJson`.

## Validation Commands

Run from repo root:

```bash
npm run typecheck
npm run build
```

Optional embedded worker syntax check:

```bash
node - <<'NODE'
const fs = require('fs');
const text = fs.readFileSync('apps/server/src/services/vmAgent.ts', 'utf8');
const match = text.match(/const remoteWorkerScript = String\.raw`([\s\S]*?)`;\n\nconst remoteControlScript/);
if (!match) throw new Error('remoteWorkerScript not found');
fs.writeFileSync('/tmp/sentaurus-agent-worker-check.py', match[1]);
NODE
python3 -m py_compile /tmp/sentaurus-agent-worker-check.py
```

## Deployment Notes

After applying backend worker changes:

1. Build and deploy the web frontend.
2. Restart the host backend server.
3. Restart/reconnect the VM agent worker so the embedded worker source is written to the VM.
4. Test with a request that produces both text and image attachments.

Expected backend messages:

- One normal text `agent` message with `meta.suppressAttachmentPreview: true`.
- One attachment `agent` message with `meta.kind: "vm_agent_attachments"` and non-empty `attachments`.

Expected browser behavior:

- Text appears in one bubble.
- Image preview appears in a separate following bubble.
- The image is not duplicated under the text bubble.
