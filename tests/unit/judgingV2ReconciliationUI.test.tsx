// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../src/contexts/LanguageContext';
import {
  buildEvidenceRecordKey,
  clearAllCachedAIAnalyses,
  clearAllJudgingV2EvidenceForTests,
  resolveEvidenceForSubmission,
  saveJudgingV2Checkpoint
} from '../../src/services/judgingV2/cacheAndCheckpoints';
import {
  ANALYSIS_VERSION,
  CRITERIA_VERSION,
  EVIDENCE_COLLECTOR_VERSION
} from '../../src/services/judgingV2/criteria';
import type { EvidenceBundle } from '../../src/services/judgingV2/types';
import type { Hackathon, JudgeAssignment, ProjectSubmission } from '../../src/types/domain';

const mockAuthValue = vi.hoisted(() => ({
  user: { uid: 'judge_1', displayName: 'Judge One', email: 'judge@hackmind.ai' },
  profile: { uid: 'judge_1', displayName: 'Judge One', approvedRole: 'judge' },
  privateInfo: { aiCloudConsent: false },
  isAdmin: false,
  emailVerified: true,
  updateCloudConsent: vi.fn()
}));

const mockFirestoreFns = vi.hoisted(() => ({
  getHackathonById: vi.fn(),
  listJudgeAssignedSubmissions: vi.fn(),
  listJudgeAssignmentsByJudge: vi.fn(),
  listOrganizerSubmissions: vi.fn()
}));

const mockCollectProjectEvidence = vi.hoisted(() => vi.fn());

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => mockAuthValue
}));

vi.mock('../../src/services/firebase/firestoreService', () => mockFirestoreFns);

vi.mock('../../src/services/judgingV2/evidenceCollector', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/services/judgingV2/evidenceCollector')>();
  return {
    ...actual,
    collectProjectEvidence: (...args: unknown[]) => mockCollectProjectEvidence(...args)
  };
});

import { EvidenceJudgingPage } from '../../src/pages/EvidenceJudgingPage';

const REPO_URL = 'https://github.com/hasan735392814-pixel/culturepulse-ai-source';
const COMMIT_SHA = 'bca5b1e4cec1b1aa56018477f3c0fe70e8923586';

const culturePulseHackathon: Hackathon = {
  id: 'hack_cp',
  organizerId: 'org_1',
  organizerName: 'Organizer',
  title: 'CulturePulse Global Hack',
  tagline: 'Cultural discovery',
  description: 'Hackathon',
  coverImageUrl: '',
  startDate: '2026-10-01',
  endDate: '2026-10-05',
  registrationDeadline: '2026-09-30',
  submissionDeadline: '2026-10-05T23:59:59Z',
  mode: 'online',
  location: 'Remote',
  tracks: ['AI & Culture'],
  technologies: ['TypeScript', 'React', 'Supabase'],
  eligibility: 'Open',
  rules: 'Open source',
  prizes: [],
  sponsors: [],
  rubric: [],
  maxTeamSize: 4,
  status: 'judging',
  resultsPublished: false
};

const culturePulseSubmission: ProjectSubmission = {
  id: 'sub_culturepulse',
  hackathonId: 'hack_cp',
  organizerId: 'org_1',
  teamId: 'team_cp',
  teamName: 'CulturePulse Team',
  projectId: 'proj_culturepulse',
  ownerId: 'owner_cp',
  memberIds: ['owner_cp'],
  memberNames: ['Hasan'],
  title: 'CulturePulse AI',
  shortDescription: 'Cultural intelligence platform powered by Qloo.',
  fullDescription: 'React + Vite + Supabase Edge Functions.',
  problemStatement: 'Fragmented cultural discovery across regions.',
  proposedSolution: 'Edge-proxied Qloo cultural intelligence workflows.',
  technologies: ['TypeScript', 'React', 'Vite', 'Supabase'],
  githubUrl: REPO_URL,
  demoUrl: '',
  videoUrl: '',
  screenshotUrls: [],
  track: 'AI & Culture',
  status: 'submitted',
  assignedJudgeIds: ['judge_1']
};

