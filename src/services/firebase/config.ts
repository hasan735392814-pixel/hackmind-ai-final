import { getApp, getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDocFromServer,
  type Firestore
} from 'firebase/firestore';
import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck
} from 'firebase/app-check';
import {
  getRemoteConfig,
  fetchAndActivate,
  getString,
  getBoolean,
  type RemoteConfig
} from 'firebase/remote-config';
import appletConfig from '../../../firebase-applet-config.json';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write'
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export interface ResolvedFirebaseClientConfig {
  firebaseOptions: FirebaseOptions;
  projectId: string;
  authDomain: string;
  storageBucket: string;
  firestoreDatabaseId: string;
  configured: boolean;
  missingKeys: string[];
}

export interface FirebaseConfigStatus {
  projectId: string;
  authDomain: string;
  firestoreDatabaseId: string;
  appId: string;
  appletConfigAppId: string;
  appIdMismatch: boolean;
  configured: boolean;
  missingKeys: string[];
  initialized: boolean;
  source: 'env' | 'incomplete';
}

export const TARGET_FIREBASE_PROJECT_ID = 'hackmind-ai';
export const TARGET_FIRESTORE_DATABASE_ID = '(default)';

const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,}$/i;

export function isValidMeasurementId(value: string | undefined | null): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return MEASUREMENT_ID_PATTERN.test(trimmed);
}

export function resolveOptionalMeasurementId(
  envValue: string | undefined | null,
  trustedConfigValue: string | undefined | null = appletConfig.measurementId
): string | undefined {
  if (isValidMeasurementId(envValue)) return envValue.trim();
  if (isValidMeasurementId(trustedConfigValue)) return trustedConfigValue.trim();
  return undefined;
}

export function resolveFirebaseClientConfig(
  env: Record<string, string | boolean | undefined> = import.meta.env as unknown as Record<
    string,
    string | boolean | undefined
  >,
  trustedConfigMeasurementId: string | undefined = appletConfig.measurementId
): ResolvedFirebaseClientConfig {
  const read = (key: string): string => {
    const val = env[key];
    return typeof val === 'string' ? val.trim() : '';
  };

  const projectId = read('VITE_FIREBASE_PROJECT_ID') || TARGET_FIREBASE_PROJECT_ID;
  const authDomain = read('VITE_FIREBASE_AUTH_DOMAIN') || `${projectId}.firebaseapp.com`;
  const storageBucket = read('VITE_FIREBASE_STORAGE_BUCKET') || `${projectId}.firebasestorage.app`;
  const apiKey = read('VITE_FIREBASE_API_KEY');
  const messagingSenderId = read('VITE_FIREBASE_MESSAGING_SENDER_ID');
  const appId = read('VITE_FIREBASE_APP_ID');
  const measurementId = resolveOptionalMeasurementId(
    read('VITE_FIREBASE_MEASUREMENT_ID'),
    trustedConfigMeasurementId
  );
  const firestoreDatabaseId =
    read('VITE_FIREBASE_FIRESTORE_DATABASE_ID') || TARGET_FIRESTORE_DATABASE_ID;

  const missingKeys: string[] = [];
  if (!apiKey) missingKeys.push('VITE_FIREBASE_API_KEY');
  if (!appId) missingKeys.push('VITE_FIREBASE_APP_ID');
  if (!messagingSenderId) missingKeys.push('VITE_FIREBASE_MESSAGING_SENDER_ID');

  const firebaseOptions: FirebaseOptions = {
    projectId,
    authDomain,
    storageBucket,
    apiKey,
    appId,
    messagingSenderId,
    ...(measurementId ? { measurementId } : {})
  };

  return {
    firebaseOptions,
    projectId,
    authDomain,
    storageBucket,
    firestoreDatabaseId,
    configured: missingKeys.length === 0,
    missingKeys
  };
}

const resolvedClientConfig = resolveFirebaseClientConfig();

