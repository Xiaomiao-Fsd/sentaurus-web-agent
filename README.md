# Sentaurus Web Agent

Browser-based message console for a Sentaurus TCAD agent running inside a CentOS VM.

The first version focuses on the essentials:

- React/TypeScript web UI
- Node/Fastify backend
- Browser-only message send/receive UI; LLM credentials stay inside the VM
- SSH health check to the Sentaurus VM (`sentaurus-centos7`)
- VM-local Python agent worker with safe Sentaurus status/tool skills and an allowlisted Sentaurus runner
- Safe per-run directory scaffolding
- Placeholder host-side run API with real SDE/SDevice execution still gated behind `ENABLE_REAL_JOBS=1`
- No secrets committed to the repository

## Repository access from the Windows host

This repo is intended to be modified later by host-side Codex.

```powershell
# one-time on Windows host, if GitHub CLI is not logged in yet
gh auth login

# clone
git clone https://github.com/Xiaomiao-Fsd/sentaurus-web-agent.git
cd sentaurus-web-agent
```

If you prefer SSH remotes, configure your Windows GitHub SSH key and switch the remote manually.

## Quick start on the Windows host

Double-click:

```text
start-dev.bat
```

Or run manually:

```powershell
npm install
Copy-Item .env.example .env
notepad .env
npm run dev
```

Open:

- Web UI (IPv6 loopback): <http://[::1]:5174>
- Web UI bind address: `[::]:5174`
- Backend health: <http://10.6.22.1:5175/api/health>

The web UI asks for the `AUTH_TOKEN` from `.env` before calling protected APIs.
Any non-loopback `HOST` requires a non-default `AUTH_TOKEN` with at least 24 characters; the server refuses to start otherwise.

## Stable local run root and migration

Relative `LOCAL_RUN_BASE` values are resolved from the repository root, not the process launch directory. The default canonical run root is:

```text
data/runs
```

Before switching an existing launcher, inventory both the canonical root and the legacy workspace root:

```powershell
npm run migrate:runs:dry-run
```

Apply the non-destructive merge after reviewing the JSON report:

```powershell
npm run migrate:runs
```

The migration validates each manifest ID, hashes every file, copies only unique run IDs through a staging directory, rewrites only the copied manifest's `localDir`, and never overwrites a conflicting duplicate. The legacy roots remain unchanged for rollback.

## Configure the VM-local LLM provider

The independently deployable worker source and upgrade installer live in [`vm-worker/`](vm-worker/README.md).
Release archives include both the Windows Web application and this CentOS worker component.

The host `.env` does not need LLM credentials for the VM Agent panel. The backend only relays messages over SSH.

Click **Start VM agent** once, or run any `/api/vm/agent/*` call, to create the VM-side directory:

```text
~/.sentaurus-web-agent/vm-agent
```

Then put the OpenAI-compatible values inside the CentOS VM, not in the web repo:

```env
~/.sentaurus-web-agent/vm-agent/.env

LLM_API_BASE=https://your-openai-compatible-base/v1
LLM_API_KEY=your-real-key
LLM_MODEL=gpt-5.5
LLM_MODELS=gpt-5.5,gpt-5.4
LLM_API_STYLE=chat-completions # or openai-responses
```

`LLM_MODEL` is the primary model. `LLM_MODELS` is an optional comma-separated fallback list that is tried entirely inside the CentOS VM, so the VM agent can keep running independently when one provider channel returns 503.

The agent also writes `config.example.json` and `.env.example` in that VM directory. Do not copy real keys back to the host repo.

Optional Sentaurus manuals or converted reference notes can be placed in VM-local text formats under:

```text
~/.sentaurus-web-agent/vm-agent/manuals
```

Supported extensions include `.txt`, `.md`, `.rst`, `.cmd`, `.des`, `.par`, `.scm`, and `.sde`. The VM worker reads excerpts from this directory into its system context so it can better understand Sentaurus deck syntax, job setup, and result extraction without depending on host-side files.

## Configure Sentaurus VM SSH from Windows host

The backend calls `ssh` using `SENTAURUS_SSH_TARGET`.

Recommended Windows OpenSSH config file:

```text
# C:\Users\<you>\.ssh\config
Host sentaurus-centos7
  HostName 192.168.134.132
  User TCAD2022
  IdentityFile C:\Users\<you>\.ssh\sentaurus_vm_ed25519
```

Then test in PowerShell:

```powershell
ssh sentaurus-centos7 "hostname; whoami; command -v sde; command -v sdevice"
```

If that works, the web backend `/api/vm/status` should work too.

## VM-local allowlisted Sentaurus runner

The CentOS worker can run real Sentaurus jobs without exposing arbitrary shell access. When the VM-local LLM decides a request is ready to execute, it emits one structured block:

```xml
<SENTAURUS_RUN_REQUEST>
{
  "title": "sde-smoke-test",
  "files": [
    { "name": "smoke.cmd", "content": "(sde:clear)\n" }
  ],
  "steps": [
    { "tool": "sde", "input": "smoke.cmd" }
  ]
}
</SENTAURUS_RUN_REQUEST>
```

