# Sentaurus Web Agent：Web 端显示 VM Offline 的修改方案

## 1. 问题结论

当前 CentOS7 VM 实际是在线的，VM worker 也在运行。

但 Web 端显示 `VM Offline`，原因不是 VM 没启动，而是：

> 跑 Web 后端的宿主机无法解析 SSH 别名 `sentaurus-centos7`

后端报错为：

```text
ssh: Could not resolve hostname sentaurus-centos7
```

也就是说，Web 后端配置里使用了：

```env
SENTAURUS_SSH_TARGET=sentaurus-centos7
```

但宿主机的 SSH 配置里没有这个别名，导致后端无法通过 SSH 连接 CentOS7 VM。

---

## 2. 当前已确认状态

### 正常的部分

```text
CentOS7 VM: online
VM IP: 192.168.134.133
VM worker: running
Web frontend: http://10.6.22.1:5174 可访问
Web backend: http://10.6.22.1:5175 可访问
/api/runs: 正常返回
```

### 异常的部分

```text
/api/vm/status: 后端 SSH 检查失败
/api/vm/agent/status: 后端 SSH 检查失败
```

失败原因：

```text
Could not resolve hostname sentaurus-centos7
```

---

## 3. 推荐架构

推荐保持现有架构：

```text
浏览器
  ↓
宿主机 Web 前端 10.6.22.1:5174
  ↓
宿主机 Web 后端 10.6.22.1:5175
  ↓ SSH
CentOS7 VM 192.168.134.133
  ↓
Sentaurus VM worker
```

只需要修复宿主机 Web 后端到 CentOS7 VM 的 SSH 配置。

---

## 4. 修改方案 A：配置宿主机 SSH 别名

在宿主机 Windows 上编辑：

```text
C:\Users\<你的用户名>\.ssh\config
```

添加：

```sshconfig
Host sentaurus-centos7
  HostName 192.168.134.133
  User TCAD2022
  IdentityFile C:\Users\<你的用户名>\.ssh\sentaurus_vm_ed25519
  IdentitiesOnly yes
```

然后在宿主机 PowerShell 测试：

```powershell
ssh sentaurus-centos7 "hostname; whoami; hostname -I"
```

预期结果类似：

```text
centos7-hostname
TCAD2022
192.168.134.133 ...
```

如果这条命令能通，Web 后端的 `/api/vm/status` 就应该能正常返回在线状态。

---

## 5. 修改方案 B：不用 SSH 别名，直接改后端 `.env`

如果不想配置 SSH alias，可以在 Web 后端 `.env` 中改成：

```env
SENTAURUS_SSH_TARGET=TCAD2022@192.168.134.133
```

但这种方式仍然要求宿主机的 OpenSSH 能找到正确私钥。

如果私钥不是默认路径，建议仍然使用方案 A，通过 SSH config 指定 `IdentityFile`。

---

## 6. 同时建议修正前端 API 地址

当前前端构建包里可能还硬编码了：

```text
http://localhost:5175
```

如果浏览器通过：

```text
http://10.6.22.1:5174
```

访问页面，那么浏览器里的 `localhost` 指的是浏览器所在机器，不一定是宿主机。

因此建议在 Web 前端启动或构建时设置：

```env
VITE_API_BASE=http://10.6.22.1:5175
```

如果使用 Vite dev server，可以在启动前设置：

```powershell
$env:VITE_API_BASE="http://10.6.22.1:5175"
npm run dev:web
```

或写入前端 `.env`：

```env
VITE_API_BASE=http://10.6.22.1:5175
```

然后重启前端。

---

## 7. 修改后重启服务

修改 SSH config / `.env` 后，重启 Web 后端和前端：

```powershell
npm run dev
```

或者如果前后端分开启动：

```powershell
npm run dev:server
npm run dev:web
```

---

## 8. 验证步骤

### 8.1 验证宿主机 SSH

```powershell
ssh sentaurus-centos7 "hostname; whoami; /home/TCAD2022/.sentaurus-web-agent/vm-agent/vm-agent-autostart.sh status"
```

预期：

```text
TCAD2022
running pid=xxxx
```

### 8.2 验证后端健康

```powershell
curl http://10.6.22.1:5175/api/health
```

预期：

```json
{"ok":true,"service":"sentaurus-web-agent"}
```

### 8.3 验证 VM 状态接口

需要带上 Web UI 使用的 `AUTH_TOKEN`：

```powershell
curl -H "Authorization: Bearer <AUTH_TOKEN>" http://10.6.22.1:5175/api/vm/status
```

预期：

```json
{
  "ok": true,
  "sshTarget": "sentaurus-centos7",
  "user": "TCAD2022"
}
```

### 8.4 验证 VM Agent 状态接口

```powershell
curl -H "Authorization: Bearer <AUTH_TOKEN>" http://10.6.22.1:5175/api/vm/agent/status
```

预期：

```json
{
  "ok": true,
  "connected": true,
  "workerRunning": true
}
```

---

## 9. 最终预期效果

修改完成后：

```text
Web 顶部 VM 状态：Online
Agent 状态：Running
LLM 状态：Configured 或 Pending
发送 VM 状态消息：能正常返回 CentOS VM 状态
```

如果仍然显示 Offline，优先检查：

1. `192.168.134.133` 是否变了；
2. 宿主机是否能 SSH 到 VM；
3. Web 后端 `.env` 中的 `SENTAURUS_SSH_TARGET` 是否正确；
4. 前端是否仍然在调用 `localhost:5175`；
5. Web UI 中保存的 `AUTH_TOKEN` 是否和后端 `.env` 一致。
