// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  Hackathon,
  JudgeAssignment,
  ProjectSubmission
} from '../../src/types/domain';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

import { LanguageProvider } from '../../src/contexts/LanguageContext';

const mockAuthValue = vi.hoisted(() => ({
  user: { uid: 'judge_1', displayName: 'Judge One' },
  profile: { uid: 'judge_1', displayName: 'Judge One', approvedRole: 'judge' },
  privateInfo: { aiCloudConsent: false },
  emailVerified: true,
  updateCloudConsent: vi.fn()
}));

const mockFns = vi.hoisted(() => ({
  listJudgeAssignmentsByJudge: vi.fn(),
  listJudgeAssignedSubmissions: vi.fn(),
  listJudgeEvaluations: vi.fn(),
  getHackathonById: vi.fn(),
  saveEvaluation: vi.fn(),
  updateJudgeAssignmentResponse: vi.fn()
}));

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => mockAuthValue
}));

vi.mock('../../src/services/firebase/firestoreService', () => mockFns);

import { JudgeWorkspacePage } from '../../src/pages/JudgeWorkspacePage';

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

describe('JudgeWorkspacePage — Save & Switch Race Regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFns.listJudgeAssignmentsByJudge.mockResolvedValue(assignments);
    mockFns.listJudgeAssignedSubmissions.mockResolvedValue([subA, subB]);
    mockFns.listJudgeEvaluations.mockResolvedValue([]);
    mockFns.getHackathonById.mockImplementation(async (hid: string) =>
      hid === 'hack_a' ? hackA : hackB
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('prevents submission switching during active evaluation save and completes without corrupting active submission state', async () => {
    const deferredSave = createDeferred<void>();
    mockFns.saveEvaluation.mockReturnValue(deferredSave.promise);

    render(
      <LanguageProvider>
        <JudgeWorkspacePage />
      </LanguageProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Submission Alpha' })).toBeTruthy();
    });

    const scoreInput = screen.getByLabelText('Criterion Alpha score') as HTMLInputElement;
    fireEvent.change(scoreInput, { target: { value: '8' } });

    const saveDraftBtn = screen.getByRole('button', { name: 'Save Draft' }) as HTMLButtonElement;
    fireEvent.click(saveDraftBtn);

    // While save is in flight, submission switcher buttons and save buttons must be locked
    const subBButton = screen.getByRole('button', { name: /Submission Beta/i }) as HTMLButtonElement;
    await waitFor(() => {
      expect(subBButton.disabled).toBe(true);
      expect(saveDraftBtn.disabled).toBe(true);
    });

    // Attempting to click disabled switcher during save must not switch active submission
    fireEvent.click(subBButton);
    expect(screen.getByRole('heading', { name: 'Submission Alpha' })).toBeTruthy();

    // Update mock evaluation list to reflect saved draft before resolving save
    mockFns.listJudgeEvaluations.mockResolvedValue([
      {
        id: 'sub_a_judge_1',
        hackathonId: 'hack_a',
        organizerId: 'org_1',
        submissionId: 'sub_a',
        judgeId: 'judge_1',
        judgeName: 'Judge One',
        criteriaScores: [
          { criterionId: 'crit_a', criterionName: 'Criterion Alpha', weight: 100, score: 8, comment: '' }
        ],
        weightedTotal: 80,
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
      expect(screen.getByText(/Evaluation draft saved \(80\/100\)/i)).toBeTruthy();
      expect(subBButton.disabled).toBe(false);
    });

    // After save completes, judge can cleanly switch to Submission Beta
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
        // Call 1 (loadJudgeData) returns null so hackathonMap does not cache hack_a;
        // Call 2 (initial selectSubmission(subA)) resolves hackA immediately;
        // Call 3+ (explicit click on subA) returns deferred promise to simulate slow response.
        if (callsForA === 1) return Promise.resolve(null);
        if (callsForA === 2) return Promise.resolve(hackA);
        return hackADeferred.promise;
      }
      callsForB += 1;
      // Call 1 (loadJudgeData) returns null so hackathonMap does not cache hack_b;
      // Call 2+ (click on subB) returns deferred promise.
      return callsForB === 1 ? Promise.resolve(null) : hackBDeferred.promise;
    });

    render(
      <LanguageProvider>
        <JudgeWorkspacePage />
      </LanguageProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Submission Alpha' })).toBeTruthy();
      expect(screen.getByLabelText('Criterion Alpha score')).toBeTruthy();
    });

    // Switch away to Beta while Alpha hackathon lookup is pending if re-selected, then back and forth rapidly
    const subAButton = screen.getByRole('button', { name: /Submission Alpha/i });
    const subBButton = screen.getByRole('button', { name: /Submission Beta/i });

    // Trigger second fetch for hackA (pending), then immediately switch to Beta (pending)
    fireEvent.click(subAButton);
    fireEvent.click(subBButton);

    // Resolve Beta first, then resolve stale Alpha late
    hackBDeferred.resolve(hackB);
    await waitFor(() => {
      expect(screen.getByLabelText('Criterion Beta score')).toBeTruthy();
    });

    hackADeferred.resolve(hackA);
    // Give microtask queue a turn and confirm Beta rubric was NOT overwritten by stale Alpha resolution
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Submission Beta' })).toBeTruthy();
      expect(screen.getByLabelText('Criterion Beta score')).toBeTruthy();
      expect(screen.queryByLabelText('Criterion Alpha score')).toBeNull();
    });
  });

  it('recovers cleanly from a failed Firestore save, preserves unsaved scores and comments, resets saveBusy, and allows retry', async () => {
    const failedSave = createDeferred<void>();
    mockFns.saveEvaluation.mockReturnValueOnce(failedSave.promise);

    render(
      <LanguageProvider>
        <JudgeWorkspacePage />
      </LanguageProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Submission Alpha' })).toBeTruthy();
    });

    const scoreInput = screen.getByLabelText('Criterion Alpha score') as HTMLInputElement;
    const commentInput = screen.getByPlaceholderText(
      'Evidence note for this criterion...'
    ) as HTMLInputElement;

    fireEvent.change(scoreInput, { target: { value: '8' } });
    fireEvent.change(commentInput, { target: { value: 'Strong architecture and test evidence' } });

    const saveDraftBtn = screen.getByRole('button', { name: 'Save Draft' }) as HTMLButtonElement;
    const submitFinalBtn = screen.getByRole('button', {
      name: 'Submit Final Human Evaluation'
    }) as HTMLButtonElement;
    const subBButton = screen.getByRole('button', { name: /Submission Beta/i }) as HTMLButtonElement;

    fireEvent.click(saveDraftBtn);

    await waitFor(() => {
      expect(saveDraftBtn.disabled).toBe(true);
      expect(submitFinalBtn.disabled).toBe(true);
      expect(subBButton.disabled).toBe(true);
    });

    // Simulate failed Firestore write
    failedSave.reject(new Error('Simulated Firestore write failure'));

    await waitFor(() => {
      expect(screen.getByText('Simulated Firestore write failure')).toBeTruthy();
      expect(saveDraftBtn.disabled).toBe(false);
      expect(submitFinalBtn.disabled).toBe(false);
      expect(subBButton.disabled).toBe(false);
    });

    // Unsaved score and criterion comment must remain intact after failure
    expect((screen.getByLabelText('Criterion Alpha score') as HTMLInputElement).value).toBe('8');
    expect(
      (screen.getByPlaceholderText('Evidence note for this criterion...') as HTMLInputElement).value
    ).toBe('Strong architecture and test evidence');

    // Retry saving succeeds with intact inputs
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
            score: 8,
            comment: 'Strong architecture and test evidence'
          }
        ],
        weightedTotal: 80,
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
      expect(screen.getByText(/Evaluation draft saved \(80\/100\)/i)).toBeTruthy();
      expect(screen.queryByText('Simulated Firestore write failure')).toBeNull();
    });
  });

  it('displays Resume Audit controls for interrupted batch checkpoints, clears on switch, and unlocks actions immediately on cancel', async () => {
    const store = new Map<string, string>();
    store.set(
      'hackmind_judge_batch_ckpt_v1:sub_a',
      JSON.stringify({
        version: 1,
        submissionId: 'sub_a',
        repoFullName: 'acme/alpha',
        commitSha: 'abc1234',
        locale: 'en',
        totalBatches: 4,
        completedBatches: 2,
        batchPlanPaths: [['a.ts'], ['b.ts'], ['c.ts'], ['d.ts']],
        inspectedPaths: ['a.ts', 'b.ts'],
        validatedBatchOutputs: [],
        lastStatusIndicator: 'CLOUD',
        lastModelIdentifier: 'gemini-2.5-pro',
        interrupted: true,
        updatedAt: '2026-11-22T00:00:00Z'
      })
    );
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear()
    });

    const deferredFetch = createDeferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => deferredFetch.promise)
    );

    render(
      <LanguageProvider>
        <JudgeWorkspacePage />
      </LanguageProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Resume Audit (Batch 3/4)' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Restart Fresh' })).toBeTruthy();
    });

    // Switch to sub_b (no checkpoint) -> resume controls disappear cleanly
    const subBButton = screen.getByRole('button', { name: /Submission Beta/i });
    fireEvent.click(subBButton);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Submission Beta' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Resume Audit/i })).toBeNull();
    });

    // Start deterministic evidence collection on sub_b, then immediately cancel -> Save Draft & Submit Final & Inspect become available immediately
    expect(screen.getByText(/Legacy Live Gemini Execution Disabled/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open Protected Judging V2/i }).getAttribute('href')).toBe('/app/judging-v2');
    expect(screen.queryByText(/Prefer On-Device/i)).toBeNull();

    const auditBtn = screen.getByRole('button', { name: 'Inspect Repo Evidence (0 Gemini)' }) as HTMLButtonElement;
    fireEvent.click(auditBtn);

    const cancelBtn = await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(screen.getByText('Evidence inspection cancelled.')).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Save Draft' }) as HTMLButtonElement).disabled).toBe(false);
      expect(
        (screen.getByRole('button', { name: 'Submit Final Human Evaluation' }) as HTMLButtonElement).disabled
      ).toBe(false);
      expect(
        (screen.getByRole('button', { name: 'Inspect Repo Evidence (0 Gemini)' }) as HTMLButtonElement).disabled
      ).toBe(false);
    });

    deferredFetch.reject(new DOMException('Aborted', 'AbortError'));
    vi.unstubAllGlobals();
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
          { criterionId: 'crit_a', criterionName: 'Criterion Alpha', weight: 100, score: 9, comment: 'Recovered' }
        ],
        weightedTotal: 90,
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

    render(
      <LanguageProvider>
        <JudgeWorkspacePage />
      </LanguageProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Previous final submission was interrupted before completion/i)).toBeTruthy();
      expect(screen.getByText(/weighted total is client-calculated for display/i)).toBeTruthy();
    });

    const submitFinalBtn = screen.getByRole('button', {
      name: 'Submit Final Human Evaluation'
    }) as HTMLButtonElement;
    fireEvent.click(submitFinalBtn);

    await waitFor(() => {
      expect(mockFns.saveEvaluation).toHaveBeenCalledWith(
        expect.objectContaining({
          submissionId: 'sub_a',
          status: 'submitted'
        }),
        expect.objectContaining({
          rubric: hackA.rubric
        })
      );
    });
  });

  it('uses inline confirmation for Restart Fresh without window.confirm, supports Cancel Restart, and preserves prior checkpoint if discovery/Batch 1 fails (with 0 Gemini calls)', async () => {
    const store = new Map<string, string>();
    const initialCheckpoint = {
      version: 1,
      submissionId: 'sub_a',
      repoFullName: 'acme/alpha',
      commitSha: 'abc1234',
      locale: 'en',
      totalBatches: 4,
      completedBatches: 2,
      batchPlanPaths: [['src/a.ts'], ['src/b.ts'], ['src/c.ts'], ['src/d.ts']],
      inspectedPaths: ['src/a.ts', 'src/b.ts'],
      validatedBatchOutputs: [],
      lastStatusIndicator: 'CLOUD',
      lastModelIdentifier: 'gemini-4-hydrogen',
      interrupted: true,
      updatedAt: '2026-11-22T00:00:00Z'
    };
    store.set('hackmind_judge_batch_ckpt_v1:sub_a', JSON.stringify(initialCheckpoint));
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear()
    });

    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'https://api.github.com/repos/acme/alpha') {
          return new Response('Rate limited', { status: 403 });
        }
        return new Response('Not Found', { status: 404 });
      })
    );

    render(
      <LanguageProvider>
        <JudgeWorkspacePage />
      </LanguageProvider>
    );

    const restartBtn = await screen.findByRole('button', { name: 'Restart Fresh' });
    fireEvent.click(restartBtn);

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/Restart audit from Batch 1\? Your saved checkpoint \(2\/4 batch\(es\)/i)).toBeTruthy();

    // Cancel Restart closes inline confirmation without wiping checkpoint
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Restart' }));
    expect(screen.queryByRole('button', { name: 'Confirm Restart Fresh' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume Audit (Batch 3/4)' })).toBeTruthy();

    // Confirm Restart Fresh -> GitHub discovery fails at 0 batches (0 Gemini calls) -> prior 2/4 checkpoint restored
    fireEvent.click(screen.getByRole('button', { name: 'Restart Fresh' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Restart Fresh' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Resume Audit (Batch 3/4)' })).toBeTruthy();
    });
    const saved = JSON.parse(store.get('hackmind_judge_batch_ckpt_v1:sub_a') || '{}');
    expect(saved.completedBatches).toBe(2);
    expect(saved.commitSha).toBe('abc1234');

    vi.unstubAllGlobals();
  });
});

