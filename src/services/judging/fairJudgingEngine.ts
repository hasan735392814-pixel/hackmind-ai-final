import type {
  CriterionScore,
  Evaluation,
  NormalizedEvaluationCriterionDoc,
  ProjectSubmission,
  RankedSubmissionResult,
  RubricCriterion,
  ScoreScale
} from '../../types/domain';

export interface DraftCriterionScore {
  criterionId: string;
  criterionName: string;
  weight: number;
  score: number | null;
  scoreScale?: ScoreScale;
  convertedFromScale?: ScoreScale;
  originalScore?: number;
  scored: boolean;
  comment: string;
}

export const CANONICAL_SCORE_SCALE: ScoreScale = '0_to_100';

export const CANONICAL_DEFAULT_RUBRIC: readonly RubricCriterion[] = [
  {
    id: 'innovation_originality',
    name: 'Innovation & Originality',
    description:
      'Novelty of problem framing, originality of technical/product approach, and clear differentiation from generic wrappers.',
    weight: 25
  },
  {
    id: 'technical_implementation',
    name: 'Technical Implementation',
    description:
      'Code quality, architecture, real working integrations, security/rule hygiene, and reliability verifiable in source code.',
    weight: 30
  },
  {
    id: 'real_world_impact',
    name: 'Real-World Impact',
    description:
      'Practical value for real users, feasibility, scalability, and clarity of real-world problem fit.',
    weight: 25
  },
  {
    id: 'ux_completeness',
    name: 'User Experience & Completeness',
    description:
      'End-to-end polish, usability, clear product flow, demo/readme completeness, and functional readiness.',
    weight: 20
  }
];

export function cloneCanonicalDefaultRubric(): RubricCriterion[] {
  return CANONICAL_DEFAULT_RUBRIC.map((item) => ({ ...item }));
}

const VALID_CRITERION_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

export function roundWeightedScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function validateRubricWeights(rubric: RubricCriterion[]): {
  valid: boolean;
  sum: number;
  error?: string;
} {
  if (!Array.isArray(rubric) || rubric.length === 0) {
    return { valid: false, sum: 0, error: 'Rubric must contain at least one criterion.' };
  }
  if (rubric.length > 12) {
    return { valid: false, sum: 0, error: 'Rubric cannot exceed 12 criteria.' };
  }
  const seenIds = new Set<string>();
  let sum = 0;
  for (const item of rubric) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const w = Number(item?.weight);
    if (!id || !VALID_CRITERION_ID_REGEX.test(id)) {
      return { valid: false, sum: 0, error: `Invalid rubric criterion ID: ${id || '(empty)'}.` };
    }
    if (seenIds.has(id)) {
      return { valid: false, sum: 0, error: `Duplicate rubric criterion ID: ${id}.` };
    }
    seenIds.add(id);
    if (!name) {
      return { valid: false, sum: 0, error: `Criterion name is required for ${id}.` };
    }
    if (!Number.isFinite(w) || w <= 0 || w > 100) {
      return { valid: false, sum: 0, error: `Weight for criterion "${name}" must be between 0 and 100.` };
    }
    sum += w;
  }

  const roundedSum = roundWeightedScore(sum);
  if (roundedSum <= 0 || Math.abs(roundedSum - 100) >= 0.01) {
    return {
      valid: false,
      sum: roundedSum,
      error: `Rubric weights must sum to 100% (currently ${roundedSum}%).`
    };
  }

  return { valid: true, sum: roundedSum };
}

export function normalizeCriterionScoreTo100(
  rawScore: number,
  options?: {
    explicitScale?: ScoreScale;
    convertedFromScale?: ScoreScale;
    originalScore?: number;
    inferLegacyZeroToTen?: boolean;
  }
): {
  score: number;
  scoreScale: '0_to_100';
  convertedFromScale?: ScoreScale;
  originalScore?: number;
} {
  const num = Number(rawScore);
  if (!Number.isFinite(num)) {
    return { score: 0, scoreScale: '0_to_100' };
  }

  const clamped100 = roundWeightedScore(Math.min(100, Math.max(0, num)));

  // Already normalized or explicitly tagged as 0..100: NEVER convert again.
  if (
    options?.explicitScale === '0_to_100' ||
    options?.convertedFromScale === '0_to_10' ||
    num > 10
  ) {
    return {
      score: clamped100,
      scoreScale: '0_to_100',
      ...(options?.convertedFromScale ? { convertedFromScale: options.convertedFromScale } : {}),
      ...(options?.originalScore !== undefined ? { originalScore: options.originalScore } : {})
    };
  }

  // Explicit legacy 0..10 or inferred legacy 0..10 document (pre-migration v1_inline or untagged <=10)
  if (options?.explicitScale === '0_to_10' || options?.inferLegacyZeroToTen) {
    const clamped10 = Math.min(10, Math.max(0, num));
    return {
      score: roundWeightedScore(clamped10 * 10),
      scoreScale: '0_to_100',
      convertedFromScale: '0_to_10',
      originalScore: clamped10
    };
  }

  return {
    score: clamped100,
    scoreScale: '0_to_100'
  };
}

