# Sentaurus Web Agent Debug Plan for Host Codex

Generated at: 2026-06-30 02:50 GMT+8
ASCII-only revision: 2026-06-30 03:35 GMT+8

Important: Do not use the GitHub repo as the baseline. The GitHub VM repo is about 100 commits behind the local host repo. Use this local repo as the source of truth:

```text
/home/XiaomiaoClaw/.openclaw/workspace/projects/sentaurus-web-agent
```

## 0. Goal

Finish and debug the full path:

```text
VM agent request -> allowlisted Sentaurus runner -> generated artifacts -> host backend -> web frontend chat preview -> session output categories
```

Primary requirements:

1. The VM agent can safely run `svisual -batchx <script.tcl>` to export structure images or gate zoom PNG files.
2. The VM agent can publish existing VM files through `VM_SESSION_FILE` with `sourcePath` or `path`.
3. The backend preserves artifact and session-file metadata from VM worker messages.
4. The frontend shows run artifacts and session files under chat messages, with image previews or clickable cards.
5. If a file path does not exist, the agent must say it was not found. It must not claim an image was sent.

## 1. Safety boundaries that must not be relaxed

Do not open a raw shell path. Do not add an arbitrary command endpoint.

Required boundaries:

- The browser must not receive SSH keys, LLM keys, or raw shell access.
- The backend must not expose arbitrary VM command execution.
- The VM runner allowlist is limited to: `sde`, `sprocess`, `sdevice`, `inspect`, `svisual`.
- `svisual` is allowed only as this exact argv form: `svisual -batchx <safe.tcl>`.
- The `<safe.tcl>` input must be a safe basename generated inside the run request. It must not be an arbitrary path.
- `VM_SESSION_FILE sourcePath/path` may only publish files from safe VM directories:
  - `~/STDB/web-agent-runs`
  - `~/STDB/web-agent-sessions`
  - `~/.sentaurus-web-agent/vm-agent/generated`
- Output categories must still map to the exact five product categories. Use ASCII aliases in code and prompts, then map to the real UI category names in existing code.

Recommended ASCII aliases for prompts and metadata:

```text
input
results
logs
params
other
```

These aliases should map to the existing product categories, not create new categories.

## 2. Recent local commits that GitHub may not have

Relevant local commits:

```text
fe9aaf8 Fix VM agent Python2 unicode LLM payloads
64817ae Allow svisual batch export in VM runner
5e934af Show VM agent work logs in chat
e663843 Document svisual image export flow for VM agent
96d1a52 Allow VM agent to publish local session files
200102c Add VM session image upload and output bridge
8c9ef52 Allow visual requests without valid run request
e3c0ca8 Relax VM agent request handling policy
8bdec7a Add VM agent context budget policy
6614b87 Extract VM run metrics after completion
56543e2 Keep VM agent session context durable
```

Meaning:

- `64817ae`: Adds restricted `svisual -batchx` support. A smoke test already generated a PNG successfully.
- `fe9aaf8`: Fixes Python2 Unicode handling for Chinese user text and prompt content. The LLM request body is now ASCII-escaped JSON bytes.
- `96d1a52` and `200102c`: Add `VM_SESSION_FILE` source-path publishing and the frontend/backend bridge.
- `5e934af`: Shows VM progress/work logs in chat. Do not allow progress spam to evict durable session context.

## 3. Current uncommitted local patch to inspect

At the time this plan was written, the local tree had these files modified:

```text
M apps/server/src/services/vmAgent.ts
M apps/web/src/App.tsx
M packages/shared/src/index.ts
```

This patch is an artifact/session-file attachments passthrough draft. Please inspect and finish it instead of creating a second parallel protocol.

### 3.1 Shared type change

File:

```text
packages/shared/src/index.ts
```

Draft intent:

