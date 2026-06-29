# Sentaurus Web VM Agent Offline 修复交接方案

## 1. 背景与目标

当前用户已经启动了：

- Windows 宿主机上的 Web frontend
- Windows 宿主机上的 Web backend
- CentOS7 VM 内的 Sentaurus 本体
- CentOS7 VM 内的 VM agent worker

但 Web 前端仍显示 VM/Agent offline。

本方案给下游 agent 执行修复使用。目标是让：

- Web 顶部 VM 状态显示 `VM Online`
- Web 顶部 Agent 状态显示 `Agent Running`
- `/api/vm/status` 正常返回 `ok:true`
- `/api/vm/agent/status` 正常返回 `connected:true`、`workerRunning:true`

## 2. 已确认现象

项目路径：

```text
E:\VSCode\Sentaurus-agent
```

后端健康接口正常：

```powershell
curl http://10.6.22.1:5175/api/health
```

已确认返回：

```json
{"ok":true,"service":"sentaurus-web-agent"}
```

当前 `.env` 中配置为：

```env
SENTAURUS_SSH_TARGET=sentaurus-centos7
```

但宿主机没有配置该 SSH alias：

```text
C:\Users\sshdev\.ssh\config 不存在
```

当前 `C:\Users\sshdev\.ssh` 中只看到：

```text
authorized_keys
```

没有看到：

```text
config
sentaurus_vm_ed25519
id_ed25519
id_rsa
```

后端接口当前错误为：

```text
ssh: Could not resolve hostname sentaurus-centos7
```

受影响接口：

```text
GET /api/vm/status
GET /api/vm/agent/status
```

宿主机到 VM 的 22 端口可达：

```powershell
Test-NetConnection -ComputerName 192.168.134.133 -Port 22
```

结果显示：

```text
TcpTestSucceeded : True
```

因此优先判断为：VM 和 SSH 服务在线，但 Windows 宿主机的 OpenSSH 目标配置缺失。

## 3. 根因说明

后端通过本机 OpenSSH 执行 SSH：

```text
apps/server/src/services/sshClient.ts
```

关键逻辑：

```ts
execa("ssh", [
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  config.SENTAURUS_SSH_TARGET,
  remoteCommand
])
```

后端配置读取位置：

```text
apps/server/src/config.ts
```

默认值：

```ts
SENTAURUS_SSH_TARGET: z.string().default("sentaurus-centos7")
```

也就是说，Web backend 不直接知道 VM IP 和账号，它只调用：

```powershell
ssh sentaurus-centos7 ...
```

当前宿主机没有 `sentaurus-centos7` alias，导致 hostname 无法解析。由于 SSH 参数包含 `BatchMode=yes`，后端也不能使用交互式密码登录，必须配置可用的免密 SSH。

## 4. 推荐修复方案

优先采用方案 A：配置 Windows 宿主机 OpenSSH alias。

### 4.1 创建 SSH config

创建或编辑：

```text
C:\Users\sshdev\.ssh\config
```

写入：

```sshconfig
Host sentaurus-centos7
  HostName 192.168.134.133
  User TCAD2022
  IdentityFile C:\Users\sshdev\.ssh\sentaurus_vm_ed25519
  IdentitiesOnly yes
```

注意：

- `HostName` 使用当前已确认的 VM IP：`192.168.134.133`
- `User` 使用当前文档和项目约定的 VM 用户：`TCAD2022`
- `IdentityFile` 路径必须指向宿主机真实存在的私钥

### 4.2 准备 SSH 私钥

检查私钥是否存在：

```powershell
Test-Path C:\Users\sshdev\.ssh\sentaurus_vm_ed25519
```

如果返回 `True`，继续验证 SSH。

如果返回 `False`，下游 agent 需要完成以下二选一：

1. 找到已有可登录 CentOS7 VM 的私钥，并将 `IdentityFile` 改成真实私钥路径。
2. 生成新 key，并把公钥加入 CentOS7 VM 用户 `TCAD2022` 的 `~/.ssh/authorized_keys`。

生成新 key 示例：

```powershell
ssh-keygen -t ed25519 -f C:\Users\sshdev\.ssh\sentaurus_vm_ed25519 -C sentaurus-web-agent
```

然后需要把以下公钥内容安装到 VM：

```powershell
Get-Content C:\Users\sshdev\.ssh\sentaurus_vm_ed25519.pub
```

目标位置：

```text
/home/TCAD2022/.ssh/authorized_keys
```

如果没有现成的密码登录、控制台登录或其它通道可以写入 VM 的 `authorized_keys`，该步骤需要用户提供 VM 登录凭据或手动在 VM 控制台执行。

### 4.3 验证 SSH alias

在 Windows 宿主机 PowerShell 执行：

```powershell
ssh sentaurus-centos7 "hostname; whoami; hostname -I"
```

预期输出类似：

```text
<centos-hostname>
TCAD2022
192.168.134.133 ...
```

再验证 VM agent worker：

```powershell
ssh sentaurus-centos7 "/home/TCAD2022/.sentaurus-web-agent/vm-agent/vm-agent-autostart.sh status"
```

预期包含：

```text
running pid=<pid>
```

如果该脚本不存在，但 Web agent 的 SSH 状态已正常，下游 agent 应进入 VM 检查实际 worker 目录：

```powershell
ssh sentaurus-centos7 "ls -la ~/.sentaurus-web-agent/vm-agent; ps -ef | grep agent_worker.py | grep -v grep"
```

## 5. 备选修复方案

如果不想使用 SSH alias，可以直接修改宿主机项目 `.env`：

```text
E:\VSCode\Sentaurus-agent\.env
```

将：

