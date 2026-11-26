import { useState } from 'react';
import { InferenceMode } from 'firebase/ai';
import { Cpu, FileText, Play } from 'lucide-react';
import { useLanguage } from '../../contexts/LanguageContext';
import { executeHybridInference } from '../../services/hybridAI/inferenceManager';
import { buildTaskPrompt } from '../../services/hybridAI/promptRegistry';
import type { AITaskKey, HybridExecutionResult } from '../../services/hybridAI/types';
import { OFFICIAL_CRITERIA_MAP } from '../../services/judgingV2/criteria';
import type { EvidenceBundle, OfficialCriterionId } from '../../services/judgingV2/types';
import { InferenceResultBanner } from '../common/InferenceBadge';
import { InferenceModeSelector } from '../common/InferenceModeSelector';

type QuickHelperTask =
  | 'evidence_excerpt_summary'
  | 'evidence_criteria_classify'
  | 'user_text_fact_extract'
  | 'preliminary_summary';

interface Props {
  locale: 'en' | 'ar';
  bundle: EvidenceBundle | null;
  projectTitle: string;
  projectDescription: string;
  cloudConsent: boolean;
  onGrantCloudConsent: () => Promise<void>;
  userId?: string;
  emailVerified?: boolean;
}

function buildDefaultSnippetForTask(
  task: QuickHelperTask,
  bundle: EvidenceBundle | null,
  projectTitle: string,
  projectDescription: string
): string {
  if (task === 'evidence_excerpt_summary' || task === 'evidence_criteria_classify') {
    const topFindings = (bundle?.findings || [])
      .slice(0, 4)
      .map(
        (f) =>
          `[${f.filePath || f.sourceLabel}${f.lineRange ? `:${f.lineRange}` : ''}] (${f.status}) ${f.title}: ${f.detail}`
      )
      .join('\n');
    if (topFindings) return topFindings;
  }

  const coverageLine = bundle
    ? `Repo: ${bundle.coverage.repoFullName || 'N/A'} | Inspected: ${bundle.coverage.inspectedFiles}/${bundle.coverage.uniqueSourceFiles} | Tests: ${bundle.testVerification.summary}`
    : '';

  return [projectTitle, projectDescription, coverageLine].filter(Boolean).join('\n').slice(0, 2400);
}

