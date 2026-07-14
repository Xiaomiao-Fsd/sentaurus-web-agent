# External Access Session History P0 实施报告

- 日期：2026-07-10
- 状态：P0 代码与无损迁移已完成，当前工作树通过类型检查和生产构建；未重启服务，未继续运行真实 VM 大历史探针。
- 范围：仅记录 `docs/coordination/session-history-external-access-fix-plan.md` 中 session history P0 的实施和验证结果，不包含 P1 外部访问配置扩展。

## 已完成内容

### VM history 压缩与传输

- `apps/server/src/services/vmAgent.ts`
  - 在 VM 侧读取 selected session 全历史后、SSH JSON 序列化前完成消息压缩。
  - 区分累计内容和增量 append 内容，合并可合并记录并限制单条 append 内容大小。
  - 增加响应字节预算、截断状态、continuation 元数据和原始/压缩消息计数。
  - 全历史响应使用 zlib 压缩后 base64 封装，通过 SSH 返回；host 侧解压并恢复结构化结果。
  - 增加 history 专用超时和 `VmAgentHistoryError`，保留 host 侧兜底压缩。
  - 暴露压缩前后传输字节指标，便于后续观察真实 VM 大历史负载。
- `apps/server/src/services/sshClient.ts`
  - 识别已完成的 JSON payload 行。
  - Windows 超时时使用 `taskkill /T /F` 清理 SSH/SCP 进程树，降低孤儿进程阻塞后续请求的风险。

### 结构化错误响应

- `apps/server/src/routes/vmAgent.ts`
  - history 超时返回 HTTP 504，不再以 HTTP 200 和空数组伪装成功。
  - VM bridge/SSH 失败返回 HTTP 502。
  - 错误体包含 `ok: false`、错误码、消息、`retryable`、原 cursor、status 和空 `messages`。
- `packages/shared/src/index.ts`
  - 增加 history 成功/失败响应、截断信息和传输指标的共享类型。

### 前端 hydration 与重试

- `apps/web/src/App.tsx`
  - 增加每个 session 的 `idle/loading/ready/empty/failed/truncated` history 状态。
  - hydration 顺序调整为 `runs -> selected session -> history`，完成历史加载后再进入实时流阶段。
  - history 请求失败时保留已有消息和 cursor，不再将失败结果覆盖为“无消息”。
  - 使用请求序号忽略过期响应，避免切换 session 时旧请求覆盖新状态。
  - 展示加载、失败、截断状态；失败状态提供 Retry 操作。
  - 仅在成功返回空历史时展示真正的空消息状态。
- `apps/web/src/styles.css`
  - 增加 history loading、failed、truncated 和 retry banner 样式。

### 稳定本地运行目录与迁移

- `apps/server/src/config.ts`
  - 相对 `LOCAL_RUN_BASE` 固定从仓库根目录解析，不再依赖进程启动时的 `process.cwd()`。
  - 增加 history timeout 和 payload budget 配置。
- `scripts/migrate-local-runs.mjs`
  - 默认 dry-run，显式 `--apply` 才写入。
  - 盘点 `data/runs` 和 `apps/server/data/runs`。
  - 校验 run ID、逐文件 SHA-256 和规范化后的 `localDir`。
  - 通过 staging copy 后 rename 迁移；不覆盖、不删除源目录，冲突会报告并停止对应项。
- `package.json`
  - 增加 `migrate:runs:dry-run` 和 `migrate:runs` 命令。
- `.env.example`、`README.md`
  - 补充稳定根目录、history 配置和迁移操作说明。

## 当前工作树审计

本次 P0 直接涉及的实现文件：

- `.env.example`
- `README.md`
- `apps/server/src/config.ts`
- `apps/server/src/routes/vmAgent.ts`
- `apps/server/src/services/sshClient.ts`
- `apps/server/src/services/vmAgent.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`
- `package.json`
- `packages/shared/src/index.ts`
- `scripts/migrate-local-runs.mjs`

当前工作树还包含既有或无法仅凭最终 diff 完整归因于本 P0 的修改和新增文档，例如：

- `apps/server/src/services/vmStatus.ts`
- `docs/sentaurus-web-agent-codex-debug-plan-2026-06-30.md`
- `docs/sentaurus-vm-agent-codex-style-worklog-plan-2026-07-02.md`
- `docs/sentaurus-vm-worker-incremental-chat-streaming-contract-2026-07-02.md`
- `docs/sentaurus-vmagent-image-publish-sourcepath-issue-2026-06-30.md`
- `docs/sentaurus-web-agent-web-attachment-bubble-fix-2026-06-30.md`
- `docs/sentaurus-web-session-history-compaction-plan-2026-07-03.md`

