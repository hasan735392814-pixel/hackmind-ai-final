import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetToken = vi.fn();
const mockInitializeAppCheck = vi.fn(() => ({ app: { name: '[DEFAULT]' } }));
const mockReCaptchaEnterpriseProvider = vi.fn(function ReCaptchaEnterpriseProviderMock(
  this: { siteKey: string },
  siteKey: string
) {
  this.siteKey = siteKey;
});

vi.mock('firebase/app', () => ({
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => ({ name: '[DEFAULT]' })),
  initializeApp: vi.fn(() => ({ name: '[DEFAULT]' }))
}));

vi.mock('firebase/app-check', () => ({
  initializeAppCheck: mockInitializeAppCheck,
  ReCaptchaEnterpriseProvider: mockReCaptchaEnterpriseProvider,
  getToken: mockGetToken
}));

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  doc: vi.fn(() => ({})),
  getDocFromServer: vi.fn().mockResolvedValue({})
}));

vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => ({ currentUser: null }))
}));

vi.mock('firebase/remote-config', () => ({
  getRemoteConfig: vi.fn(() => ({ settings: {}, defaultConfig: {} })),
  fetchAndActivate: vi.fn().mockResolvedValue(false),
  getString: vi.fn(() => ''),
  getBoolean: vi.fn(() => false)
}));

describe('Firebase App Check Token Verification & AppId Diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('hackmind.firebase.appCheckState')];
    vi.stubGlobal('window', { location: { hostname: 'ais-dev-example.europe-west1.run.app' } });
    vi.stubGlobal('self', {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('verifies a genuine JWT App Check token and records verifiedAt without logging secrets', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'test_api_key');
    vi.stubEnv('VITE_FIREBASE_APP_ID', '1:695233244494:web:54c11e3a797bdc6c7fc21f');
    vi.stubEnv('VITE_FIREBASE_MESSAGING_SENDER_ID', '695233244494');
    vi.stubEnv('VITE_RECAPTCHA_ENTERPRISE_SITE_KEY', '6LfmtSMuAAAAAFICAWBDLoeWRAoZrvkyIc-0OKMz');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const jwtToken = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhYmMxMjMifQ.signaturepart_1234567890';
    mockGetToken.mockResolvedValueOnce({ token: jwtToken });

    const { verifyAppCheckToken, getAppCheckStatus } = await import(
      '../../src/services/firebase/config'
    );
    const result = await verifyAppCheckToken({ forceRefresh: true });

    expect(result.ok).toBe(true);
    expect(result.tokenPresent).toBe(true);
    expect(result.errorCode).toBeNull();
    expect(result.hostname).toBe('ais-dev-example.europe-west1.run.app');
    expect(result.appId).toBe('1:695233244494:web:54c11e3a797bdc6c7fc21f');
    expect(getAppCheckStatus().lastTokenVerifiedAt).toBe(result.verifiedAt);
    expect(getAppCheckStatus().lastTokenError).toBeNull();
    expect(mockGetToken).toHaveBeenCalledWith(expect.anything(), true);

    const logged = infoSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('6LfmtSMuAAAAAFICAWBDLoeWRAoZrvkyIc-0OKMz');
    expect(logged).not.toContain(jwtToken);
  });

  it('rejects dummy tokens returned alongside an App Check SDK error and classifies failure codes', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'test_api_key');
    vi.stubEnv('VITE_FIREBASE_APP_ID', '1:695233244494:web:84d52ce65db1fba47fc21f');
    vi.stubEnv('VITE_FIREBASE_MESSAGING_SENDER_ID', '695233244494');
    vi.stubEnv('VITE_RECAPTCHA_ENTERPRISE_SITE_KEY', '6LfmtSMuAAAAAFICAWBDLoeWRAoZrvkyIc-0OKMz');
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const { verifyAppCheckToken, getAppCheckStatus } = await import(
      '../../src/services/firebase/config'
    );

    // Case 1: SDK returns a dummy token paired with an error (400 App not registered)
    mockGetToken.mockResolvedValueOnce({
      token: 'eyJhbGciOiJub25lIn0.eyJkdW1teSI6dHJ1ZX0.dummy_token_placeholder_123456',
      error: new Error('AppCheck: 400 error. App not registered: 1:695233244494:web:84d52ce65db1fba47fc21f. (appCheck/fetch-status-error).')
    });
    const notRegRes = await verifyAppCheckToken();
    expect(notRegRes.ok).toBe(false);
    expect(notRegRes.tokenPresent).toBe(false);
    expect(notRegRes.errorCode).toBe('app_not_registered');
    expect(getAppCheckStatus().lastTokenError).toContain('App not registered');

    // Case 2: SDK returns 403 App attestation failed
    mockGetToken.mockResolvedValueOnce({
      token: 'dummy.token.value_without_success_1234567890',
      error: new Error('AppCheck: 403 error. App attestation failed.')
    });
    const attestRes = await verifyAppCheckToken();
    expect(attestRes.ok).toBe(false);
    expect(attestRes.errorCode).toBe('attestation_failed');

    // Case 3: Token itself is dummy/non-JWT even without an error field
    mockGetToken.mockResolvedValueOnce({
      token: 'dummy-app-check-token'
    });
    const dummyRes = await verifyAppCheckToken();
    expect(dummyRes.ok).toBe(false);
    expect(dummyRes.errorCode).toBe('dummy_or_empty_token');
  });

  it('bounds stalled reCAPTCHA Enterprise script loads with an explicit timeout', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'test_api_key');
    vi.stubEnv('VITE_FIREBASE_APP_ID', '1:695233244494:web:54c11e3a797bdc6c7fc21f');
    vi.stubEnv('VITE_FIREBASE_MESSAGING_SENDER_ID', '695233244494');
    vi.stubEnv('VITE_RECAPTCHA_ENTERPRISE_SITE_KEY', '6LfmtSMuAAAAAFICAWBDLoeWRAoZrvkyIc-0OKMz');
    vi.spyOn(console, 'info').mockImplementation(() => {});

    // Simulate loadReCAPTCHAEnterpriseScript stalling indefinitely inside getToken()
    mockGetToken.mockImplementationOnce(() => new Promise(() => {}));

    const { verifyAppCheckToken } = await import('../../src/services/firebase/config');
    const pending = verifyAppCheckToken({ timeoutMs: 2_000 });

    await vi.advanceTimersByTimeAsync(2_100);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('timeout');
    expect(result.message).toContain('ais-dev-example.europe-west1.run.app');
  });

  it('surfaces appIdMismatch truthfully when VITE_FIREBASE_APP_ID differs from firebase-applet-config.json', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'test_api_key');
    vi.stubEnv('VITE_FIREBASE_APP_ID', '1:695233244494:web:54c11e3a797bdc6c7fc21f');
    vi.stubEnv('VITE_FIREBASE_MESSAGING_SENDER_ID', '695233244494');
    vi.stubEnv('VITE_RECAPTCHA_ENTERPRISE_SITE_KEY', '6LfmtSMuAAAAAFICAWBDLoeWRAoZrvkyIc-0OKMz');
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const { getFirebaseConfigStatus } = await import('../../src/services/firebase/config');
    const fbStatus = getFirebaseConfigStatus();

    expect(fbStatus.appId).toBe('1:695233244494:web:54c11e3a797bdc6c7fc21f');
    expect(fbStatus.appletConfigAppId).toBe('1:695233244494:web:84d52ce65db1fba47fc21f');
    expect(fbStatus.appIdMismatch).toBe(true);
  });
});
