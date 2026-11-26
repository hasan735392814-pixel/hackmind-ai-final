import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Trophy } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import {
  listJudgeAssignmentsByJudge,
  listOrganizerHackathons,
  listPublishedHackathons,
  listPublishedResults,
  listUserProjects,
  listUserRegistrations,
  listUserSubmissions,
  listUserTeams
} from '../services/firebase/firestoreService';
import { getAIActivitySummary } from '../services/hybridAI/inferenceLogger';
import {
  resolveOverviewStats,
  type ResolvedOverviewStats
} from '../utils/dashboardMetrics';

const EMPTY_STATS: ResolvedOverviewStats = {
  publishedHackathons: [],
  publishedHackathonsCount: null,
  organizerHackathonsCount: null,
  registrationsCount: null,
  teamsCount: null,
  projectsCount: null,
  submissionsCount: null,
  assignmentsCount: null,
  publishedResults: [],
  queryErrors: []
};

export function OverviewDashboard() {
  const { user, profile, isAdmin } = useAuth();
  const { locale } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<ResolvedOverviewStats>(EMPTY_STATS);

  const fetchDashboardStats = useCallback(async () => {
    if (!user) {
      setStats({
        publishedHackathons: [],
        publishedHackathonsCount: 0,
        organizerHackathonsCount: 0,
        registrationsCount: 0,
        teamsCount: 0,
        projectsCount: 0,
        submissionsCount: 0,
        assignmentsCount: 0,
        publishedResults: [],
        queryErrors: []
      });
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const [pub, org, regs, tms, projs, subs, assigns, pubRes] = await Promise.allSettled([
        listPublishedHackathons(),
        listOrganizerHackathons(user.uid),
        listUserRegistrations(user.uid),
        listUserTeams(user.uid),
        listUserProjects(user.uid),
        listUserSubmissions(user.uid),
        listJudgeAssignmentsByJudge(user.uid),
        listPublishedResults()
      ]);

      setStats(
        resolveOverviewStats({
          publishedHackathons: pub,
          organizerHackathons: org,
          registrations: regs,
          teams: tms,
          projects: projs,
          submissions: subs,
          assignments: assigns,
          publishedResults: pubRes
        })
      );
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    let active = true;
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const [pub, org, regs, tms, projs, subs, assigns, pubRes] = await Promise.allSettled([
          listPublishedHackathons(),
          listOrganizerHackathons(user.uid),
          listUserRegistrations(user.uid),
          listUserTeams(user.uid),
          listUserProjects(user.uid),
          listUserSubmissions(user.uid),
          listJudgeAssignmentsByJudge(user.uid),
          listPublishedResults()
        ]);
        if (!active) return;
        setStats(
          resolveOverviewStats({
            publishedHackathons: pub,
            organizerHackathons: org,
            registrations: regs,
            teams: tms,
            projects: projs,
            submissions: subs,
            assignments: assigns,
            publishedResults: pubRes
          })
        );
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [user]);

  const aiSummary = getAIActivitySummary();
  const effectiveRole = isAdmin ? 'admin' : profile?.approvedRole || 'participant';

  const formatSingleMetric = (val: number | null) =>
    val === null ? (locale === 'ar' ? 'تعذر التحميل' : 'Error') : val;

  const metrics = [
    {
      label: locale === 'ar' ? 'الهاكاثونات المنشورة' : 'Published Hackathons',
      value: formatSingleMetric(stats.publishedHackathonsCount),
      hasError: stats.publishedHackathonsCount === null
    },
    {
      label: locale === 'ar' ? 'تسجيلاتي' : 'My Registrations',
      value: formatSingleMetric(stats.registrationsCount),
      hasError: stats.registrationsCount === null
    },
    {
      label: locale === 'ar' ? 'فرقي ومشاريعي' : 'Teams / Projects',
      value:
        stats.teamsCount === null || stats.projectsCount === null
          ? `${stats.teamsCount ?? '!'} / ${stats.projectsCount ?? '!'}`
          : `${stats.teamsCount} / ${stats.projectsCount}`,
      hasError: stats.teamsCount === null || stats.projectsCount === null
    },
    {
      label: locale === 'ar' ? 'تسليماتي' : 'My Submissions',
      value: formatSingleMetric(stats.submissionsCount),
      hasError: stats.submissionsCount === null
    },
    {
      label: locale === 'ar' ? 'الهاكاثونات التي أنظمها' : 'Organized Events',
      value: formatSingleMetric(stats.organizerHackathonsCount),
      hasError: stats.organizerHackathonsCount === null
    },
    {
      label: locale === 'ar' ? 'مهام التحكيم' : 'Judge Assignments',
      value: formatSingleMetric(stats.assignmentsCount),
      hasError: stats.assignmentsCount === null
    }
  ];

  const publishedHackathons = stats.publishedHackathons;
  const publishedResults = stats.publishedResults;

  const hackathonTitleById = new Map<string, string>(
    publishedHackathons.map((h) => [h.id, h.title])
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            {locale === 'ar'
              ? `مرحباً، ${profile?.displayName || user?.displayName || 'مبتكر'}`
              : `Welcome, ${profile?.displayName || user?.displayName || 'Builder'}`}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {locale === 'ar'
              ? 'ملخص فوري لأنشطتك الموثقة في Firestore ومسارات الذكاء الهجين.'
              : 'Live summary of your persisted Firestore activity and Hybrid AI executions.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/app/discover"
            className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
          >
            {locale === 'ar' ? 'استكشاف الهاكاثونات' : 'Discover Hackathons'}
          </Link>
          {effectiveRole === 'judge' && (
            <Link
              to="/app/judging"
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {locale === 'ar' ? 'مساحة التحكيم' : 'Judge Workspace'}
            </Link>
          )}
          {effectiveRole === 'sponsor' && (
            <Link
              to="/app/sponsors"
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {locale === 'ar' ? 'تحليلات الرعاة' : 'Sponsor Analytics'}
            </Link>
          )}
          {(effectiveRole === 'organizer' || effectiveRole === 'admin') && (
            <Link
              to="/app/organizer"
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {locale === 'ar' ? 'استوديو المنظمين' : 'Organizer Studio'}
            </Link>
          )}
          {effectiveRole === 'participant' && (
            <Link
              to="/app/builder"
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {locale === 'ar' ? 'مساحة المشاركين' : 'Builder Workspace'}
            </Link>
          )}
        </div>
      </div>

      {!loading && stats.queryErrors.length > 0 && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold">
              {locale === 'ar'
                ? 'تعذر تحميل بعض إحصائيات Firestore:'
                : 'Some Firestore dashboard statistics could not be loaded:'}
            </span>
            <button
              type="button"
              onClick={() => void fetchDashboardStats()}
              className="inline-flex items-center gap-1 rounded bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-700"
            >
              <RefreshCw className="h-3 w-3" />
              <span>{locale === 'ar' ? 'إعادة المحاولة' : 'Retry'}</span>
            </button>
          </div>
          <ul className="list-disc ps-5 space-y-0.5 font-mono text-[11px]">
            {stats.queryErrors.map((err) => (
              <li key={err.key}>
                {locale === 'ar' ? err.labelAr : err.labelEn}: {err.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {metrics.map((m) => (
          <div
            key={m.label}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4"
          >
            <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{m.label}</div>
            <div
              className={`mt-2 font-mono font-bold tabular-nums ${
                !loading && m.hasError
                  ? 'text-sm text-red-600 dark:text-red-400'
                  : 'text-2xl text-slate-900 dark:text-white'
              }`}
            >
              {loading ? '—' : m.value}
            </div>
          </div>
        ))}
      </div>

      {/* Quick Workflows & AI Status */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
          <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
            {locale === 'ar' ? 'النتائج الرسمية المنشورة' : 'Published Competition Rankings'}
          </h2>

          {publishedResults.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {locale === 'ar'
                ? 'لم يتم نشر نتائج نهائية بعد. ستظهر الترتيبات النهائية هنا فور اعتمادها من المنظمين.'
                : 'No final hackathon rankings have been published yet. Once an organizer publishes audited results, teams can review rankings and score explanations here.'}
            </p>
          ) : (
            <div className="space-y-4">
              {publishedResults.map((res) => (
                <div
                  key={res.hackathonId}
                  className="border-t border-slate-200 dark:border-slate-800 pt-4 first:border-t-0 first:pt-0 space-y-2"
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                    <Trophy className="h-4 w-4 text-amber-500" />
                    <span>{hackathonTitleById.get(res.hackathonId) || res.hackathonId}</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                          <th className="py-2 text-start">#</th>
                          <th className="py-2 text-start">{locale === 'ar' ? 'المشروع' : 'Project'}</th>
                          <th className="py-2 text-start">{locale === 'ar' ? 'الفريق' : 'Team'}</th>
                          <th className="py-2 text-end">{locale === 'ar' ? 'الدرجة' : 'Score'}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {res.rankings.slice(0, 5).map((r) => (
                          <tr
                            key={r.submissionId}
                            className="border-b border-slate-100 dark:border-slate-800/60"
                          >
                            <td className="py-2 font-mono tabular-nums font-semibold">#{r.rank}</td>
                            <td className="py-2 font-medium text-slate-900 dark:text-white">{r.projectTitle}</td>
                            <td className="py-2 text-slate-600 dark:text-slate-300">{r.teamName}</td>
                            <td className="py-2 text-end font-mono tabular-nums font-semibold">
                              {r.averageScore.toFixed(1)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
              {locale === 'ar' ? 'نشاط الذكاء الهجين' : 'Hybrid AI Activity'}
            </h2>
            <Link to="/app/diagnostics" className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline">
              {locale === 'ar' ? 'التفاصيل' : 'Diagnostics'}
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
              <div className="text-slate-500 dark:text-slate-400">ON-DEVICE</div>
              <div className="mt-1 font-mono text-xl font-bold tabular-nums">{aiSummary.totalLocalExecutions}</div>
            </div>
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
              <div className="text-slate-500 dark:text-slate-400">CLOUD</div>
              <div className="mt-1 font-mono text-xl font-bold tabular-nums">{aiSummary.totalCloudExecutions}</div>
            </div>
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
              <div className="text-slate-500 dark:text-slate-400">
                {locale === 'ar' ? 'متوسط الزمن' : 'Avg Latency'}
              </div>
              <div className="mt-1 font-mono text-xl font-bold tabular-nums">{aiSummary.averageResponseMs} ms</div>
            </div>
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
              <div className="text-slate-500 dark:text-slate-400">
                {locale === 'ar' ? 'آخر مصدر' : 'Last Source'}
              </div>
              <div className="mt-1 font-mono text-xs font-semibold truncate">
                {aiSummary.lastInferenceStatus}
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2 text-xs">
            <div className="font-semibold text-slate-900 dark:text-white">
              {locale === 'ar' ? 'حالة الدور والوصول' : 'Active Workspace Role'}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-slate-600 dark:text-slate-300">
              <span>
                {locale === 'ar' ? 'الدور المعتمد:' : 'Approved Role:'}{' '}
                <strong className="uppercase font-mono">{effectiveRole}</strong>
              </span>
              <Link to="/app/profile" className="text-blue-600 dark:text-blue-400 hover:underline">
                {locale === 'ar' ? 'إدارة الملف والخصوصية' : 'Profile & Privacy'}
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
