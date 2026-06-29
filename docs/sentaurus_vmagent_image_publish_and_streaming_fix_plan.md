# Sentaurus VM Agent 图片直出与逐条消息流修复方案

## 1. 目标

本方案交给下游 agent 实施，解决两个用户可见问题：

1. VM agent 生成或引用图片时，聊天栏应直接显示图片缩略图，而不是显示普通文本协议块。
2. VM agent 的思考、进度和回复应尽早逐条进入聊天栏，而不是等整轮处理完成后把多条内容集中塞进一个聊天气泡或一次性刷新出来。

当前问题不是 VM/SSH 不通。`/api/vm/agent/messages` 能拿到消息，VM agent worker 也在运行。问题在消息发布协议和前端显示策略。

## 2. 当前已确认现象

用户询问图片后，后端返回的 agent 消息中包含：

```text
<VM_SESSION_FILE>{"category":"器件结构图","name":"utb28nm_B_structure_test.png","sourcePath":"/home/TCAD2022/STDB/web-agent-runs/run_20260628T175054Z_utb28nm-schemeb-optimized-structure-and-idvg_c7e37b/utb28nm_B_structure_test.png"}</VM_SESSION_FILE>
```

但该消息只有普通 `content`，没有 `attachments` 字段。

前端聊天栏当前只会渲染：

- `message.attachments`
- 或从 `message.meta.vmRunArtifactsJson` 解析出的 run artifacts

因此 `<VM_SESSION_FILE>` 作为普通文本出现时，前端不会显示图片。

同时，当前前端会过滤掉 progress/thinking 消息，不把它们作为普通聊天气泡展示：

```ts
const visibleMessages = currentMessages.filter(
  (message) => !isProgressMessage(message) && !isThinkingMessage(message)
);
```

这些消息只进入 progress panel / thinking panel。用户期望的是聊天栏内也能及时看到 agent 的过程输出和最终输出。

## 3. 根因

### 3.1 图片没有直出

当前代码中已经有附件类型和图片渲染能力：

- `packages/shared/src/index.ts`
  - `VmAgentMessage.attachments?: VmAgentMessageAttachment[]`
  - `VmAgentMessageAttachment.kind: "file" | "image"`
- `apps/web/src/App.tsx`
  - `renderImagePreview(...)`
  - `message.attachments` 渲染
  - `vmRunArtifactDownloadUrl(...)`
  - `vmSessionFileDownloadUrl(...)`
- `apps/server/src/routes/vmAgent.ts`
  - VM session file download endpoint
  - VM run artifact download endpoint
- `apps/server/src/services/vmAgent.ts`
  - `append_message(..., display_attachments=None)`
  - `display_attachments_for_artifacts(...)`

但缺失关键链路：

1. VM agent 输出 `<VM_SESSION_FILE>{...}</VM_SESSION_FILE>` 后，没有解析该协议块。
2. 没有把 `sourcePath` 复制/同步到当前 session output。
3. 没有把它转换成 `VmAgentMessageAttachment`。
4. 没有从用户可见文本中移除该协议块。

所以前端只看到文本，不知道这是一个图片附件。

### 3.2 回复集中出现

VM worker 实际会往 `messages.jsonl` 写入 progress/thinking 消息：

- `append_progress(...)`
- `append_thinking(...)`
- 最终 `append_message("agent", reply, ...)`

后端 SSE 当前每 2 秒轮询一次：

```ts
const result = await getVmAgentMessages(cursor);
if (result.messages.length > 0) {
  send("messages", result);
}
```

但前端聊天栏过滤掉 thinking/progress，只显示最终 agent 消息。于是用户视觉上会觉得 agent 等很久后一次性输出。

## 4. 设计原则

