import type { FastifyInstance } from "fastify";
import { requireAuth } from "../security/auth.js";

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/chat", async (request, reply) => {
    requireAuth(request);
    return reply.status(410).send({
      ok: false,
      error: "Host-side chat is disabled. Use /api/vm/agent/messages so LLM credentials and Sentaurus tools stay inside the CentOS VM."
    });
  });
}
