# Sentaurus Web Agent

Browser-based message console for a Sentaurus TCAD agent running inside a CentOS VM.

The first version focuses on the essentials:

- React/TypeScript web UI
- Node/Fastify backend
- Browser-only message send/receive UI; LLM credentials stay inside the VM
- SSH health check to the Sentaurus VM (`sentaurus-centos7`)
- VM-local Python agent worker with safe Sentaurus status/tool skills
- Safe per-run directory scaffolding
- Placeholder run API with real SDE/SDevice execution gated behind `ENABLE_REAL_JOBS=1`
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

```powershell
npm install
Copy-Item .env.example .env
notepad .env
npm run dev
```

Open:

- Web UI: <http://localhost:5174>
- Backend health: <http://localhost:5175/api/health>

The web UI asks for the `AUTH_TOKEN` from `.env` before calling protected APIs.

## Configure the VM-local LLM provider

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
```

The agent also writes `config.example.json` and `.env.example` in that VM directory. Do not copy real keys back to the host repo.

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

## Development commands

```bash
npm install
npm run dev
npm run typecheck
npm run build
```

## Safety model

- `.env` and key files are ignored.
- Real SDE/SDevice execution is disabled by default.
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
- Safe read-only Sentaurus skills: VM status, tool discovery, agent instance listing
- Run creation/listing API
- Run detail view
- Run input upload and input/artifact download APIs
- Basic SSE job-log stream
- Remote run preparation endpoint, still gated by `ENABLE_REAL_JOBS`
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
- If VM-local LLM config is missing, the worker still runs and can answer safe Sentaurus status/tool/instance requests without exposing secrets.
- The legacy host-side `/api/chat` route is disabled so the host backend does not call an LLM directly.
- Uploaded files are written only to the run's `input/` directory.
- File names are validated; path traversal and hidden-path style names are rejected.
- Browser-facing run summaries hide `localDir` to avoid exposing backend absolute paths.
- `prepare-remote` writes diagnostic lines to `logs/prepare-remote.log` and `logs/job.log`.
- Real Sentaurus job submission is still intentionally disabled/not implemented.
- `ENABLE_REAL_JOBS=0` keeps true execution paths blocked.

Next recommended steps:

1. Add remote input sync from local run `input/` to `SENTAURUS_REMOTE_BASE/<run-id>/input/`.
2. Implement an allowlisted SDE/SDevice job queue.
3. Add result artifact pullback and parser for `.plt`/`.tdr` outputs.
4. Extend the VM worker from read-only Sentaurus skills to an allowlisted job runner.
5. Add authentication suitable for non-localhost deployment.
