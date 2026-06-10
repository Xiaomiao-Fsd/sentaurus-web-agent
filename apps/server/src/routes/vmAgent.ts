import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { requireAuth } from "../security/auth.js";
import { connectVmAgent, getVmAgentMessages, getVmAgentStatus, sendVmAgentMessage } from "../services/vmAgent.js";

function parseCursor(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(trimmed)) {
    const error = new Error("sessionId contains unsupported characters") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  return trimmed;
}

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

  app.get<{ Querystring: { after?: string } }>("/api/vm/agent/messages", async (request) => {
    requireAuth(request);
    const result = await getVmAgentMessages(parseCursor(request.query.after));
    return { ok: result.status.ok, ...result };
  });

  app.post<{ Body: { message?: string; sessionId?: string } }>("/api/vm/agent/messages", async (request) => {
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
    const result = await sendVmAgentMessage(message, parseSessionId(request.body?.sessionId));
    return { ok: result.status.ok, ...result };
  });

  app.get<{ Querystring: { after?: string; token?: string } }>("/api/vm/agent/messages/stream", async (request, reply) => {
    requireAuth(request);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "access-control-allow-origin": config.CORS_ORIGIN,
      vary: "origin",
      connection: "keep-alive"
    });

    let cursor = parseCursor(request.query.after);
    let running = false;
    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const result = await getVmAgentMessages(cursor);
        cursor = result.cursor;
        if (result.messages.length > 0) {
          send("messages", result);
        } else {
          send("ping", { time: new Date().toISOString(), cursor });
        }
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        running = false;
      }
    };

    await tick();
    const interval = setInterval(() => void tick(), 2000);
    request.raw.on("close", () => clearInterval(interval));
  });
}
