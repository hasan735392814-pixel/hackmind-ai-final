import { isValidHttpUrl, parseGitHubOwnerRepo } from '../../utils/validation';
import type { Hackathon, ProjectSubmission } from '../../types/domain';
import {
  buildGitHubBlobUrl,
  normalizeRepoPath,
  redactSecrets,
  type GitHubRepoInspection,
  type InspectedRepoFile
} from '../github/repoInspector';
import {
  VALID_VERIFICATION_STATUSES,
  type AuditExecutionStatus,
  type ComprehensiveJudgingReport,
  type ConfidenceLevel,
  type CriterionObservation,
  type EvidenceRecord,
  type ExecutedTestRecord,
  type FileCitation,
  type HackathonRequirementItem,
  type LiveDemoCheckResult,
  type ProjectInspectionStrategy,
  type VerificationMatrixRow,
  type VerificationStatus
} from './evidenceTypes';
import {
  evaluateEligibilityChecks,
  extractHackathonRequirements
} from './requirementExtractor';

export interface StructuredAIAuditOutput {
  verifiedEvidence?: string[];
  teamClaims?: string[];
  missingEvidence?: string[];
  technicalObservations?: string[];
  potentialRisks?: string[];
  suggestedQuestions?: string[];
  inspectedSources?: string[];
  uninspectedSources?: string[];
  requirementEvaluations?: Array<{
    requirementId?: string;
    status?: VerificationStatus;
    evidenceCitations?: string[];
    summary?: string;
    limitations?: string;
  }>;
  criterionObservations?: Array<{
    criterionName?: string;
    observations?: string[];
    verifiedLinks?: string[];
    missingProof?: string[];
  }>;
  contradictedClaims?: Array<{
    claim?: string;
    sourceLocation?: string;
    reason?: string;
  }>;
  securityFindings?: Array<{
    severity?: 'high' | 'medium' | 'low';
    location?: string;
    finding?: string;
    mitigation?: string;
  }>;
  overallConfidence?: ConfidenceLevel;
  confidenceReason?: string;
}

export function detectProjectStrategies(
  submission?: Partial<ProjectSubmission> | null,
  repo?: Partial<GitHubRepoInspection> | null
): ProjectInspectionStrategy[] {
  const haystack = [
    submission?.title || '',
    submission?.shortDescription || '',
    submission?.fullDescription || '',
    submission?.proposedSolution || '',
    submission?.track || '',
    ...(submission?.technologies || []),
    repo?.description || '',
    repo?.readmeExcerpt || '',
    ...(repo?.treeSamplePaths || []),
    ...(repo?.inspectedFiles?.map((f) => f.path) || [])
  ]
    .join(' ')
    .toLowerCase();

  const strategies: ProjectInspectionStrategy[] = [];
  if (/(paypal|stripe|payment|invoice|billing|checkout|settlement|payout|fintech)/.test(haystack)) {
    strategies.push('payments');
  }
  if (/(gemini|genai|vertex|llm|openai|anthropic|ai |agent|prompt|firebase ai|rag)/.test(haystack)) {
    strategies.push('ai');
  }
  if (/(qloo|taste|dataset|analytics|etl|pipeline|insight|culture|telemetry|feed)/.test(haystack)) {
    strategies.push('data_driven');
  }
  if (/(rls|row[- ]level security|supabase|auth|rbac|jwt|oauth|firestore\.rules|security)/.test(haystack)) {
    strategies.push('security_auth');
  }

  return strategies.length > 0 ? strategies : ['general'];
}

function findLineRangeForPattern(
  file: InspectedRepoFile,
  pattern: RegExp
): { startLine: number; endLine: number; matched: boolean } {
  for (const chunk of file.chunks || []) {
    const lines = chunk.content.split('\n');
    for (let idx = 0; idx < lines.length; idx++) {
      if (pattern.test(lines[idx])) {
        const matchLine = chunk.startLine + idx;
        return {
          startLine: matchLine,
          endLine: Math.min(chunk.endLine, matchLine + 2),
          matched: true
        };
      }
    }
  }
  const first = file.chunks?.[0];
  return first
    ? { startLine: first.startLine, endLine: first.endLine, matched: false }
    : { startLine: 1, endLine: Math.max(1, file.totalLines || 1), matched: false };
}

function makeCitation(
  repo: GitHubRepoInspection,
  file: InspectedRepoFile,
  pattern?: RegExp
): FileCitation {
  const range = pattern
    ? findLineRangeForPattern(file, pattern)
    : file.chunks?.[0]
      ? { startLine: file.chunks[0].startLine, endLine: file.chunks[0].endLine }
      : undefined;
  const ref = repo.commitSha || repo.defaultBranch || 'main';
  return {
    path: file.path,
    ...(range ? { startLine: range.startLine, endLine: range.endLine } : {}),
    ...(repo.repoFullName
      ? {
          blobUrl: buildGitHubBlobUrl(
            repo.repoFullName,
            ref,
            file.path,
            range?.startLine,
            range?.endLine
          )
        }
      : {})
  };
}

const TEST_RUNNER_MARKER_PATTERN =
  /\b(vitest|jest|pytest|mocha|playwright|cypress|phpunit|rspec|karma|jasmine)\b|\b(npm\s+(?:t|test|run\s+test\S*)|npx\s+(?:vitest|jest|playwright|mocha)|yarn\s+test|pnpm\s+test|bun\s+test|go\s+test|cargo\s+test)\b|\bTest\s+Files\s+\d+\s+passed\b|\bTests:?\s+\d+\s+passed\b|\bRan\s+\d+\s+tests?\b|\btest\s+result:\s*ok\.\s*\d+\s+passed\b|^---\s+PASS:\s+\S+/im;

const BUILD_OR_LINT_COMMAND_PATTERN =
  /\b(vite\s+build|webpack|rollup|esbuild|tsc\b|eslint\b|prettier\b|stylelint\b|npm\s+run\s+(?:build|lint|typecheck)|built\s+in\s+\d|\b0\s+errors?\b)/i;

/**
 * Parses user-attached CI / local test execution logs safely (without executing untrusted code).
 * Self-reported pasted logs CANNOT prove commit provenance and NEVER produce TEST_CONFIRMED;
 * only verified GitHub Actions CI runs tied to the exact commit SHA can achieve TEST_CONFIRMED.
 */
export function parseExecutedTestEvidence(
  rawLogText?: string | null,
  options?: { expectedCommitSha?: string | null }
): ExecutedTestRecord[] {
  if (!rawLogText || !rawLogText.trim()) return [];
  const { sanitized } = redactSecrets(rawLogText.trim());
  const timestamp = new Date().toISOString();

  // Support Go test PASS lines (`--- PASS: TestName (...)` and `go test ...` + `ok pkg`) strictly
  const goPassLineMatches = sanitized.match(/^---\s+PASS:\s+\S+/gm) || [];
  const goFailLineMatches = sanitized.match(/^---\s+FAIL:\s+\S+/gm) || [];
  const goPkgOkMatches = /\bgo\s+test\b/i.test(sanitized)
    ? sanitized.match(/^ok\s+\S+(?:\s+[\d.]+s)?/gm) || []
    : [];
  const hasGoStandalonePass = /^PASS\s*$/m.test(sanitized);
  const hasValidGoTestSignal =
    goFailLineMatches.length === 0 &&
    ((goPassLineMatches.length > 0 && (hasGoStandalonePass || goPkgOkMatches.length > 0 || /\bgo\s+test\b/i.test(sanitized))) ||
      goPkgOkMatches.length > 0);

  // Detect explicit test counts from Vitest / Jest / Pytest / Rust / Go test runners
  const passedMatch =
    sanitized.match(/\bTests:?\s+(\d+)\s+passed\b/i) ||
    sanitized.match(/\b(\d+)\s+passed\b/i) ||
    sanitized.match(/\bRan\s+(\d+)\s+tests?\b/i);
  const failedMatch = sanitized.match(/\b(\d+)\s+failed\b/i);
  const skippedMatch = sanitized.match(/\b(\d+)\s+skipped\b/i);
  const exitMatch = sanitized.match(/exit(?:\s+code)?\s*[:=]\s*(\d+)/i);
  const commandMatch =
    sanitized.match(/^\$\s*(.+)$/m) ||
    sanitized.match(/^(npm\s+(?:test|run\s+\S+)|npx\s+\S+|pytest.*|vitest.*|jest.*|go\s+test.*|cargo\s+test.*)$/im);

  const goDerivedCount =
    goPassLineMatches.length > 0 ? goPassLineMatches.length : goPkgOkMatches.length;
  const passedCount = passedMatch
    ? Number(passedMatch[1])
    : hasValidGoTestSignal && goDerivedCount > 0
      ? goDerivedCount
      : undefined;
  const failedCount = failedMatch
    ? Number(failedMatch[1])
    : goFailLineMatches.length > 0
      ? goFailLineMatches.length
      : undefined;
  const skippedCount = skippedMatch ? Number(skippedMatch[1]) : undefined;
  const parsedExit = exitMatch ? Number(exitMatch[1]) : null;
  const commandText = commandMatch?.[1]?.trim() || 'Attached judge/CI command log';

  const sanitizedLines = sanitized.split(/\r?\n/);
  const isPassingTestCaseLine = (line: string): boolean =>
    /^\s*(?:✓|✔|---\s+PASS:|PASS(?:\s|$)|ok\s+)/.test(line);
  const hasRunnerFailureLine = sanitizedLines.some((line) => {
    if (isPassingTestCaseLine(line)) return false;
    return (
      /^\s*(?:FAIL(?:\s|$)|FAILED(?:\s|$)|✕|✖|×|npm\s+ERR!|ERR!|AssertionError\b|TypeError:|ReferenceError:|SyntaxError:|RangeError:|=+\s*FAILURES\s*=+)/.test(
        line
      ) ||
      /^test\s+\S+.*\sFAILED\s*$/.test(line) ||
      /^test\s+result:\s*FAILED\b/i.test(line) ||
      /\b[1-9]\d*\s+failures?\b/i.test(line)
    );
  });

  const hasExplicitFailure =
    (typeof failedCount === 'number' && failedCount > 0) ||
    goFailLineMatches.length > 0 ||
    (parsedExit !== null && parsedExit !== 0) ||
    hasRunnerFailureLine;

  const hasZeroTestsSignal =
    /\b(0\s+passed|0\s+tests?|no\s+tests?\s+(?:found|executed|run)|collected\s+0\s+items|no\s+test\s+files)\b/i.test(
      sanitized
    ) || passedCount === 0;

  const hasTestRunnerSignature =
    TEST_RUNNER_MARKER_PATTERN.test(sanitized) || hasValidGoTestSignal;
  const isBuildOrLintLog =
    BUILD_OR_LINT_COMMAND_PATTERN.test(sanitized) &&
    !/\b(vitest|jest|pytest|mocha|playwright|cypress|Test\s+Files\s+\d+\s+passed|Tests:?\s+\d+\s+passed|npm\s+test|go\s+test|cargo\s+test)\b/i.test(
      sanitized
    ) &&
    goPassLineMatches.length === 0;

  const hasPositivePassedCount = typeof passedCount === 'number' && passedCount > 0;
  const hasValidExitCode = parsedExit === null || parsedExit === 0;

  const parsedSelfReportedPass =
    !hasExplicitFailure &&
    !hasZeroTestsSignal &&
    !isBuildOrLintLog &&
    hasTestRunnerSignature &&
    hasPositivePassedCount &&
    hasValidExitCode;

  const expectedShortSha = options?.expectedCommitSha?.trim().slice(0, 7).toLowerCase();
  const shaMentionedInText = Boolean(
    expectedShortSha && sanitized.toLowerCase().includes(expectedShortSha)
  );

  const provenanceNote = options?.expectedCommitSha
    ? shaMentionedInText
      ? `Self-reported unverified log referencing commit ${expectedShortSha} (unverified origin — cannot confirm TEST_CONFIRMED)`
      : `Self-reported unverified log — cannot be cryptographically tied to inspected commit ${expectedShortSha}`
    : 'Self-reported unverified log — unverified provenance and commit association';

  const parsedSummaryPrefix = parsedSelfReportedPass
    ? `Parsed ${passedCount} passing test(s) · `
    : '';

  // Self-reported attached logs without verified CI provenance remain UNVERIFIED (never TEST_CONFIRMED)
  const status: ExecutedTestRecord['status'] = hasExplicitFailure ? 'CONTRADICTED' : 'UNVERIFIED';

  return [
    {
      id: 'attached_test_run_1',
      command: commandText,
      scope: isBuildOrLintLog
        ? `Build/lint output only (not test execution) · ${provenanceNote}`
        : `${parsedSummaryPrefix}${provenanceNote}`,
      exitCode: parsedExit ?? (hasExplicitFailure ? 1 : parsedSelfReportedPass ? 0 : null),
      ...(passedCount !== undefined ? { passedCount } : {}),
      ...(failedCount !== undefined ? { failedCount } : {}),
      ...(skippedCount !== undefined ? { skippedCount } : {}),
      stdoutExcerpt: sanitized.slice(0, 1800),
      timestamp,
      source: 'user_attached_ci_log',
      status,
      matchesInspectedCommit: false
    }
  ];
}

const NON_TEST_WORKFLOW_PATTERN =
  /(?:^|[^a-z0-9])(deploy|pages|publish|release|lint|format|prettier|eslint|codeql|security|dependabot|stale|label|sync|docs)(?=[^a-z0-9]|$)/i;
const TEST_WORKFLOW_OR_JOB_PATTERN =
  /(?:^|[^a-z0-9])(test|tests|testing|unit|integration|e2e|spec|vitest|jest|pytest|mocha|playwright|cypress|go_?test|cargo_?test|rspec|phpunit|karma|jasmine|bun_?test|ava|junit|testng)(?=[^a-z0-9]|$)/i;

