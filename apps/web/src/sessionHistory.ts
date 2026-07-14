import type { VmAgentHistoryResponse, VmAgentStatus } from "@sentaurus-agent/shared";

export type SessionHistoryPhase = "idle" | "loading" | "ready" | "empty" | "failed" | "truncated";

export type SessionHistoryState = {
  phase: SessionHistoryPhase;
  error?: string;
  retryable?: boolean;
  retrying?: boolean;
  messageCount?: number;
  cursor?: number;
};

export type SessionHistoryErrorDetails = {
  message: string;
  retryable: boolean;
  status?: VmAgentStatus;
};

export const IDLE_SESSION_HISTORY: SessionHistoryState = { phase: "idle" };

export function isHistoryBootstrapSettled(
  runsHydrated: boolean,
  selectedRunId: string | null,
  attemptedSessionId: string | null
): boolean {
  return runsHydrated && (!selectedRunId || attemptedSessionId === selectedRunId);
}

export function isCurrentHistoryRequest(
  currentSequence: number,
  requestSequence: number,
  selectedRunId: string | null,
  requestedSessionId: string
): boolean {
  return currentSequence === requestSequence && selectedRunId === requestedSessionId;
}

export function shouldLoadSelectedSessionHistory(state: SessionHistoryState | undefined): boolean {
  return !state || state.phase === "idle";
}

export function loadingSessionHistoryState(
  previous: SessionHistoryState | undefined,
  retrying = false
): SessionHistoryState {
  return {
    ...previous,
    phase: "loading",
    error: undefined,
    retrying: retrying || previous?.phase === "failed"
  };
}

export function completedSessionHistoryState(response: VmAgentHistoryResponse): SessionHistoryState {
  return {
    phase: response.truncated ? "truncated" : response.messages.length > 0 ? "ready" : "empty",
    retryable: !!response.truncated,
    retrying: false,
    messageCount: response.messages.length,
    cursor: response.cursor
  };
}

export function failedSessionHistoryState(
  previous: SessionHistoryState | undefined,
  details: SessionHistoryErrorDetails
): SessionHistoryState {
  return {
    phase: "failed",
    error: details.message,
    retryable: details.retryable,
    retrying: false,
    messageCount: previous?.messageCount,
    cursor: previous?.cursor
  };
}

export function historyErrorDetails(err: unknown, fallbackMessage: string): SessionHistoryErrorDetails {
  const record = err && typeof err === "object" ? err as { body?: unknown; historyBody?: unknown } : {};
  const body = record.body && typeof record.body === "object"
    ? record.body as Partial<VmAgentHistoryResponse>
    : record.historyBody && typeof record.historyBody === "object"
      ? record.historyBody as Partial<VmAgentHistoryResponse>
      : undefined;
  return {
    message: body?.message || body?.status?.error || fallbackMessage,
    retryable: body?.retryable !== false,
    status: body?.status
  };
}

export function assertHistoryResponse(response: VmAgentHistoryResponse): void {
  if (response.ok !== false && response.status.ok !== false) return;
  const error = new Error(response.message || response.status.error || response.error || "VM session history failed") as Error & {
    historyBody?: VmAgentHistoryResponse;
  };
  error.historyBody = response;
  throw error;
}
