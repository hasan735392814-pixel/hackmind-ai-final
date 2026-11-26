import { describe, expect, it } from 'vitest';
import {
  isDeadlinePassed,
  isValidFirestoreId,
  isValidGitHubRepoUrl,
  isValidHttpUrl,
  parseGitHubOwnerRepo,
  sanitizeString
} from '../../src/utils/validation';
import {
  calculateDraftWeightedPreview,
  calculateWeightedTotal,
  calculateWeightedTotalStrict,
  clearHumanCriterionScore,
  computeFairRankings,
  hydrateEvaluationScoresAndTotal,
  initializeHumanCriteriaScores,
  JudgeWorkspaceRunCoordinator,
  setHumanCriterionScore,
  validateEvaluationSubmission,
  validateRubricWeights
} from '../../src/services/judging/fairJudgingEngine';
import { computeFairTeammateMatches } from '../../src/services/matching/teamMatching';
import type { Evaluation, ProjectSubmission, RubricCriterion, UserProfile } from '../../src/types/domain';

describe('Validation & Deadline Utilities', () => {
  it('validates http/https URLs and rejects javascript: schemes', () => {
    expect(isValidHttpUrl('https://github.com/org/repo')).toBe(true);
    expect(isValidHttpUrl('http://localhost:3000')).toBe(true);
    expect(isValidHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isValidHttpUrl('not-a-url')).toBe(false);
  });

  it('parses and validates GitHub repository URLs accurately', () => {
    expect(isValidGitHubRepoUrl('https://github.com/firebase/firebase-js-sdk')).toBe(true);
    expect(isValidGitHubRepoUrl('https://github.com/only-owner')).toBe(false);
    expect(isValidGitHubRepoUrl('https://gitlab.com/org/repo')).toBe(false);
    expect(parseGitHubOwnerRepo('https://github.com/acme/hackmind-ai.git')).toEqual({
      owner: 'acme',
      repo: 'hackmind-ai'
    });
  });

  it('enforces deadlines and Firestore ID constraints', () => {
    const fixedNow = new Date('2026-12-01T12:00:00Z');
    expect(isDeadlinePassed('2026-12-01T11:59:00Z', fixedNow)).toBe(true);
    expect(isDeadlinePassed('2026-12-01T13:00:00Z', fixedNow)).toBe(false);
    expect(isValidFirestoreId('hack_2026-final')).toBe(true);
    expect(isValidFirestoreId('bad/id$here')).toBe(false);
    expect(sanitizeString('Hello\u0000World  ', 10)).toBe('HelloWorld');
  });

  it('generates and normalizes cryptographic join tokens, double-hash proof/verifier, and safe internal app links', async () => {
    const {
      deriveJoinCodeProofAndVerifier,
      generateSecureJoinToken,
      isValidInternalAppLink,
      normalizeJoinToken,
      sha256Hex
    } = await import('../../src/utils/validation');
    const token = generateSecureJoinToken();
    expect(token).toMatch(/^HM-[0-9A-F]{32}$/);
    expect(normalizeJoinToken(`  ${token.toLowerCase()} `)).toBe(token);
    expect(normalizeJoinToken(` hm\u2014 ${token.slice(3, 12).toLowerCase()}\n${token.slice(12)} `)).toBe(
      token
    );
    const { normalizedToken, proof, verifierHash } = await deriveJoinCodeProofAndVerifier(
      `  ${token.toLowerCase()} `
    );
    expect(normalizedToken).toBe(token);
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    expect(verifierHash).toMatch(/^[0-9a-f]{64}$/);
    expect(proof).not.toBe(verifierHash);
    expect(await sha256Hex(proof)).toBe(verifierHash);
    expect(isValidInternalAppLink('/app/teams')).toBe(true);
    expect(isValidInternalAppLink('/app')).toBe(true);
    expect(isValidInternalAppLink('https://evil.example/phish')).toBe(false);
    expect(isValidInternalAppLink('javascript:alert(1)')).toBe(false);
  });
});