export function detectLegacyZeroToTenScale(
  scores: Array<Pick<CriterionScore, 'score' | 'scoreScale' | 'convertedFromScale'>>,
  parentEval?: Pick<Evaluation, 'scoreScale' | 'convertedFromScale' | 'storageSchema'> | null
): boolean {
  if (!Array.isArray(scores) || scores.length === 0) {
    return parentEval?.scoreScale === '0_to_10';
  }

  // Explicit 0..100 or prior conversion guard prevents double conversion
  if (
    parentEval?.scoreScale === '0_to_100' ||
    parentEval?.convertedFromScale === '0_to_10' ||
    scores.some(
      (s) =>
        s.scoreScale === '0_to_100' ||
        s.convertedFromScale === '0_to_10' ||
        (Number.isFinite(Number(s.score)) && Number(s.score) > 10)
    )
  ) {
    return false;
  }

  if (
    parentEval?.scoreScale === '0_to_10' ||
    scores.some((s) => s.scoreScale === '0_to_10')
  ) {
    return true;
  }

  // Historical evaluations written before scoreScale was introduced were strictly bounded [0, 10] by firestore.rules
  if (
    parentEval &&
    parentEval.scoreScale === undefined &&
    scores.every((s) => s.scoreScale === undefined && Number.isFinite(Number(s.score)) && Number(s.score) >= 0 && Number(s.score) <= 10)
  ) {
    return true;
  }

  return false;
}

export function normalizeCriterionScoresTo100(
  scores: CriterionScore[],
  parentEval?: Pick<Evaluation, 'scoreScale' | 'convertedFromScale' | 'storageSchema'> | null
): CriterionScore[] {
  if (!Array.isArray(scores) || scores.length === 0) return [];
  const inferLegacy = detectLegacyZeroToTenScale(scores, parentEval);
  return scores.map((item) => {
    const normalized = normalizeCriterionScoreTo100(item.score, {
      explicitScale: item.scoreScale ?? parentEval?.scoreScale,
      convertedFromScale: item.convertedFromScale ?? parentEval?.convertedFromScale,
      originalScore: item.originalScore,
      inferLegacyZeroToTen: inferLegacy
    });
    return {
      ...item,
      score: normalized.score,
      scoreScale: normalized.scoreScale,
      ...(normalized.convertedFromScale ? { convertedFromScale: normalized.convertedFromScale } : {}),
      ...(normalized.originalScore !== undefined ? { originalScore: normalized.originalScore } : {})
    };
  });
}

