import { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileCode2,
  FlaskConical,
  Globe,
  HelpCircle,
  Info,
  RefreshCw,
  Server,
  XCircle
} from 'lucide-react';
import { CRITERIA_VERSION, EVIDENCE_COLLECTOR_VERSION } from '../../services/judgingV2/criteria';
import { reconcileCoverageReport } from '../../services/judgingV2/cacheAndCheckpoints';
import type {
  EvidenceBundle,
  EvidenceStatus,
  ObservableWorkflowCheck,
  PersistedEvidenceRecord
} from '../../services/judgingV2/types';

interface Props {
  locale: 'en' | 'ar';
  bundle: EvidenceBundle | null;
  preservedVersions?: PersistedEvidenceRecord[];
  attachedTestLog: string;
  onTestLogChange: (val: string) => void;
  onRecomputeTestsFromLog: () => void;
  onInspectAdditional?: () => void;
  isCollecting?: boolean;
  workflowChecks: ObservableWorkflowCheck[];
  isApprovedLocked: boolean;
  onUpdateWorkflowCheck: (id: string, status: EvidenceStatus, notes: string) => void;
}

type StatusFilter = 'ALL' | EvidenceStatus;

function statusColorClass(status: EvidenceStatus): string {
  switch (status) {
    case 'VERIFIED':
      return 'text-emerald-700 dark:text-emerald-400';
    case 'PARTIALLY_VERIFIED':
      return 'text-blue-700 dark:text-blue-400';
    case 'FAILED':
      return 'text-red-700 dark:text-red-400';
    default:
      return 'text-amber-700 dark:text-amber-400';
  }
}

