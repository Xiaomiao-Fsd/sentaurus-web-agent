# Architecture

```text
Browser UI
  ├─ Chat panel
  ├─ Sentaurus VM status card
  └─ Run/session manager
        ↓ HTTP + SSE log stream
Node/Fastify backend
  ├─ Auth middleware
  ├─ Disabled legacy host-side LLM client
  ├─ Run store
  ├─ Run file manager
  ├─ Sentaurus runner facade
  └─ SSH bridge
        ↓ ssh sentaurus-centos7
CentOS Sentaurus VM
  ├─ VM-local Python worker
  ├─ VM-local LLM credentials/config
  ├─ <SENTAURUS_RUN_REQUEST> parser
  ├─ Allowlisted Sentaurus runner
  ├─ sde
  ├─ sdevice
  ├─ sprocess / inspect
  └─ per-run directories under ~/STDB/web-agent-runs
```

The browser never receives SSH keys, LLM credentials, or raw shell access. The backend only relays VM-agent messages over SSH. Real execution from chat happens inside the CentOS worker by parsing a structured `<SENTAURUS_RUN_REQUEST>` JSON block and mapping it to fixed argv forms such as `sde -e -l <file>` or `sdevice <file>`.
