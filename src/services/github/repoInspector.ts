import { parseGitHubOwnerRepo } from '../../utils/validation';
import type {
  CanonicalFileInspectionStatus,
  DuplicateFileGroup,
  FileContentChunk,
  FileInventoryItem,
  ProjectInspectionStrategy,
  ProjectRootCandidate
} from '../judging/evidenceTypes';

export function normalizeRepoPath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

export type GitHubFileCategory =
  | 'readme'
  | 'server_api'
  | 'auth_rbac'
  | 'database_rls'
  | 'payments_paypal'
  | 'qloo_integration'
  | 'gemini_ai'
  | 'tests'
  | 'deployment'
  | 'config_security'
  | 'frontend_source';

export type SkippedFileReason =
  | 'sensitive_env_or_secret_file'
  | 'file_too_large'
  | 'budget_limit'
  | 'file_count_limit'
  | 'binary_or_asset'
  | 'fetch_failed'
  | 'inaccessible_http_error'
  | 'rate_limited'
  | 'batch_interrupted'
  | 'duplicate_mirror';

export function toCanonicalFileStatus(
  status: FileInventoryItem['inspectionStatus']
): CanonicalFileInspectionStatus {
  switch (status) {
    case 'inspected':
      return 'FULLY_INSPECTED';
    case 'partially_inspected':
      return 'PARTIALLY_INSPECTED';
    case 'inaccessible':
      return 'INACCESSIBLE';
    case 'failed':
      return 'FAILED';
    case 'skipped':
    default:
      return 'SKIPPED';
  }
}

export interface InspectedRepoFile {
  path: string;
  category: GitHubFileCategory;
  sizeBytes: number;
  charsIncluded: number;
  totalLines: number;
  truncated: boolean;
  sourceEndpoint: 'raw' | 'contents_api';
  redactedSecretsCount: number;
  sha?: string;
  blobUrl?: string;
  chunks: FileContentChunk[];
  excerpt: string;
}

export interface SkippedRepoFile {
  path: string;
  category: GitHubFileCategory | 'excluded';
  sizeBytes?: number;
  reason: SkippedFileReason;
}

export interface GitHubRepoInspection {
  accessible: boolean;
  repoFullName: string | null;
  defaultBranch: string | null;
  commitSha: string | null;
  commitShaVerified?: boolean;
  fromCache?: boolean;
  description: string | null;
  primaryLanguage: string | null;
  stars: number | null;
  updatedAt: string | null;
  readmeExcerpt: string | null;
  readmeFullChars: number;
  readmeTruncated: boolean;
  readmePathInspected?: string | null;
  selectedFilesCount?: number;
  treeDiscoveryMethod: 'git_trees' | 'contents_api_bfs' | 'none';
  treeTruncated: boolean;
  totalFilesInTree: number;
  treeSamplePaths: string[];
  inspectedFiles: InspectedRepoFile[];
  uninspectedImportantFiles: SkippedRepoFile[];
  fileInventory: FileInventoryItem[];
  duplicateFileGroups: DuplicateFileGroup[];
  projectRoots: ProjectRootCandidate[];
  hasDivergentRoots: boolean;
  batchesProcessed: number;
  detectedCategories: GitHubFileCategory[];
  redactedSecretsCount: number;
  rateLimitRemaining: number | null;
  aborted: boolean;
  reason: string;
}

export interface GitHubInspectOptions {
  signal?: AbortSignal;
  maxFiles?: number;
  batchSize?: number;
  maxTotalChars?: number;
  maxFileSizeBytes?: number;
  maxPerFileChars?: number;
  maxReadmeChars?: number;
  maxContentsApiDirs?: number;
  strategyHints?: ProjectInspectionStrategy[];
  useCache?: boolean;
}

interface TreeBlobEntry {
  path: string;
  size: number;
  sha?: string;
}

const DEFAULT_MAX_FILES = 96;
const DEFAULT_BATCH_SIZE = 12;
const DEFAULT_MAX_TOTAL_CHARS = 240_000;
const DEFAULT_MAX_FILE_SIZE_BYTES = 150_000;
const DEFAULT_MAX_PER_FILE_CHARS = 7_500;
const DEFAULT_MAX_README_CHARS = 16_000;
const DEFAULT_MAX_CONTENTS_DIRS = 16;
const FILE_FETCH_CONCURRENCY = 4;

const REPO_CACHE_PREFIX = 'hackmind_repo_inspect_v2:';
const MAX_MEMORY_CACHE_ENTRIES = 20;
const memoryInspectionCache = new Map<string, GitHubRepoInspection>();

function purgeLegacyLocalStorageRepoCaches(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(REPO_CACHE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    for (const k of keysToRemove) {
      localStorage.removeItem(k);
    }
  } catch {
    // Ignore browser storage errors without exposing repository content
  }
}

export function clearRepoInspectionCache(): void {
  memoryInspectionCache.clear();
  purgeLegacyLocalStorageRepoCaches();
}

function readCachedInspection(cacheKey: string): GitHubRepoInspection | null {
  purgeLegacyLocalStorageRepoCaches();
  const memHit = memoryInspectionCache.get(cacheKey);
  if (memHit && memHit.accessible && memHit.commitSha && memHit.commitShaVerified) {
    return { ...memHit, fromCache: true };
  }
  return null;
}

function writeCachedInspection(cacheKey: string, inspection: GitHubRepoInspection): void {
  // Never store raw repository source excerpts, README content, or chunks in persistent localStorage.
  // Only cache verified commit-pinned inspections inside bounded in-memory session storage.
  if (!inspection.accessible || !inspection.commitSha || !inspection.commitShaVerified) return;
  if (memoryInspectionCache.size >= MAX_MEMORY_CACHE_ENTRIES) {
    const oldestKey = memoryInspectionCache.keys().next().value;
    if (oldestKey) {
      memoryInspectionCache.delete(oldestKey);
    }
  }
  memoryInspectionCache.set(cacheKey, inspection);
}

const EXCLUDED_DIR_PREFIXES = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  '.next/',
  'out/',
  'coverage/',
  '.turbo/',
  '.cache/',
  '.venv/',
  'venv/',
  '__pycache__/',
  'vendor/',
  'target/'
];

const EXCLUDED_FILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'composer.lock',
  'cargo.lock',
  'poetry.lock'
]);

const BINARY_OR_MINIFIED_PATTERN =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff|woff2?|ttf|eot|otf|mp3|mp4|webm|mov|wav|pdf|zip|gz|tar|7z|wasm|exe|dll|so|dylib|class|jar|map)$/i;
const MINIFIED_PATTERN = /\.min\.(js|css)$/i;

// Sensitive files that must NEVER be fetched or forwarded to Gemini
const SENSITIVE_FILE_PATTERN =
  /(^|\/)(\.env(\.[a-z0-9._-]+)?|\.npmrc|\.netrc|\.htpasswd|\.pgpass|appsettings(\.[a-z0-9._-]+)?\.json|.*\.tfstate(\.backup)?|.*\.tfvars(\.json)?|\.aws\/(?:credentials|config)|kubeconfig(\.ya?ml)?|service[-_]?account.*\.json|.*credentials.*\.json|secrets?\.(json|ya?ml|toml|ts|js)|id_(?:rsa|dsa|ecdsa|ed25519)(\.pub)?|ssh_host_.*_key(\.pub)?|.*\.(pem|key|p12|pfx|keystore|ppk))$/i;

const SECRET_KEY_NAMES =
  '(?:API[-_]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|PRIVATE[-_]?KEY|CLIENT[-_]?SECRET|CLIENT[-_]?ID|WEBHOOK[-_]?(?:SECRET|URL)|SERVICE[-_]?ROLE|ACCESS[-_]?KEY|SECRET[-_]?KEY|AUTH[-_]?KEY|SIGNING[-_]?KEY|JWT[-_]?SECRET|SESSION[-_]?SECRET|ENCRYPT(?:ION)?[-_]?KEY|SSH[-_]?KEY|DEPLOY[-_]?KEY|BASIC[-_]?AUTH|DATABASE[-_]?URL|DB[-_]?URL|CONNECTION[-_]?STRING|MASTER[-_]?KEY)';

const SECRET_ENV_VAR_ASSIGNMENT_PATTERN = new RegExp(
  `(["'\`]?[A-Za-z0-9_-]*${SECRET_KEY_NAMES}[A-Za-z0-9_-]*["'\`]?)\\s*([:=])\\s*(["'\`])([^"'\`\\r\\n]{6,})\\3`,
  'gi'
);

const UNQUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `(^|[\\s,;({])(["'\`]?[A-Za-z0-9_-]*${SECRET_KEY_NAMES}[A-Za-z0-9_-]*["'\`]?)\\s*([:=])\\s*(?!["'\`])([^\\s#"'\\x60,;}\\]]{6,})`,
  'gim'
);

