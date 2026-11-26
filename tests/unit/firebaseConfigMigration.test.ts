import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatFirebaseAuthError } from '../../src/utils/firebaseErrors';

const mockGetFirestore = vi.fn(() => ({}));
const mockInitializeApp = vi.fn((opts: Record<string, unknown>) => ({ options: opts }));

vi.mock('firebase/app', () => ({
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => ({})),
  initializeApp: mockInitializeApp
}));

vi.mock('firebase/app-check', () => ({
  initializeAppCheck: vi.fn(() => ({})),
  ReCaptchaEnterpriseProvider: vi.fn(function (siteKey: string) {
    return { siteKey };
  })
}));

vi.mock('firebase/firestore', () => ({
  getFirestore: mockGetFirestore,
  doc: vi.fn(() => ({})),
  getDocFromServer: vi.fn().mockResolvedValue({})
}));

vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => ({ currentUser: null }))
}));

const mockGetAnalytics = vi.fn(() => ({ app: {} }));
const mockIsAnalyticsSupported = vi.fn().mockResolvedValue(true);

vi.mock('firebase/analytics', () => ({
  getAnalytics: mockGetAnalytics,
  isSupported: mockIsAnalyticsSupported
}));

vi.mock('firebase/remote-config', () => ({
  getRemoteConfig: vi.fn(() => ({ settings: {}, defaultConfig: {} })),
  fetchAndActivate: vi.fn().mockResolvedValue(false),
  getString: vi.fn(() => ''),
  getBoolean: vi.fn(() => false)
}));

