# 28 nm MOSFET `.plt` 参数提取失败根因与修复计划

日期：2026-07-10  
Session：`run_20260626163724_rDsE4Q`  
范围：根因分析、架构方案、迁移兼容、测试与验收；本文件不实施生产代码修改。

## 1. 结论摘要

本次问题不是 SDE/SDevice 求解失败，而是后处理链路同时存在四类缺陷：

1. **直接失败原因：动态生成的 Inspect Tcl 存在花括号解析错误。**
   - 失败 run：`run_20260710T054459Z_utb28-step0005-full-extract_4ffce5`
   - 实际命令：`inspect -batch -f extract_step0005.tcl`
   - Inspect 输出：`Error : can't read "q": no such variable`
   - 脚本在 braced `proc` body 内写入 `"\n}"` 和 `"}`。Tcl 对 braced word 做花括号层级扫描时，双引号不屏蔽未转义的 `}`，导致 `proc` body 提前结束；后续 `if {$q < 0}` 落到顶层执行，变量 `q` 尚未定义。

2. **动态 Tcl/Inspect 后处理本身不可作为稳定生产能力。**
   - Tcl 由模型按次生成，没有静态语法校验、固定版本、单元测试或输出契约。
   - 第一次实现使用 Inspect 曲线 API，曾因 `cv_abs` 等版本相关 API 失败；随后改为“在 Inspect 中运行纯 Tcl 文本解析”，仍然受到 Tcl 语法生成错误影响。
   - 后续 run 虽退出码为 0，实际指标文件仍标记 `status=partial`，说明当前 runner 只验证进程退出码，没有验证业务结果完整性。

3. **输入文件及偏压元数据不一致。**
   - Session manifest 声明现有 high 曲线为 `Vd=1.05 V`，DIBL 分母固定为 `1.05-0.05`。
   - 实际本地 `idvg_high.plt` 的主扫描偏压是 **`Vd=0.80 V`**，不是 `1.05 V`。
   - 因此不得用该文件按 1.05 V 标注或计算 DIBL；必须使用文件内实际偏压，或明确要求重新生成 1.05 V 曲线。

4. **history/files/status/SSE 共用单一全局 SSH 队列，使后处理诊断和结果读取被放大为 50–180 秒延迟。**
   - `apps/server/src/services/sshClient.ts` 使用模块级 `sshQueue` 串行化所有 SSH 命令。
   - status 的“fast”调用仍进入同一队列。
   - SSE 每个连接每秒调用一次 history，Web 端还存在补偿轮询和选中 session history 轮询。
   - files 使用 90 秒执行超时；日志中一次 files 请求总耗时 `155993 ms`，即约 66 秒排队后又执行满 90 秒。
   - 当前超时从命令真正开始执行时计时，不包含排队期限，因此用户看到的是“排队时间 + 完整执行超时”。

推荐修复方向是：**将 DF-ISE 文本解析变成固定、版本化、标准库实现的 Python parser，并以一等、类型化 postprocess runner 调用；禁止模型为该场景动态生成 Tcl。与此同时拆分 SSH 流量通道、合并重复读取、由单一 SSE poller 向客户端扇出。**

## 2. 证据时间线

| 时间（UTC） | 事件 | 证据与判断 |
|---|---|---|
| 2026-06-28 | 初次同步 `.plt` 失败 | Session `job.log` 记录 `makedirs() got an unexpected keyword argument 'exist_ok'`；远端默认 Python 2，不支持 Python 3 的 `os.makedirs(..., exist_ok=True)`。随后同内容 `.txt` 文件同步成功。 |
| 2026-07-10 05:44:59 | 启动失败 run | `run_20260710T054459Z_utb28-step0005-full-extract_4ffce5`。 |
| 05:45–05:47 | SDE/SDevice 成功 | SDE exit 0；低漏压 SDevice exit 0；高漏压 SDevice exit 0。 |
| 05:47:24 | Inspect 后处理失败 | `extract_step0005.tcl` exit 1；stdout 为 `can't read "q"`；stderr 为空。 |
| 06:41:10 | 非图片产物发布失败 | `.plt` 被送入 image-only publish 路径，报 `artifactPath is not an image`。 |
| 06:53:45 | 启动后续重跑 | `run_20260710T065345Z_utb28-step0005-full-rerun-extract_136129`。 |
| 06:55:13 | 重跑进程状态成功 | 固定列号的纯 Tcl 文本解析退出 0，但输出 `status=partial`，`SS_high=NA`。 |
| 07:11:29 | CSV/metrics 发布仍走图片接口 | `idvg_curves_step0005.csv` 与 `idvg_metrics_step0005.txt` 再次报 `artifactPath is not an image`。 |

