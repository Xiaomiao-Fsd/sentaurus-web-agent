# Sentaurus VM Agent SSH Permission Denied 修复方案

## 1. 当前最新结论

当前 Web backend 已经在线，SSH alias 解析问题也已经修复。

但 backend 仍未连上 VM agent，新的失败点是 SSH 认证失败：

```text
Permission denied (publickey,gssapi-keyex,gssapi-with-mic,password)
```

也就是说，问题已经从：

```text
Could not resolve hostname sentaurus-centos7
```

推进到：

```text
sentaurus-centos7 可以解析到 VM，但宿主机私钥没有通过 VM 用户认证
```

## 2. 已确认状态

后端健康接口正常：

```powershell
curl http://10.6.22.1:5175/api/health
```

返回：

```json
{"ok":true,"service":"sentaurus-web-agent"}
```

SSH alias 当前已生效：

```powershell
ssh -G sentaurus-centos7 | Select-String -Pattern '^(hostname|user|identityfile|identitiesonly|port) '
```

当前解析结果：

```text
user TCAD2022
hostname 192.168.134.133
port 22
identitiesonly yes
identityfile C:\Users\sshdev\.ssh\sentaurus_vm_ed25519
```

说明：

- `sentaurus-centos7` 已正确指向 `192.168.134.133`
- SSH 用户是 `TCAD2022`
- 后端将使用 `C:\Users\sshdev\.ssh\sentaurus_vm_ed25519`
- 现在失败点是该私钥不能登录 VM

后端 VM agent 状态接口当前返回：

```json
{
  "ok": false,
  "connected": false,
  "sshTarget": "sentaurus-centos7",
  "error": "TCAD2022@192.168.134.133: Permission denied (publickey,gssapi-keyex,gssapi-with-mic,password)."
}
```

VM 状态接口也同样失败：

```json
{
  "ok": false,
  "sshTarget": "sentaurus-centos7",
  "error": "TCAD2022@192.168.134.133: Permission denied (publickey,gssapi-keyex,gssapi-with-mic,password)."
}
```

## 3. 根因判断

项目后端使用本机 OpenSSH 调用 VM：

```text
apps/server/src/services/sshClient.ts
```

关键参数：

```ts
"-o", "BatchMode=yes"
```

因此后端不会进行交互式密码输入。要让 Web backend 连接 VM，必须满足：

1. Windows 宿主机存在私钥：

   ```text
   C:\Users\sshdev\.ssh\sentaurus_vm_ed25519
   ```

2. 该私钥对应的公钥已加入 VM 用户：

   ```text
   /home/TCAD2022/.ssh/authorized_keys
   ```

3. VM 侧 `.ssh` 目录和 `authorized_keys` 权限正确。

当前 `Permission denied` 说明至少有一项不满足。

## 4. 推荐修复方案

优先修复 SSH 免密登录，不修改 Web 代码。

### 4.1 检查宿主机私钥是否存在

在 Windows PowerShell 执行：

```powershell
Test-Path C:\Users\sshdev\.ssh\sentaurus_vm_ed25519
Test-Path C:\Users\sshdev\.ssh\sentaurus_vm_ed25519.pub
```

如果私钥不存在，生成一对新的 key：

```powershell
ssh-keygen -t ed25519 -f C:\Users\sshdev\.ssh\sentaurus_vm_ed25519 -C sentaurus-web-agent
```

生成后确认：

```powershell
Get-ChildItem C:\Users\sshdev\.ssh\sentaurus_vm_ed25519*
```

### 4.2 查看公钥内容

```powershell
Get-Content C:\Users\sshdev\.ssh\sentaurus_vm_ed25519.pub
```

输出应类似：

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... sentaurus-web-agent
```

后续需要把这一整行加入 CentOS7 VM 的：

```text
/home/TCAD2022/.ssh/authorized_keys
```

## 5. 将公钥安装到 VM

由于当前 SSH 免密失败，下游 agent 需要根据实际可用通道选择一种方式。

### 方式 A：通过 VM 控制台登录

如果可以直接打开 CentOS7 VM 控制台，使用 `TCAD2022` 登录后执行：

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
cat >> ~/.ssh/authorized_keys <<'EOF'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... sentaurus-web-agent
EOF
chmod 600 ~/.ssh/authorized_keys
```

如果系统启用了 SELinux，继续执行：

```bash
restorecon -Rv ~/.ssh 2>/dev/null || true
```

确认属主：

```bash
ls -ld ~/.ssh
ls -l ~/.ssh/authorized_keys
```

预期：

```text
drwx------  TCAD2022 TCAD2022 .ssh
-rw-------  TCAD2022 TCAD2022 authorized_keys
```

如果属主不对，用 root 执行：

```bash
chown -R TCAD2022:TCAD2022 /home/TCAD2022/.ssh
```

### 方式 B：如果密码 SSH 可用

如果允许交互式密码登录，可以在 Windows 宿主机执行：

```powershell
type C:\Users\sshdev\.ssh\sentaurus_vm_ed25519.pub | ssh TCAD2022@192.168.134.133 "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"
```

然后进入 VM 修正权限：

```powershell
ssh TCAD2022@192.168.134.133 "chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys; restorecon -Rv ~/.ssh 2>/dev/null || true"
```

