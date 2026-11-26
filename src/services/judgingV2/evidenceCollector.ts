import type { ProjectSubmission } from '../../types/domain';
import {
  discoverGitHubRepoPlan,
  finalizeGitHubRepoInspection,
  inspectGitHubRepoBatchSlice,
  normalizeRepoPath,
  type GitHubRepoInspection,
  type InspectedRepoFile,
  type PrioritizedRepoEntry,
  type RepoInspectionPlan,
  type SkippedRepoFile
} from '../github/repoInspector';
import {
  fetchPublicGitHubActionsRuns,
  parseExecutedTestEvidence,
  verifyPublicDemoSafely
} from '../judging/evidenceVerifier';
import type {
  ExecutedTestRecord,
  LiveDemoCheckResult
} from '../judging/evidenceTypes';
import { buildEvidenceRecordKey } from './cacheAndCheckpoints';
import { CRITERIA_VERSION, EVIDENCE_COLLECTOR_VERSION } from './criteria';
import { sanitizeSubmissionWithoutVideo } from './evidenceSanitizer';
import type {
  EvidenceBundle,
  EvidenceFinding,
  ExecutedTestVerification,
  ObservableWorkflowCheck,
  PublicAppProbeEvidence,
  RepoCoverageReport,
  SkippedFileBreakdown,
  SkippedFileDetail
} from './types';

export interface EvidenceCollectionDeps {
  discoverPlanFn?: (
    githubUrl: string,
    opts?: { signal?: AbortSignal; useCache?: boolean }
  ) => Promise<RepoInspectionPlan>;
  inspectBatchFn?: (
    plan: RepoInspectionPlan,
    batchEntries: PrioritizedRepoEntry[],
    opts?: {
      signal?: AbortSignal;
      totalCharsUsedSoFar?: number;
      maxTotalChars?: number;
      maxPerFileChars?: number;
    }
  ) => Promise<{
    inspectedFiles: InspectedRepoFile[];
    skippedOrFailed: SkippedRepoFile[];
    totalCharsAdded: number;
    redactedSecretsCount: number;
    aborted: boolean;
  }>;
  fetchActionsRunsFn?: typeof fetchPublicGitHubActionsRuns;
  probeDemoFn?: (url: string, opts?: { signal?: AbortSignal }) => Promise<LiveDemoCheckResult>;
}

const DEFAULT_WORKFLOW_TEMPLATES: Array<{ id: string; label: string }> = [
  { id: 'wf_home_load', label: 'Primary application loads without fatal runtime crash' },
  { id: 'wf_core_flow', label: 'Core user workflow executes end-to-end as submitted' },
  { id: 'wf_navigation_ux', label: 'Navigation, states (loading/empty/error), and responsiveness behave cleanly' }
];

function isDocumentationOnlyPath(filePath: string): boolean {
  const lower = normalizeRepoPath(filePath).toLowerCase();
  const base = lower.split('/').pop() || '';
  return (
    /^readme(\.[a-z0-9]+)?$/i.test(base) ||
    base.endsWith('.md') ||
    base.endsWith('.mdx') ||
    base.endsWith('.txt') ||
    lower.startsWith('docs/')
  );
}

function emptySkippedBreakdown(): SkippedFileBreakdown {
  return {
    duplicateMirror: 0,
    unselectedMirrorConfig: 0,
    unselectedRootMetaOrConfig: 0,
    nonCodeOrUnselected: 0,
    binaryOrAsset: 0,
    fileCountLimit: 0,
    oversized: 0,
    sensitive: 0,
    budgetLimit: 0,
    batchInterrupted: 0
  };
}

function isMirrorUploadPath(filePath: string): boolean {
  return /(^|\/)(github[_-]?upload|uploads?|mirror|mirrored|backup|old|deprecated|archive)(\/|$)/i.test(
    normalizeRepoPath(filePath)
  );
}

/**
 * Computes truthful repository coverage strictly excluding README/docs and binary/archive/lock assets
 * from unique source file counts, while preserving separate, mutually exclusive itemized lists.
 */
