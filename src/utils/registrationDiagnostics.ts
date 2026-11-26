import type {
  CompositeVerificationDiagnosticResult,
  DiagnosticRegistrationRecord,
  UserRegistrationsDiagnosticResult
} from '../services/firebase/firestoreService';
import type { HackathonRegistration } from '../types/domain';

export interface DuplicateRegistrationGroup {
  key: string;
  userId: string;
  hackathonId: string;
  records: DiagnosticRegistrationRecord[];
  statuses: string[];
  hasMixedStatuses: boolean;
}

export interface RegistrationSourceComparisonReport {
  totalRecordsCount: number;
  matchingSelectedCount: number;
  matchingSelectedRecords: DiagnosticRegistrationRecord[];
  duplicatesForSelected: boolean;
  duplicateGroups: DuplicateRegistrationGroup[];
  approvedRecordsForSelected: DiagnosticRegistrationRecord[];
  approvedCompositeMatchExists: boolean;
  discoverResolvedRecord: DiagnosticRegistrationRecord | null;
  builderQueryFirstRecord: DiagnosticRegistrationRecord | null;
  builderStateResolvedRecord: HackathonRegistration | null;
  builderStateCount: number;
  firstVsLastMismatch: boolean;
  queryAndStateMismatch: boolean;
  blockReason: string;
}