1. 不把图片二进制 base64 内联进聊天消息 JSON。
2. 图片文件仍保存在 VM 文件系统，通过现有受保护下载接口访问。
3. 机器人控制协议块应从用户可见文本中剥离。
4. 后端/VM worker 负责把协议块转换为结构化 `attachments`。
5. 聊天栏应显示短的过程消息，但不能泄露真实私密 chain-of-thought。
6. 当前 `agent_thinking` 内容本身是阶段摘要，不是真实模型隐藏思维链，可以作为“状态/过程消息”展示。
7. 保留 progress panel / thinking panel，但聊天栏也应有轻量逐条可见消息。

## 5. 图片直出修复方案

### 5.1 支持 VM_SESSION_FILE 协议

在 VM worker 的远端 Python 脚本中增加协议解析。

位置：

```text
apps/server/src/services/vmAgent.ts
```

重点修改嵌入的 `remoteWorkerScript`。

新增函数：

```python
def extract_vm_session_files(reply):
    start_tag = "<VM_SESSION_FILE>"
    end_tag = "</VM_SESSION_FILE>"
    specs = []
    visible = reply
    while True:
        start = visible.find(start_tag)
        end = visible.find(end_tag, start + len(start_tag)) if start >= 0 else -1
        if start < 0 or end < 0:
            break
        body = visible[start + len(start_tag):end].strip()
        try:
            payload = json.loads(body)
            if isinstance(payload, dict):
                specs.append(payload)
        except Exception as exc:
            audit("vm_session_file_parse_failed", {"error": safe_text(str(exc), 400), "body": safe_text(body, 500)})
        visible = (visible[:start] + visible[end + len(end_tag):]).strip()
    return specs, visible
```

### 5.2 分类映射

当前 shared 里的 session output categories 是中文乱码形式，运行接口返回实际中文：

```text
我的输入
仿真结果文件
仿真日志文件
仿真参数文件
其它文件
```

用户这次的协议里用了：

```text
器件结构图
```

这不是允许分类。必须做映射：

```python
OUTPUT_CATEGORY_RESULTS = u"仿真结果文件"
OUTPUT_CATEGORY_OTHER = u"其它文件"

def normalize_session_file_category(value):
    value = safe_text(value, 120).strip()
    aliases = {
        u"器件结构图": OUTPUT_CATEGORY_RESULTS,
        u"结构图": OUTPUT_CATEGORY_RESULTS,
        u"图片": OUTPUT_CATEGORY_RESULTS,
        u"图像": OUTPUT_CATEGORY_RESULTS,
        u"仿真图片": OUTPUT_CATEGORY_RESULTS,
        u"simulation image": OUTPUT_CATEGORY_RESULTS,
        u"device structure": OUTPUT_CATEGORY_RESULTS,
    }
    if value in OUTPUT_CATEGORIES:
        return value
    lowered = value.lower()
    if lowered in aliases:
        return aliases[lowered]
    return aliases.get(value, OUTPUT_CATEGORY_RESULTS)
```

注意：项目里已有中文常量可能因编码显示为乱码。下游实现时必须确认 `packages/shared/src/index.ts` 和 `vmSessionFiles.ts` 的真实 UTF-8 内容，并避免继续引入乱码。

### 5.3 安全复制 sourcePath 到 session output

新增函数把 VM 里的 `sourcePath` 复制到：

```text
~/STDB/web-agent-sessions/<sessionId>/output/<category>/<name>
```

伪代码：

