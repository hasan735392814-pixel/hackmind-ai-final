import { useEffect, useState } from 'react';
import { InferenceMode } from 'firebase/ai';
import { RotateCcw, Sparkles } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { listUserProjects, saveProject } from '../services/firebase/firestoreService';
import {
  executeHybridInference,
  loadOfflineDraftWork,
  saveOfflineDraftWork
} from '../services/hybridAI/inferenceManager';
import { buildTaskPrompt } from '../services/hybridAI/promptRegistry';
import type { AITaskKey, HybridExecutionResult } from '../services/hybridAI/types';
import type { Project, ProjectTask } from '../types/domain';
import { generateFirestoreId } from '../utils/validation';
import { InferenceResultBanner } from '../components/common/InferenceBadge';
import { InferenceModeSelector } from '../components/common/InferenceModeSelector';

interface MentorPayload {
  title?: string;
  targetUsers?: string;
  problemStatement?: string;
  proposedSolution?: string;
  coreTechnologies?: string[];
  feasibilityNotes?: string;
  roadmap?: string[];
  tasks?: { title: string; role: string; priority: string }[];
  risks?: string[];
  shortPitch?: string;
  presentationOutline?: string[];
  submissionImprovements?: string[];
}

export function AIMentorPage() {
  const { user, privateInfo, emailVerified, updateCloudConsent } = useAuth();
  const { locale, t } = useLanguage();

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [workflow, setWorkflow] = useState<'mentor_ideation' | 'mentor_roadmap' | 'mentor_pitch'>(
    'mentor_ideation'
  );
  const [mode, setMode] = useState<InferenceMode>(InferenceMode.PREFER_ON_DEVICE);
  const [promptInput, setPromptInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HybridExecutionResult<MentorPayload> | null>(null);
  const [savedNotice, setSavedNotice] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!user) return;
    void listUserProjects(user.uid)
      .then((list) => {
        setProjects(list);
        if (list.length > 0) setSelectedProjectId(list[0].id);
      })
      .catch(() => setProjects([]));

    const cached = loadOfflineDraftWork<{ promptInput: string; workflow: AITaskKey }>('mentor');
    if (cached?.payload?.promptInput) {
      setPromptInput(cached.payload.promptInput);
    }
    const wf = cached?.payload?.workflow;
    if (wf === 'mentor_ideation' || wf === 'mentor_roadmap' || wf === 'mentor_pitch') {
      setWorkflow(wf);
      setMode(wf === 'mentor_roadmap' ? InferenceMode.PREFER_IN_CLOUD : InferenceMode.PREFER_ON_DEVICE);
    }
  }, [user]);

  useEffect(() => {
    saveOfflineDraftWork('mentor', { promptInput, workflow });
  }, [promptInput, workflow]);

  const handleWorkflowChange = (next: 'mentor_ideation' | 'mentor_roadmap' | 'mentor_pitch') => {
    setWorkflow(next);
    setMode(
      next === 'mentor_roadmap' ? InferenceMode.PREFER_IN_CLOUD : InferenceMode.PREFER_ON_DEVICE
    );
  };

  const selectedProject = projects.find((p) => p.id === selectedProjectId) || null;

  const runMentor = async () => {
    if (!promptInput.trim() && !selectedProject) {
      setErrorMsg(
        locale === 'ar'
          ? 'أدخل فكرة أو اختر مشروعاً قائماً أولاً.'
          : 'Enter an idea or select an existing project first.'
      );
      return;
    }
    setErrorMsg('');
    setSavedNotice('');
    setBusy(true);
    try {
      const prompt = buildTaskPrompt(
        workflow,
        {
          userNotes: promptInput,
          project: selectedProject
            ? {
                title: selectedProject.title,
                problemStatement: selectedProject.problemStatement,
                proposedSolution: selectedProject.proposedSolution,
                technologies: selectedProject.technologies
              }
            : null
        },
        locale
      );

      const res = await executeHybridInference<MentorPayload>({
        taskKey: workflow,
        prompt,
        preferredMode: mode,
        locale,
        cloudConsentGranted: Boolean(privateInfo?.aiCloudConsent),
        userId: user?.uid,
        emailVerified
      });
      setResult(res);
      if (!res.ok) {
        setErrorMsg(
          res.errorMessage ||
            (locale === 'ar' ? 'فشل تنفيذ المرشد الذكي.' : 'Mentor execution failed.')
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const handleApproveAndSave = async () => {
    if (!user || !selectedProject || !result?.ok || !result.data || !emailVerified) {
      setErrorMsg(
        locale === 'ar'
          ? 'اختر مشروعاً وتأكد من توثيق بريدك الإلكتروني لحفظ مخرجات الذكاء المعتمدة.'
          : 'Select a project and ensure your email is verified to save approved AI outputs.'
      );
      return;
    }

    const d = result.data;
    const existingTasks = selectedProject.tasks || [];
    const existingTitles = new Set(existingTasks.map((tk) => tk.title.trim().toLowerCase()));
    const newTasks: ProjectTask[] = (d.tasks || [])
      .map((tk) => ({
        id: generateFirestoreId('tsk'),
        title: `${tk.title} (${tk.role})`,
        assigneeName: tk.role || 'Team',
        status: 'todo' as const,
        dueDate: ''
      }))
      .filter((tk) => !existingTitles.has(tk.title.trim().toLowerCase()));

    const nextTasks: ProjectTask[] = [...existingTasks, ...newTasks].slice(0, 30);

    const summaryAdditions = [
      d.feasibilityNotes ? `Feasibility: ${d.feasibilityNotes}` : '',
      d.shortPitch ? `Pitch: ${d.shortPitch}` : '',
      d.risks?.length ? `Risks: ${d.risks.join('; ')}` : '',
      d.submissionImprovements?.length
        ? `Submission Checklist: ${d.submissionImprovements.join('; ')}`
        : ''
    ]
      .filter(Boolean)
      .join('\n');

    setBusy(true);
    setErrorMsg('');
    try {
      await saveProject(
        {
          ...selectedProject,
          problemStatement: selectedProject.problemStatement || d.problemStatement || '',
          proposedSolution: selectedProject.proposedSolution || d.proposedSolution || '',
          targetUsers: selectedProject.targetUsers || d.targetUsers || '',
          technologies: Array.from(
            new Set([...(selectedProject.technologies || []), ...(d.coreTechnologies || [])])
          ).slice(0, 15),
          roadmap: d.roadmap?.length ? d.roadmap.slice(0, 20) : selectedProject.roadmap,
          tasks: nextTasks,
          aiMentorApprovedSummary: [selectedProject.aiMentorApprovedSummary, summaryAdditions]
            .filter(Boolean)
            .join('\n\n')
            .slice(0, 5000)
        },
        false
      );

      const refreshed = await listUserProjects(user.uid);
      setProjects(refreshed);
      setSavedNotice(
        locale === 'ar'
          ? 'تمت إضافة مخرجات المرشد المعتمدة إلى مشروعك في Firestore دون مسح حقولك الحالية.'
          : 'Approved mentor output appended to your Firestore project without overwriting existing fields.'
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : locale === 'ar'
            ? 'تعذر حفظ مخرجات المرشد في المشروع.'
            : 'Failed to append AI Mentor output to project'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
          {t.sidebar.mentor}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {locale === 'ar'
            ? 'مساعد هجين لصياغة الأفكار، بناء خارطة الطريق، وتحسين العرض النهائي مع حفظ محلي للمسودات.'
            : 'Hybrid AI Mentor for lightweight on-device ideation/pitch checks and cloud roadmap planning. Drafts persist locally offline.'}
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex flex-wrap gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900 p-1">
            <button
              type="button"
              onClick={() => handleWorkflowChange('mentor_ideation')}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                workflow === 'mentor_ideation' ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              {locale === 'ar' ? '١. الفكرة وملاءمة المشكلة' : '1. Idea & Problem Fit'}
            </button>
            <button
              type="button"
              onClick={() => handleWorkflowChange('mentor_roadmap')}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                workflow === 'mentor_roadmap' ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              {locale === 'ar' ? '٢. خارطة الطريق والمهام' : '2. Roadmap & Tasks'}
            </button>
            <button
              type="button"
              onClick={() => handleWorkflowChange('mentor_pitch')}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                workflow === 'mentor_pitch' ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              {locale === 'ar' ? '٣. العرض التقديمي والتوثيق' : '3. Pitch & Docs Polish'}
            </button>
          </div>

          <select
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-1.5 text-xs"
          >
            <option value="">
              {locale === 'ar' ? 'بدون ربط بمشروع (مسودة مستقلة)' : 'No project linked (standalone draft)'}
            </option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {locale === 'ar' ? `المشروع: ${p.title}` : `Project: ${p.title}`}
              </option>
            ))}
          </select>
        </div>

        <InferenceModeSelector
          mode={mode}
          onChange={setMode}
          cloudConsent={Boolean(privateInfo?.aiCloudConsent)}
          onGrantConsent={() => updateCloudConsent(true)}
        />

        <textarea
          rows={4}
          value={promptInput}
          onChange={(e) => setPromptInput(e.target.value)}
          placeholder={
            locale === 'ar'
              ? 'اوصف فكرة الهاكاثون، الفئة المستهدفة، القيود، أو ما تريد أن ينظمه لك المرشد...'
              : 'Describe your hackathon idea, target users, constraints, or what you want the mentor to structure...'
          }
          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-slate-500">
            {locale === 'ar'
              ? 'يتم حفظ المسودة تلقائياً محلياً في تخزين المتصفح.'
              : 'Draft automatically saved locally in browser storage.'}
          </span>
          <div className="flex gap-2">
            {result && !result.ok && (
              <button
                type="button"
                onClick={() => void runMentor()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-semibold"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>{t.common.retry}</span>
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void runMentor()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-5 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>
                {busy
                  ? t.common.loading
                  : locale === 'ar'
                    ? 'تشغيل المرشد الذكي'
                    : 'Run AI Mentor'}
              </span>
            </button>
          </div>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
          {errorMsg}
        </div>
      )}
      {savedNotice && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-300">
          {savedNotice}
        </div>
      )}

      {result && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
          <InferenceResultBanner result={result} />

          {result.ok && result.data && (
            <div className="space-y-4 text-sm">
              {result.data.title && (
                <div>
                  <div className="text-xs text-slate-500">
                    {locale === 'ar' ? 'العنوان المقترح' : 'Suggested Title'}
                  </div>
                  <div className="font-semibold">{result.data.title}</div>
                </div>
              )}
              {result.data.problemStatement && (
                <div>
                  <div className="text-xs text-slate-500">
                    {locale === 'ar' ? 'بيان المشكلة' : 'Problem Statement'}
                  </div>
                  <p className="text-slate-700 dark:text-slate-300">{result.data.problemStatement}</p>
                </div>
              )}
              {result.data.proposedSolution && (
                <div>
                  <div className="text-xs text-slate-500">
                    {locale === 'ar' ? 'الحل المقترح' : 'Proposed Solution'}
                  </div>
                  <p className="text-slate-700 dark:text-slate-300">{result.data.proposedSolution}</p>
                </div>
              )}
              {result.data.roadmap && result.data.roadmap.length > 0 && (
                <div>
                  <div className="text-xs text-slate-500 mb-1">
                    {locale === 'ar' ? 'خارطة طريق التطوير' : 'Development Roadmap'}
                  </div>
                  <ol className="list-decimal ps-5 space-y-1 text-xs text-slate-700 dark:text-slate-300">
                    {result.data.roadmap.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </div>
              )}
              {result.data.tasks && result.data.tasks.length > 0 && (
                <div>
                  <div className="text-xs text-slate-500 mb-1">
                    {locale === 'ar' ? 'المهام القابلة للتنفيذ' : 'Actionable Tasks'}
                  </div>
                  <ul className="space-y-1 text-xs">
                    {result.data.tasks.map((tk) => (
                      <li key={tk.title} className="rounded border border-slate-200 dark:border-slate-800 px-3 py-1.5">
                        <span className="font-semibold">{tk.title}</span> — {tk.role} ({tk.priority})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {result.data.shortPitch && (
                <div>
                  <div className="text-xs text-slate-500">
                    {locale === 'ar' ? 'العرض الموجز' : 'Short Pitch'}
                  </div>
                  <p className="text-slate-700 dark:text-slate-300">{result.data.shortPitch}</p>
                </div>
              )}
              {result.data.submissionImprovements && result.data.submissionImprovements.length > 0 && (
                <div>
                  <div className="text-xs text-slate-500 mb-1">
                    {locale === 'ar' ? 'قائمة فحص التسليم' : 'Submission Checklist'}
                  </div>
                  <ul className="list-disc ps-5 space-y-1 text-xs text-slate-700 dark:text-slate-300">
                    {result.data.submissionImprovements.map((imp) => (
                      <li key={imp}>{imp}</li>
                    ))}
                  </ul>
                </div>
              )}

              {selectedProject && (
                <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-end">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleApproveAndSave()}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {locale === 'ar' ? 'اعتماد وإضافة إلى المشروع' : 'Approve & Append to Project'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
