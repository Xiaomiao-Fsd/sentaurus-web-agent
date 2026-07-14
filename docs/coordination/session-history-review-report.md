# Session History External Access P0 审查报告

- 日期：2026-07-10
- 角色：Review / Acceptance / Debug
- 依据：
  - `docs/coordination/session-history-external-access-fix-plan.md`
  - `docs/coordination/session-history-implementation-report.md`
- 限制：未重启服务、未提交 Git、未 reset/checkout、未删除任何历史或 legacy run 数据。

## 结论

- **Session history P0 代码允许进入下一步 VM 验收：有条件通过。**
- **外部部署验收暂不允许进入：阻塞。**
- 阻塞不是 history envelope、HTTP 错误或本地 run root；而是当前实际 `.env` 仍使用非回环监听配合默认短 token，以及计划中 P1 的 same-origin / CORS allowlist / bind / Vite allowed-host 配置尚未实施。

## 本次发现并修复

### 1. `after>0` 增量请求会永久丢事件

原实现对所有匹配事件扫描到 EOF 后取最后 `limit` 条，同时把 cursor 直接推进到全局 EOF。若增量积压超过 limit，中间事件会被跳过且无法再读取。

修复：

- `after>0` 改为返回第一批匹配事件。
- 达到 limit 时 cursor 只推进到最后一条已返回事件的全局 sequence。
- 下一次使用该 cursor 可继续读取剩余原始 delta、progress、worklog 和 done 事件。
- `after=0 + selected session` 仍走 VM 侧 compact + zlib envelope；`after>0` 不压缩、不折叠原始事件。

涉及：

- `apps/server/src/services/vmAgent.ts`

### 2. 重访 session 时存在 hydration / SSE 并发竞态

原实现使用单个 `historyAttemptedSessionId`。重访一个此前加载成功的 session 时，旧 attempted 标记可能立即放行 SSE，同时另一个 effect 又发起全量 history reload，造成全量合并与实时增量并发。

修复：

- 已有 `ready / empty / failed / truncated / loading` 缓存状态的 session 不再自动重复全量 hydrate。
- 首次 `idle` session 才自动加载。
- 失败状态保留旧消息与 cursor，由显式 Retry 发起重试。
- 过期请求继续由 sequence + selected session 双重校验丢弃。
- 旧请求 finally 不再提前清除新请求的全局 busy 状态。

涉及：

- `apps/web/src/App.tsx`
- `apps/web/src/sessionHistory.ts`

### 3. 非回环监听允许默认弱 token

原保护只覆盖 `HOST=0.0.0.0`，但默认 `HOST=10.6.22.1` 同样是非回环网络监听，仍可配合 `change-me-local-only` 启动。

修复：

- 所有非回环 HOST 均拒绝默认 token。
- 所有非回环 HOST 均要求 token 至少 24 字符。
- `.env.example` 改为强 token 占位符。

当前实际 `.env` 审计结果：

```json
{
  "host": "10.6.22.1",
  "corsOrigin": "http://10.6.22.1:5174",
  "tokenLength": 20,
  "tokenIsDefault": true
}
```

因此本次代码在下次服务启动时会安全拒绝当前配置；必须先设置新的强 token。未自动修改真实 `.env`，避免替用户生成或覆盖凭据。

涉及：

- `apps/server/src/config.ts`
- `.env.example`
- `README.md`

## 协议与回归审查

### VM compact / zlib envelope

- selected session 且 `after=0`：在 VM 扫描、session 过滤和 stream compact 后，使用 `zlib-base64-json` envelope 返回。
- host 使用 `inflateSync` 解包并恢复 payload，同时保留压缩前后字节指标。
- `after>0`：保持 plain JSON 和原始事件 kind，不进入 compact envelope。
- full history compact 后，user、progress/worklog、run result、diagnostic 等非 stream 消息按 sequence 保留。
- stream 终态保留 `sessionId`、`turnId`、`targetMessageId`、artifact JSON、display attachments 等字段。

### HTTP 502 / 504

- SSH/history timeout 映射为 HTTP 504 + `VM_HISTORY_TIMEOUT`。
- 其他 SSH/bridge/invalid response 映射为 HTTP 502 + `VM_HISTORY_BRIDGE_FAILED`。
- 错误响应保留 retryable、last-known cursor、VM status 和空 messages，不再伪装 HTTP 200 空历史。

### SSH 超时进程树

