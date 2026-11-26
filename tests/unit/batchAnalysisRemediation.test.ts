import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InferenceMode } from 'firebase/ai';
import {
  clearAllAnalysisMemoryCaches,
  clearAnalysisCheckpoint,
  getSavedAnalysisCheckpoint,
  runResumableJudgeAnalysis
} from '../../src/services/judging/batchAnalysisCoordinator';
import {
  classifyRepoFile,
  discoverGitHubRepoPlan,
  finalizeGitHubRepoInspection,
  inspectGitHubRepoBatchSlice,
  inspectPublicGitHubRepo,
  type GitHubRepoInspection
} from '../../src/services/github/repoInspector';
import {
  buildComprehensiveJudgingReport,
  mergeValidatedAIAuditOutputs
} from '../../src/services/judging/evidenceVerifier';
import { ComprehensiveEvidencePanel } from '../../src/components/judging/ComprehensiveEvidencePanel';
import type { Hackathon, ProjectSubmission } from '../../src/types/domain';

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    dumpAll: () => Array.from(store.entries())
  };
}

describe('AI Judge Timeout, Batching, Resume & Coverage Remediation', () => {
  const memStorage = createMemoryStorage();

  beforeEach(() => {
    clearAllAnalysisMemoryCaches();
    memStorage.clear();
    vi.stubGlobal('localStorage', memStorage);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const baseHackathon: Hackathon = {
    id: 'hack_rem',
    organizerId: 'org_1',
    organizerName: 'Organizer',
    title: 'Global Remediation Hack',
    tagline: '',
    description: '',
    coverImageUrl: '',
    startDate: '2026-11-01',
    endDate: '2026-11-30',
    registrationDeadline: '2026-11-10',
    submissionDeadline: '2026-12-01T00:00:00Z',
    mode: 'online',
    location: 'Remote',
    tracks: ['AI'],
    technologies: ['TypeScript'],
    eligibility: 'Open',
    rules: 'Public GitHub repo required',
    prizes: [],
    sponsors: [],
    rubric: [
      { id: 'c_tech', name: 'Technical Implementation', description: 'Architecture & quality', weight: 60 },
      { id: 'c_sec', name: 'Security & Testing', description: 'Rules & tests', weight: 40 }
    ],
    maxTeamSize: 4,
    status: 'judging',
    resultsPublished: false
  };

  const baseSubmission: ProjectSubmission = {
    id: 'sub_rem_1',
    hackathonId: 'hack_rem',
    organizerId: 'org_1',
    teamId: 'team_1',
    teamName: 'Remediation Team',
    projectId: 'proj_1',
    ownerId: 'u1',
    memberIds: ['u1'],
    memberNames: ['Alice'],
    title: 'AuditGuard',
    shortDescription: 'Audit platform',
    fullDescription: 'Full audit platform',
    problemStatement: '',
    proposedSolution: 'Batch inspection with Gemini and Vitest',
    technologies: ['TypeScript'],
    githubUrl: 'https://github.com/acme/large-82-app',
    demoUrl: 'https://auditguard.example.app',
    videoUrl: '',
    screenshotUrls: [],
    track: 'AI',
    status: 'under_review',
    submittedAt: '2026-11-20T00:00:00Z'
  };

  function buildLargeRepoTree(count = 82) {
    const files: Array<{ path: string; size: number; sha: string; content: string }> = [
      { path: 'README.md', size: 120, sha: 'sha_readme', content: '# AuditGuard\nPublic TypeScript app.' },
      { path: 'package.json', size: 220, sha: 'sha_pkg', content: '{"name":"auditguard","dependencies":{"typescript":"5.0.0"}}' },
      { path: 'firestore.rules', size: 150, sha: 'sha_rules', content: 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { } }' },
      { path: 'Dockerfile', size: 120, sha: 'sha_docker', content: 'FROM node:22-alpine\nCMD ["node","server.ts"]' },
      { path: '.github/workflows/ci.yml', size: 140, sha: 'sha_ci', content: 'name: CI\non: [push]' },
      { path: 'src/api/server.ts', size: 200, sha: 'sha_api', content: 'export const apiVersion = "1.0"; // TypeScript server' },
      { path: 'src/auth/guard.ts', size: 180, sha: 'sha_auth', content: 'export function requireUser(uid: string) { return Boolean(uid); }' },
      { path: 'tests/auth.test.ts', size: 160, sha: 'sha_test', content: 'describe("auth", () => { it("ok", () => expect(true).toBe(true)); });' }
    ];
    for (let i = files.length; i < count; i++) {
      files.push({
        path: `src/modules/mod_${String(i).padStart(2, '0')}.ts`,
        size: 100,
        sha: `sha_${i}`,
        content: `export const mod${i} = ${i};`
      });
    }
    return files;
  }

  function stubGitHubRepoFetch(
    files: Array<{ path: string; size: number; sha: string; content: string }>,
    options?: {
      commitSha?: string;
      fail404Paths?: string[];
      fail500Paths?: string[];
      demoCorsBlocked?: boolean;
      withPassingCi?: boolean;
    }
  ) {
    const commitSha = options?.commitSha || 'deadbeef12345678';
    const fail404 = new Set(options?.fail404Paths || []);
    const fail500 = new Set(options?.fail500Paths || []);
    const fileMap = new Map(files.map((f) => [f.path, f]));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/acme/large-82-app') {
        return new Response(
          JSON.stringify({
            full_name: 'acme/large-82-app',
            default_branch: 'main',
            description: 'Large repo test',
            language: 'TypeScript',
            stargazers_count: 10,
            updated_at: '2026-11-21T00:00:00Z'
          }),
          { status: 200 }
        );
      }
      if (url.includes('/commits/main')) {
        return new Response(JSON.stringify({ sha: commitSha }), { status: 200 });
      }
      if (url.includes('/git/trees/')) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: files.map((f) => ({ path: f.path, type: 'blob', size: f.size, sha: f.sha }))
          }),
          { status: 200 }
        );
      }
      if (url.includes('/actions/runs?head_sha=')) {
        if (!options?.withPassingCi) {
          return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 901,
                name: 'CI',
                path: '.github/workflows/ci.yml',
                status: 'completed',
                conclusion: 'success',
                head_sha: commitSha,
                head_branch: 'main',
                updated_at: '2026-11-21T00:00:00Z'
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes('/actions/runs/901/jobs')) {
        return new Response(
          JSON.stringify({
            jobs: [{ name: 'unit_tests', conclusion: 'success', steps: [{ name: 'npm test', conclusion: 'success' }] }]
          }),
          { status: 200 }
        );
      }
      if (url.startsWith('https://raw.githubusercontent.com/')) {
        const prefix = `https://raw.githubusercontent.com/acme/large-82-app/${commitSha}/`;
        const path = decodeURIComponent(url.slice(prefix.length));
        if (fail404.has(path)) return new Response('Not Found', { status: 404 });
        if (fail500.has(path)) return new Response('Server Error', { status: 502 });
        const f = fileMap.get(path);
        if (!f) return new Response('Not Found', { status: 404 });
        return new Response(f.content, { status: 200 });
      }
      if (url.startsWith('https://api.github.com/repos/acme/large-82-app/contents/')) {
        const rawPath = url.split('/contents/')[1]?.split('?')[0] || '';
        const path = decodeURIComponent(rawPath);
        if (fail404.has(path)) return new Response('Not Found', { status: 404 });
        if (fail500.has(path)) return new Response('Server Error', { status: 502 });
        return new Response('Not Found', { status: 404 });
      }
      if (url === 'https://auditguard.example.app') {
        if (options?.demoCorsBlocked) {
          throw new TypeError('Failed to fetch (CORS)');
        }
        return new Response('<html><title>AuditGuard</title></html>', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('classifies deployment configs with high priority and inspects all 82 repository files across batches without stopping at 28', async () => {
    expect(classifyRepoFile('Dockerfile')?.category).toBe('deployment');
    expect(classifyRepoFile('apphosting.production.yaml')?.category).toBe('deployment');
    expect(classifyRepoFile('.github/workflows/ci.yml')?.category).toBe('deployment');

    const files82 = buildLargeRepoTree(82);
    stubGitHubRepoFetch(files82);

    const inspection = await inspectPublicGitHubRepo('https://github.com/acme/large-82-app', {
      useCache: false
    });

    expect(inspection.accessible).toBe(true);
    expect(inspection.totalFilesInTree).toBe(82);
    // 81 non-README eligible files + 1 README -> all 81 files inspected instead of capped at 28 with 53 skipped
    expect(inspection.inspectedFiles.length).toBe(81);
    expect(inspection.uninspectedImportantFiles.length).toBe(0);
    expect(inspection.detectedCategories).toContain('deployment');
  });

  it('tracks all 5 canonical file statuses (FULLY_INSPECTED, PARTIALLY_INSPECTED, SKIPPED, INACCESSIBLE, FAILED) honestly', async () => {
    const files = buildLargeRepoTree(10);
    // Mark Dockerfile as HTTP 404 (INACCESSIBLE) and src/api/server.ts as HTTP 502 (FAILED)
    stubGitHubRepoFetch(files, {
      fail404Paths: ['Dockerfile'],
      fail500Paths: ['src/api/server.ts'],
      demoCorsBlocked: true
    });

    const plan = await discoverGitHubRepoPlan('https://github.com/acme/large-82-app', {
      maxPerFileChars: 20, // forces longer files to become PARTIALLY_INSPECTED
      useCache: false
    });
    const slice = await inspectGitHubRepoBatchSlice(plan, plan.selectedEntries, {
      maxPerFileChars: 20
    });
    const inspection = finalizeGitHubRepoInspection(plan, {
      inspectedFiles: slice.inspectedFiles,
      extraSkipped: slice.skippedOrFailed,
      batchesProcessed: 1,
      redactedSecretsCount: slice.redactedSecretsCount,
      interrupted: false
    });

    const report = buildComprehensiveJudgingReport({
      submission: baseSubmission,
      hackathon: baseHackathon,
      repoInspection: inspection,
      liveDemoCheck: {
        demoUrl: 'https://auditguard.example.app',
        checkedAt: '2026-11-22T00:00:00Z',
        reachable: false,
        httpStatus: null,
        corsBlocked: true,
        browserCorsBlocked: true,
        requiresAuth: false,
        probeMethod: 'manual_required',
        manualVerificationRequired: true,
        checkedAspects: [],
        blockedAspects: ['CORS blocked'],
        status: 'BLOCKED',
        summary: 'Browser CORS blocked live demo.'
      }
    });

    expect(report.sectionB_coverage.partiallyInspectedCount).toBeGreaterThan(0);
    expect(report.sectionB_coverage.inaccessibleCount).toBe(1);
    expect(report.sectionB_coverage.failedCount).toBe(1);
    expect(report.sectionB_coverage.hasFullCoverage).toBe(false);
    expect(report.sectionK_confidence.overallConfidence).toBe('LOW');

    const covHtml = renderToStaticMarkup(
      createElement(ComprehensiveEvidencePanel, {
        report,
        locale: 'en',
        initialTab: 'coverage'
      })
    );
    expect(covHtml).toContain('PARTIALLY_INSPECTED');
    expect(covHtml).toContain('INACCESSIBLE');
    expect(covHtml).toContain('FAILED');
  });

  it('prevents false MEDIUM/HIGH confidence when coverage is incomplete or tests & demo are unverified/blocked', () => {
    const partialRepo: GitHubRepoInspection = {
      accessible: true,
      repoFullName: 'acme/partial',
      defaultBranch: 'main',
      commitSha: '1234abcd',
      commitShaVerified: true,
      description: 'Partial',
      primaryLanguage: 'TypeScript',
      stars: 1,
      updatedAt: '2026-11-20T00:00:00Z',
      readmeExcerpt: '# App',
      readmeFullChars: 5,
      readmeTruncated: false,
      treeDiscoveryMethod: 'git_trees',
      treeTruncated: false,
      totalFilesInTree: 82,
      treeSamplePaths: ['src/index.ts'],
      inspectedFiles: [
        {
          path: 'src/index.ts',
          category: 'server_api',
          sizeBytes: 100,
          charsIncluded: 100,
          totalLines: 2,
          truncated: false,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 0,
          chunks: [{ startLine: 1, endLine: 2, content: 'export const x = 1;' }],
          excerpt: 'export const x = 1;'
        },
        {
          path: 'tests/index.test.ts',
          category: 'tests',
          sizeBytes: 100,
          charsIncluded: 100,
          totalLines: 2,
          truncated: false,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 0,
          chunks: [{ startLine: 1, endLine: 2, content: 'it("ok", () => expect(1).toBe(1));' }],
          excerpt: 'it("ok", () => expect(1).toBe(1));'
        }
      ],
      uninspectedImportantFiles: [
        { path: 'src/payments.ts', category: 'payments_paypal', sizeBytes: 400, reason: 'budget_limit' }
      ],
      fileInventory: [
        { path: 'src/index.ts', category: 'server_api', sizeBytes: 100, inspectionStatus: 'inspected', auditStatus: 'FULLY_INSPECTED', reason: 'inspected_complete' },
        { path: 'tests/index.test.ts', category: 'tests', sizeBytes: 100, inspectionStatus: 'inspected', auditStatus: 'FULLY_INSPECTED', reason: 'inspected_complete' },
        { path: 'src/payments.ts', category: 'payments_paypal', sizeBytes: 400, inspectionStatus: 'skipped', auditStatus: 'SKIPPED', reason: 'budget_limit' }
      ],
      duplicateFileGroups: [],
      projectRoots: [],
      hasDivergentRoots: false,
      batchesProcessed: 1,
      detectedCategories: ['server_api', 'tests'],
      redactedSecretsCount: 0,
      rateLimitRemaining: 50,
      aborted: false,
      reason: 'Inspected 2 of 82 files'
    };

    const report = buildComprehensiveJudgingReport({
      submission: baseSubmission,
      hackathon: baseHackathon,
      repoInspection: partialRepo,
      liveDemoCheck: {
        demoUrl: 'https://auditguard.example.app',
        checkedAt: '2026-11-22T00:00:00Z',
        reachable: false,
        httpStatus: null,
        corsBlocked: true,
        browserCorsBlocked: true,
        requiresAuth: false,
        probeMethod: 'manual_required',
        manualVerificationRequired: true,
        checkedAspects: [],
        blockedAspects: ['CORS blocked'],
        status: 'BLOCKED',
        summary: 'Blocked by CORS.'
      },
      aiOutput: {
        overallConfidence: 'MEDIUM',
        confidenceReason: 'Looks solid across inspected files.',
        requirementEvaluations: [
          {
            requirementId: 'c_sec',
            status: 'TEST_CONFIRMED',
            evidenceCitations: ['src/nonexistent.ts:L1-L5'],
            summary: 'All tests pass'
          }
        ]
      }
    });

    expect(report.sectionK_confidence.overallConfidence).toBe('LOW');
    expect(report.sectionK_confidence.reason).toContain('Confidence=LOW');
    expect(report.sectionK_confidence.reason).not.toContain('Looks solid');
    expect(report.sectionE_tests.summaryStatus).toBe('UNVERIFIED');
    expect(report.sectionC_matrix.find((r) => r.requirementId === 'c_sec')?.finalStatus).toBe('UNVERIFIED');
  });

  it('executes bounded batches, preserves checkpoint on batch timeout without storing raw code in localStorage, resumes remaining batches, and invalidates on commit SHA change', async () => {
    const files12 = buildLargeRepoTree(13); // 1 README + 12 eligible files = 3 batches of 4
    stubGitHubRepoFetch(files12, { commitSha: 'commit_v1_aaaa', withPassingCi: true });

    const seenPromptCharLengths: number[] = [];
    let batchCallNumber = 0;

    // First run: Batch 1 & 2 pass, Batch 3 times out
    const run1 = await runResumableJudgeAnalysis({
      submission: baseSubmission,
      hackathon: baseHackathon,
      locale: 'en',
      aiMode: InferenceMode.PREFER_IN_CLOUD,
      cloudConsentGranted: true,
      explicitGeminiAuthorized: true,
      batchFilesLimit: 4,
      batchCharsLimit: 50_000,
      runInferenceFn: async (req) => {
        batchCallNumber += 1;
        seenPromptCharLengths.push(req.prompt.length);
        if (batchCallNumber === 3) {
          return {
            ok: false,
            data: null,
            rawText: '',
            statusIndicator: 'FAILED',
            sdkInferenceSource: null,
            requestedMode: InferenceMode.PREFER_IN_CLOUD,
            modelIdentifier: 'gemini-2.5-pro',
            executedAt: new Date().toISOString(),
            durationMs: 35_001,
            fallbackOccurred: false,
            failureCategory: 'timeout',
            errorMessage: 'Gemini inference timed out after 35s'
          };
        }
        const parsedCtx = req.prompt.split('<UNTRUSTED_SUBMISSION_AND_REPO_DATA>\n')[1]?.split('\n</UNTRUSTED_SUBMISSION_AND_REPO_DATA>')[0];
        const jsonCtx = JSON.parse(parsedCtx || '{}');
        const batchFiles = jsonCtx.repositoryInspection?.inspectedFiles || [];
        expect(batchFiles.length).toBeLessThanOrEqual(4);
        const firstPath = batchFiles[0]?.path || 'src/api/server.ts';
        return {
          ok: true,
          data: {
            verifiedEvidence: [`[${firstPath}:L1-L1] Inspected batch ${batchCallNumber} implementation.`],
            requirementEvaluations: [
              {
                requirementId: 'c_tech',
                status: 'CODE_CONFIRMED',
                evidenceCitations: [`${firstPath}:L1-L1`],
                summary: `Batch ${batchCallNumber} check`
              }
            ],
            overallConfidence: 'MEDIUM'
          } as never,
          rawText: '{}',
          statusIndicator: 'CLOUD',
          sdkInferenceSource: null,
          requestedMode: InferenceMode.PREFER_IN_CLOUD,
          modelIdentifier: 'gemini-2.5-pro',
          executedAt: new Date().toISOString(),
          durationMs: 500,
          fallbackOccurred: false
        };
      }
    });

    expect(run1.interrupted).toBe(true);
    expect(run1.resumable).toBe(true);
    expect(run1.batchesCompleted).toBe(2);
    expect(run1.batchesTotal).toBe(3);
    expect(run1.report.sectionB_coverage.interrupted).toBe(true);
    expect(run1.report.sectionK_confidence.overallConfidence).toBe('LOW');

    // Verify localStorage checkpoint exists and contains ZERO raw file source code
    const ckpt = getSavedAnalysisCheckpoint(baseSubmission.id);
    expect(ckpt?.completedBatches).toBe(2);
    expect(ckpt?.commitSha).toBe('commit_v1_aaaa');
    const serializedStorage = memStorage.dumpAll().map(([, v]) => v).join('\n');
    expect(serializedStorage).not.toContain('export const apiVersion');
    expect(serializedStorage).not.toContain('export function requireUser');

    // Second run (resume): ONLY runs Batch 3 (1 inference call instead of 3!)
    let resumeInferenceCalls = 0;
    const run2 = await runResumableJudgeAnalysis({
      submission: baseSubmission,
      hackathon: baseHackathon,
      locale: 'en',
      aiMode: InferenceMode.PREFER_IN_CLOUD,
      cloudConsentGranted: true,
      explicitGeminiAuthorized: true,
      batchFilesLimit: 4,
      batchCharsLimit: 50_000,
      resumeIfAvailable: true,
      runInferenceFn: async (req) => {
        resumeInferenceCalls += 1;
        expect(req.prompt).toContain('"batchIndex":3');
        return {
          ok: true,
          data: {
            verifiedEvidence: ['[tests/auth.test.ts:L1-L1] Batch 3 test file verified.'],
            overallConfidence: 'HIGH'
          } as never,
          rawText: '{}',
          statusIndicator: 'CLOUD',
          sdkInferenceSource: null,
          requestedMode: InferenceMode.PREFER_IN_CLOUD,
          modelIdentifier: 'gemini-2.5-pro',
          executedAt: new Date().toISOString(),
          durationMs: 400,
          fallbackOccurred: false
        };
      }
    });

    expect(resumeInferenceCalls).toBe(1);
    expect(run2.interrupted).toBe(false);
    expect(run2.batchesCompleted).toBe(3);
    expect(run2.batchesTotal).toBe(3);
    expect(run2.repoInspection.inspectedFiles.length).toBe(12);
    expect(getSavedAnalysisCheckpoint(baseSubmission.id)).toBeNull();
    expect(run2.report.verifiedEvidence.some((v) => v.includes('Inspected batch 1'))).toBe(true);

    // Simulate interrupted checkpoint, then commit SHA changes -> stale checkpoint MUST invalidate and re-run all 3 batches
    clearAllAnalysisMemoryCaches();
    memStorage.setItem(
      `hackmind_judge_batch_ckpt_v1:${baseSubmission.id}`,
      JSON.stringify({
        version: 1,
        submissionId: baseSubmission.id,
        repoFullName: 'acme/large-82-app',
        commitSha: 'old_commit_1111',
        locale: 'en',
        totalBatches: 3,
        completedBatches: 2,
        batchPlanPaths: [],
        inspectedPaths: [],
        validatedBatchOutputs: [],
        lastStatusIndicator: 'CLOUD',
        lastModelIdentifier: 'gemini-2.5-pro',
        interrupted: true,
        updatedAt: new Date().toISOString()
      })
    );
    stubGitHubRepoFetch(files12, { commitSha: 'new_commit_2222' });

    let freshCallsOnNewCommit = 0;
    const run3 = await runResumableJudgeAnalysis({
      submission: baseSubmission,
      hackathon: baseHackathon,
      locale: 'en',
      aiMode: InferenceMode.PREFER_IN_CLOUD,
      cloudConsentGranted: true,
      explicitGeminiAuthorized: true,
      batchFilesLimit: 4,
      batchCharsLimit: 50_000,
      resumeIfAvailable: true,
      runInferenceFn: async () => {
        freshCallsOnNewCommit += 1;
        return {
          ok: true,
          data: { verifiedEvidence: [], overallConfidence: 'LOW' } as never,
          rawText: '{}',
          statusIndicator: 'CLOUD',
          sdkInferenceSource: null,
          requestedMode: InferenceMode.PREFER_IN_CLOUD,
          modelIdentifier: 'gemini-2.5-pro',
          executedAt: new Date().toISOString(),
          durationMs: 200,
          fallbackOccurred: false
        };
      }
    });

    expect(freshCallsOnNewCommit).toBe(3);
    expect(run3.repoInspection.commitSha).toBe('new_commit_2222');
  });

  it('aborts mid-batch safely on cancellation and rejects malformed batch schema responses', async () => {
    const files12 = buildLargeRepoTree(13);
    stubGitHubRepoFetch(files12, { commitSha: 'commit_abort_1' });

    const ac = new AbortController();
    let calls = 0;
    const abortedRun = await runResumableJudgeAnalysis({
      submission: baseSubmission,
      hackathon: baseHackathon,
      locale: 'en',
      aiMode: InferenceMode.PREFER_IN_CLOUD,
      cloudConsentGranted: true,
      explicitGeminiAuthorized: true,
      batchFilesLimit: 4,
      batchCharsLimit: 50_000,
      signal: ac.signal,
      runInferenceFn: async () => {
        calls += 1;
        if (calls === 1) {
          // Abort right after Batch 1 completes so Batch 2 is never invoked
          ac.abort();
          return {
            ok: true,
            data: { verifiedEvidence: [], overallConfidence: 'LOW' } as never,
            rawText: '{}',
            statusIndicator: 'CLOUD',
            sdkInferenceSource: null,
            requestedMode: InferenceMode.PREFER_IN_CLOUD,
            modelIdentifier: 'gemini-2.5-pro',
            executedAt: new Date().toISOString(),
            durationMs: 100,
            fallbackOccurred: false
          };
        }
        throw new Error('Should not execute batch 2 after AbortSignal triggered');
      }
    });

    expect(calls).toBe(1);
    expect(abortedRun.aborted).toBe(true);
    expect(abortedRun.interrupted).toBe(true);
    expect(abortedRun.batchesCompleted).toBe(1);
    expect(getSavedAnalysisCheckpoint(baseSubmission.id)?.completedBatches).toBe(1);

    // Schema merge validator drops malformed batch outputs
    clearAnalysisCheckpoint(baseSubmission.id);
    const merged = mergeValidatedAIAuditOutputs([
      { requirementEvaluations: 'invalid-string' },
      { verifiedEvidence: ['[src/api/server.ts:L1-L1] valid'], overallConfidence: 'HIGH' }
    ]);
    expect(merged.validBatchCount).toBe(1);
    expect(merged.validationIssues.length).toBeGreaterThan(0);
    expect(merged.merged?.overallConfidence).toBe('HIGH');
  });

  it('keeps Batch 1 failure resumable (FAILED -> Retry without re-fetching GitHub), never inflates filesInspectedSoFar, and marks unreached files as batch_interrupted', async () => {
    const files8 = buildLargeRepoTree(9); // 1 README + 8 eligible = 2 batches of 4
    const fetchMock = stubGitHubRepoFetch(files8, {
      commitSha: 'commit_b1_500',
      withPassingCi: false
    });

    const observedProgress: Array<{
      stage: string;
      audited: number;
      fetched?: number;
      ciState?: string;
    }> = [];

    let inferCall = 0;
    const failedRun = await runResumableJudgeAnalysis({
      submission: baseSubmission,
      hackathon: baseHackathon,
      locale: 'en',
      aiMode: InferenceMode.PREFER_IN_CLOUD,
      cloudConsentGranted: true,
      explicitGeminiAuthorized: true,
      batchFilesLimit: 4,
      batchCharsLimit: 50_000,
      onProgress: (p) => {
        observedProgress.push({
          stage: p.stage,
          audited: p.filesInspectedSoFar,
          fetched: p.filesFetchedSoFar,
          ciState: p.stageStatus?.ci
        });
      },
      runInferenceFn: async () => {
        inferCall += 1;
        return {
          ok: false,
          data: null,
          rawText: '',
          statusIndicator: 'FAILED',
          sdkInferenceSource: null,
          requestedMode: InferenceMode.PREFER_IN_CLOUD,
          modelIdentifier: 'gemini-4-hydrogen',
          executedAt: new Date().toISOString(),
          durationMs: 1200,
          fallbackOccurred: false,
          failureCategory: 'transient_overload',
          retryAttempts: 2,
          errorMessage:
            'Cloud AI model (gemini-4-hydrogen) is temporarily experiencing high demand (HTTP 500/503).'
        };
      }
    });

    expect(inferCall).toBe(1);
    expect(failedRun.auditStatus).toBe('FAILED');
    expect(failedRun.report.auditStatus).toBe('FAILED');
    expect(failedRun.resumable).toBe(true);
    expect(failedRun.batchesCompleted).toBe(0);
    expect(failedRun.batchesTotal).toBe(2);
    expect(failedRun.repoInspection.inspectedFiles).toHaveLength(0);
    expect(failedRun.ciCheckNote).toContain('0 commit-pinned runs found');

    // Progress audited counter stayed at 0 while batch 1 files were only fetched
    const batch1Progress = observedProgress.find((p) => p.stage === 'running_batch');
    expect(batch1Progress?.audited).toBe(0);

    // Every uninspected file in failed Batch 1 run must be batch_interrupted, NEVER budget_limit
    expect(failedRun.repoInspection.uninspectedImportantFiles.length).toBe(8);
    expect(
      failedRun.repoInspection.uninspectedImportantFiles.every(
        (u) => u.reason === 'batch_interrupted'
      )
    ).toBe(true);

    // Checkpoint saved at batch 0 for immediate Retry
    const savedCkpt = getSavedAnalysisCheckpoint(baseSubmission.id);
    expect(savedCkpt?.completedBatches).toBe(0);
    expect(savedCkpt?.failedBatchIndex).toBe(0);
    expect(savedCkpt?.lastFailureCategory).toBe('transient_overload');

    // Count how many raw.githubusercontent.com file downloads happened on Retry
    const rawFetchesBeforeRetry = fetchMock.mock.calls.filter(([u]) =>
      String(u).startsWith('https://raw.githubusercontent.com/')
    ).length;

    let retryCalls = 0;
    const retriedRun = await runResumableJudgeAnalysis({
      submission: baseSubmission,
      hackathon: baseHackathon,
      locale: 'en',
      aiMode: InferenceMode.PREFER_IN_CLOUD,
      cloudConsentGranted: true,
      explicitGeminiAuthorized: true,
      batchFilesLimit: 4,
      batchCharsLimit: 50_000,
      resumeIfAvailable: true,
      runInferenceFn: async (req) => {
        retryCalls += 1;
        expect(req.useHeavyCloudModel).toBe(true);
        expect(req.preferredMode).toBe(InferenceMode.ONLY_IN_CLOUD);
        expect(req.maxTransientRetries).toBe(0);
        expect(req.disableModelFallback).toBe(true);
        return {
          ok: true,
          data: {
            verifiedEvidence: [
              `[package.json:L1-L1] Batch ${retryCalls} verified (${req.useHeavyCloudModel ? 'heavy' : 'std'}).`
            ],
            overallConfidence: 'LOW'
          } as never,
          rawText: '{}',
          statusIndicator: 'CLOUD',
          sdkInferenceSource: null,
          requestedMode: InferenceMode.PREFER_IN_CLOUD,
          modelIdentifier: req.useHeavyCloudModel ? 'gemini-4-hydrogen' : 'gemini-3.5-flash-lite',
          executedAt: new Date().toISOString(),
          durationMs: 300,
          fallbackOccurred: false
        };
      }
    });

    const rawFetchesAfterRetry = fetchMock.mock.calls.filter(([u]) =>
      String(u).startsWith('https://raw.githubusercontent.com/')
    ).length;

    // Batch 1 (4 raw files) was reused from RAM cache; only README (discovery) + Batch 2 (4 files) = 5 raw fetches
    expect(rawFetchesAfterRetry - rawFetchesBeforeRetry).toBe(5);
    expect(retryCalls).toBe(2);
    expect(retriedRun.auditStatus).toBe('COMPLETED');
    expect(retriedRun.report.auditStatus).toBe('COMPLETED');
    expect(retriedRun.batchesCompleted).toBe(2);
    expect(retriedRun.repoInspection.inspectedFiles).toHaveLength(8);
  });

  it('tracks Stage 2/4 skipped when commit SHA is unavailable and renders distinct COMPLETED/PARTIAL/INTERRUPTED/FAILED badges', async () => {
    const files5 = buildLargeRepoTree(5);
    const baseFetch = stubGitHubRepoFetch(files5);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/commits/main')) {
          return new Response('Forbidden', { status: 403 });
        }
        if (url.startsWith('https://raw.githubusercontent.com/acme/large-82-app/main/')) {
          const path = decodeURIComponent(
            url.replace('https://raw.githubusercontent.com/acme/large-82-app/main/', '')
          );
          const f = files5.find((x) => x.path === path);
          return f ? new Response(f.content, { status: 200 }) : new Response('Not Found', { status: 404 });
        }
        return baseFetch(input);
      })
    );

    let sawCiSkipped = false;
    const noShaResult = await runResumableJudgeAnalysis({
      submission: baseSubmission,
      hackathon: baseHackathon,
      locale: 'en',
      aiMode: InferenceMode.PREFER_IN_CLOUD,
      cloudConsentGranted: true,
      explicitGeminiAuthorized: true,
      batchFilesLimit: 10,
      onProgress: (p) => {
        if (p.stageStatus?.ci === 'skipped') {
          sawCiSkipped = true;
        }
      },
      runInferenceFn: async () => ({
        ok: true,
        data: { verifiedEvidence: [], overallConfidence: 'LOW' } as never,
        rawText: '{}',
        statusIndicator: 'CLOUD',
        sdkInferenceSource: null,
        requestedMode: InferenceMode.PREFER_IN_CLOUD,
        modelIdentifier: 'gemini-4-hydrogen',
        executedAt: new Date().toISOString(),
        durationMs: 100,
        fallbackOccurred: false
      })
    });

    expect(sawCiSkipped).toBe(true);
    expect(noShaResult.stageStatus.ci).toBe('skipped');
    expect(noShaResult.ciCheckNote).toContain('Commit SHA unavailable');
    expect(noShaResult.report.sectionE_tests.honestyNote).toContain('Commit SHA unavailable');

    for (const status of ['COMPLETED', 'PARTIAL', 'INTERRUPTED', 'FAILED'] as const) {
      const html = renderToStaticMarkup(
        createElement(ComprehensiveEvidencePanel, {
          report: {
            ...noShaResult.report,
            auditStatus: status,
            auditStatusReason: `Simulated ${status} state`
          },
          locale: 'en'
        })
      );
      expect(html).toContain(`Audit: ${status}`);
    }
  });

  it('Case G & J: normalizes paths without collapsing distinct SHAs, reconciles 5-state file & batch counts, and reports 0/N Batch-1 failure as README-only', async () => {
    const { normalizeRepoPath } = await import('../../src/services/github/repoInspector');
    expect(normalizeRepoPath('./src\\api//webhook.ts')).toBe('src/api/webhook.ts');

    // Repo with distinct files that happen to share filenames across directories (must NOT collapse) + 1 mirror dir + README + tests
    const files: Array<{ path: string; size: number; sha: string; content: string }> = [
      { path: 'README.md', size: 120, sha: 'sha_readme', content: '# Rizq AI Payments\nOverview.' },
      { path: 'package.json', size: 180, sha: 'sha_pkg', content: '{"name":"rizq","scripts":{"test":"vitest run"},"devDependencies":{"vitest":"^3.0.0"}}' },
      { path: 'src/pay.ts', size: 150, sha: 'sha_pay_v1', content: 'export const v1 = 1;' },
      { path: 'src/v2/pay.ts', size: 160, sha: 'sha_pay_v2', content: 'export const v2 = 2;' },
      { path: 'GITHUB_UPLOAD/src/pay.ts', size: 150, sha: 'sha_pay_v1', content: 'export const v1 = 1;' },
      { path: 'tests/pay.test.ts', size: 120, sha: 'sha_test', content: 'it("works", () => expect(1).toBe(1));' }
    ];
    for (let i = 0; i < 6; i++) {
      files.push({
        path: `src/services/svc_${i}.ts`,
        size: 100,
        sha: `sha_svc_${i}`,
        content: `export const s${i} = ${i};`
      });
    }

    stubGitHubRepoFetch(files, { commitSha: 'abcf33db0205e826' });

    // Batch 1 fails with HTTP 500 -> 0 batches completed across 3 planned batches
    const zeroBatchFail = await runResumableJudgeAnalysis({
      submission: baseSubmission,
      hackathon: baseHackathon,
      locale: 'en',
      aiMode: InferenceMode.PREFER_IN_CLOUD,
      cloudConsentGranted: true,
      explicitGeminiAuthorized: true,
      batchFilesLimit: 4,
      batchCharsLimit: 50_000,
      runInferenceFn: async () => ({
        ok: false,
        data: null,
        rawText: '',
        statusIndicator: 'FAILED',
        sdkInferenceSource: null,
        requestedMode: InferenceMode.PREFER_IN_CLOUD,
        modelIdentifier: 'gemini-4-hydrogen',
        requestedModelIdentifier: 'gemini-4-hydrogen',
        executedAt: new Date().toISOString(),
        durationMs: 250,
        fallbackOccurred: false,
        failureCategory: 'transient_overload',
        retryAttempts: 2,
        errorMessage: 'HTTP 500: high demand'
      })
    });

    // Distinct SHAs src/pay.ts & src/v2/pay.ts are both selected (only GITHUB_UPLOAD/src/pay.ts is deduped)
    const selectedPaths = zeroBatchFail.checkpoint?.batchPlanPaths.flat() || [];
    expect(selectedPaths).toContain('src/pay.ts');
    expect(selectedPaths).toContain('src/v2/pay.ts');
    expect(selectedPaths).not.toContain('GITHUB_UPLOAD/src/pay.ts');

    // Counter invariants & honest 0-source-file reporting
    const cov = zeroBatchFail.report.sectionB_coverage;
    expect(cov.inspectedSourceFilesCount).toBe(0);
    expect(cov.readmeInspected).toBe(true);
    expect(cov.batchesCompleted).toBe(0);
    expect((cov.batchesCompleted ?? 0) + (cov.batchesPendingCount ?? 0)).toBe(cov.batchesTotal);
    expect(cov.batchesPendingCount).toBe(cov.batchesTotal);
    expect(
      cov.fullyInspectedCount +
        cov.partiallyInspectedCount +
        cov.skippedCount +
        cov.inaccessibleCount +
        cov.failedCount
    ).toBe(cov.totalFilesInTree);
    expect(zeroBatchFail.repoInspection.reason).toContain('0 source files audited');
    expect(zeroBatchFail.repoInspection.reason).not.toContain('no eligible source files');

    const covHtml = renderToStaticMarkup(
      createElement(ComprehensiveEvidencePanel, {
        report: zeroBatchFail.report,
        locale: 'en',
        initialTab: 'coverage'
      })
    );
    expect(covHtml).toContain('0 source files (README only)');
    expect(covHtml).toContain(`${cov.batchesPendingCount} pending`);
  });

  it('Case M & N: coalesces concurrent runs for same submission via mutex and preserves prior checkpoint if Restart Fresh fails at 0 batches', async () => {
    const files8 = buildLargeRepoTree(9); // 1 README + 8 eligible = 2 batches of 4
    stubGitHubRepoFetch(files8, { commitSha: 'commit_mutex_fresh_1' });

    // 1. Seed a concurrent invocation test: Run 1 & Run 2 overlap in-flight -> each batch runs strictly once (2 calls total, not 4!)
    let batchCalls = 0;
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 25));

    const runPromiseA = runResumableJudgeAnalysis({
      submission: baseSubmission,
      hackathon: baseHackathon,
      locale: 'en',
      aiMode: InferenceMode.PREFER_IN_CLOUD,
      cloudConsentGranted: true,
      explicitGeminiAuthorized: true,
      batchFilesLimit: 4,
      batchCharsLimit: 50_000,
      runInferenceFn: async (req) => {
        batchCalls += 1;
        expect(req.useHeavyCloudModel).toBe(true);
        expect(req.preferredMode).toBe(InferenceMode.ONLY_IN_CLOUD);
        expect(req.maxTransientRetries).toBe(0);
        expect(req.disableModelFallback).toBe(true);
        await gate;
        if (batchCalls === 2) {
          // Simulate interruption after Batch 1 completes so we have a real completedBatches=1 checkpoint!
          return {
            ok: false,
            data: null,
            rawText: '',
            statusIndicator: 'FAILED',
            sdkInferenceSource: null,
            requestedMode: InferenceMode.ONLY_IN_CLOUD,
            modelIdentifier: 'gemini-4-hydrogen',
            requestedModelIdentifier: 'gemini-4-hydrogen',
            executedAt: new Date().toISOString(),
            durationMs: 100,
            fallbackOccurred: false,
            failureCategory: 'transient_overload',
            errorMessage: 'Batch 2 overloaded'
          };
        }
        return {
          ok: true,
          data: {
            verifiedEvidence: ['[package.json:L1-L1] Batch 1 ok'],
            overallConfidence: 'LOW'
          } as never,
          rawText: '{}',
          statusIndicator: 'CLOUD',
          sdkInferenceSource: null,
          requestedMode: InferenceMode.ONLY_IN_CLOUD,
          modelIdentifier: 'gemini-4-hydrogen',
          requestedModelIdentifier: 'gemini-4-hydrogen',
          executedAt: new Date().toISOString(),
          durationMs: 100,
          fallbackOccurred: false
        };
      }
    });

    const runPromiseB = runResumableJudgeAnalysis({
      submission: baseSubmission,
      hackathon: baseHackathon,
      locale: 'en',
      aiMode: InferenceMode.PREFER_IN_CLOUD,
      cloudConsentGranted: true,
      explicitGeminiAuthorized: true,
      batchFilesLimit: 4,
      batchCharsLimit: 50_000,
      runInferenceFn: async () => {
        throw new Error('Concurrent call must coalesce via mutex rather than invoking inference twice');
      }
    });

    const [resA, resB] = await Promise.all([runPromiseA, runPromiseB]);
    expect(batchCalls).toBe(2);
    expect(resA).toBe(resB);
    expect(resA.batchesCompleted).toBe(1);
    expect(resA.checkpoint?.auditSessionId).toBeTruthy();
    expect(resA.checkpoint?.pendingBatchIndices).toEqual([1]);
    expect(resA.checkpoint?.lastSuccessfulMarker).toBe('batch_1_of_2');
    expect(resA.checkpoint?.fileProcessingStates).toBeDefined();

    // 2. Now invoke Restart Fresh (resumeIfAvailable: false) which immediately fails at Batch 1 (0 completed batches)
    const freshFail = await runResumableJudgeAnalysis({
      submission: baseSubmission,
      hackathon: baseHackathon,
      locale: 'en',
      aiMode: InferenceMode.PREFER_IN_CLOUD,
      cloudConsentGranted: true,
      explicitGeminiAuthorized: true,
      batchFilesLimit: 4,
      batchCharsLimit: 50_000,
      resumeIfAvailable: false,
      runInferenceFn: async () => ({
        ok: false,
        data: null,
        rawText: '',
        statusIndicator: 'FAILED',
        sdkInferenceSource: null,
        requestedMode: InferenceMode.ONLY_IN_CLOUD,
        modelIdentifier: 'gemini-4-hydrogen',
        requestedModelIdentifier: 'gemini-4-hydrogen',
        executedAt: new Date().toISOString(),
        durationMs: 100,
        fallbackOccurred: false,
        failureCategory: 'transient_overload',
        errorMessage: 'Fresh run failed at Batch 1'
      })
    });

    // Prior checkpoint with completedBatches=1 MUST be preserved on disk and recoverable
    expect(freshFail.resumable).toBe(true);
    const restoredCkpt = getSavedAnalysisCheckpoint(baseSubmission.id);
    expect(restoredCkpt).not.toBeNull();
    expect(restoredCkpt?.completedBatches).toBe(1);
    expect(restoredCkpt?.commitSha).toBe('commit_mutex_fresh_1');
  });

  it('disables Gemini calls completely when explicitGeminiAuthorized is false or collectEvidenceOnly is true, and enforces cloudConsentGranted when authorized', async () => {
    const files8 = buildLargeRepoTree(9); // 1 README + 8 eligible = 2 batches of 4
    stubGitHubRepoFetch(files8, { commitSha: 'commit_legacy_ro_1', withPassingCi: true });

    const spyInference = vi.fn().mockRejectedValue(new Error('Must never be invoked'));

    // 1. Default (explicitGeminiAuthorized omitted / collectEvidenceOnly: true) -> 0 Gemini calls, full repo evidence collected
    const evidenceOnlyRun = await runResumableJudgeAnalysis({
      submission: baseSubmission,
      hackathon: baseHackathon,
      locale: 'en',
      aiMode: InferenceMode.PREFER_ON_DEVICE,
      cloudConsentGranted: true,
      collectEvidenceOnly: true,
      batchFilesLimit: 4,
      batchCharsLimit: 50_000,
      runInferenceFn: spyInference
    });

    expect(spyInference).not.toHaveBeenCalled();
    expect(evidenceOnlyRun.auditStatus).toBe('COMPLETED');
    expect(evidenceOnlyRun.batchesCompleted).toBe(2);
    expect(evidenceOnlyRun.repoInspection.inspectedFiles.length).toBe(8);
    expect(evidenceOnlyRun.stageStatus.audit).toBe('skipped');
    expect(evidenceOnlyRun.mergedAiOutput).toBeNull();

    // 2. explicitGeminiAuthorized: true with cloudConsentGranted: false -> blocks BEFORE runInferenceFn
    clearAllAnalysisMemoryCaches();
    clearAnalysisCheckpoint(baseSubmission.id);
    const noConsentRun = await runResumableJudgeAnalysis({
      submission: baseSubmission,
      hackathon: baseHackathon,
      locale: 'en',
      aiMode: InferenceMode.PREFER_IN_CLOUD,
      cloudConsentGranted: false,
      explicitGeminiAuthorized: true,
      batchFilesLimit: 4,
      batchCharsLimit: 50_000,
      runInferenceFn: spyInference
    });

    expect(spyInference).not.toHaveBeenCalled();
    expect(noConsentRun.auditStatus).toBe('FAILED');
    expect(noConsentRun.aiResult?.failureCategory).toBe('consent');
  });
});


