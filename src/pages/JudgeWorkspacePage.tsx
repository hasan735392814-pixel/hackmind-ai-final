import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { InferenceMode } from 'firebase/ai';
import { AlertTriangle, ArrowRight, ExternalLink, Gavel, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import {
  getHackathonById,
  listJudgeAssignedSubmissions,
  listJudgeAssignmentsByJudge,
  listJudgeEvaluations,
  saveEvaluation,
  updateJudgeAssignmentResponse
} from '../services/firebase/firestoreService';
import {
  redactSecrets,
  type GitHubRepoInspection
} from '../services/github/repoInspector';
import type { HybridExecutionResult } from '../services/hybridAI/types';
import type {
  AuditExecutionStatus,
  BatchAnalysisProgress,
  ComprehensiveJudgingReport,
  StageExecutionState
} from '../services/judging/evidenceTypes';
import type { StructuredAIAuditOutput } from '../services/judging/evidenceVerifier';
import {
  getSavedAnalysisCheckpoint,
  runResumableJudgeAnalysis,
  type PersistentBatchCheckpoint
} from '../services/judging/batchAnalysisCoordinator';
import {
  calculateDraftWeightedPreview,
  clearHumanCriterionScore,
  initializeHumanCriteriaScores,
  JudgeWorkspaceRunCoordinator,
  setHumanCriterionScore,
  validateEvaluationSubmission,
  type DraftCriterionScore
} from '../services/judging/fairJudgingEngine';
import type {
  Evaluation,
  Hackathon,
  JudgeAssignment,
  ProjectSubmission
} from '../types/domain';
import { InferenceResultBanner } from '../components/common/InferenceBadge';
import { ComprehensiveEvidencePanel } from '../components/judging/ComprehensiveEvidencePanel';

interface AIJudgeEvidence {
  verifiedEvidence?: string[];
  teamClaims?: string[];
  missingEvidence?: string[];
  technicalObservations?: string[];
  potentialRisks?: string[];
  suggestedQuestions?: string[];
  inspectedSources?: string[];
  uninspectedSources?: string[];
}

function sanitizeStringArray(val: unknown, maxItems = 12): string[] {
  if (!Array.isArray(val)) return [];
  return val
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => redactSecrets(item.trim()).sanitized)
    .filter((item) => item.length > 0)
    .slice(0, maxItems);
}

function normalizeAIJudgeEvidence(raw: unknown): AIJudgeEvidence | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const normalized: AIJudgeEvidence = {
    verifiedEvidence: sanitizeStringArray(obj.verifiedEvidence),
    teamClaims: sanitizeStringArray(obj.teamClaims),
    missingEvidence: sanitizeStringArray(obj.missingEvidence),
    technicalObservations: sanitizeStringArray(obj.technicalObservations),
    potentialRisks: sanitizeStringArray(obj.potentialRisks),
    suggestedQuestions: sanitizeStringArray(obj.suggestedQuestions),
    inspectedSources: sanitizeStringArray(obj.inspectedSources, 24),
    uninspectedSources: sanitizeStringArray(obj.uninspectedSources, 24)
  };
  const hasAnyValidArray =
    'verifiedEvidence' in obj ||
    'teamClaims' in obj ||
    'missingEvidence' in obj ||
    'technicalObservations' in obj ||
    'potentialRisks' in obj ||
    'suggestedQuestions' in obj;
  return hasAnyValidArray ? normalized : null;
}

function compactAIReportForStorage(report: AIJudgeEvidence, maxChars = 5800): string {
  const scrub = (arr?: string[]) =>
    (arr || []).map((item) => redactSecrets(item).sanitized);
  const clone: AIJudgeEvidence = {
    verifiedEvidence: scrub(report.verifiedEvidence),
    teamClaims: scrub(report.teamClaims),
    missingEvidence: scrub(report.missingEvidence),
    technicalObservations: scrub(report.technicalObservations),
    potentialRisks: scrub(report.potentialRisks),
    suggestedQuestions: scrub(report.suggestedQuestions),
    inspectedSources: scrub(report.inspectedSources),
    uninspectedSources: scrub(report.uninspectedSources)
  };
  let serialized = JSON.stringify(clone);
  if (serialized.length <= maxChars) return serialized;

  const keys: Array<keyof AIJudgeEvidence> = [
    'suggestedQuestions',
    'potentialRisks',
    'technicalObservations',
    'missingEvidence',
    'teamClaims',
    'verifiedEvidence',
    'uninspectedSources',
    'inspectedSources'
  ];

  // Progressively trim list lengths while keeping valid JSON under Firestore's 6000-char limit
  for (let limit = 6; limit >= 1 && serialized.length > maxChars; limit--) {
    for (const k of keys) {
      if ((clone[k]?.length || 0) > limit) {
        clone[k] = clone[k]!.slice(0, limit);
      }
    }
    serialized = JSON.stringify(clone);
  }
  return serialized.length <= maxChars ? serialized : JSON.stringify({ inspectedSources: clone.inspectedSources?.slice(0, 8) || [] });
}

