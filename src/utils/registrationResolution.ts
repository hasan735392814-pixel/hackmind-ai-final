import type { AuditLogEntry, HackathonRegistration, RegistrationStatus } from '../types/domain';

const STATUS_PRIORITY: Record<RegistrationStatus, number> = {
  approved: 4,
  pending: 3,
  rejected: 2,
  withdrawn: 1
};

const VALID_REGISTRATION_STATUSES = new Set<RegistrationStatus>([
  'pending',
  'approved',
  'rejected',
  'withdrawn'
]);

export interface ResolvedRegistrationVerification {
  approved: boolean;
  status: RegistrationStatus | null;
  registrationId: string | null;
  registration: HackathonRegistration | null;
  reason: string;
}

export interface OrganizerRegistrationResolution {
  resolved: HackathonRegistration[];
  duplicateCountByKey: Map<string, number>;
}

/**
 * Authoritatively maps a Firestore registration snapshot to a domain object,
 * always using the Firestore document snapshot ID (`docId`) and never trusting
 * a potentially stale `data.id` field stored inside the document body.
 */
export function mapRegistrationDocData(
  docId: string,
  rawData: Record<string, unknown> | undefined | null
): HackathonRegistration {
  const cleanDocId = typeof docId === 'string' ? docId.trim() : '';
  if (!cleanDocId) {
    throw new Error('Firestore registration snapshot is missing a valid document ID.');
  }
  const safeData = (rawData && typeof rawData === 'object' ? rawData : {}) as Partial<HackathonRegistration>;
  return {
    ...safeData,
    id: cleanDocId
  } as HackathonRegistration;
}

export function extractRegistrationTimestampMs(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  }
  if (typeof value === 'object') {
    if ('toMillis' in value && typeof (value as { toMillis: () => number }).toMillis === 'function') {
      try {
        const ms = (value as { toMillis: () => number }).toMillis();
        return Number.isFinite(ms) ? ms : 0;
      } catch {
        return 0;
      }
    }
    if ('toDate' in value && typeof (value as { toDate: () => Date }).toDate === 'function') {
      try {
        const dt = (value as { toDate: () => Date }).toDate();
        return Number.isNaN(dt.getTime()) ? 0 : dt.getTime();
      } catch {
        return 0;
      }
    }
    if ('seconds' in value) {
      const secs = Number((value as { seconds: unknown }).seconds);
      if (Number.isFinite(secs)) return secs * 1000;
    }
  }
  return 0;
}

function getStatusPriority(status: unknown): number {
  if (typeof status === 'string' && status in STATUS_PRIORITY) {
    return STATUS_PRIORITY[status as RegistrationStatus];
  }
  return 0;
}

/**
 * Selects the authoritative registration record for a given hackathon (and optional userId).
 * Prioritizes:
 *   1. status ('approved' > 'pending' > 'rejected' > 'withdrawn') so stale duplicates cannot hide an approval
 *   2. exact composite document ID (`${hackathonId}_${userId}`)
 *   3. most recent updatedAt / createdAt timestamp
 */
export function selectPreferredRegistration(
  registrations: HackathonRegistration[],
  hackathonId: string,
  userId?: string
): HackathonRegistration | null {
  if (!hackathonId || !Array.isArray(registrations) || registrations.length === 0) {
    return null;
  }

  const matching = registrations.filter((reg) => {
    if (!reg || reg.hackathonId !== hackathonId) return false;
    if (userId && reg.userId !== userId) return false;
    return true;
  });

  if (matching.length === 0) {
    return null;
  }

  const sorted = [...matching].sort((a, b) => {
    const prioDiff = getStatusPriority(b.status) - getStatusPriority(a.status);
    if (prioDiff !== 0) return prioDiff;

    const aCompositeId = `${hackathonId}_${a.userId}`;
    const bCompositeId = `${hackathonId}_${b.userId}`;
    const aIsComposite = a.id === aCompositeId ? 1 : 0;
    const bIsComposite = b.id === bCompositeId ? 1 : 0;
    if (bIsComposite !== aIsComposite) return bIsComposite - aIsComposite;

    const bTime = Math.max(
      extractRegistrationTimestampMs(b.updatedAt),
      extractRegistrationTimestampMs(b.createdAt)
    );
    const aTime = Math.max(
      extractRegistrationTimestampMs(a.updatedAt),
      extractRegistrationTimestampMs(a.createdAt)
    );
    return bTime - aTime;
  });

  return sorted[0];
}

export function indexRegistrationsByHackathon(
  registrations: HackathonRegistration[],
  userId?: string
): Map<string, HackathonRegistration> {
  const result = new Map<string, HackathonRegistration>();
  if (!Array.isArray(registrations) || registrations.length === 0) {
    return result;
  }

  const hackathonIds = new Set<string>();
  for (const reg of registrations) {
    if (!reg?.hackathonId) continue;
    if (userId && reg.userId !== userId) continue;
    hackathonIds.add(reg.hackathonId);
  }

  for (const hackathonId of hackathonIds) {
    const preferred = selectPreferredRegistration(registrations, hackathonId, userId);
    if (preferred) {
      result.set(hackathonId, preferred);
    }
  }

  return result;
}

/**
 * Deterministic resolver for Organizer Studio across all participants and hackathons.
 * Groups by `${hackathonId}::${userId}` and applies the exact same `selectPreferredRegistration`
 * precedence used by Discover and Builder Workspace so all three views agree.
 */