The worker strips that private control block from the chat reply, writes files under:

```text
~/STDB/web-agent-runs/run_<timestamp>_<slug>_<id>/
```

and executes only these allowlisted tool forms:

- `sde -e -l <file>`
- `sprocess -b <file>`
- `sdevice <file>`
- `inspect -batch -f <file>`

Run files must use safe ASCII basenames and one of `.cmd`, `.des`, `.par`, `.scm`, `.tcl`, `.txt`, or `.dat`. Arbitrary shell commands, hidden files, path traversal, and unsupported extensions are rejected. The final chat message includes the VM run directory, each step's exit code, and generated log/artifact file names. A smoke test on CentOS has verified `sde` execution through this path.

## Development commands

```bash
npm install
npm run dev
npm run typecheck
npm run build
```

## Safety model

- `.env` and key files are ignored.
- Host-side `/api/runs/:id/jobs` execution is disabled by default. VM-chat execution is available only through the VM-local `<SENTAURUS_RUN_REQUEST>` allowlist.
- The backend generates run IDs and directories; users cannot submit arbitrary paths.
- The SSH bridge is centralized in `apps/server/src/services/sshClient.ts`.
- Long-running/destructive actions should require UI confirmation before being enabled.

## Current MVP status

Implemented:

- Web dashboard shell
- VM Agent message panel; browser sends/receives messages only
- VM status panel wired to `/api/vm/status`
- VM Agent panel wired to an SSH-backed `/api/vm/agent/*` bridge
- VM-side agent worker at `~/.sentaurus-web-agent/vm-agent/agent_worker.py`
- VM-local LLM config via `~/.sentaurus-web-agent/vm-agent/.env` or `config.json`
- Safe Sentaurus skills: VM status, tool discovery, agent instance listing, VM-local manual excerpts, and `<SENTAURUS_RUN_REQUEST>` allowlisted execution
- Run creation/listing API
- Run detail view
- Run input upload and input/artifact download APIs
- Basic SSE job-log stream
- Remote run preparation endpoint, still gated by `ENABLE_REAL_JOBS`
- VM-local Sentaurus runner for LLM-generated run requests: `sde`, `sprocess`, `sdevice`, and `inspect` allowlisted steps
- Local run directories
- Documentation for Windows host and Sentaurus SSH setup

## Run lifecycle APIs

Protected by `AUTH_TOKEN`:

```text
GET  /api/runs
POST /api/runs
GET  /api/runs/:id
POST /api/runs/:id/files
GET  /api/runs/:id/files
GET  /api/runs/:id/files/:name
GET  /api/runs/:id/artifacts
GET  /api/runs/:id/artifacts/:name
POST /api/runs/:id/prepare-remote
POST /api/runs/:id/jobs
POST /api/runs/:id/cancel
GET  /api/runs/:id/logs/stream
GET  /api/vm/agent/status
POST /api/vm/agent/connect
GET  /api/vm/agent/messages
POST /api/vm/agent/messages
GET  /api/vm/agent/messages/stream
```

Current behavior:

- The host backend only relays messages over SSH. `POST /api/vm/agent/messages` writes to a VM-local queue; the CentOS worker reads that queue, calls the VM-local LLM config when present, uses safe Sentaurus skills, and writes responses back to `messages.jsonl`.
- VM-local status/tool skills are intentionally slash-command only (`/status`, `/skill`, `/tools`, `/instance`, `/instances`, `/sentaurus-status`) so ordinary Chinese prompts containing words such as “状态” or “仿真” still go through the LLM/runner path.
- If VM-local LLM config is missing, the worker still runs and can answer safe Sentaurus status/tool/instance requests without exposing secrets.
- The legacy host-side `/api/chat` route is disabled so the host backend does not call an LLM directly.
- Uploaded files are written only to the run's `input/` directory.
- File names are validated; path traversal and hidden-path style names are rejected.
- Browser-facing run summaries hide `localDir` to avoid exposing backend absolute paths.
- `prepare-remote` writes diagnostic lines to `logs/prepare-remote.log` and `logs/job.log`.
- Host-side `POST /api/runs/:id/jobs` is still intentionally disabled/not implemented.
- `ENABLE_REAL_JOBS=0` keeps host-side execution paths blocked.
- VM Agent chat can execute only through `<SENTAURUS_RUN_REQUEST>`; no raw shell is accepted.

Next recommended steps:

1. Add remote input sync from local run `input/` to `SENTAURUS_REMOTE_BASE/<run-id>/input/` for the legacy host run API.
2. Implement host-side `/api/runs/:id/jobs` as a wrapper around the same allowlist, or remove the unused endpoint.
3. Add result artifact pullback/download helpers for VM-local run directories.
4. Add parsers/plotters for `.plt`/`.tdr` outputs and extracted metrics.
5. Add authentication suitable for non-localhost deployment.
