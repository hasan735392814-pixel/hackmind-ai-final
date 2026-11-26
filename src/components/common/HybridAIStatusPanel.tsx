import { useState } from 'react';
import { InferenceMode } from 'firebase/ai';
import { Play, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useLanguage } from '../../contexts/LanguageContext';
import type { AppCheckStatus, FirebaseConfigStatus } from '../../services/firebase/config';
import { getConfiguredCloudModels } from '../../services/hybridAI/firebaseAI';
import { executeHybridInference } from '../../services/hybridAI/inferenceManager';
import { buildTaskPrompt } from '../../services/hybridAI/promptRegistry';
import type {
  AIActivitySummary,
  AITaskKey,
  DeviceCapabilityReport,
  HybridExecutionResult
} from '../../services/hybridAI/types';
import { InferenceResultBanner, InferenceStatusBadge } from './InferenceBadge';
import { InferenceModeSelector } from './InferenceModeSelector';

interface Props {
  capability: DeviceCapabilityReport | null;
  summary: AIActivitySummary;
  appCheck: AppCheckStatus;
  fbConfig: FirebaseConfigStatus;
  cloudConsent: boolean;
  canUpdateConsent: boolean;
  onUpdateConsent: (consent: boolean) => Promise<void>;
  onRecheckCapability?: () => Promise<void>;
  checkingCapability?: boolean;
  userId?: string;
  emailVerified?: boolean;
}

type HybridTestTaskKey =
  | 'preliminary_summary'
  | 'evidence_excerpt_summary'
  | 'evidence_criteria_classify'
  | 'user_text_fact_extract';

const DEFAULT_TEST_EXCERPT =
  'HackMind AI routes lightweight evidence summarization through Firebase AI Logic with InferenceMode.PREFER_ON_DEVICE and reads result.response.inferenceSource to report ON-DEVICE or IN_CLOUD execution honestly.';

