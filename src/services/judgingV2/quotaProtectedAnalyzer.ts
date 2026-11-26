import { InferenceMode, InferenceSource } from 'firebase/ai';
import { executeHybridInference } from '../hybridAI/inferenceManager';
import type { HybridExecutionRequest, HybridExecutionResult } from '../hybridAI/types';
import {
  buildAnalysisCacheKey,
  getCachedAIAnalysis,
  saveCachedAIAnalysis,
  saveJudgingV2Checkpoint
} from './cacheAndCheckpoints';
import {
  ANALYSIS_VERSION,
  calculateAIWeightedPreview,
  CRITERIA_VERSION,
  OFFICIAL_CRITERION_IDS,
  OFFICIAL_JUDGING_CRITERIA
} from './criteria';
import { containsVideoJudgingReference, stripVideoUrlsFromText } from './evidenceSanitizer';
import type {
  AIJudgingRecommendation,
  ConfidenceLevel,
  CriterionAIRecommendation,
  EvidenceBundle,
  OfficialCriterionId,
  QuotaGuardState
} from './types';

export type InferenceRunnerFn = <T = unknown>(
  request: HybridExecutionRequest
) => Promise<HybridExecutionResult<T>>;

export interface AnalyzeWithQuotaProtectionParams {
  bundle: EvidenceBundle;
  explicitJudgeAction: boolean;
  geminiAuthorizedForRun: boolean;
  cloudConsentGranted: boolean;
  preferredMode?: InferenceMode;
  locale?: 'en' | 'ar';
  userId?: string;
  emailVerified?: boolean;
  signal?: AbortSignal;
  forceBypassCache?: boolean;
  runInferenceFn?: InferenceRunnerFn;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface AnalyzeWithQuotaProtectionResult {
  ok: boolean;
  recommendation: AIJudgingRecommendation | null;
  fromCache: boolean;
  geminiRequestsUsed: number;
  blockedReason?: string;
  blockedCode?:
    | 'QUOTA_SAFE_MODE_ACTIVE'
    | 'CONSENT_REQUIRED'
    | 'CONCURRENT_REQUEST_BLOCKED'
    | 'DUPLICATE_JOB_BLOCKED'
    | 'RATE_LIMIT_PAUSED'
    | 'DAILY_QUOTA_EXHAUSTED'
    | 'BILLING_OR_ACCESS_BLOCKED'
    | 'ABORTED'
    | 'INFERENCE_FAILED';
  retryDelayMsApplied?: number;
}

export function parseRetryDelayMs(rawErrorMessage: string): number | null {
  if (!rawErrorMessage) return null;
  const jsonDelay = rawErrorMessage.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (jsonDelay?.[1]) {
    return Math.min(60_000, Math.max(1_000, Math.ceil(Number(jsonDelay[1]) * 1000)));
  }
  const textDelay = rawErrorMessage.match(/(?:retry\s+(?:in|after)|please\s+retry\s+in)\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)/i);
  if (textDelay?.[1]) {
    return Math.min(60_000, Math.max(1_000, Math.ceil(Number(textDelay[1]) * 1000)));
  }
  return null;
}

export function isPermanentDailyQuotaOrBillingError(rawMsg: string): boolean {
  const lower = rawMsg.toLowerCase();
  return (
    lower.includes('daily limit') ||
    lower.includes('daily quota') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('quota_exceeded_permanently') ||
    lower.includes('insufficient_quota') ||
    lower.includes('plan limit') ||
    lower.includes('billing') ||
    lower.includes('permission_denied') ||
    lower.includes('api_not_enabled') ||
    lower.includes('api-not-enabled') ||
    lower.includes('401') ||
    lower.includes('403')
  );
}

/**
 * Builds a concise, evidence-only prompt containing strictly verified/inspected facts
 * and zero demo video data.
 */
