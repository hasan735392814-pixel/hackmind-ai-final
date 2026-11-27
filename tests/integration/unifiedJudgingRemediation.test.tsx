// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LanguageProvider } from '../../src/contexts/LanguageContext';
import { ThemeProvider } from '../../src/contexts/ThemeContext';
import { DashboardLayout } from '../../src/layouts/DashboardLayout';
import {
  CANONICAL_DEFAULT_RUBRIC,
  cloneCanonicalDefaultRubric,
  computeFairRankings,
  hydrateEvaluationScoresAndTotal,
  validateRubricWeights
} from '../../src/services/judging/fairJudgingEngine';
import {
  OFFICIAL_JUDGING_CRITERIA,
  calculateWeightedScoreForRubric,
  resolveActiveRubricCriteria
} from '../../src/services/judgingV2/criteria';
import {
  attachAIRecommendationSafely,
  cacheHumanEvaluationLocally,
  createEmptyHumanEvaluation,
  reconcileEvaluationWithFirestore,
  setHumanCriterionScoreV2
} from '../../src/services/judgingV2/humanEvaluationStore';
import { clearAllJudgingV2EvidenceForTests } from '../../src/services/judgingV2/cacheAndCheckpoints';
import type { AIJudgingRecommendation } from '../../src/services/judgingV2/types';
import type { Evaluation, Hackathon, JudgeAssignment, ProjectSubmission, RubricCriterion } from '../../src/types/domain';

const mockAuthValue = vi.hoisted(() => ({
  user: { uid: 'judge_1', displayName: 'Judge One', email: 'judge1@hackmind.ai' } as {
    uid: string;
    displayName: string;
    email: string;
  } | null,
  profile: { uid: 'judge_1', displayName: 'Judge One', approvedRole: 'judge' },
  privateInfo: { aiCloudConsent: false },
  isAdmin: false,
  emailVerified: true,
  loading: false,
  updateCloudConsent: vi.fn(),
  resendVerification: vi.fn(),
  reloadUserAndProfile: vi.fn(),
  logout: vi.fn()
}));

const mockFirestoreFns = vi.hoisted(() => ({
  getHackathonById: vi.fn(),
  listJudgeAssignedSubmissions: vi.fn(),
  listJudgeAssignmentsByJudge: vi.fn(),
  listJudgeEvaluations: vi.fn(),
  listOrganizerEvaluations: vi.fn(),
  listOrganizerSubmissions: vi.fn(),
  saveEvaluation: vi.fn(),
  updateJudgeAssignmentResponse: vi.fn(),
  listDerivedUserActivity: vi.fn(),
  subscribeUserNotifications: vi.fn()
}));

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => mockAuthValue
}));

vi.mock('../../src/services/firebase/firestoreService', () => mockFirestoreFns);

import { EvidenceJudgingPage } from '../../src/pages/EvidenceJudgingPage';

const canonicalHackathon: Hackathon = {
  id: 'hack_canon',
  organizerId: 'org_1',
  organizerName: 'Organizer',
  title: 'Canonical Hack',
  tagline: 'Fairness first',
  description: 'Canonical rubric hackathon',
  coverImageUrl: '',
  startDate: '2026-11-01',
  endDate: '2026-11-03',
  registrationDeadline: '2026-10-30',
  submissionDeadline: '2026-11-03',
  mode: 'online',
  location: 'Global',
  tracks: ['AI'],
  technologies: ['TypeScript'],
  eligibility: 'Open',
  rules: 'Public repo',
  prizes: [],
  sponsors: [],
  rubric: cloneCanonicalDefaultRubric(),
  maxTeamSize: 4,
  status: 'judging',
  resultsPublished: false
};

const sub1: ProjectSubmission = {
  id: 'sub_1',
  hackathonId: 'hack_canon',
  organizerId: 'org_1',
  teamId: 'team_1',
  teamName: 'Team One',
  projectId: 'proj_1',
  ownerId: 'builder_1',
  memberIds: ['builder_1'],
  memberNames: ['Builder One'],
  title: 'Project Atlas',
  shortDescription: 'Real-time flood predictor.',
  fullDescription: 'Full stack telemetry.',
  problemStatement: 'Late warnings.',
  proposedSolution: 'Sensor fusion.',
  technologies: ['TypeScript', 'React'],
  githubUrl: 'https://github.com/example/atlas',
  demoUrl: '',
  videoUrl: '',
  screenshotUrls: [],
  track: 'AI',
  status: 'submitted'
};

