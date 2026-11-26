import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isPublicIpAddress,
  probePublicDemoFromServer
} from '../../src/services/judging/serverDemoProbe';
import { verifyPublicDemoSafely } from '../../src/services/judging/evidenceVerifier';

describe('Server Demo Probe & SSRF Guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects private, loopback, link-local, CGNAT, ULA, and IPv4-mapped IPv6 addresses', () => {
    expect(isPublicIpAddress('127.0.0.1')).toBe(false);
    expect(isPublicIpAddress('10.0.0.5')).toBe(false);
    expect(isPublicIpAddress('172.16.12.1')).toBe(false);
    expect(isPublicIpAddress('172.31.255.254')).toBe(false);
    expect(isPublicIpAddress('192.168.1.10')).toBe(false);
    expect(isPublicIpAddress('169.254.169.254')).toBe(false);
    expect(isPublicIpAddress('100.64.0.1')).toBe(false);
    expect(isPublicIpAddress('0.0.0.0')).toBe(false);
    expect(isPublicIpAddress('::1')).toBe(false);
    expect(isPublicIpAddress('fe80::1')).toBe(false);
    expect(isPublicIpAddress('fc00::abcd')).toBe(false);
    expect(isPublicIpAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicIpAddress('::ffff:169.254.169.254')).toBe(false);

    expect(isPublicIpAddress('93.184.216.34')).toBe(true);
    expect(isPublicIpAddress('172.32.0.1')).toBe(true);
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('blocks localhost, non-standard ports, embedded credentials, private DNS targets, and internal redirect hops', async () => {
    const fetchSpy = vi.fn();

    const localhostRes = await probePublicDemoFromServer('http://localhost/admin', {
      fetchFn: fetchSpy as unknown as typeof fetch
    });
    expect(localhostRes.ssrfBlocked).toBe(true);
    expect(localhostRes.status).toBe('BLOCKED');
    expect(fetchSpy).not.toHaveBeenCalled();

    const portRes = await probePublicDemoFromServer('https://example.com:8080/app', {
      fetchFn: fetchSpy as unknown as typeof fetch
    });
    expect(portRes.ssrfBlocked).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    const credRes = await probePublicDemoFromServer('https://user:secret@example.com/app', {
      fetchFn: fetchSpy as unknown as typeof fetch
    });
    expect(credRes.ssrfBlocked).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    const privateDnsRes = await probePublicDemoFromServer('https://rebind.example.com/', {
      dnsLookup: async () => [{ address: '169.254.169.254', family: 4 }],
      fetchFn: fetchSpy as unknown as typeof fetch
    });
    expect(privateDnsRes.ssrfBlocked).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Public initial host redirecting to 127.0.0.1 must be blocked before following redirect
    const redirectFetch = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/latest/meta-data/' }
      })
    );
    const hopBlockedRes = await probePublicDemoFromServer('https://demo.example.com/', {
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchFn: redirectFetch as unknown as typeof fetch
    });
    expect(hopBlockedRes.ssrfBlocked).toBe(true);
    expect(hopBlockedRes.status).toBe('BLOCKED');
    expect(redirectFetch).toHaveBeenCalledTimes(1);
  });

  it('respects auth walls as BLOCKED and never marks public HTTP 200 as PRODUCTION_CONFIRMED', async () => {
    const authRedirectFetch = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://demo.example.com/login?next=/dashboard' }
      })
    );
    const authRes = await probePublicDemoFromServer('https://demo.example.com/dashboard', {
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchFn: authRedirectFetch as unknown as typeof fetch
    });
    expect(authRes.requiresAuth).toBe(true);
    expect(authRes.status).toBe('BLOCKED');
    expect(authRes.manualVerificationRequired).toBe(true);

    const okFetch = vi.fn(async () =>
      new Response('<html><head><title>HackMind Demo</title></head><body>OK</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })
    );
    const okRes = await probePublicDemoFromServer('https://demo.example.com/', {
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchFn: okFetch as unknown as typeof fetch
    });
    expect(okRes.reachable).toBe(true);
    expect(okRes.httpStatus).toBe(200);
    expect(okRes.status).toBe('UNVERIFIED');
    expect(okRes.manualVerificationRequired).toBe(true);
    expect(okRes.probeMethod).toBe('server_http_probe');
    expect(okRes.checkedAspects.join(' ')).toContain('HackMind Demo');
  });

  it('uses /api/demo-probe fallback when browser CORS blocks direct GET, while still requiring manual verification', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://app.example.com') {
        throw new TypeError('Failed to fetch (CORS)');
      }
      if (url === '/api/demo-probe') {
        return new Response(
          JSON.stringify({
            demoUrl: 'https://app.example.com',
            checkedAt: '2026-11-22T00:00:00Z',
            reachable: true,
            httpStatus: 200,
            finalUrl: 'https://app.example.com/',
            contentType: 'text/html',
            corsBlocked: true,
            browserCorsBlocked: true,
            requiresAuth: false,
            ssrfBlocked: false,
            probeMethod: 'server_http_probe',
            manualVerificationRequired: true,
            checkedAspects: ['Server HTTP GET returned 200 (text/html)'],
            blockedAspects: ['Interactive flows require manual browser verification'],
            status: 'UNVERIFIED',
            summary: 'Server HTTP GET reached https://app.example.com/ (HTTP 200). Manual verification required.'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);
    const check = await verifyPublicDemoSafely('https://app.example.com');
    expect(check.reachable).toBe(true);
    expect(check.httpStatus).toBe(200);
    expect(check.browserCorsBlocked).toBe(true);
    expect(check.probeMethod).toBe('server_http_probe');
    expect(check.manualVerificationRequired).toBe(true);
    expect(check.status).toBe('UNVERIFIED');
  });
});
