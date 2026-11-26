import { AlertCircle, Shield, Sparkles } from 'lucide-react';
import { OFFICIAL_JUDGING_CRITERIA } from '../../services/judgingV2/criteria';
import type { AIJudgingRecommendation } from '../../services/judgingV2/types';

interface Props {
  locale: 'en' | 'ar';
  recommendation: AIJudgingRecommendation | null;
  quotaSafeMode: boolean;
  quotaStopped: boolean;
  quotaStopReason: string | null;
}

export function AIRecommendationsPanel({
  locale,
  recommendation,
  quotaSafeMode,
  quotaStopped,
  quotaStopReason
}: Props) {
  const isAr = locale === 'ar';

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              {isAr
                ? 'توصيات الذكاء الاصطناعي الاستشارية (غير ملزمة)'
                : 'Advisory AI Recommendations (Non-Binding)'}
            </h2>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {isAr
              ? 'هذا القسم استشاري فقط للمحكم البشري. لا يكتب الذكاء الاصطناعي الدرجات الرسمية ولا يعتمد التقييم مطلقاً.'
              : 'Strictly advisory context for the human judge. AI never overwrites, initializes, or approves official scores.'}
          </p>
        </div>

        {recommendation && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
            <span>
              {isAr ? 'الدرجة الاستشارية:' : 'Advisory Score:'}{' '}
              <strong className="text-blue-700 dark:text-blue-300">
                {recommendation.advisoryWeightedScore.toFixed(2)}/100
              </strong>
            </span>
            <span>·</span>
            <span>{recommendation.modelUsed}</span>
            <span>·</span>
            <span>
              {recommendation.fromCache
                ? isAr
                  ? 'من الكاش (0 طلبات)'
                  : 'FROM CACHE (0 requests)'
                : `${recommendation.inferenceSource} (${recommendation.geminiRequestsUsed} req)`}
            </span>
          </div>
        )}
      </div>

      {!recommendation ? (
        <div className="py-4 space-y-2 text-xs text-slate-600 dark:text-slate-400">
          <div className="flex items-start gap-2">
            <Shield className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
            <span>
              {quotaStopped
                ? isAr
                  ? `تم إيقاف التحليل السحابي لحماية الحصة (${quotaStopReason || 'الحد اليومي'}). يمكنك الاستمرار في التحكيم البشري الكامل اعتماداً على الأدلة المجمعة أعلاه.`
                  : `Cloud analysis stopped (${quotaStopReason || 'quota limit'}). You can complete full human judging directly from the verified evidence above.`
                : quotaSafeMode
                  ? isAr
                    ? 'لم يتم إرسال أي طلب إلى Gemini لأن وضع الأمان للحصة نشط. اجمع الأدلة أولاً ثم فعّل التفويض الصريح أعلاه إذا رغبت في الحصول على توصية استشارية.'
                    : 'No Gemini request has been sent (QUOTA-SAFE MODE active). Collect project evidence first, then explicitly authorize a single Gemini request above if an advisory breakdown is needed.'
                  : isAr
                    ? 'التفويض جاهز — اضغط زر تشغيل توصية Gemini بعد جمع الأدلة.'
                    : 'Ready to run single authorized Gemini recommendation once evidence is collected.'}
            </span>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
            {recommendation.overallSummary}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 divide-y md:divide-y-0 divide-slate-200 dark:divide-slate-800">
            {OFFICIAL_JUDGING_CRITERIA.map((def) => {
              const item = recommendation.criteriaRecommendations[def.id];
              return (
                <div
                  key={def.id}
                  className="pt-3 md:pt-0 space-y-2 border-t md:border-t-0 md:border-s md:first:border-s-0 md:odd:border-s-0 border-slate-200 dark:border-slate-800 md:even:ps-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold text-slate-900 dark:text-white">
                        {isAr ? def.nameAr : def.name}
                      </div>
                      <div className="text-[11px] font-mono tabular-nums text-slate-500">
                        {isAr ? 'الوزن:' : 'Weight:'} {def.weightPercent}% · {isAr ? 'الثقة:' : 'Confidence:'}{' '}
                        {item.confidence}
                      </div>
                    </div>
                    <div className="text-base font-mono font-bold tabular-nums text-blue-700 dark:text-blue-300">
                      {item.recommendedScore}/100
                    </div>
                  </div>

                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    {item.scoringExplanation}
                  </p>

                  {item.verifiedEvidence.length > 0 && (
                    <div className="text-[11px] text-emerald-700 dark:text-emerald-300">
                      <span className="font-semibold">
                        {isAr ? 'الأدلة المستشهد بها: ' : 'Cited Evidence: '}
                      </span>
                      {item.verifiedEvidence.join(' · ')}
                    </div>
                  )}

                  {item.strengths.length > 0 && (
                    <div className="text-[11px] text-slate-600 dark:text-slate-400">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        {isAr ? 'نقاط القوة: ' : 'Strengths: '}
                      </span>
                      {item.strengths.join(' · ')}
                    </div>
                  )}

                  {item.weaknesses.length > 0 && (
                    <div className="text-[11px] text-slate-600 dark:text-slate-400">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        {isAr ? 'نقاط الضعف: ' : 'Weaknesses: '}
                      </span>
                      {item.weaknesses.join(' · ')}
                    </div>
                  )}

                  {item.missingOrUnverifiedEvidence.length > 0 && (
                    <div className="text-[11px] text-amber-700 dark:text-amber-300 flex items-start gap-1">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>
                        <strong className="font-semibold">
                          {isAr ? 'أدلة غير موثقة: ' : 'Unverified: '}
                        </strong>
                        {item.missingOrUnverifiedEvidence.join(' · ')}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