const acceptedAssignment: JudgeAssignment = {
  id: 'hack_canon_judge_1',
  hackathonId: 'hack_canon',
  organizerId: 'org_1',
  judgeId: 'judge_1',
  judgeName: 'Judge One',
  assignedSubmissionIds: ['sub_1'],
  conflictDeclared: false,
  conflictNotes: '',
  status: 'accepted'
};

function renderPage(initialPath = '/app/judging-v2') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <LanguageProvider>
        <EvidenceJudgingPage />
      </LanguageProvider>
    </MemoryRouter>
  );
}

describe('Unified Judging System Remediation — End-to-End Integration Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('hackmind_locale', 'en');
    clearAllJudgingV2EvidenceForTests();

    mockAuthValue.user = { uid: 'judge_1', displayName: 'Judge One', email: 'judge1@hackmind.ai' };
    mockAuthValue.profile = { uid: 'judge_1', displayName: 'Judge One', approvedRole: 'judge' };
    mockAuthValue.isAdmin = false;
    mockAuthValue.emailVerified = true;

    mockFirestoreFns.listJudgeAssignedSubmissions.mockResolvedValue([sub1]);
    mockFirestoreFns.listJudgeAssignmentsByJudge.mockResolvedValue([acceptedAssignment]);
    mockFirestoreFns.listJudgeEvaluations.mockResolvedValue([]);
    mockFirestoreFns.listOrganizerEvaluations.mockResolvedValue([]);
    mockFirestoreFns.listOrganizerSubmissions.mockResolvedValue([]);
    mockFirestoreFns.getHackathonById.mockResolvedValue(canonicalHackathon);
    mockFirestoreFns.saveEvaluation.mockResolvedValue(undefined);
    mockFirestoreFns.updateJudgeAssignmentResponse.mockResolvedValue(undefined);
    mockFirestoreFns.listDerivedUserActivity.mockResolvedValue([]);
    mockFirestoreFns.subscribeUserNotifications.mockReturnValue(() => {});
  });

  afterEach(() => {
    cleanup();
  });

  it('1 & 2. Persists draft and final submitted evaluations in Cloud Firestore across fresh reload and locks UI', async () => {
    let firestoreStore: Evaluation | null = null;
    const readStore = (): Evaluation | null => firestoreStore;
    mockFirestoreFns.listJudgeEvaluations.mockImplementation(async () =>
      firestoreStore ? [firestoreStore] : []
    );
    mockFirestoreFns.saveEvaluation.mockImplementation(async (payload) => {
      firestoreStore = {
        ...payload,
        createdAt: '2026-11-27T10:00:00Z',
        updatedAt: '2026-11-27T10:05:00Z',
        ...(payload.status === 'submitted' ? { submittedAt: '2026-11-27T10:05:00Z' } : {})
      };
    });

    const firstMount = renderPage();
    await screen.findByLabelText('Innovation & Originality score');

    fireEvent.change(screen.getByLabelText('Innovation & Originality score'), { target: { value: '80' } });
    fireEvent.change(screen.getByLabelText('Technical Implementation score'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Real-World Impact score'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('User Experience & Completeness score'), { target: { value: '70' } });

    const rationales = screen.getAllByPlaceholderText(
      /Enter human judge evidence-based rationale/i
    ) as HTMLTextAreaElement[];
    for (const box of rationales) {
      fireEvent.change(box, { target: { value: 'Verified from source code' } });
    }

    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }));
    await waitFor(() => {
      expect(mockFirestoreFns.saveEvaluation).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Evaluation draft saved to Cloud Firestore \(76\.00\/100\)/i)).toBeTruthy();
    });
    expect(readStore()?.id).toBe('sub_1_judge_1');
    expect(readStore()?.status).toBe('draft');
    expect(readStore()?.weightedTotal).toBe(76);

    // Unmount and wipe localStorage to prove authoritative persistence comes from Firestore on reload
    firstMount.unmount();
    localStorage.clear();
    localStorage.setItem('hackmind_locale', 'en');

    const secondMount = renderPage();
    await waitFor(() => {
      expect((screen.getByLabelText('Innovation & Originality score') as HTMLInputElement).value).toBe('80');
      expect((screen.getByLabelText('Technical Implementation score') as HTMLInputElement).value).toBe('90');
      expect(screen.getByText('76.00 / 100')).toBeTruthy();
    });

    // Submit final official evaluation -> locks UI and writes status: 'submitted' to Firestore
    fireEvent.click(
      screen.getByRole('button', { name: 'Finalize & Approve Official Evaluation' })
    );
    await waitFor(() => {
      expect(readStore()?.status).toBe('submitted');
      expect(screen.getByRole('button', { name: 'Approved & Locked' })).toBeTruthy();
      expect((screen.getByLabelText('Innovation & Originality score') as HTMLInputElement).disabled).toBe(true);
    });

    // Fresh reload after submission keeps locked submitted state
    secondMount.unmount();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approved & Locked' })).toBeTruthy();
      expect((screen.getByLabelText('Innovation & Originality score') as HTMLInputElement).disabled).toBe(true);
    });
  });

  it('3, 4 & 5. Prevents duplicate evaluations, overrides stale localStorage draft with Firestore submitted eval, and supports offline draft recovery', async () => {
    // Seed stale unapproved localStorage draft with lower score
    const staleLocal = setHumanCriterionScoreV2(
      createEmptyHumanEvaluation({
        submissionId: 'sub_1',
        hackathonId: 'hack_canon',
        judgeId: 'judge_1',
        judgeName: 'Judge One'
      }),
      'innovation_originality',
      15,
      'Stale local note'
    );
    cacheHumanEvaluationLocally(staleLocal);

    // Authoritative Firestore record is submitted with score 88
    const authoritativeSubmitted: Evaluation = {
      id: 'sub_1_judge_1',
      hackathonId: 'hack_canon',
      organizerId: 'org_1',
      submissionId: 'sub_1',
      judgeId: 'judge_1',
      judgeName: 'Judge One',
      criteriaScores: [
        { criterionId: 'innovation_originality', criterionName: 'Innovation & Originality', weight: 25, score: 88, scoreScale: '0_to_100', comment: 'Official 1' },
        { criterionId: 'technical_implementation', criterionName: 'Technical Implementation', weight: 30, score: 88, scoreScale: '0_to_100', comment: 'Official 2' },
        { criterionId: 'real_world_impact', criterionName: 'Real-World Impact', weight: 25, score: 88, scoreScale: '0_to_100', comment: 'Official 3' },
        { criterionId: 'ux_completeness', criterionName: 'User Experience & Completeness', weight: 20, score: 88, scoreScale: '0_to_100', comment: 'Official 4' }
      ],
      weightedTotal: 88,
      scoreScale: '0_to_100',
      conflictOfInterest: false,
      conflictReason: '',
      humanFeedback: 'Authoritative submitted',
      aiReportSummary: '',
      aiInferenceSource: '',
      status: 'submitted',
      submittedAt: '2026-11-27T11:00:00Z',
      updatedAt: '2026-11-27T11:00:00Z'
    };

    mockFirestoreFns.listJudgeEvaluations.mockResolvedValue([authoritativeSubmitted]);

    renderPage();

    await waitFor(() => {
      expect((screen.getByLabelText('Innovation & Originality score') as HTMLInputElement).value).toBe('88');
      expect(screen.getByRole('button', { name: 'Approved & Locked' })).toBeTruthy();
    });

    // Direct mutation check on locked evaluation
    expect(() => setHumanCriterionScoreV2(
      reconcileEvaluationWithFirestore({
        firestoreEval: authoritativeSubmitted,
        localDraft: staleLocal,
        context: {
          submissionId: 'sub_1',
          hackathonId: 'hack_canon',
          judgeId: 'judge_1',
          judgeName: 'Judge One'
        },
        activeCriteria: resolveActiveRubricCriteria(canonicalHackathon.rubric).criteria
      }),
      'innovation_originality',
      10
    )).toThrow(/locked/i);

    // Offline draft created while Firestore has only an older draft survives reconnect without losing unsaved work
    const remoteDraft: Evaluation = {
      ...authoritativeSubmitted,
      status: 'draft',
      updatedAt: '2026-11-27T09:00:00Z'
    };
    const newerOfflineDraft = setHumanCriterionScoreV2(
      createEmptyHumanEvaluation({
        submissionId: 'sub_offline',
        hackathonId: 'hack_canon',
        judgeId: 'judge_1',
        judgeName: 'Judge One'
      }),
      'innovation_originality',
      92,
      'Offline edit'
    );
    const reconciledOffline = reconcileEvaluationWithFirestore({
      firestoreEval: { ...remoteDraft, submissionId: 'sub_offline', id: 'sub_offline_judge_1' },
      localDraft: newerOfflineDraft,
      context: {
        submissionId: 'sub_offline',
        hackathonId: 'hack_canon',
        judgeId: 'judge_1',
        judgeName: 'Judge One'
      },
      activeCriteria: resolveActiveRubricCriteria(canonicalHackathon.rubric).criteria
    });
    expect(reconciledOffline.status).toBe('draft');
    expect(reconciledOffline.syncState).toBe('local_draft');
    expect(reconciledOffline.criteria.innovation_originality.score).toBe(92);
  });

  it('6. Surfaces Firestore write errors explicitly without pretending success and keeps local inputs', async () => {
    mockFirestoreFns.saveEvaluation.mockRejectedValueOnce(new Error('PERMISSION_DENIED: Firestore rule blocked write'));

    renderPage();
    await screen.findByLabelText('Innovation & Originality score');

    fireEvent.change(screen.getByLabelText('Innovation & Originality score'), { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('PERMISSION_DENIED');
      expect(screen.getByText(/Firestore sync error — draft preserved locally/i)).toBeTruthy();
    });

    expect((screen.getByLabelText('Innovation & Originality score') as HTMLInputElement).value).toBe('75');
    expect(screen.queryByRole('button', { name: 'Approved & Locked' })).toBeNull();
  });

  it('7, 8, 9, 10, 11 & 12. Aligns canonical 25/30/25/20 weights, preserves custom 3- and 5-criterion rubrics, rejects invalid rubrics, computes exact 0-100 rankings, and avoids legacy double-conversion', () => {
    // 8. Canonical 25/30/25/20 alignment across Organizer default & Judging V2
    expect(CANONICAL_DEFAULT_RUBRIC.map((c) => [c.id, c.weight])).toEqual([
      ['innovation_originality', 25],
      ['technical_implementation', 30],
      ['real_world_impact', 25],
      ['ux_completeness', 20]
    ]);
    expect(OFFICIAL_JUDGING_CRITERIA.map((c) => [c.id, c.weightPercent])).toEqual([
      ['innovation_originality', 25],
      ['technical_implementation', 30],
      ['real_world_impact', 25],
      ['ux_completeness', 20]
    ]);

    // 10. Invalid rubric rejection
    expect(validateRubricWeights([]).valid).toBe(false);
    expect(
      validateRubricWeights([
        { id: 'c1', name: 'A', description: '', weight: 60 },
        { id: 'c2', name: 'B', description: '', weight: 30 }
      ]).valid
    ).toBe(false);
    expect(
      validateRubricWeights([
        { id: 'c1', name: 'A', description: '', weight: 0 },
        { id: 'c2', name: 'B', description: '', weight: 100 }
      ]).valid
    ).toBe(false);

    // 11. Exact 0-100 calculation correctness: 80*0.25 + 90*0.30 + 60*0.25 + 70*0.20 = 76
    const resolvedDefault = resolveActiveRubricCriteria(canonicalHackathon.rubric);
    expect(resolvedDefault.isCustom).toBe(false);
    const exact76 = calculateWeightedScoreForRubric(
      {
        innovation_originality: { criterionId: 'innovation_originality', score: 80 },
        technical_implementation: { criterionId: 'technical_implementation', score: 90 },
        real_world_impact: { criterionId: 'real_world_impact', score: 60 },
        ux_completeness: { criterionId: 'ux_completeness', score: 70 }
      },
      resolvedDefault.criteria
    );
    expect(exact76).toBe(76);

    // 9. Custom 3-criterion & 5-criterion rubric preservation + 7. computeFairRankings aggregation
    const custom3: RubricCriterion[] = [
      { id: 'arch', name: 'Architecture', description: '', weight: 40 },
      { id: 'security', name: 'Security', description: '', weight: 35 },
      { id: 'pitch', name: 'Pitch', description: '', weight: 25 }
    ];
    const custom5: RubricCriterion[] = [
      { id: 'k1', name: 'K1', description: '', weight: 20 },
      { id: 'k2', name: 'K2', description: '', weight: 20 },
      { id: 'k3', name: 'K3', description: '', weight: 20 },
      { id: 'k4', name: 'K4', description: '', weight: 20 },
      { id: 'k5', name: 'K5', description: '', weight: 20 }
    ];
    expect(resolveActiveRubricCriteria(custom3).criteria).toHaveLength(3);
    expect(resolveActiveRubricCriteria(custom5).criteria).toHaveLength(5);

    const v2EvalForSub1: Evaluation = {
      id: 'sub_1_judge_1',
      hackathonId: 'hack_canon',
      organizerId: 'org_1',
      submissionId: 'sub_1',
      judgeId: 'judge_1',
      judgeName: 'Judge One',
      criteriaScores: [
        { criterionId: 'arch', criterionName: 'Architecture', weight: 40, score: 80, scoreScale: '0_to_100', comment: 'Good' },
        { criterionId: 'security', criterionName: 'Security', weight: 35, score: 60, scoreScale: '0_to_100', comment: 'Solid' },
        { criterionId: 'pitch', criterionName: 'Pitch', weight: 25, score: 100, scoreScale: '0_to_100', comment: 'Clear' }
      ],
      weightedTotal: 78, // 32 + 21 + 25 = 78
      scoreScale: '0_to_100',
      conflictOfInterest: false,
      conflictReason: '',
      humanFeedback: '',
      aiReportSummary: '',
      aiInferenceSource: '',
      status: 'submitted'
    };

    const rankings = computeFairRankings({
      submissions: [sub1],
      evaluations: [v2EvalForSub1],
      expectedJudgesPerSubmission: 1,
      rubric: custom3
    });
    expect(rankings[0].averageScore).toBe(78);
    expect(rankings[0].judgeCount).toBe(1);

    // 12. Legacy 0-10 conversion + zero double conversion
    const legacyEval: Evaluation = {
      id: 'sub_1_legacy',
      hackathonId: 'hack_canon',
      organizerId: 'org_1',
      submissionId: 'sub_1',
      judgeId: 'judge_legacy',
      judgeName: 'Legacy Judge',
      criteriaScores: [
        { criterionId: 'arch', criterionName: 'Architecture', weight: 40, score: 8, comment: '' },
        { criterionId: 'security', criterionName: 'Security', weight: 35, score: 6, comment: '' },
        { criterionId: 'pitch', criterionName: 'Pitch', weight: 25, score: 10, comment: '' }
      ],
      weightedTotal: 78,
      storageSchema: 'v1_inline',
      conflictOfInterest: false,
      conflictReason: '',
      humanFeedback: '',
      aiReportSummary: '',
      aiInferenceSource: '',
      status: 'submitted'
    };
    const once = hydrateEvaluationScoresAndTotal(legacyEval, [], custom3);
    expect(once.scoreScale).toBe('0_to_100');
    expect(once.convertedFromScale).toBe('0_to_10');
    expect(once.criteriaScores.map((c) => c.score)).toEqual([80, 60, 100]);
    expect(once.criteriaScores.map((c) => c.originalScore)).toEqual([8, 6, 10]);
    expect(once.weightedTotal).toBe(78);

    const twice = hydrateEvaluationScoresAndTotal(once, [], custom3);
    expect(twice.criteriaScores.map((c) => c.score)).toEqual([80, 60, 100]);
    expect(twice.weightedTotal).toBe(78);
  });

  it('13. Exposes a single canonical judging navigation item in DashboardLayout and redirects /app/judging to /app/judging-v2', async () => {
    function LocationProbe() {
      const loc = useLocation();
      return <div data-testid="location-probe">{loc.pathname}</div>;
    }

    render(
      <MemoryRouter initialEntries={['/app/judging']}>
        <ThemeProvider>
          <LanguageProvider>
            <DashboardLayout>
              <Routes>
                <Route path="/app/judging" element={<Navigate to="/app/judging-v2" replace />} />
                <Route path="/app/judging-v2" element={<LocationProbe />} />
              </Routes>
            </DashboardLayout>
          </LanguageProvider>
        </ThemeProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId('location-probe').textContent).toBe('/app/judging-v2');
    });

    const navLinks = screen.getAllByRole('link');
    const judgingHrefs = navLinks
      .map((el) => el.getAttribute('href'))
      .filter((href) => href && href.includes('/judging'));
    expect(judgingHrefs).toEqual(['/app/judging-v2']);
  });

  it('14. Enforces judge authorization for unassigned viewers and keeps AI recommendation strictly advisory', async () => {
    // Unassigned organizer viewing submission sees read-only preview and cannot submit scores
    mockAuthValue.profile = { uid: 'org_viewer', displayName: 'Org Viewer', approvedRole: 'organizer' };
    mockAuthValue.user = { uid: 'org_viewer', displayName: 'Org Viewer', email: 'org@hackmind.ai' };
    mockFirestoreFns.listJudgeAssignedSubmissions.mockResolvedValue([]);
    mockFirestoreFns.listJudgeAssignmentsByJudge.mockResolvedValue([]);
    mockFirestoreFns.listOrganizerSubmissions.mockResolvedValue([sub1]);

    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText(/Read-only preview: an accepted, unconflicted judge assignment/i)
      ).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Save Draft' }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByLabelText('Innovation & Originality score') as HTMLInputElement).disabled).toBe(true);
    });

    // AI advisory attachment never modifies human scores
    const humanDraft = setHumanCriterionScoreV2(
      createEmptyHumanEvaluation({
        submissionId: 'sub_1',
        hackathonId: 'hack_canon',
        judgeId: 'judge_1',
        judgeName: 'Judge One'
      }),
      'innovation_originality',
      45,
      'Human decision'
    );
    const advisory: AIJudgingRecommendation = {
      recommendationId: 'rec_1',
      cacheKey: 'k1',
      projectId: 'proj_1',
      submissionId: 'sub_1',
      repoUrl: 'https://github.com/example/atlas',
      commitSha: 'abc',
      criteriaVersion: 'v2.4criteria.2026-11',
      analysisVersion: 'v2.evidence.1',
      generatedAt: '2026-11-27T10:00:00Z',
      modelUsed: 'gemini-4-hydrogen',
      inferenceSource: 'IN_CLOUD',
      fromCache: true,
      geminiRequestsUsed: 0,
      advisoryOnly: true,
      advisoryWeightedScore: 95,
      overallSummary: 'AI says 95',
      disclaimers: ['Advisory only'],
      criteriaRecommendations: {
        innovation_originality: { criterionId: 'innovation_originality', criterionName: 'Innovation & Originality', weightPercent: 25, recommendedScore: 95, confidence: 'HIGH', verifiedEvidence: [], strengths: [], weaknesses: [], missingOrUnverifiedEvidence: [], scoringExplanation: 'AI' },
        technical_implementation: { criterionId: 'technical_implementation', criterionName: 'Technical Implementation', weightPercent: 30, recommendedScore: 95, confidence: 'HIGH', verifiedEvidence: [], strengths: [], weaknesses: [], missingOrUnverifiedEvidence: [], scoringExplanation: 'AI' },
        real_world_impact: { criterionId: 'real_world_impact', criterionName: 'Real-World Impact', weightPercent: 25, recommendedScore: 95, confidence: 'HIGH', verifiedEvidence: [], strengths: [], weaknesses: [], missingOrUnverifiedEvidence: [], scoringExplanation: 'AI' },
        ux_completeness: { criterionId: 'ux_completeness', criterionName: 'User Experience & Completeness', weightPercent: 20, recommendedScore: 95, confidence: 'HIGH', verifiedEvidence: [], strengths: [], weaknesses: [], missingOrUnverifiedEvidence: [], scoringExplanation: 'AI' }
      }
    };
    const withAdvisory = attachAIRecommendationSafely(humanDraft, advisory);
    expect(withAdvisory.criteria.innovation_originality.score).toBe(45);
    expect(withAdvisory.criteria.innovation_originality.rationale).toBe('Human decision');
    expect(withAdvisory.aiRecommendationSnapshot?.advisoryOnly).toBe(true);
    expect(withAdvisory.status).toBe('draft');
  });
});
