// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InferenceMode, InferenceSource } from 'firebase/ai';
import { LanguageProvider } from '../../src/contexts/LanguageContext';
import {
  buildAnalysisCacheKey,
  buildEvidenceRecordKey,
  clearAllCachedAIAnalyses,
  clearAllJudgingV2EvidenceForTests,
  saveCachedAIAnalysis,
  saveJudgingV2Checkpoint
} from '../../src/services/judgingV2/cacheAndCheckpoints';
import {
  ANALYSIS_VERSION,
  CRITERIA_VERSION,
  EVIDENCE_COLLECTOR_VERSION
} from '../../src/services/judgingV2/criteria';
import { judgingV2Analyzer } from '../../src/services/judgingV2/quotaProtectedAnalyzer';
import type { AIJudgingRecommendation, EvidenceBundle } from '../../src/services/judgingV2/types';
import type { Hackathon, JudgeAssignment, ProjectSubmission } from '../../src/types/domain';

const mockAuthValue = vi.hoisted(() => ({
  user: { uid: 'judge_1', displayName: 'Judge One', email: 'judge@hackmind.ai' },
  profile: { uid: 'judge_1', displayName: 'Judge One', approvedRole: 'judge' },
  privateInfo: { aiCloudConsent: true },
  isAdmin: false,
  emailVerified: true,
  updateCloudConsent: vi.fn()
}));

const mockFirestoreFns = vi.hoisted(() => ({
  getHackathonById: vi.fn(),
  listJudgeAssignedSubmissions: vi.fn(),
  listJudgeAssignmentsByJudge: vi.fn(),
  listJudgeEvaluations: vi.fn(),
  listOrganizerEvaluations: vi.fn(),
  listOrganizerSubmissions: vi.fn(),
  saveEvaluation: vi.fn(),
  updateJudgeAssignmentResponse: vi.fn()
}));

const mockExecuteHybridInference = vi.hoisted(() => vi.fn());

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => mockAuthValue
}));

vi.mock('../../src/services/firebase/firestoreService', () => mockFirestoreFns);

vi.mock('../../src/services/hybridAI/inferenceManager', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/services/hybridAI/inferenceManager')>();
  return {
    ...actual,
    executeHybridInference: (...args: unknown[]) => mockExecuteHybridInference(...args)
  };
});

import { EvidenceJudgingPage } from '../../src/pages/EvidenceJudgingPage';

const REPO_URL = 'https://github.com/example/guarded-v2-repo';
const COMMIT_SHA = 'deadbeef1234567890abcdef1234567890abcdef';

const hackathonFixture: Hackathon = {
  id: 'hack_v2_ui',
  organizerId: 'org_1',
  organizerName: 'Organizer',
  title: 'Hybrid AI Hack',
  tagline: 'Evidence first',
  description: 'Hackathon',
  coverImageUrl: '',
  startDate: '2026-10-01',
  endDate: '2026-10-05',
  registrationDeadline: '2026-09-30',
  submissionDeadline: '2026-10-05T23:59:59Z',
  mode: 'online',
  location: 'Remote',
  tracks: ['AI'],
  technologies: ['TypeScript', 'React'],
  eligibility: 'Open',
  rules: 'Public GitHub repo',
  prizes: [],
  sponsors: [],
  rubric: [],
  maxTeamSize: 4,
  status: 'judging',
  resultsPublished: false
};

const submissionFixture: ProjectSubmission = {
  id: 'sub_ui_v2',
  hackathonId: 'hack_v2_ui',
  organizerId: 'org_1',
  teamId: 'team_ui',
  teamName: 'Team UI',
  projectId: 'proj_ui_v2',
  ownerId: 'owner_1',
  memberIds: ['owner_1'],
  memberNames: ['Alice'],
  title: 'Guarded V2 Project',
  shortDescription: 'Hydrogen safety UI test submission.',
  fullDescription: 'Full architecture description.',
  problemStatement: 'Uncontrolled retries and fallback waste quota.',
  proposedSolution: 'Single authorized Hydrogen ONLY_IN_CLOUD request.',
  technologies: ['TypeScript', 'React'],
  githubUrl: REPO_URL,
  demoUrl: '',
  videoUrl: '',
  screenshotUrls: [],
  track: 'AI',
  status: 'submitted',
  assignedJudgeIds: ['judge_1']
};

