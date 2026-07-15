import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  VmAgentAgentsMdUpdateRequest,
  VmAgentAttachmentRef,
  VmAgentAttachmentSource,
  VmAgentMessageAttachment,
  VmAgentMessageRequest,
  VmAgentModelUpdateRequest,
  VmAgentPlanStep,
  VmAgentPlanStepStatus,
  VmAgentWorkflowAction,
  VmAgentWorkflowUpdateRequest,
  VmSessionOutputCategory
} from "@sentaurus-agent/shared";
import { config } from "../config.js";
import { requireAuth } from "../security/auth.js";
import { safeFileName, safeRelativePath, safeRunId } from "../security/pathSafe.js";
import { isChatImageContentType, isChatImageName } from "../services/imageAttachments.js";
import {
  connectVmAgent,
  downloadVmRunArtifact,
  getVmAgentAgentsMd,
  getVmAgentMessages,
  getVmAgentModels,
  getVmAgentStatus,
  isVmAgentHistoryError,
  saveVmAgentAgentsMd,
  setVmAgentModel,
  sendVmAgentMessage
} from "../services/vmAgent.js";
import { validateVmAgentInstructionsContent } from "../services/vmAgentInstructions.js";
import { parseVmAgentModelId } from "../services/vmAgentModels.js";
import { getVmAgentWorkflow, updateVmAgentWorkflow } from "../services/vmAgentWorkflow.js";
import { contentTypeForName, downloadVmSessionFile, listVmSessionFiles, vmSessionOutputCategories } from "../services/vmSessionFiles.js";

function parseCursor(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

const defaultHistoryLimit = 50;
const maxHistoryLimit = 5000;

function parseLimit(value: unknown, fallback = defaultHistoryLimit): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maxHistoryLimit);
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

export type VmAgentRouteOptions = {
  getVmAgentMessages?: typeof getVmAgentMessages;
  getVmAgentAgentsMd?: typeof getVmAgentAgentsMd;
  saveVmAgentAgentsMd?: typeof saveVmAgentAgentsMd;
  getVmAgentModels?: typeof getVmAgentModels;
  setVmAgentModel?: typeof setVmAgentModel;
  getVmAgentWorkflow?: typeof getVmAgentWorkflow;
  updateVmAgentWorkflow?: typeof updateVmAgentWorkflow;
};

const workflowActions = new Set<VmAgentWorkflowAction>([
  "goal.set",
  "goal.pause",
  "goal.resume",
  "goal.block",
  "goal.complete",
  "goal.clear",
  "plan.enter",
  "plan.set",
  "plan.step",
  "plan.approve",
  "plan.exit",
  "plan.clear"
]);