const judgeAssignment: JudgeAssignment = {
  id: 'assign_1',
  hackathonId: 'hack_cp',
  organizerId: 'org_1',
  judgeId: 'judge_1',
  judgeName: 'Judge One',
  status: 'accepted',
  assignedSubmissionIds: ['sub_culturepulse'],
  conflictDeclared: false,
  conflictNotes: ''
};

function makeLegacyBundle22_8_42(): EvidenceBundle {
  const skipped42 = Array.from({ length: 42 }, (_, idx) => ({
    path: idx < 28 ? `GITHUB_UPLOAD/src/file_${idx}.ts` : `src/uninspected_${idx}.ts`,
    reason: idx < 28 ? 'duplicate_mirror' : 'file_count_limit',
    category: 'frontend_source',
    sizeBytes: 240
  }));
  const binary6 = [
    'CULTUREPULSE_AI_DEMO.mp4',
    'package-lock.json',
    'bun.lockb',
    'public/logo.png',
    'public/hero.webp',
    'GITHUB_UPLOAD/package-lock.json'
  ].map((p) => ({
    path: p,
    reason: 'binary_or_asset',
    category: 'binary_or_asset',
    sizeBytes: 4096
  }));

  return {
    bundleId: 'ev_cp_legacy',
    submissionId: 'sub_culturepulse',
    projectId: 'proj_culturepulse',
    repoUrl: REPO_URL,
    defaultBranch: 'main',
    commitSha: COMMIT_SHA,
    criteriaVersion: CRITERIA_VERSION,
    evidenceCollectorVersion: 'v2.collector.1',
    collectedAt: '2026-11-24T09:00:00Z',
    sanitizedSubmission: {
      ...culturePulseSubmission,
      videoExcluded: true
    },
    coverage: {
      accessible: true,
      repoFullName: 'hasan735392814-pixel/culturepulse-ai-source',
      defaultBranch: 'main',
      commitSha: COMMIT_SHA,
      commitShaVerified: true,
      primaryRootPath: '.',
      hasDivergentRoots: false,
      totalTreeEntries: 82,
      uniqueSourceFiles: 72,
      inspectedFiles: 22,
      partiallyInspectedFiles: 8,
      skippedFiles: 42,
      inaccessibleFiles: 0,
      failedFiles: 0,
      readmeAndDocsCount: 4,
      excludedBinaryAndLockCount: 6,
      completedBatches: 3,
      totalBatches: 3,
      treeTruncated: false,
      redactedSecretsCount: 0,
      note: 'Pass 1 partial snapshot: 22 full, 8 partial, 42 skipped.',
      // Legacy bug mixed 6 binary_or_asset items into skippedFilesList (total 48 items)
      skippedFilesList: [...skipped42, ...binary6]
    },
    findings: [],
    dependencies: ['react', 'vite'],
    apiEndpointsDetected: [
      { filePath: 'supabase/functions/qloo-proxy/index.ts', lineRange: 'L1-L20', signature: 'Deno.serve(...)' }
    ],
    clientApiHelpersDetected: [
      { filePath: 'src/lib/qloo-client.ts', lineRange: 'L1-L20', signature: 'getInsights(...)' }
    ],
    testVerification: {
      status: 'UNVERIFIED',
      source: 'none',
      executed: false,
      passedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      discoveredTestFilesCount: 0,
      summary: 'No automated test logs found.',
      references: []
    },
    publicAppProbe: {
      url: '',
      checkedAt: '2026-11-24T09:00:00Z',
      reachable: false,
      httpStatus: null,
      finalUrl: null,
      title: null,
      requiresAuth: false,
      hasCrashBanner: false,
      reachabilityStatus: 'UNVERIFIED',
      functionalityStatus: 'UNVERIFIED',
      summary: 'No public app URL provided.'
    },
    workflowChecks: [],
    epistemicNotices: ['Demo videos excluded.'],
    inspectedFilesList: [
      { path: 'src/App.tsx', category: 'frontend_source', totalLines: 106, truncated: false, status: 'FULLY_INSPECTED' }
    ]
  };
}