## 3. 失败 run 的实际命令和直接根因

### 3.1 Runner 命令

部署 worker 的 `sentaurus_command_for_step` 对 Inspect 返回：

```text
[inspect_path, "-batch", "-f", entry]
```

所以失败步骤的实际等价命令是：

```text
inspect -batch -f extract_step0005.tcl
```

`run_result.json` 中四个步骤为：

| 步骤 | 输入 | 退出码 | 时间 |
|---|---|---:|---:|
| SDE | `utb28_step0005_sde.cmd` | 0 | 18 s |
| SDevice low | `idvg_vd005_step0005.cmd` | 0 | 75 s |
| SDevice high | `idvg_vd105_step0005.cmd` | 0 | 44 s |
| Inspect | `extract_step0005.tcl` | 1 | 4 s |

### 3.2 Tcl 语法故障

失败脚本包含以下逻辑：

```tcl
proc read_curve {filename targetvd} {
  ...
  set q [string first "\n}" $body]
  if {$q < 0} { set q [string last "}" $body] }
  if {$q < 0} { error "Data block terminator not found in $filename" }
  ...
}
```

根因不是 `q` 的业务赋值分支，而是 Tcl 解析阶段：

- `proc` 的 body 是一个用 `{ ... }` 包裹的 braced word。
- 在 braced word 内，未转义花括号仍参与层级计数；双引号不提供保护。
- `"\n}"` 中的 `}` 使 `proc` body 提前闭合。
- 随后的 `if {$q < 0}` 在顶层执行，因此得到 `can't read "q": no such variable`。
- 紧接着的 `string last "}"` 同样包含未转义右花括号，即使修复第一处，仍有再次破坏结构的风险。

这解释了为什么错误表现为“变量未定义”，而不是更直观的 Data block 解析错误。

### 3.3 失败后的潜在第二故障

失败 run 同时生成：

- `idvg_vd005_step0005.plt`：2,877 bytes
- `idvg_vd105_step0005.plt`：2,877 bytes
- `drain_idvg_vd005_step0005.plt`：85,141 bytes
- `drain_idvg_vd105_step0005.plt`：47,964 bytes
- `gate_idvg_*.plt`：159,495 bytes

失败 Tcl 固定读取两个仅 2,877 bytes 的 master `.plt`，而实际扫描数据主要位于 `drain_idvg_*.plt`。因此即使花括号错误被修复，也很可能继续出现有效点不足或提取到启动阶段数据的问题。

文件选择必须依据 **dataset、实际偏压、Vg 覆盖范围和有效点数**，不能仅依据文件名。

## 4. 后续“成功”run 仍是语义不完整

后续 run `run_20260710T065345Z_utb28-step0005-full-rerun-extract_136129` 改用 Tcl 正则直接解析 DF-ISE，并产生 CSV 和 metrics。

进程输出：

```text
Extraction completed: status=partial
Vth_low=0.0929096210889 V, Vth_high=0.00497193902991 V
SS_low=83.4499918109 mV/dec, SS_high=NA mV/dec
DIBL=87.937682059 mV/V
```

问题有两层：

1. **runner 将 exit 0 直接标记为 run succeeded。**
   - `idvg_metrics_step0005.txt` 明确写入 `status=partial`。
   - 必需目标 `SS_high` 为 `NA`，但 `run_result.status` 仍是 `succeeded`。

2. **高漏压扫描不覆盖足够的亚阈值区域。**
   - high 曲线 `Vg=0` 时 `Ioff≈8.8554e-8 A/um`，已经接近 `1e-7 A/um` 阈值准则。
   - 当前 SS 算法要求在 `1e-13` 至 `1e-7 A/um` 内至少有足够点进行 7 点拟合。
   - 从 `Vg=0` 开始的 sweep 无法提供足够 high-Vd 亚阈值点，因此 `SS_high=NA` 是数据覆盖不足，不是 parser 应伪造或外推的值。

若必须得到 `Vd=1.05 V` 的 SS，需要将 gate sweep 起点扩展到负电压，例如从预检查估计的 `-0.2 V` 或更低开始，并由预检确认至少覆盖 1–2 个完整 decade；具体起点应通过轻量预扫或已有曲线确定，而不是硬编码。

## 5. 现有真实曲线与黄金指标

本地现有文件：