export const firebaseConfig = {
  projectId: resolvedClientConfig.projectId,
  authDomain: resolvedClientConfig.authDomain,
  storageBucket: resolvedClientConfig.storageBucket,
  firestoreDatabaseId: resolvedClientConfig.firestoreDatabaseId
};

export const firebaseApp: FirebaseApp =
  getApps().length > 0 ? getApp() : initializeApp(resolvedClientConfig.firebaseOptions);

export function getFirebaseConfigStatus(): FirebaseConfigStatus {
  const configuredAppId = resolvedClientConfig.firebaseOptions.appId || '';
  const appletConfigAppId = typeof appletConfig.appId === 'string' ? appletConfig.appId.trim() : '';
  return {
    projectId: resolvedClientConfig.projectId,
    authDomain: resolvedClientConfig.authDomain,
    firestoreDatabaseId: resolvedClientConfig.firestoreDatabaseId,
    appId: configuredAppId,
    appletConfigAppId,
    appIdMismatch: Boolean(configuredAppId && appletConfigAppId && configuredAppId !== appletConfigAppId),
    configured: resolvedClientConfig.configured,
    missingKeys: [...resolvedClientConfig.missingKeys],
    initialized: true,
    source: resolvedClientConfig.configured ? 'env' : 'incomplete'
  };
}

export interface AppCheckStatus {
  initialized: boolean;
  provider: 'recaptcha_enterprise' | 'debug' | 'unconfigured';
  siteKeyConfigured: boolean;
  siteKeySource: 'env' | 'config' | 'none';
  autoRefreshEnabled: boolean;
  debugModeEnabled: boolean;
  appId: string;
  hostname: string;
  lastTokenVerifiedAt: string | null;
  lastTokenError: string | null;
  reason: string;
}

export type AppCheckVerificationErrorCode =
  | 'unconfigured'
  | 'timeout'
  | 'app_not_registered'
  | 'attestation_failed'
  | 'recaptcha_error'
  | 'throttled'
  | 'dummy_or_empty_token'
  | 'unknown';

export interface AppCheckTokenVerificationResult {
  ok: boolean;
  initialized: boolean;
  tokenPresent: boolean;
  errorCode: AppCheckVerificationErrorCode | null;
  message: string;
  hostname: string;
  appId: string;
  projectId: string;
  verifiedAt: string;
}

interface AppCheckRuntimeState {
  instance: AppCheck | null;
  status: AppCheckStatus;
  diagnosticLogged: boolean;
}

const APP_CHECK_STATE_SYMBOL = Symbol.for('hackmind.firebase.appCheckState');

function getCurrentBrowserHostname(): string {
  if (typeof window === 'undefined' || !window.location) return '';
  return typeof window.location.hostname === 'string' ? window.location.hostname : '';
}

function getAppCheckRuntimeState(): AppCheckRuntimeState {
  const g = globalThis as Record<symbol, AppCheckRuntimeState | undefined>;
  if (!g[APP_CHECK_STATE_SYMBOL]) {
    g[APP_CHECK_STATE_SYMBOL] = {
      instance: null,
      status: {
        initialized: false,
        provider: 'unconfigured',
        siteKeyConfigured: false,
        siteKeySource: 'none',
        autoRefreshEnabled: false,
        debugModeEnabled: false,
        appId: resolvedClientConfig.firebaseOptions.appId || '',
        hostname: getCurrentBrowserHostname(),
        lastTokenVerifiedAt: null,
        lastTokenError: null,
        reason: 'App Check has not been initialized yet'
      },
      diagnosticLogged: false
    };
  }
  return g[APP_CHECK_STATE_SYMBOL];
}

export function resetAppCheckStateForTests(): void {
  const g = globalThis as Record<symbol, AppCheckRuntimeState | undefined>;
  delete g[APP_CHECK_STATE_SYMBOL];
}