export function calculateWeightedTotalStrict(
  scores: CriterionScore[],
  expectedRubric?: RubricCriterion[]
): { valid: boolean; weightedTotal: number; error?: string } {
  if (!Array.isArray(scores) || scores.length === 0) {
    return { valid: false, weightedTotal: 0, error: 'At least one criterion score is required.' };
  }

  const seenIds = new Set<string>();
  let totalWeight = 0;
  let weighted = 0;

  for (const item of scores) {
    if (!item || typeof item.criterionId !== 'string' || !VALID_CRITERION_ID_REGEX.test(item.criterionId)) {
      return { valid: false, weightedTotal: 0, error: 'Invalid criterion identifier.' };
    }
    if (seenIds.has(item.criterionId)) {
      return { valid: false, weightedTotal: 0, error: `Duplicate criterion identifier: ${item.criterionId}` };
    }
    seenIds.add(item.criterionId);

    if (typeof item.weight !== 'number' || !Number.isFinite(item.weight) || item.weight < 0 || item.weight > 100) {
      return { valid: false, weightedTotal: 0, error: `Invalid weight for criterion: ${item.criterionId}` };
    }

    const maxAllowed = item.scoreScale === '0_to_10' ? 10 : 100;
    if (
      typeof item.score !== 'number' ||
      !Number.isFinite(item.score) ||
      item.score < 0 ||
      item.score > maxAllowed
    ) {
      return {
        valid: false,
        weightedTotal: 0,
        error: `Score out of range [0, ${maxAllowed}] for criterion: ${item.criterionId}`
      };
    }

    const scoreOn100 =
      item.scoreScale === '0_to_10' && !item.convertedFromScale
        ? item.score * 10
        : item.score;

    totalWeight += item.weight;
    weighted += (scoreOn100 / 100) * item.weight;
  }

  if (totalWeight <= 0) {
    return { valid: false, weightedTotal: 0, error: 'Total weight of scored criteria must be greater than zero.' };
  }

  if (expectedRubric && expectedRubric.length > 0) {
    const scoreById = new Map(scores.map((s) => [s.criterionId, s]));
    if (scores.length !== expectedRubric.length) {
      return {
        valid: false,
        weightedTotal: 0,
        error: `Expected ${expectedRubric.length} rubric criteria, received ${scores.length}.`
      };
    }
    for (const r of expectedRubric) {
      const match = scoreById.get(r.id);
      if (!match) {
        return { valid: false, weightedTotal: 0, error: `Missing required rubric criterion: ${r.name}` };
      }
      if (Math.abs(match.weight - r.weight) > 0.01) {
        return {
          valid: false,
          weightedTotal: 0,
          error: `Weight mismatch for criterion ${r.name}: expected ${r.weight}, got ${match.weight}.`
        };
      }
    }
  }

  const normalized = (weighted / totalWeight) * 100;
  return {
    valid: true,
    weightedTotal: roundWeightedScore(normalized)
  };
}

export function calculateWeightedTotal(scores: CriterionScore[]): number {
  if (!scores.length) return 0;
  const seen = new Set<string>();
  let totalWeight = 0;
  let weighted = 0;

  for (const item of scores) {
    if (!item) continue;
    const id = typeof item.criterionId === 'string' ? item.criterionId : '';
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const rawScore = Number(item.score);
    const rawWeight = Number(item.weight);
    if (!Number.isFinite(rawScore) || !Number.isFinite(rawWeight)) continue;

    const scoreOn100 =
      item.scoreScale === '0_to_10' && !item.convertedFromScale
        ? Math.min(10, Math.max(0, rawScore)) * 10
        : Math.min(100, Math.max(0, rawScore));

    const weight = Math.max(0, Math.min(100, rawWeight));
    totalWeight += weight;
    weighted += (scoreOn100 / 100) * weight;
  }

  if (totalWeight <= 0) return 0;

  const normalized = (weighted / totalWeight) * 100;
  return roundWeightedScore(normalized);
}

