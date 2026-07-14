# PLT 参数提取审查报告

日期：2026-07-10  
审查依据：

- `docs/coordination/plt-parameter-extraction-fix-plan.md`
- `docs/coordination/plt-parameter-extraction-implementation-report.md`

## 1. 结论

**允许进入隔离 VM 部署验收（GO），但不允许宣告部署验收通过或进入正式服务发布（NO-GO）。**

本地审查、最小修复、针对性测试、typecheck、生产 build 和 `git diff --check` 均已通过。仍需在真实 VM 上验证默认 Python 2.7、文件持久化、真实 SSH 生命周期和并发时延；这些项目不能由本地 Python 3 环境替代。

此外，当前 SSE 仍是每连接轮询、由进程内 single-flight 合并相同 cursor 请求，并非修复计划定义的单一服务端 poller + fan-out。该项不阻止进入隔离 VM 功能验收，但在正式部署签字前必须完成或通过明确的并发验收与风险豁免。

## 2. 审查发现与修复

### 2.1 DF-ISE parser

1. **33 列 fallback 校验过宽**
   - 原实现只要 dataset 缺失或数量为 33，就直接使用固定列号。
   - 已改为要求完整 33 项 `functions` profile 与已知 DF-ISE terminal signature 完全匹配。
   - 未携带或不匹配签名的 33 列数据返回 `DATASET_NOT_FOUND / invalid-input`。

2. **参数边界未在 parser 内独立校验**
   - 已校验有限数、正 bias tolerance、正 Vth/SS 电流、SS 上下界顺序、最小点数和输出前缀。
   - 非法参数返回 `INVALID_ARGUMENT / invalid-input`，不再进入计算或被误判为数据覆盖不足。

3. **错误语义分类不完整**
   - `INVALID_ARGUMENT`、unsupported profile/method、bias order 等归类为 `invalid-input`。
   - Vth/SS/点数覆盖不足归类为 `incomplete`。
   - extractor 内部或输出 I/O 错误归类为 `failed`，不再伪装为 `incomplete`。

4. **单位与 provenance 不够明确**
   - 结果增加 V、A/um、mV/dec、mV/V 单位契约。
   - provenance 增加 `functionCount` 和 `columnResolution`，明确按 dataset 名称或受控 fallback 解析。

5. **数学契约复核**
   - Vth：首次向上跨越 `1e-7 A/um`，在 `log10(Id)` 域线性插值。
   - SS：`[1e-12, 1e-7] A/um` 内最大正相邻斜率的倒数。
   - DIBL：使用文件实际 `Vd_high - Vd_low`。
   - 未增加外推、补零、`IFERROR` 式兜底或固定 1.05 V 分母。

当前 parser SHA-256：

`e44a9e6ebc22b04b6ec77474fd6188336283cf73e237a1006666a1765fbfac4e`

原 implementation report 中记录的旧 hash 已因本次修复失效。

### 2.2 Typed postprocess 与 semantic status

1. **任意脚本字段**
   - worker 继续只接受 `dfise-idvg-v1` allowlist 字段。
   - `script`、任意 Python/Tcl/shell 字段会在 normalize 阶段直接拒绝。

2. **exit 0 可能掩盖语义失败**
   - 发现 runner 在 parser payload 声称 `status=ok`、但输出文件校验失败时，仍可能保留 `status=ok`。
   - 已改为同时要求：
     - 进程 exit 0；
     - 未超时；
     - payload status 为 `ok`；
     - required metrics 均为有限数；
     - input SHA-256 一致；
     - actual bias 与 expected bias 在容差内；
     - valid point count 达标；
     - CSV/JSON/DAT/TXT/PNG 路径、扩展名和文件存在性正确；
     - CSV 表头和数据行数达标；
     - metrics JSON 与 stdout payload 指标一致；
     - report 中 low/high 输入 hash 一致。
   - 任一后置条件失败均不会生成 succeeded run。

3. **共享类型**
   - `DfiseIdvgPostprocessResult.status` 已增加 `failed`。
   - shared provenance 和单位类型已同步。

### 2.3 Artifact 与通用文件发布

1. **run artifact display attachment 仍只保留图片**
   - 测试发现 `display_attachments_for_artifacts()` 会跳过 CSV、PLT 等非图片产物。
   - 已按 allowlist 分流：
     - PNG/JPG/JPEG/WebP/GIF/SVG：`kind=image`；
     - CSV/JSON/DAT/TXT/PLT/PDF 及允许的 TCAD 文件：`kind=file`。

2. **路径与同步**
   - postprocess 输出前缀仅允许安全 basename。
   - runner 只接受 `artifacts/` 下的声明输出。
   - session output 同步继续使用安全相对路径和类别目录，不覆盖历史 run。

### 2.4 Capability 文件与固定 context

1. 已实际解码并执行 control script 的 `write_worker_files()`。
2. 已验证以下文件在临时 HOME 中持久落盘：
   - `agent_worker.py`
   - `dfise_idvg_extract.py`
   - `capabilities/dfise-plt-postprocess-v1.json`
3. capability 文件包含 rule id、extractor version、metric profile、extractor SHA-256 和固定规则。
4. 落盘 worker 包含固定 `dfise-plt-postprocess-v1` system context，并明确禁止动态 Inspect/Tcl/Python parser。

### 2.5 SSH lane、deadline、single-flight 与清理

1. **前端取消此前没有传到 SSH**
   - 原实现只中止浏览器 fetch；服务端 SSH/SCP 仍可能继续运行。
   - 已将 `AbortSignal` 从 history/files/artifact HTTP 请求传入 SSH scheduler。

