import type {
  AIJudgingRecommendation,
  HumanCriterionEvaluation,
  OfficialCriterionDefinition,
  OfficialCriterionId
} from './types';

export const CRITERIA_VERSION = 'v2.4criteria.2026-11';
export const ANALYSIS_VERSION = 'v2.evidence.1';
export const EVIDENCE_COLLECTOR_VERSION = 'v2.collector.2';

export const OFFICIAL_JUDGING_CRITERIA: readonly OfficialCriterionDefinition[] = [
  {
    id: 'innovation_originality',
    name: 'Innovation & Originality',
    nameAr: 'الابتكار والأصالة',
    weight: 0.25,
    weightPercent: 25,
    description:
      'Evaluate the project idea, innovative approach, differentiation, and originality based on available project evidence. Never claim plagiarism detection or complete originality without reliable verification.',
    descriptionAr:
      'تقييم فكرة المشروع والنهج الابتكاري والتميّز والأصالة بناءً على الأدلة المتاحة فقط، دون ادعاء كشف الانتحال أو إثبات الأصالة الكاملة بلا وسيلة موثوقة.',
    evidenceStandard:
      'Compare stated problem-solution framing against inspected architecture, unique integrations, and technical approach.',
    evidenceStandardAr:
      'مقارنة صياغة المشكلة والحل مع البنية البرمجية المفحوصة والتكاملات والمنهجية التقنية الفعلية.'
  },
  {
    id: 'technical_implementation',
    name: 'Technical Implementation',
    nameAr: 'التنفيذ التقني',
    weight: 0.3,
    weightPercent: 30,
    description:
      'Evaluate actual implementation, source code, architecture, working integrations, dependencies, and verifiable functionality. Never award technical credit based only on descriptions or README files.',
    descriptionAr:
      'تقييم التنفيذ الفعلي والشيفرة المصدرية والمعمارية والتكاملات والاعتماديات والوظائف القابلة للتحقق، دون منح رصيد تقني اعتماداً على الوصف أو README فقط.',
    evidenceStandard:
      'Inspect real source files, API handlers, data models, dependencies, and verified executed tests.',
    evidenceStandardAr:
      'فحص الملفات المصدرية الفعلية ونقاط النهاية ونماذج البيانات والاعتماديات ونتائج الاختبارات المنفّذة فعلياً.'
  },
  {
    id: 'real_world_impact',
    name: 'Real-World Impact',
    nameAr: 'الأثر الواقعي',
    weight: 0.25,
    weightPercent: 25,
    description:
      'Evaluate the problem addressed, target users, practical usefulness, relevance, and plausible real-world value. Strictly distinguish demonstrated impact from potential impact and never invent users or adoption.',
    descriptionAr:
      'تقييم المشكلة المستهدفة والمستخدمين والجدوى العملية والملاءمة والقيمة الواقعية المحتملة مع التفريق الواضح بين الأثر المُثبت والأثر المحتمل.',
    evidenceStandard:
      'Inspect concrete domain workflows, accessibility, operational constraints, and verifiable evidence of deployment or real usage.',
    evidenceStandardAr:
      'فحص مسارات العمل الواقعية وقابلية الاستخدام والقيود التشغيلية وأي دليل فعلي على النشر أو الاستخدام.'
  },
  {
    id: 'ux_completeness',
    name: 'User Experience & Completeness',
    nameAr: 'تجربة المستخدم والاكتمال',
    weight: 0.2,
    weightPercent: 20,
    description:
      'Evaluate the accessible application interface, usability, navigation, implemented features, and working user workflows. Never assume an app works merely because its URL responds.',
    descriptionAr:
      'تقييم واجهة التطبيق المتاحة وسهولة الاستخدام والتنقل والمزايا المنفّذة ومسارات المستخدم العاملة، دون افتراض عمل التطبيق لمجرد استجابة الرابط.',
    evidenceStandard:
      'Combine accessible UI code inspection, server HTTP probe checks, and manual judge workflow verification.',
    evidenceStandardAr:
      'الجمع بين فحص شيفرة الواجهة وفحص الخادم التمهيدي والتحقق اليدوي لمسارات المستخدم من المحكم.'
  }
] as const;

export const OFFICIAL_CRITERION_IDS: readonly OfficialCriterionId[] = [
  'innovation_originality',
  'technical_implementation',
  'real_world_impact',
  'ux_completeness'
] as const;

export const OFFICIAL_CRITERIA_MAP: Record<OfficialCriterionId, OfficialCriterionDefinition> = {
  innovation_originality: OFFICIAL_JUDGING_CRITERIA[0],
  technical_implementation: OFFICIAL_JUDGING_CRITERIA[1],
  real_world_impact: OFFICIAL_JUDGING_CRITERIA[2],
  ux_completeness: OFFICIAL_JUDGING_CRITERIA[3]
};

