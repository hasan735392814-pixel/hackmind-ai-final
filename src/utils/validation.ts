export function isValidHttpUrl(url: string): boolean {
  if (!url.trim()) return true;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function isValidGitHubRepoUrl(url: string): boolean {
  if (!url.trim()) return false;
  try {
    const parsed = new URL(url.trim());
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      (parsed.hostname === 'github.com' || parsed.hostname.endsWith('.github.com')) &&
      parsed.pathname.split('/').filter(Boolean).length >= 2
    );
  } catch {
    return false;
  }
}

export function sanitizeString(value: string, maxLength: number): string {
  // eslint-disable-next-line no-control-regex -- intentionally strips C0 control characters during sanitization
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, maxLength);
}

export function sanitizeStringArray(values: string[], maxItems: number, maxItemLen = 60): string[] {
  const cleaned: string[] = [];
  for (const item of values) {
    const trimmed = sanitizeString(item, maxItemLen);
    if (trimmed && !cleaned.includes(trimmed)) {
      cleaned.push(trimmed);
    }
    if (cleaned.length >= maxItems) break;
  }
  return cleaned;
}

export function isValidFirestoreId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

export function generateFirestoreId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 14)
      : Math.random().toString(36).slice(2, 12);
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'doc';
  return `${safePrefix}_${Date.now().toString(36)}_${random}`;
}

export function isDeadlinePassed(isoDateOrDatetime: string, now: Date = new Date()): boolean {
  if (!isoDateOrDatetime) return false;
  const parsed = new Date(isoDateOrDatetime);
  if (Number.isNaN(parsed.getTime())) return false;
  return now.getTime() > parsed.getTime();
}

export function parseGitHubOwnerRepo(url: string): { owner: string; repo: string } | null {
  if (!isValidGitHubRepoUrl(url)) return null;
  const parsed = new URL(url.trim());
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return {
    owner: parts[0],
    repo: parts[1].replace(/\.git$/i, '')
  };
}

export function normalizeJoinToken(token: string): string {
  return token
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, '')
    .toUpperCase();
}

export function generateSecureJoinToken(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    throw new Error('Cryptographic random generator is unavailable in this environment.');
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `HM-${hex}`;
}

export async function sha256Hex(value: string): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new Error('WebCrypto SHA-256 is unavailable in this environment.');
  }
  const encoded = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function deriveJoinCodeProofAndVerifier(rawToken: string): Promise<{
  normalizedToken: string;
  proof: string;
  verifierHash: string;
}> {
  const normalizedToken = normalizeJoinToken(rawToken);
  const proof = await sha256Hex(normalizedToken);
  const verifierHash = await sha256Hex(proof);
  return { normalizedToken, proof, verifierHash };
}

export function isValidInternalAppLink(link: string): boolean {
  return /^\/app(\/[a-zA-Z0-9_-]+)*$/.test(link.trim());
}

