import type { VmStatus } from "@sentaurus-agent/shared";
import { requestJson } from "./client.js";

export async function getVmStatus(): Promise<VmStatus> {
  return requestJson("/api/vm/status");
}
