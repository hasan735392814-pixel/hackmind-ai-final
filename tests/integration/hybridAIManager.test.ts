import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGenerativeModel, InferenceMode, InferenceSource } from 'firebase/ai';
import { translations } from '../../src/i18n/translations';
import {
  DEFAULT_CLOUD_MODEL,
  DEFAULT_HEAVY_CLOUD_MODEL,
  resolveEffectiveCloudModel
} from '../../src/services/firebase/config';

const mockGenerateContent = vi.fn();

vi.mock('firebase/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/ai')>();
  return {
    ...actual,
    getAI: vi.fn(() => ({ app: {} })),
    getGenerativeModel: vi.fn(() => ({
      generateContent: mockGenerateContent
    }))
  };
});

vi.mock('../../src/services/firebase/firestoreService', () => ({
  recordAIUsageInFirestore: vi.fn().mockResolvedValue(undefined)
}));

type GetAppCheckStatusFn = typeof import('../../src/services/firebase/config').getAppCheckStatus;
type VerifyAppCheckTokenFn = typeof import('../../src/services/firebase/config').verifyAppCheckToken;

const { mockGetAppCheckStatus, mockVerifyAppCheckToken, actualConfigFns } = vi.hoisted(() => ({
  mockGetAppCheckStatus: vi.fn<GetAppCheckStatusFn>(),
  mockVerifyAppCheckToken: vi.fn<VerifyAppCheckTokenFn>(),
  actualConfigFns: {
    getAppCheckStatus: null as GetAppCheckStatusFn | null,
    verifyAppCheckToken: null as VerifyAppCheckTokenFn | null
  }
}));

vi.mock('../../src/services/firebase/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/firebase/config')>();
  actualConfigFns.getAppCheckStatus = actual.getAppCheckStatus;
  actualConfigFns.verifyAppCheckToken = actual.verifyAppCheckToken;
  mockGetAppCheckStatus.mockImplementation(() => actual.getAppCheckStatus());
  mockVerifyAppCheckToken.mockImplementation((options) => actual.verifyAppCheckToken(options));
  return {
    ...actual,
    getAppCheckStatus: mockGetAppCheckStatus,
    verifyAppCheckToken: mockVerifyAppCheckToken
  };
});

import { detectDeviceCapability } from '../../src/services/hybridAI/deviceCapability';
import { getAIActivitySummary } from '../../src/services/hybridAI/inferenceLogger';
import { executeHybridInference } from '../../src/services/hybridAI/inferenceManager';

function resetConfigMocksToActual(): void {
  if (actualConfigFns.getAppCheckStatus) {
    const fn = actualConfigFns.getAppCheckStatus;
    mockGetAppCheckStatus.mockImplementation(() => fn());
  }
  if (actualConfigFns.verifyAppCheckToken) {
    const fn = actualConfigFns.verifyAppCheckToken;
    mockVerifyAppCheckToken.mockImplementation((options) => fn(options));
  }
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    }
  };
}

