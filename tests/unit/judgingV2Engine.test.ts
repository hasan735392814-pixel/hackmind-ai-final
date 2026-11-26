import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateOfficialWeightedScore,
  CRITERIA_VERSION,
  EVIDENCE_COLLECTOR_VERSION,
  getTotalOfficialWeightPercent,
  OFFICIAL_CRITERION_IDS,
  OFFICIAL_JUDGING_CRITERIA,
  validateFourCriteriaScores
} from '../../src/services/judgingV2/criteria';
import { evaluateSubmissionEligibility } from '../../src/services/judgingV2/eligibilityEngine';
import {
  collectProjectEvidence,
  computeAccurateRepoCoverage,
  extractStaticCodeEvidence
} from '../../src/services/judgingV2/evidenceCollector';
import {
  containsVideoJudgingReference,
  sanitizeSubmissionWithoutVideo
} from '../../src/services/judgingV2/evidenceSanitizer';
import type {
  GitHubRepoInspection,
  InspectedRepoFile,
  RepoInspectionPlan
} from '../../src/services/github/repoInspector';
import type { Hackathon, ProjectSubmission } from '../../src/types/domain';

function createBaseSubmission(overrides?: Partial<ProjectSubmission>): ProjectSubmission {
  return {
    id: 'sub_v2_1',
    hackathonId: 'hack_v2_1',
    organizerId: 'org_1',
    teamId: 'team_1',
    teamName: 'Pulse Builders',
    projectId: 'proj_v2_1',
    ownerId: 'owner_1',
    memberIds: ['owner_1', 'member_2'],
    memberNames: ['Alice', 'Bob'],
    title: 'ClinicRoute AI',
    shortDescription: 'Routing triage platform https://youtu.be/demo123 for rural clinics.',
    fullDescription: 'Full architecture details. Walkthrough video: https://www.loom.com/share/abc999',
    problemStatement: 'Patients face 4-hour delays reaching staffed clinics.',
    proposedSolution: 'Verified Express API + React scheduling workflow.',
    technologies: ['TypeScript', 'React', 'Express'],
    githubUrl: 'https://github.com/example/clinicroute',
    demoUrl: 'https://clinicroute.example.app',
    videoUrl: 'https://youtube.com/watch?v=blockedVideo99',
    screenshotUrls: [],
    track: 'HealthTech',
    status: 'submitted',
    submittedAt: '2026-10-01T10:00:00Z',
    assignedJudgeIds: ['judge_1'],
    ...overrides
  };
}

function createBaseHackathon(overrides?: Partial<Hackathon>): Hackathon {
  return {
    id: 'hack_v2_1',
    organizerId: 'org_1',
    organizerName: 'Organizer',
    title: 'Global Civic Hack 2026',
    tagline: 'Build real tools',
    description: 'Civic challenge',
    coverImageUrl: '',
    startDate: '2026-09-25',
    endDate: '2026-10-02',
    registrationDeadline: '2026-09-24',
    submissionDeadline: '2026-10-02T23:59:59Z',
    submissionDeadlineAt: Date.parse('2026-10-02T23:59:59Z'),
    mode: 'online',
    location: 'Remote',
    tracks: ['HealthTech', 'Climate'],
    technologies: ['TypeScript', 'React'],
    eligibility: 'Teams of up to 4 participants.',
    rules: 'Original open-source submissions only.',
    prizes: [],
    sponsors: [],
    rubric: [],
    maxTeamSize: 4,
    status: 'judging',
    resultsPublished: false,
    ...overrides
  };
}

