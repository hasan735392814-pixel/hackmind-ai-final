import type { GitHubFileCategory, SkippedFileReason } from '../github/repoInspector';

export type VerificationStatus =
  | 'CODE_CONFIRMED'
  | 'TEST_CONFIRMED'
  | 'RUNTIME_CONFIRMED'
  | 'PRODUCTION_CONFIRMED'
  | 'UNVERIFIED'
  | 'CONTRADICTED'
  | 'BLOCKED'
  | 'NOT_APPLICABLE';

export const VALID_VERIFICATION_STATUSES = [
  'CODE_CONFIRMED',
  'TEST_CONFIRMED',
  'RUNTIME_CONFIRMED',
  'PRODUCTION_CONFIRMED',
  'UNVERIFIED',
  'CONTRADICTED',
  'BLOCKED',
  'NOT_APPLICABLE'
] as const;

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export type ProjectInspectionStrategy =
  | 'payments'
  | 'ai'
  | 'data_driven'
  | 'security_auth'
  | 'general';

export type HackathonRequirementKind =
  | 'mandatory_eligibility'
  | 'mandatory_submission'
  | 'mandatory_technology'
  | 'mandatory_track'
  | 'prohibited_practice'
  | 'scored_rubric';

export interface HackathonRequirementItem {
  id: string;
  kind: HackathonRequirementKind;
  mandatory: boolean;
  title: string;
  exactWording: string;
  sourceField: string;
  weight?: number;
}

export interface MissingRequirementConfigItem {
  field: string;
  status: 'UNVERIFIED' | 'BLOCKED';
  reason: string;
}

export interface HackathonRequirementsBundle {
  hackathonId: string;
  hackathonTitle: string;
  extractedAt: string;
  mandatoryRequirements: HackathonRequirementItem[];
  scoredCriteria: HackathonRequirementItem[];
  rubricWeightSum: number;
  rubricWeightsValid: boolean;
  missingRequirementFields: MissingRequirementConfigItem[];
}

export interface FileCitation {
  path: string;
  startLine?: number;
  endLine?: number;
  blobUrl?: string;
}

export interface EvidenceRecord {
  id: string;
  claimOrRequirement: string;
  verificationMethod:
    | 'static_code_audit'
    | 'executed_test_output'
    | 'runtime_log'
    | 'live_demo_probe'
    | 'ci_workflow_metadata'
    | 'metadata_check';
  evidenceSource: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  blobUrl?: string;
  commitSha?: string | null;
  observedAt: string;
  observedResult: string;
  status: VerificationStatus;
  confidence: ConfidenceLevel;
  confidenceReason: string;
  limitations: string[];
}

export interface VerificationMatrixRow {
  requirementId: string;
  requirementTitle: string;
  exactWording: string;
  sourceField: string;
  mandatory: boolean;
  weight?: number;
  submissionClaim: string;
  relevantFiles: FileCitation[];
  staticCodeEvidence: string[];
  executedTestEvidence: string[];
  runtimeEvidence: string[];
  productionEvidence: string[];
  finalStatus: VerificationStatus;
  confidence: ConfidenceLevel;
  missingProofOrAction: string;
}

export interface ExecutedTestRecord {
  id: string;
  command: string;
  scope: string;
  exitCode: number | null;
  passedCount?: number;
  failedCount?: number;
  skippedCount?: number;
  stdoutExcerpt: string;
  timestamp: string;
  source: 'user_attached_ci_log' | 'github_actions_metadata';
  status: 'TEST_CONFIRMED' | 'CONTRADICTED' | 'BLOCKED' | 'UNVERIFIED';
  headSha?: string | null;
  headBranch?: string | null;
  matchesInspectedCommit?: boolean;
}

export type CanonicalFileInspectionStatus =
  | 'FULLY_INSPECTED'
  | 'PARTIALLY_INSPECTED'
  | 'SKIPPED'
  | 'INACCESSIBLE'
  | 'FAILED';

export interface LiveDemoCheckResult {
  demoUrl: string;
  checkedAt: string;
  reachable: boolean;
  httpStatus: number | null;
  finalUrl?: string | null;
  contentType?: string | null;
  corsBlocked: boolean;
  browserCorsBlocked?: boolean;
  requiresAuth: boolean;
  probeMethod?: 'browser_fetch' | 'server_http_probe' | 'manual_required';
  manualVerificationRequired?: boolean;
  checkedAspects: string[];
  blockedAspects: string[];
  status: VerificationStatus;
  summary: string;
}

export interface FileContentChunk {
  startLine: number;
  endLine: number;
  content: string;
}