```ts
export type VmAgentMessage = {
  // existing fields
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

Purpose:

- Provide one stable field for VM run artifacts and VM session files.
- Keep backward compatibility with `meta.vmRunArtifactsJson` and `meta.vmSessionFilesJson`.

Consider adding only if needed:

```ts
isImage?: boolean;
```

Avoid adding permanent raw VM absolute URLs to the shared type. Frontend links should use host backend endpoints.

### 3.2 Backend normalization change

File:

```text
apps/server/src/services/vmAgent.ts
```

Draft intent:

- Add `normalizeAttachments(value)`.
- Add `attachments` to normalized `VmAgentMessage` objects.
- Whitelist attachment fields instead of passing arbitrary JSON through.

Need to verify:

1. Does the embedded VM worker actually write an `attachments` array in `append_message(...)`?
2. If not, extend the worker message creation path to include attachments.
3. For completed runs, convert `result.artifacts` into attachments:
   - `source: "vm-run-artifact"`
   - fields: `runId`, `path`, `name`, `size`, optional `contentType`
4. For materialized session files, convert `generated_session_files` into attachments:
   - `source: "vm-session-file"`
   - fields: `category`, `path`, `name`, `size`, optional `contentType` or `isImage`
5. Keep old meta fields:
   - `meta.vmRunArtifactsJson`
   - `meta.vmSessionFilesJson`
6. Do not expose arbitrary VM absolute paths as public frontend links.

The prompt already has a guardrail: when publishing an existing image, the agent must use the exact artifact path from manifest/session context. It must not invent `gate_zoom.png` when the manifest says `runner_gate_zoom.png` or a different name.

### 3.3 Frontend rendering change

File:

```text
apps/web/src/App.tsx
```

Draft intent:

- `vmArtifactsForMessage(...)` reads `message.attachments` where `source === "vm-run-artifact"`.
- `vmSessionFilesForMessage(...)` reads `message.attachments` where `source === "vm-session-file"`.
- Old meta JSON parsing remains supported.
- `isImage` can be inferred from file extension if absent.

Need to verify:

1. Images show as preview cards or thumbnails, not only raw text paths.
2. If both `attachments` and old `meta.*Json` are present, the UI deduplicates by stable key:
   - run artifact key: `runId + path`
   - session file key: `category + path`
3. Links use existing backend artifact/file endpoints.
4. SVG, PNG, JPG, JPEG, WebP, and GIF are recognized as images.

## 4. Recommended message protocol

The final agent message should support both old meta fields and new attachments:

```json
{
  "id": "agent_...",
  "role": "agent",
  "kind": "message",
  "content": "Simulation completed. The gate zoom image was generated.",
  "meta": {
    "kind": "sentaurus_run",
    "runId": "run_...",
    "vmRunArtifactsJson": "[...]",
    "vmSessionFilesJson": "[...]"
  },
  "attachments": [
    {
      "source": "vm-run-artifact",
      "runId": "run_...",
      "path": "runner_gate_zoom.png",
      "name": "runner_gate_zoom.png",
      "size": 18572,
      "contentType": "image/png"
    },
    {
      "source": "vm-session-file",
      "category": "results",
      "path": "results/runner_gate_zoom.png",
      "name": "runner_gate_zoom.png",
      "size": 18572,
      "contentType": "image/png"
    }
  ]
}
```

Notes:

- `vm-run-artifact.path` should be a run artifact relative path.
- `vm-session-file.path` should be a session output relative path or backend-known path.
- The UI should generate actual download/preview URLs through backend endpoints.
- Do not use CentOS absolute paths as direct browser URLs.

## 5. Failure scenarios to reproduce

### 5.1 PNG exists but chat does not show it

Use a minimal `svisual -batchx` run that generates a PNG, for example `runner_gate_zoom.png`.

Expected result:

- The run manifest contains the PNG artifact.
- The final chat message shows an image preview or file card.
- The session output view shows the PNG under the results category.

If it fails, check:

- VM worker final message JSON: does it contain `meta.vmRunArtifactsJson`?
- VM worker final message JSON: does it contain `attachments`?
- Host backend `normalizeMessages`: does it preserve attachments?
- Frontend `vmArtifactsForMessage`: does it parse the record?
- Preview/download URL: does it return 200 or 404?

### 5.2 Agent invents a wrong file name

Known risk:

```text
Manifest has: runner_gate_zoom.png
Agent says: gate_zoom.png
```

Expected behavior:

- The worker checks file existence before publishing `sourcePath`.
- A missing source path does not create a success attachment.
- The reply states the file was not found and lists available image artifact names.

### 5.3 Python2 Unicode error returns

Repro input example:

```text
Please generate a gate zoom image and send it in the chat. Use Chinese text in the request if needed.
```

Expected behavior:

- No error like: `'ascii' codec can't decode byte 0xe4`.
- The LLM HTTP request body is ASCII-escaped JSON or UTF-8 bytes.
- Chinese user input and category names do not crash `safe_text`, `json.dumps`, stdout, or stderr.

### 5.4 Progress spam evicts useful context

Expected behavior:

- LLM session context does not include large volumes of progress events.
- Durable summary still includes recent run state, artifact names, device goals, calibration context, and older goal-defining user messages.

## 6. Recommended implementation order

1. Run `git status --short` in the local repo.
2. Inspect the three modified files listed in section 3.
3. Confirm or add shared `VmAgentAttachment` fields.
4. Inspect embedded Python `append_message` and final message creation.
5. Add run artifact attachments after `run_with_autodebug(...)` returns.
6. Add session file attachments after `materialize_session_files(...)` succeeds.
7. Keep old meta JSON fields for compatibility.
8. Preserve and whitelist attachments in host backend normalization.
9. Merge and dedupe `meta` plus `attachments` records in frontend.
10. Ensure image preview URLs use backend endpoints, not VM absolute paths.
11. Run typecheck and build.
12. Restart/sync VM worker and run an end-to-end smoke test.

## 7. Validation commands

Run from local repo root:

```bash
cd /home/XiaomiaoClaw/.openclaw/workspace/projects/sentaurus-web-agent
npm run typecheck
npm run build
```

Check status and recent commits:

```bash
git status --short
git log --oneline -12
```

Search relevant fields:

```bash
grep -RIn "attachments\|vmRunArtifactsJson\|vmSessionFilesJson\|vm-run-artifact\|vm-session-file" apps/server/src apps/web/src packages/shared/src/index.ts
```

VM worker restart path used before:

```bash
/home/TCAD2022/.sentaurus-web-agent/vm-agent/vm-agent-autostart.sh restart
```

Use the real host/VM deployment scripts if they differ. Do not add a temporary raw shell runner.

## 8. Acceptance criteria

The change is done only when all of these pass:

- Chinese requests no longer trigger Python2 ASCII/Unicode errors.
- `svisual -batchx` can generate a PNG through the allowlisted runner.
- The PNG appears in the run artifact manifest.
- The PNG can be published via `VM_SESSION_FILE sourcePath` into session output.
- The chat message shows a preview or file card for the PNG.
- The output tile shows files under the existing five product categories.
- Missing file paths produce an honest failure message and list available artifact names.
- `npm run typecheck` passes.
- `npm run build` passes.

## 9. Extra notes

- Do not reset, rebase, or overwrite local work from GitHub. GitHub is behind.
- Do not wait for a GitHub PR flow. Fix locally first, test locally, then sync later.
- Keep commits small and focused.
- Do not commit VM output folders, generated artifacts, `node_modules`, secrets, or local config.
- If the current local patch already solves part of the problem, finish that                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                patch. Do not implement a second artifact protocol.
