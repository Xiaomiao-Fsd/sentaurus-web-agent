# PLT 参数提取修复实施报告

日期：2026-07-10  
范围：`plt-parameter-extraction-fix-plan.md` Phase 0–3，以及稳定运行所需的最小 Phase 4。  
约束：保留 dirty tree；未删除历史；未提交 Git；未重启 Web 服务；未继续执行 VM 大历史探针。

## 1. 结论

- 固定 Python 2.7/3 标准库 DF-ISE parser、`tcad-idvg-v1` 指标契约、结构化错误码和 CSV/JSON/DAT/TXT/PNG 标准输出已实现。
- VM worker 已接入受限的 `dfise-idvg-v1` typed postprocess；模型不能提交任意 Tcl/Python/shell parser，固定 parser 在写入 VM 前校验 SHA-256，并在执行前校验版本。
- Python 2 输入同步路径已移除 `exist_ok=True` 等 Python 3-only API，上传后校验大小和 SHA-256；同内容 `.txt`/`.plt` 以 `.plt` 为规范输入并返回 deduplicated 状态。
- 通用文件与图片发布已分流；CSV/JSON/DAT/TXT/PLT 进入普通附件/下载，PNG/JPG/JPEG/WEBP/GIF/SVG 可进入图片预览。
- `dfise-plt-postprocess-v1` 已进入固定 worker context，并在 VM 启动写入持久知识文件 `~/.sentaurus-web-agent/vm-agent/capabilities/dfise-plt-postprocess-v1.json`。
- 最小 Phase 4 已完成 SSH lane、queue deadline、SCP+SSH 事务、status/history/files single-flight、files 短缓存，以及前端 history/files 取消和重复 full-history 轮询移除。
- 本地真实 28nm 黄金文件验证通过；真实 VM 运行验证因 SSH 连接级超时阻塞，未冒充成功。

## 2. Phase 0：现有 28nm 结果恢复

使用以下仓库内真实 DF-ISE 文件完成 actual-bias 恢复验证：

- `apps/server/data/runs/run_20260626163724_rDsE4Q/input/idvg_low.plt`
- `apps/server/data/runs/run_20260626163724_rDsE4Q/input/idvg_high.plt`

固定 parser 识别结果：

| 指标 | Low | High |
|---|---:|---:|
| 实际 Vd | 0.05 V | 0.80 V |
| 有效点数 | 108 | 109 |
| Vth | 0.1783295491 V | 0.1499588910 V |
| SS | 71.56688061 mV/dec | 74.78974888 mV/dec |
| DIBL | \- | 37.82754417 mV/V |

本地验证生成并检查了以下非空输出：extracted CSV、metrics JSON、metrics DAT、report TXT、plot PNG。测试在临时目录执行并清理，没有改写历史 run。

当 expected high Vd 为 1.05 V、实际文件为 0.80 V 时，parser 返回：

- `status=invalid-input`
- `error.code=BIAS_MISMATCH`
- 不生成被误标为 1.05 V 的 DIBL。

## 3. Phase 1：固定 parser 与输出契约

主要文件：

- `apps/server/remote/dfise_idvg_extract.py`
- `apps/server/test/dfiseIdvgExtract.test.ts`
- `package.json`

实现内容：

- parser 仅使用 Python 标准库，兼容 Python 2.7/3 语法和运行时 API。
- 当前版本：`dfise-idvg-extract/1`。
- 当前 SHA-256：`4c226f28038cd119343e758a0b58bb761cfe75531833203008b01a6a9b12f8f4`。
- 指标 profile：`tcad-idvg-v1`。
- 优先按 dataset 名称解析；仅在 dataset 缺失或 33 列兼容签名场景使用受控 fallback，并输出 warning。
- 解析全部 `Data` block，按有效点数选择目标 block。
- 支持 `D`/`d` Fortran 指数。
- 按文件内主导 Vd 选择 scan；按 Vg 排序去重，重复 Vg 保留最大 `abs(Id)` 并记录 duplicate count。
- Vth 使用恒流 `1e-7 A/um` 的对数插值。
- SS 使用 `1e-12`–`1e-7 A/um` 窗口内最大相邻对数斜率。
- DIBL 使用文件内实际 `Vd_high - Vd_low`。
- `BIAS_MISMATCH`、`MALFORMED_DATA_BLOCK`、`DATASET_NOT_FOUND` 返回 `invalid-input`。
- `VTH_NOT_COVERED`、`SS_WINDOW_NOT_COVERED`、`INSUFFICIENT_POINTS` 等返回 `incomplete`，不外推、不标记成功。
- 标准输出文件：
  - `idvg_*_extracted.csv`
  - `ss_dibl_*_metrics.json`
  - `ss_dibl_*_metrics.dat`
  - `ss_dibl_*_report.txt`
  - `idvg_*_plot.png`