```python
IMAGE_EXTENSIONS = set([".png", ".jpg", ".jpeg", ".webp", ".gif"])

def safe_source_path(path):
    path = safe_text(path, 1200).strip()
    if not path.startswith(os.path.join(HOME, "STDB") + os.sep):
        raise ValueError("sourcePath must stay under ~/STDB")
    if not os.path.isfile(path):
        raise ValueError("sourcePath does not exist")
    ext = os.path.splitext(path)[1].lower()
    if ext not in IMAGE_EXTENSIONS:
        raise ValueError("VM_SESSION_FILE only supports image files for chat preview")
    return path

def publish_vm_session_file(session_id, spec):
    if not session_id:
        raise ValueError("sessionId is required to publish a VM session file")
    source = safe_source_path(spec.get("sourcePath") or "")
    name = safe_file_name(spec.get("name") or os.path.basename(source))
    ext = os.path.splitext(name)[1].lower()
    if ext not in IMAGE_EXTENSIONS:
        raise ValueError("published file name must be an image")
    category = normalize_session_file_category(spec.get("category"))
    category_dir = os.path.join(SESSION_OUTPUT_ROOT, session_id, "output", category)
    ensure_dir(category_dir)
    target = os.path.abspath(os.path.join(category_dir, name))
    if not target.startswith(os.path.abspath(category_dir) + os.sep):
        raise ValueError("published file escapes output category")
    shutil.copy2(source, target)
    size = os.path.getsize(target)
    return {
        "id": ("vm_session_%s_%s_%s" % (session_id, category, name)).replace("/", "_").replace(" ", "_"),
        "kind": "image",
        "name": name,
        "size": size,
        "contentType": content_type_for_ext(ext),
        "source": "vm-session-file",
        "path": name,
        "runId": session_id,
        "category": category,
    }
```

### 5.4 在 process_queue_file 中接入

在 `reply_for(...)` 之后，现有流程大致为：

```python
reply, meta = reply_for(...)
simulation_setup, setup_visible_reply = extract_json_tag(reply, "SIMULATION_SETUP")
run_request, visible_reply = extract_run_request(setup_visible_reply)
...
append_message("agent", reply, "vm-agent-worker", meta, None, display_attachments)
```

应改为：

```python
reply, meta = reply_for(...)

published_file_specs, reply_without_files = extract_vm_session_files(reply)
published_display_attachments = []
for spec in published_file_specs:
    try:
        published_display_attachments.append(publish_vm_session_file(session_id, spec))
    except Exception as exc:
        append_progress(session_id, "attachment_publish", "failed", "Failed to publish image: %s" % safe_text(str(exc), 300), 100)
        audit("vm_session_file_publish_failed", {"sessionId": session_id, "error": safe_text(str(exc), 500), "spec": spec})

simulation_setup, setup_visible_reply = extract_json_tag(reply_without_files, "SIMULATION_SETUP")
run_request, visible_reply = extract_run_request(setup_visible_reply)
```

最终写消息时：

```python
display_attachments = published_display_attachments + display_attachments
append_message("agent", visible_reply_or_reply, "vm-agent-worker", meta, None, display_attachments)
```

要求：

- 用户可见 `content` 中不能再包含 `<VM_SESSION_FILE>...`。
- 成功发布的图片必须进入 `message.attachments`。
- 如果只有图片没有说明文本，给一个简短文本，例如：`已生成图片。`

### 5.5 同步前端显示

前端已有渲染 `message.attachments` 的逻辑：

```text
apps/web/src/App.tsx
```

关键位置：

```ts
const allDisplayAttachments = message.attachments?.length ? message.attachments : optimisticAttachments;
```

只要后端返回的消息中有：

```json
"attachments": [
  {
    "kind": "image",
    "source": "vm-session-file",
    "runId": "run_20260626163724_rDsE4Q",
    "category": "仿真结果文件",
    "path": "utb28nm_B_structure_test.png",
    "name": "utb28nm_B_structure_test.png",
    "contentType": "image/png"
  }
]
```

前端应可通过：

```ts
vmSessionFileDownloadUrl(attachment.runId, attachment.category, attachment.path)
```

显示图片。

### 5.6 VM agent 提示词约束

更新 VM worker system prompt，明确：

- 当需要发布现有 VM 图片时，输出 `<VM_SESSION_FILE>` 块。
- 但不要告诉用户“已经发布”除非 `sourcePath` 是真实存在的文件。
- `category` 优先用 `仿真结果文件`，不要使用未注册分类。
- 生成结构图应优先复制/发布 `.png`、`.jpg`、`.webp`、`.gif`。

更好的做法是让 worker 内部支持发布块，而不是依赖模型理解前端协议。

## 6. 聊天栏逐条显示修复方案

### 6.1 当前行为

VM worker 已经写入多条消息：

- `progress`
- `agent_thinking`
- 最终 `agent`