describe('Hybrid AI Engine & Bilingual Parity', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetConfigMocksToActual();
    delete (globalThis as Record<string, unknown>).LanguageModel;
  });

  it('reports truthful unverified identity label when Prompt API is exposed on desktop', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
      onLine: true
    });
    (globalThis as Record<string, unknown>).LanguageModel = {
      availability: vi.fn().mockResolvedValue('available')
    };

    const report = await detectDeviceCapability('en');
    expect(report.isDesktopEnvironment).toBe(true);
    expect(report.localAvailability).toBe('available');
    expect(report.localModelIdentityLabel).toBe(
      'On-device AI — model identity not independently verified.'
    );
  });

  it('reports ON-DEVICE when Firebase AI Logic confirms InferenceSource.ON_DEVICE', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0',
      onLine: true
    });
    (globalThis as Record<string, unknown>).LanguageModel = {
      availability: vi.fn().mockResolvedValue('available')
    };
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => '{"title":"Edge Triage","problemStatement":"P","proposedSolution":"S"}',
        inferenceSource: InferenceSource.ON_DEVICE
      }
    });

    const res = await executeHybridInference<{ title: string }>({
      taskKey: 'mentor_ideation',
      prompt: 'Test idea',
      preferredMode: InferenceMode.PREFER_ON_DEVICE,
      cloudConsentGranted: true
    });

    expect(res.ok).toBe(true);
    expect(res.statusIndicator).toBe('ON-DEVICE');
    expect(res.fallbackOccurred).toBe(false);
    expect(res.data?.title).toBe('Edge Triage');
  });

  it('reports FALLBACK TO CLOUD with reason when PREFER_ON_DEVICE falls back to IN_CLOUD', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0',
      onLine: true
    });
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => '{"title":"Cloud Fallback Idea"}',
        inferenceSource: InferenceSource.IN_CLOUD
      }
    });

    const res = await executeHybridInference<{ title: string }>({
      taskKey: 'mentor_ideation',
      prompt: 'Test fallback',
      preferredMode: InferenceMode.PREFER_ON_DEVICE,
      cloudConsentGranted: true
    });

    expect(res.ok).toBe(true);
    expect(res.statusIndicator).toBe('FALLBACK TO CLOUD');
    expect(res.fallbackOccurred).toBe(true);
    expect(res.fallbackReason).toBeTruthy();
  });

  it('never falls back to cloud in ONLY_ON_DEVICE when local model is unavailable', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 15) Mobile',
      onLine: true
    });

    const res = await executeHybridInference({
      taskKey: 'mentor_ideation',
      prompt: 'Local only test',
      preferredMode: InferenceMode.ONLY_ON_DEVICE,
      cloudConsentGranted: true
    });

    expect(res.ok).toBe(false);
    expect(res.statusIndicator).toBe('LOCAL MODEL UNAVAILABLE');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('blocks cloud inference when explicit cloud consent is withheld or omitted', async () => {
    const resFalse = await executeHybridInference({
      taskKey: 'hackathon_builder',
      prompt: 'Build draft',
      preferredMode: InferenceMode.ONLY_IN_CLOUD,
      cloudConsentGranted: false
    });

    expect(resFalse.ok).toBe(false);
    expect(resFalse.statusIndicator).toBe('FAILED');
    expect(resFalse.modelIdentifier).toBe('consent_blocked');

    const resUndefined = await executeHybridInference({
      taskKey: 'hackathon_builder',
      prompt: 'Build draft without consent flag',
      preferredMode: InferenceMode.ONLY_IN_CLOUD
    });

    expect(resUndefined.ok).toBe(false);
    expect(resUndefined.statusIndicator).toBe('FAILED');
    expect(resUndefined.modelIdentifier).toBe('consent_blocked');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('routes normal tasks to gemini-3.5-flash-lite and omits deprecated temperature', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0',
      onLine: true
    });
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => '{"title":"Mentor Idea"}',
        inferenceSource: InferenceSource.IN_CLOUD
      }
    });

    const res = await executeHybridInference<{ title: string }>({
      taskKey: 'mentor_ideation',
      prompt: 'Ideate MVP',
      preferredMode: InferenceMode.ONLY_IN_CLOUD,
      cloudConsentGranted: true
    });

    expect(res.ok).toBe(true);
    expect(res.modelIdentifier).toBe('gemini-3.5-flash-lite');
    const getModelMock = vi.mocked(getGenerativeModel);
    expect(getModelMock).toHaveBeenCalledTimes(1);
    const params = getModelMock.mock.calls[0]?.[1] as {
      inCloudParams?: { model?: string; generationConfig?: Record<string, unknown> };
    };
    expect(params.inCloudParams?.model).toBe('gemini-3.5-flash-lite');
    expect(params.inCloudParams?.generationConfig).toEqual({ responseMimeType: 'application/json' });
    expect(params.inCloudParams?.generationConfig).not.toHaveProperty('temperature');
  });

  it('routes heavy judge_evidence tasks to gemini-4-hydrogen and omits deprecated temperature', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0',
      onLine: true
    });
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => '{"verifiedEvidence":[],"teamClaims":[],"missingEvidence":[]}',
        inferenceSource: InferenceSource.IN_CLOUD
      }
    });

    const res = await executeHybridInference<{ verifiedEvidence: string[] }>({
      taskKey: 'judge_evidence',
      prompt: 'Audit evidence',
      preferredMode: InferenceMode.ONLY_IN_CLOUD,
      useHeavyCloudModel: true,
      cloudConsentGranted: true
    });

    expect(res.ok).toBe(true);
    expect(res.modelIdentifier).toBe('gemini-4-hydrogen');
    const getModelMock = vi.mocked(getGenerativeModel);
    expect(getModelMock).toHaveBeenCalledTimes(1);
    const params = getModelMock.mock.calls[0]?.[1] as {
      inCloudParams?: { model?: string; generationConfig?: Record<string, unknown> };
    };
    expect(params.inCloudParams?.model).toBe('gemini-4-hydrogen');
    expect(params.inCloudParams?.generationConfig).toEqual({ responseMimeType: 'application/json' });
    expect(params.inCloudParams?.generationConfig).not.toHaveProperty('temperature');
  });

  it('enforces ENV > Remote Config > Default precedence and blocks legacy 1.x/2.x Remote Config overrides', () => {
    expect(
      resolveEffectiveCloudModel('gemini-3.5-flash-lite', 'gemini-2.5-flash', DEFAULT_CLOUD_MODEL)
    ).toBe('gemini-3.5-flash-lite');
    expect(resolveEffectiveCloudModel('', 'gemini-2.5-flash', DEFAULT_CLOUD_MODEL)).toBe(
      DEFAULT_CLOUD_MODEL
    );
    expect(resolveEffectiveCloudModel('', 'gemini-1.5-pro', DEFAULT_HEAVY_CLOUD_MODEL)).toBe(
      DEFAULT_HEAVY_CLOUD_MODEL
    );
    expect(resolveEffectiveCloudModel('', 'gemini-3.5-pro', DEFAULT_CLOUD_MODEL)).toBe(
      'gemini-3.5-pro'
    );
    expect(resolveEffectiveCloudModel('', '', DEFAULT_HEAVY_CLOUD_MODEL)).toBe('gemini-4-hydrogen');
  });

  it('maintains complete translation key parity between English and Arabic', () => {
    const enKeys = Object.keys(translations.en);
    const arKeys = Object.keys(translations.ar);
    expect(arKeys).toEqual(enKeys);
    expect(Object.keys(translations.ar.sidebar)).toEqual(Object.keys(translations.en.sidebar));
    expect(Object.keys(translations.ar.ai)).toEqual(Object.keys(translations.en.ai));
  });

  it('prevents silent cloud fallback in PREFER_ON_DEVICE when cloudConsentGranted is false even if local model is available', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0',
      onLine: true
    });
    (globalThis as Record<string, unknown>).LanguageModel = {
      availability: vi.fn().mockResolvedValue('available')
    };

    mockGenerateContent.mockRejectedValueOnce(new Error('Insufficient device memory for local session'));

    const res = await executeHybridInference({
      taskKey: 'evidence_excerpt_summary',
      prompt: 'Short code excerpt',
      preferredMode: InferenceMode.PREFER_ON_DEVICE,
      cloudConsentGranted: false
    });

    const getModelMock = vi.mocked(getGenerativeModel);
    expect(getModelMock).toHaveBeenCalledTimes(1);
    const passedParams = getModelMock.mock.calls[0]?.[1] as { mode?: InferenceMode };
    expect(passedParams.mode).toBe(InferenceMode.ONLY_ON_DEVICE);

    expect(res.ok).toBe(false);
    expect(res.effectiveSdkMode).toBe(InferenceMode.ONLY_ON_DEVICE);
    expect(res.statusIndicator).toBe('LOCAL MODEL UNAVAILABLE');
    expect(res.failureCategory).toBe('local_resources');
    expect(res.errorMessage).toContain('consent');
  });

  it('routes oversized PREFER_ON_DEVICE inputs to Cloud only with explicit consent and blocks without consent', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0',
      onLine: true
    });
    (globalThis as Record<string, unknown>).LanguageModel = {
      availability: vi.fn().mockResolvedValue('available')
    };

    const oversizedPrompt = 'A'.repeat(4_800);

    const blocked = await executeHybridInference({
      taskKey: 'preliminary_summary',
      prompt: oversizedPrompt,
      preferredMode: InferenceMode.PREFER_ON_DEVICE,
      cloudConsentGranted: false
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.modelIdentifier).toBe('consent_blocked');
    expect(mockGenerateContent).not.toHaveBeenCalled();

    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () =>
          JSON.stringify({
            headline: 'Cloud Routed Overview',
            summary: 'Handled oversized prompt in Cloud.',
            highlights: ['Modular Express server'],
            caveats: []
          }),
        inferenceSource: InferenceSource.IN_CLOUD
      }
    });

    const allowed = await executeHybridInference<{ headline: string }>({
      taskKey: 'preliminary_summary',
      prompt: oversizedPrompt,
      preferredMode: InferenceMode.PREFER_ON_DEVICE,
      cloudConsentGranted: true
    });

    expect(allowed.ok).toBe(true);
    expect(allowed.statusIndicator).toBe('FALLBACK TO CLOUD');
    expect(allowed.fallbackOccurred).toBe(true);
    expect(allowed.fallbackReason).toContain('context capacity');
    expect(allowed.data?.headline).toBe('Cloud Routed Overview');
  });

  it('detects downloadable, downloading, insufficient_resources, unsupported_browser, and mobile_unsupported states truthfully', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 15) Mobile Chrome/140.0.0.0',
      onLine: true
    });
    const mobileReport = await detectDeviceCapability('en');
    expect(mobileReport.localAvailability).toBe('mobile_unsupported');
    expect(mobileReport.localReasonCode).toBe('mobile_unsupported');
    expect(mobileReport.details).toContain('Android Chrome');

    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
      onLine: true
    });
    const unsupportedReport = await detectDeviceCapability('en');
    expect(unsupportedReport.localAvailability).toBe('unsupported_browser');
    expect(unsupportedReport.localReasonCode).toBe('unsupported_browser');

    (globalThis as Record<string, unknown>).LanguageModel = {
      availability: vi.fn().mockResolvedValue('downloading')
    };
    const downloadingReport = await detectDeviceCapability('en');
    expect(downloadingReport.localAvailability).toBe('downloading');
    expect(downloadingReport.localReasonCode).toBe('downloading');

    (globalThis as Record<string, unknown>).LanguageModel = {
      availability: vi.fn().mockResolvedValue('downloadable')
    };
    const downloadableReport = await detectDeviceCapability('en');
    expect(downloadableReport.localAvailability).toBe('downloadable');
    expect(downloadableReport.localReasonCode).toBe('downloadable');

    (globalThis as Record<string, unknown>).LanguageModel = {
      availability: vi.fn().mockRejectedValue(new Error('QuotaExceededError: insufficient VRAM memory'))
    };
    const resourceReport = await detectDeviceCapability('en');
    expect(resourceReport.localAvailability).toBe('unavailable');
    expect(resourceReport.localReasonCode).toBe('insufficient_resources');
  });

  it('executes all 4 on-device-first tasks using PREFER_ON_DEVICE with onDeviceParams and inCloudParams', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0',
      onLine: true
    });
    (globalThis as Record<string, unknown>).LanguageModel = {
      availability: vi.fn().mockResolvedValue('available')
    };

    const sampleResponses = [
      {
        taskKey: 'evidence_excerpt_summary' as const,
        payload: { summary: 'API route verified', keySignals: ['POST /api/probe'], citedPaths: ['server.ts'] }
      },
      {
        taskKey: 'evidence_criteria_classify' as const,
        payload: {
          classifications: [
            { criterionId: 'technical_implementation', relevance: 'high', rationale: 'Verified handler' }
          ],
          primaryCriterion: 'technical_implementation'
        }
      },
      {
        taskKey: 'user_text_fact_extract' as const,
        payload: { facts: ['Uses Express v4'], openQuestions: ['Any auth middleware?'] }
      },
      {
        taskKey: 'preliminary_summary' as const,
        payload: {
          headline: 'Preliminary Overview',
          summary: 'Concise factual summary',
          highlights: ['Clean routing'],
          caveats: ['No test logs']
        }
      }
    ];

    for (const item of sampleResponses) {
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => JSON.stringify(item.payload),
          inferenceSource: InferenceSource.ON_DEVICE
        }
      });

      const res = await executeHybridInference<Record<string, unknown>>({
        taskKey: item.taskKey,
        prompt: 'Inspect snippet',
        preferredMode: InferenceMode.PREFER_ON_DEVICE,
        cloudConsentGranted: true
      });

      expect(res.ok).toBe(true);
      expect(res.statusIndicator).toBe('ON-DEVICE');
      expect(res.sdkInferenceSource).toBe(InferenceSource.ON_DEVICE);
      expect(res.data).toEqual(item.payload);
    }

    const getModelMock = vi.mocked(getGenerativeModel);
    expect(getModelMock).toHaveBeenCalledTimes(4);
    const firstConfig = getModelMock.mock.calls[0]?.[1] as {
      mode?: InferenceMode;
      onDeviceParams?: unknown;
      inCloudParams?: { model?: string };
    };
    expect(firstConfig.mode).toBe(InferenceMode.PREFER_ON_DEVICE);
    expect(firstConfig.onDeviceParams).toBeDefined();
    expect(firstConfig.inCloudParams?.model).toBe('gemini-3.5-flash-lite');
  });

  it('classifies Firebase AI SDK "Timeout has expired." AbortError as timeout (not unknown), preserves sdkInferenceSource: null, and does not retry or fall back', async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 15) Mobile Chrome/140.0.0.0',
      onLine: true
    });

    mockGenerateContent.mockRejectedValueOnce(new DOMException('Timeout has expired.', 'AbortError'));

    const res = await executeHybridInference({
      taskKey: 'judge_evidence',
      prompt: 'Evaluate hackathon evidence',
      preferredMode: InferenceMode.ONLY_IN_CLOUD,
      useHeavyCloudModel: true,
      cloudConsentGranted: true,
      timeoutMs: 30_000,
      maxTransientRetries: 2
    });

    expect(res.ok).toBe(false);
    expect(res.statusIndicator).toBe('FAILED');
    expect(res.sdkInferenceSource).toBeNull();
    expect(res.failureCategory).toBe('timeout');
    expect(res.failurePhase).toBe('connecting_model');
    expect(res.modelIdentifier).toBe('gemini-4-hydrogen');
    expect(res.errorMessage).toContain('timed out after 30s');
    expect(res.errorMessage).not.toBe('Timeout has expired.');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    const summary = getAIActivitySummary();
    expect(summary.recentLogs[0]).toMatchObject({
      statusIndicator: 'FAILED',
      sdkInferenceSource: null,
      modelIdentifier: 'gemini-4-hydrogen',
      failureCategory: 'timeout',
      failurePhase: 'connecting_model'
    });
  });

  it('classifies unprompted SDK AbortError as timeout while distinguishing genuine caller AbortController cancellation as aborted', async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0',
      onLine: true
    });

    mockGenerateContent.mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));
    const sdkAbortRes = await executeHybridInference({
      taskKey: 'preliminary_summary',
      prompt: 'Check unprompted SDK abort',
      preferredMode: InferenceMode.PREFER_ON_DEVICE,
      cloudConsentGranted: true,
      timeoutMs: 20_000
    });
    expect(sdkAbortRes.failureCategory).toBe('timeout');
    expect(sdkAbortRes.failurePhase).toBe('connecting_model');
    expect(sdkAbortRes.sdkInferenceSource).toBeNull();

    const callerController = new AbortController();
    mockGenerateContent.mockImplementationOnce(
      (_prompt: string, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
          setTimeout(() => callerController.abort(), 10);
        })
    );

    const callerAbortRes = await executeHybridInference({
      taskKey: 'preliminary_summary',
      prompt: 'Check caller abort',
      preferredMode: InferenceMode.PREFER_ON_DEVICE,
      cloudConsentGranted: true,
      timeoutMs: 20_000,
      signal: callerController.signal
    });

    expect(callerAbortRes.ok).toBe(false);
    expect(callerAbortRes.statusIndicator).toBe('FAILED');
    expect(callerAbortRes.sdkInferenceSource).toBeNull();
    expect(callerAbortRes.failureCategory).toBe('aborted');
    expect(callerAbortRes.failurePhase).toBe('connecting_model');

    const summary = getAIActivitySummary();
    expect(summary.recentLogs[0]?.failureCategory).toBe('aborted');
    expect(summary.recentLogs[0]?.failurePhase).toBe('connecting_model');
    expect(summary.recentLogs[0]?.sdkInferenceSource).toBeNull();
  });

  it('synchronizes SDK singleRequestOptions.timeout with outer AbortController timer deadline after preflight App Check', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 15) Mobile Chrome/140.0.0.0',
      onLine: true
    });
    mockGetAppCheckStatus.mockReturnValue({
      initialized: true,
      provider: 'recaptcha_enterprise',
      siteKeyConfigured: true,
      siteKeySource: 'env',
      autoRefreshEnabled: true,
      debugModeEnabled: false,
      appId: '1:695233244494:web:84d52ce65db1fba47fc21f',
      hostname: 'localhost',
      lastTokenVerifiedAt: null,
      lastTokenError: null,
      reason: 'Active'
    });
    mockVerifyAppCheckToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                ok: true,
                initialized: true,
                tokenPresent: true,
                errorCode: null,
                message: 'Valid',
                hostname: 'localhost',
                appId: '1:695233244494:web:84d52ce65db1fba47fc21f',
                projectId: 'hackmind-ai',
                verifiedAt: new Date().toISOString()
              }),
            4_000
          );
        })
    );

    let capturedSdkTimeout: number | undefined;
    mockGenerateContent.mockImplementationOnce(
      (_prompt: string, opts?: { signal?: AbortSignal; timeout?: number }) => {
        capturedSdkTimeout = opts?.timeout;
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener(
            'abort',
            () => reject(opts.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        });
      }
    );

    const promise = executeHybridInference({
      taskKey: 'preliminary_summary',
      prompt: 'Sync deadline test',
      preferredMode: InferenceMode.PREFER_ON_DEVICE,
      cloudConsentGranted: true,
      timeoutMs: 10_000
    });

    await vi.advanceTimersByTimeAsync(4_000);
    // SDK timeout should be ~10_000ms (anchored when outer timer started after App Check), NOT 10_000 - 4_000 = 6_000ms
    expect(capturedSdkTimeout).toBeGreaterThanOrEqual(9_800);
    expect(capturedSdkTimeout).toBeLessThanOrEqual(10_000);

    await vi.advanceTimersByTimeAsync(10_000);
    const res = await promise;
    expect(res.ok).toBe(false);
    expect(res.failureCategory).toBe('timeout');
    expect(res.failurePhase).toBe('connecting_model');
    expect(res.sdkInferenceSource).toBeNull();
  });

  it('logs accurate failurePhase and failureCategory across preflight, verifying_app_check, and validating_output', async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0',
      onLine: true
    });

    // 1. preflight consent failure
    const preflightRes = await executeHybridInference({
      taskKey: 'preliminary_summary',
      prompt: 'Needs consent',
      preferredMode: InferenceMode.ONLY_IN_CLOUD,
      cloudConsentGranted: false
    });
    expect(preflightRes.failurePhase).toBe('preflight');
    expect(preflightRes.failureCategory).toBe('consent');
    expect(preflightRes.sdkInferenceSource).toBeNull();

    // 2. verifying_app_check failure + caller abort during App Check
    mockGetAppCheckStatus.mockReturnValue({
      initialized: true,
      provider: 'recaptcha_enterprise',
      siteKeyConfigured: true,
      siteKeySource: 'env',
      autoRefreshEnabled: true,
      debugModeEnabled: false,
      appId: '1:695233244494:web:84d52ce65db1fba47fc21f',
      hostname: 'localhost',
      lastTokenVerifiedAt: null,
      lastTokenError: null,
      reason: 'Active'
    });
    mockVerifyAppCheckToken.mockResolvedValueOnce({
      ok: false,
      initialized: true,
      tokenPresent: false,
      errorCode: 'app_not_registered',
      message: 'App not registered in reCAPTCHA Enterprise',
      hostname: 'localhost',
      appId: '1:695233244494:web:84d52ce65db1fba47fc21f',
      projectId: 'hackmind-ai',
      verifiedAt: new Date().toISOString()
    });

    const appCheckFailRes = await executeHybridInference({
      taskKey: 'preliminary_summary',
      prompt: 'Check App Check phase',
      preferredMode: InferenceMode.ONLY_IN_CLOUD,
      cloudConsentGranted: true
    });
    expect(appCheckFailRes.failurePhase).toBe('verifying_app_check');
    expect(appCheckFailRes.failureCategory).toBe('app_check');
    expect(appCheckFailRes.sdkInferenceSource).toBeNull();

    const appCheckAbortController = new AbortController();
    mockVerifyAppCheckToken.mockImplementationOnce(
      () =>
        new Promise(() => {
          setTimeout(() => appCheckAbortController.abort(), 5);
        })
    );
    const appCheckAbortRes = await executeHybridInference({
      taskKey: 'preliminary_summary',
      prompt: 'Abort during App Check',
      preferredMode: InferenceMode.ONLY_IN_CLOUD,
      cloudConsentGranted: true,
      signal: appCheckAbortController.signal
    });
    expect(appCheckAbortRes.failurePhase).toBe('verifying_app_check');
    expect(appCheckAbortRes.failureCategory).toBe('aborted');
    expect(appCheckAbortRes.sdkInferenceSource).toBeNull();

    // 3. validating_output parse failure
    resetConfigMocksToActual();
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => 'not valid json output',
        inferenceSource: InferenceSource.IN_CLOUD
      }
    });
    const parseRes = await executeHybridInference({
      taskKey: 'preliminary_summary',
      prompt: 'Return invalid JSON',
      preferredMode: InferenceMode.ONLY_IN_CLOUD,
      cloudConsentGranted: true
    });
    expect(parseRes.ok).toBe(false);
    expect(parseRes.failurePhase).toBe('validating_output');
    expect(parseRes.failureCategory).toBe('parse');

    const logs = getAIActivitySummary().recentLogs;
    expect(logs[0]).toMatchObject({ failurePhase: 'validating_output', failureCategory: 'parse' });
    expect(logs[1]).toMatchObject({
      failurePhase: 'verifying_app_check',
      failureCategory: 'aborted',
      sdkInferenceSource: null
    });
    expect(logs[2]).toMatchObject({
      failurePhase: 'verifying_app_check',
      failureCategory: 'app_check',
      sdkInferenceSource: null
    });
    expect(logs[3]).toMatchObject({
      failurePhase: 'preflight',
      failureCategory: 'consent',
      sdkInferenceSource: null
    });
  });

  it('prevents Hydrogen diagnostic requests (useHeavyCloudModel: true, maxTransientRetries: 0, disableModelFallback: true) from retrying or falling back to gemini-3.5-flash-lite', async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 15) Mobile Chrome/140.0.0.0',
      onLine: true
    });

    // 1. Model-not-found / unsupported error must NOT fall back to gemini-3.5-flash-lite
    mockGenerateContent.mockRejectedValueOnce(new Error('404 NOT_FOUND: model gemini-4-hydrogen unavailable'));
    const notFoundRes = await executeHybridInference({
      taskKey: 'preliminary_summary',
      prompt: 'Single Hydrogen diagnostic check',
      preferredMode: InferenceMode.ONLY_IN_CLOUD,
      useHeavyCloudModel: true,
      maxTransientRetries: 0,
      disableModelFallback: true,
      cloudConsentGranted: true
    });

    expect(notFoundRes.ok).toBe(false);
    expect(notFoundRes.modelIdentifier).toBe('gemini-4-hydrogen');
    expect(notFoundRes.fallbackOccurred).toBe(false);
    expect(notFoundRes.failureCategory).toBe('model_unsupported');
    expect(notFoundRes.failurePhase).toBe('connecting_model');
    expect(notFoundRes.sdkInferenceSource).toBeNull();
    expect(vi.mocked(getGenerativeModel)).toHaveBeenCalledTimes(1);
    const passedModel = (
      vi.mocked(getGenerativeModel).mock.calls[0]?.[1] as {
        mode?: InferenceMode;
        inCloudParams?: { model?: string };
      }
    );
    expect(passedModel.mode).toBe(InferenceMode.ONLY_IN_CLOUD);
    expect(passedModel.inCloudParams?.model).toBe('gemini-4-hydrogen');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    // 2. Transient 503 error must NOT retry when maxTransientRetries: 0
    vi.clearAllMocks();
    mockGenerateContent.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const transientRes = await executeHybridInference({
      taskKey: 'preliminary_summary',
      prompt: 'Single Hydrogen transient check',
      preferredMode: InferenceMode.ONLY_IN_CLOUD,
      useHeavyCloudModel: true,
      maxTransientRetries: 0,
      disableModelFallback: true,
      cloudConsentGranted: true
    });

    expect(transientRes.ok).toBe(false);
    expect(transientRes.modelIdentifier).toBe('gemini-4-hydrogen');
    expect(transientRes.fallbackOccurred).toBe(false);
    expect(transientRes.retryAttempts).toBeUndefined();
    expect(transientRes.failureCategory).toBe('transient_overload');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getGenerativeModel)).toHaveBeenCalledTimes(1);
  });
});
