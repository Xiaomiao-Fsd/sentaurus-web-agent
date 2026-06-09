import type { FastifyInstance } from "fastify";
import { requireAuth } from "../security/auth.js";
import { getVmStatus } from "../services/vmStatus.js";

export async function vmRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/vm/status", async (request) => {
    requireAuth(request);
    return getVmStatus();
  });
}
