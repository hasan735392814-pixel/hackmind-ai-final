import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bug, CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react';
import type { User } from 'firebase/auth';
import { getFirebaseConfigStatus } from '../../services/firebase/config';
import {
  inspectCompositeRegistrationForDiagnostics,
  inspectUserRegistrationsForDiagnostics,
  type CompositeVerificationDiagnosticResult,
  type UserRegistrationsDiagnosticResult
} from '../../services/firebase/firestoreService';
import type { Hackathon, HackathonRegistration } from '../../types/domain';
import {
  analyzeRegistrationDiagnostics,
  formatDiagnosticTimestamp
} from '../../utils/registrationDiagnostics';

interface RegistrationDiagnosticPanelProps {
  user: User | null;
  emailVerified: boolean;
  selectedHackathonId: string;
  selectedHackathon: Hackathon | undefined;
  builderStateRegistrations: HackathonRegistration[];
}

export function RegistrationDiagnosticPanel({
  user,
  emailVerified,
  selectedHackathonId,
  selectedHackathon,
  builderStateRegistrations
}: RegistrationDiagnosticPanelProps) {
  const [running, setRunning] = useState(false);
  const [lastRunAt, setLastRunAt] = useState<string>('');
  const [queryResult, setQueryResult] = useState<UserRegistrationsDiagnosticResult | null>(null);
  const [compositeResult, setCompositeResult] =
    useState<CompositeVerificationDiagnosticResult | null>(null);

  const fbConfig = getFirebaseConfigStatus();

  const runDiagnostics = useCallback(async () => {
    if (!user) return;
    setRunning(true);
    try {
      const [regDiag, compDiag] = await Promise.all([
        inspectUserRegistrationsForDiagnostics(user.uid),
        inspectCompositeRegistrationForDiagnostics(user.uid, selectedHackathonId)
      ]);
      setQueryResult(regDiag);
      setCompositeResult(compDiag);
      setLastRunAt(new Date().toISOString());
    } finally {
      setRunning(false);
    }
  }, [user, selectedHackathonId]);

  useEffect(() => {
    void runDiagnostics();
  }, [runDiagnostics, emailVerified, builderStateRegistrations.length]);

  // Diagnostic Access Control: Only render for authenticated users inspecting their own UID.
  if (!user) {
    return null;
  }

  const analysis =
    queryResult && compositeResult
      ? analyzeRegistrationDiagnostics({
          uid: user.uid,
          emailVerified,
          selectedHackathonId,
          queryResult,
          compositeResult,
          builderStateRegistrations
        })
      : null;

  return (
    <section
      aria-label="Temporary Registration Diagnostic Panel"
      className="rounded-xl border-2 border-amber-500/50 bg-amber-50/60 dark:bg-[#0B1120] p-5 space-y-5 text-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-amber-500/30 pb-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Bug className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
              Temporary Registration Diagnostic Panel (Read-Only)
            </h2>
            <span className="rounded bg-amber-500/20 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-800 dark:text-amber-300">
              NO WRITES · SELF-UID ONLY
            </span>
          </div>
          <p className="text-[11px] text-slate-600 dark:text-slate-400">
            Reads only your authenticated account&apos;s registration documents and surfaces raw
            Firestore errors without modifying data or rules.
            {lastRunAt ? ` Last checked: ${lastRunAt}` : ''}
          </p>
        </div>

        <button
          type="button"
          disabled={running}
          onClick={() => void runDiagnostics()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/50 bg-white dark:bg-[#070B14] px-3 py-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${running ? 'animate-spin' : ''}`} />
          <span>{running ? 'Inspecting...' : 'Re-run Read-Only Check'}</span>
        </button>
      </div>

      {/* 1. Authenticated User & 2. Selected Hackathon */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#070B14] p-3.5 space-y-1.5">
          <div className="font-semibold text-slate-800 dark:text-slate-200">
            1. Current Authenticated User
          </div>
          <div className="grid grid-cols-[150px_1fr] gap-y-1 text-[11px]">
            <span className="text-slate-500">Firebase Auth UID:</span>
            <span className="font-mono break-all text-slate-900 dark:text-white">{user.uid}</span>
            <span className="text-slate-500">Signed-in status:</span>
            <span className="font-mono text-emerald-600 dark:text-emerald-400">Signed In</span>
            <span className="text-slate-500">Email verification:</span>
            <span
              className={`font-mono font-semibold ${
                emailVerified
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {emailVerified ? 'Verified (true)' : 'Unverified (false)'}
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#070B14] p-3.5 space-y-1.5">
          <div className="font-semibold text-slate-800 dark:text-slate-200">
            2. Selected Hackathon &amp; Firestore Target
          </div>
          <div className="grid grid-cols-[150px_1fr] gap-y-1 text-[11px]">
            <span className="text-slate-500">Hackathon title:</span>
            <span className="font-medium text-slate-900 dark:text-white">
              {selectedHackathon?.title || '(None selected)'}
            </span>
            <span className="text-slate-500">Hackathon doc ID:</span>
            <span className="font-mono break-all text-slate-900 dark:text-white">
              {selectedHackathon?.id || selectedHackathonId || '(empty)'}
            </span>
            <span className="text-slate-500">Firestore database ID:</span>
            <span className="font-mono text-slate-900 dark:text-white">
              {fbConfig.firestoreDatabaseId} (project: {fbConfig.projectId})
            </span>
          </div>
        </div>
      </div>

      {/* 3. Registration Records Table */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#070B14] p-3.5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold text-slate-800 dark:text-slate-200">
            3. Registration Records (`where(&apos;userId&apos;, &apos;==&apos;, uid)`)
          </div>
          <div className="font-mono text-[11px] text-slate-600 dark:text-slate-400">
            {queryResult
              ? `Total returned: ${queryResult.records.length} · Matching selected hackathon: ${analysis?.matchingSelectedCount ?? 0}`
              : 'Loading...'}
          </div>
        </div>

        {queryResult?.errorCode && (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-2.5 text-[11px] text-red-700 dark:text-red-300 font-mono">
            <strong>Query Error:</strong> code={queryResult.errorCode} · message=
            {queryResult.errorMessage}
          </div>
        )}

        {analysis && analysis.duplicateGroups.length > 0 && (
          <div className="rounded border border-amber-500/50 bg-amber-500/10 p-2.5 text-[11px] text-amber-800 dark:text-amber-200 space-y-1">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>Duplicate Registration Records Detected ({analysis.duplicateGroups.length} group(s)):</span>
            </div>
            {analysis.duplicateGroups.map((grp) => (
              <div key={grp.key} className="font-mono text-[11px] ps-5">
                hackathonId={grp.hackathonId} · userId={grp.userId} → {grp.records.length} docs:{' '}
                {grp.records.map((r) => `${r.docId} (${r.status})`).join(' | ')}
                {grp.hasMixedStatuses ? ' [MIXED STATUSES]' : ''}
              </div>
            ))}
          </div>
        )}

        {queryResult && !queryResult.errorCode && queryResult.records.length === 0 ? (
          <p className="text-[11px] text-slate-500 font-mono">
            Zero registration documents returned for userId=&quot;{user.uid}&quot;.
          </p>
        ) : queryResult && queryResult.records.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="py-1.5 pe-3">Exact Doc ID</th>
                  <th className="py-1.5 pe-3">Document Path</th>
                  <th className="py-1.5 pe-3">hackathonId</th>
                  <th className="py-1.5 pe-3">userId</th>
                  <th className="py-1.5 pe-3">status</th>
                  <th className="py-1.5 pe-3">createdAt</th>
                  <th className="py-1.5">updatedAt</th>
                </tr>
              </thead>
              <tbody>
                {queryResult.records.map((rec) => {
                  const matchesSelected = Boolean(
                    selectedHackathonId && rec.hackathonId === selectedHackathonId
                  );
                  const matchesCompositeId =
                    Boolean(compositeResult?.expectedCompositeId) &&
                    rec.docId === compositeResult?.expectedCompositeId;
                  return (
                    <tr
                      key={rec.docPath}
                      className={`border-b border-slate-100 dark:border-slate-800/60 font-mono ${
                        matchesSelected
                          ? 'bg-blue-500/10 text-slate-900 dark:text-white'
                          : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      <td className="py-1.5 pe-3 align-top">
                        <div>{rec.docId}</div>
                        <div className="text-[10px]">
                          {matchesSelected && (
                            <span className="text-blue-600 dark:text-blue-400 me-1.5">
                              [selected hackathon]
                            </span>
                          )}
                          {matchesCompositeId && (
                            <span className="text-emerald-600 dark:text-emerald-400">
                              [exact composite ID]
                            </span>
                          )}
                          {rec.dataId && rec.dataId !== rec.docId && (
                            <span className="text-red-600 dark:text-red-400">
                              [data.id={rec.dataId} != doc.id]
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-1.5 pe-3 align-top break-all">{rec.docPath}</td>
                      <td className="py-1.5 pe-3 align-top break-all">{rec.hackathonId}</td>
                      <td className="py-1.5 pe-3 align-top break-all">{rec.userId}</td>
                      <td className="py-1.5 pe-3 align-top font-semibold">{rec.status}</td>
                      <td className="py-1.5 pe-3 align-top whitespace-nowrap">
                        {formatDiagnosticTimestamp(rec.createdAt)}
                      </td>
                      <td className="py-1.5 align-top whitespace-nowrap">
                        {formatDiagnosticTimestamp(rec.updatedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {/* 4. Verification Diagnostics */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#070B14] p-3.5 space-y-2">
        <div className="font-semibold text-slate-800 dark:text-slate-200">
          4. Composite Verification Diagnostics (`verifyUserRegistrationApproved`)
        </div>
        {compositeResult ? (
          <div className="space-y-2 text-[11px]">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 font-mono">
              <div className="flex justify-between gap-2 border-b border-slate-100 dark:border-slate-800/60 py-1">
                <span className="text-slate-500 font-sans">Expected composite ID:</span>
                <span className="break-all text-end">
                  {compositeResult.expectedCompositeId || '(none)'}
                </span>
              </div>
              <div className="flex justify-between gap-2 border-b border-slate-100 dark:border-slate-800/60 py-1">
                <span className="text-slate-500 font-sans">Exact document exists:</span>
                <span>
                  {compositeResult.exists === null
                    ? 'Read Failed (see error)'
                    : String(compositeResult.exists)}
                </span>
              </div>
              <div className="flex justify-between gap-2 border-b border-slate-100 dark:border-slate-800/60 py-1">
                <span className="text-slate-500 font-sans">userId matches:</span>
                <span>
                  {String(compositeResult.userIdMatches)} (stored:{' '}
                  {compositeResult.storedUserId ?? 'null'})
                </span>
              </div>
              <div className="flex justify-between gap-2 border-b border-slate-100 dark:border-slate-800/60 py-1">
                <span className="text-slate-500 font-sans">hackathonId matches:</span>
                <span>
                  {String(compositeResult.hackathonIdMatches)} (stored:{' '}
                  {compositeResult.storedHackathonId ?? 'null'})
                </span>
              </div>
              <div className="flex justify-between gap-2 border-b border-slate-100 dark:border-slate-800/60 py-1">
                <span className="text-slate-500 font-sans">Actual stored status:</span>
                <span className="font-semibold">{compositeResult.storedStatus ?? 'null'}</span>
              </div>
              <div className="flex justify-between gap-2 border-b border-slate-100 dark:border-slate-800/60 py-1">
                <span className="text-slate-500 font-sans">Final verification result:</span>
                <span
                  className={`font-semibold ${
                    compositeResult.verifyFnResult
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-red-600 dark:text-red-400'
                  }`}
                >
                  {String(compositeResult.verifyFnResult)}
                </span>
              </div>
            </div>

            {compositeResult.errorCode && (
              <div className="rounded border border-red-500/40 bg-red-500/10 p-2.5 text-red-700 dark:text-red-300 font-mono">
                <strong>Firestore Read Error:</strong> path=&quot;{compositeResult.documentPath}&quot;
                {' · '}code=&quot;{compositeResult.errorCode}&quot;
                {' · '}message=&quot;{compositeResult.errorMessage}&quot;
              </div>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-slate-500">Running verification probe...</p>
        )}
      </div>

      {/* 5. Compare Registration Sources + Exact Summary */}
      {analysis && compositeResult && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#070B14] p-3.5 space-y-3">
          <div className="font-semibold text-slate-800 dark:text-slate-200">
            5. Source Comparison (Discover Hackathons vs Builder Workspace)
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px]">
            <div className="rounded border border-slate-200 dark:border-slate-800 p-2.5 space-y-1">
              <div className="font-semibold text-slate-700 dark:text-slate-300">
                Discover Hackathons (Map → Last Wins)
              </div>
              <div className="font-mono">
                docId: {analysis.discoverResolvedRecord?.docId || 'none'}
              </div>
              <div className="font-mono">
                status: {analysis.discoverResolvedRecord?.status || 'none'}
              </div>
            </div>
            <div className="rounded border border-slate-200 dark:border-slate-800 p-2.5 space-y-1">
              <div className="font-semibold text-slate-700 dark:text-slate-300">
                Builder UI (.find → First Wins)
              </div>
              <div className="font-mono">
                fresh docId: {analysis.builderQueryFirstRecord?.docId || 'none'}
              </div>
              <div className="font-mono">
                fresh status: {analysis.builderQueryFirstRecord?.status || 'none'}
              </div>
              <div className="font-mono text-slate-500">
                state cached status: {analysis.builderStateResolvedRecord?.status || 'none'} (
                {analysis.builderStateCount} cached)
              </div>
            </div>
            <div className="rounded border border-slate-200 dark:border-slate-800 p-2.5 space-y-1">
              <div className="font-semibold text-slate-700 dark:text-slate-300">
                Duplicate / Consistency Checks
              </div>
              <div className="font-mono">
                duplicatesForSelected: {String(analysis.duplicatesForSelected)}
              </div>
              <div className="font-mono">
                firstVsLastMismatch: {String(analysis.firstVsLastMismatch)}
              </div>
              <div className="font-mono">
                queryAndStateMismatch: {String(analysis.queryAndStateMismatch)}
              </div>
            </div>
          </div>

          <div
            className={`rounded-lg border p-3 flex items-start gap-2 text-[11px] ${
              compositeResult.verifyFnResult && !analysis.firstVsLastMismatch
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
                : 'border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-200'
            }`}
          >
            {compositeResult.verifyFnResult && !analysis.firstVsLastMismatch ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
            ) : (
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
            )}
            <div className="space-y-1">
              <div className="font-semibold">Live Diagnostic Determination:</div>
              <div>{analysis.blockReason}</div>
              <div className="font-mono text-[10px] pt-1 opacity-90">
                Summary: matchingDocs={analysis.matchingSelectedCount} · duplicates=
                {String(analysis.duplicatesForSelected)} · approvedDocs=[
                {analysis.approvedRecordsForSelected.map((r) => r.docId).join(', ') || 'none'}] ·
                approvedMatchesCompositeId={String(analysis.approvedCompositeMatchExists)} ·
                listError={queryResult?.errorCode ?? 'none'} · getError=
                {compositeResult.errorCode ?? 'none'}
              </div>
            </div>
          </div>

          <div className="rounded border border-slate-200 dark:border-slate-800 p-2.5 space-y-1.5 text-[11px]">
            <div className="font-semibold text-slate-700 dark:text-slate-300">
              6. Team Creation Rule &amp; Payload Readiness (`firestore.rules` vs `createTeamWithLeader`)
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 font-mono">
              <div className="flex justify-between gap-2 border-b border-slate-100 dark:border-slate-800/60 py-1">
                <span className="text-slate-500 font-sans">Hackathon organizerId:</span>
                <span className="break-all text-end">
                  {selectedHackathon?.organizerId || '(missing)'}
                </span>
              </div>
              <div className="flex justify-between gap-2 border-b border-slate-100 dark:border-slate-800/60 py-1">
                <span className="text-slate-500 font-sans">Rule registration path:</span>
                <span className="break-all text-end">
                  {compositeResult.documentPath || '(none)'}
                </span>
              </div>
              <div className="flex justify-between gap-2 border-b border-slate-100 dark:border-slate-800/60 py-1">
                <span className="text-slate-500 font-sans">hasApprovedRegistration():</span>
                <span>{String(compositeResult.verificationResult)}</span>
              </div>
              <div className="flex justify-between gap-2 border-b border-slate-100 dark:border-slate-800/60 py-1">
                <span className="text-slate-500 font-sans">Payload omits registrationId:</span>
                <span>{String(analysis.approvedCompositeMatchExists)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