export function buildConciseFourCriteriaPrompt(
  bundle: EvidenceBundle,
  locale: 'en' | 'ar' = 'en'
): string {
  const { sanitizedSubmission, coverage, findings, dependencies, apiEndpointsDetected, testVerification, publicAppProbe, workflowChecks } = bundle;

  const compactFindings = findings.slice(0, 18).map((f) => ({
    status: f.status,
    category: f.category,
    title: f.title,
    source: f.sourceLabel,
    ...(f.filePath ? { filePath: f.filePath } : {}),
    ...(f.lineRange ? { lineRange: f.lineRange } : {}),
    detail: f.detail.slice(0, 220)
  }));

  const payload = {
    responseLanguage: locale === 'ar' ? 'Arabic' : 'English',
    strictRules: [
      'Evaluate ONLY the 4 official criteria: innovation_originality (25%), technical_implementation (30%), real_world_impact (25%), ux_completeness (20%).',
      'Return recommendedScore (0-100) for each criterion.',
      'NEVER invent users, adoption, plagiarism checks, or passed tests not present in evidence.',
      'HTTP 200 reachability is NOT proof of full working application workflows.',
      'Demo videos are completely excluded; do not mention or penalize missing demo videos.'
    ],
    project: {
      title: sanitizedSubmission.title,
      track: sanitizedSubmission.track || 'General',
      shortDescription: sanitizedSubmission.shortDescription.slice(0, 260),
      problemStatement: sanitizedSubmission.problemStatement.slice(0, 500),
      proposedSolution: sanitizedSubmission.proposedSolution.slice(0, 500),
      declaredTechnologies: sanitizedSubmission.technologies.slice(0, 12)
    },
    repositoryCoverage: {
      repoFullName: coverage.repoFullName,
      commitSha: coverage.commitSha,
      totalTreeEntries: coverage.totalTreeEntries,
      uniqueSourceFiles: coverage.uniqueSourceFiles,
      inspectedFiles: coverage.inspectedFiles,
      partiallyInspectedFiles: coverage.partiallyInspectedFiles,
      skippedFiles: coverage.skippedFiles,
      inaccessibleFiles: coverage.inaccessibleFiles,
      failedFiles: coverage.failedFiles,
      readmeExcludedCount: coverage.readmeAndDocsCount
    },
    dependencies: dependencies.slice(0, 20),
    apiEndpointsDetected: apiEndpointsDetected.slice(0, 10),
    executedTests: {
      status: testVerification.status,
      executed: testVerification.executed,
      passedCount: testVerification.passedCount,
      failedCount: testVerification.failedCount,
      summary: testVerification.summary
    },
    publicAppProbe: {
      reachabilityStatus: publicAppProbe.reachabilityStatus,
      functionalityStatus: publicAppProbe.functionalityStatus,
      httpStatus: publicAppProbe.httpStatus,
      summary: publicAppProbe.summary
    },
    judgeObservedWorkflows: workflowChecks.map((w) => ({
      label: w.label,
      status: w.status,
      notes: w.notes
    })),
    evidenceFindings: compactFindings
  };

  return [
    'You are an evidence-based hackathon judging advisor.',
    'Return ONLY valid JSON matching:',
    '{ "criteria": { "innovation_originality": { "recommendedScore": number, "confidence": "HIGH"|"MEDIUM"|"LOW", "verifiedEvidence": string[], "strengths": string[], "weaknesses": string[], "missingOrUnverifiedEvidence": string[], "scoringExplanation": string }, "technical_implementation": {...}, "real_world_impact": {...}, "ux_completeness": {...} }, "overallSummary": string }',
    JSON.stringify(payload)
  ].join('\n\n');
}

function clampScore(val: unknown): number {
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num * 100) / 100));
}

function normalizeConfidence(val: unknown): ConfidenceLevel {
  if (val === 'HIGH' || val === 'MEDIUM' || val === 'LOW') return val;
  return 'LOW';
}

function normalizeStringList(val: unknown, max = 6): string[] {
  if (!Array.isArray(val)) return [];
  return val
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => stripVideoUrlsFromText(v.trim()).slice(0, 260))
    .slice(0, max);
}

