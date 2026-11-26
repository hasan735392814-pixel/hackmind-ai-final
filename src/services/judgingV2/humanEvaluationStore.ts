import {
  calculateOfficialWeightedScore,
  CRITERIA_VERSION,
  OFFICIAL_CRITERION_IDS,
  validateFourCriteriaScores
} from './criteria';
import type {
  AIJudgingRecommendation,
  HumanCriterionEvaluation,
  HumanJudgingEvaluation,
  ObservableWorkflowCheck,
  OfficialCriterionId
} from './types';

const EVAL_STORAGE_PREFIX = 'hackmind_judging_v2_eval:';

function getStorageKey(submissionId: string, judgeId: string): string {
  return `${EVAL_STORAGE_PREFIX}${submissionId}:${judgeId}`;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function createEmptyHumanCriteriaMap(): Record<
  OfficialCriterionId,
  HumanCriterionEvaluation
> {
  return {
    innovation_originality: {
      criterionId: 'innovation_originality',
      score: null,
      rationale: ''
    },
    technical_implementation: {
      criterionId: 'technical_implementation',
      score: null,
      rationale: ''
    },
    real_world_impact: {
      criterionId: 'real_world_impact',
      score: null,
      rationale: ''
    },
    ux_completeness: {
      criterionId: 'ux_completeness',
      score: null,
      rationale: ''
    }
  };
}

export function createEmptyHumanEvaluation(params: {
  submissionId: string;
  hackathonId: string;
  judgeId: string;
  judgeName: string;
  workflowChecks?: ObservableWorkflowCheck[];
}): HumanJudgingEvaluation {
  return {
    id: `v2eval_${params.submissionId}_${params.judgeId}`,
    submissionId: params.submissionId,
    hackathonId: params.hackathonId,
    judgeId: params.judgeId,
    judgeName: params.judgeName,
    criteriaVersion: CRITERIA_VERSION,
    status: 'draft',
    criteria: createEmptyHumanCriteriaMap(),
    finalWeightedScore: null,
    overallComments: '',
    workflowChecks: params.workflowChecks ? [...params.workflowChecks] : [],
    aiRecommendationSnapshot: null,
    approvedAt: null,
    updatedAt: new Date().toISOString()
  };
}

export function loadHumanEvaluation(
  submissionId: string,
  judgeId: string
): HumanJudgingEvaluation | null {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(getStorageKey(submissionId, judgeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HumanJudgingEvaluation;
    if (!parsed || parsed.submissionId !== submissionId || parsed.judgeId !== judgeId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function assertAuthorizedHumanJudge(params: {
  evaluation: HumanJudgingEvaluation;
  actorUid: string;
  assignedSubmissionIds?: string[];
  isOrganizerOrAdmin?: boolean;
}): void {
  const { evaluation, actorUid, assignedSubmissionIds, isOrganizerOrAdmin } = params;
  if (!actorUid || actorUid !== evaluation.judgeId) {
    throw new Error('Only the assigned human judge can modify or approve their own evaluation.');
  }
  if (
    !isOrganizerOrAdmin &&
    Array.isArray(assignedSubmissionIds) &&
    !assignedSubmissionIds.includes(evaluation.submissionId)
  ) {
    throw new Error('Judge is not authorized for this submission.');
  }
}

/**
 * Attaches an AI recommendation snapshot strictly in read-only advisory capacity.
 * NEVER modifies, initializes, or overwrites human scores, rationales, approval state, or finalWeightedScore.
 */
export function attachAIRecommendationSafely(
  evaluation: HumanJudgingEvaluation,
  recommendation: AIJudgingRecommendation | null
): HumanJudgingEvaluation {
  return {
    ...evaluation,
    // Deep-preserve human-controlled fields untouched
    criteria: {
      innovation_originality: { ...evaluation.criteria.innovation_originality },
      technical_implementation: { ...evaluation.criteria.technical_implementation },
      real_world_impact: { ...evaluation.criteria.real_world_impact },
      ux_completeness: { ...evaluation.criteria.ux_completeness }
    },
    finalWeightedScore: evaluation.finalWeightedScore,
    status: evaluation.status,
    approvedAt: evaluation.approvedAt,
    aiRecommendationSnapshot: recommendation ? { ...recommendation, advisoryOnly: true } : null,
    updatedAt: evaluation.updatedAt
  };
}

export function setHumanCriterionScoreV2(
  evaluation: HumanJudgingEvaluation,
  criterionId: OfficialCriterionId,
  score: number | null,
  rationale?: string
): HumanJudgingEvaluation {
  if (evaluation.status === 'approved') {
    throw new Error('Approved official evaluations are locked and cannot be modified.');
  }
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) {
    throw new Error('Human score must be between 0 and 100.');
  }
  const nextCriteria = {
    ...evaluation.criteria,
    [criterionId]: {
      criterionId,
      score: score === null ? null : Math.round(score * 100) / 100,
      rationale:
        rationale !== undefined ? rationale : evaluation.criteria[criterionId]?.rationale || ''
    }
  };
  return {
    ...evaluation,
    criteria: nextCriteria,
    finalWeightedScore: calculateOfficialWeightedScore(nextCriteria),
    updatedAt: new Date().toISOString()
  };
}

export function saveHumanEvaluationDraft(params: {
  evaluation: HumanJudgingEvaluation;
  actorUid: string;
  assignedSubmissionIds?: string[];
  isOrganizerOrAdmin?: boolean;
}): HumanJudgingEvaluation {
  assertAuthorizedHumanJudge(params);
  const existing = loadHumanEvaluation(params.evaluation.submissionId, params.evaluation.judgeId);
  if (existing?.status === 'approved' || params.evaluation.status === 'approved') {
    throw new Error('Approved evaluations cannot be overwritten.');
  }
  const validation = validateFourCriteriaScores(params.evaluation.criteria, {
    requireAllScored: false
  });
  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid criteria structure.');
  }

  const next: HumanJudgingEvaluation = {
    ...params.evaluation,
    status: 'draft',
    approvedAt: null,
    finalWeightedScore: calculateOfficialWeightedScore(params.evaluation.criteria),
    updatedAt: new Date().toISOString()
  };

  safeStorage()?.setItem(getStorageKey(next.submissionId, next.judgeId), JSON.stringify(next));
  return next;
}

export function finalizeAndApproveHumanEvaluation(params: {
  evaluation: HumanJudgingEvaluation;
  actorUid: string;
  assignedSubmissionIds?: string[];
  isOrganizerOrAdmin?: boolean;
}): HumanJudgingEvaluation {
  assertAuthorizedHumanJudge(params);
  const existing = loadHumanEvaluation(params.evaluation.submissionId, params.evaluation.judgeId);
  if (existing?.status === 'approved') {
    throw new Error('This evaluation has already been approved and locked.');
  }
  const validation = validateFourCriteriaScores(params.evaluation.criteria, {
    requireAllScored: true
  });
  if (!validation.valid) {
    throw new Error(validation.error || 'All four official criteria must be scored (0–100) before approval.');
  }

  for (const id of OFFICIAL_CRITERION_IDS) {
    if (!params.evaluation.criteria[id]?.rationale?.trim()) {
      throw new Error(`Please enter a human judge rationale for all four criteria before final approval.`);
    }
  }

  const finalWeightedScore = calculateOfficialWeightedScore(params.evaluation.criteria);
  if (finalWeightedScore === null) {
    throw new Error('Unable to compute final weighted score.');
  }

  const approved: HumanJudgingEvaluation = {
    ...params.evaluation,
    status: 'approved',
    finalWeightedScore,
    approvedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  safeStorage()?.setItem(
    getStorageKey(approved.submissionId, approved.judgeId),
    JSON.stringify(approved)
  );
  return approved;
}
