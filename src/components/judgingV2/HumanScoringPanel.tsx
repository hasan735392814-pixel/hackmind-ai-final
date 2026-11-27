import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Download,
  Lock,
  Save,
  ShieldAlert,
  ShieldCheck
} from 'lucide-react';
import {
  calculateDraftWeightedPreview,
  getDefaultActiveCriteria
} from '../../services/judgingV2/criteria';
import type {
  ActiveCriterionDefinition,
  HumanJudgingEvaluation
} from '../../services/judgingV2/types';

interface Props {
  locale: 'en' | 'ar';
  evaluation: HumanJudgingEvaluation;
  activeCriteria?: ActiveCriterionDefinition[];
  isCustomRubric?: boolean;
  rubricError?: string | null;
  canApproveAsJudge: boolean;
  saving?: boolean;
  actionFeedback: { type: 'ok' | 'error'; text: string } | null;
  onScoreChange: (criterionId: string, score: number | null) => void;
  onRationaleChange: (criterionId: string, rationale: string) => void;
  onOverallCommentsChange: (comments: string) => void;
  onToggleCoi?: (coi: boolean) => void;
  onCoiReasonChange?: (reason: string) => void;
  onSaveDraft: () => void;
  onApproveOfficial: () => void;
  onExportAuditJson: () => void;
}