export function validateAndNormalizeFourCriteriaAIOutput(params: {
  raw: unknown;
  cacheKey: string;
  bundle: EvidenceBundle;
  modelUsed: string;
  inferenceSource: string;
  fromCache: boolean;
  geminiRequestsUsed: number;
}): AIJudgingRecommendation | null {
  const { raw, cacheKey, bundle, modelUsed, inferenceSource, fromCache, geminiRequestsUsed } = params;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;
  const rawCriteria =
    obj.criteria && typeof obj.criteria === 'object' && !Array.isArray(obj.criteria)
      ? (obj.criteria as Record<string, unknown>)
      : obj;

  const normalizedCriteria = {} as Record<OfficialCriterionId, CriterionAIRecommendation>;

  for (const def of OFFICIAL_JUDGING_CRITERIA) {
    const entry = rawCriteria[def.id];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const cObj = entry as Record<string, unknown>;
    normalizedCriteria[def.id] = {
      criterionId: def.id,
      criterionName: def.name,
      weightPercent: def.weightPercent,
      recommendedScore: clampScore(cObj.recommendedScore ?? cObj.score),
      confidence: normalizeConfidence(cObj.confidence),
      verifiedEvidence: normalizeStringList(cObj.verifiedEvidence),
      strengths: normalizeStringList(cObj.strengths),
      weaknesses: normalizeStringList(cObj.weaknesses),
      missingOrUnverifiedEvidence: normalizeStringList(cObj.missingOrUnverifiedEvidence),
      scoringExplanation:
        typeof cObj.scoringExplanation === 'string' && cObj.scoringExplanation.trim()
          ? stripVideoUrlsFromText(cObj.scoringExplanation.trim()).slice(0, 600)
          : 'No explanation returned by model.'
    };
  }

  // Strictly reject unexpected 5th criterion if present in raw.criteria keys
  if (obj.criteria && typeof obj.criteria === 'object') {
    const allowed = new Set<string>(OFFICIAL_CRITERION_IDS);
    for (const k of Object.keys(obj.criteria as Record<string, unknown>)) {
      if (!allowed.has(k)) {
        delete (obj.criteria as Record<string, unknown>)[k];
      }
    }
  }

  return {
    recommendationId: `rec_${bundle.submissionId}_${Date.now().toString(36)}`,
    cacheKey,
    projectId: bundle.projectId,
    submissionId: bundle.submissionId,
    repoUrl: bundle.sanitizedSubmission.githubUrl,
    commitSha: bundle.coverage.commitSha || 'no_commit_sha',
    criteriaVersion: CRITERIA_VERSION,
    analysisVersion: ANALYSIS_VERSION,
    generatedAt: new Date().toISOString(),
    modelUsed,
    inferenceSource,
    fromCache,
    geminiRequestsUsed,
    advisoryOnly: true,
    criteriaRecommendations: normalizedCriteria,
    advisoryWeightedScore: calculateAIWeightedPreview(normalizedCriteria),
    overallSummary:
      typeof obj.overallSummary === 'string' && obj.overallSummary.trim()
        ? stripVideoUrlsFromText(obj.overallSummary.trim()).slice(0, 800)
        : 'Advisory AI recommendation generated from inspected project evidence.',
    disclaimers: [
      'AI recommendations are advisory only and never overwrite or approve official human judge scores.',
      'Demo videos are completely excluded from analysis.'
    ]
  };
}

export class QuotaProtectedJudgingAnalyzer {
  private state: QuotaGuardState = {
    quotaSafeMode: true,
    geminiAuthorizedForRun: false,
    requestInFlight: false,
    activeSubmissionId: null,
    requestsSentSession: 0,
    cacheHitsSession: 0,
    lastRetryDelayMs: null,
    quotaStopped: false,
    quotaStopReason: null,
    preferredInferenceMode: InferenceMode.ONLY_IN_CLOUD
  };

  getState(): QuotaGuardState {
    return { ...this.state };
  }

  setQuotaSafeMode(enabled: boolean): QuotaGuardState {
    this.state.quotaSafeMode = enabled;
    if (enabled) {
      this.state.geminiAuthorizedForRun = false;
    }
    return this.getState();
  }