const assignmentFixture: JudgeAssignment = {
  id: 'assign_ui_1',
  hackathonId: 'hack_v2_ui',
  organizerId: 'org_1',
  judgeId: 'judge_1',
  judgeName: 'Judge One',
  status: 'accepted',
  assignedSubmissionIds: ['sub_ui_v2'],
  conflictDeclared: false,
  conflictNotes: ''
};

function makeBundle(): EvidenceBundle {
  const evidenceKey = buildEvidenceRecordKey({
    projectId: 'proj_ui_v2',
    repoUrl: REPO_URL,
    defaultBranch: 'main',
    commitSha: COMMIT_SHA,
    criteriaVersion: CRITERIA_VERSION,
    evidenceCollectorVersion: EVIDENCE_COLLECTOR_VERSION
  });

  return {
    bundleId: 'ev_ui_1',
    evidenceKey,
    submissionId: 'sub_ui_v2',
    projectId: 'proj_ui_v2',
    repoUrl: REPO_URL,
    defaultBranch: 'main',
    commitSha: COMMIT_SHA,
    criteriaVersion: CRITERIA_VERSION,
    evidenceCollectorVersion: EVIDENCE_COLLECTOR_VERSION,
    collectedAt: '2026-11-25T10:00:00Z',
    sanitizedSubmission: {
      ...submissionFixture,
      videoExcluded: true
    },
    coverage: {
      accessible: true,
      repoFullName: 'example/guarded-v2-repo',
      defaultBranch: 'main',
      commitSha: COMMIT_SHA,
      commitShaVerified: true,
      primaryRootPath: '.',
      hasDivergentRoots: false,
      totalTreeEntries: 6,
      uniqueSourceFiles: 5,
      inspectedFiles: 5,
      partiallyInspectedFiles: 0,
      skippedFiles: 0,
      inaccessibleFiles: 0,
      failedFiles: 0,
      readmeAndDocsCount: 1,
      excludedBinaryAndLockCount: 0,
      completedBatches: 1,
      totalBatches: 1,
      treeTruncated: false,
      redactedSecretsCount: 0,
      note: 'Inspected 5/5 unique source files (5 full, 0 partial, 0 skipped) across 1/1 batches.'
    },
    findings: [],
    dependencies: ['react'],
    apiEndpointsDetected: [],
    testVerification: {
      status: 'UNVERIFIED',
      source: 'none',
      executed: false,
      passedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      discoveredTestFilesCount: 0,
      summary: 'No test log.',
      references: []
    },
    publicAppProbe: {
      url: '',
      checkedAt: '2026-11-25T10:00:00Z',
      reachable: false,
      httpStatus: null,
      finalUrl: null,
      title: null,
      requiresAuth: false,
      hasCrashBanner: false,
      reachabilityStatus: 'UNVERIFIED',
      functionalityStatus: 'UNVERIFIED',
      summary: 'No URL'
    },
    workflowChecks: [],
    epistemicNotices: ['Demo videos excluded.'],
    inspectedFilesList: [
      { path: 'src/App.tsx', category: 'frontend_source', totalLines: 50, truncated: false, status: 'FULLY_INSPECTED' }
    ]
  };
}