function makeCompleteBundle36_0_36(): EvidenceBundle {
  const skipped36 = [
    ...Array.from({ length: 28 }, (_, idx) => ({
      path: `GITHUB_UPLOAD/src/file_${idx}.ts`,
      reason: 'duplicate_mirror',
      category: 'frontend_source',
      sizeBytes: 300
    })),
    ...Array.from({ length: 6 }, (_, idx) => ({
      path: `GITHUB_UPLOAD/mirror_cfg_${idx}.json`,
      reason: 'unselected_mirror_config_or_asset',
      category: 'config_security',
      sizeBytes: 250
    })),
    {
      path: '.gitignore',
      reason: 'unselected_config_or_asset',
      category: 'config_security',
      sizeBytes: 220
    },
    {
      path: 'LICENSE',
      reason: 'unselected_config_or_asset',
      category: 'config_security',
      sizeBytes: 1060
    }
  ];
  const docs4 = ['README.md', 'docs/ARCHITECTURE.md', 'docs/API.md', 'GITHUB_UPLOAD/README.md'].map(
    (p) => ({
      path: p,
      reason: 'non_code_documentation',
      category: 'docs',
      sizeBytes: 800
    })
  );
  const binary6 = [
    'CULTUREPULSE_AI_DEMO.mp4',
    'package-lock.json',
    'bun.lockb',
    'public/logo.png',
    'public/hero.webp',
    'GITHUB_UPLOAD/package-lock.json'
  ].map((p) => ({
    path: p,
    reason: 'binary_or_asset',
    category: 'binary_or_asset',
    sizeBytes: 4096
  }));

  const evidenceKey = buildEvidenceRecordKey({
    projectId: 'proj_culturepulse',
    repoUrl: REPO_URL,
    defaultBranch: 'main',
    commitSha: COMMIT_SHA,
    criteriaVersion: CRITERIA_VERSION,
    evidenceCollectorVersion: EVIDENCE_COLLECTOR_VERSION
  });

  return {
    bundleId: 'ev_cp_complete',
    evidenceKey,
    submissionId: 'sub_culturepulse',
    projectId: 'proj_culturepulse',
    repoUrl: REPO_URL,
    defaultBranch: 'main',
    commitSha: COMMIT_SHA,
    criteriaVersion: CRITERIA_VERSION,
    evidenceCollectorVersion: EVIDENCE_COLLECTOR_VERSION,
    collectedAt: '2026-11-24T11:30:00Z',
    sanitizedSubmission: {
      ...culturePulseSubmission,
      videoExcluded: true
    },
    coverage: {
      accessible: true,
      repoFullName: 'hasan735392814-pixel/culturepulse-ai-source',
      defaultBranch: 'main',
      commitSha: COMMIT_SHA,
      commitShaVerified: true,
      primaryRootPath: '.',
      hasDivergentRoots: false,
      totalTreeEntries: 82,
      uniqueSourceFiles: 72,
      inspectedFiles: 36,
      partiallyInspectedFiles: 0,
      skippedFiles: 36,
      inaccessibleFiles: 0,
      failedFiles: 0,
      readmeAndDocsCount: 4,
      excludedBinaryAndLockCount: 6,
      completedBatches: 5,
      totalBatches: 5,
      treeTruncated: false,
      redactedSecretsCount: 0,
      note: 'Inspected 36/72 unique source files (36 full, 0 partial, 36 skipped) across 5/5 batches.',
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
      skippedFilesList: skipped36,
      excludedDocsList: docs4,
      excludedBinaryAndLockList: binary6
    },
    findings: [],
    dependencies: ['react', 'vite'],
    apiEndpointsDetected: [
      { filePath: 'supabase/functions/qloo-proxy/index.ts', lineRange: 'L1-L20', signature: 'Deno.serve(...)' }
    ],
    clientApiHelpersDetected: [
      { filePath: 'src/lib/qloo-client.ts', lineRange: 'L1-L20', signature: 'getInsights(...)' }
    ],
    testVerification: {
      status: 'UNVERIFIED',
      source: 'none',
      executed: false,
      passedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      discoveredTestFilesCount: 0,
      summary: 'No automated test logs found.',
      references: []
    },
    publicAppProbe: {
      url: '',
      checkedAt: '2026-11-24T11:30:00Z',
      reachable: false,
      httpStatus: null,
      finalUrl: null,
      title: null,
      requiresAuth: false,
      hasCrashBanner: false,
      reachabilityStatus: 'UNVERIFIED',
      functionalityStatus: 'UNVERIFIED',
      summary: 'No public app URL provided.'
    },
    workflowChecks: [],
    epistemicNotices: ['Demo videos excluded.'],
    inspectedFilesList: Array.from({ length: 36 }, (_, idx) => ({
      path: `src/inspected_${idx}.ts`,
      category: 'frontend_source',
      totalLines: 45,
      truncated: false,
      status: 'FULLY_INSPECTED' as const
    }))
  };
}

