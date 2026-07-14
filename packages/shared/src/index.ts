export type VmStatus = {
  ok: boolean;
  checkedAt: string;
  sshTarget: string;
  hostname?: string;
  user?: string;
  sentaurusVersion?: string;
  tools?: Record<string, string | null>;
  error?: string;
  raw?: string;
};

export type VmAgentMessageKind =
  | "worklog_summary"
  | "file_operation"
  | "tool_run"
  | "run_progress"
  | "run_final"
  | "run_diagnostic"
  | "vm_agent_attachments"
  | "agent_response_stream"
  | "agent_response_delta"
  | "agent_response_done"
  | "agent_response_error"
  | "agent_trace"
  | string;

export type VmAgentMessageMeta = {
  kind?: VmAgentMessageKind;
  sessionId?: string;
  runId?: string;
  turnId?: string;
  groupId?: string;
  streamId?: string;
  targetMessageId?: string;
  messageId?: string;
  phase?: string;
  foldable?: boolean;
  collapsedByDefault?: boolean;
  publicWorklog?: boolean;
  displayLanguage?: string;
  operation?: string;
  path?: string;
  category?: string;
  tool?: string;
  commandLabel?: string;
  status?: string;
  exitCode?: number;
  durationMs?: number;
  worklogDurationMs?: number;
  append?: boolean;
  delta?: boolean;
  done?: boolean;
  streamState?: "queued" | "running" | "streaming" | "done" | "completed" | "error" | string;
  summaryOfGroup?: boolean;
} & Record<string, unknown>;

export type VmAgentMessage = {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  createdAt: string;
  vmCreatedAt?: string;
  hostReceivedAt?: string;
  sequence?: number;
  meta?: VmAgentMessageMeta;
  attachments?: VmAgentAttachment[];
};

export type VmAgentStatus = {
  ok: boolean;
  checkedAt: string;
  sshTarget: string;
  connected: boolean;
  agent?: string;
  version?: string;
  hostname?: string;
  user?: string;
  capabilities?: string[];
  instanceCount?: number;
  latestInstance?: string | null;
  mailbox?: string;
  messageCount?: number;
  workerRunning?: boolean;
  workerPid?: number | null;
  llmConfigured?: boolean;
  llmModel?: string;
  llmModels?: string[];
  llmReasoningEffort?: "max";
  llmContextWindowTokens?: number;
  llmContextTargetTokens?: number;
  llmContextHardTokens?: number;
  llmTimeoutSeconds?: number;
  maxAutodebugAttempts?: number;
  manualCount?: number;
  manualFiles?: string[];
  queueDepth?: number;
  sentaurusTools?: Record<string, string | null>;
  vmTime?: string;
  vmEpochMs?: number;
  hostTime?: string;
  hostEpochMs?: number;
  clockSkewMs?: number;
  clockSkewWarning?: boolean;
  error?: string;
  raw?: string;
};

export type VmAgentConnectResponse = {
  ok: boolean;
  status: VmAgentStatus;
  message?: VmAgentMessage;
  messages?: VmAgentMessage[];
  cursor?: number;
};

export type VmAgentMessageResponse = {
  ok: boolean;
  status: VmAgentStatus;
  message: VmAgentMessage;
  messages: VmAgentMessage[];
  cursor: number;
};

export type VmAgentModelId =
  | "gpt-5.4"
  | "gpt-5.5"
  | "gpt-5.6-luna"
  | "gpt-5.6-terra"
  | "gpt-5.6-sol";

export type VmAgentModelOption = {
  id: VmAgentModelId;
  contextWindowTokens: 272000 | 353000;
};

export type VmAgentModelsResponse = {
  ok: boolean;
  currentModel: VmAgentModelId;
  activeModels: string[];
  reasoningEffort: "max";
  contextWindowTokens: 272000 | 353000;
  models: VmAgentModelOption[];
  status: VmAgentStatus;
};

export type VmAgentModelUpdateRequest = {
  model: VmAgentModelId;
};