- `apps/server/data/runs/run_20260626163724_rDsE4Q/input/idvg_low.plt`
- `apps/server/data/runs/run_20260626163724_rDsE4Q/input/idvg_high.plt`

两个文件均为可直接读取的 DF-ISE 文本，dataset 数为 33。按 dataset 名称解析：

- `gate OuterVoltage`
- `drain OuterVoltage`
- `drain TotalCurrent`

使用以下确定性定义：

- 电流：`abs(drain TotalCurrent)`
- 同一 Vg 重复点：保留最大 `abs(Id)`
- Vth：`Id=1e-7 A/um`，在 `log10(Id)` 域线性插值
- SS：`1e-12` 至 `1e-7 A/um` 范围内最大相邻斜率的倒数
- DIBL：使用文件内实际 `Vd_high-Vd_low`

得到黄金值：

| 指标 | `idvg_low.plt` | `idvg_high.plt` |
|---|---:|---:|
| 实际 Vd | 0.05 V | **0.80 V** |
| 有效 Vg 点 | 108 | 109 |
| Vg 范围 | 0.0–1.0 V | 0.0–1.0 V |
| Id 范围 | `3.386217e-10`–`1.269878e-4 A/um` | `1.033227e-9`–`3.949897e-4 A/um` |
| Vth | `0.1783295491 V` | `0.1499588910 V` |
| SS | `71.56688061 mV/dec` | `74.78974888 mV/dec` |

使用实际偏压差 `0.80-0.05=0.75 V`：

```text
DIBL = 37.82754417 mV/V
```

这些值应成为 parser 的首组回归测试 oracle。

### 5.1 必须阻止的错误结果

以下行为必须被明确拒绝：

- 将实际 `Vd=0.80 V` 的 `idvg_high.plt` 标记成 `1.05 V`。
- 用 `1.05-0.05` 作为上述两个现有文件的 DIBL 分母。
- 在 high-Vd SS 数据窗口不足时返回 0、无穷或未经标记的外推值。
- 将 `status=partial` 的 metrics 当作完整成功。

## 6. 输入同步根因与兼容修复

Session 初期 `.plt` 同步失败的实际错误是：

```text
makedirs() got an unexpected keyword argument 'exist_ok'
```

根因是远端默认 `python` 为 Python 2，而同步脚本使用了 Python 3 API：

```python
os.makedirs(path, exist_ok=True)
```

随后 `.txt` 副本成功同步只是规避了路径，不代表 `.plt` 不可读。

最小兼容修复：

```python
if not os.path.isdir(path):
    try:
        os.makedirs(path)
    except OSError:
        if not os.path.isdir(path):
            raise
```

要求：

- 所有经 `python` 执行的远端辅助脚本必须兼容 Python 2.7/3，或显式探测并调用 `python3`。
- 不得根据扩展名改变通用目录创建逻辑。
- 同步完成后记录文件大小和 SHA-256；`.plt` 与临时 `.txt` 副本内容相同时只保留一个规范输入。
- 新 parser 直接接受 `.plt`，不再要求改后缀。

## 7. 目标架构：固定 Python DF-ISE Parser

### 7.1 核心原则

1. Parser 是仓库内受版本控制的固定程序，不由模型动态生成。
2. 只使用 Python 标准库，首版同时兼容 VM 当前 Python 2.7 和 Python 3。
3. 模型只能提交类型化参数，不能提交任意 Python/Tcl/shell。
4. 解析以 dataset 名称为主，固定 33 列仅作为经过格式签名校验的兼容 fallback。
5. 输出包含 provenance、算法版本、实际偏压和完整性状态。
6. 必需指标缺失时，runner 返回语义失败或 `incomplete`，不得返回成功。

### 7.2 建议新增固定模块

建议新增：

```text
apps/server/remote/dfise_idvg_extract.py
```

建议命令接口：

```text
python dfise_idvg_extract.py \
  --low idvg_low.plt \
  --high idvg_high.plt \
  --expected-low-vd 0.05 \
  --expected-high-vd 1.05 \
  --vth-current 1e-7 \
  --ss-current-min 1e-12 \
  --ss-current-max 1e-7 \
  --ss-method max-adjacent-v1 \
  --output-prefix idvg_step0005
```

这只是固定 runner 的内部命令，不向用户暴露任意命令执行能力。

### 7.3 Parser 流程

1. 读取 `Info { datasets = [...] }`。
2. 获取 dataset 数量并确定 record width。
3. 定位目标 Data block；允许空白、换行和 `D`/`E` 指数。
4. 校验数值总数可被 record width 整除。
5. 通过规范化名称解析 Vg、Vd、Id：
   - `gate OuterVoltage`
   - `drain OuterVoltage`
   - `drain TotalCurrent`
