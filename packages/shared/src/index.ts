export type VmStatus = {
  ok: boolean;
  checkedAt: string;
  sshTarget: string;
  hostname?: string;
  user?: string;
  sentaurusVersion?: string;
  tools?: Record<string, string | null>;
  error?: string;
  raw?: string;
};

export type VmAgentMessage = {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  createdAt: string;
  vmCreatedAt?: string;
  hostReceivedAt?: string;
  sequence?: number;
  meta?: Record<string, string | number | boolean | null>;
  attachments?: VmAgentMessageAttachment[];
};

export type VmAgentStatus = {
  ok: boolean;
  checkedAt: string;
  sshTarget: string;
  connected: boolean;
  agent?: string;
  version?: string;
  hostname?: string;
  user?: string;
  capabilities?: string[];
  instanceCount?: number;
  latestInstance?: string | null;
  mailbox?: string;
  messageCount?: number;
  workerRunning?: boolean;
  workerPid?: number | null;
  llmConfigured?: boolean;
  llmModel?: string;
  llmModels?: string[];
  maxAutodebugAttempts?: number;
  manualCount?: number;
  manualFiles?: string[];
  queueDepth?: number;
  sentaurusTools?: Record<string, string | null>;
  vmTime?: string;
  vmEpochMs?: number;
  hostTime?: string;
  hostEpochMs?: number;
  clockSkewMs?: number;
  clockSkewWarning?: boolean;
  error?: string;
  raw?: string;
};

export type VmAgentConnectResponse = {
  ok: boolean;
  status: VmAgentStatus;
  message?: VmAgentMessage;
  messages?: VmAgentMessage[];
  cursor?: number;
};

export type VmAgentMessageResponse = {
  ok: boolean;
  status: VmAgentStatus;
  message: VmAgentMessage;
  messages: VmAgentMessage[];
  cursor: number;
};

export type VmAgentHistoryResponse = {
  ok: boolean;
  status: VmAgentStatus;
  messages: VmAgentMessage[];
  cursor: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export type ChatRequest = {
  message: string;
  conversationId?: string;
};

export type ChatResponse = {
  conversationId: string;
  message: ChatMessage;
};

export type RunStatus = "created" | "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type RunFileKind = "input" | "logs" | "artifacts";

export type RunFile = {
  name: string;
  kind: RunFileKind;
  size: number;
  modifiedAt: string;
};

export type SimulationSetup = {
  deviceType?: string;
  gateBias?: string;
  drainBias?: string;
  sourceBulk?: string;
  geometry?: string;
  dopingOrImplant?: string;
  physicsModels?: string;
  mesh?: string;
  temperature?: string;
  simulationGoals?: string;
  expectedOutputs?: string[];
  notes?: string;
  updatedAt: string;
  updatedBy: "vm-agent" | "user" | "system";
};

export type VmRunArtifact = {
  path: string;
  size: number;
};

export type VmAgentAttachmentSource = "run-input" | "vm-session-file" | "vm-run-artifact";

export type VmAgentAttachmentRef = {
  id: string;
  source: VmAgentAttachmentSource;
  name: string;
  path: string;
  size: number;
  runId?: string;
  category?: VmSessionOutputCategory;
  contentType?: string;
};

export type VmAgentMessageAttachmentKind = "file" | "image";

export type VmAgentMessageAttachment = {
  id: string;
  kind: VmAgentMessageAttachmentKind;
  name: string;
  size: number;
  contentType?: string;
  source: VmAgentAttachmentSource;
  path: string;
  runId?: string;
  category?: VmSessionOutputCategory;
  width?: number;
  height?: number;
  thumbnailPath?: string;
};

export type VmAgentMessageRequest = {
  message: string;
  sessionId?: string;
  attachments?: VmAgentAttachmentRef[];
  displayAttachments?: VmAgentMessageAttachment[];
};

export const VM_SESSION_OUTPUT_CATEGORIES = ["我的输入", "仿真结果文件", "仿真日志文件", "仿真参数文件", "其它文件"] as const;

export type VmSessionOutputCategory = typeof VM_SESSION_OUTPUT_CATEGORIES[number];

export const VM_SESSION_INPUT_CATEGORY: VmSessionOutputCategory = VM_SESSION_OUTPUT_CATEGORIES[0];

export type VmSessionFileSyncStatus = {
  ok: boolean;
  category?: VmSessionOutputCategory;
  path?: string;
  error?: string;
};

export type VmSessionOutputFile = {
  category: VmSessionOutputCategory;
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  isImage: boolean;
};

export type VmSessionFilesResponse = {
  categories: VmSessionOutputCategory[];
  files: VmSessionOutputFile[];
};

export type RunSummary = {
  id: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  title: string;
  localDir?: string;
  remoteDir?: string;
  remotePreparedAt?: string;
  lastError?: string;
  simulationSetup?: SimulationSetup;
};

export type RunDetail = {
  run: RunSummary;
  files: RunFile[];
  logs: RunFile[];
  artifacts: RunFile[];
};
