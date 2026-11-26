import { CheckCircle2, HelpCircle, MinusCircle, XCircle } from 'lucide-react';
import type { EligibilityReport, EligibilityStatus } from '../../services/judgingV2/types';

interface Props {
  locale: 'en' | 'ar';
  report: EligibilityReport;
}

function renderStatusText(status: EligibilityStatus, isAr: boolean) {
  switch (status) {
    case 'PASS':
      return {
        label: isAr ? 'مستوفى (PASS)' : 'PASS',
        cls: 'text-emerald-700 dark:text-emerald-400',
        Icon: CheckCircle2
      };
    case 'FAIL':
      return {
        label: isAr ? 'غير مستوفى (FAIL)' : 'FAIL',
        cls: 'text-red-700 dark:text-red-400',
        Icon: XCircle
      };
    case 'NOT_APPLICABLE':
      return {
        label: isAr ? 'لا ينطبق' : 'NOT_APPLICABLE',
        cls: 'text-slate-500 dark:text-slate-400',
        Icon: MinusCircle
      };
    default:
      return {
        label: isAr ? 'غير موثّق' : 'UNVERIFIED',
        cls: 'text-amber-700 dark:text-amber-400',
        Icon: HelpCircle
      };
  }
}

export function EligibilitySection({ locale, report }: Props) {
  const isAr = locale === 'ar';

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
            {isAr
              ? 'فحص الأهلية والامتثال (منفصل تماماً عن التقييم)'
              : 'Eligibility & Compliance Checks (Separated from Judging Score)'}
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
            {isAr
              ? 'تعتمد النتائج فقط على قواعد الهاكاثون المصرّح بها في السجل ولا تؤثر إطلاقاً على درجات التحكيم.'
              : 'Evaluated strictly from accessible hackathon metadata. Eligibility checks never alter judging weights or weighted scores.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono tabular-nums">
          <span className="text-emerald-700 dark:text-emerald-400">
            PASS: {report.summary.passCount}
          </span>
          <span className="text-slate-300 dark:text-slate-700">·</span>
          <span className="text-red-700 dark:text-red-400">
            FAIL: {report.summary.failCount}
          </span>
          <span className="text-slate-300 dark:text-slate-700">·</span>
          <span className="text-amber-700 dark:text-amber-400">
            UNVERIFIED: {report.summary.unverifiedCount}
          </span>
          <span className="text-slate-300 dark:text-slate-700">·</span>
          <span className="text-slate-500 dark:text-slate-400">
            N/A: {report.summary.notApplicableCount}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-start text-xs">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
              <th className="py-2 pe-4 text-start font-medium">{isAr ? 'المعيار' : 'Check'}</th>
              <th className="py-2 pe-4 text-start font-medium">{isAr ? 'الحالة' : 'Status'}</th>
              <th className="py-2 pe-4 text-start font-medium">{isAr ? 'القيمة الفعلية' : 'Observed Value'}</th>
              <th className="py-2 pe-4 text-start font-medium">{isAr ? 'القاعدة المتوقعة' : 'Rule Source & Spec'}</th>
              <th className="py-2 text-start font-medium">{isAr ? 'ملاحظة' : 'Note'}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {report.checks.map((item) => {
              const st = renderStatusText(item.status, isAr);
              const Icon = st.Icon;
              return (
                <tr key={item.id} className="align-top">
                  <td className="py-2.5 pe-4 font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
                    {isAr ? item.labelAr : item.label}
                  </td>
                  <td className="py-2.5 pe-4 whitespace-nowrap">
                    <span className={`inline-flex items-center gap-1.5 font-mono font-semibold ${st.cls}`}>
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span>{st.label}</span>
                    </span>
                  </td>
                  <td className="py-2.5 pe-4 font-mono text-slate-700 dark:text-slate-300">
                    {item.actualValue}
                  </td>
                  <td className="py-2.5 pe-4 text-slate-600 dark:text-slate-400">
                    <div className="font-mono text-[11px] text-slate-500">{item.ruleSource}</div>
                    <div>{item.expectedRule}</div>
                  </td>
                  <td className="py-2.5 text-slate-600 dark:text-slate-300">{item.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
