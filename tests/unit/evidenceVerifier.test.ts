import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  buildComprehensiveJudgingReport,
  capStatusByEvidence,
  detectProjectStrategies,
  fetchPublicGitHubActionsRuns,
  normalizeVerificationStatus,
  parseExecutedTestEvidence,
  validateAndNormalizeAIAuditOutput,
  verifyPublicDemoSafely
} from '../../src/services/judging/evidenceVerifier';
import { ComprehensiveEvidencePanel } from '../../src/components/judging/ComprehensiveEvidencePanel';
import type { GitHubRepoInspection } from '../../src/services/github/repoInspector';
import type { Hackathon, ProjectSubmission } from '../../src/types/domain';

describe('Evidence Verifier Engine — Strategies, Demo Probe, Tests & Status Ceilings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const hackathon: Hackathon = {
    id: 'h1',
    organizerId: 'org1',
    organizerName: 'Organizer',
    title: 'FinTech & AI Hack',
    tagline: '',
    description: '',
    coverImageUrl: '',
    startDate: '2026-11-01',
    endDate: '2026-11-30',
    registrationDeadline: '2026-11-10',
    submissionDeadline: '2026-11-25T23:59:59Z',
    mode: 'online',
    location: '',
    tracks: ['FinTech'],
    technologies: ['TypeScript', 'PayPal'],
    eligibility: 'Open team challenge',
    rules: 'Public repo required',
    prizes: [],
    sponsors: [],
    rubric: [
      { id: 'r_tech', name: 'Technical Implementation', description: 'Code quality & security', weight: 50 },
      { id: 'r_ux', name: 'User Experience', description: 'Polish', weight: 50 }
    ],
    maxTeamSize: 4,
    status: 'judging',
    resultsPublished: false
  };

  it('detects payment, AI, data-driven, and security strategies from submission and repo metadata', () => {
    const strategies = detectProjectStrategies({
      title: 'Rizq AI Payments',
      proposedSolution: 'PayPal invoice settlement with Gemini narrative and Supabase RLS',
      technologies: ['PayPal', 'Gemini', 'Supabase', 'Qloo']
    });
    expect(strategies).toEqual(
      expect.arrayContaining(['payments', 'ai', 'data_driven', 'security_auth'])
    );
  });

  it('never marks PRODUCTION_CONFIRMED from HTTP 200 GET alone and marks CORS blocks honestly', async () => {
    const okFetch = vi.fn(async () => new Response('<html><title>Rizq App</title></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    }));
    vi.stubGlobal('fetch', okFetch);

    const http200Check = await verifyPublicDemoSafely('https://rizq.example.app');
    expect(http200Check.reachable).toBe(true);
    expect(http200Check.httpStatus).toBe(200);
    expect(http200Check.status).not.toBe('PRODUCTION_CONFIRMED');
    expect(http200Check.status).toBe('UNVERIFIED');
    expect(http200Check.summary).toContain('does NOT confirm');
    expect(http200Check.blockedAspects.join(' ')).toContain('UNVERIFIED');

    const corsFetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch (CORS)');
    });
    vi.stubGlobal('fetch', corsFetch);
    const corsCheck = await verifyPublicDemoSafely('https://blocked.example.app');
    expect(corsCheck.status).toBe('BLOCKED');
    expect(corsCheck.corsBlocked).toBe(true);
  });

  it('distinguishes discovered test files (UNVERIFIED until executed) from passing CI logs (TEST_CONFIRMED) and prevents AI status inflation', async () => {
    const repoInspection: GitHubRepoInspection = {
      accessible: true,
      repoFullName: 'example/rizq-ai-payments',
      defaultBranch: 'main',
      commitSha: 'abc1234def5678',
      description: 'PayPal SME payments',
      primaryLanguage: 'TypeScript',
      stars: 5,
      updatedAt: '2026-11-19T00:00:00Z',
      readmeExcerpt: '# Rizq\nClaimed 99.99% live settlement.',
      readmeFullChars: 38,
      readmeTruncated: false,
      treeDiscoveryMethod: 'git_trees',
      treeTruncated: false,
      totalFilesInTree: 3,
      treeSamplePaths: ['api/paypal/webhook.ts', 'tests/webhook.test.ts', 'package.json'],
      inspectedFiles: [
        {
          path: 'api/paypal/webhook.ts',
          category: 'payments_paypal',
          sizeBytes: 300,
          charsIncluded: 180,
          totalLines: 5,
          truncated: false,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 1,
          chunks: [
            {
              startLine: 1,
              endLine: 5,
              content:
                'const secret = "[REDACTED_SECRET]";\nexport function handle(req) { return req.headers.get("paypal-transmission-sig"); }'
            }
          ],
          excerpt:
            'const secret = "[REDACTED_SECRET]";\nexport function handle(req) { return req.headers.get("paypal-transmission-sig"); }'
        },
        {
          path: 'tests/webhook.test.ts',
          category: 'tests',
          sizeBytes: 120,
          charsIncluded: 80,
          totalLines: 2,
          truncated: false,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 0,
          chunks: [{ startLine: 1, endLine: 2, content: 'it("works", () => expect(true).toBe(true));' }],
          excerpt: 'it("works", () => expect(true).toBe(true));'
        }
      ],
      uninspectedImportantFiles: [],
      fileInventory: [
        {
          path: 'api/paypal/webhook.ts',
          category: 'payments_paypal',
          sizeBytes: 300,
          inspectionStatus: 'inspected',
          reason: 'inspected_complete'
        },
        {
          path: 'tests/webhook.test.ts',
          category: 'tests',
          sizeBytes: 120,
          inspectionStatus: 'inspected',
          reason: 'inspected_complete'
        },
        {
          path: 'package.json',
          category: 'config_security',
          sizeBytes: 200,
          inspectionStatus: 'skipped',
          reason: 'budget_limit'
        }
      ],
      duplicateFileGroups: [],
      projectRoots: [{ rootPath: '.', manifestFiles: ['package.json'], fileCount: 3, matchScore: 70, selectedAsPrimary: true, reason: 'root' }],
      hasDivergentRoots: false,
      batchesProcessed: 1,
      detectedCategories: ['payments_paypal', 'tests'],
      redactedSecretsCount: 1,
      rateLimitRemaining: 50,
      aborted: false,
      reason: 'Inspected 2 files'
    };

    const submission: Partial<ProjectSubmission> = {
      id: 'sub_rizq',
      title: 'Rizq AI Payments',
      track: 'FinTech',
      memberIds: ['u1', 'u2'],
      technologies: ['TypeScript', 'PayPal'],
      submittedAt: '2026-11-20T12:00:00Z'
    };

    // Case 1: No executed test logs attached -> AI tries to claim PRODUCTION_CONFIRMED / TEST_CONFIRMED, verifier MUST cap it!
    const reportNoExecTests = buildComprehensiveJudgingReport({
      submission,
      hackathon,
      repoInspection,
      liveDemoCheck: {
        demoUrl: '',
        checkedAt: '2026-11-20T12:00:00Z',
        reachable: false,
        httpStatus: null,
        corsBlocked: false,
        requiresAuth: false,
        checkedAspects: [],
        blockedAspects: [],
        status: 'UNVERIFIED',
        summary: 'No demo URL'
      },
      executedTests: [],
      aiOutput: {
        requirementEvaluations: [
          { requirementId: 'r_tech', status: 'PRODUCTION_CONFIRMED', summary: 'Looks great' }
        ],
        inspectedSources: ['api/paypal/webhook.ts', 'nonexistent/hallucinated.ts']
      }
    });

    expect(reportNoExecTests.sectionE_tests.summaryStatus).toBe('UNVERIFIED');
    expect(reportNoExecTests.sectionE_tests.honestyNote).toContain('NO executed test');
    expect(reportNoExecTests.sectionB_coverage.hasFullCoverage).toBe(false);
    expect(reportNoExecTests.sectionG_security.findings.some((f) => f.id === 'sec_paypal_header_only')).toBe(true);
    expect(reportNoExecTests.sectionG_security.findings.some((f) => f.id === 'sec_hardcoded_secrets')).toBe(true);
    const techMatrixRow = reportNoExecTests.sectionC_matrix.find((r) => r.requirementId === 'r_tech');
    expect(techMatrixRow?.finalStatus).toBe('CODE_CONFIRMED');
    expect(reportNoExecTests.sectionK_confidence.limitations.join(' ')).toContain('hallucinated.ts');

    // Case 2: Self-reported pasted Vitest log stays UNVERIFIED (never TEST_CONFIRMED);
    // only commit-pinned GitHub Actions CI run achieves TEST_CONFIRMED.
    const selfReportedLogs = parseExecutedTestEvidence(
      '$ npm test\nTest Files  4 passed (4)\nTests  18 passed (18)',
      { expectedCommitSha: 'abc1234def5678' }
    );
    expect(selfReportedLogs[0].status).toBe('UNVERIFIED');
    expect(selfReportedLogs[0].matchesInspectedCommit).toBe(false);
    expect(selfReportedLogs[0].source).toBe('user_attached_ci_log');

    const reportWithSelfReportedLogs = buildComprehensiveJudgingReport({
      submission,
      hackathon,
      repoInspection,
      liveDemoCheck: reportNoExecTests.sectionF_liveDemo,
      executedTests: selfReportedLogs,
      aiOutput: {
        requirementEvaluations: [
          {
            requirementId: 'r_tech',
            status: 'TEST_CONFIRMED',
            evidenceCitations: ['api/paypal/webhook.ts:L1-L5'],
            summary: 'Self-reported log attached'
          }
        ]
      }
    });
    expect(reportWithSelfReportedLogs.sectionE_tests.summaryStatus).toBe('UNVERIFIED');
    expect(
      reportWithSelfReportedLogs.sectionC_matrix.find((r) => r.requirementId === 'r_tech')?.finalStatus
    ).toBe('CODE_CONFIRMED');

    const reportWithVerifiedCi = buildComprehensiveJudgingReport({
      submission,
      hackathon,
      repoInspection,
      liveDemoCheck: reportNoExecTests.sectionF_liveDemo,
      executedTests: [
        {
          id: 'gh_actions_202',
          command: 'GitHub Actions: CI',
          scope: 'Verified test job "unit-tests" passed on commit abc1234',
          exitCode: 0,
          stdoutExcerpt: 'Remote CI workflow passed on abc1234.',
          timestamp: '2026-11-20T12:00:00Z',
          source: 'github_actions_metadata',
          status: 'TEST_CONFIRMED',
          headSha: 'abc1234def5678',
          headBranch: 'main',
          matchesInspectedCommit: true
        }
      ],
      aiOutput: {
        requirementEvaluations: [
          {
            requirementId: 'r_tech',
            status: 'TEST_CONFIRMED',
            evidenceCitations: ['api/paypal/webhook.ts:L1-L5'],
            summary: 'Verified with commit-pinned CI test job'
          }
        ]
      }
    });
    expect(reportWithVerifiedCi.sectionE_tests.summaryStatus).toBe('TEST_CONFIRMED');
    expect(reportWithVerifiedCi.sectionC_matrix.find((r) => r.requirementId === 'r_tech')?.finalStatus).toBe(
      'TEST_CONFIRMED'
    );
  });

  it('rejects unknown AI status values, blocks CODE_CONFIRMED when no files are inspected, and requires code proof for mandatory technologies', () => {
    expect(normalizeVerificationStatus('FAKE_CONFIRMED')).toBe('UNVERIFIED');
    expect(normalizeVerificationStatus('PASSED')).toBe('UNVERIFIED');
    expect(
      capStatusByEvidence('CODE_CONFIRMED', {
        hasInspectedFiles: false,
        hasPassingExecutedTest: false,
        hasRuntimeConfirmation: false
      })
    ).toBe('UNVERIFIED');
    expect(
      capStatusByEvidence('INVENTED_STATUS', {
        hasInspectedFiles: true,
        hasPassingExecutedTest: true,
        hasRuntimeConfirmation: true
      })
    ).toBe('UNVERIFIED');

    // Repo is accessible with a generic file that lacks PayPal/TypeScript proof, even though submission.technologies claims them
    const emptyProofRepo: GitHubRepoInspection = {
      accessible: true,
      repoFullName: 'example/claim-only',
      defaultBranch: 'main',
      commitSha: '1122334455667788',
      commitShaVerified: true,
      description: 'Claim-only project',
      primaryLanguage: 'JavaScript',
      stars: 0,
      updatedAt: '2026-11-20T00:00:00Z',
      readmeExcerpt: '# Claim-only',
      readmeFullChars: 12,
      readmeTruncated: false,
      treeDiscoveryMethod: 'git_trees',
      treeTruncated: false,
      totalFilesInTree: 1,
      treeSamplePaths: ['src/notes.js'],
      inspectedFiles: [
        {
          path: 'src/notes.js',
          category: 'frontend_source',
          sizeBytes: 40,
          charsIncluded: 40,
          totalLines: 1,
          truncated: false,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 0,
          chunks: [{ startLine: 1, endLine: 1, content: 'export const hello = "world";' }],
          excerpt: 'export const hello = "world";'
        }
      ],
      uninspectedImportantFiles: [],
      fileInventory: [
        {
          path: 'src/notes.js',
          category: 'frontend_source',
          sizeBytes: 40,
          inspectionStatus: 'inspected',
          reason: 'inspected_complete'
        }
      ],
      duplicateFileGroups: [],
      projectRoots: [],
      hasDivergentRoots: false,
      batchesProcessed: 1,
      detectedCategories: ['frontend_source'],
      redactedSecretsCount: 0,
      rateLimitRemaining: 50,
      aborted: false,
      reason: 'Inspected 1 file'
    };

    const report = buildComprehensiveJudgingReport({
      submission: {
        id: 'sub_claim',
        title: 'Claim Only',
        track: 'FinTech',
        memberIds: ['u1'],
        technologies: ['TypeScript', 'PayPal'],
        submittedAt: '2026-11-20T12:00:00Z'
      },
      hackathon,
      repoInspection: emptyProofRepo,
      liveDemoCheck: {
        demoUrl: '',
        checkedAt: '2026-11-20T12:00:00Z',
        reachable: false,
        httpStatus: null,
        corsBlocked: false,
        requiresAuth: false,
        checkedAspects: [],
        blockedAspects: [],
        status: 'UNVERIFIED',
        summary: 'No demo'
      },
      aiOutput: {
        requirementEvaluations: [
          { requirementId: 'tech_stack', status: 'CODE_CONFIRMED', summary: 'Submission lists PayPal' },
          { requirementId: 'r_tech', status: 'CUSTOM_BAD_STATUS' as never, summary: 'Invalid enum' }
        ]
      }
    });

    const techRow = report.sectionC_matrix.find((r) => r.requirementId === 'tech_stack');
    expect(techRow?.finalStatus).toBe('UNVERIFIED');
    expect(techRow?.staticCodeEvidence.join(' ')).toContain('submission metadata tags alone do NOT count');
    expect(report.sectionC_matrix.find((r) => r.requirementId === 'r_tech')?.finalStatus).toBe(
      'UNVERIFIED'
    );
  });

  it('refuses TEST_CONFIRMED for build/lint logs and zero-test outputs, and discloses unverified commit provenance', () => {
    const buildLog = parseExecutedTestEvidence(
      '$ npm run build\nvite v6.0.0 building for production...\ndist/index.js 120 kB\nbuilt in 1.42s\n0 errors\nexit code: 0',
      { expectedCommitSha: 'abcdef1234567890' }
    );
    expect(buildLog[0].status).toBe('UNVERIFIED');
    expect(buildLog[0].scope).toContain('Build/lint output only');
    expect(buildLog[0].scope).toContain('cannot be cryptographically tied to inspected commit abcdef1');
    expect(buildLog[0].matchesInspectedCommit).toBe(false);

    const eslintLog = parseExecutedTestEvidence('$ eslint src\n0 errors\nexit code: 0');
    expect(eslintLog[0].status).toBe('UNVERIFIED');

    const zeroTestsVitest = parseExecutedTestEvidence(
      '$ npx vitest run\nTest Files  0 passed (0)\nTests  0 passed (0)'
    );
    expect(zeroTestsVitest[0].status).toBe('UNVERIFIED');

    const zeroTestsPytest = parseExecutedTestEvidence('$ pytest\ncollected 0 items');
    expect(zeroTestsPytest[0].status).toBe('UNVERIFIED');
  });

  it('pins GitHub Actions verification strictly to expectedCommitSha, ignores deploy/lint workflows, and requires verified test job', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/actions/runs?head_sha=deadbeef1234')) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              // Different commit must be ignored
              {
                id: 100,
                name: 'CI Tests',
                path: '.github/workflows/test.yml',
                status: 'completed',
                conclusion: 'success',
                head_sha: 'othercommit9999',
                head_branch: 'main',
                updated_at: '2026-11-20T01:00:00Z'
              },
              // Deploy-only workflow on same commit must be skipped
              {
                id: 101,
                name: 'Deploy Firebase Hosting',
                path: '.github/workflows/deploy.yml',
                status: 'completed',
                conclusion: 'success',
                head_sha: 'deadbeef1234',
                head_branch: 'main',
                updated_at: '2026-11-20T02:00:00Z'
              },
              // CI workflow with passing test job
              {
                id: 102,
                name: 'CI',
                path: '.github/workflows/ci.yml',
                status: 'completed',
                conclusion: 'success',
                head_sha: 'deadbeef1234',
                head_branch: 'main',
                updated_at: '2026-11-20T03:00:00Z'
              },
              // CI workflow whose jobs endpoint fails -> must downgrade to UNVERIFIED
              {
                id: 103,
                name: 'Verification Suite',
                path: '.github/workflows/verify.yml',
                status: 'completed',
                conclusion: 'success',
                head_sha: 'deadbeef1234',
                head_branch: 'main',
                updated_at: '2026-11-20T04:00:00Z'
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes('/actions/runs/102/jobs')) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                name: 'unit-tests',
                conclusion: 'success',
                steps: [{ name: 'Run vitest', conclusion: 'success' }]
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes('/actions/runs/103/jobs')) {
        return new Response('Rate Limited', { status: 403 });
      }
      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    // Without expectedCommitSha -> returns [] immediately
    const noShaRuns = await fetchPublicGitHubActionsRuns('https://github.com/acme/repo');
    expect(noShaRuns).toEqual([]);

    const runs = await fetchPublicGitHubActionsRuns('https://github.com/acme/repo', {
      expectedCommitSha: 'deadbeef1234'
    });
    expect(runs).toHaveLength(2);
    expect(runs.some((r) => r.id === 'gh_actions_100')).toBe(false);
    expect(runs.some((r) => r.id === 'gh_actions_101')).toBe(false);

    const confirmedRun = runs.find((r) => r.id === 'gh_actions_102');
    expect(confirmedRun?.status).toBe('TEST_CONFIRMED');
    expect(confirmedRun?.headSha).toBe('deadbeef1234');
    expect(confirmedRun?.matchesInspectedCommit).toBe(true);

    const incompleteJobRun = runs.find((r) => r.id === 'gh_actions_103');
    expect(incompleteJobRun?.status).toBe('UNVERIFIED');
  });

  it('rejects fabricated/out-of-bounds AI citations, redacts AI-echoed secrets, and generates requirement-specific line citations', () => {
    const repoInspection: GitHubRepoInspection = {
      accessible: true,
      repoFullName: 'example/multi-chunk',
      defaultBranch: 'main',
      commitSha: 'fedcba9876543210',
      commitShaVerified: true,
      description: 'Multi-chunk app',
      primaryLanguage: 'TypeScript',
      stars: 2,
      updatedAt: '2026-11-20T00:00:00Z',
      readmeExcerpt: '# Multi Chunk',
      readmeFullChars: 13,
      readmeTruncated: false,
      treeDiscoveryMethod: 'git_trees',
      treeTruncated: false,
      totalFilesInTree: 1,
      treeSamplePaths: ['api/paypal/webhook.ts'],
      inspectedFiles: [
        {
          path: 'api/paypal/webhook.ts',
          category: 'payments_paypal',
          sizeBytes: 1200,
          charsIncluded: 400,
          totalLines: 45,
          truncated: true,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 0,
          chunks: [
            { startLine: 1, endLine: 5, content: '// header imports\nimport express from "express";' },
            {
              startLine: 40,
              endLine: 45,
              content:
                'export async function verifyPayPalWebhook(req) {\n  return verifyWebhookSignature(req);\n}'
            }
          ],
          excerpt: '// truncated'
        }
      ],
      uninspectedImportantFiles: [],
      fileInventory: [
        {
          path: 'api/paypal/webhook.ts',
          category: 'payments_paypal',
          sizeBytes: 1200,
          inspectionStatus: 'partially_inspected',
          reason: 'inspected_chunked',
          chunks: [
            { startLine: 1, endLine: 5 },
            { startLine: 40, endLine: 45 }
          ]
        }
      ],
      duplicateFileGroups: [],
      projectRoots: [],
      hasDivergentRoots: false,
      batchesProcessed: 1,
      detectedCategories: ['payments_paypal'],
      redactedSecretsCount: 0,
      rateLimitRemaining: 50,
      aborted: false,
      reason: 'Inspected 1 file'
    };

    const report = buildComprehensiveJudgingReport({
      submission: {
        id: 'sub_cite',
        title: 'Multi Chunk PayPal',
        track: 'FinTech',
        memberIds: ['u1'],
        technologies: ['TypeScript', 'PayPal'],
        submittedAt: '2026-11-20T12:00:00Z'
      },
      hackathon,
      repoInspection,
      liveDemoCheck: {
        demoUrl: '',
        checkedAt: '2026-11-20T12:00:00Z',
        reachable: false,
        httpStatus: null,
        corsBlocked: false,
        requiresAuth: false,
        checkedAspects: [],
        blockedAspects: [],
        status: 'UNVERIFIED',
        summary: 'No demo'
      },
      aiOutput: {
        verifiedEvidence: [
          '[api/paypal/webhook.ts:L40-L42] Verified handler.',
          '[fake/ghost.ts:L1-L5] Hallucinated secret AKIA1234567890ABCDEF',
          '[api/paypal/webhook.ts:L900-L920] Out of bounds line citation'
        ],
        requirementEvaluations: [
          {
            requirementId: 'r_tech',
            status: 'CODE_CONFIRMED',
            evidenceCitations: ['api/paypal/webhook.ts:L900-L920'],
            summary: 'Uses unquoted TOKEN=secretval987654'
          }
        ],
        teamClaims: ['Echoes TOKEN=secretval987654'],
        securityFindings: [
          {
            severity: 'high',
            location: 'fake/nonexistent.ts:L1-L10',
            finding: 'Leaked postgres://admin:SecretPass99@db.local:5432/prod',
            mitigation: 'Remove credential'
          }
        ]
      }
    });

    // Fabricated or out-of-bounds citations must be dropped from verifiedEvidence
    expect(report.verifiedEvidence.some((e) => e.includes('[api/paypal/webhook.ts:L40-L42]'))).toBe(true);
    expect(report.verifiedEvidence.some((e) => e.includes('fake/ghost.ts'))).toBe(false);
    expect(report.verifiedEvidence.some((e) => e.includes('L900-L920'))).toBe(false);
    // Out-of-bounds requirement citation must downgrade AI row to UNVERIFIED
    expect(report.sectionC_matrix.find((r) => r.requirementId === 'r_tech')?.finalStatus).toBe(
      'UNVERIFIED'
    );
    // Unverified security location must NOT be marked CONTRADICTED, and DB password must be redacted
    const aiSec = report.sectionG_security.findings.find((f) => f.id.startsWith('ai_sec_'));
    expect(aiSec?.status).toBe('UNVERIFIED');
    expect(aiSec?.evidenceSource).toBe('unverified_ai_location');
    expect(aiSec?.observedResult).not.toContain('SecretPass99');
    expect(report.teamClaims.join(' ')).not.toContain('secretval987654');
    expect(report.sectionK_confidence.limitations.join(' ')).toContain('Rejected');

    // Requirement-specific citation for tech_stack (mentions PayPal) should hit chunk 2 (L40-L42), not L1-L5
    const techMatrixRow = report.sectionC_matrix.find((r) => r.requirementId === 'tech_stack');
    expect(techMatrixRow?.relevantFiles[0]?.startLine).toBe(40);
  });

  it('defaults undefined/omitted statuses, textual eligibility/rules, and Section J fallback to UNVERIFIED rather than false CODE_CONFIRMED', () => {
    expect(
      capStatusByEvidence(undefined, {
        hasInspectedFiles: true,
        hasPassingExecutedTest: true,
        hasRuntimeConfirmation: true,
        hasMatchedCodeEvidence: true
      })
    ).toBe('UNVERIFIED');

    const repo: GitHubRepoInspection = {
      accessible: true,
      repoFullName: 'example/basic',
      defaultBranch: 'main',
      commitSha: '1234567890abcdef',
      commitShaVerified: true,
      description: 'Basic app',
      primaryLanguage: 'TypeScript',
      stars: 1,
      updatedAt: '2026-11-20T00:00:00Z',
      readmeExcerpt: '# Basic app',
      readmeFullChars: 11,
      readmeTruncated: false,
      treeDiscoveryMethod: 'git_trees',
      treeTruncated: false,
      totalFilesInTree: 1,
      treeSamplePaths: ['src/app.ts'],
      inspectedFiles: [
        {
          path: 'src/app.ts',
          category: 'frontend_source',
          sizeBytes: 100,
          charsIncluded: 40,
          totalLines: 2,
          truncated: false,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 0,
          chunks: [{ startLine: 1, endLine: 2, content: 'export const app = () => "hello";' }],
          excerpt: 'export const app = () => "hello";'
        }
      ],
      uninspectedImportantFiles: [],
      fileInventory: [
        {
          path: 'src/app.ts',
          category: 'frontend_source',
          sizeBytes: 100,
          inspectionStatus: 'inspected',
          reason: 'inspected_complete'
        }
      ],
      duplicateFileGroups: [],
      projectRoots: [],
      hasDivergentRoots: false,
      batchesProcessed: 1,
      detectedCategories: ['frontend_source'],
      redactedSecretsCount: 0,
      rateLimitRemaining: 50,
      aborted: false,
      reason: 'Inspected 1 file'
    };

    const report = buildComprehensiveJudgingReport({
      submission: {
        id: 'sub_basic',
        title: 'Basic App',
        track: 'FinTech',
        memberIds: ['u1'],
        technologies: ['TypeScript', 'PayPal'],
        submittedAt: '2026-11-20T12:00:00Z'
      },
      hackathon: {
        ...hackathon,
        rules: 'Public repo required\nPre-built closed templates are prohibited.'
      },
      repoInspection: repo,
      liveDemoCheck: {
        demoUrl: '',
        checkedAt: '2026-11-20T12:00:00Z',
        reachable: false,
        httpStatus: null,
        corsBlocked: false,
        requiresAuth: false,
        checkedAspects: [],
        blockedAspects: [],
        status: 'UNVERIFIED',
        summary: 'No demo'
      },
      // AI output omitted completely (aiOutput: null)
      aiOutput: null
    });

    const eligRow = report.sectionC_matrix.find((r) => r.requirementId === 'elig_1');
    const ruleRow = report.sectionC_matrix.find((r) => r.requirementId === 'rule_2');
    const uxRow = report.sectionC_matrix.find((r) => r.requirementId === 'r_ux');
    expect(eligRow?.finalStatus).toBe('UNVERIFIED');
    expect(ruleRow?.finalStatus).toBe('UNVERIFIED');
    expect(uxRow?.finalStatus).toBe('UNVERIFIED');

    const uxObs = report.sectionJ_criterionObservations.find((c) => c.criterionId === 'r_ux');
    expect(uxObs?.status).toBe('UNVERIFIED');
  });

  it('uses strict non-alphanumeric word boundaries and extension mapping for mandatory technologies (no "Go" inside "mongodb")', () => {
    const jsMongoRepo: GitHubRepoInspection = {
      accessible: true,
      repoFullName: 'example/mongo-only',
      defaultBranch: 'main',
      commitSha: 'aaaa1111bbbb2222',
      commitShaVerified: true,
      description: 'Mongo client',
      primaryLanguage: 'TypeScript',
      stars: 0,
      updatedAt: '2026-11-20T00:00:00Z',
      readmeExcerpt: '# App',
      readmeFullChars: 5,
      readmeTruncated: false,
      treeDiscoveryMethod: 'git_trees',
      treeTruncated: false,
      totalFilesInTree: 1,
      treeSamplePaths: ['src/mongodbClient.ts'],
      inspectedFiles: [
        {
          path: 'src/mongodbClient.ts',
          category: 'server_api',
          sizeBytes: 120,
          charsIncluded: 80,
          totalLines: 2,
          truncated: false,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 0,
          chunks: [
            {
              startLine: 1,
              endLine: 2,
              content: 'export const mainDb = "mongodb://localhost/main";\nexport const email = "a@b.c";'
            }
          ],
          excerpt: 'export const mainDb = "mongodb://localhost/main";\nexport const email = "a@b.c";'
        }
      ],
      uninspectedImportantFiles: [],
      fileInventory: [],
      duplicateFileGroups: [],
      projectRoots: [],
      hasDivergentRoots: false,
      batchesProcessed: 1,
      detectedCategories: ['server_api'],
      redactedSecretsCount: 0,
      rateLimitRemaining: 50,
      aborted: false,
      reason: 'Inspected 1 file'
    };

    const goHackathon: Partial<Hackathon> = {
      ...hackathon,
      technologies: ['Go', 'AI']
    };

    const falseSubstrReport = buildComprehensiveJudgingReport({
      submission: {
        id: 'sub_mongo',
        title: 'Mongo App',
        track: 'FinTech',
        memberIds: ['u1'],
        technologies: ['Go', 'AI'],
        submittedAt: '2026-11-20T12:00:00Z'
      },
      hackathon: goHackathon,
      repoInspection: jsMongoRepo,
      liveDemoCheck: {
        demoUrl: '',
        checkedAt: '2026-11-20T12:00:00Z',
        reachable: false,
        httpStatus: null,
        corsBlocked: false,
        requiresAuth: false,
        checkedAspects: [],
        blockedAspects: [],
        status: 'UNVERIFIED',
        summary: 'No demo'
      }
    });

    const techStackFalse = falseSubstrReport.sectionC_matrix.find((r) => r.requirementId === 'tech_stack');
    expect(techStackFalse?.finalStatus).toBe('UNVERIFIED');

    const realGoAiRepo: GitHubRepoInspection = {
      ...jsMongoRepo,
      treeSamplePaths: ['cmd/main.go', 'go.mod'],
      inspectedFiles: [
        {
          path: 'cmd/main.go',
          category: 'server_api',
          sizeBytes: 120,
          charsIncluded: 70,
          totalLines: 2,
          truncated: false,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 0,
          chunks: [{ startLine: 1, endLine: 2, content: 'package main\n// AI worker service' }],
          excerpt: 'package main\n// AI worker service'
        }
      ]
    };

    const realGoReport = buildComprehensiveJudgingReport({
      submission: {
        id: 'sub_go',
        title: 'Go AI App',
        track: 'FinTech',
        memberIds: ['u1'],
        technologies: ['Go', 'AI'],
        submittedAt: '2026-11-20T12:00:00Z'
      },
      hackathon: goHackathon,
      repoInspection: realGoAiRepo,
      liveDemoCheck: {
        demoUrl: '',
        checkedAt: '2026-11-20T12:00:00Z',
        reachable: false,
        httpStatus: null,
        corsBlocked: false,
        requiresAuth: false,
        checkedAspects: [],
        blockedAspects: [],
        status: 'UNVERIFIED',
        summary: 'No demo'
      }
    });

    const techStackReal = realGoReport.sectionC_matrix.find((r) => r.requirementId === 'tech_stack');
    expect(techStackReal?.finalStatus).toBe('CODE_CONFIRMED');
  });

  it('rejects uncited or truncated-gap citations in verifiedEvidence and preserves valid citations alongside UNVERIFIED downgrade on mixed matrix citations', () => {
    const truncatedRepo: GitHubRepoInspection = {
      accessible: true,
      repoFullName: 'example/trunc',
      defaultBranch: 'main',
      commitSha: '1234abcd5678ef00',
      commitShaVerified: true,
      description: 'Truncated test',
      primaryLanguage: 'TypeScript',
      stars: 1,
      updatedAt: '2026-11-20T00:00:00Z',
      readmeExcerpt: '# Truncated',
      readmeFullChars: 11,
      readmeTruncated: false,
      treeDiscoveryMethod: 'git_trees',
      treeTruncated: false,
      totalFilesInTree: 1,
      treeSamplePaths: ['api/paypal/webhook.ts'],
      inspectedFiles: [
        {
          path: 'api/paypal/webhook.ts',
          category: 'payments_paypal',
          sizeBytes: 1500,
          charsIncluded: 300,
          totalLines: 50,
          truncated: true,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 0,
          chunks: [
            { startLine: 1, endLine: 5, content: '// top\nimport crypto from "crypto";' },
            { startLine: 40, endLine: 45, content: 'export function verifyWebhook() { return true; }' }
          ],
          excerpt: '// top'
        }
      ],
      uninspectedImportantFiles: [],
      fileInventory: [],
      duplicateFileGroups: [],
      projectRoots: [],
      hasDivergentRoots: false,
      batchesProcessed: 1,
      detectedCategories: ['payments_paypal'],
      redactedSecretsCount: 0,
      rateLimitRemaining: 50,
      aborted: false,
      reason: 'Inspected 1 file'
    };

    const report = buildComprehensiveJudgingReport({
      submission: {
        id: 'sub_gap',
        title: 'Truncated Citation Test',
        track: 'FinTech',
        memberIds: ['u1'],
        technologies: ['TypeScript', 'PayPal'],
        submittedAt: '2026-11-20T12:00:00Z'
      },
      hackathon,
      repoInspection: truncatedRepo,
      liveDemoCheck: {
        demoUrl: '',
        checkedAt: '2026-11-20T12:00:00Z',
        reachable: false,
        httpStatus: null,
        corsBlocked: false,
        requiresAuth: false,
        checkedAspects: [],
        blockedAspects: [],
        status: 'UNVERIFIED',
        summary: 'No demo'
      },
      aiOutput: {
        verifiedEvidence: [
          'Uncited generic claim with no path or line range',
          '[api/paypal/webhook.ts:L15-L25] Points to uninspected gap inside truncated file',
          '[api/paypal/webhook.ts:L40-L42] Points inside inspected chunk 2',
          '[api/paypal/webhook.ts:L1-L3] Valid AND [fake/ghost.ts:L1-L2] mixed must reject entire item'
        ],
        requirementEvaluations: [
          {
            requirementId: 'r_tech',
            status: 'CODE_CONFIRMED',
            evidenceCitations: [
              'api/paypal/webhook.ts:L40-L42',
              'api/paypal/webhook.ts:L20-L30' // Uninspected gap -> invalid!
            ],
            summary: 'Mixed valid and gap citation'
          }
        ]
      }
    });

    expect(report.verifiedEvidence).toEqual(
      expect.arrayContaining(['[api/paypal/webhook.ts:L40-L42] Points inside inspected chunk 2'])
    );
    expect(report.verifiedEvidence.some((x) => x.includes('Uncited generic claim'))).toBe(false);
    expect(report.verifiedEvidence.some((x) => x.includes('L15-L25'))).toBe(false);
    expect(report.verifiedEvidence.some((x) => x.includes('mixed must reject'))).toBe(false);

    const rTech = report.sectionC_matrix.find((r) => r.requirementId === 'r_tech');
    // Valid citation preserved, yet mixed invalid citation MUST downgrade row to UNVERIFIED
    expect(rTech?.finalStatus).toBe('UNVERIFIED');
    expect(rTech?.relevantFiles.some((c) => c.path === 'api/paypal/webhook.ts' && c.startLine === 40)).toBe(
      true
    );
    expect(rTech?.staticCodeEvidence.join(' ')).toContain('downgraded to UNVERIFIED');
  });

  it('validates and normalizes adversarial malformed AI payloads without crashing', () => {
    expect(validateAndNormalizeAIAuditOutput([null]).valid).toBe(false);
    expect(validateAndNormalizeAIAuditOutput(null).valid).toBe(false);
    expect(validateAndNormalizeAIAuditOutput({ verifiedEvidence: 'not-an-array' }).valid).toBe(false);

    const partialMalformed = validateAndNormalizeAIAuditOutput({
      verifiedEvidence: ['[src/app.ts:L1-L1] Ok', 123, null],
      requirementEvaluations: [
        { requirementId: 'r_tech', status: 'BOGUS_STATUS', summary: 999 },
        { missingId: true }
      ],
      securityFindings: [
        { severity: 'critical_custom', location: 'src/app.ts:L1-L1', finding: 'Issue' },
        { finding: 12345 }
      ],
      overallConfidence: 'ULTRA_HIGH'
    });

    expect(partialMalformed.valid).toBe(true);
    expect(partialMalformed.output?.verifiedEvidence).toEqual(['[src/app.ts:L1-L1] Ok']);
    expect(partialMalformed.output?.requirementEvaluations).toEqual([
      { requirementId: 'r_tech', status: 'UNVERIFIED' }
    ]);
    expect(partialMalformed.output?.securityFindings?.[0]?.severity).toBe('medium');
    expect(partialMalformed.output?.overallConfidence).toBeUndefined();

    // Passing adversarial raw AI payload to buildComprehensiveJudgingReport must never throw
    const safeReport = buildComprehensiveJudgingReport({
      submission: { id: 's1', title: 'Test', track: 'FinTech', memberIds: ['u1'] },
      hackathon,
      repoInspection: {
        accessible: false,
        repoFullName: null,
        defaultBranch: null,
        commitSha: null,
        description: null,
        primaryLanguage: null,
        stars: null,
        updatedAt: null,
        readmeExcerpt: null,
        readmeFullChars: 0,
        readmeTruncated: false,
        treeDiscoveryMethod: 'none',
        treeTruncated: false,
        totalFilesInTree: 0,
        treeSamplePaths: [],
        inspectedFiles: [],
        uninspectedImportantFiles: [],
        fileInventory: [],
        duplicateFileGroups: [],
        projectRoots: [],
        hasDivergentRoots: false,
        batchesProcessed: 0,
        detectedCategories: [],
        redactedSecretsCount: 0,
        rateLimitRemaining: null,
        aborted: false,
        reason: 'Missing URL'
      },
      liveDemoCheck: {
        demoUrl: '',
        checkedAt: '2026-11-20T00:00:00Z',
        reachable: false,
        httpStatus: null,
        corsBlocked: false,
        requiresAuth: false,
        checkedAspects: [],
        blockedAspects: [],
        status: 'UNVERIFIED',
        summary: 'No demo'
      },
      aiOutput: { verifiedEvidence: 'malformed-string' } as unknown as never
    });

    expect(safeReport.sectionC_matrix.length).toBeGreaterThan(0);
    expect(safeReport.sectionK_confidence.limitations.join(' ')).toContain('AI schema validation diagnostics');
  });

  it('parses Go test PASS lines strictly while keeping self-reported pasted logs UNVERIFIED and ignoring bare PASS prose', () => {
    const goTests = parseExecutedTestEvidence(
      '$ go test ./...\n--- PASS: TestCaptureWebhook (0.01s)\n--- PASS: TestIdempotency (0.02s)\nPASS\nok  github.com/acme/pay 0.031s'
    );
    expect(goTests).toHaveLength(1);
    expect(goTests[0].passedCount).toBe(2);
    expect(goTests[0].status).toBe('UNVERIFIED');
    expect(goTests[0].matchesInspectedCommit).toBe(false);

    const prosePass = parseExecutedTestEvidence('Everything is great, PASS on the demo walkthrough!');
    expect(prosePass[0].passedCount).toBeUndefined();
    expect(prosePass[0].status).toBe('UNVERIFIED');
  });

  it('does not flag passing test titles containing FAIL as CONTRADICTED, while still catching actual test failures', () => {
    const passingWithFailTitle = parseExecutedTestEvidence(
      [
        '$ npm test',
        ' ✓ handles FAIL state cleanly without crashing (12ms)',
        '--- PASS: TestHandleFailMode (0.01s)',
        'Test Files  1 passed (1)',
        'Tests  2 passed (2)'
      ].join('\n')
    );
    expect(passingWithFailTitle[0].status).toBe('UNVERIFIED');
    expect(passingWithFailTitle[0].exitCode).toBe(0);
    expect(passingWithFailTitle[0].passedCount).toBe(2);

    const realFailure = parseExecutedTestEvidence(
      [
        '$ npm test',
        ' FAIL  src/auth.test.ts > validates session',
        'AssertionError: expected false to be true',
        'Tests  1 failed | 1 passed (2)'
      ].join('\n')
    );
    expect(realFailure[0].status).toBe('CONTRADICTED');
    expect(realFailure[0].exitCode).toBe(1);
  });

  it('discovers snake_case test jobs (unit_tests) and does not drop test workflows behind 3 deploy/lint runs', async () => {
    const commitSha = 'fedcba987654';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/actions/runs?head_sha=')) {
          return new Response(
            JSON.stringify({
              workflow_runs: [
                { id: 1, name: 'Deploy Pages', path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'success', head_sha: commitSha },
                { id: 2, name: 'ESLint & Prettier', path: '.github/workflows/lint.yml', status: 'completed', conclusion: 'success', head_sha: commitSha },
                { id: 3, name: 'CodeQL Security', path: '.github/workflows/codeql.yml', status: 'completed', conclusion: 'success', head_sha: commitSha },
                { id: 4, name: 'CI Pipeline', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', head_sha: commitSha, head_branch: 'main' }
              ]
            }),
            { status: 200 }
          );
        }
        if (url.includes('/actions/runs/4/jobs')) {
          return new Response(
            JSON.stringify({
              jobs: [
                {
                  name: 'unit_tests',
                  conclusion: 'success',
                  steps: [{ name: 'Run go_test', conclusion: 'success' }]
                }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response('Not Found', { status: 404 });
      })
    );

    const runs = await fetchPublicGitHubActionsRuns('https://github.com/org/app', {
      expectedCommitSha: commitSha
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('TEST_CONFIRMED');
    expect(runs[0].scope).toContain('unit_tests');
  });

  it('verifies contradictedClaims strictly, requires line ranges on truncated files, avoids tech substring false positives, and keeps procedural rules UNVERIFIED', () => {
    const repoWithTruncatedAndSimilarWords: GitHubRepoInspection = {
      accessible: true,
      repoFullName: 'org/sub-check',
      defaultBranch: 'main',
      commitSha: '1234567890abcdef',
      commitShaVerified: true,
      description: 'Test repo',
      primaryLanguage: 'TypeScript',
      stars: 1,
      updatedAt: '2026-11-20T00:00:00Z',
      readmeExcerpt: '# Demo\nWe integrate PayPal and reactive streaming.',
      readmeFullChars: 48,
      readmeTruncated: false,
      treeDiscoveryMethod: 'git_trees',
      treeTruncated: false,
      totalFilesInTree: 3,
      treeSamplePaths: ['src/reactive.ts', 'src/big.ts', 'src/payments.ts'],
      inspectedFiles: [
        {
          path: 'src/reactive.ts',
          category: 'frontend_source',
          sizeBytes: 80,
          charsIncluded: 80,
          totalLines: 3,
          truncated: false,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 0,
          chunks: [{ startLine: 1, endLine: 3, content: '// reactive and scalable redis-free buffer\nexport const reactive = true;' }],
          excerpt: '// reactive and scalable buffer\nexport const reactive = true;'
        },
        {
          path: 'src/big.ts',
          category: 'server_api',
          sizeBytes: 8000,
          charsIncluded: 25,
          totalLines: 120,
          truncated: true,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 0,
          chunks: [{ startLine: 1, endLine: 20, content: 'export const header = 1;' }],
          excerpt: 'export const header = 1;'
        },
        {
          path: 'src/payments.ts',
          category: 'payments_paypal',
          sizeBytes: 100,
          charsIncluded: 55,
          totalLines: 10,
          truncated: false,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 0,
          chunks: [{ startLine: 1, endLine: 10, content: 'export const usePayPalMock = () => ({ stub: true });' }],
          excerpt: 'export const usePayPalMock = () => ({ stub: true });'
        }
      ],
      uninspectedImportantFiles: [],
      fileInventory: [],
      duplicateFileGroups: [],
      projectRoots: [],
      hasDivergentRoots: false,
      batchesProcessed: 1,
      detectedCategories: ['frontend_source', 'server_api', 'payments_paypal'],
      redactedSecretsCount: 0,
      rateLimitRemaining: 50,
      aborted: false,
      reason: 'Inspected'
    };

    const customHackathon: Hackathon = {
      ...hackathon,
      technologies: ['React', 'Scala'],
      rules: 'Mandatory Submission Rule: Teams must submit a 3-minute walkthrough demo video before the deadline.',
      eligibility: '',
      rubric: [{ id: 'crit_1', name: 'Execution', description: 'Code quality', weight: 100 }]
    };

    const report = buildComprehensiveJudgingReport({
      submission: {
        id: 's_strict',
        title: 'ReactiveApp',
        track: 'FinTech',
        technologies: ['React', 'Scala'],
        githubUrl: 'https://github.com/org/sub-check',
        memberIds: ['u1']
      },
      hackathon: customHackathon,
      repoInspection: repoWithTruncatedAndSimilarWords,
      liveDemoCheck: {
        demoUrl: '',
        checkedAt: '2026-11-20T00:00:00Z',
        reachable: false,
        httpStatus: null,
        corsBlocked: false,
        requiresAuth: false,
        checkedAspects: [],
        blockedAspects: [],
        status: 'UNVERIFIED',
        summary: 'No demo'
      },
      aiOutput: {
        verifiedEvidence: [
          '[src/big.ts] Bare reference on truncated file must be rejected',
          '[src/big.ts:L1-L5] Valid range inside chunk 1 of truncated file'
        ],
        contradictedClaims: [
          {
            claim: 'Real-time payment engine is deployed',
            sourceLocation: 'src/nonexistent.ts:L1-L10',
            reason: 'Hallucinated file citation'
          },
          {
            claim: 'Claims full checkout logic in big file',
            sourceLocation: 'src/big.ts',
            reason: 'Missing line range on truncated file'
          },
          {
            claim: 'README claims production SLA',
            sourceLocation: 'README.md',
            reason: 'Only README mentioned without code proof'
          },
          {
            claim: 'Team claims live PayPal capture',
            sourceLocation: 'README.md',
            reason: 'Code shows [src/payments.ts:L1-L1] only exports a stub mock.'
          }
        ]
      }
    });

    // Truncated file requires explicit line range
    expect(report.verifiedEvidence.some((x) => x.includes('Bare reference'))).toBe(false);
    expect(report.verifiedEvidence).toContain('[src/big.ts:L1-L5] Valid range inside chunk 1 of truncated file');

    // Technology substring false positives prevented ("reactive" !== "React", "scalable" !== "Scala")
    const techRow = report.sectionC_matrix.find((r) => r.sourceField === 'hackathon.technologies');
    expect(techRow?.finalStatus).toBe('UNVERIFIED');

    // Procedural mandatory_submission rule remains UNVERIFIED (never CODE_CONFIRMED from code files)
    const submissionRuleRow = report.sectionC_matrix.find((r) =>
      r.exactWording.includes('3-minute walkthrough demo video')
    );
    expect(submissionRuleRow?.finalStatus).toBe('UNVERIFIED');

    // contradictedClaims checks
    const fakeContra = report.sectionH_contradictions.find((c) =>
      c.claimOrRequirement.includes('Real-time payment')
    );
    expect(fakeContra?.status).toBe('UNVERIFIED');
    expect(fakeContra?.confidence).toBe('LOW');
    expect(fakeContra?.evidenceSource).toBe('unverified_ai_location');

    const truncatedBareContra = report.sectionH_contradictions.find((c) =>
      c.claimOrRequirement.includes('big file')
    );
    expect(truncatedBareContra?.status).toBe('UNVERIFIED');
    expect(truncatedBareContra?.evidenceSource).toBe('unverified_ai_location');

    const readmeOnlyContra = report.sectionH_contradictions.find((c) =>
      c.claimOrRequirement.includes('production SLA')
    );
    expect(readmeOnlyContra?.status).toBe('UNVERIFIED');
    expect(readmeOnlyContra?.confidence).toBe('LOW');
    expect(readmeOnlyContra?.verificationMethod).toBe('metadata_check');
    expect(readmeOnlyContra?.evidenceSource).toBe('README.md (team documentation)');

    const verifiedContra = report.sectionH_contradictions.find((c) =>
      c.claimOrRequirement.includes('live PayPal capture')
    );
    expect(verifiedContra?.status).toBe('CONTRADICTED');
    expect(verifiedContra?.confidence).toBe('MEDIUM');
    expect(verifiedContra?.filePath).toBe('src/payments.ts');
    expect(verifiedContra?.startLine).toBe(1);
    expect(verifiedContra?.blobUrl).toContain('src/payments.ts#L1');

    // ComprehensiveEvidencePanel renders Section D span fallback when blobUrl is omitted, and Section H contradiction sources
    const reportForPanel = {
      ...report,
      sectionD_architecture: [
        {
          id: 'arch_no_url',
          claimOrRequirement: 'Local Arch Record',
          verificationMethod: 'static_code_audit' as const,
          evidenceSource: 'src/reactive.ts:L1-L2',
          filePath: 'src/reactive.ts',
          startLine: 1,
          endLine: 2,
          observedAt: '2026-11-20T00:00:00Z',
          observedResult: 'Uses reactive buffer',
          status: 'CODE_CONFIRMED' as const,
          confidence: 'MEDIUM' as const,
          confidenceReason: 'Static check',
          limitations: []
        }
      ]
    };
    const securityHtml = renderToStaticMarkup(
      createElement(ComprehensiveEvidencePanel, {
        report: reportForPanel,
        locale: 'en',
        initialTab: 'security'
      })
    );
    expect(securityHtml).toContain('Local Arch Record');
    expect(securityHtml).toContain('src/reactive.ts:L1-2');

    const claimsHtml = renderToStaticMarkup(
      createElement(ComprehensiveEvidencePanel, {
        report: reportForPanel,
        locale: 'en',
        initialTab: 'claims'
      })
    );
    expect(claimsHtml).toContain('README.md (team documentation)');
    expect(claimsHtml).toContain('src/payments.ts:L1-L1');
    expect(claimsHtml).toContain('unverified_ai_location');
  });

  it('preserves valid citations alongside rejected invalid siblings in securityFindings and criterionObservations.verifiedLinks, detects test frameworks/commands cleanly, and sets manualVerificationRequired on HTTP 200', async () => {
    const okFetch = vi.fn(async () => new Response('<html><title>Demo</title></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    }));
    vi.stubGlobal('fetch', okFetch);
    const liveDemo200 = await verifyPublicDemoSafely('https://demo.example.app');
    expect(liveDemo200.status).toBe('UNVERIFIED');
    expect(liveDemo200.manualVerificationRequired).toBe(true);

    const repo: GitHubRepoInspection = {
      accessible: true,
      repoFullName: 'example/mixed-cites',
      defaultBranch: 'main',
      commitSha: 'deadbeefcafebabe',
      commitShaVerified: true,
      description: 'Mixed citations & test detection',
      primaryLanguage: 'TypeScript',
      stars: 1,
      updatedAt: '2026-11-22T00:00:00Z',
      readmeExcerpt: '# App',
      readmeFullChars: 5,
      readmeTruncated: false,
      treeDiscoveryMethod: 'git_trees',
      treeTruncated: false,
      totalFilesInTree: 4,
      treeSamplePaths: ['src/auth.ts', 'package.json', 'vitest.config.ts', 'tests/auth.test.ts'],
      inspectedFiles: [
        {
          path: 'src/auth.ts',
          category: 'auth_rbac',
          sizeBytes: 200,
          charsIncluded: 120,
          totalLines: 10,
          truncated: false,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 0,
          chunks: [{ startLine: 1, endLine: 10, content: 'export function verifyToken() { return true; }' }],
          excerpt: 'export function verifyToken() { return true; }'
        },
        {
          path: 'package.json',
          category: 'config_security',
          sizeBytes: 180,
          charsIncluded: 180,
          totalLines: 6,
          truncated: false,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 0,
          chunks: [
            {
              startLine: 1,
              endLine: 6,
              content: '{"scripts":{"test":"vitest run"},"devDependencies":{"vitest":"^3.0.0"}}'
            }
          ],
          excerpt: '{"scripts":{"test":"vitest run"},"devDependencies":{"vitest":"^3.0.0"}}'
        },
        {
          path: 'tests/auth.test.ts',
          category: 'tests',
          sizeBytes: 100,
          charsIncluded: 60,
          totalLines: 2,
          truncated: false,
          sourceEndpoint: 'raw',
          redactedSecretsCount: 0,
          chunks: [{ startLine: 1, endLine: 2, content: 'it("checks", () => expect(1).toBe(1));' }],
          excerpt: 'it("checks", () => expect(1).toBe(1));'
        }
      ],
      uninspectedImportantFiles: [],
      fileInventory: [
        { path: 'src/auth.ts', category: 'auth_rbac', sizeBytes: 200, inspectionStatus: 'inspected', auditStatus: 'FULLY_INSPECTED', reason: 'inspected_complete' },
        { path: 'package.json', category: 'config_security', sizeBytes: 180, inspectionStatus: 'inspected', auditStatus: 'FULLY_INSPECTED', reason: 'inspected_complete' },
        { path: 'tests/auth.test.ts', category: 'tests', sizeBytes: 100, inspectionStatus: 'inspected', auditStatus: 'FULLY_INSPECTED', reason: 'inspected_complete' },
        { path: 'vitest.config.ts', category: 'tests', sizeBytes: 80, inspectionStatus: 'skipped', auditStatus: 'SKIPPED', reason: 'budget_limit' }
      ],
      duplicateFileGroups: [],
      projectRoots: [],
      hasDivergentRoots: false,
      batchesProcessed: 1,
      detectedCategories: ['auth_rbac', 'config_security', 'tests'],
      redactedSecretsCount: 0,
      rateLimitRemaining: 50,
      aborted: false,
      reason: 'Inspected 3 files'
    };

    const report = buildComprehensiveJudgingReport({
      submission: {
        id: 'sub_mixed',
        title: 'Mixed Citations App',
        track: 'FinTech',
        memberIds: ['u1'],
        technologies: ['TypeScript'],
        submittedAt: '2026-11-22T00:00:00Z'
      },
      hackathon,
      repoInspection: repo,
      liveDemoCheck: liveDemo200,
      executedTests: [],
      aiOutput: {
        securityFindings: [
          {
            severity: 'high',
            location: 'src/auth.ts:L1-L5',
            finding: 'Auth stub returns true unconditionally (see [ghost/file.ts:L1-L2])',
            mitigation: 'Verify JWT signature'
          },
          {
            severity: 'high',
            location: 'src/auth.ts:L1-L5',
            finding: 'Auth stub returns true unconditionally',
            mitigation: 'Require cryptographic verification'
          }
        ],
        criterionObservations: [
          {
            criterionName: 'Technical Implementation',
            observations: ['Inspects [src/auth.ts:L1-L5]'],
            verifiedLinks: ['src/auth.ts:L1-L5', 'nonexistent/missing.ts:L1-L3'],
            missingProof: []
          }
        ]
      }
    });

    // Section E: discovered test files + package.json scripts/deps without execution stay UNVERIFIED
    expect(report.sectionE_tests.summaryStatus).toBe('UNVERIFIED');
    expect(report.sectionE_tests.detectedTestFrameworks).toContain('vitest');
    expect(report.sectionE_tests.detectedTestCommands?.some((c) => c.includes('vitest run'))).toBe(true);

    // Section G: mixed valid location + invalid finding citation stays UNVERIFIED; clean valid finding is CONTRADICTED with blobUrl
    const aiSecFindings = report.sectionG_security.findings.filter((f) => f.id.startsWith('ai_sec_'));
    expect(aiSecFindings).toHaveLength(2);
    expect(aiSecFindings[0].evidenceSource).toBe('unverified_ai_location');
    expect(aiSecFindings[0].status).toBe('UNVERIFIED');
    expect(aiSecFindings[1].evidenceSource).toBe('src/auth.ts:L1-L5');
    expect(aiSecFindings[1].filePath).toBe('src/auth.ts');
    expect(aiSecFindings[1].status).toBe('CONTRADICTED');

    // Section J: valid verifiedLink src/auth.ts:L1-L5 is preserved even when nonexistent sibling is rejected
    const techObs = report.sectionJ_criterionObservations.find((c) => c.criterionId === 'r_tech');
    expect(techObs?.citations.some((c) => c.path === 'src/auth.ts' && c.startLine === 1)).toBe(true);
    expect(techObs?.citations.some((c) => c.path.includes('missing.ts'))).toBe(false);
    expect(report.sectionK_confidence.limitations.join(' ')).toContain('missing.ts');
  });
});