export function formatDiagnosticTimestamp(val: unknown): string {
  if (val == null || val === '') return '—';
  if (
    typeof val === 'object' &&
    'toDate' in val &&
    typeof (val as { toDate: () => Date }).toDate === 'function'
  ) {
    try {
      return (val as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return String(val);
    }
  }
  if (typeof val === 'object' && 'seconds' in val) {
    const secs = Number((val as { seconds: unknown }).seconds);
    if (Number.isFinite(secs)) {
      return new Date(secs * 1000).toISOString();
    }
  }
  if (val instanceof Date) {
    return val.toISOString();
  }
  return String(val);
}

export function analyzeRegistrationDiagnostics(params: {
  uid: string;
  emailVerified: boolean;
  selectedHackathonId: string;
  queryResult: UserRegistrationsDiagnosticResult;
  compositeResult: CompositeVerificationDiagnosticResult;
  builderStateRegistrations: HackathonRegistration[];
}): RegistrationSourceComparisonReport {
  const {
    uid,
    emailVerified,
    selectedHackathonId,
    queryResult,
    compositeResult,
    builderStateRegistrations
  } = params;

  const records = queryResult.records;
  const matchingSelectedRecords = selectedHackathonId
    ? records.filter((r) => r.hackathonId === selectedHackathonId)
    : [];

  const groupsMap = new Map<string, DiagnosticRegistrationRecord[]>();
  for (const r of records) {
    const key = `${r.userId}::${r.hackathonId}`;
    const existing = groupsMap.get(key) || [];
    existing.push(r);
    groupsMap.set(key, existing);
  }

  const duplicateGroups: DuplicateRegistrationGroup[] = [];
  for (const [key, group] of groupsMap.entries()) {
    if (group.length > 1) {
      const statuses = group.map((g) => g.status || '(empty)');
      duplicateGroups.push({
        key,
        userId: group[0].userId,
        hackathonId: group[0].hackathonId,
        records: group,
        statuses,
        hasMixedStatuses: new Set(statuses).size > 1
      });
    }
  }

  // Discover Hackathons uses: new Map(registrations.map((r) => [r.hackathonId, r])) -> LAST wins
  const discoverMap = new Map<string, DiagnosticRegistrationRecord>(
    records.map((r) => [r.hackathonId, r])
  );
  const discoverResolvedRecord = selectedHackathonId
    ? discoverMap.get(selectedHackathonId) ?? null
    : null;

  // Builder Workspace uses: registrations.find((r) => r.hackathonId === teamHackathonId) -> FIRST wins
  const builderQueryFirstRecord = selectedHackathonId
    ? records.find((r) => r.hackathonId === selectedHackathonId) ?? null
    : null;

  const builderStateResolvedRecord = selectedHackathonId
    ? builderStateRegistrations.find((r) => r.hackathonId === selectedHackathonId) ?? null
    : null;

  const firstVsLastMismatch = Boolean(
    discoverResolvedRecord &&
      builderQueryFirstRecord &&
      (discoverResolvedRecord.docId !== builderQueryFirstRecord.docId ||
        discoverResolvedRecord.status !== builderQueryFirstRecord.status)
  );

  const queryAndStateMismatch =
    !queryResult.errorCode &&
    (records.length !== builderStateRegistrations.length ||
      Boolean(builderQueryFirstRecord) !== Boolean(builderStateResolvedRecord) ||
      builderQueryFirstRecord?.status !== builderStateResolvedRecord?.status);

  const approvedRecordsForSelected = matchingSelectedRecords.filter(
    (r) => r.status === 'approved'
  );
  const approvedCompositeMatchExists = approvedRecordsForSelected.some(
    (r) => r.docId === compositeResult.expectedCompositeId
  );

  let blockReason: string;
  if (!uid) {
    blockReason = 'User is not authenticated.';
  } else if (!emailVerified) {
    blockReason = 'Authenticated user emailVerified is false (required to create a team).';
  } else if (!selectedHackathonId) {
    blockReason = 'No published hackathon is currently selected in Builder Workspace.';
  } else if (queryResult.errorCode) {
    blockReason = `Registration list query failed (${queryResult.errorCode}: ${queryResult.errorMessage}). Builder Workspace swallows this in .catch(() => []) and leaves registrations empty.`;
  } else if (compositeResult.errorCode) {
    blockReason = `Composite verification read (${compositeResult.documentPath}) failed with Firestore error (${compositeResult.errorCode}: ${compositeResult.errorMessage}). verifyUserRegistrationApproved catches this error and returns false.`;
  } else if (compositeResult.exists === false) {
    if (approvedRecordsForSelected.length > 0) {
      blockReason = `Approved record(s) exist for this hackathon (${approvedRecordsForSelected
        .map((r) => `${r.docId} [status=${r.status}]`)
        .join(', ')}), but NONE matches the required composite document ID "${compositeResult.expectedCompositeId}". Both verifyUserRegistrationApproved() and firestore.rules hasApprovedRegistration() require exact ID "${compositeResult.expectedCompositeId}".`;
    } else if (matchingSelectedRecords.length > 0) {
      blockReason = `Composite document "${compositeResult.expectedCompositeId}" does not exist, and the found record(s) for this hackathon do not have status="approved" (statuses: ${matchingSelectedRecords
        .map((r) => `${r.docId}=${r.status}`)
        .join(', ')}).`;
    } else {
      blockReason = `No registration document exists for UID "${uid}" and hackathon "${selectedHackathonId}" (total user registrations returned: ${records.length}).`;
    }
  } else if (compositeResult.exists === true && !compositeResult.verificationResult) {
    const reasons: string[] = [];
    if (!compositeResult.userIdMatches) {
      reasons.push(
        `userId mismatch (doc has "${compositeResult.storedUserId}", auth UID is "${uid}")`
      );
    }
    if (!compositeResult.hackathonIdMatches) {
      reasons.push(
        `hackathonId mismatch (doc has "${compositeResult.storedHackathonId}", selected hackathon is "${selectedHackathonId}")`
      );
    }
    if (!compositeResult.statusIsApproved) {
      reasons.push(
        `status is "${compositeResult.storedStatus}" instead of "approved"`
      );
    }
    blockReason = `Composite document "${compositeResult.expectedCompositeId}" exists, but failed validation: ${reasons.join('; ')}.`;
  } else if (firstVsLastMismatch) {
    blockReason = `Duplicate records exist for this hackathon causing first-vs-last mismatch: Discover (Map/last) sees ${discoverResolvedRecord?.docId} (${discoverResolvedRecord?.status}), while Builder UI (.find/first) sees ${builderQueryFirstRecord?.docId} (${builderQueryFirstRecord?.status}).`;
  } else if (queryAndStateMismatch) {
    blockReason = `Composite verification passed, but Builder Workspace's cached state (${builderStateRegistrations.length} docs) disagrees with a fresh Firestore query (${records.length} docs).`;
  } else {
    blockReason =
      'All registration checks pass for the selected hackathon and authenticated UID (composite doc exists, IDs match, status="approved").';
  }

  return {
    totalRecordsCount: records.length,
    matchingSelectedCount: matchingSelectedRecords.length,
    matchingSelectedRecords,
    duplicatesForSelected: matchingSelectedRecords.length > 1,
    duplicateGroups,
    approvedRecordsForSelected,
    approvedCompositeMatchExists,
    discoverResolvedRecord,
    builderQueryFirstRecord,
    builderStateResolvedRecord,
    builderStateCount: builderStateRegistrations.length,
    firstVsLastMismatch,
    queryAndStateMismatch,
    blockReason
  };
}