function validateWorkflowUpdate(value: unknown): VmAgentWorkflowUpdateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("workflow update body must be an object") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  const item = value as Record<string, unknown>;
  const action = item.action;
  if (typeof action !== "string" || !workflowActions.has(action as VmAgentWorkflowAction)) {
    const error = new Error("workflow action is unsupported") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  const expectedRevision = item.expectedRevision;
  if (expectedRevision !== undefined && (
    !Number.isInteger(expectedRevision) || (expectedRevision as number) < 0
  )) {
    const error = new Error("expectedRevision must be a non-negative integer") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  const revision = expectedRevision === undefined ? {} : { expectedRevision: expectedRevision as number };
  const payload = item.payload;
  const requirePayload = (): Record<string, unknown> => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      const error = new Error("workflow payload must be an object") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    return payload as Record<string, unknown>;
  };
  const invalid = (message: string): never => {
    const error = new Error(message) as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  };

  if (action === "goal.set") {
    const objective = requirePayload().objective;
    if (typeof objective !== "string" || !objective.trim() || objective.trim().length > 2000) {
      invalid("goal objective must be between 1 and 2000 characters");
    }
    return { action, ...revision, payload: { objective: (objective as string).trim() } };
  }
  if (action === "goal.block") {
    if (payload === undefined) return { action, ...revision };
    const reason = requirePayload().reason;
    if (reason !== undefined && (typeof reason !== "string" || reason.trim().length > 1000)) {
      invalid("goal block reason must be a string up to 1000 characters");
    }
    return {
      action,
      ...revision,
      payload: { ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : {}) }
    };
  }
  if (action === "plan.set") {
    const plan = requirePayload();
    if (!Array.isArray(plan.steps) || plan.steps.length > 64) {
      invalid("plan steps must be an array with at most 64 entries");
    }
    const statuses = new Set<VmAgentPlanStepStatus>(["pending", "in_progress", "completed"]);
    const steps: VmAgentPlanStep[] = (plan.steps as unknown[]).map((raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("each plan step must be an object");
      const step = raw as Record<string, unknown>;
      if (typeof step.id !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(step.id)) {
        invalid("plan step id contains unsupported characters");
      }
      if (typeof step.step !== "string" || !step.step.trim() || step.step.trim().length > 1000) {
        invalid("plan step text must be between 1 and 1000 characters");
      }
      if (typeof step.status !== "string" || !statuses.has(step.status as VmAgentPlanStepStatus)) {
        invalid("plan step status is unsupported");
      }
      return {
        id: step.id as string,
        step: (step.step as string).trim(),
        status: step.status as VmAgentPlanStepStatus
      };
    });
    const inProgressCount = steps.filter((step) => step.status === "in_progress").length;
    if (inProgressCount > 1) invalid("plan may contain at most one in_progress step");
    if (plan.explanation !== undefined && (
      typeof plan.explanation !== "string" || plan.explanation.trim().length > 4000
    )) {
      invalid("plan explanation must be a string up to 4000 characters");
    }
    return {
      action,
      ...revision,
      payload: {
        steps,
        ...(typeof plan.explanation === "string" && plan.explanation.trim()
          ? { explanation: plan.explanation.trim() }
          : {})
      }
    };
  }
  if (action === "plan.step") {
    const step = requirePayload();
    if (typeof step.stepId !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(step.stepId)) {
      invalid("plan step id contains unsupported characters");
    }
    const statuses = new Set<VmAgentPlanStepStatus>(["pending", "in_progress", "completed"]);
    if (typeof step.status !== "string" || !statuses.has(step.status as VmAgentPlanStepStatus)) {
      invalid("plan step status is unsupported");
    }
    return {
      action,
      ...revision,
      payload: { stepId: step.stepId as string, status: step.status as VmAgentPlanStepStatus }
    };
  }
  return { action: action as Exclude<VmAgentWorkflowAction, "goal.set" | "goal.block" | "plan.set" | "plan.step">, ...revision };
}

function clientAbortSignal(request: FastifyRequest, reply: FastifyReply): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  return {
    signal: controller.signal,
    cleanup: () => {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
    }
  };
}

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