export async function fetchPublicGitHubActionsRuns(
  githubUrl: string,
  options?: {
    signal?: AbortSignal;
    rateLimitRemaining?: number | null;
    expectedCommitSha?: string | null;
    defaultBranch?: string | null;
  }
): Promise<ExecutedTestRecord[]> {
  if (options?.signal?.aborted) return [];
  if (typeof options?.rateLimitRemaining === 'number' && options.rateLimitRemaining <= 5) {
    return [];
  }
  const parsed = parseGitHubOwnerRepo(githubUrl);
  if (!parsed) return [];

  const expectedCommitSha = options?.expectedCommitSha?.trim() || null;
  if (!expectedCommitSha) {
    // Cannot verify commit parity without a resolved commit SHA; never grant TEST_CONFIRMED.
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  const onAbort = () => controller.abort();
  options?.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/actions/runs?head_sha=${encodeURIComponent(expectedCommitSha)}&per_page=30`,
      {
        signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json' }
      }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      workflow_runs?: Array<{
        id?: number;
        name?: string;
        path?: string;
        status?: string;
        conclusion?: string | null;
        updated_at?: string;
        head_sha?: string;
        head_branch?: string;
      }>;
    };

    // Strictly ignore runs belonging to any other commit SHA, and filter out non-test workflows before slicing
    const commitMatchingRuns = (data.workflow_runs || [])
      .filter((run) => run.head_sha === expectedCommitSha)
      .filter((run) => {
        const workflowLabel = `${run.name || ''} ${run.path || ''}`.trim();
        const isClearlyNonTestWorkflow =
          NON_TEST_WORKFLOW_PATTERN.test(workflowLabel) &&
          !TEST_WORKFLOW_OR_JOB_PATTERN.test(workflowLabel);
        return !isClearlyNonTestWorkflow;
      })
      .slice(0, 5);

    const results: ExecutedTestRecord[] = [];
    for (let idx = 0; idx < commitMatchingRuns.length; idx++) {
      const run = commitMatchingRuns[idx];
      const conclusion = (run.conclusion || run.status || 'unknown').toLowerCase();

      let verifiedTestJobName: string | null = null;
      let jobInspectionIncomplete = false;

      if (conclusion === 'success' && typeof run.id === 'number') {
        try {
          const jobsRes = await fetch(
            `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/actions/runs/${run.id}/jobs?per_page=50`,
            {
              signal: controller.signal,
              headers: { Accept: 'application/vnd.github+json' }
            }
          );
          if (jobsRes.ok) {
            const jobsData = (await jobsRes.json()) as {
              jobs?: Array<{
                name?: string;
                conclusion?: string | null;
                steps?: Array<{ name?: string; conclusion?: string | null }>;
              }>;
            };
            const matchingJob = (jobsData.jobs || []).find((job) => {
              if ((job.conclusion || '').toLowerCase() !== 'success') return false;
              const jobNameMatches =
                TEST_WORKFLOW_OR_JOB_PATTERN.test(job.name || '') &&
                !NON_TEST_WORKFLOW_PATTERN.test(job.name || '');
              const stepMatches = (job.steps || []).some(
                (st) =>
                  (st.conclusion || '').toLowerCase() === 'success' &&
                  TEST_WORKFLOW_OR_JOB_PATTERN.test(st.name || '') &&
                  !NON_TEST_WORKFLOW_PATTERN.test(st.name || '')
              );
              return jobNameMatches || stepMatches;
            });
            if (matchingJob) {
              verifiedTestJobName = matchingJob.name || 'test job';
            }
          } else {
            jobInspectionIncomplete = true;
          }
        } catch {
          jobInspectionIncomplete = true;
        }
      }

      const status: ExecutedTestRecord['status'] =
        conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out'
          ? 'CONTRADICTED'
          : conclusion === 'success' && Boolean(verifiedTestJobName) && !jobInspectionIncomplete
            ? 'TEST_CONFIRMED'
            : 'UNVERIFIED';

      results.push({
        id: `gh_actions_${run.id ?? idx}`,
        command: `GitHub Actions: ${run.name || 'workflow'}`,
        scope:
          status === 'TEST_CONFIRMED'
            ? `Verified test job "${verifiedTestJobName}" passed on commit ${expectedCommitSha.slice(0, 7)}`
            : `Workflow conclusion=${run.conclusion || run.status || 'unknown'} @ ${expectedCommitSha.slice(0, 7)} (test step execution ${jobInspectionIncomplete ? 'incomplete' : 'unconfirmed'})`,
        exitCode: status === 'TEST_CONFIRMED' ? 0 : status === 'CONTRADICTED' ? 1 : null,
        stdoutExcerpt: `Remote CI workflow "${run.name || 'CI'}" (commit=${expectedCommitSha.slice(0, 7)}, branch=${run.head_branch || 'unknown'}) reported status="${run.status || 'unknown'}", conclusion="${run.conclusion || 'pending'}" at ${run.updated_at || 'unknown'}.${verifiedTestJobName ? ` Verified passing test job: ${verifiedTestJobName}.` : ' No verified executed test job/step confirmed.'}`,
        timestamp: run.updated_at || new Date().toISOString(),
        source: 'github_actions_metadata',
        status,
        headSha: run.head_sha || null,
        headBranch: run.head_branch || null,
        matchesInspectedCommit: true
      });
    }

    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Safe, read-only public demo verification check.
 * Never executes mutating POST/PUT/DELETE requests, form submissions, or payments.
 * Never bypasses auth or SSRF protections, and never marks PRODUCTION_CONFIRMED from HTTP 200 alone.
 * When browser CORS blocks direct GET reading, falls back to the legitimate Express POST /api/demo-probe
 * endpoint if available, while still requiring manual browser verification for interactive flows.
 */
export async function verifyPublicDemoSafely(
  demoUrl?: string | null,
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    disableServerProbe?: boolean;
    serverProbeEndpoint?: string;
  }
): Promise<LiveDemoCheckResult> {
  const checkedAt = new Date().toISOString();
  const trimmed = (demoUrl || '').trim();
  if (!trimmed) {
    return {
      demoUrl: '',
      checkedAt,
      reachable: false,
      httpStatus: null,
      corsBlocked: false,
      browserCorsBlocked: false,
      requiresAuth: false,
      probeMethod: 'manual_required',
      manualVerificationRequired: false,
      checkedAspects: [],
      blockedAspects: ['No demo URL was submitted by the team.'],
      status: 'UNVERIFIED',
      summary: 'No live demo URL provided; live application behavior is UNVERIFIED.'
    };
  }

  if (!isValidHttpUrl(trimmed)) {
    return {
      demoUrl: trimmed,
      checkedAt,
      reachable: false,
      httpStatus: null,
      corsBlocked: false,
      browserCorsBlocked: false,
      requiresAuth: false,
      probeMethod: 'manual_required',
      manualVerificationRequired: true,
      checkedAspects: ['URL syntax validation'],
      blockedAspects: ['Invalid HTTP/HTTPS demo URL format.'],
      status: 'CONTRADICTED',
      summary: 'Submitted demo URL is not a valid HTTP(S) URL.'
    };
  }

  if (options?.signal?.aborted) {
    return {
      demoUrl: trimmed,
      checkedAt,
      reachable: false,
      httpStatus: null,
      corsBlocked: false,
      browserCorsBlocked: false,
      requiresAuth: false,
      probeMethod: 'manual_required',
      manualVerificationRequired: true,
      checkedAspects: [],
      blockedAspects: ['Live demo probe aborted before completion.'],
      status: 'BLOCKED',
      summary: 'Live demo probe was cancelled.'
    };
  }

  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 6_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options?.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(trimmed, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal
    });

    const contentType = res.headers.get('content-type');
    if (res.status === 401 || res.status === 403) {
      return {
        demoUrl: trimmed,
        checkedAt,
        reachable: true,
        httpStatus: res.status,
        finalUrl: res.url || trimmed,
        contentType,
        corsBlocked: false,
        browserCorsBlocked: false,
        requiresAuth: true,
        probeMethod: 'browser_fetch',
        manualVerificationRequired: true,
        checkedAspects: [`Read-only HTTP GET returned ${res.status}`],
        blockedAspects: ['Authenticated UI and functional flows require login credentials.'],
        status: 'BLOCKED',
        summary: `Demo endpoint responded HTTP ${res.status} (authentication required); interactive flows remain BLOCKED without judge test credentials.`
      };
    }

    if (!res.ok) {
      return {
        demoUrl: trimmed,
        checkedAt,
        reachable: false,
        httpStatus: res.status,
        finalUrl: res.url || trimmed,
        contentType,
        corsBlocked: false,
        browserCorsBlocked: false,
        requiresAuth: false,
        probeMethod: 'browser_fetch',
        manualVerificationRequired: true,
        checkedAspects: [`Read-only HTTP GET returned ${res.status}`],
        blockedAspects: ['Public endpoint returned non-2xx HTTP status.'],
        status: 'CONTRADICTED',
        summary: `Submitted demo URL returned HTTP ${res.status}; availability claim contradicted during read-only check.`
      };
    }

    let bodySnippet = '';
    try {
      bodySnippet = (await res.text()).slice(0, 4000);
    } catch {
      bodySnippet = '';
    }

    const titleMatch = bodySnippet.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
    const hasCrashBanner = /(Application error|500 Internal Server Error|__next_error__|Module not found)/i.test(
      bodySnippet
    );

    if (hasCrashBanner) {
      return {
        demoUrl: trimmed,
        checkedAt,
        reachable: true,
        httpStatus: res.status,
        finalUrl: res.url || trimmed,
        contentType,
        corsBlocked: false,
        browserCorsBlocked: false,
        requiresAuth: false,
        probeMethod: 'browser_fetch',
        manualVerificationRequired: true,
        checkedAspects: [
          `Read-only HTTP GET returned ${res.status}`,
          'Scanned initial HTML for runtime error banners'
        ],
        blockedAspects: ['Interactive flows halted because initial response includes an error signature.'],
        status: 'CONTRADICTED',
        summary: `Demo URL returned HTTP ${res.status} but HTML output contains an application error banner.`
      };
    }

    return {
      demoUrl: trimmed,
      checkedAt,
      reachable: true,
      httpStatus: res.status,
      finalUrl: res.url || trimmed,
      contentType,
      corsBlocked: false,
      browserCorsBlocked: false,
      requiresAuth: false,
      probeMethod: 'browser_fetch',
      manualVerificationRequired: true,
      checkedAspects: [
        `Read-only HTTP GET returned ${res.status} (${contentType || 'unknown content-type'})`,
        ...(titleMatch?.[1] ? [`HTML <title>: "${titleMatch[1].trim()}"`] : [])
      ],
      blockedAspects: [
        'Safe browser probe does not execute JS interactions, form submissions, auth sessions, or payments; feature correctness in production remains UNVERIFIED.'
      ],
      // Strictly never mark PRODUCTION_CONFIRMED from HTTP 200 GET alone
      status: 'UNVERIFIED',
      summary: `Demo URL returned HTTP ${res.status} (read-only reachability observed${titleMatch?.[1] ? `, title="${titleMatch[1].trim()}"` : ''}). HTTP 200 does NOT confirm end-to-end feature correctness.`
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';

    // When browser CORS blocks reading the live URL (not timeout/abort), try the safe Express HTTP probe endpoint
    if (!isTimeout && !options?.signal?.aborted && !options?.disableServerProbe) {
      try {
        const probeController = new AbortController();
        const probeTimer = setTimeout(() => probeController.abort(), timeoutMs);
        const onProbeAbort = () => probeController.abort();
        options?.signal?.addEventListener('abort', onProbeAbort, { once: true });
        try {
          const probeEndpoint = options?.serverProbeEndpoint || '/api/demo-probe';
          const probeRes = await fetch(probeEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: trimmed }),
            signal: probeController.signal
          });
          if (probeRes.ok) {
            const data = (await probeRes.json()) as {
              reachable?: boolean;
              httpStatus?: number | null;
              finalUrl?: string | null;
              contentType?: string | null;
              requiresAuth?: boolean;
              status?: VerificationStatus;
              summary?: string;
              checkedAspects?: string[];
              blockedAspects?: string[];
              manualVerificationRequired?: boolean;
            };
            if (typeof data?.status === 'string' && typeof data?.reachable === 'boolean') {
              const safeStatus: VerificationStatus =
                data.status === 'CONTRADICTED' || data.status === 'BLOCKED' || data.status === 'UNVERIFIED'
                  ? data.status
                  : 'UNVERIFIED';
              return {
                demoUrl: trimmed,
                checkedAt,
                reachable: data.reachable,
                httpStatus: typeof data.httpStatus === 'number' ? data.httpStatus : null,
                finalUrl: data.finalUrl ?? trimmed,
                contentType: data.contentType ?? null,
                corsBlocked: true,
                browserCorsBlocked: true,
                requiresAuth: Boolean(data.requiresAuth),
                probeMethod: 'server_http_probe',
                manualVerificationRequired: true,
                checkedAspects: [
                  'Direct browser CORS fetch was blocked; executed legitimate server-side read-only HTTP GET probe (/api/demo-probe)',
                  ...(Array.isArray(data.checkedAspects) ? data.checkedAspects : [])
                ],
                blockedAspects: Array.from(
                  new Set([
                    ...(Array.isArray(data.blockedAspects) ? data.blockedAspects : []),
                    'Manual browser verification required: server HTTP probe cannot execute client-side JavaScript, authenticated sessions, or interactive flows.'
                  ])
                ),
                status: safeStatus,
                summary:
                  data.summary ||
                  `Browser CORS blocked direct fetch; server-side HTTP GET probe completed (HTTP ${data.httpStatus ?? 'unknown'}). Manual browser verification required for interactive flows.`
              };
            }
          }
        } finally {
          clearTimeout(probeTimer);
          options?.signal?.removeEventListener('abort', onProbeAbort);
        }
      } catch {
        // Server probe unavailable in offline/static context; fall through to honest BLOCKED result
      }
    }

    return {
      demoUrl: trimmed,
      checkedAt,
      reachable: false,
      httpStatus: null,
      corsBlocked: !isTimeout,
      browserCorsBlocked: !isTimeout,
      requiresAuth: false,
      probeMethod: 'manual_required',
      manualVerificationRequired: true,
      checkedAspects: ['Attempted read-only browser CORS GET probe'],
      blockedAspects: [
        isTimeout
          ? `Request timed out after ${Math.round(timeoutMs / 1000)}s.`
          : `Browser CORS or network isolation blocked reading live response (${errMsg}). Open demo link manually in a separate tab to verify interactive behavior.`
      ],
      status: 'BLOCKED',
      summary: isTimeout
        ? `Live demo check timed out after ${Math.round(timeoutMs / 1000)}s (BLOCKED).`
        : 'Browser CORS policy blocked inspecting the external demo URL programmatically; requires manual judge verification.'
    };
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', onAbort);
  }
}

export function auditProjectDomainImplementation(
  repo: GitHubRepoInspection,
  strategies: ProjectInspectionStrategy[],
  observedAt: string
): {
  architectureFindings: EvidenceRecord[];
  securityFindings: EvidenceRecord[];
  contradictions: EvidenceRecord[];
} {
  const architectureFindings: EvidenceRecord[] = [];
  const securityFindings: EvidenceRecord[] = [];
  const contradictions: EvidenceRecord[] = [];

  if (!repo.accessible || repo.inspectedFiles.length === 0) {
    return { architectureFindings, securityFindings, contradictions };
  }

  const ref = repo.commitSha;

  // Check secret leak / redaction event
  if (repo.redactedSecretsCount > 0) {
    const offendingFiles = repo.inspectedFiles.filter((f) => f.redactedSecretsCount > 0);
    const firstFile = offendingFiles[0];
    securityFindings.push({
      id: 'sec_hardcoded_secrets',
      claimOrRequirement: 'No committed live credentials or API secrets in repository source',
      verificationMethod: 'static_code_audit',
      evidenceSource: firstFile?.path || 'inspectedFiles',
      ...(firstFile ? { filePath: firstFile.path } : {}),
      ...(firstFile ? makeCitation(repo, firstFile, /REDACTED_SECRET/) : {}),
      commitSha: ref,
      observedAt,
      observedResult: `Detected and redacted ${repo.redactedSecretsCount} hardcoded secret/credential literal(s) in inspected source (${offendingFiles.map((f) => f.path).join(', ') || 'source files'}).`,
      status: 'CONTRADICTED',
      confidence: 'HIGH',
      confidenceReason: 'Pattern match caught literal secret assignment inside tracked repository file.',
      limitations: ['Secret values were scrubbed before leaving browser memory; rotate exposed keys immediately.']
    });
  }

  // Payments verification strategy
  if (strategies.includes('payments')) {
    const paymentFiles = repo.inspectedFiles.filter((f) => f.category === 'payments_paypal');
    const webhookFile = paymentFiles.find((f) => /webhook/i.test(f.path)) || paymentFiles[0];
    if (webhookFile) {
      const citation = makeCitation(repo, webhookFile, /webhook|paypal|transmission|signature|verify/i);
      const hasCryptoVerify =
        /verify[-_]?webhook[-_]?signature|crypto\.createHmac|timingSafeEqual|verifyWebhookSignature/i.test(
          webhookFile.excerpt
        );
      const headerOnlyCheck =
        /paypal-transmission-sig/i.test(webhookFile.excerpt) && !hasCryptoVerify;
      const hasIdempotency = /idempoten|already_processed|processed_events|unique/i.test(
        paymentFiles.map((f) => f.excerpt).join('\n')
      );
      const hasServerAmountCheck = /currency|amount|unit_amount|total/i.test(
        paymentFiles.map((f) => f.excerpt).join('\n')
      );

      architectureFindings.push({
        id: 'arch_payment_module',
        claimOrRequirement: 'Payment / webhook integration module',
        verificationMethod: 'static_code_audit',
        evidenceSource: webhookFile.path,
        filePath: webhookFile.path,
        startLine: citation.startLine,
        endLine: citation.endLine,
        blobUrl: citation.blobUrl,
        commitSha: ref,
        observedAt,
        observedResult: `Payment source inspected at ${webhookFile.path}. Server amount/currency references: ${hasServerAmountCheck ? 'present' : 'not observed'}. Idempotency guard: ${hasIdempotency ? 'present' : 'not observed'}.`,
        status: 'CODE_CONFIRMED',
        confidence: 'HIGH',
        confidenceReason: 'Static file inspected directly from GitHub repository.',
        limitations: [
          'Static code inspection cannot prove live PayPal sandbox/production settlement or webhook delivery.'
        ]
      });

      if (headerOnlyCheck) {
        securityFindings.push({
          id: 'sec_paypal_header_only',
          claimOrRequirement: 'Cryptographic PayPal webhook signature verification',
          verificationMethod: 'static_code_audit',
          evidenceSource: webhookFile.path,
          filePath: webhookFile.path,
          startLine: citation.startLine,
          endLine: citation.endLine,
          blobUrl: citation.blobUrl,
          commitSha: ref,
          observedAt,
          observedResult:
            'Webhook handler inspects presence of "paypal-transmission-sig" header without calling PayPal verify-webhook-signature API or verifying cryptographic certificate chain.',
          status: 'CONTRADICTED',
          confidence: 'MEDIUM',
          confidenceReason: 'Detected header check without cryptographic verification call in inspected excerpt.',
          limitations: ['Verify full file if chunked; confirm whether verification occurs in an upstream middleware.']
        });
      }

      if (!hasIdempotency) {
        securityFindings.push({
          id: 'sec_payment_idempotency',
          claimOrRequirement: 'Idempotency & duplicate webhook/capture protection',
          verificationMethod: 'static_code_audit',
          evidenceSource: paymentFiles.map((f) => f.path).join(', '),
          filePath: webhookFile.path,
          startLine: citation.startLine,
          endLine: citation.endLine,
          blobUrl: citation.blobUrl,
          commitSha: ref,
          observedAt,
          observedResult:
            'No explicit idempotency key or duplicate-event guard observed in inspected payment handlers.',
          status: 'UNVERIFIED',
          confidence: 'MEDIUM',
          confidenceReason: 'Keyword/pattern check over inspected payment files found no idempotency guard.',
          limitations: ['May exist in an uninspected database constraint or migration file.']
        });
      }
    }
  }

  // AI Integration strategy
  if (strategies.includes('ai')) {
    const aiFiles = repo.inspectedFiles.filter((f) => f.category === 'gemini_ai');
    if (aiFiles.length > 0) {
      const f = aiFiles[0];
      const citation = makeCitation(repo, f, /GoogleGenAI|getGenerativeModel|generateContent|OPENAI|fetch/i);
      const clientSideKeyRisk = /dangerouslyAllowBrowser|VITE_.*GEMINI.*KEY|VITE_.*OPENAI.*KEY/i.test(
        aiFiles.map((x) => x.excerpt).join('\n')
      );
      architectureFindings.push({
        id: 'arch_ai_integration',
        claimOrRequirement: 'AI model provider integration in source code',
        verificationMethod: 'static_code_audit',
        evidenceSource: f.path,
        filePath: f.path,
        startLine: citation.startLine,
        endLine: citation.endLine,
        blobUrl: citation.blobUrl,
        commitSha: ref,
        observedAt,
        observedResult: `Inspected AI client/service file ${f.path} (${aiFiles.length} AI module(s) reviewed).`,
        status: 'CODE_CONFIRMED',
        confidence: 'HIGH',
        confidenceReason: 'Observed AI SDK/API integration in inspected source file.',
        limitations: ['Runtime API latency, quota availability, and output quality cannot be proven from static code alone.']
      });
      if (clientSideKeyRisk) {
        securityFindings.push({
          id: 'sec_client_ai_key',
          claimOrRequirement: 'Server-side isolation of private AI provider secrets',
          verificationMethod: 'static_code_audit',
          evidenceSource: f.path,
          filePath: f.path,
          startLine: citation.startLine,
          endLine: citation.endLine,
          blobUrl: citation.blobUrl,
          commitSha: ref,
          observedAt,
          observedResult: 'Potential client-exposed AI API key or browser-side credential flag detected in AI integration code.',
          status: 'CONTRADICTED',
          confidence: 'MEDIUM',
          confidenceReason: 'Found browser-exposed secret env prefix or dangerouslyAllowBrowser flag.',
          limitations: ['Confirm deployment bundle does not embed private server API keys.']
        });
      }
    }
  }

  // Database / RLS / Auth strategy
  const rlsFiles = repo.inspectedFiles.filter((f) => f.category === 'database_rls');
  const authFiles = repo.inspectedFiles.filter((f) => f.category === 'auth_rbac');
  if (rlsFiles.length > 0) {
    const f = rlsFiles[0];
    const citation = makeCitation(repo, f, /ENABLE ROW LEVEL SECURITY|CREATE POLICY|allow\s+/i);
    architectureFindings.push({
      id: 'arch_database_rls',
      claimOrRequirement: 'Database schema / Row-Level Security / Access rules',
      verificationMethod: 'static_code_audit',
      evidenceSource: f.path,
      filePath: f.path,
      startLine: citation.startLine,
      endLine: citation.endLine,
      blobUrl: citation.blobUrl,
      commitSha: ref,
      observedAt,
      observedResult: `Database schema / security rules defined in ${f.path}.`,
      status: 'CODE_CONFIRMED',
      confidence: 'HIGH',
      confidenceReason: 'Inspected SQL migration or rules file directly.',
      limitations: ['Static SQL/rules presence does not prove migrations were applied to live database.']
    });
  }
  if (authFiles.length > 0) {
    const f = authFiles[0];
    const citation = makeCitation(repo, f, /auth|verify|jwt|session|role|guard/i);
    const weakBearerOnly =
      /startsWith\(["'`]Bearer\s*["'`]\)/.test(f.excerpt) &&
      !/jwt\.verify|verifyIdToken|getUser|supabase\.auth/i.test(f.excerpt);
    if (weakBearerOnly) {
      securityFindings.push({
        id: 'sec_weak_bearer_check',
        claimOrRequirement: 'Cryptographic token validation in authentication guard',
        verificationMethod: 'static_code_audit',
        evidenceSource: f.path,
        filePath: f.path,
        startLine: citation.startLine,
        endLine: citation.endLine,
        blobUrl: citation.blobUrl,
        commitSha: ref,
        observedAt,
        observedResult: `Auth guard in ${f.path} checks Bearer header prefix without visible cryptographic JWT verification.`,
        status: 'CONTRADICTED',
        confidence: 'MEDIUM',
        confidenceReason: 'Pattern check showed header string check without token signature verify call.',
        limitations: ['Confirm if verification is delegated to another middleware file.']
      });
    }
  }

  // Flag overstated README claims (e.g. SOC2 / 99.99% SLA / multi-region production) without artifacts
  if (repo.readmeExcerpt && /(99\.9\d*%|SOC\s?2|ISO\s?27001|12 regions|audited production)/i.test(repo.readmeExcerpt)) {
    contradictions.push({
      id: 'claim_production_certification',
      claimOrRequirement: 'Production compliance / uptime SLA claims in README',
      verificationMethod: 'static_code_audit',
      evidenceSource: 'README.md',
      filePath: 'README.md',
      commitSha: ref,
      observedAt,
      observedResult:
        'README contains production certification, SLA, or multi-region claims without verifiable audit logs, Terraform/IaC multi-region configs, or uptime telemetry in inspected files.',
      status: 'UNVERIFIED',
      confidence: 'MEDIUM',
      confidenceReason: 'Claim text appeared in README without corroborating infrastructure or audit evidence.',
      limitations: ['Ask team for verifiable third-party compliance artifacts or telemetry.']
    });
  }

  return { architectureFindings, securityFindings, contradictions };
}

