import { useEffect, useState, type FormEvent } from 'react';
import { Plus, Send } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import {
  createNotification,
  listPublishedHackathons,
  listUserProjects,
  listUserSubmissions,
  listUserTeams,
  saveSubmission
} from '../services/firebase/firestoreService';
import type { Hackathon, Project, ProjectSubmission, Team } from '../types/domain';
import {
  generateFirestoreId,
  isDeadlinePassed,
  isValidGitHubRepoUrl,
  isValidHttpUrl
} from '../utils/validation';
import {
  loadOfflineDraftWork,
  saveOfflineDraftWork
} from '../services/hybridAI/inferenceManager';

export function SubmissionsPage() {
  const { user, emailVerified } = useAuth();
  const { locale, t } = useLanguage();

  const [hackathons, setHackathons] = useState<Hackathon[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [submissions, setSubmissions] = useState<ProjectSubmission[]>([]);

  const [editingSub, setEditingSub] = useState<ProjectSubmission | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [shortDescription, setShortDescription] = useState('');
  const [fullDescription, setFullDescription] = useState('');
  const [problemStatement, setProblemStatement] = useState('');
  const [proposedSolution, setProposedSolution] = useState('');
  const [techText, setTechText] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [demoUrl, setDemoUrl] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [screenshotUrlsText, setScreenshotUrlsText] = useState('');
  const [track, setTrack] = useState('');

  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const populateFromProject = (p: Project, tms: Team[]) => {
    const tm = tms.find((x) => x.id === p.teamId);
    setTitle(p.title);
    setProblemStatement(p.problemStatement || '');
    setProposedSolution(p.proposedSolution || '');
    setTechText((p.technologies || []).join(', '));
    setTrack(tm?.track || '');
  };

  const loadAll = async () => {
    if (!user) return;
    const [hacks, tms, projs, subs] = await Promise.all([
      listPublishedHackathons().catch(() => []),
      listUserTeams(user.uid).catch(() => []),
      listUserProjects(user.uid).catch(() => []),
      listUserSubmissions(user.uid).catch(() => [])
    ]);
    setHackathons(hacks);
    setTeams(tms);
    setProjects(projs);
    setSubmissions(subs);
    if (projs.length > 0 && !selectedProjectId) {
      setSelectedProjectId(projs[0].id);
      populateFromProject(projs[0], tms);
    }
  };

  useEffect(() => {
    void loadAll();
    const cached = loadOfflineDraftWork<{
      title?: string;
      shortDescription?: string;
      fullDescription?: string;
      githubUrl?: string;
      demoUrl?: string;
      videoUrl?: string;
    }>('submission_form');
    if (cached?.payload && !editingSub) {
      if (cached.payload.title) setTitle(cached.payload.title);
      if (cached.payload.shortDescription) setShortDescription(cached.payload.shortDescription);
      if (cached.payload.fullDescription) setFullDescription(cached.payload.fullDescription);
      if (cached.payload.githubUrl) setGithubUrl(cached.payload.githubUrl);
      if (cached.payload.demoUrl) setDemoUrl(cached.payload.demoUrl);
      if (cached.payload.videoUrl) setVideoUrl(cached.payload.videoUrl);
    }
  }, [user]);

  useEffect(() => {
    if (!editingSub && (title || shortDescription || fullDescription || githubUrl)) {
      saveOfflineDraftWork('submission_form', {
        title,
        shortDescription,
        fullDescription,
        githubUrl,
        demoUrl,
        videoUrl
      });
    }
  }, [editingSub, title, shortDescription, fullDescription, githubUrl, demoUrl, videoUrl]);

  const loadSubmissionForEdit = (sub: ProjectSubmission) => {
    setEditingSub(sub);
    setSelectedProjectId(sub.projectId);
    setTitle(sub.title);
    setShortDescription(sub.shortDescription);
    setFullDescription(sub.fullDescription);
    setProblemStatement(sub.problemStatement);
    setProposedSolution(sub.proposedSolution);
    setTechText((sub.technologies || []).join(', '));
    setGithubUrl(sub.githubUrl);
    setDemoUrl(sub.demoUrl);
    setVideoUrl(sub.videoUrl);
    setScreenshotUrlsText((sub.screenshotUrls || []).join('\n'));
    setTrack(sub.track);
    setErrorMsg('');
    setFeedback('');
  };

  const resetForNewSubmission = () => {
    setEditingSub(null);
    setShortDescription('');
    setFullDescription('');
    setGithubUrl('');
    setDemoUrl('');
    setVideoUrl('');
    setScreenshotUrlsText('');
    setErrorMsg('');
    setFeedback('');
    const p = projects.find((x) => x.id === selectedProjectId) || projects[0];
    if (p) {
      setSelectedProjectId(p.id);
      populateFromProject(p, teams);
    } else {
      setTitle('');
      setProblemStatement('');
      setProposedSolution('');
      setTechText('');
      setTrack('');
    }
  };

  const handleProjectSelectionChange = (projectId: string) => {
    setSelectedProjectId(projectId);
    if (!editingSub) {
      const p = projects.find((x) => x.id === projectId);
      if (p) populateFromProject(p, teams);
    }
  };

  const handleSaveSubmission = async (e: FormEvent, finalSubmit: boolean) => {
    e.preventDefault();
    if (!user || !emailVerified) {
      setErrorMsg(
        locale === 'ar'
          ? 'يلزم بريد إلكتروني موثق لتسليم المشروع.'
          : 'Verified email is required to submit a project.'
      );
      return;
    }
    setErrorMsg('');
    setFeedback('');

    const project = projects.find((p) => p.id === selectedProjectId);
    const team = teams.find((tm) => tm.id === (editingSub?.teamId || project?.teamId));
    const hackathon = hackathons.find(
      (h) => h.id === (editingSub?.hackathonId || project?.hackathonId)
    );

    if (!project || !team || !hackathon) {
      setErrorMsg(
        locale === 'ar'
          ? 'اختر مشروعاً مرتبطاً بفريق من مساحة المشاركين أولاً.'
          : 'Select a linked project from your Builder Workspace first.'
      );
      return;
    }

    if (editingSub && (editingSub.status === 'under_review' || editingSub.status === 'evaluated')) {
      setErrorMsg(
        locale === 'ar'
          ? `التسليم في حالة "${editingSub.status}" ومقفل للتحكيم.`
          : `This submission is currently "${editingSub.status}" and locked for judging.`
      );
      return;
    }

    if (hackathon.status !== 'published') {
      setErrorMsg(
        locale === 'ar'
          ? `التسليم مغلق لأن حالة الهاكاثون "${hackathon.status}".`
          : `Submissions are locked because hackathon status is "${hackathon.status}".`
      );
      return;
    }

    if (isDeadlinePassed(hackathon.submissionDeadline)) {
      setErrorMsg(
        locale === 'ar'
          ? `انتهى الموعد النهائي للتسليم (${hackathon.submissionDeadline}).`
          : `Submission deadline (${hackathon.submissionDeadline}) has passed.`
      );
      return;
    }

    if (finalSubmit && !isValidGitHubRepoUrl(githubUrl)) {
      setErrorMsg(
        locale === 'ar'
          ? 'مطلوب رابط مستودع GitHub صحيح (https://github.com/owner/repo) للتسليم النهائي.'
          : 'A valid GitHub repository URL (https://github.com/owner/repo) is required for final submission.'
      );
      return;
    }

    const screenshotUrls = screenshotUrlsText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6);

    for (const u of [githubUrl, demoUrl, videoUrl, ...screenshotUrls]) {
      if (u.trim() && !isValidHttpUrl(u)) {
        setErrorMsg(
          locale === 'ar'
            ? 'يجب أن تبدأ جميع الروابط بـ http:// أو https://.'
            : 'All URLs must use valid http:// or https:// format.'
        );
        return;
      }
    }

    if (title.trim().length < 2 || shortDescription.trim().length < 5) {
      setErrorMsg(
        locale === 'ar'
          ? 'عنوان المشروع والملخص القصير (5 أحرف على الأقل) مطلوبان.'
          : 'Title and short description (min 5 chars) are required.'
      );
      return;
    }

    setBusy(true);
    try {
      const subId = editingSub?.id || generateFirestoreId('sub');
      await saveSubmission(
        {
          id: subId,
          hackathonId: hackathon.id,
          organizerId: hackathon.organizerId,
          teamId: team.id,
          teamName: team.name,
          projectId: project.id,
          ownerId: editingSub?.ownerId || user.uid,
          memberIds: team.memberIds,
          memberNames: team.memberNames,
          title,
          shortDescription,
          fullDescription,
          problemStatement,
          proposedSolution,
          technologies: techText.split(',').map((s) => s.trim()).filter(Boolean),
          githubUrl,
          demoUrl,
          videoUrl,
          screenshotUrls,
          track: track || team.track || hackathon.tracks?.[0] || 'General',
          status: finalSubmit ? 'submitted' : 'draft',
          submittedAt: editingSub?.submittedAt
        },
        !editingSub
      );

      if (finalSubmit) {
        await createNotification({
          userId: user.uid,
          type: 'submission',
          title: `Project Submitted: ${title}`,
          message: `Your final submission for ${hackathon.title} has been recorded.`,
          link: '/app/submissions'
        }).catch(() => {});
      }

      await loadAll();
      setFeedback(
        finalSubmit
          ? locale === 'ar'
            ? 'تم تسليم المشروع النهائي للتحكيم!'
            : 'Project submitted for judging!'
          : locale === 'ar'
            ? 'تم حفظ مسودة التسليم.'
            : 'Submission draft saved.'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save submission');
    } finally {
      setBusy(false);
    }
  };

  const selectedProjObj = projects.find((p) => p.id === selectedProjectId);
  const selectedHackObj = hackathons.find(
    (h) => h.id === (editingSub?.hackathonId || selectedProjObj?.hackathonId)
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
          {t.sidebar.submissions}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {locale === 'ar'
            ? 'تحقق من الروابط والمواعيد النهائية قبل التسليم النهائي للتحكيم.'
            : 'Draft, validate URLs, enforce deadlines, and submit your team deliverables for evaluation.'}
        </p>
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

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-base font-semibold">
              {locale === 'ar' ? 'تسليمات الفريق' : 'Team Submissions'} ({submissions.length})
            </h2>
            {editingSub && (
              <button
                type="button"
                onClick={resetForNewSubmission}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs font-medium"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{locale === 'ar' ? 'تسليم جديد' : 'New Submission'}</span>
              </button>
            )}
          </div>
          {submissions.length === 0 ? (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 text-xs text-slate-500">
              {locale === 'ar'
                ? 'لا توجد تسليمات بعد. أنشئ مشروعاً في مساحة المشاركين ثم أعد تسليمك هنا.'
                : 'No submissions yet. Create a project in Builder Workspace, then prepare your submission here.'}
            </div>
          ) : (
            submissions.map((sub) => (
              <button
                key={sub.id}
                type="button"
                onClick={() => loadSubmissionForEdit(sub)}
                className={`w-full text-start rounded-xl border p-4 space-y-1 ${
                  editingSub?.id === sub.id
                    ? 'border-blue-500 bg-blue-500/5'
                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]'
                }`}
              >
                <div className="text-xs text-blue-500 font-mono capitalize">{sub.status}</div>
                <div className="font-semibold text-sm text-slate-900 dark:text-white">
                  {sub.title}
                </div>
                <div className="text-xs text-slate-500">
                  {sub.teamName} · {sub.track}
                </div>
              </button>
            ))
          )}
        </div>

        <form
          onSubmit={(e) => void handleSaveSubmission(e, false)}
          className="lg:col-span-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4"
        >
          {selectedHackObj && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070B14] px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">{selectedHackObj.title}</span>
              <span className="font-mono text-slate-500">
                {locale === 'ar' ? 'موعد التسليم:' : 'Due:'}{' '}
                {selectedHackObj.submissionDeadline || (locale === 'ar' ? 'مفتوح' : 'Open')}
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">
                {locale === 'ar' ? 'المشروع المرتبط' : 'Linked Project'}
              </label>
              <select
                value={selectedProjectId}
                onChange={(e) => handleProjectSelectionChange(e.target.value)}
                disabled={Boolean(editingSub)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm disabled:opacity-60"
              >
                <option value="">
                  {locale === 'ar' ? 'اختر مشروعاً...' : 'Select project...'}
                </option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {locale === 'ar' ? 'مسار المنافسة' : 'Competition Track'}
              </label>
              <input
                type="text"
                value={track}
                onChange={(e) => setTrack(e.target.value)}
                placeholder="Hybrid Edge AI"
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">
                {locale === 'ar' ? 'عنوان المشروع' : 'Project Title'}
              </label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {locale === 'ar' ? 'ملخص قصير (حد أقصى 300 حرف)' : 'Short Pitch (max 300 chars)'}
              </label>
              <input
                type="text"
                required
                maxLength={300}
                value={shortDescription}
                onChange={(e) => setShortDescription(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">
              {locale === 'ar' ? 'الوصف التقني الكامل' : 'Full Technical Description'}
            </label>
            <textarea
              rows={4}
              value={fullDescription}
              onChange={(e) => setFullDescription(e.target.value)}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">
                {locale === 'ar' ? 'وصف المشكلة' : 'Problem Statement'}
              </label>
              <textarea
                rows={2}
                value={problemStatement}
                onChange={(e) => setProblemStatement(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {locale === 'ar' ? 'الحل المقترح' : 'Proposed Solution'}
              </label>
              <textarea
                rows={2}
                value={proposedSolution}
                onChange={(e) => setProposedSolution(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">
                {locale === 'ar' ? 'رابط مستودع GitHub' : 'GitHub Repository URL'}
              </label>
              <input
                type="url"
                placeholder="https://github.com/org/repo"
                value={githubUrl}
                onChange={(e) => setGithubUrl(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {locale === 'ar' ? 'رابط العرض المباشر' : 'Live Demo URL'}
              </label>
              <input
                type="url"
                placeholder="https://demo.example.com"
                value={demoUrl}
                onChange={(e) => setDemoUrl(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {locale === 'ar' ? 'رابط فيديو العرض' : 'Demo Video URL'}
              </label>
              <input
                type="url"
                placeholder="https://youtu.be/..."
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">
                {locale === 'ar'
                  ? 'التقنيات المستخدمة (مفصولة بفاصلة)'
                  : 'Technologies (comma-separated)'}
              </label>
              <input
                type="text"
                value={techText}
                onChange={(e) => setTechText(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {locale === 'ar'
                  ? 'روابط صور الواجهة (حتى 6 روابط، كل رابط في سطر)'
                  : 'Screenshot URLs (up to 6, one per line)'}
              </label>
              <textarea
                rows={2}
                value={screenshotUrlsText}
                onChange={(e) => setScreenshotUrlsText(e.target.value)}
                placeholder="https://..."
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
              />
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-3 pt-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold"
            >
              {locale === 'ar' ? 'حفظ المسودة' : 'Save Draft'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={(e) => void handleSaveSubmission(e, true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-5 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              <span>{locale === 'ar' ? 'تسليم المشروع نهائياً' : 'Submit Final Project'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
