# Sentaurus VM Agent UI 重构设计

## 背景

当前前端已经具备 VM Agent 消息面板、Run lifecycle API、文件上传下载、SSE 日志流、远端准备接口和本地会话排序等能力。主要问题集中在界面组织方式：功能都能找到，但主聊天、Session 管理、VM 状态、上下文用量和 TCAD Run 控制之间缺少清晰层级，使用时更像调试面板拼接，而不是一个可以长期和 Sentaurus 虚拟机沟通的工作台。

重构后的界面以“和 VM Agent 沟通”为核心，参考 ChatGPT 网页端 Agent 对话页面的使用方式，同时吸收 AMP Manager 的状态徽章、卡片密度和后台质感。第一版不改后端协议，不新增真实作业执行能力，只在原有前端功能基础上重组信息架构、完善交互和补齐上下文用量展示。

## 目标

1. 保留当前已有前端能力，包括 AUTH_TOKEN 输入、VM/Agent 状态、Session 创建与管理、VM Agent 消息、Run 文件上传下载、Prepare/Submit/Cancel、实时日志流。
2. 把主页面改成 ChatGPT Agent 工作台：左侧 Session 管理，中间主聊天，右侧 Inspector。
3. Session 管理更灵活：支持新建、选择、改名、删除、拖拽排序、搜索过滤、状态徽章和最近消息摘要。
4. 主聊天页更适合长时间沟通：清晰展示用户消息、VM Agent 消息、工具调用结果、流式状态、快捷指令和当前 session 标题。
5. 右侧常驻显示实时上下文用量：估算 token、上下文窗口占比、消息数、字符数，并随着消息变化刷新。
6. 右侧 Inspector 集成 VM 状态、Agent Context、Session Files、Run Control 和 Live Log，避免用户在多个区域之间来回找信息。

## 非目标

1. 不在本次 UI 重构中实现真实 SDE/SDevice 作业队列。
2. 不改变后端 LLM 调用方式，LLM 配置仍保留在 VM worker 内。
3. 不引入多用户权限、计费、配额或 AMP Manager 级别的管理系统。
4. 不重写 server API，只在需要时补少量前端 API 封装和类型。
5. 不把 `.tdr` / `.plt` 解析器纳入本次范围。

## 信息架构

页面采用三栏布局，并保留顶层状态栏。

```text
Top Bar
├─ Product identity: Sentaurus VM Agent
├─ VM status pill
├─ Agent status pill
└─ LLM config / auth / stream status pill

Main Workspace
├─ Left Session Sidebar
│  ├─ Search / filter
│  ├─ New session
│  ├─ Session list
│  └─ Session context actions
├─ Center Chat Surface
│  ├─ Current session header
│  ├─ Message timeline
│  ├─ Tool/result cards
│  └─ Composer with quick actions
└─ Right Inspector
   ├─ Context usage
   ├─ Agent context
   ├─ Session files
   ├─ Run controls
   └─ Live log
```

### 顶部状态栏

顶部状态栏不承担复杂导航，只回答三个问题：当前连接到哪里、Agent 是否可用、配置是否完整。状态用 AMP Manager 风格的 pill 展示，例如 `VM Online`、`Agent Running`、`LLM config pending`。如果用户尚未输入 AUTH_TOKEN，顶部显示 Auth required，并在主页面中保留现有 token 输入流程。

### 左侧 Session Sidebar

左侧栏专门管理会话。每个 session card 显示名称、run 状态、最近消息摘要、更新时间和少量操作入口。状态至少覆盖 `created`、`prepared`、`running`、`completed`、`failed`、`cancelled`，前端无法判断时显示 `unknown`。

保留现有拖拽排序和右键菜单能力。新增搜索过滤，过滤范围包含 session 名称、run id 和最近消息摘要。改名、删除、复制类操作放在 context menu 中，第一版复制可以只预留 UI，不接后端。

### 中间 Chat Surface

聊天区是主工作区。Header 显示当前 session 名称、run id、stream 状态和上下文简览。消息时间线区采用 ChatGPT 风格的左右区分或头像区分：用户消息、VM Agent 消息和系统状态消息在视觉上明确分层。