export function normalizeVerificationStatus(status: unknown): VerificationStatus {
  if (
    typeof status === 'string' &&
    (VALID_VERIFICATION_STATUSES as readonly string[]).includes(status)
  ) {
    return status as VerificationStatus;
  }
  return 'UNVERIFIED';
}

export interface AIValidationResult {
  valid: boolean;
  output: StructuredAIAuditOutput | null;
  issues: string[];
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function readSafeStringArray(
  obj: Record<string, unknown>,
  key: string,
  maxItems: number,
  issues: string[],
  fatalContainerErrors: string[]
): string[] | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined;
  const val = obj[key];
  if (!Array.isArray(val)) {
    const msg = `Field "${key}" must be an array of strings.`;
    issues.push(msg);
    fatalContainerErrors.push(msg);
    return undefined;
  }
  const clean: string[] = [];
  for (let i = 0; i < val.length; i++) {
    const item = val[i];
    if (typeof item === 'string') {
      const trimmed = redactSecrets(item.trim()).sanitized;
      if (trimmed) clean.push(trimmed);
    } else {
      issues.push(`Ignored non-string item at ${key}[${i}].`);
    }
    if (clean.length >= maxItems) break;
  }
  return clean;
}

/**
 * Dedicated runtime validator and normalizer for StructuredAIAuditOutput.
 * Guards every consumed field against malformed, missing, null, or type-mismatched AI responses.
 */
