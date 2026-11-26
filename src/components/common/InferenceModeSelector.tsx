import { InferenceMode } from 'firebase/ai';
import { ShieldAlert } from 'lucide-react';
import { useLanguage } from '../../contexts/LanguageContext';

interface Props {
  mode: InferenceMode;
  onChange: (mode: InferenceMode) => void;
  cloudConsent: boolean;
  onGrantConsent?: () => Promise<void>;
  locked?: boolean;
  lockedNotice?: string;
}

export function InferenceModeSelector({
  mode,
  onChange,
  cloudConsent,
  onGrantConsent,
  locked = false,
  lockedNotice
}: Props) {
  const { t } = useLanguage();

  const modes: { value: InferenceMode; label: string }[] = [
    { value: InferenceMode.PREFER_ON_DEVICE, label: t.ai.preferOnDevice },
    { value: InferenceMode.PREFER_IN_CLOUD, label: t.ai.preferInCloud },
    { value: InferenceMode.ONLY_ON_DEVICE, label: t.ai.onlyOnDevice },
    { value: InferenceMode.ONLY_IN_CLOUD, label: t.ai.onlyInCloud }
  ];

  const needsConsentWarning = !cloudConsent && mode !== InferenceMode.ONLY_ON_DEVICE;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
            {t.ai.modeLabel}
          </span>
          {locked && (
            <span className="font-mono text-[11px] font-semibold text-blue-700 dark:text-blue-300">
              {lockedNotice || 'LOCKED: ONLY_IN_CLOUD'}
            </span>
          )}
        </div>
        <div className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900/70 p-1">
          {modes.map((m) => {
            const isDisabled = locked && m.value !== mode;
            return (
              <button
                key={m.value}
                type="button"
                disabled={isDisabled}
                aria-disabled={isDisabled}
                onClick={() => {
                  if (!locked) {
                    onChange(m.value);
                  }
                }}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  mode === m.value
                    ? 'bg-blue-600 text-white'
                    : isDisabled
                      ? 'text-slate-400 dark:text-slate-600 opacity-50 cursor-not-allowed'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      {needsConsentWarning && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{t.ai.consentNotice}</span>
          </div>
          {onGrantConsent && (
            <button
              type="button"
              onClick={() => void onGrantConsent()}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 whitespace-nowrap shrink-0"
            >
              {t.ai.consentGrantBtn}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