工具调用结果不再塞进纯文本，而以小卡片展示，例如 Sentaurus 工具发现、VM 状态、latest agent instance、日志摘要和文件列表。卡片内容来自已有 VM Agent 消息或前端对已有 API 的整理，不要求后端新增 tool call 协议。

Composer 保留普通文本输入，并加入快捷指令按钮：`Check tools`、`Read logs`、`Prepare remote`、`Explain errors`。快捷指令本质上是预填或发送标准提示词，避免用户重复输入常见 VM 检查请求。

### 右侧 Inspector

右侧 Inspector 是实时上下文和 TCAD 操作面板。它不抢占主聊天空间，但提供当前 session 的运行状态。

Context Usage 卡片显示四个指标：估算 tokens、上下文窗口占比、消息数、字符数。第一版使用前端估算：以消息文本字符数为基础，按 `ceil(chars / 4)` 估算 token。默认参考窗口设为 128k，可在代码中集中配置，后续如果 VM worker 返回模型上下文窗口，再切换为真实值。

Agent Context 卡片显示 VM host、用户、agent instance、LLM 配置状态、queue/pending 状态。Session Files 卡片显示 input、logs 和 artifacts 文件摘要，并复用现有上传下载 API。Run Control 卡片保留 Upload、Prepare、Submit、Cancel。Live Log 使用已有 SSE 日志流，按当前 run id 订阅。

## 组件拆分

当前 `apps/web/src/App.tsx` 过大，重构时应拆成小组件，避免继续把状态、API 调用和渲染写在一个文件中。

建议目录：

```text
apps/web/src/
├─ App.tsx
├─ components/
│  ├─ layout/
│  │  ├─ AppShell.tsx
│  │  ├─ TopStatusBar.tsx
│  │  └─ EmptyState.tsx
│  ├─ sessions/
│  │  ├─ SessionSidebar.tsx
│  │  ├─ SessionCard.tsx
│  │  ├─ SessionContextMenu.tsx
│  │  └─ SessionSearch.tsx
│  ├─ chat/
│  │  ├─ ChatSurface.tsx
│  │  ├─ ChatHeader.tsx
│  │  ├─ MessageTimeline.tsx
│  │  ├─ MessageBubble.tsx
│  │  ├─ ToolResultCard.tsx
│  │  └─ Composer.tsx
│  └─ inspector/
│     ├─ InspectorPanel.tsx
│     ├─ ContextUsageCard.tsx
│     ├─ AgentContextCard.tsx
│     ├─ SessionFilesCard.tsx
│     ├─ RunControlCard.tsx
│     └─ LiveLogCard.tsx
├─ hooks/
│  ├─ useSessionOrdering.ts
│  ├─ useContextUsage.ts
│  ├─ useVmAgentStream.ts
│  └─ useRunLogStream.ts
├─ utils/
│  ├─ contextUsage.ts
│  └─ sessionStatus.ts
└─ api/
   ├─ client.ts
   ├─ runs.ts
   └─ vmAgent.ts
```

`App.tsx` 只保留全局状态编排和数据传递。样式可以继续用 `styles.css`，但按 shell、sessions、chat、inspector 分区整理，并使用 CSS variables 管理颜色、间距、圆角和阴影。

## 数据流

```text
App
├─ load token from localStorage
├─ poll /api/health and VM agent status
├─ load runs via /api/runs
├─ load VM agent messages via /api/vm/agent/messages
├─ subscribe /api/vm/agent/messages/stream
├─ subscribe current run /api/runs/:id/logs/stream
└─ derive UI state
   ├─ selected session
   ├─ messages for current session
   ├─ context usage
   ├─ session status
   └─ inspector cards
```

Session 仍以 run 为基础。当前已有 `selectedRunId`、run 列表和消息过滤逻辑可以保留，但需要统一命名：UI 中叫 session，数据层仍然使用 run id。这样不会破坏现有后端 API。

## 上下文用量计算

第一版前端估算函数：