function makeCachedRec(cacheKey: string): AIJudgingRecommendation {
  return {
    recommendationId: 'rec_cached_ui_1',
    cacheKey,
    projectId: 'proj_ui_v2',
    submissionId: 'sub_ui_v2',
    repoUrl: REPO_URL,
    commitSha: COMMIT_SHA,
    criteriaVersion: CRITERIA_VERSION,
    analysisVersion: ANALYSIS_VERSION,
    generatedAt: '2026-11-25T10:05:00Z',
    modelUsed: 'gemini-4-hydrogen',
    inferenceSource: 'IN_CLOUD',
    fromCache: false,
    geminiRequestsUsed: 1,
    advisoryOnly: true,
    advisoryWeightedScore: 81.5,
    overallSummary: 'Cached advisory recommendation.',
    disclaimers: ['Advisory only.'],
    criteriaRecommendations: {
      innovation_originality: {
        criterionId: 'innovation_originality',
        criterionName: 'Innovation & Originality',
        weightPercent: 25,
        recommendedScore: 80,
        confidence: 'MEDIUM',
        verifiedEvidence: ['src/App.tsx'],
        strengths: ['Clear structure'],
        weaknesses: ['Limited baseline'],
        missingOrUnverifiedEvidence: ['Comparison'],
        scoringExplanation: 'Cached explanation 1'
      },
      technical_implementation: {
        criterionId: 'technical_implementation',
        criterionName: 'Technical Implementation',
        weightPercent: 30,
        recommendedScore: 85,
        confidence: 'MEDIUM',
        verifiedEvidence: ['src/App.tsx'],
        strengths: ['Typed React code'],
        weaknesses: ['No test log'],
        missingOrUnverifiedEvidence: ['CI log'],
        scoringExplanation: 'Cached explanation 2'
      },
      real_world_impact: {
        criterionId: 'real_world_impact',
        criterionName: 'Real-World Impact',
        weightPercent: 25,
        recommendedScore: 78,
        confidence: 'LOW',
        verifiedEvidence: ['Submission statement'],
        strengths: ['Practical goal'],
        weaknesses: ['Unproven adoption'],
        missingOrUnverifiedEvidence: ['Pilot users'],
        scoringExplanation: 'Cached explanation 3'
      },
      ux_completeness: {
        criterionId: 'ux_completeness',
        criterionName: 'User Experience & Completeness',
        weightPercent: 20,
        recommendedScore: 82,
        confidence: 'MEDIUM',
        verifiedEvidence: ['src/App.tsx'],
        strengths: ['Clean UI'],
        weaknesses: ['No live URL'],
        missingOrUnverifiedEvidence: ['Walkthrough'],
        scoringExplanation: 'Cached explanation 4'
      }
    }
  };
}

