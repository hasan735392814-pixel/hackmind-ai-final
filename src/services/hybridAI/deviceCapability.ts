import { getAppCheckStatus } from '../firebase/config';
import type {
  DeviceCapabilityReport,
  LocalAvailabilityReasonCode,
  LocalAvailabilityState
} from './types';

interface ChromeLanguageModelGlobal {
  availability?: (options?: Record<string, unknown>) => Promise<string>;
  create?: (options?: Record<string, unknown>) => Promise<{
    prompt?: (input: string) => Promise<string>;
    destroy?: () => void;
  }>;
  params?: () => Promise<Record<string, unknown>>;
}

function detectDesktopEnvironment(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData && typeof uaData.mobile === 'boolean') {
    return !uaData.mobile;
  }
  return !/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

function getGlobalLanguageModel(): ChromeLanguageModelGlobal | null {
  if (typeof globalThis === 'undefined') return null;
  const g = globalThis as unknown as {
    LanguageModel?: ChromeLanguageModelGlobal;
  };
  return g.LanguageModel ?? null;
}

export function isInsufficientResourcesMessage(rawMessage: string): boolean {
  const lower = rawMessage.toLowerCase();
  return (
    lower.includes('insufficient') ||
    lower.includes('not enough') ||
    lower.includes('memory') ||
    lower.includes('vram') ||
    lower.includes('storage') ||
    lower.includes('disk space') ||
    lower.includes('quotaexceedederror') ||
    lower.includes('hardware') ||
    lower.includes('gpu') ||
    lower.includes('device capabilities')
  );
}

export function isLocalModelNotInitializedMessage(rawMessage: string): boolean {
  const lower = rawMessage.toLowerCase();
  return (
    lower.includes('not initialized') ||
    lower.includes('uninitialized') ||
    lower.includes('not yet initialized') ||
    lower.includes('not ready') ||
    lower.includes('after-download') ||
    lower.includes('download required')
  );
}

