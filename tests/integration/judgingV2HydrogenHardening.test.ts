import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGenerativeModel, InferenceMode, InferenceSource } from 'firebase/ai';

const { mockGenerateContent, mockVerifyAppCheckToken, mockGetAppCheckStatus } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
  mockVerifyAppCheckToken: vi.fn(),
  mockGetAppCheckStatus: vi.fn()
}));

vi.mock('firebase/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/ai')>();
  return {
    ...actual,
    getAI: vi.fn(() => ({ app: {} })),
    getGenerativeModel: vi.fn(() => ({
      generateContent: mockGenerateContent
    }))
  };
});

vi.mock('../../src/services/firebase/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/firebase/config')>();
  return {
    ...actual,
    getAppCheckStatus: mockGetAppCheckStatus,
    verifyAppCheckToken: mockVerifyAppCheckToken
  };
});

vi.mock('../../src/services/firebase/firestoreService', () => ({
  recordAIUsageInFirestore: vi.fn().mockResolvedValue(undefined)
}));

import {
  clearAllCachedAIAnalyses,
  clearAllJudgingV2EvidenceForTests,
  getJudgingV2Checkpoint
} from '../../src/services/judgingV2/cacheAndCheckpoints';
import { QuotaProtectedJudgingAnalyzer } from '../../src/services/judgingV2/quotaProtectedAnalyzer';
import type { EvidenceBundle } from '../../src/services/judgingV2/types';

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

function createSampleBundle(commitSha = 'sha_hydrogen_1'): EvidenceBundle {
  return {
    bundleId: 'ev_hydro_1',
    submissionId: 'sub_hydro_1',
    projectId: 'proj_hydro_1',
    collectedAt: '2026-11-25T10:00:00Z',
    sanitizedSubmission: {
      id: 'sub_hydro_1',
      hackathonId: 'hack_hydro',
      organizerId: 'org_1',
      teamId: 'team_1',
      teamName: 'Team Hydrogen',
      projectId: 'proj_hydro_1',
      ownerId: 'owner_1',
      memberIds: ['owner_1'],
      memberNames: ['Dana'],
      title: 'Hydrogen Guarded App',
      shortDescription: 'Evidence-grounded architecture.',
      fullDescription: 'Includes API routes and unit tests.',
      problemStatement: 'Unverified claims in judging.',
      proposedSolution: 'Deterministic evidence + 4-criteria advisory review.',
      technologies: ['TypeScript', 'React'],
      githubUrl: 'https://github.com/example/hydrogen-guarded',
      demoUrl: 'https://hydrogen-guarded.example.app',
      track: 'AI',
      status: 'submitted',
      videoExcluded: true
    },
    coverage: {
      accessible: true,
      repoFullName: 'example/hydrogen-guarded',
      defaultBranch: 'main',
      commitSha,
      commitShaVerified: true,
      primaryRootPath: '.',
      hasDivergentRoots: false,
      totalTreeEntries: 12,
      uniqueSourceFiles: 10,
      inspectedFiles: 10,
      partiallyInspectedFiles: 0,
      skippedFiles: 0,
      inaccessibleFiles: 0,
      failedFiles: 0,
      readmeAndDocsCount: 1,
      completedBatches: 1,
      totalBatches: 1,
      treeTruncated: false,
      redactedSecretsCount: 0,
      note: 'Inspected 10/10 unique source files.'
    },
    findings: [],
    dependencies: ['react', 'firebase'],
    apiEndpointsDetected: [
      { filePath: 'src/api/health.ts', lineRange: 'L1-L12', signature: 'export async function GET()' }
    ],
    testVerification: {
      status: 'UNVERIFIED',
      source: 'none',
      executed: false,
      passedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      discoveredTestFilesCount: 1,
      summary: 'Test execution log not attached.',
      references: []
    },
    publicAppProbe: {
      url: 'https://hydrogen-guarded.example.app',
      checkedAt: '2026-11-25T10:00:00Z',
      reachable: true,
      httpStatus: 200,
      finalUrl: 'https://hydrogen-guarded.example.app',
      title: 'Hydrogen Guarded App',
      requiresAuth: false,
      hasCrashBanner: false,
      reachabilityStatus: 'PARTIALLY_VERIFIED',
      functionalityStatus: 'UNVERIFIED',
      summary: 'HTTP 200 reachability confirmed.'
    },
    workflowChecks: [],
    epistemicNotices: ['Demo videos excluded.'],
    inspectedFilesList: [
      { path: 'src/api/health.ts', category: 'backend_source', totalLines: 12, truncated: false, status: 'FULLY_INSPECTED' }
    ]
  };
}

