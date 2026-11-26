import type { InferenceMode } from 'firebase/ai';
import type { InspectedRepoFile, SkippedRepoFile } from '../github/repoInspector';

export type OfficialCriterionId =
  | 'innovation_originality'
  | 'technical_implementation'
  | 'real_world_impact'
  | 'ux_completeness';

export interface OfficialCriterionDefinition {
  id: OfficialCriterionId;
  name: string;
  nameAr: string;
  weight: number;
  weightPercent: number;
  description: string;
  descriptionAr: string;
  evidenceStandard: string;
  evidenceStandardAr: string;
}

export type EvidenceStatus =
  | 'VERIFIED'
  | 'PARTIALLY_VERIFIED'
  | 'UNVERIFIED'
  | 'FAILED';

export type EligibilityStatus =
  | 'PASS'
  | 'FAIL'
  | 'UNVERIFIED'
  | 'NOT_APPLICABLE';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export type AnalysisJobStatus =
  | 'IDLE'
  | 'COLLECTING_EVIDENCE'
  | 'EVIDENCE_READY'
  | 'AWAITING_GEMINI_AUTH'
  | 'RUNNING_GEMINI'
  | 'PAUSED_QUOTA'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'FAILED';

export interface SanitizedSubmissionWithoutVideo {
  id: string;
  hackathonId: string;
  organizerId: string;
  teamId: string;
  teamName: string;
  projectId: string;
  ownerId: string;
  memberIds: string[];
  memberNames: string[];
  title: string;
  shortDescription: string;
  fullDescription: string;
  problemStatement: string;
  proposedSolution: string;
  technologies: string[];
  githubUrl: string;
  demoUrl: string;
  track: string;
  status: string;
  submittedAt?: unknown;
  videoExcluded: true;
}

export interface EligibilityCheckItem {
  id: 'submission_status' | 'team_size' | 'submission_deadline' | 'track_match' | 'competition_rules';
  label: string;
  labelAr: string;
  status: EligibilityStatus;
  ruleSource: string;
  actualValue: string;
  expectedRule: string;
  note: string;
}

export interface EligibilityReport {
  evaluatedAt: string;
  hackathonAccessible: boolean;
  separatedFromScoring: true;
  checks: EligibilityCheckItem[];
  summary: {
    passCount: number;
    failCount: number;
    unverifiedCount: number;
    notApplicableCount: number;
  };
}

export interface SkippedFileBreakdown {
  duplicateMirror: number;
  unselectedMirrorConfig?: number;
  unselectedRootMetaOrConfig?: number;
  nonCodeOrUnselected: number;
  binaryOrAsset: number;
  fileCountLimit: number;
  oversized: number;
  sensitive: number;
  budgetLimit: number;
  batchInterrupted: number;
}

export interface SkippedFileDetail {
  path: string;
  reason: string;
  category: string;
  sizeBytes?: number;
}

export interface RepoCoverageReport {
  accessible: boolean;
  repoFullName: string | null;
  defaultBranch: string | null;
  commitSha: string | null;
  commitShaVerified: boolean;
  primaryRootPath: string | null;
  hasDivergentRoots: boolean;
  totalTreeEntries: number;
  uniqueSourceFiles: number;
  inspectedFiles: number;
  partiallyInspectedFiles: number;
  skippedFiles: number;
  inaccessibleFiles: number;
  failedFiles: number;
  readmeAndDocsCount: number;
  excludedBinaryAndLockCount?: number;
  skippedBreakdown?: SkippedFileBreakdown;
  skippedFilesList?: SkippedFileDetail[];
  excludedDocsList?: SkippedFileDetail[];
  excludedBinaryAndLockList?: SkippedFileDetail[];
  completedBatches: number;
  totalBatches: number;
  treeTruncated: boolean;
  redactedSecretsCount: number;
  note: string;
}

export interface EvidenceFinding {
  id: string;
  category:
    | 'repository'
    | 'source_code'
    | 'dependencies'
    | 'api_integration'
    | 'tests'
    | 'live_app'
    | 'impact_evidence'
    | 'ux_workflow';
  criterionId?: OfficialCriterionId;
  title: string;
  status: EvidenceStatus;
  sourceType:
    | 'github_tree'
    | 'source_file'
    | 'dependency_manifest'
    | 'ci_workflow_run'
    | 'executed_test_log'
    | 'server_http_probe'
    | 'judge_observation'
    | 'submission_metadata';
  sourceLabel: string;
  filePath?: string;
  lineRange?: string;
  snippet?: string;
  testResultSummary?: string;
  workflowRef?: string;
  detail: string;
}

export interface ObservableWorkflowCheck {
  id: string;
  label: string;
  status: EvidenceStatus;
  notes: string;
  checkedByJudge: boolean;
  checkedAt?: string;
}

export interface PublicAppProbeEvidence {
  url: string;
  checkedAt: string;
  reachable: boolean;
  httpStatus: number | null;
  finalUrl: string | null;
  title: string | null;
  requiresAuth: boolean;
  hasCrashBanner: boolean;
  reachabilityStatus: EvidenceStatus;
  functionalityStatus: EvidenceStatus;
  summary: string;
}