describe('Firebase Migration Config & Error Formatting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('defaults to project hackmind-ai and (default) database without hardcoding secrets', async () => {
    vi.resetModules();
    const {
      TARGET_FIREBASE_PROJECT_ID,
      TARGET_FIRESTORE_DATABASE_ID,
      resolveFirebaseClientConfig
    } = await import('../../src/services/firebase/config');

    const resolved = resolveFirebaseClientConfig({});
    expect(TARGET_FIREBASE_PROJECT_ID).toBe('hackmind-ai');
    expect(TARGET_FIRESTORE_DATABASE_ID).toBe('(default)');
    expect(resolved.projectId).toBe('hackmind-ai');
    expect(resolved.authDomain).toBe('hackmind-ai.firebaseapp.com');
    expect(resolved.storageBucket).toBe('hackmind-ai.firebasestorage.app');
    expect(resolved.firestoreDatabaseId).toBe('(default)');
    expect(resolved.configured).toBe(false);
    expect(resolved.missingKeys).toEqual([
      'VITE_FIREBASE_API_KEY',
      'VITE_FIREBASE_APP_ID',
      'VITE_FIREBASE_MESSAGING_SENDER_ID'
    ]);
  });

  it('calls getFirestore with single app argument when database is (default)', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'test_api_key_placeholder');
    vi.stubEnv('VITE_FIREBASE_APP_ID', '1:123456:web:abcdef');
    vi.stubEnv('VITE_FIREBASE_MESSAGING_SENDER_ID', '123456');
    vi.stubEnv('VITE_FIREBASE_FIRESTORE_DATABASE_ID', '(default)');

    const { getFirebaseConfigStatus } = await import('../../src/services/firebase/config');
    const status = getFirebaseConfigStatus();

    expect(status.configured).toBe(true);
    expect(status.projectId).toBe('hackmind-ai');
    expect(status.firestoreDatabaseId).toBe('(default)');
    expect(mockGetFirestore).toHaveBeenCalledTimes(1);
    expect(mockGetFirestore.mock.calls[0]).toHaveLength(1);
  });

  it('formats common Firebase Auth error codes in EN and AR without exposing raw stack', () => {
    const err = { code: 'auth/invalid-api-key', message: 'Firebase: Error (auth/invalid-api-key).' };
    expect(formatFirebaseAuthError(err, 'en')).toContain('VITE_FIREBASE_API_KEY');
    expect(formatFirebaseAuthError(err, 'ar')).toContain('Firebase');

    const unauthErr = { code: 'auth/unauthorized-domain' };
    expect(formatFirebaseAuthError(unauthErr, 'en')).toContain('Authorized domains');
    expect(formatFirebaseAuthError(unauthErr, 'ar')).toContain('النطاق');

    const opErr = { code: 'auth/operation-not-allowed' };
    expect(formatFirebaseAuthError(opErr, 'en')).toContain('Authentication');
    expect(formatFirebaseAuthError(opErr, 'ar')).toContain('Authentication');
  });

  it('keeps Auth and Firestore operational with empty VITE_FIREBASE_MEASUREMENT_ID and VITE_APPCHECK_DEBUG_TOKEN, never fabricating a Measurement ID', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'test_api_key_placeholder');
    vi.stubEnv('VITE_FIREBASE_APP_ID', '1:123456:web:abcdef');
    vi.stubEnv('VITE_FIREBASE_MESSAGING_SENDER_ID', '123456');
    vi.stubEnv('VITE_FIREBASE_MEASUREMENT_ID', '');
    vi.stubEnv('VITE_APPCHECK_DEBUG_TOKEN', '');
    vi.stubEnv('VITE_RECAPTCHA_ENTERPRISE_SITE_KEY', '6Lc_PUBLIC_KEY_OK');
    vi.stubGlobal('window', {});
    vi.stubGlobal('self', {});

    const {
      auth,
      db,
      getAppCheckStatus,
      getFirebaseConfigStatus,
      initAnalyticsSafely,
      resolveFirebaseClientConfig
    } = await import('../../src/services/firebase/config');

    const resolved = resolveFirebaseClientConfig({
      VITE_FIREBASE_API_KEY: 'test_api_key_placeholder',
      VITE_FIREBASE_APP_ID: '1:123456:web:abcdef',
      VITE_FIREBASE_MESSAGING_SENDER_ID: '123456',
      VITE_FIREBASE_MEASUREMENT_ID: ''
    });

    expect(resolved.configured).toBe(true);
    expect(resolved.missingKeys).toEqual([]);
    expect(resolved.firebaseOptions.measurementId).toBeUndefined();
    expect(getFirebaseConfigStatus().configured).toBe(true);
    expect(db).toBeTruthy();
    expect(auth).toBeTruthy();
    expect(getAppCheckStatus().initialized).toBe(true);
    expect(getAppCheckStatus().provider).toBe('recaptcha_enterprise');

    const analyticsMissing = await initAnalyticsSafely();
    expect(analyticsMissing.initialized).toBe(false);
    expect(analyticsMissing.measurementId).toBeUndefined();
    expect(mockGetAnalytics).not.toHaveBeenCalled();

    const analyticsInvalid = await initAnalyticsSafely({ measurementId: 'invalid-id' });
    expect(analyticsInvalid.initialized).toBe(false);
    expect(analyticsInvalid.measurementId).toBeUndefined();
    expect(mockGetAnalytics).not.toHaveBeenCalled();
  });

  it('uses a genuine Measurement ID from env or trusted config and initializes Analytics only in supported browsers', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'test_api_key_placeholder');
    vi.stubEnv('VITE_FIREBASE_APP_ID', '1:123456:web:abcdef');
    vi.stubEnv('VITE_FIREBASE_MESSAGING_SENDER_ID', '123456');
    vi.stubGlobal('window', {});

    const { initAnalyticsSafely, resolveFirebaseClientConfig } = await import(
      '../../src/services/firebase/config'
    );

    const fromTrustedConfig = resolveFirebaseClientConfig(
      {
        VITE_FIREBASE_API_KEY: 'test_api_key_placeholder',
        VITE_FIREBASE_APP_ID: '1:123456:web:abcdef',
        VITE_FIREBASE_MESSAGING_SENDER_ID: '123456',
        VITE_FIREBASE_MEASUREMENT_ID: ''
      },
      'G-TRUSTED1234'
    );
    expect(fromTrustedConfig.firebaseOptions.measurementId).toBe('G-TRUSTED1234');

    const analyticsReady = await initAnalyticsSafely({ measurementId: 'G-VALID98765' });
    expect(analyticsReady.initialized).toBe(true);
    expect(analyticsReady.measurementId).toBe('G-VALID98765');
    expect(mockIsAnalyticsSupported).toHaveBeenCalledTimes(1);
    expect(mockGetAnalytics).toHaveBeenCalledTimes(1);
  });
});
