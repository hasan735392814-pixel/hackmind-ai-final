import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InferenceMode, InferenceSource } from 'firebase/ai';
import {
  buildAnalysisCacheKey,
  buildEvidenceRecordKey,
  clearAllCachedAIAnalyses,
  clearAllJudgingV2EvidenceForTests,
  getJudgingV2Checkpoint,
  reconcileCoverageReport,
  resolveEvidenceForSubmission,
  saveJudgingV2Checkpoint
} from '../../src/services/judgingV2/cacheAndCheckpoints';
import {
  ANALYSIS_VERSION,
  CRITERIA_VERSION,
  EVIDENCE_COLLECTOR_VERSION
} from '../../src/services/judgingV2/criteria';
import { collectProjectEvidence } from '../../src/services/judgingV2/evidenceCollector';
import {
  attachAIRecommendationSafely,
  createEmptyHumanEvaluation,
  finalizeAndApproveHumanEvaluation,
  loadHumanEvaluation,
  setHumanCriterionScoreV2
} from '../../src/services/judgingV2/humanEvaluationStore';
import { QuotaProtectedJudgingAnalyzer } from '../../src/services/judgingV2/quotaProtectedAnalyzer';
import type { EvidenceBundle } from '../../src/services/judgingV2/types';
import type { InspectedRepoFile, RepoInspectionPlan } from '../../src/services/github/repoInspector';
import type { ProjectSubmission } from '../../src/types/domain';

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    }
  };
}

function createSampleBundle(commitSha = 'abc123commit'): EvidenceBundle {
  return {
    bundleId: 'ev_sub_1',
    submissionId: 'sub_1',
    projectId: 'proj_1',
    collectedAt: '2026-10-01T12:00:00Z',
    sanitizedSubmission: {
      id: 'sub_1',
      hackathonId: 'hack_1',
      organizerId: 'org_1',
      teamId: 'team_1',
      teamName: 'Team Alpha',
      projectId: 'proj_1',
      ownerId: 'owner_1',
      memberIds: ['owner_1'],
      memberNames: ['Alice'],
      title: 'SolarGrid Ops',
      shortDescription: 'Microgrid balancing telemetry platform.',
      fullDescription: 'Clean React dashboard and API handlers.',
      problemStatement: 'Unplanned outages on community solar grids.',
      proposedSolution: 'Real-time inverter scheduling.',
      technologies: ['TypeScript', 'React'],
      githubUrl: 'https://github.com/example/solargrid',
      demoUrl: 'https://solargrid.example.app',
      track: 'Energy',
      status: 'submitted',
      videoExcluded: true
    },
    coverage: {
      accessible: true,
      repoFullName: 'example/solargrid',
      defaultBranch: 'main',
      commitSha,
      commitShaVerified: true,
      primaryRootPath: '.',
      hasDivergentRoots: false,
      totalTreeEntries: 4,
      uniqueSourceFiles: 3,
      inspectedFiles: 3,
      partiallyInspectedFiles: 0,
      skippedFiles: 0,
      inaccessibleFiles: 0,
      failedFiles: 0,
      readmeAndDocsCount: 1,
      completedBatches: 1,
      totalBatches: 1,
      treeTruncated: false,
      redactedSecretsCount: 0,
      note: 'Inspected 3/3 source files.'
    },
    findings: [],
    dependencies: ['react', 'express'],
    apiEndpointsDetected: [{ filePath: 'src/api.ts', lineRange: 'L10-L10', signature: 'app.get("/health")' }],
    testVerification: {
      status: 'UNVERIFIED',
      source: 'none',
      executed: false,
      passedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      discoveredTestFilesCount: 1,
      summary: 'No executed test log.',
      references: []
    },
    publicAppProbe: {
      url: 'https://solargrid.example.app',
      checkedAt: '2026-10-01T12:00:00Z',
      reachable: true,
      httpStatus: 200,
      finalUrl: 'https://solargrid.example.app',
      title: 'SolarGrid',
      requiresAuth: false,
      hasCrashBanner: false,
      reachabilityStatus: 'PARTIALLY_VERIFIED',
      functionalityStatus: 'UNVERIFIED',
      summary: 'HTTP 200 reachability only.'
    },
    workflowChecks: [],
    epistemicNotices: ['Demo videos excluded.'],
    inspectedFilesList: [
      { path: 'src/api.ts', category: 'backend_source', totalLines: 40, truncated: false, status: 'FULLY_INSPECTED' }
    ]
  };
}

