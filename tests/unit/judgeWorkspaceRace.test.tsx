// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../src/contexts/LanguageContext';
import { clearAllJudgingV2EvidenceForTests } from '../../src/services/judgingV2/cacheAndCheckpoints';
import type { Hackathon, JudgeAssignment, ProjectSubmission } from '../../src/types/domain';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mockAuthValue = vi.hoisted(() => ({
  user: { uid: 'judge_1', displayName: 'Judge One', email: 'judge@hackmind.ai' },
  profile: { uid: 'judge_1', displayName: 'Judge One', approvedRole: 'judge' },
  privateInfo: { aiCloudConsent: false },
  isAdmin: false,
  emailVerified: true,
  updateCloudConsent: vi.fn()
}));

const mockFns = vi.hoisted(() => ({
  listJudgeAssignmentsByJudge: vi.fn(),
  listJudgeAssignedSubmissions: vi.fn(),
  listJudgeEvaluations: vi.fn(),
  listOrganizerEvaluations: vi.fn(),
  listOrganizerSubmissions: vi.fn(),
  getHackathonById: vi.fn(),
  saveEvaluation: vi.fn(),
  updateJudgeAssignmentResponse: vi.fn()
}));

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => mockAuthValue
}));

vi.mock('../../src/services/firebase/firestoreService', () => mockFns);

import { EvidenceJudgingPage } from '../../src/pages/EvidenceJudgingPage';

const hackA: Hackathon = {
  id: 'hack_a',
  organizerId: 'org_1',
  organizerName: 'Organizer',
  title: 'Hack A',
  tagline: '',
  description: 'Hackathon A description',
  coverImageUrl: '',
  startDate: '2026-12-01',
  endDate: '2026-12-03',
  registrationDeadline: '2026-11-30',
  submissionDeadline: '2026-12-03',
  mode: 'online',
  location: 'Remote',
  tracks: ['AI'],
  technologies: ['TypeScript'],
  eligibility: 'Open',
  rules: 'Fair',
  prizes: ['$1000'],
  sponsors: [],
  rubric: [{ id: 'crit_a', name: 'Criterion Alpha', description: 'Alpha desc', weight: 100 }],
  maxTeamSize: 4,
  status: 'judging',
  resultsPublished: false
};

const hackB: Hackathon = {
  ...hackA,
  id: 'hack_b',
  title: 'Hack B',
  rubric: [{ id: 'crit_b', name: 'Criterion Beta', description: 'Beta desc', weight: 100 }]
};

const subA: ProjectSubmission = {
  id: 'sub_a',
  hackathonId: 'hack_a',
  organizerId: 'org_1',
  teamId: 'team_a',
  teamName: 'Team A',
  projectId: 'proj_a',
  ownerId: 'p1',
  memberIds: ['p1'],
  memberNames: ['Builder 1'],
  title: 'Submission Alpha',
  shortDescription: 'Alpha short',
  fullDescription: 'Alpha full',
  problemStatement: '',
  proposedSolution: '',
  technologies: ['TypeScript'],
  githubUrl: 'https://github.com/acme/alpha',
  demoUrl: '',
  videoUrl: '',
  screenshotUrls: [],
  track: 'AI',
  status: 'under_review'
};

const subB: ProjectSubmission = {
  ...subA,
  id: 'sub_b',
  hackathonId: 'hack_b',
  teamId: 'team_b',
  teamName: 'Team B',
  projectId: 'proj_b',
  title: 'Submission Beta',
  githubUrl: 'https://github.com/acme/beta'
};

const assignments: JudgeAssignment[] = [
  {
    id: 'hack_a_judge_1',
    hackathonId: 'hack_a',
    organizerId: 'org_1',
    judgeId: 'judge_1',
    judgeName: 'Judge One',
    assignedSubmissionIds: ['sub_a'],
    conflictDeclared: false,
    conflictNotes: '',
    status: 'accepted'
  },
  {
    id: 'hack_b_judge_1',
    hackathonId: 'hack_b',
    organizerId: 'org_1',
    judgeId: 'judge_1',
    judgeName: 'Judge One',
    assignedSubmissionIds: ['sub_b'],
    conflictDeclared: false,
    conflictNotes: '',
    status: 'accepted'
  }
];