这些既有改动未被回退、整理或纳入本次范围。`git diff --check` 已通过，仅出现 Git 的 LF/CRLF 转换提示，没有 whitespace error。

## 无损迁移结果

迁移前 dry-run：

- canonical `data/runs`：1 个 run。
- legacy `apps/server/data/runs`：2 个待复制的唯一 run。

执行 `--apply`：

- `canonical-existing: 1`
- `copied: 2`
- 未覆盖 canonical 文件，未删除或修改 legacy 源目录。

迁移后复核：

- `canonical-existing: 3`
- `duplicate-identical: 2`
- legacy 中两份 run 与 canonical 副本逐文件校验一致。

canonical `data/runs` 当前包含：

- `run_20260609195117_Os18zS`
- `run_20260626163724_rDsE4Q`
- `run_20260706071613_QpSWrO`

迁移工具保留两个根目录中的原始数据，因而可通过删除新复制的 canonical run 回退；本次没有执行任何删除。

## 已通过验证

### 本次收尾静态验证

2026-07-10 基于当前工作树各执行一次：

- `npm run typecheck`：通过。
  - shared build 通过。
  - server、web、shared TypeScript `--noEmit` 检查通过。
- `npm run build`：通过。
  - shared 和 server TypeScript build 通过。
  - web TypeScript build 和 Vite production build 通过。
  - Vite 仅报告 `lucide-react` 的 `"use client"` 指令被忽略警告，没有构建错误。

### 已有针对性验证

- 本地合成 VM control script：输入 5002 条记录，压缩为 4 条返回记录；响应预算、截断标记、累计内容合并和 append 内容上限均按预期生效。
- 配置路径验证：从仓库根目录和 `apps/server` 目录启动配置解析，`LOCAL_RUN_BASE` 均解析到 `E:\VSCode\Sentaurus-agent\data\runs`。
- Fastify route inject 超时验证：强制不可达目标返回 HTTP 504，响应包含 `VM_HISTORY_TIMEOUT`、`retryable: true`、原 cursor、status 和空 `messages`。
- SSH 快速探针：约 2.3 秒返回 `ssh-ok`，执行前后未残留 SSH 进程。
- 真实 VM direct built-module selected-session 全历史验证曾成功一次：
  - session：`run_20260706071613_QpSWrO`
  - 耗时：约 6.0 秒
  - cursor：5667
  - 原始记录：968
  - 压缩消息：597
  - payload：388634 bytes
  - transport uncompressed：390935 bytes
  - transport compressed：37535 bytes
  - `truncated: false`
  - `historyCompacted: true`
- 同一真实 VM 的增量验证曾成功一次：
  - 耗时：约 5.4 秒
  - after cursor：5647
  - 返回 cursor：5667
  - 返回 20 条增量记录。
  - 增量事件仍保持 `worklog_summary`、`progress`、`agent_trace`、`file_operation`、`tool_run` 等原始 kind。

## 仍存在的阻塞与风险

### 真实 VM SSH / 大历史

- 真实 VM 成功结果来自 direct built-module 探针，不是当前长期运行服务进程的 route/browser 端到端验证。
- 本次按要求没有重启服务；运行中的服务可能仍加载旧构建，因此现网 API 和 UI 尚不能视为已验收。
- 修复前真实大历史请求曾出现 45 秒和 120 秒超时，Windows OpenSSH/SCP 存在孤儿进程累积现象。虽然已加入进程树清理和压缩传输，仍缺少长期运行服务下的并发或 soak 观察。
- 本次明确停止继续运行真实 VM 大历史探针，没有重复成功样本，也没有验证极端历史在不同网络质量下的超时边界。

### API 与前端

- HTTP 504 结构化 route 已通过 inject 验证；最终 HTTP 502 分支已实现，但未单独执行最终 route inject 验证。
- 前端 retry、旧消息/cursor 保留、过期请求保护和 hydration 顺序已通过 TypeScript 与生产构建，但尚未通过浏览器端到端测试。
- 未验证服务重启后从外部 hostname/origin 访问的完整路径。

### 范围外事项

- P1 的 same-origin、CORS、host binding 或其他 external access 配置未实施。
- 未整理或回退当前工作树中的其他既有修改。
- 未创建 Git commit。
- 未重启任何服务。

## 后续验收建议

在获得服务重启授权后，最小验收应为：

1. 重启当前服务，使其加载本次构建。
2. 通过实际 API 验证 selected session history 成功、504 和 502 响应。
3. 在浏览器验证 runs、selected session、history 的 hydration 顺序以及失败 Retry 对旧消息/cursor 的保留。
4. 观察长历史请求后的 SSH/SCP 进程和服务队列；除非出现回归证据，不再重复扩大真实 VM 大历史探针规模。