export function HumanScoringPanel({
  locale,
  evaluation,
  activeCriteria,
  isCustomRubric = false,
  rubricError = null,
  canApproveAsJudge,
  saving = false,
  actionFeedback,
  onScoreChange,
  onRationaleChange,
  onOverallCommentsChange,
  onToggleCoi,
  onCoiReasonChange,
  onSaveDraft,
  onApproveOfficial,
  onExportAuditJson
}: Props) {
  const isAr = locale === 'ar';
  const isLocked = evaluation.status === 'approved';
  const criteriaDefs =
    activeCriteria && activeCriteria.length > 0 ? activeCriteria : getDefaultActiveCriteria();
  const preview = calculateDraftWeightedPreview(evaluation.criteria, criteriaDefs);
  const isCoi = Boolean(evaluation.conflictOfInterest);
  const coiReady = isCoi && Boolean(evaluation.conflictReason?.trim());
  const canFinalize = !isLocked && canApproveAsJudge && !saving && !rubricError && (isCoi ? coiReady : preview.complete);

  const formulaText = criteriaDefs
    .map((def) => {
      const val = evaluation.criteria[def.id]?.score ?? 0;
      const w = (def.weightPercent / 100).toFixed(2);
      return `(${val}×${w})`;
    })
    .join(' + ');

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
              {isCustomRubric
                ? isAr
                  ? `التقييم الرسمي للمحكم البشري (${criteriaDefs.length} معايير مخصصة)`
                  : `Official Human Judge Scoring (${criteriaDefs.length} Organizer Rubric Criteria)`
                : isAr
                  ? 'التقييم الرسمي للمحكم البشري (المعايير الأربعة المعتمدة)'
                  : 'Official Human Judge Scoring (Canonical 4 Criteria)'}
            </h2>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {isAr
              ? 'تُحفظ التقييمات المعتمدة رسمياً في Cloud Firestore (/evaluations). يُستخدم التخزين المحلي كمسودة مؤقتة عند انقطاع الاتصال فقط.'
              : 'Authoritative evaluations persist in Cloud Firestore (/evaluations). Browser storage acts solely as an offline draft cache.'}
          </p>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400 pt-0.5">
            <span className="inline-flex items-center gap-1">
              <Cloud className="h-3.5 w-3.5" />
              <span>
                {evaluation.syncState === 'synced'
                  ? isAr
                    ? 'متزامن مع Firestore'
                    : 'Synced with Firestore'
                  : evaluation.syncState === 'finalizing'
                    ? isAr
                      ? 'بانتظار إكمال الاعتماد في Firestore'
                      : 'Pending finalization in Firestore'
                    : evaluation.syncState === 'sync_error'
                      ? isAr
                        ? 'فشلت مزامنة Firestore — التعديلات محفوظة محلياً'
                        : 'Firestore sync error — draft preserved locally'
                      : isAr
                        ? 'مسودة محلية غير مرسلة بعد'
                        : 'Local draft (not yet synced to Firestore)'}
              </span>
            </span>
            {evaluation.convertedFromScale === '0_to_10' && (
              <span className="text-amber-600 dark:text-amber-400">
                {isAr
                  ? 'تم تحويل الدرجات التاريخية (0–10) غير تدميرياً إلى مقياس 0–100'
                  : 'Historical 0–10 scores normalized non-destructively to 0–100'}
              </span>
            )}
          </div>
        </div>

        <div className="text-end space-y-0.5">
          <div className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
            {isCoi
              ? isAr
                ? 'تعارض مصالح مُعلن'
                : 'Conflict of Interest'
              : isLocked
                ? isAr
                  ? 'النتيجة النهائية المعتمدة'
                  : 'Approved Final Score'
                : isAr
                  ? 'المجموع الموزون الحالي'
                  : 'Live Weighted Score'}
          </div>
          <div className="text-2xl font-mono font-bold tabular-nums text-slate-900 dark:text-white">
            {isCoi
              ? 'COI (0.00)'
              : preview.finalWeightedScore !== null
                ? `${preview.finalWeightedScore.toFixed(2)} / 100`
                : `${preview.weightedSoFar.toFixed(2)} / 100`}
          </div>
          {!isCoi && (
            <div className="text-[11px] font-mono tabular-nums text-slate-500">
              {formulaText}
            </div>
          )}
        </div>
      </div>

      {rubricError && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{rubricError}</span>
        </div>
      )}

      {evaluation.needsFinalizingRecovery && !isLocked && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            {isAr
              ? 'انقطعت عملية الإرسال النهائي السابقة قبل الاكتمال. تم استرجاع الدرجات المحفوظة في Firestore — راجعها ثم اضغط "اعتماد النتيجة النهائية الرسمية" أو "حفظ المسودة".'
              : 'Previous final submission was interrupted before completion. Saved Firestore criterion scores have been restored — review and click "Finalize & Approve Official Evaluation" or "Save Draft".'}
          </span>
        </div>
      )}

      {!canApproveAsJudge && (
        <div className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 p-3 text-xs text-slate-600 dark:text-slate-300">
          {isAr
            ? 'للقراءة فقط: يجب قبول تكليف التحكيم لهذا المشروع دون تعارض مصالح قبل إدخال أو اعتماد الدرجات.'
            : 'Read-only preview: an accepted, unconflicted judge assignment covering this submission is required to submit official evaluations.'}
        </div>
      )}

      {isLocked && (
        <div className="flex items-center gap-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>
            {isAr
              ? `تم اعتماد التقييم الرسمي من المحكم (${evaluation.judgeName}) بتاريخ ${evaluation.approvedAt ? new Date(evaluation.approvedAt).toLocaleString() : ''}.`
              : `Officially approved & locked in Firestore by ${evaluation.judgeName}${evaluation.approvedAt ? ` at ${new Date(evaluation.approvedAt).toLocaleString()}` : ''}.`}
          </span>
        </div>
      )}

      {/* Submission-level Conflict of Interest Declaration */}
      {onToggleCoi && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 p-3.5 space-y-2.5">
          <label className="flex items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={isCoi}
              disabled={isLocked || !canApproveAsJudge || saving}
              onChange={(e) => onToggleCoi(e.target.checked)}
            />
            <ShieldAlert className="h-4 w-4 text-amber-500 shrink-0" />
            <span>
              {isAr
                ? 'الإبلاغ عن تعارض مصالح لهذا التسليم (يُستبعد من الترتيب دون درجات)'
                : 'Declare Conflict of Interest for this submission (excludes from scoring with 0 criteria)'}
            </span>
          </label>
          {isCoi && (
            <textarea
              rows={2}
              disabled={isLocked || !canApproveAsJudge || saving}
              value={evaluation.conflictReason || ''}
              onChange={(e) => onCoiReasonChange?.(e.target.value)}
              placeholder={
                isAr
                  ? 'اشرح سبب تعارض المصالح (مطلوب)...'
                  : 'Describe the conflict of interest reason (required)...'
              }
              className="w-full rounded-lg border border-amber-400/50 dark:border-amber-500/40 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-60"
            />
          )}
        </div>
      )}

      {!isCoi && (
        <div className="divide-y divide-slate-200 dark:divide-slate-800">
          {criteriaDefs.map((def) => {
            const entry = evaluation.criteria[def.id] || {
              criterionId: def.id,
              score: null,
              rationale: ''
            };
            const numericVal = entry.score;
            const contribution =
              typeof numericVal === 'number'
                ? ((numericVal * def.weightPercent) / 100).toFixed(2)
                : '0.00';

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
                    {def.description && (
                      <p className="text-xs text-slate-600 dark:text-slate-400">
                        {isAr ? def.descriptionAr : def.description}
                      </p>
                    )}
                    {def.evidenceStandard && (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {isAr ? def.evidenceStandardAr : def.evidenceStandard}
                      </p>
                    )}
                  </div>

                  <div className="flex items-end gap-3 shrink-0">
                    <div className="space-y-1">
                      <label
                        htmlFor={`score_${def.id}`}
                        className="block text-[11px] font-medium text-slate-500 dark:text-slate-400"
                      >
                        {isAr ? 'الدرجة (0–100)' : 'Score (0–100)'}
                      </label>
                      <div className="flex items-center gap-1.5">
                        <input
                          id={`score_${def.id}`}
                          aria-label={`${def.name} score`}
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          disabled={isLocked || !canApproveAsJudge || saving}
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
                        {!isLocked && canApproveAsJudge && numericVal !== null && (
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => onScoreChange(def.id, null)}
                            className="rounded border border-slate-300 dark:border-slate-700 px-2 py-1.5 text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                          >
                            {isAr ? 'مسح' : 'Clear'}
                          </button>
                        )}
                      </div>
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
                    disabled={isLocked || !canApproveAsJudge || saving}
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
      )}

      <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-2">
        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
          {isAr ? 'ملاحظات المحكم العامة' : 'Overall Human Judge Comments'}
        </label>
        <textarea
          rows={2}
          disabled={isLocked || !canApproveAsJudge || saving}
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
          role={actionFeedback.type === 'error' ? 'alert' : 'status'}
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
            disabled={isLocked || !canApproveAsJudge || saving || Boolean(rubricError)}
            onClick={onSaveDraft}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            <span>{saving ? (isAr ? 'جاري الحفظ...' : 'Saving...') : isAr ? 'حفظ المسودة' : 'Save Draft'}</span>
          </button>

          <button
            type="button"
            disabled={!canFinalize}
            onClick={onApproveOfficial}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 text-white px-4 py-2 text-xs font-semibold hover:bg-emerald-700 disabled:opacity-50"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>
              {isLocked
                ? isAr
                  ? 'معتمد ومغلق'
                  : 'Approved & Locked'
                : saving
                  ? isAr
                    ? 'جاري الاعتماد...'
                    : 'Submitting...'
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
