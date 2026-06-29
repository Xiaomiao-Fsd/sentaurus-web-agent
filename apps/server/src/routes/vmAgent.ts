import type { FastifyInstance } from "fastify";
import type { VmAgentAttachmentRef, VmAgentAttachmentSource, VmAgentMessageAttachment, VmAgentMessageRequest, VmSessionOutputCategory } from "@sentaurus-agent/shared";
import { config } from "../config.js";
import { requireAuth } from "../security/auth.js";
import { safeFileName, safeRelativePath, safeRunId } from "../security/pathSafe.js";
import { isChatImageContentType, isChatImageName } from "../services/imageAttachments.js";
import { connectVmAgent, downloadVmRunArtifact, getVmAgentMessages, getVmAgentStatus, sendVmAgentMessage } from "../services/vmAgent.js";
import { contentTypeForName, downloadVmSessionFile, listVmSessionFiles, vmSessionOutputCategories } from "../services/vmSessionFiles.js";

function parseCursor(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseLimit(value: unknown, fallback = 50): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 1000);
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

function contentDispositionFileName(name: string): string {
  const asciiName = name.replace(/["\\\r\n]/g, "_").replace(/[^\x20-\x7E]/g, "_").trim();
  return asciiName || "download";
}

function encodedHeaderValue(value: string): string {
  return encodeURIComponent(value.replace(/[\r\n]/g, "_"));
}

function contentDispositionAttachment(name: string): string {
  return `attachment; filename="${contentDispositionFileName(name)}"; filename*=UTF-8''${encodedHeaderValue(name)}`;
}

const attachmentSources = new Set<VmAgentAttachmentSource>(["run-input", "vm-session-file", "vm-run-artifact"]);
const maxContextAttachments = 8;
const maxDisplayAttachments = 12;

function parseAttachmentSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), 50 * 1024 * 1024);
}

function parseAttachmentCategory(value: unknown, source: VmAgentAttachmentSource): VmSessionOutputCategory | undefined {
  if (source === "vm-run-artifact") return undefined;
  const category = typeof value === "string" && value.trim() ? value.trim() : vmSessionOutputCategories[0];
  if (!vmSessionOutputCategories.includes(category as VmSessionOutputCategory)) {
    return vmSessionOutputCategories[0];
  }
  return category as VmSessionOutputCategory;
}

