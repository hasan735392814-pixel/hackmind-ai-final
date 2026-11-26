import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface ServerDemoProbeResponse {
  ok: boolean;
  demoUrl: string;
  checkedAt: string;
  reachable: boolean;
  httpStatus: number | null;
  finalUrl: string | null;
  contentType: string | null;
  title: string | null;
  hasCrashBanner: boolean;
  requiresAuth: boolean;
  blockedReason: string | null;
  ssrfBlocked: boolean;
  redirectCount: number;
  probeMethod: 'server_http_probe';
  manualVerificationRequired: true;
  checkedAspects: string[];
  blockedAspects: string[];
  status: 'UNVERIFIED' | 'BLOCKED' | 'CONTRADICTED';
  summary: string;
}

export interface ServerProbeDependencies {
  dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  '169.254.169.254',
  '0.0.0.0',
  '::',
  '::1'
]);

const ALLOWED_PORTS = new Set(['', '80', '443']);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const val = Number(part);
    if (val < 0 || val > 255) return null;
    num = (num << 8) + val;
  }
  return num >>> 0;
}

function inCidr4(ipInt: number, baseInt: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

export function isPublicIpAddress(rawIp: string): boolean {
  const normalized = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zoneRemoved = normalized.split('%')[0];
  const ipVersion = isIP(zoneRemoved);
  if (ipVersion === 4) {
    const ipInt = ipv4ToInt(zoneRemoved);
    if (ipInt === null) return false;
    // Block 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10 (CGNAT), 127.0.0.0/8,
    // 169.254.0.0/16 (link-local/cloud metadata), 172.16.0.0/12, 192.0.0.0/24,
    // 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24,
    // 203.0.113.0/24, 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved/broadcast)
    const blockedRanges: Array<[string, number]> = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4]
    ];
    for (const [base, prefix] of blockedRanges) {
      const baseInt = ipv4ToInt(base);
      if (baseInt !== null && inCidr4(ipInt, baseInt, prefix)) {
        return false;
      }
    }
    return true;
  }

  if (ipVersion === 6) {
    // Handle IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1 or ::ffff:7f00:1
    if (zoneRemoved.startsWith('::ffff:')) {
      const tail = zoneRemoved.slice('::ffff:'.length);
      if (isIP(tail) === 4) {
        return isPublicIpAddress(tail);
      }
      const hexPair = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
      if (hexPair) {
        const hi = parseInt(hexPair[1], 16);
        const lo = parseInt(hexPair[2], 16);
        const mappedV4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPublicIpAddress(mappedV4);
      }
      return false;
    }

    if (zoneRemoved === '::' || zoneRemoved === '::1') return false;
    const firstHextet = zoneRemoved.split(':')[0] || '0';
    const firstVal = parseInt(firstHextet, 16);
    if (Number.isNaN(firstVal)) return false;
    // fc00::/7 Unique Local, fe80::/10 Link-Local, ff00::/8 Multicast, fec0::/10 Site-Local
    if ((firstVal & 0xfe00) === 0xfc00) return false;
    if ((firstVal & 0xffc0) === 0xfe80) return false;
    if ((firstVal & 0xffc0) === 0xfec0) return false;
    if ((firstVal & 0xff00) === 0xff00) return false;
    // 2001:db8::/32 documentation prefix
    if (zoneRemoved.startsWith('2001:db8:') || zoneRemoved.startsWith('2001:0db8:')) return false;
    return true;
  }

  return false;
}