6. 若名称缺失，仅在文件格式签名与 33 列 profile 完全匹配时使用兼容列号。
7. 统计 Vd 分布，识别主扫描偏压。
8. 校验主偏压与请求 expected bias：
   - 容差内：继续。
   - 不一致：返回 `BIAS_MISMATCH`，报告实际偏压，不计算被错误标注的 DIBL。
9. 按 Vg 排序和去重；重复点保留最大 `abs(Id)`，同时记录重复数量。
10. 校验 Vg 单调范围、有效点数、Id 正值和 threshold/SS 覆盖。
11. 计算指标并输出完整性状态。

### 7.4 文件选择

候选文件不能只按名称决定，按以下顺序打分：

1. 用户明确上传的 `idvg_low.plt` / `idvg_high.plt`。
2. 与 expected Vd 匹配的 run artifact。
3. dataset 完整、有足够有效点、Vg 覆盖完整的 `drain_*.plt`。
4. master `.plt` 只有在有效点与覆盖校验通过时才可选。

每个候选至少验证：

- 文件可读且非空。
- dataset 存在。
- 主 Vd 与目标匹配。
- 有效 Vg 点不少于配置阈值，建议默认 20。
- Vg 覆盖 threshold 交叉点。
- SS 区间至少有算法要求的点数。

若多个文件均通过，报告选择理由、文件大小、SHA-256 和实际偏压。

## 8. 指标定义与版本控制

当前历史中至少出现两种 SS 定义：

1. Manifest：指定电流区间内的最大相邻斜率。
2. 后续 Tcl：7 点滑动线性拟合，要求 `R²>=0.97`。

两者会得到不同数值，不能在不修改版本号的情况下互换。

首版建议：

```text
metricProfile = tcad-idvg-v1
vthMethod = constant-current-log-interpolation-v1
ssMethod = max-adjacent-slope-v1
diblMethod = actual-drain-bias-difference-v1
```

算法：

- `Vth`：在第一次由下向上跨越 `1e-7 A/um` 的相邻点之间，对 `log10(Id)` 线性插值。
- `SS`：在 `[1e-12, 1e-7] A/um` 内计算正的相邻 `dlog10(Id)/dVg`，取最大值，`SS=1000/maxSlope`。
- `DIBL`：`1000*(Vth_low-Vth_high)/(actualVd_high-actualVd_low)`。

如业务决定改用滑动拟合，必须新增 `tcad-idvg-v2`，保留 v1 回归值和历史可重现性。

## 9. Runner 集成

### 9.1 类型化 postprocess

不建议把 Python 作为新的通用任意 runner tool。建议在 run request 中新增受限结构：

```json
{
  "postprocess": [
    {
      "kind": "dfise-idvg-v1",
      "lowInput": "idvg_low.plt",
      "highInput": "idvg_high.plt",
      "expectedLowVd": 0.05,
      "expectedHighVd": 1.05,
      "outputPrefix": "idvg_step0005"
    }
  ]
}
```

worker 根据 `kind` 调用固定 parser；请求中不存在脚本正文或命令行字段。

### 9.2 成功判定

run 的成功条件必须同时满足：

1. parser 进程 exit 0。
2. `metrics.status == "ok"`。
3. 必需字段 `Vth_low`、`Vth_high`、`SS_low`、`SS_high`、`DIBL` 均为有限数。
4. actual Vd 与 expected Vd 在容差内。
5. CSV 至少包含规定数量的数据行。
6. report、metrics、CSV 的输入 SHA-256 一致。

若 `SS_high` 因 sweep 覆盖不足：

- run 状态为 `incomplete` 或 `failed-postcondition`。
- 错误码为 `SS_WINDOW_NOT_COVERED`。
- 报告实际最低 Id、可用点数和建议扩展的 Vg 方向。
- auto-debug 可生成“调整 sweep 范围”的新 SDevice request，但不得修改 parser 或伪造值。

### 9.3 Auto-debug 边界

当前部署的 `is_recoverable_run_failure` 对 `can't read q` 理论上应返回 recoverable，因为该文本不在 nonrecoverable 列表内；历史消息却记录“failure was not considered safely recoverable”。这表明还需校验：

- 运行时 worker 版本与仓库生成模板是否一致。
- `first_failed_step` 是否稳定返回 Inspect 步骤。
- stdout-only 错误是否总能进入分类文本。
- worker 部署 hash 是否随 server build 记录。

固定 parser 上线后：