const DB_CONNECTION_CREDENTIAL_PATTERN =
  /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql|sqlserver):\/\/)([^:\s"'`<>@/]+):([^@\s"'`<>]+)@/gi;

const KNOWN_SECRET_TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?:\s+BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?:\s+BLOCK)?-----/g,
  /PuTTY-User-Key-File-[0-9]+:[\s\S]*?Private-MAC:\s*[0-9a-fA-F]+/gi,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\b(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{18,}\b/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:npm|hf)_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi,
  /\bA21AA[A-Za-z0-9_-]{24,}\b/g, // PayPal OAuth access token signature
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
  /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
  /(["'`])[a-z0-9]+_(?:secret|token|apikey)_[A-Za-z0-9_-]{10,}\1/gi
];

const PLACEHOLDER_VALUE_PATTERN =
  /^(your[_-]|replace[_-]|example|sample|dummy|test[_-]|fake[_-]|placeholder|<[^>]+>|\*{3,}|x{4,}|process\.env|import\.meta\.env|\$\{[^}]+\}|\[REDACTED_SECRET\])/i;

const NON_SECRET_TYPE_KEYWORDS = new Set([
  'string',
  'number',
  'boolean',
  'undefined',
  'null',
  'true',
  'false',
  'any',
  'unknown',
  'never',
  'void',
  'object'
]);

function preserveLineCountRedaction(matched: string, replacement = '[REDACTED_SECRET]'): string {
  const newlineCount = (matched.match(/\n/g) || []).length;
  if (newlineCount === 0) return replacement;
  return Array(newlineCount + 1).fill(replacement).join('\n');
}

function isAllowedPublicKeyVar(keyName: string, value: string): boolean {
  const cleanKey = keyName.replace(/["'`]/g, '');
  return (
    /^(VITE_RECAPTCHA_.*SITE_KEY|.*_PUBLIC_KEY)$/i.test(cleanKey) &&
    !/(SECRET|PRIVATE|TOKEN|PASSWORD)/i.test(cleanKey) &&
    !value.startsWith('sk_')
  );
}

export function redactSecrets(input: string): { sanitized: string; count: number } {
  if (!input) return { sanitized: '', count: 0 };
  let sanitized = input;
  let count = 0;

  sanitized = sanitized.replace(
    DB_CONNECTION_CREDENTIAL_PATTERN,
    (fullMatch, proto: string, _user: string, pass: string) => {
      const trimmedPass = pass.trim();
      if (PLACEHOLDER_VALUE_PATTERN.test(trimmedPass)) {
        return fullMatch;
      }
      count += 1;
      return `${proto}[REDACTED_SECRET]@`;
    }
  );

  for (const pattern of KNOWN_SECRET_TOKEN_PATTERNS) {
    sanitized = sanitized.replace(pattern, (matched) => {
      count += 1;
      return preserveLineCountRedaction(matched);
    });
  }

  sanitized = sanitized.replace(
    SECRET_ENV_VAR_ASSIGNMENT_PATTERN,
    (fullMatch, keyName: string, sep: string, quote: string, value: string) => {
      const trimmedVal = value.trim();
      if (PLACEHOLDER_VALUE_PATTERN.test(trimmedVal)) {
        return fullMatch;
      }
      if (isAllowedPublicKeyVar(keyName, trimmedVal)) {
        return fullMatch;
      }
      count += 1;
      return `${keyName}${sep}${quote}[REDACTED_SECRET]${quote}`;
    }
  );

  sanitized = sanitized.replace(
    UNQUOTED_SECRET_ASSIGNMENT_PATTERN,
    (fullMatch, prefix: string, keyName: string, sep: string, value: string) => {
      const trimmedVal = value.trim();
      if (
        PLACEHOLDER_VALUE_PATTERN.test(trimmedVal) ||
        NON_SECRET_TYPE_KEYWORDS.has(trimmedVal.toLowerCase()) ||
        trimmedVal.startsWith('process.env') ||
        trimmedVal.startsWith('import.meta.env')
      ) {
        return fullMatch;
      }
      if (isAllowedPublicKeyVar(keyName, trimmedVal)) {
        return fullMatch;
      }
      count += 1;
      return `${prefix}${keyName}${sep}[REDACTED_SECRET]`;
    }
  );

  return { sanitized, count };
}

function isSensitivePath(path: string): boolean {
  const lower = path.toLowerCase();
  const baseName = lower.split('/').pop() || lower;
  if (
    baseName === '.env.example' ||
    baseName === '.env.sample' ||
    baseName === '.env.template'
  ) {
    return false;
  }
  return SENSITIVE_FILE_PATTERN.test(lower);
}

function isNoiseOrBinaryPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (EXCLUDED_DIR_PREFIXES.some((prefix) => lower.startsWith(prefix) || lower.includes(`/${prefix}`))) {
    return true;
  }
  const baseName = lower.split('/').pop() || lower;
  if (EXCLUDED_FILE_NAMES.has(baseName)) return true;
  if (BINARY_OR_MINIFIED_PATTERN.test(lower) || MINIFIED_PATTERN.test(lower)) return true;
  return false;
}

function isReadmePath(path: string): boolean {
  const base = (path.split('/').pop() || path).toLowerCase();
  return /^readme(\.(md|mdx|txt|rst))?$/.test(base);
}

export function classifyRepoFile(
  path: string
): { category: GitHubFileCategory; score: number } | null {
  if (isSensitivePath(path) || isNoiseOrBinaryPath(path)) {
    return null;
  }
  if (isReadmePath(path)) {
    return { category: 'readme', score: 100 };
  }

  const lower = path.toLowerCase();
  const base = lower.split('/').pop() || lower;

  // 1. PayPal / payment verification
  if (/(paypal|stripe|payment|webhook|checkout|invoice|settlement|billing|payout|order)/.test(lower)) {
    return { category: 'payments_paypal', score: 96 };
  }

  // 2. Qloo / external data & insight integration
  if (/(qloo|taste|culturepulse|cultural|insight|analytics|pipeline|dataset)/.test(lower)) {
    return { category: 'qloo_integration', score: 95 };
  }

  // 3. Gemini / Vertex / GenAI integration
  if (/(gemini|genai|vertex|firebaseai|hybridai|inferencemanager|llm|prompt|openai|anthropic)/.test(lower)) {
    return { category: 'gemini_ai', score: 94 };
  }

  // 4. RLS / SQL / migrations / database & storage rules
  if (
    /\.sql$/i.test(lower) ||
    base === 'firestore.rules' ||
    base === 'storage.rules' ||
    /(supabase\/migrations|rls|policies|policy|drizzle|prisma\/schema|database|firestore\.rules|storage\.rules|migration|schema)/.test(
      lower
    )
  ) {
    return { category: 'database_rls', score: 92 };
  }

  // 5. Auth / RBAC / Security middleware
  if (/(^|\/|_)(auth|session|jwt|oauth|rbac|permission|guard|middleware|security|validation|appcheck)/.test(lower)) {
    return { category: 'auth_rbac', score: 90 };
  }

  // 6. Tests
  if (
    /(^|\/)(__tests__|tests?|spec)\//.test(lower) ||
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|go)$/i.test(lower) ||
    /^(vitest|jest|playwright|pytest)\.config\./.test(base)
  ) {
    return { category: 'tests', score: 87 };
  }

  // 7. Server / API routes / Edge functions
  if (
    /^(server|app|index|main)\.(ts|js|mjs|py|go)$/.test(base) ||
    /(^|\/)(api|server|backend|routes|controllers|functions|supabase\/functions|app\/api|pages\/api|services)\//.test(
      lower
    )
  ) {
    return { category: 'server_api', score: 88 };
  }

  // 8. Deployment & CI/CD manifests
  if (
    base === 'dockerfile' ||
    /^dockerfile\./.test(base) ||
    /^docker-compose(\.[a-z0-9_-]+)?\.ya?ml$/.test(base) ||
    base === 'firebase.json' ||
    base === 'firestore.indexes.json' ||
    /^apphosting(\.[a-z0-9_-]+)?\.ya?ml$/.test(base) ||
    base === 'vercel.json' ||
    base === 'netlify.toml' ||
    base === 'fly.toml' ||
    base === 'render.yaml' ||
    base === 'procfile' ||
    /^cloudbuild(\.[a-z0-9_-]+)?\.ya?ml$/.test(base) ||
    /^railway\.(json|toml)$/.test(base) ||
    lower.startsWith('.github/workflows/') ||
    lower.startsWith('.github/actions/') ||
    /^(k8s|kubernetes|helm|terraform|infra|deploy(ment)?)\//.test(lower) ||
    /\.tf$/.test(lower)
  ) {
    return { category: 'deployment', score: 86 };
  }

  // 9. Env templates, project manifests, compiler/linter/security configs
  if (
    base === 'package.json' ||
    base === '.env.example' ||
    base === '.env.sample' ||
    base === '.env.template' ||
    base === 'requirements.txt' ||
    base === 'pyproject.toml' ||
    base === 'go.mod' ||
    base === 'cargo.toml' ||
    base === 'tsconfig.json' ||
    /^eslint\.config\.(js|mjs|cjs|ts)$/.test(base) ||
    /^(vite|next|nuxt|astro|svelte|tailwind)\.config\./.test(base) ||
    lower === 'supabase/config.toml'
  ) {
    return { category: 'config_security', score: 84 };
  }

  // 10. Source code fallback (ts/tsx/js/jsx/py/go/rs/java)
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|vue|svelte)$/.test(lower)) {
    const isCoreEntry = /(^|\/)(src|app)\/(app|main|index|router|routes|layout|store)\.(ts|tsx|js|jsx)$/i.test(lower);
    if (isCoreEntry) {
      return { category: 'frontend_source', score: 76 };
    }
    const isTopSrc = /(^|\/)(src|app|lib|services|pages|components|hooks|contexts)\//.test(lower);
    return { category: 'frontend_source', score: isTopSrc ? 68 : 48 };
  }

  return null;
}

