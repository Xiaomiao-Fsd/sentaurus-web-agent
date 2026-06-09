# Sentaurus VM Setup

The existing OpenClaw side uses the SSH alias:

```bash
ssh sentaurus-centos7
```

For the Windows-host backend, create the same alias in Windows OpenSSH:

```text
Host sentaurus-centos7
  HostName 192.168.134.132
  User TCAD2022
  IdentityFile C:\Users\<you>\.ssh\sentaurus_vm_ed25519
```

Then verify:

```powershell
ssh sentaurus-centos7 "hostname; whoami; command -v sde; command -v sdevice"
```

If the Sentaurus VM IP changes, update `HostName` or set `SENTAURUS_SSH_TARGET=TCAD2022@<new-ip>` in `.env`.