function validFourCriteriaPayload() {
  return JSON.stringify({
    criteria: {
      innovation_originality: {
        recommendedScore: 84,
        confidence: 'MEDIUM',
        verifiedEvidence: ['src/api/health.ts:L1-L12'],
        strengths: ['Clean API structure'],
        weaknesses: ['Limited benchmarks'],
        missingOrUnverifiedEvidence: ['Benchmarks'],
        scoringExplanation: 'Grounded in inspected code.'
      },
      technical_implementation: {
        recommendedScore: 86,
        confidence: 'MEDIUM',
        verifiedEvidence: ['src/api/health.ts:L1-L12'],
        strengths: ['Modular endpoints'],
        weaknesses: ['Executed test log missing'],
        missingOrUnverifiedEvidence: ['CI logs'],
        scoringExplanation: '10/10 files inspected.'
      },
      real_world_impact: {
        recommendedScore: 80,
        confidence: 'LOW',
        verifiedEvidence: ['Submission problemStatement'],
        strengths: ['Practical workflow'],
        weaknesses: ['No production adoption telemetry'],
        missingOrUnverifiedEvidence: ['Adoption metrics'],
        scoringExplanation: 'Problem framing clear.'
      },
      ux_completeness: {
        recommendedScore: 82,
        confidence: 'MEDIUM',
        verifiedEvidence: ['HTTP 200 probe'],
        strengths: ['App responds cleanly'],
        weaknesses: ['Interactive workflow unverified'],
        missingOrUnverifiedEvidence: ['Manual walkthrough'],
        scoringExplanation: 'Public URL responds HTTP 200.'
      }
    },
    overallSummary: 'Advisory four-criteria summary from inspected code only.'
  });
}

