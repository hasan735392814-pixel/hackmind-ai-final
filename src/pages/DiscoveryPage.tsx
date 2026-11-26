import { useEffect, useState } from 'react';
import { Bookmark, Search, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import {
  approveOwnPendingRegistration,
  createNotification,
  deleteRegistration,
  listPublishedHackathons,
  listUserRegistrations,
  reapplyForHackathon,
  registerForHackathon,
  withdrawParticipantRegistration
} from '../services/firebase/firestoreService';
import type { Hackathon, HackathonMode, HackathonRegistration } from '../types/domain';
import {
  classifyDiscoveryViewState,
  filterPublishedHackathons
} from '../utils/discoveryUtils';
import { isDeadlinePassed } from '../utils/validation';
import {
  formatActionableError,
  indexRegistrationsByHackathon
} from '../utils/registrationResolution';

const BOOKMARK_KEY = 'hackmind_bookmarked_hackathons';

export function DiscoveryPage() {
  const { user, profile, emailVerified } = useAuth();
  const { locale, t } = useLanguage();
  const [hackathons, setHackathons] = useState<Hackathon[]>([]);
  const [registrations, setRegistrations] = useState<HackathonRegistration[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [modeFilter, setModeFilter] = useState<'all' | HackathonMode>('all');
  const [trackFilter, setTrackFilter] = useState('all');
  const [techFilter, setTechFilter] = useState('all');
  const [selected, setSelected] = useState<Hackathon | null>(null);
  const [preferredTrack, setPreferredTrack] = useState('');
  const [motivation, setMotivation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmWithdrawRegId, setConfirmWithdrawRegId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const [bookmarks, setBookmarks] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(BOOKMARK_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });

  const refreshData = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [pubResult, regResult] = await Promise.allSettled([
        listPublishedHackathons(),
        user ? listUserRegistrations(user.uid) : Promise.resolve([])
      ]);
      if (pubResult.status === 'fulfilled') {
        setHackathons(pubResult.value);
      } else {
        setHackathons([]);
        const reason = pubResult.reason;
        setLoadError(
          reason instanceof Error ? reason.message : 'Failed to load published hackathons from Firestore.'
        );
      }
      if (regResult.status === 'fulfilled') {
        setRegistrations(regResult.value);
      } else {
        setRegistrations([]);
        setErrorMsg(
          formatActionableError(
            regResult.reason,
            'Failed to load your hackathon registrations from Firestore.'
          )
        );
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshData();
  }, [user, emailVerified]);

  const toggleBookmark = (id: string) => {
    setBookmarks((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try {
        localStorage.setItem(BOOKMARK_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage error
      }
      return next;
    });
  };

  const allTechnologies = Array.from(
    new Set(hackathons.flatMap((h) => h.technologies || []))
  ).slice(0, 20);

  const allTracks = Array.from(
    new Set(hackathons.flatMap((h) => h.tracks || []))
  ).slice(0, 20);

  const filtered = filterPublishedHackathons(hackathons, {
    searchQuery,
    modeFilter,
    techFilter,
    trackFilter
  });

  const viewState = classifyDiscoveryViewState({
    loading,
    loadError,
    totalPublished: hackathons.length,
    filteredCount: filtered.length
  });

  const clearFilters = () => {
    setSearchQuery('');
    setModeFilter('all');
    setTrackFilter('all');
    setTechFilter('all');
  };

  const regByHackathon = indexRegistrationsByHackathon(registrations, user?.uid);

  const formatMode = (m: HackathonMode) => {
    if (m === 'online') return t.common.online;
    if (m === 'in_person') return t.common.inPerson;
    return t.common.hybrid;
  };

  const formatStatus = (s: Hackathon['status']) => {
    if (s === 'draft') return t.common.draft;
    if (s === 'published') return t.common.published;
    if (s === 'judging') return t.common.judging;
    return t.common.completed;
  };

  const formatRegStatus = (s: HackathonRegistration['status']) => {
    if (locale === 'ar') {
      if (s === 'approved') return 'مقبول';
      if (s === 'rejected') return 'مرفوض';
      if (s === 'withdrawn') return 'منسحب';
      return 'قيد المراجعة';
    }
    return s;
  };

  const handleRegister = async (hackathon: Hackathon) => {
    if (!user) return;
    setErrorMsg('');
    setFeedback('');
    if (!emailVerified) {
      setErrorMsg(
        locale === 'ar'
          ? 'يرجى تأكيد بريدك الإلكتروني قبل التسجيل في الهاكاثون.'
          : 'Please verify your email address before registering.'
      );
      return;
    }
    if (isDeadlinePassed(hackathon.registrationDeadline)) {
      setErrorMsg(
        locale === 'ar'
          ? 'انتهى الموعد النهائي للتسجيل في هذا الهاكاثون.'
          : 'The registration deadline for this hackathon has passed.'
      );
      return;
    }

    const existing = regByHackathon.get(hackathon.id);
    setSubmitting(true);
    try {
      if (existing && existing.status === 'withdrawn') {
        await reapplyForHackathon(existing.id, {
          preferredTrack: preferredTrack || hackathon.tracks?.[0] || 'General',
          motivation
        });
      } else {
        await registerForHackathon({
          hackathonId: hackathon.id,
          organizerId: hackathon.organizerId,
          userId: user.uid,
          userName:
            profile?.displayName?.trim() ||
            user.displayName?.trim() ||
            user.email?.trim() ||
            'Participant',
          userTitle: profile?.title || '',
          preferredTrack: preferredTrack || hackathon.tracks?.[0] || 'General',
          motivation
        });
      }

      await createNotification({
        userId: user.uid,
        type: 'registration',
        title: `Registration Approved: ${hackathon.title}`,
        message: `Your registration for ${hackathon.title} is approved and active. You can now create or join a team.`,
        link: '/app/builder'
      }).catch(() => {});

      const updatedRegs = await listUserRegistrations(user.uid);
      setRegistrations(updatedRegs);
      setFeedback(
        locale === 'ar'
          ? 'تم تأكيد تسجيلك والموافقة عليه تلقائياً! يمكنك الآن إنشاء فريق أو الانضمام إلى فريق.'
          : 'Registration confirmed and approved! You can now create or join a team.'
      );
      setMotivation('');
    } catch (err) {
      setErrorMsg(formatActionableError(err, 'Registration failed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmPendingReg = async (
    reg: HackathonRegistration,
    hackathon: Hackathon
  ) => {
    if (!user) return;
    setErrorMsg('');
    setFeedback('');
    if (!emailVerified) {
      setErrorMsg(
        locale === 'ar'
          ? 'يرجى تأكيد بريدك الإلكتروني قبل تأكيد التسجيل.'
          : 'Please verify your email address before confirming your registration.'
      );
      return;
    }
    if (isDeadlinePassed(hackathon.registrationDeadline)) {
      setErrorMsg(
        locale === 'ar'
          ? 'انتهى الموعد النهائي للتسجيل في هذا الهاكاثون.'
          : 'The registration deadline for this hackathon has passed.'
      );
      return;
    }
    setSubmitting(true);
    try {
      await approveOwnPendingRegistration(reg.id, {
        preferredTrack: reg.preferredTrack,
        motivation: reg.motivation
      });
      const updatedRegs = await listUserRegistrations(user.uid);
      setRegistrations(updatedRegs);
      setFeedback(
        locale === 'ar'
          ? 'تم تفعيل تسجيلك والموافقة عليه! يمكنك الآن إنشاء فريق أو الانضمام إلى فريق.'
          : 'Your registration is now approved! Visit Builder Workspace to create or join a team.'
      );
    } catch (err) {
      setErrorMsg(formatActionableError(err, 'Failed to confirm registration'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleWithdraw = async (reg: HackathonRegistration) => {
    if (!user || !emailVerified) return;
    if (confirmWithdrawRegId !== reg.id) {
      setConfirmWithdrawRegId(reg.id);
      return;
    }
    setSubmitting(true);
    setErrorMsg('');
    setFeedback('');
    try {
      await withdrawParticipantRegistration({
        registration: reg,
        actorId: user.uid,
        actorName: profile?.displayName || user.displayName || 'Participant',
        confirmed: true
      });
      setConfirmWithdrawRegId(null);
      const updatedRegs = await listUserRegistrations(user.uid);
      setRegistrations(updatedRegs);
      setFeedback(
        locale === 'ar'
          ? 'تم سحب التسجيل بنجاح. يمكنك إعادة التقديم قبل انتهاء الموعد.'
          : 'Registration withdrawn. You can re-apply before the deadline.'
      );
    } catch (err) {
      setConfirmWithdrawRegId(null);
      setErrorMsg(formatActionableError(err, 'Failed to withdraw registration'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteReg = async (reg: HackathonRegistration) => {
    if (!user || !emailVerified) return;
    setSubmitting(true);
    setErrorMsg('');
    setFeedback('');
    try {
      await deleteRegistration(reg.id);
      const updatedRegs = await listUserRegistrations(user.uid);
      setRegistrations(updatedRegs);
      setFeedback(locale === 'ar' ? 'تم حذف سجل التسجيل.' : 'Registration record deleted.');
    } catch (err) {
      setErrorMsg(formatActionableError(err, 'Failed to delete registration'));
    } finally {
      setSubmitting(false);
    }
  };

  const selectedReg = selected ? regByHackathon.get(selected.id) : undefined;
  const canShowRegistrationForm = !selectedReg || selectedReg.status === 'withdrawn';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
          {t.sidebar.discover}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {locale === 'ar'
            ? 'استعرض فقط الهاكاثونات المنشورة فعلياً في Firestore وسجل للمشاركة.'
            : 'Live directory of published hackathons stored in Cloud Firestore.'}
        </p>
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="h-4 w-4 text-slate-400 absolute top-2.5 start-3" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={
              locale === 'ar'
                ? 'ابحث بالاسم أو المسار أو التقنية...'
                : 'Search by title, track, or technology...'
            }
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] ps-9 pe-3 py-2 text-sm"
          />
        </div>

        <select
          value={modeFilter}
          onChange={(e) => setModeFilter(e.target.value as 'all' | HackathonMode)}
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
        >
          <option value="all">{t.common.all}</option>
          <option value="online">{t.common.online}</option>
          <option value="in_person">{t.common.inPerson}</option>
          <option value="hybrid">{t.common.hybrid}</option>
        </select>

        <select
          value={trackFilter}
          onChange={(e) => setTrackFilter(e.target.value)}
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
        >
          <option value="all">{locale === 'ar' ? 'كل المسارات / الفئات' : 'All Tracks / Categories'}</option>
          {allTracks.map((tr) => (
            <option key={tr} value={tr}>
              {tr}
            </option>
          ))}
        </select>

        <select
          value={techFilter}
          onChange={(e) => setTechFilter(e.target.value)}
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
        >
          <option value="all">{locale === 'ar' ? 'كل التقنيات' : 'All Technologies'}</option>
          {allTechnologies.map((tech) => (
            <option key={tech} value={tech}>
              {tech}
            </option>
          ))}
        </select>
      </div>

      {viewState === 'loading' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-56 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] animate-pulse"
            />
          ))}
        </div>
      ) : viewState === 'permission_denied' ||
        viewState === 'network_failure' ||
        viewState === 'invalid_data' ? (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-6 space-y-3">
          <div className="text-sm font-semibold text-red-700 dark:text-red-300">
            {viewState === 'permission_denied'
              ? locale === 'ar'
                ? 'صلاحيات Firestore مرفوضة عند قراءة الهاكاثونات المنشورة.'
                : 'Firestore permission denied while reading published hackathons.'
              : viewState === 'network_failure'
                ? locale === 'ar'
                  ? 'تعذر الاتصال بقاعدة بيانات Firestore بسبب مشكلة في الشبكة.'
                  : 'Network failure while contacting Cloud Firestore.'
                : locale === 'ar'
                  ? 'تعذر قراءة بيانات الهاكاثونات أو هناك نقص في التهيئة.'
                  : 'Invalid data or incomplete Firebase configuration prevented loading hackathons.'}
          </div>
          <p className="text-xs font-mono break-all text-red-700/90 dark:text-red-300/90">
            {loadError}
          </p>
          <button
            type="button"
            onClick={() => void refreshData()}
            className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700"
          >
            {locale === 'ar' ? 'إعادة المحاولة' : 'Retry'}
          </button>
        </div>
      ) : viewState === 'no_published_hackathons' ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-10 text-center space-y-3">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
            {locale === 'ar'
              ? 'لا توجد هاكاثونات منشورة في قاعدة بيانات Firestore (default) حالياً.'
              : 'No published hackathons exist in Firestore (default) yet.'}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xl mx-auto">
            {locale === 'ar'
              ? 'تبقى الهاكاثونات التي لم يتم نشرها بعد (حالة المسودة) خاصة بالمنظمين والمسؤولين حتى يتم نشرها من استوديو المنظمين.'
              : 'Draft hackathons remain private to their organizer and administrators until published from Organizer Studio.'}
          </p>
          <div>
            <button
              type="button"
              onClick={() => void refreshData()}
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {locale === 'ar' ? 'تحديث القائمة' : 'Refresh'}
            </button>
          </div>
        </div>
      ) : viewState === 'filtered_out' ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-10 text-center space-y-3">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
            {locale === 'ar'
              ? 'لا توجد هاكاثونات منشورة تطابق معايير البحث أو التصفية الحالية.'
              : 'No published hackathons match your current search or filter criteria.'}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {locale === 'ar'
              ? `يوجد ${hackathons.length} هاكاثون منشور، ولكن التصفية الحالية تستبعدها.`
              : `${hackathons.length} published hackathon(s) exist, but none match your active filters.`}
          </p>
          <div>
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
            >
              {locale === 'ar' ? 'إعادة تعيين الفلاتر' : 'Reset filters'}
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filtered.map((h) => {
            const existingReg = regByHackathon.get(h.id);
            const isSaved = bookmarks.includes(h.id);
            const closed = isDeadlinePassed(h.registrationDeadline);
            return (
              <div
                key={h.id}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 flex flex-col justify-between space-y-4"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span className="truncate">
                      {formatMode(h.mode)} · {formatStatus(h.status)}
                      {h.submissionDeadline
                        ? ` · ${locale === 'ar' ? 'التسليم' : 'Due'} ${h.submissionDeadline}`
                        : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleBookmark(h.id)}
                      aria-label={locale === 'ar' ? 'حفظ الهاكاثون' : 'Bookmark hackathon'}
                      className={`p-1 rounded ${isSaved ? 'text-blue-500' : 'text-slate-400 hover:text-slate-700 dark:hover:text-white'}`}
                    >
                      <Bookmark className="h-4 w-4" fill={isSaved ? 'currentColor' : 'none'} />
                    </button>
                  </div>

                  <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                    {h.title}
                  </h3>
                  <p className="text-sm text-slate-600 dark:text-slate-400 line-clamp-3">
                    {h.tagline || h.description}
                  </p>

                  {h.tracks && h.tracks.length > 0 && (
                    <div className="text-xs text-slate-500 dark:text-slate-400 pt-1">
                      {h.tracks.slice(0, 3).join(' · ')}
                    </div>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-500 dark:text-slate-400 truncate">
                    {existingReg
                      ? locale === 'ar'
                        ? `الحالة: ${formatRegStatus(existingReg.status)}`
                        : `Registered (${existingReg.status})`
                      : closed
                        ? locale === 'ar'
                          ? 'التسجيل مغلق'
                          : 'Registration Closed'
                        : locale === 'ar'
                          ? `الحد الأقصى للفريق: ${h.maxTeamSize}`
                          : `Max team: ${h.maxTeamSize}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(h);
                      setPreferredTrack(existingReg?.preferredTrack || h.tracks?.[0] || '');
                      setMotivation(existingReg?.motivation || '');
                      setConfirmWithdrawRegId(null);
                      setFeedback('');
                      setErrorMsg('');
                    }}
                    className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 whitespace-nowrap"
                  >
                    {locale === 'ar' ? 'عرض التفاصيل' : 'Details'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Details & Registration Modal */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 overflow-y-auto">
          <div className="max-w-2xl w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-5 my-8 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {selected.organizerName} · {formatMode(selected.mode)} ·{' '}
                  {selected.location || t.common.online}
                </p>
                <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white mt-1">
                  {selected.title}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => {
                  setConfirmWithdrawRegId(null);
                  setSelected(null);
                }}
                aria-label={t.common.close}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-900 dark:hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300 whitespace-pre-line">
              {selected.description}
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
                <div className="text-slate-500">{locale === 'ar' ? 'البداية' : 'Start'}</div>
                <div className="font-mono mt-1 tabular-nums">{selected.startDate || 'TBD'}</div>
              </div>
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
                <div className="text-slate-500">{locale === 'ar' ? 'النهاية' : 'End'}</div>
                <div className="font-mono mt-1 tabular-nums">{selected.endDate || 'TBD'}</div>
              </div>
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
                <div className="text-slate-500">
                  {locale === 'ar' ? 'إغلاق التسجيل' : 'Reg Deadline'}
                </div>
                <div className="font-mono mt-1 tabular-nums">
                  {selected.registrationDeadline || (locale === 'ar' ? 'مفتوح' : 'Open')}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
                <div className="text-slate-500">
                  {locale === 'ar' ? 'موعد التسليم' : 'Submission Due'}
                </div>
                <div className="font-mono mt-1 tabular-nums">
                  {selected.submissionDeadline || (locale === 'ar' ? 'مفتوح' : 'Open')}
                </div>
              </div>
            </div>

            {(selected.prizes?.length > 0 || selected.eligibility || selected.rules) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                {selected.prizes?.length > 0 && (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-1">
                    <div className="font-semibold text-slate-700 dark:text-slate-300">
                      {locale === 'ar' ? 'الجوائز' : 'Prizes'}
                    </div>
                    <p className="text-slate-600 dark:text-slate-400">
                      {selected.prizes.join(' · ')}
                    </p>
                  </div>
                )}
                {selected.eligibility && (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-1">
                    <div className="font-semibold text-slate-700 dark:text-slate-300">
                      {locale === 'ar' ? 'شروط الأهلية' : 'Eligibility'}
                    </div>
                    <p className="text-slate-600 dark:text-slate-400">{selected.eligibility}</p>
                  </div>
                )}
                {selected.rules && (
                  <div className="sm:col-span-2 rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-1">
                    <div className="font-semibold text-slate-700 dark:text-slate-300">
                      {locale === 'ar' ? 'القواعد' : 'Competition Rules'}
                    </div>
                    <p className="text-slate-600 dark:text-slate-400 whitespace-pre-line">
                      {selected.rules}
                    </p>
                  </div>
                )}
              </div>
            )}

            {selected.rubric && selected.rubric.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {locale === 'ar' ? 'معايير التحكيم' : 'Judging Rubric'}
                </h3>
                <div className="divide-y divide-slate-200 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800">
                  {selected.rubric.map((r) => (
                    <div key={r.id} className="p-3 flex items-center justify-between gap-3 text-xs">
                      <div>
                        <div className="font-semibold text-slate-900 dark:text-white">{r.name}</div>
                        <div className="text-slate-500 dark:text-slate-400">{r.description}</div>
                      </div>
                      <span className="font-mono font-semibold tabular-nums text-blue-600 dark:text-blue-400">
                        {r.weight}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {errorMsg && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
                {errorMsg}
              </div>
            )}
            {feedback && (
              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-300">
                {feedback}
              </div>
            )}

            {selectedReg && (
              <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 text-xs font-medium text-blue-700 dark:text-blue-300 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    {selectedReg.status === 'approved'
                      ? locale === 'ar'
                        ? 'تمت الموافقة على تسجيلك! انتقل إلى مساحة المشاركين لتكوين فريق أو الانضمام لفريق.'
                        : 'Your registration is approved! Visit Builder Workspace to create or join a team.'
                      : selectedReg.status === 'rejected'
                        ? locale === 'ar'
                          ? 'تم رفض طلب التسجيل الخاص بك لهذا الهاكاثون.'
                          : 'Your registration for this hackathon was declined by the organizer.'
                        : selectedReg.status === 'withdrawn'
                          ? locale === 'ar'
                            ? 'لقد قمت بسحب تسجيلك. يمكنك إعادة التقديم قبل الموعد النهائي أو حذف السجل.'
                            : 'You withdrew this registration. You may re-apply below before the deadline or delete the record.'
                          : locale === 'ar'
                            ? 'تسجيلك قيد الانتظار حالياً. يمكنك تأكيده وتفعيله فوراً لإنشاء أو الانضمام إلى فريق.'
                            : 'Your registration is still pending. Confirm below to activate it immediately for team creation and joining.'}
                  </span>
                  <div className="flex items-center gap-2">
                    {selectedReg.status === 'pending' &&
                      emailVerified &&
                      !isDeadlinePassed(selected.registrationDeadline) && (
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={() => void handleConfirmPendingReg(selectedReg, selected)}
                          className="rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {locale === 'ar' ? 'تأكيد وتفعيل' : 'Confirm & Activate'}
                        </button>
                      )}
                    {(selectedReg.status === 'pending' || selectedReg.status === 'approved') &&
                      confirmWithdrawRegId !== selectedReg.id && (
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={() => setConfirmWithdrawRegId(selectedReg.id)}
                          className="rounded border border-amber-500/50 px-2.5 py-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-500/10"
                        >
                          {locale === 'ar' ? 'سحب التسجيل' : 'Withdraw'}
                        </button>
                      )}
                    {(selectedReg.status === 'pending' || selectedReg.status === 'withdrawn') && (
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => void handleDeleteReg(selectedReg)}
                        className="rounded border border-red-500/50 px-2.5 py-1 text-[11px] font-semibold text-red-600 dark:text-red-300 hover:bg-red-500/10"
                      >
                        {t.common.delete}
                      </button>
                    )}
                  </div>
                </div>
                {confirmWithdrawRegId === selectedReg.id && (
                  <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-2.5 text-[11px] text-amber-900 dark:text-amber-200 flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {selectedReg.status === 'approved'
                        ? locale === 'ar'
                          ? 'تأكيد سحب التسجيل المقبول؟ ستفقد أهلية إنشاء أو الانضمام إلى فريق حتى إعادة التقديم قبل انتهاء الموعد.'
                          : 'Confirm withdrawing this approved registration? You will lose team creation/joining eligibility until you re-apply before the deadline.'
                        : locale === 'ar'
                          ? 'تأكيد سحب طلب التسجيل قيد المراجعة؟'
                          : 'Confirm withdrawing your pending registration?'}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => void handleWithdraw(selectedReg)}
                        className="rounded bg-amber-600 px-2.5 py-1 font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                      >
                        {locale === 'ar' ? 'تأكيد السحب' : 'Confirm Withdraw'}
                      </button>
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => setConfirmWithdrawRegId(null)}
                        className="rounded border border-slate-300 dark:border-slate-700 px-2.5 py-1 font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        {t.common.cancel}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {canShowRegistrationForm && (
              <div className="space-y-3 border-t border-slate-200 dark:border-slate-800 pt-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1">
                      {locale === 'ar' ? 'المسار المفضل' : 'Preferred Track'}
                    </label>
                    {selected.tracks && selected.tracks.length > 0 ? (
                      <select
                        value={preferredTrack}
                        onChange={(e) => setPreferredTrack(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
                      >
                        {selected.tracks.map((tr) => (
                          <option key={tr} value={tr}>
                            {tr}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={preferredTrack}
                        onChange={(e) => setPreferredTrack(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
                      />
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">
                      {locale === 'ar' ? 'ملاحظة أو فكرة أولية' : 'Project Goal / Motivation'}
                    </label>
                    <input
                      type="text"
                      maxLength={500}
                      value={motivation}
                      onChange={(e) => setMotivation(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold"
                  >
                    {t.common.close}
                  </button>
                  <button
                    type="button"
                    disabled={submitting || isDeadlinePassed(selected.registrationDeadline)}
                    onClick={() => void handleRegister(selected)}
                    className="rounded-lg bg-blue-600 px-5 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {submitting
                      ? t.common.loading
                      : selectedReg?.status === 'withdrawn'
                        ? locale === 'ar'
                          ? 'إعادة التقديم'
                          : 'Re-apply Now'
                        : locale === 'ar'
                          ? 'تأكيد التسجيل'
                          : 'Register Now'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
