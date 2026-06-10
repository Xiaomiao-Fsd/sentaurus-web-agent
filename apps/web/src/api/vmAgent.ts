import type {
  VmAgentConnectResponse,
  VmAgentHistoryResponse,
  VmAgentMessageResponse,
  VmAgentStatus
} from "@sentaurus-agent/shared";
import { apiUrl, requestJson, tokenQuery } from "./client.js";

export async function getVmAgentStatus(): Promise<VmAgentStatus> {
  return requestJson("/api/vm/agent/status");
}

export async function connectVmAgent(): Promise<VmAgentConnectResponse> {
  return requestJson("/api/vm/agent/connect", { method: "POST", body: JSON.stringify({}) });
}

export async function sendVmAgentMessage(message: string, sessionId?: string): Promise<VmAgentMessageResponse> {
  return requestJson("/api/vm/agent/messages", { method: "POST", body: JSON.stringify({ message, sessionId }) });
}

export async function getVmAgentMessages(after = 0): Promise<VmAgentHistoryResponse> {
  return requestJson(`/api/vm/agent/messages?after=${encodeURIComponent(String(after))}`);
}

export function vmAgentMessageStreamUrl(after = 0): string {
  return apiUrl(`/api/vm/agent/messages/stream?after=${encodeURIComponent(String(after))}&token=${tokenQuery()}`);
}
