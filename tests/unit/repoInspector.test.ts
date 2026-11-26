import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectPublicGitHubRepo, redactSecrets } from '../../src/services/github/repoInspector';

function makeHeaders(map: Record<string, string> = {}): Headers {
  return new Headers(map);
}

describe('GitHub Repository Inspector & Secret Redaction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('redacts hardcoded API keys, PayPal secrets, and private keys while preserving safe env references', () => {
    const sample = [
      'const key = process.env.PAYPAL_CLIENT_SECRET;',
      'const paypalSecret = "sandbox_live_super_secret_987654321";',
      'PAYPAL_CLIENT_SECRET="ELiveSecretValue_1234567890"',
      'VITE_FIREBASE_API_KEY="AIzaSyFakeExampleKeyValue1234567890123"',
      'const oauthToken = "A21AAI6fakePayPalAccessTokenValue1234567890";',
      'GEMINI_API_KEY="your_api_key_here"',
      'QLOO_API_KEY="qloo_real_secret_key_abcdef123456"'
    ].join('\n');

    const { sanitized, count } = redactSecrets(sample);

    expect(count).toBeGreaterThanOrEqual(4);
    expect(sanitized).toContain('process.env.PAYPAL_CLIENT_SECRET');
    expect(sanitized).toContain('GEMINI_API_KEY="your_api_key_here"');
    expect(sanitized).not.toContain('ELiveSecretValue_1234567890');
    expect(sanitized).not.toContain('AIzaSyFakeExampleKeyValue1234567890123');
    expect(sanitized).not.toContain('A21AAI6fakePayPalAccessTokenValue1234567890');
    expect(sanitized).not.toContain('qloo_real_secret_key_abcdef123456');
    expect(sanitized).toContain('[REDACTED_SECRET]');
  });

  it('fetches Git Tree, full README (>1500 chars), prioritized files across categories, and skips .env/noise', async () => {
    const longReadme = `# HackMind Sample\n${'Detailed architecture documentation. '.repeat(90)}`;
    expect(longReadme.length).toBeGreaterThan(2500);

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/acme/sample-app') {
        return new Response(
          JSON.stringify({
            description: 'Sample repo',
            language: 'TypeScript',
            stargazers_count: 12,
            updated_at: '2026-11-19T10:00:00Z',
            default_branch: 'main'
          }),
          { status: 200, headers: makeHeaders({ 'x-ratelimit-remaining': '58' }) }
        );
      }
      if (url.includes('/git/trees/main?recursive=1')) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              { path: 'README.md', type: 'blob', size: longReadme.length },
              { path: '.env', type: 'blob', size: 120 },
              { path: '.env.production', type: 'blob', size: 140 },
              { path: '.env.example', type: 'blob', size: 110 },
              { path: 'node_modules/pkg/index.js', type: 'blob', size: 500 },
              { path: 'dist/bundle.js', type: 'blob', size: 15000 },
              { path: 'assets/logo.png', type: 'blob', size: 22000 },
              { path: 'api/paypal/webhook.ts', type: 'blob', size: 1400 },
              { path: 'services/qlooClient.ts', type: 'blob', size: 1100 },
              { path: 'services/geminiService.ts', type: 'blob', size: 1000 },
              { path: 'supabase/migrations/001_rls.sql', type: 'blob', size: 950 },
              { path: 'middleware/auth.ts', type: 'blob', size: 800 },
              { path: 'tests/webhook.test.ts', type: 'blob', size: 900 },
              { path: 'server/huge-dump.ts', type: 'blob', size: 450_000 }
            ]
          }),
          { status: 200, headers: makeHeaders({ 'x-ratelimit-remaining': '57' }) }
        );
      }
      if (url.startsWith('https://raw.githubusercontent.com/acme/sample-app/main/')) {
        const filePath = decodeURIComponent(
          url.replace('https://raw.githubusercontent.com/acme/sample-app/main/', '')
        );
        const contents: Record<string, string> = {
          'README.md': longReadme,
          '.env.example': 'PAYPAL_CLIENT_ID=""\nPAYPAL_CLIENT_SECRET=""\nQLOO_API_KEY=""',
          'api/paypal/webhook.ts':
            'export async function verifyPayPalWebhook(headers: Record<string,string>) { const secret = process.env.PAYPAL_WEBHOOK_ID; return Boolean(secret && headers["paypal-transmission-sig"]); }',
          'services/qlooClient.ts':
            'export async function fetchQlooInsights(entity: string) { const key = "qloo_secret_real_token_987654"; return fetch("https://api.qloo.com/v2/insights", { headers: { "X-Api-Key": key } }); }',
          'services/geminiService.ts':
            'import { GoogleGenAI } from "@google/genai"; export const callGemini = () => new GoogleGenAI({});',
          'supabase/migrations/001_rls.sql':
            'ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;\nCREATE POLICY "owner_only" ON transactions FOR SELECT USING (auth.uid() = user_id);',
          'middleware/auth.ts': 'export function requireAuth(uid?: string) { if (!uid) throw new Error("401"); }',
          'tests/webhook.test.ts': 'test("rejects missing signature", () => expect(false).toBe(false));'
        };
        if (filePath in contents) {
          return new Response(contents[filePath], { status: 200 });
        }
      }
      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const inspection = await inspectPublicGitHubRepo('https://github.com/acme/sample-app');

    expect(inspection.accessible).toBe(true);
    expect(inspection.defaultBranch).toBe('main');
    expect(inspection.treeDiscoveryMethod).toBe('git_trees');
    expect(inspection.readmeExcerpt?.length).toBe(longReadme.length);
    expect(inspection.readmeTruncated).toBe(false);

    const inspectedPaths = inspection.inspectedFiles.map((f) => f.path);
    expect(inspectedPaths).toContain('api/paypal/webhook.ts');
    expect(inspectedPaths).toContain('services/qlooClient.ts');
    expect(inspectedPaths).toContain('services/geminiService.ts');
    expect(inspectedPaths).toContain('supabase/migrations/001_rls.sql');
    expect(inspectedPaths).toContain('middleware/auth.ts');
    expect(inspectedPaths).toContain('tests/webhook.test.ts');
    expect(inspectedPaths).toContain('.env.example');

    // Sensitive files, node_modules, dist, images, and oversized files must NOT be fetched/inspected
    expect(inspectedPaths).not.toContain('.env');
    expect(inspectedPaths).not.toContain('.env.production');
    expect(inspectedPaths).not.toContain('node_modules/pkg/index.js');
    expect(inspectedPaths).not.toContain('dist/bundle.js');
    expect(inspectedPaths).not.toContain('assets/logo.png');
    expect(inspectedPaths).not.toContain('server/huge-dump.ts');

    // Sensitive skipped files & oversized files must be tracked transparently
    expect(inspection.uninspectedImportantFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '.env', reason: 'sensitive_env_or_secret_file' }),
        expect.objectContaining({ path: '.env.production', reason: 'sensitive_env_or_secret_file' }),
        expect.objectContaining({ path: 'server/huge-dump.ts', reason: 'file_too_large' })
      ])
    );

    // Inline literal API secret inside services/qlooClient.ts must be redacted
    const qlooFile = inspection.inspectedFiles.find((f) => f.path === 'services/qlooClient.ts');
    expect(qlooFile?.excerpt).not.toContain('qloo_secret_real_token_987654');
    expect(inspection.redactedSecretsCount).toBeGreaterThanOrEqual(1);
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('/.env') && !String(u).includes('.env.example'))
    ).toBe(false);
  });

  it('falls back to Contents API BFS with Link pagination when Git Tree is truncated', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/bigorg/monorepo') {
        return new Response(
          JSON.stringify({ default_branch: 'main', language: 'TypeScript', stargazers_count: 100 }),
          { status: 200, headers: makeHeaders({ 'x-ratelimit-remaining': '50' }) }
        );
      }
      if (url.includes('/git/trees/main?recursive=1')) {
        return new Response(
          JSON.stringify({
            truncated: true,
            tree: [{ path: 'README.md', type: 'blob', size: 100 }]
          }),
          { status: 200, headers: makeHeaders({ 'x-ratelimit-remaining': '49' }) }
        );
      }
      if (url === 'https://api.github.com/repos/bigorg/monorepo/contents?ref=main') {
        return new Response(
          JSON.stringify([
            { type: 'dir', path: 'api', name: 'api' },
            { type: 'file', path: 'package.json', name: 'package.json', size: 300 }
          ]),
          {
            status: 200,
            headers: makeHeaders({
              'x-ratelimit-remaining': '48',
              link: '<https://api.github.com/repos/bigorg/monorepo/contents?ref=main&page=2>; rel="next"'
            })
          }
        );
      }
      if (url === 'https://api.github.com/repos/bigorg/monorepo/contents?ref=main&page=2') {
        return new Response(
          JSON.stringify([{ type: 'dir', path: 'tests', name: 'tests' }]),
          { status: 200, headers: makeHeaders({ 'x-ratelimit-remaining': '47' }) }
        );
      }
      if (url === 'https://api.github.com/repos/bigorg/monorepo/contents/api?ref=main') {
        return new Response(
          JSON.stringify([{ type: 'file', path: 'api/checkout.ts', name: 'checkout.ts', size: 420 }]),
          { status: 200, headers: makeHeaders({ 'x-ratelimit-remaining': '46' }) }
        );
      }
      if (url === 'https://api.github.com/repos/bigorg/monorepo/contents/tests?ref=main') {
        return new Response(
          JSON.stringify([{ type: 'file', path: 'tests/checkout.test.ts', name: 'checkout.test.ts', size: 220 }]),
          { status: 200, headers: makeHeaders({ 'x-ratelimit-remaining': '45' }) }
        );
      }
      if (url.startsWith('https://raw.githubusercontent.com/bigorg/monorepo/main/')) {
        const p = url.replace('https://raw.githubusercontent.com/bigorg/monorepo/main/', '');
        return new Response(`// content of ${p}`, { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);
    const inspection = await inspectPublicGitHubRepo('https://github.com/bigorg/monorepo');

    expect(inspection.accessible).toBe(true);
    expect(inspection.treeTruncated).toBe(true);
    const paths = inspection.inspectedFiles.map((f) => f.path);
    expect(paths).toContain('api/checkout.ts');
    expect(paths).toContain('tests/checkout.test.ts');
    expect(paths).toContain('package.json');
  });

  it('honors AbortSignal cancellation immediately', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await inspectPublicGitHubRepo('https://github.com/acme/repo', {
      signal: controller.signal
    });

    expect(res.accessible).toBe(false);
    expect(res.aborted).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports multi-batch >18 files, chunked line ranges on large files, duplicate SHA & divergent root detection, and commit SHA caching', async () => {
    const { clearRepoInspectionCache } = await import('../../src/services/github/repoInspector');
    clearRepoInspectionCache();

    // Generate 24 prioritized source files + duplicate SHA files + multiple package.json roots + 1 large chunked file
    const treeEntries = [
      { path: 'README.md', type: 'blob', size: 120, sha: 'sha_readme' },
      { path: 'package.json', type: 'blob', size: 150, sha: 'sha_pkg_root' },
      { path: 'frontend/package.json', type: 'blob', size: 150, sha: 'sha_pkg_sub' },
      { path: 'frontend/src/App.tsx', type: 'blob', size: 200, sha: 'sha_dup_1' },
      { path: 'examples/AppCopy.tsx', type: 'blob', size: 200, sha: 'sha_dup_1' },
      ...Array.from({ length: 21 }, (_, idx) => ({
        path: `api/route_${idx + 1}.ts`,
        type: 'blob',
        size: 180,
        sha: `sha_route_${idx + 1}`
      })),
      { path: 'services/largeAnalyzer.ts', type: 'blob', size: 25_000, sha: 'sha_large' }
    ];

    const largeFileLines = [
      '// Line 1 header',
      ...Array.from({ length: 180 }, (_, idx) => `const filler_${idx} = ${idx};`),
      'export async function verifyWebhookSignature(sig: string) { return Boolean(sig); }',
      ...Array.from({ length: 140 }, (_, idx) => `const tail_${idx} = ${idx};`)
    ].join('\n');

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/multi/app') {
        return new Response(
          JSON.stringify({ default_branch: 'main', language: 'TypeScript', stargazers_count: 15 }),
          { status: 200, headers: makeHeaders({ 'x-ratelimit-remaining': '50' }) }
        );
      }
      if (url === 'https://api.github.com/repos/multi/app/commits/main') {
        return new Response(JSON.stringify({ sha: 'deadbeef1234567890' }), {
          status: 200,
          headers: makeHeaders({ 'x-ratelimit-remaining': '49' })
        });
      }
      if (url.includes('/git/trees/deadbeef1234567890?recursive=1')) {
        return new Response(
          JSON.stringify({ truncated: false, tree: treeEntries }),
          { status: 200, headers: makeHeaders({ 'x-ratelimit-remaining': '48' }) }
        );
      }
      if (url.startsWith('https://raw.githubusercontent.com/multi/app/deadbeef1234567890/')) {
        const p = decodeURIComponent(
          url.replace('https://raw.githubusercontent.com/multi/app/deadbeef1234567890/', '')
        );
        if (p === 'services/largeAnalyzer.ts') {
          return new Response(largeFileLines, { status: 200 });
        }
        return new Response(`// file ${p}\nexport const ok = true;`, { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const firstRun = await inspectPublicGitHubRepo('https://github.com/multi/app', {
      maxFiles: 30,
      batchSize: 10,
      maxPerFileChars: 1_500
    });

    expect(firstRun.accessible).toBe(true);
    expect(firstRun.commitSha).toBe('deadbeef1234567890');
    expect(firstRun.commitShaVerified).toBe(true);
    expect(firstRun.inspectedFiles.length).toBeGreaterThan(18);
    expect(firstRun.batchesProcessed).toBeGreaterThanOrEqual(2);
    expect(firstRun.hasDivergentRoots).toBe(true);
    expect(firstRun.projectRoots.some((r) => r.rootPath === '.' && r.selectedAsPrimary)).toBe(true);
    expect(firstRun.duplicateFileGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sha: 'sha_dup_1',
          paths: expect.arrayContaining(['frontend/src/App.tsx', 'examples/AppCopy.tsx'])
        })
      ])
    );
    // Ensure raw fetches strictly used commit SHA rather than floating branch HEAD
    expect(
      fetchMock.mock.calls.some(([u]) =>
        String(u).startsWith('https://raw.githubusercontent.com/multi/app/main/')
      )
    ).toBe(false);

    const chunkedFile = firstRun.inspectedFiles.find((f) => f.path === 'services/largeAnalyzer.ts');
    expect(chunkedFile?.truncated).toBe(true);
    expect(chunkedFile?.chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunkedFile?.chunks[0]?.startLine).toBe(1);
    expect(chunkedFile?.blobUrl).toContain('#L');

    // Repeat inspection on the same commit SHA & options should reuse in-memory cache cleanly
    const callsBeforeRepeat = fetchMock.mock.calls.length;
    const secondRun = await inspectPublicGitHubRepo('https://github.com/multi/app', {
      maxFiles: 30,
      batchSize: 10,
      maxPerFileChars: 1_500
    });
    expect(secondRun.fromCache).toBe(true);
    expect(secondRun.inspectedFiles.length).toBe(firstRun.inspectedFiles.length);
    // Only meta + commit SHA check executed on cache hit (no tree/raw file refetches)
    expect(fetchMock.mock.calls.length - callsBeforeRepeat).toBeLessThanOrEqual(2);

    // Different strategyHints or maxPerFileChars must NOT hit the previous cache entry
    const differentHintsRun = await inspectPublicGitHubRepo('https://github.com/multi/app', {
      maxFiles: 30,
      batchSize: 10,
      maxPerFileChars: 2_000,
      strategyHints: ['payments']
    });
    expect(differentHintsRun.fromCache).toBeUndefined();
  });

  it('redacts unquoted secrets, DB credentials, AWS keys, JWTs, and Slack tokens while preserving TS types and line numbers', () => {
    const sample = [
      'interface Config {',
      '  secret: string;',
      '  token: boolean;',
      '}',
      'PAYPAL_SECRET=live_abc123456789',
      'TOKEN: mytoken123456',
      'const db = "postgres://admin:SuperPass123@db.internal:5432/app";',
      'const awsKey = "AKIA1234567890ABCDEF";',
      'const slack = "xoxb-123456789012-123456789012-abcdefghijklmnop";',
      'const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.signaturepart123";',
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
      'SECOND_KEY_LINE_DATA_1234567890',
      '-----END PRIVATE KEY-----',
      'export const afterKeyMarker = "safe_code_after_pem";'
    ].join('\n');

    const { sanitized, count } = redactSecrets(sample);

    expect(count).toBeGreaterThanOrEqual(6);
    expect(sanitized).toContain('  secret: string;');
    expect(sanitized).toContain('  token: boolean;');
    expect(sanitized).not.toContain('live_abc123456789');
    expect(sanitized).not.toContain('mytoken123456');
    expect(sanitized).not.toContain('SuperPass123');
    expect(sanitized).not.toContain('AKIA1234567890ABCDEF');
    expect(sanitized).not.toContain('xoxb-123456789012');
    expect(sanitized).not.toContain('signaturepart123');
    expect(sanitized).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');

    // Multiline PEM redaction must preserve exact line numbers
    const originalLines = sample.split('\n');
    const sanitizedLines = sanitized.split('\n');
    expect(sanitizedLines.length).toBe(originalLines.length);
    const originalMarkerIdx = originalLines.findIndex((l) => l.includes('afterKeyMarker'));
    const sanitizedMarkerIdx = sanitizedLines.findIndex((l) => l.includes('afterKeyMarker'));
    expect(sanitizedMarkerIdx).toBe(originalMarkerIdx);
  });

  it('excludes .npmrc, .netrc, .htpasswd, .pgpass, appsettings.*.json, *.tfstate, and .env.* before fetch and never persists repo data in localStorage', async () => {
    const { clearRepoInspectionCache } = await import('../../src/services/github/repoInspector');

    const storageMap = new Map<string, string>([
      ['hackmind_repo_inspect_v2:legacy/repo@123', '{"stale":"secret_cache"}']
    ]);
    const setItemSpy = vi.fn((k: string, v: string) => storageMap.set(k, v));
    const removeItemSpy = vi.fn((k: string) => storageMap.delete(k));
    vi.stubGlobal('localStorage', {
      get length() {
        return storageMap.size;
      },
      key: (idx: number) => Array.from(storageMap.keys())[idx] ?? null,
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: setItemSpy,
      removeItem: removeItemSpy
    });

    clearRepoInspectionCache();

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/sec/test-app') {
        return new Response(
          JSON.stringify({ default_branch: 'main', language: 'TypeScript', stargazers_count: 1 }),
          { status: 200 }
        );
      }
      if (url === 'https://api.github.com/repos/sec/test-app/commits/main') {
        return new Response(JSON.stringify({ sha: 'cafebabe11223344' }), { status: 200 });
      }
      if (url.includes('/git/trees/cafebabe11223344?recursive=1')) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              { path: 'README.md', type: 'blob', size: 80 },
              { path: '.npmrc', type: 'blob', size: 120 },
              { path: '.netrc', type: 'blob', size: 120 },
              { path: '.htpasswd', type: 'blob', size: 120 },
              { path: '.pgpass', type: 'blob', size: 120 },
              { path: 'appsettings.Production.json', type: 'blob', size: 220 },
              { path: 'infra/terraform.tfstate', type: 'blob', size: 500 },
              { path: '.env.staging', type: 'blob', size: 90 },
              { path: 'src/index.ts', type: 'blob', size: 140 }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.startsWith('https://raw.githubusercontent.com/sec/test-app/cafebabe11223344/')) {
        const p = url.replace('https://raw.githubusercontent.com/sec/test-app/cafebabe11223344/', '');
        if (p === 'README.md') return new Response('# Safe README', { status: 200 });
        if (p === 'src/index.ts') return new Response('export const ok = true;', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const inspection = await inspectPublicGitHubRepo('https://github.com/sec/test-app');
    expect(inspection.accessible).toBe(true);
    expect(inspection.inspectedFiles.map((f) => f.path)).toEqual(['src/index.ts']);

    const sensitivePaths = [
      '.npmrc',
      '.netrc',
      '.htpasswd',
      '.pgpass',
      'appsettings.Production.json',
      'infra/terraform.tfstate',
      '.env.staging'
    ];
    for (const sensitivePath of sensitivePaths) {
      expect(inspection.uninspectedImportantFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: sensitivePath, reason: 'sensitive_env_or_secret_file' })
        ])
      );
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes(sensitivePath))).toBe(false);
    }

    // Legacy localStorage cache entry must be purged and no new entries written to localStorage
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(Array.from(storageMap.keys()).some((k) => k.startsWith('hackmind_repo_inspect_v2:'))).toBe(
      false
    );
  });

  it('never assigns treeData.sha to commitSha when commit resolution fails and discloses unverified commit', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/unverified/repo') {
        return new Response(
          JSON.stringify({ default_branch: 'main', language: 'TypeScript' }),
          { status: 200 }
        );
      }
      if (url === 'https://api.github.com/repos/unverified/repo/commits/main') {
        return new Response('Forbidden', { status: 403 });
      }
      if (url.includes('/git/trees/main?recursive=1')) {
        return new Response(
          JSON.stringify({
            sha: 'treesha9999999999999999',
            truncated: false,
            tree: [{ path: 'server/app.ts', type: 'blob', size: 80 }]
          }),
          { status: 200 }
        );
      }
      if (url === 'https://raw.githubusercontent.com/unverified/repo/main/server/app.ts') {
        return new Response('export const port = 3000;', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const inspection = await inspectPublicGitHubRepo('https://github.com/unverified/repo');
    expect(inspection.accessible).toBe(true);
    expect(inspection.commitSha).toBeNull();
    expect(inspection.commitShaVerified).toBe(false);
    expect(inspection.reason).toContain('commit SHA unverified');
  });

  it('unconditionally purges legacy localStorage caches even when useCache is false and commit lookup fails (403)', async () => {
    const { clearRepoInspectionCache } = await import('../../src/services/github/repoInspector');
    clearRepoInspectionCache();

    const storageMap = new Map<string, string>([
      ['hackmind_repo_inspect_v2:legacy/a@main', '{"raw":"stale_secret_excerpt"}'],
      ['hackmind_repo_inspect_v2:legacy/b@1234', '{"raw":"another_stale_excerpt"}'],
      ['unrelated_app_key', 'keep_me']
    ]);
    vi.stubGlobal('localStorage', {
      get length() {
        return storageMap.size;
      },
      key: (idx: number) => Array.from(storageMap.keys())[idx] ?? null,
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => storageMap.set(k, v),
      removeItem: (k: string) => storageMap.delete(k)
    });

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/nocache/repo') {
        return new Response(
          JSON.stringify({ default_branch: 'main', language: 'TypeScript' }),
          { status: 200 }
        );
      }
      if (url === 'https://api.github.com/repos/nocache/repo/commits/main') {
        return new Response('Forbidden', { status: 403 });
      }
      if (url.includes('/git/trees/main?recursive=1')) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [{ path: 'src/app.ts', type: 'blob', size: 60 }]
          }),
          { status: 200 }
        );
      }
      if (url === 'https://raw.githubusercontent.com/nocache/repo/main/src/app.ts') {
        return new Response('export const ready = true;', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await inspectPublicGitHubRepo('https://github.com/nocache/repo', { useCache: false });

    expect(Array.from(storageMap.keys()).some((k) => k.startsWith('hackmind_repo_inspect_v2:'))).toBe(
      false
    );
    expect(storageMap.get('unrelated_app_key')).toBe('keep_me');
  });

  it('records oversized frontend_source files in fileInventory as file_too_large instead of non_code_documentation', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/bigbundle/app') {
        return new Response(
          JSON.stringify({ default_branch: 'main', language: 'TypeScript' }),
          { status: 200 }
        );
      }
      if (url === 'https://api.github.com/repos/bigbundle/app/commits/main') {
        return new Response(JSON.stringify({ sha: 'aaa111bbb222' }), { status: 200 });
      }
      if (url.includes('/git/trees/aaa111bbb222?recursive=1')) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              { path: 'src/index.ts', type: 'blob', size: 120 },
              { path: 'src/generated/hugeBundle.ts', type: 'blob', size: 420_000 }
            ]
          }),
          { status: 200 }
        );
      }
      if (url === 'https://raw.githubusercontent.com/bigbundle/app/aaa111bbb222/src/index.ts') {
        return new Response('export const ok = true;', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const inspection = await inspectPublicGitHubRepo('https://github.com/bigbundle/app');
    const hugeEntry = inspection.fileInventory.find(
      (item) => item.path === 'src/generated/hugeBundle.ts'
    );
    expect(hugeEntry).toBeDefined();
    expect(hugeEntry?.inspectionStatus).toBe('skipped');
    expect(hugeEntry?.reason).toBe('file_too_large');
  });

  it('excludes .tfvars and SSH/AWS credential files, redacts OPENSSH/PGP/webhook secrets, and marks file_count_limit frontend_source cleanly', async () => {
    const redacted = redactSecrets(
      [
        'WEBHOOK_SECRET = "super_hook_value"',
        'SLACK_WEBHOOK = https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
        '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----',
        '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF...\n-----END PGP PRIVATE KEY BLOCK-----'
      ].join('\n')
    );
    expect(redacted.count).toBeGreaterThanOrEqual(4);
    expect(redacted.sanitized).not.toContain('super_hook_value');
    expect(redacted.sanitized).not.toContain('T00000000/B00000000');
    expect(redacted.sanitized).not.toContain('b3BlbnNzaC1rZXktdjE');
    expect(redacted.sanitized).not.toContain('lQOYBF');

    const extraFrontend = Array.from({ length: 18 }, (_, i) => ({
      path: `src/components/Widget${i}.tsx`,
      type: 'blob' as const,
      size: 120
    }));

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/sec/test') {
        return new Response(
          JSON.stringify({ default_branch: 'main', language: 'TypeScript' }),
          { status: 200 }
        );
      }
      if (url === 'https://api.github.com/repos/sec/test/commits/main') {
        return new Response(JSON.stringify({ sha: 'deadbeef123456' }), { status: 200 });
      }
      if (url.includes('/git/trees/deadbeef123456?recursive=1')) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              { path: 'infra/prod.tfvars', type: 'blob', size: 100 },
              { path: 'infra/terraform.tfvars.json', type: 'blob', size: 100 },
              { path: '.ssh/id_ed25519', type: 'blob', size: 100 },
              { path: '.aws/credentials', type: 'blob', size: 100 },
              { path: 'src/App.tsx', type: 'blob', size: 100 },
              ...extraFrontend
            ]
          }),
          { status: 200 }
        );
      }
      if (url.startsWith('https://raw.githubusercontent.com/sec/test/deadbeef123456/')) {
        return new Response('export const ok = true;', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const inspection = await inspectPublicGitHubRepo('https://github.com/sec/test', {
      maxFiles: 4
    });

    for (const secretPath of [
      'infra/prod.tfvars',
      'infra/terraform.tfvars.json',
      '.ssh/id_ed25519',
      '.aws/credentials'
    ]) {
      const inv = inspection.fileInventory.find((x) => x.path === secretPath);
      expect(inv?.inspectionStatus).toBe('skipped');
      expect(inv?.reason).toBe('sensitive_env_or_secret_file');
      expect(inspection.inspectedFiles.some((f) => f.path === secretPath)).toBe(false);
    }

    const limitSkippedFrontend = inspection.fileInventory.filter(
      (x) => x.path.startsWith('src/components/Widget') && x.inspectionStatus === 'skipped'
    );
    expect(limitSkippedFrontend.length).toBeGreaterThan(0);
    for (const entry of limitSkippedFrontend) {
      expect(entry.reason).toBe('file_count_limit');
    }
  });

  it('deduplicates GITHUB_UPLOAD mirror copies by SHA, prioritizes primary root entrypoints, and labels interrupted unreached files as batch_interrupted (not budget_limit)', async () => {
    const {
      clearRepoInspectionCache,
      discoverGitHubRepoPlan,
      finalizeGitHubRepoInspection,
      inspectGitHubRepoBatchSlice
    } = await import('../../src/services/github/repoInspector');
    clearRepoInspectionCache();

    const tree = [
      { path: 'README.md', type: 'blob', size: 100, sha: 'sha_readme' },
      { path: 'package.json', type: 'blob', size: 120, sha: 'sha_pkg' },
      { path: 'src/App.tsx', type: 'blob', size: 180, sha: 'sha_app' },
      { path: 'src/auth/guard.ts', type: 'blob', size: 150, sha: 'sha_auth' },
      { path: 'GITHUB_UPLOAD/package.json', type: 'blob', size: 120, sha: 'sha_pkg' },
      { path: 'GITHUB_UPLOAD/src/App.tsx', type: 'blob', size: 180, sha: 'sha_app' },
      { path: 'GITHUB_UPLOAD/src/auth/guard.ts', type: 'blob', size: 150, sha: 'sha_auth' }
    ];

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/mirror/app') {
        return new Response(
          JSON.stringify({ default_branch: 'main', language: 'TypeScript' }),
          { status: 200 }
        );
      }
      if (url === 'https://api.github.com/repos/mirror/app/commits/main') {
        return new Response(JSON.stringify({ sha: 'abcd1234ef567890' }), { status: 200 });
      }
      if (url.includes('/git/trees/abcd1234ef567890?recursive=1')) {
        return new Response(JSON.stringify({ truncated: false, tree }), { status: 200 });
      }
      if (url.startsWith('https://raw.githubusercontent.com/mirror/app/abcd1234ef567890/')) {
        const p = url.replace('https://raw.githubusercontent.com/mirror/app/abcd1234ef567890/', '');
        if (p === 'README.md') return new Response('# Mirror App', { status: 200 });
        return new Response(`// ${p}\nexport const ok = true;`, { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const plan = await discoverGitHubRepoPlan('https://github.com/mirror/app', {
      useCache: false
    });

    // Primary root '.' selected; GITHUB_UPLOAD mirror files deduplicated before batching
    expect(plan.projectRoots.find((r) => r.selectedAsPrimary)?.rootPath).toBe('.');
    expect(plan.duplicateMirrorPaths).toEqual(
      expect.arrayContaining([
        'GITHUB_UPLOAD/package.json',
        'GITHUB_UPLOAD/src/App.tsx',
        'GITHUB_UPLOAD/src/auth/guard.ts'
      ])
    );
    expect(plan.selectedEntries.map((e) => e.entry.path)).toEqual(
      expect.arrayContaining(['package.json', 'src/App.tsx', 'src/auth/guard.ts'])
    );
    expect(plan.selectedEntries.some((e) => e.entry.path.startsWith('GITHUB_UPLOAD/'))).toBe(false);

    // Fetch only first selected entry and finalize as interrupted
    const firstSlice = await inspectGitHubRepoBatchSlice(plan, plan.selectedEntries.slice(0, 1));
    const interruptedInspection = finalizeGitHubRepoInspection(plan, {
      inspectedFiles: firstSlice.inspectedFiles,
      extraSkipped: firstSlice.skippedOrFailed,
      batchesProcessed: 1,
      redactedSecretsCount: 0,
      interrupted: true
    });

    // Mirror copies are marked duplicate_mirror
    expect(
      interruptedInspection.fileInventory.find((f) => f.path === 'GITHUB_UPLOAD/src/App.tsx')?.reason
    ).toBe('duplicate_mirror');

    // Unreached files from primary root must be batch_interrupted, NEVER budget_limit
    expect(interruptedInspection.uninspectedImportantFiles.length).toBeGreaterThan(0);
    for (const u of interruptedInspection.uninspectedImportantFiles) {
      expect(u.reason).toBe('batch_interrupted');
    }
  });
});