function createValidFourCriteriaAIJson(scores: [number, number, number, number] = [82, 88, 79, 85]) {
  return {
    criteria: {
      innovation_originality: {
        recommendedScore: scores[0],
        confidence: 'MEDIUM',
        verifiedEvidence: ['src/api.ts:L10-L10'],
        strengths: ['Novel grid scheduler'],
        weaknesses: ['Limited baseline benchmarks'],
        missingOrUnverifiedEvidence: ['Field pilot results'],
        scoringExplanation: 'Based on inspected source architecture.'
      },
      technical_implementation: {
        recommendedScore: scores[1],
        confidence: 'MEDIUM',
        verifiedEvidence: ['package.json:L1-L10', 'src/api.ts:L10-L10'],
        strengths: ['Verified Express route handler'],
        weaknesses: ['Executed test results unverified'],
        missingOrUnverifiedEvidence: ['CI execution log'],
        scoringExplanation: '3 source files inspected; tests unverified.'
      },
      real_world_impact: {
        recommendedScore: scores[2],
        confidence: 'LOW',
        verifiedEvidence: ['Submission problemStatement'],
        strengths: ['Addresses microgrid reliability'],
        weaknesses: ['No verified deployment adoption'],
        missingOrUnverifiedEvidence: ['Production usage telemetry'],
        scoringExplanation: 'Potential impact only.'
      },
      ux_completeness: {
        recommendedScore: scores[3],
        confidence: 'MEDIUM',
        verifiedEvidence: ['Public URL HTTP 200'],
        strengths: ['App loads with HTTP 200'],
        weaknesses: ['Interactive workflows not auto-proven'],
        missingOrUnverifiedEvidence: ['Judge workflow walk-through'],
        scoringExplanation: 'Reachable public endpoint.'
      }
    },
    overallSummary: 'Advisory summary strictly from collected evidence.'
  };
}