const CATEGORY_ORDER: GitHubFileCategory[] = [
  'payments_paypal',
  'qloo_integration',
  'gemini_ai',
  'database_rls',
  'auth_rbac',
  'server_api',
  'tests',
  'deployment',
  'config_security',
  'frontend_source'
];

const MIRROR_UPLOAD_DIR_PATTERN =
  /(^|\/)(github[_-]?upload|uploads?|mirror|mirrored|backup|old|deprecated|archive|examples|samples)(\/|$)/i;

function isPathInsideRoot(path: string, rootPath: string): boolean {
  if (rootPath === '.') return true;
  return path.startsWith(`${rootPath}/`);
}

function computeStrategyBoost(
  category: GitHubFileCategory,
  path: string,
  hints: ProjectInspectionStrategy[],
  primaryRootPath = '.'
): number {
  let boost = 0;
  if (hints.includes('payments') && category === 'payments_paypal') boost += 12;
  if (hints.includes('ai') && category === 'gemini_ai') boost += 12;
  if (hints.includes('data_driven') && category === 'qloo_integration') boost += 12;
  if (hints.includes('security_auth') && (category === 'auth_rbac' || category === 'database_rls')) {
    boost += 10;
  }
  if (/(^|\/)(github[_-]?upload|uploads?|mirror|mirrored)(\/|$)/i.test(path)) {
    boost -= 35;
  } else if (/^(examples|samples|archive|old|backup|deprecated)\//i.test(path)) {
    boost -= 20;
  } else if (primaryRootPath !== '.' && isPathInsideRoot(path, primaryRootPath)) {
    boost += 10;
  } else if (primaryRootPath === '.' && !MIRROR_UPLOAD_DIR_PATTERN.test(path)) {
    boost += 4;
  }
  return boost;
}

function canonicalPriorityTuple(
  item: { entry: TreeBlobEntry; category: GitHubFileCategory; score: number },
  primaryRootPath: string
): [number, number, number, number] {
  const isMirror = MIRROR_UPLOAD_DIR_PATTERN.test(item.entry.path) ? 1 : 0;
  const inPrimary = isPathInsideRoot(item.entry.path, primaryRootPath) ? 0 : 1;
  const depth = item.entry.path.split('/').length;
  return [isMirror, inPrimary, -item.score, depth];
}

function compareCanonicalPreference(
  a: { entry: TreeBlobEntry; category: GitHubFileCategory; score: number },
  b: { entry: TreeBlobEntry; category: GitHubFileCategory; score: number },
  primaryRootPath: string
): number {
  const ta = canonicalPriorityTuple(a, primaryRootPath);
  const tb = canonicalPriorityTuple(b, primaryRootPath);
  for (let i = 0; i < ta.length; i++) {
    if (ta[i] !== tb[i]) return ta[i] - tb[i];
  }
  return a.entry.path.localeCompare(b.entry.path);
}

function selectPriorityFilesBalanced(
  entries: TreeBlobEntry[],
  maxFiles: number,
  maxFileSizeBytes: number,
  strategyHints: ProjectInspectionStrategy[] = [],
  primaryRootPath = '.'
): {
  selected: Array<{ entry: TreeBlobEntry; category: GitHubFileCategory; score: number }>;
  skipped: SkippedRepoFile[];
  oversizedPaths: string[];
  fileCountLimitPaths: string[];
  duplicateMirrorPaths: string[];
} {
  const skipped: SkippedRepoFile[] = [];
  const oversizedPaths: string[] = [];
  const fileCountLimitPaths: string[] = [];
  const duplicateMirrorPaths: string[] = [];
  const rawEligible: Array<{ entry: TreeBlobEntry; category: GitHubFileCategory; score: number }> = [];

  for (const entry of entries) {
    if (isSensitivePath(entry.path)) {
      skipped.push({
        path: entry.path,
        category: 'excluded',
        sizeBytes: entry.size,
        reason: 'sensitive_env_or_secret_file'
      });
      continue;
    }

    if (isReadmePath(entry.path)) {
      continue; // Handled separately as full README
    }

    const classified = classifyRepoFile(entry.path);
    if (!classified) continue;

    if (entry.size > maxFileSizeBytes) {
      oversizedPaths.push(entry.path);
      if (classified.category !== 'frontend_source') {
        skipped.push({
          path: entry.path,
          category: classified.category,
          sizeBytes: entry.size,
          reason: 'file_too_large'
        });
      }
      continue;
    }

    const adjustedScore =
      classified.score +
      computeStrategyBoost(classified.category, entry.path, strategyHints, primaryRootPath);
    rawEligible.push({
      entry,
      category: classified.category,
      score: adjustedScore
    });
  }

  // Deduplicate identical Git blob SHAs so mirror directories (e.g. GITHUB_UPLOAD/) never waste slots or batches
  const bestBySha = new Map<string, { entry: TreeBlobEntry; category: GitHubFileCategory; score: number }>();
  const shaUniqueCandidates: Array<{ entry: TreeBlobEntry; category: GitHubFileCategory; score: number }> = [];

  for (const item of rawEligible) {
    const sha = item.entry.sha?.trim();
    if (!sha) {
      shaUniqueCandidates.push(item);
      continue;
    }
    const existing = bestBySha.get(sha);
    if (!existing) {
      bestBySha.set(sha, item);
    } else if (compareCanonicalPreference(item, existing, primaryRootPath) < 0) {
      duplicateMirrorPaths.push(existing.entry.path);
      bestBySha.set(sha, item);
    } else {
      duplicateMirrorPaths.push(item.entry.path);
    }
  }

  for (const canonical of bestBySha.values()) {
    shaUniqueCandidates.push(canonical);
  }

  const candidatesByCat = new Map<
    GitHubFileCategory,
    Array<{ entry: TreeBlobEntry; category: GitHubFileCategory; score: number }>
  >();

  for (const cat of CATEGORY_ORDER) {
    candidatesByCat.set(cat, []);
  }
  for (const item of shaUniqueCandidates) {
    candidatesByCat.get(item.category)?.push(item);
  }

  for (const list of candidatesByCat.values()) {
    list.sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
  }

  const selected: Array<{ entry: TreeBlobEntry; category: GitHubFileCategory; score: number }> = [];
  const selectedPaths = new Set<string>();

  // Pass 1: Ensure every non-empty critical category gets up to 4 top files before filling remaining slots
  for (const cat of CATEGORY_ORDER) {
    const quota = cat === 'frontend_source' ? 3 : 4;
    const list = candidatesByCat.get(cat) || [];
    for (const item of list.slice(0, quota)) {
      if (selected.length >= maxFiles) break;
      if (!selectedPaths.has(item.entry.path)) {
        selected.push(item);
        selectedPaths.add(item.entry.path);
      }
    }
  }

  // Pass 2: Fill remaining multi-batch slots by highest adjusted score across all categories
  const remainingPool = Array.from(candidatesByCat.values())
    .flat()
    .filter((item) => !selectedPaths.has(item.entry.path))
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));

  for (const item of remainingPool) {
    if (selected.length < maxFiles) {
      selected.push(item);
      selectedPaths.add(item.entry.path);
    } else {
      fileCountLimitPaths.push(item.entry.path);
      if (item.category !== 'frontend_source') {
        skipped.push({
          path: item.entry.path,
          category: item.category,
          sizeBytes: item.entry.size,
          reason: 'file_count_limit'
        });
      }
    }
  }

  return { selected, skipped, oversizedPaths, fileCountLimitPaths, duplicateMirrorPaths };
}