export function hydrateEvaluationScoresAndTotal(
  parentEval: Evaluation,
  subcollectionCriteria: Array<NormalizedEvaluationCriterionDoc | CriterionScore>,
  rubric?: RubricCriterion[]
): Evaluation {
  if (parentEval.conflictOfInterest) {
    return {
      ...parentEval,
      criteriaScores: [],
      weightedTotal: 0,
      scoreScale: '0_to_100',
      scoredCriterionCount: 0,
      storageSchema: parentEval.storageSchema ?? 'v2_subcollection'
    };
  }

  const hasSubDocs = Array.isArray(subcollectionCriteria) && subcollectionCriteria.length > 0;
  const rawList: CriterionScore[] = hasSubDocs
    ? subcollectionCriteria.map((c) => ({
        criterionId: c.criterionId,
        criterionName: c.criterionName,
        weight: Number(c.weight),
        score: Number(c.score),
        ...(c.scoreScale ? { scoreScale: c.scoreScale } : {}),
        ...('convertedFromScale' in c && c.convertedFromScale
          ? { convertedFromScale: c.convertedFromScale }
          : {}),
        ...('originalScore' in c && c.originalScore !== undefined
          ? { originalScore: c.originalScore }
          : {}),
        comment: typeof c.comment === 'string' ? c.comment : ''
      }))
    : Array.isArray(parentEval.criteriaScores)
      ? parentEval.criteriaScores.map((c) => ({
          criterionId: c.criterionId,
          criterionName: c.criterionName,
          weight: Number(c.weight),
          score: Number(c.score),
          ...(c.scoreScale ? { scoreScale: c.scoreScale } : {}),
          ...(c.convertedFromScale ? { convertedFromScale: c.convertedFromScale } : {}),
          ...(c.originalScore !== undefined ? { originalScore: c.originalScore } : {}),
          comment: typeof c.comment === 'string' ? c.comment : ''
        }))
      : [];

  // Deduplicate cleanly by criterionId and filter invalid items (accepting canonical 0..100)
  const dedupedMap = new Map<string, CriterionScore>();
  for (const item of rawList) {
    if (
      item.criterionId &&
      VALID_CRITERION_ID_REGEX.test(item.criterionId) &&
      Number.isFinite(item.weight) &&
      item.weight >= 0 &&
      item.weight <= 100 &&
      Number.isFinite(item.score) &&
      item.score >= 0 &&
      item.score <= 100 &&
      !dedupedMap.has(item.criterionId)
    ) {
      dedupedMap.set(item.criterionId, item);
    }
  }

  let orderedScores: CriterionScore[];
  if (rubric && rubric.length > 0) {
    orderedScores = [];
    for (const r of rubric) {
      const found = dedupedMap.get(r.id);
      if (found) {
        orderedScores.push(found);
        dedupedMap.delete(r.id);
      }
    }
    for (const leftover of dedupedMap.values()) {
      orderedScores.push(leftover);
    }
  } else {
    orderedScores = Array.from(dedupedMap.values());
  }

  // Non-destructively normalize legacy 0..10 scores to 0..100 in memory without double-converting
  const normalizedScores = normalizeCriterionScoresTo100(orderedScores, parentEval);
  const convertedFromLegacy = normalizedScores.some((s) => s.convertedFromScale === '0_to_10');

  const recomputedTotal = normalizedScores.length > 0 ? calculateWeightedTotal(normalizedScores) : 0;
  const resolvedSchema = hasSubDocs
    ? 'v2_subcollection'
    : normalizedScores.length > 0
      ? 'v1_inline'
      : parentEval.storageSchema ?? 'v2_subcollection';

  return {
    ...parentEval,
    criteriaScores: normalizedScores,
    weightedTotal: recomputedTotal,
    scoreScale: '0_to_100',
    ...(convertedFromLegacy || parentEval.convertedFromScale === '0_to_10'
      ? { convertedFromScale: '0_to_10' as const }
      : {}),
    scoredCriterionCount: normalizedScores.length,
    storageSchema: resolvedSchema
  };
}

export function initializeHumanCriteriaScores(
  rubric: RubricCriterion[],
  existingEval?: Pick<Evaluation, 'criteriaScores' | 'status' | 'scoreScale' | 'convertedFromScale' | 'storageSchema'> | null
): DraftCriterionScore[] {
  if (existingEval) {
    const normalizedSaved = normalizeCriterionScoresTo100(existingEval.criteriaScores || [], existingEval);
    const saved = normalizedSaved.map((c) => {
      const hasValidSavedScore = typeof c.score === 'number' && Number.isFinite(c.score);
      return {
        criterionId: c.criterionId,
        criterionName: c.criterionName,
        weight: c.weight,
        score: hasValidSavedScore ? Math.min(100, Math.max(0, c.score)) : null,
        scoreScale: '0_to_100' as const,
        ...(c.convertedFromScale ? { convertedFromScale: c.convertedFromScale } : {}),
        ...(c.originalScore !== undefined ? { originalScore: c.originalScore } : {}),
        scored: hasValidSavedScore,
        comment: c.comment || ''
      };
    });

    if (existingEval.status === 'submitted' || rubric.length === 0) {
      return saved;
    }

    // Preserve saved draft/finalizing criteria intact and append unscored rubric criteria explicitly as unscored
    const savedById = new Map(saved.map((item) => [item.criterionId, item]));
    const savedByName = new Map(saved.map((item) => [item.criterionName.toLowerCase(), item]));
    const merged: DraftCriterionScore[] = [];

    for (const r of rubric) {
      const existing = savedById.get(r.id) || savedByName.get(r.name.toLowerCase());
      if (existing) {
        merged.push({
          ...existing,
          criterionId: r.id,
          criterionName: r.name,
          weight: r.weight
        });
      } else {
        merged.push({
          criterionId: r.id,
          criterionName: r.name,
          weight: r.weight,
          score: null,
          scoreScale: '0_to_100',
          scored: false,
          comment: ''
        });
      }
    }
    return merged;
  }

  return (rubric || []).map((r) => ({
    criterionId: r.id,
    criterionName: r.name,
    weight: r.weight,
    score: null,
    scoreScale: '0_to_100',
    scored: false,
    comment: ''
  }));
}

