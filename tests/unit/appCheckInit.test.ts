import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInitializeAppCheck = vi.fn(() => ({ app: { name: '[DEFAULT]' } }));
const mockReCaptchaEnterpriseProvider = vi.fn(function ReCaptchaEnterpriseProviderMock(
  this: { siteKey: string },
  siteKey: string
) {
  this.siteKey = siteKey;
});

const callOrder: string[] = [];

vi.mock('firebase/app', () => ({
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => ({ name: '[DEFAULT]' })),
  initializeApp: vi.fn(() => {
    callOrder.push('initializeApp');
    return { name: '[DEFAULT]' };
  })
}));

vi.mock('firebase/app-check', () => ({
  initializeAppCheck: vi.fn((...args: unknown[]) => {
    callOrder.push('initializeAppCheck');
    return mockInitializeAppCheck(...(args as []));
  }),
  ReCaptchaEnterpriseProvider: vi.fn(function (this: { siteKey: string }, siteKey: string) {
    mockReCaptchaEnterpriseProvider.call(this, siteKey);
    return { siteKey };
  })
}));

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => {
    callOrder.push('getFirestore');
    return {};
  }),
  doc: vi.fn(() => ({})),
  getDocFromServer: vi.fn().mockResolvedValue({})
}));

vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => {
    callOrder.push('getAuth');
    return {};
  })
}));

vi.mock('firebase/remote-config', () => ({
  getRemoteConfig: vi.fn(() => ({ settings: {}, defaultConfig: {} })),
  fetchAndActivate: vi.fn().mockResolvedValue(false),
  getString: vi.fn(() => ''),
  getBoolean: vi.fn(() => false)
}));

vi.mock('firebase/ai', () => ({
  getAI: vi.fn(() => {
    callOrder.push('getAI');
    return { app: {} };
  }),
  GoogleAIBackend: vi.fn(function () {
    return {};
  })
}));