const HIGH_SIGNAL_LINE_PATTERN =
  /(export\s+(?:async\s+)?(?:function|const|class)|app\.(?:get|post|put|delete|patch)|router\.|CREATE\s+POLICY|ENABLE\s+ROW\s+LEVEL\s+SECURITY|verify[-_]?webhook|paypal|qloo|GoogleGenAI|getGenerativeModel|authorize|requireAuth|idempoten|fetch\(|describe\(|it\(|test\()/i;

export function extractChunkedFileContent(
  rawText: string,
  maxChars: number,
  maxChunkChars = 3_600
): {
  chunks: FileContentChunk[];
  excerpt: string;
  truncated: boolean;
  totalLines: number;
} {
  const normalized = rawText.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const totalLines = lines.length;

  if (normalized.length <= maxChars) {
    const singleChunk: FileContentChunk = {
      startLine: 1,
      endLine: totalLines,
      content: normalized
    };
    return {
      chunks: [singleChunk],
      excerpt: normalized,
      truncated: false,
      totalLines
    };
  }

  const intervals: Array<{ start: number; end: number }> = [];

  // Head interval (~40% of char budget)
  let headChars = 0;
  let headEnd = 0;
  const headBudget = Math.max(800, Math.floor(maxChars * 0.42));
  for (let i = 0; i < lines.length; i++) {
    headChars += lines[i].length + 1;
    headEnd = i + 1;
    if (headChars >= headBudget) break;
  }
  intervals.push({ start: 1, end: headEnd });

  // Middle high-signal intervals around key functions/policies/handlers
  for (let i = headEnd; i < lines.length - 10; i++) {
    if (HIGH_SIGNAL_LINE_PATTERN.test(lines[i])) {
      const start = Math.max(1, i - 4);
      const end = Math.min(totalLines, i + 14);
      intervals.push({ start, end });
      i = end;
      if (intervals.length >= 6) break;
    }
  }

  // Tail interval (~22% of char budget)
  let tailChars = 0;
  let tailStart = totalLines;
  const tailBudget = Math.max(500, Math.floor(maxChars * 0.22));
  for (let i = lines.length - 1; i >= 0; i--) {
    tailChars += lines[i].length + 1;
    tailStart = i + 1;
    if (tailChars >= tailBudget) break;
  }
  if (tailStart > headEnd) {
    intervals.push({ start: tailStart, end: totalLines });
  }

  // Sort & merge overlapping/adjacent intervals
  intervals.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end + 2) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ ...iv });
    }
  }

  const chunks: FileContentChunk[] = [];
  let usedChars = 0;
  for (const iv of merged) {
    if (usedChars >= maxChars) break;
    const rawSlice = lines.slice(iv.start - 1, iv.end).join('\n');
    const remaining = maxChars - usedChars;
    const allowed = Math.min(maxChunkChars, remaining);
    if (allowed <= 60) break;

    let content = rawSlice;
    let endLine = iv.end;
    if (content.length > allowed) {
      const trimmedLines: string[] = [];
      let len = 0;
      for (let idx = iv.start - 1; idx < iv.end; idx++) {
        const line = lines[idx];
        if (len + line.length + 1 > allowed && trimmedLines.length > 0) break;
        trimmedLines.push(line);
        len += line.length + 1;
        endLine = idx + 1;
      }
      content = trimmedLines.join('\n').slice(0, allowed);
    }
    usedChars += content.length;
    chunks.push({
      startLine: iv.start,
      endLine: Math.max(iv.start, endLine),
      content
    });
  }

  const excerpt = chunks
    .map((c) => `/* Lines ${c.startLine}-${c.endLine} */\n${c.content}`)
    .join('\n...\n');

  return {
    chunks,
    excerpt,
    truncated: true,
    totalLines
  };
}

export function buildGitHubBlobUrl(
  repoFullName: string,
  ref: string,
  path: string,
  startLine?: number,
  endLine?: number
): string {
  const encodedPath = path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const base = `https://github.com/${repoFullName}/blob/${encodeURIComponent(ref)}/${encodedPath}`;
  if (typeof startLine === 'number' && startLine >= 1) {
    if (typeof endLine === 'number' && endLine >= startLine) {
      return `${base}#L${startLine}-L${endLine}`;
    }
    return `${base}#L${startLine}`;
  }
  return base;
}

function fastContentHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a_${(hash >>> 0).toString(16)}`;
}

function detectProjectRoots(
  entries: TreeBlobEntry[],
  strategyHints: ProjectInspectionStrategy[]
): { roots: ProjectRootCandidate[]; hasDivergentRoots: boolean } {
  const MANIFEST_NAMES = new Set([
    'package.json',
    'pyproject.toml',
    'requirements.txt',
    'go.mod',
    'cargo.toml',
    'firebase.json'
  ]);
  const rootManifestMap = new Map<string, string[]>();
  const rootFileCounts = new Map<string, number>();

  for (const entry of entries) {
    if (isNoiseOrBinaryPath(entry.path)) continue;
    const parts = entry.path.split('/');
    const base = (parts[parts.length - 1] || '').toLowerCase();
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';

    if (MANIFEST_NAMES.has(base)) {
      const existing = rootManifestMap.get(dir) || [];
      existing.push(base);
      rootManifestMap.set(dir, existing);
    }

    const topGroup = parts.length > 1 ? parts[0] : '.';
    rootFileCounts.set(topGroup, (rootFileCounts.get(topGroup) || 0) + 1);
  }

  // Map root-level blob SHAs to detect mirrored upload subdirectories (e.g. GITHUB_UPLOAD/)
  const rootRelativeSignatures = new Set<string>();
  if (rootManifestMap.has('.')) {
    for (const entry of entries) {
      if (isNoiseOrBinaryPath(entry.path) || !entry.sha) continue;
      if (!MIRROR_UPLOAD_DIR_PATTERN.test(entry.path)) {
        rootRelativeSignatures.add(`${entry.path}::${entry.sha}`);
      }
    }
  }

  const candidates: ProjectRootCandidate[] = [];
  for (const [rootPath, manifests] of rootManifestMap.entries()) {
    const depth = rootPath === '.' ? 0 : rootPath.split('/').length;
    const prefix = rootPath === '.' ? '' : `${rootPath}/`;
    const scopedEntries = entries.filter(
      (e) => !isNoiseOrBinaryPath(e.path) && (rootPath === '.' || e.path.startsWith(prefix))
    );
    const fileCount = scopedEntries.length;

    let mirroredCount = 0;
    let shaCheckedCount = 0;
    if (rootPath !== '.' && rootRelativeSignatures.size > 0) {
      for (const e of scopedEntries) {
        if (!e.sha) continue;
        shaCheckedCount += 1;
        const rel = e.path.slice(prefix.length);
        if (rootRelativeSignatures.has(`${rel}::${e.sha}`)) {
          mirroredCount += 1;
        }
      }
    }
    const isMirrorOfPrimary =
      shaCheckedCount >= 2 && mirroredCount / shaCheckedCount >= 0.5;

    let score = 50 - depth * 12 + Math.min(25, Math.floor(fileCount / 3));
    if (manifests.includes('package.json')) score += 15;
    if (/^(examples|samples|docs|templates|starter|legacy)/i.test(rootPath)) score -= 35;
    if (/(^|\/)(github[_-]?upload|uploads?|mirror|mirrored|backup)$/i.test(rootPath)) score -= 40;
    if (isMirrorOfPrimary) score -= 45;
    if (/(web|app|frontend|backend|server|api)/i.test(rootPath)) score += 8;
    if (strategyHints.includes('payments') && /pay|checkout|api/i.test(rootPath)) score += 5;

    candidates.push({
      rootPath,
      manifestFiles: manifests,
      fileCount,
      matchScore: score,
      selectedAsPrimary: false,
      reason:
        rootPath === '.'
          ? `Repository root manifest(s): ${manifests.join(', ')}`
          : isMirrorOfPrimary
            ? `Mirrored nested directory (${rootPath} shares ${mirroredCount}/${shaCheckedCount} files with primary root — deduplicated)`
            : `Nested manifest directory (${rootPath}): ${manifests.join(', ')}`
    });
  }

  candidates.sort((a, b) => b.matchScore - a.matchScore || a.rootPath.localeCompare(b.rootPath));
  if (candidates.length > 0) {
    candidates[0].selectedAsPrimary = true;
  }

  return {
    roots: candidates,
    hasDivergentRoots: candidates.length > 1
  };
}

function createTimedSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onExternalAbort = () => {
    controller.abort(
      externalSignal?.reason instanceof Error
        ? externalSignal.reason
        : new DOMException('GitHub inspection cancelled.', 'AbortError')
    );
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    controller.abort(new DOMException(`GitHub request timed out after ${timeoutMs}ms`, 'AbortError'));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  };
}

function parseNextLinkHeader(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

function encodeRepoPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function parseRateLimitRemaining(headers?: Headers): number | null {
  const raw = headers?.get('x-ratelimit-remaining');
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

async function fetchTreeViaContentsBfs(params: {
  owner: string;
  repo: string;
  branch: string;
  maxDirs: number;
  signal?: AbortSignal;
}): Promise<{ entries: TreeBlobEntry[]; rateLimitRemaining: number | null }> {
  const queue: Array<{ path: string; depth: number }> = [{ path: '', depth: 0 }];
  const visited = new Set<string>();
  const entries: TreeBlobEntry[] = [];
  let dirsFetched = 0;
  let rateLimitRemaining: number | null = null;

  const PRIORITY_DIR_PATTERN =
    /^(src|app|api|server|backend|routes|controllers|functions|supabase|migrations|prisma|drizzle|services|lib|tests|__tests__|\.github)$/i;

  while (queue.length > 0 && dirsFetched < params.maxDirs) {
    if (params.signal?.aborted) break;
    const current = queue.shift()!;
    if (visited.has(current.path)) continue;
    visited.add(current.path);

    let nextUrl: string | null = current.path
      ? `https://api.github.com/repos/${params.owner}/${params.repo}/contents/${encodeRepoPath(current.path)}?ref=${encodeURIComponent(params.branch)}`
      : `https://api.github.com/repos/${params.owner}/${params.repo}/contents?ref=${encodeURIComponent(params.branch)}`;

    while (nextUrl && dirsFetched < params.maxDirs) {
      if (params.signal?.aborted) break;
      dirsFetched += 1;
      const timed = createTimedSignal(params.signal, 7_000);
      try {
        const res = await fetch(nextUrl, {
          signal: timed.signal,
          headers: { Accept: 'application/vnd.github+json' }
        });
        timed.cleanup();
        rateLimitRemaining = parseRateLimitRemaining(res.headers) ?? rateLimitRemaining;
        if (!res.ok) break;

        const items = (await res.json()) as Array<{
          type?: string;
          path?: string;
          name?: string;
          size?: number;
          sha?: string;
        }>;
        if (!Array.isArray(items)) break;

        const subDirs: Array<{ path: string; depth: number; priority: boolean }> = [];
        for (const item of items) {
          if (!item.path) continue;
          const cleanPath = normalizeRepoPath(item.path);
          if (!cleanPath) continue;
          if (item.type === 'file') {
            entries.push({
              path: cleanPath,
              size: typeof item.size === 'number' ? item.size : 0,
              ...(typeof item.sha === 'string' ? { sha: item.sha } : {})
            });
          } else if (item.type === 'dir' && current.depth < 3) {
            const lowerDir = item.path.toLowerCase();
            if (EXCLUDED_DIR_PREFIXES.some((p) => `${lowerDir}/`.startsWith(p))) continue;
            const dirName = item.name || item.path.split('/').pop() || '';
            subDirs.push({
              path: item.path,
              depth: current.depth + 1,
              priority: PRIORITY_DIR_PATTERN.test(dirName)
            });
          }
        }

        // Enqueue high-priority backend/auth/migration/test directories before general ones
        subDirs.sort((a, b) => Number(b.priority) - Number(a.priority));
        for (const d of subDirs) {
          queue.push({ path: d.path, depth: d.depth });
        }

        nextUrl = parseNextLinkHeader(res.headers.get('link'));
      } catch {
        timed.cleanup();
        break;
      }
    }
  }

  return { entries, rateLimitRemaining };
}