但前端聊天栏过滤了 progress/thinking：

```ts
const visibleMessages = currentMessages.filter((message) => !isProgressMessage(message) && !isThinkingMessage(message));
```

所以聊天栏只看到最终回复。

### 6.2 推荐 UX

不要把底层真实 chain-of-thought 暴露给用户。当前 `agent_thinking` 是人工写入的阶段摘要，可以作为“状态消息”显示。建议改成：

- `progress`：聊天栏显示精简状态气泡，例如 `Context / running: Building session history...`
- `agent_thinking`：聊天栏显示精简过程气泡，例如 `VM is calling the local model...`
- `agent`：聊天栏显示最终回复。

如果担心太吵：

- 默认只显示重要阶段：`received`、`llm`、`execution`、`sentaurus_step`、`attachment_publish`、`final`、`reply`
- 或把 progress/thinking 气泡做成 compact 样式。

### 6.3 前端方案 A：最小改动

修改：

```text
apps/web/src/App.tsx
```

把：

```ts
const visibleMessages = useMemo(() => currentMessages.filter((message) => !isProgressMessage(message) && !isThinkingMessage(message)), [currentMessages]);
```

改为：

```ts
function isChatVisibleStatusMessage(message: VmAgentMessage): boolean {
  if (isProgressMessage(message)) {
    const stage = typeof message.meta?.progressStage === "string" ? message.meta.progressStage : "";
    return ["received", "llm", "execution", "sentaurus_step", "attachment_publish", "final", "reply", "worker"].includes(stage);
  }
  if (isThinkingMessage(message)) {
    const stage = typeof message.meta?.thinkingStage === "string" ? message.meta.thinkingStage : "";
    return ["received", "context", "llm", "validation", "execution", "complete"].includes(stage);
  }
  return true;
}

const visibleMessages = useMemo(
  () => currentMessages.filter(isChatVisibleStatusMessage),
  [currentMessages]
);
```

然后在 message render 中对 status 类消息做更紧凑样式：

```tsx
const statusMessage = isProgressMessage(message) || isThinkingMessage(message);
<article className={`message-row ${message.role} ${statusMessage ? "status-message" : ""}`} ...>
```

显示内容可以用 helper 生成：

```ts
function displayContentForMessage(message: VmAgentMessage): string {
  if (isProgressMessage(message)) {
    const stage = metaString(message, "progressStage") || "progress";
    const status = metaString(message, "progressStatus") || "running";
    const detail = metaString(message, "progressDetail") || message.content;
    return `${progressLabel(stage)} / ${status}: ${detail}`;
  }
  if (isThinkingMessage(message)) {
    const stage = metaString(message, "thinkingStage") || "working";
    const status = metaString(message, "thinkingStatus") || "running";
    return `${thinkingStageLabel(message)} / ${status}: ${message.content}`;
  }
  return message.content;
}
```

渲染时把：

```ts
const content = messageDisplayOverrides[message.id] ?? message.content;
```

改成：

```ts
const content = messageDisplayOverrides[message.id] ?? displayContentForMessage(message);
```

### 6.4 前端方案 B：更好的视觉

如果下游 agent 有时间，建议添加单独样式：

```css
.message-row.status-message .message-bubble {
  opacity: 0.84;
  padding-block: 6px;
}

.message-row.status-message .message-content {
  font-size: 12px;
  line-height: 1.35;
}
```

头像可以显示：

- progress: `Run`
- thinking: `VM`
- system errors: `Sys`

但不要做大改版。

### 6.5 SSE 后端优化

当前 SSE 每 2 秒轮询一次，虽然不是“等整个回复完成”，但可能显得慢。可以把 interval 调到 500-1000ms：

```ts
const interval = setInterval(() => void tick(), 1000);
```

如果想更实时，需要 worker 主动推送，改动较大，不建议本次做。

建议本次只把 2000ms 改为 1000ms，降低等待感。

### 6.6 防止同一气泡里堆太多文本

