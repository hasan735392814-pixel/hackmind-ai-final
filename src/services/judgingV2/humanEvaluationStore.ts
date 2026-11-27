import type { CriterionScore, Evaluation } from '../../types/domain';
import {
  normalizeCriterionScoresTo100,
  roundWeightedScore
} from '../judging/fairJudgingEngine';
import {
  calculateDraftWeightedPreview,
  calculateWeightedScoreForRubric,
  CRITERIA_VERSION,
  getDefaultActiveCriteria,
  validateCriteriaScoresForRubric
} from './criteria';
import type {
  ActiveCriterionDefinition,
  AIJudgingRecommendation,
  HumanCriterionEvaluation,
  HumanJudgingEvaluation,
  ObservableWorkflowCheck
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

export function createEmptyHumanCriteriaMap(
  activeCriteria: ActiveCriterionDefinition[] = getDefaultActiveCriteria()
): Record<string, HumanCriterionEvaluation> {
  const map: Record<string, HumanCriterionEvaluation> = {};
  for (const def of activeCriteria) {
    map[def.id] = {
      criterionId: def.id,
      criterionName: def.name,
      weightPercent: def.weightPercent,
      score: null,
      scoreScale: '0_to_100',
      rationale: ''
    };
  }
  return map;
}

export function createEmptyHumanEvaluation(params: {
  submissionId: string;
  hackathonId: string;
  judgeId: string;
  judgeName: string;
  workflowChecks?: ObservableWorkflowCheck[];
  activeCriteria?: ActiveCriterionDefinition[];
}): HumanJudgingEvaluation {
  const activeCriteria = params.activeCriteria?.length
    ? params.activeCriteria
    : getDefaultActiveCriteria();
  return {
    id: `${params.submissionId}_${params.judgeId}`,
    submissionId: params.submissionId,
    hackathonId: params.hackathonId,
    judgeId: params.judgeId,
    judgeName: params.judgeName,
    criteriaVersion: CRITERIA_VERSION,
    status: 'draft',
    firestoreStatus: 'draft',
    scoreScale: '0_to_100',
    conflictOfInterest: false,
    conflictReason: '',
    criteria: createEmptyHumanCriteriaMap(activeCriteria),
    finalWeightedScore: null,
    overallComments: '',
    workflowChecks: params.workflowChecks ? [...params.workflowChecks] : [],
    aiRecommendationSnapshot: null,
    approvedAt: null,
    updatedAt: new Date().toISOString(),
    syncState: 'local_draft',
    syncError: null,
    hasLocalUnsavedChanges: false,
    needsFinalizingRecovery: false
  };
}

export function cacheHumanEvaluationLocally(evaluation: HumanJudgingEvaluation): void {
  safeStorage()?.setItem(
    getStorageKey(evaluation.submissionId, evaluation.judgeId),
    JSON.stringify(evaluation)
  );
}

export function clearLocalHumanEvaluationCache(submissionId: string, judgeId: string): void {
  safeStorage()?.removeItem(getStorageKey(submissionId, judgeId));
}

export function alignEvaluationToActiveCriteria(
  evaluation: HumanJudgingEvaluation,
  activeCriteria: ActiveCriterionDefinition[]
): HumanJudgingEvaluation {
  const nextCriteria: Record<string, HumanCriterionEvaluation> = {};
  for (const def of activeCriteria) {
    const existing = evaluation.criteria?.[def.id];
    nextCriteria[def.id] = existing
      ? {
          ...existing,
          criterionId: def.id,
          criterionName: def.name,
          weightPercent: def.weightPercent,
          scoreScale: '0_to_100'
        }
      : {
          criterionId: def.id,
          criterionName: def.name,
          weightPercent: def.weightPercent,
          score: null,
          scoreScale: '0_to_100',
          rationale: ''
        };
  }
  return {
    ...evaluation,
    criteria: nextCriteria,
    finalWeightedScore: evaluation.conflictOfInterest
      ? 0
      : calculateWeightedScoreForRubric(nextCriteria, activeCriteria)
  };
}

export function loadHumanEvaluation(
  submissionId: string,
  judgeId: string,
  activeCriteria?: ActiveCriterionDefinition[]
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
    if (activeCriteria && activeCriteria.length > 0 && parsed.status !== 'approved') {
      return alignEvaluationToActiveCriteria(parsed, activeCriteria);
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
  const clonedCriteria: Record<string, HumanCriterionEvaluation> = {};
  for (const [k, v] of Object.entries(evaluation.criteria || {})) {
    clonedCriteria[k] = { ...v };
  }
  return {
    ...evaluation,
    criteria: clonedCriteria,
    finalWeightedScore: evaluation.finalWeightedScore,
    status: evaluation.status,
    approvedAt: evaluation.approvedAt,
    aiRecommendationSnapshot: recommendation ? { ...recommendation, advisoryOnly: true } : null,
    updatedAt: evaluation.updatedAt
  };
}

export function setHumanCriterionScoreV2(
  evaluation: HumanJudgingEvaluation,
  criterionId: string,
  score: number | null,
  rationale?: string,
  activeCriteria: ActiveCriterionDefinition[] = getDefaultActiveCriteria()
): HumanJudgingEvaluation {
  if (evaluation.status === 'approved') {
    throw new Error('Approved official evaluations are locked and cannot be modified.');
  }
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) {
    throw new Error('Human score must be between 0 and 100.');
  }
  const def = activeCriteria.find((c) => c.id === criterionId);
  const nextCriteria: Record<string, HumanCriterionEvaluation> = {
    ...evaluation.criteria,
    [criterionId]: {
      criterionId,
      criterionName: def?.name || evaluation.criteria[criterionId]?.criterionName || criterionId,
      weightPercent: def?.weightPercent ?? evaluation.criteria[criterionId]?.weightPercent,
      score: score === null ? null : Math.round(score * 100) / 100,
      scoreScale: '0_to_100',
      rationale:
        rationale !== undefined ? rationale : evaluation.criteria[criterionId]?.rationale || ''
    }
  };
  const useCriteria = activeCriteria.every((c) => c.id in nextCriteria)
    ? activeCriteria
    : Object.values(nextCriteria).map((c) => ({
        id: c.criterionId,
        name: c.criterionName || c.criterionId,
        nameAr: c.criterionName || c.criterionId,
        weight: (c.weightPercent ?? 0) / 100,
        weightPercent: c.weightPercent ?? 0,
        description: '',
        descriptionAr: '',
        evidenceStandard: '',
        evidenceStandardAr: ''
      }));

  return {
    ...evaluation,
    scoreScale: '0_to_100',
    criteria: nextCriteria,
    finalWeightedScore: evaluation.conflictOfInterest
      ? 0
      : calculateWeightedScoreForRubric(nextCriteria, useCriteria),
    hasLocalUnsavedChanges: true,
    syncState: 'local_draft',
    updatedAt: new Date().toISOString()
  };
}

export function setHumanConflictOfInterestV2(
  evaluation: HumanJudgingEvaluation,
  conflictOfInterest: boolean,
  conflictReason?: string
): HumanJudgingEvaluation {
  if (evaluation.status === 'approved') {
    throw new Error('Approved official evaluations are locked and cannot be modified.');
  }
  return {
    ...evaluation,
    conflictOfInterest,
    conflictReason: conflictReason !== undefined ? conflictReason : evaluation.conflictReason || '',
    hasLocalUnsavedChanges: true,
    syncState: 'local_draft',
    updatedAt: new Date().toISOString()
  };
}

export function saveHumanEvaluationDraft(params: {
  evaluation: HumanJudgingEvaluation;
  actorUid: string;
  assignedSubmissionIds?: string[];
  isOrganizerOrAdmin?: boolean;
  activeCriteria?: ActiveCriterionDefinition[];
}): HumanJudgingEvaluation {
  assertAuthorizedHumanJudge(params);
  const existing = loadHumanEvaluation(params.evaluation.submissionId, params.evaluation.judgeId);
  if (existing?.status === 'approved' || params.evaluation.status === 'approved') {
    throw new Error('Approved evaluations cannot be overwritten.');
  }
  const activeCriteria = params.activeCriteria?.length
    ? params.activeCriteria
    : getDefaultActiveCriteria();

  if (!params.evaluation.conflictOfInterest) {
    const validation = validateCriteriaScoresForRubric(
      params.evaluation.criteria,
      activeCriteria,
      { requireAllScored: false }
    );
    if (!validation.valid) {
      throw new Error(validation.error || 'Invalid criteria structure.');
    }
  }

  const next: HumanJudgingEvaluation = {
    ...params.evaluation,
    status: 'draft',
    scoreScale: '0_to_100',
    approvedAt: null,
    finalWeightedScore: params.evaluation.conflictOfInterest
      ? 0
      : calculateWeightedScoreForRubric(params.evaluation.criteria, activeCriteria),
    updatedAt: new Date().toISOString()
  };

  cacheHumanEvaluationLocally(next);
  return next;
}

export function finalizeAndApproveHumanEvaluation(params: {
  evaluation: HumanJudgingEvaluation;
  actorUid: string;
  assignedSubmissionIds?: string[];
  isOrganizerOrAdmin?: boolean;
  activeCriteria?: ActiveCriterionDefinition[];
}): HumanJudgingEvaluation {
  assertAuthorizedHumanJudge(params);
  const existing = loadHumanEvaluation(params.evaluation.submissionId, params.evaluation.judgeId);
  if (existing?.status === 'approved') {
    throw new Error('This evaluation has already been approved and locked.');
  }
  const activeCriteria = params.activeCriteria?.length
    ? params.activeCriteria
    : getDefaultActiveCriteria();

  if (params.evaluation.conflictOfInterest) {
    if (!params.evaluation.conflictReason?.trim()) {
      throw new Error('Please describe the conflict of interest reason before submitting.');
    }
    const approvedCoi: HumanJudgingEvaluation = {
      ...params.evaluation,
      status: 'approved',
      firestoreStatus: 'submitted',
      scoreScale: '0_to_100',
      finalWeightedScore: 0,
      approvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasLocalUnsavedChanges: false
    };
    cacheHumanEvaluationLocally(approvedCoi);
    return approvedCoi;
  }

  const validation = validateCriteriaScoresForRubric(
    params.evaluation.criteria,
    activeCriteria,
    { requireAllScored: true }
  );
  if (!validation.valid) {
    throw new Error(
      validation.error || 'All rubric criteria must be scored (0–100) before approval.'
    );
  }

  for (const def of activeCriteria) {
    if (!params.evaluation.criteria[def.id]?.rationale?.trim()) {
      throw new Error(
        `Please enter a human judge rationale for "${def.name}" before final approval.`
      );
    }
  }

  const finalWeightedScore = calculateWeightedScoreForRubric(
    params.evaluation.criteria,
    activeCriteria
  );
  if (finalWeightedScore === null) {
    throw new Error('Unable to compute final weighted score.');
  }

  const approved: HumanJudgingEvaluation = {
    ...params.evaluation,
    status: 'approved',
    firestoreStatus: 'submitted',
    scoreScale: '0_to_100',
    finalWeightedScore,
    approvedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hasLocalUnsavedChanges: false
  };

  cacheHumanEvaluationLocally(approved);
  return approved;
}

export function toFirestoreEvaluationPayload(params: {
  evaluation: HumanJudgingEvaluation;
  organizerId: string;
  activeCriteria: ActiveCriterionDefinition[];
  submitFinal: boolean;
}): Omit<Evaluation, 'createdAt' | 'updatedAt' | 'submittedAt'> {
  const { evaluation, organizerId, activeCriteria, submitFinal } = params;
  const isCoi = Boolean(evaluation.conflictOfInterest);

  if (isCoi) {
    if (!evaluation.conflictReason?.trim()) {
      throw new Error('Please describe the conflict of interest reason.');
    }
    return {
      id: `${evaluation.submissionId}_${evaluation.judgeId}`,
      hackathonId: evaluation.hackathonId,
      organizerId,
      submissionId: evaluation.submissionId,
      judgeId: evaluation.judgeId,
      judgeName: evaluation.judgeName || 'Judge',
      criteriaScores: [],
      weightedTotal: 0,
      scoreScale: '0_to_100',
      conflictOfInterest: true,
      conflictReason: evaluation.conflictReason.trim(),
      humanFeedback: evaluation.overallComments || '',
      aiReportSummary: evaluation.aiRecommendationSnapshot?.overallSummary || '',
      aiInferenceSource: evaluation.aiRecommendationSnapshot?.inferenceSource || '',
      status: submitFinal ? 'submitted' : 'draft'
    };
  }

  const criteriaScores: CriterionScore[] = [];
  for (const def of activeCriteria) {
    const entry = evaluation.criteria?.[def.id];
    if (entry && typeof entry.score === 'number' && Number.isFinite(entry.score)) {
      criteriaScores.push({
        criterionId: def.id,
        criterionName: def.name,
        weight: def.weightPercent,
        score: roundWeightedScore(entry.score),
        scoreScale: '0_to_100',
        comment: entry.rationale || ''
      });
    }
  }

  const preview = calculateDraftWeightedPreview(evaluation.criteria, activeCriteria);
  const weightedTotal =
    submitFinal && preview.finalWeightedScore !== null
      ? preview.finalWeightedScore
      : criteriaScores.length > 0
        ? roundWeightedScore(
            criteriaScores.reduce((acc, c) => acc + (c.score * c.weight) / 100, 0) /
              (criteriaScores.reduce((acc, c) => acc + c.weight, 0) / 100)
          )
        : 0;

  return {
    id: `${evaluation.submissionId}_${evaluation.judgeId}`,
    hackathonId: evaluation.hackathonId,
    organizerId,
    submissionId: evaluation.submissionId,
    judgeId: evaluation.judgeId,
    judgeName: evaluation.judgeName || 'Judge',
    criteriaScores,
    weightedTotal,
    scoreScale: '0_to_100',
    conflictOfInterest: false,
    conflictReason: '',
    humanFeedback: evaluation.overallComments || '',
    aiReportSummary: evaluation.aiRecommendationSnapshot?.overallSummary || '',
    aiInferenceSource: evaluation.aiRecommendationSnapshot?.inferenceSource || '',
    status: submitFinal ? 'submitted' : 'draft'
  };
}

function toIsoTimestamp(value: unknown): string {
  if (!value) return new Date().toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'object' && value !== null && 'toMillis' in value) {
    const fn = (value as { toMillis?: () => number }).toMillis;
    if (typeof fn === 'function') return new Date(fn.call(value)).toISOString();
  }
  return new Date().toISOString();
}