export function validateAndNormalizeAIAuditOutput(raw: unknown): AIValidationResult {
  if (!isPlainRecord(raw)) {
    return {
      valid: false,
      output: null,
      issues: ['AI output must be a non-null JSON object.']
    };
  }

  const issues: string[] = [];
  const fatalContainerErrors: string[] = [];
  const recognizedKeys = [
    'verifiedEvidence',
    'teamClaims',
    'missingEvidence',
    'technicalObservations',
    'potentialRisks',
    'suggestedQuestions',
    'inspectedSources',
    'uninspectedSources',
    'requirementEvaluations',
    'criterionObservations',
    'contradictedClaims',
    'securityFindings',
    'overallConfidence',
    'confidenceReason'
  ];

  const hasAnyRecognizedKey = recognizedKeys.some((k) => k in raw && raw[k] !== undefined);
  if (!hasAnyRecognizedKey) {
    return {
      valid: false,
      output: null,
      issues: ['AI output contains no recognized evidence audit fields.']
    };
  }

  const normalized: StructuredAIAuditOutput = {};

  const verifiedEvidence = readSafeStringArray(raw, 'verifiedEvidence', 24, issues, fatalContainerErrors);
  if (verifiedEvidence !== undefined) normalized.verifiedEvidence = verifiedEvidence;

  const teamClaims = readSafeStringArray(raw, 'teamClaims', 24, issues, fatalContainerErrors);
  if (teamClaims !== undefined) normalized.teamClaims = teamClaims;

  const missingEvidence = readSafeStringArray(raw, 'missingEvidence', 24, issues, fatalContainerErrors);
  if (missingEvidence !== undefined) normalized.missingEvidence = missingEvidence;

  const technicalObservations = readSafeStringArray(raw, 'technicalObservations', 24, issues, fatalContainerErrors);
  if (technicalObservations !== undefined) normalized.technicalObservations = technicalObservations;

  const potentialRisks = readSafeStringArray(raw, 'potentialRisks', 24, issues, fatalContainerErrors);
  if (potentialRisks !== undefined) normalized.potentialRisks = potentialRisks;

  const suggestedQuestions = readSafeStringArray(raw, 'suggestedQuestions', 24, issues, fatalContainerErrors);
  if (suggestedQuestions !== undefined) normalized.suggestedQuestions = suggestedQuestions;

  const inspectedSources = readSafeStringArray(raw, 'inspectedSources', 48, issues, fatalContainerErrors);
  if (inspectedSources !== undefined) normalized.inspectedSources = inspectedSources;

  const uninspectedSources = readSafeStringArray(raw, 'uninspectedSources', 48, issues, fatalContainerErrors);
  if (uninspectedSources !== undefined) normalized.uninspectedSources = uninspectedSources;

  if ('requirementEvaluations' in raw && raw.requirementEvaluations !== undefined) {
    if (!Array.isArray(raw.requirementEvaluations)) {
      const msg = 'Field "requirementEvaluations" must be an array.';
      issues.push(msg);
      fatalContainerErrors.push(msg);
    } else {
      const list: NonNullable<StructuredAIAuditOutput['requirementEvaluations']> = [];
      for (let i = 0; i < raw.requirementEvaluations.length; i++) {
        const entry = raw.requirementEvaluations[i];
        if (!isPlainRecord(entry)) {
          issues.push(`Ignored malformed requirementEvaluations[${i}] entry.`);
          continue;
        }
        const requirementId =
          typeof entry.requirementId === 'string' ? entry.requirementId.trim() : undefined;
        if (!requirementId) {
          issues.push(`Ignored requirementEvaluations[${i}] missing string requirementId.`);
          continue;
        }
        let safeStatus: VerificationStatus = 'UNVERIFIED';
        if (typeof entry.status === 'string') {
          if ((VALID_VERIFICATION_STATUSES as readonly string[]).includes(entry.status)) {
            safeStatus = entry.status as VerificationStatus;
          } else {
            issues.push(`Normalized invalid requirementEvaluations[${i}].status to UNVERIFIED.`);
          }
        } else if (entry.status !== undefined) {
          issues.push(`Ignored non-string requirementEvaluations[${i}].status.`);
        }
        const evidenceCitations = readSafeStringArray(
          entry,
          'evidenceCitations',
          12,
          issues,
          fatalContainerErrors
        );
        const summary =
          typeof entry.summary === 'string'
            ? redactSecrets(entry.summary.trim()).sanitized
            : entry.summary === undefined
              ? undefined
              : (issues.push(`Ignored non-string requirementEvaluations[${i}].summary.`), undefined);
        const limitations =
          typeof entry.limitations === 'string'
            ? redactSecrets(entry.limitations.trim()).sanitized
            : entry.limitations === undefined
              ? undefined
              : (issues.push(`Ignored non-string requirementEvaluations[${i}].limitations.`), undefined);

        list.push({
          requirementId,
          status: safeStatus,
          ...(evidenceCitations ? { evidenceCitations } : {}),
          ...(summary !== undefined ? { summary } : {}),
          ...(limitations !== undefined ? { limitations } : {})
        });
      }
      normalized.requirementEvaluations = list;
    }
  }

  if ('criterionObservations' in raw && raw.criterionObservations !== undefined) {
    if (!Array.isArray(raw.criterionObservations)) {
      const msg = 'Field "criterionObservations" must be an array.';
      issues.push(msg);
      fatalContainerErrors.push(msg);
    } else {
      const list: NonNullable<StructuredAIAuditOutput['criterionObservations']> = [];
      for (let i = 0; i < raw.criterionObservations.length; i++) {
        const entry = raw.criterionObservations[i];
        if (!isPlainRecord(entry)) {
          issues.push(`Ignored malformed criterionObservations[${i}] entry.`);
          continue;
        }
        const criterionName =
          typeof entry.criterionName === 'string' ? redactSecrets(entry.criterionName.trim()).sanitized : undefined;
        if (!criterionName) {
          issues.push(`Ignored criterionObservations[${i}] missing string criterionName.`);
          continue;
        }
        const observations =
          readSafeStringArray(entry, 'observations', 12, issues, fatalContainerErrors) || [];
        const verifiedLinks =
          readSafeStringArray(entry, 'verifiedLinks', 12, issues, fatalContainerErrors) || [];
        const missingProof =
          readSafeStringArray(entry, 'missingProof', 12, issues, fatalContainerErrors) || [];
        list.push({ criterionName, observations, verifiedLinks, missingProof });
      }
      normalized.criterionObservations = list;
    }
  }

  if ('contradictedClaims' in raw && raw.contradictedClaims !== undefined) {
    if (!Array.isArray(raw.contradictedClaims)) {
      const msg = 'Field "contradictedClaims" must be an array.';
      issues.push(msg);
      fatalContainerErrors.push(msg);
    } else {
      const list: NonNullable<StructuredAIAuditOutput['contradictedClaims']> = [];
      for (let i = 0; i < raw.contradictedClaims.length; i++) {
        const entry = raw.contradictedClaims[i];
        if (!isPlainRecord(entry)) {
          issues.push(`Ignored malformed contradictedClaims[${i}] entry.`);
          continue;
        }
        const claim =
          typeof entry.claim === 'string' ? redactSecrets(entry.claim.trim()).sanitized : undefined;
        if (!claim) {
          issues.push(`Ignored contradictedClaims[${i}] missing string claim.`);
          continue;
        }
        const sourceLocation =
          typeof entry.sourceLocation === 'string'
            ? redactSecrets(entry.sourceLocation.trim()).sanitized
            : undefined;
        const reason =
          typeof entry.reason === 'string' ? redactSecrets(entry.reason.trim()).sanitized : undefined;
        list.push({
          claim,
          ...(sourceLocation !== undefined ? { sourceLocation } : {}),
          ...(reason !== undefined ? { reason } : {})
        });
      }
      normalized.contradictedClaims = list;
    }
  }

  if ('securityFindings' in raw && raw.securityFindings !== undefined) {
    if (!Array.isArray(raw.securityFindings)) {
      const msg = 'Field "securityFindings" must be an array.';
      issues.push(msg);
      fatalContainerErrors.push(msg);
    } else {
      const list: NonNullable<StructuredAIAuditOutput['securityFindings']> = [];
      for (let i = 0; i < raw.securityFindings.length; i++) {
        const entry = raw.securityFindings[i];
        if (!isPlainRecord(entry)) {
          issues.push(`Ignored malformed securityFindings[${i}] entry.`);
          continue;
        }
        const finding =
          typeof entry.finding === 'string' ? redactSecrets(entry.finding.trim()).sanitized : undefined;
        if (!finding) {
          issues.push(`Ignored securityFindings[${i}] missing string finding.`);
          continue;
        }
        let severity: 'high' | 'medium' | 'low' = 'medium';
        if (entry.severity === 'high' || entry.severity === 'medium' || entry.severity === 'low') {
          severity = entry.severity;
        } else if (entry.severity !== undefined) {
          issues.push(`Normalized invalid securityFindings[${i}].severity to medium.`);
        }
        const location =
          typeof entry.location === 'string' ? redactSecrets(entry.location.trim()).sanitized : undefined;
        const mitigation =
          typeof entry.mitigation === 'string'
            ? redactSecrets(entry.mitigation.trim()).sanitized
            : undefined;
        list.push({
          severity,
          finding,
          ...(location !== undefined ? { location } : {}),
          ...(mitigation !== undefined ? { mitigation } : {})
        });
      }
      normalized.securityFindings = list;
    }
  }

  if ('overallConfidence' in raw && raw.overallConfidence !== undefined) {
    if (
      raw.overallConfidence === 'HIGH' ||
      raw.overallConfidence === 'MEDIUM' ||
      raw.overallConfidence === 'LOW'
    ) {
      normalized.overallConfidence = raw.overallConfidence;
    } else {
      issues.push('Ignored invalid overallConfidence enum value.');
    }
  }

  if ('confidenceReason' in raw && raw.confidenceReason !== undefined) {
    if (typeof raw.confidenceReason === 'string') {
      normalized.confidenceReason = redactSecrets(raw.confidenceReason.trim()).sanitized;
    } else {
      issues.push('Ignored non-string confidenceReason.');
    }
  }

  if (fatalContainerErrors.length > 0) {
    return {
      valid: false,
      output: null,
      issues
    };
  }

  return {
    valid: true,
    output: normalized,
    issues
  };
}

const MERGE_STATUS_PRECEDENCE: Record<VerificationStatus, number> = {
  CONTRADICTED: 7,
  TEST_CONFIRMED: 6,
  RUNTIME_CONFIRMED: 5,
  PRODUCTION_CONFIRMED: 4,
  CODE_CONFIRMED: 3,
  BLOCKED: 2,
  NOT_APPLICABLE: 1,
  UNVERIFIED: 0
};

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2
};

/**
 * Merges multiple schema-validated batch AI audit outputs deterministically without inflating confidence.
 */
export function mergeValidatedAIAuditOutputs(
  rawOutputs: unknown[]
): {
  merged: StructuredAIAuditOutput | null;
  validationIssues: string[];
  validBatchCount: number;
} {
  const validOutputs: StructuredAIAuditOutput[] = [];
  const validationIssues: string[] = [];

  for (let idx = 0; idx < rawOutputs.length; idx++) {
    const res = validateAndNormalizeAIAuditOutput(rawOutputs[idx]);
    for (const issue of res.issues) {
      validationIssues.push(`Batch ${idx + 1}: ${issue}`);
    }
    if (res.valid && res.output) {
      validOutputs.push(res.output);
    }
  }

  if (validOutputs.length === 0) {
    return { merged: null, validationIssues, validBatchCount: 0 };
  }

  const dedupPush = (target: string[], items: string[] | undefined, cap: number) => {
    for (const item of items || []) {
      const cleaned = redactSecrets(item.trim()).sanitized;
      if (cleaned && !target.includes(cleaned) && target.length < cap) {
        target.push(cleaned);
      }
    }
  };

  const verifiedEvidence: string[] = [];
  const teamClaims: string[] = [];
  const missingEvidence: string[] = [];
  const technicalObservations: string[] = [];
  const potentialRisks: string[] = [];
  const suggestedQuestions: string[] = [];
  const inspectedSources: string[] = [];
  const uninspectedSources: string[] = [];

  const reqMap = new Map<
    string,
    {
      requirementId: string;
      status: VerificationStatus;
      evidenceCitations: string[];
      summaries: string[];
      limitations: string[];
    }
  >();

  const critMap = new Map<
    string,
    {
      criterionName: string;
      observations: string[];
      verifiedLinks: string[];
      missingProof: string[];
    }
  >();

  const contradictedClaims: NonNullable<StructuredAIAuditOutput['contradictedClaims']> = [];
  const seenContradictions = new Set<string>();
  const securityFindings: NonNullable<StructuredAIAuditOutput['securityFindings']> = [];
  const seenSecurity = new Set<string>();

  let lowestConfidence: ConfidenceLevel | undefined;
  const confidenceReasons: string[] = [];

  for (const out of validOutputs) {
    dedupPush(verifiedEvidence, out.verifiedEvidence, 32);
    dedupPush(teamClaims, out.teamClaims, 24);
    dedupPush(missingEvidence, out.missingEvidence, 24);
    dedupPush(technicalObservations, out.technicalObservations, 32);
    dedupPush(potentialRisks, out.potentialRisks, 24);
    dedupPush(suggestedQuestions, out.suggestedQuestions, 24);
    dedupPush(inspectedSources, out.inspectedSources, 96);
    dedupPush(uninspectedSources, out.uninspectedSources, 96);

    for (const req of out.requirementEvaluations || []) {
      if (!req.requirementId) continue;
      const existing = reqMap.get(req.requirementId) || {
        requirementId: req.requirementId,
        status: 'UNVERIFIED' as VerificationStatus,
        evidenceCitations: [] as string[],
        summaries: [] as string[],
        limitations: [] as string[]
      };
      const candidateStatus = normalizeVerificationStatus(req.status);
      if (MERGE_STATUS_PRECEDENCE[candidateStatus] > MERGE_STATUS_PRECEDENCE[existing.status]) {
        existing.status = candidateStatus;
      }
      dedupPush(existing.evidenceCitations, req.evidenceCitations, 16);
      if (req.summary) dedupPush(existing.summaries, [req.summary], 4);
      if (req.limitations) dedupPush(existing.limitations, [req.limitations], 4);
      reqMap.set(req.requirementId, existing);
    }

    for (const crit of out.criterionObservations || []) {
      if (!crit.criterionName) continue;
      const key = crit.criterionName.toLowerCase();
      const existing = critMap.get(key) || {
        criterionName: crit.criterionName,
        observations: [] as string[],
        verifiedLinks: [] as string[],
        missingProof: [] as string[]
      };
      dedupPush(existing.observations, crit.observations, 12);
      dedupPush(existing.verifiedLinks, crit.verifiedLinks, 12);
      dedupPush(existing.missingProof, crit.missingProof, 12);
      critMap.set(key, existing);
    }

    for (const cc of out.contradictedClaims || []) {
      if (!cc.claim) continue;
      const dedupKey = `${cc.claim.toLowerCase()}::${(cc.sourceLocation || '').toLowerCase()}`;
      if (!seenContradictions.has(dedupKey) && contradictedClaims.length < 24) {
        seenContradictions.add(dedupKey);
        contradictedClaims.push(cc);
      }
    }

    for (const sf of out.securityFindings || []) {
      if (!sf.finding) continue;
      const dedupKey = `${sf.finding.toLowerCase()}::${(sf.location || '').toLowerCase()}`;
      if (!seenSecurity.has(dedupKey) && securityFindings.length < 24) {
        seenSecurity.add(dedupKey);
        securityFindings.push(sf);
      }
    }

    if (out.overallConfidence) {
      if (
        !lowestConfidence ||
        CONFIDENCE_RANK[out.overallConfidence] < CONFIDENCE_RANK[lowestConfidence]
      ) {
        lowestConfidence = out.overallConfidence;
      }
    }
    if (out.confidenceReason) {
      dedupPush(confidenceReasons, [out.confidenceReason], 4);
    }
  }

  return {
    validBatchCount: validOutputs.length,
    validationIssues,
    merged: {
      verifiedEvidence,
      teamClaims,
      missingEvidence,
      technicalObservations,
      potentialRisks,
      suggestedQuestions,
      inspectedSources,
      uninspectedSources,
      requirementEvaluations: Array.from(reqMap.values()).map((r) => ({
        requirementId: r.requirementId,
        status: r.status,
        ...(r.evidenceCitations.length > 0 ? { evidenceCitations: r.evidenceCitations } : {}),
        ...(r.summaries.length > 0 ? { summary: r.summaries.join(' ') } : {}),
        ...(r.limitations.length > 0 ? { limitations: r.limitations.join(' ') } : {})
      })),
      criterionObservations: Array.from(critMap.values()),
      contradictedClaims,
      securityFindings,
      ...(lowestConfidence ? { overallConfidence: lowestConfidence } : {}),
      ...(confidenceReasons.length > 0 ? { confidenceReason: confidenceReasons[0] } : {})
    }
  };
}