黄金/边界测试覆盖：

- 真实 28nm low/high 黄金值。
- expected 1.05 V 对实际 0.80 V 的 `BIAS_MISMATCH`。
- `D` 指数。
- dataset 顺序变化。
- 33 列受控 fallback。
- Data block 宽度畸形。
- 重复 Vg。
- Vth 未覆盖。
- SS 窗口未覆盖。
- 多个 Data block 选择。

## 4. Phase 2：受限 VM postprocess 与输入同步

主要文件：

- `packages/shared/src/index.ts`
- `apps/server/src/services/vmAgent.ts`
- `apps/server/src/services/vmSessionFiles.ts`
- `apps/server/src/routes/runs.ts`
- `apps/server/src/services/runStore.ts`

实现内容：

- shared schema 新增 `DfiseIdvgPostprocessRequest`、结果、错误和 provenance 类型。
- run semantic status 支持 `incomplete` 与 `failed-postcondition`。
- typed postprocess 仅接受 allowlist 字段、`kind=dfise-idvg-v1`、`.plt` basename 和有限范围数值参数。
- worker 只执行固定 parser；不执行模型生成的解析脚本。
- parser source 随 control script staging，写入前校验内嵌 SHA-256，执行前检查 `--version`。
- postprocess 校验 required metrics 均为有限数，校验 input hash、输出路径和输出文件。
- parser 非零退出保留 stdout/stderr 和结构化 error code。
- 可恢复的数据覆盖错误映射为 `incomplete/failed-postcondition`；其他失败保持 `failed`。
- session setup 持久化 extractor version、metric profile、postprocess status/error、input hashes 和 actual biases。
- audit/manifest 记录 semantic status 和 postprocess result。
- Python 2 同步脚本使用 race-safe `ensure_dir`，不使用 `os.makedirs(..., exist_ok=True)`。
- 上传后比较本地/远端 SHA-256；同内容 `.txt` 与现有 `.plt` 去重并返回规范 `.plt` 路径。

静态运行验证：

- 从 `remoteAgentScript()` 解码内嵌 worker 与 parser。
- 两个 Python 文件均通过 `python -m py_compile`。
- parser `--version` 返回 `dfise-idvg-extract/1`。
- control script 包含 `dfise-plt-postprocess-v1` 持久规则。

## 5. Phase 3：发布、固定上下文与持久知识

主要文件：

- `apps/server/src/services/vmAgent.ts`
- `apps/server/src/services/vmSessionFiles.ts`
- `apps/web/src/App.tsx`

实现内容：

- worker artifact/session-file allowlist 支持 PLT、CSV、JSON、DAT、TXT 和常见 TCAD 文件。
- 图片格式独立识别，非图片不会进入 image-only 校验路径。
- Web 上传 accept 增加 `.dat` 和 `.svg`。
- 固定 system context 注入 `dfise-plt-postprocess-v1`：
  - 禁止动态 Inspect/Tcl/Python parser。
  - 必须读取 actual Vd。
  - expected bias 不匹配必须拒绝。
  - Vth/SS/DIBL 必须全部有限才允许成功。
  - 普通文件和图片按类型发布。
- VM 持久知识文件包含 rule id、extractor version、metric profile、extractor SHA-256 和固定规则。

## 6. 最小 Phase 4：SSH 队列与重复请求

主要文件：

- `apps/server/src/services/sshClient.ts`
- `apps/server/src/services/vmAgent.ts`
- `apps/server/src/services/vmSessionFiles.ts`
- `apps/web/src/api/vmAgent.ts`
- `apps/web/src/App.tsx`

实现内容：

