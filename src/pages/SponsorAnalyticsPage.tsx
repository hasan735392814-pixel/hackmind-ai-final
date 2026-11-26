import { useEffect, useState, type FormEvent } from 'react';
import { BarChart3, Trophy } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import {
  listPublishedHackathons,
  listPublishedResults,
  listSponsorRecords,
  saveSponsorRecord
} from '../services/firebase/firestoreService';
import type { Hackathon, HackathonResults, SponsorRecord } from '../types/domain';
import { isValidHttpUrl } from '../utils/validation';

export function SponsorAnalyticsPage() {
  const { user, emailVerified } = useAuth();
  const { locale, t } = useLanguage();

  const [hackathons, setHackathons] = useState<Hackathon[]>([]);
  const [results, setResults] = useState<HackathonResults[]>([]);
  const [sponsors, setSponsors] = useState<SponsorRecord[]>([]);

  const [editingSponsorId, setEditingSponsorId] = useState<string | null>(null);
  const [hackathonId, setHackathonId] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const loadAnalytics = async () => {
    if (!user) return;
    const [hacks, res, spns] = await Promise.all([
      listPublishedHackathons().catch(() => []),
      listPublishedResults().catch(() => []),
      listSponsorRecords(user.uid).catch(() => [])
    ]);
    setHackathons(hacks);
    setResults(res);
    setSponsors(spns);
    if (hacks.length > 0 && !hackathonId) setHackathonId(hacks[0].id);
  };

  useEffect(() => {
    void loadAnalytics();
  }, [user]);

  const approvedPartnerships = sponsors.filter((sp) => sp.status === 'approved');
  const pendingOrRejectedRequests = sponsors.filter((sp) => sp.status !== 'approved');
  const hackathonTitleById = new Map(hackathons.map((h) => [h.id, h.title]));

  // Aggregate technology trends across published hackathons
  const techCounts = new Map<string, number>();
  const trackCounts = new Map<string, number>();
  for (const h of hackathons) {
    for (const tech of h.technologies || []) {
      techCounts.set(tech, (techCounts.get(tech) ?? 0) + 1);
    }
    for (const tr of h.tracks || []) {
      trackCounts.set(tr, (trackCounts.get(tr) ?? 0) + 1);
    }
  }
  const topTechnologies = Array.from(techCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topTracks = Array.from(trackCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const startEditPending = (sp: SponsorRecord) => {
    setEditingSponsorId(sp.id);
    setHackathonId(sp.hackathonId);
    setOrganizationName(sp.organizationName);
    setWebsiteUrl(sp.websiteUrl || '');
    setNotes(sp.notes || '');
    setErrorMsg('');
    setFeedback('');
  };

  const resetForm = () => {
    setEditingSponsorId(null);
    setOrganizationName('');
    setWebsiteUrl('');
    setNotes('');
  };

  const handleRequestSponsorship = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !emailVerified) {
      setErrorMsg(locale === 'ar' ? 'يلزم حساب موثق البريد الإلكتروني.' : 'Verified account required.');
      return;
    }
    const targetHack = hackathons.find((h) => h.id === hackathonId);
    if (!targetHack && !editingSponsorId) {
      setErrorMsg(locale === 'ar' ? 'اختر هاكاثوناً منشوراً.' : 'Select a published hackathon.');
      return;
    }
    if (websiteUrl.trim() && !isValidHttpUrl(websiteUrl)) {
      setErrorMsg(
        locale === 'ar'
          ? 'يجب أن يبدأ رابط الموقع بـ http:// أو https://'
          : 'Website URL must start with http:// or https://'
      );
      return;
    }

    setBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      const existingPending = editingSponsorId
        ? sponsors.find((s) => s.id === editingSponsorId)
        : undefined;
      await saveSponsorRecord({
        id: editingSponsorId || undefined,
        hackathonId: existingPending?.hackathonId || targetHack!.id,
        organizerId: existingPending?.organizerId || targetHack!.organizerId,
        sponsorUserId: user.uid,
        organizationName,
        websiteUrl,
        notes
      });
      resetForm();
      await loadAnalytics();
      setFeedback(
        editingSponsorId
          ? locale === 'ar'
            ? 'تم تحديث طلب الرعاية المعلق.'
            : 'Pending sponsorship request updated.'
          : locale === 'ar'
            ? 'تم إرسال طلب الرعاية. سيقوم منظم الهاكاثون بمراجعته وتحديد الفئة الرسمية.'
            : 'Sponsorship request submitted. The hackathon organizer will review and assign your official tier.'
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : locale === 'ar'
            ? 'فشل إرسال طلب الرعاية.'
            : 'Failed to submit sponsorship request'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
          {t.sidebar.sponsors}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {locale === 'ar'
            ? 'تحليلات مجمعة لاتجاهات التقنيات والمسارات ونتائج المنافسات المنشورة دون كشف أي بيانات خاصة بالمشاركين.'
            : 'Aggregate competition analytics from published hackathons and outcomes without exposing private participant PII.'}
        </p>
      </div>

      {/* Aggregate KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4">
          <div className="text-xs text-slate-500">
            {locale === 'ar' ? 'الهاكاثونات المنشورة' : 'Published Hackathons'}
          </div>
          <div className="mt-1 font-mono text-2xl font-bold tabular-nums">{hackathons.length}</div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4">
          <div className="text-xs text-slate-500">
            {locale === 'ar' ? 'تقارير النتائج المنشورة' : 'Published Outcome Reports'}
          </div>
          <div className="mt-1 font-mono text-2xl font-bold tabular-nums">{results.length}</div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4">
          <div className="text-xs text-slate-500">
            {locale === 'ar' ? 'الشراكات المعتمدة' : 'Approved Partnerships'}
          </div>
          <div className="mt-1 font-mono text-2xl font-bold tabular-nums">{approvedPartnerships.length}</div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4">
          <div className="text-xs text-slate-500">
            {locale === 'ar' ? 'وسوم المسارات المنشورة' : 'Published Track Tags'}
          </div>
          <div className="mt-1 font-mono text-2xl font-bold tabular-nums">{trackCounts.size}</div>
        </div>
      </div>

      {/* Technology & Track Trends */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
          <h2 className="font-display text-base font-semibold flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-blue-500" />
            <span>{locale === 'ar' ? 'اتجاهات التقنيات' : 'Technology Trends'}</span>
          </h2>
          {topTechnologies.length === 0 ? (
            <p className="text-xs text-slate-500">
              {locale === 'ar'
                ? 'لا توجد تقنيات هاكاثون منشورة بعد.'
                : 'No published hackathon technologies recorded yet.'}
            </p>
          ) : (
            <div className="space-y-3">
              {topTechnologies.map(([tech, count]) => (
                <div key={tech} className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="font-medium">{tech}</span>
                    <span className="font-mono tabular-nums text-slate-500">{count}</span>
                  </div>
                  <div className="h-2 rounded bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-blue-600"
                      style={{
                        width: `${Math.min(100, (count / Math.max(1, hackathons.length)) * 100)}%`
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
          <h2 className="font-display text-base font-semibold">
            {locale === 'ar' ? 'توزيع مسارات المنافسة' : 'Competition Track Distribution'}
          </h2>
          {topTracks.length === 0 ? (
            <p className="text-xs text-slate-500">
              {locale === 'ar' ? 'لا توجد مسارات منشورة بعد.' : 'No competition tracks published yet.'}
            </p>
          ) : (
            <div className="space-y-3">
              {topTracks.map(([trackName, count]) => (
                <div key={trackName} className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="font-medium">{trackName}</span>
                    <span className="font-mono tabular-nums text-slate-500">{count}</span>
                  </div>
                  <div className="h-2 rounded bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-indigo-500"
                      style={{
                        width: `${Math.min(100, (count / Math.max(1, hackathons.length)) * 100)}%`
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Published Outcomes (PII-Free) */}
      {results.length > 0 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
          <h2 className="font-display text-base font-semibold flex items-center gap-2">
            <Trophy className="h-4 w-4 text-amber-500" />
            <span>
              {locale === 'ar' ? 'نتائج الفرق الفائزة المنشورة (دون بيانات شخصية)' : 'Published Competition Outcomes (PII-Free)'}
            </span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {results.map((res) => (
              <div
                key={res.hackathonId}
                className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-2 text-xs"
              >
                <div className="font-semibold text-slate-900 dark:text-white">
                  {hackathonTitleById.get(res.hackathonId) || res.hackathonId}
                </div>
                <div className="space-y-1">
                  {res.rankings.slice(0, 3).map((r) => (
                    <div key={r.submissionId} className="flex items-center justify-between gap-2">
                      <span>
                        <span className="font-mono font-bold text-amber-600 dark:text-amber-400">#{r.rank}</span>{' '}
                        {r.projectTitle} ({r.teamName})
                      </span>
                      <span className="font-mono tabular-nums">{r.averageScore.toFixed(1)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sponsorship Request Form & Approved Partnerships */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form
          onSubmit={(e) => void handleRequestSponsorship(e)}
          className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-3"
        >
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold">
              {editingSponsorId
                ? locale === 'ar'
                  ? 'تعديل طلب الرعاية المعلق'
                  : 'Edit Pending Sponsorship Request'
                : locale === 'ar'
                  ? 'طلب رعاية هاكاثون'
                  : 'Request Hackathon Sponsorship'}
            </h2>
            {editingSponsorId && (
              <button
                type="button"
                onClick={resetForm}
                className="text-xs text-slate-500 hover:underline"
              >
                {t.common.cancel}
              </button>
            )}
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {locale === 'ar'
              ? 'تبدأ الطلبات بحالة المراجعة المعلقة. منظم الهاكاثون فقط يمكنه الموافقة وتحديد فئة الرعاية الرسمية.'
              : 'Requests start in pending review. Only the hackathon organizer can approve partnerships and assign the official tier.'}
          </p>
          {errorMsg && <p className="text-xs text-red-500">{errorMsg}</p>}
          {feedback && <p className="text-xs text-emerald-500">{feedback}</p>}
          <select
            value={hackathonId}
            disabled={Boolean(editingSponsorId)}
            onChange={(e) => setHackathonId(e.target.value)}
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs disabled:opacity-60"
          >
            {hackathons.map((h) => (
              <option key={h.id} value={h.id}>
                {h.title}
              </option>
            ))}
          </select>
          <input
            type="text"
            required
            value={organizationName}
            onChange={(e) => setOrganizationName(e.target.value)}
            placeholder={locale === 'ar' ? 'اسم الجهة الراعية' : 'Sponsor Organization Name'}
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
          />
          <input
            type="url"
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
            placeholder="https://sponsor.example.com"
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
          />
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={
              locale === 'ar'
                ? 'الجائزة المقترحة، الفئة المطلوبة، أو تفاصيل التحدي...'
                : 'Proposed prize, requested tier, or API challenge notes...'
            }
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {editingSponsorId
              ? locale === 'ar'
                ? 'حفظ تعديل الطلب'
                : 'Update Pending Request'
              : locale === 'ar'
                ? 'إرسال طلب الرعاية'
                : 'Submit Sponsorship Request'}
          </button>
        </form>

        <div className="lg:col-span-7 space-y-4">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-3">
            <h2 className="font-display text-base font-semibold">
              {locale === 'ar'
                ? `شراكات الرعاية المعتمدة (${approvedPartnerships.length})`
                : `Approved Sponsorship Partnerships (${approvedPartnerships.length})`}
            </h2>
            {approvedPartnerships.length === 0 ? (
              <p className="text-xs text-slate-500">
                {locale === 'ar'
                  ? 'لا توجد شراكات رعاية معتمدة من المنظمين بعد.'
                  : 'No organizer-approved sponsorship partnerships yet.'}
              </p>
            ) : (
              <div className="space-y-2">
                {approvedPartnerships.map((sp) => (
                  <div
                    key={sp.id}
                    className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs flex justify-between"
                  >
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">{sp.organizationName}</div>
                      <div className="text-slate-500">
                        {hackathonTitleById.get(sp.hackathonId) || sp.hackathonId}
                        {sp.notes ? ` · ${sp.notes}` : ''}
                      </div>
                    </div>
                    <span className="font-mono uppercase text-emerald-600 dark:text-emerald-400">{sp.tier}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-3">
            <h2 className="font-display text-sm font-semibold">
              {locale === 'ar'
                ? `الطلبات المعلقة والمراجعة (${pendingOrRejectedRequests.length})`
                : `Pending & Reviewed Requests (${pendingOrRejectedRequests.length})`}
            </h2>
            {pendingOrRejectedRequests.length === 0 ? (
              <p className="text-xs text-slate-500">
                {locale === 'ar'
                  ? 'لا توجد طلبات رعاية معلقة أو مرفوضة.'
                  : 'No pending or declined sponsorship requests.'}
              </p>
            ) : (
              <div className="space-y-2">
                {pendingOrRejectedRequests.map((sp) => (
                  <div
                    key={sp.id}
                    className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-xs flex flex-wrap items-center justify-between gap-2"
                  >
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">{sp.organizationName}</div>
                      <div className="text-slate-500">
                        {hackathonTitleById.get(sp.hackathonId) || sp.hackathonId}
                        {sp.notes ? ` · ${sp.notes}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {sp.status === 'pending' && sp.sponsorUserId === user?.uid && (
                        <button
                          type="button"
                          onClick={() => startEditPending(sp)}
                          className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                        >
                          {t.common.edit}
                        </button>
                      )}
                      <span className="font-mono capitalize text-amber-600 dark:text-amber-400">
                        {sp.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