export function computeAccurateRepoCoverage(params: {
  plan: RepoInspectionPlan | null;
  inspection: GitHubRepoInspection | null;
  completedBatches: number;
  totalBatches: number;
}): RepoCoverageReport {
  const { plan, inspection, completedBatches, totalBatches } = params;

  if (!inspection || !inspection.accessible || !plan || !plan.accessible) {
    return {
      accessible: false,
      repoFullName: inspection?.repoFullName || plan?.repoFullName || null,
      defaultBranch: inspection?.defaultBranch || plan?.defaultBranch || null,
      commitSha: inspection?.commitSha || plan?.commitSha || null,
      commitShaVerified: Boolean(inspection?.commitShaVerified),
      primaryRootPath: null,
      hasDivergentRoots: false,
      totalTreeEntries: 0,
      uniqueSourceFiles: 0,
      inspectedFiles: 0,
      partiallyInspectedFiles: 0,
      skippedFiles: 0,
      inaccessibleFiles: 0,
      failedFiles: 0,
      readmeAndDocsCount: 0,
      excludedBinaryAndLockCount: 0,
      skippedBreakdown: emptySkippedBreakdown(),
      skippedFilesList: [],
      excludedDocsList: [],
      excludedBinaryAndLockList: [],
      completedBatches,
      totalBatches,
      treeTruncated: false,
      redactedSecretsCount: 0,
      note: inspection?.reason || plan?.reason || 'GitHub repository unavailable or not accessible.'
    };
  }

  const seenPaths = new Set<string>();
  const skippedBreakdown = emptySkippedBreakdown();
  const skippedFilesList: SkippedFileDetail[] = [];
  const excludedDocsList: SkippedFileDetail[] = [];
  const excludedBinaryAndLockList: SkippedFileDetail[] = [];

  let totalTreeEntries = 0;
  let uniqueSourceFiles = 0;
  let inspectedFiles = 0;
  let partiallyInspectedFiles = 0;
  let skippedFiles = 0;
  let inaccessibleFiles = 0;
  let failedFiles = 0;
  let readmeAndDocsCount = 0;
  let excludedBinaryAndLockCount = 0;

  for (const item of inspection.fileInventory) {
    const clean = normalizeRepoPath(item.path);
    if (!clean || seenPaths.has(clean)) continue;
    seenPaths.add(clean);
    totalTreeEntries += 1;

    if (item.category === 'readme' || isDocumentationOnlyPath(clean)) {
      readmeAndDocsCount += 1;
      excludedDocsList.push({
        path: clean,
        reason: item.category === 'readme' ? 'readme_excluded' : 'documentation_excluded',
        category: item.category || 'readme',
        sizeBytes: item.sizeBytes
      });
      continue;
    }

    if (item.reason === 'binary_or_asset') {
      excludedBinaryAndLockCount += 1;
      skippedBreakdown.binaryOrAsset += 1;
      excludedBinaryAndLockList.push({
        path: clean,
        reason: 'binary_or_asset',
        category: item.category || 'excluded',
        sizeBytes: item.sizeBytes
      });
      continue;
    }

    uniqueSourceFiles += 1;
    if (item.inspectionStatus === 'inspected') {
      inspectedFiles += 1;
    } else if (item.inspectionStatus === 'partially_inspected') {
      partiallyInspectedFiles += 1;
    } else if (item.inspectionStatus === 'inaccessible') {
      inaccessibleFiles += 1;
    } else if (item.inspectionStatus === 'failed') {
      failedFiles += 1;
    } else {
      skippedFiles += 1;
      let detailReason = String(item.reason || 'non_code_documentation');
      if (item.reason === 'duplicate_mirror') {
        skippedBreakdown.duplicateMirror += 1;
      } else if (item.reason === 'file_count_limit') {
        skippedBreakdown.fileCountLimit += 1;
      } else if (item.reason === 'file_too_large') {
        skippedBreakdown.oversized += 1;
      } else if (item.reason === 'sensitive_env_or_secret_file') {
        skippedBreakdown.sensitive += 1;
      } else if (item.reason === 'budget_limit') {
        skippedBreakdown.budgetLimit += 1;
      } else if (item.reason === 'batch_interrupted') {
        skippedBreakdown.batchInterrupted += 1;
      } else {
        skippedBreakdown.nonCodeOrUnselected += 1;
        if (!isDocumentationOnlyPath(clean)) {
          if (isMirrorUploadPath(clean)) {
            detailReason = 'unselected_mirror_config_or_asset';
            skippedBreakdown.unselectedMirrorConfig =
              (skippedBreakdown.unselectedMirrorConfig || 0) + 1;
          } else {
            detailReason = 'unselected_config_or_asset';
            skippedBreakdown.unselectedRootMetaOrConfig =
              (skippedBreakdown.unselectedRootMetaOrConfig || 0) + 1;
          }
        } else {
          skippedBreakdown.unselectedRootMetaOrConfig =
            (skippedBreakdown.unselectedRootMetaOrConfig || 0) + 1;
        }
      }

      skippedFilesList.push({
        path: clean,
        reason: detailReason,
        category: item.category || 'other',
        sizeBytes: item.sizeBytes
      });
    }
  }

  const primaryRoot = inspection.projectRoots.find((r) => r.selectedAsPrimary)?.rootPath || '.';

  return {
    accessible: true,
    repoFullName: inspection.repoFullName,
    defaultBranch: inspection.defaultBranch,
    commitSha: inspection.commitSha,
    commitShaVerified: Boolean(inspection.commitShaVerified),
    primaryRootPath: primaryRoot,
    hasDivergentRoots: inspection.hasDivergentRoots,
    totalTreeEntries,
    uniqueSourceFiles,
    inspectedFiles,
    partiallyInspectedFiles,
    skippedFiles,
    inaccessibleFiles,
    failedFiles,
    readmeAndDocsCount,
    excludedBinaryAndLockCount,
    skippedBreakdown,
    skippedFilesList,
    excludedDocsList,
    excludedBinaryAndLockList,
    completedBatches,
    totalBatches,
    treeTruncated: inspection.treeTruncated,
    redactedSecretsCount: inspection.redactedSecretsCount,
    note: `Inspected ${inspectedFiles} full + ${partiallyInspectedFiles} partial source file(s) out of ${uniqueSourceFiles} unique source file(s) across ${completedBatches}/${totalBatches} batch(es). Excluded: ${readmeAndDocsCount} README/doc(s) and ${excludedBinaryAndLockCount} binary/archive/lockfile(s).`
  };
}

function findMatchingLines(
  text: string,
  regex: RegExp,
  maxMatches = 4
): Array<{ lineNumber: number; lineText: string }> {
  const lines = text.split('\n');
  const results: Array<{ lineNumber: number; lineText: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    regex.lastIndex = 0;
    if (regex.test(lines[i])) {
      results.push({ lineNumber: i + 1, lineText: lines[i].trim().slice(0, 140) });
      if (results.length >= maxMatches) break;
    }
  }
  return results;
}

function isServerSourcePath(cleanPath: string, category: string): boolean {
  return (
    category === 'server_api' ||
    /(^|\/)(api|server|backend|routes|controllers|functions|supabase\/functions|app\/api|pages\/api)\//i.test(
      cleanPath
    ) ||
    /\/route\.(ts|js|mjs)$/i.test(cleanPath)
  );
}

