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
  meta?: Record<string, string | number | boolean | null>;
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
  manualCount?: number;
  manualFiles?: string[];
  queueDepth?: number;
  sentaurusTools?: Record<string, string | null>;
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
};

export type RunDetail = {
  run: RunSummary;
  files: RunFile[];
  logs: RunFile[];
  artifacts: RunFile[];
};
