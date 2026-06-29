import type {
  VmAgentConnectResponse,
  VmAgentAttachmentRef,
  VmAgentHistoryResponse,
  VmAgentMessageAttachment,
  VmAgentMessageResponse,
  VmAgentStatus,
  VmSessionOutputCategory,
  VmSessionFilesResponse
} from "@sentaurus-agent/shared";
import { apiUrl, requestJson, tokenQuery } from "./client.js";

export async function getVmAgentStatus(): Promise<VmAgentStatus> {
  return requestJson("/api/vm/agent/status");
}

export async function connectVmAgent(): Promise<VmAgentConnectResponse> {
  return requestJson("/api/vm/agent/connect", { method: "POST", body: JSON.stringify({}) });
}

export async function sendVmAgentMessage(
  message: string,
  sessionId?: string,
  attachments: VmAgentAttachmentRef[] = [],
  displayAttachments: VmAgentMessageAttachment[] = []
): Promise<VmAgentMessageResponse> {
  return requestJson("/api/vm/agent/messages", { method: "POST", body: JSON.stringify({ message, sessionId, attachments, displayAttachments }) });
}

export async function getVmAgentMessages(after = 0, options: { limit?: number; sessionId?: string } = {}): Promise<VmAgentHistoryResponse> {
  const params = new URLSearchParams({ after: String(after) });
  if (options.limit) params.set("limit", String(options.limit));
  if (options.sessionId) params.set("sessionId", options.sessionId);
  return requestJson(`/api/vm/agent/messages?${params.toString()}`);
}

export function vmAgentMessageStreamUrl(after = 0): string {
  return apiUrl(`/api/vm/agent/messages/stream?after=${encodeURIComponent(String(after))}&token=${tokenQuery()}`);
}

export function vmRunArtifactDownloadUrl(runId: string, artifactPath: string): string {
  return apiUrl(`/api/vm/agent/runs/${encodeURIComponent(runId)}/artifacts?path=${encodeURIComponent(artifactPath)}&token=${tokenQuery()}`);
}

export async function getVmSessionFiles(sessionId: string): Promise<VmSessionFilesResponse> {
  return requestJson(`/api/vm/agent/sessions/${encodeURIComponent(sessionId)}/files`);
}

export function vmSessionFileDownloadUrl(sessionId: string, category: VmSessionOutputCategory, filePath: string): string {
  return apiUrl(`/api/vm/agent/sessions/${encodeURIComponent(sessionId)}/files/download?category=${encodeURIComponent(category)}&path=${encodeURIComponent(filePath)}&token=${tokenQuery()}`);
}
