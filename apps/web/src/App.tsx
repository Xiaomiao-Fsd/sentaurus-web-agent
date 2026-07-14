import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent, MouseEvent, ReactNode } from "react";
import { VM_SESSION_INPUT_CATEGORY, VM_SESSION_OUTPUT_CATEGORIES } from "@sentaurus-agent/shared";
import type {
  RunDetail,
  RunFile,
  RunStatus,
  RunSummary,
  SimulationSetup,
  VmAgentAttachmentRef,
  VmAgentHistoryResponse,
  VmAgentMessage,
  VmAgentMessageAttachment,
  VmRunArtifact,
  VmAgentStatus,
  VmSessionFilesResponse,
  VmSessionOutputCategory,
  VmSessionOutputFile,
  VmStatus
} from "@sentaurus-agent/shared";
import {
  connectVmAgent,
  createRun,
  deleteRun as deleteRunApi,
  downloadUrl,
  getVmAgentAgentsMd,
  getAuthToken,
  getHealth,
  getRun,
  getVmSessionFiles,
  getVmAgentMessages,
  getVmAgentStatus,
  getVmStatus,
  listRuns,
  renameRun,
  saveRunSimulationSetup,
  saveVmAgentAgentsMd,
  sendVmAgentMessage,
  setAuthToken,
  uploadRunFile,
  vmAgentMessageStreamUrl,
  vmRunArtifactDownloadUrl,
  vmSessionFileDownloadUrl
} from "./lib/api.js";
import {
  applySlashCommandSuggestion,
  nextSlashSuggestionIndex,
  slashCommandQuery,
  slashCommandSuggestions
} from "./slashCommands.js";
import type { SlashCommandSuggestion } from "./slashCommands.js";
import { TopStatusBar } from "./app/TopStatusBar.js";
import { useToast } from "./components/ui/Toast.js";
import {
  assertHistoryResponse,
  completedSessionHistoryState,
  failedSessionHistoryState,
  historyErrorDetails,
  IDLE_SESSION_HISTORY,
  isCurrentHistoryRequest,
  isHistoryBootstrapSettled,
  loadingSessionHistoryState,
  shouldLoadSelectedSessionHistory
} from "./sessionHistory.js";
import { vmSessionFilesCompletionState } from "./vmSessionFilesState.js";
import type { SessionHistoryState } from "./sessionHistory.js";
import { errorMessage, formatBytes, formatCompactNumber, formatDate, formatFullDate, normalizeAuthToken, shortId } from "./utils/format.js";

type PanelNotice = {
  kind: "info" | "success" | "error";
  text: string;
};

type QuickPrompt = {
  label: string;
  prompt: string;
};

type ContextStats = {
  characters: number;
  estimatedTokens: number;
  messageCount: number;
  percent: number;
  maxTokens: number;
};

type ProgressStatus = "running" | "completed" | "failed" | "queued" | "info";

type ProgressRow = {
  id: string;
  createdAt: string;
  vmCreatedAt?: string;
  stage: string;
  status: ProgressStatus;
  detail: string;
  progress: number | null;
  runId: string | null;
};

type SessionVmArtifact = VmRunArtifact & {
  runId: string;
  status?: string;
  attempt?: number;
  messageId: string;
  createdAt: string;
};

type MessageVmSessionFile = {
  runId: string;
  category: VmSessionOutputCategory;
  path: string;
  name: string;
  size: number;
  contentType?: string;
  isImage: boolean;
  messageId: string;
  createdAt: string;
};

type ChatTurnGroup = {
  id: string;
  messages: VmAgentMessage[];
};

type ChatItem =
  | { type: "message"; message: VmAgentMessage; key: string }
  | { type: "turn"; group: ChatTurnGroup; key: string };

type SessionMenuState = {
  runId: string;
  x: number;
  y: number;
  mode: "menu" | "rename" | "delete";
};

type UploadedAttachment = {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
  ref?: VmAgentAttachmentRef;
};

type ImagePreview = {
  src: string;
  title: string;
  downloadUrl: string;
};

type PendingImagePreview = {
  index: number;
  url: string;
  name: string;
  size: number;
};

const REFERENCE_CONTEXT_TOKENS = 1_000_000;
const REPLY_RETRY_INTERVAL_MS = 10_000;
const MAX_REPLY_RETRIES = 180;
const STREAM_RECONNECT_DELAY_MS = 3_000;
const STREAM_FALLBACK_POLL_MS = 10_000;
const SESSION_HISTORY_LIMIT = 5000;
const GLOBAL_HISTORY_LIMIT = 500;
const STREAM_BATCH_LIMIT = 500;
const SESSION_ORDER_KEY = "sentaurus_session_order";
const ATTACHMENT_ACCEPT = ".txt,.plt,.dat,.cmd,.des,.log,.out,.err,.csv,.json,.png,.jpg,.jpeg,.webp,.gif,.svg";
const MAX_PENDING_IMAGE_ATTACHMENTS = 12;
const OUTPUT_CATEGORIES: VmSessionOutputCategory[] = [...VM_SESSION_OUTPUT_CATEGORIES];
const INPUT_SESSION_CATEGORY = VM_SESSION_INPUT_CATEGORY;
const QUICK_PROMPTS: QuickPrompt[] = [
  {
    label: "Set bias",
    prompt: "For this TCAD session, help me define the gate/drain/source bias conditions and explain what sweep should be used."
  },
  {
    label: "Analyze curve",
    prompt: "Analyze the intended electrical curves for this device and tell me what transfer/output characteristics should be generated."
  },
  {
    label: "Plan implant",
    prompt: "Help me reason about ion implantation dose, concentration, and junction targets for this TCAD setup."
  },
  {
    label: "Simulation goal",
    prompt: "Summarize the simulation objective, required input files, expected curve outputs, and extraction metrics for this session."
  }
];

const SIMULATION_SETUP_FALLBACK = [
  { label: "Gate bias", value: "Vg sweep, defined by prompt or uploaded deck" },
  { label: "Drain bias", value: "Vd / Id target, extracted from experiment goal" },
  { label: "Source / bulk", value: "Reference terminal conditions" },
  { label: "Ion implantation", value: "Dose and concentration from SProcess inputs" },
  { label: "Device geometry", value: "Channel, oxide and contact setup from structure files" },
  { label: "Simulation goals", value: "Transfer curve, output curve, threshold and leakage extraction" }
];

const SETUP_FIELDS: Array<{ key: keyof SimulationSetup; label: string }> = [
  { key: "deviceType", label: "Device" },
  { key: "gateBias", label: "Gate bias" },
  { key: "drainBias", label: "Drain bias" },
  { key: "sourceBulk", label: "Source / bulk" },
  { key: "geometry", label: "Geometry" },
  { key: "dopingOrImplant", label: "Doping / implant" },
  { key: "physicsModels", label: "Physics models" },
  { key: "mesh", label: "Mesh" },
  { key: "temperature", label: "Temperature" },
  { key: "simulationGoals", label: "Simulation goals" },
  { key: "notes", label: "Notes" }
];

const EXPECTED_OUTPUTS = [
  "Electrical curve image: IV / transfer characteristic",
  "Electrical curve image: output characteristic",
  "Curve data file: .csv / .plt",
  "Device result file: .tdr",
  "Visualization image: structure, mesh or contour plot"
];

function messageSessionId(message: VmAgentMessage): string | null {
  const value = message.meta?.sessionId;
  return typeof value === "string" ? value : null;
}

function messageBelongsToSession(message: VmAgentMessage, sessionId: string): boolean {
  return messageSessionId(message) === sessionId;
}

function isProgressMessage(message: VmAgentMessage): boolean {
  return message.meta?.kind === "progress";
}

function isThinkingMessage(message: VmAgentMessage): boolean {
  return message.meta?.kind === "agent_thinking" || message.meta?.kind === "agent_reasoning_summary";
}

function messageKind(message: VmAgentMessage): string {
  return typeof message.meta?.kind === "string" ? message.meta.kind : "";
}

function isWorklogKind(kind: string): boolean {
  return kind === "worklog_summary" || kind === "file_operation" || kind === "tool_run" || kind === "run_progress" || kind === "run_diagnostic" || kind === "progress";
}

function isFoldableWorklogMessage(message: VmAgentMessage): boolean {
  const kind = messageKind(message);
  return message.role !== "user" && (message.meta?.foldable === true || isWorklogKind(kind));
}

function streamState(message: VmAgentMessage): string {
  const value = message.meta?.streamState ?? message.meta?.status;
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isAgentStreamDelta(message: VmAgentMessage): boolean {
  const kind = messageKind(message);
  return message.role === "agent" && (kind === "agent_response_delta" || message.meta?.delta === true);
}

function isAgentStreamDone(message: VmAgentMessage): boolean {
  if (message.role !== "agent") return false;
  const kind = messageKind(message);
  const state = streamState(message);
  return kind === "agent_response_done"
    || kind === "agent_response_error"
    || message.meta?.done === true
    || state === "done"
    || state === "completed"
    || state === "final"
    || state === "error";
}

function isAgentStreamingDraft(message: VmAgentMessage): boolean {
  if (message.role !== "agent") return false;
  if (isAgentStreamDelta(message)) return true;
  if (isAgentStreamDone(message)) return false;
  const kind = messageKind(message);
  const state = streamState(message);
  return kind === "agent_response_stream"
    || message.meta?.done === false
    || state === "queued"
    || state === "running"
    || state === "streaming";
}

function messageTurnId(message: VmAgentMessage): string | null {
  const value = message.meta?.turnId || message.meta?.groupId;
  return typeof value === "string" && value.trim() ? value : null;
}

function suppressAttachmentPreview(message: VmAgentMessage): boolean {
  return message.meta?.suppressAttachmentPreview === true;
}

function metaString(message: VmAgentMessage, key: string): string | null {
  const value = message.meta?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function streamTargetMessageId(message: VmAgentMessage): string | null {
  if (message.role !== "agent") return null;
  if (!isAgentStreamDelta(message) && !isAgentStreamingDraft(message) && !isAgentStreamDone(message)) return null;
  return metaString(message, "targetMessageId")
    || metaString(message, "messageId")
    || metaString(message, "streamId")
    || message.id;
}

function parseJsonValue<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function setupText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSimulationSetup(value: unknown): SimulationSetup | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<SimulationSetup>;
  const expectedOutputs = Array.isArray(record.expectedOutputs)
    ? record.expectedOutputs.flatMap((item) => {
      const text = setupText(item);
      return text ? [text] : [];
    })
    : undefined;
  return {
    deviceType: setupText(record.deviceType),
    gateBias: setupText(record.gateBias),
    drainBias: setupText(record.drainBias),
    sourceBulk: setupText(record.sourceBulk),
    geometry: setupText(record.geometry),
    dopingOrImplant: setupText(record.dopingOrImplant),
    physicsModels: setupText(record.physicsModels),
    mesh: setupText(record.mesh),
    temperature: setupText(record.temperature),
    simulationGoals: setupText(record.simulationGoals),
    expectedOutputs: expectedOutputs?.length ? expectedOutputs : undefined,
    notes: setupText(record.notes),
    updatedAt: setupText(record.updatedAt) || new Date().toISOString(),
    updatedBy: record.updatedBy === "user" || record.updatedBy === "system" ? record.updatedBy : "vm-agent"
  };
}

function simulationSetupFromMessage(message: VmAgentMessage): SimulationSetup | null {
  return normalizeSimulationSetup(parseJsonValue(metaString(message, "simulationSetupJson")));
}

function latestSimulationSetupFromMessages(messages: VmAgentMessage[]): SimulationSetup | null {
  for (const message of [...messages].reverse()) {
    const setup = simulationSetupFromMessage(message);
    if (setup) return setup;
  }
  return null;
}

function simulationSetupRows(setup: SimulationSetup | null): Array<{ label: string; value: string }> {
  if (!setup) return SIMULATION_SETUP_FALLBACK;
  const rows = SETUP_FIELDS.flatMap((field) => {
    const value = setup[field.key];
    return typeof value === "string" && value.trim() ? [{ label: field.label, value }] : [];
  });
  return rows.length > 0 ? rows : SIMULATION_SETUP_FALLBACK;
}

function expectedOutputsForSetup(setup: SimulationSetup | null): string[] {
  return setup?.expectedOutputs?.length ? setup.expectedOutputs : EXPECTED_OUTPUTS;
}

function isImagePath(filePath: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(filePath);
}

function isImageContentType(contentType?: string): boolean {
  if (!contentType) return false;
  return /^image\/(png|jpe?g|webp|gif)$/i.test(contentType.split(";")[0]?.trim() || "");
}

function isImageAttachmentLike(name: string, contentType?: string): boolean {
  return isImagePath(name) || isImageContentType(contentType);
}

function isImageFile(file: File): boolean {
  return isImageAttachmentLike(file.name, file.type);
}

function messageRunId(message: VmAgentMessage): string | null {
  const runId = message.meta?.vmRunId || message.meta?.runId;
  return typeof runId === "string" && runId.trim() ? runId : null;
}

function normalizeOutputCategory(value: unknown): VmSessionOutputCategory {
  return OUTPUT_CATEGORIES.includes(value as VmSessionOutputCategory) ? value as VmSessionOutputCategory : OUTPUT_CATEGORIES[1];
}

function vmArtifactsForMessage(message: VmAgentMessage): SessionVmArtifact[] {
  if (suppressAttachmentPreview(message)) return [];
  const artifacts: SessionVmArtifact[] = [];
  for (const attachment of message.attachments || []) {
    if (attachment.source !== "vm-run-artifact") continue;
    const runId = setupText(attachment.runId) || messageRunId(message);
    const artifactPath = setupText(attachment.path);
    if (!runId || !artifactPath) continue;
    artifacts.push({
      path: artifactPath,
      size: typeof attachment.size === "number" && Number.isFinite(attachment.size) ? attachment.size : 0,
      runId,
      messageId: message.id,
      createdAt: message.createdAt
    });
  }

  const attempts = parseJsonValue<unknown[]>(metaString(message, "autoDebugAttemptsJson"));
  if (Array.isArray(attempts)) {
    for (const attempt of attempts) {
      if (!attempt || typeof attempt !== "object") continue;
      const attemptRecord = attempt as { attempt?: unknown; runId?: unknown; status?: unknown; artifacts?: unknown };
      const runId = setupText(attemptRecord.runId);
      if (!runId || !Array.isArray(attemptRecord.artifacts)) continue;
      const attemptNo = typeof attemptRecord.attempt === "number" && Number.isFinite(attemptRecord.attempt) ? attemptRecord.attempt : undefined;
      const status = setupText(attemptRecord.status);
      for (const item of attemptRecord.artifacts) {
        if (!item || typeof item !== "object") continue;
        const record = item as Partial<VmRunArtifact>;
        const artifactPath = setupText(record.path);
        if (!artifactPath) continue;
        const size = typeof record.size === "number" && Number.isFinite(record.size) ? record.size : 0;
        artifacts.push({ path: artifactPath, size, runId, status, attempt: attemptNo, messageId: message.id, createdAt: message.createdAt });
      }
    }
  }

  const runId = messageRunId(message);
  const parsed = parseJsonValue<unknown[]>(metaString(message, "vmRunArtifactsJson"));
  if (runId && Array.isArray(parsed)) {
    const status = metaString(message, "vmRunStatus") || metaString(message, "runStatus") || undefined;
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const record = item as Partial<VmRunArtifact>;
      const artifactPath = setupText(record.path);
      if (!artifactPath) continue;
      const size = typeof record.size === "number" && Number.isFinite(record.size) ? record.size : 0;
      artifacts.push({ path: artifactPath, size, runId, status, messageId: message.id, createdAt: message.createdAt });
    }
  }

  const byKey = new Map<string, SessionVmArtifact>();
  for (const artifact of artifacts) byKey.set(`${artifact.runId}:${artifact.path}`, artifact);
  return [...byKey.values()];
}

