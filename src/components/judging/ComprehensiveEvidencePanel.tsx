import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileCode2,
  FolderTree,
  Globe,
  HelpCircle,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Terminal
} from 'lucide-react';
import type {
  AuditExecutionStatus,
  ComprehensiveJudgingReport,
  VerificationStatus
} from '../../services/judging/evidenceTypes';

export type ReportTab = 'matrix' | 'coverage' | 'security' | 'tests_demo' | 'claims' | 'rubric';

interface ComprehensiveEvidencePanelProps {
  report: ComprehensiveJudgingReport;
  locale: 'en' | 'ar';
  initialTab?: ReportTab;
}

const STATUS_BADGE_MAP: Record<
  VerificationStatus,
  { en: string; ar: string; className: string }
> = {
  CODE_CONFIRMED: {
    en: 'CODE_CONFIRMED',
    ar: 'CODE_CONFIRMED · مؤكد بالكود',
    className: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
  },
  TEST_CONFIRMED: {
    en: 'TEST_CONFIRMED',
    ar: 'TEST_CONFIRMED · مؤكد بالاختبار',
    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  },
  RUNTIME_CONFIRMED: {
    en: 'RUNTIME_CONFIRMED',
    ar: 'RUNTIME_CONFIRMED · مؤكد تشغيلياً',
    className: 'border-teal-500/40 bg-teal-500/10 text-teal-700 dark:text-teal-300'
  },
  PRODUCTION_CONFIRMED: {
    en: 'PRODUCTION_CONFIRMED',
    ar: 'PRODUCTION_CONFIRMED · مؤكد بالإنتاج',
    className: 'border-green-600/40 bg-green-600/10 text-green-700 dark:text-green-300'
  },
  UNVERIFIED: {
    en: 'UNVERIFIED',
    ar: 'UNVERIFIED · غير متحقق',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
  },
  CONTRADICTED: {
    en: 'CONTRADICTED',
    ar: 'CONTRADICTED · متعارض',
    className: 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300'
  },
  BLOCKED: {
    en: 'BLOCKED',
    ar: 'BLOCKED · محجوب',
    className: 'border-slate-500/40 bg-slate-500/10 text-slate-700 dark:text-slate-300'
  },
  NOT_APPLICABLE: {
    en: 'NOT_APPLICABLE',
    ar: 'NOT_APPLICABLE · غير منطبق',
    className: 'border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/50 text-slate-600 dark:text-slate-400'
  }
};