type RawFileFetchResult =
  | { ok: true; text: string; sourceEndpoint: 'raw' | 'contents_api' }
  | {
      ok: false;
      failureKind: 'inaccessible' | 'failed';
      reason: 'rate_limited' | 'inaccessible_http_error' | 'fetch_failed';
      rateLimited?: boolean;
    };

async function fetchRawFileContent(params: {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  allowContentsFallback: boolean;
  signal?: AbortSignal;
}): Promise<RawFileFetchResult> {
  const encodedPath = encodeRepoPath(params.path);
  const rawUrl = `https://raw.githubusercontent.com/${params.owner}/${params.repo}/${encodeURIComponent(params.branch)}/${encodedPath}`;
  let sawAccessDenial = false;
  let sawRateLimit = false;

  const timedRaw = createTimedSignal(params.signal, 6_000);
  try {
    const rawRes = await fetch(rawUrl, { signal: timedRaw.signal });
    timedRaw.cleanup();
    if (rawRes.ok) {
      return { ok: true, text: await rawRes.text(), sourceEndpoint: 'raw' };
    }
    if (rawRes.status === 401 || rawRes.status === 403 || rawRes.status === 404) {
      sawAccessDenial = true;
    } else if (rawRes.status === 429) {
      sawRateLimit = true;
    }
  } catch (err) {
    timedRaw.cleanup();
    if (params.signal?.aborted) throw err;
  }

  if (!params.allowContentsFallback) {
    return {
      ok: false,
      failureKind: sawRateLimit || sawAccessDenial ? 'inaccessible' : 'failed',
      reason: sawRateLimit ? 'rate_limited' : sawAccessDenial ? 'inaccessible_http_error' : 'fetch_failed',
      rateLimited: sawRateLimit
    };
  }

  const contentsUrl = `https://api.github.com/repos/${params.owner}/${params.repo}/contents/${encodedPath}?ref=${encodeURIComponent(params.branch)}`;
  const timedContents = createTimedSignal(params.signal, 6_000);
  try {
    const res = await fetch(contentsUrl, {
      signal: timedContents.signal,
      headers: { Accept: 'application/vnd.github.raw+json' }
    });
    timedContents.cleanup();
    if (res.status === 403 || res.status === 429) {
      return { ok: false, failureKind: 'inaccessible', reason: 'rate_limited', rateLimited: true };
    }
    if (res.status === 401 || res.status === 404) {
      return { ok: false, failureKind: 'inaccessible', reason: 'inaccessible_http_error' };
    }
    if (!res.ok) {
      return { ok: false, failureKind: 'failed', reason: 'fetch_failed' };
    }
    return { ok: true, text: await res.text(), sourceEndpoint: 'contents_api' };
  } catch (err) {
    timedContents.cleanup();
    if (params.signal?.aborted) throw err;
    return {
      ok: false,
      failureKind: sawRateLimit || sawAccessDenial ? 'inaccessible' : 'failed',
      reason: sawRateLimit ? 'rate_limited' : sawAccessDenial ? 'inaccessible_http_error' : 'fetch_failed'
    };
  }
}

function emptyInspectionResult(
  repoFullName: string | null,
  reason: string,
  extra?: Partial<GitHubRepoInspection>
): GitHubRepoInspection {
  return {
    accessible: false,
    repoFullName,
    defaultBranch: null,
    commitSha: null,
    commitShaVerified: false,
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
    reason,
    ...extra
  };
}

export interface PrioritizedRepoEntry {
  entry: TreeBlobEntry;
  category: GitHubFileCategory;
  score: number;
}

export interface RepoInspectionPlan {
  accessible: boolean;
  aborted: boolean;
  reason: string;
  owner: string;
  repo: string;
  repoFullName: string | null;
  defaultBranch: string;
  commitSha: string | null;
  commitShaVerified: boolean;
  citationRef: string;
  cacheKey: string | null;
  cachedInspection?: GitHubRepoInspection | null;
  description: string | null;
  primaryLanguage: string | null;
  stars: number | null;
  updatedAt: string | null;
  readmeExcerpt: string | null;
  readmeFullChars: number;
  readmeTruncated: boolean;
  readmePathInspected: string | null;
  readmeRedactedCount: number;
  treeDiscoveryMethod: 'git_trees' | 'contents_api_bfs' | 'none';
  treeTruncated: boolean;
  blobEntries: TreeBlobEntry[];
  selectedEntries: PrioritizedRepoEntry[];
  initialSkipped: SkippedRepoFile[];
  oversizedPaths: string[];
  fileCountLimitPaths: string[];
  duplicateMirrorPaths: string[];
  projectRoots: ProjectRootCandidate[];
  hasDivergentRoots: boolean;
  rateLimitRemaining: number | null;
  maxTotalChars: number;
  maxPerFileChars: number;
}

