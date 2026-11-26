import { InferenceMode } from 'firebase/ai';
import {
  AlertTriangle,
  Database,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2
} from 'lucide-react';
import { InferenceModeSelector } from '../common/InferenceModeSelector';
import type {
  AnalysisCheckpoint,
  AnalysisJobStatus,
  QuotaGuardState
} from '../../services/judgingV2/types';

interface Props {
  locale: 'en' | 'ar';
  guardState: QuotaGuardState;
  jobStatus: AnalysisJobStatus;
  cacheKey: string | null;
  hasCacheHit: boolean;
  checkpoint: AnalysisCheckpoint | null;
  hasBundle: boolean;
  batchProgress: { completed: number; total: number } | null;
  preferredMode: InferenceMode;
  cloudConsent: boolean;
  explicitAuthorized: boolean;
  onToggleAuthorizeGemini: (authorized: boolean) => void;
  onModeChange: (mode: InferenceMode) => void;
  onGrantCloudConsent: () => Promise<void>;
  onCollectEvidence: (resume: boolean) => void;
  onCancelJob: () => void;
  onLoadCachedRecommendation: () => void;
  onRunGeminiAnalysis: () => void;
  onClearCache: () => void;
  onClearCheckpoint: () => void;
  statusMessage: string | null;
}

