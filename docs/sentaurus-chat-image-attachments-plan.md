# Sentaurus Chat Image Attachments Plan

## Purpose

Add first-class image attachments to the Sentaurus web chat so both sides can show images directly in the message list:

- user uploads images from the browser and sees them in the chat bubble,
- the VM agent can return generated device/structure images as message attachments,
- images remain visible after refresh/history reload,
- image files can still be attached to VM-agent context as metadata or binary references.

This plan is for the downstream implementation agent.

## Current Baseline

Relevant existing code:

- `packages/shared/src/index.ts`
  - `VmAgentMessage`
  - `VmAgentAttachmentRef`
  - `VmAgentAttachmentSource`
- `apps/web/src/App.tsx`
  - `pendingAttachments`
  - `pendingVmAttachments`
  - `messageAttachments`
  - `renderImagePreview(...)`
  - inline preview for image VM artifacts in message bubbles
- `apps/web/src/styles.css`
  - `.image-preview-card`
  - `.image-thumb-button`
  - `.image-lightbox`
- `apps/server/src/routes/runs.ts`
  - `POST /api/runs/:id/files`
  - `GET /api/runs/:id/files/:name`
- `apps/server/src/routes/vmAgent.ts`
  - `POST /api/vm/agent/messages`
  - VM session file downloads
  - VM run artifact downloads
- `apps/server/src/services/vmAgent.ts`
  - VM worker message JSONL relay
  - artifact collection includes `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`
  - attachment context treats images as binary metadata

The code already has image thumbnails for some VM artifacts, but user-uploaded image display is local-state based and not durable. There is no unified message-level attachment field, so images are not reliably available after refresh or across history fetches.

## Product Behavior

Target behavior:

1. User can click `Attach image` or use the current `Attach` picker with images.
2. Selected images show as pending thumbnails above the composer.
3. On send, the images upload to the current session/run.
4. The user message bubble shows the uploaded images inline.
5. Refreshing the browser still shows those images in the same message.
6. If the VM agent generates image artifacts, the agent message bubble shows those images inline.
7. Clicking a thumbnail opens the existing lightbox.
8. A `Download` link remains available.
9. Non-image files continue to show as chips.
10. Binary images are not inlined into text context; they are passed as image attachments/metadata and displayed visually.

## Data Model

Add message-level attachment metadata. Do not rely on `messageAttachments` React state for persisted rendering.

In `packages/shared/src/index.ts`:

```ts
export type VmAgentMessageAttachmentKind = "file" | "image";

export type VmAgentMessageAttachment = {
  id: string;
  kind: VmAgentMessageAttachmentKind;
  name: string;
  size: number;
  contentType?: string;
  source: VmAgentAttachmentSource;
  path: string;
  runId?: string;
  category?: VmSessionOutputCategory;
  width?: number;
  height?: number;
  thumbnailPath?: string;
};

export type VmAgentMessage = {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  createdAt: string;
  vmCreatedAt?: string;
  hostReceivedAt?: string;
  sequence?: number;
  meta?: Record<string, string | number | boolean | null>;
  attachments?: VmAgentMessageAttachment[];
};
```

Keep `VmAgentAttachmentRef` for context delivery. Add `attachments` to `VmAgentMessage` for display/history.

Recommended source mapping:

- user upload: `source: "run-input"`
- synced VM session image: `source: "vm-session-file"`
- VM-generated image artifact: `source: "vm-run-artifact"`

## Server Changes

### 1. Image Type Helpers

Create shared server helpers, for example:

- `apps/server/src/services/imageAttachments.ts`

Recommended helpers:

```ts
export const chatImageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
export const chatImageContentTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function isChatImageName(name: string): boolean;
export function isChatImageContentType(contentType?: string): boolean;
export function messageAttachmentFromVmRef(ref: VmAgentAttachmentRef): VmAgentMessageAttachment;
```

Use extension plus content type. Do not allow SVG for chat image upload unless the code sanitizes it, because inline SVG can carry script and HTML-adjacent risks. If SVG must be supported later, serve it only as download or sanitize it first.

### 2. Upload Validation

File:

- `apps/server/src/routes/runs.ts`

Current `POST /api/runs/:id/files` accepts uploaded files generally. Add explicit image checks for chat display:

- allow `png`, `jpg`, `jpeg`, `webp`, `gif`,
- reject files whose content type does not match the allowlist when the browser provides it,
- keep existing `MAX_UPLOAD_MB`,
- optionally add a stricter `MAX_CHAT_IMAGE_MB`, for example 8 MB,
- preserve the existing VM sync result.

If possible, sniff magic bytes for common image types:

- PNG: `89 50 4E 47`
- JPEG: `FF D8 FF`
- GIF: `47 49 46 38`
- WEBP: `RIFF....WEBP`

This prevents a renamed script from rendering as an image.

### 3. Persist Attachments On User Messages

Files:

- `apps/server/src/routes/vmAgent.ts`
- `apps/server/src/services/vmAgent.ts`

Extend `VmAgentMessageRequest`:

```ts
export type VmAgentMessageRequest = {
  message: string;
  sessionId?: string;
  attachments?: VmAgentAttachmentRef[];
  displayAttachments?: VmAgentMessageAttachment[];
};
```

Validation rules:

- `displayAttachments` must be derived from validated upload responses or validated VM refs.
- limit to the same count as `attachments`, for example 8.
- safe paths only.
- only image display attachments get `kind: "image"`.

When calling the VM control script, include both:

```ts
callVmAgent({
  operation: "send",
  message,
  sessionId,
  attachments: enrichedAttachments,
  displayAttachments
});
```

In the remote Python control script, update `enqueue_message(...)` so the appended user message stores `attachments` for context and `displayAttachments` for UI display:

```python
def enqueue_message(content, session_id=None, attachments=None, display_attachments=None):
    meta = {"kind": "web_message", "queuedFor": "vm-agent-worker"}
    message = append_message("user", content, "web", meta, "web")
    message["attachments"] = attachment_refs
    message["displayAttachments"] = normalize_display_attachments(display_attachments)
```

Then update `append_message` or the message object schema so `displayAttachments` is written into `messages.jsonl`.

On host normalization, preserve it:

```ts
function normalizeMessages(...) {
  ...
  attachments: normalizeDisplayAttachments(item.displayAttachments ?? item.attachments)
}
```

Prefer the public field name `attachments` on `VmAgentMessage`, and keep context-only refs in VM internals if needed.

### 4. Agent Image Artifact Attachments

File:

- `apps/server/src/services/vmAgent.ts`

When the VM worker completes a Sentaurus run and appends the final agent message, it already has `artifacts`.

Enhance the Python worker near the final `append_message("agent", reply, ...)` path:

1. Detect image artifacts from `artifacts`.
2. Build display attachment entries:

```json
{
  "id": "artifact_run_..._plots_structure.png",
  "kind": "image",
  "name": "structure.png",
  "size": 123456,
  "contentType": "image/png",
  "source": "vm-run-artifact",
  "path": "plots/structure.png",
  "runId": "run_...",
  "category": "simulation results"
}
```

3. Attach them to the agent message as `attachments`.

Suggested Python helper:

```python
IMAGE_EXTENSIONS = set([".png", ".jpg", ".jpeg", ".webp", ".gif"])

def display_attachments_for_artifacts(run_id, artifacts, limit=12):
    result = []
    for item in artifacts or []:
        rel = safe_text(item.get("path"), 500).replace("\\", "/")
        ext = os.path.splitext(rel)[1].lower()
        if ext not in IMAGE_EXTENSIONS:
            continue
        name = os.path.basename(rel)
        result.append({
            "id": ("artifact_%s_%s" % (run_id, rel)).replace("/", "_"),
            "kind": "image",
            "name": name,
            "size": int(item.get("size") or 0),
            "contentType": content_type_for_ext(ext),
            "source": "vm-run-artifact",
            "path": rel,
            "runId": run_id,
        })
    return result[:limit]
```

This lets the UI render agent images directly from the message without reparsing `vmRunArtifactsJson`.

### 5. Download Endpoints

Existing endpoints can be reused:

- user upload image:
  - `GET /api/runs/:id/files/:name`
- VM session image:
  - `GET /api/vm/agent/sessions/:sessionId/files/download`
- VM artifact image:
  - `GET /api/vm/agent/runs/:runId/artifacts`