export function setHumanCriterionScore(
  scores: DraftCriterionScore[],
  index: number,
  rawScore: number
): DraftCriterionScore[] {
  if (index < 0 || index >= scores.length || !Number.isFinite(rawScore)) return scores;
  const clamped = roundWeightedScore(Math.min(100, Math.max(0, Number(rawScore))));
  return scores.map((item, idx) =>
    idx === index
      ? {
          ...item,
          score: clamped,
          scoreScale: '0_to_100',
          scored: true
        }
      : item
  );
}

export function clearHumanCriterionScore(
  scores: DraftCriterionScore[],
  index: number
): DraftCriterionScore[] {
  if (index < 0 || index >= scores.length) return scores;
  return scores.map((item, idx) =>
    idx === index ? { ...item, score: null, scored: false } : item
  );
}

export function calculateDraftWeightedPreview(scores: DraftCriterionScore[]): {
  total: number | null;
  scoredCount: number;
  totalCount: number;
  allScored: boolean;
} {
  const scoredItems: CriterionScore[] = [];
  for (const s of scores) {
    if (s.scored && typeof s.score === 'number' && Number.isFinite(s.score)) {
      scoredItems.push({
        criterionId: s.criterionId,
        criterionName: s.criterionName,
        weight: s.weight,
        score: s.score,
        scoreScale: s.scoreScale ?? '0_to_100',
        ...(s.convertedFromScale ? { convertedFromScale: s.convertedFromScale } : {}),
        comment: s.comment
      });
    }
  }
  return {
    total: scoredItems.length > 0 ? calculateWeightedTotal(scoredItems) : null,
    scoredCount: scoredItems.length,
    totalCount: scores.length,
    allScored: scores.length > 0 && scoredItems.length === scores.length
  };
}