export function QuotaAndJobControlBar({
  locale,
  guardState,
  jobStatus,
  cacheKey,
  hasCacheHit,
  checkpoint,
  hasBundle,
  batchProgress,
  preferredMode: _preferredMode,
  cloudConsent,
  explicitAuthorized,
  onToggleAuthorizeGemini,
  onModeChange,
  onGrantCloudConsent,
  onCollectEvidence,
  onCancelJob,
  onLoadCachedRecommendation,
  onRunGeminiAnalysis,
  onClearCache,
  onClearCheckpoint,
  statusMessage
}: Props) {
  const isAr = locale === 'ar';
  const isCollecting = jobStatus === 'COLLECTING_EVIDENCE';
  const isRunningGemini = jobStatus === 'RUNNING_GEMINI' || guardState.requestInFlight;
  const isBusy = isCollecting || isRunningGemini;

  const canResumeCheckpoint =
    Boolean(checkpoint) &&
    checkpoint!.status !== 'COMPLETED' &&
    checkpoint!.inspectedPaths.length > 0;

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              {isAr
                ? 'التحكم في الأدلة وحماية حصة Gemini 4 Hydrogen'
                : 'Evidence Pipeline & Gemini 4 Hydrogen Quota Guard'}
            </h2>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {isAr
              ? 'وضع الأمان للحصة مُفعّل افتراضياً: لا تُرسل أي طلبات Gemini تلقائياً عند فتح الصفحة أو جمع الأدلة.'
              : 'QUOTA-SAFE MODE is enabled by default: zero automatic Gemini requests run on page load, navigation, or evidence collection.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono tabular-nums">
          <span
            className={
              guardState.quotaSafeMode && !explicitAuthorized
                ? 'font-semibold text-emerald-700 dark:text-emerald-400'
                : 'font-semibold text-amber-700 dark:text-amber-400'
            }
          >
            {guardState.quotaSafeMode && !explicitAuthorized
              ? 'QUOTA-SAFE MODE'
              : isAr
                ? 'مُصرّح لمرة واحدة'
                : 'SINGLE-RUN AUTHORIZED'}
          </span>
          <span className="text-slate-300 dark:text-slate-700">·</span>
          <span className="text-slate-600 dark:text-slate-300">
            {isAr ? 'طلبات الجلسة:' : 'Requests:'} {guardState.requestsSentSession}
          </span>
          <span className="text-slate-300 dark:text-slate-700">·</span>
          <span className="text-slate-600 dark:text-slate-300">
            {isAr ? 'إصابات الكاش:' : 'Cache hits:'} {guardState.cacheHitsSession}
          </span>
          <span className="text-slate-300 dark:text-slate-700">·</span>
          <span className="text-slate-700 dark:text-slate-200">{jobStatus}</span>
        </div>
      </div>

      {/* Step 1: Deterministic Local/GitHub Evidence Collection */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => onCollectEvidence(false)}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3.5 py-2 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            <span>
              {isCollecting
                ? isAr
                  ? 'جاري جمع الأدلة...'
                  : 'Collecting Evidence...'
                : hasBundle
                  ? isAr
                    ? 'إعادة جمع الأدلة (صفر Gemini)'
                    : 'Re-collect Evidence (0 Gemini)'
                  : isAr
                    ? 'جمع الأدلة التقنية (صفر Gemini)'
                    : 'Collect Project Evidence (0 Gemini)'}
            </span>
          </button>

          {canResumeCheckpoint && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onCollectEvidence(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-blue-600/40 px-3 py-2 text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-600/10 disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="font-mono tabular-nums">
                {isAr
                  ? `استئناف (${checkpoint!.completedBatches}/${checkpoint!.totalBatches})`
                  : `Resume Checkpoint (${checkpoint!.completedBatches}/${checkpoint!.totalBatches})`}
              </span>
            </button>
          )}

          {isBusy && (
            <button
              type="button"
              onClick={onCancelJob}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 px-3 py-2 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-500/10"
            >
              <Square className="h-3.5 w-3.5" />
              <span>{isAr ? 'إلغاء' : 'Cancel'}</span>
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          {batchProgress && batchProgress.total > 0 && (
            <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
              {isAr ? 'الدفعات:' : 'Batches:'} {batchProgress.completed}/{batchProgress.total}
            </span>
          )}
          {hasCacheHit && (
            <span className="inline-flex items-center gap-1 font-mono text-emerald-700 dark:text-emerald-400">
              <Database className="h-3.5 w-3.5" />
              <span>{isAr ? 'متوفر في الكاش (0 طلبات)' : 'Cached analysis available (0 calls)'}</span>
            </span>
          )}
          {hasCacheHit && (
            <button
              type="button"
              disabled={isBusy}
              onClick={onClearCache}
              className="inline-flex items-center gap-1 text-slate-500 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>{isAr ? 'مسح الكاش' : 'Clear Cache'}</span>
            </button>
          )}
          {checkpoint && (
            <button
              type="button"
              disabled={isBusy}
              onClick={onClearCheckpoint}
              className="text-slate-500 hover:text-slate-900 dark:hover:text-white disabled:opacity-50"
            >
              {isAr ? 'حذف نقطة الاستئناف' : 'Clear Checkpoint'}
            </button>
          )}
        </div>
      </div>

      {/* Step 2: Explicit Authorization Gate for Gemini 4 Hydrogen (Locked ONLY_IN_CLOUD) */}
      <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-4">
        <InferenceModeSelector
          mode={InferenceMode.ONLY_IN_CLOUD}
          onChange={onModeChange}
          cloudConsent={cloudConsent}
          onGrantConsent={onGrantCloudConsent}
          locked
          lockedNotice={
            isAr
              ? 'مقفل على ONLY_IN_CLOUD لطلب Gemini 4 Hydrogen'
              : 'Locked to ONLY_IN_CLOUD for Gemini 4 Hydrogen (no on-device or model fallback)'
          }
        />

        <div className="flex flex-wrap items-center justify-between gap-4">
          <label className="flex items-start gap-2.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer select-none max-w-2xl">
            <input
              type="checkbox"
              checked={explicitAuthorized}
              disabled={isBusy}
              onChange={(e) => onToggleAuthorizeGemini(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-500"
            />
            <span>
              {isAr
                ? 'أُصرّح صراحةً بإرسال طلب واحد فقط إلى Gemini 4 Hydrogen (ONLY_IN_CLOUD، دون بديل نموذج ودون إعادة تلقائية) لتحليل حزمة الأدلة المجمّعة أعلاه.'
                : 'Explicitly authorize a single Gemini 4 Hydrogen request (ONLY_IN_CLOUD, no model fallback, 0 auto-retries) using the collected evidence bundle (advisory only; auto-resets back to QUOTA-SAFE MODE).'}
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-2">
            {hasCacheHit && (
              <button
                type="button"
                disabled={isBusy || !hasBundle}
                onClick={onLoadCachedRecommendation}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-600/40 px-3 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-600/10 disabled:opacity-50"
              >
                <Database className="h-3.5 w-3.5" />
                <span>{isAr ? 'تحميل التوصية المخزنة (0 طلب)' : 'Load Cached Recommendation'}</span>
              </button>
            )}

            <button
              type="button"
              disabled={
                isBusy ||
                !hasBundle ||
                guardState.quotaStopped ||
                !explicitAuthorized ||
                !cloudConsent
              }
              onClick={onRunGeminiAnalysis}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 text-white px-3.5 py-2 text-xs font-semibold hover:bg-blue-700 disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>
                {isRunningGemini
                  ? isAr
                    ? 'جاري استشارة Gemini 4 Hydrogen...'
                    : 'Running Single Hydrogen Request...'
                  : isAr
                    ? 'تشغيل تحليل Gemini جديد'
                    : 'Run New Gemini Analysis'}
              </span>
            </button>
          </div>
        </div>

        {cacheKey && (
          <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
            Cache Key: {cacheKey}
          </p>
        )}

        {guardState.quotaStopped && (
          <div className="flex items-start gap-2 text-xs text-red-700 dark:text-red-300 pt-1">
            <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              {isAr
                ? `تم إيقاف Gemini لحماية الحصة: ${guardState.quotaStopReason || 'تم بلوغ الحد اليومي أو الصلاحية.'}`
                : `Gemini requests stopped cleanly: ${guardState.quotaStopReason || 'Daily quota or billing limit reached.'}`}
            </span>
          </div>
        )}

        {statusMessage && (
          <div className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 pt-1">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
            <span>{statusMessage}</span>
          </div>
        )}
      </div>
    </section>
  );
}
