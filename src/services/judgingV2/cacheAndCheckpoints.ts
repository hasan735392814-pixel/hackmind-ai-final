import {
  ANALYSIS_VERSION,
  CRITERIA_VERSION,
  EVIDENCE_COLLECTOR_VERSION
} from './criteria';
import type { InspectedRepoFile, SkippedRepoFile } from '../github/repoInspector';
import type {
  AIJudgingRecommendation,
  AnalysisCheckpoint,
  EvidenceBundle,
  EvidenceVersionResolution,
  PersistedEvidenceRecord,
  RepoCoverageReport,
  SkippedFileBreakdown,
  SkippedFileDetail
} from './types';

const CACHE_PREFIX = 'hackmind_judging_v2_cache:';
const CHECKPOINT_PREFIX = 'hackmind_judging_v2_ckpt:';
const CHECKPOINT_HISTORY_PREFIX = 'hackmind_judging_v2_ckpt_hist:';
const EVIDENCE_RECORD_PREFIX = 'hackmind_judging_v2_ev:';
const EVIDENCE_INDEX_PREFIX = 'hackmind_judging_v2_ev_idx:';
const MAX_CACHE_ENTRIES = 40;
const MAX_HISTORY_ENTRIES = 12;

export interface CacheKeyInput {
  projectId: string;
  repoUrl: string;
  commitSha: string | null | undefined;
  criteriaVersion?: string;
  analysisVersion?: string;
}

export interface EvidenceKeyInput {
  projectId: string;
  repoUrl: string;
  defaultBranch?: string | null;
  commitSha: string | null | undefined;
  criteriaVersion?: string;
  evidenceCollectorVersion?: string;
}

