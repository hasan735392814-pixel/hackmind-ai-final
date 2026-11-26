import { useEffect, useState } from 'react';
import { InferenceMode } from 'firebase/ai';
import { Sparkles, UserPlus, XCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import {
  cancelTeamInvitation,
  listMyInvitations,
  listPublishedHackathons,
  listTeamMatchingCandidates,
  listUserTeams,
  resolveApprovedRegistrationForHackathon,
  respondToTeamInvitation,
  sendTeamInvitation
} from '../services/firebase/firestoreService';
import { executeHybridInference } from '../services/hybridAI/inferenceManager';
import { buildTaskPrompt } from '../services/hybridAI/promptRegistry';
import type { HybridExecutionResult } from '../services/hybridAI/types';
import {
  computeFairTeammateMatches,
  type TeammateMatchRecommendation
} from '../services/matching/teamMatching';
import type { Hackathon, Team, TeamInvitation } from '../types/domain';
import { InferenceResultBanner } from '../components/common/InferenceBadge';
import { InferenceModeSelector } from '../components/common/InferenceModeSelector';
import { formatActionableError } from '../utils/registrationResolution';

interface AIMatchAnalysis {
  compatibilityScore?: number;
  summary?: string;
  reasons?: string[];
  complementaryGaps?: string[];
}

export function TeamsMatchingPage() {
  const { user, profile, privateInfo, emailVerified, updateCloudConsent } = useAuth();
  const { locale, t } = useLanguage();

  const [hackathons, setHackathons] = useState<Hackathon[]>([]);
  const [myTeams, setMyTeams] = useState<Team[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [matches, setMatches] = useState<TeammateMatchRecommendation[]>([]);
  const [invitations, setInvitations] = useState<TeamInvitation[]>([]);
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);
  const [aiMode, setAiMode] = useState<InferenceMode>(InferenceMode.PREFER_ON_DEVICE);
  const [aiResult, setAiResult] = useState<HybridExecutionResult<AIMatchAnalysis> | null>(null);
  const [aiForUid, setAiForUid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const loadData = async () => {
    if (!user || !profile) return;
    const [hacksRes, tmsRes, candidatesRes, invsRes] = await Promise.allSettled([
      listPublishedHackathons(),
      listUserTeams(user.uid),
      listTeamMatchingCandidates(),
      listMyInvitations(user.uid)
    ]);

    const errors: string[] = [];
    const hacks = hacksRes.status === 'fulfilled' ? hacksRes.value : (errors.push(formatActionableError(hacksRes.reason, 'Failed to load hackathons')), []);
    const tms = tmsRes.status === 'fulfilled' ? tmsRes.value : (errors.push(formatActionableError(tmsRes.reason, 'Failed to load teams')), []);
    const candidates = candidatesRes.status === 'fulfilled' ? candidatesRes.value : (errors.push(formatActionableError(candidatesRes.reason, 'Failed to load teammates')), []);
    const invs = invsRes.status === 'fulfilled' ? invsRes.value : (errors.push(formatActionableError(invsRes.reason, 'Failed to load invitations')), []);

    if (errors.length > 0) {
      setErrorMsg(errors[0]);
    }

    setHackathons(hacks);
    setMyTeams(tms);
    const activeTeam = tms.find((x) => x.id === selectedTeamId) || tms[0] || null;
    if (activeTeam && !selectedTeamId) setSelectedTeamId(activeTeam.id);
    setMatches(computeFairTeammateMatches(profile, candidates, activeTeam));
    setInvitations(invs);
  };

  useEffect(() => {
    void loadData();
  }, [user, profile, selectedTeamId, emailVerified]);

  const selectedTeam = myTeams.find((tm) => tm.id === selectedTeamId) || myTeams[0] || null;
  const selectedTeamHackathon = selectedTeam
    ? hackathons.find((h) => h.id === selectedTeam.hackathonId)
    : undefined;
  const isSelectedTeamFull = Boolean(
    selectedTeam &&
      selectedTeamHackathon &&
      selectedTeam.memberIds.length >= selectedTeamHackathon.maxTeamSize
  );
  const isSelectedTeamClosed = Boolean(selectedTeam && selectedTeam.status !== 'forming');

  const handleAnalyzeWithAI = async (match: TeammateMatchRecommendation) => {
    if (!profile) return;
    setBusy(true);
    setAiForUid(match.candidate.uid);
    setErrorMsg('');
    try {
      const prompt = buildTaskPrompt(
        'team_matching',
        {
          requester: {
            skills: profile.skills,
            roles: profile.preferredRoles,
            experience: profile.experienceLevel,
            interests: profile.interests,
            availability: profile.availability
          },
          candidate: {
            skills: match.candidate.skills,
            roles: match.candidate.preferredRoles,
            experience: match.candidate.experienceLevel,
            interests: match.candidate.interests,
            availability: match.candidate.availability
          },
          teamNeeds: selectedTeam?.lookingForRoles || []
        },
        locale
      );
      const res = await executeHybridInference<AIMatchAnalysis>({
        taskKey: 'team_matching',
        prompt,
        preferredMode: aiMode,
        locale,
        cloudConsentGranted: Boolean(privateInfo?.aiCloudConsent),
        userId: user?.uid,
        emailVerified
      });
      setAiResult(res);
    } finally {
      setBusy(false);
    }
  };

  const handleInvite = async (match: TeammateMatchRecommendation) => {
    if (!user || !emailVerified) {
      setErrorMsg(
        locale === 'ar'
          ? 'يرجى تأكيد بريدك الإلكتروني قبل إرسال دعوات الفريق.'
          : 'Verify your email address before sending team invitations.'
      );
      return;
    }
    if (!selectedTeam) {
      setErrorMsg(
        locale === 'ar'
          ? 'أنشئ فريقاً في مساحة المشاركين أولاً قبل إرسال الدعوات.'
          : 'Create a team in Builder Workspace first before sending invitations.'
      );
      return;
    }
    if (isSelectedTeamClosed) {
      setErrorMsg(
        locale === 'ar'
          ? 'تشكيلة هذا الفريق مقفلة أو مسلّمة ولا تقبل دعوات جديدة.'
          : 'This team is locked or submitted and cannot send new invitations.'
      );
      return;
    }
    if (isSelectedTeamFull) {
      setErrorMsg(
        locale === 'ar'
          ? `وصل الفريق إلى الحد الأقصى للأعضاء (${selectedTeamHackathon?.maxTeamSize}).`
          : `Team is already at max size (${selectedTeamHackathon?.maxTeamSize} members).`
      );
      return;
    }
    setBusy(true);
    setErrorMsg('');
    try {
      await sendTeamInvitation({
        teamId: selectedTeam.id,
        teamName: selectedTeam.name,
        hackathonId: selectedTeam.hackathonId,
        fromUserId: user.uid,
        fromUserName: profile?.displayName || 'Team Lead',
        toUserId: match.candidate.uid,
        toUserName: match.candidate.displayName,
        roleOffered: match.candidate.preferredRoles?.[0] || 'Builder',
        message: `Join team ${selectedTeam.name}! ${match.reasons[0] || ''}`
      });
      await loadData();
      setFeedback(
        locale === 'ar'
          ? `تم إرسال الدعوة إلى ${match.candidate.displayName}.`
          : `Invitation sent to ${match.candidate.displayName}.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to send invitation');
    } finally {
      setBusy(false);
    }
  };

  const handleRespondInvitation = async (inv: TeamInvitation, accept: boolean) => {
    if (!user) return;
    setBusy(true);
    setErrorMsg('');
    try {
      if (accept) {
        const verification = await resolveApprovedRegistrationForHackathon(
          user.uid,
          inv.hackathonId
        );
        if (!verification.approved && verification.status !== 'pending') {
          setErrorMsg(
            locale === 'ar'
              ? verification.status === 'rejected'
                ? 'تم رفض تسجيلك في هذا الهاكاثون من قِبل المنظم.'
                : verification.status === 'withdrawn'
                  ? 'تم سحب تسجيلك في هذا الهاكاثون. أعد التقديم قبل قبول الدعوة.'
                  : 'سجّل في هذا الهاكاثون أولاً قبل قبول الدعوة.'
              : verification.reason
          );
          setBusy(false);
          return;
        }
      }
      await respondToTeamInvitation(
        inv,
        accept,
        profile?.displayName || user.displayName || 'Builder'
      );
      await loadData();
      setFeedback(
        accept
          ? locale === 'ar'
            ? `تم الانضمام إلى فريق ${inv.teamName}.`
            : `Joined ${inv.teamName}.`
          : locale === 'ar'
            ? 'تم رفض الدعوة.'
            : 'Invitation declined.'
      );
    } catch (err) {
      setErrorMsg(formatActionableError(err, 'Failed to respond to invitation'));
    } finally {
      setBusy(false);
    }
  };

  const handleCancelInvitation = async (inv: TeamInvitation) => {
    if (!user || !emailVerified || inv.fromUserId !== user.uid || inv.status !== 'pending') return;
    setBusy(true);
    setErrorMsg('');
    try {
      await cancelTeamInvitation(inv.id);
      await loadData();
      setFeedback(locale === 'ar' ? 'تم إلغاء الدعوة.' : 'Invitation cancelled.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to cancel invitation');
    } finally {
      setBusy(false);
    }
  };

  const visibleMatches = matches.filter((m) => !dismissedIds.includes(m.candidate.uid));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
          {t.sidebar.teams}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {locale === 'ar'
            ? 'مطابقة عادلة تعتمد فقط على المهارات والأدوار والخبرة والتفرغ دون أي تعيين تلقائي.'
            : 'Fair skill, role, availability, and interest matching. You control every invitation and acceptance.'}
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4">
        <InferenceModeSelector
          mode={aiMode}
          onChange={setAiMode}
          cloudConsent={Boolean(privateInfo?.aiCloudConsent)}
          onGrantConsent={() => updateCloudConsent(true)}
        />
      </div>

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

      {/* Invitations */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-3">
        <h2 className="font-display text-base font-semibold">
          {locale === 'ar' ? 'دعوات الفرق' : 'Team Invitations'} ({invitations.length})
        </h2>
        {invitations.length === 0 ? (
          <p className="text-xs text-slate-500">
            {locale === 'ar'
              ? 'لا توجد دعوات معلقة أو سابقة.'
              : 'No pending or historical team invitations.'}
          </p>
        ) : (
          <div className="space-y-2">
            {invitations.map((inv) => {
              const isIncoming = inv.toUserId === user?.uid;
              return (
                <div
                  key={inv.id}
                  className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 flex flex-wrap items-center justify-between gap-3 text-xs"
                >
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-white">
                      {inv.teamName} · {inv.roleOffered}
                    </div>
                    <div className="text-slate-500">
                      {isIncoming
                        ? locale === 'ar'
                          ? `من ${inv.fromUserName}`
                          : `From ${inv.fromUserName}`
                        : locale === 'ar'
                          ? `إلى ${inv.toUserName}`
                          : `To ${inv.toUserName}`}{' '}
                      · {locale === 'ar' ? 'الحالة:' : 'Status:'} {inv.status}
                    </div>
                  </div>
                  {isIncoming && inv.status === 'pending' && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleRespondInvitation(inv, true)}
                        className="rounded-md bg-blue-600 px-3 py-1.5 font-semibold text-white"
                      >
                        {t.common.accept}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleRespondInvitation(inv, false)}
                        className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5"
                      >
                        {t.common.decline}
                      </button>
                    </div>
                  )}
                  {!isIncoming && inv.status === 'pending' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleCancelInvitation(inv)}
                      className="inline-flex items-center gap-1 rounded-md border border-red-400/50 px-3 py-1.5 text-red-600 dark:text-red-400"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      <span>{t.common.cancel}</span>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Matching Recommendations */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-base font-semibold">
            {locale === 'ar' ? 'زملاء الفريق المتوافقون' : 'Compatible Teammates'} (
            {visibleMatches.length})
          </h2>
          {myTeams.length > 0 && (
            <select
              value={selectedTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-1.5 text-xs"
            >
              {myTeams.map((tm) => (
                <option key={tm.id} value={tm.id}>
                  {locale === 'ar' ? 'دعوة إلى:' : 'Invite for:'} {tm.name} ({tm.memberIds.length}
                  {selectedTeamHackathon && tm.id === selectedTeam?.id
                    ? `/${selectedTeamHackathon.maxTeamSize}`
                    : ''}
                  )
                </option>
              ))}
            </select>
          )}
        </div>

        {visibleMatches.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 text-xs text-slate-500">
            {locale === 'ar'
              ? 'لا يوجد مرشحون مطابقون حالياً. حدّث مهاراتك وتفضيل الفريق في ملفك الشخصي.'
              : 'No matching candidates available right now. Update your Profile skills & team preference to appear in matching.'}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {visibleMatches.map((m) => {
              const alreadyInvited = Boolean(
                selectedTeam &&
                  invitations.some(
                    (inv) =>
                      inv.teamId === selectedTeam.id &&
                      inv.toUserId === m.candidate.uid &&
                      inv.status === 'pending'
                  )
              );
              return (
                <div
                  key={m.candidate.uid}
                  className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {m.candidate.displayName}
                      </div>
                      <div className="text-xs text-slate-500">
                        {m.candidate.title || m.candidate.experienceLevel} ·{' '}
                        {m.candidate.availability.replace('_', ' ')}
                      </div>
                    </div>
                    <span className="font-mono text-sm font-bold text-blue-600 dark:text-blue-400 tabular-nums">
                      {m.score}% {locale === 'ar' ? 'توافق' : 'match'}
                    </span>
                  </div>

                  {m.candidate.skills?.length > 0 && (
                    <div className="text-xs text-slate-600 dark:text-slate-300">
                      {locale === 'ar' ? 'المهارات:' : 'Skills:'} {m.candidate.skills.join(' · ')}
                    </div>
                  )}

                  <ul className="text-xs text-slate-500 dark:text-slate-400 space-y-1 list-disc ps-4">
                    {m.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>

                  {aiForUid === m.candidate.uid && aiResult && (
                    <div className="space-y-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                      <InferenceResultBanner result={aiResult} />
                      {aiResult.ok && aiResult.data && (
                        <div className="text-xs text-slate-600 dark:text-slate-300 space-y-1">
                          <p className="font-medium">{aiResult.data.summary}</p>
                          {aiResult.data.complementaryGaps?.length ? (
                            <p className="text-slate-500">
                              {locale === 'ar' ? 'لا يزال مطلوباً:' : 'Still needed:'}{' '}
                              {aiResult.data.complementaryGaps.join(', ')}
                            </p>
                          ) : null}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 pt-2">
                    <button
                      type="button"
                      disabled={busy || alreadyInvited || isSelectedTeamClosed || isSelectedTeamFull}
                      onClick={() => void handleInvite(m)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      <span>
                        {alreadyInvited
                          ? locale === 'ar'
                            ? 'تمت الدعوة'
                            : 'Invited'
                          : locale === 'ar'
                            ? 'دعوة'
                            : 'Invite'}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleAnalyzeWithAI(m)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>{locale === 'ar' ? 'تحليل التوافق بالذكاء' : 'AI Match Insight'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setDismissedIds((prev) => [...prev, m.candidate.uid])}
                      className="rounded-lg px-2.5 py-1.5 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white"
                    >
                      {locale === 'ar' ? 'تجاهل' : 'Ignore'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