describe('Judging V2 Hydrogen Safety Hardening (Mocked End-to-End Firebase AI SDK)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', createMemoryStorage());
    vi.stubGlobal('window', { location: { hostname: 'hackmind-ai.ai.studio' } });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 15) Mobile Chrome/140.0.0.0',
      onLine: true
    });
    clearAllCachedAIAnalyses();
    clearAllJudgingV2EvidenceForTests();

    mockGetAppCheckStatus.mockReturnValue({
      initialized: true,
      provider: 'recaptcha_enterprise',
      siteKeyConfigured: true,
      siteKeySource: 'env',
      autoRefreshEnabled: true,
      debugModeEnabled: false,
      appId: '1:695233244494:web:54c11e3a797bdc6c7fc21f',
      hostname: 'hackmind-ai.ai.studio',
      lastTokenVerifiedAt: null,
      lastTokenError: null,
      reason: 'Firebase App Check active'
    });
    mockVerifyAppCheckToken.mockResolvedValue({
      ok: true,
      initialized: true,
      tokenPresent: true,
      errorCode: null,
      message: 'Valid Firebase App Check token verified.',
      hostname: 'hackmind-ai.ai.studio',
      appId: '1:695233244494:web:54c11e3a797bdc6c7fc21f',
      projectId: 'hackmind-ai',
      verifiedAt: '2026-11-25T10:00:00.000Z'
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('locks Hydrogen judging to ONLY_IN_CLOUD and passes gemini-4-hydrogen directly to getGenerativeModel', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => validFourCriteriaPayload(),
        inferenceSource: InferenceSource.IN_CLOUD
      }
    });

    const analyzer = new QuotaProtectedJudgingAnalyzer();
    // Attempt to switch mode to PREFER_ON_DEVICE must be ignored
    const lockedState = analyzer.setPreferredInferenceMode(InferenceMode.PREFER_ON_DEVICE);
    expect(lockedState.preferredInferenceMode).toBe(InferenceMode.ONLY_IN_CLOUD);

    analyzer.authorizeGeminiForNextRun(true);
    const res = await analyzer.analyzeWithQuotaProtection({
      bundle: createSampleBundle('sha_lock_1'),
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true,
      preferredMode: InferenceMode.PREFER_ON_DEVICE // must be overridden to ONLY_IN_CLOUD
    });

    expect(res.ok).toBe(true);
    expect(res.fromCache).toBe(false);
    expect(res.geminiRequestsUsed).toBe(1);
    expect(res.recommendation?.modelUsed).toBe('gemini-4-hydrogen');
    expect(res.recommendation?.inferenceSource).toBe('IN_CLOUD');
    expect(vi.mocked(getGenerativeModel)).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    const modelCallParams = vi.mocked(getGenerativeModel).mock.calls[0]?.[1] as {
      mode?: InferenceMode;
      inCloudParams?: { model?: string };
    };
    expect(modelCallParams.mode).toBe(InferenceMode.ONLY_IN_CLOUD);
    expect(modelCallParams.inCloudParams?.model).toBe('gemini-4-hydrogen');
  });

  it('prevents fallback to gemini-3.5-flash-lite on 404 NOT_FOUND or unsupported thinkingConfig (1 call max)', async () => {
    const analyzer = new QuotaProtectedJudgingAnalyzer();

    // Case 1: 404 NOT_FOUND
    mockGenerateContent.mockRejectedValueOnce(
      new Error('404 NOT_FOUND: models/gemini-4-hydrogen is not found')
    );
    analyzer.authorizeGeminiForNextRun(true);
    const notFoundRes = await analyzer.analyzeWithQuotaProtection({
      bundle: createSampleBundle('sha_404'),
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true
    });

    expect(notFoundRes.ok).toBe(false);
    expect(notFoundRes.blockedCode).toBe('INFERENCE_FAILED');
    expect(notFoundRes.geminiRequestsUsed).toBe(1);
    expect(vi.mocked(getGenerativeModel)).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(analyzer.getState().quotaSafeMode).toBe(true);
    expect(analyzer.getState().geminiAuthorizedForRun).toBe(false);

    // Case 2: unsupported thinkingConfig
    vi.clearAllMocks();
    mockGenerateContent.mockRejectedValueOnce(
      new Error('thinkingConfig is not supported for this model')
    );
    analyzer.authorizeGeminiForNextRun(true);
    const thinkingErrRes = await analyzer.analyzeWithQuotaProtection({
      bundle: createSampleBundle('sha_thinking'),
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true
    });

    expect(thinkingErrRes.ok).toBe(false);
    expect(thinkingErrRes.blockedCode).toBe('INFERENCE_FAILED');
    expect(thinkingErrRes.geminiRequestsUsed).toBe(1);
    expect(vi.mocked(getGenerativeModel)).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it('never issues a second request on Timeout, 503 transient overload, or 429 RetryInfo', async () => {
    const analyzer = new QuotaProtectedJudgingAnalyzer();

    // 1. Timeout error -> 1 request max
    mockGenerateContent.mockRejectedValueOnce(new Error('Timeout has expired.'));
    analyzer.authorizeGeminiForNextRun(true);
    const timeoutRes = await analyzer.analyzeWithQuotaProtection({
      bundle: createSampleBundle('sha_timeout'),
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true
    });
    expect(timeoutRes.ok).toBe(false);
    expect(timeoutRes.blockedCode).toBe('INFERENCE_FAILED');
    expect(timeoutRes.geminiRequestsUsed).toBe(1);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    // 2. Transient 503 overload -> 1 request max (maxTransientRetries=0 enforced)
    vi.clearAllMocks();
    mockGenerateContent.mockRejectedValueOnce(new Error('503 Service Unavailable: overloaded'));
    analyzer.authorizeGeminiForNextRun(true);
    const overloadRes = await analyzer.analyzeWithQuotaProtection({
      bundle: createSampleBundle('sha_503'),
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true
    });
    expect(overloadRes.ok).toBe(false);
    expect(overloadRes.blockedCode).toBe('INFERENCE_FAILED');
    expect(overloadRes.geminiRequestsUsed).toBe(1);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    // 3. 429 RetryInfo -> pauses immediately at 1 request max with PAUSED_QUOTA checkpoint
    vi.clearAllMocks();
    mockGenerateContent.mockRejectedValueOnce(
      new Error('429 Too Many Requests {"retryDelay": "12s"}')
    );
    analyzer.authorizeGeminiForNextRun(true);
    const retryInfoRes = await analyzer.analyzeWithQuotaProtection({
      bundle: createSampleBundle('sha_429'),
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true
    });
    expect(retryInfoRes.ok).toBe(false);
    expect(retryInfoRes.blockedCode).toBe('RATE_LIMIT_PAUSED');
    expect(retryInfoRes.retryDelayMsApplied).toBe(12_000);
    expect(retryInfoRes.geminiRequestsUsed).toBe(1);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(getJudgingV2Checkpoint('sub_hydro_1')?.status).toBe('PAUSED_QUOTA');
  });

  it('blocks live inference without cloud consent and requires explicit authorization for cache-hit forceBypassCache re-runs', async () => {
    const analyzer = new QuotaProtectedJudgingAnalyzer();
    const bundle = createSampleBundle('sha_auth_cache');

    // 1. No cloud consent -> CONSENT_REQUIRED and 0 SDK calls
    analyzer.authorizeGeminiForNextRun(true);
    const noConsentRes = await analyzer.analyzeWithQuotaProtection({
      bundle,
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: false
    });
    expect(noConsentRes.ok).toBe(false);
    expect(noConsentRes.blockedCode).toBe('CONSENT_REQUIRED');
    expect(noConsentRes.geminiRequestsUsed).toBe(0);
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(analyzer.getState().quotaSafeMode).toBe(true);

    // 2. Populate cache via authorized run
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => validFourCriteriaPayload(),
        inferenceSource: InferenceSource.IN_CLOUD
      }
    });
    analyzer.authorizeGeminiForNextRun(true);
    const liveRun = await analyzer.analyzeWithQuotaProtection({
      bundle,
      explicitJudgeAction: true,
      geminiAuthorizedForRun: true,
      cloudConsentGranted: true
    });
    expect(liveRun.ok).toBe(true);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    // 3. Cache hit load consumes 0 Gemini calls even without explicit authorization
    const cacheLoad = await analyzer.analyzeWithQuotaProtection({
      bundle,
      explicitJudgeAction: false,
      geminiAuthorizedForRun: false,
      cloudConsentGranted: false,
      forceBypassCache: false
    });
    expect(cacheLoad.ok).toBe(true);
    expect(cacheLoad.fromCache).toBe(true);
    expect(cacheLoad.geminiRequestsUsed).toBe(0);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    // 4. Bypassing cache for a fresh live run WITHOUT authorization MUST be blocked!
    const unauthorizedBypass = await analyzer.analyzeWithQuotaProtection({
      bundle,
      explicitJudgeAction: true,
      geminiAuthorizedForRun: false,
      cloudConsentGranted: true,
      forceBypassCache: true
    });
    expect(unauthorizedBypass.ok).toBe(false);
    expect(unauthorizedBypass.blockedCode).toBe('QUOTA_SAFE_MODE_ACTIVE');
    expect(unauthorizedBypass.geminiRequestsUsed).toBe(0);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });
});