export async function discoverGitHubRepoPlan(
  githubUrl: string,
  options?: GitHubInspectOptions
): Promise<RepoInspectionPlan> {
  purgeLegacyLocalStorageRepoCaches();
  const parsed = parseGitHubOwnerRepo(githubUrl);
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  const batchSize = Math.max(4, options?.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxTotalChars = options?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const maxFileSizeBytes = options?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const maxPerFileChars = options?.maxPerFileChars ?? DEFAULT_MAX_PER_FILE_CHARS;
  const maxReadmeChars = options?.maxReadmeChars ?? DEFAULT_MAX_README_CHARS;
  const maxContentsApiDirs = options?.maxContentsApiDirs ?? DEFAULT_MAX_CONTENTS_DIRS;
  const strategyHints = options?.strategyHints || [];
  const useCache = options?.useCache !== false;

  const emptyPlan = (
    repoFullName: string | null,
    reason: string,
    opts?: { aborted?: boolean; rateLimitRemaining?: number | null }
  ): RepoInspectionPlan => ({
    accessible: false,
    aborted: Boolean(opts?.aborted),
    reason,
    owner: parsed?.owner || '',
    repo: parsed?.repo || '',
    repoFullName,
    defaultBranch: 'main',
    commitSha: null,
    commitShaVerified: false,
    citationRef: 'main',
    cacheKey: null,
    description: null,
    primaryLanguage: null,
    stars: null,
    updatedAt: null,
    readmeExcerpt: null,
    readmeFullChars: 0,
    readmeTruncated: false,
    readmePathInspected: null,
    readmeRedactedCount: 0,
    treeDiscoveryMethod: 'none',
    treeTruncated: false,
    blobEntries: [],
    selectedEntries: [],
    initialSkipped: [],
    oversizedPaths: [],
    fileCountLimitPaths: [],
    duplicateMirrorPaths: [],
    projectRoots: [],
    hasDivergentRoots: false,
    rateLimitRemaining: opts?.rateLimitRemaining ?? null,
    maxTotalChars,
    maxPerFileChars
  });

  if (!parsed) {
    return emptyPlan(null, 'No valid GitHub repository URL was provided.');
  }

  const repoFullName = `${parsed.owner}/${parsed.repo}`;
  if (options?.signal?.aborted) {
    return emptyPlan(repoFullName, 'Repository inspection was cancelled.', { aborted: true });
  }

  const metaTimed = createTimedSignal(options?.signal, 7_000);
  try {
    const metaRes = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
      signal: metaTimed.signal,
      headers: { Accept: 'application/vnd.github+json' }
    });
    metaTimed.cleanup();

    let rateLimitRemaining = parseRateLimitRemaining(metaRes.headers);

    if (!metaRes.ok) {
      const reason =
        metaRes.status === 404
          ? `Repository ${repoFullName} could not be accessed (private or not found).`
          : metaRes.status === 403 || metaRes.status === 429
            ? `GitHub API rate limit reached (HTTP ${metaRes.status}). Try again later or inspect manually.`
            : `GitHub API returned HTTP ${metaRes.status}; repository metadata unavailable.`;
      return emptyPlan(repoFullName, reason, { rateLimitRemaining });
    }

    const meta = (await metaRes.json()) as {
      description?: string;
      language?: string;
      stargazers_count?: number;
      updated_at?: string;
      default_branch?: string;
    };
    const defaultBranch = meta.default_branch?.trim() || 'main';

    let commitSha: string | null = null;
    if (rateLimitRemaining === null || rateLimitRemaining > 1) {
      const commitTimed = createTimedSignal(options?.signal, 5_000);
      try {
        const commitRes = await fetch(
          `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(defaultBranch)}`,
          {
            signal: commitTimed.signal,
            headers: { Accept: 'application/vnd.github+json' }
          }
        );
        commitTimed.cleanup();
        rateLimitRemaining = parseRateLimitRemaining(commitRes.headers) ?? rateLimitRemaining;
        if (commitRes.ok) {
          const commitJson = (await commitRes.json()) as { sha?: string };
          if (typeof commitJson.sha === 'string' && commitJson.sha.trim()) {
            commitSha = commitJson.sha.trim();
          }
        }
      } catch {
        commitTimed.cleanup();
      }
    }

    const commitShaVerified = Boolean(commitSha);
    const inspectionRef = commitSha || defaultBranch;
    const cacheKey = commitSha
      ? `${repoFullName}@${commitSha}:max=${maxFiles}:batch=${batchSize}:tot=${maxTotalChars}:fsize=${maxFileSizeBytes}:pfile=${maxPerFileChars}:readme=${maxReadmeChars}:dirs=${maxContentsApiDirs}:hints=${[...strategyHints].sort().join(',')}`
      : null;

    if (useCache && cacheKey) {
      const cached = readCachedInspection(cacheKey);
      if (cached) {
        return {
          ...emptyPlan(repoFullName, cached.reason, { rateLimitRemaining }),
          accessible: true,
          defaultBranch,
          commitSha,
          commitShaVerified,
          citationRef: inspectionRef,
          cacheKey,
          cachedInspection: { ...cached, rateLimitRemaining }
        };
      }
    }

    let treeMethod: GitHubRepoInspection['treeDiscoveryMethod'] = 'none';
    let treeTruncated = false;
    let blobEntries: TreeBlobEntry[] = [];

    const treeTimed = createTimedSignal(options?.signal, 9_000);
    try {
      const treeRes = await fetch(
        `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(inspectionRef)}?recursive=1`,
        {
          signal: treeTimed.signal,
          headers: { Accept: 'application/vnd.github+json' }
        }
      );
      treeTimed.cleanup();
      rateLimitRemaining = parseRateLimitRemaining(treeRes.headers) ?? rateLimitRemaining;

      if (treeRes.ok) {
        const treeData = (await treeRes.json()) as {
          sha?: string;
          truncated?: boolean;
          tree?: Array<{ path?: string; type?: string; size?: number; sha?: string }>;
        };
        treeMethod = 'git_trees';
        treeTruncated = Boolean(treeData.truncated);
        const seenTreePaths = new Set<string>();
        blobEntries = [];
        for (const item of treeData.tree || []) {
          if (item.type !== 'blob' || typeof item.path !== 'string') continue;
          const cleanPath = normalizeRepoPath(item.path);
          if (!cleanPath || seenTreePaths.has(cleanPath)) continue;
          seenTreePaths.add(cleanPath);
          blobEntries.push({
            path: cleanPath,
            size: typeof item.size === 'number' ? item.size : 0,
            ...(typeof item.sha === 'string' ? { sha: item.sha } : {})
          });
        }
      }
    } catch {
      treeTimed.cleanup();
      if (options?.signal?.aborted) {
        return emptyPlan(repoFullName, 'Repository inspection was cancelled.', { aborted: true });
      }
    }

    if (
      (blobEntries.length === 0 || treeTruncated) &&
      (rateLimitRemaining === null || rateLimitRemaining > 4)
    ) {
      const bfs = await fetchTreeViaContentsBfs({
        owner: parsed.owner,
        repo: parsed.repo,
        branch: inspectionRef,
        maxDirs: maxContentsApiDirs,
        signal: options?.signal
      });
      rateLimitRemaining = bfs.rateLimitRemaining ?? rateLimitRemaining;
      if (bfs.entries.length > 0) {
        const seen = new Set(blobEntries.map((b) => normalizeRepoPath(b.path)));
        for (const item of bfs.entries) {
          const cleanPath = normalizeRepoPath(item.path);
          if (cleanPath && !seen.has(cleanPath)) {
            blobEntries.push({ ...item, path: cleanPath });
            seen.add(cleanPath);
          }
        }
        if (treeMethod === 'none') {
          treeMethod = 'contents_api_bfs';
        }
      }
    }

    if (options?.signal?.aborted) {
      return emptyPlan(repoFullName, 'Repository inspection was cancelled.', { aborted: true });
    }

    let readmeExcerpt: string | null = null;
    let readmeFullChars = 0;
    let readmeTruncated = false;
    let readmeRedactedCount = 0;
    let readmePathInspected: string | null = null;

    const readmeCandidate = blobEntries.find((b) => isReadmePath(b.path));
    if (readmeCandidate) {
      const rawReadme = await fetchRawFileContent({
        owner: parsed.owner,
        repo: parsed.repo,
        branch: inspectionRef,
        path: readmeCandidate.path,
        allowContentsFallback: rateLimitRemaining === null || rateLimitRemaining > 2,
        signal: options?.signal
      });
      if (rawReadme.ok && rawReadme.text) {
        readmePathInspected = readmeCandidate.path;
        const redacted = redactSecrets(rawReadme.text);
        readmeRedactedCount += redacted.count;
        readmeFullChars = redacted.sanitized.length;
        readmeTruncated = readmeFullChars > maxReadmeChars;
        readmeExcerpt = redacted.sanitized.slice(0, maxReadmeChars);
      }
    }

    if (!readmeExcerpt && (rateLimitRemaining === null || rateLimitRemaining > 1)) {
      const readmeTimed = createTimedSignal(options?.signal, 6_000);
      try {
        const readmeRes = await fetch(
          `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/readme?ref=${encodeURIComponent(inspectionRef)}`,
          {
            signal: readmeTimed.signal,
            headers: { Accept: 'application/vnd.github.raw+json' }
          }
        );
        readmeTimed.cleanup();
        rateLimitRemaining = parseRateLimitRemaining(readmeRes.headers) ?? rateLimitRemaining;
        if (readmeRes.ok) {
          const text = await readmeRes.text();
          const redacted = redactSecrets(text);
          readmeRedactedCount += redacted.count;
          readmeFullChars = redacted.sanitized.length;
          readmeTruncated = readmeFullChars > maxReadmeChars;
          readmeExcerpt = redacted.sanitized.slice(0, maxReadmeChars);
        }
      } catch {
        readmeTimed.cleanup();
      }
    }

    const { roots: projectRoots, hasDivergentRoots } = detectProjectRoots(
      blobEntries,
      strategyHints
    );
    const primaryRootPath =
      projectRoots.find((r) => r.selectedAsPrimary)?.rootPath || '.';

    const {
      selected,
      skipped,
      oversizedPaths,
      fileCountLimitPaths,
      duplicateMirrorPaths
    } = selectPriorityFilesBalanced(
      blobEntries,
      maxFiles,
      maxFileSizeBytes,
      strategyHints,
      primaryRootPath
    );

    const sanitizedDescription = meta.description
      ? redactSecrets(meta.description).sanitized
      : null;

    return {
      accessible: true,
      aborted: false,
      reason: 'Repository tree plan ready',
      owner: parsed.owner,
      repo: parsed.repo,
      repoFullName,
      defaultBranch,
      commitSha,
      commitShaVerified,
      citationRef: inspectionRef,
      cacheKey,
      cachedInspection: null,
      description: sanitizedDescription,
      primaryLanguage: meta.language ?? null,
      stars: typeof meta.stargazers_count === 'number' ? meta.stargazers_count : null,
      updatedAt: meta.updated_at ?? null,
      readmeExcerpt,
      readmeFullChars,
      readmeTruncated,
      readmePathInspected,
      readmeRedactedCount,
      treeDiscoveryMethod: treeMethod,
      treeTruncated,
      blobEntries,
      selectedEntries: selected,
      initialSkipped: skipped,
      oversizedPaths,
      fileCountLimitPaths,
      duplicateMirrorPaths,
      projectRoots,
      hasDivergentRoots,
      rateLimitRemaining,
      maxTotalChars,
      maxPerFileChars
    };
  } catch (err) {
    metaTimed.cleanup();
    const aborted =
      Boolean(options?.signal?.aborted) ||
      (err instanceof Error && err.name === 'AbortError');
    return emptyPlan(
      repoFullName,
      aborted
        ? 'Repository inspection was cancelled.'
        : err instanceof Error
          ? `Could not access repository (${err.message}).`
          : 'Repository inspection failed or timed out.',
      { aborted }
    );
  }
}