describe('Judging V2 UI — Locked ONLY_IN_CLOUD Mode & Explicit Live Authorization Gate', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('hackmind_locale', 'en');
    clearAllCachedAIAnalyses();
    clearAllJudgingV2EvidenceForTests();
    judgingV2Analyzer.resetForTests();
    mockExecuteHybridInference.mockReset();

    mockAuthValue.privateInfo = { aiCloudConsent: true };
    mockFirestoreFns.listJudgeAssignedSubmissions.mockResolvedValue([submissionFixture]);
    mockFirestoreFns.listJudgeAssignmentsByJudge.mockResolvedValue([assignmentFixture]);
    mockFirestoreFns.listJudgeEvaluations.mockResolvedValue([]);
    mockFirestoreFns.listOrganizerEvaluations.mockResolvedValue([]);
    mockFirestoreFns.listOrganizerSubmissions.mockResolvedValue([]);
    mockFirestoreFns.getHackathonById.mockResolvedValue(hackathonFixture);
    mockFirestoreFns.saveEvaluation.mockResolvedValue(undefined);
    mockFirestoreFns.updateJudgeAssignmentResponse.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('locks InferenceModeSelector to ONLY_IN_CLOUD, loads cached recommendation with 0 Gemini calls, and requires explicit authorization for Run New Gemini Analysis', async () => {
    const bundle = makeBundle();
    const cacheKey = buildAnalysisCacheKey({
      projectId: 'proj_ui_v2',
      repoUrl: REPO_URL,
      commitSha: COMMIT_SHA,
      criteriaVersion: CRITERIA_VERSION,
      analysisVersion: ANALYSIS_VERSION
    });
    saveJudgingV2Checkpoint({
      jobId: 'job_ui_v2',
      submissionId: 'sub_ui_v2',
      projectId: 'proj_ui_v2',
      repoUrl: REPO_URL,
      defaultBranch: 'main',
      commitSha: COMMIT_SHA,
      criteriaVersion: CRITERIA_VERSION,
      analysisVersion: ANALYSIS_VERSION,
      evidenceCollectorVersion: EVIDENCE_COLLECTOR_VERSION,
      evidenceKey: bundle.evidenceKey,
      status: 'EVIDENCE_READY',
      completedBatches: 1,
      totalBatches: 1,
      inspectedPaths: ['src/App.tsx'],
      evidenceBundle: bundle,
      aiRecommendation: null,
      lastError: null,
      quotaStopped: false,
      updatedAt: '2026-11-25T10:00:00Z'
    });
    saveCachedAIAnalysis(makeCachedRec(cacheKey));

    render(
      <MemoryRouter>
        <LanguageProvider>
          <EvidenceJudgingPage />
        </LanguageProvider>
      </MemoryRouter>
    );

    await screen.findByText('Repository Coverage & Verifiable Evidence');
    await waitFor(() => {
      expect(screen.getByText(/Locked to ONLY_IN_CLOUD for Gemini 4 Hydrogen/i)).toBeTruthy();
    });

    // 1. Verify alternate InferenceMode buttons in QuotaAndJobControlBar are disabled while ONLY_IN_CLOUD is active
    const quotaSection = screen
      .getByText('Evidence Pipeline & Gemini 4 Hydrogen Quota Guard')
      .closest('section')!;
    const preferLocalBtn = within(quotaSection).getByRole('button', {
      name: 'Prefer On-Device'
    }) as HTMLButtonElement;
    const preferCloudBtn = within(quotaSection).getByRole('button', {
      name: 'Prefer In-Cloud'
    }) as HTMLButtonElement;
    const onlyLocalBtn = within(quotaSection).getByRole('button', {
      name: 'Only On-Device'
    }) as HTMLButtonElement;
    const onlyCloudBtn = within(quotaSection).getByRole('button', {
      name: 'Only In-Cloud'
    }) as HTMLButtonElement;

    expect(preferLocalBtn.disabled).toBe(true);
    expect(preferCloudBtn.disabled).toBe(true);
    expect(onlyLocalBtn.disabled).toBe(true);
    expect(onlyCloudBtn.disabled).toBe(false);

    // 2. Cache hit does NOT bypass explicit authorization for Run New Gemini Analysis
    const runNewBtn = screen.getByRole('button', { name: 'Run New Gemini Analysis' }) as HTMLButtonElement;
    const loadCacheBtn = screen.getByRole('button', { name: 'Load Cached Recommendation' }) as HTMLButtonElement;
    const authCheckbox = screen.getByRole('checkbox', {
      name: /Explicitly authorize a single Gemini 4 Hydrogen request/i
    }) as HTMLInputElement;

    expect(authCheckbox.checked).toBe(false);
    expect(runNewBtn.disabled).toBe(true);
    expect(loadCacheBtn.disabled).toBe(false);

    // Clicking Load Cached Recommendation uses 0 Gemini calls
    fireEvent.click(loadCacheBtn);
    await waitFor(() => {
      expect(
        screen.getByText(/Loaded Gemini advisory recommendation from cache \(0 Gemini API requests used\)/i)
      ).toBeTruthy();
    });
    expect(mockExecuteHybridInference).not.toHaveBeenCalled();

    // 3. Authorizing live run enables Run New Gemini Analysis and sends exactly ONE ONLY_IN_CLOUD Hydrogen request
    mockExecuteHybridInference.mockResolvedValueOnce({
      ok: true,
      data: {
        criteria: {
          innovation_originality: { recommendedScore: 90, confidence: 'HIGH', verifiedEvidence: [], strengths: [], weaknesses: [], missingOrUnverifiedEvidence: [], scoringExplanation: 'Fresh 1' },
          technical_implementation: { recommendedScore: 92, confidence: 'HIGH', verifiedEvidence: [], strengths: [], weaknesses: [], missingOrUnverifiedEvidence: [], scoringExplanation: 'Fresh 2' },
          real_world_impact: { recommendedScore: 88, confidence: 'MEDIUM', verifiedEvidence: [], strengths: [], weaknesses: [], missingOrUnverifiedEvidence: [], scoringExplanation: 'Fresh 3' },
          ux_completeness: { recommendedScore: 89, confidence: 'MEDIUM', verifiedEvidence: [], strengths: [], weaknesses: [], missingOrUnverifiedEvidence: [], scoringExplanation: 'Fresh 4' }
        },
        overallSummary: 'Fresh Hydrogen run'
      },
      rawText: '{}',
      statusIndicator: 'CLOUD',
      sdkInferenceSource: InferenceSource.IN_CLOUD,
      requestedMode: InferenceMode.ONLY_IN_CLOUD,
      modelIdentifier: 'gemini-4-hydrogen',
      requestedModelIdentifier: 'gemini-4-hydrogen',
      executedAt: new Date().toISOString(),
      durationMs: 200,
      fallbackOccurred: false
    });

    fireEvent.click(authCheckbox);
    expect(authCheckbox.checked).toBe(true);
    expect(runNewBtn.disabled).toBe(false);

    fireEvent.click(runNewBtn);

    await waitFor(() => {
      expect(mockExecuteHybridInference).toHaveBeenCalledTimes(1);
    });

    const passedReq = mockExecuteHybridInference.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passedReq.taskKey).toBe('judge_evidence');
    expect(passedReq.preferredMode).toBe(InferenceMode.ONLY_IN_CLOUD);
    expect(passedReq.useHeavyCloudModel).toBe(true);
    expect(passedReq.disableModelFallback).toBe(true);
    expect(passedReq.maxTransientRetries).toBe(0);
    expect(passedReq.thinkingLevel).toBe('LOW');
    expect(passedReq.timeoutMs).toBe(90_000);

    // Authorization auto-resets back to QUOTA-SAFE MODE after completion
    await waitFor(() => {
      expect(authCheckbox.checked).toBe(false);
      expect(runNewBtn.disabled).toBe(true);
      expect(screen.getByText('QUOTA-SAFE MODE')).toBeTruthy();
    });
  });

  it('transitions cleanly to PAUSED_QUOTA with 0 auto-retries when Hydrogen returns 429 RetryInfo', async () => {
    const bundle = makeBundle();
    saveJudgingV2Checkpoint({
      jobId: 'job_ui_v2',
      submissionId: 'sub_ui_v2',
      projectId: 'proj_ui_v2',
      repoUrl: REPO_URL,
      defaultBranch: 'main',
      commitSha: COMMIT_SHA,
      criteriaVersion: CRITERIA_VERSION,
      analysisVersion: ANALYSIS_VERSION,
      evidenceCollectorVersion: EVIDENCE_COLLECTOR_VERSION,
      evidenceKey: bundle.evidenceKey,
      status: 'EVIDENCE_READY',
      completedBatches: 1,
      totalBatches: 1,
      inspectedPaths: ['src/App.tsx'],
      evidenceBundle: bundle,
      aiRecommendation: null,
      lastError: null,
      quotaStopped: false,
      updatedAt: '2026-11-25T10:00:00Z'
    });

    mockExecuteHybridInference.mockResolvedValueOnce({
      ok: false,
      data: null,
      rawText: '',
      statusIndicator: 'FAILED',
      sdkInferenceSource: null,
      requestedMode: InferenceMode.ONLY_IN_CLOUD,
      modelIdentifier: 'gemini-4-hydrogen',
      requestedModelIdentifier: 'gemini-4-hydrogen',
      executedAt: new Date().toISOString(),
      durationMs: 30,
      fallbackOccurred: false,
      failureCategory: 'quota',
      errorMessage: '429 Too Many Requests {"retryDelay": "9s"}'
    });

    render(
      <MemoryRouter>
        <LanguageProvider>
          <EvidenceJudgingPage />
        </LanguageProvider>
      </MemoryRouter>
    );

    await screen.findByText('Repository Coverage & Verifiable Evidence');

    const authCheckbox = (await screen.findByRole('checkbox', {
      name: /Explicitly authorize a single Gemini 4 Hydrogen request/i
    })) as HTMLInputElement;
    const runNewBtn = screen.getByRole('button', { name: 'Run New Gemini Analysis' }) as HTMLButtonElement;

    fireEvent.click(authCheckbox);
    await waitFor(() => {
      expect(authCheckbox.checked).toBe(true);
      expect(runNewBtn.disabled).toBe(false);
    });
    fireEvent.click(runNewBtn);

    await waitFor(() => {
      expect(mockExecuteHybridInference).toHaveBeenCalledTimes(1);
      expect(screen.getByText('PAUSED_QUOTA')).toBeTruthy();
      expect(authCheckbox.checked).toBe(false);
    });
  });
});