function parseSavedAIReport(raw?: string): AIJudgeEvidence | null {
  if (!raw || !raw.trim()) return null;
  try {
    return normalizeAIJudgeEvidence(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function JudgeWorkspacePage() {
  const { user, profile, emailVerified } = useAuth();
  const { locale, t } = useLanguage();
  const inRouter = useInRouterContext();

  const [assignments, setAssignments] = useState<JudgeAssignment[]>([]);
  const [hackathonMap, setHackathonMap] = useState<Record<string, Hackathon>>({});
  const [submissions, setSubmissions] = useState<ProjectSubmission[]>([]);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [activeSubmission, setActiveSubmission] = useState<ProjectSubmission | null>(null);
  const [activeHackathon, setActiveHackathon] = useState<Hackathon | null>(null);

  const [repoInfo, setRepoInfo] = useState<GitHubRepoInspection | null>(null);
  const [comprehensiveReport, setComprehensiveReport] = useState<ComprehensiveJudgingReport | null>(
    null
  );
  const [attachedTestLog, setAttachedTestLog] = useState('');
  const [aiResult, setAiResult] = useState<HybridExecutionResult<StructuredAIAuditOutput> | null>(
    null
  );
  const [persistedAIReport, setPersistedAIReport] = useState<AIJudgeEvidence | null>(null);
  const [persistedAISource, setPersistedAISource] = useState('');

  const [criteriaScores, setCriteriaScores] = useState<DraftCriterionScore[]>([]);
  const [conflictOfInterest, setConflictOfInterest] = useState(false);
  const [conflictReason, setConflictReason] = useState('');
  const [humanFeedback, setHumanFeedback] = useState('');
  const [showAllUninspected, setShowAllUninspected] = useState(false);

  const [busy, setBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [assignmentBusy, setAssignmentBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<string>('');
  const [analysisProgressState, setAnalysisProgressState] = useState<BatchAnalysisProgress | null>(null);
  const [lastAuditStatus, setLastAuditStatus] = useState<AuditExecutionStatus | null>(null);
  const [savedCheckpoint, setSavedCheckpoint] = useState<PersistentBatchCheckpoint | null>(null);
  const [confirmRestartOpen, setConfirmRestartOpen] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const runCoordinatorRef = useRef(new JudgeWorkspaceRunCoordinator());

  const evaluationsRef = useRef(evaluations);
  const hackathonMapRef = useRef(hackathonMap);
  useEffect(() => {
    evaluationsRef.current = evaluations;
    hackathonMapRef.current = hackathonMap;
  }, [evaluations, hackathonMap]);

  const selectSubmission = useCallback(
    async (
      sub: ProjectSubmission,
      evalList = evaluationsRef.current,
      knownHackathons = hackathonMapRef.current,
      options: { preserveMessages?: boolean; ignoreSaveGuard?: boolean } = {}
    ) => {
      if (!options.ignoreSaveGuard && runCoordinatorRef.current.isSaving) {
        return;
      }
      const selectionSeq = runCoordinatorRef.current.beginSubmissionSwitch(sub.id);
      setAiBusy(false);
      if (!runCoordinatorRef.current.isSaving) {
        setBusy(false);
      }
      setAnalysisProgress('');
      setAnalysisProgressState(null);
      setLastAuditStatus(null);
      setConfirmRestartOpen(false);
      setShowAllUninspected(false);
      setActiveSubmission(sub);
      setRepoInfo(null);
      setComprehensiveReport(null);
      setAttachedTestLog('');
      setAiResult(null);
      setSavedCheckpoint(getSavedAnalysisCheckpoint(sub.id));
      if (!options.preserveMessages) {
        setStatusMsg('');
        setErrorMsg('');
      }

      const hack =
        knownHackathons[sub.hackathonId] || (await getHackathonById(sub.hackathonId).catch(() => null));
      if (!runCoordinatorRef.current.isCurrentSelection(selectionSeq)) {
        return;
      }
      setActiveHackathon(hack);

      const existingEval = evalList.find((e) => e.submissionId === sub.id);
      setCriteriaScores(initializeHumanCriteriaScores(hack?.rubric || [], existingEval || null));
      if (existingEval) {
        setConflictOfInterest(existingEval.conflictOfInterest);
        setConflictReason(existingEval.conflictReason);
        setHumanFeedback(existingEval.humanFeedback);
        setPersistedAIReport(parseSavedAIReport(existingEval.aiReportSummary));
        setPersistedAISource(existingEval.aiInferenceSource || '');
      } else {
        setConflictOfInterest(false);
        setConflictReason('');
        setHumanFeedback('');
        setPersistedAIReport(null);
        setPersistedAISource('');
      }
    },
    []
  );

  const loadJudgeData = useCallback(
    async (
      preferredSubmissionId?: string | null,
      options: { preserveMessages?: boolean; preserveSelectionIfUnchanged?: boolean } = {}
    ) => {
      if (!user) return;
      const loadSeq = runCoordinatorRef.current.beginLoad();
      const [assigns, subs, evals] = await Promise.all([
        listJudgeAssignmentsByJudge(user.uid).catch(() => []),
        listJudgeAssignedSubmissions(user.uid).catch(() => []),
        listJudgeEvaluations(user.uid).catch(() => [])
      ]);
      if (!runCoordinatorRef.current.isCurrentLoad(loadSeq)) return;

      const uniqueHackIds = Array.from(
        new Set([...assigns.map((a) => a.hackathonId), ...subs.map((s) => s.hackathonId)])
      );
      const resolvedHackathons = await Promise.all(
        uniqueHackIds.map(async (hid) => [hid, await getHackathonById(hid).catch(() => null)] as const)
      );
      if (!runCoordinatorRef.current.isCurrentLoad(loadSeq)) return;

      const nextMap: Record<string, Hackathon> = {};
      for (const [hid, hack] of resolvedHackathons) {
        if (hack) nextMap[hid] = hack;
      }

      setHackathonMap(nextMap);
      setAssignments(assigns);
      setSubmissions(subs);
      setEvaluations(evals);

      const targetId = preferredSubmissionId ?? runCoordinatorRef.current.currentSubmissionId;
      if (subs.length > 0) {
        const stillActive = targetId ? subs.find((s) => s.id === targetId) : undefined;
        const resolvedSub = stillActive || subs[0];
        if (
          options.preserveSelectionIfUnchanged &&
          runCoordinatorRef.current.currentSubmissionId &&
          resolvedSub.id === runCoordinatorRef.current.currentSubmissionId
        ) {
          const refreshedHack = nextMap[resolvedSub.hackathonId] || null;
          if (refreshedHack) setActiveHackathon(refreshedHack);
          return;
        }
        await selectSubmission(resolvedSub, evals, nextMap, {
          preserveMessages: options.preserveMessages,
          ignoreSaveGuard: true
        });
      } else {
        runCoordinatorRef.current.beginSubmissionSwitch(null);
        setActiveSubmission(null);
        setActiveHackathon(null);
      }
    },
    [user, selectSubmission]
  );

  useEffect(() => {
    runCoordinatorRef.current = new JudgeWorkspaceRunCoordinator();
    void loadJudgeData();
    return () => {
      runCoordinatorRef.current.dispose();
    };
  }, [loadJudgeData]);

  const formatBatchProgress = (progress: BatchAnalysisProgress): string => {
    const fetchedSuffixEn =
      typeof progress.filesFetchedSoFar === 'number' &&
      progress.filesFetchedSoFar > progress.filesInspectedSoFar
        ? `, ${progress.filesFetchedSoFar} fetched`
        : '';
    const fetchedSuffixAr =
      typeof progress.filesFetchedSoFar === 'number' &&
      progress.filesFetchedSoFar > progress.filesInspectedSoFar
        ? `، ${progress.filesFetchedSoFar} تم تنزيلها`
        : '';
    const detailSuffix = progress.detail ? ` — ${progress.detail}` : '';

    if (locale === 'ar') {
      switch (progress.stage) {
        case 'discovering_repo':
          return '1/4 جارٍ استكشاف شجرة المستودع وفحص العرض الحي بأمان...';
        case 'probing_demo':
          return '1/4 جارٍ فحص رابط العرض المباشر...';
        case 'checking_ci':
          return `2/4 ${progress.detail || 'جارٍ فحص سجلات اختبارات GitHub Actions المرتبطة بالـ commit...'}`;
        case 'running_batch':
          return `3/4 جارٍ تدقيق الدفعة ${progress.currentBatch}/${progress.totalBatches} (${progress.filesInspectedSoFar}/${progress.totalEligibleFiles || '?'} ملفات مدققة${fetchedSuffixAr})${detailSuffix}`;
        case 'merging_report':
          return '4/4 جارٍ دمج نتائج الدفعات والتحقق من صحة التقرير...';
        case 'interrupted':
          return `توقف عند الدفعة ${progress.currentBatch}/${progress.totalBatches}`;
        case 'completed':
          return `اكتمل تدقيق ${progress.totalBatches}/${progress.totalBatches} دفعة.`;
      }
    }
    switch (progress.stage) {
      case 'discovering_repo':
        return '1/4 Discovering repository file tree & running safe live demo probe...';
      case 'probing_demo':
        return '1/4 Probing live demo endpoint safely...';
      case 'checking_ci':
        return `2/4 ${progress.detail || 'Checking commit-pinned GitHub Actions test workflows...'}`;
      case 'running_batch':
        return `3/4 Auditing batch ${progress.currentBatch}/${progress.totalBatches} (${progress.filesInspectedSoFar}/${progress.totalEligibleFiles || '?'} audited${fetchedSuffixEn})${detailSuffix}`;
      case 'merging_report':
        return '4/4 Merging schema-validated batch outputs & building audit report...';
      case 'interrupted':
        return `Paused at batch ${progress.currentBatch}/${progress.totalBatches}`;
      case 'completed':
        return `Completed ${progress.totalBatches}/${progress.totalBatches} batch(es).`;
    }
  };

  const renderStageChip = (label: string, state?: StageExecutionState) => {
    const resolved = state || 'pending';
    const cls =
      resolved === 'completed'
        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
        : resolved === 'active'
          ? 'border-blue-500/50 bg-blue-500/20 text-blue-700 dark:text-blue-200 animate-pulse'
          : resolved === 'skipped'
            ? 'border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300'
            : resolved === 'failed'
              ? 'border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300'
              : resolved === 'interrupted'
                ? 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300'
                : 'border-slate-300/60 dark:border-slate-700 bg-white/50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400';
    return (
      <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${cls}`}>
        <span>{label}:</span>
        <span className="uppercase">{resolved}</span>
      </span>
    );
  };

  const handleCancelAnalysis = () => {
    const cancelled = runCoordinatorRef.current.cancelAnalysis();
    setAiBusy(false);
    setBusy(false);
    setConfirmRestartOpen(false);
    setAnalysisProgress('');
    setAnalysisProgressState(null);
    if (activeSubmission) {
      setSavedCheckpoint(getSavedAnalysisCheckpoint(activeSubmission.id));
    }
    if (cancelled) {
      setLastAuditStatus('INTERRUPTED');
      setStatusMsg(locale === 'ar' ? 'تم إلغاء فحص الأدلة.' : 'Evidence inspection cancelled.');
    }
  };

  const handleInspectAndAnalyze = async (options?: { resume?: boolean }) => {
    if (!activeSubmission || busy || aiBusy || runCoordinatorRef.current.isRunning) return;

    const resumeIfAvailable = options?.resume !== false;
    setConfirmRestartOpen(false);

    const token = runCoordinatorRef.current.startAnalysis();
    if (!token) return;

    const targetSubmission = activeSubmission;
    const targetHackathon = activeHackathon;
    const targetAttachedLog = attachedTestLog;
    setAiBusy(true);
    setBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    setLastAuditStatus(null);
    const initialProgress: BatchAnalysisProgress = {
      stage: 'discovering_repo',
      currentBatch: 0,
      totalBatches: 1,
      filesInspectedSoFar: 0,
      filesFetchedSoFar: 0,
      totalEligibleFiles: 0,
      stageStatus: {
        discover: 'active',
        ci: 'pending',
        audit: 'pending',
        merge: 'pending'
      }
    };
    setAnalysisProgressState(initialProgress);
    setAnalysisProgress(formatBatchProgress(initialProgress));

    try {
      const result = await runResumableJudgeAnalysis({
        submission: targetSubmission,
        hackathon: targetHackathon,
        locale,
        aiMode: InferenceMode.ONLY_IN_CLOUD,
        cloudConsentGranted: false,
        explicitGeminiAuthorized: false,
        collectEvidenceOnly: true,
        userId: user?.uid,
        emailVerified,
        attachedTestLog: targetAttachedLog,
        signal: token.controller.signal,
        resumeIfAvailable,
        onProgress: (progress) => {
          if (runCoordinatorRef.current.isCurrentAnalysis(token)) {
            setAnalysisProgressState(progress);
            setAnalysisProgress(formatBatchProgress(progress));
          }
        }
      });

      if (!runCoordinatorRef.current.isCurrentAnalysis(token)) {
        return;
      }

      setRepoInfo(result.repoInspection);
      setComprehensiveReport(result.report);
      setSavedCheckpoint(result.checkpoint);
      setLastAuditStatus(result.auditStatus);

      if (result.aiResult) {
        setAiResult(result.aiResult);
      }

      const enrichedLegacy: AIJudgeEvidence = {
        verifiedEvidence: result.report.verifiedEvidence,
        teamClaims: result.report.teamClaims,
        missingEvidence: result.report.missingEvidence,
        technicalObservations: result.report.technicalObservations,
        potentialRisks: result.report.potentialRisks,
        suggestedQuestions: result.report.suggestedQuestions,
        inspectedSources: result.report.inspectedSources,
        uninspectedSources: result.report.uninspectedSources
      };

      if (result.mergedAiOutput) {
        setPersistedAIReport(enrichedLegacy);
        setPersistedAISource(result.aiResult?.statusIndicator || '');
      }

      if (result.auditStatus === 'PARTIAL') {
        setErrorMsg(
          result.errorMessage ||
            (locale === 'ar'
              ? `تدقيق جزئي: اكتملت ${result.batchesCompleted}/${result.batchesTotal} دفعات وتم حفظ نتائجها. اضغط "استئناف التدقيق" للمتابعة دون تكرار الدفعات المكتملة.`
              : `Partial audit: ${result.batchesCompleted}/${result.batchesTotal} batch(es) completed and preserved. Click Resume Audit to continue remaining batches without repeating completed work.`)
        );
      } else if (result.auditStatus === 'INTERRUPTED') {
        setStatusMsg(
          result.auditStatusReason ||
            (locale === 'ar' ? 'تم إيقاف الفحص مؤقتاً.' : 'Audit interrupted.')
        );
      } else if (result.auditStatus === 'FAILED') {
        setErrorMsg(
          result.errorMessage ||
            result.aiResult?.errorMessage ||
            result.auditStatusReason ||
            (locale === 'ar'
              ? 'فشل تحليل مساعد التحكيم الذكي.'
              : 'AI Judge Assistant analysis failed.')
        );
      } else if (result.aiResult && !result.aiResult.ok) {
        setErrorMsg(
          result.aiResult.errorMessage ||
            (locale === 'ar'
              ? 'فشل تحليل مساعد التحكيم الذكي.'
              : 'AI Judge Assistant analysis failed.')
        );
      }
    } finally {
      if (runCoordinatorRef.current.finishAnalysis(token)) {
        setAiBusy(false);
        setBusy(false);
        setAnalysisProgress('');
        setAnalysisProgressState(null);
      }
    }
  };

  const activeAssignment = activeSubmission
    ? assignments.find((a) => a.hackathonId === activeSubmission.hackathonId)
    : undefined;
  const activeExistingEval = activeSubmission
    ? evaluations.find((e) => e.submissionId === activeSubmission.id)
    : undefined;
  const assignmentBlocksEvaluation =
    !activeAssignment || activeAssignment.status !== 'accepted' || activeAssignment.conflictDeclared;
  const isEvaluationLocked = activeExistingEval?.status === 'submitted' || assignmentBlocksEvaluation;

  const handleSaveEvaluation = async (submitFinal: boolean) => {
    if (saveBusy || runCoordinatorRef.current.isSaving) return;
    if (!user || !emailVerified || !activeSubmission) {
      setErrorMsg(
        locale === 'ar'
          ? 'يلزم حساب محكّم موثق البريد وتحديد تسليم للتقييم.'
          : 'Verified judge account and selected submission required.'
      );
      return;
    }
    if (assignmentBlocksEvaluation) {
      setErrorMsg(
        locale === 'ar'
          ? 'يجب قبول مهمة التحكيم دون وجود تعارض مصالح قبل إدخال الدرجات.'
          : 'You must accept the judging assignment with no declared conflict before scoring.'
      );
      return;
    }
    if (activeExistingEval?.status === 'submitted') {
      setErrorMsg(
        locale === 'ar'
          ? 'تم إرسال التقييم النهائي وقفله بواسطة قواعد أمان Firestore.'
          : 'Final submitted evaluations are immutable and locked by Firestore security rules.'
      );
      return;
    }
    const validation = validateEvaluationSubmission({
      criteriaScores,
      conflictOfInterest,
      conflictReason,
      submitFinal,
      locale
    });
    if (!validation.valid) {
      setErrorMsg(validation.errorMessage);
      return;
    }

    const targetSubmission = activeSubmission;
    const targetHackathon =
      hackathonMap[targetSubmission.hackathonId] || activeHackathon || null;
    const targetExistingEval = activeExistingEval;
    const saveToken = runCoordinatorRef.current.startSave(targetSubmission.id);
    if (!saveToken) return;

    setSaveBusy(true);
    setBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const weightedTotal = validation.weightedTotal;
      const summaryToPersist =
        aiResult?.ok && aiResult.data
          ? compactAIReportForStorage(aiResult.data, 5800)
          : targetExistingEval?.aiReportSummary || '';
      const sourceToPersist =
        aiResult?.statusIndicator || targetExistingEval?.aiInferenceSource || '';

      await saveEvaluation(
        {
          hackathonId: targetSubmission.hackathonId,
          organizerId: targetSubmission.organizerId,
          submissionId: targetSubmission.id,
          judgeId: user.uid,
          judgeName: profile?.displayName || user.displayName || 'Judge',
          criteriaScores: validation.persistedScores,
          weightedTotal,
          conflictOfInterest,
          conflictReason,
          humanFeedback,
          aiReportSummary: summaryToPersist,
          aiInferenceSource: sourceToPersist,
          status: submitFinal ? 'submitted' : 'draft'
        },
        targetHackathon?.rubric?.length ? { rubric: targetHackathon.rubric } : undefined
      );

      if (!runCoordinatorRef.current.isCurrentSave(saveToken)) {
        // Refresh evaluations list in background without disturbing the newly selected submission
        await loadJudgeData(runCoordinatorRef.current.currentSubmissionId, {
          preserveMessages: true,
          preserveSelectionIfUnchanged: true
        });
        return;
      }

      await loadJudgeData(targetSubmission.id, {
        preserveMessages: true,
        preserveSelectionIfUnchanged: true
      });
      if (!runCoordinatorRef.current.isCurrentSave(saveToken)) {
        return;
      }
      setStatusMsg(
        submitFinal
          ? locale === 'ar'
            ? `تم إرسال التقييم النهائي المستقل (${weightedTotal}/100).`
            : `Final human evaluation submitted (${weightedTotal}/100).`
          : locale === 'ar'
            ? validation.persistedScores.length > 0
              ? `تم حفظ مسودة التقييم (${weightedTotal}/100).`
              : 'تم حفظ مسودة التقييم (معايير غير مُقيّمة بعد).'
            : validation.persistedScores.length > 0
              ? `Evaluation draft saved (${weightedTotal}/100).`
              : 'Evaluation draft saved (criteria remain unscored).'
      );
    } catch (err) {
      if (runCoordinatorRef.current.isCurrentSave(saveToken)) {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : locale === 'ar'
              ? 'فشل حفظ التقييم.'
              : 'Failed to save evaluation'
        );
      }
    } finally {
      if (runCoordinatorRef.current.finishSave(saveToken)) {
        setSaveBusy(false);
        if (!runCoordinatorRef.current.isRunning) {
          setBusy(false);
        }
      }
    }
  };

  const scorePreview = calculateDraftWeightedPreview(criteriaScores);
  const displayedReport = (aiResult?.ok && aiResult.data) ? aiResult.data : persistedAIReport;
  const displayedReportSource = aiResult?.ok
    ? aiResult.statusIndicator
    : persistedAISource;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
          {t.sidebar.judging}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {locale === 'ar'
            ? 'تحقق من المستودع العام، وافصل الأدلة الموثقة عن ادعاءات الفريق، ثم أدخل تقييمك المستقل.'
            : 'Inspect real project evidence with the AI Judge Assistant. Human judges enter independent scores and retain final authority.'}
        </p>
      </div>

      {/* Judge Assignments Acceptance */}
      {assignments.length > 0 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4 space-y-2 text-xs">
          <div className="font-semibold">
            {locale === 'ar'
              ? `مهام التحكيم (${assignments.length})`
              : `Judging Assignments (${assignments.length})`}
          </div>
          {assignments.map((a) => {
            const hackTitle = hackathonMap[a.hackathonId]?.title || a.hackathonId;
            return (
              <div
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-slate-100 dark:border-slate-800/60 first:border-t-0 first:pt-0"
              >
                <span>
                  <span className="font-semibold text-slate-900 dark:text-white">{hackTitle}</span> ·{' '}
                  {locale === 'ar'
                    ? `${a.assignedSubmissionIds.length} تسليم`
                    : `${a.assignedSubmissionIds.length} submission(s)`}{' '}
                  · <span className="capitalize font-semibold">{a.status}</span>
                  {a.conflictDeclared
                    ? locale === 'ar'
                      ? ' (تعارض مصالح معلن — التقييم معطل)'
                      : ' (Conflict Declared — Scoring Disabled)'
                    : ''}
                </span>
                {a.status === 'invited' && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={assignmentBusy || saveBusy}
                      onClick={() => {
                        setAssignmentBusy(true);
                        void updateJudgeAssignmentResponse({
                          assignmentId: a.id,
                          status: 'accepted',
                          conflictDeclared: false,
                          conflictNotes: ''
                        })
                          .then(() => loadJudgeData(runCoordinatorRef.current.currentSubmissionId))
                          .catch((err) =>
                            setErrorMsg(
                              err instanceof Error
                                ? err.message
                                : locale === 'ar'
                                  ? 'تعذر قبول المهمة.'
                                  : 'Failed to accept assignment'
                            )
                          )
                          .finally(() => setAssignmentBusy(false));
                      }}
                      className="rounded-md bg-blue-600 px-3 py-1 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {t.common.accept}
                    </button>
                    <button
                      type="button"
                      disabled={assignmentBusy || saveBusy}
                      onClick={() => {
                        setAssignmentBusy(true);
                        void updateJudgeAssignmentResponse({
                          assignmentId: a.id,
                          status: 'declined',
                          conflictDeclared: false,
                          conflictNotes: 'Declined by judge'
                        })
                          .then(() => loadJudgeData(runCoordinatorRef.current.currentSubmissionId))
                          .catch((err) =>
                            setErrorMsg(
                              err instanceof Error
                                ? err.message
                                : locale === 'ar'
                                  ? 'تعذر رفض المهمة.'
                                  : 'Failed to decline assignment'
                            )
                          )
                          .finally(() => setAssignmentBusy(false));
                      }}
                      className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1 disabled:opacity-50"
                    >
                      {t.common.decline}
                    </button>
                  </div>
                )}
                {a.status === 'accepted' && !a.conflictDeclared && (
                  <button
                    type="button"
                    disabled={assignmentBusy || saveBusy}
                    onClick={() => {
                      setAssignmentBusy(true);
                      void updateJudgeAssignmentResponse({
                        assignmentId: a.id,
                        status: 'declined',
                        conflictDeclared: true,
                        conflictNotes: 'Judge declared conflict of interest on hackathon assignment'
                      })
                        .then(() => loadJudgeData(runCoordinatorRef.current.currentSubmissionId))
                        .catch((err) =>
                          setErrorMsg(
                            err instanceof Error
                              ? err.message
                              : locale === 'ar'
                                ? 'تعذر إعلان تعارض المصالح.'
                                : 'Failed to declare conflict'
                          )
                        )
                        .finally(() => setAssignmentBusy(false));
                    }}
                    className="rounded-md border border-amber-500/40 px-2.5 py-1 text-amber-600 dark:text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
                  >
                    {locale === 'ar' ? 'إعلان تعارض مصالح للمهمة' : 'Declare Assignment Conflict'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {errorMsg && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
          {errorMsg}
        </div>
      )}
      {statusMsg && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-300">
          {statusMsg}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-4 space-y-3">
          <h2 className="font-display text-base font-semibold">
            {locale === 'ar'
              ? `التسليمات المخصصة (${submissions.length})`
              : `Assigned Submissions (${submissions.length})`}
          </h2>
          {submissions.length === 0 ? (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 text-xs text-slate-500">
              {assignments.some((a) => a.status === 'invited')
                ? locale === 'ar'
                  ? 'اقبل دعوة التحكيم المعلقة أعلاه لفتح التسليمات المخصصة وإدخال الدرجات.'
                  : 'Accept your pending judging assignment above to unlock assigned submissions and scoring.'
                : locale === 'ar'
                  ? 'لا توجد تسليمات نشطة مخصصة لحساب التحكيم الخاص بك حالياً.'
                  : 'No active accepted submissions are assigned to your judge account.'}
            </div>
          ) : (
            submissions.map((sub) => {
              const ev = evaluations.find((x) => x.submissionId === sub.id);
              return (
                <button
                  key={sub.id}
                  type="button"
                  disabled={saveBusy}
                  onClick={() => void selectSubmission(sub)}
                  className={`w-full text-start rounded-xl border p-4 space-y-1 disabled:opacity-60 disabled:cursor-not-allowed ${
                    activeSubmission?.id === sub.id
                      ? 'border-blue-500 bg-blue-500/5'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]'
                  }`}
                >
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">{sub.teamName}</span>
                    <span className="font-mono text-blue-500">
                      {ev
                        ? `${ev.weightedTotal}/100 (${ev.status})`
                        : locale === 'ar'
                          ? 'قيد الانتظار'
                          : 'Pending'}
                    </span>
                  </div>
                  <div className="font-semibold text-sm text-slate-900 dark:text-white">{sub.title}</div>
                </button>
              );
            })
          )}
        </div>

        {activeSubmission && (
          <div className="lg:col-span-8 space-y-6">
            {/* Project Details & Links */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
              <div>
                <div className="text-xs text-slate-500">
                  {activeHackathon?.title ? `${activeHackathon.title} · ` : ''}
                  {locale === 'ar' ? 'الفريق:' : 'Team'} {activeSubmission.teamName} ·{' '}
                  {locale === 'ar' ? 'المسار:' : 'Track:'} {activeSubmission.track}
                </div>
                <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white mt-1">
                  {activeSubmission.title}
                </h2>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                  {activeSubmission.fullDescription || activeSubmission.shortDescription}
                </p>
              </div>

              <div className="flex flex-wrap gap-4 text-xs">
                {activeSubmission.githubUrl && (
                  <a
                    href={activeSubmission.githubUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    <span>{locale === 'ar' ? 'مستودع GitHub' : 'GitHub Repo'}</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                {activeSubmission.demoUrl && (
                  <a
                    href={activeSubmission.demoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    <span>{locale === 'ar' ? 'العرض المباشر' : 'Live Demo'}</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                {activeSubmission.videoUrl && (
                  <a
                    href={activeSubmission.videoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    <span>{locale === 'ar' ? 'فيديو العرض' : 'Demo Video'}</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            </div>

            {/* AI Judge Assistant */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-display text-base font-semibold flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-blue-500" />
                  <span>
                    {locale === 'ar' ? 'مساعد التحكيم بالذكاء الهجين' : 'AI Judge Evidence Assistant'}
                  </span>
                </h3>
                <div className="flex flex-wrap items-center gap-2">
                  {aiBusy && (
                    <button
                      type="button"
                      onClick={handleCancelAnalysis}
                      className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      {locale === 'ar' ? 'إلغاء التحليل' : 'Cancel'}
                    </button>
                  )}
                  {!aiBusy &&
                    savedCheckpoint &&
                    savedCheckpoint.interrupted &&
                    savedCheckpoint.completedBatches >= 0 &&
                    savedCheckpoint.completedBatches < savedCheckpoint.totalBatches && (
                      <>
                        <button
                          type="button"
                          disabled={busy || aiBusy}
                          onClick={() => void handleInspectAndAnalyze({ resume: true })}
                          className="rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {savedCheckpoint.completedBatches === 0
                            ? locale === 'ar'
                              ? `إعادة المحاولة (الدفعة ${(savedCheckpoint.failedBatchIndex ?? 0) + 1}/${savedCheckpoint.totalBatches})`
                              : `Retry Audit (Batch ${(savedCheckpoint.failedBatchIndex ?? 0) + 1}/${savedCheckpoint.totalBatches})`
                            : locale === 'ar'
                              ? `استئناف التدقيق (${savedCheckpoint.completedBatches + 1}/${savedCheckpoint.totalBatches})`
                              : `Resume Audit (Batch ${savedCheckpoint.completedBatches + 1}/${savedCheckpoint.totalBatches})`}
                        </button>
                        <button
                          type="button"
                          disabled={busy || aiBusy}
                          onClick={() => setConfirmRestartOpen((prev) => !prev)}
                          className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                        >
                          {locale === 'ar' ? 'إعادة من البداية' : 'Restart Fresh'}
                        </button>
                      </>
                    )}
                  <button
                    type="button"
                    disabled={busy || aiBusy}
                    onClick={() => void handleInspectAndAnalyze({ resume: true })}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {aiBusy
                      ? t.common.loading
                      : locale === 'ar'
                        ? 'فحص أدلة المستودع (0 استدعاءات Gemini)'
                        : 'Inspect Repo Evidence (0 Gemini)'}
                  </button>
                </div>
              </div>

              {!aiBusy && confirmRestartOpen && savedCheckpoint && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-900 dark:text-amber-200 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    {locale === 'ar'
                      ? `تأكيد إعادة التدقيق من الدفعة 1؟ التقدم المحفوظ (${savedCheckpoint.completedBatches}/${savedCheckpoint.totalBatches} دفعات · commit ${savedCheckpoint.commitSha?.slice(0, 7) || 'HEAD'}) سيبقى محمياً إذا فشلت الدفعة الأولى.`
                      : `Restart audit from Batch 1? Your saved checkpoint (${savedCheckpoint.completedBatches}/${savedCheckpoint.totalBatches} batch(es) · commit ${savedCheckpoint.commitSha?.slice(0, 7) || 'HEAD'}) stays protected if Batch 1 fails before progressing.`}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleInspectAndAnalyze({ resume: false })}
                      className="rounded-md bg-amber-600 px-3 py-1 font-semibold text-white hover:bg-amber-700"
                    >
                      {locale === 'ar' ? 'تأكيد الإعادة من البداية' : 'Confirm Restart Fresh'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRestartOpen(false)}
                      className="rounded-md border border-slate-300 dark:border-slate-700 px-2.5 py-1 font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      {locale === 'ar' ? 'إلغاء الإعادة' : 'Cancel Restart'}
                    </button>
                  </div>
                </div>
              )}

              {analysisProgress && (
                <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs font-medium text-blue-700 dark:text-blue-200 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>{analysisProgress}</span>
                    {analysisProgressState?.selectedModel && (
                      <span className="rounded border border-blue-500/30 bg-white/60 dark:bg-slate-900/60 px-2 py-0.5 font-mono text-[10px]">
                        {locale === 'ar' ? 'النموذج:' : 'Model:'}{' '}
                        {analysisProgressState.executedModel || analysisProgressState.selectedModel}
                        {analysisProgressState.fallbackModel
                          ? ` (fallback from ${analysisProgressState.selectedModel})`
                          : ''}
                        {analysisProgressState.retryAttempts
                          ? ` · retries=${analysisProgressState.retryAttempts}`
                          : ''}
                      </span>
                    )}
                  </div>
                  {analysisProgressState?.stageStatus && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {renderStageChip(
                        locale === 'ar' ? '1/4 المستودع' : '1/4 Repo',
                        analysisProgressState.stageStatus.discover
                      )}
                      {renderStageChip(
                        locale === 'ar' ? '2/4 CI' : '2/4 CI',
                        analysisProgressState.stageStatus.ci
                      )}
                      {renderStageChip(
                        locale === 'ar' ? '3/4 الدفعات' : '3/4 AI Batches',
                        analysisProgressState.stageStatus.audit
                      )}
                      {renderStageChip(
                        locale === 'ar' ? '4/4 التقرير' : '4/4 Report',
                        analysisProgressState.stageStatus.merge
                      )}
                      {analysisProgressState.stageStatus.ciNote && (
                        <span className="text-[10px] font-normal text-slate-600 dark:text-slate-300">
                          · {analysisProgressState.stageStatus.ciNote}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {!aiBusy &&
                savedCheckpoint &&
                savedCheckpoint.interrupted &&
                savedCheckpoint.completedBatches >= 0 &&
                savedCheckpoint.completedBatches < savedCheckpoint.totalBatches && (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200 space-y-1">
                    <div>
                      {savedCheckpoint.completedBatches === 0
                        ? locale === 'ar'
                          ? `نقطة استئناف متاحة (${lastAuditStatus || 'FAILED'} · commit ${savedCheckpoint.commitSha?.slice(0, 7) || 'HEAD'}). خطة المستودع والملفات المحمّلة جاهزة لإعادة المحاولة من الدفعة ${(savedCheckpoint.failedBatchIndex ?? 0) + 1}/${savedCheckpoint.totalBatches}.`
                          : `Retry checkpoint available (${lastAuditStatus || 'FAILED'} · commit ${savedCheckpoint.commitSha?.slice(0, 7) || 'HEAD'}). Discovered repo plan and fetched files are ready to retry from batch ${(savedCheckpoint.failedBatchIndex ?? 0) + 1}/${savedCheckpoint.totalBatches}.`
                        : locale === 'ar'
                          ? `يوجد تقدم محفوظ (${savedCheckpoint.completedBatches}/${savedCheckpoint.totalBatches} دفعات · commit ${savedCheckpoint.commitSha?.slice(0, 7) || 'HEAD'}) جاهز للاستئناف من الدفعة ${savedCheckpoint.completedBatches + 1}.`
                          : `Saved batch checkpoint available: ${savedCheckpoint.completedBatches}/${savedCheckpoint.totalBatches} batch(es) completed (commit ${savedCheckpoint.commitSha?.slice(0, 7) || 'HEAD'}). Resume will continue from batch ${savedCheckpoint.completedBatches + 1} without repeating finished calls.`}
                    </div>
                    {savedCheckpoint.lastError && (
                      <div className="text-[11px] opacity-90">{savedCheckpoint.lastError}</div>
                    )}
                  </div>
                )}

              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-2 text-xs text-amber-950 dark:text-amber-100">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold flex items-center gap-2 text-amber-800 dark:text-amber-200">
                    <ShieldAlert className="h-4 w-4 shrink-0" />
                    <span>
                      {locale === 'ar'
                        ? 'تم تعطيل التشغيل المباشر لـ Gemini في صفحة التحكيم القديمة'
                        : 'Legacy Live Gemini Execution Disabled — Protected Judging V2 Required'}
                    </span>
                  </div>
                  {inRouter ? (
                    <Link
                      to="/app/judging-v2"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                    >
                      <span>
                        {locale === 'ar' ? 'فتح التحكيم المحمي V2' : 'Open Protected Judging V2'}
                      </span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  ) : (
                    <a
                      href="/app/judging-v2"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                    >
                      <span>
                        {locale === 'ar' ? 'فتح التحكيم المحمي V2' : 'Open Protected Judging V2'}
                      </span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
                <p className="text-[11px] leading-relaxed text-amber-900 dark:text-amber-200">
                  {locale === 'ar'
                    ? 'لحماية حصة Gemini 4 Hydrogen وضمان تطبيق وضع الحماية (QUOTA-SAFE MODE) والمعايير الرسمية الأربعة واستبعاد فيديو العرض بالكامل، لا ترسل هذه الصفحة القديمة أي طلبات AI مباشرة. يظل فحص المستودع وCI والدرجات البشرية والتقارير المحفوظة متاحاً دون أي استدعاءات Gemini.'
                    : 'To protect Gemini 4 Hydrogen quota and enforce QUOTA-SAFE MODE, the 4 official fixed criteria, and strict demo video exclusion, live Gemini inference is disabled on this legacy workspace. Deterministic GitHub/CI evidence collection, historical reports, and human rubric scoring remain active with 0 Gemini calls.'}
                </p>
              </div>

              {/* Optional verified test/build command log input */}
              <details className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 p-3 text-xs">
                <summary className="cursor-pointer font-semibold text-slate-700 dark:text-slate-200">
                  {locale === 'ar'
                    ? 'إرفاق سجل اختبارات / بناء منفذ فعلياً (اختياري لترقية الحالة إلى TEST_CONFIRMED)'
                    : 'Attach Executed Test / Build Log (Optional — required for TEST_CONFIRMED status)'}
                </summary>
                <div className="mt-2 space-y-1.5">
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {locale === 'ar'
                      ? 'وجود ملفات اختبار في GitHub وحده لا يثبت نجاحها. الصق مخرجات الاختبار المنفذة (يتم تنقيح أي أسرار قبل التحليل).'
                      : 'Test files in GitHub alone are capped at CODE_CONFIRMED. Paste actual passing test/CI command output here (secrets are scrubbed automatically).'}
                  </p>
                  <textarea
                    rows={3}
                    value={attachedTestLog}
                    onChange={(e) => setAttachedTestLog(e.target.value)}
                    placeholder={
                      locale === 'ar'
                        ? '$ npm test\nTest Files 17 passed (17)\nTests 110 passed (110)'
                        : '$ npm test\nTest Files  17 passed (17)\nTests  110 passed (110)'
                    }
                    className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2.5 py-1.5 font-mono text-[11px]"
                  />
                </div>
              </details>

              {repoInfo && (
                <div
                  className={`rounded-lg border p-3 text-xs space-y-2 ${
                    repoInfo.accessible
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
                      : 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200'
                  }`}
                >
                  <div className="font-semibold">
                    {locale === 'ar' ? 'فحص المستودع:' : 'Repository Inspection:'}{' '}
                    {repoInfo.accessible
                      ? `${repoInfo.repoFullName}${repoInfo.defaultBranch ? ` (${repoInfo.defaultBranch})` : ''}${repoInfo.commitSha ? ` @ ${repoInfo.commitSha.slice(0, 7)}` : ''}`
                      : locale === 'ar'
                        ? 'غير متاح للوصول'
                        : 'Not Accessible'}
                  </div>
                  <p>{repoInfo.reason}</p>
                  {repoInfo.accessible && (
                    <>
                      <p className="font-mono text-[11px]">
                        {locale === 'ar' ? 'اللغة:' : 'Language:'} {repoInfo.primaryLanguage || 'Unknown'} ·{' '}
                        {locale === 'ar' ? 'النجوم:' : 'Stars:'} {repoInfo.stars ?? 0} ·{' '}
                        {locale === 'ar' ? 'الشجرة:' : 'Tree:'} {repoInfo.totalFilesInTree} ·{' '}
                        {locale === 'ar' ? 'المفحوصة:' : 'Inspected:'} {repoInfo.inspectedFiles.length} ·{' '}
                        {locale === 'ar' ? 'الدفعات:' : 'Batches:'} {repoInfo.batchesProcessed}
                        {repoInfo.treeTruncated
                          ? locale === 'ar'
                            ? ' (شجرة مقصوصة — فحص انتقائي عبر Contents API)'
                            : ' (truncated tree — selective Contents API)'
                          : ''}
                      </p>
                      {repoInfo.redactedSecretsCount > 0 && (
                        <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                          {locale === 'ar'
                            ? `تم تنقيح ${repoInfo.redactedSecretsCount} قيمة حساسة/مفتاح محتمل قبل الإرسال إلى Gemini.`
                            : `Redacted ${repoInfo.redactedSecretsCount} potential secret/credential literal(s) before Gemini analysis.`}
                        </p>
                      )}
                      {repoInfo.inspectedFiles.length > 0 && (
                        <div className="pt-1 border-t border-emerald-500/20">
                          <div className="font-semibold text-[11px] mb-1">
                            {locale === 'ar'
                              ? `الملفات الفعلية التي تم فحصها (${repoInfo.inspectedFiles.length}):`
                              : `Actually Inspected Source Files (${repoInfo.inspectedFiles.length}):`}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {repoInfo.inspectedFiles.map((file) => (
                              <span
                                key={file.path}
                                className="rounded bg-white/70 dark:bg-slate-900/70 px-2 py-0.5 font-mono text-[10px] border border-emerald-500/25"
                              >
                                {file.path} ({file.category}
                                {file.truncated ? ' · chunked' : ''})
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {repoInfo.uninspectedImportantFiles.length > 0 && (
                        <div className="pt-1 border-t border-emerald-500/20">
                          <div className="font-semibold text-[11px] mb-1 text-amber-700 dark:text-amber-300">
                            {locale === 'ar'
                              ? `ملفات لم تُفحص (${repoInfo.uninspectedImportantFiles.length}):`
                              : `Uninspected / Skipped Important Files (${repoInfo.uninspectedImportantFiles.length}):`}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {(showAllUninspected
                              ? repoInfo.uninspectedImportantFiles
                              : repoInfo.uninspectedImportantFiles.slice(0, 12)
                            ).map((file) => (
                              <span
                                key={`${file.path}-${file.reason}`}
                                className="rounded bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] border border-amber-500/25"
                              >
                                {file.path} ({file.reason})
                              </span>
                            ))}
                            {repoInfo.uninspectedImportantFiles.length > 12 && (
                              <button
                                type="button"
                                onClick={() => setShowAllUninspected((prev) => !prev)}
                                className="rounded bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-800 dark:text-amber-200 border border-amber-500/35 hover:bg-amber-500/25"
                              >
                                {showAllUninspected
                                  ? locale === 'ar'
                                    ? 'إخفاء الزائد'
                                    : 'Show fewer'
                                  : locale === 'ar'
                                    ? `+${repoInfo.uninspectedImportantFiles.length - 12} ملفات أخرى`
                                    : `+${repoInfo.uninspectedImportantFiles.length - 12} more`}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {aiResult && <InferenceResultBanner result={aiResult} />}

              {comprehensiveReport && (
                <ComprehensiveEvidencePanel report={comprehensiveReport} locale={locale} />
              )}

              {!comprehensiveReport && !aiResult && displayedReport && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
                  {locale === 'ar'
                    ? `تقرير أدلة الذكاء الاصطناعي المحفوظ (${displayedReportSource || 'محفوظ'})`
                    : `Loaded persisted AI evidence audit (${displayedReportSource || 'saved'})`}
                </div>
              )}

              {!comprehensiveReport && displayedReport && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  <div className="rounded-lg border border-emerald-500/30 p-3 space-y-1">
                    <div className="font-semibold flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      <span>{locale === 'ar' ? 'أدلة موثقة' : 'Verified Evidence'}</span>
                    </div>
                    <ul className="list-disc ps-4 space-y-1 text-slate-600 dark:text-slate-300">
                      {(displayedReport.verifiedEvidence || []).map((x, idx) => (
                        <li key={`${idx}-${x}`}>{x}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded-lg border border-amber-500/30 p-3 space-y-1">
                    <div className="font-semibold flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      <span>
                        {locale === 'ar'
                          ? 'ادعاءات الفريق (تتطلب تحققاً)'
                          : 'Team Claims (Requires Verification)'}
                      </span>
                    </div>
                    <ul className="list-disc ps-4 space-y-1 text-slate-600 dark:text-slate-300">
                      {(displayedReport.teamClaims || []).map((x, idx) => (
                        <li key={`${idx}-${x}`}>{x}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-1">
                    <div className="font-semibold">
                      {locale === 'ar' ? 'أدلة وفجوات مفقودة' : 'Missing Evidence & Gaps'}
                    </div>
                    <ul className="list-disc ps-4 space-y-1 text-slate-600 dark:text-slate-300">
                      {(displayedReport.missingEvidence || []).map((x, idx) => (
                        <li key={`${idx}-${x}`}>{x}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-1">
                    <div className="font-semibold">
                      {locale === 'ar' ? 'أسئلة مقترحة للمحكم' : 'Suggested Judge Questions'}
                    </div>
                    <ul className="list-disc ps-4 space-y-1 text-slate-600 dark:text-slate-300">
                      {(displayedReport.suggestedQuestions || []).map((x, idx) => (
                        <li key={`${idx}-${x}`}>{x}</li>
                      ))}
                    </ul>
                  </div>

                  {(displayedReport.technicalObservations || []).length > 0 && (
                    <div className="rounded-lg border border-blue-500/30 p-3 space-y-1">
                      <div className="font-semibold text-blue-600 dark:text-blue-400">
                        {locale === 'ar'
                          ? 'ملاحظات تقنية ومعايير التقييم'
                          : 'Technical & Rubric Observations'}
                      </div>
                      <ul className="list-disc ps-4 space-y-1 text-slate-600 dark:text-slate-300">
                        {(displayedReport.technicalObservations || []).map((x, idx) => (
                          <li key={`${idx}-${x}`}>{x}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {(displayedReport.potentialRisks || []).length > 0 && (
                    <div className="rounded-lg border border-rose-500/30 p-3 space-y-1">
                      <div className="font-semibold text-rose-600 dark:text-rose-400">
                        {locale === 'ar' ? 'مخاطر محتملة' : 'Potential Risks'}
                      </div>
                      <ul className="list-disc ps-4 space-y-1 text-slate-600 dark:text-slate-300">
                        {(displayedReport.potentialRisks || []).map((x, idx) => (
                          <li key={`${idx}-${x}`}>{x}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {((displayedReport.inspectedSources || []).length > 0 ||
                    (displayedReport.uninspectedSources || []).length > 0) && (
                    <div className="md:col-span-2 rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2">
                      {(displayedReport.inspectedSources || []).length > 0 && (
                        <div>
                          <div className="font-semibold text-slate-700 dark:text-slate-200">
                            {locale === 'ar'
                              ? 'مصادر الملفات المفحوصة'
                              : 'Audited Source Files'}
                          </div>
                          <ul className="list-disc ps-4 mt-1 space-y-0.5 font-mono text-[11px] text-slate-600 dark:text-slate-300">
                            {(displayedReport.inspectedSources || []).map((x, idx) => (
                              <li key={`${idx}-${x}`}>{x}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {(displayedReport.uninspectedSources || []).length > 0 && (
                        <div className="pt-1 border-t border-slate-200 dark:border-slate-800">
                          <div className="font-semibold text-amber-700 dark:text-amber-300">
                            {locale === 'ar'
                              ? 'ملفات لم تُفحص'
                              : 'Uninspected Source Files'}
                          </div>
                          <ul className="list-disc ps-4 mt-1 space-y-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                            {(displayedReport.uninspectedSources || []).map((x, idx) => (
                              <li key={`${idx}-${x}`}>{x}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Human Rubric Evaluation */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-base font-semibold flex items-center gap-2">
                  <Gavel className="h-4 w-4 text-blue-500" />
                  <span>
                    {locale === 'ar' ? 'التقييم البشري المستقل' : 'Independent Human Evaluation'}
                  </span>
                </h3>
                <span className="font-mono text-lg font-bold text-blue-600 dark:text-blue-400 tabular-nums">
                  {conflictOfInterest
                    ? 'COI'
                    : scorePreview.total === null
                      ? locale === 'ar'
                        ? 'غير مُقيّم'
                        : 'Unscored'
                      : scorePreview.allScored
                        ? `${scorePreview.total} / 100`
                        : `${scorePreview.total} / 100 (${scorePreview.scoredCount}/${scorePreview.totalCount})`}
                </span>
              </div>

              {activeExistingEval?.status === 'finalizing' && !isEvaluationLocked && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                  {locale === 'ar'
                    ? 'تمت مقاطعة محاولة الإرسال النهائي السابقة قبل الاكتمال. تم استرجاع درجات المعايير المحفوظة — راجعها ثم اضغط "إرسال التقييم البشري النهائي" أو "حفظ المسودة".'
                    : 'Previous final submission was interrupted before completion. Saved criterion scores have been restored — review and click "Submit Final Human Evaluation" or "Save Draft".'}
                </div>
              )}

              {isEvaluationLocked && (
                <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 text-xs text-blue-700 dark:text-blue-200">
                  {activeExistingEval?.status === 'submitted'
                    ? locale === 'ar'
                      ? 'تم إرسال التقييم النهائي وقفله لضمان نزاهة الترتيب.'
                      : 'Final evaluation has been submitted and locked for ranking integrity.'
                    : locale === 'ar'
                      ? 'يتطلب التحكيم قبول المهمة وعدم إعلان تعارض مصالح.'
                      : 'Accept this judging assignment without conflict of interest to score.'}
                </div>
              )}

              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {locale === 'ar'
                  ? 'يُحفظ كل معيار كسجل مستقل محمي بقواعد Firestore، ويُحسب المجموع الموزون محلياً للعرض ويُعاد التحقق منه من سجلات المعايير عند الترتيب.'
                  : 'Each criterion score is saved and rule-validated individually in Firestore; the weighted total is client-calculated for display and recomputed from persisted criterion records during ranking.'}
              </p>

              <label className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-300">
                <input
                  type="checkbox"
                  disabled={isEvaluationLocked}
                  checked={conflictOfInterest}
                  onChange={(e) => setConflictOfInterest(e.target.checked)}
                />
                <span>
                  {locale === 'ar'
                    ? 'إعلان تعارض مصالح (يستبعد درجتي من حساب الترتيب)'
                    : 'Declare Conflict of Interest (excludes my score from ranking)'}
                </span>
              </label>

              {conflictOfInterest ? (
                <input
                  type="text"
                  disabled={isEvaluationLocked}
                  value={conflictReason}
                  onChange={(e) => setConflictReason(e.target.value)}
                  placeholder={locale === 'ar' ? 'سبب تعارض المصالح...' : 'Reason for conflict of interest...'}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs disabled:opacity-60"
                />
              ) : criteriaScores.length === 0 ? (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                  {locale === 'ar'
                    ? 'لا توجد معايير تقييم محددة لهذا الهاكاثون بعد.'
                    : 'No rubric criteria configured for this hackathon yet.'}
                </div>
              ) : (
                <div className="space-y-3">
                  {criteriaScores.map((crit, idx) => (
                    <div
                      key={crit.criterionId}
                      className={`rounded-lg border p-3 space-y-2 ${
                        crit.scored && crit.score !== null
                          ? 'border-blue-500/30 bg-blue-500/[0.03] dark:border-slate-700'
                          : 'border-amber-500/50 bg-amber-500/5'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-semibold">
                          {crit.criterionName} ({crit.weight}%)
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <input
                            type="number"
                            min={0}
                            max={10}
                            step={0.5}
                            aria-label={`${crit.criterionName} score`}
                            disabled={isEvaluationLocked}
                            placeholder="—"
                            value={crit.scored && crit.score !== null ? crit.score : ''}
                            onChange={(e) => {
                              const raw = e.target.value;
                              if (raw === '') {
                                setCriteriaScores((prev) => clearHumanCriterionScore(prev, idx));
                              } else {
                                const parsed = Number(raw);
                                if (Number.isFinite(parsed)) {
                                  setCriteriaScores((prev) =>
                                    setHumanCriterionScore(prev, idx, parsed)
                                  );
                                }
                              }
                            }}
                            className="w-16 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2 py-0.5 text-end font-mono text-xs disabled:opacity-60"
                          />
                          {!isEvaluationLocked && (
                            <button
                              type="button"
                              onClick={() =>
                                setCriteriaScores((prev) => setHumanCriterionScore(prev, idx, 0))
                              }
                              title={
                                locale === 'ar'
                                  ? 'تعيين الدرجة إلى صفر صريح (0)'
                                  : 'Set explicit 0 score'
                              }
                              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                                crit.scored && crit.score === 0
                                  ? 'border-slate-700 bg-slate-800 text-white dark:border-slate-200 dark:bg-slate-200 dark:text-slate-900'
                                  : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                              }`}
                            >
                              0
                            </button>
                          )}
                          {!isEvaluationLocked && crit.scored && (
                            <button
                              type="button"
                              onClick={() =>
                                setCriteriaScores((prev) => clearHumanCriterionScore(prev, idx))
                              }
                              className="rounded border border-slate-300 dark:border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              {locale === 'ar' ? 'مسح' : 'Clear'}
                            </button>
                          )}
                          {crit.scored && crit.score !== null ? (
                            <span
                              className={`rounded border px-2 py-0.5 font-mono text-[10px] font-bold tabular-nums ${
                                crit.score === 0
                                  ? 'border-slate-400/50 bg-slate-200/70 text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100'
                                  : 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                              }`}
                            >
                              {crit.score === 0
                                ? locale === 'ar'
                                  ? '0 / 10 (صفر صريح)'
                                  : '0 / 10 (Explicit 0)'
                                : `${crit.score} / 10`}
                            </span>
                          ) : (
                            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                              {locale === 'ar' ? 'غير مُقيّم' : 'Unscored'}
                            </span>
                          )}
                        </div>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={10}
                        step={0.5}
                        disabled={isEvaluationLocked}
                        value={crit.scored && crit.score !== null ? crit.score : 0}
                        onChange={(e) =>
                          setCriteriaScores((prev) =>
                            setHumanCriterionScore(prev, idx, Number(e.target.value))
                          )
                        }
                        className="w-full accent-blue-600 disabled:opacity-60"
                      />
                      <input
                        type="text"
                        disabled={isEvaluationLocked}
                        value={crit.comment}
                        onChange={(e) => {
                          const next = [...criteriaScores];
                          next[idx] = { ...crit, comment: e.target.value };
                          setCriteriaScores(next);
                        }}
                        placeholder={
                          locale === 'ar' ? 'ملاحظة الدليل لهذا المعيار...' : 'Evidence note for this criterion...'
                        }
                        className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2.5 py-1 text-xs disabled:opacity-60"
                      />
                    </div>
                  ))}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium mb-1">
                  {locale === 'ar' ? 'ملاحظات المحكم المكتوبة' : 'Judge Written Feedback'}
                </label>
                <textarea
                  rows={3}
                  disabled={isEvaluationLocked}
                  value={humanFeedback}
                  onChange={(e) => setHumanFeedback(e.target.value)}
                  placeholder={
                    locale === 'ar'
                      ? 'ملخص تقييم بنّاء للفريق...'
                      : 'Constructive evaluation summary for the team...'
                  }
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm disabled:opacity-60"
                />
              </div>

              <div className="flex flex-wrap justify-end gap-3">
                <button
                  type="button"
                  disabled={busy || isEvaluationLocked}
                  onClick={() => void handleSaveEvaluation(false)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold disabled:opacity-50"
                >
                  {locale === 'ar' ? 'حفظ المسودة' : 'Save Draft'}
                </button>
                <button
                  type="button"
                  disabled={busy || isEvaluationLocked}
                  onClick={() => void handleSaveEvaluation(true)}
                  className="rounded-lg bg-blue-600 px-5 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {locale === 'ar' ? 'إرسال التقييم البشري النهائي' : 'Submit Final Human Evaluation'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