export function HybridAIStatusPanel({
  capability,
  summary,
  appCheck,
  fbConfig,
  cloudConsent,
  canUpdateConsent,
  onUpdateConsent,
  onRecheckCapability,
  checkingCapability = false,
  userId,
  emailVerified
}: Props) {
  const { locale, t } = useLanguage();
  const isAr = locale === 'ar';

  const [mode, setMode] = useState<InferenceMode>(InferenceMode.PREFER_ON_DEVICE);
  const [modelTier, setModelTier] = useState<'standard' | 'heavy'>('standard');
  const [selectedTask, setSelectedTask] = useState<HybridTestTaskKey>('preliminary_summary');
  const [testInput, setTestInput] = useState<string>(DEFAULT_TEST_EXCERPT);
  const [runningTest, setRunningTest] = useState(false);
  const [testResult, setTestResult] = useState<HybridExecutionResult<Record<string, unknown>> | null>(
    null
  );
  const [consentBusy, setConsentBusy] = useState(false);

  const configuredModels = getConfiguredCloudModels();
  const isHeavySelected = modelTier === 'heavy';
  const effectivePreferredMode = isHeavySelected ? InferenceMode.ONLY_IN_CLOUD : mode;
  const selectedModelIdentifier = isHeavySelected
    ? configuredModels.heavy
    : configuredModels.standard;

  const latestLog = summary.recentLogs[0] ?? null;

  const cloudFallbackLabel = !capability?.cloudOnline
    ? t.ai.fallbackOffline
    : !cloudConsent
      ? t.ai.fallbackBlockedConsent
      : t.ai.fallbackReady;

  const handleToggleConsent = async (next: boolean) => {
    if (!canUpdateConsent || consentBusy) return;
    setConsentBusy(true);
    try {
      await onUpdateConsent(next);
    } finally {
      setConsentBusy(false);
    }
  };

  const handleModelTierChange = (nextTier: 'standard' | 'heavy') => {
    setModelTier(nextTier);
    if (nextTier === 'heavy') {
      setMode(InferenceMode.ONLY_IN_CLOUD);
    }
  };

  const handleRunTest = async () => {
    if (runningTest || !testInput.trim()) return;
    setRunningTest(true);
    try {
      const prompt = buildTaskPrompt(
        selectedTask as AITaskKey,
        {
          excerpt: testInput.trim(),
          note: 'Manual Hybrid AI diagnostic verification run (single request).'
        },
        locale,
        { compact: true }
      );
      const res = await executeHybridInference<Record<string, unknown>>({
        taskKey: selectedTask,
        prompt,
        preferredMode: effectivePreferredMode,
        locale,
        ...(isHeavySelected
          ? {
              useHeavyCloudModel: true,
              maxTransientRetries: 0,
              disableModelFallback: true
            }
          : {
              useHeavyCloudModel: false
            }),
        cloudConsentGranted: cloudConsent,
        userId,
        emailVerified
      });
      setTestResult(res);
    } finally {
      setRunningTest(false);
    }
  };

  const taskOptions: Array<{ key: HybridTestTaskKey; label: string }> = [
    { key: 'preliminary_summary', label: t.ai.helperPreliminarySummary },
    { key: 'evidence_excerpt_summary', label: t.ai.helperSummarizeExcerpt },
    { key: 'evidence_criteria_classify', label: t.ai.helperClassifyCriteria },
    { key: 'user_text_fact_extract', label: t.ai.helperExtractFacts }
  ];

  const displayedLastError =
    testResult?.errorMessage ||
    testResult?.fallbackReason ||
    latestLog?.errorMessage ||
    latestLog?.fallbackReason ||
    null;

  const displayedFailurePhase = testResult?.failurePhase || latestLog?.failurePhase || null;
  const displayedFailureCategory =
    testResult?.failureCategory || latestLog?.failureCategory || null;
  const displayedSdkSource = testResult
    ? testResult.sdkInferenceSource
    : (latestLog?.sdkInferenceSource ?? null);

  const displayedLastOutput =
    testResult?.data
      ? JSON.stringify(testResult.data, null, 2)
      : testResult?.rawText || latestLog?.resultPreview || null;

  return (
    <section
      aria-label={t.ai.statusPanelTitle}
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-5"
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">
              {t.ai.statusPanelTitle}
            </h2>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">{t.ai.statusPanelSubtitle}</p>
        </div>

        {onRecheckCapability && (
          <button
            type="button"
            disabled={checkingCapability}
            onClick={() => void onRecheckCapability()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${checkingCapability ? 'animate-spin' : ''}`} />
            <span>{t.ai.retryLocalCheck}</span>
          </button>
        )}
      </div>

      {/* 8-Signal Operational Status Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-4 text-xs">
        <div className="space-y-1">
          <div className="text-slate-500 dark:text-slate-400">{t.ai.hybridEngineState}</div>
          <div className="font-mono font-semibold text-slate-900 dark:text-white">
            {fbConfig.configured ? t.ai.engineEnabled : t.ai.engineLimited}
          </div>
          <div className="text-[11px] text-slate-500">
            {isAr ? 'SDK: firebase/ai (GoogleAIBackend)' : 'SDK: firebase/ai (GoogleAIBackend)'}
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-slate-500 dark:text-slate-400">{t.ai.localAvailability}</div>
          <div className="font-mono font-semibold text-slate-900 dark:text-white">
            {capability?.localAvailability ?? 'checking...'}
            {capability?.localReasonCode && capability.localReasonCode !== capability.localAvailability
              ? ` (${capability.localReasonCode})`
              : ''}
          </div>
          <div className="text-[11px] text-slate-500">
            {capability?.localModelIdentityLabel || t.ai.desktopNote}
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-slate-500 dark:text-slate-400">{t.ai.lastSource}</div>
          <div className="flex flex-wrap items-center gap-2">
            {latestLog ? (
              <InferenceStatusBadge status={latestLog.statusIndicator} compact durationMs={latestLog.durationMs} />
            ) : (
              <span className="font-mono font-semibold text-slate-500">NONE</span>
            )}
          </div>
          <div className="text-[11px] font-mono text-slate-500 truncate">
            {latestLog
              ? `sdk=${latestLog.sdkInferenceSource ?? 'unset'} · model=${latestLog.modelIdentifier}`
              : t.ai.noResultYet}
          </div>
          {latestLog && (latestLog.failurePhase || latestLog.failureCategory) && (
            <div className="text-[10px] font-mono text-red-600 dark:text-red-400 truncate">
              {[
                latestLog.failurePhase ? `phase=${latestLog.failurePhase}` : null,
                latestLog.failureCategory ? `category=${latestLog.failureCategory}` : null
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <div className="text-slate-500 dark:text-slate-400">{t.ai.cloudFallbackStatus}</div>
          <div className="font-mono font-semibold text-slate-900 dark:text-white">
            {cloudFallbackLabel}
          </div>
          <div className="text-[11px] text-slate-500">
            {isAr
              ? 'يتطلب اتصالاً نشطاً وموافقة سحابية صريحة.'
              : 'Requires online connectivity and explicit cloud consent.'}
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-slate-500 dark:text-slate-400">{t.ai.appCheckStatusLabel}</div>
          <div className="font-mono font-semibold text-slate-900 dark:text-white">
            {appCheck.initialized
              ? `${appCheck.provider} (autoRefresh=${String(appCheck.autoRefreshEnabled)})`
              : 'unconfigured'}
          </div>
          <div className="text-[11px] text-slate-500 truncate">{appCheck.reason}</div>
        </div>

        <div className="space-y-1">
          <div className="text-slate-500 dark:text-slate-400">{t.ai.consentStateLabel}</div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`font-mono font-semibold ${
                cloudConsent
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-amber-700 dark:text-amber-300'
              }`}
            >
              {cloudConsent ? t.ai.consentGranted : t.ai.consentNotGranted}
            </span>
            {canUpdateConsent && (
              <button
                type="button"
                disabled={consentBusy}
                onClick={() => void handleToggleConsent(!cloudConsent)}
                className="rounded border border-slate-300 dark:border-slate-700 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {cloudConsent ? t.ai.revokeConsentBtn : t.ai.consentGrantBtn}
              </button>
            )}
          </div>
          <div className="text-[11px] text-slate-500">
            {!canUpdateConsent
              ? isAr
                ? 'سجّل الدخول ببريد موثق لتعديل تفضيل الموافقة المحفوظ.'
                : 'Sign in with a verified account to persist cloud consent preferences.'
              : isAr
                ? 'بدون موافقة، يُمنع التحويل السحابي الصامت.'
                : 'Without consent, silent cloud fallback is strictly blocked.'}
          </div>
        </div>
      </div>

      {/* Mode Selector */}
      <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-2">
        <InferenceModeSelector
          mode={effectivePreferredMode}
          onChange={(nextMode) => {
            if (!isHeavySelected) {
              setMode(nextMode);
            }
          }}
          cloudConsent={cloudConsent}
          onGrantConsent={canUpdateConsent ? () => handleToggleConsent(true) : undefined}
        />
        {isHeavySelected && (
          <p className="text-[11px] font-mono text-amber-700 dark:text-amber-300">
            {isAr
              ? `تم قفل الوضع على ONLY_IN_CLOUD لأن النموذج الثقيل (${selectedModelIdentifier}) ينفذ طلباً سحابياً واحداً فقط بدون إعادة محاولة أو تحويل.`
              : `Mode locked to ONLY_IN_CLOUD while Heavy (${selectedModelIdentifier}) is selected (0 retries, model fallback disabled).`}
          </p>
        )}
      </div>

      {/* Explicit Single-Request Interactive Test */}
      <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-0.5">
            <h3 className="text-xs font-semibold text-slate-900 dark:text-white">
              {t.ai.testActionTitle}
            </h3>
            <p className="text-[11px] text-slate-600 dark:text-slate-400">{t.ai.testActionDesc}</p>
          </div>
          <button
            type="button"
            disabled={runningTest || !testInput.trim()}
            onClick={() => void handleRunTest()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Play className="h-3.5 w-3.5" />
            <span>{runningTest ? t.ai.runningTestBtn : t.ai.runTestBtn}</span>
          </button>
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 px-3 py-2 text-[11px] font-mono text-slate-700 dark:text-slate-300 flex flex-wrap items-center justify-between gap-2">
          <span>
            {isAr ? 'النموذج المحدد:' : 'Selected model:'}{' '}
            <strong className="text-slate-900 dark:text-white">{selectedModelIdentifier}</strong>
          </span>
          <span className="text-slate-500">
            mode={effectivePreferredMode}
            {isHeavySelected ? ' · retries=0 · fallback=disabled' : ''}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          <div className="space-y-1">
            <label
              htmlFor="hybrid-test-model-select"
              className="block text-[11px] font-medium text-slate-600 dark:text-slate-400"
            >
              {isAr ? 'نموذج الاختبار' : 'Test Model'}
            </label>
            <select
              id="hybrid-test-model-select"
              value={modelTier}
              onChange={(e) => handleModelTierChange(e.target.value as 'standard' | 'heavy')}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-white font-mono"
            >
              <option value="standard">Standard: {configuredModels.standard}</option>
              <option value="heavy">Heavy: {configuredModels.heavy}</option>
            </select>
          </div>

          <div className="space-y-1">
            <label
              htmlFor="hybrid-test-task-select"
              className="block text-[11px] font-medium text-slate-600 dark:text-slate-400"
            >
              {t.ai.testTaskLabel}
            </label>
            <select
              id="hybrid-test-task-select"
              value={selectedTask}
              onChange={(e) => setSelectedTask(e.target.value as HybridTestTaskKey)}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-white"
            >
              {taskOptions.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2 space-y-1">
            <label
              htmlFor="hybrid-test-input"
              className="block text-[11px] font-medium text-slate-600 dark:text-slate-400"
            >
              {t.ai.testInputLabel}
            </label>
            <textarea
              id="hybrid-test-input"
              rows={2}
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-white font-mono"
            />
          </div>
        </div>

        {testResult && <InferenceResultBanner result={testResult} />}
      </div>

      {/* Last Output & Error Summary */}
      {(displayedLastOutput || displayedLastError) && (
        <div className="border-t border-slate-200 dark:border-slate-800 pt-4 grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
          <div className="space-y-1">
            <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
              {t.ai.lastResultLabel}
            </div>
            <pre className="max-h-40 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3 font-mono text-[11px] text-slate-800 dark:text-slate-200 whitespace-pre-wrap">
              {displayedLastOutput || t.ai.noResultYet}
            </pre>
          </div>

          <div className="space-y-1">
            <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
              {t.ai.lastErrorLabel}
            </div>
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3 text-[11px] text-slate-700 dark:text-slate-300 space-y-1.5">
              {displayedLastError ? (
                <>
                  <div className="flex items-start gap-2">
                    <ShieldAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <span>{displayedLastError}</span>
                  </div>
                  {(displayedFailurePhase || displayedFailureCategory) && (
                    <div className="font-mono text-[10px] text-slate-500 ps-5">
                      {[
                        displayedFailurePhase ? `phase=${displayedFailurePhase}` : null,
                        displayedFailureCategory ? `category=${displayedFailureCategory}` : null,
                        `sdk=${displayedSdkSource ?? 'unset'}`
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  )}
                </>
              ) : (
                <span className="font-mono text-emerald-700 dark:text-emerald-400">
                  {isAr ? 'لا توجد أخطاء أو تحويلات مسجلة.' : 'None'}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
