import { InferenceMode } from 'firebase/ai';
import {
  discoverGitHubRepoPlan,
  finalizeGitHubRepoInspection,
  inspectGitHubRepoBatchSlice,
  type GitHubRepoInspection,
  type InspectedRepoFile,
  type PrioritizedRepoEntry,
  type RepoInspectionPlan,
  type SkippedRepoFile
} from '../github/repoInspector';
import { executeHybridInference } from '../hybridAI/inferenceManager';
import { getConfiguredCloudModels } from '../hybridAI/firebaseAI';
import {
  buildJudgeEvidenceContext,
  buildTaskPrompt,
  JUDGE_EVIDENCE_SCHEMA
} from '../hybridAI/promptRegistry';
import type {
  AIFailureCategory,
  HybridExecutionRequest,
  HybridExecutionResult,
  TruthfulInferenceStatus
} from '../hybridAI/types';
import type { Hackathon, ProjectSubmission } from '../../types/domain';
import type {
  AuditExecutionStatus,
  BatchAnalysisProgress,
  BatchStageTracker,
  ComprehensiveJudgingReport,
  ExecutedTestRecord,
  LiveDemoCheckResult
} from './evidenceTypes';
import {
  buildComprehensiveJudgingReport,
  detectProjectStrategies,
  fetchPublicGitHubActionsRuns,
  mergeValidatedAIAuditOutputs,
  parseExecutedTestEvidence,
  validateAndNormalizeAIAuditOutput,
  verifyPublicDemoSafely,
  type StructuredAIAuditOutput
} from './evidenceVerifier';

export const AI_BATCH_MAX_FILES = 6;
export const AI_BATCH_MAX_CHARS = 16_000;
export const AI_BATCH_TIMEOUT_MS = 35_000;

const CHECKPOINT_STORAGE_PREFIX = 'hackmind_judge_batch_ckpt_v1:';

export interface PersistentBatchCheckpoint {
  version: 1;
  auditSessionId?: string;
  submissionId: string;
  repoFullName: string | null;
  commitSha: string | null;
  locale: 'en' | 'ar';
  totalBatches: number;
  completedBatches: number;
  pendingBatchIndices?: number[];
  failedBatchIndex?: number;
  lastFailureCategory?: AIFailureCategory;
  stageStatus?: BatchStageTracker;
  batchPlanPaths: string[][];
  inspectedPaths: string[];
  validatedBatchOutputs: StructuredAIAuditOutput[];
  lastStatusIndicator: TruthfulInferenceStatus | '';
  lastModelIdentifier: string;
  requestedModel?: string;
  fallbackOccurred?: boolean;
  retryAttempts?: number;
  fileProcessingStates?: {
    full: number;
    partial: number;
    skipped: number;
    inaccessible: number;
    failed: number;
  };
  lastSuccessfulMarker?: string;
  interrupted: boolean;
  lastError?: string;
  updatedAt: string;
}

interface FetchedBatchSliceCacheEntry {
  inspectedFiles: InspectedRepoFile[];
  skippedOrFailed: SkippedRepoFile[];
  totalCharsAdded: number;
  redactedSecretsCount: number;
}

interface SessionBatchMemoryState {
  submissionId: string;
  commitSha: string | null;
  locale: 'en' | 'ar';
  plan: RepoInspectionPlan;
  demoProbe: LiveDemoCheckResult;
  ciRuns: ExecutedTestRecord[];
  ciState: 'completed' | 'skipped';
  ciNote: string;
  inspectedFiles: InspectedRepoFile[];
  extraSkipped: SkippedRepoFile[];
  totalCharsUsed: number;
  redactedSecretsCount: number;
  completedBatches: number;
  batches: PrioritizedRepoEntry[][];
  fetchedBatchSlices: Map<number, FetchedBatchSliceCacheEntry>;
  validatedBatchOutputs: StructuredAIAuditOutput[];
  lastAiResult: HybridExecutionResult<StructuredAIAuditOutput> | null;
}

const sessionMemoryCheckpoints = new Map<string, SessionBatchMemoryState>();
const activeSubmissionRuns = new Map<string, Promise<RunResumableJudgeAnalysisResult>>();

function canUseLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function';
  } catch {
    return false;
  }
}

