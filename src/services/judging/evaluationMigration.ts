import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore
} from 'firebase/firestore';
import type { CriterionScore, Evaluation, NormalizedEvaluationCriterionDoc } from '../../types/domain';
import {
  calculateWeightedTotal,
  detectLegacyZeroToTenScale,
  hydrateEvaluationScoresAndTotal,
  normalizeCriterionScoreTo100
} from './fairJudgingEngine';
import { isValidFirestoreId, sanitizeString } from '../../utils/validation';

export type EvaluationMigrationOutcome =
  | 'already_migrated'
  | 'migrated_to_subcollection'
  | 'skipped_submitted_immutable'
  | 'skipped_no_criteria'
  | 'not_found';

export interface EvaluationMigrationResult {
  evaluationId: string;
  outcome: EvaluationMigrationOutcome;
  createdCriteriaCount: number;
  preservedExistingCriteriaCount: number;
  recomputedWeightedTotal: number;
}

/**
 * Idempotent, non-destructive migration helper for transitioning legacy inline-array
 * evaluation documents (`v1_inline`) to the Spark-compatible normalized subcollection
 * structure (`/evaluations/{evaluationId}/criteria/{criterionId}`).
 *
 * Guarantees:
 * - Never auto-runs against production.
 * - Never deletes or overwrites existing `/criteria/{criterionId}` human scores.
 * - Leaves locked `'submitted'` evaluations untouched unless explicitly invoked with
 *   `allowSubmittedOverride: true` by an authorized administrator context.
 */
export async function migrateLegacyEvaluationToSubcollection(
  firestore: Firestore,
  evaluationId: string,
  options: { allowSubmittedOverride?: boolean } = {}
): Promise<EvaluationMigrationResult> {
  const evalRef = doc(firestore, 'evaluations', evaluationId);
  const parentSnap = await getDoc(evalRef);
  if (!parentSnap.exists()) {
    return {
      evaluationId,
      outcome: 'not_found',
      createdCriteriaCount: 0,
      preservedExistingCriteriaCount: 0,
      recomputedWeightedTotal: 0
    };
  }

  const parentData = parentSnap.data() as Evaluation;
  const legacyScores = Array.isArray(parentData.criteriaScores) ? parentData.criteriaScores : [];

  const criteriaColRef = collection(firestore, 'evaluations', evaluationId, 'criteria');
  const existingSubSnap = await getDocs(criteriaColRef);
  const existingSubById = new Map<string, NormalizedEvaluationCriterionDoc>();
  for (const d of existingSubSnap.docs) {
    existingSubById.set(d.id, d.data() as NormalizedEvaluationCriterionDoc);
  }

  if (legacyScores.length === 0) {
    const hydrated = hydrateEvaluationScoresAndTotal(
      parentData,
      Array.from(existingSubById.values())
    );
    return {
      evaluationId,
      outcome: existingSubById.size > 0 || parentData.storageSchema === 'v2_subcollection'
        ? 'already_migrated'
        : 'skipped_no_criteria',
      createdCriteriaCount: 0,
      preservedExistingCriteriaCount: existingSubById.size,
      recomputedWeightedTotal: hydrated.weightedTotal
    };
  }

  if (parentData.status === 'submitted' && !options.allowSubmittedOverride) {
    const hydrated = hydrateEvaluationScoresAndTotal(
      parentData,
      Array.from(existingSubById.values())
    );
    return {
      evaluationId,
      outcome: 'skipped_submitted_immutable',
      createdCriteriaCount: 0,
      preservedExistingCriteriaCount: existingSubById.size,
      recomputedWeightedTotal: hydrated.weightedTotal
    };
  }

  let createdCriteriaCount = 0;
  let preservedExistingCriteriaCount = 0;
  const mergedForTotal = new Map<string, CriterionScore>();

  const existingSubDocsList = Array.from(existingSubById.values());
  const inferLegacySub = detectLegacyZeroToTenScale(existingSubDocsList, parentData);

  for (const [id, existingDoc] of existingSubById.entries()) {
    const normalizedExisting = normalizeCriterionScoreTo100(Number(existingDoc.score), {
      explicitScale: existingDoc.scoreScale ?? parentData.scoreScale,
      inferLegacyZeroToTen: inferLegacySub
    });
    mergedForTotal.set(id, {
      criterionId: existingDoc.criterionId || id,
      criterionName: existingDoc.criterionName,
      weight: Number(existingDoc.weight),
      score: normalizedExisting.score,
      scoreScale: normalizedExisting.scoreScale,
      ...(normalizedExisting.convertedFromScale ? { convertedFromScale: normalizedExisting.convertedFromScale } : {}),
      comment: existingDoc.comment || ''
    });
    preservedExistingCriteriaCount += 1;
  }

  const inferLegacyInline = detectLegacyZeroToTenScale(legacyScores, {
    ...parentData,
    storageSchema: parentData.storageSchema ?? 'v1_inline'
  });

  for (const rawItem of legacyScores) {
    if (!rawItem || typeof rawItem.criterionId !== 'string' || !isValidFirestoreId(rawItem.criterionId)) {
      continue;
    }
    if (existingSubById.has(rawItem.criterionId)) {
      // Non-destructive: keep existing subcollection doc untouched
      continue;
    }

    const weight = Number(rawItem.weight);
    const rawScore = Number(rawItem.score);
    if (
      !Number.isFinite(weight) ||
      weight < 0 ||
      weight > 100 ||
      !Number.isFinite(rawScore) ||
      rawScore < 0 ||
      rawScore > 100
    ) {
      continue;
    }

    const normalized = normalizeCriterionScoreTo100(rawScore, {
      explicitScale: rawItem.scoreScale ?? parentData.scoreScale,
      convertedFromScale: rawItem.convertedFromScale,
      originalScore: rawItem.originalScore,
      inferLegacyZeroToTen: inferLegacyInline
    });

    const criterionName = sanitizeString(rawItem.criterionName || rawItem.criterionId, 120) || rawItem.criterionId;
    const comment = sanitizeString(rawItem.comment || '', 1000);

    if (!parentData.conflictOfInterest) {
      await setDoc(doc(firestore, 'evaluations', evaluationId, 'criteria', rawItem.criterionId), {
        criterionId: rawItem.criterionId,
        evaluationId,
        hackathonId: parentData.hackathonId,
        submissionId: parentData.submissionId,
        judgeId: parentData.judgeId,
        criterionName,
        weight,
        score: normalized.score,
        scoreScale: '0_to_100',
        comment,
        updatedAt: serverTimestamp()
      });
      createdCriteriaCount += 1;
      mergedForTotal.set(rawItem.criterionId, {
        criterionId: rawItem.criterionId,
        criterionName,
        weight,
        score: normalized.score,
        scoreScale: '0_to_100',
        comment
      });
    }
  }

  const finalScores = parentData.conflictOfInterest ? [] : Array.from(mergedForTotal.values());
  const recomputedWeightedTotal = finalScores.length > 0 ? calculateWeightedTotal(finalScores) : 0;

  await updateDoc(evalRef, {
    criteriaScores: [],
    weightedTotal: recomputedWeightedTotal,
    scoreScale: '0_to_100',
    scoredCriterionCount: finalScores.length,
    storageSchema: 'v2_subcollection',
    updatedAt: serverTimestamp()
  });

  return {
    evaluationId,
    outcome: 'migrated_to_subcollection',
    createdCriteriaCount,
    preservedExistingCriteriaCount,
    recomputedWeightedTotal
  };
}