describe('Firebase App Check Client Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('hackmind.firebase.appCheckState')];
    vi.stubGlobal('window', {});
    vi.stubGlobal('self', {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('initializes ReCaptchaEnterpriseProvider before Firestore, Auth, and Firebase AI Logic on module load', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_RECAPTCHA_ENTERPRISE_SITE_KEY', '6Lc_ENV_ORDER_SITE_KEY');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await import('../../src/services/firebase/config');
    const { getFirebaseAIInstance } = await import('../../src/services/hybridAI/firebaseAI');
    getFirebaseAIInstance();

    expect(callOrder.slice(0, 5)).toEqual([
      'initializeApp',
      'initializeAppCheck',
      'getFirestore',
      'getAuth',
      'getAI'
    ]);
    expect(mockReCaptchaEnterpriseProvider).toHaveBeenCalledTimes(1);
    expect(mockReCaptchaEnterpriseProvider).toHaveBeenCalledWith('6Lc_ENV_ORDER_SITE_KEY');
    expect(infoSpy.mock.calls.flat().join(' ')).not.toContain('6Lc_ENV_ORDER_SITE_KEY');
  });

  it('warns clearly without breaking workflows when VITE_RECAPTCHA_ENTERPRISE_SITE_KEY is missing', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_RECAPTCHA_ENTERPRISE_SITE_KEY', '');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { getAppCheckStatus } = await import('../../src/services/firebase/config');
    const status = getAppCheckStatus();

    expect(status.initialized).toBe(false);
    expect(status.provider).toBe('unconfigured');
    expect(status.siteKeyConfigured).toBe(false);
    expect(status.siteKeySource).toBe('none');
    expect(status.autoRefreshEnabled).toBe(false);
    expect(mockInitializeAppCheck).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('VITE_RECAPTCHA_ENTERPRISE_SITE_KEY');
  });

  it('prevents duplicate App Check initialization across repeated calls / hot reload', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_RECAPTCHA_ENTERPRISE_SITE_KEY', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const {
      getAppCheckStatus,
      initAppCheckSafely,
      resetAppCheckStateForTests
    } = await import('../../src/services/firebase/config');
    resetAppCheckStateForTests();

    const fakeSiteKey = '6Lc_PUBLIC_SITE_KEY_EXAMPLE_ONLY';
    const first = initAppCheckSafely({
      envSiteKey: fakeSiteKey,
      configSiteKey: '',
      debugToken: '',
      isDev: true
    });
    const second = initAppCheckSafely({
      envSiteKey: fakeSiteKey,
      configSiteKey: '',
      debugToken: '',
      isDev: true
    });

    expect(first.initialized).toBe(true);
    expect(first.provider).toBe('recaptcha_enterprise');
    expect(first.siteKeyConfigured).toBe(true);
    expect(first.siteKeySource).toBe('env');
    expect(first.autoRefreshEnabled).toBe(true);
    expect(second).toEqual(first);
    expect(getAppCheckStatus()).toEqual(first);
    expect(mockReCaptchaEnterpriseProvider).toHaveBeenCalledTimes(1);
    expect(mockInitializeAppCheck).toHaveBeenCalledTimes(1);
    expect(mockInitializeAppCheck).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isTokenAutoRefreshEnabled: true })
    );
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls.flat().join(' ')).not.toContain(fakeSiteKey);
  });

  it('supports dev debug mode without logging debug tokens or site keys', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_RECAPTCHA_ENTERPRISE_SITE_KEY', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const {
      initAppCheckSafely,
      resetAppCheckStateForTests
    } = await import('../../src/services/firebase/config');
    resetAppCheckStateForTests();

    const fakeSiteKey = '6Lc_SITE_KEY_NO_LOG';
    const fakeDebugToken = 'debug-token-never-log-value';

    const status = initAppCheckSafely({
      envSiteKey: fakeSiteKey,
      debugToken: fakeDebugToken,
      isDev: true
    });

    expect(status.initialized).toBe(true);
    expect(status.provider).toBe('debug');
    expect(status.debugModeEnabled).toBe(true);
    expect((self as unknown as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN).toBe(
      fakeDebugToken
    );

    const logged = infoSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(fakeSiteKey);
    expect(logged).not.toContain(fakeDebugToken);
  });

  it('initializes ReCaptchaEnterpriseProvider normally when VITE_APPCHECK_DEBUG_TOKEN is empty, falsey, or in non-dev mode without inventing a debug token', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_RECAPTCHA_ENTERPRISE_SITE_KEY', '6Lc_NORMAL_MODE_SITE_KEY');
    vi.stubEnv('VITE_APPCHECK_DEBUG_TOKEN', '');
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const { initAppCheckSafely, resetAppCheckStateForTests } = await import(
      '../../src/services/firebase/config'
    );

    // 1. Empty debug token in dev -> normal ReCaptcha Enterprise provider, no debug global
    resetAppCheckStateForTests();
    const devNormal = initAppCheckSafely({
      envSiteKey: '6Lc_NORMAL_MODE_SITE_KEY',
      debugToken: '',
      isDev: true
    });
    expect(devNormal.initialized).toBe(true);
    expect(devNormal.provider).toBe('recaptcha_enterprise');
    expect(devNormal.debugModeEnabled).toBe(false);
    expect((self as unknown as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN).toBeUndefined();

    // 2. Literal "false" string or non-dev environment -> never enables debug mode
    resetAppCheckStateForTests();
    const prodStatus = initAppCheckSafely({
      envSiteKey: '6Lc_NORMAL_MODE_SITE_KEY',
      debugToken: 'false',
      isDev: false
    });
    expect(prodStatus.initialized).toBe(true);
    expect(prodStatus.provider).toBe('recaptcha_enterprise');
    expect(prodStatus.debugModeEnabled).toBe(false);
    expect((self as unknown as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN).toBeUndefined();
  });
});
