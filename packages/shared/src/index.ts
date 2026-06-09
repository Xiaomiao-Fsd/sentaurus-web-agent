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

export type RunSummary = {
  id: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  title: string;
  localDir: string;
  remoteDir?: string;
};
