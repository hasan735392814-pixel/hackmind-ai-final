import { AlertTriangle, CheckCircle2, Cloud, Cpu, XCircle } from 'lucide-react';
import type {
  AIExecutionStage,
  AIFailureCategory,
  HybridExecutionResult,
  TruthfulInferenceStatus
} from '../../services/hybridAI/types';
import { useLanguage } from '../../contexts/LanguageContext';

interface StatusBadgeProps {
  status: TruthfulInferenceStatus;
  modelIdentifier?: string;
  durationMs?: number;
  fallbackReason?: string;
  failureCategory?: AIFailureCategory;
  failurePhase?: AIExecutionStage;
  errorMessage?: string;
  compact?: boolean;
}

export function InferenceStatusBadge({
  status,
  modelIdentifier,
  durationMs,
  fallbackReason,
  failureCategory,
  failurePhase,
  errorMessage,
  compact = false
}: StatusBadgeProps) {
  const { locale } = useLanguage();

  const configMap: Record<
    TruthfulInferenceStatus,
    { classes: string; Icon: typeof Cpu; labelAr: string }
  > = {
    'ON-DEVICE': {
      classes:
        'border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      Icon: Cpu,
      labelAr: 'على الجهاز (ON-DEVICE)'
    },
    CLOUD: {
      classes: 'border-blue-600/30 bg-blue-500/10 text-blue-700 dark:text-blue-300',
      Icon: Cloud,
      labelAr: 'السحابة (CLOUD)'
    },
    'FALLBACK TO CLOUD': {
      classes: 'border-amber-600/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      Icon: AlertTriangle,
      labelAr: 'تحويل إلى السحابة (FALLBACK TO CLOUD)'
    },
    'LOCAL MODEL UNAVAILABLE': {
      classes: 'border-amber-600/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      Icon: AlertTriangle,
      labelAr: 'النموذج المحلي غير متاح (LOCAL MODEL UNAVAILABLE)'
    },
    FAILED: {
      classes: 'border-red-600/30 bg-red-500/10 text-red-700 dark:text-red-300',
      Icon: XCircle,
      labelAr: 'فشل التنفيذ (FAILED)'
    }
  };

  const { classes, Icon, labelAr } = configMap[status];

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-xs font-medium whitespace-nowrap ${classes}`}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span>{locale === 'ar' ? labelAr : status}</span>
        {typeof durationMs === 'number' && (
          <span className="opacity-75 tabular-nums">· {Math.round(durationMs)}ms</span>
        )}
      </span>
    );
  }

  return (
    <div className={`rounded-lg border p-3 text-xs ${classes}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-mono font-semibold">
          <Icon className="h-4 w-4 shrink-0" />
          <span>{locale === 'ar' ? labelAr : status}</span>
        </div>
        {typeof durationMs === 'number' && (
          <span className="font-mono tabular-nums opacity-80">{Math.round(durationMs)} ms</span>
        )}
      </div>
      {modelIdentifier && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] opacity-90">
          <CheckCircle2 className="h-3 w-3 shrink-0" />
          <span className="truncate">{modelIdentifier}</span>
        </div>
      )}
      {fallbackReason && (
        <p className="mt-1.5 text-[11px] leading-relaxed opacity-90">{fallbackReason}</p>
      )}
      {(failurePhase || failureCategory) && (
        <p className="mt-1.5 font-mono text-[10px] opacity-85">
          {[failurePhase ? `phase=${failurePhase}` : null, failureCategory ? `category=${failureCategory}` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {errorMessage && (
        <p className="mt-1.5 text-[11px] leading-relaxed font-medium">{errorMessage}</p>
      )}
    </div>
  );
}

export function InferenceResultBanner({ result }: { result: HybridExecutionResult<unknown> | null }) {
  if (!result) return null;
  return (
    <InferenceStatusBadge
      status={result.statusIndicator}
      modelIdentifier={result.modelIdentifier}
      durationMs={result.durationMs}
      fallbackReason={result.fallbackReason}
      failureCategory={result.failureCategory}
      failurePhase={result.failurePhase}
      errorMessage={result.errorMessage}
    />
  );
}