describe('Judging V2 — Four-Criteria Rubric, Video Exclusion, Eligibility & Evidence Truthfulness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enforces ONLY the 4 fixed criteria summing to 100% and computes exact weighted formula', () => {
    expect(OFFICIAL_JUDGING_CRITERIA).toHaveLength(4);
    expect(OFFICIAL_CRITERION_IDS).toEqual([
      'innovation_originality',
      'technical_implementation',
      'real_world_impact',
      'ux_completeness'
    ]);
    expect(getTotalOfficialWeightPercent()).toBe(100);

    const exactScore = calculateOfficialWeightedScore({
      innovation_originality: { criterionId: 'innovation_originality', score: 80 },
      technical_implementation: { criterionId: 'technical_implementation', score: 90 },
      real_world_impact: { criterionId: 'real_world_impact', score: 60 },
      ux_completeness: { criterionId: 'ux_completeness', score: 70 }
    });
    // 80*0.25 (20) + 90*0.30 (27) + 60*0.25 (15) + 70*0.20 (14) = 76
    expect(exactScore).toBe(76);

    const fifthCriterionRejection = validateFourCriteriaScores({
      innovation_originality: { criterionId: 'innovation_originality', score: 80 },
      technical_implementation: { criterionId: 'technical_implementation', score: 90 },
      real_world_impact: { criterionId: 'real_world_impact', score: 60 },
      ux_completeness: { criterionId: 'ux_completeness', score: 70 },
      bonus_presentation: { criterionId: 'ux_completeness', score: 100 }
    });
    expect(fifthCriterionRejection.valid).toBe(false);
    expect(fifthCriterionRejection.error).toContain('Unsupported judging criterion');
  });

  it('completely excludes videoUrl and embedded video links from sanitized judging payloads', () => {
    const raw = createBaseSubmission();
    const sanitized = sanitizeSubmissionWithoutVideo(raw);

    expect('videoUrl' in sanitized).toBe(false);
    expect(sanitized.videoExcluded).toBe(true);
    expect(sanitized.shortDescription).not.toContain('youtu.be');
    expect(sanitized.fullDescription).not.toContain('loom.com');
    expect(containsVideoJudgingReference(sanitized)).toBe(false);
    expect(containsVideoJudgingReference({ videoUrl: 'https://vimeo.com/123' })).toBe(true);
  });

  it('evaluates eligibility strictly separately and keeps unavailable hackathon rules UNVERIFIED', () => {
    const sub = createBaseSubmission({ memberIds: ['u1', 'u2', 'u3', 'u4', 'u5'], track: 'FinTech' });
    const hackathon = createBaseHackathon({ maxTeamSize: 4, tracks: ['HealthTech'] });

    const report = evaluateSubmissionEligibility({ submission: sub, hackathon });
    expect(report.separatedFromScoring).toBe(true);
    expect(report.checks.find((c) => c.id === 'team_size')?.status).toBe('FAIL');
    expect(report.checks.find((c) => c.id === 'track_match')?.status).toBe('FAIL');
    expect(report.checks.find((c) => c.id === 'submission_status')?.status).toBe('PASS');
    expect(report.checks.find((c) => c.id === 'submission_deadline')?.status).toBe('PASS');
    expect(report.checks.find((c) => c.id === 'competition_rules')?.status).toBe('UNVERIFIED');

    // Missing hackathon record must NEVER invent rules
    const missingHackReport = evaluateSubmissionEligibility({
      submission: createBaseSubmission(),
      hackathon: null
    });
    expect(missingHackReport.hackathonAccessible).toBe(false);
    expect(missingHackReport.checks.find((c) => c.id === 'team_size')?.status).toBe('UNVERIFIED');
    expect(missingHackReport.checks.find((c) => c.id === 'submission_deadline')?.status).toBe('UNVERIFIED');
  });

  it('excludes README/docs from unique source coverage, extracts line-cited findings, and never treats test presence or HTTP 200 as full proof', async () => {
    const sub = createBaseSubmission();
    const inspectedPackageJson: InspectedRepoFile = {
      path: 'package.json',
      category: 'config_security',
      sizeBytes: 120,
      charsIncluded: 120,
      totalLines: 8,
      truncated: false,
      sourceEndpoint: 'contents_api',
      redactedSecretsCount: 0,
      chunks: [
        {
          startLine: 1,
          endLine: 8,
          content: JSON.stringify({ dependencies: { express: '^4.21.0', react: '^19.0.1' } }, null, 2)
        }
      ],
      excerpt: ''
    };
    const inspectedServerTs: InspectedRepoFile = {
      path: 'src/server.ts',
      category: 'server_api',
      sizeBytes: 180,
      charsIncluded: 180,
      totalLines: 5,
      truncated: false,
      sourceEndpoint: 'contents_api',
      redactedSecretsCount: 0,
      chunks: [
        {
          startLine: 1,
          endLine: 5,
          content: `import express from 'express';\nconst app = express();\napp.get('/api/triage', (_req, res) => res.json({ ok: true }));`
        }
      ],
      excerpt: ''
    };
    const inspectedTestFile: InspectedRepoFile = {
      path: 'tests/triage.test.ts',
      category: 'tests',
      sizeBytes: 90,
      charsIncluded: 90,
      totalLines: 3,
      truncated: false,
      sourceEndpoint: 'contents_api',
      redactedSecretsCount: 0,
      chunks: [{ startLine: 1, endLine: 3, content: `describe('triage', () => { it('works', () => {}); });` }],
      excerpt: ''
    };

    const mockPlan: RepoInspectionPlan = {
      accessible: true,
      aborted: false,
      reason: 'ok',
      owner: 'example',
      repo: 'clinicroute',
      repoFullName: 'example/clinicroute',
      defaultBranch: 'main',
      commitSha: 'deadbeef123456',
      commitShaVerified: true,
      citationRef: 'deadbeef123456',
      cacheKey: 'example/clinicroute@deadbeef123456',
      description: 'Clinic triage',
      primaryLanguage: 'TypeScript',
      stars: 2,
      updatedAt: '2026-10-01T00:00:00Z',
      readmeExcerpt: 'Readme claims 1M users',
      readmeFullChars: 24,
      readmeTruncated: false,
      readmePathInspected: 'README.md',
      readmeRedactedCount: 0,
      treeDiscoveryMethod: 'git_trees',
      treeTruncated: false,
      blobEntries: [
        { path: 'README.md', size: 24 },
        { path: 'package.json', size: 120 },
        { path: 'src/server.ts', size: 180 },
        { path: 'tests/triage.test.ts', size: 90 }
      ],
      selectedEntries: [
        { entry: { path: 'package.json', size: 120 }, category: 'config_security', score: 100 },
        { entry: { path: 'src/server.ts', size: 180 }, category: 'server_api', score: 95 },
        { entry: { path: 'tests/triage.test.ts', size: 90 }, category: 'tests', score: 80 }
      ],
      initialSkipped: [],
      oversizedPaths: [],
      fileCountLimitPaths: [],
      duplicateMirrorPaths: [],
      projectRoots: [
        {
          rootPath: '.',
          reason: 'package.json',
          fileCount: 3,
          matchScore: 100,
          manifestFiles: ['package.json'],
          selectedAsPrimary: true
        }
      ],
      hasDivergentRoots: false,
      rateLimitRemaining: 50,
      maxTotalChars: 120000,
      maxPerFileChars: 12000
    };

    const result = await collectProjectEvidence({
      submission: sub,
      deps: {
        discoverPlanFn: vi.fn().mockResolvedValue(mockPlan),
        inspectBatchFn: vi.fn().mockResolvedValue({
          inspectedFiles: [inspectedPackageJson, inspectedServerTs, inspectedTestFile],
          skippedOrFailed: [],
          totalCharsAdded: 390,
          redactedSecretsCount: 0,
          aborted: false
        }),
        fetchActionsRunsFn: vi.fn().mockResolvedValue([]),
        probeDemoFn: vi.fn().mockResolvedValue({
          demoUrl: 'https://clinicroute.example.app',
          checkedAt: '2026-10-01T12:00:00Z',
          reachable: true,
          httpStatus: 200,
          finalUrl: 'https://clinicroute.example.app/',
          corsBlocked: false,
          requiresAuth: false,
          checkedAspects: ['HTTP 200 response'],
          blockedAspects: [],
          status: 'RUNTIME_CONFIRMED',
          summary: 'HTTP 200 OK'
        })
      }
    });

    const { coverage, publicAppProbe, testVerification, apiEndpointsDetected, findings } = result.bundle;
    expect(coverage.totalTreeEntries).toBe(4);
    expect(coverage.readmeAndDocsCount).toBe(1);
    // README excluded from unique source files & inspected source files
    expect(coverage.uniqueSourceFiles).toBe(3);
    expect(coverage.inspectedFiles).toBe(3);

    expect(apiEndpointsDetected).toEqual([
      {
        filePath: 'src/server.ts',
        lineRange: 'L3-L3',
        signature: "app.get('/api/triage', (_req, res) => res.json({ ok: true }));"
      }
    ]);

    // Test file code presence NEVER equals passed tests
    expect(testVerification.discoveredTestFilesCount).toBe(1);
    expect(testVerification.status).toBe('UNVERIFIED');
    expect(testVerification.executed).toBe(false);
    expect(findings.find((f) => f.id === 'testfile_tests/triage.test.ts')?.status).toBe(
      'PARTIALLY_VERIFIED'
    );

    // HTTP 200 probe verifies reachability only, NOT workflow functionality
    expect(publicAppProbe.reachable).toBe(true);
    expect(publicAppProbe.reachabilityStatus).toBe('PARTIALLY_VERIFIED');
    expect(publicAppProbe.functionalityStatus).toBe('UNVERIFIED');

    // Also test direct coverage helper with inaccessible/failed files
    const directInspection: GitHubRepoInspection = {
      accessible: true,
      aborted: false,
      reason: 'ok',
      repoFullName: 'example/clinicroute',
      defaultBranch: 'main',
      commitSha: 'deadbeef123456',
      commitShaVerified: true,
      description: null,
      primaryLanguage: 'TypeScript',
      stars: 1,
      updatedAt: null,
      readmeExcerpt: null,
      readmeFullChars: 0,
      readmeTruncated: false,
      readmePathInspected: null,
      totalFilesInTree: 3,
      treeSamplePaths: ['README.md', 'src/server.ts', 'src/secret.ts'],
      inspectedFiles: [inspectedServerTs],
      uninspectedImportantFiles: [],
      fileInventory: [
        { path: 'README.md', category: 'readme', sizeBytes: 24, inspectionStatus: 'inspected', reason: 'inspected_complete' },
        { path: 'src/server.ts', category: 'server_api', sizeBytes: 180, inspectionStatus: 'inspected', reason: 'inspected_complete' },
        { path: 'src/secret.ts', category: 'server_api', sizeBytes: 120, inspectionStatus: 'inaccessible', reason: 'fetch_failed' }
      ],
      duplicateFileGroups: [],
      projectRoots: [],
      hasDivergentRoots: false,
      treeTruncated: false,
      treeDiscoveryMethod: 'git_trees',
      detectedCategories: ['readme', 'server_api'],
      redactedSecretsCount: 0,
      rateLimitRemaining: 50,
      batchesProcessed: 1
    };

    const cov = computeAccurateRepoCoverage({
      plan: mockPlan,
      inspection: directInspection,
      completedBatches: 1,
      totalBatches: 1
    });
    expect(cov.readmeAndDocsCount).toBe(1);
    expect(cov.uniqueSourceFiles).toBe(2);
    expect(cov.inspectedFiles).toBe(1);
    expect(cov.inaccessibleFiles).toBe(1);
    expect(extractStaticCodeEvidence([inspectedPackageJson]).dependencies).toEqual(['express', 'react']);
  });

  it('separates binary_or_asset from unique source files, distinguishes client API helpers (getInsights) from Deno.serve endpoints, and performs non-destructive incremental batches', async () => {
    const qlooClientFile: InspectedRepoFile = {
      path: 'src/lib/qloo-client.ts',
      category: 'qloo_integration',
      sizeBytes: 9835,
      charsIncluded: 7500,
      totalLines: 255,
      truncated: true,
      sourceEndpoint: 'contents_api',
      redactedSecretsCount: 0,
      chunks: [
        {
          startLine: 1,
          endLine: 100,
          content: [
            "const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;",
            "async function callEdgeFunction(fnName: string, body?: unknown) {",
            "  return fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, { method: 'POST', body: JSON.stringify(body) });",
            "}",
            "export async function getInsights(params: Record<string, string>) {",
            "  return callEdgeFunction('qloo-proxy', { endpoint: 'insights', params });",
            "}"
          ].join('\n')
        }
      ],
      excerpt: ''
    };

    const qlooProxyEdgeFn: InspectedRepoFile = {
      path: 'supabase/functions/qloo-proxy/index.ts',
      category: 'server_api',
      sizeBytes: 7902,
      charsIncluded: 7902,
      totalLines: 217,
      truncated: false,
      sourceEndpoint: 'contents_api',
      redactedSecretsCount: 0,
      chunks: [
        {
          startLine: 1,
          endLine: 15,
          content: [
            "const QLOO_BASE = 'https://hackathon.api.qloo.com';",
            "Deno.serve(async (req: Request) => {",
            "  const apiKey = Deno.env.get('QLOO_API_KEY');",
            "  return new Response(JSON.stringify({ ok: Boolean(apiKey), base: QLOO_BASE }));",
            "});"
          ].join('\n')
        }
      ],
      excerpt: ''
    };

    const appTsxFile: InspectedRepoFile = {
      path: 'src/App.tsx',
      category: 'frontend_source',
      sizeBytes: 3100,
      charsIncluded: 3100,
      totalLines: 106,
      truncated: false,
      sourceEndpoint: 'contents_api',
      redactedSecretsCount: 0,
      chunks: [
        {
          startLine: 1,
          endLine: 25,
          content: [
            "import { useState } from 'react';",
            "export function App() {",
            "  const [currentPage, setCurrentPage] = useState<'dashboard' | 'analysis'>('dashboard');",
            "  if (currentPage === 'analysis') return <main />;",
            "  return <div />;",
            "}"
          ].join('\n')
        }
      ],
      excerpt: ''
    };

    const pkgFile: InspectedRepoFile = {
      path: 'package.json',
      category: 'config_security',
      sizeBytes: 500,
      charsIncluded: 500,
      totalLines: 20,
      truncated: false,
      sourceEndpoint: 'contents_api',
      redactedSecretsCount: 0,
      chunks: [
        {
          startLine: 1,
          endLine: 12,
          content: JSON.stringify({
            dependencies: {
              '@supabase/supabase-js': '^2.57.4',
              react: '^18.3.1'
            }
          })
        }
      ],
      excerpt: ''
    };

    const staticCheck = extractStaticCodeEvidence([qlooClientFile, qlooProxyEdgeFn, appTsxFile, pkgFile]);
    // getInsights MUST NOT appear as a server endpoint
    expect(staticCheck.apiEndpointsDetected.some((e) => e.filePath === 'src/lib/qloo-client.ts')).toBe(false);
    expect(staticCheck.apiEndpointsDetected.some((e) => e.filePath === 'supabase/functions/qloo-proxy/index.ts')).toBe(true);
    expect(staticCheck.clientApiHelpersDetected.some((c) => c.filePath === 'src/lib/qloo-client.ts')).toBe(true);
    expect(
      staticCheck.findings.find((f) => f.id === 'client_api_src/lib/qloo-client.ts')?.title
    ).toContain('Client-side API helper');
    expect(staticCheck.findings.find((f) => f.id === 'ux_route_src/App.tsx')?.status).toBe(
      'PARTIALLY_VERIFIED'
    );

    // Coverage accounting test with binary/lock assets + duplicate mirrors + unselected configs
    const mockPlan: RepoInspectionPlan = {
      accessible: true,
      aborted: false,
      reason: 'ok',
      owner: 'hasan735392814-pixel',
      repo: 'culturepulse-ai-source',
      repoFullName: 'hasan735392814-pixel/culturepulse-ai-source',
      defaultBranch: 'main',
      commitSha: 'bca5b1e4cec1b1aa56018477f3c0fe70e8923586',
      commitShaVerified: true,
      citationRef: 'bca5b1e4cec1b1aa56018477f3c0fe70e8923586',
      cacheKey: 'hasan735392814-pixel/culturepulse-ai-source@bca5b1e4cec1b1aa56018477f3c0fe70e8923586',
      description: 'CulturePulse AI',
      primaryLanguage: 'TypeScript',
      stars: 0,
      updatedAt: '2026-10-01T00:00:00Z',
      readmeExcerpt: '# CulturePulse AI',
      readmeFullChars: 16,
      readmeTruncated: false,
      readmePathInspected: 'README.md',
      readmeRedactedCount: 0,
      treeDiscoveryMethod: 'git_trees',
      treeTruncated: false,
      blobEntries: [
        { path: 'README.md', size: 100 },
        { path: 'package-lock.json', size: 5000 },
        { path: 'CULTUREPULSE_AI_DEMO.mp4', size: 1200000 },
        { path: 'package.json', size: 500 },
        { path: 'src/App.tsx', size: 3100 },
        { path: 'src/lib/qloo-client.ts', size: 9835 },
        { path: 'supabase/functions/qloo-proxy/index.ts', size: 7902 },
        { path: 'index.html', size: 598 },
        { path: 'src/index.css', size: 3597 },
        { path: 'GITHUB_UPLOAD/src/App.tsx', size: 3100 },
        { path: '.gitignore', size: 220 }
      ],
      selectedEntries: [
        { entry: { path: 'package.json', size: 500 }, category: 'config_security', score: 90 },
        { entry: { path: 'src/App.tsx', size: 3100 }, category: 'frontend_source', score: 85 },
        { entry: { path: 'src/lib/qloo-client.ts', size: 9835 }, category: 'qloo_integration', score: 95 },
        { entry: { path: 'supabase/functions/qloo-proxy/index.ts', size: 7902 }, category: 'server_api', score: 92 }
      ],
      initialSkipped: [],
      oversizedPaths: [],
      fileCountLimitPaths: [],
      duplicateMirrorPaths: ['GITHUB_UPLOAD/src/App.tsx'],
      projectRoots: [
        { rootPath: '.', reason: 'package.json', fileCount: 9, matchScore: 100, manifestFiles: ['package.json'], selectedAsPrimary: true }
      ],
      hasDivergentRoots: false,
      rateLimitRemaining: 50,
      maxTotalChars: 120000,
      maxPerFileChars: 7500
    };

    const fullFile = (path: string, content: string, category: InspectedRepoFile['category'] = 'frontend_source'): InspectedRepoFile => ({
      path,
      category,
      sizeBytes: content.length,
      charsIncluded: content.length,
      totalLines: content.split('\n').length,
      truncated: false,
      sourceEndpoint: 'contents_api',
      redactedSecretsCount: 0,
      chunks: [{ startLine: 1, endLine: content.split('\n').length, content }],
      excerpt: content
    });

    const sub = createBaseSubmission({
      githubUrl: 'https://github.com/hasan735392814-pixel/culturepulse-ai-source',
      demoUrl: ''
    });

    const mainTsxFile = fullFile('src/main.tsx', "import { App } from './App'; console.log(App);");
    const typesTsFile = fullFile('src/lib/types.ts', 'export interface EntityItem { id: string; }');

    // Incremental batch run preserving existing full files & commit SHA, expanding truncated qloo-client.ts,
    // and inspecting index.html + src/index.css while skipping GITHUB_UPLOAD mirror and binary assets
    const requestedInIncremental: string[] = [];
    const incrementalRes = await collectProjectEvidence({
      submission: sub,
      resumeInspectedFiles: [pkgFile, appTsxFile, mainTsxFile, typesTsFile, qlooClientFile, qlooProxyEdgeFn],
      resumeCompletedBatches: 1,
      resumeCommitSha: 'bca5b1e4cec1b1aa56018477f3c0fe70e8923586',
      inspectAdditionalUninspected: true,
      expandTruncatedFiles: true,
      deps: {
        discoverPlanFn: vi.fn().mockResolvedValue({
          ...mockPlan,
          blobEntries: [
            ...mockPlan.blobEntries,
            { path: 'src/main.tsx', size: 120 },
            { path: 'src/lib/types.ts', size: 80 }
          ]
        }),
        inspectBatchFn: vi.fn().mockImplementation(async (_plan, slice) => {
          const out: InspectedRepoFile[] = [];
          for (const item of slice) {
            requestedInIncremental.push(item.entry.path);
            if (item.entry.path === 'src/lib/qloo-client.ts') {
              out.push(fullFile('src/lib/qloo-client.ts', "export async function getInsights() { return fetch('/functions/v1/qloo-proxy'); }", 'qloo_integration'));
            } else {
              out.push(fullFile(item.entry.path, `/* ${item.entry.path} */`));
            }
          }
          return {
            inspectedFiles: out,
            skippedOrFailed: [],
            totalCharsAdded: 500,
            redactedSecretsCount: 0,
            aborted: false
          };
        }),
        fetchActionsRunsFn: vi.fn().mockResolvedValue([]),
        probeDemoFn: vi.fn().mockResolvedValue(null)
      }
    });

    expect(requestedInIncremental).toEqual(['src/lib/qloo-client.ts', 'index.html', 'src/index.css']);
    const cov2 = incrementalRes.bundle.coverage;
    expect(cov2.commitSha).toBe('bca5b1e4cec1b1aa56018477f3c0fe70e8923586');
    expect(cov2.readmeAndDocsCount).toBe(1);
    expect(cov2.excludedBinaryAndLockCount).toBe(2);
    expect(cov2.uniqueSourceFiles).toBe(10);
    expect(cov2.inspectedFiles).toBe(8);
    expect(cov2.partiallyInspectedFiles).toBe(0);
    expect(cov2.skippedFiles).toBe(2); // GITHUB_UPLOAD/src/App.tsx + .gitignore
    expect(
      cov2.inspectedFiles +
        cov2.partiallyInspectedFiles +
        cov2.skippedFiles +
        cov2.inaccessibleFiles +
        cov2.failedFiles
    ).toBe(cov2.uniqueSourceFiles);
    expect(cov2.skippedBreakdown?.duplicateMirror).toBe(1);
    expect(cov2.skippedBreakdown?.unselectedRootMetaOrConfig).toBe(1);
    expect(cov2.skippedBreakdown?.nonCodeOrUnselected).toBe(1);
    expect(cov2.skippedBreakdown?.binaryOrAsset).toBe(2);
    expect(cov2.skippedFilesList?.length).toBe(cov2.skippedFiles);
    expect(cov2.skippedFilesList?.some((s) => s.reason === 'binary_or_asset')).toBe(false);
    expect(cov2.excludedDocsList?.length).toBe(cov2.readmeAndDocsCount);
    expect(cov2.excludedBinaryAndLockList?.length).toBe(cov2.excludedBinaryAndLockCount);
    expect(incrementalRes.bundle.repoUrl).toBe(
      'https://github.com/hasan735392814-pixel/culturepulse-ai-source'
    );
    expect(incrementalRes.bundle.defaultBranch).toBe('main');
    expect(incrementalRes.bundle.commitSha).toBe('bca5b1e4cec1b1aa56018477f3c0fe70e8923586');
    expect(incrementalRes.bundle.criteriaVersion).toBe(CRITERIA_VERSION);
    expect(incrementalRes.bundle.evidenceCollectorVersion).toBe(EVIDENCE_COLLECTOR_VERSION);
    expect(incrementalRes.bundle.evidenceKey).toContain(EVIDENCE_COLLECTOR_VERSION);
    // All JS/TS files non-truncated -> catches unused @supabase/supabase-js
    const unusedDepFinding = incrementalRes.bundle.findings.find((f) => f.id === 'dep_unused_declared');
    expect(unusedDepFinding?.title).toContain('@supabase/supabase-js');
    expect(unusedDepFinding?.title).not.toContain('react');

    // Standard call (without explicit flags) defaults to full incremental expansion
    const requestedDefault: string[] = [];
    const defaultRes = await collectProjectEvidence({
      submission: sub,
      deps: {
        discoverPlanFn: vi.fn().mockResolvedValue(mockPlan),
        inspectBatchFn: vi.fn().mockImplementation(async (_plan, slice: Array<{ entry: { path: string } }>) => {
          for (const item of slice) requestedDefault.push(item.entry.path);
          return {
            inspectedFiles: slice.map((item) =>
              fullFile(item.entry.path, `export const ok = '${item.entry.path}';`)
            ),
            skippedOrFailed: [],
            totalCharsAdded: 200,
            redactedSecretsCount: 0,
            aborted: false
          };
        }),
        fetchActionsRunsFn: vi.fn().mockResolvedValue([]),
        probeDemoFn: vi.fn().mockResolvedValue(null)
      }
    });
    expect(requestedDefault).toContain('index.html');
    expect(requestedDefault).toContain('src/index.css');
    expect(defaultRes.bundle.coverage.skippedFilesList?.length).toBe(
      defaultRes.bundle.coverage.skippedFiles
    );
  });
});
