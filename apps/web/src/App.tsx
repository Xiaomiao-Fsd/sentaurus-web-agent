import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, MouseEvent } from "react";
import type {
  RunDetail,
  RunFile,
  RunStatus,
  RunSummary,
  SimulationSetup,
  VmAgentHistoryResponse,
  VmAgentMessage,
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
  sendVmAgentMessage,
  setAuthToken,
  uploadRunFile,
  vmAgentMessageStreamUrl,
  vmRunArtifactDownloadUrl,
  vmSessionFileDownloadUrl
} from "./lib/api.js";
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
};

type ImagePreview = {
  src: string;
  title: string;
  downloadUrl: string;
};

const REFERENCE_CONTEXT_TOKENS = 272_000;
const REPLY_RETRY_INTERVAL_MS = 10_000;
const MAX_REPLY_RETRIES = 180;
const STREAM_RECONNECT_DELAY_MS = 3_000;
const STREAM_FALLBACK_POLL_MS = 10_000;
const SESSION_ORDER_KEY = "sentaurus_session_order";
const OUTPUT_CATEGORIES: VmSessionOutputCategory[] = ["我的输入", "仿真结果文件", "仿真日志文件", "仿真参数文件", "其它文件"];
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

function metaString(message: VmAgentMessage, key: string): string | null {
  const value = message.meta?.[key];
  return typeof value === "string" && value.trim() ? value : null;
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

function messageRunId(message: VmAgentMessage): string | null {
  const runId = message.meta?.vmRunId || message.meta?.runId;
  return typeof runId === "string" && runId.trim() ? runId : null;
}

function vmArtifactsForMessage(message: VmAgentMessage): SessionVmArtifact[] {
  const artifacts: SessionVmArtifact[] = [];
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
  const scoped = messages.filter((message) => messageBelongsToSession(message, runId) && message.meta?.kind !== "progress");
  const latest = scoped.at(-1);
  if (!latest) return "No scoped VM messages yet";
  const compact = latest.content.replace(/\s+/g, " ").trim();
  return compact.length > 86 ? `${compact.slice(0, 86)}…` : compact;
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
    if (!messageBelongsToSession(message, sessionId) || message.meta?.kind !== "progress") return [];
    const stage = typeof message.meta.progressStage === "string" ? message.meta.progressStage : "progress";
    const detail = typeof message.meta.progressDetail === "string" ? message.meta.progressDetail : message.content;
    const rawProgress = typeof message.meta.progress === "number" ? message.meta.progress : null;
    const runId = typeof message.meta.runId === "string" ? message.meta.runId : null;
    return [{
      id: message.id,
      createdAt: message.createdAt,
      vmCreatedAt: message.vmCreatedAt,
      stage,
      status: progressStatus(message.meta.progressStatus),
      detail,
      progress: rawProgress === null ? null : Math.max(0, Math.min(100, rawProgress)),
      runId
    }];
  });
}

function estimateContextUsage(messages: VmAgentMessage[]): ContextStats {
  const characters = messages.reduce((total, message) => total + message.content.length, 0);
  const estimatedTokens = Math.ceil(characters / 4);
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

function statusPillClass(ok: boolean | null | undefined, warning = false): string {
  if (ok === true) return "status-pill good";
  if (warning || ok === false) return "status-pill warn";
  return "status-pill idle";
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
    const isAgentReply = message.role === "agent";
    const isSystemError = message.role === "system" && (message.meta?.kind === "llm_error" || message.meta?.kind === "worker_error");
    if (!isAgentReply && !isSystemError) return false;
    const scopedSession = messageSessionId(message);
    return scopedSession === sessionId || scopedSession === null;
  });
}

