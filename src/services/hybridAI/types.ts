import { InferenceMode, InferenceSource, type SchemaRequest } from 'firebase/ai';

export { InferenceMode, InferenceSource };

export type TruthfulInferenceStatus =
  | 'ON-DEVICE'
  | 'CLOUD'
  | 'LOCAL MODEL UNAVAILABLE'
  | 'FALLBACK TO CLOUD'
  | 'FAILED';

export type LocalAvailabilityState =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable'
  | 'unsupported_browser'
  | 'mobile_unsupported';

export type LocalAvailabilityReasonCode =
  | 'ready'
  | 'downloadable'
  | 'downloading'
  | 'not_initialized'
  | 'insufficient_resources'
  | 'unavailable'
  | 'unsupported_browser'
  | 'mobile_unsupported';

export type AIExecutionStage =
  | 'preflight'
  | 'verifying_app_check'
  | 'connecting_model'
  | 'validating_output';

export type AIFailureCategory =
  | 'app_check'
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'transient_overload'
  | 'model_unsupported'
  | 'local_resources'
  | 'consent'
  | 'quota'
  | 'parse'
  | 'unknown';

export interface DeviceCapabilityReport {
  isDesktopEnvironment: boolean;
  isChromePromptApiSupported: boolean;
  localAvailability: LocalAvailabilityState;
  localReasonCode?: LocalAvailabilityReasonCode;
  localModelIdentityLabel: string;
  cloudOnline: boolean;
  appCheckActive: boolean;
  checkedAt: string;
  details: string;
}

export type AITaskKey =
  | 'hackathon_builder'
  | 'team_matching'
  | 'mentor_ideation'
  | 'mentor_roadmap'
  | 'mentor_pitch'
  | 'judge_evidence'
  | 'evidence_excerpt_summary'
  | 'evidence_criteria_classify'
  | 'user_text_fact_extract'
  | 'preliminary_summary';

export interface HybridExecutionRequest {
  taskKey: AITaskKey;
  prompt: string;
  systemInstruction?: string;
  preferredMode?: InferenceMode;
  locale?: 'en' | 'ar';
  useHeavyCloudModel?: boolean;
  expectJson?: boolean;
  responseSchema?: SchemaRequest;
  thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
  timeoutMs?: number;
  maxTransientRetries?: number;
  transientBackoffBaseMs?: number;
  disableModelFallback?: boolean;
  signal?: AbortSignal;
  onProgress?: (stage: AIExecutionStage, detail?: string) => void;
  cloudConsentGranted?: boolean;
  userId?: string;
  emailVerified?: boolean;
}

export interface HybridExecutionResult<T = string> {
  ok: boolean;
  data: T | null;
  rawText: string;
  statusIndicator: TruthfulInferenceStatus;
  sdkInferenceSource: InferenceSource | null;
  requestedMode: InferenceMode;
  effectiveSdkMode?: InferenceMode;
  modelIdentifier: string;
  requestedModelIdentifier?: string;
  fallbackModelIdentifier?: string;
  executedAt: string;
  durationMs: number;
  fallbackOccurred: boolean;
  fallbackReason?: string;
  failureCategory?: AIFailureCategory;
  failurePhase?: AIExecutionStage;
  retryAttempts?: number;
  errorMessage?: string;
}

export interface AIActivitySummary {
  totalLocalExecutions: number;
  totalCloudExecutions: number;
  totalFallbacks: number;
  failedRequests: number;
  averageResponseMs: number;
  lastInferenceStatus: TruthfulInferenceStatus | 'NONE';
  lastExecutedAt: string | null;
  recentLogs: AIExecutionLogItem[];
}

export interface AIExecutionLogItem {
  id: string;
  taskKey: AITaskKey;
  statusIndicator: TruthfulInferenceStatus;
  sdkInferenceSource?: InferenceSource | null;
  requestedMode: InferenceMode;
  modelIdentifier: string;
  durationMs: number;
  fallbackOccurred: boolean;
  fallbackReason?: string;
  failureCategory?: AIFailureCategory;
  failurePhase?: AIExecutionStage;
  errorMessage?: string;
  resultPreview?: string;
  executedAt: string;
}