function vmSessionFilesForMessage(message: VmAgentMessage): MessageVmSessionFile[] {
  if (suppressAttachmentPreview(message)) return [];
  const runId = messageRunId(message);
  const files: MessageVmSessionFile[] = [];

  for (const attachment of message.attachments || []) {
    if (attachment.source !== "vm-session-file") continue;
    const fileRunId = setupText(attachment.runId) || runId;
    const filePath = setupText(attachment.path);
    const name = setupText(attachment.name) || filePath?.split("/").at(-1) || filePath;
    if (!fileRunId || !filePath || !name) continue;
    files.push({
      runId: fileRunId,
      category: normalizeOutputCategory(attachment.category),
      path: filePath,
      name,
      size: typeof attachment.size === "number" && Number.isFinite(attachment.size) ? attachment.size : 0,
      contentType: setupText(attachment.contentType),
      isImage: isImageAttachmentLike(name || filePath, setupText(attachment.contentType)),
      messageId: message.id,
      createdAt: message.createdAt
    });
  }

  const parsed = parseJsonValue<unknown[]>(metaString(message, "vmSessionFilesJson"));
  if (runId && Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const filePath = setupText(record.path);
      const name = setupText(record.name) || filePath?.split("/").at(-1) || filePath;
      if (!filePath || !name) continue;
      const contentType = setupText(record.contentType);
      const isImage = typeof record.isImage === "boolean" ? record.isImage : isImageAttachmentLike(name || filePath, contentType);
      files.push({
        runId,
        category: normalizeOutputCategory(record.category),
        path: filePath,
        name,
        size: typeof record.size === "number" && Number.isFinite(record.size) ? record.size : 0,
        contentType,
        isImage,
        messageId: message.id,
        createdAt: message.createdAt
      });
    }
  }

  const byKey = new Map<string, MessageVmSessionFile>();
  for (const file of files) byKey.set(`${file.runId}:${file.category}:${file.path}`, file);
  return [...byKey.values()];
}