export interface FileInventoryItem {
  path: string;
  category: GitHubFileCategory | 'excluded' | 'other';
  sizeBytes: number;
  sha?: string;
  inspectionStatus: 'inspected' | 'partially_inspected' | 'skipped' | 'inaccessible' | 'failed';
  auditStatus?: CanonicalFileInspectionStatus;
  reason:
    | SkippedFileReason
    | 'inspected_complete'
    | 'inspected_chunked'
    | 'non_code_documentation'
    | 'batch_interrupted'
    | 'duplicate_mirror';
  chunks?: Array<{ startLine: number; endLine: number }>;
}

export interface DuplicateFileGroup {
  sha: string;
  paths: string[];
}

export interface ProjectRootCandidate {
  rootPath: string;
  manifestFiles: string[];
  fileCount: number;
  matchScore: number;
  selectedAsPrimary: boolean;
  reason: string;
}

export interface CriterionObservation {
  criterionId: string;
  criterionName: string;
  weight: number;
  description: string;
  status: VerificationStatus;
  observations: string[];
  citations: FileCitation[];
  missingProof: string[];
}

export type AuditExecutionStatus = 'COMPLETED' | 'PARTIAL' | 'INTERRUPTED' | 'FAILED';

export type StageExecutionState =
  | 'pending'
  | 'active'
  | 'completed'
  | 'skipped'
  | 'interrupted'
  | 'failed';

export interface BatchStageTracker {
  discover: StageExecutionState;
  ci: StageExecutionState;
  ciNote?: string;
  audit: StageExecutionState;
  merge: StageExecutionState;
}

export interface BatchAnalysisProgress {
  stage:
    | 'discovering_repo'
    | 'probing_demo'
    | 'checking_ci'
    | 'running_batch'
    | 'merging_report'
    | 'interrupted'
    | 'completed';
  currentBatch: number;
  totalBatches: number;
  pendingBatches?: number;
  filesInspectedSoFar: number;
  filesFetchedSoFar?: number;
  totalEligibleFiles: number;
  selectedModel?: string;
  executedModel?: string;
  fallbackModel?: string;
  retryAttempts?: number;
  detail?: string;
  stageStatus?: BatchStageTracker;
}

export interface ComprehensiveJudgingReport {
  reportVersion: '2.0';
  generatedAt: string;
  auditStatus?: AuditExecutionStatus;
  auditStatusReason?: string;
  resumable?: boolean;
  submissionId?: string;
  submissionTitle: string;
  hackathonId?: string;
  hackathonTitle: string;
  commitSha: string | null;
  detectedStrategies: ProjectInspectionStrategy[];
  requirementsBundle: HackathonRequirementsBundle;
  sectionA_eligibility: {
    overallStatus: VerificationStatus;
    checks: EvidenceRecord[];
  };
  sectionB_coverage: {
    accessible: boolean;
    repoFullName: string | null;
    defaultBranch: string | null;
    commitSha: string | null;
    commitShaVerified?: boolean;
    treeDiscoveryMethod: 'git_trees' | 'contents_api_bfs' | 'none';
    treeTruncated: boolean;
    totalFilesInTree: number;
    filesSelectedCount?: number;
    filesFetchedCount?: number;
    readmeInspected?: boolean;
    inspectedSourceFilesCount?: number;
    fullyInspectedCount: number;
    partiallyInspectedCount: number;
    skippedCount: number;
    inaccessibleCount: number;
    failedCount: number;
    interrupted?: boolean;
    batchesCompleted?: number;
    batchesPendingCount?: number;
    batchesInterruptedCount?: number;
    batchesTotal?: number;
    hasFullCoverage: boolean;
    coverageHonestyNote: string;
    duplicateFileGroups: DuplicateFileGroup[];
    projectRoots: ProjectRootCandidate[];
    hasDivergentRoots: boolean;
    importantUninspected: Array<{ path: string; category: string; reason: string }>;
    fileInventory: FileInventoryItem[];
  };
  sectionC_matrix: VerificationMatrixRow[];
  sectionD_architecture: EvidenceRecord[];
  sectionE_tests: {
    discoveredTestFiles: string[];
    detectedTestFrameworks?: string[];
    detectedTestCommands?: string[];
    executedTests: ExecutedTestRecord[];
    summaryStatus: VerificationStatus;
    honestyNote: string;
  };
  sectionF_liveDemo: LiveDemoCheckResult;
  sectionG_security: {
    redactedSecretsCount: number;
    findings: EvidenceRecord[];
  };
  sectionH_contradictions: EvidenceRecord[];
  sectionI_missingEvidence: {
    missingItems: string[];
    teamQuestions: string[];
  };
  sectionJ_criterionObservations: CriterionObservation[];
  sectionK_confidence: {
    overallConfidence: ConfidenceLevel;
    reason: string;
    limitations: string[];
  };
  // Backward-compatible summary fields for compact Firestore storage and legacy consumers
  verifiedEvidence: string[];
  teamClaims: string[];
  missingEvidence: string[];
  technicalObservations: string[];
  potentialRisks: string[];
  suggestedQuestions: string[];
  inspectedSources: string[];
  uninspectedSources: string[];
}
