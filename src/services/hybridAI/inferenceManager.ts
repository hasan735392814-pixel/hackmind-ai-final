import {
  getGenerativeModel,
  InferenceMode,
  InferenceSource,
  type GenerateContentResult,
  type GenerationConfig
} from 'firebase/ai';
import { getAppCheckStatus, verifyAppCheckToken } from '../firebase/config';
import { getConfiguredCloudModels, getFirebaseAIInstance } from './firebaseAI';
import {
  detectDeviceCapability,
  isInsufficientResourcesMessage
} from './deviceCapability';
import { logAIExecution } from './inferenceLogger';
import { exceedsLocalContextBudget, PROMPT_REGISTRY } from './promptRegistry';
import type {
  AIExecutionStage,
  AIFailureCategory,
  HybridExecutionRequest,
  HybridExecutionResult,
  TruthfulInferenceStatus
} from './types';

function extractJsonFromText<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.unshift(fenced[1].trim());
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as T;
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}

function runWithAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException('AI request was cancelled.', 'AbortError')
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('AI request was cancelled.', 'AbortError')
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise
      .then((res) => {
        signal.removeEventListener('abort', onAbort);
        resolve(res);
      })
      .catch((err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });
  });
}

function isPermanentQuotaOrAccessError(rawMsg: string): boolean {
  const lower = rawMsg.toLowerCase();
  return (
    lower.includes('app check') ||
    lower.includes('appcheck') ||
    lower.includes('attestation') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('404') ||
    lower.includes('not_found') ||
    lower.includes('is not found') ||
    lower.includes('api_not_enabled') ||
    lower.includes('api-not-enabled') ||
    lower.includes('permission_denied') ||
    lower.includes('unauthenticated') ||
    lower.includes('billing') ||
    lower.includes('quota_exceeded_permanently') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('daily limit') ||
    lower.includes('daily quota') ||
    lower.includes('plan limit') ||
    lower.includes('insufficient_quota')
  );
}

function isTransientRateLimitError(rawMsg: string): boolean {
  if (isPermanentQuotaOrAccessError(rawMsg)) return false;
  const lower = rawMsg.toLowerCase();
  return (
    /\b429\b/.test(lower) ||
    lower.includes('too many requests') ||
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('ratelimit') ||
    lower.includes('resource_exhausted') ||
    lower.includes('try again in')
  );
}