```ts
export function estimateContextUsage(messages: VmAgentMessage[], maxTokens = 128_000) {
  const characters = messages.reduce((sum, message) => sum + message.content.length, 0);
  const estimatedTokens = Math.ceil(characters / 4);
  const ratio = Math.min(1, estimatedTokens / maxTokens);

  return {
    characters,
    estimatedTokens,
    maxTokens,
    ratio,
    messageCount: messages.length,
  };
}
```

展示上应明确标注为估算，避免用户误以为来自模型真实 tokenization。后续如果后端或 VM worker 能返回真实 token 数，再替换计算来源。

## 状态与错误处理

1. AUTH_TOKEN 缺失：显示登录/解锁卡片，不渲染空白工作台。
2. VM offline：顶部状态显示 offline，聊天输入仍可保留，但发送按钮提示需要连接 VM。
3. Agent 未启动：右侧 Agent Context 显示 start action，中间区域显示可恢复说明。
4. SSE 断开：显示 reconnecting 状态，保留最近一次数据。
5. 当前 session 不存在：自动选择最新 run；如果没有 run，显示创建 session 的 empty state。
6. 文件上传失败、prepare 失败、submit 被保护闸门拦截：在 Run Control 和聊天系统消息中同时反馈。

## 视觉风格

整体风格使用浅色工作台，深色左侧 session rail，白色卡片和 teal 主色。AMP Manager 的影响体现在高密度但清晰的卡片、状态徽章、细边框、柔和阴影和统一圆角。ChatGPT 的影响体现在聊天优先、composer 常驻底部、消息时间线居中、工具结果嵌入消息流。

建议 CSS token：

```css
:root {
  --color-bg: #f6f8fb;
  --color-surface: #ffffff;
  --color-sidebar: #111827;
  --color-primary: #0f766e;
  --color-primary-soft: #e6f4f1;
  --color-border: #dfe7ef;
  --color-text: #152033;
  --color-muted: #718096;
  --radius-lg: 18px;
  --radius-xl: 24px;
  --shadow-card: 0 10px 26px rgba(15, 23, 42, 0.04);
}
```

## 第一版验收标准

1. 页面保留原有功能入口，不因 UI 重构丢失 Run、VM Agent、文件和日志相关能力。
2. 用户可以在左侧完成 session 新建、选择、搜索、改名、删除和排序。
3. 中间聊天区可以正常显示当前 session 的用户消息和 VM Agent 消息，并能发送新消息。
4. 右侧 Context Usage 随当前 session 消息变化刷新，展示 characters、estimated tokens、message count 和窗口占比。
5. 右侧 Run Control 可以调用已有 prepare、submit、cancel、upload/download 能力。
6. Live Log 能订阅当前 run 的 SSE 日志流，切换 session 后切换订阅目标。
7. TypeScript 构建通过，前端主要页面无运行时 console error。
8. 窄屏下右侧 Inspector 可以折叠或下移，不遮挡主聊天功能。

## 实施顺序

1. 抽离 API 和类型引用，确认 `runs.ts`、`vmAgent.ts`、`client.ts` 可被新组件复用。
2. 新建 context usage 工具函数和 hook。
3. 拆出 AppShell、TopStatusBar 和三栏布局。
4. 拆出 SessionSidebar，并迁移现有 session 排序、改名、删除逻辑。
5. 拆出 ChatSurface、MessageTimeline、MessageBubble 和 Composer。
6. 拆出 InspectorPanel 及五个卡片组件。
7. 整理 `styles.css`，用 CSS variables 统一视觉风格。
8. 运行构建检查并修复类型和样式问题。

## 后续扩展

1. 右侧 Inspector 支持 pin，使用户可以在不同 session 间固定查看 VM 全局状态。
2. Session 支持 tag、favorite 和 duplicate。
3. ToolResultCard 接入结构化 tool call 协议，而不是从文本消息推断。
4. Context Usage 使用 VM worker 返回的真实 token 统计。
5. Run Control 在后端完成 allowlisted job runner 后，显示队列状态、进度和 artifact 预览。