Make sure image responses include accurate content types:

- `image/png`
- `image/jpeg`
- `image/webp`
- `image/gif`

For `GET /api/runs/:id/files/:name`, currently it streams without explicit content type. Add content-type detection for images so browser rendering is stable.

## Frontend Changes

### 1. API Types

Files:

- `apps/web/src/api/vmAgent.ts`
- `apps/web/src/api/runs.ts`
- `packages/shared/src/index.ts`

Update `sendVmAgentMessage`:

```ts
export async function sendVmAgentMessage(
  message: string,
  sessionId?: string,
  attachments: VmAgentAttachmentRef[] = [],
  displayAttachments: VmAgentMessageAttachment[] = []
): Promise<VmAgentMessageResponse> {
  return requestJson("/api/vm/agent/messages", {
    method: "POST",
    body: JSON.stringify({ message, sessionId, attachments, displayAttachments })
  });
}
```

### 2. Pending Upload UI

File:

- `apps/web/src/App.tsx`

Keep the current `Attach` input, but make image behavior explicit:

- accept images and normal files:
  - `accept=".txt,.plt,.cmd,.des,.log,.out,.err,.csv,.json,.png,.jpg,.jpeg,.webp,.gif"`
- show pending image thumbnails using `URL.createObjectURL(file)`,
- revoke object URLs when files are removed or sent,
- show filename and size below thumbnails,
- keep non-image files as chips.

Add helpers:

```ts
function isImageFile(file: File): boolean {
  return /^image\/(png|jpeg|webp|gif)$/.test(file.type) || isImagePath(file.name);
}

function displayAttachmentFromUpload(
  uploaded: UploadRunFileResponse,
  ref: VmAgentAttachmentRef,
  contentType?: string
): VmAgentMessageAttachment {
  return {
    id: ref.id,
    kind: isImagePath(uploaded.file.name) ? "image" : "file",
    name: uploaded.file.name,
    size: uploaded.file.size,
    contentType,
    source: ref.source,
    path: ref.path,
    runId: ref.runId,
    category: ref.category
  };
}
```

### 3. Sending Messages

In `handleVmAgentMessage(...)`:

1. Upload files as today.
2. Build both:
   - `attachmentRefs` for VM context,
   - `displayAttachments` for persisted chat rendering.
3. Send both to the API.
4. Stop using local `messageAttachments` as the primary display source.

Recommended change:

```ts
const displayAttachments: VmAgentMessageAttachment[] = [];

for (const file of attachments) {
  const uploaded = await uploadRunFile(selectedRunId, file);
  const ref = ...;
  attachmentRefs.push(ref);
  displayAttachments.push(displayAttachmentFromUpload(uploaded, ref, file.type));
}

for (const ref of vmAttachments) {
  displayAttachments.push(displayAttachmentFromRef(ref));
}

const response = await sendVmAgentMessage(
  `${visibleText}${attachmentLine}`,
  selectedRunId,
  attachmentRefs,
  displayAttachments
);
```

After this, `messageAttachments` should only be a temporary optimistic fallback. The canonical source should be `message.attachments`.

### 4. Rendering Message Attachments

In the message loop:

```ts
const attachments = message.attachments || messageAttachments[message.id] || [];
```

Render by attachment kind:

```tsx
{attachments.map((attachment) => (
  attachment.kind === "image"
    ? renderImagePreview(
        imageAttachmentUrl(attachment),
        attachment.name,
        imageAttachmentUrl(attachment)
      )
    : renderFileChip(attachment)
))}
```

Add URL helper:

```ts
function imageAttachmentUrl(attachment: VmAgentMessageAttachment): string {
  if (attachment.source === "run-input" && attachment.runId) {
    return downloadUrl(attachment.runId, "files", attachment.path || attachment.name);
  }
  if (attachment.source === "vm-run-artifact" && attachment.runId) {
    return vmRunArtifactDownloadUrl(attachment.runId, attachment.path);
  }
  if (attachment.source === "vm-session-file" && attachment.runId && attachment.category) {
    return vmSessionFileDownloadUrl(attachment.runId, attachment.category, attachment.path);
  }
  return "";
}
```

Keep the existing fallback that parses `vmRunArtifactsJson`, but avoid duplicate images by de-duping on `source/runId/path`.

