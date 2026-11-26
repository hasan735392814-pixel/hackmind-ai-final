// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InferenceMode, InferenceSource } from 'firebase/ai';
import { LanguageProvider } from '../../src/contexts/LanguageContext';
import { HybridAIStatusPanel } from '../../src/components/common/HybridAIStatusPanel';
import { OnDeviceQuickHelpersPanel } from '../../src/components/judgingV2/OnDeviceQuickHelpersPanel';

const mockExecuteHybridInference = vi.fn();

vi.mock('../../src/services/hybridAI/inferenceManager', () => ({
  executeHybridInference: (...args: unknown[]) => mockExecuteHybridInference(...args)
}));

describe('HybridAIStatusPanel & OnDeviceQuickHelpersPanel (0 Auto Calls, Strict Mock)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  afterEach(() => {
    cleanup();
  });

  it('renders all hybrid status fields with ZERO automatic AI calls on mount and executes 1 test request on click', async () => {
    const onUpdateConsent = vi.fn().mockResolvedValue(undefined);
    mockExecuteHybridInference.mockResolvedValueOnce({
      ok: true,
      data: {
        headline: 'Verified Local Summary',
        summary: 'Ran cleanly via mocked ON_DEVICE response.',
        highlights: ['Zero auto quota spend'],
        caveats: []
      },
      rawText: '{"headline":"Verified Local Summary"}',
      statusIndicator: 'ON-DEVICE',
      sdkInferenceSource: InferenceSource.ON_DEVICE,
      requestedMode: InferenceMode.PREFER_ON_DEVICE,
      modelIdentifier: 'On-device AI — model identity not independently verified.',
      executedAt: '2026-11-25T12:00:00.000Z',
      durationMs: 42,
      fallbackOccurred: false
    });

    render(
      <LanguageProvider>
        <HybridAIStatusPanel
          capability={{
            isDesktopEnvironment: true,
            isChromePromptApiSupported: true,
            localAvailability: 'available',
            localReasonCode: 'ready',
            localModelIdentityLabel: 'On-device AI — model identity not independently verified.',
            cloudOnline: true,
            appCheckActive: true,
            checkedAt: '2026-11-25T12:00:00.000Z',
            details: 'Ready'
          }}
          summary={{
            totalLocalExecutions: 1,
            totalCloudExecutions: 0,
            totalFallbacks: 0,
            failedRequests: 0,
            averageResponseMs: 42,
            lastInferenceStatus: 'ON-DEVICE',
            lastExecutedAt: '2026-11-25T12:00:00.000Z',
            recentLogs: [
              {
                id: 'log_1',
                taskKey: 'preliminary_summary',
                statusIndicator: 'ON-DEVICE',
                sdkInferenceSource: InferenceSource.ON_DEVICE,
                requestedMode: InferenceMode.PREFER_ON_DEVICE,
                modelIdentifier: 'On-device AI — model identity not independently verified.',
                durationMs: 42,
                fallbackOccurred: false,
                executedAt: '2026-11-25T12:00:00.000Z'
              }
            ]
          }}
          appCheck={{
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
            reason: 'Firebase App Check active (reCAPTCHA Enterprise with auto-refresh)'
          }}
          fbConfig={{
            projectId: 'hackmind-ai',
            authDomain: 'hackmind-ai.firebaseapp.com',
            firestoreDatabaseId: '(default)',
            appId: '1:695233244494:web:84d52ce65db1fba47fc21f',
            appletConfigAppId: '1:695233244494:web:84d52ce65db1fba47fc21f',
            appIdMismatch: false,
            configured: true,
            missingKeys: [],
            initialized: true,
            source: 'env'
          }}
          cloudConsent={true}
          canUpdateConsent={true}
          onUpdateConsent={onUpdateConsent}
        />
      </LanguageProvider>
    );

    expect(mockExecuteHybridInference).not.toHaveBeenCalled();
    expect(screen.getByText('Enabled (Firebase AI Logic)')).toBeTruthy();
    expect(screen.getByText(/recaptcha_enterprise/i)).toBeTruthy();
    expect(screen.getByText('Ready (Online & Consent Granted)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Run Single Hybrid Test/i }));

    await waitFor(() => expect(mockExecuteHybridInference).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Verified Local Summary/)).toBeTruthy());
  });

  it('triggers zero automatic AI calls in OnDeviceQuickHelpersPanel and classifies into the 4 official criteria on explicit click', async () => {
    mockExecuteHybridInference.mockResolvedValueOnce({
      ok: true,
      data: {
        classifications: [
          {
            criterionId: 'technical_implementation',
            relevance: 'high',
            rationale: 'Verified backend handler in server.ts'
          }
        ],
        primaryCriterion: 'technical_implementation'
      },
      rawText: '{}',
      statusIndicator: 'FALLBACK TO CLOUD',
      sdkInferenceSource: InferenceSource.IN_CLOUD,
      requestedMode: InferenceMode.PREFER_ON_DEVICE,
      modelIdentifier: 'gemini-3.5-flash-lite',
      executedAt: '2026-11-25T12:05:00.000Z',
      durationMs: 210,
      fallbackOccurred: true,
      fallbackReason: 'Chrome Prompt API not exposed in current browser; fell back to Cloud Gemini.'
    });

    render(
      <LanguageProvider>
        <OnDeviceQuickHelpersPanel
          locale="en"
          bundle={null}
          projectTitle="CulturePulse AI"
          projectDescription="Verified Express + Vite submission."
          cloudConsent={true}
          onGrantCloudConsent={vi.fn().mockResolvedValue(undefined)}
        />
      </LanguageProvider>
    );

    expect(mockExecuteHybridInference).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Classify into 4 Official Criteria/i }));
    fireEvent.click(screen.getByRole('button', { name: /Run Selected Helper \(1 Request\)/i }));

    await waitFor(() => expect(mockExecuteHybridInference).toHaveBeenCalledTimes(1));
    const callArg = mockExecuteHybridInference.mock.calls[0]?.[0] as {
      taskKey?: string;
      preferredMode?: InferenceMode;
    };
    expect(callArg.taskKey).toBe('evidence_criteria_classify');
    expect(callArg.preferredMode).toBe(InferenceMode.PREFER_ON_DEVICE);

    await waitFor(() => expect(screen.getByText(/Technical Implementation \(30%\)/i)).toBeTruthy());
    expect(screen.getByText(/FALLBACK TO CLOUD/i)).toBeTruthy();
  });

  it('displays truthful sdk=unset alongside failurePhase and failureCategory when the latest inference log failed', () => {
    render(
      <LanguageProvider>
        <HybridAIStatusPanel
          capability={{
            isDesktopEnvironment: false,
            isChromePromptApiSupported: false,
            localAvailability: 'mobile_unsupported',
            localReasonCode: 'mobile_unsupported',
            localModelIdentityLabel: 'Android Chrome mobile browser',
            cloudOnline: true,
            appCheckActive: true,
            checkedAt: '2026-11-25T12:00:00.000Z',
            details: 'Mobile browser uses Cloud Gemini.'
          }}
          summary={{
            totalLocalExecutions: 0,
            totalCloudExecutions: 0,
            totalFallbacks: 0,
            failedRequests: 1,
            averageResponseMs: 45120,
            lastInferenceStatus: 'FAILED',
            lastExecutedAt: '2026-11-25T12:10:00.000Z',
            recentLogs: [
              {
                id: 'log_fail_1',
                taskKey: 'preliminary_summary',
                statusIndicator: 'FAILED',
                sdkInferenceSource: null,
                requestedMode: InferenceMode.PREFER_ON_DEVICE,
                modelIdentifier: 'gemini-3.5-flash-lite',
                durationMs: 45120,
                fallbackOccurred: false,
                failureCategory: 'timeout',
                failurePhase: 'connecting_model',
                errorMessage: 'Gemini inference timed out after 45s and the request was cancelled cleanly.',
                executedAt: '2026-11-25T12:10:00.000Z'
              }
            ]
          }}
          appCheck={{
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
            reason: 'Firebase App Check active (reCAPTCHA Enterprise with auto-refresh)'
          }}
          fbConfig={{
            projectId: 'hackmind-ai',
            authDomain: 'hackmind-ai.firebaseapp.com',
            firestoreDatabaseId: '(default)',
            appId: '1:695233244494:web:84d52ce65db1fba47fc21f',
            appletConfigAppId: '1:695233244494:web:84d52ce65db1fba47fc21f',
            appIdMismatch: false,
            configured: true,
            missingKeys: [],
            initialized: true,
            source: 'env'
          }}
          cloudConsent={true}
          canUpdateConsent={true}
          onUpdateConsent={vi.fn().mockResolvedValue(undefined)}
        />
      </LanguageProvider>
    );

    expect(screen.getByText(/sdk=unset · model=gemini-3\.5-flash-lite/i)).toBeTruthy();
    expect(screen.getByText('phase=connecting_model · category=timeout')).toBeTruthy();
    expect(screen.getByText('phase=connecting_model · category=timeout · sdk=unset')).toBeTruthy();
  });

  it('defaults to Standard gemini-3.5-flash-lite, displays the selected model before execution, and sends strict single-request Hydrogen flags when Heavy is chosen', async () => {
    mockExecuteHybridInference.mockResolvedValueOnce({
      ok: true,
      data: {
        headline: 'Hydrogen Check',
        summary: 'Completed single cloud request.',
        highlights: ['No fallback'],
        caveats: []
      },
      rawText: '{"headline":"Hydrogen Check"}',
      statusIndicator: 'CLOUD',
      sdkInferenceSource: InferenceSource.IN_CLOUD,
      requestedMode: InferenceMode.ONLY_IN_CLOUD,
      modelIdentifier: 'gemini-4-hydrogen',
      executedAt: '2026-11-25T13:00:00.000Z',
      durationMs: 320,
      fallbackOccurred: false
    });

    render(
      <LanguageProvider>
        <HybridAIStatusPanel
          capability={{
            isDesktopEnvironment: false,
            isChromePromptApiSupported: false,
            localAvailability: 'mobile_unsupported',
            localReasonCode: 'mobile_unsupported',
            localModelIdentityLabel: 'Android Chrome mobile browser',
            cloudOnline: true,
            appCheckActive: true,
            checkedAt: '2026-11-25T13:00:00.000Z',
            details: 'Mobile browser uses Cloud Gemini.'
          }}
          summary={{
            totalLocalExecutions: 0,
            totalCloudExecutions: 0,
            totalFallbacks: 0,
            failedRequests: 0,
            averageResponseMs: 0,
            lastInferenceStatus: 'NONE',
            lastExecutedAt: null,
            recentLogs: []
          }}
          appCheck={{
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
            reason: 'Firebase App Check active (reCAPTCHA Enterprise with auto-refresh)'
          }}
          fbConfig={{
            projectId: 'hackmind-ai',
            authDomain: 'hackmind-ai.firebaseapp.com',
            firestoreDatabaseId: '(default)',
            appId: '1:695233244494:web:84d52ce65db1fba47fc21f',
            appletConfigAppId: '1:695233244494:web:84d52ce65db1fba47fc21f',
            appIdMismatch: false,
            configured: true,
            missingKeys: [],
            initialized: true,
            source: 'env'
          }}
          cloudConsent={true}
          canUpdateConsent={true}
          onUpdateConsent={vi.fn().mockResolvedValue(undefined)}
        />
      </LanguageProvider>
    );

    expect(mockExecuteHybridInference).not.toHaveBeenCalled();

    const modelSelect = screen.getByLabelText(/Test Model/i) as HTMLSelectElement;
    expect(modelSelect.value).toBe('standard');
    expect(screen.getByText('gemini-3.5-flash-lite')).toBeTruthy();

    fireEvent.change(modelSelect, { target: { value: 'heavy' } });
    expect(modelSelect.value).toBe('heavy');
    expect(screen.getByText('gemini-4-hydrogen')).toBeTruthy();
    expect(screen.getByText(/mode=ONLY_IN_CLOUD · retries=0 · fallback=disabled/i)).toBeTruthy();
    expect(mockExecuteHybridInference).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Run Single Hybrid Test/i }));

    await waitFor(() => expect(mockExecuteHybridInference).toHaveBeenCalledTimes(1));
    const reqArg = mockExecuteHybridInference.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(reqArg).toMatchObject({
      taskKey: 'preliminary_summary',
      preferredMode: InferenceMode.ONLY_IN_CLOUD,
      useHeavyCloudModel: true,
      maxTransientRetries: 0,
      disableModelFallback: true,
      cloudConsentGranted: true
    });
  });
});