export function capStatusByEvidence(
  proposed: VerificationStatus | string | undefined,
  opts: {
    hasInspectedFiles: boolean;
    hasPassingExecutedTest: boolean;
    hasRuntimeConfirmation: boolean;
    hasMatchedCodeEvidence?: boolean;
  }
): VerificationStatus {
  // Missing or undefined AI status MUST default to UNVERIFIED, never CODE_CONFIRMED
  if (proposed === undefined) {
    return 'UNVERIFIED';
  }
  const normalized = normalizeVerificationStatus(proposed);
  if (
    normalized === 'UNVERIFIED' ||
    normalized === 'CONTRADICTED' ||
    normalized === 'BLOCKED' ||
    normalized === 'NOT_APPLICABLE'
  ) {
    return normalized;
  }
  const hasCodeProof =
    opts.hasInspectedFiles &&
    (opts.hasMatchedCodeEvidence === undefined ? true : opts.hasMatchedCodeEvidence);
  if (!hasCodeProof) {
    return 'UNVERIFIED';
  }
  if (normalized === 'PRODUCTION_CONFIRMED') {
    return opts.hasRuntimeConfirmation ? 'RUNTIME_CONFIRMED' : 'CODE_CONFIRMED';
  }
  if (normalized === 'TEST_CONFIRMED' && !opts.hasPassingExecutedTest) {
    return 'CODE_CONFIRMED';
  }
  if (normalized === 'RUNTIME_CONFIRMED' && !opts.hasRuntimeConfirmation) {
    return 'CODE_CONFIRMED';
  }
  return normalized;
}