function vmArtifactsForSession(messages: VmAgentMessage[]): SessionVmArtifact[] {
  const byKey = new Map<string, SessionVmArtifact>();
  for (const artifact of messages.flatMap((message) => vmArtifactsForMessage(message))) {
    byKey.set(`${artifact.runId}:${artifact.path}`, artifact);
  }
  return [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function simulationSetupKey(setup: SimulationSetup | null | undefined): string {
  return setup ? JSON.stringify(setup) : "";
}

function messagesForSession(messages: VmAgentMessage[], sessionId: string | null): VmAgentMessage[] {
  if (!sessionId) return [];
  const filtered: VmAgentMessage[] = [];
  let waitingForLegacyReply = false;

  for (const message of messages) {
    const scopedSession = messageSessionId(message);
    if (scopedSession === sessionId) {
      filtered.push(message);
      waitingForLegacyReply = message.role === "user";
      continue;
    }

    if (!scopedSession && waitingForLegacyReply && message.role !== "user") {
      filtered.push(message);
      waitingForLegacyReply = false;
      continue;
    }

    if (scopedSession && scopedSession !== sessionId) {
      waitingForLegacyReply = false;
    }
  }

  return filtered;
}

function chatItemsForMessages(messages: VmAgentMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  let pending: ChatTurnGroup | null = null;

  const flush = () => {
    if (!pending) return;
    const onlyMessage = pending.messages[0];
    if (pending.messages.length === 1 && onlyMessage.role !== "user" && !isFoldableWorklogMessage(onlyMessage)) {
      items.push({ type: "message", message: onlyMessage, key: onlyMessage.id });
    } else {
      items.push({ type: "turn", group: pending, key: pending.id });
    }
    pending = null;
  };

  for (const message of messages) {
    const turnId = messageTurnId(message);
    if (!turnId) {
      flush();
      items.push({ type: "message", message, key: message.id });
      continue;
    }
    if (!pending || pending.id !== turnId) {
      flush();
      pending = { id: turnId, messages: [message] };
    } else {
      pending.messages.push(message);
    }
  }

  flush();
  return items;
}

function turnHasWorklog(group: ChatTurnGroup): boolean {
  return group.messages.some(isFoldableWorklogMessage);
}

function turnHasFinalResult(group: ChatTurnGroup): boolean {
  return group.messages.some((message) => {
    if (message.role === "user" || isFoldableWorklogMessage(message)) return false;
    if (isAgentStreamingDraft(message)) return false;
    const kind = messageKind(message);
    return kind === "run_final" || kind === "vm_agent_attachments" || message.meta?.summaryOfGroup === true || message.role === "agent";
  });
}

function globalAgentMessages(messages: VmAgentMessage[]): VmAgentMessage[] {
  return messages.filter((message) => !messageSessionId(message));
}

function loadSessionOrder(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_ORDER_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function saveSessionOrder(order: string[]): void {
  localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(order));
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function orderRuns(runs: RunSummary[], order: string[]): RunSummary[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const ordered = order.flatMap((id) => {
    const run = byId.get(id);
    return run ? [run] : [];
  });
  const known = new Set(order);
  return [...ordered, ...runs.filter((run) => !known.has(run.id))];
}

function statusTone(status?: RunStatus): "neutral" | "good" | "warn" | "bad" {
  if (status === "succeeded") return "good";
  if (status === "running" || status === "queued") return "warn";
  if (status === "failed" || status === "cancelled") return "bad";
  return "neutral";
}

function latestMessagePreview(messages: VmAgentMessage[], runId: string): string {
  const scoped = messages.filter((message) => messageBelongsToSession(message, runId) && !isProgressMessage(message) && !isThinkingMessage(message));
  const latest = scoped.at(-1);
  if (!latest) return "No scoped VM messages yet";
  const compact = latest.content.replace(/\s+/g, " ").trim();
  return compact.length > 86 ? `${compact.slice(0, 86)}...` : compact;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function progressStatus(value: unknown): ProgressStatus {
  return value === "completed" || value === "failed" || value === "queued" || value === "info" ? value : "running";
}

function progressLabel(stage: string): string {
  const labels: Record<string, string> = {
    received: "Received",
    skill: "Skill",
    llm_context: "Context",
    llm: "LLM",
    reply: "Reply",
    final: "Final",
    runner: "Runner",
    autodebug: "Auto-debug",
    repair_llm: "Repair LLM",
    run_validation: "Run validation",
    runner_prepare: "Prepare",
    sentaurus_step: "Sentaurus",
    artifacts: "Artifacts",
    worker: "Worker"
  };
  return labels[stage] || stage.replace(/_/g, " ");
}

function progressRowsForSession(messages: VmAgentMessage[], sessionId: string | null): ProgressRow[] {
  if (!sessionId) return [];
  return messages.flatMap((message) => {
    if (!messageBelongsToSession(message, sessionId) || !isProgressMessage(message)) return [];
    const meta = message.meta || {};
    const stage = typeof meta.progressStage === "string" ? meta.progressStage : "progress";
    const detail = typeof meta.progressDetail === "string" ? meta.progressDetail : message.content;
    const rawProgress = typeof meta.progress === "number" ? meta.progress : null;
    const runId = typeof meta.runId === "string" ? meta.runId : null;
    return [{
      id: message.id,
      createdAt: message.createdAt,
      vmCreatedAt: message.vmCreatedAt,
      stage,
      status: progressStatus(meta.progressStatus),
      detail,
      progress: rawProgress === null ? null : Math.max(0, Math.min(100, rawProgress)),
      runId
    }];
  });
}

function thinkingMessagesForSession(messages: VmAgentMessage[], sessionId: string | null): VmAgentMessage[] {
  if (!sessionId) return [];
  return messages.filter((message) => messageBelongsToSession(message, sessionId) && isThinkingMessage(message)).slice(-8);
}

function thinkingStageLabel(message: VmAgentMessage): string {
  const stage = metaString(message, "thinkingStage") || metaString(message, "progressStage") || "working";
  return stage.replace(/_/g, " ");
}

function estimateTextTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of value) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii);
}

function estimatedMessageText(message: VmAgentMessage): string {
  return JSON.stringify({
    role: message.role,
    source: (message as VmAgentMessage & { source?: string }).source,
    content: message.content,
    meta: message.meta,
    attachments: message.attachments
  });
}

function estimateContextUsage(messages: VmAgentMessage[]): ContextStats {
  const serializedMessages = messages.map(estimatedMessageText);
  const characters = serializedMessages.reduce((total, text) => total + text.length, 0);
  const estimatedTokens = serializedMessages.reduce((total, text) => total + estimateTextTokens(text), 0);
  return {
    characters,
    estimatedTokens,
    messageCount: messages.length,
    percent: Math.min(100, Math.round((estimatedTokens / REFERENCE_CONTEXT_TOKENS) * 100)),
    maxTokens: REFERENCE_CONTEXT_TOKENS
  };
}

function newSystemMessage(content: string, sessionId: string | null): VmAgentMessage {
  return {
    id: `ui_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    role: "system",
    content,
    createdAt: new Date().toISOString(),
    meta: sessionId ? { sessionId } : undefined
  };
}

function messageSequence(message: VmAgentMessage): number | null {
  return typeof message.sequence === "number" && Number.isFinite(message.sequence) ? message.sequence : null;
}

function messageTime(message: VmAgentMessage): number {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeMessageList(prev: VmAgentMessage[], next: VmAgentMessage[] | undefined): VmAgentMessage[] {
  if (!next?.length) return prev;
  const byId = new Map(prev.map((message) => [message.id, message]));
  for (const message of next) {
    const targetMessageId = streamTargetMessageId(message);
    if (targetMessageId) {
      const existing = byId.get(targetMessageId);
      const appendContent = isAgentStreamDelta(message) || message.meta?.append === true;
      const mergedContent = existing && appendContent
        ? `${existing.content}${message.content}`
        : message.content || existing?.content || "";
      byId.set(targetMessageId, {
        ...existing,
        ...message,
        id: targetMessageId,
        role: "agent",
        content: mergedContent,
        createdAt: existing?.createdAt || message.createdAt,
        sequence: existing?.sequence ?? message.sequence,
        meta: {
          ...existing?.meta,
          ...message.meta,
          kind: isAgentStreamDone(message) ? messageKind(message) || "agent_response_done" : "agent_response_stream",
          done: isAgentStreamDone(message)
        },
        attachments: message.attachments || existing?.attachments
      });
      continue;
    }
    const existing = byId.get(message.id);
    byId.set(message.id, existing ? { ...existing, ...message, meta: { ...existing.meta, ...message.meta } } : message);
  }
  return [...byId.values()].sort((a, b) => {
    const aSequence = messageSequence(a);
    const bSequence = messageSequence(b);
    if (aSequence !== null && bSequence !== null && aSequence !== bSequence) return aSequence - bSequence;
    return messageTime(a) - messageTime(b);
  });
}

function formatClockSkew(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  let remaining = Math.round(Math.abs(value) / 1000);
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining - minutes * 60;
  if (hours > 0) return `${sign}${hours}h ${minutes}m`;
  if (minutes > 0) return `${sign}${minutes}m ${seconds}s`;
  return `${sign}${seconds}s`;
}

function formatReplyWait(retryCount: number): string {
  const elapsedSeconds = Math.round((retryCount * REPLY_RETRY_INTERVAL_MS) / 1000);
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function isSentaurusRunCompletion(message: VmAgentMessage): boolean {
  return message.role === "agent" && message.meta?.kind === "sentaurus_run";
}

function sentaurusRunStatus(message: VmAgentMessage): string | null {
  const value = message.meta?.runStatus ?? message.meta?.vmRunStatus;
  return typeof value === "string" ? value : null;
}

function hasAgentReplyForSession(messages: VmAgentMessage[] | undefined, sessionId: string): boolean {
  return !!messages?.some((message) => {
    const isAgentReply = message.role === "agent" && !isAgentStreamingDraft(message);
    const isSystemError = message.role === "system" && (message.meta?.kind === "llm_error" || message.meta?.kind === "worker_error");
    if (!isAgentReply && !isSystemError) return false;
    const scopedSession = messageSessionId(message);
    return scopedSession === sessionId || scopedSession === null;
  });
}

function refKey(ref: VmAgentAttachmentRef): string {
  return `${ref.source}:${ref.runId || ""}:${ref.category || ""}:${ref.path}`;
}

function attachmentStateLabel(ref?: VmAgentAttachmentRef): string {
  if (!ref) return "uploaded";
  const contextStatus = (ref as VmAgentAttachmentRef & { contextStatus?: string }).contextStatus;
  if (contextStatus) return contextStatus.replace(/_/g, " ");
  if (ref.source === "run-input") return "inline fallback";
  if (ref.source === "vm-session-file") return "synced";
  if (ref.source === "vm-run-artifact") return "VM artifact";
  return "attached";
}

function normalizeAttachmentSource(value: unknown): VmAgentMessageAttachment["source"] | null {
  return value === "run-input" || value === "vm-session-file" || value === "vm-run-artifact" ? value : null;
}

function displayAttachmentFromRef(ref: VmAgentAttachmentRef): VmAgentMessageAttachment {
  return {
    id: ref.id,
    kind: isImageAttachmentLike(ref.name || ref.path, ref.contentType) ? "image" : "file",
    name: ref.name,
    size: ref.size,
    contentType: ref.contentType,
    source: ref.source,
    path: ref.path,
    runId: ref.runId,
    category: ref.category
  };
}

function displayAttachmentFromMessage(attachment: NonNullable<VmAgentMessage["attachments"]>[number], message: VmAgentMessage): VmAgentMessageAttachment | null {
  const source = normalizeAttachmentSource(attachment.source);
  const path = setupText(attachment.path);
  const name = setupText(attachment.name) || path?.split("/").at(-1);
  if (!source || !path || !name) return null;
  const contentType = setupText(attachment.contentType);
  const category = source === "vm-session-file" ? normalizeOutputCategory(attachment.category) : undefined;
  const runId = setupText(attachment.runId) || (source !== "run-input" ? messageRunId(message) || undefined : undefined);
  return {
    id: setupText(attachment.id) || `${source}:${runId || ""}:${category || ""}:${path}`.replace(/[^A-Za-z0-9_.:-]/g, "_"),
    kind: attachment.kind === "image" || attachment.kind === "file" ? attachment.kind : isImageAttachmentLike(name || path, contentType) ? "image" : "file",
    name,
    size: typeof attachment.size === "number" && Number.isFinite(attachment.size) ? attachment.size : 0,
    contentType,
    source,
    path,
    runId,
    category,
    width: typeof attachment.width === "number" ? attachment.width : undefined,
    height: typeof attachment.height === "number" ? attachment.height : undefined,
    thumbnailPath: setupText(attachment.thumbnailPath)
  };
}

function displayAttachmentFromUploaded(file: UploadedAttachment, runId: string | null): VmAgentMessageAttachment {
  if (file.ref) return displayAttachmentFromRef(file.ref);
  return {
    id: file.id,
    kind: isImageAttachmentLike(file.name) ? "image" : "file",
    name: file.name,
    size: file.size,
    source: "run-input",
    path: file.name,
    runId: runId || undefined
  };
}

function imageAttachmentUrl(attachment: VmAgentMessageAttachment): string {
  if (attachment.source === "run-input" && attachment.runId) {
    return downloadUrl(attachment.runId, "files", attachment.path || attachment.name);
  }
  if (attachment.source === "vm-run-artifact" && attachment.runId) {
    return vmRunArtifactDownloadUrl(attachment.runId, attachment.path);
  }
  if (attachment.source === "vm-session-file" && attachment.runId && attachment.category) {
    return vmSessionFileDownloadUrl(attachment.runId, attachment.category, attachment.path);
  }
  return "";
}

function displayAttachmentKey(attachment: VmAgentMessageAttachment): string {
  return `${attachment.source}:${attachment.runId || ""}:${attachment.category || ""}:${attachment.path}`;
}

function renderInlineCode(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

function renderMessageText(content: string): ReactNode {
  const lines = content.split(/\r?\n/);
  return lines.map((line, index) => {
    const listMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (listMatch) {
      return <div className="message-list-line" key={index}><span>-</span><p>{renderInlineCode(listMatch[1])}</p></div>;
    }
    return <p key={index}>{renderInlineCode(line || " ")}</p>;
  });
}

function vmArtifactDisplayKey(file: SessionVmArtifact): string {
  return `vm-run-artifact:${file.runId}::${file.path}`;
}

function vmSessionFileDisplayKey(file: MessageVmSessionFile): string {
  return `vm-session-file:${file.runId}:${file.category}:${file.path}`;
}

function vmSessionFileAttachmentRef(file: MessageVmSessionFile): VmAgentAttachmentRef {
  return {
    id: `session_${file.runId}_${file.category}_${file.path}`.replace(/[^A-Za-z0-9_.:-]/g, "_"),
    source: "vm-session-file",
    name: file.name || file.path,
    path: file.path,
    size: file.size,
    runId: file.runId,
    category: file.category,
    contentType: file.contentType
  };
}

function attachmentRefFromDisplayAttachment(attachment: VmAgentMessageAttachment): VmAgentAttachmentRef | null {
  if (!attachment.runId) return null;
  return {
    id: attachment.id,
    source: attachment.source,
    name: attachment.name || attachment.path,
    path: attachment.path,
    size: attachment.size,
    runId: attachment.runId,
    category: attachment.category,
    contentType: attachment.contentType
  };
}

export default function App() {
  const { notify } = useToast();
  const savedToken = getAuthToken();
  const [authInput, setAuthInput] = useState(savedToken);
  const [authKey, setAuthKey] = useState(savedToken);
  const [health, setHealth] = useState<string>("checking");
  const [vm, setVm] = useState<VmStatus | null>(null);
  const [vmLoading, setVmLoading] = useState(false);
  const [vmAgent, setVmAgent] = useState<VmAgentStatus | null>(null);
  const [vmAgentMessages, setVmAgentMessages] = useState<VmAgentMessage[]>([]);
  const [composer, setComposer] = useState("");
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(null);
  const [slashSuggestionIndex, setSlashSuggestionIndex] = useState(0);
  const [vmAgentStatusLoading, setVmAgentStatusLoading] = useState(false);
  const [vmAgentConnectLoading, setVmAgentConnectLoading] = useState(false);
  const [vmAgentHistoryLoading, setVmAgentHistoryLoading] = useState(false);
  const [vmSessionFiles, setVmSessionFiles] = useState<VmSessionFilesResponse>({ categories: OUTPUT_CATEGORIES, files: [] });
  const [vmSessionFilesLoading, setVmSessionFilesLoading] = useState(false);
  const [collapsedOutputCategories, setCollapsedOutputCategories] = useState<Partial<Record<VmSessionOutputCategory, boolean>>>({});
  const [messageSending, setMessageSending] = useState(false);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [pendingReplySessionId, setPendingReplySessionId] = useState<string | null>(null);
  const [pendingReplyRetryCount, setPendingReplyRetryCount] = useState(0);
  const [vmAgentStreamState, setVmAgentStreamState] = useState("idle");
  const [progressCollapsed, setProgressCollapsed] = useState(true);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  const [mobileLeftPanelOpen, setMobileLeftPanelOpen] = useState(false);
  const [mobileRightPanelOpen, setMobileRightPanelOpen] = useState(false);
  const [mobileChatInfoOpen, setMobileChatInfoOpen] = useState(false);
  const [mobileComposerToolsOpen, setMobileComposerToolsOpen] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsHydrated, setRunsHydrated] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [historyAttemptedSessionId, setHistoryAttemptedSessionId] = useState<string | null>(null);
  const [sessionHistoryById, setSessionHistoryById] = useState<Record<string, SessionHistoryState>>({});
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [panelNotice, setPanelNotice] = useState<PanelNotice | null>(null);
  const [sessionOrder, setSessionOrder] = useState<string[]>(() => loadSessionOrder());
  const [sessionSearch, setSessionSearch] = useState("");
  const [draggedRunId, setDraggedRunId] = useState<string | null>(null);
  const [dragOverRunId, setDragOverRunId] = useState<string | null>(null);
  const [sessionMenu, setSessionMenu] = useState<SessionMenuState | null>(null);
  const [closingSessionMenu, setClosingSessionMenu] = useState<SessionMenuState | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<File[]>([]);
  const [pendingVmAttachments, setPendingVmAttachments] = useState<VmAgentAttachmentRef[]>([]);
  const [messageAttachments, setMessageAttachments] = useState<Record<string, UploadedAttachment[]>>({});
  const [messageDisplayOverrides, setMessageDisplayOverrides] = useState<Record<string, string>>({});
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const [pendingImagePreviews, setPendingImagePreviews] = useState<PendingImagePreview[]>([]);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [agentsModalOpen, setAgentsModalOpen] = useState(false);
  const [agentsModalLoading, setAgentsModalLoading] = useState(false);
  const [agentsModalSaving, setAgentsModalSaving] = useState(false);
  const [agentsModalError, setAgentsModalError] = useState<string | null>(null);
  const [agentsModalDraft, setAgentsModalDraft] = useState("");
  const [agentsModalSavedValue, setAgentsModalSavedValue] = useState("");
  const [worklogClock, setWorklogClock] = useState(Date.now());
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const agentsTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingReplySessionRef = useRef<string | null>(null);
  const pendingReplyRetryRef = useRef(0);
  const vmAgentCursorRef = useRef(0);
  const selectedRunIdRef = useRef<string | null>(null);
  const notifiedCompletionIdsRef = useRef<Set<string>>(new Set());
  const sessionMenuCloseTimerRef = useRef<number | null>(null);
  const composerDragDepthRef = useRef(0);
  const setupSyncKeyRef = useRef("");
  const historyRequestSequenceRef = useRef(0);
  const historyAbortControllerRef = useRef<AbortController | null>(null);
  const vmSessionFilesRequestRef = useRef<{
    sessionId: string;
    controller: AbortController;
    promise: Promise<VmSessionFilesResponse>;
  } | null>(null);

  selectedRunIdRef.current = selectedRunId;

  const activeSlashQuery = slashCommandQuery(composer);
  const visibleSlashSuggestions = useMemo(() => {
    if (!activeSlashQuery || dismissedSlashQuery === activeSlashQuery) return [];
    return slashCommandSuggestions(composer);
  }, [activeSlashQuery, composer, dismissedSlashQuery]);
  const activeSlashSuggestion = visibleSlashSuggestions[slashSuggestionIndex] || visibleSlashSuggestions[0] || null;
  const agentsModalDirty = agentsModalDraft !== agentsModalSavedValue;

  useEffect(() => {
    const previews = pendingAttachments
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => isImageFile(file))
      .slice(0, MAX_PENDING_IMAGE_ATTACHMENTS)
      .map(({ file, index }) => ({
        index,
        url: URL.createObjectURL(file),
        name: file.name,
        size: file.size
      }));
    setPendingImagePreviews(previews);
    return () => {
      previews.forEach((preview) => URL.revokeObjectURL(preview.url));
    };
  }, [pendingAttachments]);

  useEffect(() => {
    if (panelNotice) notify(panelNotice.kind, panelNotice.text);
  }, [notify, panelNotice]);

  useEffect(() => {
    if (!activeSlashQuery) {
      setDismissedSlashQuery(null);
      setSlashSuggestionIndex(0);
      return;
    }
    if (dismissedSlashQuery && dismissedSlashQuery !== activeSlashQuery) {
      setDismissedSlashQuery(null);
    }
  }, [activeSlashQuery, dismissedSlashQuery]);

  useEffect(() => {
    if (slashSuggestionIndex < visibleSlashSuggestions.length) return;
    setSlashSuggestionIndex(0);
  }, [slashSuggestionIndex, visibleSlashSuggestions.length]);

  useEffect(() => {
    if (!agentsModalOpen) return;
    agentsTextareaRef.current?.focus();
  }, [agentsModalOpen]);

  const orderedRuns = useMemo(() => orderRuns(runs, sessionOrder), [runs, sessionOrder]);
  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) || null, [runs, selectedRunId]);
  const selectedHistoryState = selectedRunId ? sessionHistoryById[selectedRunId] || IDLE_SESSION_HISTORY : IDLE_SESSION_HISTORY;
  const selectedHistoryPhase = selectedHistoryState.phase;
  const historyBootstrapSettled = isHistoryBootstrapSettled(runsHydrated, selectedRunId, historyAttemptedSessionId);
  const visibleSessionMenu = sessionMenu || closingSessionMenu;
  const menuRun = useMemo(() => runs.find((run) => run.id === visibleSessionMenu?.runId) || null, [runs, visibleSessionMenu]);
  const currentMessages = useMemo(() => messagesForSession(vmAgentMessages, selectedRunId), [selectedRunId, vmAgentMessages]);
  const visibleMessages = useMemo(() => currentMessages.filter((message) => {
    if (isThinkingMessage(message)) return false;
    if (isProgressMessage(message)) return !!messageTurnId(message);
    return true;
  }), [currentMessages]);
  const chatItems = useMemo(() => chatItemsForMessages(visibleMessages), [visibleMessages]);
  const hasActiveWorklog = useMemo(() => chatItems.some((item) => (
    item.type === "turn"
    && item.group.messages.some((message) => message.role === "user")
    && !turnHasFinalResult(item.group)
  )), [chatItems]);
  const progressRows = useMemo(() => progressRowsForSession(vmAgentMessages, selectedRunId).slice(-12), [selectedRunId, vmAgentMessages]);
  const thinkingMessages = useMemo(() => thinkingMessagesForSession(vmAgentMessages, selectedRunId), [selectedRunId, vmAgentMessages]);
  const messageSimulationSetup = useMemo(() => latestSimulationSetupFromMessages(currentMessages), [currentMessages]);
  const currentSimulationSetup = messageSimulationSetup || runDetail?.run.simulationSetup || selectedRun?.simulationSetup || null;
  const simulationRows = useMemo(() => simulationSetupRows(currentSimulationSetup), [currentSimulationSetup]);
  const expectedOutputs = useMemo(() => expectedOutputsForSetup(currentSimulationSetup), [currentSimulationSetup]);
  const vmRunArtifacts = useMemo(() => vmArtifactsForSession(currentMessages), [currentMessages]);
  const latestRunMessageKey = useMemo(() => {
    const latest = [...currentMessages].reverse().find((message) => message.meta?.kind === "sentaurus_run");
    return latest ? `${latest.id}:${latest.meta?.vmRunArtifactCount ?? ""}:${latest.meta?.autoDebugAttemptCount ?? ""}` : "";
  }, [currentMessages]);
  const latestProgress = progressRows.at(-1);
  const globalMessages = useMemo(() => globalAgentMessages(vmAgentMessages).slice(-6), [vmAgentMessages]);
  const contextStats = useMemo(() => estimateContextUsage(visibleMessages), [visibleMessages]);
  const query = sessionSearch.trim().toLowerCase();
  const visibleRuns = useMemo(() => {
    if (!query) return orderedRuns;
    return orderedRuns.filter((run) => {
      const preview = latestMessagePreview(vmAgentMessages, run.id).toLowerCase();
      return run.title.toLowerCase().includes(query) || run.id.toLowerCase().includes(query) || preview.includes(query);
    });
  }, [orderedRuns, query, vmAgentMessages]);
  const currentTitle = selectedRun?.title || "No session selected";
  const vmOnline = vm?.ok ?? null;
  const workerRunning = vmAgent?.workerRunning ?? null;
  const llmConfigured = vmAgent?.llmConfigured ?? null;
  const clockSkewWarning = vmAgent?.clockSkewWarning ?? false;
  const clockSkewLabel = formatClockSkew(vmAgent?.clockSkewMs);
  const clockSkewOk = typeof vmAgent?.clockSkewMs === "number" ? !clockSkewWarning : null;
  const canSendMessage = !!authKey && !!selectedRunId && !messageSending && !attachmentUploading;
  const composerDropEnabled = !!authKey && !!selectedRunId && !messageSending && !attachmentUploading;
  const waitingForAgentReply = !!pendingReplySessionId;
  const startAgentDisabled = !authKey || vmAgentConnectLoading || messageSending || waitingForAgentReply;

  useEffect(() => {
    if (!hasActiveWorklog) return undefined;
    setWorklogClock(Date.now());
    const interval = window.setInterval(() => setWorklogClock(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [hasActiveWorklog]);

  function setVmAgentCursorValue(cursor: number) {
    const nextCursor = Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
    vmAgentCursorRef.current = nextCursor;
  }

  function beginPendingAgentReply(sessionId: string) {
    pendingReplySessionRef.current = sessionId;
    pendingReplyRetryRef.current = 0;
    setPendingReplySessionId(sessionId);
    setPendingReplyRetryCount(0);
  }

  function clearPendingAgentReply(sessionId?: string) {
    if (sessionId && pendingReplySessionRef.current !== sessionId) return;
    pendingReplySessionRef.current = null;
    pendingReplyRetryRef.current = 0;
    setPendingReplySessionId(null);
    setPendingReplyRetryCount(0);
  }

  function forceStopPendingReply() {
    if (!pendingReplySessionRef.current) return;
    clearPendingAgentReply();
    recordSystemNotice("Stopped waiting for the current agent reply. You can restart the agent if needed.", "error");
  }

  function closeMobilePanels() {
    setMobileLeftPanelOpen(false);
    setMobileRightPanelOpen(false);
  }

  function mergeVmAgentMessages(next: VmAgentMessage[] | undefined) {
    setVmAgentMessages((prev) => mergeMessageList(prev, next));
  }

  function recordSystemNotice(text: string, kind: PanelNotice["kind"] = "info") {
    setPanelNotice({ kind, text });
    setVmAgentMessages((prev) => [...prev, newSystemMessage(text, selectedRunId)]);
  }

  function recordError(err: unknown) {
    recordSystemNotice(errorMessage(err), "error");
  }

  function handleVmAgentMessageBatch(batch: VmAgentMessage[] | undefined) {
    if (!batch?.length) return;
    for (const message of batch) {
      if (!isSentaurusRunCompletion(message)) continue;
      if (notifiedCompletionIdsRef.current.has(message.id)) continue;
      notifiedCompletionIdsRef.current.add(message.id);

      const sessionId = messageSessionId(message);
      const runStatus = sentaurusRunStatus(message);
      const ok = runStatus === "succeeded";
      setPanelNotice({
        kind: ok ? "success" : "error",
        text: ok
          ? "Sentaurus simulation completed. Final result has been appended to the chat."
          : "Sentaurus simulation finished with errors. Check the final result message and logs."
      });
      if (sessionId && sessionId === selectedRunIdRef.current) {
        void refreshRunDetail(sessionId);
        void refreshVmSessionFiles(sessionId, false);
      }
      void refreshRuns();
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(ok ? "Sentaurus simulation completed" : "Sentaurus simulation finished with errors", {
          body: sessionId ? `Session ${shortId(sessionId)} - ${runStatus || "finished"}` : runStatus || "finished"
        });
      }
    }
  }

  async function saveToken() {
    const next = normalizeAuthToken(authInput);
    setAuthInput(next);
    setAuthToken(next);
    setAuthKey(next);
    if (!next) {
      setPanelNotice({ kind: "error", text: "AUTH_TOKEN is required." });
      return;
    }
    setPanelNotice({ kind: "info", text: "Checking AUTH_TOKEN..." });
    try {
      const result = await listRuns();
      setRuns(result.runs);
      setRunsHydrated(true);
      if (!selectedRunId && result.runs[0]) setSelectedRunId(result.runs[0].id);
      setPanelNotice({ kind: "success", text: "AUTH_TOKEN saved." });
    } catch (err) {
      recordError(err);
    }
  }

  async function refreshVm() {
    setVmLoading(true);
    try {
      setVm(await getVmStatus());
    } catch (err) {
      recordError(err);
    } finally {
      setVmLoading(false);
    }
  }

  async function refreshVmAgent() {
    setVmAgentStatusLoading(true);
    try {
      setVmAgent(await getVmAgentStatus());
    } catch (err) {
      recordError(err);
    } finally {
      setVmAgentStatusLoading(false);
    }
  }

  async function handleConnectVmAgent() {
    setVmAgentConnectLoading(true);
    try {
      const response = await connectVmAgent();
      const messages = response.messages || (response.message ? [response.message] : []);
      setVmAgent(response.status);
      setVmAgentCursorValue(response.cursor || 0);
      mergeVmAgentMessages(messages);
      handleVmAgentMessageBatch(messages);
      setPanelNotice({ kind: "success", text: "VM agent connection refreshed." });
    } catch (err) {
      recordError(err);
    } finally {
      setVmAgentConnectLoading(false);
    }
  }

  async function loadSelectedSessionHistory(
    sessionId: string,
    options: { retrying?: boolean; showBusy?: boolean } = {}
  ): Promise<boolean> {
    const requestSequence = historyRequestSequenceRef.current + 1;
    historyRequestSequenceRef.current = requestSequence;
    historyAbortControllerRef.current?.abort();
    const controller = new AbortController();
    historyAbortControllerRef.current = controller;
    setSessionHistoryById((current) => ({
      ...current,
      [sessionId]: loadingSessionHistoryState(current[sessionId], options.retrying)
    }));
    if (options.showBusy) setVmAgentHistoryLoading(true);

    try {
      const response = await getVmAgentMessages(0, { limit: SESSION_HISTORY_LIMIT, sessionId, signal: controller.signal });
      if (!isCurrentHistoryRequest(historyRequestSequenceRef.current, requestSequence, selectedRunIdRef.current, sessionId)) return false;
      assertHistoryResponse(response);
      setVmAgent(response.status);
      setVmAgentCursorValue(response.cursor);
      mergeVmAgentMessages(response.messages);
      handleVmAgentMessageBatch(response.messages);
      setSessionHistoryById((current) => ({
        ...current,
        [sessionId]: completedSessionHistoryState(response)
      }));
      setHistoryAttemptedSessionId(sessionId);
      return true;
    } catch (err) {
      if (controller.signal.aborted) return false;
      if (!isCurrentHistoryRequest(historyRequestSequenceRef.current, requestSequence, selectedRunIdRef.current, sessionId)) return false;
      const details = historyErrorDetails(err, errorMessage(err));
      if (details.status) setVmAgent(details.status);
      setSessionHistoryById((current) => ({
        ...current,
        [sessionId]: failedSessionHistoryState(current[sessionId], details)
      }));
      setHistoryAttemptedSessionId(sessionId);
      return false;
    } finally {
      if (historyAbortControllerRef.current === controller) historyAbortControllerRef.current = null;
      if (options.showBusy && historyRequestSequenceRef.current === requestSequence) {
        setVmAgentHistoryLoading(false);
      }
    }
  }

  async function handleRefreshVmAgentMessages(showBusy = true) {
    if (selectedRunId) {
      await loadSelectedSessionHistory(selectedRunId, {
        retrying: selectedHistoryPhase === "failed",
        showBusy
      });
      return;
    }
    if (showBusy) setVmAgentHistoryLoading(true);
    try {
      const response = await getVmAgentMessages(0, { limit: GLOBAL_HISTORY_LIMIT });
      assertHistoryResponse(response);
      setVmAgent(response.status);
      setVmAgentCursorValue(response.cursor);
      mergeVmAgentMessages(response.messages);
      handleVmAgentMessageBatch(response.messages);
    } catch (err) {
      recordError(err);
    } finally {
      if (showBusy) setVmAgentHistoryLoading(false);
    }
  }

  function applySlashSuggestion(suggestion: SlashCommandSuggestion) {
    setComposer(applySlashCommandSuggestion(composer, suggestion));
    setDismissedSlashQuery(null);
    setSlashSuggestionIndex(0);
    window.requestAnimationFrame(() => composerInputRef.current?.focus());
  }

  async function openAgentsModal() {
    if (!authKey) {
      setPanelNotice({ kind: "error", text: "Save AUTH_TOKEN before editing VM AGENTS.md." });
      return;
    }
    setAgentsModalOpen(true);
    setAgentsModalLoading(true);
    setAgentsModalError(null);
    try {
      const response = await getVmAgentAgentsMd();
      setAgentsModalDraft(response.content || "");
      setAgentsModalSavedValue(response.content || "");
    } catch (err) {
      const message = errorMessage(err);
      setAgentsModalError(message);
      setAgentsModalDraft("");
      setAgentsModalSavedValue("");
    } finally {
      setAgentsModalLoading(false);
    }
  }

  function closeAgentsModal(force = false) {
    if (agentsModalSaving) return;
    if (!force && agentsModalDirty && !window.confirm("Discard unsaved AGENTS.md changes?")) return;
    setAgentsModalOpen(false);
    setAgentsModalError(null);
  }

  async function saveAgentsModal() {
    if (!authKey || agentsModalLoading || agentsModalSaving) return;
    setAgentsModalSaving(true);
    setAgentsModalError(null);
    try {
      const response = await saveVmAgentAgentsMd(agentsModalDraft);
      setAgentsModalDraft(response.content || "");
      setAgentsModalSavedValue(response.content || "");
      setPanelNotice({ kind: "success", text: "VM AGENTS.md saved." });
    } catch (err) {
      setAgentsModalError(errorMessage(err));
    } finally {
      setAgentsModalSaving(false);
    }
  }

  async function handleVmAgentMessage(textOverride?: string) {
    const text = (textOverride ?? composer).trim();
    const attachments = textOverride ? [] : pendingAttachments;
    const vmAttachments = textOverride ? [] : pendingVmAttachments;
    if (!text && attachments.length === 0 && vmAttachments.length === 0) return;
    if (!selectedRunId) {
      setPanelNotice({ kind: "error", text: "Create or select a session before sending a message." });
      return;
    }
    setMessageSending(true);
    if (attachments.length > 0) setAttachmentUploading(true);
    setComposer("");
    setPendingAttachments([]);
    setPendingVmAttachments([]);
    const uploadedAttachments: UploadedAttachment[] = [];
    const attachmentRefs: VmAgentAttachmentRef[] = [...vmAttachments];
    const displayAttachments: VmAgentMessageAttachment[] = vmAttachments.map(displayAttachmentFromRef);
    try {
      for (const file of attachments) {
        const uploaded = await uploadRunFile(selectedRunId, file);
        const vmSync = uploaded.vmSync;
        const ref: VmAgentAttachmentRef = {
          id: `${file.name}_${file.size}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          source: vmSync?.ok ? "vm-session-file" : "run-input",
          name: uploaded.file.name,
          path: vmSync?.ok ? vmSync.path || uploaded.file.name : uploaded.file.name,
          size: uploaded.file.size,
          runId: selectedRunId,
          category: vmSync?.ok ? vmSync.category || INPUT_SESSION_CATEGORY : undefined,
          contentType: file.type || undefined
        };
        attachmentRefs.push(ref);
        const displayRef: VmAgentAttachmentRef = {
          ...ref,
          source: "run-input",
          path: uploaded.file.name,
          category: undefined
        };
        displayAttachments.push(displayAttachmentFromRef(displayRef));
        uploadedAttachments.push({
          id: ref.id,
          name: uploaded.file.name,
          size: uploaded.file.size,
          uploadedAt: new Date().toISOString(),
          ref: displayRef
        });
        if (!vmSync?.ok) {
          setPanelNotice({ kind: "info", text: `${uploaded.file.name} will be provided inline because VM sync was not confirmed.` });
        }
      }
      if (uploadedAttachments.length > 0) await refreshRunDetail(selectedRunId);
      if (uploadedAttachments.length > 0) await refreshVmSessionFiles(selectedRunId, false);

      const allAttachmentNames = [...uploadedAttachments.map((file) => file.name), ...vmAttachments.map((file) => file.name)];
      const attachmentLine = allAttachmentNames.length > 0
        ? `\n\nAttachments available to the VM agent: ${allAttachmentNames.join(", ")}.`
        : "";
      const visibleText = text || `Attached ${allAttachmentNames.length} file${allAttachmentNames.length === 1 ? "" : "s"}.`;
      const optimisticTurnId = `ui_turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const optimisticUserMessage: VmAgentMessage = {
        id: `ui_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: "user",
        content: visibleText,
        createdAt: new Date().toISOString(),
        meta: { sessionId: selectedRunId, turnId: optimisticTurnId, pending: true }
      };
      mergeVmAgentMessages([optimisticUserMessage]);
      beginPendingAgentReply(selectedRunId);
      const response = await sendVmAgentMessage(`${visibleText}${attachmentLine}`, selectedRunId, attachmentRefs, displayAttachments);
      const messages = response.messages || [response.message];
      setVmAgent(response.status);
      setVmAgentCursorValue(response.cursor);
      const userMessage = [...messages]
        .reverse()
        .find((message) => message.role === "user" && messageBelongsToSession(message, selectedRunId));
      const responseTurnId = messages.map(messageTurnId).find((turnId): turnId is string => !!turnId);
      if (userMessage) {
        setVmAgentMessages((prev) => prev.filter((message) => message.id !== optimisticUserMessage.id));
      } else if (responseTurnId) {
        setVmAgentMessages((prev) => prev.map((message) => (
          message.id === optimisticUserMessage.id
            ? { ...message, meta: { ...message.meta, turnId: responseTurnId } }
            : message
        )));
      }
      if (userMessage && (uploadedAttachments.length > 0 || vmAttachments.length > 0)) {
        const vmDisplayAttachments: UploadedAttachment[] = vmAttachments.map((ref) => ({
          id: ref.id,
          name: ref.name,
          size: ref.size,
          uploadedAt: new Date().toISOString(),
          ref
        }));
        setMessageAttachments((prev) => ({ ...prev, [userMessage.id]: [...uploadedAttachments, ...vmDisplayAttachments] }));
        setMessageDisplayOverrides((prev) => ({ ...prev, [userMessage.id]: visibleText }));
      }
      mergeVmAgentMessages(messages);
      handleVmAgentMessageBatch(messages);
      if (hasAgentReplyForSession(messages, selectedRunId)) clearPendingAgentReply(selectedRunId);
    } catch (err) {
      recordError(err);
      clearPendingAgentReply(selectedRunId);
      setVmAgentMessages((prev) => prev.filter((message) => message.meta?.pending !== true));
      if (!textOverride) setComposer(text);
      setPendingAttachments((prev) => [...attachments, ...prev]);
      setPendingVmAttachments((prev) => [...vmAttachments, ...prev]);
    } finally {
      setAttachmentUploading(false);
      setMessageSending(false);
    }
  }

  async function refreshRuns(selectFirst = false): Promise<string | null> {
    try {
      const result = await listRuns();
      setRuns(result.runs);
      const currentSelection = selectedRunIdRef.current;
      const nextSelection = currentSelection && result.runs.some((run) => run.id === currentSelection)
        ? currentSelection
        : result.runs[0]?.id || null;
      if (selectFirst && nextSelection !== currentSelection) setSelectedRunId(nextSelection);
      setRunsHydrated(true);
      return nextSelection;
    } catch (err) {
      recordError(err);
      setRunsHydrated(true);
      return null;
    }
  }

  async function refreshRunDetail(id = selectedRunId) {
    if (!id) return;
    try {
      const detail = await getRun(id);
      setRunDetail(detail);
      setSelectedRunId(detail.run.id);
    } catch (err) {
      recordError(err);
    }
  }

  async function refreshVmSessionFiles(id = selectedRunId, showBusy = true) {
    if (!id || !authKey) return;
    const activeRequest = vmSessionFilesRequestRef.current;
    if (activeRequest && activeRequest.sessionId !== id) {
      activeRequest.controller.abort();
      vmSessionFilesRequestRef.current = null;
    }
    let request = vmSessionFilesRequestRef.current;
    if (!request) {
      const controller = new AbortController();
      request = {
        sessionId: id,
        controller,
        promise: getVmSessionFiles(id, controller.signal)
      };
      vmSessionFilesRequestRef.current = request;
    }
    if (showBusy) setVmSessionFilesLoading(true);
    try {
      const response = await request.promise;
      if (vmSessionFilesRequestRef.current !== request || selectedRunIdRef.current !== id) return;
      setVmSessionFiles(response);
    } catch (err) {
      if (request.controller.signal.aborted) return;
      recordError(err);
    } finally {
      const { ownsActiveRequest, shouldClearLoading } = vmSessionFilesCompletionState(
        vmSessionFilesRequestRef.current,
        request
      );
      if (ownsActiveRequest) vmSessionFilesRequestRef.current = null;
      if (showBusy && shouldClearLoading) setVmSessionFilesLoading(false);
    }
  }

  async function handleCreateRun() {
    setPanelNotice({ kind: "info", text: "Creating session..." });
    try {
      const result = await createRun(`Session ${new Date().toLocaleString()}`);
      setRuns((prev) => [result.run, ...prev.filter((run) => run.id !== result.run.id)]);
      setSessionOrder((prev) => [result.run.id, ...prev.filter((id) => id !== result.run.id)]);
      setSelectedRunId(result.run.id);
      await refreshRunDetail(result.run.id);
      setPanelNotice({ kind: "success", text: "Session created." });
    } catch (err) {
      recordError(err);
    }
  }

  function clearSessionMenuCloseTimer() {
    if (sessionMenuCloseTimerRef.current !== null) {
      window.clearTimeout(sessionMenuCloseTimerRef.current);
      sessionMenuCloseTimerRef.current = null;
    }
  }

  function closeSessionMenu() {
    if (!sessionMenu) return;
    clearSessionMenuCloseTimer();
    setClosingSessionMenu(sessionMenu);
    setSessionMenu(null);
    sessionMenuCloseTimerRef.current = window.setTimeout(() => {
      setClosingSessionMenu(null);
      sessionMenuCloseTimerRef.current = null;
    }, 180);
  }

  function openSessionMenu(event: MouseEvent, runId: string) {
    event.preventDefault();
    clearSessionMenuCloseTimer();
    setClosingSessionMenu(null);
    setRenameTitle("");
    setSessionMenu({ runId, x: event.clientX, y: event.clientY, mode: "menu" });
  }

  function handleDropRun(targetRunId: string) {
    if (!draggedRunId || draggedRunId === targetRunId) {
      setDraggedRunId(null);
      setDragOverRunId(null);
      return;
    }
    const ids = orderedRuns.map((run) => run.id);
    const withoutDragged = ids.filter((id) => id !== draggedRunId);
    const targetIndex = withoutDragged.indexOf(targetRunId);
    const nextOrder = [...withoutDragged];
    nextOrder.splice(targetIndex >= 0 ? targetIndex : nextOrder.length, 0, draggedRunId);
    setSessionOrder(nextOrder);
    setDraggedRunId(null);
    setDragOverRunId(null);
  }

  function showRenameSession(run: RunSummary) {
    setRenameTitle(run.title);
    setSessionMenu((prev) => prev ? { ...prev, runId: run.id, mode: "rename" } : prev);
  }

  async function handleRenameSession(event: FormEvent, run: RunSummary) {
    event.preventDefault();
    const title = renameTitle.trim();
    if (!title || title === run.title) {
      closeSessionMenu();
      setRenameTitle("");
      return;
    }
    closeSessionMenu();
    setPanelNotice({ kind: "info", text: "Renaming session..." });
    try {
      const result = await renameRun(run.id, title);
      setRuns((prev) => prev.map((item) => item.id === run.id ? result.run : item));
      setRunDetail((prev) => prev && prev.run.id === run.id ? { ...prev, run: result.run } : prev);
      setPanelNotice({ kind: "success", text: "Session renamed." });
    } catch (err) {
      recordError(err);
    } finally {
      setRenameTitle("");
    }
  }

  function showDeleteSession(run: RunSummary) {
    setSessionMenu((prev) => prev ? { ...prev, runId: run.id, mode: "delete" } : prev);
  }

  async function handleDeleteSession(run: RunSummary) {
    closeSessionMenu();
    setPanelNotice({ kind: "info", text: "Deleting session..." });
    try {
      const nextSelectedRun = orderedRuns.find((item) => item.id !== run.id) || null;
      await deleteRunApi(run.id);
      setRuns((prev) => prev.filter((item) => item.id !== run.id));
      setSessionOrder((prev) => prev.filter((id) => id !== run.id));
      if (selectedRunId === run.id) {
        setSelectedRunId(nextSelectedRun?.id ?? null);
        setRunDetail(null);
      }
      setPanelNotice({ kind: "success", text: "Session deleted." });
    } catch (err) {
      recordError(err);
    }
  }

  function handleSelectAttachments(fileList: FileList | null) {
    if (!fileList?.length) return;
    const incoming = Array.from(fileList);
    let remainingImageSlots = Math.max(0, MAX_PENDING_IMAGE_ATTACHMENTS - pendingAttachments.filter(isImageFile).length);
    let skippedImages = 0;
    const accepted = incoming.filter((file) => {
      if (!isImageFile(file)) return true;
      if (remainingImageSlots <= 0) {
        skippedImages += 1;
        return false;
      }
      remainingImageSlots -= 1;
      return true;
    });
    if (skippedImages > 0) notify("info", `Only ${MAX_PENDING_IMAGE_ATTACHMENTS} images can be attached to one message.`);
    if (accepted.length > 0) setPendingAttachments((prev) => [...prev, ...accepted]);
  }

  function dragEventHasFiles(event: DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types || []).includes("Files");
  }

  function resetComposerDragState() {
    composerDragDepthRef.current = 0;
    setComposerDragActive(false);
  }

  function handleComposerDragEnter(event: DragEvent<HTMLFormElement>) {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current += 1;
    if (composerDropEnabled) setComposerDragActive(true);
  }

  function handleComposerDragOver(event: DragEvent<HTMLFormElement>) {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = composerDropEnabled ? "copy" : "none";
    if (composerDropEnabled) setComposerDragActive(true);
  }

  function handleComposerDragLeave(event: DragEvent<HTMLFormElement>) {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1);
    if (composerDragDepthRef.current === 0) setComposerDragActive(false);
  }

  function handleComposerDrop(event: DragEvent<HTMLFormElement>) {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    resetComposerDragState();
    if (!composerDropEnabled) {
      notify("error", selectedRunId ? "Cannot attach files while the current message is sending." : "Create or select a session before attaching files.");
      return;
    }
    handleSelectAttachments(event.dataTransfer.files);
  }

  function removePendingAttachment(index: number) {
    setPendingAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
  }

  function addPendingVmAttachment(ref: VmAgentAttachmentRef) {
    setPendingVmAttachments((prev) => {
      if (prev.some((item) => refKey(item) === refKey(ref))) return prev;
      return [...prev, ref];
    });
    notify("info", `Added ${ref.name} to message context.`);
  }

  function removePendingVmAttachment(index: number) {
    setPendingVmAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
  }

  function vmSessionAttachmentRef(file: VmSessionOutputFile): VmAgentAttachmentRef | null {
    if (!selectedRunId) return null;
    return {
      id: `session_${selectedRunId}_${file.category}_${file.path}`.replace(/[^A-Za-z0-9_.:-]/g, "_"),
      source: "vm-session-file",
      name: file.name || file.path,
      path: file.path,
      size: file.size,
      runId: selectedRunId,
      category: file.category
    };
  }

  function vmArtifactAttachmentRef(file: SessionVmArtifact): VmAgentAttachmentRef {
    const name = file.path.split("/").at(-1) || file.path;
    return {
      id: `artifact_${file.runId}_${file.path}`.replace(/[^A-Za-z0-9_.:-]/g, "_"),
      source: "vm-run-artifact",
      name,
      path: file.path,
      size: file.size,
      runId: file.runId
    };
  }

  function renderThinkingPanel() {
    if (thinkingMessages.length === 0 && !waitingForAgentReply) return null;
    const latest = thinkingMessages.at(-1);
    return (
      <details className="thinking-panel" open={waitingForAgentReply || undefined}>
        <summary>
          <span>{waitingForAgentReply ? "Agent working" : "Agent summary"}</span>
          <small>{latest ? `${thinkingStageLabel(latest)} / ${metaString(latest, "thinkingStatus") || "running"}` : "waiting"}</small>
        </summary>
        <div className="thinking-steps">
          {thinkingMessages.length === 0 ? (
            <p>Waiting for the VM worker to publish progress.</p>
          ) : thinkingMessages.map((message) => (
            <div className={`thinking-row ${metaString(message, "thinkingStatus") || "running"}`} key={message.id}>
              <span>{thinkingStageLabel(message)}</span>
              <p>{message.content}</p>
              <small>{formatDate(message.createdAt)}</small>
            </div>
          ))}
        </div>
      </details>
    );
  }

  function renderArtifactList(files: RunFile[]) {
    if (!runDetail) return null;
    if (files.length === 0) return <p className="empty-line">No generated outputs yet.</p>;
    return (
      <div className="file-list">
        {files.map((file) => (
          <a className="file-row" key={`${file.kind}:${file.name}`} href={downloadUrl(runDetail.run.id, "artifacts", file.name)} target="_blank" rel="noreferrer">
            <span>{file.name}</span>
            <small>{formatBytes(file.size)} / {formatDate(file.modifiedAt)}</small>
          </a>
        ))}
      </div>
    );
  }

  function renderImagePreview(src: string, title: string, downloadHref: string) {
    return (
      <span className="image-preview-card">
        <button
          className="image-thumb-button"
          onClick={() => setImagePreview({ src, title, downloadUrl: downloadHref })}
          title={title}
          type="button"
        >
          <img alt={title} loading="lazy" src={src} />
        </button>
        <a className="image-download-link" href={downloadHref} rel="noreferrer" target="_blank">Download</a>
      </span>
    );
  }

  function renderVmArtifactList(files: SessionVmArtifact[]) {
    if (files.length === 0) return <p className="empty-line">No VM artifacts yet.</p>;
    return (
      <div className="file-list">
        {files.map((file) => (
          <div
            className="file-row file-row-with-action"
            key={`${file.runId}:${file.path}`}
            title={`${file.runId}/${file.path}`}
          >
            <a href={vmRunArtifactDownloadUrl(file.runId, file.path)} rel="noreferrer" target="_blank">
              <span>{file.path}</span>
              <small>{formatBytes(file.size)} - {file.attempt ? `attempt ${file.attempt}` : file.status || "artifact"} - {shortId(file.runId)}</small>
            </a>
            <button className="link-button" onClick={() => addPendingVmAttachment(vmArtifactAttachmentRef(file))} type="button">Add to context</button>
          </div>
        ))}
      </div>
    );
  }

  function renderVmSessionFile(file: VmSessionOutputFile) {
    const href = selectedRunId ? vmSessionFileDownloadUrl(selectedRunId, file.category, file.path) : "";
    if (file.isImage && href) {
      return (
        <div className="output-file-tile image-file-tile" key={`${file.category}:${file.path}`}>
          {renderImagePreview(href, file.name, href)}
          <div>
            <span>{file.path}</span>
            <small>{formatBytes(file.size)} - {formatDate(file.modifiedAt)}</small>
          </div>
        </div>
      );
    }
    return (
      <div className="file-row file-row-with-action" key={`${file.category}:${file.path}`} title={`${file.category}/${file.path}`}>
        <a href={href} rel="noreferrer" target="_blank">
          <span>{file.path}</span>
          <small>{formatBytes(file.size)} - {formatDate(file.modifiedAt)}</small>
        </a>
        <button className="link-button" disabled={!selectedRunId} onClick={() => {
          const ref = vmSessionAttachmentRef(file);
          if (ref) addPendingVmAttachment(ref);
        }} type="button">Add to context</button>
      </div>
    );
  }

  function renderChatMessage(message: VmAgentMessage) {
    const optimisticAttachments = (messageAttachments[message.id] || []).map((file) => displayAttachmentFromUploaded(file, selectedRunId));
    const messageDisplayAttachments = (message.attachments || []).flatMap((attachment) => {
      const displayAttachment = displayAttachmentFromMessage(attachment, message);
      return displayAttachment ? [displayAttachment] : [];
    });
    const allDisplayAttachments = messageDisplayAttachments.length ? messageDisplayAttachments : optimisticAttachments;
    let visibleImageAttachments = 0;
    const displayAttachments = allDisplayAttachments.filter((attachment) => {
      if (attachment.kind !== "image") return true;
      visibleImageAttachments += 1;
      return visibleImageAttachments <= MAX_PENDING_IMAGE_ATTACHMENTS;
    });
    const hiddenDisplayAttachmentCount = Math.max(0, allDisplayAttachments.length - displayAttachments.length);
    const displayAttachmentKeys = new Set(displayAttachments.map(displayAttachmentKey));
    const messageVmArtifacts = vmArtifactsForMessage(message).filter((file) => !displayAttachmentKeys.has(vmArtifactDisplayKey(file)));
    const messageVmSessionFiles = vmSessionFilesForMessage(message).filter((file) => !displayAttachmentKeys.has(vmSessionFileDisplayKey(file)));
    const visibleVmArtifacts = messageVmArtifacts.slice(0, 16);
    const visibleVmSessionFiles = messageVmSessionFiles.slice(0, 16);
    const hiddenVmArtifactCount = Math.max(0, messageVmArtifacts.length - visibleVmArtifacts.length);
    const hiddenVmSessionFileCount = Math.max(0, messageVmSessionFiles.length - visibleVmSessionFiles.length);
    const content = messageDisplayOverrides[message.id] ?? message.content;
    const hasMessageAttachments = displayAttachments.length > 0 || messageVmArtifacts.length > 0 || messageVmSessionFiles.length > 0;
    const kind = messageKind(message);
    return (
      <article className={`message-row ${message.role} ${kind ? `kind-${kind.replace(/[^A-Za-z0-9_-]/g, "-")}` : ""}`} key={message.id}>
        <div className="avatar">{message.role === "agent" ? "VM" : message.role === "user" ? "You" : "Sys"}</div>
        <div className={`message-bubble ${hasMessageAttachments ? "has-attachments" : ""}`}>
          {content && <div className="message-content">{renderMessageText(content)}</div>}
          {hasMessageAttachments && (
            <div className="message-attachments">
              {displayAttachments.map((attachment) => {
                const href = imageAttachmentUrl(attachment);
                const ref = attachmentRefFromDisplayAttachment(attachment);
                if (attachment.kind === "image" && href) {
                  return (
                    <span className="chat-image-with-link" key={`${displayAttachmentKey(attachment)}:${attachment.id}`}>
                      {renderImagePreview(href, attachment.name || attachment.path, href)}
                      {ref && <button className="link-button image-context-action" onClick={() => addPendingVmAttachment(ref)} type="button">Add to context</button>}
                    </span>
                  );
                }
                return (
                  <span className="attachment-chip" key={`${displayAttachmentKey(attachment)}:${attachment.id}`}>
                    {href ? (
                      <a href={href} rel="noreferrer" target="_blank">
                        <span>{attachment.name || attachment.path}</span>
                        <small>{attachmentStateLabel(ref || undefined)} / {formatBytes(attachment.size)}</small>
                      </a>
                    ) : (
                      <>
                        <span>{attachment.name || attachment.path}</span>
                        <small>{attachmentStateLabel(ref || undefined)} / {formatBytes(attachment.size)}</small>
                      </>
                    )}
                    {ref && <button type="button" onClick={() => addPendingVmAttachment(ref)}>Add</button>}
                  </span>
                );
              })}
              {visibleVmArtifacts.map((file) => (
                isImagePath(file.path) ? (
                  <span className="chat-image-with-link" key={`${file.runId}:${file.path}`}>
                    {renderImagePreview(vmRunArtifactDownloadUrl(file.runId, file.path), file.path, vmRunArtifactDownloadUrl(file.runId, file.path))}
                    <button className="link-button image-context-action" onClick={() => addPendingVmAttachment(vmArtifactAttachmentRef(file))} type="button">Add to context</button>
                  </span>
                ) : (
                  <span className="attachment-chip artifact-chip" key={`${file.runId}:${file.path}`} title={`${file.runId}/${file.path}`}>
                    <a href={vmRunArtifactDownloadUrl(file.runId, file.path)} rel="noreferrer" target="_blank">
                      <span>{file.path}</span>
                      <small>{file.attempt ? `try ${file.attempt} / ${formatBytes(file.size)}` : formatBytes(file.size)}</small>
                    </a>
                    <button type="button" onClick={() => addPendingVmAttachment(vmArtifactAttachmentRef(file))}>Add to context</button>
                  </span>
                )
              ))}
              {visibleVmSessionFiles.map((file) => {
                const href = vmSessionFileDownloadUrl(file.runId, file.category, file.path);
                return file.isImage ? (
                  <span className="chat-image-with-link" key={`${file.runId}:${file.category}:${file.path}`}>
                    {renderImagePreview(href, file.name || file.path, href)}
                    <button className="link-button image-context-action" onClick={() => addPendingVmAttachment(vmSessionFileAttachmentRef(file))} type="button">Add to context</button>
                  </span>
                ) : (
                  <span className="attachment-chip artifact-chip" key={`${file.runId}:${file.category}:${file.path}`} title={`${file.category}/${file.path}`}>
                    <a href={href} rel="noreferrer" target="_blank">
                      <span>{file.path}</span>
                      <small>{file.category} / {formatBytes(file.size)}</small>
                    </a>
                    <button type="button" onClick={() => addPendingVmAttachment(vmSessionFileAttachmentRef(file))}>Add to context</button>
                  </span>
                );
              })}
              {(hiddenDisplayAttachmentCount > 0 || hiddenVmArtifactCount > 0 || hiddenVmSessionFileCount > 0) && (
                <span className="attachment-chip muted-chip">
                  <span>+{hiddenDisplayAttachmentCount + hiddenVmArtifactCount + hiddenVmSessionFileCount} more</span>
                </span>
              )}
            </div>
          )}
        </div>
      </article>
    );
  }

  function worklogDurationLabel(
    messages: VmAgentMessage[],
    finalMessages: VmAgentMessage[],
    active: boolean,
    startMessages: VmAgentMessage[] = [],
  ): string {
    const explicit = finalMessages.flatMap((message) => typeof message.meta?.worklogDurationMs === "number" ? [message.meta.worklogDurationMs] : []);
    if (explicit.length > 0) return formatDuration(explicit.at(-1) || 0);
    const firstMessage = startMessages[0] || messages[0] || finalMessages[0];
    const first = firstMessage ? Date.parse(firstMessage.createdAt) : NaN;
    const last = active
      ? worklogClock
      : finalMessages.at(-1)
        ? Date.parse(finalMessages.at(-1)?.createdAt || "")
        : messages.at(-1)
          ? Date.parse(messages.at(-1)?.createdAt || "")
          : NaN;
    if (Number.isFinite(first) && Number.isFinite(last) && last >= first) return formatDuration(last - first);
    return "a moment";
  }

  function formatWorklogEvent(message: VmAgentMessage): ReactNode {
    const kind = messageKind(message);
    if (kind === "progress") {
      const stage = metaString(message, "progressStage") || "progress";
      const status = metaString(message, "progressStatus") || "running";
      const detail = metaString(message, "progressDetail") || message.content;
      const progress = typeof message.meta?.progress === "number" ? ` · ${message.meta.progress}%` : "";
      return <span>{progressLabel(stage)} · {status}{progress}<br />{renderInlineCode(detail)}</span>;
    }
    if (kind === "file_operation") {
      return <span>{message.content || `${metaString(message, "operation") || "Touched"} ${metaString(message, "path") || "file"}`}</span>;
    }
    if (kind === "tool_run") {
      const status = metaString(message, "status") || "running";
      const command = metaString(message, "commandLabel") || message.content;
      return <span>{status} <code>{command}</code></span>;
    }
    return renderInlineCode(message.content);
  }

  function renderWorklogFold(
    messages: VmAgentMessage[],
    finalMessages: VmAgentMessage[],
    active: boolean,
    startMessages: VmAgentMessage[] = [],
  ) {
    if (messages.length === 0 && !active) return null;
    const fileOperations = messages.filter((message) => messageKind(message) === "file_operation");
    return (
      <article className="message-row agent worklog-row">
        <div className="avatar">VM</div>
        <details className={`worklog-fold ${active ? "active" : ""}`}>
          <summary>
            <span>{active ? "Working for" : "Worked for"} {worklogDurationLabel(messages, finalMessages, active, startMessages)}</span>
            <small>{messages.length > 0 ? `${messages.length} event${messages.length === 1 ? "" : "s"}` : "starting"}</small>
          </summary>
          <div className="worklog-body">
            <div className="worklog-body-inner">
              {messages.length === 0 && (
                <p className="worklog-empty">Waiting for VM worker activity...</p>
              )}
              {fileOperations.length > 0 && (
                <section className="worklog-files">
                  <h3>Files</h3>
                  <ul>
                    {fileOperations.slice(-12).map((message) => (
                      <li key={message.id}>
                        <span>{renderInlineCode(message.content)}</span>
                        {typeof message.meta?.size === "number" && <small>{formatBytes(message.meta.size)}</small>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <div className="worklog-events">
                {messages.map((message) => {
                  const kind = messageKind(message);
                  const status = metaString(message, "status") || metaString(message, "progressStatus");
                  return (
                    <div className={`worklog-event kind-${kind || "event"} ${status || ""}`} key={message.id}>
                      <span>{kind ? kind.replace(/_/g, " ") : "event"}</span>
                      <p>{formatWorklogEvent(message)}</p>
                      <small>{formatDate(message.createdAt)}</small>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </details>
      </article>
    );
  }

  function renderTurnGroup(group: ChatTurnGroup) {
    const userMessages = group.messages.filter((message) => message.role === "user");
    const foldable = group.messages.filter(isFoldableWorklogMessage);
    const visible = group.messages.filter((message) => message.role !== "user" && !isFoldableWorklogMessage(message));
    const finalMessages = visible.filter((message) => messageKind(message) === "run_final" || message.meta?.summaryOfGroup === true);
    const active = userMessages.length > 0 && !turnHasFinalResult(group);
    return (
      <div className="chat-turn-group" key={group.id}>
        {userMessages.map((message) => renderChatMessage(message))}
        {renderWorklogFold(foldable, finalMessages.length ? finalMessages : visible, active, userMessages)}
        {visible.map((message) => renderChatMessage(message))}
      </div>
    );
  }

  function outputCategoryCollapsed(category: VmSessionOutputCategory): boolean {
    return collapsedOutputCategories[category] ?? true;
  }

  function toggleOutputCategory(category: VmSessionOutputCategory) {
    setCollapsedOutputCategories((current) => ({
      ...current,
      [category]: !(current[category] ?? true)
    }));
  }

  function renderVmSessionOutputBrowser() {
    const categories = vmSessionFiles.categories.length > 0 ? vmSessionFiles.categories : OUTPUT_CATEGORIES;
    return (
      <div className="session-output-browser">
        {categories.map((category, index) => {
          const files = vmSessionFiles.files.filter((file) => file.category === category);
          const collapsed = outputCategoryCollapsed(category);
          const bodyId = `output-category-${index}`;
          return (
            <section className={`output-category ${collapsed ? "collapsed" : ""}`} key={category}>
              <button
                aria-controls={bodyId}
                aria-expanded={!collapsed}
                className="output-category-head"
                onClick={() => toggleOutputCategory(category)}
                type="button"
              >
                <span className="output-category-title">
                  <span className="output-category-chevron" aria-hidden="true" />
                  <h3>{category}</h3>
                </span>
                <span className="output-category-count">{files.length}</span>
              </button>
              <div aria-hidden={collapsed} className="output-category-body" id={bodyId}>
                {files.length > 0 ? (
                  <div className="file-list">{files.map((file) => renderVmSessionFile(file))}</div>
                ) : (
                  <p className="empty-line">No files yet.</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    );
  }

  useEffect(() => {
    getHealth().then((h) => setHealth(`${h.service} OK`)).catch((err) => setHealth(errorMessage(err)));
  }, []);

  useEffect(() => {
    saveSessionOrder(sessionOrder);
  }, [sessionOrder]);

  useEffect(() => {
    if (!sessionMenu) return;
    const close = () => closeSessionMenu();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [sessionMenu]);

  useEffect(() => {
    if (!mobileLeftPanelOpen && !mobileRightPanelOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMobilePanels();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileLeftPanelOpen, mobileRightPanelOpen]);

  useEffect(() => {
    return () => clearSessionMenuCloseTimer();
  }, []);

  useEffect(() => {
    const runIds = runs.map((run) => run.id);
    setSessionOrder((prev) => {
      const known = new Set(runIds);
      const next = [...prev.filter((id) => known.has(id)), ...runIds.filter((id) => !prev.includes(id))];
      return sameStringArray(prev, next) ? prev : next;
    });
  }, [runs]);

  useEffect(() => {
    if (selectedRunId && runs.some((run) => run.id === selectedRunId)) return;
    setSelectedRunId(orderedRuns[0]?.id ?? null);
  }, [orderedRuns, runs, selectedRunId]);

  useEffect(() => {
    if (!authKey) {
      setVmAgentStreamState("auth required");
      setRunsHydrated(false);
      setHistoryAttemptedSessionId(null);
      return;
    }
    setRunsHydrated(false);
    void refreshRuns(true);
    void refreshVm();
  }, [authKey]);

  useEffect(() => {
    if (!authKey || !historyBootstrapSettled) {
      if (authKey) setVmAgentStreamState(selectedRunId ? "loading history" : "loading sessions");
      return;
    }
    let closed = false;
    let reconnectTimer: number | null = null;
    let events: EventSource | null = null;
    let reconnecting = false;

    const scheduleReconnect = () => {
      if (closed || reconnectTimer !== null) return;
      setVmAgentStreamState("reconnecting");
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        reconnecting = true;
        connect();
      }, STREAM_RECONNECT_DELAY_MS);
    };

    const connect = () => {
      if (closed) return;
      events?.close();
      setVmAgentStreamState(reconnecting ? "reconnecting" : "connecting");
      const source = new EventSource(vmAgentMessageStreamUrl(vmAgentCursorRef.current));
      events = source;

      source.addEventListener("open", () => {
        if (closed || events !== source) return;
        reconnecting = false;
        setVmAgentStreamState("live");
      });
      const handleStreamMessages = (event: Event) => {
        if (closed || events !== source) return;
        const data = JSON.parse((event as MessageEvent).data) as VmAgentHistoryResponse & { message?: VmAgentMessage };
        if (data.ok === false || data.status?.ok === false) return;
        if (data.status) setVmAgent(data.status);
        if (typeof data.cursor === "number") setVmAgentCursorValue(data.cursor);
        const messages = Array.isArray(data.messages) ? data.messages : data.message ? [data.message] : [];
        if (messages.length === 0) return;
        mergeVmAgentMessages(messages);
        handleVmAgentMessageBatch(messages);
        const pendingSessionId = pendingReplySessionRef.current;
        if (pendingSessionId && hasAgentReplyForSession(messages, pendingSessionId)) clearPendingAgentReply(pendingSessionId);
        reconnecting = false;
        setVmAgentStreamState("live");
      };
      source.addEventListener("messages", handleStreamMessages);
      source.addEventListener("message", handleStreamMessages);
      source.addEventListener("message_delta", handleStreamMessages);
      source.addEventListener("message_done", handleStreamMessages);
      source.addEventListener("ping", () => {
        if (closed || events !== source) return;
        reconnecting = false;
        setVmAgentStreamState("live");
      });
      source.addEventListener("error", () => {
        if (closed || events !== source) return;
        source.close();
        if (events === source) events = null;
        reconnecting = true;
        scheduleReconnect();
      });
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      events?.close();
    };
  }, [authKey, historyBootstrapSettled, selectedRunId]);

  useEffect(() => {
    if (!authKey || !historyBootstrapSettled || vmAgentStreamState === "live") return;
    let closed = false;
    let inFlight = false;
    const interval = window.setInterval(() => {
      if (closed || inFlight) return;
      inFlight = true;
      void getVmAgentMessages(vmAgentCursorRef.current, { limit: STREAM_BATCH_LIMIT })
        .then((response) => {
          if (closed) return;
          assertHistoryResponse(response);
          setVmAgent(response.status);
          setVmAgentCursorValue(response.cursor);
          mergeVmAgentMessages(response.messages);
          handleVmAgentMessageBatch(response.messages);
          const pendingSessionId = pendingReplySessionRef.current;
          if (pendingSessionId && hasAgentReplyForSession(response.messages, pendingSessionId)) clearPendingAgentReply(pendingSessionId);
        })
        .catch(() => {
          if (!closed && vmAgentStreamState !== "reconnecting") setVmAgentStreamState("disconnected");
        })
        .finally(() => {
          inFlight = false;
        });
    }, STREAM_FALLBACK_POLL_MS);
    return () => {
      closed = true;
      window.clearInterval(interval);
    };
  }, [authKey, historyBootstrapSettled, vmAgentStreamState]);

  useEffect(() => {
    if (!pendingReplySessionId || !authKey) return;
    const interval = window.setInterval(() => {
      const waitingSessionId = pendingReplySessionRef.current;
      if (!waitingSessionId) return;
      const nextRetry = pendingReplyRetryRef.current + 1;
      pendingReplyRetryRef.current = nextRetry;
      setPendingReplyRetryCount(nextRetry);
      if (nextRetry >= MAX_REPLY_RETRIES) {
        clearPendingAgentReply(waitingSessionId);
        recordSystemNotice("No agent reply after 30 minutes. Stopped waiting so the agent can be restarted manually.", "error");
      }
    }, REPLY_RETRY_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [pendingReplySessionId, authKey]);

  useEffect(() => {
    if (!selectedRunId || !authKey) return;
    if (!shouldLoadSelectedSessionHistory(sessionHistoryById[selectedRunId])) {
      setHistoryAttemptedSessionId(selectedRunId);
      return;
    }
    void loadSelectedSessionHistory(selectedRunId);
  }, [selectedRunId, authKey]);

  useEffect(() => {
    if (!selectedRunId || !authKey) {
      historyAbortControllerRef.current?.abort();
      historyAbortControllerRef.current = null;
      vmSessionFilesRequestRef.current?.controller.abort();
      vmSessionFilesRequestRef.current = null;
      setRunDetail(null);
      setVmSessionFiles({ categories: OUTPUT_CATEGORIES, files: [] });
      return;
    }
    let closed = false;
    void getRun(selectedRunId)
      .then((detail) => {
        if (!closed) setRunDetail(detail);
      })
      .catch((err) => {
        if (!closed) recordError(err);
      });
    return () => {
      closed = true;
    };
  }, [selectedRunId, authKey]);

  useEffect(() => () => {
    historyAbortControllerRef.current?.abort();
    vmSessionFilesRequestRef.current?.controller.abort();
  }, []);

  useEffect(() => {
    if (!selectedRunId || !authKey) return;
    void refreshVmSessionFiles(selectedRunId);
  }, [selectedRunId, authKey]);

  useEffect(() => {
    if (!selectedRunId || !authKey || !latestRunMessageKey) return;
    void refreshVmSessionFiles(selectedRunId, false);
  }, [selectedRunId, authKey, latestRunMessageKey]);

  useEffect(() => {
    if (!authKey || !selectedRunId || !messageSimulationSetup) return;
    const nextKey = `${selectedRunId}:${simulationSetupKey(messageSimulationSetup)}`;
    if (setupSyncKeyRef.current === nextKey) return;
    if (simulationSetupKey(runDetail?.run.simulationSetup) === simulationSetupKey(messageSimulationSetup)) {
      setupSyncKeyRef.current = nextKey;
      return;
    }
    let closed = false;
    setupSyncKeyRef.current = nextKey;
    void saveRunSimulationSetup(selectedRunId, messageSimulationSetup)
      .then((result) => {
        if (closed) return;
        setRuns((prev) => prev.map((run) => run.id === result.run.id ? result.run : run));
        setRunDetail((prev) => prev && prev.run.id === result.run.id ? { ...prev, run: result.run } : prev);
      })
      .catch((err) => {
        if (closed) return;
        setupSyncKeyRef.current = "";
        recordError(err);
      });
    return () => {
      closed = true;
    };
  }, [authKey, selectedRunId, messageSimulationSetup, runDetail?.run.simulationSetup]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [currentMessages.length, selectedRunId]);

  const shellClassName = [
    "app-shell",
    leftPanelCollapsed ? "left-collapsed" : "",
    rightPanelCollapsed ? "right-collapsed" : "",
    mobileLeftPanelOpen ? "mobile-left-open" : "",
    mobileRightPanelOpen ? "mobile-right-open" : ""
  ].filter(Boolean).join(" ");
  const mobileSessionStatus = latestProgress ? `${progressLabel(latestProgress.stage)} ${latestProgress.status}` : selectedRun?.status || vmAgentStreamState;
  const pendingAttachmentCount = pendingAttachments.length + pendingVmAttachments.length;
  const composerStatus = pendingAttachmentCount
    ? `${pendingAttachmentCount} attachment${pendingAttachmentCount === 1 ? "" : "s"} ready`
    : waitingForAgentReply
      ? "Waiting for agent"
      : canSendMessage
        ? "Ready"
        : selectedRunId
          ? "Agent unavailable"
          : "Select a session";
  const chatComposerClassName = [
    "chat-composer",
    composer.trim() || pendingAttachmentCount ? "has-draft" : "",
    mobileComposerToolsOpen ? "tools-open" : "",
    composerDragActive ? "drag-active" : ""
  ].filter(Boolean).join(" ");

  return (
    <main className={shellClassName}>
      <TopStatusBar
        agentChecked={!!vmAgent}
        clockSkewLabel={clockSkewLabel}
        clockSkewOk={clockSkewOk}
        clockSkewWarning={clockSkewWarning}
        health={health}
        leftPanelCollapsed={leftPanelCollapsed}
        llmConfigured={llmConfigured}
        mobileLeftPanelOpen={mobileLeftPanelOpen}
        mobileRightPanelOpen={mobileRightPanelOpen}
        onOpenMobileLeftPanel={() => {
          setMobileRightPanelOpen(false);
          setMobileLeftPanelOpen(true);
        }}
        onOpenMobileRightPanel={() => {
          setMobileLeftPanelOpen(false);
          setMobileRightPanelOpen(true);
        }}
        onToggleLeftPanel={() => setLeftPanelCollapsed((collapsed) => !collapsed)}
        onToggleRightPanel={() => setRightPanelCollapsed((collapsed) => !collapsed)}
        rightPanelCollapsed={rightPanelCollapsed}
        vmAgentStreamState={vmAgentStreamState}
        vmChecked={!!vm}
        vmLoading={vmLoading}
        vmOnline={vmOnline}
        vmTime={vmAgent?.vmTime}
        workerRunning={workerRunning}
      />

      {(mobileLeftPanelOpen || mobileRightPanelOpen) && (
        <button className="drawer-backdrop" onClick={closeMobilePanels} type="button" aria-label="Close side panel" />
      )}

      <aside className="session-sidebar" id="session-sidebar" aria-label="Sessions panel">
        <div className="drawer-panel-head">
          <strong>Sessions</strong>
          <button className="secondary" onClick={closeMobilePanels} type="button">Close</button>
        </div>
        <section className="auth-card">
          <label htmlFor="auth-token-input">AUTH_TOKEN</label>
          <div className="auth-input-row">
            <input id="auth-token-input" value={authInput} onChange={(event) => setAuthInput(event.target.value)} placeholder="Paste AUTH_TOKEN" type="password" />
            <button onClick={() => void saveToken()}>Save</button>
          </div>
          {panelNotice && <p className={`panel-notice ${panelNotice.kind}`}>{panelNotice.text}</p>}
          <div className="mini-actions">
            <button className="secondary" onClick={() => void refreshVm()} disabled={!authKey || vmLoading}>{vmLoading ? "Checking" : "VM status"}</button>
            <button className="secondary" onClick={() => void refreshVmAgent()} disabled={!authKey || vmAgentStatusLoading}>{vmAgentStatusLoading ? "Checking" : "Agent status"}</button>
          </div>
        </section>

        <section className="session-toolbar">
          <div>
            <h2>Sessions</h2>
            <small>{visibleRuns.length} shown / {runs.length} total</small>
          </div>
          <button onClick={() => void handleCreateRun()} disabled={!authKey}>New</button>
        </section>

        <div className="session-search">
          <input value={sessionSearch} onChange={(event) => setSessionSearch(event.target.value)} placeholder="Search title, run id, latest message" />
          <button className="secondary" onClick={() => void refreshRuns()} disabled={!authKey}>Refresh</button>
        </div>

        <div className="session-list" aria-label="Sessions">
          {visibleRuns.map((run) => (
            <button
              className={`session-card ${selectedRunId === run.id ? "selected" : ""} ${draggedRunId === run.id ? "dragging" : ""} ${dragOverRunId === run.id ? "drag-over" : ""}`}
              draggable
              key={run.id}
              onClick={() => {
                setSelectedRunId(run.id);
                setMobileLeftPanelOpen(false);
              }}
              onContextMenu={(event) => openSessionMenu(event, run.id)}
              onDragStart={() => setDraggedRunId(run.id)}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOverRunId(run.id);
              }}
              onDragLeave={() => setDragOverRunId((current) => current === run.id ? null : current)}
              onDrop={(event) => {
                event.preventDefault();
                handleDropRun(run.id);
              }}
              onDragEnd={() => {
                setDraggedRunId(null);
                setDragOverRunId(null);
              }}
            >
              <span className="session-title-row">
                <strong>{run.title}</strong>
                <em className={`run-state ${statusTone(run.status)} ${run.status}`}>{run.status}</em>
              </span>
              <span className="session-preview">{latestMessagePreview(vmAgentMessages, run.id)}</span>
              <span className="session-meta-row">
                <small>{shortId(run.id)}</small>
                <small>{formatDate(run.updatedAt || run.createdAt)}</small>
              </span>
            </button>
          ))}
          {visibleRuns.length === 0 && <p className="empty-line">No matching sessions</p>}
        </div>
      </aside>

      <section className="chat-workspace">
        <header className={`chat-header ${mobileChatInfoOpen ? "mobile-open" : ""}`}>
          <div className="mobile-session-strip">
            <span className={`mobile-session-dot ${statusTone(selectedRun?.status)}`} />
            <div>
              <strong>{currentTitle}</strong>
              <small>{mobileSessionStatus}</small>
            </div>
            <button
              aria-controls="mobile-session-details"
              aria-expanded={mobileChatInfoOpen}
              className="secondary"
              onClick={() => setMobileChatInfoOpen((open) => !open)}
              type="button"
            >
              {mobileChatInfoOpen ? "Hide" : "Info"}
            </button>
          </div>
          <div className="chat-title-details" id="mobile-session-details">
            <p className="eyebrow">Current session</p>
            <h1>{currentTitle}</h1>
            <div className="meta-row">
              <span>{selectedRunId ? shortId(selectedRunId) : "select or create a session"}</span>
              <span>stream: {vmAgentStreamState}</span>
              {selectedRunId && <span>history: {selectedHistoryPhase}</span>}
              {selectedRun && <span>{selectedRun.status}</span>}
              {latestProgress && <span>{progressLabel(latestProgress.stage)}: {latestProgress.status}</span>}
              {clockSkewWarning && <span>VM clock skew: {clockSkewLabel}</span>}
              <span>context: {formatCompactNumber(contextStats.estimatedTokens)} / {formatCompactNumber(contextStats.maxTokens)} est. tokens</span>
            </div>
          </div>
          <div className="chat-actions">
            <button
              onClick={() => void handleConnectVmAgent()}
              disabled={startAgentDisabled}
              title={waitingForAgentReply ? "Disabled while waiting for the current agent reply to avoid interrupting a long task." : undefined}
            >
              {waitingForAgentReply ? `Waiting reply ${formatReplyWait(pendingReplyRetryCount)}` : vmAgentConnectLoading ? "Starting" : "Start agent"}
            </button>
            {waitingForAgentReply && (
              <button className="secondary danger-button" onClick={forceStopPendingReply} type="button">
                Force stop
              </button>
            )}
            <button
              className="secondary"
              onClick={() => void handleRefreshVmAgentMessages()}
              disabled={!authKey || vmAgentHistoryLoading || selectedHistoryPhase === "loading"}
            >
              {selectedHistoryPhase === "loading" && selectedHistoryState.retrying
                ? "Retrying"
                : vmAgentHistoryLoading || selectedHistoryPhase === "loading"
                  ? "Loading"
                  : "History"}
            </button>
          </div>
        </header>

        {!progressCollapsed && (
          <button
            aria-label="Close progress"
            className="mobile-progress-backdrop"
            onClick={() => setProgressCollapsed(true)}
            type="button"
          />
        )}
        <section className={`progress-panel ${progressCollapsed ? "collapsed" : ""}`} aria-label="Agent progress">
          <div className="progress-panel-header">
            <div>
              <p className="eyebrow">Progress</p>
              <h2>{latestProgress ? `${progressLabel(latestProgress.stage)} / ${latestProgress.status}` : "Idle"}</h2>
            </div>
            <div className="progress-panel-controls">
              <span>{progressRows.length} event{progressRows.length === 1 ? "" : "s"}</span>
              <button
                aria-controls="agent-progress-table"
                aria-expanded={!progressCollapsed}
                className="secondary progress-toggle"
                onClick={() => setProgressCollapsed((collapsed) => !collapsed)}
                type="button"
              >
                {progressCollapsed ? "Show" : "Hide"}
              </button>
            </div>
          </div>
          <div className="progress-table-wrap" id="agent-progress-table" aria-hidden={progressCollapsed}>
            <table className="progress-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Stage</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {progressRows.length === 0 ? (
                  <tr><td colSpan={5}>No progress events yet.</td></tr>
                ) : progressRows.map((row) => (
                  <tr className={`progress-${row.status}`} key={row.id}>
                    <td title={row.vmCreatedAt ? `VM time: ${row.vmCreatedAt}` : undefined}>{formatDate(row.createdAt)}</td>
                    <td>{progressLabel(row.stage)}</td>
                    <td><span>{row.status}</span></td>
                    <td>{row.progress === null ? "-" : `${row.progress}%`}</td>
                    <td title={row.runId || undefined}>{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="message-list">
          {selectedRunId && selectedHistoryPhase === "loading" && (
            <div className="history-load-banner loading" role="status">
              <div>
                <strong>{selectedHistoryState.retrying ? "Retrying session history..." : "Loading full session history..."}</strong>
                <span>Existing messages and the live cursor remain available while this request runs.</span>
              </div>
            </div>
          )}
          {selectedRunId && selectedHistoryPhase === "failed" && (
            <div className="history-load-banner failed" role="alert">
              <div>
                <strong>History failed to load.</strong>
                <span>{selectedHistoryState.error || "The VM history bridge is unavailable."} Existing messages were preserved.</span>
              </div>
              {selectedHistoryState.retryable !== false && (
                <button
                  className="secondary"
                  onClick={() => void loadSelectedSessionHistory(selectedRunId, { retrying: true, showBusy: true })}
                  type="button"
                >
                  Retry
                </button>
              )}
            </div>
          )}
          {selectedRunId && selectedHistoryPhase === "truncated" && (
            <div className="history-load-banner truncated" role="status">
              <div>
                <strong>History loaded with an older-page boundary.</strong>
                <span>The latest visible turns are available; increase the server history budget if older turns are required.</span>
              </div>
            </div>
          )}
          {renderThinkingPanel()}
          {visibleMessages.length === 0 && (
            <div className="empty-chat">
              <strong>
                {!selectedRun
                  ? "No session selected."
                  : selectedHistoryPhase === "empty"
                    ? "No messages in this session."
                    : selectedHistoryPhase === "failed"
                      ? "Session history is temporarily unavailable."
                      : "Loading session history..."}
              </strong>
              <span>
                {!selectedRun
                  ? "Create or select a session from the left panel."
                  : selectedHistoryPhase === "empty"
                    ? "Send a prompt or use a quick action to talk with the VM agent."
                    : selectedHistoryPhase === "failed"
                      ? "Use Retry above; a failed load never clears existing messages."
                      : "The selected session is being hydrated before live updates begin."}
              </span>
            </div>
          )}
          {chatItems.map((item) => item.type === "turn" ? renderTurnGroup(item.group) : renderChatMessage(item.message))}
          <div ref={messageEndRef} />
        </div>

        <form
          className={chatComposerClassName}
          onDragEnter={handleComposerDragEnter}
          onDragLeave={handleComposerDragLeave}
          onDragOver={handleComposerDragOver}
          onDrop={handleComposerDrop}
          onSubmit={(event) => { event.preventDefault(); void handleVmAgentMessage(); }}
        >
          {composerDragActive && (
            <div className="composer-drop-overlay" aria-hidden="true">
              <span>Drop files to attach</span>
            </div>
          )}
          <div className="mobile-composer-toolbar">
            <button
              aria-controls="mobile-composer-tools"
              aria-expanded={mobileComposerToolsOpen}
              className="secondary composer-tools-toggle"
              onClick={() => setMobileComposerToolsOpen((open) => !open)}
              type="button"
            >
              {mobileComposerToolsOpen ? "Hide tools" : "Tools"}
            </button>
            <span>{composerStatus}</span>
          </div>
          <div className="composer-tools" id="mobile-composer-tools">
          <div className="quick-prompts">
            <button
              className="quick-chip"
              disabled={!canSendMessage}
              onClick={() => setComposer(QUICK_PROMPTS[0]!.prompt)}
              type="button"
            >
              {QUICK_PROMPTS[0]!.label}
            </button>
            <button
              className="quick-chip quick-chip-secondary"
              disabled={!authKey || agentsModalLoading || agentsModalSaving}
              onClick={() => void openAgentsModal()}
              type="button"
            >
              AGENTS.md
            </button>
            {QUICK_PROMPTS.slice(1).map((prompt) => (
              <button
                className="quick-chip"
                disabled={!canSendMessage}
                key={prompt.label}
                onClick={() => setComposer(prompt.prompt)}
                type="button"
              >
                {prompt.label}
              </button>
            ))}
          </div>
          <div className="mobile-attach-row">
            <label className="attach-button">
              Attach files
              <input accept={ATTACHMENT_ACCEPT} type="file" multiple disabled={!authKey || !selectedRunId || messageSending || attachmentUploading} onChange={(event) => {
                handleSelectAttachments(event.target.files);
                event.currentTarget.value = "";
              }} />
            </label>
          </div>
          {pendingAttachments.length > 0 && (
            <div className="pending-attachments">
              {pendingAttachments.map((file, index) => {
                const preview = pendingImagePreviews.find((item) => item.index === index);
                if (preview) {
                  return (
                    <span className="pending-image-card" key={`${file.name}-${file.size}-${index}`}>
                      <button
                        className="image-thumb-button"
                        onClick={() => setImagePreview({ src: preview.url, title: preview.name, downloadUrl: preview.url })}
                        title={preview.name}
                        type="button"
                      >
                        <img alt={preview.name} loading="lazy" src={preview.url} />
                      </button>
                      <span>{preview.name}</span>
                      <small>{formatBytes(preview.size)}</small>
                      <button type="button" onClick={() => removePendingAttachment(index)} disabled={messageSending || attachmentUploading}>x</button>
                    </span>
                  );
                }
                return (
                  <span className="attachment-chip" key={`${file.name}-${file.size}-${index}`}>
                    <span>{file.name}</span>
                    <small>{formatBytes(file.size)}</small>
                    <button type="button" onClick={() => removePendingAttachment(index)} disabled={messageSending || attachmentUploading}>x</button>
                  </span>
                );
              })}
            </div>
          )}
          {pendingVmAttachments.length > 0 && (
            <div className="pending-attachments">
              {pendingVmAttachments.map((file, index) => (
                <span className="attachment-chip" key={refKey(file)}>
                  {file.name}
                  <small>{attachmentStateLabel(file)} / {formatBytes(file.size)}</small>
                  <button type="button" onClick={() => removePendingVmAttachment(index)} disabled={messageSending || attachmentUploading}>x</button>
                </span>
              ))}
            </div>
          )}
          </div>
          <div className="composer-box">
            <div className="composer-input-stack">
              {visibleSlashSuggestions.length > 0 && (
                <div className="composer-slash-palette" role="listbox" aria-label="Slash commands">
                  {visibleSlashSuggestions.map((suggestion, index) => {
                    const selected = index === Math.max(0, Math.min(slashSuggestionIndex, visibleSlashSuggestions.length - 1));
                    return (
                      <button
                        aria-selected={selected}
                        className={`composer-slash-option ${selected ? "selected" : ""}`}
                        key={suggestion.command}
                        onClick={() => applySlashSuggestion(suggestion)}
                        onMouseEnter={() => setSlashSuggestionIndex(index)}
                        type="button"
                      >
                        <strong>{suggestion.label}</strong>
                        <span>{suggestion.description}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <textarea
                ref={composerInputRef}
                value={composer}
                onChange={(event) => setComposer(event.target.value)}
                onKeyDown={(event) => {
                  if (visibleSlashSuggestions.length > 0) {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setSlashSuggestionIndex((current) => nextSlashSuggestionIndex(current, 1, visibleSlashSuggestions.length));
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setSlashSuggestionIndex((current) => nextSlashSuggestionIndex(current, -1, visibleSlashSuggestions.length));
                      return;
                    }
                    if (event.key === "Tab" && activeSlashSuggestion) {
                      event.preventDefault();
                      applySlashSuggestion(activeSlashSuggestion);
                      return;
                    }
                    if (event.key === "Enter" && activeSlashSuggestion) {
                      event.preventDefault();
                      applySlashSuggestion(activeSlashSuggestion);
                      return;
                    }
                    if (event.key === "Escape" && activeSlashQuery) {
                      event.preventDefault();
                      setDismissedSlashQuery(activeSlashQuery);
                      return;
                    }
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleVmAgentMessage();
                  }
                }}
                placeholder="Message the VM agent..."
                rows={3}
              />
            </div>
            <div className="composer-actions">
              <label className="attach-button">
                Attach
                <input accept={ATTACHMENT_ACCEPT} type="file" multiple disabled={!authKey || !selectedRunId || messageSending || attachmentUploading} onChange={(event) => {
                  handleSelectAttachments(event.target.files);
                  event.currentTarget.value = "";
                }} />
              </label>
              <button disabled={!canSendMessage || (!composer.trim() && pendingAttachmentCount === 0)}>
                {attachmentUploading ? "Uploading" : messageSending ? "Sending" : "Send"}
              </button>
            </div>
          </div>
        </form>
      </section>

      <aside className="inspector-panel" id="inspector-panel" aria-label="Details panel">
        <div className="drawer-panel-head">
          <strong>Details</strong>
          <button className="secondary" onClick={closeMobilePanels} type="button">Close</button>
        </div>
        <section className="inspector-card context-card">
          <div className="section-head">
            <h2>Context Usage</h2>
            <span>estimated</span>
          </div>
          <div className="usage-meter" aria-label="Estimated context usage">
            <span style={{ width: `${contextStats.estimatedTokens > 0 ? Math.max(2, contextStats.percent) : 0}%` }} />
          </div>
          <div className="metric-grid">
            <div><strong>{formatCompactNumber(contextStats.estimatedTokens)}</strong><span>est. tokens</span></div>
            <div><strong>{contextStats.percent}%</strong><span>of 1.0m</span></div>
            <div><strong>{contextStats.messageCount}</strong><span>messages</span></div>
            <div><strong>{formatCompactNumber(contextStats.characters)}</strong><span>characters</span></div>
          </div>
        </section>

        <section className="inspector-card">
          <div className="section-head">
            <h2>Agent Context</h2>
            <button className="link-button" onClick={() => void refreshVmAgent()} disabled={!authKey || vmAgentStatusLoading}>{vmAgentStatusLoading ? "Checking" : "Refresh"}</button>
          </div>
          <dl className="kv">
            <dt>VM</dt><dd>{vmOnline === true ? "online" : vmOnline === false ? "offline" : "unchecked"}</dd>
            <dt>Agent</dt><dd>{workerRunning ? "running" : vmAgent ? "stopped" : vmAgentStreamState}</dd>
            <dt>LLM</dt><dd>{vmAgent?.llmConfigured ? "configured" : "pending"}</dd>
            <dt>Models</dt><dd>{vmAgent?.llmModels?.join(" -> ") || vmAgent?.llmModel || "not configured"}</dd>
            <dt>Manuals</dt><dd>{vmAgent?.manualCount ? `${vmAgent.manualCount} installed` : "none installed"}</dd>
            <dt>Messages</dt><dd>{vmAgent?.messageCount ?? currentMessages.length}</dd>
            <dt>Queue</dt><dd>{vmAgent?.queueDepth ?? 0}</dd>
            <dt>Clock</dt><dd>{clockSkewWarning ? `skew ${clockSkewLabel}` : `skew ${clockSkewLabel}`}</dd>
          </dl>
        </section>

        <section className="inspector-card">
          <div className="section-head">
            <h2>Simulation Setup</h2>
            {selectedRun && <em className={`run-state ${statusTone(selectedRun.status)} ${selectedRun.status}`}>{selectedRun.status}</em>}
          </div>
          <div className="simulation-list">
            {simulationRows.map((item) => (
              <div className="simulation-row" key={item.label}>
                <span>{item.label}</span>
                <small>{item.value}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="inspector-card">
          <div className="section-head">
            <h2>Output Files</h2>
            {selectedRunId && (
              <button className="link-button" onClick={() => { void refreshRunDetail(); void refreshVmSessionFiles(); }} disabled={vmSessionFilesLoading}>
                {vmSessionFilesLoading ? "Loading" : "Refresh"}
              </button>
            )}
          </div>
          <div className="output-targets">
            {expectedOutputs.map((item) => <span key={item}>{item}</span>)}
          </div>
          {renderVmSessionOutputBrowser()}
          <h3>Host artifacts</h3>
          {runDetail ? renderArtifactList(runDetail.artifacts) : <p className="empty-line">Select a session to view generated outputs.</p>}
          <h3>VM run artifacts</h3>
          {renderVmArtifactList(vmRunArtifacts)}
        </section>

        {globalMessages.length > 0 && (
          <section className="inspector-card">
            <h2>Global Agent Events</h2>
            <div className="global-events">
              {globalMessages.map((message) => <p key={message.id}>{formatDate(message.createdAt)} / {message.content}</p>)}
            </div>
          </section>
        )}
      </aside>

      {agentsModalOpen && (
        <div className="modal-backdrop" onClick={() => closeAgentsModal()}>
          <div className="agents-modal" onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <h2>VM AGENTS.md</h2>
              <div className="confirm-actions">
                <button className="secondary" disabled={agentsModalSaving} onClick={() => closeAgentsModal()} type="button">Close</button>
                <button disabled={agentsModalLoading || agentsModalSaving || !agentsModalDirty} onClick={() => void saveAgentsModal()} type="button">
                  {agentsModalSaving ? "Saving" : "Save"}
                </button>
              </div>
            </div>
            <p className="modal-caption">Edits apply to `~/.sentaurus-web-agent/vm-agent/AGENTS.md` inside the VM worker root.</p>
            {agentsModalError && <p className="panel-notice error">{agentsModalError}</p>}
            <textarea
              ref={agentsTextareaRef}
              className="agents-modal-textarea"
              disabled={agentsModalLoading || agentsModalSaving}
              onChange={(event) => setAgentsModalDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                  event.preventDefault();
                  void saveAgentsModal();
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeAgentsModal();
                }
              }}
              placeholder={agentsModalLoading ? "Loading AGENTS.md..." : "No VM AGENTS.md content loaded."}
              rows={18}
              value={agentsModalDraft}
            />
            <div className="agents-modal-footer">
              <span>{agentsModalLoading ? "Loading" : agentsModalSaving ? "Saving" : agentsModalDirty ? "Unsaved changes" : "Saved"}</span>
              <span>{agentsModalDraft.length} chars</span>
            </div>
          </div>
        </div>
      )}

      {imagePreview && (
        <div className="image-lightbox" onClick={() => setImagePreview(null)}>
          <div className="image-lightbox-body" onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <h2>{imagePreview.title}</h2>
              <div className="confirm-actions">
                <a className="link-button image-lightbox-download" href={imagePreview.downloadUrl} rel="noreferrer" target="_blank">Download</a>
                <button className="secondary" onClick={() => setImagePreview(null)} type="button">Close</button>
              </div>
            </div>
            <img alt={imagePreview.title} src={imagePreview.src} />
          </div>
        </div>
      )}

      {visibleSessionMenu && menuRun && (
        <div
          className={`session-menu ${closingSessionMenu && !sessionMenu ? "closing" : ""}`}
          style={{ left: visibleSessionMenu.x, top: visibleSessionMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <strong>{menuRun.title}</strong>
          <div className="session-menu-body" key={visibleSessionMenu.mode}>
            {visibleSessionMenu.mode === "menu" && (
              <>
              <button onClick={() => showRenameSession(menuRun)}>Rename</button>
              <button className="danger-button" onClick={() => showDeleteSession(menuRun)}>Delete</button>
              </>
            )}
            {visibleSessionMenu.mode === "rename" && (
              <form className="menu-form" onSubmit={(event) => void handleRenameSession(event, menuRun)}>
                <label>
                  Session name
                  <input autoFocus value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} />
                </label>
                <div className="confirm-actions">
                  <button type="button" className="secondary" onClick={closeSessionMenu}>Cancel</button>
                  <button type="submit" disabled={!renameTitle.trim() || renameTitle.trim() === menuRun.title}>Save</button>
                </div>
              </form>
            )}
            {visibleSessionMenu.mode === "delete" && (
              <div className="menu-confirm danger">
                <p>Delete this session and its local files?</p>
                <span>This cannot be undone.</span>
                <div className="confirm-actions">
                  <button className="secondary" onClick={closeSessionMenu}>Cancel</button>
                  <button className="danger-button" onClick={() => void handleDeleteSession(menuRun)}>Delete session</button>
                </div>
              </div>
            )}
          </div>
          <dl>
            <dt>Created</dt><dd>{formatFullDate(menuRun.createdAt)}</dd>
            <dt>Updated</dt><dd>{formatFullDate(menuRun.updatedAt)}</dd>
            <dt>Run id</dt><dd>{menuRun.id}</dd>
          </dl>
        </div>
      )}
    </main>
  );
}