function isTransientServerError(rawMsg: string): boolean {
  if (isPermanentQuotaOrAccessError(rawMsg)) {
    return false;
  }
  const lower = rawMsg.toLowerCase();
  return (
    /\b50[0234]\b/.test(lower) ||
    lower.includes('high demand') ||
    lower.includes('experiencing high demand') ||
    lower.includes('overloaded') ||
    lower.includes('service unavailable') ||
    lower.includes('temporarily unavailable') ||
    lower.includes('internal server error') ||
    lower.includes('internal error') ||
    lower.includes('status: unavailable') ||
    isTransientRateLimitError(rawMsg)
  );
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return signal.aborted
      ? Promise.reject(new DOMException('AI request was cancelled.', 'AbortError'))
      : Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('AI request was cancelled.', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('AI request was cancelled.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isModelNotSupportedError(rawMsg: string): boolean {
  const lower = rawMsg.toLowerCase();
  if (
    lower.includes('app check') ||
    lower.includes('appcheck') ||
    lower.includes('401') ||
    lower.includes('unauthenticated') ||
    lower.includes('api_not_enabled') ||
    lower.includes('api-not-enabled') ||
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    isTransientServerError(rawMsg)
  ) {
    return false;
  }
  return (
    lower.includes('not_found') ||
    lower.includes('404') ||
    lower.includes('is not found') ||
    lower.includes('not supported for generatecontent') ||
    lower.includes('unsupported model') ||
    lower.includes('thinkinglevel') ||
    lower.includes('thinking_level') ||
    lower.includes('thinkingconfig')
  );
}

function isTimeoutError(rawMsg: string, errorName?: string): boolean {
  const lower = rawMsg.toLowerCase();
  return (
    lower.includes('timeout has expired') ||
    lower.includes('timed out') ||
    lower.includes('request timeout') ||
    lower.includes('deadline exceeded') ||
    errorName === 'AbortError' ||
    errorName === 'TimeoutError'
  );
}

function classifyErrorCategory(
  rawMsg: string,
  flags: {
    timedOut: boolean;
    callerAborted: boolean;
    localModeAttempted?: boolean;
    errorName?: string;
  }
): AIFailureCategory {
  if (flags.callerAborted) return 'aborted';
  if (flags.timedOut) return 'timeout';
  if (isTimeoutError(rawMsg, flags.errorName)) {
    return 'timeout';
  }

  if (flags.localModeAttempted && isInsufficientResourcesMessage(rawMsg)) {
    return 'local_resources';
  }

  const lower = rawMsg.toLowerCase();
  if (
    lower.includes('app check') ||
    lower.includes('appcheck') ||
    lower.includes('attestation') ||
    lower.includes('401') ||
    lower.includes('unauthenticated')
  ) {
    return 'app_check';
  }
  if (
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota')
  ) {
    return 'quota';
  }
  if (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('network request failed') ||
    lower.includes('offline') ||
    lower.includes('err_internet_disconnected')
  ) {
    return 'network';
  }
  if (isTransientServerError(rawMsg)) {
    return 'transient_overload';
  }
  if (isModelNotSupportedError(rawMsg)) {
    return 'model_unsupported';
  }
  return 'unknown';
}

function formatActionableErrorMessage(
  rawMsg: string,
  category: AIFailureCategory,
  locale: 'en' | 'ar',
  timeoutMs: number
): string {
  const host =
    typeof window !== 'undefined' && window.location?.hostname
      ? window.location.hostname
      : '';
  const appCheckStatus = getAppCheckStatus();

  if (category === 'local_resources') {
    return locale === 'ar'
      ? `تعذر تشغيل النموذج المحلي بسبب محدودية موارد الجهاز (الذاكرة/القرص) أو عدم تهيئة النموذج (${rawMsg}).`
      : `On-device model could not execute due to insufficient device resources or uninitialized local model (${rawMsg}).`;
  }
  if (category === 'app_check') {
    return locale === 'ar'
      ? `فشل التحقق من Firebase App Check قبل أو أثناء استدعاء Gemini (${rawMsg}). تأكد من أن النطاق "${host || 'current host'}" مسموح في reCAPTCHA Enterprise وأن App ID (${appCheckStatus.appId || 'unset'}) مطابق لتطبيق الويب المسجل.`
      : `Firebase App Check verification failed (${rawMsg}). Verify that "${host || 'current host'}" is allowlisted in reCAPTCHA Enterprise and that App ID (${appCheckStatus.appId || 'unset'}) matches the registered Web App.`;
  }
  if (category === 'timeout') {
    const secs = Math.round(timeoutMs / 1000);
    return locale === 'ar'
      ? `انتهت مهلة استجابة نموذج Gemini بعد ${secs} ثانية وتم إلغاء الطلب بأمان لمنع تعليقه.`
      : `Gemini inference timed out after ${secs}s and the request was cancelled cleanly.`;
  }
  if (category === 'aborted') {
    return locale === 'ar'
      ? 'تم إلغاء طلب التحليل بالذكاء الاصطناعي.'
      : 'AI analysis request was cancelled.';
  }
  if (category === 'network') {
    return locale === 'ar'
      ? `تعذر الاتصال بخدمة Firebase AI Logic بسبب خطأ شبكة (${rawMsg}).`
      : `Network failure while contacting Firebase AI Logic (${rawMsg}).`;
  }
  if (category === 'transient_overload') {
    return locale === 'ar'
      ? `خدمة نموذج Gemini تشهد ضغطاً مرتفعاً مؤقتاً (${rawMsg}). تم الحفاظ على التقدم المكتمل ويمكنك الاستئناف أو إعادة المحاولة دون تكرار الدفعات الناجحة.`
      : `Gemini model service is temporarily overloaded (${rawMsg}). Completed work is preserved — click Resume/Retry to continue without repeating completed batches.`;
  }
  if (category === 'quota') {
    return locale === 'ar'
      ? `تم تجاوز حد الحصة أو معدل الطلبات لخدمة Gemini مؤقتاً (${rawMsg}).`
      : `Gemini API quota or rate limit exceeded (${rawMsg}).`;
  }
  if (category === 'model_unsupported') {
    return locale === 'ar'
      ? `النموذج المهيأ غير مدعوم حالياً في هذا المشروع (${rawMsg}).`
      : `Configured Gemini model is not supported in this Firebase AI Logic environment (${rawMsg}).`;
  }
  return rawMsg;
}

const OFFLINE_DRAFT_PREFIX = 'hackmind_offline_ai_draft_';

export function saveOfflineDraftWork(key: string, payload: unknown): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      `${OFFLINE_DRAFT_PREFIX}${key}`,
      JSON.stringify({ savedAt: new Date().toISOString(), payload })
    );
  } catch {
    // Ignore storage quota errors
  }
}