export function validateEvaluationSubmission(params: {
  criteriaScores: DraftCriterionScore[];
  conflictOfInterest: boolean;
  conflictReason: string;
  submitFinal: boolean;
  locale?: 'en' | 'ar';
}): {
  valid: boolean;
  unscoredCriteria: string[];
  errorMessage: string;
  persistedScores: CriterionScore[];
  weightedTotal: number;
} {
  const { criteriaScores, conflictOfInterest, conflictReason, submitFinal, locale = 'en' } = params;

  if (conflictOfInterest) {
    if (!conflictReason.trim()) {
      return {
        valid: false,
        unscoredCriteria: [],
        errorMessage:
          locale === 'ar'
            ? 'يرجى توضيح سبب تعارض المصالح.'
            : 'Please describe the conflict of interest reason.',
        persistedScores: [],
        weightedTotal: 0
      };
    }
    return {
      valid: true,
      unscoredCriteria: [],
      errorMessage: '',
      persistedScores: [],
      weightedTotal: 0
    };
  }

  if (criteriaScores.length === 0) {
    return {
      valid: false,
      unscoredCriteria: [],
      errorMessage:
        locale === 'ar'
          ? 'معايير التحكيم غير متوفرة لهذا الهاكاثون. يمكنك الإبلاغ للمنظم.'
          : 'No rubric criteria are defined for this hackathon. Contact the organizer before scoring.',
      persistedScores: [],
      weightedTotal: 0
    };
  }

  const seenCriterionIds = new Set<string>();
  for (const item of criteriaScores) {
    if (!item.criterionId || !VALID_CRITERION_ID_REGEX.test(item.criterionId)) {
      return {
        valid: false,
        unscoredCriteria: [],
        errorMessage:
          locale === 'ar'
            ? 'معرّف معيار التقييم غير صالح.'
            : 'Invalid rubric criterion identifier.',
        persistedScores: [],
        weightedTotal: 0
      };
    }
    if (seenCriterionIds.has(item.criterionId)) {
      return {
        valid: false,
        unscoredCriteria: [],
        errorMessage:
          locale === 'ar'
            ? 'يوجد تكرار في معرّفات معايير التقييم.'
            : 'Duplicate rubric criterion identifiers are not allowed.',
        persistedScores: [],
        weightedTotal: 0
      };
    }
    seenCriterionIds.add(item.criterionId);
    if (!Number.isFinite(item.weight) || item.weight < 0 || item.weight > 100) {
      return {
        valid: false,
        unscoredCriteria: [],
        errorMessage:
          locale === 'ar'
            ? `وزن المعيار غير صالح: ${item.criterionName}.`
            : `Invalid weight for criterion: ${item.criterionName}.`,
        persistedScores: [],
        weightedTotal: 0
      };
    }
    if (item.scored && (item.score === null || !Number.isFinite(item.score) || item.score < 0 || item.score > 100)) {
      return {
        valid: false,
        unscoredCriteria: [],
        errorMessage:
          locale === 'ar'
            ? `الدرجة يجب أن تكون بين 0 و 100 للمعيار: ${item.criterionName}.`
            : `Score must be between 0 and 100 for criterion: ${item.criterionName}.`,
        persistedScores: [],
        weightedTotal: 0
      };
    }
  }

  const unscoredCriteria = criteriaScores
    .filter((c) => !c.scored || c.score === null || !Number.isFinite(c.score))
    .map((c) => c.criterionName);

  if (submitFinal && unscoredCriteria.length > 0) {
    const listed = unscoredCriteria.join(locale === 'ar' ? '، ' : ', ');
    return {
      valid: false,
      unscoredCriteria,
      errorMessage:
        locale === 'ar'
          ? `يجب إدخال درجة صريحة لكل معيار قبل إرسال التقييم النهائي. المعايير غير المُقيّمة: ${listed}.`
          : `All criteria must be explicitly scored before final submission. Unscored criteria: ${listed}.`,
      persistedScores: [],
      weightedTotal: 0
    };
  }

  const persistedScores: CriterionScore[] = criteriaScores
    .filter((c) => c.scored && typeof c.score === 'number' && Number.isFinite(c.score))
    .map((c) => ({
      criterionId: c.criterionId,
      criterionName: c.criterionName,
      weight: c.weight,
      score: roundWeightedScore(Number(c.score)),
      scoreScale: '0_to_100',
      comment: c.comment
    }));

  if (persistedScores.length > 0) {
    const strictCheck = calculateWeightedTotalStrict(persistedScores);
    if (!strictCheck.valid) {
      return {
        valid: false,
        unscoredCriteria,
        errorMessage:
          locale === 'ar'
            ? 'مجموع أوزان المعايير المُقيّمة يجب أن يكون أكبر من صفر.'
            : strictCheck.error || 'Total weight of scored criteria must be greater than zero.',
        persistedScores: [],
        weightedTotal: 0
      };
    }
    return {
      valid: true,
      unscoredCriteria,
      errorMessage: '',
      persistedScores,
      weightedTotal: strictCheck.weightedTotal
    };
  }

  return {
    valid: true,
    unscoredCriteria,
    errorMessage: '',
    persistedScores: [],
    weightedTotal: 0
  };
}

function getAuthoritativeEvaluationTotal(
  ev: Evaluation,
  rubric?: RubricCriterion[]
): { eligible: boolean; total: number } {
  // Draft and finalizing evaluations are never eligible for final rankings
  if (ev.status !== 'submitted' || ev.conflictOfInterest) {
    return { eligible: false, total: 0 };
  }

  if (ev.criteriaScores && ev.criteriaScores.length > 0) {
    const normalizedCriteria = normalizeCriterionScoresTo100(ev.criteriaScores, ev);
    const strict = calculateWeightedTotalStrict(normalizedCriteria, rubric);
    if (!strict.valid) {
      return { eligible: false, total: 0 };
    }
    return { eligible: true, total: strict.weightedTotal };
  }

  // In normalized v2_subcollection mode, an empty criteriaScores list after hydration means 0 persisted criterion docs
  if (ev.storageSchema === 'v2_subcollection' || (rubric && rubric.length > 0)) {
    return { eligible: false, total: 0 };
  }

  // Legacy aggregate-only evaluation fixture
  const safeTotal = Number.isFinite(ev.weightedTotal) ? Math.min(100, Math.max(0, ev.weightedTotal)) : 0;
  return { eligible: true, total: roundWeightedScore(safeTotal) };
}