function StatusBadge({ status, locale }: { status: VerificationStatus; locale: 'en' | 'ar' }) {
  const cfg = STATUS_BADGE_MAP[status] || STATUS_BADGE_MAP.UNVERIFIED;
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${cfg.className}`}
    >
      {locale === 'ar' ? cfg.ar : cfg.en}
    </span>
  );
}

export function ComprehensiveEvidencePanel({
  report,
  locale,
  initialTab = 'matrix'
}: ComprehensiveEvidencePanelProps) {
  const [activeTab, setActiveTab] = useState<ReportTab>(initialTab);
  const [showAllInventory, setShowAllInventory] = useState(false);

  const handleDownloadJson = () => {
    const json = JSON.stringify(report, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = (report.submissionTitle || 'submission').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
    a.download = `hackmind-evidence-audit-${safeName}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const tabs: Array<{ id: ReportTab; labelEn: string; labelAr: string }> = [
    { id: 'matrix', labelEn: 'A & C · Matrix & Eligibility', labelAr: 'أ و ج · المصفوفة والأهلية' },
    { id: 'coverage', labelEn: 'B · Coverage & Repo', labelAr: 'ب · التغطية والمستودع' },
    { id: 'security', labelEn: 'D & G · Architecture & Security', labelAr: 'د و ز · المعمارية والأمان' },
    { id: 'tests_demo', labelEn: 'E & F · Tests & Live Demo', labelAr: 'هـ و و · الاختبارات والعرض الحي' },
    { id: 'claims', labelEn: 'H & I · Claims & Gaps', labelAr: 'ح و ط · الادعاءات والفجوات' },
    { id: 'rubric', labelEn: 'J · Rubric Evidence', labelAr: 'ي · أدلة معايير التحكيم' }
  ];

  const { sectionB_coverage: cov, sectionK_confidence: conf } = report;
  const effectiveAuditStatus: AuditExecutionStatus =
    report.auditStatus ||
    (!cov.accessible
      ? 'FAILED'
      : cov.interrupted && (cov.batchesCompleted ?? 0) > 0
        ? 'PARTIAL'
        : cov.interrupted
          ? 'INTERRUPTED'
          : 'COMPLETED');

  const auditStatusBadgeClass =
    effectiveAuditStatus === 'COMPLETED'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : effectiveAuditStatus === 'PARTIAL'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : effectiveAuditStatus === 'INTERRUPTED'
          ? 'border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300'
          : 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300';

  const batchStateSuffixEn =
    effectiveAuditStatus === 'COMPLETED'
      ? ''
      : effectiveAuditStatus === 'PARTIAL'
        ? ' (Partial)'
        : effectiveAuditStatus === 'FAILED'
          ? ' (Failed)'
          : ' (Interrupted)';

  const batchStateSuffixAr =
    effectiveAuditStatus === 'COMPLETED'
      ? ''
      : effectiveAuditStatus === 'PARTIAL'
        ? ' (جزئي)'
        : effectiveAuditStatus === 'FAILED'
          ? ' (فشل)'
          : ' (متوقف)';

  return (
    <div className="space-y-4 text-xs">
      {/* Header Summary + Confidence + Export (Section K Overview) */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/60 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-0.5">
            <div className="font-semibold text-sm text-slate-900 dark:text-white flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-blue-500" />
              <span>
                {locale === 'ar'
                  ? `تقرير التحقق الشامل المبني على الأدلة — ${report.hackathonTitle}`
                  : `Comprehensive Evidence Audit — ${report.hackathonTitle}`}
              </span>
            </div>
            <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
              {cov.repoFullName || 'No Repo'} ·{' '}
              {cov.commitSha && cov.commitShaVerified !== false
                ? `commit ${cov.commitSha.slice(0, 10)}`
                : `commit unverified (${cov.defaultBranch || 'HEAD'})`}{' '}
              · {locale === 'ar' ? 'الاستراتيجيات:' : 'Strategies:'}{' '}
              {report.detectedStrategies.join(', ')}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded border px-2 py-1 font-mono text-[10px] font-bold ${auditStatusBadgeClass}`}>
              {locale === 'ar' ? 'حالة التدقيق:' : 'Audit:'} {effectiveAuditStatus}
            </span>
            <span
              className={`rounded border px-2 py-1 font-mono text-[10px] font-bold ${
                conf.overallConfidence === 'HIGH'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : conf.overallConfidence === 'MEDIUM'
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                    : 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300'
              }`}
            >
              {locale === 'ar' ? 'الثقة:' : 'Confidence:'} {conf.overallConfidence}
            </span>
            <button
              type="button"
              onClick={handleDownloadJson}
              className="inline-flex items-center gap-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5" />
              <span>{locale === 'ar' ? 'تصدير JSON' : 'Export JSON'}</span>
            </button>
          </div>
        </div>

        {effectiveAuditStatus !== 'COMPLETED' && (
          <div
            className={`rounded-lg border px-3 py-2 text-[11px] space-y-1 ${
              effectiveAuditStatus === 'FAILED'
                ? 'border-rose-500/35 bg-rose-500/10 text-rose-800 dark:text-rose-200'
                : 'border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-200'
            }`}
          >
            <div className="font-semibold">
              {locale === 'ar'
                ? `حالة التنفيذ: ${effectiveAuditStatus} (${cov.batchesCompleted ?? 0}/${cov.batchesTotal ?? 0} دفعات مكتملة)`
                : `Audit Execution State: ${effectiveAuditStatus} (${cov.batchesCompleted ?? 0}/${cov.batchesTotal ?? 0} batch(es) completed)`}
            </div>
            {report.auditStatusReason && <p>{report.auditStatusReason}</p>}
            {report.resumable && (
              <p className="font-medium">
                {locale === 'ar'
                  ? 'تم حفظ النتائج المكتملة ويمكنك استئناف أو إعادة المحاولة دون تكرار الدفعات المكتملة.'
                  : 'Completed batch findings and fetched source files are preserved — use Resume/Retry Audit above without repeating finished Gemini calls.'}
              </p>
            )}
          </div>
        )}

        {/* Metrics Strip (Honest, never inflating 100%) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-2.5">
            <div className="text-[10px] text-slate-500">
              {locale === 'ar' ? 'تغطية شجرة الملفات' : 'Repo Files Inspected'}
            </div>
            <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5 text-[11px]">
              {cov.fullyInspectedCount} full · {cov.partiallyInspectedCount} partial / {cov.totalFilesInTree}
            </div>
            <div className="font-mono text-[10px] text-slate-500 mt-0.5">
              {cov.skippedCount} skipped · {cov.inaccessibleCount} inacc · {cov.failedCount ?? 0} failed
            </div>
            {typeof cov.inspectedSourceFilesCount === 'number' && cov.inspectedSourceFilesCount === 0 && cov.readmeInspected && (
              <div className="font-mono text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">
                {locale === 'ar' ? '0 ملفات برمجية (README فقط)' : '0 source files (README only)'}
              </div>
            )}
            {typeof cov.batchesTotal === 'number' && cov.batchesTotal > 0 && (
              <div className="font-mono text-[10px] text-blue-600 dark:text-blue-400 mt-0.5">
                {locale === 'ar'
                  ? `الدفعات: ${cov.batchesCompleted ?? 0}/${cov.batchesTotal}${cov.batchesPendingCount ? ` · ${cov.batchesPendingCount} متبقية` : ''}${batchStateSuffixAr}`
                  : `Batches: ${cov.batchesCompleted ?? 0}/${cov.batchesTotal}${cov.batchesPendingCount ? ` · ${cov.batchesPendingCount} pending` : ''}${batchStateSuffixEn}`}
              </div>
            )}
          </div>
          <div className="rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-2.5">
            <div className="text-[10px] text-slate-500">
              {locale === 'ar' ? 'الأهلية والمتطلبات' : 'Mandatory Requirements'}
            </div>
            <div className="mt-0.5">
              <StatusBadge status={report.sectionA_eligibility.overallStatus} locale={locale} />
            </div>
          </div>
          <div className="rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-2.5">
            <div className="text-[10px] text-slate-500">
              {locale === 'ar' ? 'الاختبارات المنفذة' : 'Automated Tests'}
            </div>
            <div className="mt-0.5">
              <StatusBadge status={report.sectionE_tests.summaryStatus} locale={locale} />
            </div>
          </div>
          <div className="rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-2.5">
            <div className="text-[10px] text-slate-500">
              {locale === 'ar' ? 'العرض المباشر (قراءة فقط)' : 'Live Demo Probe'}
            </div>
            <div className="mt-0.5">
              <StatusBadge status={report.sectionF_liveDemo.status} locale={locale} />
            </div>
          </div>
        </div>

        {/* Honest Confidence & Limitations Notice (Section K) */}
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
          <div className="font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>
              {locale === 'ar' ? 'القسم ك · الثقة والقيود الموثقة' : 'Section K · Confidence & Verification Limitations'}
            </span>
          </div>
          <p className="text-slate-700 dark:text-slate-300">{conf.reason}</p>
          {conf.limitations.length > 0 && (
            <ul className="list-disc ps-4 space-y-0.5 text-slate-600 dark:text-slate-400">
              {conf.limitations.map((lim, i) => (
                <li key={`${i}-${lim.slice(0, 24)}`}>{lim}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Section Navigation Tabs */}
      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 dark:border-slate-800 pb-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-md px-3 py-1.5 text-[11px] font-semibold transition-colors ${
              activeTab === tab.id
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'
            }`}
          >
            {locale === 'ar' ? tab.labelAr : tab.labelEn}
          </button>
        ))}
      </div>

      {/* TAB 1: Sections A & C (Eligibility + Verification Matrix) */}
      {activeTab === 'matrix' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2">
            <div className="font-semibold flex items-center gap-1.5 text-slate-900 dark:text-white">
              <CheckCircle2 className="h-3.5 w-3.5 text-blue-500" />
              <span>
                {locale === 'ar'
                  ? 'القسم أ · التحقق من الأهلية والمتطلبات الإلزامية الفعلية'
                  : 'Section A · Eligibility & Mandatory Requirements Verification'}
              </span>
            </div>
            <div className="space-y-2">
              {report.sectionA_eligibility.checks.map((chk) => (
                <div
                  key={chk.id}
                  className="rounded border border-slate-200 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-900/40 p-2.5 space-y-1"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900 dark:text-white">
                      {chk.claimOrRequirement}
                    </span>
                    <StatusBadge status={chk.status} locale={locale} />
                  </div>
                  <p className="text-slate-600 dark:text-slate-300">{chk.observedResult}</p>
                  <div className="text-[10px] font-mono text-slate-500">
                    {locale === 'ar' ? 'المصدر:' : 'Source:'} {chk.evidenceSource}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2">
            <div className="font-semibold flex items-center gap-1.5 text-slate-900 dark:text-white">
              <FileCode2 className="h-3.5 w-3.5 text-blue-500" />
              <span>
                {locale === 'ar'
                  ? 'القسم ج · مصفوفة ربط المتطلبات بالأدلة'
                  : 'Section C · Requirement-to-Evidence Verification Matrix'}
              </span>
            </div>
            {report.sectionC_matrix.length === 0 ? (
              <p className="text-slate-500">
                {locale === 'ar'
                  ? 'لا توجد متطلبات أو معايير مهيأة في هذا الهاكاثون للربط.'
                  : 'No configured requirements or rubric criteria available on this hackathon.'}
              </p>
            ) : (
              <div className="space-y-2.5">
                {report.sectionC_matrix.map((row) => (
                  <div
                    key={row.requirementId}
                    className="rounded border border-slate-200 dark:border-slate-800 p-3 space-y-1.5 bg-white dark:bg-[#0B1120]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-semibold text-slate-900 dark:text-white">
                          {row.requirementTitle}
                        </span>
                        {row.weight !== undefined && (
                          <span className="ms-2 font-mono text-[10px] text-blue-500">
                            ({row.weight}%)
                          </span>
                        )}
                        <span className="ms-2 text-[10px] font-mono text-slate-500">
                          [{row.sourceField}]
                        </span>
                      </div>
                      <StatusBadge status={row.finalStatus} locale={locale} />
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      {row.exactWording}
                    </p>
                    {row.staticCodeEvidence.length > 0 && (
                      <ul className="list-disc ps-4 space-y-0.5 text-slate-700 dark:text-slate-300">
                        {row.staticCodeEvidence.map((ev, i) => (
                          <li key={i}>{ev}</li>
                        ))}
                      </ul>
                    )}
                    {row.relevantFiles.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {row.relevantFiles.map((f, i) =>
                          f.blobUrl ? (
                            <a
                              key={`${f.path}-${i}`}
                              href={f.blobUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 rounded border border-blue-500/30 bg-blue-500/5 px-2 py-0.5 font-mono text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
                            >
                              <span>
                                {f.path}
                                {f.startLine ? `:L${f.startLine}-${f.endLine || f.startLine}` : ''}
                              </span>
                              <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          ) : (
                            <span
                              key={`${f.path}-${i}`}
                              className="rounded border border-slate-300 dark:border-slate-700 px-2 py-0.5 font-mono text-[10px]"
                            >
                              {f.path}
                              {f.startLine ? `:L${f.startLine}-${f.endLine || f.startLine}` : ''}
                            </span>
                          )
                        )}
                      </div>
                    )}
                    <div className="text-[10px] text-amber-700 dark:text-amber-300">
                      {locale === 'ar' ? 'الإجراء / الإثبات الناقص:' : 'Missing Proof / Next Step:'}{' '}
                      {row.missingProofOrAction}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Section B (Complete Repository Coverage) */}
      {activeTab === 'coverage' && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-3">
          <div className="font-semibold flex items-center gap-1.5 text-slate-900 dark:text-white">
            <FolderTree className="h-3.5 w-3.5 text-blue-500" />
            <span>
              {locale === 'ar'
                ? 'القسم ب · تغطية المستودع الكاملة وجرد الملفات'
                : 'Section B · Complete Repository Coverage & File Inventory'}
            </span>
          </div>
          <p className="text-slate-700 dark:text-slate-300">{cov.coverageHonestyNote}</p>

          {cov.hasDivergentRoots && cov.projectRoots.length > 0 && (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2.5 space-y-1">
              <div className="font-semibold text-amber-700 dark:text-amber-300">
                {locale === 'ar'
                  ? 'تنبيه: رصد عدة جذور للمشروع داخل المستودع'
                  : 'Notice: Multiple / Divergent Project Roots Detected'}
              </div>
              <ul className="list-disc ps-4 space-y-0.5 font-mono text-[11px]">
                {cov.projectRoots.map((root) => (
                  <li key={root.rootPath}>
                    {root.rootPath} ({root.fileCount} files) — {root.manifestFiles.join(', ')}
                    {root.selectedAsPrimary ? ' [PRIMARY SELECTED]' : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {cov.duplicateFileGroups.length > 0 && (
            <div className="rounded border border-slate-200 dark:border-slate-800 p-2.5 space-y-1">
              <div className="font-semibold">
                {locale === 'ar'
                  ? `ملفات متطابقة المحتوى (SHA مكرر: ${cov.duplicateFileGroups.length})`
                  : `Identical File Groups (${cov.duplicateFileGroups.length})`}
              </div>
              <ul className="list-disc ps-4 space-y-0.5 font-mono text-[10px] text-slate-500">
                {cov.duplicateFileGroups.slice(0, 6).map((grp) => (
                  <li key={grp.sha}>
                    {grp.sha.slice(0, 8)}: {grp.paths.join(' == ')}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {cov.importantUninspected.length > 0 && (
            <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2.5 space-y-1">
              <div className="font-semibold text-amber-700 dark:text-amber-300">
                {locale === 'ar'
                  ? `ملفات مهمة غير مفحوصة / مستثناة (${cov.importantUninspected.length})`
                  : `Important Uninspected / Skipped Files (${cov.importantUninspected.length})`}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {cov.importantUninspected.map((u, idx) => (
                  <span
                    key={`${u.path}-${u.reason}-${idx}`}
                    className="rounded border border-amber-500/30 bg-white/60 dark:bg-slate-900/60 px-2 py-0.5 font-mono text-[10px] text-amber-800 dark:text-amber-200"
                  >
                    {u.path} ({u.category} · {u.reason})
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="max-h-72 overflow-y-auto rounded border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800/70">
            {(showAllInventory ? cov.fileInventory : cov.fileInventory.slice(0, 80)).map((item) => (
              <div
                key={item.path}
                className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 font-mono text-[10px]"
              >
                <span className="truncate max-w-[60%] text-slate-800 dark:text-slate-200">
                  {item.path}
                  {item.chunks && item.chunks.length > 0
                    ? ` (${item.chunks.map((c) => `L${c.startLine}-${c.endLine}`).join(', ')})`
                    : ''}
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-slate-500">{item.category}</span>
                  {(() => {
                    const canonical =
                      item.auditStatus ||
                      (item.inspectionStatus === 'inspected'
                        ? 'FULLY_INSPECTED'
                        : item.inspectionStatus === 'partially_inspected'
                          ? 'PARTIALLY_INSPECTED'
                          : item.inspectionStatus === 'inaccessible'
                            ? 'INACCESSIBLE'
                            : item.inspectionStatus === 'failed'
                              ? 'FAILED'
                              : 'SKIPPED');
                    const badgeClass =
                      canonical === 'FULLY_INSPECTED'
                        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : canonical === 'PARTIALLY_INSPECTED'
                          ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
                          : canonical === 'FAILED'
                            ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
                            : canonical === 'INACCESSIBLE'
                              ? 'bg-orange-500/10 text-orange-700 dark:text-orange-300'
                              : 'bg-amber-500/10 text-amber-700 dark:text-amber-300';
                    return (
                      <span className={`rounded px-1.5 py-0.5 font-semibold ${badgeClass}`}>
                        {canonical} ({item.reason})
                      </span>
                    );
                  })()}
                </span>
              </div>
            ))}
          </div>
          {cov.fileInventory.length > 80 && (
            <button
              type="button"
              onClick={() => setShowAllInventory((prev) => !prev)}
              className="rounded border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {showAllInventory
                ? locale === 'ar'
                  ? 'عرض أول 80 ملفاً فقط'
                  : 'Show first 80 files only'
                : locale === 'ar'
                  ? `عرض جميع الملفات (${cov.fileInventory.length})`
                  : `Show all ${cov.fileInventory.length} inventory files`}
            </button>
          )}
        </div>
      )}

      {/* TAB 3: Sections D & G (Technical Architecture & Security) */}
      {activeTab === 'security' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2">
            <div className="font-semibold text-blue-600 dark:text-blue-400">
              {locale === 'ar'
                ? 'القسم د · نتائج المعمارية والتنفيذ التقني'
                : 'Section D · Technical Architecture & Implementation Findings'}
            </div>
            {report.sectionD_architecture.length === 0 && report.technicalObservations.length === 0 ? (
              <p className="text-slate-500">
                {locale === 'ar' ? 'لا توجد ملاحظات معمارية مفحوصة.' : 'No inspected architectural findings.'}
              </p>
            ) : (
              <div className="space-y-2">
                {report.sectionD_architecture.map((rec) => (
                  <div key={rec.id} className="rounded border border-slate-200 dark:border-slate-800 p-2.5 space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900 dark:text-white">{rec.claimOrRequirement}</span>
                      <StatusBadge status={rec.status} locale={locale} />
                    </div>
                    <p className="text-slate-700 dark:text-slate-300">{rec.observedResult}</p>
                    {rec.blobUrl ? (
                      <a
                        href={rec.blobUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-mono text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        <span>
                          {rec.filePath}
                          {rec.startLine ? `:L${rec.startLine}-${rec.endLine || rec.startLine}` : ''}
                        </span>
                        <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    ) : rec.filePath ? (
                      <span className="inline-flex items-center gap-1 font-mono text-[10px] text-slate-500 dark:text-slate-400">
                        {rec.filePath}
                        {rec.startLine ? `:L${rec.startLine}-${rec.endLine || rec.startLine}` : ''}
                      </span>
                    ) : null}
                  </div>
                ))}
                {report.technicalObservations.map((obs, idx) => (
                  <div key={idx} className="rounded border border-blue-500/20 bg-blue-500/5 p-2 text-slate-700 dark:text-slate-300">
                    {obs}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-rose-500/30 p-3 space-y-2">
            <div className="font-semibold text-rose-600 dark:text-rose-400 flex items-center gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5" />
              <span>
                {locale === 'ar'
                  ? 'القسم ز · الأمان والاعتمادية وحماية الأسرار'
                  : 'Section G · Security, Reliability & Secret Protection Findings'}
              </span>
            </div>
            <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-2 flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
              <Lock className="h-3.5 w-3.5 shrink-0" />
              <span>
                {locale === 'ar'
                  ? `ملفات .env والمفاتيح السرية مستثناة من الإرسال لـ Gemini. عدد القيم السرية المنقحة قبل التدقيق: ${report.sectionG_security.redactedSecretsCount}`
                  : `Sensitive .env/key files are blocked before AI transit. Hardcoded secrets scrubbed prior to Gemini audit: ${report.sectionG_security.redactedSecretsCount}.`}
              </span>
            </div>
            {report.sectionG_security.findings.map((f) => (
              <div key={f.id} className="rounded border border-rose-500/25 bg-rose-500/5 p-2.5 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-slate-900 dark:text-white">{f.claimOrRequirement}</span>
                  <StatusBadge status={f.status} locale={locale} />
                </div>
                <p className="text-slate-700 dark:text-slate-300">{f.observedResult}</p>
                {f.blobUrl ? (
                  <a
                    href={f.blobUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    <span>
                      {f.evidenceSource}
                      {f.startLine ? `:L${f.startLine}-${f.endLine || f.startLine}` : ''}
                    </span>
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                ) : (
                  <div className="font-mono text-[10px] text-slate-500">
                    {f.evidenceSource}
                    {f.startLine ? `:L${f.startLine}-${f.endLine || f.startLine}` : ''}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 4: Sections E & F (Executed Tests vs Test Files + Safe Live Demo Probe) */}
      {activeTab === 'tests_demo' && (
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold flex items-center gap-1.5 text-slate-900 dark:text-white">
                <Terminal className="h-3.5 w-3.5 text-blue-500" />
                <span>
                  {locale === 'ar'
                    ? 'القسم هـ · نتائج الاختبارات المنفذة مقابل ملفات الاختبار'
                    : 'Section E · Executed Test Results vs Discovered Test Files'}
                </span>
              </div>
              <StatusBadge status={report.sectionE_tests.summaryStatus} locale={locale} />
            </div>
            <p className="text-slate-700 dark:text-slate-300">{report.sectionE_tests.honestyNote}</p>

            {((report.sectionE_tests.detectedTestFrameworks?.length ?? 0) > 0 ||
              (report.sectionE_tests.detectedTestCommands?.length ?? 0) > 0) && (
              <div className="rounded border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 p-2 font-mono text-[10px] text-slate-600 dark:text-slate-300 space-y-0.5">
                {(report.sectionE_tests.detectedTestFrameworks?.length ?? 0) > 0 && (
                  <div>
                    {locale === 'ar' ? 'الأطر المكتشفة:' : 'Detected Frameworks:'}{' '}
                    {report.sectionE_tests.detectedTestFrameworks!.join(', ')}
                  </div>
                )}
                {(report.sectionE_tests.detectedTestCommands?.length ?? 0) > 0 && (
                  <div>
                    {locale === 'ar' ? 'أوامر الاختبار المعرّفة:' : 'Configured Test Commands:'}{' '}
                    {report.sectionE_tests.detectedTestCommands!.join(' · ')}
                  </div>
                )}
              </div>
            )}

            {report.sectionE_tests.discoveredTestFiles.length > 0 && (
              <div>
                <div className="font-semibold text-[11px] mb-1">
                  {locale === 'ar'
                    ? `ملفات الاختبار المكتشفة في الكود (${report.sectionE_tests.discoveredTestFiles.length}):`
                    : `Discovered Test Files (${report.sectionE_tests.discoveredTestFiles.length}):`}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {report.sectionE_tests.discoveredTestFiles.map((tf) => (
                    <span
                      key={tf}
                      className="rounded border border-slate-300 dark:border-slate-700 px-2 py-0.5 font-mono text-[10px]"
                    >
                      {tf}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {report.sectionE_tests.executedTests.length > 0 && (
              <div className="space-y-2 pt-2">
                {report.sectionE_tests.executedTests.map((t) => (
                  <div key={t.id} className="rounded border border-slate-200 dark:border-slate-800 p-2.5 space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono font-semibold">{t.command}</span>
                      <StatusBadge status={t.status} locale={locale} />
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {t.scope} · exitCode={t.exitCode ?? 'unknown'} · {t.source}
                    </div>
                    <pre className="whitespace-pre-wrap rounded bg-slate-950/90 text-slate-100 p-2 text-[10px] overflow-x-auto">
                      {t.stdoutExcerpt}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold flex items-center gap-1.5 text-slate-900 dark:text-white">
                <Globe className="h-3.5 w-3.5 text-blue-500" />
                <span>
                  {locale === 'ar'
                    ? 'القسم و · فحص العرض المباشر الآمن (للقراءة فقط)'
                    : 'Section F · Safe Read-Only Live Demo Verification'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {report.sectionF_liveDemo.probeMethod && (
                  <span className="rounded border border-slate-300 dark:border-slate-700 px-2 py-0.5 font-mono text-[10px] text-slate-600 dark:text-slate-300">
                    {report.sectionF_liveDemo.probeMethod}
                  </span>
                )}
                <StatusBadge status={report.sectionF_liveDemo.status} locale={locale} />
              </div>
            </div>
            <p className="text-slate-700 dark:text-slate-300">{report.sectionF_liveDemo.summary}</p>
            {(report.sectionF_liveDemo.manualVerificationRequired ||
              report.sectionF_liveDemo.browserCorsBlocked) && (
              <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-800 dark:text-amber-200 flex flex-wrap items-center justify-between gap-2">
                <span>
                  {locale === 'ar'
                    ? 'يلزم التحقق اليدوي في المتصفح للتفاعلات الحية وتسجيل الدخول وسير العمل الكامل.'
                    : 'Manual browser verification required for interactive UI flows, authentication, and end-to-end runtime proof.'}
                </span>
                {report.sectionF_liveDemo.demoUrl && (
                  <a
                    href={report.sectionF_liveDemo.demoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold underline"
                  >
                    <span>{locale === 'ar' ? 'فتح العرض يدوياً' : 'Open Demo Manually'}</span>
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </div>
            )}
            {report.sectionF_liveDemo.checkedAspects.length > 0 && (
              <div>
                <div className="font-semibold text-[11px] text-emerald-700 dark:text-emerald-300">
                  {locale === 'ar' ? 'ما تم فحصه:' : 'Checked (Read-Only):'}
                </div>
                <ul className="list-disc ps-4 text-slate-600 dark:text-slate-300">
                  {report.sectionF_liveDemo.checkedAspects.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
            {report.sectionF_liveDemo.blockedAspects.length > 0 && (
              <div>
                <div className="font-semibold text-[11px] text-amber-700 dark:text-amber-300">
                  {locale === 'ar' ? 'ما يتعذر إثباته آلياً:' : 'Blocked / Unverified Automatically:'}
                </div>
                <ul className="list-disc ps-4 text-slate-600 dark:text-slate-300">
                  {report.sectionF_liveDemo.blockedAspects.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 5: Sections H & I (Contradicted Claims + Missing Evidence + Team Questions) */}
      {activeTab === 'claims' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-lg border border-amber-500/30 p-3 space-y-2">
            <div className="font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>
                {locale === 'ar'
                  ? 'القسم ح · الادعاءات المتعارضة أو غير المدعومة'
                  : 'Section H · Contradicted & Unverified Claims'}
              </span>
            </div>
            {report.sectionH_contradictions.map((c) => (
              <div key={c.id} className="rounded border border-amber-500/20 p-2 space-y-1">
                <div className="flex justify-between gap-2">
                  <span className="font-semibold">{c.claimOrRequirement}</span>
                  <StatusBadge status={c.status} locale={locale} />
                </div>
                <p className="text-slate-600 dark:text-slate-300">{c.observedResult}</p>
                {c.blobUrl ? (
                  <a
                    href={c.blobUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    <span>{c.evidenceSource}</span>
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                ) : (
                  <span className="inline-block font-mono text-[10px] text-slate-500 dark:text-slate-400">
                    {c.evidenceSource}
                    {c.filePath
                      ? ` (${c.filePath}${c.startLine ? `:L${c.startLine}-${c.endLine || c.startLine}` : ''})`
                      : ''}
                  </span>
                )}
              </div>
            ))}
            {(report.teamClaims || []).map((tc, idx) => (
              <div key={idx} className="rounded border border-slate-200 dark:border-slate-800 p-2 text-slate-600 dark:text-slate-300">
                {tc}
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2">
            <div className="font-semibold flex items-center gap-1.5 text-slate-900 dark:text-white">
              <HelpCircle className="h-3.5 w-3.5 text-blue-500" />
              <span>
                {locale === 'ar'
                  ? 'القسم ط · الأدلة الناقصة وأسئلة المحكم للفريق'
                  : 'Section I · Missing Evidence & Judge Follow-Up Questions'}
              </span>
            </div>
            <ul className="list-disc ps-4 space-y-1 text-slate-600 dark:text-slate-300">
              {report.sectionI_missingEvidence.missingItems.map((m, idx) => (
                <li key={`m-${idx}`}>{m}</li>
              ))}
            </ul>
            <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
              <div className="font-semibold mb-1 text-blue-600 dark:text-blue-400">
                {locale === 'ar' ? 'أسئلة التحقق الموصى بطرحها على الفريق:' : 'Questions for Team Verification:'}
              </div>
              <ul className="list-disc ps-4 space-y-1 text-slate-700 dark:text-slate-200">
                {report.sectionI_missingEvidence.teamQuestions.map((q, idx) => (
                  <li key={`q-${idx}`}>{q}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* TAB 6: Section J (Evidence-Based Criterion Observations — ZERO numeric scores) */}
      {activeTab === 'rubric' && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2.5">
          <div className="font-semibold text-slate-900 dark:text-white">
            {locale === 'ar'
              ? 'القسم ي · ملاحظات مبنية على الأدلة لكل معيار (بدون أي درجات رقمية من الذكاء الاصطناعي)'
              : 'Section J · Evidence-Based Observations per Criterion (No AI Numeric Scores)'}
          </div>
          {report.sectionJ_criterionObservations.map((crit) => (
            <div
              key={crit.criterionId}
              className="rounded border border-slate-200 dark:border-slate-800 p-3 space-y-1.5 bg-white dark:bg-[#0B1120]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-900 dark:text-white">
                  {crit.criterionName} ({crit.weight}%)
                </span>
                <StatusBadge status={crit.status} locale={locale} />
              </div>
              {crit.description && (
                <p className="text-[11px] text-slate-500 dark:text-slate-400">{crit.description}</p>
              )}
              <ul className="list-disc ps-4 space-y-0.5 text-slate-700 dark:text-slate-300">
                {crit.observations.map((obs, idx) => (
                  <li key={idx}>{obs}</li>
                ))}
              </ul>
              {crit.citations.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {crit.citations.map((c, idx) =>
                    c.blobUrl ? (
                      <a
                        key={`${c.path}-${idx}`}
                        href={c.blobUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded border border-blue-500/30 px-2 py-0.5 font-mono text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        <span>
                          {c.path}
                          {c.startLine ? `:L${c.startLine}-${c.endLine || c.startLine}` : ''}
                        </span>
                        <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    ) : (
                      <span
                        key={`${c.path}-${idx}`}
                        className="rounded border border-slate-300 dark:border-slate-700 px-2 py-0.5 font-mono text-[10px] text-slate-600 dark:text-slate-300"
                      >
                        {c.path}
                        {c.startLine ? `:L${c.startLine}-${c.endLine || c.startLine}` : ''}
                      </span>
                    )
                  )}
                </div>
              )}
              {crit.missingProof.length > 0 && (
                <div className="text-[10px] text-amber-700 dark:text-amber-300">
                  {locale === 'ar' ? 'نقص الإثبات:' : 'Missing proof:'} {crit.missingProof.join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