- parser 格式/输入错误由结构化错误码处理，不交给 LLM 改写 parser。
- auto-debug 只允许调整输入文件选择、expected bias 或 SDevice sweep。
- parser 自身异常视为服务缺陷，停止自动重试并报警。

## 10. 标准输出

固定输出：

```text
idvg_step0005_extracted.csv
ss_dibl_step0005_metrics.json
ss_dibl_step0005_metrics.dat
ss_dibl_step0005_report.txt
idvg_step0005_plot.png
```

### 10.1 合并 CSV

列：

```text
Vg_V,Id_low_A_per_um,Id_high_A_per_um,Vd_low_V,Vd_high_V
```

要求：

- Vg 升序。
- 不同曲线缺失点为空，不用 0 填补。
- 数值使用稳定科学计数法。
- 元数据不混入数据行。

### 10.2 Metrics JSON

至少包含：

```json
{
  "status": "ok",
  "metricProfile": "tcad-idvg-v1",
  "extractorVersion": "dfise-idvg-extract/1",
  "inputs": {
    "low": {"path": "...", "sha256": "...", "actualVd": 0.05},
    "high": {"path": "...", "sha256": "...", "actualVd": 0.8}
  },
  "parameters": {
    "vthCurrentAperUm": 1e-7,
    "ssCurrentMinAperUm": 1e-12,
    "ssCurrentMaxAperUm": 1e-7
  },
  "metrics": {
    "vthLowV": 0.1783295491,
    "vthHighV": 0.1499588910,
    "ssLowMvPerDec": 71.56688061,
    "ssHighMvPerDec": 74.78974888,
    "diblMvPerV": 37.82754417
  },
  "warnings": []
}
```

当 expected high Vd 为 1.05 而实际为 0.8 时，状态必须为 `invalid-input`，并包含 `BIAS_MISMATCH`；上例数值仅用于 actual-bias 分析和回归测试，不可冒充 1.05 V 结果。

### 10.3 发布路径

- PNG/SVG 使用 image publish。
- CSV、JSON、DAT、TXT、PLT 使用通用文件附件/下载路径。
- artifact publish API 在入参阶段按 MIME/扩展名分流，禁止把非图片送入 image-only API。

## 11. 长期记忆与模型上下文接入

不能把这次经验仅写成一条聊天回复。需要以版本化能力规则接入 worker 上下文。

建议新增规则：

```text
ruleId: dfise-plt-postprocess-v1
```

规则内容：

1. 对可读 DF-ISE `.plt` 参数提取，默认调用固定 `dfise-idvg-v1` postprocess。
2. 不生成 Inspect `cv_*` 脚本。
3. 不在 Inspect 中动态生成 Tcl 文本 parser。
4. 必须读取 actual Vd，不相信文件名或旧 manifest。
5. 必须在 required metrics 完整后才宣称成功。
6. 非图片结果使用文件附件路径。

接入位置：

- `apps/server/src/services/vmAgent.ts` 构建 LLM context 的固定能力说明。
- 现有 `[Same-session durable context summary]` 继续记录本 session 的具体偏压和 extractor 结果，但不能覆盖系统能力规则。
- `simulationSetup` 增加 `extractorVersion`、`metricProfile`、input hashes、actual biases 和结果状态。
- worker 启动或部署时记录 capability rule 版本与 worker SHA-256，便于审计版本漂移。

## 12. SSH 队列治理

### 12.1 当前数据流

目前以下操作最终进入同一个模块级 `sshQueue`：

- history：`getVmAgentMessages`，默认执行超时 45 秒。
- status：`getVmAgentStatus`，虽然调用 Fast 版本，仍进入同一个 queue。
- session files：`listVmSessionFiles`，执行超时 90 秒。
- artifact 下载/发布。
- SSE：服务端每个连接每秒执行一次 history 读取。
- Web fallback：EventSource 外仍有 history 增量轮询和选中 session history 轮询。

此外 `runSshCommandWithInputInternal` 先执行 SCP，再进入 SSH queue，意味着 queue 堵塞时仍可能同时产生多次 SCP。

### 12.2 最小治理方案

将单一队列拆为四条 lane：

| Lane | 内容 | 并发 | 优先级 |
|---|---|---:|---:|
| `interactive` | send、worker 控制、明确用户动作 | 1 | 最高 |
| `status` | VM/agent status | 1，强制合并 | 高 |
| `history` | 增量 history、SSE 后端 poller | 1，按 cursor/session 合并 | 中 |
| `files` | files list、artifact 下载、完整 history | 1–2 | 低 |

