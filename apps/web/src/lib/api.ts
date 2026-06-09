import type {
  ChatResponse,
  VmAgentConnectResponse,
  VmAgentMessageResponse,
  VmAgentStatus,
  VmStatus,
  RunDetail,
  RunFile,
  RunSummary
} from "@sentaurus-agent/shared";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:5175";

function token(): string {
  return localStorage.getItem("sentaurus_auth_token") || "";
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token()}`,
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text}`);
  }
  return response.json() as Promise<T>;
}

async function upload<T>(path: string, body: FormData): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}` },
    body
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text}`);
  }
  return response.json() as Promise<T>;
}

export function setAuthToken(value: string): void {
  localStorage.setItem("sentaurus_auth_token", value);
}

export function getAuthToken(): string {
  return token();
}

export async function getHealth(): Promise<{ ok: boolean; service: string; time: string }> {
  return request("/api/health");
}

export async function getVmStatus(): Promise<VmStatus> {
  return request("/api/vm/status");
}

export async function getVmAgentStatus(): Promise<VmAgentStatus> {
  return request("/api/vm/agent/status");
}

export async function connectVmAgent(): Promise<VmAgentConnectResponse> {
  return request("/api/vm/agent/connect", { method: "POST", body: JSON.stringify({}) });
}

export async function sendVmAgentMessage(message: string): Promise<VmAgentMessageResponse> {
  return request("/api/vm/agent/messages", { method: "POST", body: JSON.stringify({ message }) });
}

export async function sendChat(message: string): Promise<ChatResponse> {
  return request("/api/chat", { method: "POST", body: JSON.stringify({ message }) });
}

export async function listRuns(): Promise<{ runs: RunSummary[] }> {
  return request("/api/runs");
}

export async function getRun(id: string): Promise<RunDetail> {
  return request(`/api/runs/${encodeURIComponent(id)}`);
}

export async function createRun(title: string): Promise<{ run: RunSummary }> {
  return request("/api/runs", { method: "POST", body: JSON.stringify({ title }) });
}

export async function uploadRunFile(id: string, file: File): Promise<{ file: RunFile; run: RunSummary }> {
  const form = new FormData();
  form.append("file", file);
  return upload(`/api/runs/${encodeURIComponent(id)}/files`, form);
}

export async function prepareRemoteRun(id: string): Promise<{ ok: boolean; message: string; run: RunSummary }> {
  return request(`/api/runs/${encodeURIComponent(id)}/prepare-remote`, { method: "POST", body: JSON.stringify({}) });
}

export async function submitRunJob(id: string): Promise<{ ok: boolean; message: string; run: RunSummary }> {
  return request(`/api/runs/${encodeURIComponent(id)}/jobs`, { method: "POST", body: JSON.stringify({}) });
}

export async function cancelRun(id: string): Promise<{ ok: boolean; run: RunSummary }> {
  return request(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({}) });
}

export function downloadUrl(id: string, area: "files" | "artifacts", name: string): string {
  return `${API_BASE}/api/runs/${encodeURIComponent(id)}/${area}/${encodeURIComponent(name)}?token=${encodeURIComponent(token())}`;
}

export function logStreamUrl(id: string): string {
  return `${API_BASE}/api/runs/${encodeURIComponent(id)}/logs/stream?token=${encodeURIComponent(token())}`;
}