export function normalizeRepoUrlForCache(repoUrl: string): string {
  return (repoUrl || '')
    .trim()
    .toLowerCase()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

export function buildAnalysisCacheKey(input: CacheKeyInput): string {
  const projectId = (input.projectId || 'unknown_project').trim();
  const repoUrl = normalizeRepoUrlForCache(input.repoUrl) || 'no_repo';
  const commitSha = (input.commitSha || '').trim() || 'no_commit_sha';
  const criteriaVersion = input.criteriaVersion || CRITERIA_VERSION;
  const analysisVersion = input.analysisVersion || ANALYSIS_VERSION;
  return `${projectId}::${repoUrl}::${commitSha}::${criteriaVersion}::${analysisVersion}`;
}

export function buildEvidenceRecordKey(input: EvidenceKeyInput): string {
  const projectId = (input.projectId || 'unknown_project').trim();
  const repoUrl = normalizeRepoUrlForCache(input.repoUrl) || 'no_repo';
  const branch = (input.defaultBranch || '').trim() || 'HEAD';
  const commitSha = (input.commitSha || '').trim() || 'no_commit_sha';
  const criteriaVersion = input.criteriaVersion || CRITERIA_VERSION;
  const collectorVersion = input.evidenceCollectorVersion || EVIDENCE_COLLECTOR_VERSION;
  return `${projectId}::${repoUrl}::${branch}::${commitSha}::${criteriaVersion}::${collectorVersion}`;
}

const memoryCache = new Map<string, AIJudgingRecommendation>();
const memoryCheckpoints = new Map<string, AnalysisCheckpoint>();
const memoryCheckpointHistory = new Map<string, AnalysisCheckpoint[]>();
const memoryEvidenceRecords = new Map<string, PersistedEvidenceRecord>();
const memoryEvidenceSubmissionIndex = new Map<string, string[]>();

function safeGetStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function isDocPathForReconcile(filePath: string): boolean {
  const lower = (filePath || '').replace(/^\/+/, '').toLowerCase();
  const base = lower.split('/').pop() || '';
  return (
    /^readme(\.[a-z0-9]+)?$/i.test(base) ||
    base.endsWith('.md') ||
    base.endsWith('.mdx') ||
    base.endsWith('.txt') ||
    lower.startsWith('docs/')
  );
}

function isMirrorPathForReconcile(filePath: string): boolean {
  return /(^|\/)(github[_-]?upload|uploads?|mirror|mirrored|backup|old|deprecated|archive)(\/|$)/i.test(
    (filePath || '').replace(/^\/+/, '')
  );
}

/**
 * Normalizes and reconciles any RepoCoverageReport (including legacy v2.collector.1 records)
 * so uniqueSourceFiles === inspected + partial + skipped + inaccessible + failed,
 * and skippedFilesList matches skippedFiles 1-to-1 (never mixing binary_or_asset or docs into skipped source lists).
 */
export function reconcileCoverageReport(coverage: RepoCoverageReport): RepoCoverageReport {
  if (!coverage || !coverage.accessible) {
    return coverage;
  }

  const rawSkipped = Array.isArray(coverage.skippedFilesList) ? coverage.skippedFilesList : [];
  const rawDocs = Array.isArray(coverage.excludedDocsList) ? coverage.excludedDocsList : [];
  const rawBinaries = Array.isArray(coverage.excludedBinaryAndLockList)
    ? coverage.excludedBinaryAndLockList
    : [];

  const skippedSourceMap = new Map<string, SkippedFileDetail>();
  const docsMap = new Map<string, SkippedFileDetail>();
  const binariesMap = new Map<string, SkippedFileDetail>();

  for (const d of rawDocs) {
    docsMap.set(d.path, d);
  }
  for (const b of rawBinaries) {
    binariesMap.set(b.path, { ...b, reason: 'binary_or_asset' });
  }

  for (const item of rawSkipped) {
    if (item.reason === 'binary_or_asset') {
      if (!binariesMap.has(item.path)) {
        binariesMap.set(item.path, { ...item, reason: 'binary_or_asset' });
      }
      continue;
    }
    if (isDocPathForReconcile(item.path) && item.reason === 'non_code_documentation') {
      if (!docsMap.has(item.path)) {
        docsMap.set(item.path, item);
      }
      continue;
    }
    const normalizedReason =
      item.reason === 'non_code_documentation' && !isDocPathForReconcile(item.path)
        ? isMirrorPathForReconcile(item.path)
          ? 'unselected_mirror_config_or_asset'
          : 'unselected_config_or_asset'
        : item.reason;
    skippedSourceMap.set(item.path, { ...item, reason: normalizedReason });
  }

  const skippedFilesList = Array.from(skippedSourceMap.values());
  const excludedDocsList = Array.from(docsMap.values());
  const excludedBinaryAndLockList = Array.from(binariesMap.values());

  const excludedBinaryAndLockCount = Math.max(
    coverage.excludedBinaryAndLockCount ?? 0,
    excludedBinaryAndLockList.length
  );
  const readmeAndDocsCount = Math.max(coverage.readmeAndDocsCount ?? 0, excludedDocsList.length);

  // Reconcile skippedFiles count cleanly
  const accountedWithoutSkipped =
    (coverage.inspectedFiles || 0) +
    (coverage.partiallyInspectedFiles || 0) +
    (coverage.inaccessibleFiles || 0) +
    (coverage.failedFiles || 0);

  let reconciledSkippedFiles = coverage.skippedFiles || 0;
  let reconciledUniqueSource = coverage.uniqueSourceFiles || 0;

  if (skippedFilesList.length > 0) {
    reconciledSkippedFiles = skippedFilesList.length;
    if (coverage.totalTreeEntries > 0) {
      const derivedUnique = Math.max(
        accountedWithoutSkipped + reconciledSkippedFiles,
        coverage.totalTreeEntries - readmeAndDocsCount - excludedBinaryAndLockCount
      );
      reconciledUniqueSource = derivedUnique;
    } else {
      reconciledUniqueSource = accountedWithoutSkipped + reconciledSkippedFiles;
    }
  } else if (reconciledUniqueSource >= accountedWithoutSkipped) {
    reconciledSkippedFiles = reconciledUniqueSource - accountedWithoutSkipped;
  }

  let duplicateMirror = 0;
  let unselectedMirrorConfig = 0;
  let unselectedRootMetaOrConfig = 0;
  let fileCountLimit = 0;
  let oversized = 0;
  let sensitive = 0;
  let budgetLimit = 0;
  let batchInterrupted = 0;

  if (skippedFilesList.length > 0) {
    for (const s of skippedFilesList) {
      if (s.reason === 'duplicate_mirror') duplicateMirror += 1;
      else if (s.reason === 'unselected_mirror_config_or_asset') unselectedMirrorConfig += 1;
      else if (s.reason === 'file_count_limit') fileCountLimit += 1;
      else if (s.reason === 'file_too_large') oversized += 1;
      else if (s.reason === 'sensitive_env_or_secret_file') sensitive += 1;
      else if (s.reason === 'budget_limit') budgetLimit += 1;
      else if (s.reason === 'batch_interrupted') batchInterrupted += 1;
      else unselectedRootMetaOrConfig += 1;
    }
  } else if (coverage.skippedBreakdown) {
    duplicateMirror = coverage.skippedBreakdown.duplicateMirror || 0;
    unselectedMirrorConfig = coverage.skippedBreakdown.unselectedMirrorConfig || 0;
    unselectedRootMetaOrConfig =
      coverage.skippedBreakdown.unselectedRootMetaOrConfig ??
      Math.max(0, (coverage.skippedBreakdown.nonCodeOrUnselected || 0) - unselectedMirrorConfig);
    fileCountLimit = coverage.skippedBreakdown.fileCountLimit || 0;
    oversized = coverage.skippedBreakdown.oversized || 0;
    sensitive = coverage.skippedBreakdown.sensitive || 0;
    budgetLimit = coverage.skippedBreakdown.budgetLimit || 0;
    batchInterrupted = coverage.skippedBreakdown.batchInterrupted || 0;
  }

  const skippedBreakdown: SkippedFileBreakdown = {
    duplicateMirror,
    unselectedMirrorConfig,
    unselectedRootMetaOrConfig,
    nonCodeOrUnselected: unselectedMirrorConfig + unselectedRootMetaOrConfig,
    binaryOrAsset: excludedBinaryAndLockCount,
    fileCountLimit,
    oversized,
    sensitive,
    budgetLimit,
    batchInterrupted
  };

  return {
    ...coverage,
    uniqueSourceFiles: reconciledUniqueSource,
    skippedFiles: reconciledSkippedFiles,
    readmeAndDocsCount,
    excludedBinaryAndLockCount,
    skippedBreakdown,
    skippedFilesList,
    excludedDocsList,
    excludedBinaryAndLockList
  };
}

export function normalizeEvidenceBundle(
  bundle: EvidenceBundle,
  fallbackCollectorVersion = 'v2.collector.1'
): EvidenceBundle {
  const coverage = reconcileCoverageReport(bundle.coverage);
  const collectorVersion = bundle.evidenceCollectorVersion || fallbackCollectorVersion;
  const criteriaVersion = bundle.criteriaVersion || CRITERIA_VERSION;
  const repoUrl = bundle.repoUrl || bundle.sanitizedSubmission?.githubUrl || '';
  const defaultBranch = bundle.defaultBranch ?? coverage.defaultBranch ?? null;
  const commitSha = bundle.commitSha ?? coverage.commitSha ?? null;
  const evidenceKey =
    bundle.evidenceKey ||
    buildEvidenceRecordKey({
      projectId: bundle.projectId || bundle.submissionId,
      repoUrl,
      defaultBranch,
      commitSha,
      criteriaVersion,
      evidenceCollectorVersion: collectorVersion
    });

  return {
    ...bundle,
    evidenceKey,
    repoUrl,
    defaultBranch,
    commitSha,
    criteriaVersion,
    evidenceCollectorVersion: collectorVersion,
    coverage
  };
}

function getCollectorVersionRank(version?: string | null): number {
  if (!version) return 1;
  if (version === EVIDENCE_COLLECTOR_VERSION) return 2;
  const match = version.match(/v2\.collector\.(\d+)/i);
  if (match?.[1]) return Number(match[1]);
  return 1;
}

function getBundleCompletenessScore(bundle: EvidenceBundle | null | undefined): number {
  if (!bundle?.coverage) return -1;
  const c = bundle.coverage;
  if (!c.accessible) return 0;
  const full = c.inspectedFiles || 0;
  const partial = c.partiallyInspectedFiles || 0;
  const batches = c.completedBatches || 0;
  const isBatchIncomplete = (c.totalBatches || 0) > (c.completedBatches || 0);
  return full * 1000 + partial * 100 + batches * 10 - (isBatchIncomplete ? 500 : 0);
}

/**
 * Returns > 0 if candidate is strictly superior/preferred over existing,
 * < 0 if existing is strictly superior/preferred over candidate,
 * 0 if equal precedence (tie-break by newer timestamp).
 */
export function compareEvidencePrecedence(
  candidate: {
    evidenceCollectorVersion?: string;
    bundle?: EvidenceBundle | null;
    completedBatches?: number;
    totalBatches?: number;
    timestamp?: string;
  },
  existing: {
    evidenceCollectorVersion?: string;
    bundle?: EvidenceBundle | null;
    completedBatches?: number;
    totalBatches?: number;
    timestamp?: string;
  }
): number {
  const candHasBundle = Boolean(candidate.bundle);
  const exHasBundle = Boolean(existing.bundle);
  if (candHasBundle !== exHasBundle) {
    return candHasBundle ? 1 : -1;
  }

  if (candHasBundle && exHasBundle) {
    const candAcc = Boolean(candidate.bundle!.coverage?.accessible);
    const exAcc = Boolean(existing.bundle!.coverage?.accessible);
    if (candAcc !== exAcc) {
      return candAcc ? 1 : -1;
    }

    const candCov = candidate.bundle!.coverage;
    const exCov = existing.bundle!.coverage;
    const candIncomplete = (candCov.totalBatches || 0) > (candCov.completedBatches || 0);
    const exIncomplete = (exCov.totalBatches || 0) > (exCov.completedBatches || 0);
    if (candIncomplete !== exIncomplete) {
      return candIncomplete ? -1 : 1;
    }

    const candScore = getBundleCompletenessScore(candidate.bundle);
    const exScore = getBundleCompletenessScore(existing.bundle);
    const candVersion = getCollectorVersionRank(
      candidate.evidenceCollectorVersion || candidate.bundle?.evidenceCollectorVersion
    );
    const exVersion = getCollectorVersionRank(
      existing.evidenceCollectorVersion || existing.bundle?.evidenceCollectorVersion
    );
    if (candVersion !== exVersion && candScore >= exScore) {
      return candVersion - exVersion;
    }
    if (candScore !== exScore) {
      return candScore - exScore;
    }
    if (candVersion !== exVersion) {
      return candVersion - exVersion;
    }
  } else {
    const candVersion = getCollectorVersionRank(candidate.evidenceCollectorVersion);
    const exVersion = getCollectorVersionRank(existing.evidenceCollectorVersion);
    const candBatches = candidate.completedBatches || 0;
    const exBatches = existing.completedBatches || 0;
    if (candBatches !== exBatches) {
      return candBatches - exBatches;
    }
    if (candVersion !== exVersion) {
      return candVersion - exVersion;
    }
  }

  const candTime = Date.parse(candidate.timestamp || candidate.bundle?.collectedAt || '') || 0;
  const exTime = Date.parse(existing.timestamp || existing.bundle?.collectedAt || '') || 0;
  return candTime - exTime;
}

// ---------- AI Analysis Recommendation Cache ----------

export function getCachedAIAnalysis(cacheKey: string): AIJudgingRecommendation | null {
  const mem = memoryCache.get(cacheKey);
  if (mem) {
    return { ...mem, fromCache: true, geminiRequestsUsed: 0 };
  }
  const storage = safeGetStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(`${CACHE_PREFIX}${cacheKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AIJudgingRecommendation;
    if (!parsed || parsed.cacheKey !== cacheKey || !parsed.criteriaRecommendations) {
      return null;
    }
    memoryCache.set(cacheKey, parsed);
    return { ...parsed, fromCache: true, geminiRequestsUsed: 0 };
  } catch {
    return null;
  }
}

export function saveCachedAIAnalysis(recommendation: AIJudgingRecommendation): void {
  const toStore: AIJudgingRecommendation = {
    ...recommendation,
    advisoryOnly: true
  };
  if (memoryCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest) memoryCache.delete(oldest);
  }
  memoryCache.set(toStore.cacheKey, toStore);

  const storage = safeGetStorage();
  if (!storage) return;
  try {
    const existingCacheKeys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) existingCacheKeys.push(k);
    }
    if (existingCacheKeys.length >= MAX_CACHE_ENTRIES) {
      storage.removeItem(existingCacheKeys[0]);
    }
    storage.setItem(`${CACHE_PREFIX}${toStore.cacheKey}`, JSON.stringify(toStore));
  } catch {
    // Ignore browser quota storage errors cleanly
  }
}

export function clearCachedAIAnalysis(cacheKey: string): void {
  memoryCache.delete(cacheKey);
  const storage = safeGetStorage();
  try {
    storage?.removeItem(`${CACHE_PREFIX}${cacheKey}`);
  } catch {
    // Ignore
  }
}

export function clearAllCachedAIAnalyses(): void {
  memoryCache.clear();
  const storage = safeGetStorage();
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
  } catch {
    // Ignore
  }
}

// ---------- Versioned Evidence Store (Non-Destructive Conflict Preservation) ----------

function readSubmissionEvidenceIndex(submissionId: string): string[] {
  const mem = memoryEvidenceSubmissionIndex.get(submissionId);
  const storage = safeGetStorage();
  const storageSet = new Set<string>(mem || []);
  if (storage) {
    try {
      const raw = storage.getItem(`${EVIDENCE_INDEX_PREFIX}${submissionId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as string[];
        if (Array.isArray(parsed)) {
          parsed.forEach((k) => storageSet.add(k));
        }
      }
    } catch {
      // Ignore
    }
  }
  const merged = Array.from(storageSet);
  memoryEvidenceSubmissionIndex.set(submissionId, merged);
  return merged;
}

