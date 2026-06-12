import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, MouseEvent } from "react";
import type {
  RunDetail,
  RunFile,
  RunStatus,
  RunSummary,
  VmAgentHistoryResponse,
  VmAgentMessage,
  VmAgentStatus,
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
  getVmAgentMessages,
  getVmAgentStatus,
  getVmStatus,
  listRuns,
  renameRun,
  sendVmAgentMessage,
  setAuthToken,
  uploadRunFile,
  vmAgentMessageStreamUrl
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
  stage: string;
  status: ProgressStatus;
  detail: string;
  progress: number | null;
  runId: string | null;
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

const REFERENCE_CONTEXT_TOKENS = 272_000;
const REPLY_RETRY_INTERVAL_MS = 10_000;
const MAX_REPLY_RETRIES = 180;
const VM_AGENT_STREAM_RECONNECT_MS = 3_000;
const SESSION_ORDER_KEY = "sentaurus_session_order";
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

const SIMULATION_SETUP = [
  { label: "Gate bias", value: "Vg sweep, defined by prompt or uploaded deck" },
  { label: "Drain bias", value: "Vd / Id target, extracted from experiment goal" },
  { label: "Source / bulk", value: "Reference terminal conditions" },
  { label: "Ion implantation", value: "Dose and concentration from SProcess inputs" },
  { label: "Device geometry", value: "Channel, oxide and contact setup from structure files" },
  { label: "Simulation goals", value: "Transfer curve, output curve, threshold and leakage extraction" }
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

function mergeMessageList(prev: VmAgentMessage[], next: VmAgentMessage[] | undefined): VmAgentMessage[] {
  if (!next?.length) return prev;
  const seen = new Set(prev.map((message) => message.id));
  const merged = [...prev];
  for (const message of next) {
    if (!seen.has(message.id)) {
      merged.push(message);
      seen.add(message.id);
    }
  }
  return merged.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
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

function isSentaurusRunCompletion(message: VmAgentMessage): boolean {
  return message.role === "agent" && message.meta?.kind === "sentaurus_run";
}

function sentaurusRunStatus(message: VmAgentMessage): string | null {
  const value = message.meta?.runStatus;
  return typeof value === "string" ? value : null;
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
  const [vmAgentCursor, setVmAgentCursor] = useState(0);
  const [composer, setComposer] = useState("");
  const [vmAgentStatusLoading, setVmAgentStatusLoading] = useState(false);
  const [vmAgentConnectLoading, setVmAgentConnectLoading] = useState(false);
  const [vmAgentHistoryLoading, setVmAgentHistoryLoading] = useState(false);
  const [messageSending, setMessageSending] = useState(false);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [pendingReplySessionId, setPendingReplySessionId] = useState<string | null>(null);
  const [pendingReplyRetryCount, setPendingReplyRetryCount] = useState(0);
  const [vmAgentStreamState, setVmAgentStreamState] = useState("idle");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [panelNotice, setPanelNotice] = useState<PanelNotice | null>(null);
  const [sessionOrder, setSessionOrder] = useState<string[]>(() => loadSessionOrder());
  const [sessionSearch, setSessionSearch] = useState("");
  const [draggedRunId, setDraggedRunId] = useState<string | null>(null);
  const [dragOverRunId, setDragOverRunId] = useState<string | null>(null);
  const [sessionMenu, setSessionMenu] = useState<SessionMenuState | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<File[]>([]);
  const [messageAttachments, setMessageAttachments] = useState<Record<string, UploadedAttachment[]>>({});
  const [messageDisplayOverrides, setMessageDisplayOverrides] = useState<Record<string, string>>({});
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const vmAgentCursorRef = useRef(0);
  const selectedRunIdRef = useRef<string | null>(null);
  const pendingReplySessionRef = useRef<string | null>(null);
  const pendingReplyRetryRef = useRef(0);
  const notifiedCompletionIdsRef = useRef<Set<string>>(new Set());

  const orderedRuns = useMemo(() => orderRuns(runs, sessionOrder), [runs, sessionOrder]);
  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) || null, [runs, selectedRunId]);
  const menuRun = useMemo(() => runs.find((run) => run.id === sessionMenu?.runId) || null, [runs, sessionMenu]);
  const currentMessages = useMemo(() => messagesForSession(vmAgentMessages, selectedRunId), [selectedRunId, vmAgentMessages]);
  const visibleMessages = useMemo(() => currentMessages.filter((message) => message.meta?.kind !== "progress"), [currentMessages]);
  const progressRows = useMemo(() => progressRowsForSession(vmAgentMessages, selectedRunId).slice(-12), [selectedRunId, vmAgentMessages]);
  const latestProgress = progressRows.at(-1);
  const progressTraceAutoOpen = latestProgress?.status === "running" || latestProgress?.status === "queued";
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
  const canSendMessage = !!authKey && !!selectedRunId && !messageSending && !attachmentUploading;
  const waitingForAgentReply = !!pendingReplySessionId;
  const startAgentDisabled = !authKey || vmAgentConnectLoading || messageSending || waitingForAgentReply;

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

  function mergeVmAgentMessages(next: VmAgentMessage[] | undefined) {
    setVmAgentMessages((prev) => mergeMessageList(prev, next));
  }

  function updateVmAgentCursor(cursor: number | undefined) {
    const nextCursor = cursor || 0;
    vmAgentCursorRef.current = nextCursor;
    setVmAgentCursor(nextCursor);
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
      if (sessionId && sessionId === selectedRunIdRef.current) void refreshRunDetail(sessionId);
      void refreshRuns();
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(ok ? "Sentaurus simulation completed" : "Sentaurus simulation finished with errors", {
          body: sessionId ? `Session ${shortId(sessionId)} · ${runStatus || "finished"}` : runStatus || "finished"
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
      setVmAgent(response.status);
      updateVmAgentCursor(response.cursor);
      mergeVmAgentMessages(response.messages || (response.message ? [response.message] : []));
      handleVmAgentMessageBatch(response.messages || (response.message ? [response.message] : []));
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
      const response = await getVmAgentMessages(0);
      setVmAgent(response.status);
      updateVmAgentCursor(response.cursor);
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

      const attachmentLine = uploadedAttachments.length > 0
        ? `\n\nAttachments uploaded to this session: ${uploadedAttachments.map((file) => file.name).join(", ")}.`
        : "";
      const visibleText = text || `Attached ${uploadedAttachments.length} file${uploadedAttachments.length === 1 ? "" : "s"}.`;
      const response = await sendVmAgentMessage(`${visibleText}${attachmentLine}`, selectedRunId);
      setVmAgent(response.status);
      updateVmAgentCursor(response.cursor);
      beginPendingAgentReply(selectedRunId);
      const userMessage = [...(response.messages || [response.message])]
        .reverse()
        .find((message) => message.role === "user" && messageBelongsToSession(message, selectedRunId));
      if (userMessage && uploadedAttachments.length > 0) {
        setMessageAttachments((prev) => ({ ...prev, [userMessage.id]: uploadedAttachments }));
        setMessageDisplayOverrides((prev) => ({ ...prev, [userMessage.id]: visibleText }));
      }
      mergeVmAgentMessages(response.messages || [response.message]);
      handleVmAgentMessageBatch(response.messages || [response.message]);
      if (hasAgentReplyForSession(response.messages || [response.message], selectedRunId)) clearPendingAgentReply(selectedRunId);
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

  function openSessionMenu(event: MouseEvent, runId: string) {
    event.preventDefault();
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
      setSessionMenu(null);
      setRenameTitle("");
      return;
    }
    setSessionMenu(null);
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
    setSessionMenu(null);
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

  useEffect(() => {
    getHealth().then((h) => setHealth(`${h.service} OK`)).catch((err) => setHealth(errorMessage(err)));
  }, []);

  useEffect(() => {
    saveSessionOrder(sessionOrder);
  }, [sessionOrder]);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  useEffect(() => {
    if (!sessionMenu) return;
    const close = () => setSessionMenu(null);
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
    let reconnectTimer: number | undefined;
    let events: EventSource | null = null;

    const closeStream = () => {
      if (!events) return;
      events.close();
      events = null;
    };

    const connectStream = () => {
      if (closed) return;
      closeStream();
      setVmAgentStreamState("connecting");
      events = new EventSource(vmAgentMessageStreamUrl(vmAgentCursorRef.current));
      events.addEventListener("messages", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as VmAgentHistoryResponse;
        setVmAgent(data.status);
        updateVmAgentCursor(data.cursor);
        mergeVmAgentMessages(data.messages);
        handleVmAgentMessageBatch(data.messages);
        const pendingSessionId = pendingReplySessionRef.current;
        if (pendingSessionId && hasAgentReplyForSession(data.messages, pendingSessionId)) clearPendingAgentReply(pendingSessionId);
        setVmAgentStreamState("live");
      });
      events.addEventListener("ping", () => setVmAgentStreamState("live"));
      events.addEventListener("error", () => {
        if (closed) return;
        closeStream();
        setVmAgentStreamState("reconnecting");
        if (reconnectTimer) window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(connectStream, VM_AGENT_STREAM_RECONNECT_MS);
      });
    };

    connectStream();
    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      closeStream();
    };
  }, [authKey]);

  useEffect(() => {
    if (!pendingReplySessionId || !authKey) return;
    let closed = false;
    let inFlight = false;
    const interval = window.setInterval(() => {
      if (closed || inFlight || !pendingReplySessionRef.current) return;
      inFlight = true;
      void getVmAgentMessages(0)
        .then((response) => {
          if (closed) return;
          setVmAgent(response.status);
          updateVmAgentCursor(response.cursor);
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
            recordSystemNotice("No agent reply after a long wait. Stopped waiting so the agent can be restarted manually.", "error");
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
    if (!selectedRunId || !authKey) {
      setRunDetail(null);
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
    messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [currentMessages.length, selectedRunId]);

  return (
    <main className="app-shell">
      <header className="top-status-bar">
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
        </div>
      </header>

      <aside className="session-sidebar">
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
              onClick={() => setSelectedRunId(run.id)}
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
              <span>context: {formatCompactNumber(contextStats.estimatedTokens)} / {formatCompactNumber(contextStats.maxTokens)} est. tokens</span>
            </div>
          </div>
          <div className="chat-actions">
            <button
              onClick={() => void handleConnectVmAgent()}
              disabled={startAgentDisabled}
              title={waitingForAgentReply ? "Disabled while waiting for the current agent reply to avoid interrupting a long task." : undefined}
            >
              {waitingForAgentReply ? `Waiting reply ${pendingReplyRetryCount}/${MAX_REPLY_RETRIES}` : vmAgentConnectLoading ? "Starting" : "Start agent"}
            </button>
            {waitingForAgentReply && (
              <button className="secondary danger-button" onClick={forceStopPendingReply} type="button">
                Force stop
              </button>
            )}
            <button className="secondary" onClick={() => void handleRefreshVmAgentMessages()} disabled={!authKey || vmAgentHistoryLoading}>{vmAgentHistoryLoading ? "Loading" : "History"}</button>
          </div>
        </header>

        <section className="progress-panel" aria-label="Agent progress">
          <div className="progress-panel-header">
            <div>
              <p className="eyebrow">Progress</p>
              <h2>{latestProgress ? `${progressLabel(latestProgress.stage)} · ${latestProgress.status}` : "Idle"}</h2>
            </div>
            <span>{progressRows.length} event{progressRows.length === 1 ? "" : "s"} · {progressTraceAutoOpen ? "expanded" : "folded"}</span>
          </div>
          <details className="progress-details" open={progressTraceAutoOpen}>
            <summary>
              <span>Execution trace</span>
              <small>Visible progress events, not hidden model chain-of-thought</small>
            </summary>
            <div className="progress-table-wrap">
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
                      <td>{formatDate(row.createdAt)}</td>
                      <td>{progressLabel(row.stage)}</td>
                      <td><span>{row.status}</span></td>
                      <td>{row.progress === null ? "-" : `${row.progress}%`}</td>
                      <td title={row.runId || undefined}>{row.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
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
            const content = messageDisplayOverrides[message.id] ?? message.content;
            return (
              <article className={`message-row ${message.role}`} key={message.id}>
                <div className="avatar">{message.role === "agent" ? "VM" : message.role === "user" ? "You" : "Sys"}</div>
                <div className="message-bubble">
                  <div className="message-content">{content}</div>
                  {attachments.length > 0 && (
                    <div className="message-attachments">
                      {attachments.map((file) => (
                        <span className="attachment-chip" key={file.id}>
                          {file.name}
                          <small>{formatBytes(file.size)}</small>
                        </span>
                      ))}
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

      <aside className="inspector-panel">
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
          </dl>
        </section>

        <section className="inspector-card">
          <div className="section-head">
            <h2>Simulation Setup</h2>
            {selectedRun && <em className={`run-state ${statusTone(selectedRun.status)} ${selectedRun.status}`}>{selectedRun.status}</em>}
          </div>
          <div className="simulation-list">
            {SIMULATION_SETUP.map((item) => (
              <div className="simulation-row" key={item.label}>
                <span>{item.label}</span>
                <small>{item.value}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="inspector-card">
          <div className="section-head">
            <h2>Expected Outputs</h2>
            {runDetail && <button className="link-button" onClick={() => void refreshRunDetail()}>Refresh</button>}
          </div>
          <div className="output-targets">
            {EXPECTED_OUTPUTS.map((item) => <span key={item}>{item}</span>)}
          </div>
          <h3>Generated artifacts</h3>
          {runDetail ? renderArtifactList(runDetail.artifacts) : <p className="empty-line">Select a session to view generated outputs.</p>}
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

      {sessionMenu && menuRun && (
        <div className="session-menu" style={{ left: sessionMenu.x, top: sessionMenu.y }} onClick={(event) => event.stopPropagation()}>
          <strong>{menuRun.title}</strong>
          {sessionMenu.mode === "menu" && (
            <>
              <button onClick={() => showRenameSession(menuRun)}>Rename</button>
              <button className="danger-button" onClick={() => showDeleteSession(menuRun)}>Delete</button>
            </>
          )}
          {sessionMenu.mode === "rename" && (
            <form className="menu-form" onSubmit={(event) => void handleRenameSession(event, menuRun)}>
              <label>
                Session name
                <input autoFocus value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} />
              </label>
              <div className="confirm-actions">
                <button type="button" className="secondary" onClick={() => setSessionMenu((prev) => prev ? { ...prev, mode: "menu" } : prev)}>Cancel</button>
                <button type="submit" disabled={!renameTitle.trim() || renameTitle.trim() === menuRun.title}>Save</button>
              </div>
            </form>
          )}
          {sessionMenu.mode === "delete" && (
            <div className="menu-confirm danger">
              <p>Delete this session and its local files?</p>
              <span>This cannot be undone.</span>
              <div className="confirm-actions">
                <button className="secondary" onClick={() => setSessionMenu((prev) => prev ? { ...prev, mode: "menu" } : prev)}>Cancel</button>
                <button className="danger-button" onClick={() => void handleDeleteSession(menuRun)}>Delete session</button>
              </div>
            </div>
          )}
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