- Windows 使用 `taskkill /PID <pid> /T /F` 清理 SSH/SCP 本地进程树，并用 `child.kill("SIGKILL")` 兜底。
- 新增真实父子 Node 进程树测试，超时清理后父子进程均不存在。
- 测试结束后无 fixture Node 残留。

### Artifact / progress / output / session context

- VM compact 测试覆盖并确认：
  - progress 的 `sessionId`、`runId`、output category 保留；
  - assistant final 的 `vmRunArtifactsJson` 保留；
  - artifact attachment 的 source、runId、path 保留；
  - 其他 session 消息不会混入 selected session。
- host `normalizeMessages` 后再次验证上述 primitive meta 和 attachments 不丢失。
- VM worker 的同 session context 仍读取原始 `messages.jsonl`，本次 transport compact 不改写 VM 历史文件。

### 稳定 run root 与无损迁移

- 从仓库根目录解析：`E:\VSCode\Sentaurus-agent\data\runs`
- 从 `apps/server` cwd 解析：`E:\VSCode\Sentaurus-agent\data\runs`
- migration dry-run：
  - `canonical-existing: 3`
  - `duplicate-identical: 2`
  - `conflict: 0`
  - `invalid: 0`
- canonical 和 legacy 根均保留，未覆盖、未删除源历史。

## 新增测试

命令：

```powershell
npm run test:session-history
```

结果：**12/12 通过**。

覆盖：

1. zlib-base64 envelope 解包和 transport metrics。
2. selected full history 的 VM compact + envelope。
3. artifact / progress / output / session meta 经 VM compact 与 host normalize 后保留。
4. `after>0` 第一页、cursor 和第二页连续增量语义。
5. HTTP 504 structured timeout。
6. HTTP 502 structured bridge failure。
7. 非回环 weak/default token 拒绝。
8. Windows 父子进程树清理。
9. hydration 必须等待 selected session attempt。
10. stale request 不得覆盖新 selection。
11. 重访已缓存 session 不自动并发 full reload。
12. Retry 失败保留旧 message count/cursor，只有成功空响应进入 empty。

测试文件：

- `apps/server/test/sessionHistory.test.ts`
- `apps/server/test/setup.ts`
- `apps/web/test/sessionHistoryState.test.ts`

## 最终验证

- `npm run test:session-history`：通过，12/12。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- Vite 仅有 `lucide-react` 的 `"use client"` ignored warning，无构建错误。
- `git diff --check`：通过，仅有现有 LF/CRLF 提示。
- 未发现测试遗留 Node fixture 进程。
- 未重启任何服务，因此当前长期运行进程仍可能加载旧构建。

## 未解决阻塞

### 部署外部访问 P1 尚未实施

以下仍与计划中的 P1 一致，未在本次 P0 审查中扩大修改：

- `apps/web/src/api/client.ts` 默认 API base 仍固定为 `http://10.6.22.1:5175`，不是部署 same-origin 相对 URL。
- web dev/preview 仍固定绑定 `10.6.22.1`。
- Vite 未配置受控 `allowedHosts`，alternate hostname 仍可能 HTTP 403。
- Fastify REST CORS 仍是单一 `CORS_ORIGIN` 字符串，不是 exact allowlist。
- VM message SSE 和 run log SSE 仍手写固定 `CORS_ORIGIN`。
- EventSource 和下载 URL 仍通过 query 参数携带 bearer token；部署前应改为 same-origin 安全会话、短期 stream ticket，或至少完成 URL 日志脱敏方案。

因此当前代码不能宣称已完成“外部 hostname / reverse proxy / 多 origin”部署验收。

### 仍需运行态验收

本次遵守要求未重启服务，也未重复真实 VM 大历史/soak 探针。下一阶段需要在获批重启后验证：

1. 设置强 `AUTH_TOKEN`，确认新构建可启动。
2. 通过真实 route 请求验证 selected session full history、504 和 502。
3. 浏览器验证首次 hydrate、快速切换 session、失败 Retry 与旧消息/cursor 保留。
4. 观察大历史请求后的 SSH/SCP 进程和队列，执行有限并发/soak。
5. 实施 P1 后再验证 allowed/disallowed origin、SSE 和 reverse proxy。

## 验收决定

| Gate | 决定 | 条件 |
| --- | --- | --- |
| 进入 VM 验收 | **允许，有条件** | 先更新真实 `.env` 强 token；获批后重启加载新构建；执行有限真实 VM/API/browser 验收 |
| 进入部署验收 | **不允许** | 先完成 P1 same-origin、CORS allowlist、SSE origin、bind/allowedHosts 与 query-token 风险处理 |

