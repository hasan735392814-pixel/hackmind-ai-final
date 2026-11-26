import { InferenceMode, InferenceSource } from 'firebase/ai';
import { generateFirestoreId } from '../../utils/validation';
import { recordAIUsageInFirestore } from '../firebase/firestoreService';
import { redactSecrets } from '../github/repoInspector';
import type {
  AIActivitySummary,
  AIExecutionLogItem,
  AIExecutionStage,
  AIFailureCategory,
  AITaskKey,
  TruthfulInferenceStatus
} from './types';

const STORAGE_KEY = 'hackmind_ai_diagnostics_logs_v1';
const MAX_LOCAL_LOGS = 50;

function readStoredLogs(): AIExecutionLogItem[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AIExecutionLogItem[]) : [];
  } catch {
    return [];
  }
}

function writeStoredLogs(logs: AIExecutionLogItem[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(logs.slice(0, MAX_LOCAL_LOGS)));
  } catch {
    // Ignore storage quota errors
  }
}

const listeners = new Set<() => void>();

export function subscribeAIActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAIActivitySummary(): AIActivitySummary {
  const logs = readStoredLogs();
  let totalLocalExecutions = 0;
  let totalCloudExecutions = 0;
  let totalFallbacks = 0;
  let failedRequests = 0;
  let durationSum = 0;
  let durationCount = 0;

  for (const item of logs) {
    if (item.statusIndicator === 'ON-DEVICE') {
      totalLocalExecutions += 1;
    } else if (item.statusIndicator === 'CLOUD' || item.statusIndicator === 'FALLBACK TO CLOUD') {
      totalCloudExecutions += 1;
    } else if (
      item.statusIndicator === 'FAILED' ||
      item.statusIndicator === 'LOCAL MODEL UNAVAILABLE'
    ) {
      failedRequests += 1;
    }
    if (item.fallbackOccurred) {
      totalFallbacks += 1;
    }
    if (typeof item.durationMs === 'number' && item.durationMs >= 0) {
      durationSum += item.durationMs;
      durationCount += 1;
    }
  }

  return {
    totalLocalExecutions,
    totalCloudExecutions,
    totalFallbacks,
    failedRequests,
    averageResponseMs: durationCount > 0 ? Math.round(durationSum / durationCount) : 0,
    lastInferenceStatus: logs.length > 0 ? logs[0].statusIndicator : 'NONE',
    lastExecutedAt: logs.length > 0 ? logs[0].executedAt : null,
    recentLogs: logs
  };
}

export async function logAIExecution(params: {
  userId?: string;
  emailVerified?: boolean;
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
}): Promise<void> {
  const safePreview = params.resultPreview
    ? redactSecrets(params.resultPreview).sanitized.replace(/\s+/g, ' ').trim().slice(0, 220)
    : undefined;

  const entry: AIExecutionLogItem = {
    id: generateFirestoreId('ai'),
    taskKey: params.taskKey,
    statusIndicator: params.statusIndicator,
    sdkInferenceSource: params.sdkInferenceSource ?? null,
    requestedMode: params.requestedMode,
    modelIdentifier: params.modelIdentifier,
    durationMs: Math.round(params.durationMs),
    fallbackOccurred: params.fallbackOccurred,
    fallbackReason: params.fallbackReason,
    ...(params.failureCategory ? { failureCategory: params.failureCategory } : {}),
    ...(params.failurePhase ? { failurePhase: params.failurePhase } : {}),
    errorMessage: params.errorMessage,
    ...(safePreview ? { resultPreview: safePreview } : {}),
    executedAt: new Date().toISOString()
  };

  const existing = readStoredLogs();
  writeStoredLogs([entry, ...existing]);
  listeners.forEach((fn) => fn());

  if (params.userId && params.emailVerified) {
    try {
      await recordAIUsageInFirestore({
        id: entry.id,
        userId: params.userId,
        taskName: params.taskKey,
        inferenceSource: params.statusIndicator,
        requestedMode: params.requestedMode,
        modelId: params.modelIdentifier.slice(0, 120),
        durationMs: entry.durationMs,
        fallbackOccurred: entry.fallbackOccurred,
        status:
          params.statusIndicator === 'FAILED' ||
          params.statusIndicator === 'LOCAL MODEL UNAVAILABLE'
            ? 'failed'
            : 'success'
      });
    } catch {
      // Non-blocking telemetry persistence
    }
  }
}

export function clearLocalAILogs(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
  }
  listeners.forEach((fn) => fn());
}
