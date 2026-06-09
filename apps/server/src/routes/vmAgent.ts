import type { FastifyInstance } from "fastify";
import { requireAuth } from "../security/auth.js";
import { connectVmAgent, getVmAgentStatus, sendVmAgentMessage } from "../services/vmAgent.js";

export async function vmAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/vm/agent/status", async (request) => {
    requireAuth(request);
    return getVmAgentStatus();
  });

  app.post("/api/vm/agent/connect", async (request) => {
    requireAuth(request);
    const result = await connectVmAgent();
    return { ok: result.status.ok, ...result };
  });

  app.post<{ Body: { message?: string } }>("/api/vm/agent/messages", async (request) => {
    requireAuth(request);
    const message = request.body?.message?.trim();
    if (!message) {
      const error = new Error("message is required") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    if (message.length > 4000) {
      const error = new Error("message is too long") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const result = await sendVmAgentMessage(message);
    return { ok: result.status.ok, ...result };
  });
}