async function validateExternalHttpTarget(
  rawUrl: string,
  dnsLookup: (hostname: string) => Promise<Array<{ address: string; family: number }>>
): Promise<{ valid: true; url: URL } | { valid: false; reason: string; ssrfBlocked: boolean }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: 'Invalid URL syntax.', ssrfBlocked: false };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      valid: false,
      reason: `Unsupported URL protocol "${parsed.protocol}"; only http and https are permitted.`,
      ssrfBlocked: true
    };
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      reason: 'Embedded credentials in demo URLs are rejected for security.',
      ssrfBlocked: true
    };
  }

  if (!ALLOWED_PORTS.has(parsed.port)) {
    return {
      valid: false,
      reason: `Non-standard port "${parsed.port}" is blocked by demo probe SSRF policy.`,
      ssrfBlocked: true
    };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !host ||
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.arpa')
  ) {
    return {
      valid: false,
      reason: `Target host "${host || 'empty'}" is blocked by SSRF policy.`,
      ssrfBlocked: true
    };
  }

  if (isIP(host) !== 0) {
    if (!isPublicIpAddress(host)) {
      return {
        valid: false,
        reason: `Private, loopback, or link-local IP "${host}" is blocked by SSRF policy.`,
        ssrfBlocked: true
      };
    }
    return { valid: true, url: parsed };
  }

  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await dnsLookup(host);
  } catch {
    return {
      valid: false,
      reason: `DNS resolution failed for "${host}".`,
      ssrfBlocked: false
    };
  }

  if (!resolved || resolved.length === 0) {
    return {
      valid: false,
      reason: `No DNS records found for "${host}".`,
      ssrfBlocked: false
    };
  }

  for (const record of resolved) {
    if (!isPublicIpAddress(record.address)) {
      return {
        valid: false,
        reason: `Host "${host}" resolved to non-public IP "${record.address}" and was blocked by SSRF policy.`,
        ssrfBlocked: true
      };
    }
  }

  return { valid: true, url: parsed };
}

function defaultDnsLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return lookup(hostname, { all: true });
}