function renderUnifiedJudgingPage() {
  return render(
    <MemoryRouter>
      <LanguageProvider>
        <EvidenceJudgingPage />
      </LanguageProvider>
    </MemoryRouter>
  );
}

describe('EvidenceJudgingPage — Unified Save, Switch Race, Recovery & COI Regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('hackmind_locale', 'en');
    clearAllJudgingV2EvidenceForTests();

    mockFns.listJudgeAssignmentsByJudge.mockResolvedValue(assignments);
    mockFns.listJudgeAssignedSubmissions.mockResolvedValue([subA, subB]);
    mockFns.listJudgeEvaluations.mockResolvedValue([]);
    mockFns.listOrganizerEvaluations.mockResolvedValue([]);
    mockFns.listOrganizerSubmissions.mockResolvedValue([]);
    mockFns.getHackathonById.mockImplementation(async (hid: string) =>
      hid === 'hack_a' ? hackA : hackB
    );
    mockFns.updateJudgeAssignmentResponse.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('prevents submission switching during active evaluation save and completes on 0-100 scale without corrupting active submission state', async () => {
    const deferredSave = createDeferred<void>();
    mockFns.saveEvaluation.mockReturnValue(deferredSave.promise);

    renderUnifiedJudgingPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Submission Alpha' })).toBeTruthy();
      expect(screen.getByLabelText('Criterion Alpha score')).toBeTruthy();
    });

    const scoreInput = screen.getByLabelText('Criterion Alpha score') as HTMLInputElement;
    fireEvent.change(scoreInput, { target: { value: '80' } });

    const saveDraftBtn = screen.getByRole('button', { name: 'Save Draft' }) as HTMLButtonElement;
    fireEvent.click(saveDraftBtn);

    const subBButton = screen.getByRole('button', { name: /Submission Beta/i }) as HTMLButtonElement;
    await waitFor(() => {
      expect(subBButton.disabled).toBe(true);
      expect(saveDraftBtn.disabled).toBe(true);
    });

    fireEvent.click(subBButton);
    expect(screen.getByRole('heading', { name: 'Submission Alpha' })).toBeTruthy();

    mockFns.listJudgeEvaluations.mockResolvedValue([
      {
        id: 'sub_a_judge_1',
        hackathonId: 'hack_a',
        organizerId: 'org_1',
        submissionId: 'sub_a',
        judgeId: 'judge_1',
        judgeName: 'Judge One',
        criteriaScores: [
          {
            criterionId: 'crit_a',
            criterionName: 'Criterion Alpha',
            weight: 100,
            score: 80,
            scoreScale: '0_to_100',
            comment: ''
          }
        ],
        weightedTotal: 80,
        scoreScale: '0_to_100',
        conflictOfInterest: false,
        conflictReason: '',
        humanFeedback: '',
        aiReportSummary: '',
        aiInferenceSource: '',
        status: 'draft'
      }
    ]);
    deferredSave.resolve();

    await waitFor(() => {
      expect(
        screen.getByText(/Evaluation draft saved to Cloud Firestore \(80\.00\/100\)/i)
      ).toBeTruthy();
      expect(subBButton.disabled).toBe(false);
    });

    fireEvent.click(subBButton);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Submission Beta' })).toBeTruthy();
      expect(screen.getByLabelText('Criterion Beta score')).toBeTruthy();
    });
  });

  it('ignores out-of-order getHackathonById resolution when switching rapidly between submissions', async () => {
    const hackADeferred = createDeferred<Hackathon | null>();
    const hackBDeferred = createDeferred<Hackathon | null>();
    let callsForA = 0;
    let callsForB = 0;

    mockFns.getHackathonById.mockImplementation((hid: string) => {
      if (hid === 'hack_a') {
        callsForA += 1;
        if (callsForA === 1) return Promise.resolve(null);
        if (callsForA === 2) return Promise.resolve(hackA);
        return hackADeferred.promise;
      }
      callsForB += 1;
      return callsForB === 1 ? Promise.resolve(null) : hackBDeferred.promise;
    });

    renderUnifiedJudgingPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Submission Alpha' })).toBeTruthy();
      expect(screen.getByLabelText('Criterion Alpha score')).toBeTruthy();
    });

    const subAButton = screen.getByRole('button', { name: /Submission Alpha/i });
    const subBButton = screen.getByRole('button', { name: /Submission Beta/i });

    fireEvent.click(subAButton);
    fireEvent.click(subBButton);

    hackBDeferred.resolve(hackB);
    await waitFor(() => {
      expect(screen.getByLabelText('Criterion Beta score')).toBeTruthy();
    });

    hackADeferred.resolve(hackA);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Submission Beta' })).toBeTruthy();
      expect(screen.getByLabelText('Criterion Beta score')).toBeTruthy();
      expect(screen.queryByLabelText('Criterion Alpha score')).toBeNull();
    });
  });

  it('recovers cleanly from a failed Firestore save, preserves unsaved 0-100 scores and comments, resets saving lock, and allows retry', async () => {
    const failedSave = createDeferred<void>();
    mockFns.saveEvaluation.mockReturnValueOnce(failedSave.promise);

    renderUnifiedJudgingPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Submission Alpha' })).toBeTruthy();
      expect(screen.getByLabelText('Criterion Alpha score')).toBeTruthy();
    });

    const scoreInput = screen.getByLabelText('Criterion Alpha score') as HTMLInputElement;
    const commentInput = screen.getByPlaceholderText(
      'Enter human judge evidence-based rationale for this criterion...'
    ) as HTMLTextAreaElement;

    fireEvent.change(scoreInput, { target: { value: '82' } });
    fireEvent.change(commentInput, { target: { value: 'Strong architecture and test evidence' } });

    const saveDraftBtn = screen.getByRole('button', { name: 'Save Draft' }) as HTMLButtonElement;
    const submitFinalBtn = screen.getByRole('button', {
      name: 'Finalize & Approve Official Evaluation'
    }) as HTMLButtonElement;
    const subBButton = screen.getByRole('button', { name: /Submission Beta/i }) as HTMLButtonElement;

    fireEvent.click(saveDraftBtn);

    await waitFor(() => {
      expect(saveDraftBtn.disabled).toBe(true);
      expect(submitFinalBtn.disabled).toBe(true);
      expect(subBButton.disabled).toBe(true);
    });

    failedSave.reject(new Error('Simulated Firestore write failure'));

    await waitFor(() => {
      expect(screen.getByText('Simulated Firestore write failure')).toBeTruthy();
      expect(saveDraftBtn.disabled).toBe(false);
      expect(submitFinalBtn.disabled).toBe(false);
      expect(subBButton.disabled).toBe(false);
    });

    expect((screen.getByLabelText('Criterion Alpha score') as HTMLInputElement).value).toBe('82');
    expect(
      (
        screen.getByPlaceholderText(
          'Enter human judge evidence-based rationale for this criterion...'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('Strong architecture and test evidence');

    mockFns.saveEvaluation.mockResolvedValueOnce(undefined);
    mockFns.listJudgeEvaluations.mockResolvedValue([
      {
        id: 'sub_a_judge_1',
        hackathonId: 'hack_a',
        organizerId: 'org_1',
        submissionId: 'sub_a',
        judgeId: 'judge_1',
        judgeName: 'Judge One',
        criteriaScores: [
          {
            criterionId: 'crit_a',
            criterionName: 'Criterion Alpha',
            weight: 100,
            score: 82,
            scoreScale: '0_to_100',
            comment: 'Strong architecture and test evidence'
          }
        ],
        weightedTotal: 82,
        scoreScale: '0_to_100',
        conflictOfInterest: false,
        conflictReason: '',
        humanFeedback: '',
        aiReportSummary: '',
        aiInferenceSource: '',
        status: 'draft'
      }
    ]);

    fireEvent.click(saveDraftBtn);

    await waitFor(() => {
      expect(mockFns.saveEvaluation).toHaveBeenCalledTimes(2);
      expect(
        screen.getByText(/Evaluation draft saved to Cloud Firestore \(82\.00\/100\)/i)
      ).toBeTruthy();
      expect(screen.queryByText('Simulated Firestore write failure')).toBeNull();
    });
  });

  it('displays recovery banner when evaluation status is finalizing and allows completing final submission', async () => {
    mockFns.listJudgeEvaluations.mockResolvedValue([
      {
        id: 'sub_a_judge_1',
        hackathonId: 'hack_a',
        organizerId: 'org_1',
        submissionId: 'sub_a',
        judgeId: 'judge_1',
        judgeName: 'Judge One',
        criteriaScores: [
          {
            criterionId: 'crit_a',
            criterionName: 'Criterion Alpha',
            weight: 100,
            score: 90,
            scoreScale: '0_to_100',
            comment: 'Recovered'
          }
        ],
        weightedTotal: 90,
        scoreScale: '0_to_100',
        scoredCriterionCount: 1,
        storageSchema: 'v2_subcollection',
        conflictOfInterest: false,
        conflictReason: '',
        humanFeedback: 'Interrupted submit',
        aiReportSummary: '',
        aiInferenceSource: '',
        status: 'finalizing'
      }
    ]);
    mockFns.saveEvaluation.mockResolvedValueOnce(undefined);

    renderUnifiedJudgingPage();

    await waitFor(() => {
      expect(
        screen.getByText(/Previous final submission was interrupted before completion/i)
      ).toBeTruthy();
    });

    const submitFinalBtn = screen.getByRole('button', {
      name: 'Finalize & Approve Official Evaluation'
    }) as HTMLButtonElement;
    fireEvent.click(submitFinalBtn);

    await waitFor(() => {
      expect(mockFns.saveEvaluation).toHaveBeenCalledWith(
        expect.objectContaining({
          submissionId: 'sub_a',
          scoreScale: '0_to_100',
          status: 'submitted'
        }),
        expect.objectContaining({
          rubric: hackA.rubric
        })
      );
    });
  });

  it('supports assignment acceptance and submission-level conflict of interest submission with 0 criteria', async () => {
    mockFns.listJudgeAssignmentsByJudge.mockResolvedValue([
      {
        ...assignments[0],
        status: 'invited'
      }
    ]);
    mockFns.listJudgeAssignedSubmissions.mockResolvedValue([]);

    renderUnifiedJudgingPage();

    const acceptBtn = await screen.findByRole('button', { name: 'Accept' });
    mockFns.listJudgeAssignmentsByJudge.mockResolvedValue([assignments[0]]);
    mockFns.listJudgeAssignedSubmissions.mockResolvedValue([subA]);
    fireEvent.click(acceptBtn);

    await waitFor(() => {
      expect(mockFns.updateJudgeAssignmentResponse).toHaveBeenCalledWith({
        assignmentId: 'hack_a_judge_1',
        status: 'accepted',
        conflictDeclared: false,
        conflictNotes: ''
      });
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Submission Alpha' })).toBeTruthy();
    });

    const coiCheckbox = screen.getByRole('checkbox', {
      name: /Declare Conflict of Interest for this submission/i
    }) as HTMLInputElement;
    fireEvent.click(coiCheckbox);

    const reasonBox = screen.getByPlaceholderText(
      /Describe the conflict of interest reason/i
    ) as HTMLTextAreaElement;
    fireEvent.change(reasonBox, { target: { value: 'Former teammate of the submitter' } });

    mockFns.saveEvaluation.mockResolvedValueOnce(undefined);
    fireEvent.click(
      screen.getByRole('button', { name: 'Finalize & Approve Official Evaluation' })
    );

    await waitFor(() => {
      expect(mockFns.saveEvaluation).toHaveBeenCalledWith(
        expect.objectContaining({
          submissionId: 'sub_a',
          conflictOfInterest: true,
          conflictReason: 'Former teammate of the submitter',
          criteriaScores: [],
          weightedTotal: 0,
          status: 'submitted'
        }),
        expect.anything()
      );
    });
  });
});
