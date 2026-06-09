# Architecture

```text
Browser UI
  ├─ Chat panel
  ├─ Sentaurus VM status card
  └─ Run manager / detail panel
        ↓ HTTP + SSE log stream
Node/Fastify backend
  ├─ Auth middleware
  ├─ OpenAI-compatible LLM client
  ├─ Run store
  ├─ Run file manager
  ├─ Sentaurus runner facade
  └─ SSH bridge
        ↓ ssh sentaurus-centos7
CentOS Sentaurus VM
  ├─ sde
  ├─ sdevice
  └─ per-run directories under SENTAURUS_REMOTE_BASE
```

The backend should be the only component that can reach the Sentaurus VM. The browser never receives SSH keys or raw shell access.