- SSH lane：`interactive`、`status`、`history`、`files`。
- 各 lane 独立串行队列和 queue deadline；超时返回 `VM_SSH_QUEUE_TIMEOUT`。
- SCP staging、远端 SSH 执行和临时文件清理纳入同一调度事务。
- status/history/artifact/files list/download/input sync 使用稳定 dedupe key。
- files list 增加 5 秒短缓存；成功同步输入后立即失效。
- selected-session history 使用 AbortController 取消旧选择请求。
- session files 请求按 session 单飞；切换 session 时取消旧请求，过期响应不能覆盖新选择。
- pending reply 不再额外发起第二套 selected-session 全量 history 轮询；消息仍由 SSE 和 cursor 增量 fallback 接收，UI 保留等待/retry 计时状态。
- 现有 history hydration 保持 runs -> selected session -> history 顺序；失败重试保留旧消息和 cursor。

本次未扩展完整 Phase 4 的“SSE 单 poller + 多客户端 fan-out”。当前改动满足请求中的最小稳定范围，但多浏览器客户端仍可能各自维持 EventSource；这是明确的剩余项，不应描述为已完成。

## 7. 验证结果

### 7.1 已通过

| 命令/检查 | 结果 |
|---|---|
| `npm run test:plt-extraction` | 9/9 通过 |
| `npm run test:session-history` | 12/12 通过 |
| `npm run typecheck` | shared/server/web 全部通过 |
| `npm run build` | shared/server/web production build 通过 |
| embedded worker/parser `python -m py_compile` | 通过 |
| embedded parser `--version` | `dfise-idvg-extract/1` |
| `git diff --check` | 通过 |

Vite build 仅输出第三方 `lucide-react` 的 `"use client"` directive warning，不影响构建结果。

### 7.2 无损迁移 dry-run

执行 `npm run migrate:runs:dry-run`，未应用写入：

- `canonical-existing`: 2
- `conflict`: 2
- 退出码：2，表示检测到同 ID 不同 hash 的冲突并拒绝覆盖。

冲突主要来自 canonical 与 legacy 目录中同 run ID 的 `manifest.json` 差异；PLT/PDF 等主体输入 hash 保持一致。迁移工具没有删除、覆盖或合并任何历史内容。由于存在冲突，本次没有执行 `npm run migrate:runs -- --apply`。

## 8. 真实 VM 验证阻塞

按要求未运行真实 VM 大历史探针。仅执行两次轻量 SSH 连接探测：

1. `BatchMode + ConnectTimeout=8`：连接阶段超时，约 24 秒后由外层超时终止。
2. `ConnectionAttempts=1 + ConnectTimeout=15`：连接阶段再次超时，约 44 秒后由外层超时终止。

两次均未获得 `SSH_OK`，不能证明远端命令已开始执行。因此以下项目仍未完成真实 VM 验收：

- VM 默认 Python 2.7 下 parser 的实际执行和 Python 2/3 输出 hash 对比。
- `.plt` 实际同步、并发目录创建、`.txt`/`.plt` 远端去重。
- 固定 parser 和 capability 文件在 VM 上的 staging/hash/version 校验。
- typed postprocess 对真实 28nm 文件的 VM 端执行和 artifact 发布。
- 真实 1.05 V run 的 `SS_WINDOW_NOT_COVERED -> incomplete/failed-postcondition` 验证。
- SSH lane 的 p95 时延、queue deadline 和 files/status 隔离验收。

当前本地测试已经验证相应 parser 语义和嵌入脚本语法，但不能替代上述 VM 运行证明。恢复 VM 连通后，应只运行隔离的 parser/sync/postprocess 验证，不需要重跑 TCAD，也不应读取大历史。

## 9. 风险与后续

- **VM Python 2 风险**：代码按 Python 2.7 语法/API 编写，但缺少真实解释器执行证明。
- **远端持久化风险**：capability/parser 写入逻辑已静态验证，因 SSH 不通尚未确认远端文件落盘。
- **1.05 V 数据风险**：仓库中只有真实 0.05/0.80 V 黄金文件；1.05 V mismatch 已验证，真实 1.05 V SS 覆盖不足只能在 VM 恢复后验证。
- **Phase 4 范围风险**：未实现完整 SSE fan-out 和跨进程共享 single-flight；当前 scheduler/single-flight 为单 server 进程内机制。
- **迁移冲突风险**：同 ID manifest 差异需要人工选择保留版本或制定字段级无损合并规则；工具当前正确拒绝覆盖。

## 10. 仓库状态

- dirty tree 已保留。
- 未删除任何历史 run、消息或 artifact。
- 未提交 Git。
- 未重启 Web 服务。
- 未执行最终服务重启。