关键规则：

- 整个 SCP + SSH 事务必须进入同一 lane，不能在排队前先 SCP。
- 每个任务同时具有 `queueDeadlineMs` 和 `executionTimeoutMs`。
- queue deadline 到期立即返回 `VM_SSH_QUEUE_TIMEOUT`，不再等待完整执行超时。
- 同 key 请求 single-flight：
  - status：全局一个进行中的请求，缓存 2–5 秒。
  - session history：`sessionId + cursor + limit`。
  - files：`sessionId`，缓存 5–15 秒。
- 客户端断开后通过 `AbortSignal` 取消尚未开始的任务，并终止已无消费者的 SSH。
- 记录 `enqueuedAt`、`startedAt`、`queueWaitMs`、`executionMs`、lane、dedupe key。

### 12.3 SSE 改造

当前每个 SSE 客户端独立触发 SSH history 读取，客户端数量会线性放大 VM 请求。

改为：

1. 服务端仅维护一个增量 history poller。
2. poller 按全局 cursor 读取一次 VM。
3. 新消息进入内存 ring buffer。
4. 向所有 SSE 客户端扇出。
5. 新客户端用 `Last-Event-ID` 或 cursor 从 ring buffer 补发。
6. ring buffer 不足时才进入低优先级 full-history lane。

Web 端：

- EventSource 正常时停止增量 HTTP 轮询。
- EventSource 断开后使用指数退避 fallback，不每秒固定重试。
- 选中 session 的 full history 在 session 未变化时不重复请求。
- files 请求使用 single-flight，切换 session 时取消旧请求。

### 12.4 建议默认期限

| 操作 | Queue deadline | Execution timeout |
|---|---:|---:|
| status | 1 s | 6 s |
| send/interactive | 5 s | 20 s |
| incremental history | 2 s | 10 s |
| selected session history | 10 s | 45 s |
| files list | 10 s | 45 s |
| artifact download | 20 s | 90 s |

达到 queue deadline 时应返回明确的 429/503 和可重试提示，而不是挂起 50–180 秒。

## 13. 涉及文件与函数清单

以下均为后续实施范围，本次未修改：

| 文件 | 函数/区域 | 计划修改 |
|---|---|---|
| `apps/server/src/services/vmAgent.ts` | `sentaurus_command_for_step`、`run_step` | 增加固定、类型化 postprocess 调用；不开放任意 Python。 |
| `apps/server/src/services/vmAgent.ts` | `collect_run_artifacts` | 纳入 metrics JSON、PNG 和 extractor diagnostics；保留非图片文件类型。 |
| `apps/server/src/services/vmAgent.ts` | `is_recoverable_run_failure`、`run_with_autodebug` | 使用结构化 postprocess 错误；验证 stdout-only 错误；禁止 LLM 修改固定 parser。 |
| `apps/server/src/services/vmAgent.ts` | LLM context / durable context | 注入 `dfise-plt-postprocess-v1` 固定规则和 extractor version。 |
| `apps/server/src/services/vmAgent.ts` | session input/setup 同步 | 移除 Python 3-only `exist_ok` 用法；记录 input hash、actual Vd。 |
| `apps/server/remote/dfise_idvg_extract.py` | 新固定模块 | DF-ISE parser、指标计算、输出和错误码。 |
| `packages/shared/src/index.ts` | run/postprocess 类型 | 增加 `DfiseIdvgPostprocessRequest/Result` 与结构化错误。 |
| `apps/server/src/services/sshClient.ts` | `sshQueue`、`runSsh`、`runSshCommandWithInputInternal` | 改为分 lane 调度、queue deadline、single-flight、AbortSignal；SCP 纳入队列。 |
| `apps/server/src/services/vmSessionFiles.ts` | `runRemoteSessionScript` / files list | 使用 files lane、缓存和取消。 |
| `apps/server/src/routes/vmAgent.ts` | status、history、files、SSE route | 单 poller SSE 扇出；返回队列错误码和 timing headers。 |
| `apps/web/src/App.tsx` | EventSource、history/files/status effects | 避免 SSE 与轮询并发；请求去重和取消。 |
| `.env.example` | VM/SSH 配置 | 增加各 lane queue deadline、缓存 TTL、并发配置。 |

## 14. 最小实施顺序

### Phase 0：恢复当前 session 结果