export function computeFairRankings(params: {
  submissions: ProjectSubmission[];
  evaluations: Evaluation[];
  expectedJudgesPerSubmission?: number;
  rubric?: RubricCriterion[];
}): RankedSubmissionResult[] {
  const { submissions, evaluations, expectedJudgesPerSubmission = 1, rubric } = params;
  const submittedWithTotals: Array<{ eval: Evaluation; total: number }> = [];
  for (const ev of evaluations) {
    const check = getAuthoritativeEvaluationTotal(ev, rubric);
    if (check.eligible) {
      submittedWithTotals.push({ eval: ev, total: check.total });
    }
  }

  // Per-judge baseline mean/std for optional z-score fairness normalization
  const judgeScoresMap = new Map<string, number[]>();
  for (const item of submittedWithTotals) {
    const list = judgeScoresMap.get(item.eval.judgeId) ?? [];
    list.push(item.total);
    judgeScoresMap.set(item.eval.judgeId, list);
  }

  const judgeStats = new Map<string, { mean: number; std: number }>();
  for (const [judgeId, vals] of judgeScoresMap.entries()) {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance =
      vals.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / vals.length;
    judgeStats.set(judgeId, { mean, std: Math.sqrt(variance) });
  }

  const rawResults: Omit<RankedSubmissionResult, 'rank'>[] = [];

  for (const sub of submissions) {
    if (sub.status === 'draft') continue;
    const subItems = submittedWithTotals.filter((item) => item.eval.submissionId === sub.id);
    if (subItems.length === 0) {
      rawResults.push({
        submissionId: sub.id,
        teamId: sub.teamId,
        teamName: sub.teamName || sub.teamId,
        projectTitle: sub.title,
        track: sub.track || 'General',
        averageScore: 0,
        normalizedScore: 0,
        judgeCount: 0,
        disagreementSpread: 0,
        anomalyFlag: true,
        explanation: 'Missing independent human evaluations.'
      });
      continue;
    }

    const rawTotals = subItems.map((item) => item.total);
    const averageScore = roundWeightedScore(
      rawTotals.reduce((a, b) => a + b, 0) / rawTotals.length
    );
    const minScore = Math.min(...rawTotals);
    const maxScore = Math.max(...rawTotals);
    const disagreementSpread = roundWeightedScore(maxScore - minScore);

    // Calibrated normalization: adjust only when a judge evaluated >= 2 submissions with variance > 0
    const normalizedTotals = subItems.map((item) => {
      const stats = judgeStats.get(item.eval.judgeId);
      if (!stats || (judgeScoresMap.get(item.eval.judgeId)?.length ?? 0) < 2 || stats.std < 1) {
        return item.total;
      }
      const z = (item.total - stats.mean) / stats.std;
      return Math.min(100, Math.max(0, 75 + z * 12));
    });

    const normalizedScore = roundWeightedScore(
      normalizedTotals.reduce((a, b) => a + b, 0) / normalizedTotals.length
    );

    const missingEvaluations = subItems.length < expectedJudgesPerSubmission;
    const highDisagreement = disagreementSpread >= 20;
    const anomalyFlag = missingEvaluations || highDisagreement;

    const reasons: string[] = [
      `Mean of ${subItems.length} independent human evaluation(s): ${averageScore}/100`
    ];
    if (subItems.length > 1) {
      reasons.push(`Judge spread: ${disagreementSpread} pts (min ${minScore}, max ${maxScore})`);
    }
    if (highDisagreement) {
      reasons.push('Anomaly alert: judge disagreement >= 20 points requires organizer review');
    }
    if (missingEvaluations) {
      reasons.push(`Missing evaluations (${subItems.length}/${expectedJudgesPerSubmission})`);
    }

    rawResults.push({
      submissionId: sub.id,
      teamId: sub.teamId,
      teamName: sub.teamName || sub.teamId,
      projectTitle: sub.title,
      track: sub.track || 'General',
      averageScore,
      normalizedScore,
      judgeCount: subItems.length,
      disagreementSpread,
      anomalyFlag,
      explanation: reasons.join(' · ')
    });
  }

  rawResults.sort((a, b) => {
    if (b.averageScore !== a.averageScore) return b.averageScore - a.averageScore;
    if (b.normalizedScore !== a.normalizedScore) return b.normalizedScore - a.normalizedScore;
    return b.judgeCount - a.judgeCount;
  });

  return rawResults.map((item, idx) => ({
    ...item,
    rank: idx + 1
  }));
}