```env
SENTAURUS_SSH_TARGET=sentaurus-centos7
```

改为：

```env
SENTAURUS_SSH_TARGET=TCAD2022@192.168.134.133
```

但该方案仍要求 OpenSSH 能自动找到正确私钥。当前宿主机没有默认私钥文件，因此除非私钥位于 OpenSSH 默认路径，否则仍建议使用方案 A，通过 `C:\Users\sshdev\.ssh\config` 显式指定 `IdentityFile`。

## 6. 前端 API 地址检查

md 原始建议中提到前端可能硬编码 `localhost:5175`。当前源码已检查：

```text
apps/web/src/api/client.ts
```

当前默认值为：

```ts
export const API_BASE = import.meta.env.VITE_API_BASE || "http://10.6.22.1:5175";
```

因此这不是当前 offline 的主因。

仍建议启动前端时确保没有环境变量覆盖到错误地址：

```powershell
$env:VITE_API_BASE="http://10.6.22.1:5175"
npm run dev:web
```

如果前后端一起启动：

```powershell
$env:VITE_API_BASE="http://10.6.22.1:5175"
npm run dev
```

## 7. 重启服务

修改 SSH config 或 `.env` 后，重启 Web backend。推荐直接重启整个 dev 服务：

```powershell
cd E:\VSCode\Sentaurus-agent
npm run dev
```

如果前后端分开启动：

```powershell
npm run dev:server
npm run dev:web
```

## 8. 验收命令

从 `.env` 中读取 `AUTH_TOKEN`，然后请求受保护接口。

PowerShell 示例：

```powershell
$envPath = "E:\VSCode\Sentaurus-agent\.env"
$token = (Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^AUTH_TOKEN=' } | Select-Object -First 1) -replace '^AUTH_TOKEN=',''
```

### 8.1 验证后端健康

```powershell
curl http://10.6.22.1:5175/api/health
```

预期：

```json
{"ok":true,"service":"sentaurus-web-agent"}
```

### 8.2 验证 VM 状态

```powershell
curl -H "Authorization: Bearer $token" http://10.6.22.1:5175/api/vm/status
```

预期重点字段：

```json
{
  "ok": true,
  "sshTarget": "sentaurus-centos7",
  "user": "TCAD2022"
}
```

### 8.3 验证 VM agent 状态

```powershell
curl -H "Authorization: Bearer $token" http://10.6.22.1:5175/api/vm/agent/status
```

预期重点字段：

```json
{
  "ok": true,
  "connected": true,
  "workerRunning": true
}
```

## 9. Web UI 验收

打开：

```text
http://10.6.22.1:5174
```

确认：

```text
VM Online
Agent Running
LLM Configured 或 LLM Pending
```

如果页面仍显示 offline，优先检查浏览器本地保存的 `AUTH_TOKEN` 是否和 `.env` 一致。前端 token 存储 key 为：

```text
sentaurus_auth_token
```

相关源码：

```text
apps/web/src/api/client.ts
```

## 10. 常见失败分支

### 10.1 仍然提示 Could not resolve hostname

说明 `C:\Users\sshdev\.ssh\config` 没有生效，检查：

```powershell
ssh -G sentaurus-centos7 | Select-String -Pattern '^(hostname|user|identityfile|identitiesonly|port) '
```

预期包含：

```text
hostname 192.168.134.133
user TCAD2022
identityfile C:/Users/sshdev/.ssh/sentaurus_vm_ed25519
identitiesonly yes
```

### 10.2 提示 Permission denied

说明 alias 已生效，但私钥不对或 VM 未安装对应公钥。处理：

- 确认 `IdentityFile` 指向正确私钥
- 确认公钥在 VM 的 `/home/TCAD2022/.ssh/authorized_keys`
- 确认 VM 侧权限：

```bash
chmod 700 /home/TCAD2022/.ssh
chmod 600 /home/TCAD2022/.ssh/authorized_keys
chown -R TCAD2022:TCAD2022 /home/TCAD2022/.ssh
```

### 10.3 SSH 通，但 `/api/vm/agent/status` 显示 workerRunning false

说明 SSH 通道已修好，但 VM worker 没跑。执行：

```powershell
ssh sentaurus-centos7 "cd ~/.sentaurus-web-agent/vm-agent && python agent_worker.py >/tmp/sentaurus-vm-agent.log 2>&1 &"
```

然后再次验证：

```powershell
curl -H "Authorization: Bearer $token" http://10.6.22.1:5175/api/vm/agent/status
```

### 10.4 浏览器请求 401

说明 Web UI 保存的 token 和后端 `.env` 中 `AUTH_TOKEN` 不一致。处理：

- 在 Web UI 重新输入 `.env` 中的 `AUTH_TOKEN`
- 或清理浏览器 localStorage 中的 `sentaurus_auth_token`

## 11. 不建议改动的部分

本问题不需要优先修改以下代码：

- `apps/web/src/app/TopStatusBar.tsx`
- `apps/web/src/api/client.ts`
- `apps/server/src/routes/vm.ts`
- `apps/server/src/routes/vmAgent.ts`
- `apps/server/src/services/vmStatus.ts`
- `apps/server/src/services/vmAgent.ts`

当前状态显示逻辑和接口调用链是合理的。根因在宿主机 SSH 目标解析与免密登录配置。

## 12. 最终交付标准

下游 agent 完成后，应在回复中提供：

1. `ssh sentaurus-centos7 "hostname; whoami; hostname -I"` 的关键输出
2. `/api/vm/status` 的关键 JSON 字段
3. `/api/vm/agent/status` 的关键 JSON 字段
4. Web UI 顶部状态是否显示 `VM Online` 和 `Agent Running`
