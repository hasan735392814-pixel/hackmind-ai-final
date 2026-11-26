import { useEffect, useState, type FormEvent } from 'react';
import { InferenceMode } from 'firebase/ai';
import { Download, ExternalLink, Plus, Shield, Sparkles, Trash2, Trophy } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import {
  adminListAllAuditLogs,
  adminListAllHackathons,
  adminListAllUsers,
  adminUpdateHackathonStatus,
  adminUpdateUserApprovedRole,
  assignJudgeToHackathon,
  deleteDraftHackathon,
  deleteJudgeAssignment,
  getHackathonResults,
  listJudgeAssignmentsByOrganizer,
  listJudgeDirectory,
  listOrganizerEvaluations,
  listOrganizerHackathons,
  listOrganizerRegistrations,
  listOrganizerSubmissions,
  listOrganizerTeams,
  listPendingRoleRequestsForAdmin,
  listSponsorRecords,
  recordAuditLog,
  reviewSponsorRequest,
  saveHackathon,
  saveHackathonResults,
  updateRegistrationStatus
} from '../services/firebase/firestoreService';
import { executeHybridInference } from '../services/hybridAI/inferenceManager';
import { buildTaskPrompt } from '../services/hybridAI/promptRegistry';
import type { HybridExecutionResult } from '../services/hybridAI/types';
import { computeFairRankings, validateRubricWeights } from '../services/judging/fairJudgingEngine';
import type {
  AccountRole,
  AuditLogEntry,
  Evaluation,
  Hackathon,
  HackathonMode,
  HackathonRegistration,
  HackathonResults,
  HackathonStatus,
  JudgeAssignment,
  ProjectSubmission,
  RankedSubmissionResult,
  RubricCriterion,
  SponsorRecord,
  Team,
  UserProfile
} from '../types/domain';
import { generateFirestoreId } from '../utils/validation';
import {
  formatActionableError,
  indexOrganizerRegistrations
} from '../utils/registrationResolution';
import { InferenceResultBanner } from '../components/common/InferenceBadge';
import { InferenceModeSelector } from '../components/common/InferenceModeSelector';

interface AIHackathonDraft {
  tagline?: string;
  description?: string;
  eligibility?: string;
  rules?: string;
  tracks?: string[];
  technologies?: string[];
  prizes?: string[];
  rubric?: { name: string; description: string; weight: number }[];
}

const DEFAULT_RUBRIC: RubricCriterion[] = [
  { id: 'innovation', name: 'Innovation & Originality', description: 'Novelty and creative use of hybrid AI', weight: 25 },
  { id: 'tech', name: 'Technical Implementation', description: 'Architecture, code quality, and reliability', weight: 30 },
  { id: 'impact', name: 'Real-World Impact', description: 'Clarity of problem and measurable usefulness', weight: 20 },
  { id: 'ux', name: 'User Experience & Completeness', description: 'Polish, accessibility, and working end-to-end flow', weight: 25 }
];

type StudioTab = 'events' | 'registrations' | 'teams' | 'judging' | 'results' | 'admin';