export interface AsyncRunToken {
  analysisSeq: number;
  selectionSeq: number;
  controller: AbortController;
}

export interface SaveRunToken {
  saveSeq: number;
  selectionSeq: number;
  submissionId: string;
}

export class JudgeWorkspaceRunCoordinator {
  private analysisSeq = 0;
  private selectionSeq = 0;
  private loadSeq = 0;
  private saveSeq = 0;
  private activeController: AbortController | null = null;
  private inFlight = false;
  private saveInFlight = false;
  private activeSaveToken: SaveRunToken | null = null;
  private activeSubmissionId: string | null = null;
  private disposed = false;

  get isRunning(): boolean {
    return this.inFlight;
  }

  get isSaving(): boolean {
    return this.saveInFlight;
  }

  get currentSelectionSeq(): number {
    return this.selectionSeq;
  }

  get currentSubmissionId(): string | null {
    return this.activeSubmissionId;
  }

  beginSubmissionSwitch(submissionId?: string | null): number {
    this.selectionSeq += 1;
    if (submissionId !== undefined) {
      this.activeSubmissionId = submissionId;
    }
    this.cancelAnalysis();
    return this.selectionSeq;
  }

  isCurrentSelection(selectionSeq: number): boolean {
    return !this.disposed && this.selectionSeq === selectionSeq;
  }

  beginLoad(): number {
    this.loadSeq += 1;
    return this.loadSeq;
  }

  isCurrentLoad(loadSeq: number): boolean {
    return !this.disposed && this.loadSeq === loadSeq;
  }

  startSave(submissionId: string): SaveRunToken | null {
    if (this.disposed || this.saveInFlight) return null;
    this.saveSeq += 1;
    this.saveInFlight = true;
    const token: SaveRunToken = {
      saveSeq: this.saveSeq,
      selectionSeq: this.selectionSeq,
      submissionId
    };
    this.activeSaveToken = token;
    return token;
  }

  isCurrentSave(token: SaveRunToken): boolean {
    return (
      !this.disposed &&
      this.saveSeq === token.saveSeq &&
      this.selectionSeq === token.selectionSeq &&
      this.activeSaveToken?.saveSeq === token.saveSeq
    );
  }

  finishSave(token: SaveRunToken): boolean {
    if (
      this.saveSeq === token.saveSeq &&
      this.activeSaveToken?.saveSeq === token.saveSeq
    ) {
      this.saveInFlight = false;
      this.activeSaveToken = null;
      return true;
    }
    return false;
  }

  startAnalysis(): AsyncRunToken | null {
    if (this.disposed || this.inFlight) return null;
    this.analysisSeq += 1;
    const controller = new AbortController();
    this.activeController = controller;
    this.inFlight = true;
    return {
      analysisSeq: this.analysisSeq,
      selectionSeq: this.selectionSeq,
      controller
    };
  }

  cancelAnalysis(): boolean {
    const wasRunning = this.inFlight || this.activeController !== null;
    this.analysisSeq += 1;
    if (this.activeController) {
      const ctrl = this.activeController;
      this.activeController = null;
      ctrl.abort();
    }
    this.inFlight = false;
    return wasRunning;
  }

  isCurrentAnalysis(token: AsyncRunToken): boolean {
    return (
      !this.disposed &&
      !token.controller.signal.aborted &&
      this.analysisSeq === token.analysisSeq &&
      this.selectionSeq === token.selectionSeq &&
      this.activeController === token.controller
    );
  }

  finishAnalysis(token: AsyncRunToken): boolean {
    if (
      this.analysisSeq === token.analysisSeq &&
      this.activeController === token.controller
    ) {
      this.activeController = null;
      this.inFlight = false;
      return true;
    }
    return false;
  }

  dispose(): void {
    this.disposed = true;
    this.selectionSeq += 1;
    this.loadSeq += 1;
    this.saveSeq += 1;
    this.saveInFlight = false;
    this.activeSaveToken = null;
    this.cancelAnalysis();
  }
}