1. 用固定 parser 读取现有 `idvg_low.plt` 和 `idvg_high.plt`。
2. 输出 actual-bias 报告，明确 high 为 0.80 V。
3. 生成 actual-bias 黄金 CSV/metrics/report。
4. 若目标必须是 1.05 V，拒绝将 0.80 V 数据冒充目标；使用后续 1.05 V run，并因 `SS_high` 数据覆盖不足返回 incomplete。

### Phase 1：固定 parser 与输出契约

1. 新增双版本兼容的标准库 parser。
2. 建立黄金文件单测。
3. 建立指标 profile 和结构化错误码。
4. 建立 CSV/JSON/DAT/TXT/PNG 输出。
5. 将 `status=partial` 作为非成功。

### Phase 2：类型化 runner

1. 扩展 shared run schema。
2. worker staging 固定 parser，并校验 SHA-256/version。
3. postprocess request 只包含受限参数。
4. auto-debug 只调整输入选择和 sweep，不改 parser。
5. 修复 input sync 的 Python 2 兼容性。

### Phase 3：附件与长期规则

1. 图片和通用文件发布分流。
2. 注入 `dfise-plt-postprocess-v1` 能力规则。
3. session setup 保存 extractor/metric profile/provenance。
4. 审计日志记录 semantic status。

### Phase 4：SSH 调度

1. 引入 lane scheduler 和 queue deadline。
2. 将 SCP 纳入完整事务。
3. status/history/files single-flight。
4. SSE 单 poller + fan-out。
5. Web 端停止重复轮询并支持取消。

## 15. 迁移与兼容

- 历史 `.plt`、run 目录和 `messages.jsonl` 不做重写。
- 旧 run request 的 `sde/sprocess/sdevice/inspect` 仍可执行。
- 新 DF-ISE postprocess 默认使用新类型化结构；旧 Inspect 提取不自动转换，但 UI 可提供“用固定 parser 重新提取”动作。
- 历史 metrics 不覆盖；新结果写入新 run 或带 extractor version 的新 artifact。
- DIBL 必须绑定 actual biases；旧报告缺少 actual Vd 时标记 `legacy-unverified`。
- SS 历史定义保持可查；新报告必须写明 `metricProfile`。
- VM 仍只有 Python 2 时使用双兼容 parser；未来切换 Python 3 不改变输出格式和黄金值。
- SSH lane 上线可用 feature flag 灰度；关闭时保留旧队列作为短期回退，但不得长期保留 per-client SSE SSH 轮询。

## 16. 测试矩阵

### 16.1 Parser 与指标

| ID | 场景 | 预期 |
|---|---|---|
| P01 | 现有 `idvg_low.plt` | 33 列、108 点、Vd=0.05 V。 |
| P02 | 现有 `idvg_high.plt` | 33 列、109 点、Vd=0.80 V。 |
| P03 | 黄金 Vth | low `0.1783295491 V`，high `0.1499588910 V`。 |
| P04 | 黄金 SS | low `71.56688061`，high `74.78974888 mV/dec`。 |
| P05 | 黄金 DIBL | actual-bias DIBL `37.82754417 mV/V`。 |
| P06 | expected high Vd=1.05，实际 0.80 | `BIAS_MISMATCH`，不得输出标记为 1.05 V 的 DIBL。 |
| P07 | `D` 指数 | 与 `E` 指数数值一致。 |
| P08 | dataset 顺序变化 | 仍按名称正确解析。 |
| P09 | dataset 名称缺失、33 列签名匹配 | 使用受控 fallback，并产生 warning。 |
| P10 | 数值数量不能整除 width | `MALFORMED_DATA_BLOCK`。 |
| P11 | 重复 Vg | 保留最大 `abs(Id)`，记录 duplicate count。 |
| P12 | 无 Vth crossing | `VTH_NOT_COVERED`，不得外推。 |
| P13 | SS 点不足 | `SS_WINDOW_NOT_COVERED`。 |
| P14 | 多个 Data block | 依据 schema/有效点选择目标 block，并记录选择。 |
| P15 | master `.plt` 仅少量启动点，drain 文件完整 | 选择 drain 文件。 |
| P16 | Python 2.7 与 Python 3 | 输出 JSON/CSV hash 一致。 |

### 16.2 Runner 与输出

| ID | 场景 | 预期 |
|---|---|---|
| R01 | parser exit 0、全部指标完整 | run `succeeded`。 |
| R02 | parser exit 0、`SS_high=NA` | run `incomplete/failed-postcondition`，不能 succeeded。 |
| R03 | parser 非零退出 | 保留 stdout/stderr、结构化 error code。 |
| R04 | CSV/metrics/report 生成 | 文件存在、非空、input hash 一致。 |
| R05 | 发布 CSV/TXT/PLT | 使用通用文件路径，无 `artifactPath is not an image`。 |
| R06 | 发布 PNG | 使用 image publish，可预览。 |
| R07 | auto-debug 收到 `SS_WINDOW_NOT_COVERED` | 建议扩展 Vg sweep，不修改 parser。 |
| R08 | worker/parser version 不匹配 | 拒绝执行并记录部署漂移。 |

