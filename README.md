# Sentaurus Web Agent

Browser-based dashboard/chat for controlling a Sentaurus TCAD workflow through a safe backend bridge.

The first version focuses on the essentials:

- React/TypeScript web UI
- Node/Fastify backend
- OpenAI-compatible LLM configuration matching a VSCode Continue-style provider
- SSH health check to the Sentaurus VM (`sentaurus-centos7`)
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

## Configure the VSCode Continue-compatible LLM provider

Put the same OpenAI-compatible values you use for Continue into `.env`:

```env
LLM_API_BASE=https://your-openai-compatible-base/v1
LLM_API_KEY=your-real-key
LLM_MODEL=gpt-5.5
```

Do **not** commit `.env`.

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
- Chat panel wired to `/api/chat`
- VM status panel wired to `/api/vm/status`
- Run creation/listing API
- Local run directories
- LLM chat call through OpenAI-compatible `/chat/completions`
- Documentation for Windows host and Sentaurus SSH setup

Next recommended steps:

1. Add file upload/download per run.
2. Implement SDE/SDevice job queue and SSE log streaming.
3. Add result artifact parser for `.plt`/`.tdr` outputs.
4. Connect a stricter tool-calling agent loop.
5. Add authentication suitable for non-localhost deployment.