function writeSubmissionEvidenceIndex(submissionId: string, keys: string[]): void {
  const unique = Array.from(new Set(keys)).slice(-MAX_HISTORY_ENTRIES);
  memoryEvidenceSubmissionIndex.set(submissionId, unique);
  const storage = safeGetStorage();
  if (!storage) return;
  try {
    storage.setItem(`${EVIDENCE_INDEX_PREFIX}${submissionId}`, JSON.stringify(unique));
  } catch {
    // Ignore storage quota errors
  }
}

function readPersistedEvidenceRecordByStorageKey(storageKey: string): PersistedEvidenceRecord | null {
  const mem = memoryEvidenceRecords.get(storageKey);
  if (mem) {
    return { ...mem, bundle: normalizeEvidenceBundle(mem.bundle, mem.evidenceCollectorVersion) };
  }
  const storage = safeGetStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(`${EVIDENCE_RECORD_PREFIX}${storageKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedEvidenceRecord;
    if (!parsed || !parsed.bundle) return null;
    const normalized: PersistedEvidenceRecord = {
      ...parsed,
      bundle: normalizeEvidenceBundle(parsed.bundle, parsed.evidenceCollectorVersion)
    };
    memoryEvidenceRecords.set(storageKey, normalized);
    return normalized;
  } catch {
    return null;
  }
}

function writePersistedEvidenceRecordByStorageKey(
  storageKey: string,
  record: PersistedEvidenceRecord
): void {
  memoryEvidenceRecords.set(storageKey, record);
  const storage = safeGetStorage();
  if (!storage) return;
  try {
    storage.setItem(`${EVIDENCE_RECORD_PREFIX}${storageKey}`, JSON.stringify(record));
  } catch {
    // Retry without heavy file snapshots if localStorage quota is tight
    try {
      const lightweight: PersistedEvidenceRecord = {
        ...record,
        inspectedFilesSnapshot: undefined,
        skippedFilesSnapshot: undefined
      };
      storage.setItem(`${EVIDENCE_RECORD_PREFIX}${storageKey}`, JSON.stringify(lightweight));
    } catch {
      // Ignore storage quota errors
    }
  }
}

export function listEvidenceRecordsForSubmission(submissionId: string): PersistedEvidenceRecord[] {
  const indexKeys = readSubmissionEvidenceIndex(submissionId);
  const out: PersistedEvidenceRecord[] = [];
  for (const key of indexKeys) {
    const rec = readPersistedEvidenceRecordByStorageKey(key);
    if (rec && rec.submissionId === submissionId) {
      out.push(rec);
    }
  }
  return out;
}

export function getEvidenceRecordByKey(evidenceKey: string): PersistedEvidenceRecord | null {
  return readPersistedEvidenceRecordByStorageKey(evidenceKey);
}

/**
 * Persists a collected EvidenceBundle keyed by
 * (projectId, repoUrl, defaultBranch, commitSha, criteriaVersion, evidenceCollectorVersion).
 * Never lets an older or less-complete record overwrite a newer or more-complete record for the same target;
 * instead preserves conflicting versions explicitly and marks only the winning record ACTIVE.
 */
export function saveEvidenceRecord(params: {
  submissionId: string;
  bundle: EvidenceBundle;
  inspectedFilesSnapshot?: InspectedRepoFile[];
  skippedFilesSnapshot?: SkippedRepoFile[];
}): {
  activeRecord: PersistedEvidenceRecord;
  preservedConflict: boolean;
} {
  const normalizedBundle = normalizeEvidenceBundle(params.bundle, EVIDENCE_COLLECTOR_VERSION);
  const evidenceKey =
    normalizedBundle.evidenceKey ||
    buildEvidenceRecordKey({
      projectId: normalizedBundle.projectId || params.submissionId,
      repoUrl: normalizedBundle.repoUrl || normalizedBundle.sanitizedSubmission.githubUrl,
      defaultBranch: normalizedBundle.defaultBranch,
      commitSha: normalizedBundle.commitSha,
      criteriaVersion: normalizedBundle.criteriaVersion,
      evidenceCollectorVersion: normalizedBundle.evidenceCollectorVersion
    });

  const incomingRecord: PersistedEvidenceRecord = {
    evidenceKey,
    submissionId: params.submissionId,
    projectId: normalizedBundle.projectId || params.submissionId,
    repoUrl: normalizeRepoUrlForCache(
      normalizedBundle.repoUrl || normalizedBundle.sanitizedSubmission.githubUrl
    ),
    defaultBranch: normalizedBundle.defaultBranch ?? null,
    commitSha: normalizedBundle.commitSha ?? null,
    criteriaVersion: normalizedBundle.criteriaVersion || CRITERIA_VERSION,
    evidenceCollectorVersion: normalizedBundle.evidenceCollectorVersion || EVIDENCE_COLLECTOR_VERSION,
    collectedAt: normalizedBundle.collectedAt,
    bundle: normalizedBundle,
    inspectedFilesSnapshot: params.inspectedFilesSnapshot,
    skippedFilesSnapshot: params.skippedFilesSnapshot,
    status: 'ACTIVE'
  };

  const existingRecords = listEvidenceRecordsForSubmission(params.submissionId);
  const indexKeys = readSubmissionEvidenceIndex(params.submissionId);

  // Check if an existing record for the exact same repo & commit SHA is strictly superior
  const sameTargetRecords = existingRecords.filter(
    (r) =>
      normalizeRepoUrlForCache(r.repoUrl) === incomingRecord.repoUrl &&
      (r.commitSha || '') === (incomingRecord.commitSha || '')
  );

  let bestExisting: PersistedEvidenceRecord | null = null;
  for (const r of sameTargetRecords) {
    if (!bestExisting || compareEvidencePrecedence(r, bestExisting) > 0) {
      bestExisting = r;
    }
  }

  if (bestExisting && compareEvidencePrecedence(incomingRecord, bestExisting) < 0) {
    // Incoming record is stale / less complete -> preserve it under conflict key WITHOUT erasing active record
    const conflictKey = `${evidenceKey}::conflict::${Date.now().toString(36)}`;
    const preservedIncoming: PersistedEvidenceRecord = {
      ...incomingRecord,
      evidenceKey: conflictKey,
      status: 'SUPERSEDED',
      supersededByKey: bestExisting.evidenceKey,
      legacyOrStaleReason: `Superseded by higher-completeness or newer version (${bestExisting.evidenceCollectorVersion})`
    };
    writePersistedEvidenceRecordByStorageKey(conflictKey, preservedIncoming);
    if (!indexKeys.includes(conflictKey)) {
      indexKeys.push(conflictKey);
      writeSubmissionEvidenceIndex(params.submissionId, indexKeys);
    }
    return { activeRecord: bestExisting, preservedConflict: true };
  }

  // Demote all existing records for this submission cleanly to SUPERSEDED (without deleting any!)
  let anySuperseded = false;
  for (const oldRec of existingRecords) {
    if (oldRec.evidenceKey === evidenceKey) continue;
    const demoted: PersistedEvidenceRecord = {
      ...oldRec,
      status: 'SUPERSEDED',
      supersededByKey: evidenceKey
    };
    writePersistedEvidenceRecordByStorageKey(oldRec.evidenceKey, demoted);
    anySuperseded = true;
  }

  // If the same evidenceKey previously existed, preserve a conflict snapshot only if its counts differed significantly
  const sameKeyExisting = readPersistedEvidenceRecordByStorageKey(evidenceKey);
  if (
    sameKeyExisting &&
    (sameKeyExisting.bundle.coverage.inspectedFiles !== normalizedBundle.coverage.inspectedFiles ||
      sameKeyExisting.bundle.coverage.partiallyInspectedFiles !==
        normalizedBundle.coverage.partiallyInspectedFiles)
  ) {
    const archivedKey = `${evidenceKey}::prev::${Date.now().toString(36)}`;
    const archived: PersistedEvidenceRecord = {
      ...sameKeyExisting,
      evidenceKey: archivedKey,
      status: 'SUPERSEDED',
      supersededByKey: evidenceKey,
      legacyOrStaleReason: 'Replaced by updated evidence collection pass'
    };
    writePersistedEvidenceRecordByStorageKey(archivedKey, archived);
    if (!indexKeys.includes(archivedKey)) indexKeys.push(archivedKey);
    anySuperseded = true;
  }

  writePersistedEvidenceRecordByStorageKey(evidenceKey, incomingRecord);
  if (!indexKeys.includes(evidenceKey)) indexKeys.push(evidenceKey);
  writeSubmissionEvidenceIndex(params.submissionId, indexKeys);

  return { activeRecord: incomingRecord, preservedConflict: anySuperseded };
}

// ---------- Checkpoints (Conflict-Preserving & Stale-Overwrite-Safe) ----------

function readCheckpointHistory(submissionId: string): AnalysisCheckpoint[] {
  const mem = memoryCheckpointHistory.get(submissionId);
  if (mem) return mem;
  const storage = safeGetStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(`${CHECKPOINT_HISTORY_PREFIX}${submissionId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AnalysisCheckpoint[];
    const list = Array.isArray(parsed) ? parsed : [];
    memoryCheckpointHistory.set(submissionId, list);
    return list;
  } catch {
    return [];
  }
}

function appendCheckpointHistory(submissionId: string, ckpt: AnalysisCheckpoint): void {
  const current = readCheckpointHistory(submissionId);
  const deduped = current.filter(
    (c) => !(c.updatedAt === ckpt.updatedAt && c.evidenceKey === ckpt.evidenceKey && c.status === ckpt.status)
  );
  const next = [...deduped, ckpt].slice(-MAX_HISTORY_ENTRIES);
  memoryCheckpointHistory.set(submissionId, next);
  const storage = safeGetStorage();
  if (!storage) return;
  try {
    storage.setItem(`${CHECKPOINT_HISTORY_PREFIX}${submissionId}`, JSON.stringify(next));
  } catch {
    // Strip snapshots in history if storage quota is tight
    try {
      const compact = next.map((c) => ({
        ...c,
        inspectedFilesSnapshot: undefined,
        skippedFilesSnapshot: undefined
      }));
      storage.setItem(`${CHECKPOINT_HISTORY_PREFIX}${submissionId}`, JSON.stringify(compact));
    } catch {
      // Ignore
    }
  }
}

function normalizeCheckpoint(ckpt: AnalysisCheckpoint): AnalysisCheckpoint {
  const inferredCollectorVersion =
    ckpt.evidenceCollectorVersion ||
    ckpt.evidenceBundle?.evidenceCollectorVersion ||
    'v2.collector.1';
  const normalizedBundle = ckpt.evidenceBundle
    ? normalizeEvidenceBundle(ckpt.evidenceBundle, inferredCollectorVersion)
    : null;
  const evidenceKey =
    ckpt.evidenceKey ||
    normalizedBundle?.evidenceKey ||
    buildEvidenceRecordKey({
      projectId: ckpt.projectId || ckpt.submissionId,
      repoUrl: ckpt.repoUrl,
      defaultBranch: ckpt.defaultBranch ?? normalizedBundle?.defaultBranch ?? null,
      commitSha: ckpt.commitSha,
      criteriaVersion: ckpt.criteriaVersion || CRITERIA_VERSION,
      evidenceCollectorVersion: inferredCollectorVersion
    });

  return {
    ...ckpt,
    defaultBranch: ckpt.defaultBranch ?? normalizedBundle?.defaultBranch ?? null,
    evidenceCollectorVersion: inferredCollectorVersion,
    evidenceKey,
    evidenceBundle: normalizedBundle
  };
}

export function getJudgingV2Checkpoint(submissionId: string): AnalysisCheckpoint | null {
  const mem = memoryCheckpoints.get(submissionId);
  if (mem) return normalizeCheckpoint(mem);
  const storage = safeGetStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(`${CHECKPOINT_PREFIX}${submissionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AnalysisCheckpoint;
    if (!parsed || parsed.submissionId !== submissionId || parsed.criteriaVersion !== CRITERIA_VERSION) {
      return null;
    }
    const normalized = normalizeCheckpoint(parsed);
    memoryCheckpoints.set(submissionId, normalized);
    return normalized;
  } catch {
    return null;
  }
}

export function saveJudgingV2Checkpoint(
  checkpoint: AnalysisCheckpoint,
  options?: { allowReplaceCompleted?: boolean }
): { activeCheckpoint: AnalysisCheckpoint; preservedConflict: boolean } {
  const normalizedIncoming = normalizeCheckpoint({
    ...checkpoint,
    criteriaVersion: CRITERIA_VERSION,
    analysisVersion: ANALYSIS_VERSION,
    evidenceCollectorVersion:
      checkpoint.evidenceCollectorVersion ||
      checkpoint.evidenceBundle?.evidenceCollectorVersion ||
      EVIDENCE_COLLECTOR_VERSION,
    updatedAt: checkpoint.updatedAt || new Date().toISOString()
  });

  const existing = getJudgingV2Checkpoint(checkpoint.submissionId);
  if (existing && !options?.allowReplaceCompleted) {
    const sameRepoAndCommit =
      normalizeRepoUrlForCache(existing.repoUrl) ===
        normalizeRepoUrlForCache(normalizedIncoming.repoUrl) &&
      (existing.commitSha || '') === (normalizedIncoming.commitSha || '');

    // If same target repo+commit, guard against an older/stale/incomplete checkpoint overwriting a newer/complete one
    if (sameRepoAndCommit) {
      const cmp = compareEvidencePrecedence(
        {
          evidenceCollectorVersion: normalizedIncoming.evidenceCollectorVersion,
          bundle: normalizedIncoming.evidenceBundle,
          completedBatches: normalizedIncoming.completedBatches,
          totalBatches: normalizedIncoming.totalBatches,
          timestamp: normalizedIncoming.updatedAt
        },
        {
          evidenceCollectorVersion: existing.evidenceCollectorVersion,
          bundle: existing.evidenceBundle,
          completedBatches: existing.completedBatches,
          totalBatches: existing.totalBatches,
          timestamp: existing.updatedAt
        }
      );

      // Allow status transitions (e.g. PAUSED_QUOTA, COMPLETED, CANCELLED) ONLY when they don't downgrade evidence
      const isStatusUpdateOnEqualEvidence =
        cmp >= 0 ||
        (normalizedIncoming.status === 'PAUSED_QUOTA' &&
          Boolean(normalizedIncoming.evidenceBundle) &&
          getBundleCompletenessScore(normalizedIncoming.evidenceBundle) >=
            getBundleCompletenessScore(existing.evidenceBundle));

      if (!isStatusUpdateOnEqualEvidence) {
        // Keep existing superior checkpoint active; preserve incoming conflicting checkpoint in history
        appendCheckpointHistory(checkpoint.submissionId, normalizedIncoming);
        return { activeCheckpoint: existing, preservedConflict: true };
      }
    }

    // Preserve superseded previous checkpoint in history whenever replacing across versions/commits
    if (
      existing.evidenceKey !== normalizedIncoming.evidenceKey ||
      getBundleCompletenessScore(existing.evidenceBundle) !==
        getBundleCompletenessScore(normalizedIncoming.evidenceBundle)
    ) {
      appendCheckpointHistory(checkpoint.submissionId, existing);
    }
  }

  memoryCheckpoints.set(checkpoint.submissionId, normalizedIncoming);
  const storage = safeGetStorage();
  if (storage) {
    try {
      storage.setItem(`${CHECKPOINT_PREFIX}${checkpoint.submissionId}`, JSON.stringify(normalizedIncoming));
    } catch {
      try {
        const lightweight: AnalysisCheckpoint = {
          ...normalizedIncoming,
          inspectedFilesSnapshot: undefined,
          skippedFilesSnapshot: undefined
        };
        storage.setItem(`${CHECKPOINT_PREFIX}${checkpoint.submissionId}`, JSON.stringify(lightweight));
      } catch {
        // Ignore storage quota errors
      }
    }
  }

  if (normalizedIncoming.evidenceBundle) {
    saveEvidenceRecord({
      submissionId: normalizedIncoming.submissionId,
      bundle: normalizedIncoming.evidenceBundle,
      inspectedFilesSnapshot: normalizedIncoming.inspectedFilesSnapshot,
      skippedFilesSnapshot: normalizedIncoming.skippedFilesSnapshot
    });
  }

  return { activeCheckpoint: normalizedIncoming, preservedConflict: false };
}

/**
 * Resolves the authoritative ACTIVE evidence record & checkpoint for a submission,
 * migrating legacy localStorage checkpoints non-destructively (preserving conflicting/older versions).
 */
export function resolveEvidenceForSubmission(params: {
  submissionId: string;
  projectId?: string;
  repoUrl?: string;
  preferredCommitSha?: string | null;
}): EvidenceVersionResolution {
  const { submissionId, repoUrl } = params;
  const normalizedTargetRepo = repoUrl ? normalizeRepoUrlForCache(repoUrl) : '';

  const currentCkpt = getJudgingV2Checkpoint(submissionId);
  const ckptHistory = readCheckpointHistory(submissionId);
  const persistedRecords = listEvidenceRecordsForSubmission(submissionId);

  const candidates = new Map<string, PersistedEvidenceRecord>();
  for (const r of persistedRecords) {
    candidates.set(r.evidenceKey, r);
  }

  // Include checkpoint bundle if not already represented in evidence records (non-destructive migration)
  const allCkpts: AnalysisCheckpoint[] = [
    ...(currentCkpt ? [currentCkpt] : []),
    ...ckptHistory
  ];
  for (const ck of allCkpts) {
    if (!ck.evidenceBundle) continue;
    const normBundle = normalizeEvidenceBundle(ck.evidenceBundle, ck.evidenceCollectorVersion);
    const key = normBundle.evidenceKey!;
    const fromCkpt: PersistedEvidenceRecord = {
      evidenceKey: key,
      submissionId,
      projectId: normBundle.projectId || submissionId,
      repoUrl: normalizeRepoUrlForCache(normBundle.repoUrl || ck.repoUrl),
      defaultBranch: normBundle.defaultBranch ?? ck.defaultBranch ?? null,
      commitSha: normBundle.commitSha ?? ck.commitSha ?? null,
      criteriaVersion: normBundle.criteriaVersion || CRITERIA_VERSION,
      evidenceCollectorVersion: normBundle.evidenceCollectorVersion || 'v2.collector.1',
      collectedAt: normBundle.collectedAt || ck.updatedAt,
      bundle: normBundle,
      inspectedFilesSnapshot: ck.inspectedFilesSnapshot,
      skippedFilesSnapshot: ck.skippedFilesSnapshot,
      status: 'SUPERSEDED',
      legacyOrStaleReason:
        normBundle.evidenceCollectorVersion !== EVIDENCE_COLLECTOR_VERSION
          ? `Legacy checkpoint version (${normBundle.evidenceCollectorVersion})`
          : undefined
    };

    const existing = candidates.get(key);
    if (!existing || compareEvidencePrecedence(fromCkpt, existing) > 0) {
      candidates.set(key, fromCkpt);
    }
  }

  const allRecords = Array.from(candidates.values());
  const matchingRepoRecords = normalizedTargetRepo
    ? allRecords.filter((r) => normalizeRepoUrlForCache(r.repoUrl) === normalizedTargetRepo)
    : allRecords;
  const pool = matchingRepoRecords.length > 0 ? matchingRepoRecords : allRecords;

  let activeRecord: PersistedEvidenceRecord | null = null;
  for (const r of pool) {
    if (
      params.preferredCommitSha &&
      r.commitSha &&
      r.commitSha !== params.preferredCommitSha
    ) {
      continue;
    }
    if (!activeRecord || compareEvidencePrecedence(r, activeRecord) > 0) {
      activeRecord = r;
    }
  }
  if (!activeRecord && pool.length > 0) {
    for (const r of pool) {
      if (!activeRecord || compareEvidencePrecedence(r, activeRecord) > 0) {
        activeRecord = r;
      }
    }
  }

  if (activeRecord) {
    activeRecord = { ...activeRecord, status: 'ACTIVE', supersededByKey: undefined };
  }

  const preservedVersions = allRecords
    .filter((r) => !activeRecord || r.evidenceKey !== activeRecord.evidenceKey)
    .map((r) => ({
      ...r,
      status: 'SUPERSEDED' as const,
      supersededByKey: activeRecord?.evidenceKey
    }));

  // Ensure activeCheckpoint matches activeRecord when activeRecord is strictly newer/more complete
  let activeCheckpoint = currentCkpt;
  if (activeRecord) {
    const ckptScore = currentCkpt
      ? compareEvidencePrecedence(
          {
            evidenceCollectorVersion: activeRecord.evidenceCollectorVersion,
            bundle: activeRecord.bundle,
            timestamp: activeRecord.collectedAt
          },
          {
            evidenceCollectorVersion: currentCkpt.evidenceCollectorVersion,
            bundle: currentCkpt.evidenceBundle,
            completedBatches: currentCkpt.completedBatches,
            totalBatches: currentCkpt.totalBatches,
            timestamp: currentCkpt.updatedAt
          }
        )
      : 1;
    if (!activeCheckpoint || ckptScore > 0) {
      activeCheckpoint = {
        jobId: currentCkpt?.jobId || `job_${submissionId}`,
        submissionId,
        projectId: activeRecord.projectId,
        repoUrl: activeRecord.bundle.repoUrl || activeRecord.repoUrl,
        defaultBranch: activeRecord.defaultBranch,
        commitSha: activeRecord.commitSha,
        criteriaVersion: activeRecord.criteriaVersion,
        analysisVersion: ANALYSIS_VERSION,
        evidenceCollectorVersion: activeRecord.evidenceCollectorVersion,
        evidenceKey: activeRecord.evidenceKey,
        status: currentCkpt?.status === 'COMPLETED' && currentCkpt.evidenceKey === activeRecord.evidenceKey
          ? 'COMPLETED'
          : 'EVIDENCE_READY',
        completedBatches: activeRecord.bundle.coverage.completedBatches,
        totalBatches: activeRecord.bundle.coverage.totalBatches,
        inspectedPaths: activeRecord.bundle.inspectedFilesList.map((f) => f.path),
        inspectedFilesSnapshot: activeRecord.inspectedFilesSnapshot,
        skippedFilesSnapshot: activeRecord.skippedFilesSnapshot,
        evidenceBundle: activeRecord.bundle,
        aiRecommendation: currentCkpt?.aiRecommendation ?? null,
        lastError: null,
        quotaStopped: false,
        updatedAt: activeRecord.collectedAt
      };
    }
  }

  const needsUpgrade = Boolean(
    activeRecord &&
      activeRecord.bundle.coverage.accessible &&
      (activeRecord.evidenceCollectorVersion !== EVIDENCE_COLLECTOR_VERSION ||
        activeRecord.bundle.coverage.partiallyInspectedFiles > 0)
  );

  return {
    activeRecord,
    activeCheckpoint,
    preservedVersions,
    preservedCheckpoints: ckptHistory,
    hasConflict: preservedVersions.length > 0 || ckptHistory.length > 0,
    needsUpgrade
  };
}

export function clearJudgingV2Checkpoint(submissionId: string): void {
  memoryCheckpoints.delete(submissionId);
  memoryCheckpointHistory.delete(submissionId);
  const existingKeys = readSubmissionEvidenceIndex(submissionId);
  for (const k of existingKeys) {
    memoryEvidenceRecords.delete(k);
  }
  memoryEvidenceSubmissionIndex.delete(submissionId);
  const storage = safeGetStorage();
  try {
    storage?.removeItem(`${CHECKPOINT_PREFIX}${submissionId}`);
    storage?.removeItem(`${CHECKPOINT_HISTORY_PREFIX}${submissionId}`);
    storage?.removeItem(`${EVIDENCE_INDEX_PREFIX}${submissionId}`);
    for (const k of existingKeys) {
      storage?.removeItem(`${EVIDENCE_RECORD_PREFIX}${k}`);
    }
  } catch {
    // Ignore
  }
}

export function clearAllJudgingV2EvidenceForTests(): void {
  memoryCache.clear();
  memoryCheckpoints.clear();
  memoryCheckpointHistory.clear();
  memoryEvidenceRecords.clear();
  memoryEvidenceSubmissionIndex.clear();
  const storage = safeGetStorage();
  if (!storage) return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (
        k &&
        (k.startsWith(CACHE_PREFIX) ||
          k.startsWith(CHECKPOINT_PREFIX) ||
          k.startsWith(CHECKPOINT_HISTORY_PREFIX) ||
          k.startsWith(EVIDENCE_RECORD_PREFIX) ||
          k.startsWith(EVIDENCE_INDEX_PREFIX))
      ) {
        keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) storage.removeItem(k);
  } catch {
    // Ignore
  }
}