export function getSavedAnalysisCheckpoint(submissionId: string): PersistentBatchCheckpoint | null {
  if (!submissionId || !canUseLocalStorage()) return null;
  try {
    const raw = localStorage.getItem(`${CHECKPOINT_STORAGE_PREFIX}${submissionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistentBatchCheckpoint>;
    if (
      parsed.version !== 1 ||
      parsed.submissionId !== submissionId ||
      !Array.isArray(parsed.batchPlanPaths) ||
      !Array.isArray(parsed.validatedBatchOutputs) ||
      typeof parsed.completedBatches !== 'number' ||
      typeof parsed.totalBatches !== 'number'
    ) {
      return null;
    }
    return parsed as PersistentBatchCheckpoint;
  } catch {
    return null;
  }
}

function saveAnalysisCheckpoint(checkpoint: PersistentBatchCheckpoint): void {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.setItem(
      `${CHECKPOINT_STORAGE_PREFIX}${checkpoint.submissionId}`,
      JSON.stringify(checkpoint)
    );
  } catch {
    // Ignore storage quota errors
  }
}

export function clearAnalysisCheckpoint(submissionId: string): void {
  if (!submissionId) return;
  sessionMemoryCheckpoints.delete(submissionId);
  if (canUseLocalStorage()) {
    try {
      localStorage.removeItem(`${CHECKPOINT_STORAGE_PREFIX}${submissionId}`);
    } catch {
      // Ignore storage errors
    }
  }
}

export function clearAllAnalysisMemoryCaches(): void {
  sessionMemoryCheckpoints.clear();
}

export function buildBoundedRepoBatches(
  entries: PrioritizedRepoEntry[],
  options?: { maxFilesPerBatch?: number; maxEstimatedBytesPerBatch?: number }
): PrioritizedRepoEntry[][] {
  const maxFiles = Math.max(1, options?.maxFilesPerBatch ?? AI_BATCH_MAX_FILES);
  const maxBytes = Math.max(2_000, options?.maxEstimatedBytesPerBatch ?? AI_BATCH_MAX_CHARS);

  if (entries.length === 0) return [];

  const batches: PrioritizedRepoEntry[][] = [];
  let current: PrioritizedRepoEntry[] = [];
  let currentEstimatedBytes = 0;

  for (const entry of entries) {
    const entryEstBytes = Math.min(entry.entry.size || 1_200, 12_000);
    const wouldExceedCount = current.length >= maxFiles;
    const wouldExceedBytes = current.length > 0 && currentEstimatedBytes + entryEstBytes > maxBytes;
    if (wouldExceedCount || wouldExceedBytes) {
      batches.push(current);
      current = [];
      currentEstimatedBytes = 0;
    }
    current.push(entry);
    currentEstimatedBytes += entryEstBytes;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

export type BatchInferenceRunner = <T = StructuredAIAuditOutput>(
  request: HybridExecutionRequest
) => Promise<HybridExecutionResult<T>>;

export interface RunResumableJudgeAnalysisParams {
  submission: ProjectSubmission;
  hackathon: Hackathon | null | undefined;
  locale: 'en' | 'ar';
  aiMode: InferenceMode;
  cloudConsentGranted: boolean;
  userId?: string;
  emailVerified?: boolean;
  attachedTestLog?: string;
  signal?: AbortSignal;
  resumeIfAvailable?: boolean;
  batchFilesLimit?: number;
  batchCharsLimit?: number;
  batchTimeoutMs?: number;
  onProgress?: (progress: BatchAnalysisProgress) => void;
  runInferenceFn?: BatchInferenceRunner;
  explicitGeminiAuthorized?: boolean;
  collectEvidenceOnly?: boolean;
}

export interface RunResumableJudgeAnalysisResult {
  repoInspection: GitHubRepoInspection;
  liveDemoCheck: LiveDemoCheckResult;
  executedTests: ExecutedTestRecord[];
  report: ComprehensiveJudgingReport;
  aiResult: HybridExecutionResult<StructuredAIAuditOutput> | null;
  mergedAiOutput: StructuredAIAuditOutput | null;
  auditStatus: AuditExecutionStatus;
  auditStatusReason: string;
  ciCheckNote?: string;
  stageStatus: BatchStageTracker;
  interrupted: boolean;
  aborted: boolean;
  resumable: boolean;
  batchesCompleted: number;
  batchesTotal: number;
  checkpoint: PersistentBatchCheckpoint | null;
  errorMessage?: string;
}

export async function runResumableJudgeAnalysis(
  params: RunResumableJudgeAnalysisParams
): Promise<RunResumableJudgeAnalysisResult> {
  const submissionKey = params.submission?.id || '';
  if (submissionKey) {
    const existingRun = activeSubmissionRuns.get(submissionKey);
    if (existingRun) {
      return existingRun;
    }
  }

  const runPromise = executeResumableJudgeAnalysisInternal(params);
  if (submissionKey) {
    activeSubmissionRuns.set(submissionKey, runPromise);
    runPromise.finally(() => {
      if (activeSubmissionRuns.get(submissionKey) === runPromise) {
        activeSubmissionRuns.delete(submissionKey);
      }
    });
  }
  return runPromise;
}

async function executeResumableJudgeAnalysisInternal(
  params: RunResumableJudgeAnalysisParams
): Promise<RunResumableJudgeAnalysisResult> {
  const {
    submission,
    hackathon,
    locale,
    aiMode: _aiMode,
    cloudConsentGranted,
    userId,
    emailVerified,
    attachedTestLog = '',
    signal,
    resumeIfAvailable = true,
    batchFilesLimit = AI_BATCH_MAX_FILES,
    batchCharsLimit = AI_BATCH_MAX_CHARS,
    batchTimeoutMs = AI_BATCH_TIMEOUT_MS,
    onProgress,
    runInferenceFn = executeHybridInference,
    explicitGeminiAuthorized = false,
    collectEvidenceOnly = false
  } = params;

  const allowLiveGemini = !collectEvidenceOnly && explicitGeminiAuthorized === true;
  const enforcedCloudMode = InferenceMode.ONLY_IN_CLOUD;
  void _aiMode;

  const auditSessionId = `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const configuredModels = getConfiguredCloudModels();
  const initialStrategies = detectProjectStrategies(submission);

  onProgress?.({
    stage: 'discovering_repo',
    currentBatch: 0,
    totalBatches: 1,
    pendingBatches: 1,
    filesInspectedSoFar: 0,
    filesFetchedSoFar: 0,
    totalEligibleFiles: 0,
    ...(allowLiveGemini ? { selectedModel: configuredModels.heavy } : {}),
    detail: submission.githubUrl,
    stageStatus: {
      discover: 'active',
      ci: 'pending',
      audit: allowLiveGemini ? 'pending' : 'skipped',
      merge: 'pending'
    }
  });

  const existingDiskCheckpoint = getSavedAnalysisCheckpoint(submission.id);
  const savedDiskCheckpoint = resumeIfAvailable ? existingDiskCheckpoint : null;
  const preservedFreshRestartBackup = !resumeIfAvailable ? existingDiskCheckpoint : null;
  if (!resumeIfAvailable) {
    sessionMemoryCheckpoints.delete(submission.id);
  }
  const savedMem = resumeIfAvailable ? sessionMemoryCheckpoints.get(submission.id) : undefined;

  const [freshPlan, demoProbe] = await Promise.all([
    discoverGitHubRepoPlan(submission.githubUrl, {
      signal,
      strategyHints: initialStrategies,
      useCache: false
    }),
    verifyPublicDemoSafely(submission.demoUrl, { signal })
  ]);

  if (signal?.aborted || freshPlan.aborted) {
    const cancelReason = 'Cancelled during repository discovery.';
    const emptyRepo = finalizeGitHubRepoInspection(freshPlan, {
      inspectedFiles: [],
      extraSkipped: [],
      batchesProcessed: 0,
      redactedSecretsCount: 0,
      interrupted: true
    });
    const stageStatus: BatchStageTracker = {
      discover: 'interrupted',
      ci: 'skipped',
      ciNote: 'Skipped because inspection was cancelled during repository discovery.',
      audit: 'interrupted',
      merge: 'interrupted'
    };
    const report = buildComprehensiveJudgingReport({
      submission,
      hackathon,
      repoInspection: emptyRepo,
      liveDemoCheck: demoProbe,
      executedTests: parseExecutedTestEvidence(attachedTestLog, {
        expectedCommitSha: freshPlan.commitSha
      }),
      aiOutput: null,
      expectedCommitSha: freshPlan.commitSha,
      batchAnalysisState: {
        interrupted: true,
        batchesCompleted: 0,
        batchesTotal: 0,
        incompleteReason: cancelReason,
        auditStatus: 'INTERRUPTED',
        auditStatusReason: cancelReason,
        resumable: Boolean(savedDiskCheckpoint || preservedFreshRestartBackup),
        ciCheckNote: stageStatus.ciNote
      }
    });
    return {
      repoInspection: emptyRepo,
      liveDemoCheck: demoProbe,
      executedTests: report.sectionE_tests.executedTests,
      report,
      aiResult: null,
      mergedAiOutput: null,
      auditStatus: 'INTERRUPTED',
      auditStatusReason: cancelReason,
      ciCheckNote: stageStatus.ciNote,
      stageStatus,
      interrupted: true,
      aborted: true,
      resumable: Boolean(savedDiskCheckpoint || preservedFreshRestartBackup),
      batchesCompleted: 0,
      batchesTotal: 0,
      checkpoint: savedDiskCheckpoint || preservedFreshRestartBackup || null,
      errorMessage: 'Evidence inspection cancelled.'
    };
  }

  // Handle inaccessible repository cleanly without clearing unrelated valid checkpoints
  if (!freshPlan.accessible) {
    const failReason = freshPlan.reason || 'Repository could not be accessed.';
    const emptyRepo = finalizeGitHubRepoInspection(freshPlan, {
      inspectedFiles: [],
      extraSkipped: [],
      batchesProcessed: 0,
      redactedSecretsCount: 0,
      interrupted: false
    });
    const executedTests = parseExecutedTestEvidence(attachedTestLog);
    const stageStatus: BatchStageTracker = {
      discover: 'failed',
      ci: 'skipped',
      ciNote: 'Repository inaccessible — CI workflow check skipped.',
      audit: 'failed',
      merge: 'completed'
    };
    const report = buildComprehensiveJudgingReport({
      submission,
      hackathon,
      repoInspection: emptyRepo,
      liveDemoCheck: demoProbe,
      executedTests,
      aiOutput: null,
      batchAnalysisState: {
        interrupted: false,
        batchesCompleted: 0,
        batchesTotal: 0,
        incompleteReason: failReason,
        auditStatus: 'FAILED',
        auditStatusReason: failReason,
        resumable: Boolean(preservedFreshRestartBackup),
        ciCheckNote: stageStatus.ciNote
      }
    });
    return {
      repoInspection: emptyRepo,
      liveDemoCheck: demoProbe,
      executedTests,
      report,
      aiResult: null,
      mergedAiOutput: null,
      auditStatus: 'FAILED',
      auditStatusReason: failReason,
      ciCheckNote: stageStatus.ciNote,
      stageStatus,
      interrupted: false,
      aborted: false,
      resumable: Boolean(preservedFreshRestartBackup),
      batchesCompleted: 0,
      batchesTotal: 0,
      checkpoint: preservedFreshRestartBackup || null,
      errorMessage: failReason
    };
  }

  // Commit SHA verification: invalidate any checkpoint if commit SHA or locale changed
  const canResumeMemory =
    Boolean(savedMem) &&
    savedMem!.commitSha === freshPlan.commitSha &&
    savedMem!.locale === locale &&
    savedMem!.plan.repoFullName === freshPlan.repoFullName &&
    savedMem!.completedBatches < savedMem!.batches.length;

  const canResumeDisk =
    Boolean(savedDiskCheckpoint) &&
    savedDiskCheckpoint!.commitSha === freshPlan.commitSha &&
    savedDiskCheckpoint!.locale === locale &&
    savedDiskCheckpoint!.repoFullName === freshPlan.repoFullName &&
    savedDiskCheckpoint!.interrupted === true &&
    savedDiskCheckpoint!.completedBatches >= 0 &&
    savedDiskCheckpoint!.completedBatches < savedDiskCheckpoint!.totalBatches &&
    (savedDiskCheckpoint!.completedBatches > 0 || savedDiskCheckpoint!.failedBatchIndex !== undefined);

  if (savedDiskCheckpoint && !canResumeDisk) {
    clearAnalysisCheckpoint(submission.id);
  }

  const activeCiCheckNote = !freshPlan.commitSha
    ? 'Commit SHA unavailable — commit-pinned GitHub Actions check skipped.'
    : freshPlan.rateLimitRemaining !== null && freshPlan.rateLimitRemaining <= 5
      ? `GitHub API rate limit low (${freshPlan.rateLimitRemaining} remaining) — CI workflow check skipped.`
      : `Checking commit-pinned GitHub Actions for ${(freshPlan.commitSha || '').slice(0, 7)}...`;

  onProgress?.({
    stage: 'checking_ci',
    currentBatch: 0,
    totalBatches: 1,
    filesInspectedSoFar: canResumeMemory ? savedMem!.inspectedFiles.length : 0,
    filesFetchedSoFar: canResumeMemory ? savedMem!.inspectedFiles.length : 0,
    totalEligibleFiles: freshPlan.selectedEntries.length,
    detail: activeCiCheckNote,
    stageStatus: {
      discover: 'completed',
      ci: 'active',
      ciNote: activeCiCheckNote,
      audit: 'pending',
      merge: 'pending'
    }
  });

  let ciRuns: ExecutedTestRecord[] = [];
  let ciState: 'completed' | 'skipped' = 'completed';
  let ciNote = '';

  if (canResumeMemory && savedMem!.ciState) {
    ciRuns = savedMem!.ciRuns;
    ciState = savedMem!.ciState;
    ciNote = savedMem!.ciNote;
  } else if (!freshPlan.commitSha) {
    ciState = 'skipped';
    ciNote = 'Commit SHA unavailable — commit-pinned GitHub Actions check skipped.';
    ciRuns = [];
  } else if (freshPlan.rateLimitRemaining !== null && freshPlan.rateLimitRemaining <= 5) {
    ciState = 'skipped';
    ciNote = `GitHub API rate limit low (${freshPlan.rateLimitRemaining} remaining) — CI workflow check skipped.`;
    ciRuns = [];
  } else {
    ciRuns = await fetchPublicGitHubActionsRuns(submission.githubUrl, {
      signal,
      rateLimitRemaining: freshPlan.rateLimitRemaining,
      expectedCommitSha: freshPlan.commitSha,
      defaultBranch: freshPlan.defaultBranch
    });
    ciState = 'completed';
    ciNote =
      ciRuns.length > 0
        ? `Verified ${ciRuns.length} commit-pinned GitHub Actions workflow run(s).`
        : 'Checked GitHub Actions workflows (0 commit-pinned runs found).';
  }

  const parsedUserTests = parseExecutedTestEvidence(attachedTestLog, {
    expectedCommitSha: freshPlan.commitSha
  });
  const executedTests = [...parsedUserTests, ...ciRuns];

  // Build deterministic batch schedule
  const entryByPath = new Map<string, PrioritizedRepoEntry>(
    freshPlan.selectedEntries.map((e) => [e.entry.path, e])
  );

  let batches: PrioritizedRepoEntry[][];
  if (canResumeMemory && savedMem!.batches.length > 0) {
    batches = savedMem!.batches;
  } else if (canResumeDisk && savedDiskCheckpoint) {
    const reconstructed: PrioritizedRepoEntry[][] = [];
    for (const pathList of savedDiskCheckpoint.batchPlanPaths) {
      const batchEntries = pathList
        .map((p) => entryByPath.get(p))
        .filter((x): x is PrioritizedRepoEntry => Boolean(x));
      if (batchEntries.length > 0) {
        reconstructed.push(batchEntries);
      }
    }
    batches =
      reconstructed.length === savedDiskCheckpoint.totalBatches
        ? reconstructed
        : buildBoundedRepoBatches(freshPlan.selectedEntries, {
            maxFilesPerBatch: batchFilesLimit,
            maxEstimatedBytesPerBatch: batchCharsLimit
          });
  } else {
    batches = buildBoundedRepoBatches(freshPlan.selectedEntries, {
      maxFilesPerBatch: batchFilesLimit,
      maxEstimatedBytesPerBatch: batchCharsLimit
    });
  }

  const totalBatches = Math.max(1, batches.length);
  const inspectedFiles: InspectedRepoFile[] = canResumeMemory
    ? [...savedMem!.inspectedFiles]
    : [];
  const extraSkipped: SkippedRepoFile[] = canResumeMemory
    ? [...savedMem!.extraSkipped]
    : [];
  let totalCharsUsed = canResumeMemory ? savedMem!.totalCharsUsed : 0;
  let redactedSecretsCount = canResumeMemory ? savedMem!.redactedSecretsCount : 0;
  const fetchedBatchSlices = canResumeMemory
    ? new Map<number, FetchedBatchSliceCacheEntry>(savedMem!.fetchedBatchSlices)
    : new Map<number, FetchedBatchSliceCacheEntry>();
  const validatedBatchOutputs: StructuredAIAuditOutput[] = canResumeMemory
    ? [...savedMem!.validatedBatchOutputs]
    : canResumeDisk && savedDiskCheckpoint
      ? [...savedDiskCheckpoint.validatedBatchOutputs]
      : [];
  let startBatchIndex = canResumeMemory
    ? savedMem!.completedBatches
    : canResumeDisk && savedDiskCheckpoint
      ? Math.min(savedDiskCheckpoint.completedBatches, batches.length)
      : 0;
  let lastAiResult: HybridExecutionResult<StructuredAIAuditOutput> | null = canResumeMemory
    ? savedMem!.lastAiResult
    : null;

  // Cold-reload resume: hydrate already-completed batch file excerpts from GitHub without re-running Gemini on them
  if (!canResumeMemory && canResumeDisk && startBatchIndex > 0) {
    for (let i = 0; i < startBatchIndex; i++) {
      if (signal?.aborted) break;
      onProgress?.({
        stage: 'running_batch',
        currentBatch: i + 1,
        totalBatches,
        filesInspectedSoFar: inspectedFiles.length,
        filesFetchedSoFar: inspectedFiles.length,
        totalEligibleFiles: freshPlan.selectedEntries.length,
        detail: `Restoring completed batch ${i + 1}/${startBatchIndex} citations`,
        stageStatus: {
          discover: 'completed',
          ci: ciState,
          ciNote,
          audit: 'active',
          merge: 'pending'
        }
      });
      const slice = await inspectGitHubRepoBatchSlice(freshPlan, batches[i] || [], {
        signal,
        totalCharsUsedSoFar: totalCharsUsed,
        maxTotalChars: freshPlan.maxTotalChars,
        maxPerFileChars: freshPlan.maxPerFileChars
      });
      if (slice.aborted) {
        startBatchIndex = i;
        break;
      }
      fetchedBatchSlices.set(i, {
        inspectedFiles: slice.inspectedFiles,
        skippedOrFailed: slice.skippedOrFailed,
        totalCharsAdded: slice.totalCharsAdded,
        redactedSecretsCount: slice.redactedSecretsCount
      });
      inspectedFiles.push(...slice.inspectedFiles);
      extraSkipped.push(...slice.skippedOrFailed);
      totalCharsUsed += slice.totalCharsAdded;
      redactedSecretsCount += slice.redactedSecretsCount;
    }
  }

  const persistCheckpointSnapshot = (
    completedBatches: number,
    isInterrupted: boolean,
    lastError?: string,
    failedBatchIdx?: number,
    failureCategory?: AIFailureCategory,
    stageSnapshot?: BatchStageTracker,
    batchRetryAttempts?: number
  ): PersistentBatchCheckpoint => {
    const memState: SessionBatchMemoryState = {
      submissionId: submission.id,
      commitSha: freshPlan.commitSha,
      locale,
      plan: freshPlan,
      demoProbe,
      ciRuns,
      ciState,
      ciNote,
      inspectedFiles: [...inspectedFiles],
      extraSkipped: [...extraSkipped],
      totalCharsUsed,
      redactedSecretsCount,
      completedBatches,
      batches,
      fetchedBatchSlices,
      validatedBatchOutputs: [...validatedBatchOutputs],
      lastAiResult
    };
    sessionMemoryCheckpoints.set(submission.id, memState);

    const pendingBatchIndices: number[] = [];
    for (let idx = completedBatches; idx < batches.length; idx++) {
      pendingBatchIndices.push(idx);
    }

    const partialCount = inspectedFiles.filter((f) => f.truncated).length;
    const fullCount = inspectedFiles.length - partialCount + (freshPlan.readmePathInspected && !freshPlan.readmeTruncated ? 1 : 0);
    const failedFileCount = extraSkipped.filter((s) => s.reason === 'fetch_failed').length;
    const inaccFileCount = extraSkipped.filter(
      (s) => s.reason === 'inaccessible_http_error' || s.reason === 'rate_limited'
    ).length;
    const skippedFileCount = Math.max(
      0,
      freshPlan.blobEntries.length - fullCount - partialCount - failedFileCount - inaccFileCount
    );

    const ckpt: PersistentBatchCheckpoint = {
      version: 1,
      auditSessionId,
      submissionId: submission.id,
      repoFullName: freshPlan.repoFullName,
      commitSha: freshPlan.commitSha,
      locale,
      totalBatches: batches.length,
      completedBatches,
      pendingBatchIndices,
      ...(failedBatchIdx !== undefined ? { failedBatchIndex: failedBatchIdx } : {}),
      ...(failureCategory ? { lastFailureCategory: failureCategory } : {}),
      ...(stageSnapshot ? { stageStatus: stageSnapshot } : {}),
      batchPlanPaths: batches.map((b) => b.map((x) => x.entry.path)),
      inspectedPaths: inspectedFiles.map((f) => f.path),
      validatedBatchOutputs: [...validatedBatchOutputs],
      lastStatusIndicator: lastAiResult?.statusIndicator || '',
      lastModelIdentifier: lastAiResult?.modelIdentifier || '',
      requestedModel: allowLiveGemini
        ? lastAiResult?.requestedModelIdentifier || configuredModels.heavy
        : '',
      fallbackOccurred: Boolean(lastAiResult?.fallbackOccurred),
      ...(typeof (batchRetryAttempts ?? lastAiResult?.retryAttempts) === 'number'
        ? { retryAttempts: batchRetryAttempts ?? lastAiResult?.retryAttempts }
        : {}),
      fileProcessingStates: {
        full: fullCount,
        partial: partialCount,
        skipped: skippedFileCount,
        inaccessible: inaccFileCount,
        failed: failedFileCount
      },
      ...(completedBatches > 0
        ? { lastSuccessfulMarker: `batch_${completedBatches}_of_${batches.length}` }
        : {}),
      interrupted: isInterrupted,
      ...(lastError ? { lastError } : {}),
      updatedAt: new Date().toISOString()
    };
    saveAnalysisCheckpoint(ckpt);
    return ckpt;
  };

  let interrupted = false;
  let aborted = false;
  let failureErrorMessage: string | undefined;
  let failedBatchIndex: number | undefined;
  let completedBatches = startBatchIndex;

  // Edge case: repo has 0 eligible code files (README/metadata-only repo)
  if (batches.length === 0) {
    const emptyRepo = finalizeGitHubRepoInspection(freshPlan, {
      inspectedFiles: [],
      extraSkipped: [],
      batchesProcessed: 0,
      redactedSecretsCount: 0,
      interrupted: false
    });
    const finalStrategies = detectProjectStrategies(submission, emptyRepo);
    let res: HybridExecutionResult<StructuredAIAuditOutput> | null = null;
    if (allowLiveGemini) {
      if (cloudConsentGranted !== true) {
        res = {
          ok: false,
          data: null,
          rawText: '',
          statusIndicator: 'FAILED',
          sdkInferenceSource: null,
          requestedMode: enforcedCloudMode,
          modelIdentifier: configuredModels.heavy,
          requestedModelIdentifier: configuredModels.heavy,
          executedAt: new Date().toISOString(),
          durationMs: 0,
          fallbackOccurred: false,
          failureCategory: 'consent',
          errorMessage:
            locale === 'ar'
              ? 'يلزم منح موافقة الذكاء السحابي قبل إرسال الأدلة إلى Gemini 4 Hydrogen.'
              : 'Cloud AI consent is required before sending repository evidence to Gemini 4 Hydrogen.'
        };
      } else {
        const promptPayload = buildJudgeEvidenceContext({
          submission,
          githubInspection: emptyRepo,
          rubric: hackathon?.rubric || [],
          hackathon,
          detectedStrategies: finalStrategies,
          executedTests,
          liveDemoCheck: demoProbe
        });
        res = await runInferenceFn<StructuredAIAuditOutput>({
          taskKey: 'judge_evidence',
          prompt: buildTaskPrompt('judge_evidence', promptPayload, locale, { compact: true }),
          preferredMode: enforcedCloudMode,
          locale,
          useHeavyCloudModel: true,
          disableModelFallback: true,
          maxTransientRetries: 0,
          responseSchema: JUDGE_EVIDENCE_SCHEMA,
          thinkingLevel: 'LOW',
          timeoutMs: batchTimeoutMs,
          signal,
          cloudConsentGranted: true,
          userId,
          emailVerified
        });
      }
    }
    lastAiResult = res;
    const validated = res && res.ok && res.data ? validateAndNormalizeAIAuditOutput(res.data) : null;
    const isCancelled = Boolean(signal?.aborted) || res?.failureCategory === 'aborted';
    const zeroBatchStatus: AuditExecutionStatus = isCancelled
      ? 'INTERRUPTED'
      : !allowLiveGemini || res?.ok
        ? 'COMPLETED'
        : 'FAILED';
    const zeroBatchReason = !allowLiveGemini
      ? collectEvidenceOnly
        ? 'Deterministic repository metadata collected (Legacy live Gemini execution disabled; use Evidence Judging V2).'
        : 'Repository metadata collected without live Gemini inference (explicit Gemini authorization required).'
      : res?.ok
        ? 'Completed audit on repository metadata/README (0 eligible code batches).'
        : res?.errorMessage || 'AI audit failed on repository metadata.';
    const zeroBatchStages: BatchStageTracker = {
      discover: 'completed',
      ci: ciState,
      ciNote,
      audit: !allowLiveGemini
        ? 'skipped'
        : zeroBatchStatus === 'COMPLETED'
          ? 'completed'
          : isCancelled
            ? 'interrupted'
            : 'failed',
      merge: 'completed'
    };
    const report = buildComprehensiveJudgingReport({
      submission,
      hackathon,
      repoInspection: emptyRepo,
      liveDemoCheck: demoProbe,
      executedTests,
      aiOutput: validated?.valid ? validated.output : null,
      expectedCommitSha: freshPlan.commitSha,
      batchAnalysisState: {
        interrupted: zeroBatchStatus !== 'COMPLETED',
        batchesCompleted: !allowLiveGemini || res?.ok ? 1 : 0,
        batchesTotal: 1,
        incompleteReason: !allowLiveGemini || res?.ok ? undefined : zeroBatchReason,
        auditStatus: zeroBatchStatus,
        auditStatusReason: zeroBatchReason,
        resumable: false,
        ciCheckNote: ciNote
      }
    });
    clearAnalysisCheckpoint(submission.id);
    onProgress?.({
      stage: zeroBatchStatus === 'COMPLETED' ? 'completed' : 'interrupted',
      currentBatch: !allowLiveGemini || res?.ok ? 1 : 0,
      totalBatches: 1,
      filesInspectedSoFar: 0,
      filesFetchedSoFar: 0,
      totalEligibleFiles: 0,
      stageStatus: zeroBatchStages
    });
    return {
      repoInspection: emptyRepo,
      liveDemoCheck: demoProbe,
      executedTests,
      report,
      aiResult: res,
      mergedAiOutput: validated?.valid ? validated.output : null,
      auditStatus: zeroBatchStatus,
      auditStatusReason: zeroBatchReason,
      ciCheckNote: ciNote,
      stageStatus: zeroBatchStages,
      interrupted: zeroBatchStatus !== 'COMPLETED',
      aborted: isCancelled,
      resumable: false,
      batchesCompleted: !allowLiveGemini || res?.ok ? 1 : 0,
      batchesTotal: 1,
      checkpoint: null,
      ...(allowLiveGemini && res && !res.ok ? { errorMessage: zeroBatchReason } : {})
    };
  }

  for (let batchIdx = startBatchIndex; batchIdx < batches.length; batchIdx++) {
    if (signal?.aborted) {
      interrupted = true;
      aborted = true;
      failedBatchIndex = batchIdx;
      failureErrorMessage = 'Evidence inspection cancelled.';
      break;
    }

    const batchEntries = batches[batchIdx];
    const displayBatchNum = batchIdx + 1;
    const expectedBatchModel = allowLiveGemini ? configuredModels.heavy : undefined;

    const cachedSlice = fetchedBatchSlices.get(batchIdx);

    onProgress?.({
      stage: 'running_batch',
      currentBatch: displayBatchNum,
      totalBatches: batches.length,
      pendingBatches: Math.max(0, batches.length - completedBatches),
      filesInspectedSoFar: inspectedFiles.length,
      filesFetchedSoFar: inspectedFiles.length + (cachedSlice?.inspectedFiles.length || 0),
      totalEligibleFiles: freshPlan.selectedEntries.length,
      ...(expectedBatchModel ? { selectedModel: expectedBatchModel } : {}),
      detail: cachedSlice
        ? `Reusing ${cachedSlice.inspectedFiles.length} cached file(s) for batch ${displayBatchNum}/${batches.length}`
        : `Fetching batch ${displayBatchNum}/${batches.length}`,
      stageStatus: {
        discover: 'completed',
        ci: ciState,
        ciNote,
        audit: allowLiveGemini ? 'active' : 'skipped',
        merge: 'pending'
      }
    });

    let batchSlice: FetchedBatchSliceCacheEntry;
    if (cachedSlice) {
      batchSlice = cachedSlice;
    } else {
      const freshSlice = await inspectGitHubRepoBatchSlice(freshPlan, batchEntries, {
        signal,
        totalCharsUsedSoFar: totalCharsUsed,
        maxTotalChars: freshPlan.maxTotalChars,
        maxPerFileChars: freshPlan.maxPerFileChars
      });

      if (freshSlice.aborted || signal?.aborted) {
        interrupted = true;
        aborted = true;
        failedBatchIndex = batchIdx;
        failureErrorMessage = 'Evidence inspection cancelled during file download.';
        break;
      }

      batchSlice = {
        inspectedFiles: freshSlice.inspectedFiles,
        skippedOrFailed: freshSlice.skippedOrFailed,
        totalCharsAdded: freshSlice.totalCharsAdded,
        redactedSecretsCount: freshSlice.redactedSecretsCount
      };
      fetchedBatchSlices.set(batchIdx, batchSlice);
    }

    // In evidence-only / non-authorized mode, NEVER call Gemini; commit deterministic repo inspection slice cleanly.
    if (!allowLiveGemini) {
      for (const f of batchSlice.inspectedFiles) {
        if (!inspectedFiles.some((prev) => prev.path === f.path)) {
          inspectedFiles.push(f);
        }
      }
      extraSkipped.push(...batchSlice.skippedOrFailed);
      totalCharsUsed += batchSlice.totalCharsAdded;
      redactedSecretsCount += batchSlice.redactedSecretsCount;
      completedBatches = displayBatchNum;

      persistCheckpointSnapshot(
        completedBatches,
        completedBatches < batches.length,
        undefined,
        undefined,
        undefined,
        {
          discover: 'completed',
          ci: ciState,
          ciNote,
          audit: 'skipped',
          merge: 'pending'
        }
      );
      continue;
    }

    // Do NOT commit batchSlice into inspectedFiles / extraSkipped / totalCharsUsed until AI audit succeeds.
    const batchInspectedPaths = new Set(batchSlice.inspectedFiles.map((f) => f.path));
    const candidateInspectedFiles = [...inspectedFiles];
    for (const f of batchSlice.inspectedFiles) {
      if (!candidateInspectedFiles.some((prev) => prev.path === f.path)) {
        candidateInspectedFiles.push(f);
      }
    }

    onProgress?.({
      stage: 'running_batch',
      currentBatch: displayBatchNum,
      totalBatches: batches.length,
      pendingBatches: Math.max(0, batches.length - completedBatches),
      filesInspectedSoFar: inspectedFiles.length,
      filesFetchedSoFar: candidateInspectedFiles.length,
      totalEligibleFiles: freshPlan.selectedEntries.length,
      selectedModel: expectedBatchModel,
      detail: `Auditing batch ${displayBatchNum}/${batches.length} (${batchSlice.inspectedFiles.length} file(s) ready · ${expectedBatchModel})`,
      stageStatus: {
        discover: 'completed',
        ci: ciState,
        ciNote,
        audit: 'active',
        merge: 'pending'
      }
    });

    let res: HybridExecutionResult<StructuredAIAuditOutput>;
    if (cloudConsentGranted !== true) {
      res = {
        ok: false,
        data: null,
        rawText: '',
        statusIndicator: 'FAILED',
        sdkInferenceSource: null,
        requestedMode: enforcedCloudMode,
        modelIdentifier: configuredModels.heavy,
        requestedModelIdentifier: configuredModels.heavy,
        executedAt: new Date().toISOString(),
        durationMs: 0,
        fallbackOccurred: false,
        failureCategory: 'consent',
        errorMessage:
          locale === 'ar'
            ? 'يلزم منح موافقة الذكاء السحابي قبل إرسال الأدلة إلى Gemini 4 Hydrogen.'
            : 'Cloud AI consent is required before sending repository evidence to Gemini 4 Hydrogen.'
      };
    } else {
      // Build a bounded inspection snapshot containing ONLY this batch's fetched files in inspectedFiles
      // so Gemini never receives an oversized multi-batch payload.
      const batchOnlyInspection = finalizeGitHubRepoInspection(freshPlan, {
        inspectedFiles: batchSlice.inspectedFiles,
        extraSkipped: batchSlice.skippedOrFailed,
        batchesProcessed: displayBatchNum,
        redactedSecretsCount: batchSlice.redactedSecretsCount,
        interrupted: displayBatchNum < batches.length
      });

      const cumulativeStrategies = detectProjectStrategies(submission, {
        ...batchOnlyInspection,
        inspectedFiles: candidateInspectedFiles
      });

      const priorDigest = validatedBatchOutputs
        .flatMap((o) => o.verifiedEvidence || [])
        .slice(-6);

      const contextPayload = buildJudgeEvidenceContext({
        submission,
        githubInspection: {
          ...batchOnlyInspection,
          inspectedFiles: batchSlice.inspectedFiles.filter((f) => batchInspectedPaths.has(f.path))
        },
        rubric: hackathon?.rubric || [],
        hackathon,
        detectedStrategies: cumulativeStrategies,
        executedTests,
        liveDemoCheck: demoProbe,
        batchMeta: {
          batchIndex: displayBatchNum,
          totalBatches: batches.length,
          previouslyInspectedPaths: inspectedFiles.map((f) => f.path),
          priorFindingsDigest: priorDigest
        }
      });

      const prompt = buildTaskPrompt('judge_evidence', contextPayload, locale, { compact: true });

      res = await runInferenceFn<StructuredAIAuditOutput>({
        taskKey: 'judge_evidence',
        prompt,
        preferredMode: enforcedCloudMode,
        locale,
        useHeavyCloudModel: true,
        disableModelFallback: true,
        maxTransientRetries: 0,
        responseSchema: JUDGE_EVIDENCE_SCHEMA,
        thinkingLevel: 'LOW',
        timeoutMs: batchTimeoutMs,
        signal,
        onProgress: (_aiStage, aiDetail) => {
          const retryMatch = aiDetail?.match(/retry\s+(\d+)\//i);
          onProgress?.({
            stage: 'running_batch',
            currentBatch: displayBatchNum,
            totalBatches: batches.length,
            pendingBatches: Math.max(0, batches.length - completedBatches),
            filesInspectedSoFar: inspectedFiles.length,
            filesFetchedSoFar: candidateInspectedFiles.length,
            totalEligibleFiles: freshPlan.selectedEntries.length,
            selectedModel: expectedBatchModel,
            ...(retryMatch ? { retryAttempts: Number(retryMatch[1]) } : {}),
            detail: aiDetail || `Batch ${displayBatchNum}/${batches.length} (${expectedBatchModel})`,
            stageStatus: {
              discover: 'completed',
              ci: ciState,
              ciNote,
              audit: 'active',
              merge: 'pending'
            }
          });
        },
        cloudConsentGranted: true,
        userId,
        emailVerified
      });
    }

    lastAiResult = res;

    if (!res.ok) {
      interrupted = true;
      failedBatchIndex = batchIdx;
      aborted = res.failureCategory === 'aborted' || Boolean(signal?.aborted);
      failureErrorMessage =
        res.errorMessage ||
        (locale === 'ar'
          ? `توقف التدقيق في الدفعة ${displayBatchNum}/${batches.length}.`
          : `Audit paused at batch ${displayBatchNum}/${batches.length}.`);
      break;
    }

    const schemaCheck = validateAndNormalizeAIAuditOutput(res.data);
    if (!schemaCheck.valid || !schemaCheck.output) {
      interrupted = true;
      failedBatchIndex = batchIdx;
      failureErrorMessage =
        locale === 'ar'
          ? `استجابة النموذج في الدفعة ${displayBatchNum}/${batches.length} لم تطابق بنية JSON المطلوبة.`
          : `Model response in batch ${displayBatchNum}/${batches.length} failed JSON schema validation (UNVERIFIED).`;
      lastAiResult = {
        ...res,
        ok: false,
        data: null,
        statusIndicator: 'FAILED',
        failureCategory: 'parse',
        errorMessage: failureErrorMessage
      };
      break;
    }

    // Commit completed batch atomically ONLY after AI inference + JSON schema validation succeed
    for (const f of batchSlice.inspectedFiles) {
      if (!inspectedFiles.some((prev) => prev.path === f.path)) {
        inspectedFiles.push(f);
      }
    }
    extraSkipped.push(...batchSlice.skippedOrFailed);
    totalCharsUsed += batchSlice.totalCharsAdded;
    redactedSecretsCount += batchSlice.redactedSecretsCount;
    validatedBatchOutputs.push(schemaCheck.output);
    completedBatches = displayBatchNum;

    // Persist checkpoint after every completed batch so interruption or timeout loses zero finished work
    persistCheckpointSnapshot(
      completedBatches,
      completedBatches < batches.length,
      undefined,
      undefined,
      undefined,
      {
        discover: 'completed',
        ci: ciState,
        ciNote,
        audit: completedBatches < batches.length ? 'active' : 'completed',
        merge: 'pending'
      }
    );
  }

  const auditStatus: AuditExecutionStatus = aborted
    ? 'INTERRUPTED'
    : interrupted && completedBatches > 0
      ? 'PARTIAL'
      : interrupted
        ? 'FAILED'
        : 'COMPLETED';

  const auditStatusReason =
    auditStatus === 'COMPLETED'
      ? allowLiveGemini
        ? `Completed all ${batches.length}/${batches.length} batch(es) (${inspectedFiles.length} file(s) audited).`
        : collectEvidenceOnly
          ? `Deterministic repository/CI/demo evidence collected across ${batches.length}/${batches.length} batch(es) (${inspectedFiles.length} file(s); 0 Gemini calls — legacy live Gemini disabled; use Evidence Judging V2).`
          : `Repository/CI/demo evidence collected across ${batches.length}/${batches.length} batch(es) (${inspectedFiles.length} file(s); 0 Gemini calls — explicit authorization required).`
      : auditStatus === 'PARTIAL'
        ? `Partial audit: ${completedBatches}/${batches.length} batch(es) completed (${inspectedFiles.length} file(s) audited). Interrupted at batch ${(failedBatchIndex ?? completedBatches) + 1}${failureErrorMessage ? `: ${failureErrorMessage}` : '.'}`
        : auditStatus === 'INTERRUPTED'
          ? `Audit interrupted by cancellation at batch ${(failedBatchIndex ?? completedBatches) + 1}/${batches.length} (${completedBatches} batch(es) completed).`
          : failureErrorMessage ||
            `Audit failed at batch ${(failedBatchIndex ?? completedBatches) + 1}/${batches.length} before completing any batch.`;

  const finalStageStatus: BatchStageTracker = {
    discover: 'completed',
    ci: ciState,
    ciNote,
    audit:
      auditStatus === 'COMPLETED'
        ? allowLiveGemini
          ? 'completed'
          : 'skipped'
        : auditStatus === 'FAILED'
          ? 'failed'
          : 'interrupted',
    merge: 'completed'
  };

  onProgress?.({
    stage: interrupted ? 'interrupted' : 'merging_report',
    currentBatch: completedBatches,
    totalBatches: batches.length,
    filesInspectedSoFar: inspectedFiles.length,
    filesFetchedSoFar: inspectedFiles.length,
    totalEligibleFiles: freshPlan.selectedEntries.length,
    stageStatus: {
      discover: 'completed',
      ci: ciState,
      ciNote,
      audit: finalStageStatus.audit,
      merge: interrupted ? finalStageStatus.audit : 'active'
    }
  });

  const finalRepoInspection = finalizeGitHubRepoInspection(freshPlan, {
    inspectedFiles,
    extraSkipped,
    batchesProcessed: completedBatches,
    redactedSecretsCount,
    interrupted
  });

  const mergedInfo = mergeValidatedAIAuditOutputs(validatedBatchOutputs);

  const batchesPendingCount = Math.max(0, batches.length - completedBatches);
  const batchesInterruptedCount = interrupted && batchesPendingCount > 0 ? 1 : 0;
  const fetchedUniquePaths = new Set<string>();
  for (const f of inspectedFiles) fetchedUniquePaths.add(f.path);
  for (const slice of fetchedBatchSlices.values()) {
    for (const f of slice.inspectedFiles) fetchedUniquePaths.add(f.path);
  }
  const totalFetchedFilesCount = fetchedUniquePaths.size;

  const isResumable = interrupted && batches.length > 0 && completedBatches < batches.length;

  const report = buildComprehensiveJudgingReport({
    submission,
    hackathon,
    repoInspection: finalRepoInspection,
    liveDemoCheck: demoProbe,
    executedTests,
    aiOutput: mergedInfo.merged,
    expectedCommitSha: freshPlan.commitSha,
    batchAnalysisState: {
      interrupted,
      batchesCompleted: completedBatches,
      batchesPendingCount,
      batchesInterruptedCount,
      batchesTotal: batches.length,
      filesSelectedCount: freshPlan.selectedEntries.length,
      filesFetchedCount: totalFetchedFilesCount,
      incompleteReason: failureErrorMessage,
      auditStatus,
      auditStatusReason,
      resumable: isResumable,
      ciCheckNote: ciNote
    }
  });

  const isRecoverableFailure =
    completedBatches > 0 ||
    aborted ||
    lastAiResult?.failureCategory === 'transient_overload' ||
    lastAiResult?.failureCategory === 'quota' ||
    lastAiResult?.failureCategory === 'timeout' ||
    lastAiResult?.failureCategory === 'network' ||
    lastAiResult?.failureCategory === 'parse';

  const canRestorePriorCheckpointOnZeroBatchFail =
    !resumeIfAvailable &&
    completedBatches === 0 &&
    interrupted &&
    Boolean(preservedFreshRestartBackup) &&
    preservedFreshRestartBackup!.commitSha === freshPlan.commitSha &&
    preservedFreshRestartBackup!.repoFullName === freshPlan.repoFullName &&
    preservedFreshRestartBackup!.completedBatches > 0;

  let finalCheckpoint: PersistentBatchCheckpoint | null;
  if (canRestorePriorCheckpointOnZeroBatchFail && preservedFreshRestartBackup) {
    saveAnalysisCheckpoint(preservedFreshRestartBackup);
    finalCheckpoint = preservedFreshRestartBackup;
  } else if (isResumable && isRecoverableFailure) {
    finalCheckpoint = persistCheckpointSnapshot(
      completedBatches,
      true,
      failureErrorMessage,
      failedBatchIndex,
      lastAiResult?.failureCategory,
      finalStageStatus,
      lastAiResult?.retryAttempts
    );
  } else {
    clearAnalysisCheckpoint(submission.id);
    finalCheckpoint = null;
  }

  const enrichedAiResult: HybridExecutionResult<StructuredAIAuditOutput> | null = lastAiResult
    ? lastAiResult.ok && mergedInfo.merged
      ? {
          ...lastAiResult,
          data: {
            ...mergedInfo.merged,
            verifiedEvidence: report.verifiedEvidence,
            teamClaims: report.teamClaims,
            missingEvidence: report.missingEvidence,
            technicalObservations: report.technicalObservations,
            potentialRisks: report.potentialRisks,
            suggestedQuestions: report.suggestedQuestions,
            inspectedSources: report.inspectedSources,
            uninspectedSources: report.uninspectedSources
          }
        }
      : lastAiResult
    : null;

  onProgress?.({
    stage: interrupted ? 'interrupted' : 'completed',
    currentBatch: completedBatches,
    totalBatches: batches.length,
    pendingBatches: batchesPendingCount,
    filesInspectedSoFar: inspectedFiles.length,
    filesFetchedSoFar: totalFetchedFilesCount,
    totalEligibleFiles: freshPlan.selectedEntries.length,
    ...(allowLiveGemini
      ? { selectedModel: lastAiResult?.requestedModelIdentifier || configuredModels.heavy }
      : {}),
    ...(lastAiResult?.modelIdentifier ? { executedModel: lastAiResult.modelIdentifier } : {}),
    ...(lastAiResult?.fallbackModelIdentifier ? { fallbackModel: lastAiResult.fallbackModelIdentifier } : {}),
    ...(typeof lastAiResult?.retryAttempts === 'number' ? { retryAttempts: lastAiResult.retryAttempts } : {}),
    stageStatus: finalStageStatus
  });

  return {
    repoInspection: finalRepoInspection,
    liveDemoCheck: demoProbe,
    executedTests,
    report,
    aiResult: enrichedAiResult,
    mergedAiOutput: mergedInfo.merged,
    auditStatus,
    auditStatusReason,
    ciCheckNote: ciNote,
    stageStatus: finalStageStatus,
    interrupted,
    aborted,
    resumable: Boolean(finalCheckpoint),
    batchesCompleted: completedBatches,
    batchesTotal: batches.length,
    checkpoint: finalCheckpoint,
    ...(failureErrorMessage ? { errorMessage: failureErrorMessage } : {})
  };
}