export async function detectDeviceCapability(
  locale: 'en' | 'ar' = 'en'
): Promise<DeviceCapabilityReport> {
  const isDesktop = detectDesktopEnvironment();
  const cloudOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  const appCheckActive = getAppCheckStatus().initialized;
  const checkedAt = new Date().toISOString();

  if (!isDesktop) {
    return {
      isDesktopEnvironment: false,
      isChromePromptApiSupported: false,
      localAvailability: 'mobile_unsupported',
      localReasonCode: 'mobile_unsupported',
      localModelIdentityLabel: 'Not supported on mobile web browsers — Cloud AI active',
      cloudOnline,
      appCheckActive,
      checkedAt,
      details:
        'Web on-device inference via Firebase AI Logic requires a compatible desktop Chrome environment. Android Chrome and other mobile web browsers use Firebase AI Logic cloud inference.'
    };
  }

  const languageModel = getGlobalLanguageModel();
  if (!languageModel || typeof languageModel.availability !== 'function') {
    return {
      isDesktopEnvironment: true,
      isChromePromptApiSupported: false,
      localAvailability: 'unsupported_browser',
      localReasonCode: 'unsupported_browser',
      localModelIdentityLabel: 'Chrome Prompt API unavailable in this browser',
      cloudOnline,
      appCheckActive,
      checkedAt,
      details:
        'window.LanguageModel is not exposed. Requires desktop Chrome 139+ with Prompt API & built-in on-device model enabled.'
    };
  }

  try {
    const createOptions = {
      expectedInputs: [{ type: 'text', languages: [locale === 'ar' ? 'ar' : 'en'] }],
      expectedOutputs: [{ type: 'text', languages: [locale === 'ar' ? 'ar' : 'en'] }]
    };

    let rawAvailability = await languageModel.availability(createOptions);
    if (rawAvailability === 'unavailable' && locale === 'ar') {
      rawAvailability = await languageModel.availability({
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }]
      });
    }

    let localAvailability: LocalAvailabilityState = 'unavailable';
    let localReasonCode: LocalAvailabilityReasonCode = 'unavailable';

    if (rawAvailability === 'available' || rawAvailability === 'readily') {
      localAvailability = 'available';
      localReasonCode = 'ready';
    } else if (rawAvailability === 'downloadable' || rawAvailability === 'after-download') {
      localAvailability = 'downloadable';
      localReasonCode = 'downloadable';
    } else if (rawAvailability === 'downloading') {
      localAvailability = 'downloading';
      localReasonCode = 'downloading';
    } else if (
      typeof rawAvailability === 'string' &&
      isInsufficientResourcesMessage(rawAvailability)
    ) {
      localAvailability = 'unavailable';
      localReasonCode = 'insufficient_resources';
    } else if (
      typeof rawAvailability === 'string' &&
      isLocalModelNotInitializedMessage(rawAvailability)
    ) {
      localAvailability = 'unavailable';
      localReasonCode = 'not_initialized';
    }

    const identityLabel =
      localAvailability === 'available' ||
      localAvailability === 'downloadable' ||
      localAvailability === 'downloading'
        ? 'On-device AI — model identity not independently verified.'
        : 'Local model unavailable on this device';

    return {
      isDesktopEnvironment: true,
      isChromePromptApiSupported: true,
      localAvailability,
      localReasonCode,
      localModelIdentityLabel: identityLabel,
      cloudOnline,
      appCheckActive,
      checkedAt,
      details:
        localAvailability === 'available'
          ? 'Browser Prompt API reports local model ready for single-turn on-device tasks.'
          : localAvailability === 'downloading'
            ? 'Compatible desktop browser detected; on-device model download is currently in progress.'
            : localAvailability === 'downloadable'
              ? 'Compatible desktop browser detected; on-device model is not initialized/downloaded yet and can be downloaded via user gesture.'
              : localReasonCode === 'insufficient_resources'
                ? 'On-device model reported unavailable due to insufficient device RAM/VRAM or disk resources.'
                : 'Compatible Prompt API detected, but local model is reported unavailable or not yet initialized on this hardware/profile.'
    };
  } catch (err) {
    const rawErr = err instanceof Error ? err.message : String(err || '');
    const insufficient = isInsufficientResourcesMessage(rawErr);
    const notInitialized = isLocalModelNotInitializedMessage(rawErr);

    return {
      isDesktopEnvironment: true,
      isChromePromptApiSupported: true,
      localAvailability: 'unavailable',
      localReasonCode: insufficient
        ? 'insufficient_resources'
        : notInitialized
          ? 'not_initialized'
          : 'unavailable',
      localModelIdentityLabel: insufficient
        ? 'Insufficient device resources for local model'
        : 'Local model check failed',
      cloudOnline,
      appCheckActive,
      checkedAt,
      details: rawErr || 'Failed to inspect local model availability.'
    };
  }
}

export async function triggerLocalModelRetry(locale: 'en' | 'ar' = 'en'): Promise<DeviceCapabilityReport> {
  const languageModel = getGlobalLanguageModel();
  let createErrorMessage = '';
  if (languageModel && typeof languageModel.create === 'function') {
    try {
      const session = await languageModel.create({
        expectedInputs: [{ type: 'text', languages: [locale === 'ar' ? 'ar' : 'en'] }],
        expectedOutputs: [{ type: 'text', languages: [locale === 'ar' ? 'ar' : 'en'] }]
      });
      session.destroy?.();
    } catch (err) {
      createErrorMessage = err instanceof Error ? err.message : String(err || '');
    }
  }
  const report = await detectDeviceCapability(locale);
  if (createErrorMessage && report.localAvailability !== 'available') {
    const insufficient = isInsufficientResourcesMessage(createErrorMessage);
    return {
      ...report,
      localReasonCode: insufficient ? 'insufficient_resources' : report.localReasonCode ?? 'not_initialized',
      details: `${report.details} (${createErrorMessage})`
    };
  }
  return report;
}
