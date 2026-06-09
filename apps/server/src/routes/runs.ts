import type { FastifyInstance } from "fastify";
import { requireAuth } from "../security/auth.js";
import { createRun, listRuns } from "../services/runStore.js";

export async function runRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/runs", async (request) => {
    requireAuth(request);
    return { runs: await listRuns() };
  });

  app.post<{ Body: { title?: string } }>("/api/runs", async (request) => {
    requireAuth(request);
    return { run: await createRun(request.body?.title) };
  });
}