export function roundScoreTwoDecimals(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

export function getTotalOfficialWeightPercent(): number {
  return OFFICIAL_JUDGING_CRITERIA.reduce((sum, c) => sum + c.weightPercent, 0);
}

export function isOfficialCriterionId(id: string): id is OfficialCriterionId {
  return (OFFICIAL_CRITERION_IDS as readonly string[]).includes(id);
}

export interface FourCriteriaValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates that ONLY the four official criteria exist, there are no fifth criteria,
 * no bonus/penalty adjustments, and all scores fall strictly in [0, 100].
 */
export function validateFourCriteriaScores(
  criteria: Record<string, Pick<HumanCriterionEvaluation, 'criterionId' | 'score'>>,
  options?: { requireAllScored?: boolean }
): FourCriteriaValidationResult {
  const keys = Object.keys(criteria || {});
  const allowedSet = new Set<string>(OFFICIAL_CRITERION_IDS);

  for (const key of keys) {
    if (!allowedSet.has(key)) {
      return {
        valid: false,
        error: `Unsupported judging criterion "${key}". Only the four official criteria are permitted.`
      };
    }
  }

  for (const id of OFFICIAL_CRITERION_IDS) {
    const entry = criteria[id];
    if (!entry || entry.criterionId !== id) {
      return {
        valid: false,
        error: `Missing required official criterion "${id}".`
      };
    }
    if (entry.score === null || entry.score === undefined) {
      if (options?.requireAllScored) {
        return {
          valid: false,
          error: `Criterion "${OFFICIAL_CRITERIA_MAP[id].name}" requires a numeric score from 0 to 100.`
        };
      }
      continue;
    }
    if (typeof entry.score !== 'number' || !Number.isFinite(entry.score)) {
      return {
        valid: false,
        error: `Invalid score for "${OFFICIAL_CRITERIA_MAP[id].name}".`
      };
    }
    if (entry.score < 0 || entry.score > 100) {
      return {
        valid: false,
        error: `Score for "${OFFICIAL_CRITERIA_MAP[id].name}" must be between 0 and 100.`
      };
    }
  }

  return { valid: true };
}

/**
 * Exact official formula:
 * Final Score = (Innovation * 0.25) + (Technical Implementation * 0.30) + (Real-World Impact * 0.25) + (User Experience & Completeness * 0.20)
 */
export function calculateOfficialWeightedScore(
  criteria: Record<OfficialCriterionId, Pick<HumanCriterionEvaluation, 'criterionId' | 'score'>>
): number | null {
  const validation = validateFourCriteriaScores(criteria, { requireAllScored: true });
  if (!validation.valid) {
    return null;
  }
  const innovation = criteria.innovation_originality.score as number;
  const technical = criteria.technical_implementation.score as number;
  const impact = criteria.real_world_impact.score as number;
  const ux = criteria.ux_completeness.score as number;

  const total = innovation * 0.25 + technical * 0.3 + impact * 0.25 + ux * 0.2;
  return roundScoreTwoDecimals(total);
}

export function calculateDraftWeightedPreview(
  criteria: Record<OfficialCriterionId, Pick<HumanCriterionEvaluation, 'criterionId' | 'score'>>
): {
  scoredCount: number;
  weightedSoFar: number;
  finalWeightedScore: number | null;
  complete: boolean;
} {
  let scoredCount = 0;
  let weightedSoFar = 0;

  for (const def of OFFICIAL_JUDGING_CRITERIA) {
    const score = criteria[def.id]?.score;
    if (typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100) {
      scoredCount += 1;
      weightedSoFar += score * def.weight;
    }
  }

  const finalWeightedScore =
    scoredCount === OFFICIAL_JUDGING_CRITERIA.length
      ? calculateOfficialWeightedScore(criteria)
      : null;

  return {
    scoredCount,
    weightedSoFar: roundScoreTwoDecimals(weightedSoFar),
    finalWeightedScore,
    complete: scoredCount === OFFICIAL_JUDGING_CRITERIA.length
  };
}

export function calculateAIWeightedPreview(
  rec: AIJudgingRecommendation['criteriaRecommendations']
): number {
  const total =
    rec.innovation_originality.recommendedScore * 0.25 +
    rec.technical_implementation.recommendedScore * 0.3 +
    rec.real_world_impact.recommendedScore * 0.25 +
    rec.ux_completeness.recommendedScore * 0.2;
  return roundScoreTwoDecimals(total);
}
