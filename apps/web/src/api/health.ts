import { requestJson } from "./client.js";

export type HealthResponse = {
  ok: boolean;
  service: string;
  time: string;
};

export async function getHealth(): Promise<HealthResponse> {
  return requestJson("/api/health");
}