describe('Judging V2 UI — Persisted Coverage Reconciliation & Stale Checkpoint Protection', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('hackmind_locale', 'en');
    clearAllCachedAIAnalyses();
    clearAllJudgingV2EvidenceForTests();
    mockCollectProjectEvidence.mockReset();

    mockFirestoreFns.listJudgeAssignedSubmissions.mockResolvedValue([culturePulseSubmission]);
    mockFirestoreFns.listJudgeAssignmentsByJudge.mockResolvedValue([judgeAssignment]);
    mockFirestoreFns.listOrganizerSubmissions.mockResolvedValue([]);
    mockFirestoreFns.getHackathonById.mockResolvedValue(culturePulseHackathon);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('displays latest 36/0/36 (5/5) persisted evidence over stale 22/8/42 (3/3) checkpoints and reconciles skipped vs excluded paths', async () => {
    const legacyBundle = makeLegacyBundle22_8_42();
    const completeBundle = makeCompleteBundle36_0_36();

    // Seed newer complete v2.collector.2 record AND attempt writing a stale v2.collector.1 checkpoint afterwards
    saveJudgingV2Checkpoint({
      jobId: 'job_cp_v2',
      submissionId: 'sub_culturepulse',
      projectId: 'proj_culturepulse',
      repoUrl: REPO_URL,
      defaultBranch: 'main',
      commitSha: COMMIT_SHA,
      criteriaVersion: CRITERIA_VERSION,
      analysisVersion: ANALYSIS_VERSION,
      evidenceCollectorVersion: EVIDENCE_COLLECTOR_VERSION,
      evidenceKey: completeBundle.evidenceKey,
      status: 'EVIDENCE_READY',
      completedBatches: 5,
      totalBatches: 5,
      inspectedPaths: completeBundle.inspectedFilesList.map((f) => f.path),
      evidenceBundle: completeBundle,
      aiRecommendation: null,
      lastError: null,
      quotaStopped: false,
      updatedAt: '2026-11-24T11:30:00Z'
    });

    // Stale checkpoint arrives later -> preserved as SUPERSEDED without overwriting 36/0/36
    saveJudgingV2Checkpoint({
      jobId: 'job_cp_legacy',
      submissionId: 'sub_culturepulse',
      projectId: 'proj_culturepulse',
      repoUrl: REPO_URL,
      defaultBranch: 'main',
      commitSha: COMMIT_SHA,
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

    render(
      <MemoryRouter>
        <LanguageProvider>
          <EvidenceJudgingPage />
        </LanguageProvider>
      </MemoryRouter>
    );

    // Wait for page load & authoritative evidence restoration
    await waitFor(() => {
      expect(screen.getByText('Repository Coverage & Verifiable Evidence')).toBeTruthy();
    });

    // Must NOT trigger extra collection or Gemini calls when v2.collector.2 36/0/36 is already active
    expect(mockCollectProjectEvidence).not.toHaveBeenCalled();
    expect(screen.getByText('QUOTA-SAFE MODE')).toBeTruthy();

    // Displays 36/0/36 and 5/5 (and NOT 22/8/42 or 3/3 as active coverage)
    expect(screen.getByText(/Inspected 36\/72 unique source files \(36 full, 0 partial, 36 skipped\) across 5\/5 batches/)).toBeTruthy();
    expect(screen.getByText('Batches: 5/5')).toBeTruthy();
    expect(screen.getAllByText(/Active: v2\.collector\.2/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/bca5b1e4cec1/).length).toBeGreaterThanOrEqual(1);

    // Preserved legacy version notice is shown cleanly without erasing history
    expect(
      screen.getByText(/Preserved 1 superseded\/legacy version\(s\) cleanly \(Active: v2\.collector\.2\): v2\.collector\.1 \(22\/8\/42, 3\/3\)/)
    ).toBeTruthy();

    // Skipped (36) & Excluded (10 = 4 docs + 6 binary/lock) reconciled cleanly — never 48!
    const disclosureBtn = screen.getByRole('button', {
      name: /Inspect Skipped \(36\) & Excluded \(10\) Paths/i
    });
    fireEvent.click(disclosureBtn);

    expect(screen.getByRole('button', { name: 'Skipped Source Paths (36)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Excluded Docs & Binary/Locks (10)' })).toBeTruthy();

    // Verify table rows match 36 on Skipped tab and 10 on Excluded tab
    const pathsTable = screen.getByRole('columnheader', { name: 'Reason' }).closest('table')!;
    expect(pathsTable.querySelectorAll('tbody tr')).toHaveLength(36);
    fireEvent.click(screen.getByRole('button', { name: 'Excluded Docs & Binary/Locks (10)' }));
    expect(pathsTable.querySelectorAll('tbody tr')).toHaveLength(10);
  });

  it('automatically upgrades a legacy-only 22/8/42 checkpoint to 36/0/36 (5/5) on load with 0 Gemini calls while preserving the legacy version', async () => {
    const legacyBundle = makeLegacyBundle22_8_42();
    const completeBundle = makeCompleteBundle36_0_36();

    saveJudgingV2Checkpoint({
      jobId: 'job_cp_legacy_only',
      submissionId: 'sub_culturepulse',
      projectId: 'proj_culturepulse',
      repoUrl: REPO_URL,
      defaultBranch: 'main',
      commitSha: COMMIT_SHA,
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
      updatedAt: '2026-11-24T09:00:00Z'
    });

    mockCollectProjectEvidence.mockResolvedValueOnce({
      bundle: completeBundle,
      interrupted: false,
      aborted: false,
      inspectedFilesSnapshot: [],
      skippedFilesSnapshot: []
    });

    render(
      <MemoryRouter>
        <LanguageProvider>
          <EvidenceJudgingPage />
        </LanguageProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mockCollectProjectEvidence).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(
        screen.getAllByText(
          /Inspected 36\/72 unique source files \(36 full, 0 partial, 36 skipped\) across 5\/5 batches/
        ).length
      ).toBeGreaterThanOrEqual(1);
    });

    expect(screen.getByText('Batches: 5/5')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Inspect Skipped \(36\) & Excluded \(10\) Paths/i })).toBeTruthy();

    // Legacy 22/8/42 checkpoint remains preserved as SUPERSEDED in store
    const resolved = resolveEvidenceForSubmission({
      submissionId: 'sub_culturepulse',
      projectId: 'proj_culturepulse',
      repoUrl: REPO_URL
    });
    expect(resolved.activeRecord?.evidenceCollectorVersion).toBe(EVIDENCE_COLLECTOR_VERSION);
    expect(resolved.preservedVersions.some((v) => v.evidenceCollectorVersion === 'v2.collector.1')).toBe(
      true
    );
  });
});