### 5. Agent Response Images

For agent messages:

- render `message.attachments` first,
- then render any extra `vmRunArtifactsForMessage(message)` images that are not already in `message.attachments`.

This gives backwards compatibility with old messages while letting new messages use the durable attachment field.

## VM Agent Prompt/Capability Wording

Update the VM worker system/capability text so it stops saying there is no image upload/display path after implementation.

Add guidance:

- If the user asks for a device structure image, generate/export a PNG/JPG artifact when possible.
- When a run creates image artifacts, attach them to the final message.
- If the image cannot be generated, say which required tool or artifact is missing.

Do not claim an image is attached unless the artifact exists and the message includes an image attachment record.

## Security And Limits

Required:

1. Do not inline image binary data as base64 in message JSONL.
2. Store files on disk and reference them by safe path.
3. Keep auth token protection on image download URLs.
4. Reject path traversal.
5. Enforce upload size limits.
6. Allow only `png`, `jpg`, `jpeg`, `webp`, `gif` for inline chat image display.
7. Treat SVG as download-only or unsupported.
8. Use `loading="lazy"` for thumbnails.
9. Use object URL cleanup for pending previews.
10. Cap displayed images per message, for example 12, with a `+N more` chip.

## CSS / UX Requirements

Reuse existing classes:

- `.image-preview-card`
- `.image-thumb-button`
- `.image-lightbox`
- `.message-attachments`
- `.attachment-chip`

Add only scoped styles if needed:

- `.pending-image-grid`
- `.pending-image-card`
- `.message-image-grid`

Mobile requirements:

- thumbnails must not overflow message bubbles,
- image grid should wrap cleanly,
- lightbox image should fit viewport with `max-width: 100%` and `max-height: 80vh`,
- remove/download controls must stay tappable.

## Implementation Order

1. Add shared `VmAgentMessageAttachment` type and optional `attachments` field on `VmAgentMessage`.
2. Update server message normalization to preserve `attachments`.
3. Extend `POST /api/vm/agent/messages` to accept validated `displayAttachments`.
4. Update the remote VM control script to store display attachments in `messages.jsonl`.
5. Add image content-type handling for run file downloads.
6. Update frontend `sendVmAgentMessage` signature.
7. Update composer pending image previews.
8. Update `handleVmAgentMessage` to send `displayAttachments`.
9. Render `message.attachments` in message bubbles.
10. Update VM worker final run message to attach image artifacts.
11. De-dupe legacy artifact-derived image previews.
12. Run typecheck/build and manual image tests.

## Manual Test Cases

### Test 1: User Upload PNG

1. Select a session.
2. Upload a small `.png`.
3. Send `Here is the structure reference image.`

Expected:

- pending preview appears before send,
- user message shows the image inline,
- clicking the thumbnail opens lightbox,
- refresh still shows the image,
- VM agent receives the image as binary/metadata attachment, not only filename.

### Test 2: User Upload JPG With Text File

Attach one `.jpg` and one `.plt`.

Expected:

- `.jpg` renders as image,
- `.plt` renders as file chip,
- `.plt` can still be included in text context,
- `.jpg` is not decoded as text.

### Test 3: VM Agent Generated Image Artifact

Ask the VM agent to run or produce a device structure image.

Expected:

- generated `.png` or `.jpg` appears in the agent message bubble,
- image downloads through `vmRunArtifactDownloadUrl`,
- old artifact list still shows the file.

### Test 4: History Reload

Reload the browser after Test 1 and Test 3.

Expected:

- both user and agent images still appear in the chat,
- no dependency on local `messageAttachments` state.

### Test 5: Rejected SVG

Try uploading `.svg`.

Expected:

- SVG is rejected for inline chat image display or treated as normal download-only file,
- it is not rendered inside `<img>` as a trusted inline image.

## Acceptance Criteria

The downstream fix is complete when:

1. users can upload image files from the composer,
2. user-uploaded images render inline in the chat message,
3. VM-generated image artifacts render inline in agent messages,
4. image attachments persist across history reload,
5. text/binary context handling remains separate from display attachments,
6. image URLs use existing authenticated download routes,
7. `npm run typecheck` passes,
8. `npm run build` passes.