  authorizeGeminiForNextRun(authorized: boolean): QuotaGuardState {
    this.state.geminiAuthorizedForRun = authorized;
    if (authorized) {
      this.state.quotaSafeMode = false;
      this.state.quotaStopped = false;
      this.state.quotaStopReason = null;
    }
    return this.getState();
  }

  /**
   * Hydrogen judge_evidence is permanently locked to ONLY_IN_CLOUD.
   */
  setPreferredInferenceMode(_mode: InferenceMode): QuotaGuardState {
    this.state.preferredInferenceMode = InferenceMode.ONLY_IN_CLOUD;
    return this.getState();
  }

  resetForTests(): void {
    this.state = {
      quotaSafeMode: true,
      geminiAuthorizedForRun: false,
      requestInFlight: false,
      activeSubmissionId: null,
      requestsSentSession: 0,
      cacheHitsSession: 0,
      lastRetryDelayMs: null,
      quotaStopped: false,
      quotaStopReason: null,
      preferredInferenceMode: InferenceMode.ONLY_IN_CLOUD
    };
  }

  async analyzeWithQuotaProtection(
    params: AnalyzeWithQuotaProtectionParams
  ): Promise<AnalyzeWithQuotaProtectionResult> {
    const {
      bundle,
      explicitJudgeAction,
      geminiAuthorizedForRun,
      cloudConsentGranted,
      locale = 'en',
      userId,
      emailVerified,
      signal,
      forceBypassCache = false,
      runInferenceFn = executeHybridInference
    } = params;

    const enforcedMode = InferenceMode.ONLY_IN_CLOUD;
    this.state.preferredInferenceMode = enforcedMode;

    const cacheKey = buildAnalysisCacheKey({
      projectId: bundle.projectId || bundle.sanitizedSubmission.id,
      repoUrl: bundle.sanitizedSubmission.githubUrl,
      commitSha: bundle.coverage.commitSha,
      criteriaVersion: CRITERIA_VERSION,
      analysisVersion: ANALYSIS_VERSION
    });

    // 1. Deterministic composite cache lookup (0 Gemini quota, never requires live authorization)
    if (!forceBypassCache) {
      const cached = getCachedAIAnalysis(cacheKey);
      if (cached) {
        this.state.cacheHitsSession += 1;
        return {
          ok: true,
          recommendation: cached,
          fromCache: true,
          geminiRequestsUsed: 0
        };
      }
    }

    // 2. Enforce Quota-Safe Mode unless human judge explicitly authorizes Gemini for this live run
    if (this.state.quotaSafeMode || !explicitJudgeAction || !geminiAuthorizedForRun) {
      return {
        ok: false,
        recommendation: null,
        fromCache: false,
        geminiRequestsUsed: 0,
        blockedCode: 'QUOTA_SAFE_MODE_ACTIVE',
        blockedReason:
          'QUOTA-SAFE MODE is active. Gemini 4 Hydrogen requests are disabled until a human judge explicitly authorizes an AI run.'
      };
    }

    if (this.state.quotaStopped) {
      this.state.geminiAuthorizedForRun = false;
      this.state.quotaSafeMode = true;
      return {
        ok: false,
        recommendation: null,
        fromCache: false,
        geminiRequestsUsed: 0,
        blockedCode: 'DAILY_QUOTA_EXHAUSTED',
        blockedReason:
          this.state.quotaStopReason ||
          'Gemini analysis halted due to daily quota or billing limits.'
      };
    }

    // 3. Enforce explicit Cloud AI consent before sending any project data to Gemini 4 Hydrogen
    if (cloudConsentGranted !== true) {
      this.state.geminiAuthorizedForRun = false;
      this.state.quotaSafeMode = true;
      return {
        ok: false,
        recommendation: null,
        fromCache: false,
        geminiRequestsUsed: 0,
        blockedCode: 'CONSENT_REQUIRED',
        blockedReason:
          'Cloud AI processing consent is required before sending evidence to Gemini 4 Hydrogen.'
      };
    }

    // 4. Enforce single concurrent Gemini request & prevent duplicate jobs
    if (this.state.requestInFlight) {
      const isDuplicateSameSubmission = this.state.activeSubmissionId === bundle.submissionId;
      return {
        ok: false,
        recommendation: null,
        fromCache: false,
        geminiRequestsUsed: 0,
        blockedCode: isDuplicateSameSubmission ? 'DUPLICATE_JOB_BLOCKED' : 'CONCURRENT_REQUEST_BLOCKED',
        blockedReason: isDuplicateSameSubmission
          ? `An analysis job for submission "${bundle.submissionId}" is already in progress.`
          : `Another Gemini request (${this.state.activeSubmissionId}) is currently active. Only one Gemini request is allowed at a time.`
      };
    }

    const prompt = buildConciseFourCriteriaPrompt(bundle, locale);
    if (containsVideoJudgingReference(prompt)) {
      this.state.geminiAuthorizedForRun = false;
      this.state.quotaSafeMode = true;
      return {
        ok: false,
        recommendation: null,
        fromCache: false,
        geminiRequestsUsed: 0,
        blockedCode: 'INFERENCE_FAILED',
        blockedReason: 'Safety invariant failed: video URL detected in sanitized judging prompt.'
      };
    }

    this.state.requestInFlight = true;
    this.state.activeSubmissionId = bundle.submissionId;

    let requestsSentThisRun = 0;

    try {
      // Strictly ONE request per explicit judge authorization — zero automatic retries, zero silent model fallback
      requestsSentThisRun += 1;
      this.state.requestsSentSession += 1;
      const result: HybridExecutionResult<unknown> = await runInferenceFn({
        taskKey: 'judge_evidence',
        prompt,
        systemInstruction:
          'Evaluate strictly on the four official criteria (25/30/25/20) using ONLY the provided evidence JSON. Never invent evidence, users, originality proofs, or passed tests.',
        preferredMode: InferenceMode.ONLY_IN_CLOUD,
        locale,
        useHeavyCloudModel: true,
        disableModelFallback: true,
        expectJson: true,
        thinkingLevel: 'LOW',
        timeoutMs: 90_000,
        maxTransientRetries: 0,
        signal,
        cloudConsentGranted: true,
        userId,
        emailVerified
      });

      if (!result.ok) {
        const errMsg = result.errorMessage || '';
        if (signal?.aborted || result.failureCategory === 'aborted') {
          return {
            ok: false,
            recommendation: null,
            fromCache: false,
            geminiRequestsUsed: requestsSentThisRun,
            blockedCode: 'ABORTED',
            blockedReason: 'Gemini analysis cancelled by judge.'
          };
        }

        if (isPermanentDailyQuotaOrBillingError(errMsg)) {
          this.state.quotaStopped = true;
          this.state.quotaStopReason = errMsg;
          saveJudgingV2Checkpoint({
            jobId: `job_${bundle.submissionId}`,
            submissionId: bundle.submissionId,
            projectId: bundle.projectId,
            repoUrl: bundle.sanitizedSubmission.githubUrl,
            commitSha: bundle.coverage.commitSha,
            criteriaVersion: CRITERIA_VERSION,
            analysisVersion: ANALYSIS_VERSION,
            evidenceCollectorVersion: bundle.evidenceCollectorVersion,
            evidenceKey: bundle.evidenceKey,
            status: 'PAUSED_QUOTA',
            completedBatches: bundle.coverage.completedBatches,
            totalBatches: bundle.coverage.totalBatches,
            inspectedPaths: bundle.inspectedFilesList.map((f) => f.path),
            evidenceBundle: bundle,
            aiRecommendation: null,
            lastError: errMsg,
            quotaStopped: true,
            updatedAt: new Date().toISOString()
          });
          return {
            ok: false,
            recommendation: null,
            fromCache: false,
            geminiRequestsUsed: requestsSentThisRun,
            blockedCode:
              errMsg.toLowerCase().includes('billing') || errMsg.toLowerCase().includes('403')
                ? 'BILLING_OR_ACCESS_BLOCKED'
                : 'DAILY_QUOTA_EXHAUSTED',
            blockedReason: errMsg
          };
        }

        // Preserve RetryInfo as diagnostic data and pause immediately without automatic retry
        if (result.failureCategory === 'quota') {
          const retryDelayMs = parseRetryDelayMs(errMsg);
          if (retryDelayMs !== null) {
            this.state.lastRetryDelayMs = retryDelayMs;
          }
          saveJudgingV2Checkpoint({
            jobId: `job_${bundle.submissionId}`,
            submissionId: bundle.submissionId,
            projectId: bundle.projectId,
            repoUrl: bundle.sanitizedSubmission.githubUrl,
            commitSha: bundle.coverage.commitSha,
            criteriaVersion: CRITERIA_VERSION,
            analysisVersion: ANALYSIS_VERSION,
            evidenceCollectorVersion: bundle.evidenceCollectorVersion,
            evidenceKey: bundle.evidenceKey,
            status: 'PAUSED_QUOTA',
            completedBatches: bundle.coverage.completedBatches,
            totalBatches: bundle.coverage.totalBatches,
            inspectedPaths: bundle.inspectedFilesList.map((f) => f.path),
            evidenceBundle: bundle,
            aiRecommendation: null,
            lastError: errMsg,
            quotaStopped: false,
            ...(retryDelayMs !== null ? { retryDelayMsApplied: retryDelayMs } : {}),
            updatedAt: new Date().toISOString()
          });
          return {
            ok: false,
            recommendation: null,
            fromCache: false,
            geminiRequestsUsed: requestsSentThisRun,
            blockedCode: 'RATE_LIMIT_PAUSED',
            blockedReason:
              retryDelayMs !== null
                ? `Gemini API rate limit reached (suggested wait ~${Math.ceil(retryDelayMs / 1000)}s). Automatic retry is disabled — re-authorize and click manually when ready.`
                : errMsg ||
                  'Gemini API rate limit reached. Automatic retry is disabled — re-authorize and click manually when ready.',
            ...(retryDelayMs !== null ? { retryDelayMsApplied: retryDelayMs } : {})
          };
        }

        return {
          ok: false,
          recommendation: null,
          fromCache: false,
          geminiRequestsUsed: requestsSentThisRun,
          blockedCode: 'INFERENCE_FAILED',
          blockedReason: errMsg || 'Gemini 4 Hydrogen inference failed without fallback.'
        };
      }

      if (!result.data) {
        return {
          ok: false,
          recommendation: null,
          fromCache: false,
          geminiRequestsUsed: requestsSentThisRun,
          blockedCode: 'INFERENCE_FAILED',
          blockedReason: 'Gemini analysis returned no valid structured output.'
        };
      }

      const normalized = validateAndNormalizeFourCriteriaAIOutput({
        raw: result.data,
        cacheKey,
        bundle,
        modelUsed: result.modelIdentifier,
        inferenceSource:
          result.sdkInferenceSource === InferenceSource.ON_DEVICE
            ? 'ON_DEVICE'
            : result.sdkInferenceSource === InferenceSource.IN_CLOUD
              ? 'IN_CLOUD'
              : result.statusIndicator,
        fromCache: false,
        geminiRequestsUsed: requestsSentThisRun
      });

      if (!normalized) {
        return {
          ok: false,
          recommendation: null,
          fromCache: false,
          geminiRequestsUsed: requestsSentThisRun,
          blockedCode: 'INFERENCE_FAILED',
          blockedReason: 'AI response did not match the strict four-criteria JSON schema.'
        };
      }

      saveCachedAIAnalysis(normalized);

      return {
        ok: true,
        recommendation: normalized,
        fromCache: false,
        geminiRequestsUsed: requestsSentThisRun
      };
    } finally {
      this.state.requestInFlight = false;
      this.state.activeSubmissionId = null;
      // Auto-reset single-run authorization back to Quota-Safe Mode after every live attempt
      this.state.geminiAuthorizedForRun = false;
      this.state.quotaSafeMode = true;
    }
  }
}

export const judgingV2Analyzer = new QuotaProtectedJudgingAnalyzer();