function toTimestampMs(value: unknown): number {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'object' && value !== null && 'toMillis' in value) {
    const fn = (value as { toMillis?: () => number }).toMillis;
    if (typeof fn === 'function') return fn.call(value);
  }
  return 0;
}

export function fromFirestoreEvaluationDoc(
  firestoreEval: Evaluation,
  activeCriteria: ActiveCriterionDefinition[] = getDefaultActiveCriteria(),
  workflowChecks: ObservableWorkflowCheck[] = []
): HumanJudgingEvaluation {
  const normalizedCriteriaList = normalizeCriterionScoresTo100(
    firestoreEval.criteriaScores || [],
    firestoreEval
  );
  const convertedFromLegacy =
    firestoreEval.convertedFromScale === '0_to_10' ||
    normalizedCriteriaList.some((c) => c.convertedFromScale === '0_to_10');

  const criteriaMap = createEmptyHumanCriteriaMap(activeCriteria);
  for (const item of normalizedCriteriaList) {
    criteriaMap[item.criterionId] = {
      criterionId: item.criterionId,
      criterionName:
        criteriaMap[item.criterionId]?.criterionName || item.criterionName || item.criterionId,
      weightPercent: criteriaMap[item.criterionId]?.weightPercent ?? item.weight,
      score: item.score,
      scoreScale: '0_to_100',
      ...(item.convertedFromScale ? { convertedFromScale: item.convertedFromScale } : {}),
      ...(item.originalScore !== undefined ? { originalScore: item.originalScore } : {}),
      rationale: item.comment || ''
    };
  }

  const isSubmitted = firestoreEval.status === 'submitted';
  const isFinalizing = firestoreEval.status === 'finalizing';
  const effectiveCriteriaDefs: ActiveCriterionDefinition[] =
    activeCriteria.length > 0
      ? activeCriteria
      : normalizedCriteriaList.map((c) => ({
          id: c.criterionId,
          name: c.criterionName,
          nameAr: c.criterionName,
          weight: c.weight / 100,
          weightPercent: c.weight,
          description: '',
          descriptionAr: '',
          evidenceStandard: '',
          evidenceStandardAr: ''
        }));

  const computedTotal = firestoreEval.conflictOfInterest
    ? 0
    : calculateWeightedScoreForRubric(criteriaMap, effectiveCriteriaDefs);

  return {
    id: firestoreEval.id || `${firestoreEval.submissionId}_${firestoreEval.judgeId}`,
    submissionId: firestoreEval.submissionId,
    hackathonId: firestoreEval.hackathonId,
    judgeId: firestoreEval.judgeId,
    judgeName: firestoreEval.judgeName,
    criteriaVersion: CRITERIA_VERSION,
    status: isSubmitted ? 'approved' : 'draft',
    firestoreStatus: firestoreEval.status,
    scoreScale: '0_to_100',
    ...(convertedFromLegacy ? { convertedFromScale: '0_to_10' as const } : {}),
    conflictOfInterest: Boolean(firestoreEval.conflictOfInterest),
    conflictReason: firestoreEval.conflictReason || '',
    criteria: criteriaMap,
    finalWeightedScore:
      computedTotal !== null
        ? computedTotal
        : typeof firestoreEval.weightedTotal === 'number' && firestoreEval.criteriaScores.length > 0
          ? firestoreEval.weightedTotal
          : null,
    overallComments: firestoreEval.humanFeedback || '',
    workflowChecks: [...workflowChecks],
    aiRecommendationSnapshot: null,
    approvedAt: isSubmitted ? toIsoTimestamp(firestoreEval.submittedAt || firestoreEval.updatedAt) : null,
    updatedAt: toIsoTimestamp(firestoreEval.updatedAt),
    syncState: isFinalizing ? 'finalizing' : 'synced',
    syncError: null,
    hasLocalUnsavedChanges: false,
    needsFinalizingRecovery: isFinalizing
  };
}

