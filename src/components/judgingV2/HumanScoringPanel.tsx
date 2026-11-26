import { CheckCircle2, Download, Lock, Save, ShieldCheck } from 'lucide-react';
import {
  calculateDraftWeightedPreview,
  OFFICIAL_JUDGING_CRITERIA
} from '../../services/judgingV2/criteria';
import type {
  HumanJudgingEvaluation,
  OfficialCriterionId
} from '../../services/judgingV2/types';

interface Props {
  locale: 'en' | 'ar';
  evaluation: HumanJudgingEvaluation;
  canApproveAsJudge: boolean;
  actionFeedback: { type: 'ok' | 'error'; text: string } | null;
  onScoreChange: (criterionId: OfficialCriterionId, score: number | null) => void;
  onRationaleChange: (criterionId: OfficialCriterionId, rationale: string) => void;
  onOverallCommentsChange: (comments: string) => void;
  onSaveDraft: () => void;
  onApproveOfficial: () => void;
  onExportAuditJson: () => void;
}

export function HumanScoringPanel({
  locale,
  evaluation,
  canApproveAsJudge,
  actionFeedback,
  onScoreChange,
  onRationaleChange,
  onOverallCommentsChange,
  onSaveDraft,
  onApproveOfficial,
  onExportAuditJson
}: Props) {
  const isAr = locale === 'ar';
  const isLocked = evaluation.status === 'approved';
  const preview = calculateDraftWeightedPreview(evaluation.criteria);

  const innovationScore = evaluation.criteria.innovation_originality.score ?? 0;
  const technicalScore = evaluation.criteria.technical_implementation.score ?? 0;
  const impactScore = evaluation.criteria.real_world_impact.score ?? 0;
  const uxScore = evaluation.criteria.ux_completeness.score ?? 0;

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {isLocked ? (
              <Lock className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
            )}
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              {isAr
                ? 'التقييم الرسمي للمحكم البشري (المعايير الأربعة المعتمدة فقط)'
                : 'Official Human Judge Scoring (Strictly 4 Fixed Criteria)'}
            </h2>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {isAr
              ? 'يحفظ التقييم محلياً في المتصفح (localStorage) لحماية بيانات التحكيم السابقة وقواعد Firestore الحالية. الاعتماد النهائي يغلق التعديل.'
              : 'Saved in browser-local judgingV2 storage so legacy Firestore evaluations and security rules remain untouched. Final approval locks scores permanently.'}
          </p>
        </div>

        <div className="text-end space-y-0.5">
          <div className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
            {isLocked
              ? isAr
                ? 'النتيجة النهائية المعتمدة'
                : 'Approved Final Score'
              : isAr
                ? 'المجموع الموزون الحالي'
                : 'Live Weighted Score'}
          </div>
          <div className="text-2xl font-mono font-bold tabular-nums text-slate-900 dark:text-white">
            {preview.finalWeightedScore !== null
              ? `${preview.finalWeightedScore.toFixed(2)} / 100`
              : `${preview.weightedSoFar.toFixed(2)} / 100`}
          </div>
          <div className="text-[11px] font-mono tabular-nums text-slate-500">
            ({innovationScore}×0.25) + ({technicalScore}×0.30) + ({impactScore}×0.25) + ({uxScore}×0.20)
          </div>
        </div>
      </div>

      {isLocked && (
        <div className="flex items-center gap-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>
            {isAr
              ? `تم اعتماد التقييم الرسمي من المحكم (${evaluation.judgeName}) بتاريخ ${evaluation.approvedAt ? new Date(evaluation.approvedAt).toLocaleString() : ''}.`
              : `Officially approved & locked by ${evaluation.judgeName}${evaluation.approvedAt ? ` at ${new Date(evaluation.approvedAt).toLocaleString()}` : ''}.`}
          </span>
        </div>
      )}

      <div className="divide-y divide-slate-200 dark:divide-slate-800">
        {OFFICIAL_JUDGING_CRITERIA.map((def) => {
          const entry = evaluation.criteria[def.id];
          const numericVal = entry.score;
          const contribution =
            typeof numericVal === 'number' ? (numericVal * def.weight).toFixed(2) : '0.00';

          return (
            <div key={def.id} className="py-4 first:pt-0 last:pb-0 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1 max-w-2xl">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                      {isAr ? def.nameAr : def.name}
                    </h3>
                    <span className="font-mono tabular-nums text-xs font-semibold text-blue-700 dark:text-blue-400">
                      {def.weightPercent}%
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    {isAr ? def.descriptionAr : def.description}
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {isAr ? def.evidenceStandardAr : def.evidenceStandard}
                  </p>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <div className="space-y-1">
                    <label
                      htmlFor={`score_${def.id}`}
                      className="block text-[11px] font-medium text-slate-500 dark:text-slate-400"
                    >
                      {isAr ? 'الدرجة (0–100)' : 'Score (0–100)'}
                    </label>
                    <input
                      id={`score_${def.id}`}
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      disabled={isLocked || !canApproveAsJudge}
                      value={numericVal === null ? '' : numericVal}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        if (!raw) {
                          onScoreChange(def.id, null);
                          return;
                        }
                        const parsed = Number(raw);
                        if (Number.isFinite(parsed)) {
                          onScoreChange(def.id, Math.max(0, Math.min(100, parsed)));
                        }
                      }}
                      className="w-24 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 font-mono text-sm tabular-nums text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
                    />
                  </div>
                  <div className="space-y-1 text-end">
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {isAr ? 'المساهمة الموزونة' : 'Weighted'}
                    </div>
                    <div className="font-mono text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-200 py-1.5">
                      +{contribution}
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <textarea
                  rows={2}
                  disabled={isLocked || !canApproveAsJudge}
                  value={entry.rationale}
                  onChange={(e) => onRationaleChange(def.id, e.target.value)}
                  placeholder={
                    isAr
                      ? 'اكتب مبرر المحكم المبني على الأدلة لهذا المعيار...'
                      : 'Enter human judge evidence-based rationale for this criterion...'
                  }
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-2">
        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
          {isAr ? 'ملاحظات المحكم العامة' : 'Overall Human Judge Comments'}
        </label>
        <textarea
          rows={2}
          disabled={isLocked || !canApproveAsJudge}
          value={evaluation.overallComments}
          onChange={(e) => onOverallCommentsChange(e.target.value)}
          placeholder={
            isAr
              ? 'ملخص التقييم النهائي والتوصيات...'
              : 'Overall evaluation notes and verification summary...'
          }
          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
        />
      </div>

      {actionFeedback && (
        <p
          className={`text-xs font-medium ${
            actionFeedback.type === 'ok'
              ? 'text-emerald-700 dark:text-emerald-400'
              : 'text-red-700 dark:text-red-400'
          }`}
        >
          {actionFeedback.text}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <button
          type="button"
          onClick={onExportAuditJson}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <Download className="h-3.5 w-3.5" />
          <span>{isAr ? 'تصدير سجل التحكيم JSON' : 'Export Evidence & Score JSON'}</span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isLocked || !canApproveAsJudge}
            onClick={onSaveDraft}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            <span>{isAr ? 'حفظ المسودة' : 'Save Draft'}</span>
          </button>

          <button
            type="button"
            disabled={isLocked || !canApproveAsJudge || !preview.complete}
            onClick={onApproveOfficial}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 text-white px-4 py-2 text-xs font-semibold hover:bg-emerald-700 disabled:opacity-50"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>
              {isLocked
                ? isAr
                  ? 'معتمد ومغلق'
                  : 'Approved & Locked'
                : isAr
                  ? 'اعتماد النتيجة النهائية الرسمية'
                  : 'Finalize & Approve Official Evaluation'}
            </span>
          </button>
        </div>
      </div>
    </section>
  );
}