export interface ExecutedTestVerification {
  status: EvidenceStatus;
  source: 'github_actions' | 'judge_test_log' | 'none';
  executed: boolean;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  discoveredTestFilesCount: number;
  summary: string;
  references: string[];
}

export interface EvidenceBundle {
  bundleId: string;
  evidenceKey?: string;
  submissionId: string;
  projectId: string;
  repoUrl?: string;
  defaultBranch?: string | null;
  commitSha?: string | null;
  criteriaVersion?: string;
  evidenceCollectorVersion?: string;
  collectedAt: string;
  sanitizedSubmission: SanitizedSubmissionWithoutVideo;
  coverage: RepoCoverageReport;
  findings: EvidenceFinding[];
  dependencies: string[];
  apiEndpointsDetected: Array<{ filePath: string; lineRange: string; signature: string }>;
  clientApiHelpersDetected?: Array<{ filePath: string; lineRange: string; signature: string }>;
  testVerification: ExecutedTestVerification;
  publicAppProbe: PublicAppProbeEvidence;
  workflowChecks: ObservableWorkflowCheck[];
  epistemicNotices: string[];
  inspectedFilesList: Array<{
    path: string;
    category: string;
    totalLines: number;
    truncated: boolean;
    status: 'FULLY_INSPECTED' | 'PARTIALLY_INSPECTED';
  }>;
}

export interface CriterionAIRecommendation {
  criterionId: OfficialCriterionId;
  criterionName: string;
  weightPercent: number;
  recommendedScore: number;
  confidence: ConfidenceLevel;
  verifiedEvidence: string[];
  strengths: string[];
  weaknesses: string[];
  missingOrUnverifiedEvidence: string[];
  scoringExplanation: string;
}

export interface AIJudgingRecommendation {
  recommendationId: string;
  cacheKey: string;
  projectId: string;
  submissionId: string;
  repoUrl: string;
  commitSha: string;
  criteriaVersion: string;
  analysisVersion: string;
  generatedAt: string;
  modelUsed: string;
  inferenceSource: string;
  fromCache: boolean;
  geminiRequestsUsed: number;
  advisoryOnly: true;
  criteriaRecommendations: Record<OfficialCriterionId, CriterionAIRecommendation>;
  advisoryWeightedScore: number;
  overallSummary: string;
  disclaimers: string[];
}

export interface AnalysisCheckpoint {
  jobId: string;
  submissionId: string;
  projectId: string;
  repoUrl: string;
  defaultBranch?: string | null;
  commitSha: string | null;
  criteriaVersion: string;
  analysisVersion: string;
  evidenceCollectorVersion?: string;
  evidenceKey?: string;
  status: AnalysisJobStatus;
  completedBatches: number;
  totalBatches: number;
  inspectedPaths: string[];
  inspectedFilesSnapshot?: InspectedRepoFile[];
  skippedFilesSnapshot?: SkippedRepoFile[];
  evidenceBundle: EvidenceBundle | null;
  aiRecommendation: AIJudgingRecommendation | null;
  lastError: string | null;
  quotaStopped: boolean;
  retryDelayMsApplied?: number;
  updatedAt: string;
}

export interface PersistedEvidenceRecord {
  evidenceKey: string;
  submissionId: string;
  projectId: string;
  repoUrl: string;
  defaultBranch: string | null;
  commitSha: string | null;
  criteriaVersion: string;
  evidenceCollectorVersion: string;
  collectedAt: string;
  bundle: EvidenceBundle;
  inspectedFilesSnapshot?: InspectedRepoFile[];
  skippedFilesSnapshot?: SkippedRepoFile[];
  status: 'ACTIVE' | 'SUPERSEDED';
  supersededByKey?: string;
  legacyOrStaleReason?: string;
}

export interface EvidenceVersionResolution {
  activeRecord: PersistedEvidenceRecord | null;
  activeCheckpoint: AnalysisCheckpoint | null;
  preservedVersions: PersistedEvidenceRecord[];
  preservedCheckpoints: AnalysisCheckpoint[];
  hasConflict: boolean;
  needsUpgrade: boolean;
}

export interface HumanCriterionEvaluation {
  criterionId: OfficialCriterionId;
  score: number | null;
  rationale: string;
}

export interface HumanJudgingEvaluation {
  id: string;
  submissionId: string;
  hackathonId: string;
  judgeId: string;
  judgeName: string;
  criteriaVersion: string;
  status: 'draft' | 'approved';
  criteria: Record<OfficialCriterionId, HumanCriterionEvaluation>;
  finalWeightedScore: number | null;
  overallComments: string;
  workflowChecks: ObservableWorkflowCheck[];
  aiRecommendationSnapshot: AIJudgingRecommendation | null;
  approvedAt: string | null;
  updatedAt: string;
}

export interface QuotaGuardState {
  quotaSafeMode: boolean;
  geminiAuthorizedForRun: boolean;
  requestInFlight: boolean;
  activeSubmissionId: string | null;
  requestsSentSession: number;
  cacheHitsSession: number;
  lastRetryDelayMs: number | null;
  quotaStopped: boolean;
  quotaStopReason: string | null;
  preferredInferenceMode: InferenceMode;
}