### 16.3 输入同步

| ID | 场景 | 预期 |
|---|---|---|
| I01 | 远端 Python 2 | 创建目录和同步 `.plt` 成功。 |
| I02 | 目录并发创建 | 不因已存在而失败。 |
| I03 | `.plt` 与 `.txt` 内容相同 | 识别重复，使用规范 `.plt`。 |
| I04 | 上传后 hash 不一致 | 同步失败，不进入提取。 |

### 16.4 SSH 队列与 SSE

| ID | 场景 | 预期 |
|---|---|---|
| Q01 | files 执行 90 秒，同时请求 status | status 不排在 files 后，p95 小于 3 秒。 |
| Q02 | 10 个 SSE 客户端 | VM 端仅一个 history poller。 |
| Q03 | 相同 session files 并发 20 次 | 只执行一次 SSH，其余共享结果。 |
| Q04 | 相同 history cursor 并发 | single-flight。 |
| Q05 | 用户切换 session | 旧 files/history 请求被取消。 |
| Q06 | queue deadline 超时 | 5–10 秒内返回 `VM_SSH_QUEUE_TIMEOUT`，不等待 90 秒。 |
| Q07 | SCP 较慢 | 后续同 lane 任务可观测排队，SCP 不形成无界并发。 |
| Q08 | SSE 断线重连 | 使用 cursor/ring buffer 补发，不触发 full history 风暴。 |
| Q09 | 外部 origin 多标签页 | 请求数不随标签页和 SSE 客户端线性放大。 |

## 17. 验收标准

### 17.1 参数提取

- 对现有两个黄金文件，结果满足：
  - `Vth_low = 0.1783295491 V ± 1e-6 V`
  - `Vth_high = 0.1499588910 V ± 1e-6 V`
  - `SS_low = 71.56688061 ± 0.01 mV/dec`
  - `SS_high = 74.78974888 ± 0.01 mV/dec`
  - `DIBL_actual = 37.82754417 ± 0.01 mV/V`
- 报告明确 high 文件实际为 `Vd=0.80 V`。
- 当 expected high Vd 为 1.05 V 时，返回 `BIAS_MISMATCH`，不产生误标 DIBL。
- 所有必需指标非有限数或缺失时，run 不得标记 succeeded。
- parser 代码不由 LLM 生成；相同输入和 profile 的输出可重现。
- CSV、metrics、report 和 plot 均可下载；非图片不会进入 image publish。

### 17.2 输入与兼容

- VM 默认 Python 2 时 `.plt` 上传和目录创建成功。
- 输入同步后记录大小和 SHA-256。
- parser 在 Python 2.7/3 上对黄金文件产生一致结果。
- 历史 run、消息和 artifact 保持可读。

### 17.3 SSH 与外部访问

- status p95 `<3 s`，且不受 90 秒 files 操作阻塞。
- 增量 SSE 消息端到端 p95 `<2 s`。
- warm session history p95 `<5 s`；cold full history p95 `<30 s`。
- files list p95 `<10 s`；重型下载不阻塞 status/send/history。
- 任一请求 queue wait 超过配置 deadline 后立即失败并返回可识别错误，不出现 50–180 秒无反馈等待。
- 10 个并发 SSE 客户端只产生一个 VM history poller。
- 日志可区分 `queueWaitMs` 与 `executionMs`，可按 lane 统计 p50/p95/p99。

## 18. Definition of Done

只有同时满足以下条件才算完成：

1. 固定 Python DF-ISE parser 和黄金测试合入。
2. 现有 local low/high 文件通过全部黄金断言。
3. 1.05 V 偏压不匹配被正确拒绝。
4. high-Vd SS 覆盖不足被判定为 incomplete，而不是成功。
5. postprocess 使用类型化 request，不执行模型生成脚本。
6. input sync 在 Python 2 VM 上通过。
7. CSV/TXT/PLT 使用通用文件发布路径。
8. 长期能力规则进入固定 worker context，并带版本号。
9. SSH lane、single-flight、queue deadline、SSE fan-out 完成。
10. 并发和外部访问验收达到上述时延目标，且没有未解释的 50–180 秒排队。