export async function inspectGitHubRepoBatchSlice(
  plan: RepoInspectionPlan,
  batchEntries: PrioritizedRepoEntry[],
  options?: {
    signal?: AbortSignal;
    totalCharsUsedSoFar?: number;
    maxTotalChars?: number;
    maxPerFileChars?: number;
  }
): Promise<{
  inspectedFiles: InspectedRepoFile[];
  skippedOrFailed: SkippedRepoFile[];
  totalCharsAdded: number;
  redactedSecretsCount: number;
  aborted: boolean;
}> {
  const inspectedFiles: InspectedRepoFile[] = [];
  const skippedOrFailed: SkippedRepoFile[] = [];
  let totalCharsUsed = options?.totalCharsUsedSoFar ?? 0;
  const maxTotalChars = options?.maxTotalChars ?? plan.maxTotalChars;
  const maxPerFileChars = options?.maxPerFileChars ?? plan.maxPerFileChars;
  let totalCharsAdded = 0;
  let redactedSecretsCount = 0;

  for (let i = 0; i < batchEntries.length; i += FILE_FETCH_CONCURRENCY) {
    if (options?.signal?.aborted) {
      return {
        inspectedFiles,
        skippedOrFailed,
        totalCharsAdded,
        redactedSecretsCount,
        aborted: true
      };
    }

    const subBatch = batchEntries.slice(i, i + FILE_FETCH_CONCURRENCY);
    const batchResults = await Promise.all(
      subBatch.map(async (item) => {
        if (totalCharsUsed >= maxTotalChars) {
          return { kind: 'skipped' as const, reason: 'budget_limit' as const, item };
        }
        try {
          const fetched = await fetchRawFileContent({
            owner: plan.owner,
            repo: plan.repo,
            branch: plan.citationRef,
            path: item.entry.path,
            allowContentsFallback: plan.rateLimitRemaining === null || plan.rateLimitRemaining > 3,
            signal: options?.signal
          });
          if (!fetched.ok) {
            return {
              kind: 'skipped' as const,
              reason: fetched.reason,
              item
            };
          }
          return { kind: 'ok' as const, fetched, item };
        } catch (err) {
          if (options?.signal?.aborted) {
            throw err;
          }
          return { kind: 'skipped' as const, reason: 'fetch_failed' as const, item };
        }
      })
    );

    for (let resIdx = 0; resIdx < batchResults.length; resIdx++) {
      const res = batchResults[resIdx];
      if (res.kind === 'skipped') {
        skippedOrFailed.push({
          path: res.item.entry.path,
          category: res.item.category,
          sizeBytes: res.item.entry.size,
          reason: res.reason
        });
        continue;
      }

      const remainingBudget = maxTotalChars - totalCharsUsed;
      if (remainingBudget <= 200) {
        skippedOrFailed.push({
          path: res.item.entry.path,
          category: res.item.category,
          sizeBytes: res.item.entry.size,
          reason: 'budget_limit'
        });
        continue;
      }

      const remainingInBatch =
        batchResults.length - resIdx + Math.max(0, batchEntries.length - (i + subBatch.length));
      const redacted = redactSecrets(res.fetched.text);
      redactedSecretsCount += redacted.count;
      const fairShareCap =
        remainingInBatch > 1 && remainingBudget < maxPerFileChars * remainingInBatch
          ? Math.max(600, Math.floor(remainingBudget / remainingInBatch))
          : maxPerFileChars;
      const capForFile = Math.min(maxPerFileChars, remainingBudget, fairShareCap);
      const chunked = extractChunkedFileContent(redacted.sanitized, capForFile);
      totalCharsUsed += chunked.excerpt.length;
      totalCharsAdded += chunked.excerpt.length;

      const firstChunk = chunked.chunks[0];
      const sha = res.item.entry.sha || fastContentHash(redacted.sanitized);
      const inspectedFile: InspectedRepoFile = {
        path: res.item.entry.path,
        category: res.item.category,
        sizeBytes: res.item.entry.size || redacted.sanitized.length,
        charsIncluded: chunked.excerpt.length,
        totalLines: chunked.totalLines,
        truncated: chunked.truncated,
        sourceEndpoint: res.fetched.sourceEndpoint,
        redactedSecretsCount: redacted.count,
        sha,
        blobUrl: buildGitHubBlobUrl(
          plan.repoFullName || `${plan.owner}/${plan.repo}`,
          plan.citationRef,
          res.item.entry.path,
          firstChunk?.startLine,
          firstChunk?.endLine
        ),
        chunks: chunked.chunks,
        excerpt: chunked.excerpt
      };
      inspectedFiles.push(inspectedFile);
    }
  }

  return {
    inspectedFiles,
    skippedOrFailed,
    totalCharsAdded,
    redactedSecretsCount,
    aborted: false
  };
}

