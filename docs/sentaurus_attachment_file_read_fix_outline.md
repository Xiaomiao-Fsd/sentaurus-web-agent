# Sentaurus Attachment File Read Fix Outline

## Purpose

This outline is for the downstream implementation agent. It is based on the report in:

- `docs/sentaurus_attachment_file_read_issue.md`

The reported failure is still that the VM agent can see attachment names and metadata, but cannot reliably read the actual uploaded file contents.

The immediate target is reliable text attachment access for files such as:

- `.txt`
- `.plt`
- `.cmd`
- `.des`
- `.log`
- `.out`
- `.err`
- `.csv`
- `.json`

Binary files can remain metadata-only for now.

## Current Situation

The current code already has part of an attachment-reference implementation:

- `packages/shared/src/index.ts`
  - `VmAgentAttachmentRef`
  - `VmAgentMessageRequest`
- `apps/web/src/App.tsx`
  - builds `pendingAttachments`
  - uploads each file through `uploadRunFile`
  - builds `VmAgentAttachmentRef`
  - calls `sendVmAgentMessage(..., attachmentRefs)`
- `apps/web/src/api/vmAgent.ts`
  - sends `attachments` in the JSON body
- `apps/server/src/routes/vmAgent.ts`
  - validates attachment refs
- `apps/server/src/services/vmAgent.ts`
  - passes attachment refs to the remote VM control script
  - queues attachments in the VM worker queue
  - tries to resolve and read them inside the VM worker

The failure likely persists because the attachment ref is only useful if the uploaded file was actually copied into the VM session folder. That copy can fail, and the current upload route still returns success.

Relevant current flow:

1. Frontend calls `uploadRunFile(selectedRunId, file)`.
2. Server saves the file locally under the run input folder.
3. Server calls `syncInputFileToVmSession(...)`.
4. If VM sync fails, `apps/server/src/routes/runs.ts` catches the error, writes a log line, and still returns success.
5. Frontend still creates a `source: "vm-session-file"` attachment ref.
6. VM worker tries to read:

```text
~/STDB/web-agent-sessions/<sessionId>/output/<category>/<fileName>
```

7. If step 3 failed, the worker sees only metadata and reports `file not found`.

This exactly matches the report:

- names are visible,
- context says attachments are available,
- `.txt` attachments later resolve as `file not found`,
- contents are not available to the model.

## Primary Fix Strategy

Make attachment content delivery reliable by using a two-layer approach:

1. Prefer VM-side files when sync succeeds.
2. Fall back to host-side inline text content for readable attachments when VM sync is missing or uncertain.

Do not rely on frontend-generated VM paths as proof that files exist in the VM.

## Required Changes

### 1. Make Upload Return VM Sync Status

File:

- `apps/server/src/routes/runs.ts`

Current behavior:

- The route catches `syncInputFileToVmSession` failures and only writes to `job.log`.
- The response does not tell the frontend whether the file is readable from the VM.

Change the response shape of `POST /api/runs/:id/files` to include VM sync status:

```ts
type UploadRunFileResponse = {
  file: RunFile;
  run: RunSummary;
  vmSync: {
    ok: boolean;
    category?: VmSessionOutputCategory;
    path?: string;
    error?: string;
  };
};
```

Implementation outline:

```ts
let vmSync: UploadRunFileResponse["vmSync"] = { ok: false };

try {
  const localPath = await resolveRunFile(request.params.id, "input", saved.name);
  await syncInputFileToVmSession(request.params.id, saved.name, localPath);
  vmSync = {
    ok: true,
    category: VM_SESSION_INPUT_CATEGORY,
    path: saved.name
  };
  await appendRunLog(...synced...);
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  vmSync = { ok: false, error: detail };
  await appendRunLog(...failed...);
}

return { file: saved, run: await getPublicRun(request.params.id), vmSync };
```

Important:

- Do not silently imply VM readability when `vmSync.ok === false`.
- Keep local upload success separate from VM sync success.

### 2. Centralize Session Output Category Constants

Files:

- `packages/shared/src/index.ts`
- `apps/server/src/services/vmSessionFiles.ts`
- `apps/server/src/services/vmAgent.ts`
- `apps/web/src/App.tsx`

Problem:

- Category strings are duplicated in multiple places.
- Some terminals show mojibake for Chinese category names.
- Any mismatch between frontend ref category, sync destination, and VM worker lookup will produce `file not found`.

Create shared constants in `packages/shared/src/index.ts`:

```ts
export const VM_SESSION_OUTPUT_CATEGORIES = [
  "my_inputs",
  "simulation_results",
  "simulation_logs",
  "simulation_parameters",
  "other_files"
] as const;

export type VmSessionOutputCategory = typeof VM_SESSION_OUTPUT_CATEGORIES[number];

export const VM_SESSION_INPUT_CATEGORY: VmSessionOutputCategory = "my_inputs";
```

Migration note:

- If keeping existing Chinese folder names is required for compatibility, keep a mapping layer:

```ts
export const VM_SESSION_OUTPUT_CATEGORY_LABELS: Record<VmSessionOutputCategory, string> = {
  my_inputs: "My inputs",
  simulation_results: "Simulation results",
  simulation_logs: "Simulation logs",
  simulation_parameters: "Simulation parameters",
  other_files: "Other files"
};
```

The key point is that the filesystem directory names should be stable ASCII IDs, while UI labels can be localized separately.

If changing directory names is too large for this pass, do the smaller fix:

- Export one shared `VM_SESSION_INPUT_CATEGORY`.
- Import and use it everywhere.
- Remove local duplicate category arrays.

### 3. Stop Frontend From Inventing VM-Readable Refs

File:

- `apps/web/src/App.tsx`
- `apps/web/src/api/runs.ts`

Current frontend flow constructs:

```ts
{
  source: "vm-session-file",
  name: file.name,
  path: file.name,
  category: INPUT_SESSION_CATEGORY
}
```

This is unsafe because the frontend does not know whether the file exists in the VM session folder.

Change frontend behavior:

1. Use the `vmSync` response from `uploadRunFile`.
2. If `vmSync.ok === true`, build a `vm-session-file` ref from the server response.
3. If `vmSync.ok === false`, either:
   - do not send a VM path ref, and show a clear warning, or
   - send a `run-input` ref so the backend can inline the local file content before calling the VM.

Preferred local upload ref:

```ts
const ref: VmAgentAttachmentRef = upload.vmSync.ok
  ? {
      id,
      source: "vm-session-file",
      name: upload.file.name,
      path: upload.vmSync.path || upload.file.name,
      size: upload.file.size,
      runId: selectedRunId,
      category: upload.vmSync.category
    }
  : {
      id,
      source: "run-input",
      name: upload.file.name,
      path: upload.file.name,
      size: upload.file.size,
      runId: selectedRunId
    };
```

The `run-input` source must be resolved by the host backend, not by the VM worker.

### 4. Add Backend Attachment Enrichment Before Sending To VM

File:

- `apps/server/src/services/vmAgent.ts`

Current problem:

- `source: "run-input"` is normalized, but the VM worker currently resolves it like a VM session file.
- That is wrong because local run input files live on the host backend filesystem, not necessarily inside the VM.

Add a backend-side enrichment step before `callVmAgent({ operation: "send", ... })`.

For each attachment:

- If `source === "run-input"`:
  - validate `runId`
  - resolve host local file with `resolveRunFile(runId, "input", path)`
  - read text content if extension is readable and size is under limit
  - attach inline content to the ref sent to the VM
- If `source === "vm-session-file"`:
  - optionally verify remote existence using a lightweight VM session list/read call
  - if verification fails and a corresponding local input file exists, fall back to inline content
- If `source === "vm-run-artifact"`:
  - leave as VM path ref because the worker can resolve VM artifact paths

Suggested enriched shape:

```ts
type EnrichedVmAgentAttachmentRef = VmAgentAttachmentRef & {
  inlineText?: string;
  inlineTextTruncated?: boolean;
  inlineError?: string;
};
```

Limits:

```ts
const readableAttachmentExtensions = new Set([
  ".txt", ".md", ".rst", ".log", ".out", ".err", ".csv", ".json",
  ".cmd", ".des", ".par", ".scm", ".tcl", ".sde", ".dat", ".plt"
]);

const maxInlineAttachmentBytes = 256 * 1024;
const maxInlineAttachmentTotalChars = 600_000;
```

Do not inline binary files.

### 5. Teach VM Worker To Prefer Inline Text

File:

- `apps/server/src/services/vmAgent.ts`

Inside the remote worker script, update `attachment_context`.

Current behavior:

- Worker resolves filesystem path first.
- If not found, summary says `file not found`.

New behavior:

1. If `ref.inlineText` is present, use it as the source of truth.
2. Else resolve and read VM filesystem path.
3. Else include a clear attachment error summary.

Pseudo-code:

```python
def attachment_context(session_id, attachments):
    ...
    inline_text = safe_text(ref.get("inlineText"), MAX_ATTACHMENT_READ_BYTES)
    if inline_text:
        summaries.append({
            "name": name,
            "path": safe_text(ref.get("path"), 500),
            "source": safe_text(ref.get("source"), 60),
            "inline": True,
            "size": len(inline_text),
            "truncated": bool(ref.get("inlineTextTruncated")),
        })
        chunks.append("[Attachment %s: %s (inline)]\n%s" % (index, name, inline_text))
        continue

    # existing VM path resolution follows
```

This makes local uploads robust even when VM sync fails.

### 6. Do Not Truncate The Entire User Message Too Early

File:

- `apps/server/src/services/vmAgent.ts`

Current worker flow does:

```python
text = safe_text(item.get("content"), 4000)
...
text = safe_text(text + "\n\n[VM attachment context]\n" + attachment_text, MAX_ATTACHMENT_CONTEXT_CHARS + 5000)
```

This is mostly okay, but confirm that:

- user prompt text is limited separately,
- attachment context is limited separately,
- adding attachment context does not accidentally clip all useful attachment content.

Use:

```python
user_text = safe_text(item.get("content"), 4000)
attachment_text, summaries = attachment_context(...)
text = user_text
if attachment_text:
    text = user_text + "\n\n[VM attachment context]\n" + safe_text(attachment_text, MAX_ATTACHMENT_CONTEXT_CHARS)
```

### 7. Surface Attachment Resolution Diagnostics In UI

Files:

- `apps/server/src/services/vmAgent.ts`
- `apps/web/src/App.tsx`

The report was only obvious after the agent said `file not found`. Add structured diagnostics so failures are visible.

Worker should add `attachmentsJson` to the user message and thinking/progress messages:

```json
[
  {
    "name": "idvg_low.txt",
    "source": "run-input",
    "inline": true,
    "size": 12345,
    "truncated": false
  },
  {
    "name": "idvg_high.txt",
    "source": "vm-session-file",
    "error": "file not found",
    "path": "idvg_high.txt"
  }
]
```

Frontend can show small attachment state labels:

- `readable`
- `inline`
- `synced`
- `metadata only`
- `not found`
- `binary`
- `too large`

This helps users and future agents distinguish "uploaded to host" from "readable by VM agent".

## Specific Bug To Check First

Before implementing a large refactor, check this exact failure path:

1. Upload `idvg_low.txt`.
2. Inspect server logs for:

```text
VM input sync failed for idvg_low.txt: ...
```

3. Inspect VM path:

```bash
ssh <target> 'find ~/STDB/web-agent-sessions -name idvg_low.txt -print'
```

4. Inspect queued message:

```bash
ssh <target> 'tail -n 1 ~/.sentaurus-web-agent/vm-agent/messages.jsonl'
```

or queue files if still pending:

```bash
ssh <target> 'find ~/.sentaurus-web-agent/vm-agent/queue -type f -maxdepth 1 -print -exec cat {} \;'
```

Expected if fixed:

- Either the file exists under the VM session folder, or
- the queued/enriched request includes `inlineText`.

If neither is true, the VM agent cannot read the file.

## Attachment Library Context Ingestion Plan

The VM agent cannot read the web attachment library by itself. The web app and API must explicitly convert selected library files into either:

1. inline text that is appended to the VM agent request context, or
2. a verified VM-side path that the remote worker can read.

Do not depend on filenames in the prompt. A filename is only metadata, not context.

### Target User Flow

The UI should make attachment-library context explicit:

1. User opens the attachment library, session files panel, or run artifacts panel.
2. User clicks `Add to context` for one or more files.
3. The composer shows a context tray with selected files.
4. When the user sends the message, the request includes `attachments`.
5. The server resolves every selected attachment before queueing the VM request.
6. The remote worker receives actual text snippets or verified readable paths.
7. The VM agent answer is based on file contents, not only file names.

Avoid automatically injecting the entire attachment library. It can quickly exceed context limits and may leak irrelevant files into the model prompt. Add an optional bulk action such as `Add all readable files in this category`, but keep the same size limits and diagnostics.

### Shared Attachment Ref Model

Keep `VmAgentAttachmentRef`, but treat it as a selector, not as proof that content is already in context.

Recommended normalized shape:

```ts
type VmAgentAttachmentSource =
  | "run-input"
  | "vm-session-file"
  | "vm-run-artifact";

type VmAgentAttachmentRef = {
  id: string;
  source: VmAgentAttachmentSource;
  name: string;
  path: string;
  size?: number;
  runId?: string;
  category?: VmSessionOutputCategory;
  contentType?: string;
};
```

Add an internal server-side enriched shape:

```ts
type EnrichedVmAgentAttachmentRef = VmAgentAttachmentRef & {
  contextStatus:
    | "inline"
    | "vm_path"
    | "metadata_only"
    | "not_found"
    | "too_large"
    | "unsupported"
    | "error";
  inlineText?: string;
  inlineTextTruncated?: boolean;
  vmPath?: string;
  inlineError?: string;
};
```

Only the enriched shape should be passed to the remote VM queue.

### Frontend Changes

Files to inspect first:

- `apps/web/src/App.tsx`
- `apps/web/src/api/vmAgent.ts`
- any new attachment-library components under `apps/web/src/components`

Required frontend behavior:

1. Add a visible `Add to context` action beside every attachment-library file.
2. Store selected refs in `pendingVmAttachments` or a dedicated `contextAttachments` state.
3. Show selected files in a composer context tray.
4. Allow removing a selected file before send.
5. Send selected refs in `POST /api/vm/agent/messages`.
6. Do not create `source: "vm-session-file"` refs for local uploads unless the upload response reports `vmSync.ok === true`.
7. For host-side uploaded files, prefer `source: "run-input"` so the backend can read the local saved copy and inline it.

The frontend should not try to read large file contents and put them directly into the JSON request. Keep file-content extraction on the server so limits, logging, and error handling are centralized.

### Backend Context Resolution

Files to inspect first:

- `apps/server/src/services/vmAgent.ts`
- `apps/server/src/routes/vmAgent.ts`
- `apps/server/src/services/vmSessionFiles.ts`
- `apps/server/src/routes/runs.ts`

Add or extend one centralized resolver:

```ts
async function enrichAttachmentsForVm(
  sessionId: string,
  attachments: VmAgentAttachmentRef[]
): Promise<EnrichedVmAgentAttachmentRef[]> {
  // Resolve each selected attachment into inline text, vmPath, or diagnostics.
}
```

Resolution rules:

1. `source: "run-input"`
   - Read from the host run input directory using the existing run file helpers.
   - If extension and size are readable, decode to text and set `contextStatus: "inline"`.
   - If binary or unsupported, set `contextStatus: "metadata_only"`.

2. `source: "vm-session-file"`
   - If the server can download the VM session file through `downloadVmSessionFile`, use that buffer and inline readable text.
   - If a verified remote path exists and the remote worker can read it, set `contextStatus: "vm_path"` and include `vmPath`.
   - If neither succeeds, set `contextStatus: "not_found"` or `contextStatus: "error"`.

3. `source: "vm-run-artifact"`
   - Resolve through the run artifact download path if available.
   - Inline readable text files such as `.plt`, `.txt`, `.log`, `.out`, `.err`, `.cmd`, `.des`, `.csv`, and `.json`.
   - Keep binary artifacts metadata-only.

4. Total context budget
   - Enforce a per-file byte limit.
   - Enforce a total inline character limit across all attachments.
   - Mark truncated files with `inlineTextTruncated: true`.

Readable-extension allowlist:

```ts
const readableAttachmentExtensions = new Set([
  ".txt",
  ".plt",
  ".cmd",
  ".des",
  ".log",
  ".out",
  ".err",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".md"
]);
```

Recommended default limits:

```ts
const maxInlineAttachmentBytes = 512 * 1024;
const maxInlineAttachmentTotalChars = 300_000;
```

These values can be lower if the current VM-agent model context is small.

### Context Injection Format

Prefer passing enriched attachments as structured JSON to the remote worker, then let the worker append context to the prompt. This keeps UI display text separate from model context.

The remote worker should generate a deterministic context block:

````text
[Attachment context]

### idvg_low.plt
source: vm-run-artifact
status: inline
truncated: false

```text
<file body>
```

### mesh.log
source: vm-session-file
status: metadata_only
reason: unsupported or binary
````

If the codebase already appends attachment context in `process_queue_file`, extend that path instead of creating a second injection mechanism.

### Remote VM Worker Changes

The worker must prefer enriched content in this order:

1. `inlineText`
2. verified `vmPath`
3. metadata and diagnostics only

Pseudocode:

```python
def attachment_context(attachments):
    parts = []
    for att in attachments:
        if att.get("inlineText"):
            parts.append(render_inline_attachment(att))
            continue

        vm_path = att.get("vmPath")
        if vm_path and os.path.exists(vm_path):
            parts.append(render_file_attachment(att, vm_path))
            continue

        parts.append(render_attachment_diagnostic(att))
    return "\n\n".join(parts)
```

The worker should not try to infer library storage paths from browser-side names. Path construction must happen on the server or use already verified VM paths.

### Diagnostics To Expose