export default function App() {
  const savedToken = getAuthToken();
  const [authInput, setAuthInput] = useState(savedToken);
  const [authKey, setAuthKey] = useState(savedToken);
  const [health, setHealth] = useState<string>("checking");
  const [vm, setVm] = useState<VmStatus | null>(null);
  const [vmLoading, setVmLoading] = useState(false);
  const [vmAgent, setVmAgent] = useState<VmAgentStatus | null>(null);
  const [vmAgentMessages, setVmAgentMessages] = useState<VmAgentMessage[]>([]);
  const [composer, setComposer] = useState("");
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
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
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
  const [messageAttachments, setMessageAttachments] = useState<Record<string, UploadedAttachment[]>>({});
  const [messageDisplayOverrides, setMessageDisplayOverrides] = useState<Record<string, string>>({});
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const pendingReplySessionRef = useRef<string | null>(null);
  const pendingReplyRetryRef = useRef(0);
  const vmAgentCursorRef = useRef(0);
  const selectedRunIdRef = useRef<string | null>(null);
  const notifiedCompletionIdsRef = useRef<Set<string>>(new Set());
  const sessionMenuCloseTimerRef = useRef<number | null>(null);
  const setupSyncKeyRef = useRef("");

  selectedRunIdRef.current = selectedRunId;

  const orderedRuns = useMemo(() => orderRuns(runs, sessionOrder), [runs, sessionOrder]);
  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) || null, [runs, selectedRunId]);
  const visibleSessionMenu = sessionMenu || closingSessionMenu;
  const menuRun = useMemo(() => runs.find((run) => run.id === visibleSessionMenu?.runId) || null, [runs, visibleSessionMenu]);
  const currentMessages = useMemo(() => messagesForSession(vmAgentMessages, selectedRunId), [selectedRunId, vmAgentMessages]);
  const visibleMessages = useMemo(() => currentMessages.filter((message) => message.meta?.kind !== "progress"), [currentMessages]);
  const progressRows = useMemo(() => progressRowsForSession(vmAgentMessages, selectedRunId).slice(-12), [selectedRunId, vmAgentMessages]);
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
  const waitingForAgentReply = !!pendingReplySessionId;
  const startAgentDisabled = !authKey || vmAgentConnectLoading || messageSending || waitingForAgentReply;

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

  async function handleRefreshVmAgentMessages(showBusy = true) {
    if (showBusy) setVmAgentHistoryLoading(true);
    try {
      const response = selectedRunId
        ? await getVmAgentMessages(0, { limit: 500, sessionId: selectedRunId })
        : await getVmAgentMessages(0, { limit: 100 });
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

  async function handleVmAgentMessage(textOverride?: string) {
    const text = (textOverride ?? composer).trim();
    const attachments = textOverride ? [] : pendingAttachments;
    if (!text && attachments.length === 0) return;
    if (!selectedRunId) {
      setPanelNotice({ kind: "error", text: "Create or select a session before sending a message." });
      return;
    }
    setMessageSending(true);
    if (attachments.length > 0) setAttachmentUploading(true);
    setComposer("");
    setPendingAttachments([]);
    const uploadedAttachments: UploadedAttachment[] = [];
    try {
      for (const file of attachments) {
        await uploadRunFile(selectedRunId, file);
        uploadedAttachments.push({
          id: `${file.name}_${file.size}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: file.name,
          size: file.size,
          uploadedAt: new Date().toISOString()
        });
      }
      if (uploadedAttachments.length > 0) await refreshRunDetail(selectedRunId);
      if (uploadedAttachments.length > 0) await refreshVmSessionFiles(selectedRunId, false);

      const attachmentLine = uploadedAttachments.length > 0
        ? `\n\nAttachments uploaded to this session: ${uploadedAttachments.map((file) => file.name).join(", ")}.`
        : "";
      const visibleText = text || `Attached ${uploadedAttachments.length} file${uploadedAttachments.length === 1 ? "" : "s"}.`;
      const response = await sendVmAgentMessage(`${visibleText}${attachmentLine}`, selectedRunId);
      const messages = response.messages || [response.message];
      setVmAgent(response.status);
      setVmAgentCursorValue(response.cursor);
      beginPendingAgentReply(selectedRunId);
      const userMessage = [...messages]
        .reverse()
        .find((message) => message.role === "user" && messageBelongsToSession(message, selectedRunId));
      if (userMessage && uploadedAttachments.length > 0) {
        setMessageAttachments((prev) => ({ ...prev, [userMessage.id]: uploadedAttachments }));
        setMessageDisplayOverrides((prev) => ({ ...prev, [userMessage.id]: visibleText }));
      }
      mergeVmAgentMessages(messages);
      handleVmAgentMessageBatch(messages);
      if (hasAgentReplyForSession(messages, selectedRunId)) clearPendingAgentReply(selectedRunId);
    } catch (err) {
      recordError(err);
      clearPendingAgentReply(selectedRunId);
      if (!textOverride) setComposer(text);
      setPendingAttachments((prev) => [...attachments, ...prev]);
    } finally {
      setAttachmentUploading(false);
      setMessageSending(false);
    }
  }

  async function refreshRuns(selectFirst = false) {
    try {
      const result = await listRuns();
      setRuns(result.runs);
      if (selectFirst && !selectedRunId && result.runs[0]) setSelectedRunId(result.runs[0].id);
    } catch (err) {
      recordError(err);
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
    if (showBusy) setVmSessionFilesLoading(true);
    try {
      setVmSessionFiles(await getVmSessionFiles(id));
    } catch (err) {
      recordError(err);
    } finally {
      if (showBusy) setVmSessionFilesLoading(false);
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
    setPendingAttachments((prev) => [...prev, ...Array.from(fileList)]);
  }

  function removePendingAttachment(index: number) {
    setPendingAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
  }

  function renderArtifactList(files: RunFile[]) {
    if (!runDetail) return null;
    if (files.length === 0) return <p className="empty-line">No generated outputs yet.</p>;
    return (
      <div className="file-list">
        {files.map((file) => (
          <a className="file-row" key={`${file.kind}:${file.name}`} href={downloadUrl(runDetail.run.id, "artifacts", file.name)} target="_blank" rel="noreferrer">
            <span>{file.name}</span>
            <small>{formatBytes(file.size)} · {formatDate(file.modifiedAt)}</small>
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
          <a
            className="file-row"
            href={vmRunArtifactDownloadUrl(file.runId, file.path)}
            key={`${file.runId}:${file.path}`}
            rel="noreferrer"
            target="_blank"
            title={`${file.runId}/${file.path}`}
          >
            <span>{file.path}</span>
            <small>{formatBytes(file.size)} - {file.attempt ? `attempt ${file.attempt}` : file.status || "artifact"} - {shortId(file.runId)}</small>
          </a>
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
      <a className="file-row" href={href} key={`${file.category}:${file.path}`} rel="noreferrer" target="_blank" title={`${file.category}/${file.path}`}>
        <span>{file.path}</span>
        <small>{formatBytes(file.size)} - {formatDate(file.modifiedAt)}</small>
      </a>
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
      return;
    }
    void refreshRuns(true);
    void refreshVm();
    void handleRefreshVmAgentMessages(false);

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
      source.addEventListener("messages", (event) => {
        if (closed || events !== source) return;
        const data = JSON.parse((event as MessageEvent).data) as VmAgentHistoryResponse;
        setVmAgent(data.status);
        setVmAgentCursorValue(data.cursor);
        mergeVmAgentMessages(data.messages);
        handleVmAgentMessageBatch(data.messages);
        const pendingSessionId = pendingReplySessionRef.current;
        if (pendingSessionId && hasAgentReplyForSession(data.messages, pendingSessionId)) clearPendingAgentReply(pendingSessionId);
        reconnecting = false;
        setVmAgentStreamState("live");
      });
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
  }, [authKey]);

  useEffect(() => {
    if (!authKey || vmAgentStreamState === "live") return;
    let closed = false;
    let inFlight = false;
    const interval = window.setInterval(() => {
      if (closed || inFlight) return;
      inFlight = true;
      void getVmAgentMessages(vmAgentCursorRef.current, { limit: 100 })
        .then((response) => {
          if (closed) return;
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
  }, [authKey, vmAgentStreamState]);

  useEffect(() => {
    if (!pendingReplySessionId || !authKey) return;
    let closed = false;
    let inFlight = false;
    const interval = window.setInterval(() => {
      if (closed || inFlight || !pendingReplySessionRef.current) return;
      const requestedSessionId = pendingReplySessionRef.current;
      inFlight = true;
      void getVmAgentMessages(0, { limit: 500, sessionId: requestedSessionId })
        .then((response) => {
          if (closed) return;
          setVmAgent(response.status);
          setVmAgentCursorValue(response.cursor);
          mergeVmAgentMessages(response.messages);
          handleVmAgentMessageBatch(response.messages);
          const waitingSessionId = pendingReplySessionRef.current;
          if (waitingSessionId && hasAgentReplyForSession(response.messages, waitingSessionId)) {
            clearPendingAgentReply(waitingSessionId);
            return;
          }
          const nextRetry = pendingReplyRetryRef.current + 1;
          pendingReplyRetryRef.current = nextRetry;
          setPendingReplyRetryCount(nextRetry);
          if (nextRetry >= MAX_REPLY_RETRIES) {
            clearPendingAgentReply(waitingSessionId || undefined);
            recordSystemNotice("No agent reply after 30 minutes of fallback polling. Stopped waiting so the agent can be restarted manually.", "error");
          }
        })
        .catch((err) => {
          if (closed) return;
          const nextRetry = pendingReplyRetryRef.current + 1;
          pendingReplyRetryRef.current = nextRetry;
          setPendingReplyRetryCount(nextRetry);
          if (nextRetry >= MAX_REPLY_RETRIES) {
            clearPendingAgentReply();
            recordError(err);
          }
        })
        .finally(() => {
          inFlight = false;
        });
    }, REPLY_RETRY_INTERVAL_MS);
    return () => {
      closed = true;
      window.clearInterval(interval);
    };
  }, [pendingReplySessionId, authKey]);

  useEffect(() => {
    if (!selectedRunId || !authKey) return;
    let closed = false;
    void getVmAgentMessages(0, { limit: 500, sessionId: selectedRunId })
      .then((response) => {
        if (closed) return;
        setVmAgent(response.status);
        setVmAgentCursorValue(response.cursor);
        mergeVmAgentMessages(response.messages);
        handleVmAgentMessageBatch(response.messages);
      })
      .catch((err) => {
        if (!closed) recordError(err);
      });
    return () => {
      closed = true;
    };
  }, [selectedRunId, authKey]);

  useEffect(() => {
    if (!selectedRunId || !authKey) {
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

  return (
    <main className={shellClassName}>
      <header className="top-status-bar">
        <button
          aria-controls="session-sidebar"
          aria-expanded={!leftPanelCollapsed}
          className="secondary desktop-panel-toggle"
          onClick={() => setLeftPanelCollapsed((collapsed) => !collapsed)}
          type="button"
        >
          {leftPanelCollapsed ? "Show sessions" : "Hide sessions"}
        </button>
        <button
          aria-controls="session-sidebar"
          aria-expanded={mobileLeftPanelOpen}
          className="secondary mobile-panel-trigger"
          onClick={() => {
            setMobileRightPanelOpen(false);
            setMobileLeftPanelOpen(true);
          }}
          type="button"
        >
          Sessions
        </button>
        <div className="brand-lockup">
          <span className="brand-mark">S</span>
          <div>
            <strong>Sentaurus VM Agent</strong>
            <small>VM-local LLM · SSH relay · Safe TCAD workspace</small>
          </div>
        </div>
        <div className="top-status-actions">
          <span className={statusPillClass(health.endsWith("OK"))}><i />API {health}</span>
          <span className={statusPillClass(vmOnline, vmLoading)}><i />VM {vmLoading ? "Checking" : vm?.ok ? "Online" : vm ? "Offline" : "Unchecked"}</span>
          <span className={statusPillClass(workerRunning)}><i />Agent {vmAgent?.workerRunning ? "Running" : vmAgent ? "Stopped" : vmAgentStreamState}</span>
          <span className={statusPillClass(llmConfigured, vmAgent && !vmAgent.llmConfigured ? true : false)}><i />LLM {vmAgent?.llmConfigured ? "Configured" : "Pending"}</span>
          <span className={statusPillClass(clockSkewOk, clockSkewWarning)} title={vmAgent?.vmTime ? `VM time: ${vmAgent.vmTime}` : undefined}><i />Clock {clockSkewLabel}</span>
          <button
            aria-controls="inspector-panel"
            aria-expanded={!rightPanelCollapsed}
            className="secondary desktop-panel-toggle"
            onClick={() => setRightPanelCollapsed((collapsed) => !collapsed)}
            type="button"
          >
            {rightPanelCollapsed ? "Show details" : "Hide details"}
          </button>
        </div>
        <button
          aria-controls="inspector-panel"
          aria-expanded={mobileRightPanelOpen}
          className="secondary mobile-panel-trigger"
          onClick={() => {
            setMobileLeftPanelOpen(false);
            setMobileRightPanelOpen(true);
          }}
          type="button"
        >
          Details
        </button>
      </header>

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
            <small>{visibleRuns.length} shown · {runs.length} total</small>
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
        <header className="chat-header">
          <div>
            <p className="eyebrow">Current session</p>
            <h1>{currentTitle}</h1>
            <div className="meta-row">
              <span>{selectedRunId ? shortId(selectedRunId) : "select or create a session"}</span>
              <span>stream: {vmAgentStreamState}</span>
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
            <button className="secondary" onClick={() => void handleRefreshVmAgentMessages()} disabled={!authKey || vmAgentHistoryLoading}>{vmAgentHistoryLoading ? "Loading" : "History"}</button>
          </div>
        </header>

        <section className={`progress-panel ${progressCollapsed ? "collapsed" : ""}`} aria-label="Agent progress">
          <div className="progress-panel-header">
            <div>
              <p className="eyebrow">Progress</p>
              <h2>{latestProgress ? `${progressLabel(latestProgress.stage)} · ${latestProgress.status}` : "Idle"}</h2>
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
          {visibleMessages.length === 0 && (
            <div className="empty-chat">
              <strong>{selectedRun ? "No messages in this session." : "No session selected."}</strong>
              <span>{selectedRun ? "Send a prompt or use a quick action to talk with the VM agent." : "Create or select a session from the left panel."}</span>
            </div>
          )}
          {visibleMessages.map((message) => {
            const attachments = messageAttachments[message.id] || [];
            const messageVmArtifacts = vmArtifactsForMessage(message);
            const visibleVmArtifacts = messageVmArtifacts.slice(0, 16);
            const content = messageDisplayOverrides[message.id] ?? message.content;
            return (
              <article className={`message-row ${message.role}`} key={message.id}>
                <div className="avatar">{message.role === "agent" ? "VM" : message.role === "user" ? "You" : "Sys"}</div>
                <div className="message-bubble">
                  <div className="message-content">{content}</div>
                  {(attachments.length > 0 || messageVmArtifacts.length > 0) && (
                    <div className="message-attachments">
                      {attachments.map((file) => (
                        isImagePath(file.name) && selectedRunId ? (
                          <span className="chat-image-with-link" key={file.id}>
                            {renderImagePreview(downloadUrl(selectedRunId, "files", file.name), file.name, downloadUrl(selectedRunId, "files", file.name))}
                          </span>
                        ) : (
                          <span className="attachment-chip" key={file.id}>
                            <span>{file.name}</span>
                            <small>{formatBytes(file.size)}</small>
                          </span>
                        )
                      ))}
                      {visibleVmArtifacts.map((file) => (
                        isImagePath(file.path) ? (
                          <span className="chat-image-with-link" key={`${file.runId}:${file.path}`}>
                            {renderImagePreview(vmRunArtifactDownloadUrl(file.runId, file.path), file.path, vmRunArtifactDownloadUrl(file.runId, file.path))}
                          </span>
                        ) : (
                          <a
                            className="attachment-chip artifact-chip"
                            href={vmRunArtifactDownloadUrl(file.runId, file.path)}
                            key={`${file.runId}:${file.path}`}
                            rel="noreferrer"
                            target="_blank"
                            title={`${file.runId}/${file.path}`}
                          >
                            <span>{file.path}</span>
                            <small>{file.attempt ? `try ${file.attempt} / ${formatBytes(file.size)}` : formatBytes(file.size)}</small>
                          </a>
                        )
                      ))}
                      {messageVmArtifacts.length > visibleVmArtifacts.length && (
                        <span className="attachment-chip muted-chip">
                          <span>+{messageVmArtifacts.length - visibleVmArtifacts.length} more</span>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
          <div ref={messageEndRef} />
        </div>

        <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void handleVmAgentMessage(); }}>
          <div className="quick-prompts">
            {QUICK_PROMPTS.map((prompt) => (
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
          {pendingAttachments.length > 0 && (
            <div className="pending-attachments">
              {pendingAttachments.map((file, index) => (
                <span className="attachment-chip" key={`${file.name}-${file.size}-${index}`}>
                  {file.name}
                  <small>{formatBytes(file.size)}</small>
                  <button type="button" onClick={() => removePendingAttachment(index)} disabled={messageSending || attachmentUploading}>×</button>
                </span>
              ))}
            </div>
          )}
          <div className="composer-box">
            <textarea
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleVmAgentMessage();
                }
              }}
              placeholder="Message the VM agent…"
              rows={3}
            />
            <div className="composer-actions">
              <label className="attach-button">
                Attach
                <input type="file" multiple disabled={!authKey || !selectedRunId || messageSending || attachmentUploading} onChange={(event) => {
                  handleSelectAttachments(event.target.files);
                  event.currentTarget.value = "";
                }} />
              </label>
              <button disabled={!canSendMessage || (!composer.trim() && pendingAttachments.length === 0)}>
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
            <div><strong>{contextStats.percent}%</strong><span>of 272k</span></div>
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
            <dt>Models</dt><dd>{vmAgent?.llmModels?.join(" → ") || vmAgent?.llmModel || "not configured"}</dd>
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
              {globalMessages.map((message) => <p key={message.id}>{formatDate(message.createdAt)} · {message.content}</p>)}
            </div>
          </section>
        )}
      </aside>

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