export async function vmAgentRoutes(app: FastifyInstance, options: VmAgentRouteOptions = {}): Promise<void> {
  const loadVmAgentMessages = options.getVmAgentMessages ?? getVmAgentMessages;
  const loadVmAgentAgentsMd = options.getVmAgentAgentsMd ?? getVmAgentAgentsMd;
  const persistVmAgentAgentsMd = options.saveVmAgentAgentsMd ?? saveVmAgentAgentsMd;
  const loadVmAgentModels = options.getVmAgentModels ?? getVmAgentModels;
  const persistVmAgentModel = options.setVmAgentModel ?? setVmAgentModel;
  const loadVmAgentWorkflow = options.getVmAgentWorkflow ?? getVmAgentWorkflow;
  const persistVmAgentWorkflow = options.updateVmAgentWorkflow ?? updateVmAgentWorkflow;
  app.get("/api/vm/agent/status", async (request) => {
    requireAuth(request);
    return getVmAgentStatus();
  });

  app.get("/api/vm/agent/models", async (request) => {
    requireAuth(request);
    return loadVmAgentModels();
  });

  app.put<{ Body: VmAgentModelUpdateRequest }>("/api/vm/agent/model", async (request, reply) => {
    requireAuth(request);
    const model = parseVmAgentModelId(request.body?.model);
    const client = clientAbortSignal(request, reply);
    try {
      return await persistVmAgentModel(model, client.signal);
    } finally {
      client.cleanup();
    }
  });

  app.get("/api/vm/agent/agents-md", async (request, reply) => {
    requireAuth(request);
    const client = clientAbortSignal(request, reply);
    try {
      return await loadVmAgentAgentsMd(client.signal);
    } finally {
      client.cleanup();
    }
  });

  app.put<{ Body: VmAgentAgentsMdUpdateRequest }>("/api/vm/agent/agents-md", async (request, reply) => {
    requireAuth(request);
    const content = validateVmAgentInstructionsContent(request.body?.content);
    const client = clientAbortSignal(request, reply);
    try {
      return await persistVmAgentAgentsMd(content, client.signal);
    } finally {
      client.cleanup();
    }
  });

  app.post("/api/vm/agent/connect", async (request) => {
    requireAuth(request);
    const result = await connectVmAgent();
    return { ok: result.status.ok, ...result };
  });

  app.get<{ Querystring: { after?: string; limit?: string; sessionId?: string } }>("/api/vm/agent/messages", async (request, reply) => {
    requireAuth(request);
    const client = clientAbortSignal(request, reply);
    try {
      const result = await loadVmAgentMessages(
        parseCursor(request.query.after),
        parseLimit(request.query.limit),
        parseSessionId(request.query.sessionId),
        client.signal
      );
      return { ok: true, ...result };
    } catch (err) {
      if (!isVmAgentHistoryError(err)) throw err;
      return reply.code(err.statusCode).send({
        ok: false,
        error: err.code,
        message: err.message,
        retryable: err.retryable,
        cursor: err.cursor,
        status: err.status,
        messages: []
      });
    } finally {
      client.cleanup();
    }
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

  app.get<{ Params: { sessionId: string } }>("/api/vm/agent/sessions/:sessionId/workflow", async (request, reply) => {
    requireAuth(request);
    const sessionId = parseSessionId(request.params.sessionId);
    if (!sessionId) {
      const error = new Error("sessionId is required") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const client = clientAbortSignal(request, reply);
    try {
      return await loadVmAgentWorkflow(sessionId, client.signal);
    } finally {
      client.cleanup();
    }
  });

  app.patch<{ Params: { sessionId: string }; Body: VmAgentWorkflowUpdateRequest }>(
    "/api/vm/agent/sessions/:sessionId/workflow",
    async (request, reply) => {
      requireAuth(request);
      const sessionId = parseSessionId(request.params.sessionId);
      if (!sessionId) {
        const error = new Error("sessionId is required") as Error & { statusCode?: number };
        error.statusCode = 400;
        throw error;
      }
      const update = validateWorkflowUpdate(request.body);
      const client = clientAbortSignal(request, reply);
      try {
        return await persistVmAgentWorkflow(sessionId, update, client.signal);
      } finally {
        client.cleanup();
      }
    }
  );

  app.get<{ Params: { runId: string }; Querystring: { path?: string; token?: string } }>("/api/vm/agent/runs/:runId/artifacts", async (request, reply) => {
    requireAuth(request);
    const artifactPath = request.query.path;
    if (!artifactPath) {
      const error = new Error("path is required") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const client = clientAbortSignal(request, reply);
    try {
      const artifact = await downloadVmRunArtifact(request.params.runId, artifactPath, client.signal);
      reply.header("content-type", contentTypeForName(artifact.fileName));
      reply.header("content-length", String(artifact.data.byteLength));
      reply.header("x-vm-artifact-path", encodedHeaderValue(artifact.path));
      reply.header("content-disposition", contentDispositionAttachment(artifact.fileName));
      return reply.send(artifact.data);
    } finally {
      client.cleanup();
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: { token?: string } }>("/api/vm/agent/sessions/:sessionId/files", async (request, reply) => {
    requireAuth(request);
    const client = clientAbortSignal(request, reply);
    try {
      return await listVmSessionFiles(request.params.sessionId, client.signal);
    } finally {
      client.cleanup();
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: { category?: string; path?: string; token?: string } }>("/api/vm/agent/sessions/:sessionId/files/download", async (request, reply) => {
    requireAuth(request);
    if (!request.query.category || !request.query.path) {
      const error = new Error("category and path are required") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const client = clientAbortSignal(request, reply);
    try {
      const file = await downloadVmSessionFile(request.params.sessionId, request.query.category, request.query.path, client.signal);
      reply.header("content-type", file.contentType);
      reply.header("content-length", String(file.data.byteLength));
      reply.header("x-vm-session-category", encodedHeaderValue(file.category));
      reply.header("x-vm-session-path", encodedHeaderValue(file.path));
      reply.header("content-disposition", contentDispositionAttachment(file.fileName));
      return reply.send(file.data);
    } finally {
      client.cleanup();
    }
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
    reply.raw.flushHeaders();

    let cursor = parseCursor(request.query.after);
    let running = false;
    const streamController = new AbortController();
    let interval: ReturnType<typeof setInterval> | undefined;
    const closeStream = () => {
      streamController.abort();
      if (interval) clearInterval(interval);
    };
    request.raw.once("close", closeStream);
    const send = (event: string, data: unknown) => {
      if (streamController.signal.aborted || reply.raw.destroyed) return;
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const result = await loadVmAgentMessages(cursor, 50, undefined, streamController.signal);
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
    if (!streamController.signal.aborted) interval = setInterval(() => void tick(), 1000);
  });
}