export function loadOfflineDraftWork<T>(key: string): { savedAt: string; payload: T } | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(`${OFFLINE_DRAFT_PREFIX}${key}`);
    return raw ? (JSON.parse(raw) as { savedAt: string; payload: T }) : null;
  } catch {
    return null;
  }
}

export async function executeHybridInference<T = string>(
  request: HybridExecutionRequest
): Promise<HybridExecutionResult<T>> {
  const startedAt = performance.now();
  const executedAt = new Date().toISOString();
  const spec = PROMPT_REGISTRY[request.taskKey];
  const locale = request.locale ?? 'en';
  const requestedMode: InferenceMode =
    request.preferredMode ??
    (spec.recommendedMode === 'prefer_on_device'
      ? InferenceMode.PREFER_ON_DEVICE
      : InferenceMode.PREFER_IN_CLOUD);

  const expectJson = request.expectJson ?? spec.expectJson;
  const useHeavy = request.useHeavyCloudModel ?? spec.useHeavyCloudModel;
  const models = getConfiguredCloudModels();
  const primaryCloudModelName = useHeavy ? models.heavy : models.standard;
  const systemInstruction = request.systemInstruction ?? spec.systemInstruction;
  const timeoutMs =
    request.timeoutMs ?? (request.taskKey === 'judge_evidence' ? 120_000 : 45_000);

  let currentPhase: AIExecutionStage = 'preflight';
  request.onProgress?.(currentPhase);

  const capability = await detectDeviceCapability(locale);
  const localReady = capability.localAvailability === 'available';
  const contextTooLargeForLocal = exceedsLocalContextBudget(request.prompt);

  // Enforce explicit user consent before sending data to cloud when cloud routing may occur.
  // Crucially: if PREFER_ON_DEVICE is chosen without cloud consent while local is ready,
  // constrain the SDK call to ONLY_ON_DEVICE so a runtime local error can never silently leak to Cloud.
  const requiresCloudNow =
    requestedMode === InferenceMode.ONLY_IN_CLOUD ||
    requestedMode === InferenceMode.PREFER_IN_CLOUD ||
    (requestedMode === InferenceMode.PREFER_ON_DEVICE && (!localReady || contextTooLargeForLocal));

  if (requiresCloudNow && request.cloudConsentGranted !== true) {
    const durationMs = performance.now() - startedAt;
    const msg =
      requestedMode === InferenceMode.PREFER_ON_DEVICE && contextTooLargeForLocal
        ? locale === 'ar'
          ? 'حجم النص يتجاوز سعة المعالجة المحلية، ويلزم موافقتك الصريحة قبل إرسال البيانات إلى الذكاء السحابي.'
          : 'Input exceeds on-device context capacity and requires explicit Cloud AI consent before sending to Cloud inference.'
        : locale === 'ar'
          ? 'يلزم موافقتك الصريحة قبل إرسال بيانات المشروع إلى الذكاء الاصطناعي السحابي.'
          : 'Cloud AI processing consent is required before sending data to cloud inference.';
    await logAIExecution({
      userId: request.userId,
      emailVerified: request.emailVerified,
      taskKey: request.taskKey,
      statusIndicator: 'FAILED',
      sdkInferenceSource: null,
      requestedMode,
      modelIdentifier: 'consent_blocked',
      durationMs,
      fallbackOccurred: false,
      failureCategory: 'consent',
      failurePhase: currentPhase,
      errorMessage: msg
    });
    return {
      ok: false,
      data: null,
      rawText: '',
      statusIndicator: 'FAILED',
      sdkInferenceSource: null,
      requestedMode,
      modelIdentifier: 'consent_blocked',
      executedAt,
      durationMs,
      fallbackOccurred: false,
      failureCategory: 'consent',
      failurePhase: currentPhase,
      errorMessage: msg
    };
  }

  // Strictly refuse silent cloud fallback in ONLY_ON_DEVICE mode
  if (requestedMode === InferenceMode.ONLY_ON_DEVICE && !localReady) {
    const durationMs = performance.now() - startedAt;
    const reason = capability.details;
    const localFailureCategory: AIFailureCategory =
      capability.localReasonCode === 'insufficient_resources'
        ? 'local_resources'
        : 'model_unsupported';
    await logAIExecution({
      userId: request.userId,
      emailVerified: request.emailVerified,
      taskKey: request.taskKey,
      statusIndicator: 'LOCAL MODEL UNAVAILABLE',
      sdkInferenceSource: null,
      requestedMode,
      modelIdentifier: capability.localModelIdentityLabel,
      durationMs,
      fallbackOccurred: false,
      failureCategory: localFailureCategory,
      failurePhase: currentPhase,
      errorMessage: reason
    });
    return {
      ok: false,
      data: null,
      rawText: '',
      statusIndicator: 'LOCAL MODEL UNAVAILABLE',
      sdkInferenceSource: null,
      requestedMode,
      effectiveSdkMode: InferenceMode.ONLY_ON_DEVICE,
      modelIdentifier: capability.localModelIdentityLabel,
      executedAt,
      durationMs,
      fallbackOccurred: false,
      failureCategory: localFailureCategory,
      failurePhase: currentPhase,
      errorMessage: reason
    };
  }

  let effectiveSdkMode: InferenceMode = requestedMode;
  let preflightCloudRouteReason: string | undefined;

  if (requestedMode === InferenceMode.PREFER_ON_DEVICE) {
    if (request.cloudConsentGranted !== true) {
      effectiveSdkMode = InferenceMode.ONLY_ON_DEVICE;
    } else if (contextTooLargeForLocal) {
      effectiveSdkMode = InferenceMode.ONLY_IN_CLOUD;
      preflightCloudRouteReason =
        locale === 'ar'
          ? 'تجاوز النص سعة النموذج المحلي؛ تم التحويل إلى Gemini السحابي.'
          : 'Input exceeded on-device context capacity; fell back cleanly to Cloud Gemini.';
    }
  }

  const cloudMayBeUsed =
    effectiveSdkMode === InferenceMode.ONLY_IN_CLOUD ||
    effectiveSdkMode === InferenceMode.PREFER_IN_CLOUD ||
    (effectiveSdkMode === InferenceMode.PREFER_ON_DEVICE && !localReady);

  const requestController = new AbortController();
  let timedOut = false;
  let callerAborted = false;

  const onCallerAbort = () => {
    callerAborted = true;
    requestController.abort(
      request.signal?.reason instanceof Error
        ? request.signal.reason
        : new DOMException('AI request cancelled by caller.', 'AbortError')
    );
  };

  if (request.signal) {
    if (request.signal.aborted) {
      onCallerAbort();
    } else {
      request.signal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  // Pre-flight Firebase App Check verification when App Check is initialized in browser
  if (cloudMayBeUsed && typeof window !== 'undefined' && getAppCheckStatus().initialized) {
    currentPhase = 'verifying_app_check';
    request.onProgress?.(currentPhase);
    let appCheckCheck;
    try {
      appCheckCheck = await runWithAbortSignal(
        verifyAppCheckToken({ timeoutMs: 12_000 }),
        requestController.signal
      );
    } catch (abortErr) {
      if (request.signal) {
        request.signal.removeEventListener('abort', onCallerAbort);
      }
      const durationMs = performance.now() - startedAt;
      const isCallerAborted = callerAborted || Boolean(request.signal?.aborted);
      const rawErrMsg = abortErr instanceof Error ? abortErr.message : String(abortErr);
      const errName = abortErr instanceof Error ? abortErr.name : undefined;
      const category: AIFailureCategory = isCallerAborted
        ? 'aborted'
        : classifyErrorCategory(rawErrMsg, {
            timedOut: false,
            callerAborted: false,
            errorName: errName
          });
      const resolvedCategory: AIFailureCategory =
        category === 'unknown' ? 'app_check' : category;
      const friendlyMsg = formatActionableErrorMessage(
        rawErrMsg,
        resolvedCategory,
        locale,
        timeoutMs
      );
      await logAIExecution({
        userId: request.userId,
        emailVerified: request.emailVerified,
        taskKey: request.taskKey,
        statusIndicator: 'FAILED',
        sdkInferenceSource: null,
        requestedMode,
        modelIdentifier: isCallerAborted ? 'aborted' : 'app_check_blocked',
        durationMs,
        fallbackOccurred: false,
        failureCategory: resolvedCategory,
        failurePhase: currentPhase,
        errorMessage: friendlyMsg
      });
      return {
        ok: false,
        data: null,
        rawText: '',
        statusIndicator: 'FAILED',
        sdkInferenceSource: null,
        requestedMode,
        modelIdentifier: isCallerAborted ? 'aborted' : 'app_check_blocked',
        executedAt,
        durationMs,
        fallbackOccurred: false,
        failureCategory: resolvedCategory,
        failurePhase: currentPhase,
        errorMessage: friendlyMsg
      };
    }
    if (!appCheckCheck.ok) {
      if (request.signal) {
        request.signal.removeEventListener('abort', onCallerAbort);
      }
      const durationMs = performance.now() - startedAt;
      const friendlyMsg = formatActionableErrorMessage(
        appCheckCheck.message,
        'app_check',
        locale,
        timeoutMs
      );
      await logAIExecution({
        userId: request.userId,
        emailVerified: request.emailVerified,
        taskKey: request.taskKey,
        statusIndicator: 'FAILED',
        sdkInferenceSource: null,
        requestedMode,
        modelIdentifier: 'app_check_blocked',
        durationMs,
        fallbackOccurred: false,
        failureCategory: 'app_check',
        failurePhase: currentPhase,
        errorMessage: friendlyMsg
      });
      return {
        ok: false,
        data: null,
        rawText: '',
        statusIndicator: 'FAILED',
        sdkInferenceSource: null,
        requestedMode,
        modelIdentifier: 'app_check_blocked',
        executedAt,
        durationMs,
        fallbackOccurred: false,
        failureCategory: 'app_check',
        failurePhase: currentPhase,
        errorMessage: friendlyMsg
      };
    }
  }

  const inferenceDeadline = performance.now() + timeoutMs;
  const timer = setTimeout(() => {
    timedOut = true;
    requestController.abort(
      new DOMException(`AI request timed out after ${Math.round(timeoutMs / 1000)}s`, 'AbortError')
    );
  }, timeoutMs);

  let activeCloudModelName = primaryCloudModelName;
  let modelFallbackOccurred = false;
  let modelFallbackReason: string | undefined;
  let retryAttempts = 0;

  try {
    const ai = getFirebaseAIInstance();

    const buildGenerationConfig = (
      targetModel: string,
      includeThinking: boolean
    ): GenerationConfig => {
      const isLegacyPre3Model = /^gemini-[12]\./i.test(targetModel);
      return {
        ...(isLegacyPre3Model ? { temperature: 0.35 } : {}),
        ...(expectJson ? { responseMimeType: 'application/json' } : {}),
        ...(request.responseSchema ? { responseSchema: request.responseSchema } : {}),
        ...(includeThinking && request.thinkingLevel && !isLegacyPre3Model
          ? { thinkingConfig: { thinkingLevel: request.thinkingLevel } }
          : {})
      };
    };

    const invokeModel = async (
      targetModel: string,
      includeThinking: boolean
    ): Promise<GenerateContentResult> => {
      const generationConfig = buildGenerationConfig(targetModel, includeThinking);
      const model = getGenerativeModel(ai, {
        mode: effectiveSdkMode,
        onDeviceParams: {
          createOptions: {
            expectedInputs: [{ type: 'text', languages: [locale === 'ar' ? 'ar' : 'en'] }],
            expectedOutputs: [{ type: 'text', languages: [locale === 'ar' ? 'ar' : 'en'] }]
          }
        },
        inCloudParams: {
          model: targetModel,
          ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
          systemInstruction
        }
      });

      // When local model may run, prepend compact instruction so single-turn on-device calls also obey JSON schema
      const combinedPrompt =
        effectiveSdkMode === InferenceMode.ONLY_ON_DEVICE ||
        (effectiveSdkMode === InferenceMode.PREFER_ON_DEVICE && localReady)
          ? `${systemInstruction}\n\n${request.prompt}`
          : request.prompt;

      const remainingMs = Math.max(50, Math.round(inferenceDeadline - performance.now()));
      return runWithAbortSignal(
        model.generateContent(combinedPrompt, {
          signal: requestController.signal,
          timeout: remainingMs
        }),
        requestController.signal
      );
    };

    currentPhase = 'connecting_model';
    request.onProgress?.(currentPhase, activeCloudModelName);

    const maxTransientRetries = Math.min(3, Math.max(0, request.maxTransientRetries ?? 2));
    const transientBackoffBaseMs = Math.max(0, request.transientBackoffBaseMs ?? 900);

    const invokeWithBoundedTransientRetry = async (
      targetModel: string,
      includeThinking: boolean
    ): Promise<GenerateContentResult> => {
      for (let attempt = 0; attempt <= maxTransientRetries; attempt++) {
        try {
          return await invokeModel(targetModel, includeThinking);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const errName = err instanceof Error ? err.name : undefined;
          const remainingMs = inferenceDeadline - performance.now();
          const canRetryTransient =
            cloudMayBeUsed &&
            !timedOut &&
            !callerAborted &&
            !requestController.signal.aborted &&
            !isTimeoutError(msg, errName) &&
            attempt < maxTransientRetries &&
            isTransientServerError(msg);

          if (!canRetryTransient) {
            throw err;
          }

          const jitter =
            transientBackoffBaseMs > 0
              ? Math.round(Math.random() * Math.max(100, transientBackoffBaseMs * 0.35))
              : 0;
          const delayMs =
            transientBackoffBaseMs > 0
              ? Math.round(transientBackoffBaseMs * Math.pow(2, attempt) + jitter)
              : 0;

          if (remainingMs < delayMs + 6_000) {
            throw err;
          }

          retryAttempts = attempt + 1;
          currentPhase = 'connecting_model';
          request.onProgress?.(
            currentPhase,
            `${targetModel} (retry ${retryAttempts}/${maxTransientRetries})`
          );
          await sleepWithAbort(delayMs, requestController.signal);
        }
      }
      throw new Error('Transient retry loop exhausted unexpectedly.');
    };

    let responseResult: GenerateContentResult;
    try {
      responseResult = await invokeWithBoundedTransientRetry(
        activeCloudModelName,
        Boolean(request.thinkingLevel)
      );
    } catch (primaryErr) {
      const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      const primaryErrName = primaryErr instanceof Error ? primaryErr.name : undefined;
      const remainingMs = inferenceDeadline - performance.now();
      const canFallbackModel =
        cloudMayBeUsed &&
        !request.disableModelFallback &&
        !timedOut &&
        !callerAborted &&
        !requestController.signal.aborted &&
        !isTimeoutError(primaryMsg, primaryErrName) &&
        remainingMs >= 10_000 &&
        isModelNotSupportedError(primaryMsg);

      if (!canFallbackModel) {
        throw primaryErr;
      }

      const nextModel =
        activeCloudModelName !== models.standard ? models.standard : 'gemini-2.5-flash';
      modelFallbackOccurred = true;
      modelFallbackReason = `Primary model "${activeCloudModelName}" unavailable (${primaryMsg}); switched once to "${nextModel}".`;
      activeCloudModelName = nextModel;
      currentPhase = 'connecting_model';
      request.onProgress?.(currentPhase, activeCloudModelName);
      responseResult = await invokeWithBoundedTransientRetry(activeCloudModelName, false);
    }

    currentPhase = 'validating_output';
    request.onProgress?.(currentPhase);

    const rawText = responseResult.response.text();
    const sdkSource = responseResult.response.inferenceSource ?? null;
    const durationMs = performance.now() - startedAt;

    // Verify actual source strictly from Firebase AI Logic SDK response metadata
    let statusIndicator: TruthfulInferenceStatus = 'FAILED';
    let fallbackOccurred = modelFallbackOccurred;
    let fallbackReason: string | undefined = modelFallbackReason || preflightCloudRouteReason;
    let modelIdentifier = activeCloudModelName;

    if (sdkSource === InferenceSource.ON_DEVICE) {
      statusIndicator = 'ON-DEVICE';
      modelIdentifier = capability.localModelIdentityLabel;
      if (requestedMode === InferenceMode.PREFER_IN_CLOUD) {
        fallbackOccurred = true;
        fallbackReason = 'Cloud inference unavailable or offline; Firebase AI Logic executed on-device.';
      }
    } else if (sdkSource === InferenceSource.IN_CLOUD) {
      modelIdentifier = activeCloudModelName;
      if (requestedMode === InferenceMode.PREFER_ON_DEVICE) {
        statusIndicator = 'FALLBACK TO CLOUD';
        fallbackOccurred = true;
        fallbackReason =
          fallbackReason ||
          (!capability.isDesktopEnvironment
            ? 'Mobile browser environment uses Firebase AI Logic Cloud inference.'
            : !capability.isChromePromptApiSupported
              ? 'Chrome Prompt API not exposed in current browser; fell back to Cloud Gemini.'
              : capability.localReasonCode === 'insufficient_resources'
                ? 'Insufficient device resources for local model; fell back to Cloud Gemini.'
                : !localReady
                  ? `Local model state is "${capability.localAvailability}"; fell back to Cloud Gemini.`
                  : 'Task exceeded on-device constraints or local session declined; fell back to Cloud Gemini.');
      } else {
        statusIndicator = 'CLOUD';
      }
    } else {
      // Never claim ON-DEVICE in hybrid mode if SDK did not confirm InferenceSource.ON_DEVICE
      if (effectiveSdkMode === InferenceMode.ONLY_ON_DEVICE) {
        statusIndicator = 'ON-DEVICE';
        modelIdentifier = capability.localModelIdentityLabel;
      } else {
        statusIndicator =
          requestedMode === InferenceMode.PREFER_ON_DEVICE ? 'FALLBACK TO CLOUD' : 'CLOUD';
        fallbackOccurred =
          fallbackOccurred || requestedMode === InferenceMode.PREFER_ON_DEVICE;
        fallbackReason =
          fallbackReason ||
          (fallbackOccurred
            ? 'On-device inference source was not confirmed by browser; treated as Cloud Gemini execution.'
            : undefined);
      }
    }

    let parsedData: T | null = null;
    if (expectJson) {
      parsedData = extractJsonFromText<T>(rawText);
      if (!parsedData) {
        const parseErr = 'Model response did not conform to expected structured JSON format.';
        await logAIExecution({
          userId: request.userId,
          emailVerified: request.emailVerified,
          taskKey: request.taskKey,
          statusIndicator: 'FAILED',
          sdkInferenceSource: sdkSource,
          requestedMode,
          modelIdentifier,
          durationMs,
          fallbackOccurred,
          fallbackReason,
          failureCategory: 'parse',
          failurePhase: currentPhase,
          errorMessage: parseErr,
          resultPreview: rawText
        });
        return {
          ok: false,
          data: null,
          rawText,
          statusIndicator: 'FAILED',
          sdkInferenceSource: sdkSource,
          requestedMode,
          effectiveSdkMode,
          modelIdentifier,
          requestedModelIdentifier: primaryCloudModelName,
          ...(modelFallbackOccurred ? { fallbackModelIdentifier: activeCloudModelName } : {}),
          executedAt,
          durationMs,
          fallbackOccurred,
          fallbackReason,
          failureCategory: 'parse',
          failurePhase: currentPhase,
          ...(retryAttempts > 0 ? { retryAttempts } : {}),
          errorMessage: parseErr
        };
      }
    } else {
      parsedData = rawText as unknown as T;
    }

    await logAIExecution({
      userId: request.userId,
      emailVerified: request.emailVerified,
      taskKey: request.taskKey,
      statusIndicator,
      sdkInferenceSource: sdkSource,
      requestedMode,
      modelIdentifier,
      durationMs,
      fallbackOccurred,
      fallbackReason,
      resultPreview: rawText
    });

    return {
      ok: true,
      data: parsedData,
      rawText,
      statusIndicator,
      sdkInferenceSource: sdkSource,
      requestedMode,
      effectiveSdkMode,
      modelIdentifier,
      requestedModelIdentifier: primaryCloudModelName,
      ...(modelFallbackOccurred ? { fallbackModelIdentifier: activeCloudModelName } : {}),
      executedAt,
      durationMs,
      fallbackOccurred,
      fallbackReason,
      ...(retryAttempts > 0 ? { retryAttempts } : {})
    };
  } catch (err) {
    const durationMs = performance.now() - startedAt;
    const rawMsg =
      err instanceof Error
        ? err.message
        : typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err);
    const errName =
      err instanceof Error
        ? err.name
        : typeof err === 'object' && err !== null && 'name' in err
          ? String((err as { name: unknown }).name)
          : undefined;
    const isCallerAborted = callerAborted || Boolean(request.signal?.aborted);
    const localAttempted = effectiveSdkMode === InferenceMode.ONLY_ON_DEVICE;
    const category = classifyErrorCategory(rawMsg, {
      timedOut,
      callerAborted: isCallerAborted,
      localModeAttempted: localAttempted,
      errorName: errName
    });
    const isTimeout = timedOut || category === 'timeout';
    let friendlyMsg = formatActionableErrorMessage(rawMsg, category, locale, timeoutMs);

    const isLocalUnavailable =
      localAttempted ||
      rawMsg.toLowerCase().includes('not available') ||
      rawMsg.toLowerCase().includes('api_not_enabled');

    if (
      requestedMode === InferenceMode.PREFER_ON_DEVICE &&
      effectiveSdkMode === InferenceMode.ONLY_ON_DEVICE &&
      !isCallerAborted &&
      !isTimeout
    ) {
      friendlyMsg =
        locale === 'ar'
          ? `${friendlyMsg} (لم يتم التحويل إلى السحابة لأن موافقة الذكاء السحابي غير مفعّلة.)`
          : `${friendlyMsg} (Cloud fallback skipped because explicit Cloud AI consent is not granted.)`;
    }

    const statusIndicator: TruthfulInferenceStatus =
      localAttempted && isLocalUnavailable && !isCallerAborted && !isTimeout
        ? 'LOCAL MODEL UNAVAILABLE'
        : 'FAILED';

    await logAIExecution({
      userId: request.userId,
      emailVerified: request.emailVerified,
      taskKey: request.taskKey,
      statusIndicator,
      sdkInferenceSource: null,
      requestedMode,
      modelIdentifier: localAttempted
        ? capability.localModelIdentityLabel
        : activeCloudModelName,
      durationMs,
      fallbackOccurred: modelFallbackOccurred,
      fallbackReason: modelFallbackReason || preflightCloudRouteReason,
      failureCategory: category,
      failurePhase: currentPhase,
      errorMessage: friendlyMsg
    });

    return {
      ok: false,
      data: null,
      rawText: '',
      statusIndicator,
      sdkInferenceSource: null,
      requestedMode,
      effectiveSdkMode,
      modelIdentifier: localAttempted
        ? capability.localModelIdentityLabel
        : activeCloudModelName,
      requestedModelIdentifier: primaryCloudModelName,
      ...(modelFallbackOccurred ? { fallbackModelIdentifier: activeCloudModelName } : {}),
      executedAt,
      durationMs,
      fallbackOccurred: modelFallbackOccurred,
      fallbackReason: modelFallbackReason || preflightCloudRouteReason,
      failureCategory: category,
      failurePhase: currentPhase,
      ...(retryAttempts > 0 ? { retryAttempts } : {}),
      errorMessage: friendlyMsg
    };
  } finally {
    clearTimeout(timer);
    if (request.signal) {
      request.signal.removeEventListener('abort', onCallerAbort);
    }
  }
}
