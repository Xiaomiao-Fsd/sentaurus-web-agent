import type { ChatResponse, VmStatus, RunSummary } from "@sentaurus-agent/shared";

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

export async function sendChat(message: string): Promise<ChatResponse> {
  return request("/api/chat", { method: "POST", body: JSON.stringify({ message }) });
}

export async function listRuns(): Promise<{ runs: RunSummary[] }> {
  return request("/api/runs");
}

export async function createRun(title: string): Promise<{ run: RunSummary }> {
  return request("/api/runs", { method: "POST", body: JSON.stringify({ title }) });
}