export function indexOrganizerRegistrations(
  registrations: HackathonRegistration[]
): OrganizerRegistrationResolution {
  const duplicateCountByKey = new Map<string, number>();
  if (!Array.isArray(registrations) || registrations.length === 0) {
    return { resolved: [], duplicateCountByKey };
  }

  const groups = new Map<string, HackathonRegistration[]>();
  for (const reg of registrations) {
    if (!reg?.hackathonId || !reg?.userId) continue;
    const key = `${reg.hackathonId}::${reg.userId}`;
    const existing = groups.get(key) || [];
    existing.push(reg);
    groups.set(key, existing);
  }

  const resolved: HackathonRegistration[] = [];
  for (const [key, group] of groups.entries()) {
    duplicateCountByKey.set(key, group.length);
    const sample = group[0];
    const preferred = selectPreferredRegistration(group, sample.hackathonId, sample.userId);
    if (preferred) {
      resolved.push(preferred);
    }
  }

  return { resolved, duplicateCountByKey };
}

export interface ValidateRegistrationTransitionInput {
  currentStatus: unknown;
  nextStatus: RegistrationStatus;
  expectedCurrentStatus?: RegistrationStatus;
  actorRole?: 'organizer' | 'participant' | 'admin';
  confirmed?: boolean;
}

export function validateRegistrationStatusTransition(
  input: ValidateRegistrationTransitionInput
): RegistrationStatus {
  const { currentStatus, nextStatus, expectedCurrentStatus, actorRole, confirmed } = input;

  if (!VALID_REGISTRATION_STATUSES.has(nextStatus)) {
    throw new Error(`Invalid target registration status: "${String(nextStatus)}".`);
  }

  if (
    typeof currentStatus !== 'string' ||
    !VALID_REGISTRATION_STATUSES.has(currentStatus as RegistrationStatus)
  ) {
    throw new Error(`Invalid current registration status in Firestore: "${String(currentStatus)}".`);
  }

  const typedCurrent = currentStatus as RegistrationStatus;

  if (expectedCurrentStatus !== undefined && typedCurrent !== expectedCurrentStatus) {
    throw new Error(
      `Registration status conflict: expected "${expectedCurrentStatus}", but Firestore currently has "${typedCurrent}". Refresh and try again.`
    );
  }

  if (nextStatus === 'withdrawn') {
    if (!confirmed) {
      throw new Error('Explicit participant confirmation is required before withdrawing a registration.');
    }
    if (expectedCurrentStatus === undefined) {
      throw new Error(
        'Cannot withdraw registration without verifying its current status (stale state protection).'
      );
    }
    if (typedCurrent === 'withdrawn') {
      throw new Error('Registration is already withdrawn.');
    }
    if (typedCurrent === 'rejected') {
      throw new Error('A rejected registration cannot be transitioned to withdrawn.');
    }
  }

  if (actorRole === 'participant') {
    if (typedCurrent === 'rejected') {
      throw new Error(
        'Your registration for this hackathon was rejected and cannot be modified or self-approved.'
      );
    }
    if (nextStatus === 'approved' && typedCurrent !== 'pending' && typedCurrent !== 'withdrawn') {
      throw new Error('Registration is already approved.');
    }
  }

  if (actorRole === 'organizer' && (nextStatus === 'approved' || nextStatus === 'rejected')) {
    if (typedCurrent === 'withdrawn') {
      throw new Error(
        'Cannot approve or reject a registration that has already been withdrawn by the participant.'
      );
    }
  }

  return typedCurrent;
}

export function buildRegistrationWithdrawalAuditEntry(params: {
  actorId: string;
  actorName?: string;
  registrationId: string;
  hackathonId: string;
  previousStatus: RegistrationStatus;
}): Omit<AuditLogEntry, 'id' | 'createdAt'> {
  const actorId = params.actorId.trim();
  const registrationId = params.registrationId.trim();
  const hackathonId = params.hackathonId.trim();

  if (!actorId) {
    throw new Error('Audit validation failed: actorId is required for withdrawal audit log.');
  }
  if (!registrationId) {
    throw new Error('Audit validation failed: registrationId is required for withdrawal audit log.');
  }
  if (!hackathonId) {
    throw new Error('Audit validation failed: hackathonId is required for withdrawal audit log.');
  }
  if (params.previousStatus !== 'pending' && params.previousStatus !== 'approved') {
    throw new Error(
      `Audit validation failed: invalid previous status "${params.previousStatus}" for withdrawal.`
    );
  }

  const actorLabel = (params.actorName || '').trim() || 'Participant';
  return {
    actorId,
    actorName: actorLabel.slice(0, 100),
    action: 'registration_withdrawn',
    targetCollection: 'registrations',
    targetId: registrationId,
    hackathonId,
    details: `${actorLabel} (${actorId}) confirmed withdrawal (${params.previousStatus} -> withdrawn).`
  };
}

export function formatActionableError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!raw) return fallback;

  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; path?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        const pathSuffix =
          typeof parsed.path === 'string' && parsed.path.trim() ? ` (${parsed.path})` : '';
        return `${parsed.error}${pathSuffix}`;
      }
    } catch {
      // Fall through to raw message
    }
  }
  return raw;
}

