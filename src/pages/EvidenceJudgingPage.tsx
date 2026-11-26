import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InferenceMode } from 'firebase/ai';
import { Link } from 'react-router-dom';
import { ExternalLink, FolderGit2, Gavel, ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import {
  getHackathonById,
  listJudgeAssignedSubmissions,
  listJudgeAssignmentsByJudge,
  listOrganizerSubmissions
} from '../services/firebase/firestoreService';
import type { InspectedRepoFile, SkippedRepoFile } from '../services/github/repoInspector';
import {
  ANALYSIS_VERSION,
  CRITERIA_VERSION,
  EVIDENCE_COLLECTOR_VERSION,
  OFFICIAL_JUDGING_CRITERIA
} from '../services/judgingV2/criteria';
import {
  buildAnalysisCacheKey,
  clearCachedAIAnalysis,
  clearJudgingV2Checkpoint,
  compareEvidencePrecedence,
  getCachedAIAnalysis,
  resolveEvidenceForSubmission,
  saveJudgingV2Checkpoint
} from '../services/judgingV2/cacheAndCheckpoints';
import { evaluateSubmissionEligibility } from '../services/judgingV2/eligibilityEngine';
import { collectProjectEvidence } from '../services/judgingV2/evidenceCollector';
import { sanitizeSubmissionWithoutVideo } from '../services/judgingV2/evidenceSanitizer';
import {
  attachAIRecommendationSafely,
  createEmptyHumanEvaluation,
  finalizeAndApproveHumanEvaluation,
  loadHumanEvaluation,
  saveHumanEvaluationDraft,
  setHumanCriterionScoreV2
} from '../services/judgingV2/humanEvaluationStore';
import { judgingV2Analyzer } from '../services/judgingV2/quotaProtectedAnalyzer';
import type {
  AnalysisCheckpoint,
  AnalysisJobStatus,
  EvidenceBundle,
  EvidenceStatus,
  HumanJudgingEvaluation,
  ObservableWorkflowCheck,
  OfficialCriterionId,
  PersistedEvidenceRecord,
  QuotaGuardState
} from '../services/judgingV2/types';
import type { Hackathon, ProjectSubmission } from '../types/domain';
import { AIRecommendationsPanel } from '../components/judgingV2/AIRecommendationsPanel';
import { EligibilitySection } from '../components/judgingV2/EligibilitySection';
import { EvidenceCoveragePanel } from '../components/judgingV2/EvidenceCoveragePanel';
import { HumanScoringPanel } from '../components/judgingV2/HumanScoringPanel';
import { OnDeviceQuickHelpersPanel } from '../components/judgingV2/OnDeviceQuickHelpersPanel';
import { QuotaAndJobControlBar } from '../components/judgingV2/QuotaAndJobControlBar';

export function EvidenceJudgingPage() {
  const { user, profile, privateInfo, isAdmin, emailVerified, updateCloudConsent } = useAuth();
  const { locale } = useLanguage();
  const isAr = locale === 'ar';

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<ProjectSubmission[]>([]);
  const [assignedSubmissionIds, setAssignedSubmissionIds] = useState<string[]>([]);
  const [hackathonsMap, setHackathonsMap] = useState<Record<string, Hackathon>>({});
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string>('');

  const [guardState, setGuardState] = useState<QuotaGuardState>(() => judgingV2Analyzer.getState());
  const [preferredMode, setPreferredMode] = useState<InferenceMode>(InferenceMode.ONLY_IN_CLOUD);
  const [explicitAuthorized, setExplicitAuthorized] = useState(false);

  const [jobStatus, setJobStatus] = useState<AnalysisJobStatus>('IDLE');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ completed: number; total: number } | null>(
    null
  );
  const [attachedTestLog, setAttachedTestLog] = useState('');
  const [evidenceBundles, setEvidenceBundles] = useState<Record<string, EvidenceBundle>>({});
  const [checkpoints, setCheckpoints] = useState<Record<string, AnalysisCheckpoint | null>>({});
  const [preservedVersionsBySub, setPreservedVersionsBySub] = useState<
    Record<string, PersistedEvidenceRecord[]>
  >({});
  const [evaluations, setEvaluations] = useState<Record<string, HumanJudgingEvaluation>>({});
  const [scoringFeedback, setScoringFeedback] = useState<{ type: 'ok' | 'error'; text: string } | null>(
    null
  );

  const abortControllerRef = useRef<AbortController | null>(null);
  const evidenceBundlesRef = useRef<Record<string, EvidenceBundle>>({});
  useEffect(() => {
    evidenceBundlesRef.current = evidenceBundles;
  }, [evidenceBundles]);
  const evaluationsRef = useRef<Record<string, HumanJudgingEvaluation>>({});
  useEffect(() => {
    evaluationsRef.current = evaluations;
  }, [evaluations]);
  const attachedTestLogRef = useRef(attachedTestLog);
  useEffect(() => {
    attachedTestLogRef.current = attachedTestLog;
  }, [attachedTestLog]);
  const autoUpgradedSubIdsRef = useRef<Set<string>>(new Set());
  const resumeFilesRef = useRef<
    Record<
      string,
      {
        inspectedFiles: InspectedRepoFile[];
        skippedFiles: SkippedRepoFile[];
        completedBatches: number;
        commitSha: string | null;
      }
    >
  >({});

  const isOrganizerOrAdmin = Boolean(isAdmin || profile?.approvedRole === 'organizer');

  const loadAssignedWork = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [judgeSubs, judgeAssignments, orgSubs] = await Promise.all([
        listJudgeAssignedSubmissions(user.uid).catch(() => []),
        listJudgeAssignmentsByJudge(user.uid).catch(() => []),
        isOrganizerOrAdmin ? listOrganizerSubmissions(user.uid).catch(() => []) : Promise.resolve([])
      ]);

      const acceptedIds = Array.from(
        new Set(
          judgeAssignments
            .filter((a) => a.status === 'accepted' && !a.conflictDeclared)
            .flatMap((a) => a.assignedSubmissionIds || [])
        )
      );
      setAssignedSubmissionIds(acceptedIds);

      const mergedById = new Map<string, ProjectSubmission>();
      for (const s of [...judgeSubs, ...orgSubs]) {
        mergedById.set(s.id, s);
      }
      const combined = Array.from(mergedById.values());
      setSubmissions(combined);

      const uniqueHackathonIds = Array.from(
        new Set(combined.map((s) => s.hackathonId).filter(Boolean))
      );
      const hackathons = await Promise.all(
        uniqueHackathonIds.map((hid) => getHackathonById(hid).catch(() => null))
      );
      const hMap: Record<string, Hackathon> = {};
      for (const h of hackathons) {
        if (h) hMap[h.id] = h;
      }
      setHackathonsMap(hMap);

      if (combined.length > 0) {
        setSelectedSubmissionId((prev) =>
          prev && mergedById.has(prev) ? prev : combined[0].id
        );
      }
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Unable to load assigned submissions from Firestore.'
      );
    } finally {
      setLoading(false);
    }
  }, [isOrganizerOrAdmin, user]);

  useEffect(() => {
    void loadAssignedWork();
  }, [loadAssignedWork]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const selectedSubmission = useMemo(
    () => submissions.find((s) => s.id === selectedSubmissionId) || null,
    [submissions, selectedSubmissionId]
  );

  const sanitizedSubmission = useMemo(
    () => (selectedSubmission ? sanitizeSubmissionWithoutVideo(selectedSubmission) : null),
    [selectedSubmission]
  );

  const selectedHackathon = useMemo(
    () => (selectedSubmission ? hackathonsMap[selectedSubmission.hackathonId] || null : null),
    [hackathonsMap, selectedSubmission]
  );

  const eligibilityReport = useMemo(
    () =>
      selectedSubmission
        ? evaluateSubmissionEligibility({
            submission: selectedSubmission,
            hackathon: selectedHackathon
          })
        : null,
    [selectedSubmission, selectedHackathon]
  );

  const handleCollectEvidence = useCallback(
    async (
      resume: boolean,
      expandOptions?: {
        inspectAdditionalUninspected?: boolean;
        expandTruncatedFiles?: boolean;
      }
    ) => {
      if (!selectedSubmission || !user) return;
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setJobStatus('COLLECTING_EVIDENCE');
      setStatusMessage(null);
      setBatchProgress({ completed: 0, total: 0 });

      const resolvedBefore = resolveEvidenceForSubmission({
        submissionId: selectedSubmission.id,
        projectId: selectedSubmission.projectId,
        repoUrl: selectedSubmission.githubUrl
      });
      const memResume = resumeFilesRef.current[selectedSubmission.id];
      const ckptResume = resolvedBefore.activeCheckpoint;
      const recResume = resolvedBefore.activeRecord;

      const resumeInspectedFiles = resume
        ? memResume?.inspectedFiles ||
          recResume?.inspectedFilesSnapshot ||
          ckptResume?.inspectedFilesSnapshot ||
          []
        : [];
      const resumeSkippedFiles = resume
        ? memResume?.skippedFiles ||
          recResume?.skippedFilesSnapshot ||
          ckptResume?.skippedFilesSnapshot ||
          []
        : [];
      const resumeCompletedBatches = resume
        ? memResume?.completedBatches ?? ckptResume?.completedBatches ?? 0
        : 0;
      const resumeCommitSha = resume
        ? memResume?.commitSha ?? recResume?.commitSha ?? ckptResume?.commitSha ?? null
        : null;

      try {
        const result = await collectProjectEvidence({
          submission: selectedSubmission,
          attachedTestLog: attachedTestLogRef.current,
          signal: controller.signal,
          resumeInspectedFiles,
          resumeSkippedFiles,
          resumeCompletedBatches,
          resumeCommitSha,
          existingWorkflowChecks: evaluationsRef.current[selectedSubmission.id]?.workflowChecks,
          inspectAdditionalUninspected: expandOptions?.inspectAdditionalUninspected ?? true,
          expandTruncatedFiles: expandOptions?.expandTruncatedFiles ?? true,
          onBatchProgress: (prog) => {
            setBatchProgress({ completed: prog.completedBatches, total: prog.totalBatches });
            resumeFilesRef.current[selectedSubmission.id] = {
              inspectedFiles: prog.inspectedFiles,
              skippedFiles: prog.skippedFiles,
              completedBatches: prog.completedBatches,
              commitSha: prog.commitSha
            };
            const partialCkpt: AnalysisCheckpoint = {
              jobId: `job_${selectedSubmission.id}`,
              submissionId: selectedSubmission.id,
              projectId: selectedSubmission.projectId,
              repoUrl: sanitizedSubmission?.githubUrl || '',
              defaultBranch: recResume?.defaultBranch ?? ckptResume?.defaultBranch ?? null,
              commitSha: prog.commitSha,
              criteriaVersion: CRITERIA_VERSION,
              analysisVersion: ANALYSIS_VERSION,
              evidenceCollectorVersion: EVIDENCE_COLLECTOR_VERSION,
              status: 'COLLECTING_EVIDENCE',
              completedBatches: prog.completedBatches,
              totalBatches: prog.totalBatches,
              inspectedPaths: prog.inspectedFiles.map((f) => f.path),
              inspectedFilesSnapshot: prog.inspectedFiles,
              skippedFilesSnapshot: prog.skippedFiles,
              evidenceBundle: null,
              aiRecommendation: evaluationsRef.current[selectedSubmission.id]?.aiRecommendationSnapshot || null,
              lastError: null,
              quotaStopped: false,
              updatedAt: new Date().toISOString()
            };
            const savedPartial = saveJudgingV2Checkpoint(partialCkpt);
            setCheckpoints((prev) => ({
              ...prev,
              [selectedSubmission.id]: savedPartial.activeCheckpoint
            }));
          }
        });

        resumeFilesRef.current[selectedSubmission.id] = {
          inspectedFiles: result.inspectedFilesSnapshot,
          skippedFiles: result.skippedFilesSnapshot,
          completedBatches: result.bundle.coverage.completedBatches,
          commitSha: result.bundle.coverage.commitSha
        };

        const finalStatus: AnalysisJobStatus = result.aborted ? 'CANCELLED' : 'EVIDENCE_READY';
        const finalCkpt: AnalysisCheckpoint = {
          jobId: `job_${selectedSubmission.id}`,
          submissionId: selectedSubmission.id,
          projectId: selectedSubmission.projectId,
          repoUrl: result.bundle.repoUrl || result.bundle.sanitizedSubmission.githubUrl,
          defaultBranch: result.bundle.coverage.defaultBranch,
          commitSha: result.bundle.coverage.commitSha,
          criteriaVersion: CRITERIA_VERSION,
          analysisVersion: ANALYSIS_VERSION,
          evidenceCollectorVersion: EVIDENCE_COLLECTOR_VERSION,
          evidenceKey: result.bundle.evidenceKey,
          status: finalStatus,
          completedBatches: result.bundle.coverage.completedBatches,
          totalBatches: result.bundle.coverage.totalBatches,
          inspectedPaths: result.bundle.inspectedFilesList.map((f) => f.path),
          inspectedFilesSnapshot: result.inspectedFilesSnapshot,
          skippedFilesSnapshot: result.skippedFilesSnapshot,
          evidenceBundle: result.bundle,
          aiRecommendation: evaluationsRef.current[selectedSubmission.id]?.aiRecommendationSnapshot || null,
          lastError: result.interrupted ? 'Evidence inspection interrupted before completion.' : null,
          quotaStopped: false,
          updatedAt: new Date().toISOString()
        };

        const savedResult = saveJudgingV2Checkpoint(finalCkpt);
        const resolvedAfter = resolveEvidenceForSubmission({
          submissionId: selectedSubmission.id,
          projectId: selectedSubmission.projectId,
          repoUrl: result.bundle.repoUrl || selectedSubmission.githubUrl
        });
        const authoritativeBundle = resolvedAfter.activeRecord?.bundle || result.bundle;

        setEvidenceBundles((prev) => ({ ...prev, [selectedSubmission.id]: authoritativeBundle }));
        setCheckpoints((prev) => ({
          ...prev,
          [selectedSubmission.id]: resolvedAfter.activeCheckpoint || savedResult.activeCheckpoint
        }));
        setPreservedVersionsBySub((prev) => ({
          ...prev,
          [selectedSubmission.id]: resolvedAfter.preservedVersions
        }));
        setBatchProgress({
          completed: authoritativeBundle.coverage.completedBatches,
          total: authoritativeBundle.coverage.totalBatches
        });
        setJobStatus(finalStatus);

        // Sync default workflow checks onto draft if empty
        setEvaluations((prev) => {
          const cur = prev[selectedSubmission.id];
          if (!cur || cur.workflowChecks.length > 0) return prev;
          return {
            ...prev,
            [selectedSubmission.id]: {
              ...cur,
              workflowChecks: authoritativeBundle.workflowChecks
            }
          };
        });

        if (result.aborted) {
          setStatusMessage(
            isAr
              ? 'تم إلغاء فحص المستودع بعد حفظ الدفعات المكتملة.'
              : 'Repository collection cancelled cleanly; completed batches saved to checkpoint.'
          );
        } else if (savedResult.preservedConflict) {
          setStatusMessage(
            isAr
              ? 'تم الإبقاء على حزمة الأدلة الأكثر اكتمالاً كنسخة نشطة وحفظ التحديث في السجل دون مسح التاريخ.'
              : 'Preserved the more complete persisted evidence bundle as ACTIVE while archiving this run cleanly.'
          );
        } else {
          setStatusMessage(authoritativeBundle.coverage.note);
        }
      } catch (err) {
        setJobStatus('FAILED');
        setStatusMessage(
          err instanceof Error ? err.message : 'Failed to collect project evidence.'
        );
      }
    },
    [isAr, sanitizedSubmission?.githubUrl, selectedSubmission, user]
  );

  // Restore authoritative persisted evidence, preserve legacy/conflicting versions, and upgrade stale v2.collector.1 caches safely (0 Gemini calls)
  useEffect(() => {
    if (!selectedSubmission || !user) return;
    setScoringFeedback(null);
    setStatusMessage(null);
    setExplicitAuthorized(false);
    judgingV2Analyzer.setQuotaSafeMode(true);
    setGuardState(judgingV2Analyzer.getState());

    const resolved = resolveEvidenceForSubmission({
      submissionId: selectedSubmission.id,
      projectId: selectedSubmission.projectId,
      repoUrl: selectedSubmission.githubUrl
    });

    setCheckpoints((prev) => ({ ...prev, [selectedSubmission.id]: resolved.activeCheckpoint }));
    setPreservedVersionsBySub((prev) => ({
      ...prev,
      [selectedSubmission.id]: resolved.preservedVersions
    }));

    const existingInMemory = evidenceBundlesRef.current[selectedSubmission.id] || null;
    const resolvedBundle = resolved.activeRecord?.bundle || null;

    if (
      resolvedBundle &&
      (!existingInMemory ||
        compareEvidencePrecedence(
          {
            evidenceCollectorVersion: resolved.activeRecord?.evidenceCollectorVersion,
            bundle: resolvedBundle,
            timestamp: resolved.activeRecord?.collectedAt
          },
          {
            evidenceCollectorVersion: existingInMemory.evidenceCollectorVersion,
            bundle: existingInMemory,
            timestamp: existingInMemory.collectedAt
          }
        ) >= 0)
    ) {
      setEvidenceBundles((prev) => ({ ...prev, [selectedSubmission.id]: resolvedBundle }));
      const nextStatus: AnalysisJobStatus =
        resolved.activeCheckpoint?.status === 'COMPLETED'
          ? 'COMPLETED'
          : resolved.activeCheckpoint?.status === 'PAUSED_QUOTA'
            ? 'PAUSED_QUOTA'
            : 'EVIDENCE_READY';
      setJobStatus(nextStatus);
      setBatchProgress({
        completed: resolvedBundle.coverage.completedBatches,
        total: resolvedBundle.coverage.totalBatches
      });
    } else if (existingInMemory) {
      setJobStatus('EVIDENCE_READY');
      setBatchProgress({
        completed: existingInMemory.coverage.completedBatches,
        total: existingInMemory.coverage.totalBatches
      });
    } else if (resolved.activeCheckpoint) {
      setJobStatus(resolved.activeCheckpoint.status);
      setBatchProgress({
        completed: resolved.activeCheckpoint.completedBatches,
        total: resolved.activeCheckpoint.totalBatches
      });
    } else {
      setJobStatus('IDLE');
      setBatchProgress(null);
    }

    const seedInspected =
      resolved.activeRecord?.inspectedFilesSnapshot ||
      resolved.activeCheckpoint?.inspectedFilesSnapshot;
    const seedSkipped =
      resolved.activeRecord?.skippedFilesSnapshot ||
      resolved.activeCheckpoint?.skippedFilesSnapshot;
    if (seedInspected && seedInspected.length > 0) {
      resumeFilesRef.current[selectedSubmission.id] = {
        inspectedFiles: seedInspected,
        skippedFiles: seedSkipped || [],
        completedBatches:
          resolvedBundle?.coverage.completedBatches ??
          resolved.activeCheckpoint?.completedBatches ??
          0,
        commitSha:
          resolved.activeRecord?.commitSha ?? resolved.activeCheckpoint?.commitSha ?? null
      };
    }

    setEvaluations((prev) => {
      if (prev[selectedSubmission.id]) return prev;
      const stored = loadHumanEvaluation(selectedSubmission.id, user.uid);
      const initial =
        stored ||
        createEmptyHumanEvaluation({
          submissionId: selectedSubmission.id,
          hackathonId: selectedSubmission.hackathonId,
          judgeId: user.uid,
          judgeName: profile?.displayName || user.displayName || user.email || 'Human Judge',
          workflowChecks: resolvedBundle?.workflowChecks
        });
      return { ...prev, [selectedSubmission.id]: initial };
    });

    if (
      resolved.needsUpgrade &&
      selectedSubmission.githubUrl &&
      !autoUpgradedSubIdsRef.current.has(selectedSubmission.id)
    ) {
      autoUpgradedSubIdsRef.current.add(selectedSubmission.id);
      void handleCollectEvidence(true, {
        inspectAdditionalUninspected: true,
        expandTruncatedFiles: true
      });
    }
  }, [selectedSubmission, user, profile?.displayName, handleCollectEvidence]);

  const activeBundle = selectedSubmission ? evidenceBundles[selectedSubmission.id] || null : null;
  const activeCheckpoint = selectedSubmission ? checkpoints[selectedSubmission.id] || null : null;
  const activeEvaluation =
    selectedSubmission && user
      ? evaluations[selectedSubmission.id] ||
        createEmptyHumanEvaluation({
          submissionId: selectedSubmission.id,
          hackathonId: selectedSubmission.hackathonId,
          judgeId: user.uid,
          judgeName: profile?.displayName || user.displayName || user.email || 'Human Judge'
        })
      : null;

  const cacheKey = useMemo(() => {
    if (!sanitizedSubmission) return null;
    return buildAnalysisCacheKey({
      projectId: sanitizedSubmission.projectId || sanitizedSubmission.id,
      repoUrl: sanitizedSubmission.githubUrl,
      commitSha: activeBundle?.coverage.commitSha || activeCheckpoint?.commitSha || null,
      criteriaVersion: CRITERIA_VERSION,
      analysisVersion: ANALYSIS_VERSION
    });
  }, [sanitizedSubmission, activeBundle, activeCheckpoint]);

  const cachedRecommendation = useMemo(
    () => (cacheKey ? getCachedAIAnalysis(cacheKey) : null),
    [cacheKey]
  );

  const displayedRecommendation =
    activeEvaluation?.aiRecommendationSnapshot ||
    cachedRecommendation ||
    activeCheckpoint?.aiRecommendation ||
    null;

  const canApproveAsJudge = Boolean(
    user &&
      selectedSubmission &&
      (isOrganizerOrAdmin || assignedSubmissionIds.includes(selectedSubmission.id))
  );

  const handleToggleAuthorizeGemini = (authorized: boolean) => {
    setExplicitAuthorized(authorized);
    if (authorized) {
      setGuardState(judgingV2Analyzer.authorizeGeminiForNextRun(true));
    } else {
      setGuardState(judgingV2Analyzer.setQuotaSafeMode(true));
    }
  };

  const handleModeChange = (_mode: InferenceMode) => {
    setPreferredMode(InferenceMode.ONLY_IN_CLOUD);
    setGuardState(judgingV2Analyzer.setPreferredInferenceMode(InferenceMode.ONLY_IN_CLOUD));
  };

  const handleCancelJob = () => {
    abortControllerRef.current?.abort();
    setJobStatus('CANCELLED');
    setStatusMessage(
      isAr ? 'تم إيقاف العملية وحفظ نقطة الاستئناف المتاحة.' : 'Operation cancelled cleanly; partial checkpoint preserved.'
    );
  };

  const handleRecomputeTestsFromLog = async () => {
    if (!selectedSubmission) return;
    await handleCollectEvidence(true);
  };

  const handleUpdateWorkflowCheck = (id: string, status: EvidenceStatus, notes: string) => {
    if (!selectedSubmission || !activeEvaluation || activeEvaluation.status === 'approved') return;
    const baseChecks: ObservableWorkflowCheck[] =
      activeEvaluation.workflowChecks.length > 0
        ? activeEvaluation.workflowChecks
        : activeBundle?.workflowChecks || [];

    const nextChecks = baseChecks.map((wf) =>
      wf.id === id
        ? {
            ...wf,
            status,
            notes,
            checkedByJudge: true,
            checkedAt: new Date().toISOString()
          }
        : wf
    );

    setEvaluations((prev) => ({
      ...prev,
      [selectedSubmission.id]: {
        ...activeEvaluation,
        workflowChecks: nextChecks
      }
    }));

    if (activeBundle) {
      setEvidenceBundles((prev) => ({
        ...prev,
        [selectedSubmission.id]: {
          ...activeBundle,
          workflowChecks: nextChecks
        }
      }));
    }
  };

  const handleLoadCachedRecommendation = () => {
    if (!selectedSubmission || !cacheKey) return;
    const cached = getCachedAIAnalysis(cacheKey);
    if (!cached) {
      setStatusMessage(
        isAr ? 'لا توجد توصية مخزنة في الكاش لهذه الحزمة.' : 'No cached recommendation found for this evidence bundle.'
      );
      return;
    }
    setEvaluations((prev) => {
      const current = prev[selectedSubmission.id];
      if (!current) return prev;
      return {
        ...prev,
        [selectedSubmission.id]: attachAIRecommendationSafely(current, cached)
      };
    });
    setStatusMessage(
      isAr
        ? 'تم تحميل توصية Gemini من الكاش بنجاح (0 طلبات API).'
        : 'Loaded Gemini advisory recommendation from cache (0 Gemini API requests used).'
    );
  };

  const handleRunGeminiAnalysis = async () => {
    if (!selectedSubmission || !activeBundle || !user) return;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setJobStatus('RUNNING_GEMINI');
    setStatusMessage(null);

    try {
      const res = await judgingV2Analyzer.analyzeWithQuotaProtection({
        bundle: activeBundle,
        explicitJudgeAction: true,
        geminiAuthorizedForRun: explicitAuthorized,
        cloudConsentGranted: Boolean(privateInfo?.aiCloudConsent),
        preferredMode: InferenceMode.ONLY_IN_CLOUD,
        locale,
        userId: user.uid,
        emailVerified,
        signal: controller.signal,
        forceBypassCache: true
      });

      setGuardState(judgingV2Analyzer.getState());

      if (!res.ok || !res.recommendation) {
        const nextStatus: AnalysisJobStatus =
          res.blockedCode === 'DAILY_QUOTA_EXHAUSTED' ||
          res.blockedCode === 'BILLING_OR_ACCESS_BLOCKED' ||
          res.blockedCode === 'RATE_LIMIT_PAUSED'
            ? 'PAUSED_QUOTA'
            : res.blockedCode === 'ABORTED'
              ? 'CANCELLED'
              : 'FAILED';
        if (nextStatus === 'PAUSED_QUOTA') {
          const resolvedQuota = resolveEvidenceForSubmission({
            submissionId: selectedSubmission.id,
            projectId: selectedSubmission.projectId,
            repoUrl: selectedSubmission.githubUrl
          });
          if (resolvedQuota.activeCheckpoint) {
            setCheckpoints((prev) => ({
              ...prev,
              [selectedSubmission.id]: resolvedQuota.activeCheckpoint
            }));
          }
        }
        setJobStatus(nextStatus);
        setStatusMessage(res.blockedReason || 'Gemini analysis blocked or failed.');
        return;
      }

      // Strictly read-only attachment — preserves ALL human judge scores, comments, and approval state
      setEvaluations((prev) => {
        const current = prev[selectedSubmission.id];
        if (!current) return prev;
        return {
          ...prev,
          [selectedSubmission.id]: attachAIRecommendationSafely(current, res.recommendation)
        };
      });

      const updatedCkpt: AnalysisCheckpoint = {
        jobId: `job_${selectedSubmission.id}`,
        submissionId: selectedSubmission.id,
        projectId: selectedSubmission.projectId,
        repoUrl: activeBundle.repoUrl || activeBundle.sanitizedSubmission.githubUrl,
        defaultBranch: activeBundle.coverage.defaultBranch,
        commitSha: activeBundle.coverage.commitSha,
        criteriaVersion: CRITERIA_VERSION,
        analysisVersion: ANALYSIS_VERSION,
        evidenceCollectorVersion: activeBundle.evidenceCollectorVersion || EVIDENCE_COLLECTOR_VERSION,
        evidenceKey: activeBundle.evidenceKey,
        status: 'COMPLETED',
        completedBatches: activeBundle.coverage.completedBatches,
        totalBatches: activeBundle.coverage.totalBatches,
        inspectedPaths: activeBundle.inspectedFilesList.map((f) => f.path),
        inspectedFilesSnapshot: resumeFilesRef.current[selectedSubmission.id]?.inspectedFiles,
        skippedFilesSnapshot: resumeFilesRef.current[selectedSubmission.id]?.skippedFiles,
        evidenceBundle: activeBundle,
        aiRecommendation: res.recommendation,
        lastError: null,
        quotaStopped: false,
        retryDelayMsApplied: res.retryDelayMsApplied,
        updatedAt: new Date().toISOString()
      };
      const savedAi = saveJudgingV2Checkpoint(updatedCkpt);
      setCheckpoints((prev) => ({ ...prev, [selectedSubmission.id]: savedAi.activeCheckpoint }));
      setJobStatus('COMPLETED');
      setStatusMessage(
        res.fromCache
          ? isAr
            ? 'تم تحميل توصية Gemini من الكاش بنجاح (0 طلبات API).'
            : 'Loaded Gemini advisory recommendation from cache (0 Gemini API requests used).'
          : isAr
            ? 'اكتملت توصية Gemini 4 Hydrogen الاستشارية وأُعيد تفعيل وضع الأمان للحصة تلقائياً.'
            : 'Advisory Gemini 4 Hydrogen recommendation completed cleanly and QUOTA-SAFE MODE automatically re-engaged.'
      );
    } finally {
      setExplicitAuthorized(false);
      setGuardState(judgingV2Analyzer.getState());
    }
  };

  const handleClearCache = () => {
    if (!cacheKey) return;
    clearCachedAIAnalysis(cacheKey);
    if (selectedSubmission) {
      setEvaluations((prev) => {
        const cur = prev[selectedSubmission.id];
        if (!cur) return prev;
        return {
          ...prev,
          [selectedSubmission.id]: attachAIRecommendationSafely(cur, null)
        };
      });
    }
    setStatusMessage(
      isAr ? 'تم مسح نسخة الكاش لهذا المشروع.' : 'Cleared cached AI analysis for this project.'
    );
  };

  const handleClearCheckpoint = () => {
    if (!selectedSubmission) return;
    clearJudgingV2Checkpoint(selectedSubmission.id);
    delete resumeFilesRef.current[selectedSubmission.id];
    setCheckpoints((prev) => ({ ...prev, [selectedSubmission.id]: null }));
    setPreservedVersionsBySub((prev) => ({ ...prev, [selectedSubmission.id]: [] }));
    setStatusMessage(
      isAr ? 'تم حذف نقطة الاستئناف.' : 'Cleared saved inspection checkpoint for this submission.'
    );
  };

  const handleHumanScoreChange = (criterionId: OfficialCriterionId, score: number | null) => {
    if (!selectedSubmission || !activeEvaluation) return;
    try {
      const updated = setHumanCriterionScoreV2(activeEvaluation, criterionId, score);
      setEvaluations((prev) => ({ ...prev, [selectedSubmission.id]: updated }));
      setScoringFeedback(null);
    } catch (err) {
      setScoringFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to update score.'
      });
    }
  };

  const handleHumanRationaleChange = (criterionId: OfficialCriterionId, rationale: string) => {
    if (!selectedSubmission || !activeEvaluation) return;
    try {
      const currentScore = activeEvaluation.criteria[criterionId].score;
      const updated = setHumanCriterionScoreV2(activeEvaluation, criterionId, currentScore, rationale);
      setEvaluations((prev) => ({ ...prev, [selectedSubmission.id]: updated }));
      setScoringFeedback(null);
    } catch (err) {
      setScoringFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to update rationale.'
      });
    }
  };

  const handleOverallCommentsChange = (comments: string) => {
    if (!selectedSubmission || !activeEvaluation || activeEvaluation.status === 'approved') return;
    setEvaluations((prev) => ({
      ...prev,
      [selectedSubmission.id]: {
        ...activeEvaluation,
        overallComments: comments,
        updatedAt: new Date().toISOString()
      }
    }));
  };

  const handleSaveDraft = () => {
    if (!selectedSubmission || !activeEvaluation || !user) return;
    try {
      const saved = saveHumanEvaluationDraft({
        evaluation: activeEvaluation,
        actorUid: user.uid,
        assignedSubmissionIds,
        isOrganizerOrAdmin
      });
      setEvaluations((prev) => ({ ...prev, [selectedSubmission.id]: saved }));
      setScoringFeedback({
        type: 'ok',
        text: isAr
          ? 'تم حفظ مسودة التقييم في المتصفح (localStorage).'
          : 'Human judge draft saved to browser localStorage.'
      });
    } catch (err) {
      setScoringFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to save draft.'
      });
    }
  };

  const handleApproveOfficial = () => {
    if (!selectedSubmission || !activeEvaluation || !user) return;
    try {
      const approved = finalizeAndApproveHumanEvaluation({
        evaluation: activeEvaluation,
        actorUid: user.uid,
        assignedSubmissionIds,
        isOrganizerOrAdmin
      });
      setEvaluations((prev) => ({ ...prev, [selectedSubmission.id]: approved }));
      setScoringFeedback({
        type: 'ok',
        text: isAr
          ? `تم اعتماد النتيجة الرسمية النهائية: ${approved.finalWeightedScore?.toFixed(2)}/100 وتم إغلاق التقييم.`
          : `Official evaluation approved & locked: ${approved.finalWeightedScore?.toFixed(2)}/100.`
      });
    } catch (err) {
      setScoringFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to approve evaluation.'
      });
    }
  };

  const handleExportAuditJson = () => {
    if (!sanitizedSubmission || !activeEvaluation) return;
    const exportPayload = {
      exportedAt: new Date().toISOString(),
      criteriaDefinition: OFFICIAL_JUDGING_CRITERIA.map((c) => ({
        id: c.id,
        name: c.name,
        weightPercent: c.weightPercent
      })),
      sanitizedSubmission,
      eligibilityReport,
      evidenceBundle: activeBundle,
      officialHumanEvaluation: activeEvaluation
    };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `hackmind-judging-v2-${sanitizedSubmission.id}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
        {isAr ? 'جاري تحميل مساحة التحكيم المبنية على الأدلة...' : 'Loading Evidence-Based Judging System...'}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">
              {isAr ? 'نظام التحكيم المبني على الأدلة (V2)' : 'Evidence-Based Judging System (V2)'}
            </h1>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 max-w-3xl">
            {isAr
              ? 'نظام تحكيم مستقل تماماً يعتمد حصرياً على المعايير الأربعة الثابتة (25% / 30% / 25% / 20%)، يستبعد مقاطع الفيديو كلياً، ويحمي حصة Gemini عبر التفعيل الصريح فقط.'
              : 'Independent evidence-verified judging system using strictly the four official criteria (25% / 30% / 25% / 20%), complete video exclusion, and QUOTA-SAFE MODE protection.'}
          </p>
        </div>

        <Link
          to="/app/judging"
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <Gavel className="h-3.5 w-3.5" />
          <span>{isAr ? 'مساحة التحكيم الكلاسيكية' : 'Legacy Judge Workspace'}</span>
        </Link>
      </header>

      {loadError && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-xs text-red-700 dark:text-red-300">
          {loadError}
        </div>
      )}

      {submissions.length === 0 ? (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-8 text-center space-y-3">
          <FolderGit2 className="h-8 w-8 text-slate-400 mx-auto" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
            {isAr ? 'لا توجد مشاريع مسندة للتحكيم حالياً' : 'No Assigned Submissions Available'}
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-400 max-w-lg mx-auto">
            {isAr
              ? 'يعرض هذا النظام المشاريع المُسندة لك كمحكّم معتمد أو مشاريع الهاكاثونات التي تنظمها دون إنشاء بيانات وهمية.'
              : 'Only real Firestore submissions assigned to your accepted judge account (or organized by you) appear here. Accept a judge assignment or manage submissions in Organizer Studio.'}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
            <Link
              to="/app/judging"
              className="rounded-lg bg-blue-600 text-white px-4 py-2 text-xs font-semibold hover:bg-blue-700"
            >
              {isAr ? 'الانتقال لمساحة التحكيم' : 'Open Judge Assignments'}
            </Link>
            <Link
              to="/app/organizer"
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {isAr ? 'استوديو المنظمين' : 'Organizer Studio'}
            </Link>
          </div>
        </section>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Submission Selector Sidebar */}
          <aside className="xl:col-span-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {isAr ? 'المشاريع المتاحة' : 'Submissions'}
              </h2>
              <span className="font-mono text-xs tabular-nums text-slate-600 dark:text-slate-300">
                {submissions.length}
              </span>
            </div>

            <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-[540px] overflow-y-auto">
              {submissions.map((sub) => {
                const selected = sub.id === selectedSubmissionId;
                const localEval = evaluations[sub.id];
                return (
                  <button
                    key={sub.id}
                    type="button"
                    onClick={() => setSelectedSubmissionId(sub.id)}
                    className={`w-full text-start py-3 px-2.5 rounded-lg transition-colors ${
                      selected
                        ? 'bg-blue-600/10 text-blue-700 dark:text-blue-300'
                        : 'hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-800 dark:text-slate-200'
                    }`}
                  >
                    <div className="text-xs font-semibold truncate">{sub.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                      <span className="truncate">{sub.teamName || sub.teamId}</span>
                      <span>·</span>
                      <span>{sub.track || 'General'}</span>
                      {localEval?.status === 'approved' && (
                        <>
                          <span>·</span>
                          <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                            {localEval.finalWeightedScore?.toFixed(1)}
                          </span>
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Main Evidence & Judging Workbench */}
          {sanitizedSubmission && activeEvaluation && eligibilityReport && (
            <div className="xl:col-span-9 space-y-5 min-w-0">
              {/* Sanitized Project Summary (Strictly Zero Video URL/Player) */}
              <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h2 className="text-base font-bold text-slate-900 dark:text-white">
                      {sanitizedSubmission.title}
                    </h2>
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-600 dark:text-slate-400 font-mono">
                      <span>{sanitizedSubmission.teamName || sanitizedSubmission.teamId}</span>
                      <span>·</span>
                      <span>{selectedHackathon?.title || sanitizedSubmission.hackathonId}</span>
                      <span>·</span>
                      <span>{sanitizedSubmission.track || 'General'}</span>
                      <span>·</span>
                      <span className="text-emerald-700 dark:text-emerald-400">
                        {isAr ? 'الفيديو مستبعد كلياً' : 'Video Excluded'}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {sanitizedSubmission.githubUrl && (
                      <a
                        href={sanitizedSubmission.githubUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 font-mono text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        <span>GitHub</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    {sanitizedSubmission.demoUrl && (
                      <a
                        href={sanitizedSubmission.demoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 font-mono text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        <span>App URL</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </div>

                <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                  {sanitizedSubmission.shortDescription}
                </p>

                {sanitizedSubmission.technologies.length > 0 && (
                  <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                    {isAr ? 'التقنيات المعلنة: ' : 'Declared Stack: '}
                    {sanitizedSubmission.technologies.join(' · ')}
                  </div>
                )}
              </section>

              <QuotaAndJobControlBar
                locale={locale}
                guardState={guardState}
                jobStatus={jobStatus}
                cacheKey={cacheKey}
                hasCacheHit={Boolean(cachedRecommendation)}
                checkpoint={activeCheckpoint}
                hasBundle={Boolean(activeBundle)}
                batchProgress={batchProgress}
                preferredMode={preferredMode}
                cloudConsent={Boolean(privateInfo?.aiCloudConsent)}
                explicitAuthorized={explicitAuthorized}
                onToggleAuthorizeGemini={handleToggleAuthorizeGemini}
                onModeChange={handleModeChange}
                onGrantCloudConsent={() => updateCloudConsent(true)}
                onCollectEvidence={(resume) => void handleCollectEvidence(resume)}
                onCancelJob={handleCancelJob}
                onLoadCachedRecommendation={handleLoadCachedRecommendation}
                onRunGeminiAnalysis={() => void handleRunGeminiAnalysis()}
                onClearCache={handleClearCache}
                onClearCheckpoint={handleClearCheckpoint}
                statusMessage={statusMessage}
              />

              <EligibilitySection locale={locale} report={eligibilityReport} />

              <EvidenceCoveragePanel
                locale={locale}
                bundle={activeBundle}
                preservedVersions={preservedVersionsBySub[sanitizedSubmission.id] || []}
                attachedTestLog={attachedTestLog}
                onTestLogChange={setAttachedTestLog}
                onRecomputeTestsFromLog={() => void handleRecomputeTestsFromLog()}
                onInspectAdditional={() =>
                  void handleCollectEvidence(true, {
                    inspectAdditionalUninspected: true,
                    expandTruncatedFiles: true
                  })
                }
                isCollecting={jobStatus === 'COLLECTING_EVIDENCE'}
                workflowChecks={
                  activeEvaluation.workflowChecks.length > 0
                    ? activeEvaluation.workflowChecks
                    : activeBundle?.workflowChecks || []
                }
                isApprovedLocked={activeEvaluation.status === 'approved'}
                onUpdateWorkflowCheck={handleUpdateWorkflowCheck}
              />

              <OnDeviceQuickHelpersPanel
                key={sanitizedSubmission.id}
                locale={locale}
                bundle={activeBundle}
                projectTitle={sanitizedSubmission.title}
                projectDescription={sanitizedSubmission.shortDescription}
                cloudConsent={Boolean(privateInfo?.aiCloudConsent)}
                onGrantCloudConsent={() => updateCloudConsent(true)}
                userId={user?.uid}
                emailVerified={emailVerified}
              />

              <AIRecommendationsPanel
                locale={locale}
                recommendation={displayedRecommendation}
                quotaSafeMode={guardState.quotaSafeMode && !explicitAuthorized}
                quotaStopped={guardState.quotaStopped}
                quotaStopReason={guardState.quotaStopReason}
              />

              <HumanScoringPanel
                locale={locale}
                evaluation={activeEvaluation}
                canApproveAsJudge={canApproveAsJudge}
                actionFeedback={scoringFeedback}
                onScoreChange={handleHumanScoreChange}
                onRationaleChange={handleHumanRationaleChange}
                onOverallCommentsChange={handleOverallCommentsChange}
                onSaveDraft={handleSaveDraft}
                onApproveOfficial={handleApproveOfficial}
                onExportAuditJson={handleExportAuditJson}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