export function EvidenceCoveragePanel({
  locale,
  bundle,
  preservedVersions = [],
  attachedTestLog,
  onTestLogChange,
  onRecomputeTestsFromLog,
  onInspectAdditional,
  isCollecting = false,
  workflowChecks,
  isApprovedLocked,
  onUpdateWorkflowCheck
}: Props) {
  const isAr = locale === 'ar';
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [showSkippedDetails, setShowSkippedDetails] = useState(false);
  const [pathListTab, setPathListTab] = useState<'skipped' | 'excluded'>('skipped');

  if (!bundle) {
    return (
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 text-center space-y-2">
        <FileCode2 className="h-6 w-6 text-slate-400 mx-auto" />
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
          {isAr ? 'لم يتم جمع حزمة الأدلة بعد' : 'No Evidence Bundle Collected Yet'}
        </h3>
        <p className="text-xs text-slate-600 dark:text-slate-400 max-w-xl mx-auto">
          {isAr
            ? 'اضغط على "جمع الأدلة التقنية" لفحص المستودع المتاح، تغطية الملفات الحقيقية، الاعتماديات، نقاط النهاية، حالة التطبيق العام، والاختبارات المنفّذة دون أي استهلاك لحصة Gemini.'
            : 'Click "Collect Project Evidence (0 Gemini)" above to inspect the accessible GitHub repository, true file coverage, dependencies, API handlers, executed test status, and public URL probe cleanly with zero Gemini quota usage.'}
        </p>
      </section>
    );
  }

  const {
    findings,
    testVerification,
    publicAppProbe,
    epistemicNotices,
    apiEndpointsDetected,
    clientApiHelpersDetected = []
  } = bundle;
  const coverage = reconcileCoverageReport(bundle.coverage);
  const filteredFindings =
    statusFilter === 'ALL' ? findings : findings.filter((f) => f.status === statusFilter);

  const excludedBinaryCount =
    coverage.excludedBinaryAndLockCount ?? coverage.skippedBreakdown?.binaryOrAsset ?? 0;

  const coverageMetrics = [
    {
      label: isAr ? 'ملفات المصدر الفريدة' : 'Unique Source Files',
      value: coverage.uniqueSourceFiles
    },
    {
      label: isAr ? 'مفحوصة بالكامل' : 'Fully Inspected',
      value: coverage.inspectedFiles
    },
    {
      label: isAr ? 'مفحوصة جزئياً' : 'Partially Inspected',
      value: coverage.partiallyInspectedFiles
    },
    {
      label: isAr ? 'تم تخطيها' : 'Skipped',
      value: coverage.skippedFiles
    },
    {
      label: isAr ? 'تعذر الوصول' : 'Inaccessible',
      value: coverage.inaccessibleFiles
    },
    {
      label: isAr ? 'فشل القراءة' : 'Failed',
      value: coverage.failedFiles
    },
    {
      label: isAr ? 'وثائق/README مستبعدة' : 'README / Docs Excl.',
      value: coverage.readmeAndDocsCount
    },
    {
      label: isAr ? 'ثنائيات/أقفال مستبعدة' : 'Binary / Lock Excl.',
      value: excludedBinaryCount
    },
    {
      label: isAr ? 'الدفعات المكتملة' : 'Batches',
      value: `${coverage.completedBatches}/${coverage.totalBatches}`
    }
  ];

  const skippedBreakdown = coverage.skippedBreakdown;
  const skippedFilesList = coverage.skippedFilesList ?? [];
  const excludedDocsList = coverage.excludedDocsList ?? [];
  const excludedBinaryAndLockList = coverage.excludedBinaryAndLockList ?? [];
  const totalExcludedNonSourcePaths = excludedDocsList.length + excludedBinaryAndLockList.length;

  const activeCollectorVersion = bundle.evidenceCollectorVersion || 'v2.collector.1';
  const isStaleVersion = activeCollectorVersion !== EVIDENCE_COLLECTOR_VERSION;

  const hasAdditionalInspectable =
    coverage.accessible &&
    (isStaleVersion ||
      coverage.partiallyInspectedFiles > 0 ||
      (skippedBreakdown?.fileCountLimit ?? 0) > 0 ||
      (skippedBreakdown?.budgetLimit ?? 0) > 0 ||
      (skippedBreakdown?.batchInterrupted ?? 0) > 0);

  return (
    <div className="space-y-5">
      {/* Repository Coverage & Epistemic Rules */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
          <div className="space-y-0.5">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              {isAr ? 'تغطية المستودع والأدلة المستخلصة' : 'Repository Coverage & Verifiable Evidence'}
            </h2>
            <p className="text-xs font-mono text-slate-600 dark:text-slate-400">
              {coverage.repoFullName || (isAr ? 'مستودع غير متاح' : 'Repository unavailable')}
              {coverage.defaultBranch ? ` (${coverage.defaultBranch})` : ''}
              {coverage.commitSha ? ` @ ${coverage.commitSha.slice(0, 12)}` : ''}
              {coverage.primaryRootPath ? ` · root: ${coverage.primaryRootPath}` : ''}
            </p>
            <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
              {isAr ? 'النسخة النشطة:' : 'Active:'} {activeCollectorVersion} · {bundle.criteriaVersion || CRITERIA_VERSION}
              {bundle.evidenceKey ? ` · ${bundle.evidenceKey}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
              {isAr ? 'إجمالي شجرة الملفات:' : 'Tree entries:'} {coverage.totalTreeEntries}
              {coverage.redactedSecretsCount > 0
                ? ` · ${isAr ? 'أسرار محجوبة:' : 'Secrets redacted:'} ${coverage.redactedSecretsCount}`
                : ''}
            </span>
            {onInspectAdditional && hasAdditionalInspectable && (
              <button
                type="button"
                disabled={isCollecting}
                onClick={onInspectAdditional}
                className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 px-3 py-1.5 text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-500/10 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isCollecting ? 'animate-spin' : ''}`} />
                <span>
                  {isAr
                    ? 'فحص الملفات المتبقية وتوسيع المقتطعة (0 Gemini)'
                    : 'Inspect Remaining / Expand Truncated Files (0 Gemini)'}
                </span>
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-9 gap-3">
          {coverageMetrics.map((m) => (
            <div key={m.label} className="space-y-1">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">{m.label}</div>
              <div className="text-lg font-mono font-semibold tabular-nums text-slate-900 dark:text-white">
                {m.value}
              </div>
            </div>
          ))}
        </div>

        <p className="text-xs text-slate-600 dark:text-slate-300">{coverage.note}</p>

        {preservedVersions.length > 0 && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 px-3 py-2 text-[11px] font-mono text-slate-600 dark:text-slate-300">
            {isAr
              ? `تم حفظ ${preservedVersions.length} نسخة سابقة/متعارضة في السجل (النشطة حالياً: ${activeCollectorVersion}): `
              : `Preserved ${preservedVersions.length} superseded/legacy version(s) cleanly (Active: ${activeCollectorVersion}): `}
            {preservedVersions
              .slice(0, 3)
              .map(
                (v) =>
                  `${v.evidenceCollectorVersion} (${v.bundle.coverage.inspectedFiles}/${v.bundle.coverage.partiallyInspectedFiles}/${v.bundle.coverage.skippedFiles}, ${v.bundle.coverage.completedBatches}/${v.bundle.coverage.totalBatches})`
              )
              .join(' · ')}
          </div>
        )}

        {/* Server Endpoints vs Client-Side API Helpers */}
        {(apiEndpointsDetected.length > 0 || clientApiHelpersDetected.length > 0) && (
          <div className="border-t border-slate-200 dark:border-slate-800 pt-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="space-y-1.5">
              <div className="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                <Server className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                <span>
                  {isAr ? 'نقاط النهاية الخادمية / Edge Functions' : 'Server API Endpoints & Edge Functions'} (
                  <span className="font-mono tabular-nums">{apiEndpointsDetected.length}</span>)
                </span>
              </div>
              {apiEndpointsDetected.length === 0 ? (
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {isAr ? 'لم يتم اكتشاف مسارات خادم في الملفات المفحوصة.' : 'None detected in inspected source files.'}
                </p>
              ) : (
                <ul className="space-y-1 font-mono text-[11px] text-slate-700 dark:text-slate-300">
                  {apiEndpointsDetected.slice(0, 6).map((ep, idx) => (
                    <li key={`${ep.filePath}_${ep.lineRange}_${idx}`} className="truncate">
                      {ep.filePath}:{ep.lineRange} — {ep.signature}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                <span>
                  {isAr ? 'دوال اتصال عميل (ليست خادماً)' : 'Client-Side API Helpers (Browser Fetch — Not Server Routes)'} (
                  <span className="font-mono tabular-nums">{clientApiHelpersDetected.length}</span>)
                </span>
              </div>
              {clientApiHelpersDetected.length === 0 ? (
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {isAr ? 'لا توجد دوال عميل مرصودة.' : 'None detected in inspected source files.'}
                </p>
              ) : (
                <ul className="space-y-1 font-mono text-[11px] text-slate-700 dark:text-slate-300">
                  {clientApiHelpersDetected.slice(0, 6).map((ch, idx) => (
                    <li key={`${ch.filePath}_${ch.lineRange}_${idx}`} className="truncate">
                      {ch.filePath}:{ch.lineRange} — {ch.signature}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* Itemized Skipped Source Files vs Excluded Non-Source Files (Reconciled 1-to-1) */}
        {(skippedFilesList.length > 0 || totalExcludedNonSourcePaths > 0) && skippedBreakdown && (
          <div className="border-t border-slate-200 dark:border-slate-800 pt-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] font-mono tabular-nums text-slate-600 dark:text-slate-400 space-y-0.5">
                <div>
                  {isAr ? `تخطي المصدر (${coverage.skippedFiles}):` : `Skipped source (${coverage.skippedFiles}):`}{' '}
                  duplicate_mirror={skippedBreakdown.duplicateMirror} · unselected_mirror_config=
                  {skippedBreakdown.unselectedMirrorConfig ?? 0} · unselected_root_meta=
                  {skippedBreakdown.unselectedRootMetaOrConfig ?? skippedBreakdown.nonCodeOrUnselected}{' '}
                  · file_count_limit={skippedBreakdown.fileCountLimit} · oversized=
                  {skippedBreakdown.oversized} · sensitive={skippedBreakdown.sensitive}
                </div>
                <div>
                  {isAr
                    ? `استبعاد غير مصدري (${coverage.readmeAndDocsCount + excludedBinaryCount}):`
                    : `Excluded non-source (${coverage.readmeAndDocsCount + excludedBinaryCount}):`}{' '}
                  readme_docs={coverage.readmeAndDocsCount} · binary_or_asset={excludedBinaryCount}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSkippedDetails((v) => !v)}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
              >
                <span>
                  {showSkippedDetails
                    ? isAr
                      ? 'إخفاء القوائم التفصيلية'
                      : 'Hide Skipped & Excluded Paths'
                    : isAr
                      ? `عرض متخطى المصدر (${skippedFilesList.length}) والمستبعد (${totalExcludedNonSourcePaths})`
                      : `Inspect Skipped (${skippedFilesList.length}) & Excluded (${totalExcludedNonSourcePaths}) Paths`}
                </span>
                {showSkippedDetails ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
            </div>

            {showSkippedDetails && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
                  <button
                    type="button"
                    onClick={() => setPathListTab('skipped')}
                    className={`rounded-md px-2.5 py-1 transition-colors ${
                      pathListTab === 'skipped'
                        ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-semibold'
                        : 'border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {isAr
                      ? `ملفات المصدر المتخطاة (${skippedFilesList.length})`
                      : `Skipped Source Paths (${skippedFilesList.length})`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPathListTab('excluded')}
                    className={`rounded-md px-2.5 py-1 transition-colors ${
                      pathListTab === 'excluded'
                        ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-semibold'
                        : 'border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {isAr
                      ? `الملفات غير المصدرية المستبعدة (${totalExcludedNonSourcePaths})`
                      : `Excluded Docs & Binary/Locks (${totalExcludedNonSourcePaths})`}
                  </button>
                </div>

                <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-start text-[11px] font-mono">
                    <thead className="bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400">
                      <tr>
                        <th className="py-1.5 px-2.5 text-start">{isAr ? 'المسار' : 'Path'}</th>
                        <th className="py-1.5 px-2.5 text-start">{isAr ? 'التصنيف / السبب' : 'Reason'}</th>
                        <th className="py-1.5 px-2.5 text-end">{isAr ? 'الحجم' : 'Bytes'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {(pathListTab === 'skipped'
                        ? skippedFilesList
                        : [...excludedDocsList, ...excludedBinaryAndLockList]
                      ).map((sf) => (
                        <tr key={`${pathListTab}_${sf.path}_${sf.reason}`}>
                          <td className="py-1 px-2.5 text-slate-800 dark:text-slate-200">{sf.path}</td>
                          <td className="py-1 px-2.5 text-amber-700 dark:text-amber-400">{sf.reason}</td>
                          <td className="py-1 px-2.5 text-end tabular-nums text-slate-500">
                            {sf.sizeBytes ?? '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        <ul className="border-t border-slate-200 dark:border-slate-800 pt-3 space-y-1 text-[11px] text-slate-600 dark:text-slate-400">
          {epistemicNotices.map((notice) => (
            <li key={notice} className="flex items-start gap-1.5">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-slate-400" />
              <span>{notice}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Executed Tests & Public URL Probe (Strict Truthfulness) */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
              <FlaskConical className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              <span>{isAr ? 'التحقق من الاختبارات المنفّذة' : 'Executed Test Verification'}</span>
            </h3>
            <span className={`text-xs font-mono font-semibold ${statusColorClass(testVerification.status)}`}>
              {testVerification.status}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono tabular-nums text-slate-700 dark:text-slate-300">
            <span>{isAr ? 'ملفات اختبار مكتشفة:' : 'Test files found:'} {testVerification.discoveredTestFilesCount}</span>
            <span>{isAr ? 'ناجحة:' : 'Passed:'} {testVerification.passedCount}</span>
            <span>{isAr ? 'فاشلة:' : 'Failed:'} {testVerification.failedCount}</span>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">{testVerification.summary}</p>

          <div className="space-y-1.5 pt-1">
            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400">
              {isAr
                ? 'إرفاق مخرجات تنفيذ الاختبارات الفعلية (من Vitest / Jest / Pytest بواسطة المحكم)'
                : 'Attach Executed Test Log (optional judge-run Vitest / Jest / Pytest output)'}
            </label>
            <textarea
              rows={3}
              value={attachedTestLog}
              onChange={(e) => onTestLogChange(e.target.value)}
              placeholder={
                isAr
                  ? 'مثال: Tests  24 passed (24)'
                  : 'e.g., Test Files  4 passed (4) / Tests  24 passed (24)'
              }
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="button"
              onClick={onRecomputeTestsFromLog}
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {isAr ? 'تحديث دليل الاختبارات من السجل' : 'Apply & Recompute Test Evidence'}
            </button>
          </div>
        </div>

        <div className="space-y-3 border-t lg:border-t-0 lg:border-s border-slate-200 dark:border-slate-800 pt-4 lg:pt-0 lg:ps-6">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
              <Globe className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              <span>{isAr ? 'فحص التطبيق العام ومسارات المستخدم' : 'Public App Probe & Observable Workflows'}</span>
            </h3>
            <span className={`text-xs font-mono font-semibold ${statusColorClass(publicAppProbe.reachabilityStatus)}`}>
              {isAr ? 'الوصول:' : 'Reachability:'} {publicAppProbe.reachabilityStatus}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
            <span>HTTP: {publicAppProbe.httpStatus ?? 'N/A'}</span>
            <span>·</span>
            <span className={statusColorClass(publicAppProbe.functionalityStatus)}>
              {isAr ? 'عمل الوظائف:' : 'Workflow Status:'} {publicAppProbe.functionalityStatus}
            </span>
            {publicAppProbe.url && (
              <>
                <span>·</span>
                <a
                  href={publicAppProbe.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
                >
                  <span>{isAr ? 'فتح الرابط العام' : 'Open Public URL'}</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">{publicAppProbe.summary}</p>

          <div className="space-y-2 pt-1 divide-y divide-slate-200 dark:divide-slate-800">
            {workflowChecks.map((wf) => (
              <div key={wf.id} className="pt-2 first:pt-0 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-800 dark:text-slate-200">
                    {wf.label}
                  </span>
                  <div className="flex items-center gap-1 text-[11px] font-mono">
                    {(['VERIFIED', 'PARTIALLY_VERIFIED', 'UNVERIFIED', 'FAILED'] as EvidenceStatus[]).map(
                      (st) => (
                        <button
                          key={st}
                          type="button"
                          disabled={isApprovedLocked}
                          onClick={() => onUpdateWorkflowCheck(wf.id, st, wf.notes)}
                          className={`rounded px-2 py-0.5 transition-colors disabled:opacity-50 ${
                            wf.status === st
                              ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-semibold'
                              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          {st === 'PARTIALLY_VERIFIED' ? 'PARTIAL' : st}
                        </button>
                      )
                    )}
                  </div>
                </div>
                <input
                  type="text"
                  disabled={isApprovedLocked}
                  value={wf.notes}
                  onChange={(e) => onUpdateWorkflowCheck(wf.id, wf.status, e.target.value)}
                  placeholder={isAr ? 'ملاحظات المحكم على المسار الملاحظ...' : 'Judge observation notes...'}
                  className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2.5 py-1 text-xs text-slate-800 dark:text-slate-200 disabled:opacity-60"
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Filterable Evidence Findings Table */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
            {isAr ? 'سجل الأدلة والملفات المستشهد بها' : 'Evidence Ledger & Line-Cited Findings'}
          </h3>
          <div className="flex flex-wrap items-center gap-1">
            {(['ALL', 'VERIFIED', 'PARTIALLY_VERIFIED', 'UNVERIFIED', 'FAILED'] as StatusFilter[]).map(
              (f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setStatusFilter(f)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-mono font-medium transition-colors ${
                    statusFilter === f
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  {f}
                </button>
              )
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                <th className="py-2 pe-4 text-start font-medium">{isAr ? 'الحالة' : 'Status'}</th>
                <th className="py-2 pe-4 text-start font-medium">{isAr ? 'الدليل' : 'Finding'}</th>
                <th className="py-2 pe-4 text-start font-medium">{isAr ? 'المصدر والأسطر' : 'Source & Lines'}</th>
                <th className="py-2 text-start font-medium">{isAr ? 'التفاصيل' : 'Detail'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filteredFindings.map((finding) => (
                <tr key={finding.id} className="align-top">
                  <td className="py-2.5 pe-4 whitespace-nowrap font-mono font-semibold">
                    <span className={`inline-flex items-center gap-1 ${statusColorClass(finding.status)}`}>
                      {finding.status === 'VERIFIED' ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      ) : finding.status === 'FAILED' ? (
                        <XCircle className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <HelpCircle className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span>{finding.status}</span>
                    </span>
                  </td>
                  <td className="py-2.5 pe-4 font-medium text-slate-900 dark:text-slate-100">
                    <div>{finding.title}</div>
                    {finding.criterionId && (
                      <div className="text-[11px] font-mono text-slate-500">{finding.criterionId}</div>
                    )}
                  </td>
                  <td className="py-2.5 pe-4 font-mono text-slate-700 dark:text-slate-300">
                    <div>{finding.sourceLabel}</div>
                    {finding.lineRange && (
                      <div className="text-[11px] text-blue-600 dark:text-blue-400 tabular-nums">
                        {finding.lineRange}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 text-slate-600 dark:text-slate-300">
                    <div>{finding.detail}</div>
                    {finding.snippet && (
                      <pre className="mt-1 overflow-x-auto rounded bg-slate-100 dark:bg-slate-900 px-2 py-1 font-mono text-[11px] text-slate-800 dark:text-slate-200">
                        {finding.snippet}
                      </pre>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
