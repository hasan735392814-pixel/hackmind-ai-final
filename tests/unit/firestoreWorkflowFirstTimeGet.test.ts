import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetDoc = vi.fn();
const mockGetDocs = vi.fn();
const mockSetDoc = vi.fn();
const mockUpdateDoc = vi.fn();
const mockDeleteDoc = vi.fn();
const mockBatchSet = vi.fn();
const mockBatchUpdate = vi.fn();
const mockBatchCommit = vi.fn();

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  collection: vi.fn((_, ...segments: string[]) => ({ path: segments.join('/') })),
  doc: vi.fn((_, ...segments: string[]) => ({
    col: segments[0],
    id: segments[segments.length - 1],
    path: segments.join('/')
  })),
  query: vi.fn((col) => col),
  where: vi.fn(() => ({})),
  getDoc: (...args: unknown[]) => mockGetDoc(...args),
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
  setDoc: (...args: unknown[]) => mockSetDoc(...args),
  updateDoc: (...args: unknown[]) => mockUpdateDoc(...args),
  deleteDoc: (...args: unknown[]) => mockDeleteDoc(...args),
  writeBatch: vi.fn(() => ({
    set: mockBatchSet,
    update: mockBatchUpdate,
    commit: mockBatchCommit
  })),
  serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP')
}));

vi.mock('../../src/services/firebase/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/firebase/config')>();
  return {
    ...actual,
    db: {},
    auth: { currentUser: null }
  };
});

import {
  assignJudgeToHackathon,
  getHackathonResults,
  saveEvaluation,
  saveHackathonResults
} from '../../src/services/firebase/firestoreService';