export function OrganizerStudioPage() {
  const { user, profile, privateInfo, emailVerified, isAdmin, updateCloudConsent } = useAuth();
  const { locale, t } = useLanguage();

  const isApprovedOrganizerOrAdmin = isAdmin || profile?.approvedRole === 'organizer';

  const [hackathons, setHackathons] = useState<Hackathon[]>([]);
  const [registrations, setRegistrations] = useState<HackathonRegistration[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [submissions, setSubmissions] = useState<ProjectSubmission[]>([]);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [judges, setJudges] = useState<UserProfile[]>([]);
  const [assignments, setAssignments] = useState<JudgeAssignment[]>([]);
  const [sponsors, setSponsors] = useState<SponsorRecord[]>([]);
  const [sponsorTiers, setSponsorTiers] = useState<Record<string, SponsorRecord['tier']>>({});

  // Admin state
  const [pendingRoleUsers, setPendingRoleUsers] = useState<UserProfile[]>([]);
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [allPlatformHackathons, setAllPlatformHackathons] = useState<Hackathon[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);

  const [activeTab, setActiveTab] = useState<StudioTab>('events');

  // Form state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [tagline, setTagline] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<HackathonMode>('online');
  const [location, setLocation] = useState('Global Remote');
  const [startDate, setStartDate] = useState('2026-12-01');
  const [endDate, setEndDate] = useState('2026-12-03');
  const [regDeadline, setRegDeadline] = useState('2026-11-30');
  const [subDeadline, setSubDeadline] = useState('2026-12-03T18:00');
  const [maxTeamSize, setMaxTeamSize] = useState(4);
  const [tracksText, setTracksText] = useState(
    'Artificial Intelligence, AI Agents, FinTech, Healthcare Technology, Education Technology, Sustainability'
  );
  const [techText, setTechText] = useState('TypeScript, React, Firebase, Gemini');
  const [prizesText, setPrizesText] = useState(
    'Proposed: Winner Recognition Certificates, Featured Showcase (Official prizes TBD)'
  );
  const [sponsorsText, setSponsorsText] = useState('');
  const [eligibility, setEligibility] = useState(
    'Proposed: Open to developers, entrepreneurs, students, designers, and researchers worldwide.'
  );
  const [rules, setRules] = useState(
    'Proposed: All submitted prototypes must be built during the competition window with clear attribution for open-source libraries and AI tooling.'
  );
  const [rubric, setRubric] = useState<RubricCriterion[]>(DEFAULT_RUBRIC);
  const [status, setStatus] = useState<HackathonStatus>('draft');

  // AI Builder
  const [aiTopic, setAiTopic] = useState('');
  const [aiMode, setAiMode] = useState<InferenceMode>(InferenceMode.PREFER_IN_CLOUD);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<HybridExecutionResult<AIHackathonDraft> | null>(null);
  const [pendingAIDraft, setPendingAIDraft] = useState<AIHackathonDraft | null>(null);

  // Judging / Results state
  const [selectedHackathonId, setSelectedHackathonId] = useState('');
  const [selectedJudgeId, setSelectedJudgeId] = useState('');
  const [selectedSubIds, setSelectedSubIds] = useState<string[]>([]);
  const [expectedJudgesPerSub, setExpectedJudgesPerSub] = useState(1);
  const [computedRankings, setComputedRankings] = useState<RankedSubmissionResult[]>([]);
  const [savedResultsDoc, setSavedResultsDoc] = useState<HackathonResults | null>(null);

  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const loadAll = async () => {
    if (!user) return;
    let studioLoadError = '';
    const [hacks, regs, tms, subs, evals, jList, assigns, spList, roleReqs, adminUsers, adminHacks, adminLogs] =
      await Promise.all([
        listOrganizerHackathons(user.uid).catch((err) => {
          studioLoadError =
            err instanceof Error ? err.message : 'Failed to load organizer hackathons.';
          return [] as Hackathon[];
        }),
        listOrganizerRegistrations(user.uid).catch(() => []),
        listOrganizerTeams(user.uid).catch(() => []),
        listOrganizerSubmissions(user.uid).catch(() => []),
        listOrganizerEvaluations(user.uid).catch(() => []),
        listJudgeDirectory().catch(() => []),
        listJudgeAssignmentsByOrganizer(user.uid).catch(() => []),
        listSponsorRecords(user.uid).catch(() => []),
        isAdmin ? listPendingRoleRequestsForAdmin().catch(() => []) : Promise.resolve([]),
        isAdmin ? adminListAllUsers().catch(() => []) : Promise.resolve([]),
        isAdmin ? adminListAllHackathons().catch(() => []) : Promise.resolve([]),
        isAdmin ? adminListAllAuditLogs().catch(() => []) : Promise.resolve([])
      ]);
    if (studioLoadError) {
      setErrorMsg(studioLoadError);
    }
    setHackathons(hacks);
    setRegistrations(regs);
    setTeams(tms);
    setSubmissions(subs);
    setEvaluations(evals);
    setJudges(jList);
    setAssignments(assigns);
    setSponsors(spList.filter((sp) => sp.organizerId === user.uid));
    setPendingRoleUsers(roleReqs.filter((u) => u.requestedRole !== u.approvedRole));
    setAllUsers(adminUsers);
    setAllPlatformHackathons(adminHacks);
    setAuditLogs(adminLogs);
    if (hacks.length > 0 && !selectedHackathonId) {
      setSelectedHackathonId(hacks[0].id);
    }
  };

  useEffect(() => {
    void loadAll();
  }, [user, isAdmin]);

  // Pre-fill assigned submissions when judge + hackathon already have an assignment
  useEffect(() => {
    if (!selectedHackathonId || !selectedJudgeId) {
      setSelectedSubIds([]);
      return;
    }
    const existing = assignments.find(
      (a) => a.hackathonId === selectedHackathonId && a.judgeId === selectedJudgeId
    );
    setSelectedSubIds(existing ? [...existing.assignedSubmissionIds] : []);
  }, [selectedHackathonId, selectedJudgeId, assignments]);

  // Load saved/published results doc when selectedHackathonId changes
  useEffect(() => {
    if (!selectedHackathonId) {
      setSavedResultsDoc(null);
      setComputedRankings([]);
      return;
    }
    void getHackathonResults(selectedHackathonId)
      .then((resDoc) => {
        setSavedResultsDoc(resDoc);
        if (resDoc?.rankings?.length) {
          setComputedRankings(resDoc.rankings);
        } else {
          setComputedRankings([]);
        }
      })
      .catch(() => {
        setSavedResultsDoc(null);
      });
  }, [selectedHackathonId]);

  const hackathonTitleById = new Map(hackathons.map((h) => [h.id, h.title]));

  const editingHackathon = editingId ? hackathons.find((h) => h.id === editingId) : undefined;
  const isEditingLockedCompleted = !isAdmin && editingHackathon?.status === 'completed';

  const allowedStatusOptions = ((): HackathonStatus[] => {
    if (isAdmin) return ['draft', 'published', 'judging', 'completed'];
    if (!editingHackathon) return ['draft', 'published'];
    switch (editingHackathon.status) {
      case 'draft':
        return ['draft', 'published', 'judging'];
      case 'published':
        return ['published', 'judging', 'completed'];
      case 'judging':
        return ['judging', 'completed'];
      case 'completed':
        return ['completed'];
    }
  })();

  const loadHackathonIntoForm = (h: Hackathon) => {
    setErrorMsg('');
    setFeedback('');
    setEditingId(h.id);
    setTitle(h.title);
    setTagline(h.tagline || '');
    setDescription(h.description);
    setMode(h.mode);
    setLocation(h.location || '');
    setStartDate(h.startDate || '');
    setEndDate(h.endDate || '');
    setRegDeadline(h.registrationDeadline || '');
    setSubDeadline(h.submissionDeadline || '');
    setMaxTeamSize(h.maxTeamSize || 4);
    setTracksText((h.tracks || []).join(', '));
    setTechText((h.technologies || []).join(', '));
    setPrizesText((h.prizes || []).join(', '));
    setSponsorsText((h.sponsors || []).join(', '));
    setEligibility(h.eligibility || '');
    setRules(h.rules || '');
    setRubric(h.rubric && h.rubric.length ? h.rubric : DEFAULT_RUBRIC);
    setStatus(h.status);
  };

  const resetForm = () => {
    setErrorMsg('');
    setFeedback('');
    setEditingId(null);
    setTitle('');
    setTagline('');
    setDescription('');
    setSponsorsText('');
    setStatus('draft');
    setRubric(DEFAULT_RUBRIC);
  };

  const applyProposedHackathonTemplate = () => {
    setErrorMsg('');
    setEditingId(null);
    setTitle('Global AI Innovation Hackathon 2026');
    setTagline('Proposed: Open Innovation Competition for Practical AI-Powered Solutions');
    setDescription(
      'An open innovation competition inviting developers and entrepreneurs to build practical AI-powered solutions.\n\n[Proposed Schedule & Guidelines — Review before publishing]\n• Registration Closes: 2026-12-10\n• Build Window: 2026-12-12 to 2026-12-15\n• Official prizes and sponsors remain TBD until confirmed by organizers.'
    );
    setMode('online');
    setLocation('Global Remote (Proposed)');
    setRegDeadline('2026-12-10');
    setStartDate('2026-12-12');
    setEndDate('2026-12-15');
    setSubDeadline('2026-12-15T18:00');
    setMaxTeamSize(4);
    setTracksText(
      'Artificial Intelligence, AI Agents, FinTech, Healthcare Technology, Education Technology, Sustainability'
    );
    setTechText('TypeScript, React, Firebase, Gemini');
    setPrizesText(
      'Proposed: Winner Recognition Certificates, Community Showcase Spotlight (Official prizes TBD)'
    );
    setSponsorsText('');
    setEligibility(
      'Proposed: Open to developers, entrepreneurs, students, designers, and researchers worldwide (teams of 1–4 members).'
    );
    setRules(
      'Proposed: All submitted code and prototypes must be built during the competition window. Open-source libraries and AI tools are permitted with transparent attribution.'
    );
    setRubric([
      {
        id: 'innovation',
        name: 'Innovation & Originality',
        description: 'Novelty and practical AI problem-solving approach',
        weight: 25
      },
      {
        id: 'tech',
        name: 'Technical Implementation',
        description: 'Architecture, code quality, security, and reliability',
        weight: 30
      },
      {
        id: 'impact',
        name: 'Real-World Impact',
        description: 'Clarity of use case across target domain and measurable value',
        weight: 25
      },
      {
        id: 'ux',
        name: 'User Experience & Completeness',
        description: 'Working end-to-end flow, clarity, and accessibility',
        weight: 20
      }
    ]);
    setStatus('draft');
    setFeedback(
      locale === 'ar'
        ? 'تم تعبئة نموذج المسودة المقترح لمراجعة المنظّم قبل الحفظ أو النشر.'
        : 'Loaded proposed 2026 draft template. Review all proposed fields before saving or publishing.'
    );
  };

  const handleDeleteDraft = async (h: Hackathon) => {
    if (!user || !emailVerified || (h.status !== 'draft' && !isAdmin)) return;
    setBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      await deleteDraftHackathon(h.id);
      if (editingId === h.id) resetForm();
      await loadAll();
      setFeedback(
        locale === 'ar'
          ? `تم حذف مسودة الهاكاثون "${h.title}".`
          : `Draft hackathon "${h.title}" deleted.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to delete draft hackathon');
    } finally {
      setBusy(false);
    }
  };

  const handlePublishDraft = async (h: Hackathon) => {
    if (!user || h.status !== 'draft') return;
    setErrorMsg('');
    setFeedback('');
    if (!emailVerified) {
      setErrorMsg(
        locale === 'ar'
          ? 'يلزم توثيق البريد الإلكتروني لنشر الهاكاثونات.'
          : 'Email verification is required to publish hackathons.'
      );
      return;
    }
    if (!isApprovedOrganizerOrAdmin) {
      setErrorMsg(
        locale === 'ar'
          ? 'تتطلب إدارة ونشر الهاكاثونات موافقة المسؤول على دور المنظّم.'
          : 'Organizer approval from an administrator is required before publishing hackathons.'
      );
      return;
    }
    if (h.title.trim().length < 3 || h.description.trim().length < 10) {
      loadHackathonIntoForm(h);
      setErrorMsg(
        locale === 'ar'
          ? 'يرجى إكمال العنوان (3 أحرف على الأقل) والوصف (10 أحرف على الأقل) قبل النشر.'
          : 'Complete the required title (min 3 chars) and description (min 10 chars) before publishing.'
      );
      return;
    }

    setBusy(true);
    try {
      await saveHackathon(
        {
          ...h,
          organizerName: (h.organizerName || profile?.displayName || user.displayName || '').trim() || 'Organizer',
          status: 'published',
          resultsPublished: Boolean(h.resultsPublished)
        },
        false
      );
      await recordAuditLog({
        actorId: user.uid,
        actorName: (profile?.displayName || user.displayName || '').trim() || 'Organizer',
        action: 'hackathon_updated_published',
        targetCollection: 'hackathons',
        targetId: h.id,
        hackathonId: h.id,
        details: `Hackathon "${h.title}" published to Discovery directory`
      }).catch(() => {});
      await loadAll();
      if (editingId === h.id) {
        setStatus('published');
      }
      setFeedback(
        locale === 'ar'
          ? `تم نشر "${h.title}" وأصبح ظاهراً في صفحة استكشاف الهاكاثونات.`
          : `"${h.title}" published and is now visible in Discover Hackathons.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to publish hackathon');
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateDraft = async () => {
    if (!title.trim() && !aiTopic.trim()) {
      setErrorMsg(
        locale === 'ar'
          ? 'أدخل عنوان الهاكاثون أو موضوعاً ليقوم الذكاء الاصطناعي بإعداد المسودة.'
          : 'Enter a hackathon title or theme topic before running AI Hackathon Builder.'
      );
      return;
    }
    setErrorMsg('');
    setAiBusy(true);
    try {
      const prompt = buildTaskPrompt(
        'hackathon_builder',
        {
          title: title || aiTopic,
          theme: aiTopic || title,
          mode,
          maxTeamSize,
          existingTracks: tracksText
        },
        locale
      );
      const res = await executeHybridInference<AIHackathonDraft>({
        taskKey: 'hackathon_builder',
        prompt,
        preferredMode: aiMode,
        locale,
        cloudConsentGranted: Boolean(privateInfo?.aiCloudConsent),
        userId: user?.uid,
        emailVerified
      });
      setAiResult(res);
      if (res.ok && res.data) {
        setPendingAIDraft(res.data);
      } else {
        setErrorMsg(res.errorMessage || 'AI Hackathon Builder failed.');
      }
    } finally {
      setAiBusy(false);
    }
  };

  const applyPendingAIDraft = () => {
    if (!pendingAIDraft) return;
    if (pendingAIDraft.tagline) setTagline(pendingAIDraft.tagline);
    if (pendingAIDraft.description) setDescription(pendingAIDraft.description);
    if (pendingAIDraft.eligibility) setEligibility(pendingAIDraft.eligibility);
    if (pendingAIDraft.rules) setRules(pendingAIDraft.rules);
    if (Array.isArray(pendingAIDraft.tracks) && pendingAIDraft.tracks.length) {
      setTracksText(pendingAIDraft.tracks.join(', '));
    }
    if (Array.isArray(pendingAIDraft.technologies) && pendingAIDraft.technologies.length) {
      setTechText(pendingAIDraft.technologies.join(', '));
    }
    if (Array.isArray(pendingAIDraft.prizes) && pendingAIDraft.prizes.length) {
      setPrizesText(pendingAIDraft.prizes.join(', '));
    }
    if (Array.isArray(pendingAIDraft.rubric) && pendingAIDraft.rubric.length) {
      setRubric(
        pendingAIDraft.rubric.map((r, idx) => ({
          id: `crit_${idx + 1}`,
          name: r.name,
          description: r.description,
          weight: Number(r.weight) || 25
        }))
      );
    }
    setPendingAIDraft(null);
    setFeedback(
      locale === 'ar'
        ? 'تم تطبيق المسودة المقترحة في النموذج للمراجعة قبل النشر.'
        : 'AI draft applied to form. Review and edit before saving or publishing.'
    );
  };

  const handleSaveHackathon = async (e: FormEvent, overrideStatus?: HackathonStatus) => {
    e.preventDefault();
    if (!user) return;
    setErrorMsg('');
    setFeedback('');

    if (!emailVerified) {
      setErrorMsg(
        locale === 'ar'
          ? 'يلزم توثيق البريد الإلكتروني لحفظ الهاكاثونات.'
          : 'Email verification is required to save hackathons.'
      );
      return;
    }
    if (title.trim().length < 3 || description.trim().length < 10) {
      setErrorMsg(
        locale === 'ar'
          ? 'العنوان (3 أحرف على الأقل) والوصف (10 أحرف على الأقل) مطلوبان.'
          : 'Title (min 3 chars) and description (min 10 chars) are required.'
      );
      return;
    }
    const weightCheck = validateRubricWeights(rubric);
    if (!weightCheck.valid) {
      setErrorMsg(
        locale === 'ar'
          ? `يجب أن يساوي مجموع أوزان معايير التحكيم 100% (الحالي: ${weightCheck.sum}%).`
          : `Rubric weights must sum to 100% (currently ${weightCheck.sum}%).`
      );
      return;
    }

    if (startDate && endDate && new Date(endDate).getTime() < new Date(startDate).getTime()) {
      setErrorMsg(
        locale === 'ar'
          ? 'لا يمكن أن يسبق تاريخ الانتهاء تاريخ البدء.'
          : 'End date cannot be earlier than start date.'
      );
      return;
    }
    if (regDeadline && endDate && new Date(regDeadline).getTime() > new Date(endDate).getTime()) {
      setErrorMsg(
        locale === 'ar'
          ? 'لا يمكن أن يتجاوز الموعد النهائي للتسجيل تاريخ انتهاء الهاكاثون.'
          : 'Registration deadline cannot be after the hackathon end date.'
      );
      return;
    }

    if (!isApprovedOrganizerOrAdmin) {
      setErrorMsg(
        locale === 'ar'
          ? 'تتطلب إدارة الهاكاثونات موافقة المسؤول على دور المنظّم.'
          : 'Organizer approval from an administrator is required before saving hackathons.'
      );
      return;
    }

    if (isEditingLockedCompleted) {
      setErrorMsg(
        locale === 'ar'
          ? 'الهاكاثونات المكتملة مقفلة ضد التعديل.'
          : 'Completed hackathons are locked against edits.'
      );
      return;
    }

    const targetStatus = overrideStatus ?? status;
    if (!allowedStatusOptions.includes(targetStatus)) {
      setErrorMsg(
        locale === 'ar'
          ? `الانتقال إلى الحالة "${targetStatus}" غير مسموح من الحالة "${editingHackathon?.status}".`
          : `Status transition to "${targetStatus}" is not allowed from "${editingHackathon?.status}".`
      );
      return;
    }

    const targetId = editingId || generateFirestoreId('hack');

    setBusy(true);
    try {
      await saveHackathon(
        {
          id: targetId,
          organizerId: editingHackathon?.organizerId || user.uid,
          organizerName:
            (editingHackathon?.organizerName || profile?.displayName || user.displayName || '').trim() ||
            'Organizer',
          title,
          tagline,
          description,
          coverImageUrl: editingHackathon?.coverImageUrl || '',
          startDate,
          endDate,
          registrationDeadline: regDeadline,
          submissionDeadline: subDeadline,
          mode,
          location,
          tracks: tracksText.split(',').map((s) => s.trim()).filter(Boolean),
          technologies: techText.split(',').map((s) => s.trim()).filter(Boolean),
          eligibility,
          rules,
          prizes: prizesText.split(',').map((s) => s.trim()).filter(Boolean),
          sponsors: sponsorsText.split(',').map((s) => s.trim()).filter(Boolean),
          rubric,
          maxTeamSize,
          status: targetStatus,
          resultsPublished: editingHackathon?.resultsPublished ?? false
        },
        !editingId
      );

      await recordAuditLog({
        actorId: user.uid,
        actorName: profile?.displayName || user.displayName || 'Organizer',
        action: editingId ? `hackathon_updated_${targetStatus}` : `hackathon_created_${targetStatus}`,
        targetCollection: 'hackathons',
        targetId,
        hackathonId: targetId,
        details: `Hackathon "${title}" saved with status ${targetStatus}`
      }).catch(() => {});

      await loadAll();
      setEditingId(targetId);
      setStatus(targetStatus);
      setFeedback(
        targetStatus === 'published'
          ? locale === 'ar'
            ? 'تم حفظ الهاكاثون ونشره في دليل المنافسات.'
            : 'Hackathon saved and published to Discovery directory.'
          : locale === 'ar'
            ? 'تم حفظ الهاكاثون.'
            : 'Hackathon saved.'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save hackathon');
    } finally {
      setBusy(false);
    }
  };

  const handleAssignJudge = async () => {
    if (!user || !selectedHackathonId || !selectedJudgeId || selectedSubIds.length === 0) {
      setErrorMsg(
        locale === 'ar'
          ? 'اختر هاكاثوناً ومحكماً وتسليماً واحداً على الأقل.'
          : 'Select a hackathon, a judge, and at least one submission.'
      );
      return;
    }
    const judgeProfile = judges.find((j) => j.uid === selectedJudgeId);
    if (!judgeProfile) return;

    setBusy(true);
    setErrorMsg('');
    try {
      await assignJudgeToHackathon({
        hackathonId: selectedHackathonId,
        organizerId: user.uid,
        judgeId: judgeProfile.uid,
        judgeName: judgeProfile.displayName,
        submissionIds: selectedSubIds
      });
      await loadAll();
      setFeedback(
        locale === 'ar'
          ? `تم تعيين ${judgeProfile.displayName} لعدد ${selectedSubIds.length} تسليم.`
          : `Assigned ${judgeProfile.displayName} to ${selectedSubIds.length} submission(s). The judge can review and accept on their Judging Workspace.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Judge assignment failed');
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveAssignment = async (assignment: JudgeAssignment) => {
    setBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      await deleteJudgeAssignment(assignment.id);
      await loadAll();
      setFeedback(
        locale === 'ar'
          ? `تم إزالة تكليف المحكم ${assignment.judgeName}.`
          : `Removed judge assignment for ${assignment.judgeName}.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to remove judge assignment');
    } finally {
      setBusy(false);
    }
  };

  const handleComputeResults = () => {
    const hackSubs = submissions.filter((s) => s.hackathonId === selectedHackathonId);
    const hackEvals = evaluations.filter((ev) => ev.hackathonId === selectedHackathonId);
    const targetHack = hackathons.find((h) => h.id === selectedHackathonId);
    const rankings = computeFairRankings({
      submissions: hackSubs,
      evaluations: hackEvals,
      expectedJudgesPerSubmission: Math.max(1, expectedJudgesPerSub),
      rubric: targetHack?.rubric
    });
    setComputedRankings(rankings);
    setFeedback(
      locale === 'ar'
        ? `تم حساب ترتيب ${rankings.length} تسليم.`
        : `Computed rankings for ${rankings.length} submission(s).`
    );
  };

  const handleSaveResults = async (publishFinal: boolean) => {
    if (!user || !selectedHackathonId || computedRankings.length === 0) return;
    const targetHack = hackathons.find((h) => h.id === selectedHackathonId);
    if (savedResultsDoc?.published || targetHack?.resultsPublished) {
      setErrorMsg(
        locale === 'ar'
          ? 'النتائج النهائية منشورة ومقفلة مسبقاً.'
          : 'Final results are already published and locked against modification.'
      );
      return;
    }
    if (publishFinal && targetHack?.status === 'draft') {
      setErrorMsg(
        locale === 'ar'
          ? 'انشر الهاكاثون أو حوّل حالته إلى "قيد التحكيم" قبل نشر النتائج النهائية.'
          : 'Publish the hackathon or set it to "judging" before publishing final results.'
      );
      return;
    }
    if (publishFinal && targetHack?.status === 'completed' && !isAdmin) {
      setErrorMsg(
        locale === 'ar'
          ? 'تم وضع الهاكاثون كمكتمل يدوياً قبل النشر. اطلب من المسؤول الفتح أو انشر أثناء حالة التحكيم.'
          : 'Hackathon is already marked completed without published results. Have an admin restore status to judging before publishing.'
      );
      return;
    }

    setBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      await saveHackathonResults({
        hackathonId: selectedHackathonId,
        organizerId: user.uid,
        published: publishFinal,
        rankings: computedRankings
      });
      if (publishFinal) {
        await recordAuditLog({
          actorId: user.uid,
          actorName: profile?.displayName || 'Organizer',
          action: 'results_published',
          targetCollection: 'hackathonResults',
          targetId: selectedHackathonId,
          hackathonId: selectedHackathonId,
          details: `Published ${computedRankings.length} ranked submissions.`
        }).catch(() => {});
      }

      const freshRes = await getHackathonResults(selectedHackathonId).catch(() => null);
      setSavedResultsDoc(freshRes);
      await loadAll();
      setFeedback(
        publishFinal
          ? locale === 'ar'
            ? 'تم نشر الترتيب النهائي وإعلان النتائج الرسمية.'
            : 'Final rankings published! Participants can now view results on their dashboards and activity feeds.'
          : locale === 'ar'
            ? 'تم حفظ مسودة الترتيب بنجاح.'
            : 'Draft rankings saved to Firestore.'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save results');
    } finally {
      setBusy(false);
    }
  };

  const handleRegistrationReview = async (
    reg: HackathonRegistration,
    nextStatus: 'approved' | 'rejected'
  ) => {
    if (!user) return;
    setBusy(true);
    setErrorMsg('');
    try {
      await updateRegistrationStatus(reg.id, nextStatus, {
        expectedCurrentStatus: reg.status,
        actorRole: isAdmin ? 'admin' : 'organizer'
      });
      await recordAuditLog({
        actorId: user.uid,
        actorName: profile?.displayName || 'Organizer',
        action: nextStatus === 'approved' ? 'registration_approved' : 'registration_rejected',
        targetCollection: 'registrations',
        targetId: reg.id,
        hackathonId: reg.hackathonId,
        details: `${reg.userName} (${reg.userId}) ${nextStatus}.`
      }).catch(() => {});
      await loadAll();
      setFeedback(
        locale === 'ar'
          ? `تم تحديث تسجيل ${reg.userName} إلى ${nextStatus}.`
          : `Registration for ${reg.userName} ${nextStatus}.`
      );
    } catch (err) {
      setErrorMsg(formatActionableError(err, `Failed to ${nextStatus} registration`));
    } finally {
      setBusy(false);
    }
  };

  const handleSponsorReview = async (
    sp: SponsorRecord,
    nextStatus: 'approved' | 'rejected'
  ) => {
    if (!user) return;
    const chosenTier = sponsorTiers[sp.id] || sp.tier || 'community';
    setBusy(true);
    setErrorMsg('');
    try {
      await reviewSponsorRequest({
        sponsorId: sp.id,
        status: nextStatus,
        tier: chosenTier
      });
      await recordAuditLog({
        actorId: user.uid,
        actorName: profile?.displayName || 'Organizer',
        action: nextStatus === 'approved' ? 'sponsor_approved' : 'sponsor_rejected',
        targetCollection: 'sponsors',
        targetId: sp.id,
        hackathonId: sp.hackathonId,
        details: `Sponsor ${sp.organizationName} ${nextStatus} (${chosenTier}).`
      }).catch(() => {});
      await loadAll();
      setFeedback(`Sponsor request for ${sp.organizationName} ${nextStatus}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : `Failed to ${nextStatus} sponsor request`);
    } finally {
      setBusy(false);
    }
  };

  const handleAdminSetUserRole = async (target: UserProfile, nextRole: AccountRole) => {
    if (!user || !isAdmin) return;
    setBusy(true);
    setErrorMsg('');
    try {
      await adminUpdateUserApprovedRole(target.uid, nextRole);
      await recordAuditLog({
        actorId: user.uid,
        actorName: profile?.displayName || 'Admin',
        action: 'role_approved',
        targetCollection: 'users',
        targetId: target.uid,
        hackathonId: '',
        details: `Set approvedRole=${nextRole} (requested=${target.requestedRole}) for ${target.displayName}`
      }).catch(() => {});
      await loadAll();
      setFeedback(`Updated approved role for ${target.displayName} to ${nextRole}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update user role');
    } finally {
      setBusy(false);
    }
  };

  const handleAdminHackathonStatus = async (h: Hackathon, nextStatus: HackathonStatus) => {
    if (!user || !isAdmin) return;
    setBusy(true);
    setErrorMsg('');
    try {
      await adminUpdateHackathonStatus(h.id, nextStatus);
      await recordAuditLog({
        actorId: user.uid,
        actorName: profile?.displayName || 'Admin',
        action: `hackathon_updated_${nextStatus}`,
        targetCollection: 'hackathons',
        targetId: h.id,
        hackathonId: h.id,
        details: `Admin set hackathon "${h.title}" status to ${nextStatus}`
      }).catch(() => {});
      await loadAll();
      setFeedback(`Updated hackathon "${h.title}" status to ${nextStatus}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update hackathon status');
    } finally {
      setBusy(false);
    }
  };

  const { resolved: resolvedRegistrations, duplicateCountByKey } =
    indexOrganizerRegistrations(registrations);

  const exportReport = () => {
    const targetHack = hackathons.find((h) => h.id === selectedHackathonId);
    const report = {
      generatedAt: new Date().toISOString(),
      hackathon: targetHack,
      registrationsCount: resolvedRegistrations.filter((r) => r.hackathonId === selectedHackathonId).length,
      teamsCount: teams.filter((tm) => tm.hackathonId === selectedHackathonId).length,
      submissionsCount: submissions.filter((s) => s.hackathonId === selectedHackathonId).length,
      evaluationsCount: evaluations.filter((ev) => ev.hackathonId === selectedHackathonId).length,
      rankings: computedRankings
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hackathon-report-${selectedHackathonId || 'export'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredSubs = submissions.filter((s) => s.hackathonId === selectedHackathonId);
  const existingJudgeAssignment = assignments.find(
    (a) => a.hackathonId === selectedHackathonId && a.judgeId === selectedJudgeId
  );
  const selectedHackObj = hackathons.find((h) => h.id === selectedHackathonId);
  const resultsAlreadyPublished = Boolean(
    savedResultsDoc?.published || selectedHackObj?.resultsPublished
  );

  const tabItems: { key: StudioTab; label: string }[] = [
    { key: 'events', label: locale === 'ar' ? 'الفعاليات' : 'Events' },
    { key: 'registrations', label: locale === 'ar' ? 'التسجيلات والرعاة' : 'Registrations' },
    { key: 'teams', label: locale === 'ar' ? 'الفرق والتسليمات' : 'Teams & Submissions' },
    { key: 'judging', label: locale === 'ar' ? 'تعيين المحكمين' : 'Judging' },
    { key: 'results', label: locale === 'ar' ? 'النتائج' : 'Results' },
    ...(isAdmin ? [{ key: 'admin' as const, label: locale === 'ar' ? 'إشراف الإدارة' : 'Admin Oversight' }] : [])
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            {t.sidebar.organizer}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {locale === 'ar'
              ? 'إدارة الهاكاثونات، الموافقة على المشاركين، تعيين المحكمين، وحساب النتائج الموزونة.'
              : 'Create competitions, review AI-drafted specs, manage registrations, assign judges, and publish rankings.'}
          </p>
        </div>

        <div className="inline-flex flex-wrap gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900 p-1">
          {tabItems.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                activeTab === tab.key
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {!isApprovedOrganizerOrAdmin && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {locale === 'ar'
            ? 'يتطلب إنشاء أو إدارة الهاكاثونات موافقة المسؤول على دور المنظّم. يمكنك طلب دور المنظّم من صفحة الملف الشخصي.'
            : `Organizer privileges require administrator approval. Your current approved role is "${profile?.approvedRole || 'participant'}". Request the Organizer role in Profile and await admin approval.`}
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

      {activeTab === 'events' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Existing Organizer Hackathons */}
          <div className="lg:col-span-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-base font-semibold">
                {locale === 'ar' ? 'هاكاثوناتي' : 'My Hackathons'}
              </h2>
              <button
                type="button"
                onClick={resetForm}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs font-medium"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{locale === 'ar' ? 'جديد' : 'New'}</span>
              </button>
            </div>

            {hackathons.length === 0 ? (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 text-xs text-slate-500">
                {locale === 'ar'
                  ? 'لم يتم إنشاء أي هاكاثون بعد. استخدم النموذج أو منشئ الذكاء الاصطناعي لإنشاء منافستك الأولى.'
                  : 'No hackathons created yet. Use the form or AI Hackathon Builder to create your first competition.'}
              </div>
            ) : (
              <div className="space-y-3">
                {hackathons.map((h) => (
                  <div
                    key={h.id}
                    className={`rounded-xl border p-4 transition-colors space-y-2 ${
                      editingId === h.id
                        ? 'border-blue-500 bg-blue-500/5'
                        : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => loadHackathonIntoForm(h)}
                      className="w-full text-start"
                    >
                      <div className="text-xs text-slate-500 capitalize">
                        {h.status} · {h.mode.replace('_', ' ')}
                      </div>
                      <div className="font-semibold text-sm text-slate-900 dark:text-white mt-1">
                        {h.title}
                      </div>
                    </button>
                    {(h.status === 'draft' || isAdmin) && (
                      <div className="flex items-center justify-end gap-3">
                        {h.status === 'draft' && isApprovedOrganizerOrAdmin && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handlePublishDraft(h)}
                            className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
                          >
                            {locale === 'ar' ? 'نشر الآن' : 'Publish'}
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDeleteDraft(h)}
                          className="text-[11px] text-red-500 hover:underline disabled:opacity-50"
                        >
                          {locale === 'ar' ? 'حذف المسودة' : 'Delete Draft'}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Create / Edit Form + AI Hackathon Builder */}
          <div className="lg:col-span-8 space-y-6">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-4">
              <div className="flex items-center gap-2 font-display text-sm font-semibold">
                <Sparkles className="h-4 w-4 text-blue-500" />
                <span>{locale === 'ar' ? 'منشئ الهاكاثون بالذكاء الهجين' : 'AI Hackathon Builder (Review Before Publish)'}</span>
              </div>
              <InferenceModeSelector
                mode={aiMode}
                onChange={setAiMode}
                cloudConsent={Boolean(privateInfo?.aiCloudConsent)}
                onGrantConsent={() => updateCloudConsent(true)}
              />
              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  value={aiTopic}
                  onChange={(e) => setAiTopic(e.target.value)}
                  placeholder={locale === 'ar' ? 'موضوع الهاكاثون (مثال: ذكاء اصطناعي محلي للرعاية الصحية)...' : 'Hackathon focus (e.g., Hybrid Edge AI for Climate & Health)...'}
                  className="flex-1 min-w-[220px] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  disabled={aiBusy}
                  onClick={() => void handleGenerateDraft()}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {aiBusy ? t.common.loading : locale === 'ar' ? 'توليد مسودة' : 'Generate Draft'}
                </button>
              </div>
              {aiResult && <InferenceResultBanner result={aiResult} />}
              {pendingAIDraft && (
                <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 space-y-2 text-xs">
                  <div className="font-semibold text-slate-900 dark:text-white">
                    {locale === 'ar' ? 'مسودة جاهزة لمراجعة المنظم' : 'Draft Ready for Organizer Review'}
                  </div>
                  <p className="text-slate-600 dark:text-slate-300">{pendingAIDraft.description?.slice(0, 260)}...</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={applyPendingAIDraft}
                      className="rounded-md bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-700"
                    >
                      {locale === 'ar' ? 'اعتماد وتعبئة النموذج' : 'Approve & Fill Form'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingAIDraft(null)}
                      className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5"
                    >
                      {locale === 'ar' ? 'تجاهل' : 'Discard'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <form
              onSubmit={(e) => void handleSaveHackathon(e)}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-200 dark:border-slate-800">
                <span className="font-display text-sm font-semibold text-slate-900 dark:text-white">
                  {editingId
                    ? locale === 'ar'
                      ? 'تعديل الهاكاثون'
                      : 'Edit Hackathon'
                    : locale === 'ar'
                      ? 'إنشاء هاكاثون جديد (مسودة أولاً)'
                      : 'Create New Hackathon (Draft First)'}
                </span>
                {!editingId && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={applyProposedHackathonTemplate}
                    className="rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 py-1.5 text-xs font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-500/20 disabled:opacity-50"
                  >
                    {locale === 'ar'
                      ? 'تعبئة قالب 2026 المقترح (مسودة)'
                      : 'Load Proposed 2026 Template (Draft)'}
                  </button>
                )}
              </div>

              {isEditingLockedCompleted && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                  {locale === 'ar'
                    ? 'هذا الهاكاثون مكتمل ومقفل ضد التعديل.'
                    : 'This hackathon is completed and locked against edits.'}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'العنوان' : 'Title'}
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={140}
                    disabled={isEditingLockedCompleted}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'الشعار التعريفي' : 'Tagline'}
                  </label>
                  <input
                    type="text"
                    maxLength={200}
                    disabled={isEditingLockedCompleted}
                    value={tagline}
                    onChange={(e) => setTagline(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm disabled:opacity-60"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">
                  {locale === 'ar' ? 'الوصف' : 'Description'}
                </label>
                <textarea
                  rows={4}
                  required
                  maxLength={8000}
                  disabled={isEditingLockedCompleted}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm disabled:opacity-60"
                />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'النمط' : 'Mode'}
                  </label>
                  <select
                    value={mode}
                    disabled={isEditingLockedCompleted}
                    onChange={(e) => setMode(e.target.value as HackathonMode)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2.5 py-2 text-xs disabled:opacity-60"
                  >
                    <option value="online">{t.common.online}</option>
                    <option value="in_person">{t.common.inPerson}</option>
                    <option value="hybrid">{t.common.hybrid}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'الموقع' : 'Location'}
                  </label>
                  <input
                    type="text"
                    disabled={isEditingLockedCompleted}
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2.5 py-2 text-xs disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'الحد الأقصى للفريق' : 'Max Team Size'}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    disabled={isEditingLockedCompleted}
                    value={maxTeamSize}
                    onChange={(e) => setMaxTeamSize(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2.5 py-2 text-xs font-mono tabular-nums disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'الحالة' : 'Status'}
                  </label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as HackathonStatus)}
                    disabled={isEditingLockedCompleted}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2.5 py-2 text-xs disabled:opacity-60"
                  >
                    {allowedStatusOptions.map((st) => (
                      <option key={st} value={st}>
                        {st === 'draft'
                          ? t.common.draft
                          : st === 'published'
                            ? t.common.published
                            : st === 'judging'
                              ? t.common.judging
                              : t.common.completed}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'تاريخ البدء' : 'Start Date'}
                  </label>
                  <input
                    type="date"
                    disabled={isEditingLockedCompleted}
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2.5 py-2 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'تاريخ الانتهاء' : 'End Date'}
                  </label>
                  <input
                    type="date"
                    disabled={isEditingLockedCompleted}
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2.5 py-2 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'آخر موعد للتسجيل' : 'Reg Deadline'}
                  </label>
                  <input
                    type="date"
                    disabled={isEditingLockedCompleted}
                    value={regDeadline}
                    onChange={(e) => setRegDeadline(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2.5 py-2 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'آخر موعد للتسليم' : 'Submission Due'}
                  </label>
                  <input
                    type="datetime-local"
                    disabled={isEditingLockedCompleted}
                    value={subDeadline}
                    onChange={(e) => setSubDeadline(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2.5 py-2 text-xs font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'المسارات (مفصولة بفواصل)' : 'Tracks (comma-separated)'}
                  </label>
                  <input
                    type="text"
                    disabled={isEditingLockedCompleted}
                    value={tracksText}
                    onChange={(e) => setTracksText(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'التقنيات (مفصولة بفواصل)' : 'Technologies (comma-separated)'}
                  </label>
                  <input
                    type="text"
                    disabled={isEditingLockedCompleted}
                    value={techText}
                    onChange={(e) => setTechText(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'الجوائز (مفصولة بفواصل)' : 'Prizes (comma-separated)'}
                  </label>
                  <input
                    type="text"
                    disabled={isEditingLockedCompleted}
                    value={prizesText}
                    onChange={(e) => setPrizesText(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'الرعاة (مفصولة بفواصل)' : 'Sponsors (comma-separated)'}
                  </label>
                  <input
                    type="text"
                    disabled={isEditingLockedCompleted}
                    value={sponsorsText}
                    onChange={(e) => setSponsorsText(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'الأهلية' : 'Eligibility'}
                  </label>
                  <textarea
                    rows={2}
                    disabled={isEditingLockedCompleted}
                    value={eligibility}
                    onChange={(e) => setEligibility(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {locale === 'ar' ? 'القوانين' : 'Rules'}
                  </label>
                  <textarea
                    rows={2}
                    disabled={isEditingLockedCompleted}
                    value={rules}
                    onChange={(e) => setRules(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
                  />
                </div>
              </div>

              {/* Rubric Weights */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold">
                  <span>
                    {locale === 'ar'
                      ? 'معايير التحكيم (يجب أن يساوي المجموع 100%)'
                      : 'Judging Rubric (Total must equal 100%)'}
                  </span>
                  <span className="font-mono tabular-nums">{validateRubricWeights(rubric).sum}%</span>
                </div>
                {rubric.map((crit, idx) => (
                  <div key={crit.id} className="grid grid-cols-12 gap-2">
                    <input
                      type="text"
                      disabled={isEditingLockedCompleted}
                      value={crit.name}
                      onChange={(e) => {
                        const next = [...rubric];
                        next[idx] = { ...crit, name: e.target.value };
                        setRubric(next);
                      }}
                      className="col-span-5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2.5 py-1.5 text-xs"
                    />
                    <input
                      type="text"
                      disabled={isEditingLockedCompleted}
                      value={crit.description}
                      onChange={(e) => {
                        const next = [...rubric];
                        next[idx] = { ...crit, description: e.target.value };
                        setRubric(next);
                      }}
                      className="col-span-5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2.5 py-1.5 text-xs"
                    />
                    <input
                      type="number"
                      min={0}
                      max={100}
                      disabled={isEditingLockedCompleted}
                      value={crit.weight}
                      onChange={(e) => {
                        const next = [...rubric];
                        next[idx] = { ...crit, weight: Number(e.target.value) };
                        setRubric(next);
                      }}
                      className="col-span-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2 py-1.5 text-xs font-mono tabular-nums"
                    />
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap justify-end gap-3 pt-2">
                <button
                  type="submit"
                  disabled={busy || isEditingLockedCompleted}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold disabled:opacity-50"
                >
                  {locale === 'ar' ? `حفظ بحالة (${status})` : `Save as ${status}`}
                </button>
                {allowedStatusOptions.includes('published') && (
                  <button
                    type="button"
                    disabled={busy || isEditingLockedCompleted}
                    onClick={(e) => void handleSaveHackathon(e, 'published')}
                    className="rounded-lg bg-blue-600 px-5 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {locale === 'ar' ? 'نشر الهاكاثون' : 'Publish Hackathon'}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {activeTab === 'registrations' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
            <h2 className="font-display text-lg font-semibold">
              {locale === 'ar'
                ? `تسجيلات المشاركين (${resolvedRegistrations.length})`
                : `Participant Registrations (${resolvedRegistrations.length})`}
            </h2>
            {resolvedRegistrations.length === 0 ? (
              <p className="text-sm text-slate-500">
                {locale === 'ar' ? 'لا توجد تسجيلات مشاركين بعد.' : 'No participant registrations yet.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                      <th className="py-2 text-start">{locale === 'ar' ? 'المشارك' : 'Participant'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'الهاكاثون' : 'Hackathon'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'المسار' : 'Track'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'الحالة' : 'Status'}</th>
                      <th className="py-2 text-end">{locale === 'ar' ? 'الإجراءات' : 'Actions'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resolvedRegistrations.map((reg) => {
                      const dupCount =
                        duplicateCountByKey.get(`${reg.hackathonId}::${reg.userId}`) || 1;
                      return (
                      <tr key={reg.id} className="border-b border-slate-100 dark:border-slate-800/60">
                        <td className="py-2.5 font-medium">
                          {reg.userName}
                          {reg.userTitle ? <span className="text-slate-400"> · {reg.userTitle}</span> : null}
                          {dupCount > 1 && (
                            <span className="ms-1.5 text-[10px] font-mono text-amber-600 dark:text-amber-400">
                              ({dupCount} records)
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 text-slate-600 dark:text-slate-300">
                          {hackathonTitleById.get(reg.hackathonId) || reg.hackathonId}
                        </td>
                        <td className="py-2.5">{reg.preferredTrack}</td>
                        <td className="py-2.5 capitalize">{reg.status}</td>
                        <td className="py-2.5 text-end space-x-2">
                          <button
                            type="button"
                            disabled={busy || reg.status === 'withdrawn'}
                            onClick={() => void handleRegistrationReview(reg, 'approved')}
                            className="text-emerald-600 font-semibold hover:underline disabled:opacity-40"
                          >
                            {t.common.approve}
                          </button>
                          <button
                            type="button"
                            disabled={busy || reg.status === 'withdrawn'}
                            onClick={() => void handleRegistrationReview(reg, 'rejected')}
                            className="text-red-500 font-semibold hover:underline disabled:opacity-40"
                          >
                            {t.common.reject}
                          </button>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
            <h2 className="font-display text-lg font-semibold">
              {locale === 'ar'
                ? `طلبات شراكة الرعاة (${sponsors.length})`
                : `Sponsor Partnership Requests (${sponsors.length})`}
            </h2>
            {sponsors.length === 0 ? (
              <p className="text-sm text-slate-500">
                {locale === 'ar'
                  ? 'لا توجد طلبات رعاية لهاكاثوناتك حتى الآن.'
                  : 'No sponsor partnership requests for your hackathons yet.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                      <th className="py-2 text-start">{locale === 'ar' ? 'الجهة' : 'Organization'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'الهاكاثون' : 'Hackathon'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'الحالة' : 'Status'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'الفئة' : 'Tier'}</th>
                      <th className="py-2 text-end">{locale === 'ar' ? 'الإجراءات' : 'Actions'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sponsors.map((sp) => (
                      <tr key={sp.id} className="border-b border-slate-100 dark:border-slate-800/60">
                        <td className="py-2.5 font-medium">{sp.organizationName}</td>
                        <td className="py-2.5 text-slate-600 dark:text-slate-300">
                          {hackathonTitleById.get(sp.hackathonId) || sp.hackathonId}
                        </td>
                        <td className="py-2.5 capitalize">{sp.status || 'pending'}</td>
                        <td className="py-2.5">
                          <select
                            value={sponsorTiers[sp.id] || sp.tier || 'community'}
                            onChange={(e) =>
                              setSponsorTiers((prev) => ({
                                ...prev,
                                [sp.id]: e.target.value as SponsorRecord['tier']
                              }))
                            }
                            className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2 py-1 text-xs"
                          >
                            <option value="community">Community</option>
                            <option value="silver">Silver</option>
                            <option value="gold">Gold</option>
                            <option value="platinum">Platinum</option>
                          </select>
                        </td>
                        <td className="py-2.5 text-end space-x-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleSponsorReview(sp, 'approved')}
                            className="text-emerald-600 font-semibold hover:underline disabled:opacity-50"
                          >
                            {t.common.approve}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleSponsorReview(sp, 'rejected')}
                            className="text-red-500 font-semibold hover:underline disabled:opacity-50"
                          >
                            {t.common.reject}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'teams' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
            <h2 className="font-display text-lg font-semibold">
              {locale === 'ar'
                ? `الفرق المسجلة (${teams.length})`
                : `Organizer Teams (${teams.length})`}
            </h2>
            {teams.length === 0 ? (
              <p className="text-sm text-slate-500">
                {locale === 'ar' ? 'لا توجد فرق منشأة في هاكاثوناتك بعد.' : 'No teams created in your hackathons yet.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                      <th className="py-2 text-start">{locale === 'ar' ? 'الفريق' : 'Team'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'الهاكاثون' : 'Hackathon'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'المسار' : 'Track'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'الأعضاء' : 'Members'}</th>
                      <th className="py-2 text-end">{locale === 'ar' ? 'الحالة' : 'Status'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teams.map((tm) => (
                      <tr key={tm.id} className="border-b border-slate-100 dark:border-slate-800/60">
                        <td className="py-2.5 font-semibold text-slate-900 dark:text-white">{tm.name}</td>
                        <td className="py-2.5">{hackathonTitleById.get(tm.hackathonId) || tm.hackathonId}</td>
                        <td className="py-2.5">{tm.track || 'General'}</td>
                        <td className="py-2.5">{tm.memberNames.join(', ')} ({tm.memberIds.length})</td>
                        <td className="py-2.5 text-end capitalize">{tm.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
            <h2 className="font-display text-lg font-semibold">
              {locale === 'ar'
                ? `تسليمات المشاريع (${submissions.length})`
                : `Project Submissions (${submissions.length})`}
            </h2>
            {submissions.length === 0 ? (
              <p className="text-sm text-slate-500">
                {locale === 'ar' ? 'لا توجد تسليمات مشاريع بعد.' : 'No project submissions yet.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                      <th className="py-2 text-start">{locale === 'ar' ? 'المشروع' : 'Submission'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'الفريق' : 'Team'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'الهاكاثون' : 'Hackathon'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'الروابط' : 'Links'}</th>
                      <th className="py-2 text-end">{locale === 'ar' ? 'الحالة' : 'Status'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {submissions.map((sub) => (
                      <tr key={sub.id} className="border-b border-slate-100 dark:border-slate-800/60">
                        <td className="py-2.5 font-semibold text-slate-900 dark:text-white">{sub.title}</td>
                        <td className="py-2.5">{sub.teamName}</td>
                        <td className="py-2.5">{hackathonTitleById.get(sub.hackathonId) || sub.hackathonId}</td>
                        <td className="py-2.5 space-x-2">
                          {sub.githubUrl && (
                            <a href={sub.githubUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline">
                              <span>GitHub</span>
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                          {sub.demoUrl && (
                            <a href={sub.demoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline">
                              <span>Demo</span>
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </td>
                        <td className="py-2.5 text-end capitalize">{sub.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'judging' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-5">
          <h2 className="font-display text-lg font-semibold">
            {locale === 'ar' ? 'تعيين المحكمين للتسليمات' : 'Assign Judges to Submissions'}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">
                {locale === 'ar' ? 'الهاكاثون' : 'Hackathon'}
              </label>
              <select
                value={selectedHackathonId}
                onChange={(e) => setSelectedHackathonId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              >
                {hackathons.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.title}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {locale === 'ar' ? 'حساب المحكم' : 'Judge Account'}
              </label>
              <select
                value={selectedJudgeId}
                onChange={(e) => setSelectedJudgeId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              >
                <option value="">{locale === 'ar' ? 'اختر محكماً...' : 'Select judge...'}</option>
                {judges.map((j) => (
                  <option key={j.uid} value={j.uid}>
                    {j.displayName} {j.title ? `(${j.title})` : ''}
                  </option>
                ))}
              </select>
              {judges.length === 0 && (
                <p className="mt-1 text-[11px] text-amber-500">
                  {locale === 'ar'
                    ? 'لا يوجد مستخدمون بدور "judge" معتمد بعد. يمكن للمستخدم طلب الدور من ملفه الشخصي وموافقة المسؤول.'
                    : 'No users with approved role "judge" found yet. Users can request the Judge role in Profile and await admin approval.'}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium">
              {locale === 'ar' ? `التسليمات (${filteredSubs.length})` : `Submissions (${filteredSubs.length})`}
            </div>
            {filteredSubs.length === 0 ? (
              <p className="text-xs text-slate-500">
                {locale === 'ar'
                  ? 'لا توجد تسليمات مستلمة لهذا الهاكاثون بعد.'
                  : 'No submissions received for this hackathon yet.'}
              </p>
            ) : (
              <div className="space-y-2">
                {filteredSubs.map((sub) => {
                  const checked = selectedSubIds.includes(sub.id);
                  return (
                    <label
                      key={sub.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-xs cursor-pointer"
                    >
                      <span className="flex items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setSelectedSubIds((prev) =>
                              checked ? prev.filter((id) => id !== sub.id) : [...prev, sub.id]
                            )
                          }
                        />
                        <span className="font-semibold text-slate-900 dark:text-white">{sub.title}</span>
                        <span className="text-slate-500">
                          {locale === 'ar' ? `من ${sub.teamName}` : `by ${sub.teamName}`}
                        </span>
                      </span>
                      <span className="capitalize text-slate-500">{sub.status}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => void handleAssignJudge()}
            className="rounded-lg bg-blue-600 px-5 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {existingJudgeAssignment
              ? locale === 'ar'
                ? 'تحديث تعيين المحكم'
                : 'Update Judge Assignment'
              : locale === 'ar'
                ? 'تعيين المحكم المحدد'
                : 'Assign Selected Judge'}
          </button>

          {assignments.length > 0 && (
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2">
              <div className="text-xs font-semibold">
                {locale === 'ar' ? 'التكليفات النشطة' : 'Active Assignments'}
              </div>
              {assignments.map((a) => (
                <div
                  key={a.id}
                  className="text-xs text-slate-600 dark:text-slate-300 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 dark:border-slate-800/60 p-2.5"
                >
                  <span>
                    <span className="font-semibold text-slate-900 dark:text-white">{a.judgeName}</span> ·{' '}
                    {hackathonTitleById.get(a.hackathonId) || a.hackathonId} ·{' '}
                    {locale === 'ar'
                      ? `${a.assignedSubmissionIds.length} تسليم`
                      : `${a.assignedSubmissionIds.length} submission(s)`}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="capitalize">
                      {a.status}{' '}
                      {a.conflictDeclared
                        ? locale === 'ar'
                          ? '· تعارض معلن'
                          : '· Conflict Declared'
                        : ''}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleRemoveAssignment(a)}
                      className="text-red-500 hover:text-red-600 inline-flex items-center gap-1 disabled:opacity-50"
                      aria-label={locale === 'ar' ? 'إزالة التكليف' : 'Remove assignment'}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'results' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-lg font-semibold flex items-center gap-2">
              <Trophy className="h-5 w-5 text-amber-500" />
              <span>
                {locale === 'ar'
                  ? 'محرك التحكيم العادل والترتيب'
                  : 'Fair Judging Engine & Rankings'}
              </span>
            </h2>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleComputeResults}
                className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold"
              >
                {locale === 'ar' ? 'حساب الترتيب' : 'Compute Rankings'}
              </button>
              <button
                type="button"
                onClick={exportReport}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold"
              >
                <Download className="h-3.5 w-3.5" />
                <span>{locale === 'ar' ? 'تصدير التقرير' : 'Export Report'}</span>
              </button>
              {!resultsAlreadyPublished && (
                <>
                  <button
                    type="button"
                    disabled={busy || computedRankings.length === 0}
                    onClick={() => void handleSaveResults(false)}
                    className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold disabled:opacity-50"
                  >
                    {locale === 'ar' ? 'حفظ المسودة' : 'Save Draft'}
                  </button>
                  <button
                    type="button"
                    disabled={busy || computedRankings.length === 0}
                    onClick={() => void handleSaveResults(true)}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {locale === 'ar' ? 'نشر النتائج النهائية' : 'Publish Final Results'}
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs font-medium mb-1">
                {locale === 'ar' ? 'الهاكاثون' : 'Hackathon'}
              </label>
              <select
                value={selectedHackathonId}
                onChange={(e) => setSelectedHackathonId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              >
                {hackathons.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.title} ({h.status})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {locale === 'ar' ? 'العدد المتوقع للمحكمين/تسليم' : 'Expected Judges / Submission'}
              </label>
              <input
                type="number"
                min={1}
                max={20}
                value={expectedJudgesPerSub}
                onChange={(e) => setExpectedJudgesPerSub(Math.max(1, Number(e.target.value) || 1))}
                className="w-28 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm font-mono tabular-nums"
              />
            </div>
          </div>

          {resultsAlreadyPublished && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-300">
              {locale === 'ar'
                ? 'تم نشر النتائج النهائية لهذا الهاكاثون وقفله ضد أي تعديلات لاحقة.'
                : 'Official final rankings are published and immutably locked for this hackathon.'}
            </div>
          )}

          {computedRankings.length === 0 ? (
            <p className="text-sm text-slate-500">
              {locale === 'ar'
                ? 'اضغط "حساب الترتيب" لتجميع تقييمات المحكمين المستقلة مع فحص تباين الدرجات.'
                : 'Click "Compute Rankings" to aggregate independent human evaluations with disagreement spread checks.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                    <th className="py-2 text-start">{locale === 'ar' ? 'الترتيب' : 'Rank'}</th>
                    <th className="py-2 text-start">{locale === 'ar' ? 'المشروع' : 'Project'}</th>
                    <th className="py-2 text-start">{locale === 'ar' ? 'الفريق' : 'Team'}</th>
                    <th className="py-2 text-end">{locale === 'ar' ? 'المتوسط الخام' : 'Raw Avg'}</th>
                    <th className="py-2 text-end">{locale === 'ar' ? 'الدرجة المعيارية' : 'Normalized'}</th>
                    <th className="py-2 text-end">{locale === 'ar' ? 'المحكمون' : 'Judges'}</th>
                    <th className="py-2 text-start ps-4">{locale === 'ar' ? 'توضيح التدقيق' : 'Audit Explanation'}</th>
                  </tr>
                </thead>
                <tbody>
                  {computedRankings.map((r) => (
                    <tr key={r.submissionId} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="py-2.5 font-mono font-bold tabular-nums">#{r.rank}</td>
                      <td className="py-2.5 font-semibold">{r.projectTitle}</td>
                      <td className="py-2.5">{r.teamName}</td>
                      <td className="py-2.5 text-end font-mono tabular-nums">{r.averageScore.toFixed(2)}</td>
                      <td className="py-2.5 text-end font-mono tabular-nums">{r.normalizedScore.toFixed(2)}</td>
                      <td className="py-2.5 text-end font-mono tabular-nums">{r.judgeCount}</td>
                      <td className={`py-2.5 ps-4 ${r.anomalyFlag ? 'text-amber-500' : 'text-slate-500'}`}>
                        {r.explanation}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'admin' && isAdmin && (
        <div className="space-y-6">
          {/* Role Approvals */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
            <h2 className="font-display text-lg font-semibold flex items-center gap-2">
              <Shield className="h-5 w-5 text-blue-500" />
              <span>
                {locale === 'ar'
                  ? `طلبات ترقية الأدوار المعلقة (${pendingRoleUsers.length})`
                  : `Pending Role Requests (${pendingRoleUsers.length})`}
              </span>
            </h2>
            {pendingRoleUsers.length === 0 ? (
              <p className="text-sm text-slate-500">
                {locale === 'ar' ? 'لا توجد طلبات أدوار معلقة.' : 'No pending privileged role requests.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                      <th className="py-2 text-start">{locale === 'ar' ? 'المستخدم' : 'User'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'الدور المطلوب' : 'Requested'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'المعتمد حالياً' : 'Current Approved'}</th>
                      <th className="py-2 text-end">{locale === 'ar' ? 'الإجراءات' : 'Actions'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingRoleUsers.map((u) => (
                      <tr key={u.uid} className="border-b border-slate-100 dark:border-slate-800/60">
                        <td className="py-2.5 font-medium">{u.displayName}</td>
                        <td className="py-2.5 capitalize">{u.requestedRole}</td>
                        <td className="py-2.5 capitalize">{u.approvedRole}</td>
                        <td className="py-2.5 text-end space-x-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleAdminSetUserRole(u, u.requestedRole)}
                            className="text-emerald-600 font-semibold hover:underline disabled:opacity-50"
                          >
                            Grant {u.requestedRole}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleAdminSetUserRole(u, 'participant')}
                            className="text-red-500 font-semibold hover:underline disabled:opacity-50"
                          >
                            Keep Participant
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* All Users Role Control */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
            <h2 className="font-display text-base font-semibold">
              {locale === 'ar' ? `دليل المستخدمين (${allUsers.length})` : `All Platform Users (${allUsers.length})`}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                    <th className="py-2 text-start">{locale === 'ar' ? 'الاسم' : 'User'}</th>
                    <th className="py-2 text-start">{locale === 'ar' ? 'المطلوب' : 'Requested'}</th>
                    <th className="py-2 text-end">{locale === 'ar' ? 'الدور المعتمد' : 'Approved Role'}</th>
                  </tr>
                </thead>
                <tbody>
                  {allUsers.map((u) => (
                    <tr key={u.uid} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="py-2.5 font-medium">{u.displayName}</td>
                      <td className="py-2.5 capitalize">{u.requestedRole}</td>
                      <td className="py-2.5 text-end">
                        <select
                          disabled={busy}
                          value={u.approvedRole}
                          onChange={(e) => void handleAdminSetUserRole(u, e.target.value as AccountRole)}
                          className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2 py-1 text-xs"
                        >
                          <option value="participant">participant</option>
                          <option value="organizer">organizer</option>
                          <option value="judge">judge</option>
                          <option value="sponsor">sponsor</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* All Hackathons Moderation */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
            <h2 className="font-display text-base font-semibold">
              {locale === 'ar'
                ? `جميع الهاكاثونات (${allPlatformHackathons.length})`
                : `All Platform Hackathons (${allPlatformHackathons.length})`}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                    <th className="py-2 text-start">{locale === 'ar' ? 'العنوان' : 'Title'}</th>
                    <th className="py-2 text-start">{locale === 'ar' ? 'المنظم' : 'Organizer'}</th>
                    <th className="py-2 text-end">{locale === 'ar' ? 'الحالة' : 'Status'}</th>
                  </tr>
                </thead>
                <tbody>
                  {allPlatformHackathons.map((h) => (
                    <tr key={h.id} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="py-2.5 font-medium">{h.title}</td>
                      <td className="py-2.5">{h.organizerName}</td>
                      <td className="py-2.5 text-end">
                        <select
                          disabled={busy}
                          value={h.status}
                          onChange={(e) => void handleAdminHackathonStatus(h, e.target.value as HackathonStatus)}
                          className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2 py-1 text-xs"
                        >
                          <option value="draft">draft</option>
                          <option value="published">published</option>
                          <option value="judging">judging</option>
                          <option value="completed">completed</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Audit Logs */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
            <h2 className="font-display text-base font-semibold">
              {locale === 'ar' ? `سجل التدقيق (${auditLogs.length})` : `Platform Audit Log (${auditLogs.length})`}
            </h2>
            {auditLogs.length === 0 ? (
              <p className="text-xs text-slate-500">
                {locale === 'ar' ? 'لا توجد سجلات تدقيق بعد.' : 'No audit logs recorded yet.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                      <th className="py-2 text-start">{locale === 'ar' ? 'المنفذ' : 'Actor'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'الإجراء' : 'Action'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'الهدف' : 'Target'}</th>
                      <th className="py-2 text-start">{locale === 'ar' ? 'التفاصيل' : 'Details'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogs.slice(0, 50).map((log) => (
                      <tr key={log.id} className="border-b border-slate-100 dark:border-slate-800/60">
                        <td className="py-2 font-medium">{log.actorName || log.actorId}</td>
                        <td className="py-2 font-mono text-blue-600 dark:text-blue-400">{log.action}</td>
                        <td className="py-2 font-mono">{log.targetCollection}/{log.targetId}</td>
                        <td className="py-2 text-slate-600 dark:text-slate-300">{log.details}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