describe('Fair Judging Engine', () => {
  it('validates rubric weights sum to 100 and calculates weighted totals', () => {
    expect(
      validateRubricWeights([
        { id: '1', name: 'Innovation', description: '', weight: 40 },
        { id: '2', name: 'Tech', description: '', weight: 60 }
      ])
    ).toEqual({ valid: true, sum: 100 });

    expect(
      validateRubricWeights([
        { id: '1', name: 'Innovation', description: '', weight: 40 },
        { id: '2', name: 'Tech', description: '', weight: 40 }
      ])
    ).toEqual({ valid: false, sum: 80 });

    const total = calculateWeightedTotal([
      { criterionId: '1', criterionName: 'Innovation', weight: 50, score: 8, comment: '' },
      { criterionId: '2', criterionName: 'Tech', weight: 50, score: 10, comment: '' }
    ]);
    expect(total).toBe(90);
  });

  it('initializes new human evaluations as unscored, blocks final submission until all criteria are scored, and preserves saved evaluations', () => {
    const rubric: RubricCriterion[] = [
      { id: 'c1', name: 'Innovation', description: 'Novelty', weight: 40 },
      { id: 'c2', name: 'Execution', description: 'Implementation', weight: 60 }
    ];

    // New evaluation: strictly unscored (no prefilled 7/10 or 70/100)
    const initial = initializeHumanCriteriaScores(rubric, null);
    expect(initial).toHaveLength(2);
    expect(initial.every((c) => c.score === null && c.scored === false)).toBe(true);
    expect(calculateDraftWeightedPreview(initial)).toEqual({
      total: null,
      scoredCount: 0,
      totalCount: 2,
      allScored: false
    });

    // Final submission blocked when criteria remain unscored, listing missing criteria names
    const finalBlocked = validateEvaluationSubmission({
      criteriaScores: initial,
      conflictOfInterest: false,
      conflictReason: '',
      submitFinal: true,
      locale: 'en'
    });
    expect(finalBlocked.valid).toBe(false);
    expect(finalBlocked.unscoredCriteria).toEqual(['Innovation', 'Execution']);
    expect(finalBlocked.errorMessage).toContain('Innovation');
    expect(finalBlocked.errorMessage).toContain('Execution');

    // Draft saving allowed with unscored criteria (saves [] rather than fabricated 7s)
    const draftEmpty = validateEvaluationSubmission({
      criteriaScores: initial,
      conflictOfInterest: false,
      conflictReason: '',
      submitFinal: false,
      locale: 'en'
    });
    expect(draftEmpty.valid).toBe(true);
    expect(draftEmpty.persistedScores).toEqual([]);
    expect(draftEmpty.weightedTotal).toBe(0);

    // Explicit scoring on first criterion only (including explicit 0 score) still blocks final submission
    const partial = setHumanCriterionScore(initial, 0, 0);
    expect(partial[0].score).toBe(0);
    expect(partial[0].scored).toBe(true);
    expect(partial[1].scored).toBe(false);

    const partialPreview = calculateDraftWeightedPreview(partial);
    expect(partialPreview.total).toBe(0);
    expect(partialPreview.scoredCount).toBe(1);
    expect(partialPreview.allScored).toBe(false);

    const partialFinalBlocked = validateEvaluationSubmission({
      criteriaScores: partial,
      conflictOfInterest: false,
      conflictReason: '',
      submitFinal: true,
      locale: 'en'
    });
    expect(partialFinalBlocked.valid).toBe(false);
    expect(partialFinalBlocked.unscoredCriteria).toEqual(['Execution']);

    // Partial draft saves ONLY explicitly scored criteria
    const partialDraft = validateEvaluationSubmission({
      criteriaScores: partial,
      conflictOfInterest: false,
      conflictReason: '',
      submitFinal: false,
      locale: 'en'
    });
    expect(partialDraft.valid).toBe(true);
    expect(partialDraft.persistedScores).toHaveLength(1);
    expect(partialDraft.persistedScores[0].criterionId).toBe('c1');

    // Loading partial draft restores saved score on c1 while keeping c2 unscored
    const reloadedPartial = initializeHumanCriteriaScores(rubric, {
      status: 'draft',
      criteriaScores: partialDraft.persistedScores
    });
    expect(reloadedPartial[0].score).toBe(0);
    expect(reloadedPartial[0].scored).toBe(true);
    expect(reloadedPartial[1].score).toBeNull();
    expect(reloadedPartial[1].scored).toBe(false);

    // Scoring remaining criterion unlocks final submission
    const completed = setHumanCriterionScore(reloadedPartial, 1, 9);
    const finalAllowed = validateEvaluationSubmission({
      criteriaScores: completed,
      conflictOfInterest: false,
      conflictReason: '',
      submitFinal: true,
      locale: 'en'
    });
    expect(finalAllowed.valid).toBe(true);
    expect(finalAllowed.persistedScores).toHaveLength(2);
    expect(finalAllowed.weightedTotal).toBe(54);

    // Clearing returns criterion cleanly back to unscored
    const cleared = clearHumanCriterionScore(completed, 1);
    expect(cleared[1].scored).toBe(false);
    expect(cleared[1].score).toBeNull();

    // Existing saved submitted evaluation (including historical score of 7) loads untouched
    const savedSubmitted = initializeHumanCriteriaScores(rubric, {
      status: 'submitted',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Innovation', weight: 40, score: 7, comment: 'Good' },
        { criterionId: 'c2', criterionName: 'Execution', weight: 60, score: 8, comment: 'Solid' }
      ]
    });
    expect(savedSubmitted.every((c) => c.scored)).toBe(true);
    expect(savedSubmitted[0].score).toBe(7);
    expect(savedSubmitted[1].score).toBe(8);
  });

  it('excludes conflicts of interest and flags judge disagreement anomalies', () => {
    const submissions: ProjectSubmission[] = [
      {
        id: 'sub_1',
        hackathonId: 'h1',
        organizerId: 'org1',
        teamId: 't1',
        teamName: 'Alpha',
        projectId: 'p1',
        ownerId: 'u1',
        memberIds: ['u1'],
        memberNames: ['Alice'],
        title: 'Project Alpha',
        shortDescription: 'Hybrid AI triage',
        fullDescription: '',
        problemStatement: '',
        proposedSolution: '',
        technologies: ['TypeScript'],
        githubUrl: 'https://github.com/a/b',
        demoUrl: '',
        videoUrl: '',
        screenshotUrls: [],
        track: 'AI',
        status: 'submitted'
      },
      {
        id: 'sub_2',
        hackathonId: 'h1',
        organizerId: 'org1',
        teamId: 't2',
        teamName: 'Beta',
        projectId: 'p2',
        ownerId: 'u2',
        memberIds: ['u2'],
        memberNames: ['Bob'],
        title: 'Project Beta',
        shortDescription: 'Edge sensors',
        fullDescription: '',
        problemStatement: '',
        proposedSolution: '',
        technologies: ['Python'],
        githubUrl: 'https://github.com/c/d',
        demoUrl: '',
        videoUrl: '',
        screenshotUrls: [],
        track: 'AI',
        status: 'submitted'
      }
    ];

    const evaluations: Evaluation[] = [
      {
        id: 'sub_1_j1',
        hackathonId: 'h1',
        organizerId: 'org1',
        submissionId: 'sub_1',
        judgeId: 'j1',
        judgeName: 'Judge 1',
        criteriaScores: [],
        weightedTotal: 92,
        conflictOfInterest: false,
        conflictReason: '',
        humanFeedback: 'Strong',
        aiReportSummary: '',
        aiInferenceSource: 'CLOUD',
        status: 'submitted'
      },
      {
        id: 'sub_1_j2',
        hackathonId: 'h1',
        organizerId: 'org1',
        submissionId: 'sub_1',
        judgeId: 'j2',
        judgeName: 'Judge 2',
        criteriaScores: [],
        weightedTotal: 65,
        conflictOfInterest: false,
        conflictReason: '',
        humanFeedback: 'Needs tests',
        aiReportSummary: '',
        aiInferenceSource: 'CLOUD',
        status: 'submitted'
      },
      {
        id: 'sub_2_j1',
        hackathonId: 'h1',
        organizerId: 'org1',
        submissionId: 'sub_2',
        judgeId: 'j1',
        judgeName: 'Judge 1',
        criteriaScores: [],
        weightedTotal: 98,
        conflictOfInterest: true,
        conflictReason: 'Mentored team',
        humanFeedback: '',
        aiReportSummary: '',
        aiInferenceSource: '',
        status: 'submitted'
      },
      {
        id: 'sub_2_j2',
        hackathonId: 'h1',
        organizerId: 'org1',
        submissionId: 'sub_2',
        judgeId: 'j2',
        judgeName: 'Judge 2',
        criteriaScores: [],
        weightedTotal: 84,
        conflictOfInterest: false,
        conflictReason: '',
        humanFeedback: 'Solid MVP',
        aiReportSummary: '',
        aiInferenceSource: 'CLOUD',
        status: 'submitted'
      }
    ];

    const rankings = computeFairRankings({
      submissions,
      evaluations,
      expectedJudgesPerSubmission: 2
    });

    expect(rankings).toHaveLength(2);
    expect(rankings[0].submissionId).toBe('sub_2');
    expect(rankings[0].averageScore).toBe(84); // 98 COI excluded
    expect(rankings[0].anomalyFlag).toBe(true); // 1/2 judges after COI exclusion
    expect(rankings[1].submissionId).toBe('sub_1');
    expect(rankings[1].disagreementSpread).toBe(27);
    expect(rankings[1].anomalyFlag).toBe(true);
  });
});