export function initAppCheckSafely(overrides?: {
  envSiteKey?: string;
  configSiteKey?: string;
  debugToken?: string;
  isDev?: boolean;
}): AppCheckStatus {
  const state = getAppCheckRuntimeState();
  if (state.instance) {
    return state.status;
  }

  if (typeof window === 'undefined') {
    return state.status;
  }

  const isDev = overrides?.isDev ?? Boolean(import.meta.env.DEV);
  const envSiteKey = (
    overrides?.envSiteKey ??
    import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY ??
    ''
  ).trim();
  const configSiteKey = (overrides?.configSiteKey ?? appletConfig.recaptchaSiteKey ?? '').trim();

  const siteKey = envSiteKey || configSiteKey;
  const siteKeySource: AppCheckStatus['siteKeySource'] = envSiteKey
    ? 'env'
    : configSiteKey
      ? 'config'
      : 'none';

  const candidateDebugToken = (
    overrides?.debugToken ??
    import.meta.env.VITE_APPCHECK_DEBUG_TOKEN ??
    ''
  ).trim();
  const normalizedDebugLower = candidateDebugToken.toLowerCase();
  const hasExplicitDebugToken =
    candidateDebugToken.length > 0 &&
    normalizedDebugLower !== 'false' &&
    normalizedDebugLower !== '0' &&
    normalizedDebugLower !== 'null' &&
    normalizedDebugLower !== 'undefined' &&
    normalizedDebugLower !== 'none';
  const debugModeEnabled = isDev && hasExplicitDebugToken;

  try {
    if (debugModeEnabled) {
      (self as unknown as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN =
        normalizedDebugLower === 'true' ? true : candidateDebugToken;
    }

    if (siteKey) {
      state.instance = initializeAppCheck(firebaseApp, {
        provider: new ReCaptchaEnterpriseProvider(siteKey),
        isTokenAutoRefreshEnabled: true
      });
      state.status = {
        initialized: true,
        provider: debugModeEnabled ? 'debug' : 'recaptcha_enterprise',
        siteKeyConfigured: true,
        siteKeySource,
        autoRefreshEnabled: true,
        debugModeEnabled,
        appId: resolvedClientConfig.firebaseOptions.appId || '',
        hostname: getCurrentBrowserHostname(),
        lastTokenVerifiedAt: null,
        lastTokenError: null,
        reason: debugModeEnabled
          ? 'Firebase App Check active (development debug mode with auto-refresh)'
          : 'Firebase App Check active (reCAPTCHA Enterprise with auto-refresh)'
      };
      if (isDev && !state.diagnosticLogged) {
        state.diagnosticLogged = true;
        console.info(
          `[HackMind AppCheck] Initialized provider=${state.status.provider} source=${siteKeySource} autoRefresh=true project=${resolvedClientConfig.projectId}`
        );
      }
    } else {
      state.status = {
        initialized: false,
        provider: 'unconfigured',
        siteKeyConfigured: false,
        siteKeySource: 'none',
        autoRefreshEnabled: false,
        debugModeEnabled: false,
        appId: resolvedClientConfig.firebaseOptions.appId || '',
        hostname: getCurrentBrowserHostname(),
        lastTokenVerifiedAt: null,
        lastTokenError: null,
        reason:
          'Missing VITE_RECAPTCHA_ENTERPRISE_SITE_KEY; App Check stays inactive in client while enforcement is disabled.'
      };
      if (isDev && !state.diagnosticLogged) {
        state.diagnosticLogged = true;
        console.warn(
          '[HackMind AppCheck] VITE_RECAPTCHA_ENTERPRISE_SITE_KEY is not set. App Check client attestation is inactive; unrelated development workflows remain enabled while App Check enforcement is off.'
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'App Check initialization skipped';
    state.status = {
      initialized: false,
      provider: 'unconfigured',
      siteKeyConfigured: Boolean(siteKey),
      siteKeySource,
      autoRefreshEnabled: false,
      debugModeEnabled: false,
      appId: resolvedClientConfig.firebaseOptions.appId || '',
      hostname: getCurrentBrowserHostname(),
      lastTokenVerifiedAt: null,
      lastTokenError: message,
      reason: message
    };
    if (isDev && !state.diagnosticLogged) {
      state.diagnosticLogged = true;
      console.warn(`[HackMind AppCheck] Initialization deferred safely: ${message}`);
    }
  }

  return state.status;
}

export function getAppCheckStatus(): AppCheckStatus {
  const state = getAppCheckRuntimeState();
  state.status.hostname = getCurrentBrowserHostname();
  return state.status;
}

function classifyAppCheckFailure(rawMessage: string): AppCheckVerificationErrorCode {
  const lower = rawMessage.toLowerCase();
  if (lower.includes('app not registered') || lower.includes('failed_precondition')) {
    return 'app_not_registered';
  }
  if (lower.includes('attestation') || lower.includes('403') || lower.includes('permission_denied')) {
    return 'attestation_failed';
  }
  if (lower.includes('throttled') || lower.includes('too many')) {
    return 'throttled';
  }
  if (lower.includes('timed out')) {
    return 'timeout';
  }
  if (lower.includes('recaptcha') || lower.includes('site key') || lower.includes('domain')) {
    return 'recaptcha_error';
  }
  return 'unknown';
}

export async function verifyAppCheckToken(options?: {
  forceRefresh?: boolean;
  timeoutMs?: number;
}): Promise<AppCheckTokenVerificationResult> {
  const state = getAppCheckRuntimeState();
  const hostname = getCurrentBrowserHostname();
  const appId = resolvedClientConfig.firebaseOptions.appId || '';
  const projectId = resolvedClientConfig.projectId;
  const verifiedAt = new Date().toISOString();
  const timeoutMs = Math.max(2_000, options?.timeoutMs ?? 12_000);

  if (!state.instance) {
    initAppCheckSafely();
  }

  if (!state.instance || !state.status.initialized) {
    const msg = state.status.reason || 'Firebase App Check is not initialized.';
    state.status.lastTokenError = msg;
    return {
      ok: false,
      initialized: false,
      tokenPresent: false,
      errorCode: 'unconfigured',
      message: msg,
      hostname,
      appId,
      projectId,
      verifiedAt
    };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const tokenPromise = getToken(state.instance, Boolean(options?.forceRefresh));
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `App Check token acquisition timed out after ${Math.round(timeoutMs / 1000)}s (reCAPTCHA Enterprise script may be blocked or stalled on "${hostname || 'current host'}").`
          )
        );
      }, timeoutMs);
    });

    const result = (await Promise.race([tokenPromise, timeoutPromise])) as {
      token?: string;
      error?: Error;
    };

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    // Never accept a dummy token returned alongside an App Check error
    if (result?.error) {
      const errMsg = result.error.message || String(result.error);
      const errorCode = classifyAppCheckFailure(errMsg);
      state.status.lastTokenError = errMsg;
      return {
        ok: false,
        initialized: true,
        tokenPresent: false,
        errorCode,
        message: errMsg,
        hostname,
        appId,
        projectId,
        verifiedAt
      };
    }

    const tokenValue = typeof result?.token === 'string' ? result.token.trim() : '';
    const isLikelyJwt = tokenValue.split('.').length === 3 && tokenValue.length >= 30;
    if (!tokenValue || !isLikelyJwt || tokenValue.toLowerCase().includes('dummy')) {
      const errMsg = 'Firebase App Check returned an empty or invalid dummy token.';
      state.status.lastTokenError = errMsg;
      return {
        ok: false,
        initialized: true,
        tokenPresent: false,
        errorCode: 'dummy_or_empty_token',
        message: errMsg,
        hostname,
        appId,
        projectId,
        verifiedAt
      };
    }

    state.status.lastTokenVerifiedAt = verifiedAt;
    state.status.lastTokenError = null;
    return {
      ok: true,
      initialized: true,
      tokenPresent: true,
      errorCode: null,
      message: 'Valid Firebase App Check token verified.',
      hostname,
      appId,
      projectId,
      verifiedAt
    };
  } catch (err) {
    if (timer) {
      clearTimeout(timer);
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    const errorCode = classifyAppCheckFailure(errMsg);
    state.status.lastTokenError = errMsg;
    return {
      ok: false,
      initialized: true,
      tokenPresent: false,
      errorCode,
      message: errMsg,
      hostname,
      appId,
      projectId,
      verifiedAt
    };
  }
}