function validateAttachmentRef(value: unknown): VmAgentAttachmentRef {
  if (!value || typeof value !== "object") {
    const error = new Error("attachment must be an object") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  const item = value as Partial<VmAgentAttachmentRef>;
  const source = item.source;
  if (!source || !attachmentSources.has(source)) {
    const error = new Error("attachment source is invalid") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  const safePath = safeRelativePath(String(item.path || ""));
  const name = safeFileName(String(item.name || safePath.split("/").at(-1) || ""));
  const id = typeof item.id === "string" && item.id.trim()
    ? item.id.trim().slice(0, 180).replace(/[^A-Za-z0-9_.:-]/g, "_")
    : `${source}:${safePath}`.slice(0, 180).replace(/[^A-Za-z0-9_.:-]/g, "_");
  const runId = item.runId ? safeRunId(item.runId) : undefined;
  if (source === "vm-run-artifact" && !runId) {
    const error = new Error("vm-run-artifact attachment requires runId") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  return {
    id,
    source,
    name,
    path: safePath,
    size: parseAttachmentSize(item.size),
    runId,
    category: parseAttachmentCategory(item.category, source),
    contentType: typeof item.contentType === "string" && item.contentType.trim() ? item.contentType.trim().slice(0, 120) : undefined
  };
}

function validateAttachments(value: unknown): VmAgentAttachmentRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    const error = new Error("attachments must be an array") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  if (value.length > maxContextAttachments) {
    const error = new Error(`attachments are limited to ${maxContextAttachments} files`) as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  return value.map(validateAttachmentRef);
}

function validateDisplayAttachment(value: unknown): VmAgentMessageAttachment {
  if (!value || typeof value !== "object") {
    const error = new Error("display attachment must be an object") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  const item = value as Partial<VmAgentMessageAttachment>;
  const source = item.source;
  if (!source || !attachmentSources.has(source)) {
    const error = new Error("display attachment source is invalid") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  const safePath = safeRelativePath(String(item.path || ""));
  const name = safeFileName(String(item.name || safePath.split("/").at(-1) || ""));
  const contentType = typeof item.contentType === "string" && item.contentType.trim() ? item.contentType.trim().slice(0, 120) : undefined;
  const imageLike = isChatImageName(name) || isChatImageContentType(contentType);
  return {
    id: typeof item.id === "string" && item.id.trim() ? item.id.trim().slice(0, 180).replace(/[^A-Za-z0-9_.:-]/g, "_") : `${source}:${safePath}`.slice(0, 180).replace(/[^A-Za-z0-9_.:-]/g, "_"),
    kind: imageLike ? "image" : "file",
    name,
    size: parseAttachmentSize(item.size),
    contentType,
    source,
    path: safePath,
    runId: item.runId ? safeRunId(item.runId) : undefined,
    category: parseAttachmentCategory(item.category, source),
    width: typeof item.width === "number" && Number.isFinite(item.width) ? Math.max(0, Math.floor(item.width)) : undefined,
    height: typeof item.height === "number" && Number.isFinite(item.height) ? Math.max(0, Math.floor(item.height)) : undefined,
    thumbnailPath: typeof item.thumbnailPath === "string" && item.thumbnailPath.trim() ? safeRelativePath(item.thumbnailPath) : undefined
  };
}

function validateDisplayAttachments(value: unknown): VmAgentMessageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    const error = new Error("displayAttachments must be an array") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  if (value.length > maxDisplayAttachments) {
    const error = new Error(`displayAttachments are limited to ${maxDisplayAttachments} files`) as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  return value.map(validateDisplayAttachment);
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

  app.get<{ Querystring: { after?: string; limit?: string; sessionId?: string } }>("/api/vm/agent/messages", async (request) => {
    requireAuth(request);
    const result = await getVmAgentMessages(
      parseCursor(request.query.after),
      parseLimit(request.query.limit),
      parseSessionId(request.query.sessionId)
    );
    return { ok: result.status.ok, ...result };
  });

  app.post<{ Body: VmAgentMessageRequest }>("/api/vm/agent/messages", async (request) => {
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
    const result = await sendVmAgentMessage(
      message,
      parseSessionId(request.body?.sessionId),
      validateAttachments(request.body?.attachments),
      validateDisplayAttachments(request.body?.displayAttachments)
    );
    return { ok: result.status.ok, ...result };
  });

  app.get<{ Params: { runId: string }; Querystring: { path?: string; token?: string } }>("/api/vm/agent/runs/:runId/artifacts", async (request, reply) => {
    requireAuth(request);
    const artifactPath = request.query.path;
    if (!artifactPath) {
      const error = new Error("path is required") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const artifact = await downloadVmRunArtifact(request.params.runId, artifactPath);
    reply.header("content-type", contentTypeForName(artifact.fileName));
    reply.header("content-length", String(artifact.data.byteLength));
    reply.header("x-vm-artifact-path", encodedHeaderValue(artifact.path));
    reply.header("content-disposition", contentDispositionAttachment(artifact.fileName));
    return reply.send(artifact.data);
  });

  app.get<{ Params: { sessionId: string }; Querystring: { token?: string } }>("/api/vm/agent/sessions/:sessionId/files", async (request) => {
    requireAuth(request);
    return listVmSessionFiles(request.params.sessionId);
  });

  app.get<{ Params: { sessionId: string }; Querystring: { category?: string; path?: string; token?: string } }>("/api/vm/agent/sessions/:sessionId/files/download", async (request, reply) => {
    requireAuth(request);
    if (!request.query.category || !request.query.path) {
      const error = new Error("category and path are required") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const file = await downloadVmSessionFile(request.params.sessionId, request.query.category, request.query.path);
    reply.header("content-type", file.contentType);
    reply.header("content-length", String(file.data.byteLength));
    reply.header("x-vm-session-category", encodedHeaderValue(file.category));
    reply.header("x-vm-session-path", encodedHeaderValue(file.path));
    reply.header("content-disposition", contentDispositionAttachment(file.fileName));
    return reply.send(file.data);
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
    const interval = setInterval(() => void tick(), 1000);
    request.raw.on("close", () => clearInterval(interval));
  });
}