function scrubControlAndTokens(text: string): string {
  return text
    .replace(/\b(?:AIza|AKIA|ASIA|ghp_|github_pat_|sk-)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_SECRET]')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function probePublicDemoFromServer(
  rawUrl: string,
  deps?: ServerProbeDependencies
): Promise<ServerDemoProbeResponse> {
  const checkedAt = new Date().toISOString();
  const trimmed = (rawUrl || '').trim();
  const dnsLookup = deps?.dnsLookup ?? defaultDnsLookup;
  const fetchFn = deps?.fetchFn ?? fetch;
  const timeoutMs = deps?.timeoutMs ?? 5_500;
  const maxRedirects = deps?.maxRedirects ?? 3;
  const maxBodyBytes = deps?.maxBodyBytes ?? 65_536;

  const baseBlocked = (
    reason: string,
    opts?: { ssrfBlocked?: boolean; status?: 'BLOCKED' | 'CONTRADICTED'; httpStatus?: number | null }
  ): ServerDemoProbeResponse => ({
    ok: false,
    demoUrl: trimmed,
    checkedAt,
    reachable: false,
    httpStatus: opts?.httpStatus ?? null,
    finalUrl: null,
    contentType: null,
    title: null,
    hasCrashBanner: false,
    requiresAuth: false,
    blockedReason: reason,
    ssrfBlocked: Boolean(opts?.ssrfBlocked),
    redirectCount: 0,
    probeMethod: 'server_http_probe',
    manualVerificationRequired: true,
    checkedAspects: ['Server-side read-only HTTP probe URL validation'],
    blockedAspects: [
      reason,
      'Interactive UI flows, JavaScript rendering, and authentication flows require manual judge verification.'
    ],
    status: opts?.status ?? 'BLOCKED',
    summary: reason
  });

  if (!trimmed) {
    return baseBlocked('No demo URL provided.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = trimmed;
    let redirectCount = 0;

    while (redirectCount <= maxRedirects) {
      const check = await validateExternalHttpTarget(currentUrl, dnsLookup);
      if (!check.valid) {
        return baseBlocked(check.reason, {
          ssrfBlocked: check.ssrfBlocked,
          status: check.ssrfBlocked ? 'BLOCKED' : 'BLOCKED'
        });
      }

      const res = await fetchFn(check.url.toString(), {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: {
          'user-agent': 'HackMind-AI-DemoProbe/1.0 (read-only)',
          accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1'
        },
        signal: controller.signal
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          return {
            ...baseBlocked(`HTTP ${res.status} redirect without Location header.`, {
              httpStatus: res.status
            }),
            redirectCount
          };
        }
        if (redirectCount >= maxRedirects) {
          return {
            ...baseBlocked(`Exceeded maximum redirect limit (${maxRedirects}).`, {
              httpStatus: res.status
            }),
            redirectCount
          };
        }

        let nextUrlObj: URL;
        try {
          nextUrlObj = new URL(location, check.url);
        } catch {
          return {
            ...baseBlocked('Malformed redirect Location header.', { httpStatus: res.status }),
            redirectCount
          };
        }

        // Detect login/OAuth gate redirects cleanly without bypassing authentication
        const lowerRedirect = nextUrlObj.pathname.toLowerCase();
        if (/(\/login|\/signin|\/sign-in|\/auth\/|\/oauth|accounts\.google\.com)/.test(lowerRedirect) ||
            /accounts\.google\.com|login\.microsoftonline\.com|auth0\.com/.test(nextUrlObj.hostname.toLowerCase())) {
          return {
            ok: true,
            demoUrl: trimmed,
            checkedAt,
            reachable: true,
            httpStatus: res.status,
            finalUrl: nextUrlObj.toString(),
            contentType: res.headers.get('content-type'),
            title: null,
            hasCrashBanner: false,
            requiresAuth: true,
            blockedReason: 'Live demo redirects to an authentication/login wall.',
            ssrfBlocked: false,
            redirectCount: redirectCount + 1,
            probeMethod: 'server_http_probe',
            manualVerificationRequired: true,
            checkedAspects: [
              `Server HTTP GET returned redirect (${res.status}) toward ${nextUrlObj.hostname}`
            ],
            blockedAspects: [
              'Demo requires user login; unauthenticated server probe never bypasses authentication. Judge must verify authenticated flows manually.'
            ],
            status: 'BLOCKED',
            summary: `Server HTTP probe observed redirect (${res.status}) to a login/auth endpoint (${nextUrlObj.hostname}); manual judge verification is required.`
          };
        }

        currentUrl = nextUrlObj.toString();
        redirectCount += 1;
        continue;
      }

      const contentType = res.headers.get('content-type');
      const finalUrl = res.url || check.url.toString();

      if (res.status === 401 || res.status === 403) {
        return {
          ok: true,
          demoUrl: trimmed,
          checkedAt,
          reachable: true,
          httpStatus: res.status,
          finalUrl,
          contentType,
          title: null,
          hasCrashBanner: false,
          requiresAuth: true,
          blockedReason: `HTTP ${res.status} authentication or access restriction.`,
          ssrfBlocked: false,
          redirectCount,
          probeMethod: 'server_http_probe',
          manualVerificationRequired: true,
          checkedAspects: [`Server HTTP GET returned ${res.status}`],
          blockedAspects: [
            'Protected demo endpoint requires authentication or authorization; manual judge verification is required.'
          ],
          status: 'BLOCKED',
          summary: `Server HTTP probe returned HTTP ${res.status} (access/auth restricted); interactive flows remain BLOCKED without manual verification.`
        };
      }

      if (!res.ok) {
        return {
          ok: true,
          demoUrl: trimmed,
          checkedAt,
          reachable: false,
          httpStatus: res.status,
          finalUrl,
          contentType,
          title: null,
          hasCrashBanner: false,
          requiresAuth: false,
          blockedReason: `Demo endpoint returned non-2xx HTTP ${res.status}.`,
          ssrfBlocked: false,
          redirectCount,
          probeMethod: 'server_http_probe',
          manualVerificationRequired: true,
          checkedAspects: [`Server HTTP GET returned ${res.status}`],
          blockedAspects: [
            `Demo endpoint returned HTTP ${res.status}; availability claim contradicted by server probe.`
          ],
          status: 'CONTRADICTED',
          summary: `Server HTTP probe returned HTTP ${res.status} for ${finalUrl}; availability contradicted.`
        };
      }

      let rawBody = '';
      try {
        const text = await res.text();
        rawBody = text.slice(0, maxBodyBytes);
      } catch {
        rawBody = '';
      }

      const titleMatch = rawBody.match(/<title[^>]*>([^<]{1,140})<\/title>/i);
      const title = titleMatch?.[1] ? scrubControlAndTokens(titleMatch[1]) : null;
      const hasCrashBanner =
        /(Application error|500 Internal Server Error|__next_error__|Module not found)/i.test(
          rawBody
        );

      if (hasCrashBanner) {
        return {
          ok: true,
          demoUrl: trimmed,
          checkedAt,
          reachable: true,
          httpStatus: res.status,
          finalUrl,
          contentType,
          title,
          hasCrashBanner: true,
          requiresAuth: false,
          blockedReason: 'HTML response contains an application error banner.',
          ssrfBlocked: false,
          redirectCount,
          probeMethod: 'server_http_probe',
          manualVerificationRequired: true,
          checkedAspects: [
            `Server HTTP GET returned ${res.status} (${contentType || 'unknown content-type'})`,
            'Scanned HTML body for runtime error signatures'
          ],
          blockedAspects: [
            'Initial HTML shows an application crash banner; manual browser inspection required.'
          ],
          status: 'CONTRADICTED',
          summary: `Server HTTP probe returned HTTP ${res.status} but detected an application error banner in HTML.`
        };
      }

      return {
        ok: true,
        demoUrl: trimmed,
        checkedAt,
        reachable: true,
        httpStatus: res.status,
        finalUrl,
        contentType,
        title,
        hasCrashBanner: false,
        requiresAuth: false,
        blockedReason: null,
        ssrfBlocked: false,
        redirectCount,
        probeMethod: 'server_http_probe',
        manualVerificationRequired: true,
        checkedAspects: [
          `Server-side read-only HTTP GET returned ${res.status} (${contentType || 'unknown content-type'})`,
          ...(redirectCount > 0 ? [`Followed ${redirectCount} validated HTTP redirect(s) to ${finalUrl}`] : []),
          ...(title ? [`HTML <title>: "${title}"`] : [])
        ],
        blockedAspects: [
          'Server HTTP probe verified network reachability only (not browser JS execution, auth flows, or end-to-end features). Manual judge verification in a browser is still required.'
        ],
        // Strictly never mark PRODUCTION_CONFIRMED from HTTP GET reachability
        status: 'UNVERIFIED',
        summary: `Server HTTP probe succeeded with HTTP ${res.status} (reachability only${title ? `, title="${title}"` : ''}). Interactive flows remain UNVERIFIED and require manual browser verification.`
      };
    }

    return baseBlocked('Exceeded redirect limit.');
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      demoUrl: trimmed,
      checkedAt,
      reachable: false,
      httpStatus: null,
      finalUrl: null,
      contentType: null,
      title: null,
      hasCrashBanner: false,
      requiresAuth: false,
      blockedReason: isTimeout
        ? `Server HTTP probe timed out after ${Math.round(timeoutMs / 1000)}s.`
        : `Server HTTP probe network error (${msg}).`,
      ssrfBlocked: false,
      redirectCount: 0,
      probeMethod: 'server_http_probe',
      manualVerificationRequired: true,
      checkedAspects: ['Attempted server-side read-only HTTP GET probe'],
      blockedAspects: [
        isTimeout
          ? `Server probe timed out after ${Math.round(timeoutMs / 1000)}s; open demo URL manually in browser.`
          : `Network failure while probing demo URL (${msg}); open demo URL manually in browser.`
      ],
      status: 'BLOCKED',
      summary: isTimeout
        ? `Server HTTP probe timed out after ${Math.round(timeoutMs / 1000)}s (BLOCKED); manual judge verification required.`
        : `Server HTTP probe failed (${msg}); manual judge verification required.`
    };
  } finally {
    clearTimeout(timer);
  }
}
