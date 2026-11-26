import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import {
  getAppCheckStatus,
  getCachedRemoteAIConfig,
  getFirebaseConfigStatus,
  verifyAppCheckToken,
  type AppCheckTokenVerificationResult
} from '../services/firebase/config';
import {
  runHackathonsDiagnostics,
  type HackathonsDiagnosticsReport
} from '../services/firebase/firestoreService';
import {
  detectDeviceCapability,
  triggerLocalModelRetry
} from '../services/hybridAI/deviceCapability';
import {
  clearLocalAILogs,
  getAIActivitySummary,
  subscribeAIActivity
} from '../services/hybridAI/inferenceLogger';
import type { AIActivitySummary, DeviceCapabilityReport } from '../services/hybridAI/types';
import { HybridAIStatusPanel } from '../components/common/HybridAIStatusPanel';
import { InferenceStatusBadge } from '../components/common/InferenceBadge';

export function DiagnosticsPage() {
  const { user, profile, privateInfo, isAdmin, emailVerified, updateCloudConsent } = useAuth();
  const { locale, t } = useLanguage();
  const [capability, setCapability] = useState<DeviceCapabilityReport | null>(null);
  const [summary, setSummary] = useState<AIActivitySummary>(() => getAIActivitySummary());
  const [checking, setChecking] = useState(false);
  const [firestoreDiag, setFirestoreDiag] = useState<HackathonsDiagnosticsReport | null>(null);
  const [diagLoading, setDiagLoading] = useState(true);
  const [appCheckProbe, setAppCheckProbe] = useState<AppCheckTokenVerificationResult | null>(null);
  const [appCheckProbing, setAppCheckProbing] = useState(false);

  const runLiveAppCheckProbe = async () => {
    setAppCheckProbing(true);
    try {
      const result = await verifyAppCheckToken({ forceRefresh: true, timeoutMs: 12_000 });
      setAppCheckProbe(result);
    } finally {
      setAppCheckProbing(false);
    }
  };

  const refreshCapability = async (retryModel = false) => {
    setChecking(true);
    try {
      const cap = retryModel
        ? await triggerLocalModelRetry(locale)
        : await detectDeviceCapability(locale);
      setCapability(cap);
    } finally {
      setChecking(false);
    }
  };

  const refreshFirestoreDiagnostics = useCallback(async () => {
    setDiagLoading(true);
    try {
      const report = await runHackathonsDiagnostics();
      setFirestoreDiag(report);
    } finally {
      setDiagLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCapability(false);
    void refreshFirestoreDiagnostics();
    const unsub = subscribeAIActivity(() => setSummary(getAIActivitySummary()));
    return () => unsub();
  }, [locale, refreshFirestoreDiagnostics]);

  const appCheck = getAppCheckStatus();
  const remoteCfg = getCachedRemoteAIConfig();
  const fbConfig = getFirebaseConfigStatus();
  const effectiveRole = isAdmin ? 'admin' : profile?.approvedRole || 'participant';
  const authProviderIds = user?.providerData?.map((p) => p.providerId).filter(Boolean) || [];
  const authStateLabel = !user
    ? locale === 'ar'
      ? 'غير مسجل الدخول'
      : 'Signed Out'
    : emailVerified
      ? locale === 'ar'
        ? 'مسجل الدخول (البريد موثق)'
        : 'Signed In (Email Verified)'
      : locale === 'ar'
        ? 'مسجل الدخول (البريد غير موثق)'
        : 'Signed In (Email Unverified)';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            {t.ai.diagnosticsTitle}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">{t.ai.desktopNote}</p>
        </div>

        <button
          type="button"
          disabled={checking}
          onClick={() => void refreshCapability(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
          <span>{t.ai.retryLocalCheck}</span>
        </button>
      </div>

      {/* Unified Hybrid AI Status Panel & Manual Single-Request Test */}
      <HybridAIStatusPanel
        capability={capability}
        summary={summary}
        appCheck={appCheck}
        fbConfig={fbConfig}
        cloudConsent={Boolean(privateInfo?.aiCloudConsent)}
        canUpdateConsent={Boolean(user && emailVerified)}
        onUpdateConsent={updateCloudConsent}
        onRecheckCapability={() => refreshCapability(true)}
        checkingCapability={checking}
        userId={user?.uid}
        emailVerified={emailVerified}
      />

      {/* Firebase Migration & Environment Readiness */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="space-y-1">
          <div className="text-slate-500">
            {locale === 'ar' ? 'هدف مشروع Firebase وقاعدة البيانات' : 'Firebase Target Project & Firestore'}
          </div>
          <div className="font-mono font-semibold text-slate-900 dark:text-white">
            projectId={fbConfig.projectId} · database={fbConfig.firestoreDatabaseId}
          </div>
          {!fbConfig.configured && (
            <p className="text-amber-600 dark:text-amber-300">
              {locale === 'ar'
                ? `متغيرات البيئة المطلوبة في .env.local غير مضبوطة: ${fbConfig.missingKeys.join(', ')}`
                : `Missing env vars in .env.local: ${fbConfig.missingKeys.join(', ')}`}
            </p>
          )}
        </div>
        <span
          className={`font-mono font-semibold px-2.5 py-1 rounded ${
            fbConfig.configured
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'bg-amber-500/10 text-amber-600 dark:text-amber-300'
          }`}
        >
          {fbConfig.configured
            ? locale === 'ar'
              ? 'بيئة Firebase مكتملة'
              : 'FIREBASE ENV READY'
            : locale === 'ar'
              ? 'بانتظار مفاتيح Console'
              : 'PENDING CONSOLE ENV'}
        </span>
      </div>

      {/* Firestore Discovery & Auth Diagnostics (Non-sensitive) */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">
              {locale === 'ar'
                ? 'تشخيصات Firestore والمصادقة (بيانات عامة آمنة)'
                : 'Firestore Discovery & Auth Diagnostics'}
            </h2>
            <p className="text-xs text-slate-500">
              {locale === 'ar'
                ? 'يعرض حالة الاستعلام الفعلية والأدوار دون كشف أي رموز سرية أو بيانات شخصية.'
                : 'Live non-sensitive runtime diagnostics for hackathon queries and role state.'}
            </p>
          </div>
          <button
            type="button"
            disabled={diagLoading}
            onClick={() => void refreshFirestoreDiagnostics()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${diagLoading ? 'animate-spin' : ''}`} />
            <span>{locale === 'ar' ? 'تحديث الفحص' : 'Run Live Probe'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-1">
            <div className="text-slate-500">
              {locale === 'ar' ? 'المشروع والمسار' : 'Project & Collection Path'}
            </div>
            <div className="font-mono font-semibold text-slate-900 dark:text-white">
              {fbConfig.projectId} ({fbConfig.firestoreDatabaseId}) /{' '}
              {firestoreDiag?.collectionPath || 'hackathons'}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-1">
            <div className="text-slate-500">
              {locale === 'ar' ? 'عدد المستندات وتوزيع الحالات' : 'Retrieved Docs & Status Distribution'}
            </div>
            <div className="font-mono font-semibold text-slate-900 dark:text-white tabular-nums">
              {diagLoading
                ? '...'
                : `total=${firestoreDiag?.retrievedCount ?? 0} (published=${firestoreDiag?.statusDistribution.published ?? 0}, judging=${firestoreDiag?.statusDistribution.judging ?? 0}, completed=${firestoreDiag?.statusDistribution.completed ?? 0})`}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-1">
            <div className="text-slate-500">
              {locale === 'ar' ? 'المصادقة والدور الحالي' : 'Authentication State & User Role'}
            </div>
            <div className="font-mono font-semibold text-slate-900 dark:text-white">
              {authStateLabel} · role={effectiveRole}
            </div>
            <div className="font-mono text-[11px] text-slate-500">
              approved={profile?.approvedRole || 'participant'} · requested={profile?.requestedRole || 'participant'}
              {authProviderIds.length > 0 ? ` · provider=${authProviderIds.join(',')}` : ''}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-xs space-y-1">
          <div className="text-slate-500 font-semibold">
            {locale === 'ar' ? 'أخطاء تنفيذ الاستعلامات' : 'Query Execution Errors'}
          </div>
          {diagLoading ? (
            <span className="font-mono text-slate-500">{locale === 'ar' ? 'جارٍ الفحص...' : 'Probing...'}</span>
          ) : !firestoreDiag || firestoreDiag.queryErrors.length === 0 ? (
            <span className="font-mono text-emerald-600 dark:text-emerald-400">
              {locale === 'ar' ? 'لا توجد أخطاء (نجح الاستعلام)' : 'None (all status queries succeeded)'}
            </span>
          ) : (
            <ul className="list-disc ps-5 font-mono text-[11px] text-red-600 dark:text-red-400 space-y-0.5">
              {firestoreDiag.queryErrors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Capability Status Grid */}
      {capability && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4 space-y-1">
            <div className="text-xs text-slate-500">{t.ai.localAvailability}</div>
            <div className="font-mono text-sm font-bold text-slate-900 dark:text-white">
              {capability.localAvailability}
            </div>
            <p className="text-[11px] text-slate-500">{capability.localModelIdentityLabel}</p>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4 space-y-1">
            <div className="text-xs text-slate-500">{t.ai.browserCompat}</div>
            <div className="font-mono text-sm font-bold text-slate-900 dark:text-white">
              {capability.isDesktopEnvironment ? 'Desktop' : 'Mobile'} ·{' '}
              {capability.isChromePromptApiSupported ? 'Prompt API Present' : 'Prompt API Absent'}
            </div>
            <p className="text-[11px] text-slate-500">{capability.details}</p>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4 space-y-1">
            <div className="text-xs text-slate-500">{t.ai.cloudConnectivity}</div>
            <div className="font-mono text-sm font-bold text-slate-900 dark:text-white">
              {capability.cloudOnline
                ? locale === 'ar'
                  ? 'متصل'
                  : 'Online'
                : locale === 'ar'
                  ? 'غير متصل'
                  : 'Offline'}
            </div>
            <p className="text-[11px] text-slate-500">
              Models: {remoteCfg.cloudModelName} / {remoteCfg.heavyCloudModelName}
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-slate-500">Firebase App Check</div>
              <button
                type="button"
                disabled={appCheckProbing}
                onClick={() => void runLiveAppCheckProbe()}
                className="rounded border border-slate-300 dark:border-slate-700 px-2 py-0.5 text-[10px] font-semibold hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
              >
                {appCheckProbing
                  ? locale === 'ar'
                    ? 'جارٍ التحقق...'
                    : 'Verifying...'
                  : locale === 'ar'
                    ? 'فحص التوكن'
                    : 'Verify Token'}
              </button>
            </div>
            <div className="font-mono text-sm font-bold text-slate-900 dark:text-white">
              {appCheck.provider}
            </div>
            <p className="text-[11px] text-slate-500">{appCheck.reason}</p>
            <p className="font-mono text-[10px] text-slate-400 break-all">
              Source: {appCheck.siteKeySource} · Host: {appCheck.hostname || 'unknown'} · AppId:{' '}
              {fbConfig.appId || 'unset'}
            </p>
            {fbConfig.appIdMismatch && (
              <p className="text-[10px] text-amber-600 dark:text-amber-300">
                {locale === 'ar'
                  ? `تنبيه: App ID الفعلي (${fbConfig.appId}) يختلف عن appletConfig (${fbConfig.appletConfigAppId}).`
                  : `Note: Active VITE_FIREBASE_APP_ID (${fbConfig.appId}) differs from appletConfig (${fbConfig.appletConfigAppId}).`}
              </p>
            )}
            {appCheckProbe && (
              <p
                className={`text-[10px] font-mono ${
                  appCheckProbe.ok
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-red-600 dark:text-red-400'
                }`}
              >
                {appCheckProbe.ok
                  ? locale === 'ar'
                    ? 'توكن App Check صالح'
                    : 'Valid App Check token verified'
                  : `${appCheckProbe.errorCode}: ${appCheckProbe.message}`}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Telemetry Counters */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4">
          <div className="text-xs text-slate-500">{t.ai.localCount}</div>
          <div className="mt-1 font-mono text-2xl font-bold tabular-nums">
            {summary.totalLocalExecutions}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4">
          <div className="text-xs text-slate-500">{t.ai.cloudCount}</div>
          <div className="mt-1 font-mono text-2xl font-bold tabular-nums">
            {summary.totalCloudExecutions}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4">
          <div className="text-xs text-slate-500">{t.ai.failedCount}</div>
          <div className="mt-1 font-mono text-2xl font-bold tabular-nums">
            {summary.failedRequests}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4">
          <div className="text-xs text-slate-500">{t.ai.avgLatency}</div>
          <div className="mt-1 font-mono text-2xl font-bold tabular-nums">
            {summary.averageResponseMs} ms
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4">
          <div className="text-xs text-slate-500">{t.ai.lastSource}</div>
          <div className="mt-2 font-mono text-xs font-semibold truncate">
            {summary.lastInferenceStatus}
          </div>
        </div>
      </div>

      {/* Execution Audit Log */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base font-semibold">
            {locale === 'ar'
              ? `سجل تنفيذ الاستدلال الموثق (${summary.recentLogs.length})`
              : `Verified Inference Execution Log (${summary.recentLogs.length})`}
          </h2>
          {summary.recentLogs.length > 0 && (
            <button
              type="button"
              onClick={clearLocalAILogs}
              className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-red-500"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>{locale === 'ar' ? 'مسح السجل المحلي' : 'Clear Local History'}</span>
            </button>
          )}
        </div>

        {summary.recentLogs.length === 0 ? (
          <p className="text-xs text-slate-500">
            {locale === 'ar'
              ? 'لم يتم تنفيذ عمليات ذكاء اصطناعي في هذا المتصفح بعد.'
              : 'No AI operations executed yet in this browser. Run AI Mentor, AI Hackathon Builder, or AI Judge Assistant to observe verified inference source logs.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="py-2 text-start">{locale === 'ar' ? 'الوقت' : 'Time'}</th>
                  <th className="py-2 text-start">{locale === 'ar' ? 'المهمة' : 'Task'}</th>
                  <th className="py-2 text-start">{locale === 'ar' ? 'الوضع المطلوب' : 'Requested Mode'}</th>
                  <th className="py-2 text-start">{locale === 'ar' ? 'الحالة الموثقة' : 'Verified Status'}</th>
                  <th className="py-2 text-start">{locale === 'ar' ? 'النموذج' : 'Model'}</th>
                  <th className="py-2 text-end">{locale === 'ar' ? 'المدة' : 'Duration'}</th>
                </tr>
              </thead>
              <tbody>
                {summary.recentLogs.map((log) => (
                  <tr key={log.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-2 font-mono tabular-nums text-slate-500">
                      {new Date(log.executedAt).toLocaleTimeString()}
                    </td>
                    <td className="py-2 font-medium">{log.taskKey}</td>
                    <td className="py-2 font-mono">{log.requestedMode}</td>
                    <td className="py-2">
                      <InferenceStatusBadge status={log.statusIndicator} compact />
                      {(log.failurePhase || log.failureCategory) && (
                        <div className="mt-0.5 font-mono text-[10px] text-slate-500">
                          {[
                            log.failurePhase ? `phase=${log.failurePhase}` : null,
                            log.failureCategory ? `category=${log.failureCategory}` : null
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="py-2 font-mono text-slate-500 max-w-[200px] truncate">
                      {log.modelIdentifier}
                    </td>
                    <td className="py-2 text-end font-mono tabular-nums">{log.durationMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