// Initialize App Check before Firestore, Auth, Remote Config, or Firebase AI Logic instances
initAppCheckSafely();

const usesNamedDatabase =
  Boolean(resolvedClientConfig.firestoreDatabaseId) &&
  resolvedClientConfig.firestoreDatabaseId !== TARGET_FIRESTORE_DATABASE_ID;

export const db: Firestore = usesNamedDatabase
  ? getFirestore(firebaseApp, resolvedClientConfig.firestoreDatabaseId)
  : getFirestore(firebaseApp);

function initAuthSafely(): Auth | null {
  try {
    return getAuth(firebaseApp);
  } catch (err) {
    if (import.meta.env.DEV) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[HackMind Firebase] Auth initialization skipped cleanly (${msg}). Configure VITE_FIREBASE_API_KEY in .env.local.`);
    }
    return null;
  }
}

export const auth: Auth | null = initAuthSafely();

export interface RemoteAIConfig {
  cloudModelName: string;
  heavyCloudModelName: string;
  defaultInferenceMode: 'prefer_on_device' | 'prefer_in_cloud' | 'only_on_device' | 'only_in_cloud';
  useLimitedUseAppCheckTokens: boolean;
}

const ENV_CLOUD_MODEL = (import.meta.env.VITE_FIREBASE_AI_CLOUD_MODEL || '').trim();
const ENV_HEAVY_CLOUD_MODEL = (import.meta.env.VITE_FIREBASE_AI_HEAVY_CLOUD_MODEL || '').trim();

export const DEFAULT_CLOUD_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_HEAVY_CLOUD_MODEL = 'gemini-4-hydrogen';

export function resolveEffectiveCloudModel(
  envValue: string,
  remoteValue: string,
  fallbackModel: string
): string {
  const cleanEnv = envValue.trim();
  if (cleanEnv) return cleanEnv;

  const cleanRemote = remoteValue.trim();
  if (!cleanRemote) return fallbackModel;

  // Prevent stale Remote Config parameters from downgrading to obsolete Gemini 1.x / 2.x models
  if (/^gemini-[12]\./i.test(cleanRemote)) {
    return fallbackModel;
  }
  return cleanRemote;
}

const DEFAULT_REMOTE_CONFIG: RemoteAIConfig = {
  cloudModelName: ENV_CLOUD_MODEL || DEFAULT_CLOUD_MODEL,
  heavyCloudModelName: ENV_HEAVY_CLOUD_MODEL || DEFAULT_HEAVY_CLOUD_MODEL,
  defaultInferenceMode: 'prefer_on_device',
  useLimitedUseAppCheckTokens: false
};

let remoteConfigInstance: RemoteConfig | null = null;
let cachedRemoteAIConfig: RemoteAIConfig = { ...DEFAULT_REMOTE_CONFIG };

export async function initRemoteConfigSafely(): Promise<RemoteAIConfig> {
  if (typeof window === 'undefined' || !resolvedClientConfig.configured) {
    return cachedRemoteAIConfig;
  }
  try {
    if (!remoteConfigInstance) {
      remoteConfigInstance = getRemoteConfig(firebaseApp);
      remoteConfigInstance.settings.minimumFetchIntervalMillis = import.meta.env.DEV ? 60_000 : 3_600_000;
      remoteConfigInstance.defaultConfig = {
        ai_cloud_model: DEFAULT_REMOTE_CONFIG.cloudModelName,
        ai_heavy_cloud_model: DEFAULT_REMOTE_CONFIG.heavyCloudModelName,
        ai_default_inference_mode: DEFAULT_REMOTE_CONFIG.defaultInferenceMode,
        ai_limited_use_appcheck: DEFAULT_REMOTE_CONFIG.useLimitedUseAppCheckTokens
      };
    }
    await fetchAndActivate(remoteConfigInstance);
    const modeVal = getString(remoteConfigInstance, 'ai_default_inference_mode');
    const validMode =
      modeVal === 'prefer_on_device' ||
      modeVal === 'prefer_in_cloud' ||
      modeVal === 'only_on_device' ||
      modeVal === 'only_in_cloud'
        ? modeVal
        : DEFAULT_REMOTE_CONFIG.defaultInferenceMode;

    cachedRemoteAIConfig = {
      cloudModelName: resolveEffectiveCloudModel(
        ENV_CLOUD_MODEL,
        getString(remoteConfigInstance, 'ai_cloud_model'),
        DEFAULT_REMOTE_CONFIG.cloudModelName
      ),
      heavyCloudModelName: resolveEffectiveCloudModel(
        ENV_HEAVY_CLOUD_MODEL,
        getString(remoteConfigInstance, 'ai_heavy_cloud_model'),
        DEFAULT_REMOTE_CONFIG.heavyCloudModelName
      ),
      defaultInferenceMode: validMode,
      useLimitedUseAppCheckTokens: getBoolean(remoteConfigInstance, 'ai_limited_use_appcheck')
    };
  } catch {
    cachedRemoteAIConfig = { ...DEFAULT_REMOTE_CONFIG };
  }
  return cachedRemoteAIConfig;
}

export function getCachedRemoteAIConfig(): RemoteAIConfig {
  return cachedRemoteAIConfig;
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid,
      email: auth?.currentUser?.email,
      emailVerified: auth?.currentUser?.emailVerified,
      isAnonymous: auth?.currentUser?.isAnonymous,
      tenantId: auth?.currentUser?.tenantId,
      providerInfo:
        auth?.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email
        })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export interface AnalyticsStatus {
  initialized: boolean;
  measurementId: string | undefined;
  reason: string;
}

export async function initAnalyticsSafely(overrides?: {
  measurementId?: string | null;
  app?: FirebaseApp;
}): Promise<AnalyticsStatus> {
  const effectiveMeasurementId =
    overrides && 'measurementId' in overrides
      ? resolveOptionalMeasurementId(overrides.measurementId, undefined)
      : resolvedClientConfig.firebaseOptions.measurementId;

  if (!isValidMeasurementId(effectiveMeasurementId)) {
    return {
      initialized: false,
      measurementId: undefined,
      reason: 'Optional Measurement ID not configured; Analytics skipped.'
    };
  }

  if (typeof window === 'undefined') {
    return {
      initialized: false,
      measurementId: effectiveMeasurementId,
      reason: 'Analytics skipped outside browser environment.'
    };
  }

  try {
    const { getAnalytics, isSupported } = await import('firebase/analytics');
    const supported = await isSupported();
    if (!supported) {
      return {
        initialized: false,
        measurementId: effectiveMeasurementId,
        reason: 'Browser environment does not support Firebase Analytics.'
      };
    }
    getAnalytics(overrides?.app ?? firebaseApp);
    return {
      initialized: true,
      measurementId: effectiveMeasurementId,
      reason: 'Firebase Analytics initialized.'
    };
  } catch (err) {
    return {
      initialized: false,
      measurementId: effectiveMeasurementId,
      reason: err instanceof Error ? err.message : 'Analytics initialization skipped.'
    };
  }
}

export async function verifyFirestoreConnection(): Promise<{ connected: boolean; error?: string }> {
  if (!resolvedClientConfig.configured) {
    return {
      connected: false,
      error: `Firebase Web client configuration incomplete. Missing: ${resolvedClientConfig.missingKeys.join(', ')}`
    };
  }
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return { connected: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('the client is offline')) {
      return { connected: false, error: message };
    }
    return { connected: true };
  }
}

void verifyFirestoreConnection();
void initRemoteConfigSafely();
void initAnalyticsSafely();