const CITATION_TOKEN_PATTERN = /\[([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?::L?(\d+)(?:-L?(\d+))?)?\]/g;
const RAW_PATH_LINE_PATTERN = /^([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?::L?(\d+)(?:-L?(\d+))?)?$/;

function isCitationReferenceValid(
  rawRef: string,
  inspectedMap: Map<string, InspectedRepoFile>
): { valid: boolean; reason?: string; cleanPath?: string; startLine?: number; endLine?: number } {
  const trimmed = rawRef.trim().replace(/^\[|\]$/g, '');
  const match = trimmed.match(RAW_PATH_LINE_PATTERN);
  if (!match) {
    return { valid: false, reason: `Malformed citation "${rawRef}"` };
  }
  const [, rawPath, startStr, endStr] = match;
  const path = normalizeRepoPath(rawPath);
  const file = inspectedMap.get(path);
  if (!file) {
    return { valid: false, reason: `File "${path}" not in inspectedFiles`, cleanPath: path };
  }
  if (startStr) {
    const startLine = Number(startStr);
    const endLine = endStr ? Number(endStr) : startLine;
    const maxLine = Math.max(1, file.totalLines || 1);
    if (
      !Number.isInteger(startLine) ||
      !Number.isInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine ||
      endLine > maxLine
    ) {
      return {
        valid: false,
        reason: `Line range L${startLine}-L${endLine} out of bounds for ${path} (totalLines=${maxLine})`,
        cleanPath: path
      };
    }
    if (file.truncated) {
      const chunks = file.chunks || [];
      const insideInspectedChunk = chunks.some(
        (c) => startLine >= c.startLine && endLine <= c.endLine
      );
      if (!insideInspectedChunk) {
        return {
          valid: false,
          reason: `Line range L${startLine}-L${endLine} in truncated file ${path} falls outside inspected chunk intervals`,
          cleanPath: path
        };
      }
    }
    return { valid: true, cleanPath: path, startLine, endLine };
  }
  if (file.truncated) {
    return {
      valid: false,
      reason: `Citation for chunked/truncated file "${path}" requires an explicit inspected line range (:Lstart-Lend)`,
      cleanPath: path
    };
  }
  return { valid: true, cleanPath: path };
}

interface ValidatedCitationDetail {
  path: string;
  startLine?: number;
  endLine?: number;
}

function sanitizeAndValidateAITextItem(
  raw: string,
  inspectedMap: Map<string, InspectedRepoFile>,
  rejectedCitations: string[]
): {
  sanitizedText: string;
  hasValidCitation: boolean;
  hasInvalidCitation: boolean;
  validCitations: ValidatedCitationDetail[];
} {
  const { sanitized } = redactSecrets(raw);
  let hasValidCitation = false;
  let hasInvalidCitation = false;
  const validCitations: ValidatedCitationDetail[] = [];

  const validated = sanitized.replace(CITATION_TOKEN_PATTERN, (full, path: string, s?: string, e?: string) => {
    const ref = s ? `${path}:L${s}${e ? `-L${e}` : ''}` : path;
    const check = isCitationReferenceValid(ref, inspectedMap);
    if (check.valid && check.cleanPath) {
      hasValidCitation = true;
      validCitations.push({
        path: check.cleanPath,
        ...(check.startLine !== undefined ? { startLine: check.startLine } : {}),
        ...(check.endLine !== undefined ? { endLine: check.endLine } : {})
      });
      return full;
    }
    hasInvalidCitation = true;
    rejectedCitations.push(check.reason || full);
    return `[UNVERIFIED_CITATION:${ref}]`;
  });

  return { sanitizedText: validated, hasValidCitation, hasInvalidCitation, validCitations };
}

const TECH_EXTENSION_MAP: Record<string, RegExp> = {
  typescript: /\.(ts|tsx)$/i,
  javascript: /\.(js|jsx|mjs|cjs)$/i,
  python: /\.py$/i,
  go: /\.go$/i,
  golang: /\.go$/i,
  rust: /\.rs$/i,
  java: /\.java$/i,
  ruby: /\.rb$/i
};

function hasTechEvidenceInFile(tech: string, file: InspectedRepoFile): boolean {
  const trimmed = tech.trim();
  if (!trimmed) return false;
  const lowerTech = trimmed.toLowerCase();
  const extPattern = TECH_EXTENSION_MAP[lowerTech];
  if (extPattern && extPattern.test(file.path)) {
    return true;
  }

  const escaped = lowerTech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startsAlnum = /^[a-z0-9]/.test(lowerTech);
  const endsAlnum = /[a-z0-9]$/.test(lowerTech);

  // Strict non-alphanumeric boundaries prevent short substring false positives (e.g., "go" inside "mongodb")
  const strictPattern = new RegExp(
    `${startsAlnum ? '(?:^|[^a-z0-9])' : ''}${escaped}${endsAlnum ? '(?=[^a-z0-9]|$)' : '(?![a-z0-9])'}`,
    'i'
  );
  if (strictPattern.test(file.path) || strictPattern.test(file.excerpt)) {
    return true;
  }

  // For multi-character named frameworks/SDKs (>= 5 chars, e.g. PayPal, Supabase, Gemini), allow camelCase segments strictly without partial-word matches
  if (lowerTech.length >= 5 && /^[a-z0-9]+$/.test(lowerTech)) {
    const ciTokens = Array.from(lowerTech).map((ch) =>
      ch >= 'a' && ch <= 'z' ? `[${ch}${ch.toUpperCase()}]` : ch
    );
    const ciTech = ciTokens.join('');
    const firstUpper =
      lowerTech[0] >= 'a' && lowerTech[0] <= 'z' ? lowerTech[0].toUpperCase() : lowerTech[0];
    const ciRest = ciTokens.slice(1).join('');
    const camelRegex = new RegExp(
      `(?:(?:^|[^a-zA-Z0-9])${ciTech}|[a-z0-9]${firstUpper}${ciRest})(?=[A-Z]|[^a-zA-Z0-9]|$)`
    );
    if (camelRegex.test(file.path) || camelRegex.test(file.excerpt)) {
      return true;
    }
  }

  return false;
}

function buildRequirementSearchPattern(
  req: HackathonRequirementItem,
  hackathon?: Partial<Hackathon> | null
): RegExp | undefined {
  const text = `${req.title} ${req.exactWording}`.toLowerCase();
  const tokens: string[] = [];
  if (/(payment|paypal|stripe|invoice|billing|checkout|settlement)/.test(text)) {
    tokens.push('paypal', 'stripe', 'webhook', 'capture', 'order', 'payment', 'idempoten');
  }
  if (/(security|auth|rbac|jwt|oauth|rls|privacy|secret)/.test(text)) {
    tokens.push('verify', 'auth', 'jwt', 'policy', 'ROW LEVEL SECURITY', 'guard', 'redact');
  }
  if (/(test|quality|reliability|coverage)/.test(text)) {
    tokens.push('describe\\(', 'it\\(', 'test\\(', 'expect\\(');
  }
  if (/(ai|gemini|genai|llm|model|data|insight|qloo)/.test(text)) {
    tokens.push('GoogleGenAI', 'generateContent', 'qloo', 'gemini', 'prompt');
  }
  if (req.kind === 'mandatory_technology') {
    for (const tech of hackathon?.technologies || []) {
      const escaped = tech.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (escaped.length >= 2) tokens.push(escaped);
    }
  }
  const genericWords = text
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !['which', 'there', 'their', 'about', 'against', 'should', 'require', 'based'].includes(w))
    .slice(0, 6);
  for (const w of genericWords) {
    tokens.push(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  const unique = Array.from(new Set(tokens)).filter(Boolean);
  if (unique.length === 0) return undefined;
  return new RegExp(`(${unique.join('|')})`, 'i');
}

function detectTestFrameworksAndCommands(
  repo: GitHubRepoInspection,
  discoveredTestFiles: string[]
): { frameworks: string[]; commands: string[] } {
  const frameworks = new Set<string>();
  const commands = new Set<string>();

  for (const tf of discoveredTestFiles) {
    const lower = tf.toLowerCase();
    if (/vitest\.config\./.test(lower)) frameworks.add('vitest');
    if (/jest\.config\./.test(lower)) frameworks.add('jest');
    if (/playwright\.config\./.test(lower)) frameworks.add('playwright');
    if (/pytest\.ini$/.test(lower) || /(^|\/)test_[^/]+\.py$/.test(lower)) frameworks.add('pytest');
    if (/_test\.go$/.test(lower)) frameworks.add('go test');
  }

  for (const file of repo.inspectedFiles) {
    const base = (file.path.split('/').pop() || file.path).toLowerCase();
    if (base === 'package.json') {
      try {
        const parsed = JSON.parse(file.excerpt) as {
          scripts?: Record<string, string>;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const allDeps = {
          ...(parsed.dependencies || {}),
          ...(parsed.devDependencies || {})
        };
        for (const fw of ['vitest', 'jest', 'mocha', 'playwright', 'cypress', '@testing-library/react']) {
          if (fw in allDeps) frameworks.add(fw);
        }
        for (const [scriptName, scriptCmd] of Object.entries(parsed.scripts || {})) {
          if (/test|e2e|spec/i.test(scriptName) && typeof scriptCmd === 'string' && scriptCmd.trim()) {
            commands.add(`npm run ${scriptName} (${scriptCmd.trim()})`);
          }
        }
      } catch {
        const fwMatch = file.excerpt.match(/\b(vitest|jest|mocha|playwright|cypress)\b/gi) || [];
        for (const fw of fwMatch) frameworks.add(fw.toLowerCase());
      }
    } else if (base === 'pyproject.toml' || base === 'pytest.ini') {
      if (/pytest/i.test(file.excerpt)) frameworks.add('pytest');
    } else if (base === 'go.mod') {
      frameworks.add('go test');
    } else if (base === 'cargo.toml') {
      frameworks.add('cargo test');
    }
  }

  return {
    frameworks: Array.from(frameworks),
    commands: Array.from(commands)
  };
}

export function buildComprehensiveJudgingReport(params: {
  submission: Partial<ProjectSubmission>;
  hackathon: Partial<Hackathon> | null | undefined;
  repoInspection: GitHubRepoInspection;
  liveDemoCheck: LiveDemoCheckResult;
  executedTests?: ExecutedTestRecord[];
  aiOutput?: StructuredAIAuditOutput | null;
  expectedCommitSha?: string | null;
  batchAnalysisState?: {
    interrupted?: boolean;
    batchesCompleted?: number;
    batchesPendingCount?: number;
    batchesInterruptedCount?: number;
    batchesTotal?: number;
    filesSelectedCount?: number;
    filesFetchedCount?: number;
    incompleteReason?: string;
    auditStatus?: AuditExecutionStatus;
    auditStatusReason?: string;
    resumable?: boolean;
    ciCheckNote?: string;
  };
}): ComprehensiveJudgingReport {
  const generatedAt = new Date().toISOString();
  const { submission, hackathon, repoInspection, liveDemoCheck } = params;

  const aiValidationIssues: string[] = [];
  let aiOutput: StructuredAIAuditOutput | null = null;
  let aiValidationFailed = false;
  if (params.aiOutput !== undefined && params.aiOutput !== null) {
    const validation = validateAndNormalizeAIAuditOutput(params.aiOutput);
    aiValidationIssues.push(...validation.issues);
    if (validation.valid && validation.output) {
      aiOutput = validation.output;
    } else {
      aiValidationFailed = true;
    }
  }

  const strategies = detectProjectStrategies(submission, repoInspection);
  const requirementsBundle = extractHackathonRequirements(hackathon, submission);
  const eligibility = evaluateEligibilityChecks({
    bundle: requirementsBundle,
    hackathon,
    submission,
    observedAt: generatedAt
  });

  const discoveredTestFiles = repoInspection.inspectedFiles
    .filter((f) => f.category === 'tests')
    .map((f) => normalizeRepoPath(f.path));

  for (const inv of repoInspection.fileInventory) {
    const normPath = normalizeRepoPath(inv.path);
    if (inv.category === 'tests' && !discoveredTestFiles.includes(normPath)) {
      discoveredTestFiles.push(normPath);
    }
  }

  const { frameworks: detectedTestFrameworks, commands: detectedTestCommands } =
    detectTestFrameworksAndCommands(repoInspection, discoveredTestFiles);

  const executedTests = params.executedTests || [];
  const hasPassingExecutedTest = executedTests.some((t) => t.status === 'TEST_CONFIRMED');
  const hasFailingExecutedTest = executedTests.some((t) => t.status === 'CONTRADICTED');

  let testSummaryStatus: VerificationStatus;
  let testHonestyNote: string;
  if (hasFailingExecutedTest) {
    testSummaryStatus = 'CONTRADICTED';
    testHonestyNote =
      'One or more attached test/CI execution records failed or reported non-zero exit status.';
  } else if (hasPassingExecutedTest) {
    testSummaryStatus = 'TEST_CONFIRMED';
    testHonestyNote =
      'Verified passing execution output from attached test/CI record(s).';
  } else if (discoveredTestFiles.length > 0) {
    // Test file presence in static code without verified executed test output MUST remain UNVERIFIED (never CODE_CONFIRMED / TEST_CONFIRMED).
    testSummaryStatus = 'UNVERIFIED';
    testHonestyNote = `Discovered ${discoveredTestFiles.length} test file(s) in repository code, but NO executed test command output was confirmed for this commit (executedTests = ${executedTests.length}). Test file presence does NOT prove passing tests.`;
  } else {
    testSummaryStatus = 'UNVERIFIED';
    testHonestyNote = 'No automated test files or verified executed test run logs were found.';
  }

  const ciCheckNote = params.batchAnalysisState?.ciCheckNote?.trim();
  if (ciCheckNote && !testHonestyNote.includes(ciCheckNote)) {
    testHonestyNote = `${testHonestyNote} (${ciCheckNote})`;
  }

  const domainAudit = auditProjectDomainImplementation(repoInspection, strategies, generatedAt);

  // Build strict inspectedFile map using normalized paths and validate + redact all AI outputs
  const inspectedFileMap = new Map(
    repoInspection.inspectedFiles.map((f) => [normalizeRepoPath(f.path), f])
  );
  const rejectedAiCitations: string[] = [];

  for (const src of aiOutput?.inspectedSources || []) {
    const cleanedSrc = normalizeRepoPath(redactSecrets(src).sanitized);
    if (!cleanedSrc) continue;
    if (!inspectedFileMap.has(cleanedSrc)) {
      rejectedAiCitations.push(`inspectedSources path "${cleanedSrc}" not in inspectedFiles`);
    }
  }

  // Strictly require BOTH res.hasValidCitation && !res.hasInvalidCitation for verifiedEvidence
  const sanitizedAiVerifiedEvidence: string[] = [];
  for (const item of aiOutput?.verifiedEvidence || []) {
    const res = sanitizeAndValidateAITextItem(item, inspectedFileMap, rejectedAiCitations);
    if (!res.hasValidCitation && !res.hasInvalidCitation) {
      rejectedAiCitations.push(
        `Rejected uncited verifiedEvidence statement without [path:Lstart-Lend]: "${res.sanitizedText.slice(0, 80)}"`
      );
      continue;
    }
    if (
      res.hasValidCitation &&
      !res.hasInvalidCitation &&
      repoInspection.accessible &&
      repoInspection.inspectedFiles.length > 0
    ) {
      sanitizedAiVerifiedEvidence.push(res.sanitizedText);
    }
  }

  const sanitizedAiTechObs = (aiOutput?.technicalObservations || []).map(
    (item) => sanitizeAndValidateAITextItem(item, inspectedFileMap, rejectedAiCitations).sanitizedText
  );
  const sanitizedAiTeamClaims = (aiOutput?.teamClaims || []).map((item) => redactSecrets(item).sanitized);
  const sanitizedAiMissingEvidence = (aiOutput?.missingEvidence || []).map((item) => redactSecrets(item).sanitized);
  const sanitizedAiPotentialRisks = (aiOutput?.potentialRisks || []).map(
    (item) => sanitizeAndValidateAITextItem(item, inspectedFileMap, rejectedAiCitations).sanitizedText
  );
  const sanitizedAiQuestions = (aiOutput?.suggestedQuestions || []).map((item) => redactSecrets(item).sanitized);

  const matrixRows: VerificationMatrixRow[] = [];
  const allRequirements = [
    ...requirementsBundle.mandatoryRequirements,
    ...requirementsBundle.scoredCriteria
  ];

  const aiReqMap = new Map(
    (aiOutput?.requirementEvaluations || [])
      .filter((r) => r.requirementId)
      .map((r) => [r.requirementId as string, r])
  );

  for (const req of allRequirements) {
    const matchingElig = eligibility.checks.find(
      (c) =>
        (req.id === 'max_team_size' && c.id === 'check_team_size') ||
        (req.id === 'track_alignment' && c.id === 'check_track') ||
        (req.id === 'submission_deadline' && c.id === 'check_deadline')
    );

    const reqPattern = buildRequirementSearchPattern(req, hackathon);

    const relevantInspected = repoInspection.inspectedFiles
      .filter((f) => {
        if (req.kind === 'mandatory_technology') {
          return true;
        }
        if (req.kind === 'scored_rubric') {
          const lowerTitle = req.title.toLowerCase();
          if (/(security|auth|payment|technical|architecture|implementation)/.test(lowerTitle)) {
            return f.category !== 'readme';
          }
          return true;
        }
        return f.category !== 'frontend_source';
      })
      .sort((a, b) => {
        const aHit = reqPattern ? (findLineRangeForPattern(a, reqPattern).matched ? 1 : 0) : 0;
        const bHit = reqPattern ? (findLineRangeForPattern(b, reqPattern).matched ? 1 : 0) : 0;
        return bHit - aHit;
      });

    const matchedRepoFiles = reqPattern
      ? relevantInspected.filter((f) => findLineRangeForPattern(f, reqPattern).matched)
      : [];
    const matchedRepoCitations: FileCitation[] = matchedRepoFiles
      .slice(0, 4)
      .map((f) => makeCitation(repoInspection, f, reqPattern));

    const aiMatch = aiReqMap.get(req.id);

    // Validate EVERY AI requirement citation strictly; never clear aiHadInvalidCitation when validCount > 0
    let aiHadInvalidCitation = false;
    const validAiCitations: FileCitation[] = [];
    const invalidAiReasons: string[] = [];
    if (aiMatch?.evidenceCitations && aiMatch.evidenceCitations.length > 0) {
      for (const cit of aiMatch.evidenceCitations) {
        const cleanedCit = redactSecrets(cit).sanitized;
        const check = isCitationReferenceValid(cleanedCit, inspectedFileMap);
        if (check.valid && check.cleanPath) {
          const ref = repoInspection.commitSha || repoInspection.defaultBranch || 'main';
          validAiCitations.push({
            path: check.cleanPath,
            ...(check.startLine !== undefined ? { startLine: check.startLine } : {}),
            ...(check.endLine !== undefined ? { endLine: check.endLine } : {}),
            ...(repoInspection.repoFullName
              ? {
                  blobUrl: buildGitHubBlobUrl(
                    repoInspection.repoFullName,
                    ref,
                    check.cleanPath,
                    check.startLine,
                    check.endLine
                  )
                }
              : {})
          });
        } else {
          aiHadInvalidCitation = true;
          const reason = check.reason || cit;
          invalidAiReasons.push(reason);
          rejectedAiCitations.push(reason);
        }
      }
    }

    // Combine deterministic matched citations + valid AI citations (deduped by path + lines)
    const combinedCitations: FileCitation[] = [];
    const seenCiteKeys = new Set<string>();
    for (const c of [...validAiCitations, ...matchedRepoCitations]) {
      const key = `${c.path}:${c.startLine ?? ''}-${c.endLine ?? ''}`;
      if (!seenCiteKeys.has(key)) {
        seenCiteKeys.add(key);
        combinedCitations.push(c);
      }
    }
    const citations: FileCitation[] = combinedCitations.slice(0, 4);

    const staticEvidence: string[] = [];
    let techAllPresentInCode = false;
    if (matchingElig) {
      staticEvidence.push(matchingElig.observedResult);
    } else if (req.kind === 'mandatory_technology') {
      const requiredTechs = (hackathon?.technologies || []).map((t) => t.trim()).filter(Boolean);
      const matchedTechs: string[] = [];
      const missingTechs: string[] = [];
      for (const tech of requiredTechs) {
        const foundInFile = repoInspection.inspectedFiles.find((f) =>
          hasTechEvidenceInFile(tech, f)
        );
        if (foundInFile) {
          matchedTechs.push(`${tech} (${foundInFile.path})`);
        } else {
          missingTechs.push(tech);
        }
      }
      techAllPresentInCode =
        repoInspection.accessible &&
        repoInspection.inspectedFiles.length > 0 &&
        requiredTechs.length > 0 &&
        missingTechs.length === 0;
      if (matchedTechs.length > 0) {
        staticEvidence.push(`Inspected code/manifests reference: ${matchedTechs.join(', ')}.`);
      }
      if (missingTechs.length > 0) {
        staticEvidence.push(
          `Not observed in inspected repository source/manifests: ${missingTechs.join(', ')} (submission metadata tags alone do NOT count as code proof).`
        );
      }
    } else if (aiHadInvalidCitation) {
      staticEvidence.push(
        `AI status downgraded to UNVERIFIED because ${invalidAiReasons.length} citation(s) referenced uninspected/invalid files or line ranges (${invalidAiReasons.slice(0, 2).join('; ')}). Valid citations preserved where verified.`
      );
    } else if (aiMatch?.summary) {
      staticEvidence.push(
        sanitizeAndValidateAITextItem(aiMatch.summary, inspectedFileMap, rejectedAiCitations)
          .sanitizedText
      );
    } else if (matchedRepoCitations.length > 0) {
      staticEvidence.push(
        `Matched inspected source files: ${matchedRepoCitations.map((c) => c.path).join(', ')}.`
      );
    }

    const executedTestEvidence = hasPassingExecutedTest
      ? executedTests.filter((t) => t.status === 'TEST_CONFIRMED').map((t) => `${t.command}: ${t.scope}`)
      : hasFailingExecutedTest
        ? executedTests.filter((t) => t.status === 'CONTRADICTED').map((t) => `${t.command} FAILED`)
        : [];

    const runtimeEvidence = liveDemoCheck.reachable
      ? [`${liveDemoCheck.demoUrl} responded HTTP ${liveDemoCheck.httpStatus} (reachability only)`]
      : [];

    let finalStatus: VerificationStatus;
    if (matchingElig) {
      // Deterministic metadata check cannot be overridden by AI
      finalStatus = matchingElig.status;
    } else if (req.kind === 'mandatory_technology') {
      // Mandatory technology verification MUST use actual inspected source/manifests with strict token boundaries
      finalStatus = techAllPresentInCode
        ? 'CODE_CONFIRMED'
        : repoInspection.accessible
          ? 'UNVERIFIED'
          : 'BLOCKED';
    } else if (
      req.kind === 'mandatory_eligibility' ||
      req.kind === 'prohibited_practice' ||
      req.kind === 'mandatory_submission' ||
      req.kind === 'mandatory_track'
    ) {
      // Textual eligibility/prohibited-practice/procedural submission & unmapped track rules cannot become CODE_CONFIRMED solely from inspected source presence
      if (!repoInspection.accessible && req.mandatory) {
        finalStatus = 'BLOCKED';
      } else if (
        !aiHadInvalidCitation &&
        aiMatch?.status === 'CONTRADICTED' &&
        validAiCitations.length > 0
      ) {
        finalStatus = 'CONTRADICTED';
      } else {
        finalStatus = 'UNVERIFIED';
      }
    } else {
      const hasMatchedCodeEvidence =
        validAiCitations.length > 0 || matchedRepoCitations.length > 0;
      const aiProposedStatus = aiHadInvalidCitation ? 'UNVERIFIED' : aiMatch?.status;
      finalStatus = capStatusByEvidence(aiProposedStatus, {
        hasInspectedFiles: repoInspection.accessible && repoInspection.inspectedFiles.length > 0,
        hasMatchedCodeEvidence,
        hasPassingExecutedTest,
        hasRuntimeConfirmation: false
      });
      if (!repoInspection.accessible && req.mandatory) {
        finalStatus = 'BLOCKED';
      }
    }

    matrixRows.push({
      requirementId: req.id,
      requirementTitle: req.title,
      exactWording: req.exactWording,
      sourceField: req.sourceField,
      mandatory: req.mandatory,
      ...(req.weight !== undefined ? { weight: req.weight } : {}),
      submissionClaim:
        req.kind === 'mandatory_track'
          ? submission.track || 'Not specified'
          : req.kind === 'mandatory_technology'
            ? (submission.technologies || []).join(', ') || 'Not specified'
            : submission.proposedSolution || submission.shortDescription || 'See submission text',
      relevantFiles: citations,
      staticCodeEvidence: staticEvidence,
      executedTestEvidence,
      runtimeEvidence,
      productionEvidence: [],
      finalStatus,
      confidence:
        finalStatus === 'CONTRADICTED' || (citations.length > 0 && finalStatus === 'CODE_CONFIRMED')
          ? 'MEDIUM'
          : 'LOW',
      missingProofOrAction:
        (aiHadInvalidCitation
          ? `Rejected invalid AI citation(s): ${invalidAiReasons.slice(0, 2).join('; ')}`
          : aiMatch?.limitations
            ? redactSecrets(aiMatch.limitations).sanitized
            : '') ||
        (finalStatus === 'TEST_CONFIRMED'
          ? 'End-to-end production telemetry not verified from browser audit.'
          : hasPassingExecutedTest
            ? 'Verify live demo flows manually.'
            : 'Requires executed test output and/or manual runtime check in live demo.')
    });
  }

  // Coverage stats (Section B) — strictly honest 5-state classification
  const fullyInspectedCount = repoInspection.fileInventory.filter(
    (f) => f.auditStatus === 'FULLY_INSPECTED' || f.inspectionStatus === 'inspected'
  ).length;
  const partiallyInspectedCount = repoInspection.fileInventory.filter(
    (f) => f.auditStatus === 'PARTIALLY_INSPECTED' || f.inspectionStatus === 'partially_inspected'
  ).length;
  const skippedCount = repoInspection.fileInventory.filter(
    (f) => f.auditStatus === 'SKIPPED' || f.inspectionStatus === 'skipped'
  ).length;
  const inaccessibleCount = repoInspection.fileInventory.filter(
    (f) => f.auditStatus === 'INACCESSIBLE' || f.inspectionStatus === 'inaccessible'
  ).length;
  const failedCount = repoInspection.fileInventory.filter(
    (f) => f.auditStatus === 'FAILED' || f.inspectionStatus === 'failed'
  ).length;

  const skippedNonTrivialCount = repoInspection.fileInventory.filter(
    (f) =>
      (f.auditStatus === 'SKIPPED' || f.inspectionStatus === 'skipped') &&
      f.reason !== 'binary_or_asset' &&
      f.reason !== 'non_code_documentation' &&
      f.reason !== 'duplicate_mirror'
  ).length;

  const skippedDueToBudgetOrInterruption = repoInspection.fileInventory.filter(
    (f) =>
      (f.auditStatus === 'SKIPPED' || f.inspectionStatus === 'skipped') &&
      f.reason !== 'binary_or_asset' &&
      f.reason !== 'non_code_documentation' &&
      f.reason !== 'sensitive_env_or_secret_file' &&
      f.reason !== 'duplicate_mirror'
  ).length;

  const importantNonSensitiveUninspected = repoInspection.uninspectedImportantFiles.filter(
    (u) => u.reason !== 'sensitive_env_or_secret_file'
  );

  const batchInterrupted = Boolean(params.batchAnalysisState?.interrupted);
  const batchesCompleted =
    params.batchAnalysisState?.batchesCompleted ?? repoInspection.batchesProcessed;
  const batchesTotal = params.batchAnalysisState?.batchesTotal ?? repoInspection.batchesProcessed;
  const batchesPendingCount =
    params.batchAnalysisState?.batchesPendingCount ?? Math.max(0, batchesTotal - batchesCompleted);
  const batchesInterruptedCount =
    params.batchAnalysisState?.batchesInterruptedCount ??
    (batchInterrupted && batchesPendingCount > 0 ? 1 : 0);
  const inspectedSourceFilesCount = repoInspection.inspectedFiles.length;
  const readmeInspected = Boolean(
    repoInspection.readmeExcerpt &&
      repoInspection.fileInventory.some(
        (f) =>
          f.category === 'readme' &&
          (f.auditStatus === 'FULLY_INSPECTED' ||
            f.auditStatus === 'PARTIALLY_INSPECTED' ||
            f.inspectionStatus === 'inspected' ||
            f.inspectionStatus === 'partially_inspected')
      )
  );
  const filesSelectedCount =
    params.batchAnalysisState?.filesSelectedCount ?? repoInspection.selectedFilesCount;
  const filesFetchedCount =
    params.batchAnalysisState?.filesFetchedCount ?? inspectedSourceFilesCount;

  const resolvedAuditStatus: AuditExecutionStatus =
    params.batchAnalysisState?.auditStatus ||
    (!repoInspection.accessible
      ? 'FAILED'
      : batchInterrupted && batchesCompleted > 0
        ? 'PARTIAL'
        : batchInterrupted
          ? 'INTERRUPTED'
          : 'COMPLETED');

  const resolvedAuditStatusReason =
    params.batchAnalysisState?.auditStatusReason ||
    (resolvedAuditStatus === 'COMPLETED'
      ? `Completed audit across ${batchesCompleted}/${Math.max(1, batchesTotal)} batch(es).`
      : resolvedAuditStatus === 'PARTIAL'
        ? `Partial audit: ${batchesCompleted}/${batchesTotal} batch(es) completed.${params.batchAnalysisState?.incompleteReason ? ` ${params.batchAnalysisState.incompleteReason}` : ''}`
        : resolvedAuditStatus === 'INTERRUPTED'
          ? `Audit interrupted at batch ${batchesCompleted}/${batchesTotal}.${params.batchAnalysisState?.incompleteReason ? ` ${params.batchAnalysisState.incompleteReason}` : ''}`
          : params.batchAnalysisState?.incompleteReason ||
            `Audit failed (${repoInspection.reason || 'repository or AI step failed'}).`);

  const resolvedResumable =
    params.batchAnalysisState?.resumable !== undefined
      ? params.batchAnalysisState.resumable
      : batchInterrupted && batchesTotal > 0 && batchesCompleted < batchesTotal;

  const expectedCommitShaTrimmed = params.expectedCommitSha?.trim() || null;
  const commitShaMismatch = Boolean(
    expectedCommitShaTrimmed &&
      repoInspection.commitSha &&
      expectedCommitShaTrimmed !== repoInspection.commitSha
  );

  const hasFullCoverage =
    repoInspection.accessible &&
    !batchInterrupted &&
    resolvedAuditStatus === 'COMPLETED' &&
    !repoInspection.treeTruncated &&
    partiallyInspectedCount === 0 &&
    inaccessibleCount === 0 &&
    failedCount === 0 &&
    skippedNonTrivialCount === 0 &&
    repoInspection.uninspectedImportantFiles.length === 0;

  const hasUninspectedImportantGap =
    !repoInspection.accessible ||
    batchInterrupted ||
    resolvedAuditStatus !== 'COMPLETED' ||
    repoInspection.treeTruncated ||
    inaccessibleCount > 0 ||
    failedCount > 0 ||
    skippedDueToBudgetOrInterruption > 0 ||
    importantNonSensitiveUninspected.length > 0 ||
    commitShaMismatch;

  const zeroSourceNote =
    inspectedSourceFilesCount === 0 && readmeInspected
      ? ' (README.md inspected during discovery only; 0 source batches completed)'
      : '';

  const coverageHonestyNote = !repoInspection.accessible
    ? `Repository inspection failed or unavailable (${repoInspection.reason}).`
    : hasFullCoverage
      ? `Inspected all eligible source/config/test/deployment files (${fullyInspectedCount}/${repoInspection.totalFilesInTree} tree items).`
      : `Incomplete repository coverage: ${fullyInspectedCount} FULLY_INSPECTED, ${partiallyInspectedCount} PARTIALLY_INSPECTED, ${skippedCount} SKIPPED, ${inaccessibleCount} INACCESSIBLE, ${failedCount} FAILED out of ${repoInspection.totalFilesInTree} tree files${zeroSourceNote}.${batchInterrupted ? ` Audit ${resolvedAuditStatus} at batch ${batchesCompleted}/${batchesTotal}.` : ''}${repoInspection.treeTruncated ? ' GitHub tree was truncated.' : ''}`;

  // Section G: Merge deterministic + validated & redacted AI security findings
  const securityFindings = [...domainAudit.securityFindings];
  for (const sf of aiOutput?.securityFindings || []) {
    if (!sf.finding) continue;
    const redactedLoc = sf.location ? redactSecrets(sf.location).sanitized.trim() : '';
    const locCheck = redactedLoc
      ? isCitationReferenceValid(redactedLoc, inspectedFileMap)
      : { valid: false };
    if (redactedLoc && !locCheck.valid && locCheck.reason) {
      rejectedAiCitations.push(locCheck.reason);
    }
    const sanitizedFinding = sanitizeAndValidateAITextItem(
      sf.finding,
      inspectedFileMap,
      rejectedAiCitations
    );
    const safeSeverity =
      sf.severity === 'high' || sf.severity === 'medium' || sf.severity === 'low'
        ? sf.severity
        : 'medium';
    const ref = repoInspection.commitSha || repoInspection.defaultBranch || 'main';
    const locValid = locCheck.valid && !sanitizedFinding.hasInvalidCitation && Boolean(locCheck.cleanPath);
    securityFindings.push({
      id: `ai_sec_${securityFindings.length + 1}`,
      claimOrRequirement: redactSecrets(sf.mitigation || 'Application security control').sanitized,
      verificationMethod: 'static_code_audit',
      evidenceSource: locValid ? redactedLoc : 'unverified_ai_location',
      ...(locValid && locCheck.cleanPath ? { filePath: locCheck.cleanPath } : {}),
      ...(locValid && locCheck.startLine !== undefined ? { startLine: locCheck.startLine } : {}),
      ...(locValid && locCheck.endLine !== undefined ? { endLine: locCheck.endLine } : {}),
      ...(locValid && locCheck.cleanPath && repoInspection.repoFullName
        ? {
            blobUrl: buildGitHubBlobUrl(
              repoInspection.repoFullName,
              ref,
              locCheck.cleanPath,
              locCheck.startLine,
              locCheck.endLine
            )
          }
        : {}),
      observedAt: generatedAt,
      observedResult: sanitizedFinding.sanitizedText,
      status: safeSeverity === 'high' && locValid ? 'CONTRADICTED' : 'UNVERIFIED',
      confidence: locValid ? 'MEDIUM' : 'LOW',
      confidenceReason: locValid
        ? 'AI code audit observation verified against inspected file path.'
        : 'AI security finding could not be tied to a validated inspected file/line citation.',
      limitations: ['Verify full file context before treating as confirmed vulnerability.']
    });
  }

  // Section H: Contradicted, unsupported & unverifiable claims
  const contradictions = [...domainAudit.contradictions];
  for (const c of eligibility.checks.filter((x) => x.status === 'CONTRADICTED')) {
    contradictions.push(c);
  }
  for (const cc of aiOutput?.contradictedClaims || []) {
    if (!cc.claim) continue;
    const isDocPath = (filePath: string): boolean => /(?:^|\/)readme(?:\.[a-z0-9]+)?$/i.test(filePath);
    const claimSanitized = sanitizeAndValidateAITextItem(cc.claim, inspectedFileMap, rejectedAiCitations);
    const reasonSanitized = sanitizeAndValidateAITextItem(
      cc.reason || 'Claim lacks corroborating code or contradicts inspected source.',
      inspectedFileMap,
      rejectedAiCitations
    );
    const rawLoc = redactSecrets(cc.sourceLocation || '').sanitized.trim();
    const mentionsReadme = /\breadme(?:\.[a-z0-9]+)?\b/i.test(rawLoc);
    const mentionsMetadata = /\b(submission|metadata|proposedsolution|description|video|demo)\b/i.test(rawLoc);

    let locHasInvalid = false;
    const validLocCitations: ValidatedCitationDetail[] = [];

    // Check explicit bracketed citations inside sourceLocation first
    const locBracketSanitized = sanitizeAndValidateAITextItem(rawLoc, inspectedFileMap, rejectedAiCitations);
    if (locBracketSanitized.hasInvalidCitation) {
      locHasInvalid = true;
    }
    for (const c of locBracketSanitized.validCitations) {
      if (!isDocPath(c.path)) {
        validLocCitations.push(c);
      }
    }

    // Also inspect unbracketed file-path tokens inside sourceLocation (outside already-checked bracket tokens)
    const strippedBracketsLoc = rawLoc.replace(CITATION_TOKEN_PATTERN, ' ');
    const unbracketedLocPattern =
      /([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|cpp|c|h|kt|swift|json|ya?ml|toml|sql|md|mdx|txt|sh|prisma|graphql|html|css|scss|vue|svelte))(?::L?(\d+)(?:-L?(\d+))?)?/gi;
    for (const m of strippedBracketsLoc.matchAll(unbracketedLocPattern)) {
      const pathToken = m[1];
      const sStr = m[2];
      const eStr = m[3];
      const fullRef = sStr ? `${pathToken}:L${sStr}${eStr ? `-L${eStr}` : ''}` : pathToken;
      if (isDocPath(pathToken)) {
        if (sStr || inspectedFileMap.has(pathToken)) {
          const check = isCitationReferenceValid(fullRef, inspectedFileMap);
          if (!check.valid) {
            locHasInvalid = true;
            rejectedAiCitations.push(check.reason || fullRef);
          }
        }
        continue;
      }
      const check = isCitationReferenceValid(fullRef, inspectedFileMap);
      if (check.valid && check.cleanPath) {
        validLocCitations.push({
          path: check.cleanPath,
          ...(check.startLine !== undefined ? { startLine: check.startLine } : {}),
          ...(check.endLine !== undefined ? { endLine: check.endLine } : {})
        });
      } else {
        locHasInvalid = true;
        rejectedAiCitations.push(check.reason || fullRef);
      }
    }

    const validCodeCitations: ValidatedCitationDetail[] = [
      ...validLocCitations,
      ...reasonSanitized.validCitations.filter((c) => !isDocPath(c.path)),
      ...claimSanitized.validCitations.filter((c) => !isDocPath(c.path))
    ];
    const hasAnyInvalidCitation =
      locHasInvalid || reasonSanitized.hasInvalidCitation || claimSanitized.hasInvalidCitation;
    const hasAccessibleCode = repoInspection.accessible && repoInspection.inspectedFiles.length > 0;
    const primaryCodeCitation = validCodeCitations[0];
    const isVerifiedContradiction =
      hasAccessibleCode && !hasAnyInvalidCitation && Boolean(primaryCodeCitation);

    const ref = repoInspection.commitSha || repoInspection.defaultBranch || 'main';
    const docClaimLabel = mentionsReadme
      ? 'README.md'
      : mentionsMetadata
        ? 'submission metadata'
        : '';

    if (isVerifiedContradiction && primaryCodeCitation) {
      const lineSuffix = primaryCodeCitation.startLine
        ? `:L${primaryCodeCitation.startLine}-L${primaryCodeCitation.endLine || primaryCodeCitation.startLine}`
        : '';
      contradictions.push({
        id: `ai_contra_${contradictions.length + 1}`,
        claimOrRequirement: claimSanitized.sanitizedText,
        verificationMethod: 'static_code_audit',
        evidenceSource: `${primaryCodeCitation.path}${lineSuffix}${docClaimLabel ? ` (vs ${docClaimLabel})` : ''}`,
        filePath: primaryCodeCitation.path,
        ...(primaryCodeCitation.startLine !== undefined
          ? { startLine: primaryCodeCitation.startLine }
          : {}),
        ...(primaryCodeCitation.endLine !== undefined
          ? { endLine: primaryCodeCitation.endLine }
          : {}),
        ...(repoInspection.repoFullName
          ? {
              blobUrl: buildGitHubBlobUrl(
                repoInspection.repoFullName,
                ref,
                primaryCodeCitation.path,
                primaryCodeCitation.startLine,
                primaryCodeCitation.endLine
              )
            }
          : {}),
        observedAt: generatedAt,
        observedResult: reasonSanitized.sanitizedText,
        status: 'CONTRADICTED',
        confidence: 'MEDIUM',
        confidenceReason:
          'Detected discrepancy backed by validated inspected repository file/line citation.',
        limitations: [
          'Contradiction verified against inspected commit snapshot; confirm behavior in live runtime if applicable.'
        ]
      });
    } else if (hasAnyInvalidCitation) {
      contradictions.push({
        id: `ai_contra_${contradictions.length + 1}`,
        claimOrRequirement: claimSanitized.sanitizedText,
        verificationMethod: 'static_code_audit',
        evidenceSource: 'unverified_ai_location',
        observedAt: generatedAt,
        observedResult: reasonSanitized.sanitizedText,
        status: 'UNVERIFIED',
        confidence: 'LOW',
        confidenceReason:
          'Claimed contradiction cited an uninspected, nonexistent, or out-of-bounds file/line reference and was downgraded to UNVERIFIED.',
        limitations: [
          'AI contradiction citation rejected against inspected repository files; manual code inspection required.'
        ]
      });
    } else {
      contradictions.push({
        id: `ai_contra_${contradictions.length + 1}`,
        claimOrRequirement: claimSanitized.sanitizedText,
        verificationMethod: 'metadata_check',
        evidenceSource: mentionsReadme
          ? 'README.md (team documentation)'
          : 'submission_metadata (unverified claim)',
        observedAt: generatedAt,
        observedResult: reasonSanitized.sanitizedText,
        status: 'UNVERIFIED',
        confidence: 'LOW',
        confidenceReason:
          'Claim relies on README/submission metadata without a corroborated inspected source citation; cannot classify as CONTRADICTED.',
        limitations: [
          'Requires validated inspected code file and line-range evidence before marking CONTRADICTED.'
        ]
      });
    }
  }

  // Section J: Criterion-by-criterion observations (strictly NO numeric scores)
  const criterionObservations: CriterionObservation[] = (hackathon?.rubric || []).map((crit) => {
    const aiCrit = (aiOutput?.criterionObservations || []).find(
      (c) => c.criterionName?.toLowerCase() === crit.name.toLowerCase()
    );
    const matrixMatch = matrixRows.find((m) => m.requirementId === crit.id || m.requirementTitle === crit.name);
    const validatedObs = (aiCrit?.observations || []).map(
      (obs) => sanitizeAndValidateAITextItem(obs, inspectedFileMap, rejectedAiCitations).sanitizedText
    );
    const validCritLinks: FileCitation[] = [];
    const ref = repoInspection.commitSha || repoInspection.defaultBranch || 'main';
    for (const rawLink of aiCrit?.verifiedLinks || []) {
      const cleaned = redactSecrets(rawLink).sanitized.trim();
      const check = isCitationReferenceValid(cleaned, inspectedFileMap);
      if (check.valid && check.cleanPath) {
        validCritLinks.push({
          path: check.cleanPath,
          ...(check.startLine !== undefined ? { startLine: check.startLine } : {}),
          ...(check.endLine !== undefined ? { endLine: check.endLine } : {}),
          ...(repoInspection.repoFullName
            ? {
                blobUrl: buildGitHubBlobUrl(
                  repoInspection.repoFullName,
                  ref,
                  check.cleanPath,
                  check.startLine,
                  check.endLine
                )
              }
            : {})
        });
      } else {
        rejectedAiCitations.push(check.reason || cleaned);
      }
    }
    const mergedCritCitations: FileCitation[] = [];
    const seenCritKeys = new Set<string>();
    for (const c of [...validCritLinks, ...(matrixMatch?.relevantFiles || [])]) {
      const key = `${c.path}:${c.startLine ?? ''}-${c.endLine ?? ''}`;
      if (!seenCritKeys.has(key)) {
        seenCritKeys.add(key);
        mergedCritCitations.push(c);
      }
    }
    return {
      criterionId: crit.id,
      criterionName: crit.name,
      weight: crit.weight,
      description: crit.description,
      status:
        matrixMatch?.finalStatus ||
        (repoInspection.accessible ? 'UNVERIFIED' : 'BLOCKED'),
      observations:
        validatedObs.length > 0
          ? validatedObs
          : matrixMatch?.staticCodeEvidence || [
              repoInspection.accessible
                ? 'Review relevant inspected source files below to assign independent score.'
                : 'Repository inaccessible; review submission materials manually.'
            ],
      citations: mergedCritCitations.slice(0, 6),
      missingProof:
        aiCrit?.missingProof && aiCrit.missingProof.length > 0
          ? aiCrit.missingProof.map((m) => redactSecrets(m).sanitized)
          : [
              hasPassingExecutedTest
                ? 'Runtime / production user testing verification remains manual.'
                : 'No executed automated test results or live functional verification observed.'
            ]
    };
  });

  // Section K: Overall Confidence & Limitations
  const limitations: string[] = [];
  if (!repoInspection.accessible) {
    limitations.push(`GitHub repository not accessible (${repoInspection.reason}).`);
  }
  if (repoInspection.accessible && !repoInspection.commitSha) {
    limitations.push(
      `Commit SHA could not be resolved; inspection fell back to branch HEAD "${repoInspection.defaultBranch || 'main'}" and commit parity is unverified.`
    );
  }
  if (commitShaMismatch) {
    limitations.push(
      `Commit SHA mismatch detected: expected ${expectedCommitShaTrimmed?.slice(0, 10)}, inspected ${repoInspection.commitSha?.slice(0, 10)}.`
    );
  }
  if (batchInterrupted) {
    limitations.push(
      `Audit status ${resolvedAuditStatus} at batch ${batchesCompleted}/${batchesTotal}${params.batchAnalysisState?.incompleteReason ? ` (${params.batchAnalysisState.incompleteReason})` : ''}. Remaining batches are UNVERIFIED until resumed.`
    );
  } else if (resolvedAuditStatus !== 'COMPLETED') {
    limitations.push(resolvedAuditStatusReason);
  }
  if (ciCheckNote) {
    limitations.push(`CI check note: ${ciCheckNote}`);
  }
  if (failedCount > 0) {
    limitations.push(
      `${failedCount} repository file(s) FAILED to fetch due to network/server errors and remain unverified.`
    );
  }
  if (!hasFullCoverage && repoInspection.accessible) {
    limitations.push(coverageHonestyNote);
  }
  if (!hasPassingExecutedTest) {
    limitations.push(testHonestyNote);
  }
  if (liveDemoCheck.status === 'BLOCKED' || liveDemoCheck.status === 'UNVERIFIED') {
    limitations.push(liveDemoCheck.summary);
  }
  if (liveDemoCheck.manualVerificationRequired && liveDemoCheck.demoUrl) {
    limitations.push(
      'Manual browser verification required for interactive UI, authentication, and end-to-end live demo workflows.'
    );
  }
  if (repoInspection.hasDivergentRoots) {
    limitations.push(
      `Multiple project roots detected (${repoInspection.projectRoots.map((r) => r.rootPath).join(', ')}); confirm primary deployed app directory.`
    );
  }
  for (const missingCfg of requirementsBundle.missingRequirementFields) {
    limitations.push(`${missingCfg.field}: ${missingCfg.reason}`);
  }
  if (aiValidationIssues.length > 0) {
    limitations.push(
      `AI schema validation diagnostics (${aiValidationIssues.length}): ${Array.from(new Set(aiValidationIssues)).slice(0, 4).join('; ')}.`
    );
  }
  if (rejectedAiCitations.length > 0) {
    limitations.push(
      `Rejected ${rejectedAiCitations.length} unverified/out-of-bounds AI citation(s): ${Array.from(new Set(rejectedAiCitations)).slice(0, 6).join('; ')}.`
    );
  }

  // Strictly prevent false confidence when important files remain uninspected, batches are interrupted,
  // AI validation failed, commit SHA is mismatched, or BOTH automated tests and live demo are unverified/blocked.
  let overallConfidence: ConfidenceLevel = 'LOW';
  if (
    repoInspection.accessible &&
    resolvedAuditStatus === 'COMPLETED' &&
    !hasUninspectedImportantGap &&
    partiallyInspectedCount === 0 &&
    !aiValidationFailed &&
    repoInspection.inspectedFiles.length >= 4 &&
    hasPassingExecutedTest &&
    repoInspection.commitShaVerified !== false &&
    requirementsBundle.rubricWeightsValid &&
    liveDemoCheck.status !== 'CONTRADICTED'
  ) {
    overallConfidence = 'HIGH';
  } else if (
    repoInspection.accessible &&
    resolvedAuditStatus === 'COMPLETED' &&
    !hasUninspectedImportantGap &&
    !aiValidationFailed &&
    repoInspection.inspectedFiles.length >= 2 &&
    requirementsBundle.rubricWeightsValid &&
    (hasPassingExecutedTest || liveDemoCheck.reachable)
  ) {
    overallConfidence = 'MEDIUM';
  }

  // Build deterministic + validated summary lists (all redacted and grounded)
  const deterministicVerified = [
    ...domainAudit.architectureFindings.map(
      (f) => `[${f.filePath}${f.startLine ? `:${f.startLine}-${f.endLine}` : ''}] (${f.status}) ${f.observedResult}`
    ),
    ...sanitizedAiVerifiedEvidence
  ];

  const deterministicInspected = repoInspection.inspectedFiles.map((f) => {
    const first = f.chunks?.[0];
    const lineTag = first ? ` L${first.startLine}-${first.endLine}` : '';
    return `${f.path} [${f.category}${lineTag}${f.truncated ? ' · partial' : ''}]`;
  });

  const deterministicUninspected = repoInspection.uninspectedImportantFiles.map(
    (f) => `${f.path} (${f.reason})`
  );

  const deterministicConfidenceSummary = `Confidence=${overallConfidence} (${resolvedAuditStatus}) based on ${fullyInspectedCount} FULLY_INSPECTED, ${partiallyInspectedCount} PARTIALLY_INSPECTED, ${skippedCount} SKIPPED, ${inaccessibleCount} INACCESSIBLE, ${failedCount} FAILED (${repoInspection.inspectedFiles.length} inspected source files of ${repoInspection.totalFilesInTree} tree entries), commit=${repoInspection.commitSha || 'unresolved'}, executedTests=${executedTests.length}, demoStatus=${liveDemoCheck.status}.`;
  const safeAiReason =
    !hasUninspectedImportantGap &&
    !batchInterrupted &&
    overallConfidence !== 'LOW' &&
    aiOutput?.confidenceReason
      ? ` ${redactSecrets(aiOutput.confidenceReason).sanitized}`
      : '';

  return {
    reportVersion: '2.0',
    generatedAt,
    auditStatus: resolvedAuditStatus,
    auditStatusReason: resolvedAuditStatusReason,
    resumable: resolvedResumable,
    submissionId: submission.id,
    submissionTitle: submission.title || 'Untitled Submission',
    hackathonId: hackathon?.id || submission.hackathonId,
    hackathonTitle: requirementsBundle.hackathonTitle,
    commitSha: repoInspection.commitSha,
    detectedStrategies: strategies,
    requirementsBundle,
    sectionA_eligibility: eligibility,
    sectionB_coverage: {
      accessible: repoInspection.accessible,
      repoFullName: repoInspection.repoFullName,
      defaultBranch: repoInspection.defaultBranch,
      commitSha: repoInspection.commitSha,
      commitShaVerified: repoInspection.commitShaVerified ?? Boolean(repoInspection.commitSha),
      treeDiscoveryMethod: repoInspection.treeDiscoveryMethod,
      treeTruncated: repoInspection.treeTruncated,
      totalFilesInTree: repoInspection.totalFilesInTree,
      ...(filesSelectedCount !== undefined ? { filesSelectedCount } : {}),
      filesFetchedCount,
      readmeInspected,
      inspectedSourceFilesCount,
      fullyInspectedCount,
      partiallyInspectedCount,
      skippedCount,
      inaccessibleCount,
      failedCount,
      interrupted: batchInterrupted,
      batchesCompleted,
      batchesPendingCount,
      batchesInterruptedCount,
      batchesTotal,
      hasFullCoverage,
      coverageHonestyNote,
      duplicateFileGroups: repoInspection.duplicateFileGroups,
      projectRoots: repoInspection.projectRoots,
      hasDivergentRoots: repoInspection.hasDivergentRoots,
      importantUninspected: repoInspection.uninspectedImportantFiles.map((u) => ({
        path: u.path,
        category: u.category,
        reason: u.reason
      })),
      fileInventory: repoInspection.fileInventory
    },
    sectionC_matrix: matrixRows,
    sectionD_architecture: domainAudit.architectureFindings,
    sectionE_tests: {
      discoveredTestFiles,
      ...(detectedTestFrameworks.length > 0 ? { detectedTestFrameworks } : {}),
      ...(detectedTestCommands.length > 0 ? { detectedTestCommands } : {}),
      executedTests,
      summaryStatus: testSummaryStatus,
      honestyNote: testHonestyNote
    },
    sectionF_liveDemo: liveDemoCheck,
    sectionG_security: {
      redactedSecretsCount: repoInspection.redactedSecretsCount,
      findings: securityFindings
    },
    sectionH_contradictions: contradictions,
    sectionI_missingEvidence: {
      missingItems: Array.from(
        new Set([
          ...sanitizedAiMissingEvidence,
          ...limitations
        ])
      ),
      teamQuestions:
        sanitizedAiQuestions.length > 0
          ? sanitizedAiQuestions
          : [
              'Can you demonstrate end-to-end execution against live environment/sandbox with logs?',
              'Can you run your automated test suite and share full passing output for this commit SHA?'
            ]
    },
    sectionJ_criterionObservations: criterionObservations,
    sectionK_confidence: {
      overallConfidence,
      reason: `${deterministicConfidenceSummary}${safeAiReason}`,
      limitations
    },
    verifiedEvidence: Array.from(new Set(deterministicVerified)).slice(0, 12),
    teamClaims:
      sanitizedAiTeamClaims.length > 0
        ? sanitizedAiTeamClaims
        : contradictions.map((c) => c.observedResult).slice(0, 8),
    missingEvidence: Array.from(
      new Set([...sanitizedAiMissingEvidence, ...limitations])
    ).slice(0, 12),
    technicalObservations:
      sanitizedAiTechObs.length > 0
        ? sanitizedAiTechObs
        : domainAudit.architectureFindings.map((a) => `[${a.filePath}] ${a.observedResult}`),
    potentialRisks:
      sanitizedAiPotentialRisks.length > 0
        ? sanitizedAiPotentialRisks
        : securityFindings.map((s) => `[${s.evidenceSource}] ${s.observedResult}`),
    suggestedQuestions:
      sanitizedAiQuestions.length > 0
        ? sanitizedAiQuestions
        : [
            'Please provide passing test suite output and commit hash matching the deployed demo.',
            'How are external API failures, secrets, and unauthorized requests handled server-side?'
          ],
    inspectedSources: deterministicInspected,
    uninspectedSources: deterministicUninspected
  };
}
