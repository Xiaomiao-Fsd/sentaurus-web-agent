import type { RunDetail, RunFile, RunSummary, SimulationSetup } from "@sentaurus-agent/shared";
import { apiUrl, requestJson, tokenQuery, uploadJson } from "./client.js";

export async function listRuns(): Promise<{ runs: RunSummary[] }> {
  return requestJson("/api/runs");
}

export async function getRun(id: string): Promise<RunDetail> {
  return requestJson(`/api/runs/${encodeURIComponent(id)}`);
}

export async function renameRun(id: string, title: string): Promise<{ run: RunSummary }> {
  return requestJson(`/api/runs/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title }) });
}

export async function saveRunSimulationSetup(id: string, setup: SimulationSetup): Promise<{ run: RunSummary }> {
  return requestJson(`/api/runs/${encodeURIComponent(id)}/simulation-setup`, { method: "PATCH", body: JSON.stringify(setup) });
}

export async function deleteRun(id: string): Promise<{ ok: boolean }> {
  return requestJson(`/api/runs/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function createRun(title: string): Promise<{ run: RunSummary }> {
  return requestJson("/api/runs", { method: "POST", body: JSON.stringify({ title }) });
}

export async function uploadRunFile(id: string, file: File): Promise<{ file: RunFile; run: RunSummary }> {
  const form = new FormData();
  form.append("file", file);
  return uploadJson(`/api/runs/${encodeURIComponent(id)}/files`, form);
}

export async function prepareRemoteRun(id: string): Promise<{ ok: boolean; message: string; run: RunSummary }> {
  return requestJson(`/api/runs/${encodeURIComponent(id)}/prepare-remote`, { method: "POST", body: JSON.stringify({}) });
}

export async function submitRunJob(id: string): Promise<{ ok: boolean; message: string; run: RunSummary }> {
  return requestJson(`/api/runs/${encodeURIComponent(id)}/jobs`, { method: "POST", body: JSON.stringify({}) });
}

export async function cancelRun(id: string): Promise<{ ok: boolean; run: RunSummary }> {
  return requestJson(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({}) });
}

export function downloadUrl(id: string, area: "files" | "logs" | "artifacts", name: string): string {
  return apiUrl(`/api/runs/${encodeURIComponent(id)}/${area}/${encodeURIComponent(name)}?token=${tokenQuery()}`);
}

export function logStreamUrl(id: string): string {
  return apiUrl(`/api/runs/${encodeURIComponent(id)}/logs/stream?token=${tokenQuery()}`);
}