describe('First-Time Nonexistent Document Get -> Create/Update & Permission Error Workflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBatchCommit.mockResolvedValue(undefined);
    mockSetDoc.mockResolvedValue(undefined);
    mockUpdateDoc.mockResolvedValue(undefined);
    mockDeleteDoc.mockResolvedValue(undefined);
    mockGetDocs.mockResolvedValue({ docs: [] });
  });

  it('assignJudgeToHackathon reads judgeAssignments/{hid}_{jid}, creates when missing, updates when existing, and marks submitted submissions under_review', async () => {
    // 1. First-time assignment: judgeAssignment missing, submission exists with status=submitted
    mockGetDoc
      .mockResolvedValueOnce({ exists: () => false })
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'sub_1',
        data: () => ({ id: 'sub_1', status: 'submitted' })
      });

    await assignJudgeToHackathon({
      hackathonId: 'hack_m3abc_9f8e7d',
      organizerId: 'org_1',
      judgeId: 'judge_1',
      judgeName: 'Dr. Ada',
      submissionIds: ['sub_1']
    });

    expect(mockGetDoc).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ col: 'judgeAssignments', id: 'hack_m3abc_9f8e7d_judge_1' })
    );
    expect(mockBatchSet).toHaveBeenCalledWith(
      expect.objectContaining({ col: 'judgeAssignments', id: 'hack_m3abc_9f8e7d_judge_1' }),
      expect.objectContaining({
        id: 'hack_m3abc_9f8e7d_judge_1',
        hackathonId: 'hack_m3abc_9f8e7d',
        organizerId: 'org_1',
        judgeId: 'judge_1',
        status: 'invited',
        conflictDeclared: false,
        assignedSubmissionIds: ['sub_1']
      })
    );
    expect(mockBatchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ col: 'submissions', id: 'sub_1' }),
      expect.objectContaining({ status: 'under_review' })
    );
    expect(mockBatchCommit).toHaveBeenCalledTimes(1);

    // 2. Subsequent update when judgeAssignment already exists
    vi.clearAllMocks();
    mockBatchCommit.mockResolvedValue(undefined);
    mockGetDoc
      .mockResolvedValueOnce({ exists: () => true, data: () => ({ id: 'hack_m3abc_9f8e7d_judge_1' }) })
      .mockResolvedValueOnce({ exists: () => true, id: 'sub_1', data: () => ({ id: 'sub_1', status: 'under_review' }) });

    await assignJudgeToHackathon({
      hackathonId: 'hack_m3abc_9f8e7d',
      organizerId: 'org_1',
      judgeId: 'judge_1',
      judgeName: 'Dr. Ada',
      submissionIds: ['sub_1']
    });

    expect(mockBatchSet).not.toHaveBeenCalled();
    expect(mockBatchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ col: 'judgeAssignments', id: 'hack_m3abc_9f8e7d_judge_1' }),
      expect.objectContaining({ assignedSubmissionIds: ['sub_1'] })
    );
  });

  it('saveEvaluation reads evaluations/{subId}_{judgeId}, writes normalized subcollection criteria, and transitions draft -> finalizing -> submitted', async () => {
    const score = {
      criterionId: 'crit_1',
      criterionName: 'Innovation',
      weight: 100,
      score: 8,
      comment: 'Solid'
    };
    const baseEval = {
      hackathonId: 'hack_1',
      organizerId: 'org_1',
      submissionId: 'sub_m3abc_9f8e7d',
      judgeId: 'judge_1',
      judgeName: 'Dr. Ada',
      criteriaScores: [score],
      weightedTotal: 80,
      conflictOfInterest: false,
      conflictReason: '',
      humanFeedback: 'Strong architecture',
      aiReportSummary: '',
      aiInferenceSource: 'CLOUD',
      status: 'draft' as const
    };

    // First save (nonexistent draft)
    mockGetDoc.mockResolvedValueOnce({ exists: () => false });
    mockGetDocs.mockResolvedValueOnce({ docs: [] });
    await saveEvaluation(baseEval);
    expect(mockGetDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'evaluations/sub_m3abc_9f8e7d_judge_1' })
    );
    expect(mockSetDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'evaluations/sub_m3abc_9f8e7d_judge_1' }),
      expect.objectContaining({
        criteriaScores: [],
        scoredCriterionCount: 1,
        storageSchema: 'v2_subcollection',
        weightedTotal: 80,
        status: 'draft'
      })
    );
    expect(mockSetDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'evaluations/sub_m3abc_9f8e7d_judge_1/criteria/crit_1' }),
      expect.objectContaining({ criterionId: 'crit_1', score: 8, weight: 100 })
    );
    expect(mockUpdateDoc).not.toHaveBeenCalled();

    // Update existing draft -> final submission (transitions finalizing -> read-back verify -> submitted)
    vi.clearAllMocks();
    mockSetDoc.mockResolvedValue(undefined);
    mockUpdateDoc.mockResolvedValue(undefined);
    mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => ({ status: 'draft' }) });
    // First getDocs sees empty existing subcollection, second getDocs verifies persisted doc before submitting
    mockGetDocs
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({
        docs: [
          {
            id: 'crit_1',
            data: () => ({
              criterionId: 'crit_1',
              evaluationId: 'sub_m3abc_9f8e7d_judge_1',
              hackathonId: 'hack_1',
              submissionId: 'sub_m3abc_9f8e7d',
              judgeId: 'judge_1',
              criterionName: 'Innovation',
              weight: 100,
              score: 8,
              comment: 'Solid'
            })
          }
        ]
      });

    await saveEvaluation(
      { ...baseEval, status: 'submitted' },
      { rubric: [{ id: 'crit_1', name: 'Innovation', description: '', weight: 100 }] }
    );
    expect(mockUpdateDoc).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ path: 'evaluations/sub_m3abc_9f8e7d_judge_1' }),
      expect.objectContaining({ status: 'finalizing', criteriaScores: [], scoredCriterionCount: 1 })
    );
    expect(mockSetDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'evaluations/sub_m3abc_9f8e7d_judge_1/criteria/crit_1' }),
      expect.objectContaining({ criterionId: 'crit_1', score: 8, weight: 100 })
    );
    expect(mockUpdateDoc).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ path: 'evaluations/sub_m3abc_9f8e7d_judge_1' }),
      expect.objectContaining({
        status: 'submitted',
        weightedTotal: 80,
        scoredCriterionCount: 1,
        submittedAt: 'SERVER_TIMESTAMP'
      })
    );
  });

  it('saveHackathonResults and getHackathonResults handle missing and existing hackathonResults/{hid} cleanly', async () => {
    mockGetDoc.mockResolvedValueOnce({ exists: () => false });
    const missing = await getHackathonResults('hack_m3abc_9f8e7d');
    expect(missing).toBeNull();

    // First-time draft save (missing -> batch.set without completing hackathon)
    mockGetDoc.mockResolvedValueOnce({ exists: () => false });
    await saveHackathonResults({
      hackathonId: 'hack_m3abc_9f8e7d',
      organizerId: 'org_1',
      published: false,
      rankings: []
    });
    expect(mockBatchSet).toHaveBeenCalledWith(
      expect.objectContaining({ col: 'hackathonResults', id: 'hack_m3abc_9f8e7d' }),
      expect.objectContaining({ hackathonId: 'hack_m3abc_9f8e7d', published: false })
    );
    expect(mockBatchUpdate).not.toHaveBeenCalled();

    // Publish existing draft -> batch.update on hackathonResults + hackathons atomic completion
    vi.clearAllMocks();
    mockBatchCommit.mockResolvedValue(undefined);
    mockGetDoc.mockResolvedValueOnce({ exists: () => true });
    await saveHackathonResults({
      hackathonId: 'hack_m3abc_9f8e7d',
      organizerId: 'org_1',
      published: true,
      rankings: []
    });
    expect(mockBatchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ col: 'hackathonResults', id: 'hack_m3abc_9f8e7d' }),
      expect.objectContaining({ published: true })
    );
    expect(mockBatchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ col: 'hackathons', id: 'hack_m3abc_9f8e7d' }),
      expect.objectContaining({ resultsPublished: true, status: 'completed' })
    );
  });

  it('preserves genuine PERMISSION_DENIED errors from initial getDoc across all three workflows', async () => {
    mockGetDoc.mockRejectedValueOnce(new Error('Missing or insufficient permissions.'));
    await expect(
      assignJudgeToHackathon({
        hackathonId: 'hack_1',
        organizerId: 'org_1',
        judgeId: 'judge_1',
        judgeName: 'Dr. Ada',
        submissionIds: []
      })
    ).rejects.toThrow(/Missing or insufficient permissions\./);

    mockGetDoc.mockRejectedValueOnce(new Error('Missing or insufficient permissions.'));
    await expect(
      saveEvaluation({
        hackathonId: 'hack_1',
        organizerId: 'org_1',
        submissionId: 'sub_1',
        judgeId: 'judge_1',
        judgeName: 'Dr. Ada',
        criteriaScores: [],
        weightedTotal: 50,
        conflictOfInterest: false,
        conflictReason: '',
        humanFeedback: '',
        aiReportSummary: '',
        aiInferenceSource: 'CLOUD',
        status: 'draft'
      })
    ).rejects.toThrow(/Missing or insufficient permissions\./);

    mockGetDoc.mockRejectedValueOnce(new Error('Missing or insufficient permissions.'));
    await expect(getHackathonResults('hack_1')).rejects.toThrow(/Missing or insufficient permissions\./);
  });

  it('saveEvaluation aborts before writing submitted when read-back verification detects a missing middle criterion', async () => {
    const rubric = [
      { id: 'c1', name: 'Innovation', description: 'Novelty', weight: 25 },
      { id: 'c2', name: 'Technical Depth', description: 'Architecture', weight: 30 },
      { id: 'c3', name: 'Impact', description: 'Usefulness', weight: 20 },
      { id: 'c4', name: 'Presentation', description: 'Clarity', weight: 25 }
    ];
    const desiredScores = [
      { criterionId: 'c1', criterionName: 'Innovation', weight: 25, score: 8, comment: '' },
      { criterionId: 'c2', criterionName: 'Technical Depth', weight: 30, score: 9, comment: '' },
      { criterionId: 'c3', criterionName: 'Impact', weight: 20, score: 8, comment: '' },
      { criterionId: 'c4', criterionName: 'Presentation', weight: 25, score: 7, comment: '' }
    ];

    mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => ({ status: 'draft' }) });
    // First getDocs sees empty subcollection; second read-back omits middle criterion 'c2'
    mockGetDocs
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({
        docs: desiredScores
          .filter((d) => d.criterionId !== 'c2')
          .map((d) => ({
            id: d.criterionId,
            data: () => ({
              criterionId: d.criterionId,
              evaluationId: 'sub_mid_judge_1',
              hackathonId: 'hack_1',
              submissionId: 'sub_mid',
              judgeId: 'judge_1',
              criterionName: d.criterionName,
              weight: d.weight,
              score: d.score,
              comment: d.comment
            })
          }))
      });

    await expect(
      saveEvaluation(
        {
          hackathonId: 'hack_1',
          organizerId: 'org_1',
          submissionId: 'sub_mid',
          judgeId: 'judge_1',
          judgeName: 'Dr. Ada',
          criteriaScores: desiredScores,
          weightedTotal: 80.5,
          conflictOfInterest: false,
          conflictReason: '',
          humanFeedback: '',
          aiReportSummary: '',
          aiInferenceSource: 'CLOUD',
          status: 'submitted'
        },
        { rubric }
      )
    ).rejects.toThrow(/Finalization verification mismatch: expected 4 persisted criteria, found 3/);

    // Parent moved to 'finalizing', but NEVER transitioned to 'submitted'
    expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
    expect(mockUpdateDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'evaluations/sub_mid_judge_1' }),
      expect.objectContaining({ status: 'finalizing' })
    );
    expect(mockUpdateDoc).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'submitted' })
    );
  });
});