注意：这种方式可能会提示输入 `TCAD2022` 的密码。后端不支持这种交互，但人工安装公钥时可以使用。

### 方式 C：使用已有正确私钥

如果用户已有另一把可以登录 VM 的私钥，不要重新生成 key。直接修改：

```text
C:\Users\sshdev\.ssh\config
```

将：

```sshconfig
IdentityFile C:\Users\sshdev\.ssh\sentaurus_vm_ed25519
```

改成真实可用私钥路径，例如：

```sshconfig
IdentityFile C:\Users\sshdev\.ssh\id_ed25519
```

然后重新验证。

## 6. 验证 SSH 免密登录

安装或修正公钥后，在 Windows PowerShell 执行：

```powershell
ssh -o BatchMode=yes sentaurus-centos7 "hostname; whoami; hostname -I"
```

预期输出：

```text
<centos-hostname>
TCAD2022
192.168.134.133 ...
```

如果仍失败，执行详细调试：

```powershell
ssh -vvv -o BatchMode=yes sentaurus-centos7 "whoami"
```

重点看：

```text
Offering public key: C:\Users\sshdev\.ssh\sentaurus_vm_ed25519
Server accepts key
```

如果只看到 `Offering public key`，但没有 `Server accepts key`，说明 VM 的 `authorized_keys` 没有对应公钥，或 VM 侧权限/SELinux 阻止了读取。

## 7. 验证 VM agent worker

SSH 免密成功后，先检查 VM agent 目录：

```powershell
ssh sentaurus-centos7 "ls -la ~/.sentaurus-web-agent/vm-agent"
```

检查 worker 进程：

```powershell
ssh sentaurus-centos7 "ps -ef | grep agent_worker.py | grep -v grep || true"
```

如果 worker 没跑，可以通过 Web backend 的 connect 接口启动，或在 VM 内手动启动。

优先使用后端接口启动：

```powershell
$envPath = "E:\VSCode\Sentaurus-agent\.env"
$token = (Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^AUTH_TOKEN=' } | Select-Object -First 1) -replace '^AUTH_TOKEN=',''
curl -X POST -H "Authorization: Bearer $token" http://10.6.22.1:5175/api/vm/agent/connect
```

## 8. 验证后端接口

读取 token：

```powershell
$envPath = "E:\VSCode\Sentaurus-agent\.env"
$token = (Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^AUTH_TOKEN=' } | Select-Object -First 1) -replace '^AUTH_TOKEN=',''
```

验证 VM 状态：

```powershell
curl -H "Authorization: Bearer $token" http://10.6.22.1:5175/api/vm/status
```

预期关键字段：

```json
{
  "ok": true,
  "sshTarget": "sentaurus-centos7",
  "user": "TCAD2022"
}
```

验证 VM agent 状态：

```powershell
curl -H "Authorization: Bearer $token" http://10.6.22.1:5175/api/vm/agent/status
```

预期关键字段：

```json
{
  "ok": true,
  "connected": true,
  "workerRunning": true
}
```

如果返回 `connected:true` 但 `workerRunning:false`，说明 SSH 通道已修复，但 worker 没启动。此时调用：

```powershell
curl -X POST -H "Authorization: Bearer $token" http://10.6.22.1:5175/api/vm/agent/connect
```

然后再次请求 status。

## 9. 是否需要重启 Web backend

如果只修改了：

```text
C:\Users\sshdev\.ssh\config
C:\Users\sshdev\.ssh\sentaurus_vm_ed25519
VM authorized_keys
```

通常不需要重启 backend，因为后端每次请求都会重新调用系统 `ssh`。

如果修改了：

```text
E:\VSCode\Sentaurus-agent\.env
```

则需要重启 Web backend：

```powershell
cd E:\VSCode\Sentaurus-agent
npm run dev
```

或只重启后端：

```powershell
npm run dev:server
```

## 10. Web UI 最终验收

打开：

```text
http://10.6.22.1:5174
```

确认顶部状态：

```text
VM Online
Agent Running
```

如果接口已正常但 UI 仍异常，检查浏览器保存的 token 是否和 `.env` 一致：

```text
localStorage key: sentaurus_auth_token
```

## 11. 本阶段不建议修改的内容

本阶段不需要改 Web 前端或后端业务代码。

不建议优先修改：

```text
apps/web/src/api/client.ts
apps/web/src/app/TopStatusBar.tsx
apps/server/src/services/vmAgent.ts
apps/server/src/services/vmStatus.ts
apps/server/src/services/sshClient.ts
```

当前故障点已经明确是 SSH 认证：

```text
Permission denied
```

修复重点应放在：

```text
C:\Users\sshdev\.ssh\config
C:\Users\sshdev\.ssh\sentaurus_vm_ed25519
/home/TCAD2022/.ssh/authorized_keys
```

## 12. 下游 agent 交付标准

修复完成后，下游 agent 应提供以下结果：

1. `ssh -o BatchMode=yes sentaurus-centos7 "hostname; whoami; hostname -I"` 的关键输出
2. `/api/vm/status` 返回的 `ok`、`sshTarget`、`user`
3. `/api/vm/agent/status` 返回的 `ok`、`connected`、`workerRunning`
4. Web UI 顶部是否显示 `VM Online` 与 `Agent Running`
