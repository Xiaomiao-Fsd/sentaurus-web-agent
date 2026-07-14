# Sentaurus Codex Coordination Manifest

Repo: E:\VSCode\Sentaurus-agent
Coordinator: MiaoBOT / main assistant
Created under: Windows host user sshdev

## Sessions

- sentaurus-planner: planning, architecture, backlog, acceptance criteria. No production code edits.
- sentaurus-implementer: implementation only. This is the only session allowed to edit production code after coordinator approval.
- sentaurus-reviewer-debugger: review, tests, acceptance, debugging guidance. No production code edits unless explicitly authorized.
- sentaurus-vm-bridge-auditor: VM worker / bridge / SSH / network / environment-variable audit. Read-only; no secrets printed.

## Operating Rules

1. Main assistant coordinates all sessions and assigns tasks.
2. Planner produces task specs before implementation.
3. Implementer changes code only from approved specs.
4. Reviewer-debugger validates implementation before handoff.
5. VM auditor checks host/backend/VM worker connection details separately from application implementation.
6. No session commits git unless the coordinator explicitly asks.