export function finalizeGitHubRepoInspection(
  plan: RepoInspectionPlan,
  state: {
    inspectedFiles: InspectedRepoFile[];
    extraSkipped: SkippedRepoFile[];
    batchesProcessed: number;
    redactedSecretsCount: number;
    interrupted?: boolean;
  }
): GitHubRepoInspection {
  if (!plan.accessible || !plan.repoFullName) {
    return emptyInspectionResult(plan.repoFullName, plan.reason, {
      aborted: plan.aborted,
      rateLimitRemaining: plan.rateLimitRemaining
    });
  }

  const inspectedFiles = state.inspectedFiles.map((f) => ({
    ...f,
    path: normalizeRepoPath(f.path)
  }));
  const inspectedMap = new Map<string, InspectedRepoFile>();
  for (const f of inspectedFiles) {
    inspectedMap.set(f.path, f);
  }

  const uninspectedImportantFiles: SkippedRepoFile[] = [...plan.initialSkipped, ...state.extraSkipped].map((s) => ({
    ...s,
    path: normalizeRepoPath(s.path)
  }));
  const skippedMap = new Map<string, SkippedFileReason>();
  for (const s of uninspectedImportantFiles) {
    skippedMap.set(s.path, s.reason);
  }
  for (const rawOversized of plan.oversizedPaths) {
    const oversizedPath = normalizeRepoPath(rawOversized);
    if (!skippedMap.has(oversizedPath)) {
      skippedMap.set(oversizedPath, 'file_too_large');
    }
  }
  for (const rawLimit of plan.fileCountLimitPaths) {
    const limitPath = normalizeRepoPath(rawLimit);
    if (!skippedMap.has(limitPath)) {
      skippedMap.set(limitPath, 'file_count_limit');
    }
  }

  const duplicateMirrorSet = new Set((plan.duplicateMirrorPaths || []).map(normalizeRepoPath));
  const normalizedReadmePath = plan.readmePathInspected
    ? normalizeRepoPath(plan.readmePathInspected)
    : null;
  const unreachedSelected = new Set<string>();
  if (state.interrupted) {
    for (const sel of plan.selectedEntries) {
      const cleanSelPath = normalizeRepoPath(sel.entry.path);
      if (!inspectedMap.has(cleanSelPath) && !skippedMap.has(cleanSelPath)) {
        unreachedSelected.add(cleanSelPath);
        uninspectedImportantFiles.push({
          path: cleanSelPath,
          category: sel.category,
          sizeBytes: sel.entry.size,
          reason: 'batch_interrupted'
        });
      }
    }
  }

  const normalizedBlobs: TreeBlobEntry[] = [];
  const seenBlobPaths = new Set<string>();
  for (const rawEntry of plan.blobEntries) {
    const cleanPath = normalizeRepoPath(rawEntry.path);
    if (!cleanPath || seenBlobPaths.has(cleanPath)) continue;
    seenBlobPaths.add(cleanPath);
    normalizedBlobs.push({ ...rawEntry, path: cleanPath });
  }

  const shaToPaths = new Map<string, string[]>();
  const fileInventory: FileInventoryItem[] = normalizedBlobs.map((entry) => {
    const inspected = inspectedMap.get(entry.path);
    const effectiveSha = inspected?.sha || entry.sha;
    if (effectiveSha) {
      const list = shaToPaths.get(effectiveSha) || [];
      list.push(entry.path);
      shaToPaths.set(effectiveSha, list);
    }

    if (inspected) {
      const inspectionStatus = inspected.truncated ? 'partially_inspected' : 'inspected';
      return {
        path: entry.path,
        category: inspected.category,
        sizeBytes: inspected.sizeBytes,
        ...(effectiveSha ? { sha: effectiveSha } : {}),
        inspectionStatus,
        auditStatus: toCanonicalFileStatus(inspectionStatus),
        reason: inspected.truncated ? 'inspected_chunked' : 'inspected_complete',
        chunks: inspected.chunks.map((c) => ({ startLine: c.startLine, endLine: c.endLine }))
      };
    }

    if (normalizedReadmePath === entry.path) {
      const inspectionStatus = plan.readmeTruncated ? 'partially_inspected' : 'inspected';
      return {
        path: entry.path,
        category: 'readme',
        sizeBytes: entry.size,
        ...(effectiveSha ? { sha: effectiveSha } : {}),
        inspectionStatus,
        auditStatus: toCanonicalFileStatus(inspectionStatus),
        reason: plan.readmeTruncated ? 'inspected_chunked' : 'inspected_complete'
      };
    }

    if (isSensitivePath(entry.path)) {
      return {
        path: entry.path,
        category: 'excluded',
        sizeBytes: entry.size,
        ...(effectiveSha ? { sha: effectiveSha } : {}),
        inspectionStatus: 'skipped',
        auditStatus: 'SKIPPED',
        reason: 'sensitive_env_or_secret_file'
      };
    }

    if (isNoiseOrBinaryPath(entry.path)) {
      return {
        path: entry.path,
        category: 'excluded',
        sizeBytes: entry.size,
        ...(effectiveSha ? { sha: effectiveSha } : {}),
        inspectionStatus: 'skipped',
        auditStatus: 'SKIPPED',
        reason: 'binary_or_asset'
      };
    }

    if (duplicateMirrorSet.has(entry.path)) {
      return {
        path: entry.path,
        category: classifyRepoFile(entry.path)?.category || 'other',
        sizeBytes: entry.size,
        ...(effectiveSha ? { sha: effectiveSha } : {}),
        inspectionStatus: 'skipped',
        auditStatus: 'SKIPPED',
        reason: 'duplicate_mirror'
      };
    }

    const skippedReason = skippedMap.get(entry.path);
    if (skippedReason === 'fetch_failed') {
      return {
        path: entry.path,
        category: classifyRepoFile(entry.path)?.category || 'other',
        sizeBytes: entry.size,
        ...(effectiveSha ? { sha: effectiveSha } : {}),
        inspectionStatus: 'failed',
        auditStatus: 'FAILED',
        reason: 'fetch_failed'
      };
    }
    if (skippedReason === 'inaccessible_http_error' || skippedReason === 'rate_limited') {
      return {
        path: entry.path,
        category: classifyRepoFile(entry.path)?.category || 'other',
        sizeBytes: entry.size,
        ...(effectiveSha ? { sha: effectiveSha } : {}),
        inspectionStatus: 'inaccessible',
        auditStatus: 'INACCESSIBLE',
        reason: skippedReason
      };
    }

    if (unreachedSelected.has(entry.path)) {
      return {
        path: entry.path,
        category: classifyRepoFile(entry.path)?.category || 'other',
        sizeBytes: entry.size,
        ...(effectiveSha ? { sha: effectiveSha } : {}),
        inspectionStatus: 'skipped',
        auditStatus: 'SKIPPED',
        reason: 'batch_interrupted'
      };
    }

    const classified = classifyRepoFile(entry.path);
    return {
      path: entry.path,
      category: classified?.category || 'other',
      sizeBytes: entry.size,
      ...(effectiveSha ? { sha: effectiveSha } : {}),
      inspectionStatus: 'skipped',
      auditStatus: 'SKIPPED',
      reason: skippedReason || 'non_code_documentation'
    };
  });

  const duplicateFileGroups: DuplicateFileGroup[] = [];
  for (const [sha, paths] of shaToPaths.entries()) {
    if (paths.length > 1) {
      duplicateFileGroups.push({ sha, paths });
    }
  }

  const detectedCategories = Array.from(
    new Set<GitHubFileCategory>([
      ...(plan.readmeExcerpt ? (['readme'] as GitHubFileCategory[]) : []),
      ...inspectedFiles.map((f) => f.category)
    ])
  );

  const treeSamplePaths = normalizedBlobs
    .filter((b) => !isNoiseOrBinaryPath(b.path) && !isSensitivePath(b.path))
    .map((b) => b.path)
    .slice(0, 120);

  const totalRedactedSecrets = plan.readmeRedactedCount + state.redactedSecretsCount;
  const commitNote = plan.commitShaVerified
    ? ''
    : ` Warning: commit SHA unverified (fell back to unpinned branch HEAD "${plan.defaultBranch}").`;

  return {
    accessible: true,
    repoFullName: plan.repoFullName,
    defaultBranch: plan.defaultBranch,
    commitSha: plan.commitSha,
    commitShaVerified: plan.commitShaVerified,
    description: plan.description,
    primaryLanguage: plan.primaryLanguage,
    stars: plan.stars,
    updatedAt: plan.updatedAt,
    readmeExcerpt: plan.readmeExcerpt,
    readmeFullChars: plan.readmeFullChars,
    readmeTruncated: plan.readmeTruncated,
    readmePathInspected: normalizedReadmePath,
    selectedFilesCount: plan.selectedEntries.length,
    treeDiscoveryMethod: plan.treeDiscoveryMethod,
    treeTruncated: plan.treeTruncated,
    totalFilesInTree: normalizedBlobs.length,
    treeSamplePaths,
    inspectedFiles,
    uninspectedImportantFiles,
    fileInventory,
    duplicateFileGroups,
    projectRoots: plan.projectRoots,
    hasDivergentRoots: plan.hasDivergentRoots,
    batchesProcessed: state.batchesProcessed,
    detectedCategories,
    redactedSecretsCount: totalRedactedSecrets,
    rateLimitRemaining: plan.rateLimitRemaining,
    aborted: false,
    reason:
      inspectedFiles.length > 0
        ? `Inspected ${inspectedFiles.length} prioritized source/config/security/deployment/test file(s) across ${state.batchesProcessed} batch(es) from ${normalizedBlobs.length} repository file(s).${state.interrupted ? ' Inspection paused/interrupted with partial progress preserved.' : ''}${commitNote}`
        : state.interrupted && plan.selectedEntries.length > 0
          ? `0 source files audited (0/${plan.selectedEntries.length} prioritized source file(s) completed across ${state.batchesProcessed} batch(es)${normalizedReadmePath ? `; ${normalizedReadmePath} fetched during discovery only` : ''}).${commitNote}`
          : `Public GitHub repository metadata retrieved (no eligible source files selected).${commitNote}`
  };
}

export async function inspectPublicGitHubRepo(
  githubUrl: string,
  options?: GitHubInspectOptions
): Promise<GitHubRepoInspection> {
  const plan = await discoverGitHubRepoPlan(githubUrl, options);
  if (!plan.accessible) {
    return emptyInspectionResult(plan.repoFullName, plan.reason, {
      aborted: plan.aborted,
      rateLimitRemaining: plan.rateLimitRemaining
    });
  }
  if (plan.cachedInspection) {
    return plan.cachedInspection;
  }

  const batchSize = Math.max(4, options?.batchSize ?? DEFAULT_BATCH_SIZE);
  const useCache = options?.useCache !== false;

  const inspectedFiles: InspectedRepoFile[] = [];
  const extraSkipped: SkippedRepoFile[] = [];
  let totalCharsUsed = 0;
  let redactedSecretsCount = 0;
  let batchesProcessed = 0;

  for (let batchStart = 0; batchStart < plan.selectedEntries.length; batchStart += batchSize) {
    if (options?.signal?.aborted) {
      return emptyInspectionResult(plan.repoFullName, 'Repository inspection was cancelled.', {
        aborted: true
      });
    }
    const batchSlice = plan.selectedEntries.slice(batchStart, batchStart + batchSize);
    batchesProcessed += 1;

    const batchRes = await inspectGitHubRepoBatchSlice(plan, batchSlice, {
      signal: options?.signal,
      totalCharsUsedSoFar: totalCharsUsed,
      maxTotalChars: plan.maxTotalChars,
      maxPerFileChars: plan.maxPerFileChars
    });
    if (batchRes.aborted) {
      return emptyInspectionResult(plan.repoFullName, 'Repository inspection was cancelled.', {
        aborted: true
      });
    }

    inspectedFiles.push(...batchRes.inspectedFiles);
    extraSkipped.push(...batchRes.skippedOrFailed);
    totalCharsUsed += batchRes.totalCharsAdded;
    redactedSecretsCount += batchRes.redactedSecretsCount;
  }

  const result = finalizeGitHubRepoInspection(plan, {
    inspectedFiles,
    extraSkipped,
    batchesProcessed,
    redactedSecretsCount,
    interrupted: false
  });

  if (useCache && plan.cacheKey) {
    writeCachedInspection(plan.cacheKey, result);
  }

  return result;
}