2. **共享请求取消竞态**
   - single-flight 增加消费者引用计数。
   - 一个消费者取消不会终止其他消费者共享的 SSH。
   - 所有消费者取消后，才中止底层任务并移除 single-flight。

3. **排队任务和 deadline**
   - queue deadline 到期后返回 `VM_SSH_QUEUE_TIMEOUT`。
   - 已验证过期任务在前序任务结束后不会再次执行。
   - 所有消费者取消时，外层 flight 立即结束并清理 deadline timer。

4. **进程与远端临时脚本**
   - 运行中取消继续调用进程树终止逻辑。
   - SCP 与 SSH 保持在同一 lane 事务内。
   - 远端临时 Python 文件增加 shell `EXIT/HUP/INT/TERM` trap 清理。

### 2.6 前端 hydration、竞态、Retry 与 SSE

1. history hydration 继续按 runs → selected session → history 顺序执行。
2. history 和 session-files 使用独立 AbortController，不会直接关闭 EventSource。
3. 修复旧 session-files 请求完成后错误清除新请求 loading 状态的竞态。
4. SSE 在初次 SSH history 调用前注册 close/abort 监听。
5. 发现 SSE 仅 `writeHead()`、未 `flushHeaders()`，初次 history 阻塞时客户端不能完成建连，也不能及时取消。
6. 已增加 `flushHeaders()`；测试验证建连后信号仍未取消，断开 socket 后才中止对应 SSH history 消费者。

## 3. 实际测试结果

### 3.1 `npm run test:plt-extraction`

结果：**21/21 通过**

覆盖：

- 28nm golden Vth/SS/DIBL；
- expected 1.05 V 与实际 0.80 V mismatch；
- D/d exponent；
- dataset 重排；
- 完整 33 列 function-signature fallback；
- 无签名 33 列拒绝；
- Data width、重复 Vg、多个 Data block；
- Vth/SS 覆盖不足；
- 非法数值边界和 semantic status；
- typed postprocess 任意脚本字段拒绝；
- exit-zero 但输出缺失时 runner 返回 failed；
- capability/parser/worker 持久落盘；
- CSV/PLT 通用文件与 PNG 图片分流；
- SSH queue deadline；
- 引用计数 single-flight cancellation；
- SSE disconnect → SSH consumer abort；
- session-files stale completion 状态竞态。

### 3.2 `npm run test:session-history`

结果：**14/14 通过**

确认未回归：

- zlib-base64 envelope；
- `after>0` 增量语义；
- HTTP 502/504；
- Windows 超时进程树清理；
- hydration、Retry、旧消息/cursor 保留；
- session-files 前端状态竞态。

### 3.3 `npm run typecheck`

结果：**通过**

- shared build；
- server typecheck；
- web typecheck；
- shared typecheck。

### 3.4 `npm run build`

结果：**通过**

- shared build；
- server build；
- web TypeScript + Vite production build。

Vite 仅报告 `lucide-react` 的 `"use client"` directive 被忽略警告，无构建失败。

### 3.5 `git diff --check`

结果：**通过**

仅出现现有工作区 LF/CRLF 转换提示，无 whitespace error。

### 3.6 Python 本地检查

- `python -m py_compile apps/server/remote/dfise_idvg_extract.py`：通过。
- 嵌入 worker/control 在本地 Python 3 环境中已被实际解码和执行。
- 当前可用解释器为 Python 3.14.6。
- 本机没有可用 Python 2.7；已发现的 Python 3.9 launcher 路径无效，因此未把静态兼容检查冒充为真实 Python 2 运行证明。

## 4. 尚未验证的 VM 项

以下项目必须在隔离 VM 部署验收中完成：

1. VM 默认 `python` 确认为 Python 2.7，并运行 parser `--version`。
2. 在 Python 2.7 与 Python 3 上对同一 golden 输入比较 JSON/CSV 指标和 hash。
3. 实际 staging 后核对 parser SHA-256 为：
   - `e44a9e6ebc22b04b6ec77474fd6188336283cf73e237a1006666a1765fbfac4e`
4. 重启 worker 后确认 capability 文件和固定 context 仍被加载。
5. 真实 `.plt` input sync、`.txt`/`.plt` 去重、远端目录并发创建和 SHA-256 校验。
6. 真实 typed postprocess 生成并下载 CSV/JSON/DAT/TXT/PNG/PLT。
7. 真实 timeout/cancel 后确认：
   - 本地主机无残留 ssh/scp 进程树；
   - VM `/tmp/sentaurus-web-agent-*.py` 无残留；
   - lane 后续任务可继续执行。
8. 测量 status/history/files/artifact 的 queue wait、execution time 和 p95。
9. 使用多个 SSE 客户端验证 VM history 请求放大量；当前是进程内相同 cursor single-flight，不是严格单 poller fan-out。

## 5. 部署验收决定

### 允许

**允许进入隔离 VM 部署验收。**

本地已无已知 parser 数学、typed postprocess、semantic status、artifact 分流、HTTP 取消传播或前端关键状态的 P0 阻塞项。

### 不允许

在以下条件完成前，**不允许宣告部署验收通过，不允许重启或替换正式服务**：

1. 真实 Python 2.7 golden 对比通过；
2. VM parser/capability 持久化和 hash 验证通过；
3. 真实 SSH timeout/cancel 无进程和临时文件泄漏；
4. 真实 artifact/general-file 发布通过；
5. SSE 多客户端放大量达到验收目标，或对未实现单 poller fan-out 给出明确风险豁免。

## 6. 操作约束确认

- 未执行 Git reset/checkout。
- 未删除历史 run、message 或 artifact。
- 未提交 Git。
- 未重启正式服务。
- 本报告写入后未再次运行集成测试或 build。