/**
 * Reconciles authoritative Firestore state with optional local offline draft cache.
 * Guarantees:
 * 1. Authoritative Firestore `'submitted'` evaluations ALWAYS win and lock UI against stale local drafts.
 * 2. Interrupted `'finalizing'` records surface Firestore scores for safe recovery.
 * 3. Unsynced local drafts created offline are preserved with explicit `syncState: 'local_draft'`
 *    for reconnect saving without falsely marking them `'approved'`.
 */
export function reconcileEvaluationWithFirestore(params: {
  firestoreEval: Evaluation | null;
  localDraft: HumanJudgingEvaluation | null;
  context: {
    submissionId: string;
    hackathonId: string;
    judgeId: string;
    judgeName: string;
    workflowChecks?: ObservableWorkflowCheck[];
  };
  activeCriteria: ActiveCriterionDefinition[];
}): HumanJudgingEvaluation {
  const { firestoreEval, localDraft, context, activeCriteria } = params;

  // 1. Authoritative submitted Firestore evaluation ALWAYS wins and overrides any stale local cache
  if (firestoreEval && firestoreEval.status === 'submitted') {
    const authoritative = fromFirestoreEvaluationDoc(
      firestoreEval,
      activeCriteria,
      localDraft?.workflowChecks?.length ? localDraft.workflowChecks : context.workflowChecks || []
    );
    const synced: HumanJudgingEvaluation = {
      ...authoritative,
      aiRecommendationSnapshot: localDraft?.aiRecommendationSnapshot || null,
      syncState: 'synced',
      hasLocalUnsavedChanges: false
    };
    cacheHumanEvaluationLocally(synced);
    return synced;
  }

  // 2. Interrupted 'finalizing' transaction in Firestore surfaces directly for recovery
  if (firestoreEval && firestoreEval.status === 'finalizing') {
    const recovered = fromFirestoreEvaluationDoc(
      firestoreEval,
      activeCriteria,
      localDraft?.workflowChecks?.length ? localDraft.workflowChecks : context.workflowChecks || []
    );
    return {
      ...recovered,
      aiRecommendationSnapshot: localDraft?.aiRecommendationSnapshot || null,
      needsFinalizingRecovery: true,
      syncState: 'finalizing'
    };
  }

  // 3. Firestore has a draft
  if (firestoreEval) {
    const remoteMs = toTimestampMs(firestoreEval.updatedAt);
    const localMs = localDraft ? toTimestampMs(localDraft.updatedAt) : 0;

    if (
      localDraft &&
      localDraft.submissionId === context.submissionId &&
      localDraft.judgeId === context.judgeId &&
      localDraft.hasLocalUnsavedChanges &&
      localMs > remoteMs
    ) {
      const alignedLocal = alignEvaluationToActiveCriteria(
        {
          ...localDraft,
          status: 'draft',
          firestoreStatus: firestoreEval.status,
          approvedAt: null,
          syncState: 'local_draft',
          hasLocalUnsavedChanges: true
        },
        activeCriteria
      );
      return alignedLocal;
    }

    const fromRemote = fromFirestoreEvaluationDoc(
      firestoreEval,
      activeCriteria,
      localDraft?.workflowChecks?.length ? localDraft.workflowChecks : context.workflowChecks || []
    );
    const hydrated: HumanJudgingEvaluation = {
      ...fromRemote,
      aiRecommendationSnapshot: localDraft?.aiRecommendationSnapshot || null,
      syncState: 'synced',
      hasLocalUnsavedChanges: false
    };
    cacheHumanEvaluationLocally(hydrated);
    return hydrated;
  }

  // 4. No Firestore doc yet: restore unsaved local draft (never trusting unconfirmed local 'approved')
  if (
    localDraft &&
    localDraft.submissionId === context.submissionId &&
    localDraft.judgeId === context.judgeId
  ) {
    const downgradedIfUnconfirmed =
      localDraft.status === 'approved'
        ? {
            ...localDraft,
            status: 'draft' as const,
            firestoreStatus: undefined,
            approvedAt: null,
            hasLocalUnsavedChanges: true,
            syncState: 'local_draft' as const,
            syncError: 'Local evaluation has not been persisted to Firestore yet.'
          }
        : {
            ...localDraft,
            syncState: 'local_draft' as const
          };
    return alignEvaluationToActiveCriteria(downgradedIfUnconfirmed, activeCriteria);
  }

  return createEmptyHumanEvaluation({
    submissionId: context.submissionId,
    hackathonId: context.hackathonId,
    judgeId: context.judgeId,
    judgeName: context.judgeName,
    workflowChecks: context.workflowChecks,
    activeCriteria
  });
}