最终 agent 消息本身仍可能包含多段文字。下游 agent 可选择实现 `split_agent_reply`，但优先级低于前端显示 progress/thinking。

如果要切分最终回复：

- 只按双换行切分非常短的段落可能破坏代码块和 XML/JSON 块。
- 不建议本次切最终回复文本。
- 重点是让状态消息和附件先出现，而不是强拆最终文本。

## 7. 后端返回验证

修复后，请求：

```powershell
$token = (Get-Content E:\VSCode\Sentaurus-agent\.env | Where-Object { $_ -match '^AUTH_TOKEN=' } | Select-Object -First 1) -replace '^AUTH_TOKEN=',''
curl -H "Authorization: Bearer $token" "http://10.6.22.1:5175/api/vm/agent/messages?after=0&limit=20&sessionId=run_20260626163724_rDsE4Q"
```

预期最新图片消息类似：

```json
{
  "role": "agent",
  "content": "已生成图片。",
  "attachments": [
    {
      "kind": "image",
      "source": "vm-session-file",
      "runId": "run_20260626163724_rDsE4Q",
      "category": "仿真结果文件",
      "path": "utb28nm_B_structure_test.png",
      "name": "utb28nm_B_structure_test.png",
      "contentType": "image/png"
    }
  ]
}
```

并且 `content` 不再包含：

```text
<VM_SESSION_FILE>
```

## 8. 前端验收

### 8.1 图片直出

在 Web UI 中向 VM agent 请求：

```text
把 Scheme B 的结构图发到聊天栏
```

预期：

- agent 消息气泡里出现图片缩略图。
- 点击缩略图打开 lightbox。
- Download 链接可下载图片。
- 刷新页面后图片仍显示。
- 消息文本中不再显示 `<VM_SESSION_FILE>{...}</VM_SESSION_FILE>`。

### 8.2 逐条消息

发送一个需要调用 LLM 或执行仿真的请求。

预期：

- 聊天栏先出现 received/context/llm 等状态消息。
- 如果执行 Sentaurus，聊天栏逐步出现 runner/sentaurus_step/artifacts/final 等状态。
- 最终 agent 回复作为最后一个正式回复出现。
- 不再表现为长时间无输出后一次性出现所有内容。

## 9. 必须修改的文件

优先修改：

```text
apps/server/src/services/vmAgent.ts
apps/web/src/App.tsx
apps/server/src/routes/vmAgent.ts
```

可能需要修改：

```text
packages/shared/src/index.ts
apps/web/src/styles.css
```

目前 shared 类型已经有 `attachments?: VmAgentMessageAttachment[]`，如果实现时发现 dist 不一致，需要重新 build shared。

## 10. 不建议本次修改

不建议本次做：

- 新增数据库。
- 把图片 base64 放进消息 JSON。
- 大改 SSE 为真正 websocket。
- 拆分最终回复文本里的代码块。
- 支持 SVG 内联显示。
- 让模型输出真实隐藏 chain-of-thought。

## 11. 回归测试命令

```powershell
cd E:\VSCode\Sentaurus-agent
npm run typecheck
npm run build
npm run dev:ensure
npm run dev:status
```

如果 build 成功但 VM worker 仍跑旧脚本，调用：

```powershell
$token = (Get-Content .env | Where-Object { $_ -match '^AUTH_TOKEN=' } | Select-Object -First 1) -replace '^AUTH_TOKEN=',''
curl -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d "{}" http://10.6.22.1:5175/api/vm/agent/connect
```

注意：`connect` 会重写 VM 侧 worker 文件并重启 worker，确保远端 Python 脚本更新生效。

## 12. 交付标准

下游 agent 完成后应提供：

1. 一条包含 `attachments[0].kind === "image"` 的 `/api/vm/agent/messages` JSON 截图或摘录。
2. Web UI 聊天栏图片缩略图可见。
3. `<VM_SESSION_FILE>` 不再出现在聊天正文。
4. 聊天栏能看到 VM agent 的阶段性 status/thinking 消息。
5. `npm run typecheck` 和 `npm run build` 通过。
