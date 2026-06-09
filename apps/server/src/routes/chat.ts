import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import type { ChatRequest, ChatResponse } from "@sentaurus-agent/shared";
import { requireAuth } from "../security/auth.js";
import { chatWithLlm } from "../services/llmClient.js";

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ChatRequest }>("/api/chat", async (request): Promise<ChatResponse> => {
    requireAuth(request);
    const body = request.body;
    if (!body?.message?.trim()) {
      const error = new Error("message is required") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const content = await chatWithLlm(body.message.trim());
    return {
      conversationId: body.conversationId || `conv_${nanoid(8)}`,
      message: {
        id: `msg_${nanoid(8)}`,
        role: "assistant",
        content,
        createdAt: new Date().toISOString()
      }
    };
  });
}