describe('Fair Smart Team Matching', () => {
  it('ranks complementary builders higher and excludes solo/already-teamed profiles', () => {
    const me: UserProfile = {
      uid: 'u_me',
      displayName: 'Me',
      title: 'Frontend Engineer',
      bio: '',
      skills: ['React', 'TypeScript'],
      experienceLevel: 'intermediate',
      interests: ['Healthcare'],
      preferredRoles: ['Frontend Lead'],
      preferredLanguages: ['English'],
      availability: 'full_time',
      teamPreference: 'looking_for_team',
      portfolioUrl: '',
      githubUrl: '',
      linkedinUrl: '',
      photoUrl: '',
      requestedRole: 'participant',
      approvedRole: 'participant'
    };

    const candidates: UserProfile[] = [
      me,
      {
        ...me,
        uid: 'u_ai',
        displayName: 'AI Builder',
        skills: ['Python', 'Firebase', 'TypeScript'],
        preferredRoles: ['AI Engineer'],
        teamPreference: 'open_to_join'
      },
      {
        ...me,
        uid: 'u_solo',
        displayName: 'Solo Builder',
        teamPreference: 'solo'
      }
    ];

    const matches = computeFairTeammateMatches(me, candidates);
    expect(matches).toHaveLength(1);
    expect(matches[0].candidate.uid).toBe('u_ai');
    expect(matches[0].complementarySkills).toContain('Python');
    expect(matches[0].score).toBeGreaterThan(50);
  });
});