describe('Judging V2 Integration — Quota-Safe Mode, Caching, RetryInfo, Resume & Human Authority', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    clearAllCachedAIAnalyses();
    clearAllJudgingV2EvidenceForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('enforces QUOTA-SAFE MODE by default (0 Gemini calls), honors composite cache, and invalidates cleanly on commit SHA change', async () => {
    const analyzer = new QuotaProtectedJudgingAnalyzer();
    const runner = vi.fn().mockResolvedValue({
      ok: true,
      data: createValidFourCriteriaAIJson(),
      rawText: '{}',
      modelIdentifier: 'gemini-4-hydrogen-mock',
      sdkInferenceSource: InferenceSource.IN_CLOUD,
      statusIndicator: 'CLOUD_FALLBACK',
      durationMs: 120
    });

    const bundleV1 = createSampleBundle('sha_commit_1');

    // 1. Default state blocks Gemini calls completely
    expect(analyzer.getState().quotaSafeMode).toBe(true);
    const blocked = await analyzer.analyzeWithQuotaProtection({
      bundle: bundleV1,
      explicitJudgeAction: false,
      geminiAuthorizedForRun: false,
      cloudConsentGranted: true,
      runInferenceFn: runner
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.blockedCode).toBe('QUOTA_SAFE_MODE_ACTIVE');
    expect(blocked.geminiRequestsUsed).toBe(0);
    expect(runner).not.toHaveBeenCalled();

    // 2. Judge explicitly authorizes 1 Gemini run
    analyzer.authorizeGeminiForNextRun(true);
    const run1 = await analyzer.analyzeWithQuotaProtection({
      bundle: bundleV1,
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true,
      preferredMode: InferenceMode.ONLY_IN_CLOUD,
      runInferenceFn: runner
    });
    expect(run1.ok).toBe(true);
    expect(run1.fromCache).toBe(false);
    expect(run1.geminiRequestsUsed).toBe(1);
    expect(runner).toHaveBeenCalledTimes(1);
    // Auto-reset back to QUOTA-SAFE MODE after completion
    expect(analyzer.getState().quotaSafeMode).toBe(true);
    expect(analyzer.getState().geminiAuthorizedForRun).toBe(false);

    // 3. Re-evaluating same (projectId, repoUrl, commitSha, criteriaVersion, analysisVersion) hits cache with 0 Gemini calls
    const cacheKey1 = buildAnalysisCacheKey({
      projectId: bundleV1.projectId,
      repoUrl: bundleV1.sanitizedSubmission.githubUrl,
      commitSha: 'sha_commit_1',
      criteriaVersion: CRITERIA_VERSION,
      analysisVersion: ANALYSIS_VERSION
    });
    const runCached = await analyzer.analyzeWithQuotaProtection({
      bundle: bundleV1,
      explicitJudgeAction: false,
      geminiAuthorizedForRun: false,
      cloudConsentGranted: true,
      runInferenceFn: runner
    });
    expect(runCached.ok).toBe(true);
    expect(runCached.fromCache).toBe(true);
    expect(runCached.geminiRequestsUsed).toBe(0);
    expect(runCached.recommendation?.cacheKey).toBe(cacheKey1);
    expect(runner).toHaveBeenCalledTimes(1);

    // 4. Different commit SHA misses old cache cleanly
    const bundleV2 = createSampleBundle('sha_commit_2');
    analyzer.authorizeGeminiForNextRun(true);
    const run2 = await analyzer.analyzeWithQuotaProtection({
      bundle: bundleV2,
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true,
      runInferenceFn: runner
    });
    expect(run2.ok).toBe(true);
    expect(run2.fromCache).toBe(false);
    expect(run2.geminiRequestsUsed).toBe(1);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('blocks duplicate concurrent Gemini jobs and enforces single-request mutex', async () => {
    const analyzer = new QuotaProtectedJudgingAnalyzer();
    let resolveInFlight!: (val: unknown) => void;
    const pendingRunner = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInFlight = resolve;
        })
    );

    const bundle = createSampleBundle('sha_mutex');
    analyzer.authorizeGeminiForNextRun(true);

    const firstPromise = analyzer.analyzeWithQuotaProtection({
      bundle,
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true,
      runInferenceFn: pendingRunner
    });

    // While first request is active, second attempt on same submission is blocked
    const duplicate = await analyzer.analyzeWithQuotaProtection({
      bundle,
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true,
      runInferenceFn: pendingRunner
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.blockedCode).toBe('DUPLICATE_JOB_BLOCKED');
    expect(pendingRunner).toHaveBeenCalledTimes(1);

    resolveInFlight({
      ok: true,
      data: createValidFourCriteriaAIJson(),
      rawText: '{}',
      modelIdentifier: 'gemini-4-hydrogen-mock',
      sdkInferenceSource: InferenceSource.IN_CLOUD,
      statusIndicator: 'CLOUD_FALLBACK',
      durationMs: 50
    });

    const firstResult = await firstPromise;
    expect(firstResult.ok).toBe(true);
    expect(analyzer.getState().requestInFlight).toBe(false);
  });

  it('pauses on 429 RetryInfo with 0 automatic retries and stops cleanly on daily quota or billing errors with PAUSED_QUOTA checkpoint', async () => {
    const analyzer = new QuotaProtectedJudgingAnalyzer();
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const runner = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        data: null,
        rawText: '',
        modelIdentifier: 'gemini-4-hydrogen',
        sdkInferenceSource: null,
        statusIndicator: 'FAILED',
        durationMs: 25,
        failureCategory: 'quota',
        errorMessage: '429 Too Many Requests {"retryDelay": "4s"}'
      })
      .mockResolvedValueOnce({
        ok: true,
        data: createValidFourCriteriaAIJson(),
        rawText: '{}',
        modelIdentifier: 'gemini-4-hydrogen',
        sdkInferenceSource: InferenceSource.IN_CLOUD,
        statusIndicator: 'CLOUD',
        durationMs: 40
      });

    analyzer.authorizeGeminiForNextRun(true);
    const rateLimitRes = await analyzer.analyzeWithQuotaProtection({
      bundle: createSampleBundle('sha_retry'),
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true,
      runInferenceFn: runner,
      sleepFn: sleepSpy
    });

    expect(sleepSpy).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(rateLimitRes.ok).toBe(false);
    expect(rateLimitRes.blockedCode).toBe('RATE_LIMIT_PAUSED');
    expect(rateLimitRes.retryDelayMsApplied).toBe(4000);
    expect(rateLimitRes.geminiRequestsUsed).toBe(1);
    expect(analyzer.getState().quotaSafeMode).toBe(true);
    expect(analyzer.getState().geminiAuthorizedForRun).toBe(false);
    expect(analyzer.getState().quotaStopped).toBe(false);
    expect(getJudgingV2Checkpoint('sub_1')?.status).toBe('PAUSED_QUOTA');

    // Second request runs ONLY after judge explicitly re-authorizes a new click
    analyzer.authorizeGeminiForNextRun(true);
    const manualRetryRes = await analyzer.analyzeWithQuotaProtection({
      bundle: createSampleBundle('sha_retry'),
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true,
      runInferenceFn: runner,
      sleepFn: sleepSpy
    });
    expect(manualRetryRes.ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);

    // Daily quota exhaustion stops cleanly without extra retries and saves PAUSED_QUOTA checkpoint
    const dailyExhaustRunner = vi.fn().mockResolvedValue({
      ok: false,
      data: null,
      rawText: '',
      modelIdentifier: 'gemini-4-hydrogen',
      sdkInferenceSource: null,
      statusIndicator: 'FAILED',
      durationMs: 15,
      failureCategory: 'quota',
      errorMessage: '429 RESOURCE_EXHAUSTED: exceeded your current quota / daily limit reached'
    });

    analyzer.authorizeGeminiForNextRun(true);
    const quotaStoppedRes = await analyzer.analyzeWithQuotaProtection({
      bundle: createSampleBundle('sha_daily_stop'),
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true,
      runInferenceFn: dailyExhaustRunner
    });

    expect(quotaStoppedRes.ok).toBe(false);
    expect(quotaStoppedRes.blockedCode).toBe('DAILY_QUOTA_EXHAUSTED');
    expect(dailyExhaustRunner).toHaveBeenCalledTimes(1);
    expect(analyzer.getState().quotaStopped).toBe(true);
    expect(getJudgingV2Checkpoint('sub_1')?.status).toBe('PAUSED_QUOTA');

    // Billing / 403 error also halts cleanly with BILLING_OR_ACCESS_BLOCKED
    const billingAnalyzer = new QuotaProtectedJudgingAnalyzer();
    billingAnalyzer.authorizeGeminiForNextRun(true);
    const billingRunner = vi.fn().mockResolvedValue({
      ok: false,
      data: null,
      rawText: '',
      modelIdentifier: 'gemini-4-hydrogen',
      sdkInferenceSource: null,
      statusIndicator: 'FAILED',
      durationMs: 12,
      failureCategory: 'unknown',
      errorMessage: '403 PERMISSION_DENIED: billing must be enabled'
    });
    const billingRes = await billingAnalyzer.analyzeWithQuotaProtection({
      bundle: createSampleBundle('sha_billing_stop'),
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true,
      runInferenceFn: billingRunner
    });
    expect(billingRes.ok).toBe(false);
    expect(billingRes.blockedCode).toBe('BILLING_OR_ACCESS_BLOCKED');
    expect(billingRunner).toHaveBeenCalledTimes(1);
    expect(billingAnalyzer.getState().quotaStopped).toBe(true);
  });

  it('supports interrupted batch cancellation & checkpoint resume skipping previously completed files', async () => {
    const controller = new AbortController();
    const inspectedPathsCalled: string[] = [];

    const makeFile = (p: string): InspectedRepoFile => ({
      path: p,
      category: 'frontend_source',
      sizeBytes: 50,
      charsIncluded: 50,
      totalLines: 5,
      truncated: false,
      sourceEndpoint: 'contents_api',
      redactedSecretsCount: 0,
      chunks: [{ startLine: 1, endLine: 5, content: `// ${p}\nexport const x = 1;` }],
      excerpt: ''
    });

    const entries = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'].map((p) => ({
      entry: { path: p, size: 50 },
      category: 'frontend_source' as const,
      score: 90
    }));

    const mockPlan: RepoInspectionPlan = {
      accessible: true,
      aborted: false,
      reason: 'ok',
      owner: 'org',
      repo: 'app',
      repoFullName: 'org/app',
      defaultBranch: 'main',
      commitSha: 'resume_sha_99',
      commitShaVerified: true,
      citationRef: 'resume_sha_99',
      cacheKey: 'org/app@resume_sha_99',
      description: null,
      primaryLanguage: 'TypeScript',
      stars: 0,
      updatedAt: null,
      readmeExcerpt: null,
      readmeFullChars: 0,
      readmeTruncated: false,
      readmePathInspected: null,
      readmeRedactedCount: 0,
      treeDiscoveryMethod: 'git_trees',
      treeTruncated: false,
      blobEntries: entries.map((e) => e.entry),
      selectedEntries: entries,
      initialSkipped: [],
      oversizedPaths: [],
      fileCountLimitPaths: [],
      duplicateMirrorPaths: [],
      projectRoots: [],
      hasDivergentRoots: false,
      rateLimitRemaining: 40,
      maxTotalChars: 50000,
      maxPerFileChars: 10000
    };

    const sub: ProjectSubmission = {
      id: 'sub_resume',
      hackathonId: 'hack_1',
      organizerId: 'org_1',
      teamId: 'team_1',
      teamName: 'Team Resume',
      projectId: 'proj_resume',
      ownerId: 'u1',
      memberIds: ['u1'],
      memberNames: ['Alice'],
      title: 'Resumable Repo',
      shortDescription: 'Desc',
      fullDescription: 'Full description',
      problemStatement: 'Problem',
      proposedSolution: 'Solution',
      technologies: ['TypeScript'],
      githubUrl: 'https://github.com/org/app',
      demoUrl: '',
      videoUrl: '',
      screenshotUrls: [],
      track: 'General',
      status: 'submitted'
    };

    const run1 = await collectProjectEvidence({
      submission: sub,
      batchSize: 4,
      signal: controller.signal,
      deps: {
        discoverPlanFn: vi.fn().mockResolvedValue(mockPlan),
        inspectBatchFn: vi.fn().mockImplementation(async (_plan, slice: typeof entries) => {
          const files = slice.map((s) => {
            inspectedPathsCalled.push(s.entry.path);
            return makeFile(s.entry.path);
          });
          // Abort cleanly after batch 1 completes
          controller.abort();
          return {
            inspectedFiles: files,
            skippedOrFailed: [],
            totalCharsAdded: files.length * 50,
            redactedSecretsCount: 0,
            aborted: true
          };
        }),
        fetchActionsRunsFn: vi.fn().mockResolvedValue([]),
        probeDemoFn: vi.fn().mockResolvedValue(null)
      }
    });

    expect(run1.aborted).toBe(true);
    expect(run1.bundle.coverage.completedBatches).toBe(1);
    expect(inspectedPathsCalled).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);

    // Resume from checkpoint — must ONLY inspect src/e.ts and preserve earlier 4 files
    const resumedSliceCalls: string[] = [];
    const run2 = await collectProjectEvidence({
      submission: sub,
      batchSize: 4,
      resumeInspectedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'].map(makeFile),
      resumeCompletedBatches: 1,
      resumeCommitSha: 'resume_sha_99',
      deps: {
        discoverPlanFn: vi.fn().mockResolvedValue(mockPlan),
        inspectBatchFn: vi.fn().mockImplementation(async (_plan, slice: typeof entries) => {
          const files = slice.map((s) => {
            resumedSliceCalls.push(s.entry.path);
            return makeFile(s.entry.path);
          });
          return {
            inspectedFiles: files,
            skippedOrFailed: [],
            totalCharsAdded: 50,
            redactedSecretsCount: 0,
            aborted: false
          };
        }),
        fetchActionsRunsFn: vi.fn().mockResolvedValue([]),
        probeDemoFn: vi.fn().mockResolvedValue(null)
      }
    });

    expect(run2.aborted).toBe(false);
    expect(resumedSliceCalls).toEqual(['src/e.ts']);
    expect(run2.bundle.coverage.inspectedFiles).toBe(5);
    expect(run2.bundle.coverage.completedBatches).toBe(2);
    expect(run2.bundle.coverage.totalBatches).toBe(2);
  });

  it('guarantees AI never modifies/approves human scores and enforces human judge authority & post-approval immutability', async () => {
    const analyzer = new QuotaProtectedJudgingAnalyzer();
    analyzer.authorizeGeminiForNextRun(true);
    const aiRes = await analyzer.analyzeWithQuotaProtection({
      bundle: createSampleBundle('sha_human_guard'),
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true,
      runInferenceFn: vi.fn().mockResolvedValue({
        ok: true,
        data: createValidFourCriteriaAIJson([95, 95, 95, 95]),
        rawText: '{}',
        modelIdentifier: 'gemini-4-hydrogen-mock',
        sdkInferenceSource: InferenceSource.IN_CLOUD,
        statusIndicator: 'CLOUD_FALLBACK',
        durationMs: 30
      })
    });
    expect(aiRes.ok).toBe(true);

    let evalState = createEmptyHumanEvaluation({
      submissionId: 'sub_1',
      hackathonId: 'hack_1',
      judgeId: 'judge_1',
      judgeName: 'Dr. Judge'
    });
    evalState = setHumanCriterionScoreV2(evalState, 'innovation_originality', 70, 'Solid framing');
    evalState = setHumanCriterionScoreV2(evalState, 'technical_implementation', 80, 'Verified API');

    // Attaching AI recommendation MUST NOT overwrite human scores or rationales or status
    const withAI = attachAIRecommendationSafely(evalState, aiRes.recommendation);
    expect(withAI.status).toBe('draft');
    expect(withAI.approvedAt).toBeNull();
    expect(withAI.criteria.innovation_originality.score).toBe(70);
    expect(withAI.criteria.technical_implementation.score).toBe(80);
    expect(withAI.criteria.real_world_impact.score).toBeNull();
    expect(withAI.criteria.ux_completeness.score).toBeNull();
    expect(withAI.aiRecommendationSnapshot?.advisoryWeightedScore).toBe(95);

    // Non-assigned actor cannot approve
    let complete = setHumanCriterionScoreV2(withAI, 'real_world_impact', 60, 'Potential impact');
    complete = setHumanCriterionScoreV2(complete, 'ux_completeness', 90, 'Clean UX');

    expect(() =>
      finalizeAndApproveHumanEvaluation({
        evaluation: complete,
        actorUid: 'intruder_uid',
        assignedSubmissionIds: ['sub_1']
      })
    ).toThrow(/Only the assigned human judge/);

    // Authorized judge approves official evaluation
    const approved = finalizeAndApproveHumanEvaluation({
      evaluation: complete,
      actorUid: 'judge_1',
      assignedSubmissionIds: ['sub_1']
    });
    expect(approved.status).toBe('approved');
    // 70*0.25 (17.5) + 80*0.30 (24) + 60*0.25 (15) + 90*0.20 (18) = 74.5
    expect(approved.finalWeightedScore).toBe(74.5);
    expect(loadHumanEvaluation('sub_1', 'judge_1')?.status).toBe('approved');

    // Approved evaluations are permanently locked
    expect(() => setHumanCriterionScoreV2(approved, 'innovation_originality', 100)).toThrow(
      /locked/
    );
  });

  it('prevents stale or partial checkpoints from overwriting newer complete evidence, preserves conflicts cleanly, and isolates evidence keys', () => {
    const repoUrl = 'https://github.com/hasan735392814-pixel/culturepulse-ai-source';
    const commitSha = 'bca5b1e4cec1b1aa56018477f3c0fe70e8923586';

    // Evidence keys are strictly scoped by projectId, repoUrl, defaultBranch, commitSha, criteriaVersion, and evidenceCollectorVersion
    const keyV1 = buildEvidenceRecordKey({
      projectId: 'proj_cp',
      repoUrl,
      defaultBranch: 'main',
      commitSha,
      criteriaVersion: CRITERIA_VERSION,
      evidenceCollectorVersion: 'v2.collector.1'
    });
    const keyV2 = buildEvidenceRecordKey({
      projectId: 'proj_cp',
      repoUrl,
      defaultBranch: 'main',
      commitSha,
      criteriaVersion: CRITERIA_VERSION,
      evidenceCollectorVersion: EVIDENCE_COLLECTOR_VERSION
    });
    const keyOtherSha = buildEvidenceRecordKey({
      projectId: 'proj_cp',
      repoUrl,
      defaultBranch: 'main',
      commitSha: 'different_sha_999',
      criteriaVersion: CRITERIA_VERSION,
      evidenceCollectorVersion: EVIDENCE_COLLECTOR_VERSION
    });
    expect(new Set([keyV1, keyV2, keyOtherSha]).size).toBe(3);

    // 1. Seed a legacy v2.collector.1 (22/8/42, 3/3) bundle that previously mixed 6 binary_or_asset files into skippedFilesList (48 items)
    const legacySkipped42 = Array.from({ length: 42 }, (_, idx) => ({
      path: idx < 28 ? `GITHUB_UPLOAD/src/file_${idx}.ts` : `src/uninspected_${idx}.ts`,
      reason: idx < 28 ? 'duplicate_mirror' : 'file_count_limit',
      category: 'frontend_source'
    }));
    const legacyBinary6 = Array.from({ length: 6 }, (_, idx) => ({
      path: `assets/bin_${idx}.png`,
      reason: 'binary_or_asset',
      category: 'asset'
    }));

    const legacyBundle = createSampleBundle(commitSha);
    legacyBundle.submissionId = 'sub_culturepulse';
    legacyBundle.projectId = 'proj_cp';
    legacyBundle.repoUrl = repoUrl;
    legacyBundle.sanitizedSubmission.githubUrl = repoUrl;
    legacyBundle.evidenceCollectorVersion = 'v2.collector.1';
    legacyBundle.collectedAt = '2026-11-24T10:00:00Z';
    legacyBundle.coverage = {
      ...legacyBundle.coverage,
      repoFullName: 'hasan735392814-pixel/culturepulse-ai-source',
      defaultBranch: 'main',
      commitSha,
      totalTreeEntries: 82,
      uniqueSourceFiles: 72,
      inspectedFiles: 22,
      partiallyInspectedFiles: 8,
      skippedFiles: 42,
      readmeAndDocsCount: 4,
      excludedBinaryAndLockCount: 6,
      completedBatches: 3,
      totalBatches: 3,
      skippedFilesList: [...legacySkipped42, ...legacyBinary6]
    };

    // Reconcile helper cleanly strips the 6 binary_or_asset items into excludedBinaryAndLockList
    const reconciledLegacyCov = reconcileCoverageReport(legacyBundle.coverage);
    expect(reconciledLegacyCov.skippedFiles).toBe(42);
    expect(reconciledLegacyCov.skippedFilesList).toHaveLength(42);
    expect(reconciledLegacyCov.excludedBinaryAndLockList).toHaveLength(6);

    saveJudgingV2Checkpoint({
      jobId: 'job_cp_v1',
      submissionId: 'sub_culturepulse',
      projectId: 'proj_cp',
      repoUrl,
      defaultBranch: 'main',
      commitSha,
      criteriaVersion: CRITERIA_VERSION,
      analysisVersion: ANALYSIS_VERSION,
      evidenceCollectorVersion: 'v2.collector.1',
      status: 'EVIDENCE_READY',
      completedBatches: 3,
      totalBatches: 3,
      inspectedPaths: ['src/App.tsx'],
      evidenceBundle: legacyBundle,
      aiRecommendation: null,
      lastError: null,
      quotaStopped: false,
      updatedAt: '2026-11-24T10:00:00Z'
    });

    // Legacy checkpoint alone triggers needsUpgrade = true
    const beforeUpgrade = resolveEvidenceForSubmission({
      submissionId: 'sub_culturepulse',
      projectId: 'proj_cp',
      repoUrl
    });
    expect(beforeUpgrade.activeRecord?.evidenceCollectorVersion).toBe('v2.collector.1');
    expect(beforeUpgrade.needsUpgrade).toBe(true);

    // 2. Save newer v2.collector.2 complete (36/0/36, 5/5) evidence
    const completeBundle = createSampleBundle(commitSha);
    completeBundle.submissionId = 'sub_culturepulse';
    completeBundle.projectId = 'proj_cp';
    completeBundle.repoUrl = repoUrl;
    completeBundle.sanitizedSubmission.githubUrl = repoUrl;
    completeBundle.evidenceCollectorVersion = EVIDENCE_COLLECTOR_VERSION;
    completeBundle.evidenceKey = keyV2;
    completeBundle.collectedAt = '2026-11-24T11:00:00Z';
    completeBundle.coverage = {
      ...completeBundle.coverage,
      repoFullName: 'hasan735392814-pixel/culturepulse-ai-source',
      defaultBranch: 'main',
      commitSha,
      totalTreeEntries: 82,
      uniqueSourceFiles: 72,
      inspectedFiles: 36,
      partiallyInspectedFiles: 0,
      skippedFiles: 36,
      readmeAndDocsCount: 4,
      excludedBinaryAndLockCount: 6,
      completedBatches: 5,
      totalBatches: 5,
      skippedBreakdown: {
        duplicateMirror: 28,
        unselectedMirrorConfig: 6,
        unselectedRootMetaOrConfig: 2,
        nonCodeOrUnselected: 8,
        binaryOrAsset: 6,
        fileCountLimit: 0,
        oversized: 0,
        sensitive: 0,
        budgetLimit: 0,
        batchInterrupted: 0
      },
      skippedFilesList: Array.from({ length: 36 }, (_, idx) => ({
        path: idx < 28 ? `GITHUB_UPLOAD/src/f_${idx}.ts` : idx < 34 ? `GITHUB_UPLOAD/cfg_${idx}.json` : `.cfg_${idx}`,
        reason: idx < 28 ? 'duplicate_mirror' : idx < 34 ? 'unselected_mirror_config_or_asset' : 'unselected_config_or_asset',
        category: 'frontend_source'
      })),
      excludedDocsList: Array.from({ length: 4 }, (_, idx) => ({
        path: `docs/doc_${idx}.md`,
        reason: 'non_code_documentation',
        category: 'docs'
      })),
      excludedBinaryAndLockList: legacyBinary6
    };

    const saveV2 = saveJudgingV2Checkpoint({
      jobId: 'job_cp_v2',
      submissionId: 'sub_culturepulse',
      projectId: 'proj_cp',
      repoUrl,
      defaultBranch: 'main',
      commitSha,
      criteriaVersion: CRITERIA_VERSION,
      analysisVersion: ANALYSIS_VERSION,
      evidenceCollectorVersion: EVIDENCE_COLLECTOR_VERSION,
      evidenceKey: keyV2,
      status: 'EVIDENCE_READY',
      completedBatches: 5,
      totalBatches: 5,
      inspectedPaths: ['src/App.tsx', 'src/lib/qloo-client.ts'],
      evidenceBundle: completeBundle,
      aiRecommendation: null,
      lastError: null,
      quotaStopped: false,
      updatedAt: '2026-11-24T11:00:00Z'
    });
    expect(saveV2.preservedConflict).toBe(false);

    // 3. Stale v2.collector.1 checkpoint or partial in-flight progress checkpoint MUST NOT overwrite 36/0/36
    const staleAttempt = saveJudgingV2Checkpoint({
      jobId: 'job_cp_stale',
      submissionId: 'sub_culturepulse',
      projectId: 'proj_cp',
      repoUrl,
      defaultBranch: 'main',
      commitSha,
      criteriaVersion: CRITERIA_VERSION,
      analysisVersion: ANALYSIS_VERSION,
      evidenceCollectorVersion: 'v2.collector.1',
      status: 'EVIDENCE_READY',
      completedBatches: 3,
      totalBatches: 3,
      inspectedPaths: ['src/App.tsx'],
      evidenceBundle: legacyBundle,
      aiRecommendation: null,
      lastError: null,
      quotaStopped: false,
      updatedAt: '2026-11-24T12:00:00Z'
    });
    expect(staleAttempt.preservedConflict).toBe(true);
    expect(staleAttempt.activeCheckpoint.evidenceBundle?.coverage.inspectedFiles).toBe(36);

    const partialAttempt = saveJudgingV2Checkpoint({
      jobId: 'job_cp_partial',
      submissionId: 'sub_culturepulse',
      projectId: 'proj_cp',
      repoUrl,
      defaultBranch: 'main',
      commitSha,
      criteriaVersion: CRITERIA_VERSION,
      analysisVersion: ANALYSIS_VERSION,
      evidenceCollectorVersion: EVIDENCE_COLLECTOR_VERSION,
      status: 'COLLECTING_EVIDENCE',
      completedBatches: 1,
      totalBatches: 5,
      inspectedPaths: ['src/App.tsx'],
      evidenceBundle: null,
      aiRecommendation: null,
      lastError: null,
      quotaStopped: false,
      updatedAt: '2026-11-24T12:05:00Z'
    });
    expect(partialAttempt.preservedConflict).toBe(true);
    expect(partialAttempt.activeCheckpoint.evidenceBundle?.coverage.inspectedFiles).toBe(36);

    // 4. Authoritative resolution returns 36/0/36 ACTIVE and preserves legacy 22/8/42 cleanly as SUPERSEDED
    const resolved = resolveEvidenceForSubmission({
      submissionId: 'sub_culturepulse',
      projectId: 'proj_cp',
      repoUrl
    });
    expect(resolved.needsUpgrade).toBe(false);
    expect(resolved.activeRecord?.evidenceKey).toBe(keyV2);
    expect(resolved.activeRecord?.bundle.coverage.inspectedFiles).toBe(36);
    expect(resolved.activeRecord?.bundle.coverage.partiallyInspectedFiles).toBe(0);
    expect(resolved.activeRecord?.bundle.coverage.skippedFiles).toBe(36);
    expect(resolved.activeRecord?.bundle.coverage.completedBatches).toBe(5);
    expect(resolved.activeRecord?.bundle.coverage.totalBatches).toBe(5);
    expect(resolved.preservedVersions.length).toBeGreaterThanOrEqual(1);
    const preservedLegacy = resolved.preservedVersions.find(
      (v) => v.evidenceCollectorVersion === 'v2.collector.1'
    );
    expect(preservedLegacy?.status).toBe('SUPERSEDED');
    expect(preservedLegacy?.supersededByKey).toBe(keyV2);
    expect(preservedLegacy?.bundle.coverage.skippedFilesList).toHaveLength(42);
    expect(preservedLegacy?.bundle.coverage.excludedBinaryAndLockList).toHaveLength(6);
  });
});