Expose attachment-context status in server logs and, ideally, in the UI message detail area:

```json
{
  "name": "idvg_low.plt",
  "source": "vm-run-artifact",
  "contextStatus": "inline",
  "chars": 18420,
  "truncated": false
}
```

Failure examples should be explicit:

```json
{
  "name": "idvg_low.txt",
  "source": "vm-session-file",
  "contextStatus": "not_found",
  "error": "VM file does not exist and no host-side copy was available"
}
```

This is important because the previous bug was hidden by UI metadata that implied the file was readable.

### Additional Test Cases

Add these tests in addition to the upload tests below.

#### Test 6: Existing Attachment Library File

1. Put a readable `.txt` file into the attachment library.
2. Add it to context from the library UI.
3. Ask the VM agent to quote a unique token inside the file.

Expected:

- The selected file appears in the composer context tray.
- The server marks it as `contextStatus: "inline"` or `contextStatus: "vm_path"`.
- The VM agent quotes the unique token.

#### Test 7: Existing VM Run Artifact PLT

1. Run or import a job that produces `idvg_low.plt`.
2. Add that artifact to context from the artifact panel.
3. Ask the VM agent to summarize the `Data { ... }` block.

Expected:

- `.plt` is treated as readable text.
- The VM agent can cite numeric rows from the file.

#### Test 8: Message With Only Attachment Context

1. Add a readable file to context.
2. Send a short message such as `Analyze the attached file.`

Expected:

- The VM agent can analyze the file without the user pasting content manually.

#### Test 9: Oversized Library File

1. Add a large readable file over the per-file limit.

Expected:

- The server truncates or rejects inline context according to configured policy.
- The UI and diagnostics show `too_large` or `inlineTextTruncated: true`.

## Required Test Cases

### Test 1: Host Upload With VM Sync Success

1. Upload `attachment_probe.txt` containing:

```text
UNIQUE_SENTaurus_ATTACHMENT_PROBE_20260628
```

2. Send:

```text
Read the attached file and quote the unique probe token.
```

Expected:

- VM agent quotes `UNIQUE_SENTaurus_ATTACHMENT_PROBE_20260628`.
- Attachment diagnostics show `synced` or `readable`.

### Test 2: Host Upload With VM Sync Failure

Temporarily force `syncInputFileToVmSession` to fail or point it at an invalid SSH target.

Expected:

- Upload still stores the local host file.
- `vmSync.ok === false`.
- Backend enriches the message with inline text from local `run-input`.
- VM agent still reads the content.
- UI shows that the attachment was provided inline or that VM sync failed but fallback succeeded.

### Test 3: PLT Text File

Upload `idvg_low.plt` and `idvg_high.plt`.

Expected:

- `.plt` is treated as readable text.
- VM agent can see the `Data { ... }` block.
- VM agent can parse or at least quote numeric rows from the data block.

### Test 4: Converted TXT File

Upload `idvg_low.txt` and `idvg_high.txt`.

Expected:

- No `file not found`.
- VM agent sees actual file body.

### Test 5: Binary Metadata Only

Upload or attach `.tdr` or image file.

Expected:

- VM agent receives metadata only.
- It does not hallucinate file content.
- UI labels it as `binary / metadata only`.

## Acceptance Criteria

The downstream fix is complete when all of these are true:

1. The frontend no longer claims an attachment is VM-readable unless the server confirms VM sync or inline fallback.
2. `POST /api/runs/:id/files` reports VM sync status.
3. `sendVmAgentMessage` passes attachment refs plus inline text fallback when needed.
4. VM worker reads `inlineText` before attempting VM filesystem resolution.
5. `.plt` and `.txt` attachment contents can be read by the VM agent.
6. The user can ask the VM agent to inspect an uploaded file and receive an answer based on the actual content.
7. Attachment diagnostics are visible in logs or UI.
8. `npm run typecheck` passes.
9. `npm run build` passes.

## Implementation Order

1. Add shared constants for session output categories or at least `VM_SESSION_INPUT_CATEGORY`.
2. Change upload response to include `vmSync`.
3. Change frontend upload handling to trust server `vmSync`, not locally invented refs.
4. Add backend enrichment for `source: "run-input"` attachments.
5. Add `inlineText` handling in the VM worker's `attachment_context`.
6. Add diagnostics to user message metadata and thinking/progress summaries.
7. Run the five manual tests above.

## Notes

- This issue is not solved by showing attachment names in the prompt.
- This issue is not solved by metadata alone.
- The VM worker needs either a real readable VM path or inline text content.
- The most robust fix is to support both paths and inline fallback.