export type VmAgentHistoryErrorCode =
  | "VM_HISTORY_TIMEOUT"
  | "VM_HISTORY_BRIDGE_FAILED"
  | "VM_SSH_QUEUE_TIMEOUT";

export type VmAgentHistoryResponse = {
  ok: boolean;
  status: VmAgentStatus;
  messages: VmAgentMessage[];
  cursor: number;
  truncated?: boolean;
  continuation?: string;
  rawCount?: number;
  compactedCount?: number;
  payloadBytes?: number;
  historyCompacted?: boolean;
  transportCompressedBytes?: number;
  transportUncompressedBytes?: number;
  error?: VmAgentHistoryErrorCode;
  message?: string;
  retryable?: boolean;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export type ChatRequest = {
  message: string;
  conversationId?: string;
};

export type ChatResponse = {
  conversationId: string;
  message: ChatMessage;
};

export type RunStatus =
  | "created"
  | "queued"
  | "running"
  | "succeeded"
  | "incomplete"
  | "failed-postcondition"
  | "failed"
  | "cancelled";

export type RunFileKind = "input" | "logs" | "artifacts";

export type RunFile = {
  name: string;
  kind: RunFileKind;
  size: number;
  modifiedAt: string;
};

export type SimulationSetup = {
  deviceType?: string;
  gateBias?: string;
  drainBias?: string;
  sourceBulk?: string;
  geometry?: string;
  dopingOrImplant?: string;
  physicsModels?: string;
  mesh?: string;
  temperature?: string;
  simulationGoals?: string;
  expectedOutputs?: string[];
  notes?: string;
  extractorVersion?: string;
  metricProfile?: string;
  postprocessStatus?: "ok" | "incomplete" | "invalid-input" | "failed" | string;
  postprocessErrorCode?: string;
  inputHashes?: Record<string, string>;
  actualBiases?: {
    lowVd?: number;
    highVd?: number;
  };
  updatedAt: string;
  updatedBy: "vm-agent" | "user" | "system";
};

export type DfiseIdvgMetricProfile = "tcad-idvg-v1";

export type DfiseIdvgPostprocessRequest = {
  kind: "dfise-idvg-v1";
  lowInput: string;
  highInput: string;
  expectedLowVd?: number;
  expectedHighVd?: number;
  biasToleranceV?: number;
  vthCurrentAperUm?: number;
  ssCurrentMinAperUm?: number;
  ssCurrentMaxAperUm?: number;
  minimumPointCount?: number;
  outputPrefix: string;
  metricProfile?: DfiseIdvgMetricProfile;
};

export type DfiseIdvgErrorCode =
  | "BIAS_MISMATCH"
  | "BIAS_ORDER_INVALID"
  | "DATASET_NOT_FOUND"
  | "EXTRACTOR_INTERNAL_ERROR"
  | "EXTRACTOR_VERSION_MISMATCH"
  | "INSUFFICIENT_POINTS"
  | "INVALID_ARGUMENT"
  | "MALFORMED_DATA_BLOCK"
  | "NO_VALID_POINTS"
  | "NONFINITE_METRIC"
  | "SS_WINDOW_NOT_COVERED"
  | "UNSUPPORTED_METRIC_PROFILE"
  | "UNSUPPORTED_SS_METHOD"
  | "VTH_NOT_COVERED";

export type DfiseIdvgInputProvenance = {
  path: string;
  sha256: string;
  size: number;
  actualVd: number;
  datasetCount: number;
  functionCount?: number;
  columnResolution?: "dataset-name" | "function-signature-fallback" | string;
  validPointCount: number;
  duplicateCount: number;
  vgMin: number;
  vgMax: number;
  idMin: number;
  idMax: number;
  selectedDataBlock: number;
};

export type DfiseIdvgPostprocessResult = {
  status: "ok" | "incomplete" | "invalid-input" | "failed";
  metricProfile: DfiseIdvgMetricProfile;
  extractorVersion: "dfise-idvg-extract/1" | string;
  units?: {
    gateVoltage: "V" | string;
    drainVoltage: "V" | string;
    drainCurrent: "A/um" | string;
    vth: "V" | string;
    ss: "mV/dec" | string;
    dibl: "mV/V" | string;
  };
  inputs?: {
    low: DfiseIdvgInputProvenance;
    high: DfiseIdvgInputProvenance;
  };
  metrics?: {
    vthLowV: number;
    vthHighV: number;
    ssLowMvPerDec: number;
    ssHighMvPerDec: number;
    diblMvPerV: number;
    ssLowWindowPointCount?: number;
    ssHighWindowPointCount?: number;
    ssLowAdjacentPairCount?: number;
    ssHighAdjacentPairCount?: number;
  };
  outputs?: {
    csv: string;
    metricsJson: string;
    metricsDat: string;
    report: string;
    plot: string;
  };
  error?: {
    code: DfiseIdvgErrorCode | string;
    message: string;
    details?: Record<string, unknown>;
  };
  warnings?: string[];
  generatedAt?: string;
};

export type VmRunArtifact = {
  path: string;
  size: number;
};

export type VmAgentAttachmentSource = "run-input" | "vm-session-file" | "vm-run-artifact";

export type VmAgentAttachmentRef = {
  id: string;
  source: VmAgentAttachmentSource;
  name: string;
  path: string;
  size: number;
  runId?: string;
  category?: VmSessionOutputCategory;
  contentType?: string;
};

export type VmAgentMessageAttachmentKind = "file" | "image";

export type VmAgentAttachment = {
  id?: string;
  kind?: VmAgentMessageAttachmentKind | string;
  name?: string;
  size?: number;
  contentType?: string;
  source?: VmAgentAttachmentSource | string;
  path?: string;
  runId?: string;
  category?: VmSessionOutputCategory | string;
  width?: number;
  height?: number;
  thumbnailPath?: string;
};

export type VmAgentMessageAttachment = {
  id: string;
  kind: VmAgentMessageAttachmentKind;
  name: string;
  size: number;
  contentType?: string;
  source: VmAgentAttachmentSource;
  path: string;
  runId?: string;
  category?: VmSessionOutputCategory;
  width?: number;
  height?: number;
  thumbnailPath?: string;
};

export type VmAgentMessageRequest = {
  message: string;
  sessionId?: string;
  attachments?: VmAgentAttachmentRef[];
  displayAttachments?: VmAgentMessageAttachment[];
};

export type VmAgentAgentsMdResponse = {
  ok: boolean;
  path: string;
  exists: boolean;
  content: string;
  size: number;
  updatedAt?: string;
  sha256?: string;
};

export type VmAgentAgentsMdUpdateRequest = {
  content: string;
};

export type VmAgentInstructionsResponse = {
  ok: boolean;
  content: string;
  fileName: "AGENTS.md";
  path: string;
  size: number;
  maxBytes: number;
  updatedAt: string | null;
};

export const VM_SESSION_OUTPUT_CATEGORIES = ["我的输入", "仿真结果文件", "仿真日志文件", "仿真参数文件", "其它文件"] as const;

export type VmSessionOutputCategory = typeof VM_SESSION_OUTPUT_CATEGORIES[number];

export const VM_SESSION_INPUT_CATEGORY: VmSessionOutputCategory = VM_SESSION_OUTPUT_CATEGORIES[0];

export type VmSessionFileSyncStatus = {
  ok: boolean;
  category?: VmSessionOutputCategory;
  path?: string;
  size?: number;
  sha256?: string;
  deduplicated?: boolean;
  error?: string;
};

export type VmSessionOutputFile = {
  category: VmSessionOutputCategory;
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  isImage: boolean;
};

export type VmSessionFilesResponse = {
  categories: VmSessionOutputCategory[];
  files: VmSessionOutputFile[];
};

export type RunSummary = {
  id: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  title: string;
  localDir?: string;
  remoteDir?: string;
  remotePreparedAt?: string;
  lastError?: string;
  simulationSetup?: SimulationSetup;
};

export type RunDetail = {
  run: RunSummary;
  files: RunFile[];
  logs: RunFile[];
  artifacts: RunFile[];
};