export function OnDeviceQuickHelpersPanel({
  locale,
  bundle,
  projectTitle,
  projectDescription,
  cloudConsent,
  onGrantCloudConsent,
  userId,
  emailVerified
}: Props) {
  const { t } = useLanguage();
  const isAr = locale === 'ar';

  const [selectedTask, setSelectedTask] = useState<QuickHelperTask>('evidence_excerpt_summary');
  const [mode, setMode] = useState<InferenceMode>(InferenceMode.PREFER_ON_DEVICE);
  const [inputText, setInputText] = useState<string>(() =>
    buildDefaultSnippetForTask('evidence_excerpt_summary', bundle, projectTitle, projectDescription)
  );
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<HybridExecutionResult<Record<string, unknown>> | null>(null);

  const taskDefs: Array<{ key: QuickHelperTask; label: string }> = [
    { key: 'evidence_excerpt_summary', label: t.ai.helperSummarizeExcerpt },
    { key: 'evidence_criteria_classify', label: t.ai.helperClassifyCriteria },
    { key: 'user_text_fact_extract', label: t.ai.helperExtractFacts },
    { key: 'preliminary_summary', label: t.ai.helperPreliminarySummary }
  ];

  const handleLoadContextSnippet = (taskOverride?: QuickHelperTask) => {
    const targetTask = taskOverride ?? selectedTask;
    setInputText(buildDefaultSnippetForTask(targetTask, bundle, projectTitle, projectDescription));
  };

  const handleSelectTask = (task: QuickHelperTask) => {
    setSelectedTask(task);
    handleLoadContextSnippet(task);
  };

  const handleRunHelper = async () => {
    const trimmed = inputText.trim();
    if (!trimmed || running) return;
    setRunning(true);
    try {
      const prompt = buildTaskPrompt(
        selectedTask as AITaskKey,
        {
          projectTitle,
          textExcerpt: trimmed.slice(0, 4200),
          note: 'Strictly use the four official criteria (25/30/25/20) and do not include video data.'
        },
        locale,
        { compact: true }
      );

      const res = await executeHybridInference<Record<string, unknown>>({
        taskKey: selectedTask,
        prompt,
        preferredMode: mode,
        locale,
        cloudConsentGranted: cloudConsent,
        userId,
        emailVerified
      });
      setResult(res);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              {t.ai.onDeviceHelpersTitle}
            </h2>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 max-w-3xl">
            {t.ai.onDeviceHelpersDesc}
          </p>
        </div>

        <span className="font-mono text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
          {t.ai.helperQuotaSafeNote}
        </span>
      </div>

      {/* 4 Task Buttons */}
      <div className="flex flex-wrap items-center gap-2">
        {taskDefs.map((def) => (
          <button
            key={def.key}
            type="button"
            disabled={running}
            onClick={() => handleSelectTask(def.key)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              selectedTask === def.key
                ? 'border-blue-600 bg-blue-600/10 text-blue-700 dark:text-blue-300'
                : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            {def.label}
          </button>
        ))}

        <button
          type="button"
          disabled={running}
          onClick={() => handleLoadContextSnippet()}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 text-[11px] font-mono text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
        >
          <FileText className="h-3 w-3" />
          <span>{isAr ? 'تعبئة مقتطف من الأدلة' : 'Load Evidence Snippet'}</span>
        </button>
      </div>

      <InferenceModeSelector
        mode={mode}
        onChange={setMode}
        cloudConsent={cloudConsent}
        onGrantConsent={onGrantCloudConsent}
      />

      <div className="space-y-2">
        <textarea
          rows={3}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={
            isAr
              ? 'أدخل مقتطفاً قصيراً من الأدلة أو نصاً لاستخلاص الحقائق...'
              : 'Paste a short evidence excerpt or project text (kept concise for on-device routing)...'
          }
          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-xs font-mono text-slate-900 dark:text-white"
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-[11px] tabular-nums text-slate-500">
            {inputText.trim().length} / 4500 {isAr ? 'حرف (حد المعالجة المحلية)' : 'chars (on-device budget)'}
          </span>
          <button
            type="button"
            disabled={running || !inputText.trim()}
            onClick={() => void handleRunHelper()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3.5 py-2 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Play className="h-3.5 w-3.5" />
            <span>{running ? t.ai.runningTestBtn : t.ai.runHelperBtn}</span>
          </button>
        </div>
      </div>

      {result && (
        <div className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
          <InferenceResultBanner result={result} />

          {result.ok && result.data && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3 text-xs space-y-2">
              {selectedTask === 'evidence_criteria_classify' &&
              Array.isArray(result.data.classifications) ? (
                <div className="space-y-1.5">
                  {(
                    result.data.classifications as Array<{
                      criterionId?: string;
                      relevance?: string;
                      rationale?: string;
                    }>
                  ).map((item, idx) => {
                    const cId = item.criterionId as OfficialCriterionId | undefined;
                    const def = cId ? OFFICIAL_CRITERIA_MAP[cId] : undefined;
                    return (
                      <div
                        key={`${item.criterionId || 'c'}_${idx}`}
                        className="flex flex-wrap items-baseline justify-between gap-2 border-b last:border-b-0 border-slate-200 dark:border-slate-800 pb-1.5 last:pb-0"
                      >
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {def ? (isAr ? def.nameAr : `${def.name} (${def.weightPercent}%)`) : item.criterionId}
                        </div>
                        <span className="font-mono text-[11px] text-blue-700 dark:text-blue-300">
                          {item.relevance || 'n/a'}
                        </span>
                        {item.rationale && (
                          <p className="w-full text-[11px] text-slate-600 dark:text-slate-300">
                            {item.rationale}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <pre className="font-mono text-[11px] text-slate-800 dark:text-slate-200 whitespace-pre-wrap overflow-auto max-h-56">
                  {JSON.stringify(result.data, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