describe('JudgeWorkspaceRunCoordinator — Cancel, AbortController & Submission Switch Guards', () => {
  it('immediately unlocks state on cancel, allows immediate restart, and prevents stale finally/results from interfering', () => {
    const coordinator = new JudgeWorkspaceRunCoordinator();

    const first = coordinator.startAnalysis();
    expect(first).not.toBeNull();
    expect(coordinator.isRunning).toBe(true);
    expect(coordinator.isCurrentAnalysis(first!)).toBe(true);

    // Clicking Cancel aborts first controller and unlocks immediately
    expect(coordinator.cancelAnalysis()).toBe(true);
    expect(first!.controller.signal.aborted).toBe(true);
    expect(coordinator.isRunning).toBe(false);
    expect(coordinator.isCurrentAnalysis(first!)).toBe(false);

    // Judge immediately starts a new inspection before the old async promise reaches finally
    const second = coordinator.startAnalysis();
    expect(second).not.toBeNull();
    expect(coordinator.isRunning).toBe(true);
    expect(coordinator.isCurrentAnalysis(second!)).toBe(true);

    // Stale first run settles and hits finally: MUST NOT clear second run
    expect(coordinator.finishAnalysis(first!)).toBe(false);
    expect(coordinator.isRunning).toBe(true);
    expect(coordinator.isCurrentAnalysis(second!)).toBe(true);

    // Active second run completes normally
    expect(coordinator.finishAnalysis(second!)).toBe(true);
    expect(coordinator.isRunning).toBe(false);
  });

  it('invalidates previous hackathon/analysis results on rapid submission switches', () => {
    const coordinator = new JudgeWorkspaceRunCoordinator();

    const selA = coordinator.beginSubmissionSwitch();
    const runDuringA = coordinator.startAnalysis();
    expect(runDuringA).not.toBeNull();
    expect(coordinator.isCurrentSelection(selA)).toBe(true);

    // Rapid switch to submission B
    const selB = coordinator.beginSubmissionSwitch('sub_b');
    expect(runDuringA!.controller.signal.aborted).toBe(true);
    expect(coordinator.isRunning).toBe(false);
    expect(coordinator.isCurrentSelection(selA)).toBe(false);
    expect(coordinator.isCurrentSelection(selB)).toBe(true);
    expect(coordinator.isCurrentAnalysis(runDuringA!)).toBe(false);
    expect(coordinator.currentSubmissionId).toBe('sub_b');
  });

  it('rejects invalid criterion IDs, duplicate criterion IDs, out-of-range scores, zero total weight, and invalid COI submissions', () => {
    const baseValid = {
      criterionId: 'c1',
      criterionName: 'Innovation',
      weight: 50,
      score: 8,
      scored: true,
      comment: ''
    };

    const invalidId = validateEvaluationSubmission({
      criteriaScores: [{ ...baseValid, criterionId: 'bad/id' }],
      conflictOfInterest: false,
      conflictReason: '',
      submitFinal: true
    });
    expect(invalidId.valid).toBe(false);

    const duplicateIds = validateEvaluationSubmission({
      criteriaScores: [
        { ...baseValid, criterionId: 'c1', weight: 50 },
        { ...baseValid, criterionId: 'c1', criterionName: 'Innovation Copy', weight: 50 }
      ],
      conflictOfInterest: false,
      conflictReason: '',
      submitFinal: true
    });
    expect(duplicateIds.valid).toBe(false);

    const negativeScore = validateEvaluationSubmission({
      criteriaScores: [{ ...baseValid, weight: 100, score: -1 }],
      conflictOfInterest: false,
      conflictReason: '',
      submitFinal: true
    });
    expect(negativeScore.valid).toBe(false);

    const overTenScore = validateEvaluationSubmission({
      criteriaScores: [{ ...baseValid, weight: 100, score: 11 }],
      conflictOfInterest: false,
      conflictReason: '',
      submitFinal: false
    });
    expect(overTenScore.valid).toBe(false);

    const zeroTotalWeight = validateEvaluationSubmission({
      criteriaScores: [{ ...baseValid, weight: 0, score: 8 }],
      conflictOfInterest: false,
      conflictReason: '',
      submitFinal: true
    });
    expect(zeroTotalWeight.valid).toBe(false);

    const emptyCoiReason = validateEvaluationSubmission({
      criteriaScores: [{ ...baseValid, weight: 100 }],
      conflictOfInterest: true,
      conflictReason: '   ',
      submitFinal: true
    });
    expect(emptyCoiReason.valid).toBe(false);

    const validCoi = validateEvaluationSubmission({
      criteriaScores: [{ ...baseValid, weight: 100 }],
      conflictOfInterest: true,
      conflictReason: 'Mentored the team prior to submission',
      submitFinal: true
    });
    expect(validCoi.valid).toBe(true);
    expect(validCoi.persistedScores).toEqual([]);
    expect(validCoi.weightedTotal).toBe(0);
  });

  it('syncs saved draft criteria to updated hackathon rubric weights and drops obsolete criteria', () => {
    const updatedRubric: RubricCriterion[] = [
      { id: 'c1', name: 'Innovation', description: 'Novelty', weight: 30 },
      { id: 'c2', name: 'Execution', description: 'Code quality', weight: 70 }
    ];
    const synced = initializeHumanCriteriaScores(updatedRubric, {
      status: 'draft',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Innovation', weight: 50, score: 9, comment: 'Strong' },
        { criterionId: 'obsolete', criterionName: 'Removed Criterion', weight: 50, score: 6, comment: 'Old' }
      ]
    });
    expect(synced).toHaveLength(2);
    expect(synced[0]).toMatchObject({ criterionId: 'c1', weight: 30, score: 9, scored: true, comment: 'Strong' });
    expect(synced[1]).toMatchObject({ criterionId: 'c2', weight: 70, score: null, scored: false });
  });

  it('guards save/switch and concurrent load sequences in JudgeWorkspaceRunCoordinator', () => {
    const coordinator = new JudgeWorkspaceRunCoordinator();

    const load1 = coordinator.beginLoad();
    expect(coordinator.isCurrentLoad(load1)).toBe(true);
    const load2 = coordinator.beginLoad();
    expect(coordinator.isCurrentLoad(load1)).toBe(false);
    expect(coordinator.isCurrentLoad(load2)).toBe(true);

    coordinator.beginSubmissionSwitch('sub_a');
    const saveA = coordinator.startSave('sub_a');
    expect(saveA).not.toBeNull();
    expect(coordinator.isSaving).toBe(true);
    expect(coordinator.isCurrentSave(saveA!)).toBe(true);
    // Concurrent double-save while saveA is in flight is blocked
    expect(coordinator.startSave('sub_a')).toBeNull();

    // If selection switches away while saveA is in flight, saveA token is no longer current for UI updates
    coordinator.beginSubmissionSwitch('sub_b');
    expect(coordinator.currentSubmissionId).toBe('sub_b');
    expect(coordinator.isCurrentSave(saveA!)).toBe(false);

    // Finishing saveA clears saving lock without reverting active submission
    expect(coordinator.finishSave(saveA!)).toBe(true);
    expect(coordinator.isSaving).toBe(false);
    expect(coordinator.currentSubmissionId).toBe('sub_b');
  });

  it('validates calculateWeightedTotalStrict, deterministically recomputes subcollection totals in hydrateEvaluationScoresAndTotal, and excludes finalizing evaluations from rankings', () => {
    const rubric: RubricCriterion[] = [
      { id: 'c1', name: 'Innovation', description: 'Novelty', weight: 25 },
      { id: 'c2', name: 'Technical Depth', description: 'Architecture', weight: 30 },
      { id: 'c3', name: 'Impact', description: 'Usefulness', weight: 20 },
      { id: 'c4', name: 'Presentation', description: 'Clarity', weight: 25 }
    ];

    const strictValid = calculateWeightedTotalStrict(
      [
        { criterionId: 'c1', criterionName: 'Innovation', weight: 25, score: 8.5, comment: '' },
        { criterionId: 'c2', criterionName: 'Technical Depth', weight: 30, score: 7.5, comment: '' },
        { criterionId: 'c3', criterionName: 'Impact', weight: 20, score: 9, comment: '' },
        { criterionId: 'c4', criterionName: 'Presentation', weight: 25, score: 8, comment: '' }
      ],
      rubric
    );
    expect(strictValid).toEqual({ valid: true, weightedTotal: 81.75 });

    const strictBadWeight = calculateWeightedTotalStrict(
      [
        { criterionId: 'c1', criterionName: 'Innovation', weight: 50, score: 8, comment: '' },
        { criterionId: 'c2', criterionName: 'Technical Depth', weight: 30, score: 7, comment: '' },
        { criterionId: 'c3', criterionName: 'Impact', weight: 20, score: 9, comment: '' },
        { criterionId: 'c4', criterionName: 'Presentation', weight: 25, score: 8, comment: '' }
      ],
      rubric
    );
    expect(strictBadWeight.valid).toBe(false);

    // Parent doc has stale/forged weightedTotal=99; hydration MUST recompute from persisted /criteria docs
    const parentForged: Evaluation = {
      id: 'sub_1_j1',
      hackathonId: 'h1',
      organizerId: 'org1',
      submissionId: 'sub_1',
      judgeId: 'j1',
      judgeName: 'Judge 1',
      criteriaScores: [],
      weightedTotal: 99,
      scoredCriterionCount: 4,
      storageSchema: 'v2_subcollection',
      conflictOfInterest: false,
      conflictReason: '',
      humanFeedback: '',
      aiReportSummary: '',
      aiInferenceSource: '',
      status: 'submitted'
    };

    const hydrated = hydrateEvaluationScoresAndTotal(parentForged, [
      { criterionId: 'c1', evaluationId: 'sub_1_j1', hackathonId: 'h1', submissionId: 'sub_1', judgeId: 'j1', criterionName: 'Innovation', weight: 25, score: 8.5, comment: '' },
      { criterionId: 'c2', evaluationId: 'sub_1_j1', hackathonId: 'h1', submissionId: 'sub_1', judgeId: 'j1', criterionName: 'Technical Depth', weight: 30, score: 7.5, comment: '' },
      { criterionId: 'c3', evaluationId: 'sub_1_j1', hackathonId: 'h1', submissionId: 'sub_1', judgeId: 'j1', criterionName: 'Impact', weight: 20, score: 9, comment: '' },
      { criterionId: 'c4', evaluationId: 'sub_1_j1', hackathonId: 'h1', submissionId: 'sub_1', judgeId: 'j1', criterionName: 'Presentation', weight: 25, score: 8, comment: '' }
    ]);
    expect(hydrated.weightedTotal).toBe(81.75);
    expect(hydrated.criteriaScores).toHaveLength(4);

    // Rankings exclude 'finalizing' and ignore parent forged total when criteria recompute differently
    const sub: ProjectSubmission = {
      id: 'sub_1',
      hackathonId: 'h1',
      organizerId: 'org1',
      teamId: 't1',
      teamName: 'Team',
      projectId: 'p1',
      ownerId: 'u1',
      memberIds: ['u1'],
      memberNames: ['Alice'],
      title: 'Project',
      shortDescription: 'Desc',
      fullDescription: '',
      problemStatement: '',
      proposedSolution: '',
      technologies: [],
      githubUrl: 'https://github.com/a/b',
      demoUrl: '',
      videoUrl: '',
      screenshotUrls: [],
      track: 'AI',
      status: 'submitted'
    };

    const rankings = computeFairRankings({
      submissions: [sub],
      evaluations: [
        { ...hydrated, weightedTotal: 99 }, // Even if caller passes stale total, computeFairRankings recalculates from hydrated.criteriaScores -> 81.75
        { ...hydrated, id: 'sub_1_j2', judgeId: 'j2', status: 'finalizing' }
      ],
      expectedJudgesPerSubmission: 2,
      rubric
    });
    expect(rankings[0].averageScore).toBe(81.75);
    expect(rankings[0].judgeCount).toBe(1);
    expect(rankings[0].anomalyFlag).toBe(true);
  });

  it('excludes submitted evaluations missing a middle rubric criterion from computeFairRankings', () => {
    const rubric: RubricCriterion[] = [
      { id: 'c1', name: 'Innovation', description: 'Novelty', weight: 25 },
      { id: 'c2', name: 'Technical Depth', description: 'Architecture', weight: 30 },
      { id: 'c3', name: 'Impact', description: 'Usefulness', weight: 20 },
      { id: 'c4', name: 'Presentation', description: 'Clarity', weight: 25 }
    ];
    const sub: ProjectSubmission = {
      id: 'sub_mid',
      hackathonId: 'h1',
      organizerId: 'org1',
      teamId: 't1',
      teamName: 'Team Mid',
      projectId: 'p1',
      ownerId: 'u1',
      memberIds: ['u1'],
      memberNames: ['Alice'],
      title: 'Middle Criterion Test',
      shortDescription: 'Desc',
      fullDescription: '',
      problemStatement: '',
      proposedSolution: '',
      technologies: [],
      githubUrl: 'https://github.com/a/b',
      demoUrl: '',
      videoUrl: '',
      screenshotUrls: [],
      track: 'AI',
      status: 'under_review'
    };

    const missingMiddleEval: Evaluation = {
      id: 'sub_mid_j1',
      hackathonId: 'h1',
      organizerId: 'org1',
      submissionId: 'sub_mid',
      judgeId: 'j1',
      judgeName: 'Judge 1',
      // Middle criterion 'c2' omitted even though c1 and c4 exist and status is 'submitted'
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Innovation', weight: 25, score: 9, comment: 'C1 ok' },
        { criterionId: 'c3', criterionName: 'Impact', weight: 20, score: 8, comment: 'C3 ok' },
        { criterionId: 'c4', criterionName: 'Presentation', weight: 25, score: 9, comment: 'C4 ok' }
      ],
      weightedTotal: 90,
      scoredCriterionCount: 4,
      storageSchema: 'v2_subcollection',
      conflictOfInterest: false,
      conflictReason: '',
      humanFeedback: '',
      aiReportSummary: '',
      aiInferenceSource: '',
      status: 'submitted'
    };

    const rankings = computeFairRankings({
      submissions: [sub],
      evaluations: [missingMiddleEval],
      expectedJudgesPerSubmission: 1,
      rubric
    });
    expect(rankings).toHaveLength(1);
    expect(rankings[0].judgeCount).toBe(0);
    expect(rankings[0].averageScore).toBe(0);
    expect(rankings[0].anomalyFlag).toBe(true);
  });

  it('supports unmigrated v1_inline submitted and draft evaluations while preserving scores, comments, and IDs', () => {
    const rubric: RubricCriterion[] = [
      { id: 'c1', name: 'Innovation', description: 'Novelty', weight: 40 },
      { id: 'c2', name: 'Execution', description: 'Build', weight: 60 }
    ];
    const sub: ProjectSubmission = {
      id: 'sub_v1',
      hackathonId: 'h1',
      organizerId: 'org1',
      teamId: 't1',
      teamName: 'Team Legacy',
      projectId: 'p1',
      ownerId: 'u1',
      memberIds: ['u1'],
      memberNames: ['Bob'],
      title: 'Legacy Inline Project',
      shortDescription: 'Desc',
      fullDescription: '',
      problemStatement: '',
      proposedSolution: '',
      technologies: [],
      githubUrl: 'https://github.com/a/b',
      demoUrl: '',
      videoUrl: '',
      screenshotUrls: [],
      track: 'AI',
      status: 'evaluated'
    };

    const legacySubmitted: Evaluation = {
      id: 'sub_v1_j1',
      hackathonId: 'h1',
      organizerId: 'org1',
      submissionId: 'sub_v1',
      judgeId: 'j1',
      judgeName: 'Legacy Judge',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Innovation', weight: 40, score: 8, comment: 'Inline comment c1' },
        { criterionId: 'c2', criterionName: 'Execution', weight: 60, score: 9, comment: 'Inline comment c2' }
      ],
      weightedTotal: 86,
      storageSchema: 'v1_inline',
      conflictOfInterest: false,
      conflictReason: '',
      humanFeedback: 'Solid legacy submission',
      aiReportSummary: '',
      aiInferenceSource: '',
      status: 'submitted'
    };

    // No /criteria subcollection docs exist yet -> falls back cleanly to v1_inline
    const hydratedSubmitted = hydrateEvaluationScoresAndTotal(legacySubmitted, [], rubric);
    expect(hydratedSubmitted.id).toBe('sub_v1_j1');
    expect(hydratedSubmitted.storageSchema).toBe('v1_inline');
    expect(hydratedSubmitted.weightedTotal).toBe(86);
    expect(hydratedSubmitted.criteriaScores).toEqual([
      { criterionId: 'c1', criterionName: 'Innovation', weight: 40, score: 8, comment: 'Inline comment c1' },
      { criterionId: 'c2', criterionName: 'Execution', weight: 60, score: 9, comment: 'Inline comment c2' }
    ]);

    const rankings = computeFairRankings({
      submissions: [sub],
      evaluations: [hydratedSubmitted],
      expectedJudgesPerSubmission: 1,
      rubric
    });
    expect(rankings[0].judgeCount).toBe(1);
    expect(rankings[0].averageScore).toBe(86);

    const legacyPartialDraft: Evaluation = {
      ...legacySubmitted,
      id: 'sub_v1_j2',
      judgeId: 'j2',
      criteriaScores: [
        { criterionId: 'c1', criterionName: 'Innovation', weight: 40, score: 7, comment: 'Draft inline comment' }
      ],
      weightedTotal: 70,
      status: 'draft'
    };
    const hydratedDraft = hydrateEvaluationScoresAndTotal(legacyPartialDraft, [], rubric);
    const initialized = initializeHumanCriteriaScores(rubric, hydratedDraft);
    expect(initialized).toEqual([
      {
        criterionId: 'c1',
        criterionName: 'Innovation',
        weight: 40,
        score: 7,
        scored: true,
        comment: 'Draft inline comment'
      },
      {
        criterionId: 'c2',
        criterionName: 'Execution',
        weight: 60,
        score: null,
        scored: false,
        comment: ''
      }
    ]);
  });
});

