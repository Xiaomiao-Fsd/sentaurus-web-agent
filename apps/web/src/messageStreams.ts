import type { VmAgentMessage } from "@sentaurus-agent/shared";
import { filterConcurrentWorkerArtifacts } from "./sessionHistory.js";

export function messageKind(message: VmAgentMessage): string {
  return typeof message.meta?.kind === "string" ? message.meta.kind : "";
}

function streamState(message: VmAgentMessage): string {
  const value = message.meta?.streamState ?? message.meta?.status;
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isAgentStreamDelta(message: VmAgentMessage): boolean {
  const kind = messageKind(message);
  return message.role === "agent" && !kind.startsWith("agent_reasoning_summary_") && (kind === "agent_response_delta" || message.meta?.delta === true);
}

function isReasoningStreamDelta(message: VmAgentMessage): boolean {
  return message.role === "agent" && messageKind(message) === "agent_reasoning_summary_delta";
}

function isReasoningStreamDone(message: VmAgentMessage): boolean {
  return message.role === "agent" && messageKind(message) === "agent_reasoning_summary_done";
}

function isAgentStreamDone(message: VmAgentMessage): boolean {
  if (message.role !== "agent") return false;
  const kind = messageKind(message);
  if (kind.startsWith("agent_reasoning_summary_")) return false;
  const state = streamState(message);
  return kind === "agent_response_done"
    || kind === "agent_response_error"
    || message.meta?.done === true
    || state === "done"
    || state === "completed"
    || state === "final"
    || state === "error";
}

export function isAgentStreamingDraft(message: VmAgentMessage): boolean {
  if (message.role !== "agent") return false;
  if (isReasoningStreamDelta(message) || isReasoningStreamDone(message)) return false;
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

function metaString(message: VmAgentMessage, key: string): string | null {
  const value = message.meta?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function streamTargetMessageId(message: VmAgentMessage): string | null {
  if (message.role !== "agent") return null;
  if (!isAgentStreamDelta(message)
    && !isAgentStreamingDraft(message)
    && !isAgentStreamDone(message)
    && !isReasoningStreamDelta(message)
    && !isReasoningStreamDone(message)) return null;
  return metaString(message, "targetMessageId")
    || metaString(message, "messageId")
    || metaString(message, "streamId")
    || message.id;
}

function messageSequence(message: VmAgentMessage): number | null {
  return typeof message.sequence === "number" && Number.isFinite(message.sequence) ? message.sequence : null;
}

function messageTime(message: VmAgentMessage): number {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isLegacyReasoningConfigEcho(message: VmAgentMessage): boolean {
  const summaryIndex = typeof message.meta?.summaryIndex === "number" ? message.meta.summaryIndex : 0;
  return messageKind(message) === "agent_reasoning_summary"
    && summaryIndex > 1
    && /^[detail]$/i.test(message.content.trim());
}

export function mergeMessageList(prev: VmAgentMessage[], next: VmAgentMessage[] | undefined): VmAgentMessage[] {
  if (!next?.length) return prev;
  const byId = new Map(prev.map((message) => [message.id, message]));
  for (const message of next) {
    if (isLegacyReasoningConfigEcho(message)) continue;
    const targetMessageId = streamTargetMessageId(message);
    if (targetMessageId) {
      const existing = byId.get(targetMessageId);
      const reasoningStream = isReasoningStreamDelta(message) || isReasoningStreamDone(message);
      const streamDone = reasoningStream ? isReasoningStreamDone(message) : isAgentStreamDone(message);
      const appendContent = isAgentStreamDelta(message) || isReasoningStreamDelta(message) || message.meta?.append === true;
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
          kind: reasoningStream
            ? "agent_reasoning_summary"
            : streamDone ? messageKind(message) || "agent_response_done" : "agent_response_stream",
          ...(reasoningStream ? { thinkingStatus: streamDone ? "completed" : "streaming" } : {}),
          done: streamDone
        },
        attachments: message.attachments || existing?.attachments
      });
      continue;
    }
    const existing = byId.get(message.id);
    byId.set(message.id, existing ? { ...existing, ...message, meta: { ...existing.meta, ...message.meta } } : message);
  }
  const sorted = [...byId.values()].sort((a, b) => {
    const aSequence = messageSequence(a);
    const bSequence = messageSequence(b);
    if (aSequence !== null && bSequence !== null && aSequence !== bSequence) return aSequence - bSequence;
    return messageTime(a) - messageTime(b);
  });
  return filterConcurrentWorkerArtifacts(sorted.filter((message) => !isLegacyReasoningConfigEcho(message)));
}