export function extractStaticCodeEvidence(inspectedFiles: InspectedRepoFile[]): {
  findings: EvidenceFinding[];
  dependencies: string[];
  apiEndpointsDetected: Array<{ filePath: string; lineRange: string; signature: string }>;
  clientApiHelpersDetected: Array<{ filePath: string; lineRange: string; signature: string }>;
  discoveredTestFiles: string[];
} {
  const findings: EvidenceFinding[] = [];
  const dependenciesSet = new Set<string>();
  const declaredDepsByManifest: string[] = [];
  const apiEndpointsDetected: Array<{ filePath: string; lineRange: string; signature: string }> = [];
  const clientApiHelpersDetected: Array<{ filePath: string; lineRange: string; signature: string }> =
    [];
  const discoveredTestFiles: string[] = [];

  const allInspectedSourceContents: Array<{ cleanPath: string; content: string; truncated: boolean }> =
    [];

  for (const file of inspectedFiles) {
    const cleanPath = normalizeRepoPath(file.path);
    const content = file.chunks.length > 0
      ? file.chunks.map((c) => c.content).join('\n')
      : file.excerpt;
    const baseName = (cleanPath.split('/').pop() || '').toLowerCase();

    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(cleanPath)) {
      allInspectedSourceContents.push({ cleanPath, content, truncated: file.truncated });
    }

    // 1. Package dependencies (actual manifests only)
    if (baseName === 'package.json') {
      try {
        const pkg = JSON.parse(content) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          scripts?: Record<string, string>;
        };
        const deps = Object.keys(pkg.dependencies || {});
        deps.slice(0, 25).forEach((d) => {
          dependenciesSet.add(d);
          if (!declaredDepsByManifest.includes(d)) {
            declaredDepsByManifest.push(d);
          }
        });
        if (deps.length > 0) {
          findings.push({
            id: `dep_${cleanPath}`,
            category: 'dependencies',
            criterionId: 'technical_implementation',
            title: `Declared runtime dependencies in ${cleanPath}`,
            status: file.truncated ? 'PARTIALLY_VERIFIED' : 'VERIFIED',
            sourceType: 'dependency_manifest',
            sourceLabel: cleanPath,
            filePath: cleanPath,
            lineRange: `L1-L${Math.min(file.totalLines, 60)}`,
            detail: `Detected ${deps.length} runtime package(s): ${deps.slice(0, 10).join(', ')}${deps.length > 10 ? '...' : ''}.`
          });
        }
      } catch {
        // Non-JSON or truncated manifest
      }
    } else if (baseName === 'requirements.txt' || baseName === 'pyproject.toml') {
      const depMatches = content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('['));
      depMatches.slice(0, 15).forEach((d) => dependenciesSet.add(d.split(/[=<>~]/)[0].trim()));
      if (depMatches.length > 0) {
        findings.push({
          id: `pydep_${cleanPath}`,
          category: 'dependencies',
          criterionId: 'technical_implementation',
          title: `Python dependencies manifest inspected at ${cleanPath}`,
          status: file.truncated ? 'PARTIALLY_VERIFIED' : 'VERIFIED',
          sourceType: 'dependency_manifest',
          sourceLabel: cleanPath,
          filePath: cleanPath,
          lineRange: `L1-L${Math.min(file.totalLines, 40)}`,
          detail: `Inspected ${depMatches.length} manifest line(s).`
        });
      }
    }

    // 2. Genuine server API routes / Deno Edge Functions (case-sensitive HTTP verbs!)
    const isServerCandidate = isServerSourcePath(cleanPath, file.category);
    const serverEndpointRegex = isServerCandidate
      ? /(?:\b(?:app|router|fastify)\.(?:get|post|put|patch|delete)\s*\(|\bexport\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|@(?:app\.route|router\.(?:get|post|put|patch|delete)|GetMapping|PostMapping|PutMapping|DeleteMapping)\b|\bDeno\.serve\s*\(|\bserve\s*\(\s*async\b)/
      : /(?:\b(?:app|router|fastify)\.(?:get|post|put|patch|delete)\s*\(|\bexport\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|@(?:app\.route|router\.(?:get|post|put|patch|delete)|GetMapping|PostMapping|PutMapping|DeleteMapping)\b|\bDeno\.serve\s*\()/;

    const apiMatches = findMatchingLines(content, serverEndpointRegex, 6);
    for (const m of apiMatches) {
      const lineRange = `L${m.lineNumber}-L${m.lineNumber}`;
      apiEndpointsDetected.push({
        filePath: cleanPath,
        lineRange,
        signature: m.lineText
      });
    }
    if (apiMatches.length > 0) {
      const first = apiMatches[0].lineNumber;
      const last = apiMatches[apiMatches.length - 1].lineNumber;
      findings.push({
        id: `api_${cleanPath}`,
        category: 'api_integration',
        criterionId: 'technical_implementation',
        title: `Implemented server API endpoint / Edge Function in ${cleanPath}`,
        status: file.truncated ? 'PARTIALLY_VERIFIED' : 'VERIFIED',
        sourceType: 'source_file',
        sourceLabel: `${cleanPath}:L${first}-L${last}`,
        filePath: cleanPath,
        lineRange: `L${first}-L${last}`,
        snippet: apiMatches[0].lineText,
        detail: `Verified ${apiMatches.length} server route/handler definition(s) in inspected source.`
      });
    } else if (
      !isServerCandidate &&
      /\.(ts|tsx|js|jsx)$/i.test(cleanPath) &&
      /(?:\bfetch\s*\(|\/functions\/v1\/|import\.meta\.env\.VITE_|process\.env\.NEXT_PUBLIC_)/.test(
        content
      )
    ) {
      // Client-side browser API helper (NEVER misclassified as a server API endpoint)
      const helperMatches = findMatchingLines(
        content,
        /(?:export\s+(?:async\s+)?function\s+[a-zA-Z0-9_]+|async\s+function\s+call[a-zA-Z0-9_]*|\bfetch\s*\()/ ,
        6
      );
      for (const m of helperMatches) {
        clientApiHelpersDetected.push({
          filePath: cleanPath,
          lineRange: `L${m.lineNumber}-L${m.lineNumber}`,
          signature: m.lineText
        });
      }
      if (helperMatches.length > 0) {
        const first = helperMatches[0].lineNumber;
        const last = helperMatches[helperMatches.length - 1].lineNumber;
        findings.push({
          id: `client_api_${cleanPath}`,
          category: 'api_integration',
          criterionId: 'technical_implementation',
          title: `Client-side API helper (not a server endpoint) in ${cleanPath}`,
          status: file.truncated ? 'PARTIALLY_VERIFIED' : 'VERIFIED',
          sourceType: 'source_file',
          sourceLabel: `${cleanPath}:L${first}-L${last}`,
          filePath: cleanPath,
          lineRange: `L${first}-L${last}`,
          snippet: helperMatches[0].lineText,
          detail:
            'Browser-side fetch/Edge-Function client helper; makes HTTP requests to external or serverless endpoints rather than hosting a server route.'
        });
      }
    }

    // 3. Real test files (code presence ONLY — never runtime pass proof!)
    if (file.category === 'tests' || /\.(test|spec)\.[a-z]+$/i.test(cleanPath)) {
      discoveredTestFiles.push(cleanPath);
      findings.push({
        id: `testfile_${cleanPath}`,
        category: 'tests',
        criterionId: 'technical_implementation',
        title: `Test source file present: ${cleanPath}`,
        status: 'PARTIALLY_VERIFIED',
        sourceType: 'source_file',
        sourceLabel: `${cleanPath}:L1-L${file.totalLines}`,
        filePath: cleanPath,
        lineRange: `L1-L${file.totalLines}`,
        detail:
          'Test file exists in source tree, but presence of test code alone does not verify tests passed until executed.'
      });
    }

    // 4. UI / workflow navigation (supports React Router OR state-driven page switches)
    const hasRouterNav = /(?:<Routes|<Route|createBrowserRouter|app\/.*page\.tsx)/i.test(content);
    const hasStatePageNav =
      file.category === 'frontend_source' &&
      /(?:useState<[^>]*Page|renderPage\s*\(|switch\s*\(\s*currentPage\s*\)|currentPage\s*===\s*['"])/.test(
        content
      );

    if (file.category === 'frontend_source' && (hasRouterNav || hasStatePageNav)) {
      const uiMatch = findMatchingLines(
        content,
        /(?:<Route|createBrowserRouter|switch\s*\(\s*currentPage|currentPage\s*===\s*['"]|export default function)/i,
        2
      );
      const ln = uiMatch[0]?.lineNumber ?? 1;
      findings.push({
        id: `ux_route_${cleanPath}`,
        category: 'ux_workflow',
        criterionId: 'ux_completeness',
        title: `Frontend navigation / page workflow defined in ${cleanPath}`,
        status: 'PARTIALLY_VERIFIED',
        sourceType: 'source_file',
        sourceLabel: `${cleanPath}:L${ln}-L${Math.min(file.totalLines, ln + 20)}`,
        filePath: cleanPath,
        lineRange: `L${ln}-L${Math.min(file.totalLines, ln + 20)}`,
        detail: hasRouterNav
          ? 'Router structure verified in source code; interactive workflow execution requires manual judge verification.'
          : 'Client state-driven multi-page workflow structure verified in source code; interactive runtime behavior requires manual judge verification.'
      });
    }
  }

  // 5. Cross-check declared runtime npm packages vs actual imports when full frontend/backend files are inspected
  if (declaredDepsByManifest.length > 0 && allInspectedSourceContents.length >= 5) {
    const anySourceTruncated = allInspectedSourceContents.some((s) => s.truncated);
    if (!anySourceTruncated) {
      const unusedDeclared = declaredDepsByManifest.filter((pkgName) => {
        if (pkgName === 'react-dom') return false;
        const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const importRe = new RegExp(`['"]${escaped}(?:/[^'"]*)?['"]`);
        return !allInspectedSourceContents.some((src) => importRe.test(src.content));
      });
      if (unusedDeclared.length > 0) {
        findings.push({
          id: 'dep_unused_declared',
          category: 'dependencies',
          criterionId: 'technical_implementation',
          title: `Declared package(s) without source imports: ${unusedDeclared.join(', ')}`,
          status: 'VERIFIED',
          sourceType: 'dependency_manifest',
          sourceLabel: 'package.json vs inspected src/',
          detail: `${unusedDeclared.join(', ')} declared in package.json dependencies, but zero ES imports were found across all ${allInspectedSourceContents.length} fully inspected JS/TS source files.`
        });
      }
    }
  }

  return {
    findings,
    dependencies: Array.from(dependenciesSet),
    apiEndpointsDetected,
    clientApiHelpersDetected,
    discoveredTestFiles
  };
}

function buildPublicAppProbeEvidence(
  demoUrl: string,
  probe: LiveDemoCheckResult | null
): PublicAppProbeEvidence {
  const cleanUrl = (demoUrl || '').trim();
  if (!cleanUrl) {
    return {
      url: '',
      checkedAt: new Date().toISOString(),
      reachable: false,
      httpStatus: null,
      finalUrl: null,
      title: null,
      requiresAuth: false,
      hasCrashBanner: false,
      reachabilityStatus: 'UNVERIFIED',
      functionalityStatus: 'UNVERIFIED',
      summary: 'No public application URL was submitted. Not classified as FAILED.'
    };
  }

  if (!probe) {
    return {
      url: cleanUrl,
      checkedAt: new Date().toISOString(),
      reachable: false,
      httpStatus: null,
      finalUrl: null,
      title: null,
      requiresAuth: false,
      hasCrashBanner: false,
      reachabilityStatus: 'UNVERIFIED',
      functionalityStatus: 'UNVERIFIED',
      summary: 'Public URL has not been probed yet.'
    };
  }

  const hasCrashOrErrorIndicator =
    probe.status === 'CONTRADICTED' ||
    probe.blockedAspects.some((a) => /crash|error banner|application error/i.test(a));

  // Strictly distinguish HTTP 200 reachability from working user workflows
  if (
    hasCrashOrErrorIndicator ||
    (probe.httpStatus !== null && probe.httpStatus >= 400 && !probe.requiresAuth)
  ) {
    return {
      url: cleanUrl,
      checkedAt: probe.checkedAt,
      reachable: probe.reachable,
      httpStatus: probe.httpStatus,
      finalUrl: probe.finalUrl ?? null,
      title: null,
      requiresAuth: probe.requiresAuth,
      hasCrashBanner: hasCrashOrErrorIndicator,
      reachabilityStatus: 'FAILED',
      functionalityStatus: 'FAILED',
      summary: probe.summary
    };
  }

  if (probe.reachable && !probe.requiresAuth) {
    return {
      url: cleanUrl,
      checkedAt: probe.checkedAt,
      reachable: true,
      httpStatus: probe.httpStatus,
      finalUrl: probe.finalUrl ?? null,
      title: null,
      requiresAuth: false,
      hasCrashBanner: false,
      reachabilityStatus: 'PARTIALLY_VERIFIED',
      functionalityStatus: 'UNVERIFIED',
      summary: `HTTP ${probe.httpStatus ?? 200} responded cleanly, which verifies network reachability only — interactive workflows remain UNVERIFIED until observed by a judge.`
    };
  }

  return {
    url: cleanUrl,
    checkedAt: probe.checkedAt,
    reachable: probe.reachable,
    httpStatus: probe.httpStatus,
    finalUrl: probe.finalUrl ?? null,
    title: null,
    requiresAuth: probe.requiresAuth,
    hasCrashBanner: hasCrashOrErrorIndicator,
    reachabilityStatus: 'UNVERIFIED',
    functionalityStatus: 'UNVERIFIED',
    summary: probe.summary
  };
}

function buildTestVerificationSummary(params: {
  attachedTestLog: string;
  commitSha: string | null;
  actionsRuns: ExecutedTestRecord[];
  discoveredTestFilesCount: number;
}): ExecutedTestVerification {
  const { attachedTestLog, commitSha, actionsRuns, discoveredTestFilesCount } = params;

  const parsedLogs = parseExecutedTestEvidence(attachedTestLog, {
    expectedCommitSha: commitSha
  });
  if (parsedLogs.length > 0) {
    const passedCount = parsedLogs.reduce((acc, r) => acc + (r.passedCount ?? 0), 0);
    const failedCount = parsedLogs.reduce((acc, r) => acc + (r.failedCount ?? 0), 0);
    const skippedCount = parsedLogs.reduce((acc, r) => acc + (r.skippedCount ?? 0), 0);
    const anyFailed =
      failedCount > 0 || parsedLogs.some((r) => r.status === 'CONTRADICTED' || r.exitCode === 1);
    const anyConfirmed = parsedLogs.some((r) => r.status === 'TEST_CONFIRMED');

    if (anyFailed || anyConfirmed) {
      return {
        status: anyFailed ? 'FAILED' : 'VERIFIED',
        source: 'judge_test_log',
        executed: true,
        passedCount,
        failedCount,
        skippedCount,
        discoveredTestFilesCount,
        summary: parsedLogs.map((r) => r.stdoutExcerpt || r.command).join(' | ').slice(0, 320),
        references: parsedLogs
          .map((r) => r.command || 'Judge-verified executed test log')
          .slice(0, 5)
      };
    }
  }

  if (actionsRuns.length > 0) {
    const failedRuns = actionsRuns.filter(
      (r) => r.status === 'CONTRADICTED' || (r.failedCount ?? 0) > 0
    );
    const passedRuns = actionsRuns.filter((r) => r.status === 'TEST_CONFIRMED');
    if (failedRuns.length > 0) {
      return {
        status: 'FAILED',
        source: 'github_actions',
        executed: true,
        passedCount: passedRuns.length,
        failedCount: failedRuns.length,
        skippedCount: 0,
        discoveredTestFilesCount,
        summary: `Public GitHub Actions CI reported ${failedRuns.length} failing workflow run(s).`,
        references: failedRuns.map((r) => r.command || r.scope || 'CI run').slice(0, 5)
      };
    }
    if (passedRuns.length > 0) {
      return {
        status: 'VERIFIED',
        source: 'github_actions',
        executed: true,
        passedCount: passedRuns.length,
        failedCount: 0,
        skippedCount: 0,
        discoveredTestFilesCount,
        summary: `Public GitHub Actions CI confirmed ${passedRuns.length} passing workflow run(s).`,
        references: passedRuns.map((r) => r.command || r.scope || 'CI run').slice(0, 5)
      };
    }
  }

  return {
    status: 'UNVERIFIED',
    source: 'none',
    executed: false,
    passedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    discoveredTestFilesCount,
    summary:
      discoveredTestFilesCount > 0
        ? `Discovered ${discoveredTestFilesCount} test file(s) in repository, but no executed test results were verified. Not marked as passed or failed.`
        : 'No executed test results available or verified.',
    references: []
  };
}

function isImportantAdditionalUninspectedPath(cleanPath: string): boolean {
  if (isDocumentationOnlyPath(cleanPath)) return false;
  if (isMirrorUploadPath(cleanPath)) return false;
  const lower = cleanPath.toLowerCase();
  const base = lower.split('/').pop() || '';
  if (base === '.gitignore' || base === 'license' || base === 'license.md' || base === 'package-lock.json') {
    return false;
  }
  if (/\.(png|jpg|jpeg|gif|svg|webp|ico|mp4|mov|webm|zip|tar|gz|pdf|woff2?|ttf|eot)$/i.test(lower)) {
    return false;
  }
  return /\.(html|css|scss|json|toml|ya?ml|ts|tsx|js|jsx|mjs|cjs|py|go|sql)$/i.test(lower);
}

export function identifyImportantUninspectedEntries(
  plan: RepoInspectionPlan,
  alreadyInspectedPaths: Set<string>,
  alreadySkippedReasons: Map<string, string>
): PrioritizedRepoEntry[] {
  const duplicateSet = new Set((plan.duplicateMirrorPaths || []).map(normalizeRepoPath));
  const candidates: PrioritizedRepoEntry[] = [];
  const seen = new Set<string>();

  for (const blob of plan.blobEntries) {
    const clean = normalizeRepoPath(blob.path);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);

    if (alreadyInspectedPaths.has(clean)) continue;
    if (duplicateSet.has(clean)) continue;
    const prevReason = alreadySkippedReasons.get(clean);
    if (
      prevReason === 'sensitive_env_or_secret_file' ||
      prevReason === 'binary_or_asset' ||
      prevReason === 'duplicate_mirror' ||
      prevReason === 'file_too_large'
    ) {
      continue;
    }

    const inFileLimit = (plan.fileCountLimitPaths || []).some(
      (p) => normalizeRepoPath(p) === clean
    );
    if (!inFileLimit && !isImportantAdditionalUninspectedPath(clean)) continue;
    if (blob.size > 120_000) continue;

    const category =
      clean.endsWith('.css') || clean.endsWith('.scss') || clean.endsWith('.html')
        ? 'frontend_source'
        : clean.includes('supabase/') || clean.endsWith('.toml') || clean.endsWith('.json')
          ? 'config_security'
          : 'frontend_source';

    candidates.push({
      entry: { ...blob, path: clean },
      category,
      score: inFileLimit ? 75 : 65
    });
  }

  return candidates;
}

export async function collectProjectEvidence(params: {
  submission: ProjectSubmission;
  attachedTestLog?: string;
  signal?: AbortSignal;
  resumeInspectedFiles?: InspectedRepoFile[];
  resumeSkippedFiles?: SkippedRepoFile[];
  resumeCompletedBatches?: number;
  resumeCommitSha?: string | null;
  existingWorkflowChecks?: ObservableWorkflowCheck[];
  inspectAdditionalUninspected?: boolean;
  expandTruncatedFiles?: boolean;
  maxTotalCharsOverride?: number;
  maxPerFileCharsOverride?: number;
  batchSize?: number;
  onBatchProgress?: (state: {
    completedBatches: number;
    totalBatches: number;
    inspectedFiles: InspectedRepoFile[];
    skippedFiles: SkippedRepoFile[];
    commitSha: string | null;
  }) => void;
  deps?: EvidenceCollectionDeps;
}): Promise<{
  bundle: EvidenceBundle;
  interrupted: boolean;
  aborted: boolean;
  inspectedFilesSnapshot: InspectedRepoFile[];
  skippedFilesSnapshot: SkippedRepoFile[];
}> {
  const {
    submission,
    attachedTestLog = '',
    signal,
    resumeInspectedFiles = [],
    resumeSkippedFiles = [],
    resumeCompletedBatches = 0,
    resumeCommitSha = null,
    existingWorkflowChecks,
    inspectAdditionalUninspected = true,
    expandTruncatedFiles = true,
    maxTotalCharsOverride,
    maxPerFileCharsOverride,
    batchSize = 10,
    onBatchProgress,
    deps
  } = params;

  const sanitizedSubmission = sanitizeSubmissionWithoutVideo(submission);
  const discoverPlanFn = deps?.discoverPlanFn ?? discoverGitHubRepoPlan;
  const inspectBatchFn = deps?.inspectBatchFn ?? inspectGitHubRepoBatchSlice;
  const fetchActionsRunsFn = deps?.fetchActionsRunsFn ?? fetchPublicGitHubActionsRuns;
  const probeDemoFn = deps?.probeDemoFn ?? verifyPublicDemoSafely;

  const [plan, demoProbe] = await Promise.all([
    sanitizedSubmission.githubUrl
      ? discoverPlanFn(sanitizedSubmission.githubUrl, { signal, useCache: false })
      : Promise.resolve(null),
    sanitizedSubmission.demoUrl
      ? probeDemoFn(sanitizedSubmission.demoUrl, { signal })
      : Promise.resolve(null)
  ]);

  if (signal?.aborted || plan?.aborted) {
    const abortedCoverage = computeAccurateRepoCoverage({
      plan,
      inspection: null,
      completedBatches: resumeCompletedBatches,
      totalBatches: 0
    });
    return {
      interrupted: true,
      aborted: true,
      inspectedFilesSnapshot: resumeInspectedFiles,
      skippedFilesSnapshot: resumeSkippedFiles,
      bundle: buildEvidenceBundle({
        sanitizedSubmission,
        coverage: abortedCoverage,
        inspectedFiles: resumeInspectedFiles,
        demoProbe,
        attachedTestLog,
        actionsRuns: [],
        existingWorkflowChecks
      })
    };
  }

  let workingInspected: InspectedRepoFile[] = [];
  let workingSkipped: SkippedRepoFile[] = [];
  let completedBatches = 0;

  if (plan && plan.accessible) {
    const canReuseResume =
      Boolean(plan.commitSha) &&
      Boolean(resumeCommitSha) &&
      plan.commitSha === resumeCommitSha &&
      resumeInspectedFiles.length > 0;

    if (canReuseResume) {
      workingInspected = [...resumeInspectedFiles];
      workingSkipped = [...resumeSkippedFiles];
      completedBatches = resumeCompletedBatches;
    }

    const alreadyProcessedPaths = new Set<string>([
      ...workingInspected.map((f) => normalizeRepoPath(f.path)),
      ...workingSkipped.map((s) => normalizeRepoPath(s.path))
    ]);

    const remainingEntries: PrioritizedRepoEntry[] = plan.selectedEntries.filter(
      (sel) => !alreadyProcessedPaths.has(normalizeRepoPath(sel.entry.path))
    );

    const reexpandTargets = new Set<string>();
    if (expandTruncatedFiles) {
      for (const existing of workingInspected) {
        if (!existing.truncated) continue;
        const clean = normalizeRepoPath(existing.path);
        const blobMatch = plan.blobEntries.find((b) => normalizeRepoPath(b.path) === clean);
        const selectedMatch = plan.selectedEntries.find((s) => normalizeRepoPath(s.entry.path) === clean);
        if (blobMatch || selectedMatch) {
          reexpandTargets.add(clean);
          remainingEntries.push({
            entry: blobMatch ? { ...blobMatch, path: clean } : selectedMatch!.entry,
            category: selectedMatch?.category || existing.category,
            score: selectedMatch?.score || 90
          });
        }
      }
    }

    if (inspectAdditionalUninspected) {
      const inspectedSet = new Set<string>(workingInspected.map((f) => normalizeRepoPath(f.path)));
      for (const s of remainingEntries) {
        inspectedSet.add(normalizeRepoPath(s.entry.path));
      }
      const skipReasons = new Map<string, string>();
      for (const s of [...plan.initialSkipped, ...workingSkipped]) {
        skipReasons.set(normalizeRepoPath(s.path), s.reason);
      }
      const additional = identifyImportantUninspectedEntries(plan, inspectedSet, skipReasons);
      remainingEntries.push(...additional);
    }

    const safeBatchSize = Math.max(4, batchSize);
    const remainingBatches: PrioritizedRepoEntry[][] = [];
    for (let i = 0; i < remainingEntries.length; i += safeBatchSize) {
      remainingBatches.push(remainingEntries.slice(i, i + safeBatchSize));
    }

    const totalBatches = completedBatches + remainingBatches.length;
    const effectiveMaxTotalChars =
      maxTotalCharsOverride ??
      (expandTruncatedFiles || inspectAdditionalUninspected
        ? Math.max(plan.maxTotalChars, 450_000)
        : plan.maxTotalChars);
    const effectiveMaxPerFileChars =
      maxPerFileCharsOverride ??
      (expandTruncatedFiles ? Math.max(plan.maxPerFileChars, 25_000) : plan.maxPerFileChars);

    let totalCharsUsed = workingInspected
      .filter((f) => !reexpandTargets.has(normalizeRepoPath(f.path)))
      .reduce((acc, f) => acc + f.charsIncluded, 0);
    let redactedSecretsCount = workingInspected
      .filter((f) => !reexpandTargets.has(normalizeRepoPath(f.path)))
      .reduce((acc, f) => acc + f.redactedSecretsCount, 0);
    let interrupted = false;

    for (const batchSlice of remainingBatches) {
      if (signal?.aborted) {
        interrupted = true;
        break;
      }
      const sliceResult = await inspectBatchFn(plan, batchSlice, {
        signal,
        totalCharsUsedSoFar: totalCharsUsed,
        maxTotalChars: effectiveMaxTotalChars,
        maxPerFileChars: effectiveMaxPerFileChars
      });
      for (const f of sliceResult.inspectedFiles) {
        const clean = normalizeRepoPath(f.path);
        const skippedIdx = workingSkipped.findIndex((s) => normalizeRepoPath(s.path) === clean);
        if (skippedIdx >= 0) {
          workingSkipped.splice(skippedIdx, 1);
        }
        const existingIdx = workingInspected.findIndex((w) => normalizeRepoPath(w.path) === clean);
        if (existingIdx >= 0) {
          if (reexpandTargets.has(clean)) {
            workingInspected[existingIdx] = f;
            reexpandTargets.delete(clean);
          }
        } else {
          alreadyProcessedPaths.add(clean);
          workingInspected.push(f);
        }
      }
      for (const s of sliceResult.skippedOrFailed) {
        const clean = normalizeRepoPath(s.path);
        if (!alreadyProcessedPaths.has(clean)) {
          alreadyProcessedPaths.add(clean);
          workingSkipped.push(s);
        }
      }
      totalCharsUsed += sliceResult.totalCharsAdded;
      redactedSecretsCount += sliceResult.redactedSecretsCount;
      completedBatches += 1;

      onBatchProgress?.({
        completedBatches,
        totalBatches,
        inspectedFiles: [...workingInspected],
        skippedFiles: [...workingSkipped],
        commitSha: plan.commitSha
      });

      if (sliceResult.aborted || signal?.aborted) {
        interrupted = true;
        break;
      }
    }

    const inspection = finalizeGitHubRepoInspection(plan, {
      inspectedFiles: workingInspected,
      extraSkipped: workingSkipped,
      batchesProcessed: completedBatches,
      redactedSecretsCount,
      interrupted
    });

    const actionsRuns =
      !interrupted && sanitizedSubmission.githubUrl
        ? await fetchActionsRunsFn(sanitizedSubmission.githubUrl, {
            expectedCommitSha: plan.commitSha,
            defaultBranch: plan.defaultBranch,
            rateLimitRemaining: plan.rateLimitRemaining,
            signal
          }).catch(() => [])
        : [];

    const coverage = computeAccurateRepoCoverage({
      plan,
      inspection,
      completedBatches,
      totalBatches
    });

    return {
      interrupted,
      aborted: Boolean(signal?.aborted),
      inspectedFilesSnapshot: inspection.inspectedFiles,
      skippedFilesSnapshot: workingSkipped,
      bundle: buildEvidenceBundle({
        sanitizedSubmission,
        coverage,
        inspectedFiles: inspection.inspectedFiles,
        demoProbe,
        attachedTestLog,
        actionsRuns,
        existingWorkflowChecks
      })
    };
  }

  // No accessible repo URL or private/missing repo -> still preserve truthful UNVERIFIED status
  const unavailableCoverage = computeAccurateRepoCoverage({
    plan,
    inspection: null,
    completedBatches: 0,
    totalBatches: 0
  });

  return {
    interrupted: false,
    aborted: false,
    inspectedFilesSnapshot: [],
    skippedFilesSnapshot: [],
    bundle: buildEvidenceBundle({
      sanitizedSubmission,
      coverage: unavailableCoverage,
      inspectedFiles: [],
      demoProbe,
      attachedTestLog,
      actionsRuns: [],
      existingWorkflowChecks
    })
  };
}

function buildEvidenceBundle(params: {
  sanitizedSubmission: EvidenceBundle['sanitizedSubmission'];
  coverage: RepoCoverageReport;
  inspectedFiles: InspectedRepoFile[];
  demoProbe: LiveDemoCheckResult | null;
  attachedTestLog: string;
  actionsRuns: ExecutedTestRecord[];
  existingWorkflowChecks?: ObservableWorkflowCheck[];
}): EvidenceBundle {
  const {
    sanitizedSubmission,
    coverage,
    inspectedFiles,
    demoProbe,
    attachedTestLog,
    actionsRuns,
    existingWorkflowChecks
  } = params;

  const staticExtracted = extractStaticCodeEvidence(inspectedFiles);
  const publicAppProbe = buildPublicAppProbeEvidence(sanitizedSubmission.demoUrl, demoProbe);
  const testVerification = buildTestVerificationSummary({
    attachedTestLog,
    commitSha: coverage.commitSha,
    actionsRuns,
    discoveredTestFilesCount: staticExtracted.discoveredTestFiles.length
  });

  const findings: EvidenceFinding[] = [];

  // Repository access finding
  if (!sanitizedSubmission.githubUrl) {
    findings.push({
      id: 'repo_missing',
      category: 'repository',
      criterionId: 'technical_implementation',
      title: 'No GitHub repository URL provided',
      status: 'UNVERIFIED',
      sourceType: 'submission_metadata',
      sourceLabel: 'Submission metadata',
      detail: 'Repository URL is empty; source code implementation cannot be verified (not classified as FAILED).'
    });
  } else if (!coverage.accessible) {
    findings.push({
      id: 'repo_inaccessible',
      category: 'repository',
      criterionId: 'technical_implementation',
      title: 'GitHub repository inaccessible',
      status: 'UNVERIFIED',
      sourceType: 'github_tree',
      sourceLabel: sanitizedSubmission.githubUrl,
      detail: `${coverage.note} Missing/private repositories remain UNVERIFIED unless access is provided.`
    });
  } else {
    findings.push({
      id: 'repo_verified',
      category: 'repository',
      criterionId: 'technical_implementation',
      title: `Repository inspected (${coverage.repoFullName || sanitizedSubmission.githubUrl})`,
      status: coverage.inspectedFiles + coverage.partiallyInspectedFiles > 0 ? 'VERIFIED' : 'PARTIALLY_VERIFIED',
      sourceType: 'github_tree',
      sourceLabel: `${coverage.repoFullName || ''} @ ${coverage.commitSha || coverage.defaultBranch || 'HEAD'}`,
      detail: coverage.note
    });
  }

  findings.push(...staticExtracted.findings);

  // Executed test verification finding
  findings.push({
    id: 'executed_tests',
    category: 'tests',
    criterionId: 'technical_implementation',
    title: 'Executed Test Verification',
    status: testVerification.status,
    sourceType:
      testVerification.source === 'judge_test_log'
        ? 'executed_test_log'
        : testVerification.source === 'github_actions'
          ? 'ci_workflow_run'
          : 'submission_metadata',
    sourceLabel: testVerification.references[0] || 'No executed test source',
    testResultSummary: testVerification.summary,
    detail: testVerification.summary
  });

  // Live App Probe finding
  findings.push({
    id: 'live_app_probe',
    category: 'live_app',
    criterionId: 'ux_completeness',
    title: 'Public Application URL Probe',
    status: publicAppProbe.reachabilityStatus,
    sourceType: 'server_http_probe',
    sourceLabel: publicAppProbe.url || 'No public URL provided',
    workflowRef: publicAppProbe.finalUrl || publicAppProbe.url || undefined,
    detail: publicAppProbe.summary
  });

  // Impact evidence note (strictly prevents inventing users or business outcomes)
  findings.push({
    id: 'impact_distinction',
    category: 'impact_evidence',
    criterionId: 'real_world_impact',
    title: 'Problem Framing & Demonstrated vs. Potential Impact',
    status: sanitizedSubmission.problemStatement ? 'PARTIALLY_VERIFIED' : 'UNVERIFIED',
    sourceType: 'submission_metadata',
    sourceLabel: 'Submission problemStatement & proposedSolution',
    detail:
      'Submission describes the intended problem and target value, which represents potential impact only unless verified adoption/deployment metrics are independently documented.'
  });

  const workflowChecks: ObservableWorkflowCheck[] =
    existingWorkflowChecks && existingWorkflowChecks.length > 0
      ? existingWorkflowChecks
      : DEFAULT_WORKFLOW_TEMPLATES.map((tpl) => ({
          id: tpl.id,
          label: tpl.label,
          status: 'UNVERIFIED',
          notes: '',
          checkedByJudge: false
        }));

  const inspectedFilesList = inspectedFiles.map((f) => ({
    path: normalizeRepoPath(f.path),
    category: f.category,
    totalLines: f.totalLines,
    truncated: f.truncated,
    status: (f.truncated ? 'PARTIALLY_INSPECTED' : 'FULLY_INSPECTED') as
      | 'FULLY_INSPECTED'
      | 'PARTIALLY_INSPECTED'
  }));

  const epistemicNotices = [
    'Demo videos are completely excluded: videoUrl and video links are stripped and never scored or penalised.',
    'README content is excluded from source code coverage counts and never treated as proof of implemented functionality.',
    'HTTP 200 reachability does not prove interactive user workflows work; observable workflows require manual judge verification.',
    'Tests are never marked VERIFIED unless an actual CI workflow run or executed test log confirms execution results.',
    'Git timestamps do not prove code was written during the hackathon, and automated plagiarism detection is not claimed.'
  ];

  const evidenceKey = buildEvidenceRecordKey({
    projectId: sanitizedSubmission.projectId || sanitizedSubmission.id,
    repoUrl: sanitizedSubmission.githubUrl,
    defaultBranch: coverage.defaultBranch,
    commitSha: coverage.commitSha,
    criteriaVersion: CRITERIA_VERSION,
    evidenceCollectorVersion: EVIDENCE_COLLECTOR_VERSION
  });

  return {
    bundleId: `ev_${sanitizedSubmission.id}_${Date.now().toString(36)}`,
    evidenceKey,
    submissionId: sanitizedSubmission.id,
    projectId: sanitizedSubmission.projectId,
    repoUrl: sanitizedSubmission.githubUrl,
    defaultBranch: coverage.defaultBranch,
    commitSha: coverage.commitSha,
    criteriaVersion: CRITERIA_VERSION,
    evidenceCollectorVersion: EVIDENCE_COLLECTOR_VERSION,
    collectedAt: new Date().toISOString(),
    sanitizedSubmission,
    coverage,
    findings,
    dependencies: staticExtracted.dependencies,
    apiEndpointsDetected: staticExtracted.apiEndpointsDetected,
    clientApiHelpersDetected: staticExtracted.clientApiHelpersDetected,
    testVerification,
    publicAppProbe,
    workflowChecks,
    epistemicNotices,
    inspectedFilesList
  };
}
