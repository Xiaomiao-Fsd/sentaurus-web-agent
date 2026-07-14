# VM worker commands and AGENTS.md

The CentOS VM worker supports session-scoped commands sent through the normal Web composer.

## Commands

- `/goal` shows the current session goal.
- `/goal set <text>` and `/goal <text>` set or replace the goal.
- `/goal complete` marks the current goal completed and removes it from later normal prompts.
- `/goal clear` removes the saved goal.
- `/side <task>` runs the task through the existing sequential worker queue with main conversation history and the active session goal excluded. Side request, progress, and result messages carry `contextScope: "side"` and a `sideTaskId`; those messages remain visible in the Web session but are excluded from later normal prompt history.
- `/help` lists these commands and the existing VM status/tool commands.

Goals are stored at `~/.sentaurus-web-agent/vm-agent/goals.json`. The worker writes this file atomically. An active goal is injected into later normal model prompts for the same Web session.

## Global instructions

The editable global instructions file is:

```text
~/.sentaurus-web-agent/vm-agent/AGENTS.md
```

The worker installer creates it only when missing, so reconnecting or redeploying the worker preserves VM-local edits and `.env` secrets. The worker loads at most 64 KiB of UTF-8 instructions into every normal and `/side` model prompt. Safety rules built into the worker remain authoritative.

Authenticated host endpoints:

```text
GET /api/vm/agent/instructions
PUT /api/vm/agent/instructions
```

The PUT body is `{ "content": "..." }`. There is no user-controlled path. The SSH-side operation always targets the fixed VM agent root, rejects symbolic links, validates UTF-8 and size, and uses an atomic replacement.

## Verification

Run the focused suite and the full build from the repository root:

```powershell
npm run test:codex-features
npm run build
```

`POST /api/vm/agent/connect` is the established deployment path. It rewrites the generated worker files, creates `AGENTS.md` only if absent, preserves VM `.env`/config files, and restarts only the VM worker.
