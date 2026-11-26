import {
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from './config';
import {
  deriveJoinCodeProofAndVerifier,
  generateFirestoreId,
  generateSecureJoinToken,
  isDeadlinePassed,
  isValidInternalAppLink,
  normalizeJoinToken,
  sanitizeString,
  sanitizeStringArray
} from '../../utils/validation';
import {
  buildRegistrationWithdrawalAuditEntry,
  mapRegistrationDocData,
  selectPreferredRegistration,
  validateRegistrationStatusTransition,
  type ResolvedRegistrationVerification
} from '../../utils/registrationResolution';
import type {
  AccountRole,
  AIUsageRecord,
  AppNotification,
  AuditLogEntry,
  CriterionScore,
  Evaluation,
  Hackathon,
  HackathonRegistration,
  HackathonResults,
  JudgeAssignment,
  NormalizedEvaluationCriterionDoc,
  Project,
  ProjectSubmission,
  RegistrationStatus,
  RubricCriterion,
  SponsorRecord,
  SponsorStatus,
  Team,
  TeamInvitation,
  TeamMemberRecord,
  UserPrivateInfo,
  UserProfile
} from '../../types/domain';
import {
  calculateWeightedTotal,
  calculateWeightedTotalStrict,
  hydrateEvaluationScoresAndTotal
} from '../judging/fairJudgingEngine';

// --- Admin Check ---
export async function checkIsAdminUser(uid: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, 'admins', uid));
    return snap.exists();
  } catch {
    return false;
  }
}

// --- User Profile & Private PII ---
export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const path = `users/${uid}`;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? (snap.data() as UserProfile) : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function getUserPrivateInfo(uid: string): Promise<UserPrivateInfo | null> {
  const path = `users/${uid}/private/info`;
  try {
    const snap = await getDoc(doc(db, 'users', uid, 'private', 'info'));
    return snap.exists() ? (snap.data() as UserPrivateInfo) : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function upsertUserProfile(
  profile: Omit<UserProfile, 'approvedRole' | 'createdAt' | 'updatedAt'>,
  isNew: boolean,
  options?: { ensureParticipantRoleIfMissing?: boolean }
): Promise<void> {
  const path = `users/${profile.uid}`;
  const requestedRole: AccountRole =
    profile.requestedRole === 'organizer' ||
    profile.requestedRole === 'judge' ||
    profile.requestedRole === 'sponsor'
      ? profile.requestedRole
      : 'participant';

  const cleanPayload = {
    uid: profile.uid,
    displayName: sanitizeString(profile.displayName || 'Builder', 80),
    title: sanitizeString(profile.title || '', 100),
    bio: sanitizeString(profile.bio || '', 1000),
    skills: sanitizeStringArray(profile.skills || [], 15, 40),
    experienceLevel: profile.experienceLevel || 'intermediate',
    interests: sanitizeStringArray(profile.interests || [], 10, 50),
    preferredRoles: sanitizeStringArray(profile.preferredRoles || [], 6, 50),
    preferredLanguages: sanitizeStringArray(profile.preferredLanguages || [], 10, 40),
    availability: profile.availability || 'full_time',
    teamPreference: profile.teamPreference || 'looking_for_team',
    portfolioUrl: sanitizeString(profile.portfolioUrl || '', 300),
    githubUrl: sanitizeString(profile.githubUrl || '', 300),
    linkedinUrl: sanitizeString(profile.linkedinUrl || '', 300),
    photoUrl: sanitizeString(profile.photoUrl || '', 500),
    requestedRole
  };

  try {
    if (isNew) {
      await setDoc(doc(db, 'users', profile.uid), {
        ...cleanPayload,
        approvedRole: 'participant',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } else {
      await updateDoc(doc(db, 'users', profile.uid), {
        displayName: cleanPayload.displayName,
        title: cleanPayload.title,
        bio: cleanPayload.bio,
        skills: cleanPayload.skills,
        experienceLevel: cleanPayload.experienceLevel,
        interests: cleanPayload.interests,
        preferredRoles: cleanPayload.preferredRoles,
        preferredLanguages: cleanPayload.preferredLanguages,
        availability: cleanPayload.availability,
        teamPreference: cleanPayload.teamPreference,
        portfolioUrl: cleanPayload.portfolioUrl,
        githubUrl: cleanPayload.githubUrl,
        linkedinUrl: cleanPayload.linkedinUrl,
        photoUrl: cleanPayload.photoUrl,
        requestedRole: cleanPayload.requestedRole,
        ...(options?.ensureParticipantRoleIfMissing ? { approvedRole: 'participant' } : {}),
        updatedAt: serverTimestamp()
      });
    }
  } catch (err) {
    handleFirestoreError(err, isNew ? OperationType.CREATE : OperationType.UPDATE, path);
  }
}

export async function adminUpdateUserApprovedRole(
  targetUid: string,
  approvedRole: AccountRole
): Promise<void> {
  const path = `users/${targetUid}`;
  try {
    await updateDoc(doc(db, 'users', targetUid), {
      approvedRole,
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function listPendingRoleRequestsForAdmin(): Promise<UserProfile[]> {
  const path = 'users';
  try {
    const q = query(
      collection(db, 'users'),
      where('requestedRole', 'in', ['organizer', 'judge', 'sponsor'])
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as UserProfile);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function adminListAllUsers(): Promise<UserProfile[]> {
  const path = 'users';
  try {
    const snap = await getDocs(collection(db, 'users'));
    return snap.docs.map((d) => d.data() as UserProfile);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function upsertUserPrivateInfo(info: Omit<UserPrivateInfo, 'updatedAt'>, isNew: boolean): Promise<void> {
  const path = `users/${info.uid}/private/info`;
  const payload = {
    uid: info.uid,
    email: sanitizeString(info.email, 200),
    notificationsEnabled: Boolean(info.notificationsEnabled),
    aiCloudConsent: Boolean(info.aiCloudConsent),
    preferredLocale: info.preferredLocale === 'ar' ? 'ar' : 'en',
    updatedAt: serverTimestamp()
  };
  try {
    if (isNew) {
      await setDoc(doc(db, 'users', info.uid, 'private', 'info'), payload);
    } else {
      await updateDoc(doc(db, 'users', info.uid, 'private', 'info'), payload);
    }
  } catch (err) {
    handleFirestoreError(err, isNew ? OperationType.CREATE : OperationType.UPDATE, path);
  }
}

export async function listTeamMatchingCandidates(): Promise<UserProfile[]> {
  const path = 'users';
  try {
    const q = query(
      collection(db, 'users'),
      where('teamPreference', 'in', ['looking_for_team', 'open_to_join'])
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as UserProfile);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function listJudgeDirectory(): Promise<UserProfile[]> {
  const path = 'users';
  try {
    const q = query(collection(db, 'users'), where('approvedRole', '==', 'judge'));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as UserProfile);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

// --- Hackathons ---
export function normalizeHackathonDoc(docId: string, raw: Partial<Hackathon>): Hackathon {
  const cleanId =
    (typeof docId === 'string' && docId.trim()) ||
    (typeof raw.id === 'string' && raw.id.trim()) ||
    '';
  const validStatus: Hackathon['status'] =
    raw.status === 'published' ||
    raw.status === 'judging' ||
    raw.status === 'completed' ||
    raw.status === 'draft'
      ? raw.status
      : 'draft';
  const validMode: Hackathon['mode'] =
    raw.mode === 'in_person' || raw.mode === 'hybrid' || raw.mode === 'online'
      ? raw.mode
      : 'online';

  return {
    id: cleanId,
    organizerId: typeof raw.organizerId === 'string' ? raw.organizerId : '',
    organizerName: typeof raw.organizerName === 'string' ? raw.organizerName : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    tagline: typeof raw.tagline === 'string' ? raw.tagline : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    coverImageUrl: typeof raw.coverImageUrl === 'string' ? raw.coverImageUrl : '',
    startDate: typeof raw.startDate === 'string' ? raw.startDate : '',
    endDate: typeof raw.endDate === 'string' ? raw.endDate : '',
    registrationDeadline: typeof raw.registrationDeadline === 'string' ? raw.registrationDeadline : '',
    submissionDeadline: typeof raw.submissionDeadline === 'string' ? raw.submissionDeadline : '',
    ...(raw.registrationDeadlineAt !== undefined
      ? { registrationDeadlineAt: raw.registrationDeadlineAt }
      : {}),
    ...(raw.submissionDeadlineAt !== undefined
      ? { submissionDeadlineAt: raw.submissionDeadlineAt }
      : {}),
    mode: validMode,
    location: typeof raw.location === 'string' ? raw.location : '',
    tracks: Array.isArray(raw.tracks) ? raw.tracks.filter((t): t is string => typeof t === 'string') : [],
    technologies: Array.isArray(raw.technologies)
      ? raw.technologies.filter((t): t is string => typeof t === 'string')
      : [],
    eligibility: typeof raw.eligibility === 'string' ? raw.eligibility : '',
    rules: typeof raw.rules === 'string' ? raw.rules : '',
    prizes: Array.isArray(raw.prizes) ? raw.prizes.filter((p): p is string => typeof p === 'string') : [],
    sponsors: Array.isArray(raw.sponsors)
      ? raw.sponsors.filter((s): s is string => typeof s === 'string')
      : [],
    rubric: Array.isArray(raw.rubric) ? raw.rubric : [],
    maxTeamSize:
      typeof raw.maxTeamSize === 'number' && Number.isFinite(raw.maxTeamSize) && raw.maxTeamSize >= 1
        ? raw.maxTeamSize
        : 4,
    status: validStatus,
    resultsPublished: Boolean(raw.resultsPublished),
    ...(raw.createdAt !== undefined ? { createdAt: raw.createdAt } : {}),
    ...(raw.updatedAt !== undefined ? { updatedAt: raw.updatedAt } : {})
  };
}

export interface HackathonsDiagnosticsReport {
  collectionPath: 'hackathons';
  retrievedCount: number;
  statusDistribution: {
    published: number;
    judging: number;
    completed: number;
  };
  queryErrors: string[];
}

export async function runHackathonsDiagnostics(): Promise<HackathonsDiagnosticsReport> {
  const statuses: Array<'published' | 'judging' | 'completed'> = [
    'published',
    'judging',
    'completed'
  ];
  const distribution = { published: 0, judging: 0, completed: 0 };
  const queryErrors: string[] = [];

  const results = await Promise.allSettled(
    statuses.map((st) => getDocs(query(collection(db, 'hackathons'), where('status', '==', st))))
  );

  results.forEach((res, idx) => {
    const statusKey = statuses[idx];
    if (res.status === 'fulfilled') {
      distribution[statusKey] = res.value.docs.length;
    } else {
      const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
      queryErrors.push(`status=${statusKey}: ${msg}`);
    }
  });

  return {
    collectionPath: 'hackathons',
    retrievedCount: distribution.published + distribution.judging + distribution.completed,
    statusDistribution: distribution,
    queryErrors
  };
}

export async function listPublishedHackathons(): Promise<Hackathon[]> {
  const path = 'hackathons';
  try {
    const [pubSnap, judgeSnap, compSnap] = await Promise.all([
      getDocs(query(collection(db, 'hackathons'), where('status', '==', 'published'))),
      getDocs(query(collection(db, 'hackathons'), where('status', '==', 'judging'))),
      getDocs(query(collection(db, 'hackathons'), where('status', '==', 'completed')))
    ]);

    const map = new Map<string, Hackathon>();
    for (const snap of [pubSnap, judgeSnap, compSnap]) {
      for (const d of snap.docs) {
        const h = normalizeHackathonDoc(d.id, d.data() as Partial<Hackathon>);
        map.set(h.id, h);
      }
    }
    return Array.from(map.values());
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function listOrganizerHackathons(organizerId: string): Promise<Hackathon[]> {
  const path = 'hackathons';
  try {
    const q = query(collection(db, 'hackathons'), where('organizerId', '==', organizerId));
    const snap = await getDocs(q);
    return snap.docs.map((d) => normalizeHackathonDoc(d.id, d.data() as Partial<Hackathon>));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function adminListAllHackathons(): Promise<Hackathon[]> {
  const path = 'hackathons';
  try {
    const snap = await getDocs(collection(db, 'hackathons'));
    return snap.docs.map((d) => normalizeHackathonDoc(d.id, d.data() as Partial<Hackathon>));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function adminUpdateHackathonStatus(
  hackathonId: string,
  status: Hackathon['status']
): Promise<void> {
  const path = `hackathons/${hackathonId}`;
  try {
    await updateDoc(doc(db, 'hackathons', hackathonId), {
      status,
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function getHackathonById(hackathonId: string): Promise<Hackathon | null> {
  const path = `hackathons/${hackathonId}`;
  try {
    const snap = await getDoc(doc(db, 'hackathons', hackathonId));
    return snap.exists()
      ? normalizeHackathonDoc(snap.id, snap.data() as Partial<Hackathon>)
      : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

function parseOptionalDeadlineTimestamp(isoDateOrDatetime: string): Timestamp | null {
  const trimmed = isoDateOrDatetime.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return Timestamp.fromDate(parsed);
}

export async function saveHackathon(
  hackathon: Omit<Hackathon, 'createdAt' | 'updatedAt'>,
  isNew: boolean
): Promise<void> {
  const path = `hackathons/${hackathon.id}`;
  const regAt = parseOptionalDeadlineTimestamp(hackathon.registrationDeadline || '');
  const subAt = parseOptionalDeadlineTimestamp(hackathon.submissionDeadline || '');

  const payload = {
    id: hackathon.id,
    organizerId: hackathon.organizerId,
    organizerName: sanitizeString(hackathon.organizerName, 100) || 'Organizer',
    title: sanitizeString(hackathon.title, 140),
    tagline: sanitizeString(hackathon.tagline || '', 200),
    description: sanitizeString(hackathon.description, 8000),
    coverImageUrl: sanitizeString(hackathon.coverImageUrl || '', 500),
    startDate: sanitizeString(hackathon.startDate || '', 40),
    endDate: sanitizeString(hackathon.endDate || '', 40),
    registrationDeadline: sanitizeString(hackathon.registrationDeadline || '', 40),
    submissionDeadline: sanitizeString(hackathon.submissionDeadline || '', 40),
    ...(regAt ? { registrationDeadlineAt: regAt } : {}),
    ...(subAt ? { submissionDeadlineAt: subAt } : {}),
    mode: hackathon.mode,
    location: sanitizeString(hackathon.location || '', 200),
    tracks: sanitizeStringArray(hackathon.tracks || [], 12, 80),
    technologies: sanitizeStringArray(hackathon.technologies || [], 15, 50),
    eligibility: sanitizeString(hackathon.eligibility || '', 3000),
    rules: sanitizeString(hackathon.rules || '', 6000),
    prizes: sanitizeStringArray(hackathon.prizes || [], 10, 120),
    sponsors: sanitizeStringArray(hackathon.sponsors || [], 10, 100),
    rubric: (hackathon.rubric || []).slice(0, 10),
    maxTeamSize: Math.min(10, Math.max(1, Math.round(hackathon.maxTeamSize || 4))),
    status: hackathon.status,
    resultsPublished: Boolean(hackathon.resultsPublished)
  };

  try {
    if (isNew) {
      await setDoc(doc(db, 'hackathons', hackathon.id), {
        ...payload,
        resultsPublished: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } else {
      const { id: _id, organizerId: _org, ...updatable } = payload;
      await updateDoc(doc(db, 'hackathons', hackathon.id), {
        ...updatable,
        updatedAt: serverTimestamp()
      });
    }
  } catch (err) {
    handleFirestoreError(err, isNew ? OperationType.CREATE : OperationType.UPDATE, path);
  }
}

export async function deleteDraftHackathon(hackathonId: string): Promise<void> {
  const path = `hackathons/${hackathonId}`;
  try {
    await deleteDoc(doc(db, 'hackathons', hackathonId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

// --- Registrations ---
function assertHackathonDocEligibleForRegistration(
  hackData: (Partial<Hackathon> & { registrationDeadlineAt?: { toMillis?: () => number } }) | undefined
): void {
  if (!hackData) {
    throw new Error('Selected hackathon does not exist.');
  }
  if (hackData.status !== 'published') {
    throw new Error('Registration is only available while the hackathon is published.');
  }
  if (isDeadlinePassed(hackData.registrationDeadline || '')) {
    throw new Error('The registration deadline for this hackathon has passed.');
  }
  if (
    hackData.registrationDeadlineAt &&
    typeof hackData.registrationDeadlineAt.toMillis === 'function' &&
    Date.now() > hackData.registrationDeadlineAt.toMillis()
  ) {
    throw new Error('The registration deadline for this hackathon has passed.');
  }
}

export async function registerForHackathon(
  reg: Omit<HackathonRegistration, 'id' | 'status' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const currentUid = auth?.currentUser?.uid;
  if (!reg.userId || (currentUid && currentUid !== reg.userId)) {
    throw new Error('Cannot register on behalf of another user.');
  }
  await ensureVerifiedAuthClaimForWrite(reg.userId);

  const id = `${reg.hackathonId}_${reg.userId}`;
  const path = `registrations/${id}`;
  try {
    const hackSnap = await getDoc(doc(db, 'hackathons', reg.hackathonId));
    if (!hackSnap.exists()) {
      throw new Error('Selected hackathon does not exist.');
    }
    const hackData = hackSnap.data() as Partial<Hackathon> & {
      registrationDeadlineAt?: { toMillis?: () => number };
    };
    assertHackathonDocEligibleForRegistration(hackData);

    // Prevent duplicate registrations across composite and legacy non-composite records
    const existingRegs = await listUserRegistrations(reg.userId);
    const preferredExisting = selectPreferredRegistration(existingRegs, reg.hackathonId, reg.userId);
    if (preferredExisting) {
      if (preferredExisting.status === 'rejected') {
        throw new Error(
          'Your registration for this hackathon was rejected and cannot be re-submitted.'
        );
      }
      if (preferredExisting.status === 'approved') {
        throw new Error('You are already registered and approved for this hackathon.');
      }
      if (preferredExisting.status === 'pending') {
        await approveOwnPendingRegistration(preferredExisting.id, {
          preferredTrack: reg.preferredTrack,
          motivation: reg.motivation
        });
        return preferredExisting.id;
      }
      if (preferredExisting.status === 'withdrawn') {
        await reapplyForHackathon(preferredExisting.id, {
          preferredTrack: reg.preferredTrack,
          motivation: reg.motivation
        });
        return preferredExisting.id;
      }
    }

    const regRef = doc(db, 'registrations', id);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(regRef);
      if (snap.exists()) {
        const currentData = snap.data() as Partial<HackathonRegistration> | undefined;
        if (currentData?.status === 'rejected') {
          throw new Error(
            'Your registration for this hackathon was rejected and cannot be re-submitted.'
          );
        }
        if (currentData?.status === 'approved') {
          throw new Error('You are already registered and approved for this hackathon.');
        }
        if (currentData?.status === 'pending' || currentData?.status === 'withdrawn') {
          tx.update(regRef, {
            preferredTrack: sanitizeString(reg.preferredTrack || '', 100),
            motivation: sanitizeString(reg.motivation || '', 1500),
            status: 'approved',
            updatedAt: serverTimestamp()
          });
          return;
        }
      }
      tx.set(regRef, {
        id,
        hackathonId: reg.hackathonId,
        organizerId: hackData.organizerId || reg.organizerId,
        userId: reg.userId,
        userName: sanitizeString(reg.userName || 'Participant', 100) || 'Participant',
        userTitle: sanitizeString(reg.userTitle || '', 100),
        preferredTrack: sanitizeString(reg.preferredTrack || '', 100),
        motivation: sanitizeString(reg.motivation || '', 1500),
        status: 'approved',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    });
    return id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function listUserRegistrations(userId: string): Promise<HackathonRegistration[]> {
  const path = 'registrations';
  try {
    const q = query(collection(db, 'registrations'), where('userId', '==', userId));
    const snap = await getDocs(q);
    return snap.docs.map((d) => mapRegistrationDocData(d.id, d.data() as Record<string, unknown>));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function resolveApprovedRegistrationForHackathon(
  userId: string,
  hackathonId: string
): Promise<ResolvedRegistrationVerification> {
  if (!userId) {
    return {
      approved: false,
      status: null,
      registrationId: null,
      registration: null,
      reason: 'Authenticated participant account is required.'
    };
  }
  if (!hackathonId) {
    return {
      approved: false,
      status: null,
      registrationId: null,
      registration: null,
      reason: 'Select a hackathon first.'
    };
  }

  const compositeId = `${hackathonId}_${userId}`;
  const path = `registrations/${compositeId}`;
  let compositeRecord: HackathonRegistration | null = null;

  try {
    const snap = await getDoc(doc(db, 'registrations', compositeId));
    if (snap.exists()) {
      compositeRecord = mapRegistrationDocData(
        snap.id || compositeId,
        snap.data() as Record<string, unknown>
      );
      if (
        compositeRecord.userId === userId &&
        compositeRecord.hackathonId === hackathonId &&
        compositeRecord.status === 'approved'
      ) {
        return {
          approved: true,
          status: 'approved',
          registrationId: compositeRecord.id,
          registration: compositeRecord,
          reason: 'Approved registration verified.'
        };
      }
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }

  // Fallback / duplicate reconciliation: query all registrations for userId
  // so approved non-composite docs or mixed-status duplicates are handled deterministically.
  const userRegs = await listUserRegistrations(userId);
  const byId = new Map<string, HackathonRegistration>();
  for (const reg of userRegs) {
    if (reg.id) {
      byId.set(reg.id, reg);
    }
  }
  if (
    compositeRecord &&
    compositeRecord.userId === userId &&
    compositeRecord.hackathonId === hackathonId &&
    !byId.has(compositeRecord.id)
  ) {
    byId.set(compositeRecord.id, compositeRecord);
  }

  const preferred = selectPreferredRegistration(Array.from(byId.values()), hackathonId, userId);
  if (!preferred) {
    return {
      approved: false,
      status: null,
      registrationId: null,
      registration: null,
      reason:
        'No registration found for this hackathon. Register for this hackathon before creating or joining a team.'
    };
  }

  if (preferred.status === 'approved') {
    return {
      approved: true,
      status: 'approved',
      registrationId: preferred.id,
      registration: preferred,
      reason: 'Approved registration verified.'
    };
  }

  if (preferred.status === 'pending') {
    return {
      approved: false,
      status: 'pending',
      registrationId: preferred.id,
      registration: preferred,
      reason:
        'Your pending registration must be confirmed before creating or joining a team for this hackathon.'
    };
  }

  if (preferred.status === 'rejected') {
    return {
      approved: false,
      status: 'rejected',
      registrationId: preferred.id,
      registration: preferred,
      reason: 'Your registration for this hackathon was rejected by the organizer.'
    };
  }

  return {
    approved: false,
    status: preferred.status,
    registrationId: preferred.id,
    registration: preferred,
    reason:
      'Your registration for this hackathon was withdrawn. Re-apply before the deadline to create or join a team.'
  };
}

export async function verifyUserRegistrationApproved(
  userId: string,
  hackathonId: string
): Promise<boolean> {
  const resolved = await resolveApprovedRegistrationForHackathon(userId, hackathonId);
  return resolved.approved;
}

export interface DiagnosticRegistrationRecord {
  docId: string;
  docPath: string;
  dataId: string;
  hackathonId: string;
  userId: string;
  status: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface UserRegistrationsDiagnosticResult {
  records: DiagnosticRegistrationRecord[];
  errorCode: string | null;
  errorMessage: string | null;
}

export interface CompositeVerificationDiagnosticResult {
  expectedCompositeId: string;
  documentPath: string;
  readSucceeded: boolean;
  exists: boolean | null;
  actualDocId: string | null;
  storedDataId: string | null;
  storedUserId: string | null;
  storedHackathonId: string | null;
  storedStatus: string | null;
  userIdMatches: boolean;
  hackathonIdMatches: boolean;
  statusIsApproved: boolean;
  verificationResult: boolean;
  verifyFnResult: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

function extractFirestoreErrorDetails(err: unknown): { code: string; message: string } {
  if (err && typeof err === 'object') {
    const maybeCode = 'code' in err ? String((err as { code?: unknown }).code || '') : '';
    const maybeMessage =
      'message' in err ? String((err as { message?: unknown }).message || '') : String(err);
    return {
      code: maybeCode || 'unknown',
      message: maybeMessage || String(err)
    };
  }
  return {
    code: 'unknown',
    message: String(err)
  };
}

export async function inspectUserRegistrationsForDiagnostics(
  userId: string
): Promise<UserRegistrationsDiagnosticResult> {
  if (!userId) {
    return {
      records: [],
      errorCode: 'unauthenticated',
      errorMessage: 'No authenticated user UID available.'
    };
  }
  try {
    const q = query(collection(db, 'registrations'), where('userId', '==', userId));
    const snap = await getDocs(q);
    const records: DiagnosticRegistrationRecord[] = snap.docs.map((d) => {
      const data = d.data() as Partial<HackathonRegistration>;
      return {
        docId: d.id,
        docPath: d.ref?.path || `registrations/${d.id}`,
        dataId: typeof data.id === 'string' ? data.id : '',
        hackathonId: typeof data.hackathonId === 'string' ? data.hackathonId : '',
        userId: typeof data.userId === 'string' ? data.userId : '',
        status: typeof data.status === 'string' ? data.status : '',
        createdAt: data.createdAt ?? null,
        updatedAt: data.updatedAt ?? null
      };
    });
    return { records, errorCode: null, errorMessage: null };
  } catch (err) {
    const { code, message } = extractFirestoreErrorDetails(err);
    return { records: [], errorCode: code, errorMessage: message };
  }
}

export async function inspectCompositeRegistrationForDiagnostics(
  userId: string,
  hackathonId: string
): Promise<CompositeVerificationDiagnosticResult> {
  const expectedCompositeId = hackathonId && userId ? `${hackathonId}_${userId}` : '';
  const documentPath = expectedCompositeId ? `registrations/${expectedCompositeId}` : '';

  if (!userId || !hackathonId) {
    return {
      expectedCompositeId,
      documentPath,
      readSucceeded: false,
      exists: null,
      actualDocId: null,
      storedDataId: null,
      storedUserId: null,
      storedHackathonId: null,
      storedStatus: null,
      userIdMatches: false,
      hackathonIdMatches: false,
      statusIsApproved: false,
      verificationResult: false,
      verifyFnResult: false,
      errorCode: 'missing-parameters',
      errorMessage: !userId
        ? 'Authenticated UID is missing.'
        : 'Selected hackathon ID is empty.'
    };
  }

  let verifyFnResult: boolean;
  try {
    verifyFnResult = await verifyUserRegistrationApproved(userId, hackathonId);
  } catch {
    verifyFnResult = false;
  }

  try {
    const snap = await getDoc(doc(db, 'registrations', expectedCompositeId));
    if (!snap.exists()) {
      return {
        expectedCompositeId,
        documentPath,
        readSucceeded: true,
        exists: false,
        actualDocId: null,
        storedDataId: null,
        storedUserId: null,
        storedHackathonId: null,
        storedStatus: null,
        userIdMatches: false,
        hackathonIdMatches: false,
        statusIsApproved: false,
        verificationResult: false,
        verifyFnResult,
        errorCode: null,
        errorMessage: null
      };
    }

    const data = snap.data() as Partial<HackathonRegistration>;
    const storedUserId = typeof data.userId === 'string' ? data.userId : null;
    const storedHackathonId = typeof data.hackathonId === 'string' ? data.hackathonId : null;
    const storedStatus = typeof data.status === 'string' ? data.status : null;
    const storedDataId = typeof data.id === 'string' ? data.id : null;
    const userIdMatches = storedUserId === userId;
    const hackathonIdMatches = storedHackathonId === hackathonId;
    const statusIsApproved = storedStatus === 'approved';

    return {
      expectedCompositeId,
      documentPath,
      readSucceeded: true,
      exists: true,
      actualDocId: snap.id,
      storedDataId,
      storedUserId,
      storedHackathonId,
      storedStatus,
      userIdMatches,
      hackathonIdMatches,
      statusIsApproved,
      verificationResult: userIdMatches && hackathonIdMatches && statusIsApproved,
      verifyFnResult,
      errorCode: null,
      errorMessage: null
    };
  } catch (err) {
    const { code, message } = extractFirestoreErrorDetails(err);
    return {
      expectedCompositeId,
      documentPath,
      readSucceeded: false,
      exists: null,
      actualDocId: null,
      storedDataId: null,
      storedUserId: null,
      storedHackathonId: null,
      storedStatus: null,
      userIdMatches: false,
      hackathonIdMatches: false,
      statusIsApproved: false,
      verificationResult: false,
      verifyFnResult,
      errorCode: code,
      errorMessage: message
    };
  }
}

export async function listOrganizerRegistrations(organizerId: string): Promise<HackathonRegistration[]> {
  const path = 'registrations';
  try {
    const q = query(collection(db, 'registrations'), where('organizerId', '==', organizerId));
    const snap = await getDocs(q);
    return snap.docs.map((d) => mapRegistrationDocData(d.id, d.data() as Record<string, unknown>));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export interface UpdateRegistrationStatusOptions {
  expectedCurrentStatus?: RegistrationStatus;
  actorRole?: 'organizer' | 'participant' | 'admin';
  confirmed?: boolean;
}

export async function updateRegistrationStatus(
  registrationId: string,
  status: HackathonRegistration['status'],
  options?: UpdateRegistrationStatusOptions
): Promise<void> {
  const cleanId = typeof registrationId === 'string' ? registrationId.trim() : '';
  if (!cleanId) {
    throw new Error('Registration document ID is required.');
  }
  const path = `registrations/${cleanId}`;
  try {
    const regRef = doc(db, 'registrations', cleanId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(regRef);
      if (!snap.exists()) {
        throw new Error(`Registration "${cleanId}" does not exist in Firestore.`);
      }
      const currentData = snap.data() as Partial<HackathonRegistration> | undefined;
      validateRegistrationStatusTransition({
        currentStatus: currentData?.status,
        nextStatus: status,
        expectedCurrentStatus: options?.expectedCurrentStatus,
        actorRole: options?.actorRole,
        confirmed: options?.confirmed
      });
      tx.update(regRef, {
        status,
        updatedAt: serverTimestamp()
      });
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function withdrawParticipantRegistration(params: {
  registration: HackathonRegistration;
  actorId: string;
  actorName?: string;
  confirmed: boolean;
}): Promise<{ previousStatus: RegistrationStatus; registrationId: string }> {
  const { registration, actorId, actorName, confirmed } = params;
  if (!confirmed) {
    throw new Error('Explicit confirmation is required before withdrawing a registration.');
  }
  if (!actorId || registration.userId !== actorId) {
    throw new Error('You can only withdraw your own registration.');
  }
  await ensureVerifiedAuthClaimForWrite(actorId);
  if (!registration.id) {
    throw new Error('Registration document ID is missing.');
  }

  const auditEntry = buildRegistrationWithdrawalAuditEntry({
    actorId,
    actorName,
    registrationId: registration.id,
    hackathonId: registration.hackathonId,
    previousStatus: registration.status
  });

  await updateRegistrationStatus(registration.id, 'withdrawn', {
    expectedCurrentStatus: registration.status,
    actorRole: 'participant',
    confirmed: true
  });

  // Record audit event non-fatally if Firestore rules in the current phase do not yet whitelist 'registration_withdrawn'
  await recordAuditLog(auditEntry).catch(() => {});

  return {
    previousStatus: registration.status,
    registrationId: registration.id
  };
}

export async function approveOwnPendingRegistration(
  registrationId: string,
  params?: { preferredTrack?: string; motivation?: string }
): Promise<void> {
  const cleanId = typeof registrationId === 'string' ? registrationId.trim() : '';
  if (!cleanId) {
    throw new Error('Registration document ID is required.');
  }
  const currentUid = auth?.currentUser?.uid;
  if (currentUid) {
    await ensureVerifiedAuthClaimForWrite(currentUid);
  }
  const path = `registrations/${cleanId}`;
  try {
    const regRef = doc(db, 'registrations', cleanId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(regRef);
      if (!snap.exists()) {
        throw new Error(`Registration "${cleanId}" does not exist in Firestore.`);
      }
      const currentData = snap.data() as Partial<HackathonRegistration> | undefined;
      if (currentUid && currentData?.userId && currentData.userId !== currentUid) {
        throw new Error('You can only confirm your own registration.');
      }
      validateRegistrationStatusTransition({
        currentStatus: currentData?.status,
        nextStatus: 'approved',
        expectedCurrentStatus: 'pending',
        actorRole: 'participant'
      });
      if (currentData?.hackathonId) {
        const hackSnap = await tx.get(doc(db, 'hackathons', currentData.hackathonId));
        if (!hackSnap.exists()) {
          throw new Error('Selected hackathon does not exist.');
        }
        assertHackathonDocEligibleForRegistration(
          hackSnap.data() as Partial<Hackathon> & {
            registrationDeadlineAt?: { toMillis?: () => number };
          }
        );
      }
      const updates: Record<string, unknown> = {
        status: 'approved',
        updatedAt: serverTimestamp()
      };
      if (params?.preferredTrack !== undefined) {
        updates.preferredTrack = sanitizeString(params.preferredTrack || 'General', 100);
      }
      if (params?.motivation !== undefined) {
        updates.motivation = sanitizeString(params.motivation || '', 1500);
      }
      tx.update(regRef, updates);
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function reapplyForHackathon(
  registrationId: string,
  params: { preferredTrack: string; motivation: string }
): Promise<void> {
  const cleanId = typeof registrationId === 'string' ? registrationId.trim() : '';
  if (!cleanId) {
    throw new Error('Registration document ID is required.');
  }
  const currentUid = auth?.currentUser?.uid;
  if (currentUid) {
    await ensureVerifiedAuthClaimForWrite(currentUid);
  }
  const path = `registrations/${cleanId}`;
  try {
    const regRef = doc(db, 'registrations', cleanId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(regRef);
      if (!snap.exists()) {
        throw new Error(`Registration "${cleanId}" does not exist in Firestore.`);
      }
      const currentData = snap.data() as Partial<HackathonRegistration> | undefined;
      if (currentUid && currentData?.userId && currentData.userId !== currentUid) {
        throw new Error('You can only re-apply with your own registration.');
      }
      validateRegistrationStatusTransition({
        currentStatus: currentData?.status,
        nextStatus: 'approved',
        expectedCurrentStatus: 'withdrawn',
        actorRole: 'participant'
      });
      if (currentData?.hackathonId) {
        const hackSnap = await tx.get(doc(db, 'hackathons', currentData.hackathonId));
        if (!hackSnap.exists()) {
          throw new Error('Selected hackathon does not exist.');
        }
        assertHackathonDocEligibleForRegistration(
          hackSnap.data() as Partial<Hackathon> & {
            registrationDeadlineAt?: { toMillis?: () => number };
          }
        );
      }
      tx.update(regRef, {
        preferredTrack: sanitizeString(params.preferredTrack || 'General', 100),
        motivation: sanitizeString(params.motivation || '', 1500),
        status: 'approved',
        updatedAt: serverTimestamp()
      });
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteRegistration(registrationId: string): Promise<void> {
  const path = `registrations/${registrationId}`;
  try {
    await deleteDoc(doc(db, 'registrations', registrationId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

// --- Teams & Double-Hash Spark-Only Join Codes ---
// Plaintext token T is shown once in memory to the leader and never persisted.
// Client proof P = SHA256(T) is only used transiently in joinClaims (write-only & purged post-commit).
// Firestore stores only verifierHash V = SHA256(SHA256(T)).
async function ensureVerifiedAuthClaimForWrite(expectedUid: string): Promise<void> {
  const currentUser = auth?.currentUser;
  if (!currentUser) return;
  if (currentUser.uid !== expectedUid) {
    throw new Error('Cannot perform this action on behalf of another user.');
  }
  if (!currentUser.emailVerified) {
    throw new Error('Verified email address is required before creating or joining a team.');
  }
  if (typeof currentUser.getIdTokenResult === 'function') {
    const tokenResult = await currentUser.getIdTokenResult().catch(() => null);
    if (tokenResult && !tokenResult.claims?.email_verified && typeof currentUser.getIdToken === 'function') {
      await currentUser.getIdToken(true);
    }
  }
}

export async function createTeamWithLeader(
  team: Omit<Team, 'id' | 'createdAt' | 'updatedAt'>,
  options?: { joinCodeExpiresAt?: Date }
): Promise<{ id: string; joinCode: string }> {
  const currentUid = auth?.currentUser?.uid;
  if (!team.leaderId || (currentUid && currentUid !== team.leaderId)) {
    throw new Error('Cannot create a team on behalf of another user.');
  }
  await ensureVerifiedAuthClaimForWrite(team.leaderId);

  const cleanTeamName = sanitizeString(team.name || '', 80);
  if (cleanTeamName.length < 2) {
    throw new Error('Team name must be at least 2 characters.');
  }
  const leaderName = sanitizeString(team.memberNames[0] || '', 100) || 'Team Lead';

  const expiresAtField =
    options?.joinCodeExpiresAt instanceof Date
      ? (() => {
          if (
            Number.isNaN(options.joinCodeExpiresAt.getTime()) ||
            options.joinCodeExpiresAt.getTime() <= Date.now()
          ) {
            throw new Error('Join code expiration time must be in the future.');
          }
          return { expiresAt: Timestamp.fromDate(options.joinCodeExpiresAt) };
        })()
      : {};

  const verification = await resolveApprovedRegistrationForHackathon(
    team.leaderId,
    team.hackathonId
  );
  if (!verification.approved || !verification.registrationId) {
    throw new Error(verification.reason);
  }

  const canonicalCompositeRegId = `${team.hackathonId}_${team.leaderId}`;
  const nonCompositeRegistrationField =
    verification.registrationId !== canonicalCompositeRegId
      ? { registrationId: verification.registrationId }
      : {};

  const id = generateFirestoreId('team');
  const path = `teams/${id}`;
  try {
    const rawJoinCode = generateSecureJoinToken();
    const { normalizedToken, verifierHash } = await deriveJoinCodeProofAndVerifier(rawJoinCode);

    const batch = writeBatch(db);
    batch.set(doc(db, 'teams', id), {
      id,
      hackathonId: team.hackathonId,
      organizerId: team.organizerId,
      ...nonCompositeRegistrationField,
      name: cleanTeamName,
      description: sanitizeString(team.description || '', 600),
      leaderId: team.leaderId,
      memberIds: [team.leaderId],
      memberNames: [leaderName],
      lookingForRoles: sanitizeStringArray(team.lookingForRoles || [], 6, 50),
      track: sanitizeString(team.track || '', 100),
      status: 'forming',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    batch.set(doc(db, 'teams', id, 'members', team.leaderId), {
      uid: team.leaderId,
      displayName: leaderName,
      roleInTeam: 'Team Lead',
      ...nonCompositeRegistrationField,
      joinedAt: serverTimestamp()
    });
    batch.set(doc(db, 'teams', id, 'private', 'joinCode'), {
      verifierHash,
      leaderId: team.leaderId,
      active: true,
      ...expiresAtField,
      updatedAt: serverTimestamp()
    });
    batch.set(doc(db, 'teamJoinCodes', verifierHash), {
      id: verifierHash,
      verifierHash,
      teamId: id,
      hackathonId: team.hackathonId,
      organizerId: team.organizerId,
      leaderId: team.leaderId,
      active: true,
      ...expiresAtField,
      createdAt: serverTimestamp()
    });
    await batch.commit();
    return { id, joinCode: normalizedToken };
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function getTeamJoinCodeStatus(
  teamId: string
): Promise<{ active: boolean; updatedAt?: unknown } | null> {
  try {
    const snap = await getDoc(doc(db, 'teams', teamId, 'private', 'joinCode'));
    if (!snap.exists()) return null;
    const data = snap.data() as { active?: boolean; updatedAt?: unknown };
    return {
      active: Boolean(data.active),
      updatedAt: data.updatedAt
    };
  } catch {
    return null;
  }
}

export async function revokeTeamJoinCode(teamId: string): Promise<void> {
  const path = `teams/${teamId}/private/joinCode`;
  try {
    const privateSnap = await getDoc(doc(db, 'teams', teamId, 'private', 'joinCode'));
    if (!privateSnap.exists()) return;
    const privateData = privateSnap.data() as { verifierHash?: string; leaderId?: string };
    if (!privateData.verifierHash || !privateData.leaderId) return;

    const batch = writeBatch(db);
    batch.update(doc(db, 'teamJoinCodes', privateData.verifierHash), {
      active: false
    });
    batch.update(doc(db, 'teams', teamId, 'private', 'joinCode'), {
      verifierHash: privateData.verifierHash,
      leaderId: privateData.leaderId,
      active: false,
      updatedAt: serverTimestamp()
    });
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function rotateTeamJoinCode(
  teamId: string,
  options?: { expiresAt?: Date }
): Promise<string> {
  const path = `teams/${teamId}/private/joinCode`;
  try {
    const expiresAtField =
      options?.expiresAt instanceof Date
        ? (() => {
            if (
              Number.isNaN(options.expiresAt.getTime()) ||
              options.expiresAt.getTime() <= Date.now()
            ) {
              throw new Error('Join code expiration time must be in the future.');
            }
            return { expiresAt: Timestamp.fromDate(options.expiresAt) };
          })()
        : {};

    const teamSnap = await getDoc(doc(db, 'teams', teamId));
    if (!teamSnap.exists()) {
      throw new Error('Team not found.');
    }
    const team = teamSnap.data() as Team;
    const privateSnap = await getDoc(doc(db, 'teams', teamId, 'private', 'joinCode'));
    const previousVerifierHash = privateSnap.exists()
      ? (privateSnap.data() as { verifierHash?: string; active?: boolean })
      : null;

    const rawJoinCode = generateSecureJoinToken();
    const { normalizedToken, verifierHash } = await deriveJoinCodeProofAndVerifier(rawJoinCode);

    const batch = writeBatch(db);
    if (previousVerifierHash?.verifierHash && previousVerifierHash.active) {
      batch.update(doc(db, 'teamJoinCodes', previousVerifierHash.verifierHash), {
        active: false
      });
    }
    batch.set(doc(db, 'teamJoinCodes', verifierHash), {
      id: verifierHash,
      verifierHash,
      teamId,
      hackathonId: team.hackathonId,
      organizerId: team.organizerId,
      leaderId: team.leaderId,
      active: true,
      ...expiresAtField,
      createdAt: serverTimestamp()
    });
    batch.set(doc(db, 'teams', teamId, 'private', 'joinCode'), {
      verifierHash,
      leaderId: team.leaderId,
      active: true,
      ...expiresAtField,
      updatedAt: serverTimestamp()
    });
    await batch.commit();
    return normalizedToken;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function listTeamMembers(teamId: string): Promise<TeamMemberRecord[]> {
  const path = `teams/${teamId}/members`;
  try {
    const snap = await getDocs(collection(db, 'teams', teamId, 'members'));
    return snap.docs.map((d) => d.data() as TeamMemberRecord);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

function extractTimestampMillis(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value === 'object') {
    if ('toMillis' in value && typeof (value as { toMillis: () => number }).toMillis === 'function') {
      try {
        const ms = (value as { toMillis: () => number }).toMillis();
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
    if ('seconds' in value) {
      const secs = Number((value as { seconds: unknown }).seconds);
      if (Number.isFinite(secs)) return secs * 1000;
    }
  }
  return null;
}

export async function joinTeamByCode(
  joinCode: string,
  userId: string,
  displayName: string
): Promise<Team | null> {
  const path = 'teams';
  try {
    const currentUid = auth?.currentUser?.uid;
    if (!userId || (currentUid && currentUid !== userId)) {
      throw new Error('Cannot join a team on behalf of another user.');
    }
    await ensureVerifiedAuthClaimForWrite(userId);

    const normalized = normalizeJoinToken(joinCode);
    if (!normalized || normalized.length < 16 || normalized.length > 64) {
      return null;
    }
    const { proof, verifierHash } = await deriveJoinCodeProofAndVerifier(normalized);
    const codeSnap = await getDoc(doc(db, 'teamJoinCodes', verifierHash));
    if (!codeSnap.exists()) return null;
    const codeData = codeSnap.data() as {
      teamId?: string;
      hackathonId?: string;
      leaderId?: string;
      active?: boolean;
      expiresAt?: unknown;
    };
    if (!codeData.teamId) return null;
    if (!codeData.active) {
      throw new Error(
        'This join code has been revoked or rotated. Ask the team leader for a new active code.'
      );
    }
    const expiresAtMs = extractTimestampMillis(codeData.expiresAt);
    if (expiresAtMs !== null && Date.now() > expiresAtMs) {
      throw new Error(
        'This team join code has expired. Ask the team leader to issue a new active code.'
      );
    }
    if (codeData.leaderId && codeData.leaderId === userId) {
      throw new Error('You are already the leader of this team.');
    }

    const teamId = codeData.teamId;
    let hackathonId = typeof codeData.hackathonId === 'string' ? codeData.hackathonId.trim() : '';
    if (!hackathonId) {
      // Legacy fallback only if a pre-existing teamJoinCodes doc lacked hackathonId
      const fallbackSnap = await getDoc(doc(db, 'teams', teamId));
      if (!fallbackSnap.exists()) return null;
      hackathonId = (fallbackSnap.data() as Partial<Team>).hackathonId || '';
    }
    if (!hackathonId) {
      throw new Error(
        'Team join code metadata is incomplete. Ask the team leader to rotate the join code.'
      );
    }

    let verification = await resolveApprovedRegistrationForHackathon(userId, hackathonId);
    if (
      !verification.approved &&
      verification.status === 'pending' &&
      verification.registration &&
      (!currentUid || currentUid === userId)
    ) {
      await approveOwnPendingRegistration(verification.registration.id);
      verification = await resolveApprovedRegistrationForHackathon(userId, hackathonId);
    }
    if (!verification.approved || !verification.registrationId) {
      throw new Error(verification.reason);
    }

    const canonicalCompositeRegId = `${hackathonId}_${userId}`;
    const nonCompositeRegistrationField =
      verification.registrationId !== canonicalCompositeRegId
        ? { registrationId: verification.registrationId }
        : {};

    const cleanName = sanitizeString(displayName || '', 100) || 'Builder';
    const batch = writeBatch(db);
    batch.set(doc(db, 'teams', teamId, 'joinClaims', userId), {
      uid: userId,
      teamId,
      mode: 'join_code',
      proof,
      ...nonCompositeRegistrationField,
      presentedAt: serverTimestamp()
    });
    batch.update(doc(db, 'teams', teamId), {
      memberIds: arrayUnion(userId),
      memberNames: arrayUnion(cleanName),
      updatedAt: serverTimestamp()
    });
    batch.set(doc(db, 'teams', teamId, 'members', userId), {
      uid: userId,
      displayName: cleanName,
      roleInTeam: 'Member',
      ...nonCompositeRegistrationField,
      joinedAt: serverTimestamp()
    });
    try {
      await batch.commit();
    } catch (commitErr) {
      const errMsg = commitErr instanceof Error ? commitErr.message : String(commitErr);
      const errCode =
        commitErr && typeof commitErr === 'object' && 'code' in commitErr
          ? String((commitErr as { code?: unknown }).code || '')
          : '';
      if (
        errCode.includes('permission-denied') ||
        errMsg.toLowerCase().includes('missing or insufficient permissions')
      ) {
        const existingTeamSnap = await getDoc(doc(db, 'teams', teamId)).catch(() => null);
        if (existingTeamSnap?.exists()) {
          const teamData = existingTeamSnap.data() as Partial<Team>;
          if (Array.isArray(teamData.memberIds) && teamData.memberIds.includes(userId)) {
            throw new Error('You are already a member of this team.', { cause: commitErr });
          }
          if (teamData.status && teamData.status !== 'forming') {
            throw new Error(
              'This team is locked or already submitted and is no longer accepting new members.',
              { cause: commitErr }
            );
          }
        }
        throw new Error(
          'Unable to join team: the team may already be full, locked/submitted, or this join code is no longer valid.',
          { cause: commitErr }
        );
      }
      throw commitErr;
    }

    // Immediately purge only this user's transient proof claim; keep teamJoinCodes active for reuse by other eligible participants.
    await deleteDoc(doc(db, 'teams', teamId, 'joinClaims', userId)).catch(() => {});

    const finalTeamSnap = await getDoc(doc(db, 'teams', teamId));
    return finalTeamSnap.exists() ? (finalTeamSnap.data() as Team) : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function listUserTeams(userId: string): Promise<Team[]> {
  const path = 'teams';
  try {
    const q = query(collection(db, 'teams'), where('memberIds', 'array-contains', userId));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as Team);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function listOrganizerTeams(organizerId: string): Promise<Team[]> {
  const path = 'teams';
  try {
    const q = query(collection(db, 'teams'), where('organizerId', '==', organizerId));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as Team);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function updateTeamDetails(
  teamId: string,
  updates: {
    name: string;
    description: string;
    lookingForRoles: string[];
    track: string;
    status: Team['status'];
  }
): Promise<void> {
  const path = `teams/${teamId}`;
  try {
    await updateDoc(doc(db, 'teams', teamId), {
      name: sanitizeString(updates.name, 80),
      description: sanitizeString(updates.description || '', 600),
      lookingForRoles: sanitizeStringArray(updates.lookingForRoles || [], 6, 50),
      track: sanitizeString(updates.track || '', 100),
      status: updates.status,
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

async function buildReducedRoster(
  teamId: string,
  targetUid: string
): Promise<{ nextMemberIds: string[]; nextMemberNames: string[] }> {
  const [teamSnap, memberSnaps] = await Promise.all([
    getDoc(doc(db, 'teams', teamId)),
    getDocs(collection(db, 'teams', teamId, 'members')).catch(() => null)
  ]);
  if (!teamSnap.exists()) {
    throw new Error('Team not found.');
  }
  const team = teamSnap.data() as Team;
  const nextMemberIds = (team.memberIds || []).filter((id) => id !== targetUid);
  const existingNames = team.memberNames || [];
  const memberMap = new Map<string, string>();
  if (memberSnaps) {
    memberSnaps.docs.forEach((d) => {
      const m = d.data() as TeamMemberRecord;
      if (m.uid && m.displayName) memberMap.set(m.uid, m.displayName);
    });
  }

  let nextMemberNames: string[];
  if (memberMap.size > 0 && nextMemberIds.every((id) => memberMap.has(id))) {
    nextMemberNames = nextMemberIds
      .map((id) => memberMap.get(id) || '')
      .filter((name) => name && existingNames.includes(name));
  } else {
    const removeIdx = (team.memberIds || []).indexOf(targetUid);
    nextMemberNames = existingNames.filter((_, idx) => idx !== removeIdx);
  }
  if (nextMemberNames.length > nextMemberIds.length) {
    nextMemberNames = nextMemberNames.slice(0, nextMemberIds.length);
  }
  return { nextMemberIds, nextMemberNames };
}

export async function removeTeamMember(teamId: string, targetUid: string): Promise<void> {
  const path = `teams/${teamId}`;
  try {
    const { nextMemberIds, nextMemberNames } = await buildReducedRoster(teamId, targetUid);
    const batch = writeBatch(db);
    batch.update(doc(db, 'teams', teamId), {
      memberIds: nextMemberIds,
      memberNames: nextMemberNames,
      updatedAt: serverTimestamp()
    });
    batch.delete(doc(db, 'teams', teamId, 'members', targetUid));
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function leaveTeam(teamId: string, userId: string): Promise<void> {
  const path = `teams/${teamId}`;
  try {
    const { nextMemberIds, nextMemberNames } = await buildReducedRoster(teamId, userId);
    const batch = writeBatch(db);
    batch.update(doc(db, 'teams', teamId), {
      memberIds: nextMemberIds,
      memberNames: nextMemberNames,
      updatedAt: serverTimestamp()
    });
    batch.delete(doc(db, 'teams', teamId, 'members', userId));
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteFormingTeam(teamId: string): Promise<void> {
  const path = `teams/${teamId}`;
  try {
    const [teamSnap, membersSnap, privateSnap] = await Promise.all([
      getDoc(doc(db, 'teams', teamId)),
      getDocs(collection(db, 'teams', teamId, 'members')).catch(() => null),
      getDoc(doc(db, 'teams', teamId, 'private', 'joinCode')).catch(() => null)
    ]);
    if (!teamSnap.exists()) return;

    const batch = writeBatch(db);
    if (membersSnap) {
      membersSnap.docs.forEach((m) => {
        batch.delete(doc(db, 'teams', teamId, 'members', m.id));
      });
    }
    if (privateSnap?.exists()) {
      const pData = privateSnap.data() as { verifierHash?: string };
      if (pData.verifierHash) {
        batch.delete(doc(db, 'teamJoinCodes', pData.verifierHash));
      }
      batch.delete(doc(db, 'teams', teamId, 'private', 'joinCode'));
    }
    batch.delete(doc(db, 'teams', teamId));
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function sendTeamInvitation(
  inv: Omit<TeamInvitation, 'id' | 'status' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  await ensureVerifiedAuthClaimForWrite(inv.fromUserId);
  const id = generateFirestoreId('inv');
  const path = `teamInvitations/${id}`;
  try {
    await setDoc(doc(db, 'teamInvitations', id), {
      id,
      teamId: inv.teamId,
      teamName: sanitizeString(inv.teamName, 80),
      hackathonId: inv.hackathonId,
      fromUserId: inv.fromUserId,
      fromUserName: sanitizeString(inv.fromUserName, 100),
      toUserId: inv.toUserId,
      toUserName: sanitizeString(inv.toUserName, 100),
      roleOffered: sanitizeString(inv.roleOffered, 80),
      message: sanitizeString(inv.message, 500),
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function listMyInvitations(userId: string): Promise<TeamInvitation[]> {
  const path = 'teamInvitations';
  try {
    const [incomingSnap, outgoingSnap] = await Promise.all([
      getDocs(query(collection(db, 'teamInvitations'), where('toUserId', '==', userId))),
      getDocs(query(collection(db, 'teamInvitations'), where('fromUserId', '==', userId)))
    ]);
    const map = new Map<string, TeamInvitation>();
    incomingSnap.docs.forEach((d) => map.set(d.id, d.data() as TeamInvitation));
    outgoingSnap.docs.forEach((d) => map.set(d.id, d.data() as TeamInvitation));
    return Array.from(map.values());
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function respondToTeamInvitation(
  invitation: TeamInvitation,
  accept: boolean,
  responderName: string
): Promise<void> {
  const path = `teamInvitations/${invitation.id}`;
  try {
    if (accept) {
      await ensureVerifiedAuthClaimForWrite(invitation.toUserId);
      let verification = await resolveApprovedRegistrationForHackathon(
        invitation.toUserId,
        invitation.hackathonId
      );
      if (
        !verification.approved &&
        verification.status === 'pending' &&
        verification.registration &&
        (!auth?.currentUser || auth.currentUser.uid === invitation.toUserId)
      ) {
        await approveOwnPendingRegistration(verification.registration.id);
        verification = await resolveApprovedRegistrationForHackathon(
          invitation.toUserId,
          invitation.hackathonId
        );
      }
      if (!verification.approved || !verification.registrationId) {
        throw new Error(verification.reason);
      }

      const canonicalCompositeRegId = `${invitation.hackathonId}_${invitation.toUserId}`;
      const nonCompositeRegistrationField =
        verification.registrationId !== canonicalCompositeRegId
          ? { registrationId: verification.registrationId }
          : {};

      const cleanName = sanitizeString(responderName || '', 100) || 'Builder';
      const batch = writeBatch(db);
      batch.update(doc(db, 'teamInvitations', invitation.id), {
        status: 'accepted',
        updatedAt: serverTimestamp()
      });
      batch.set(doc(db, 'teams', invitation.teamId, 'joinClaims', invitation.toUserId), {
        uid: invitation.toUserId,
        teamId: invitation.teamId,
        mode: 'invitation',
        invitationId: invitation.id,
        ...nonCompositeRegistrationField,
        presentedAt: serverTimestamp()
      });
      batch.update(doc(db, 'teams', invitation.teamId), {
        memberIds: arrayUnion(invitation.toUserId),
        memberNames: arrayUnion(cleanName),
        updatedAt: serverTimestamp()
      });
      batch.set(doc(db, 'teams', invitation.teamId, 'members', invitation.toUserId), {
        uid: invitation.toUserId,
        displayName: cleanName,
        roleInTeam: sanitizeString(invitation.roleOffered || 'Member', 80),
        ...nonCompositeRegistrationField,
        joinedAt: serverTimestamp()
      });
      await batch.commit();
      await deleteDoc(doc(db, 'teams', invitation.teamId, 'joinClaims', invitation.toUserId)).catch(() => {});
    } else {
      await updateDoc(doc(db, 'teamInvitations', invitation.id), {
        status: 'rejected',
        updatedAt: serverTimestamp()
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function cancelTeamInvitation(invitationId: string): Promise<void> {
  const path = `teamInvitations/${invitationId}`;
  try {
    await updateDoc(doc(db, 'teamInvitations', invitationId), {
      status: 'cancelled',
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

// --- Projects ---
export async function listUserProjects(userId: string): Promise<Project[]> {
  const path = 'projects';
  try {
    const q = query(collection(db, 'projects'), where('memberIds', 'array-contains', userId));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as Project);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function saveProject(
  project: Omit<Project, 'createdAt' | 'updatedAt'>,
  isNew: boolean,
  options?: { updateMembership?: boolean }
): Promise<void> {
  const path = `projects/${project.id}`;
  const mutableFields = {
    title: sanitizeString(project.title, 140),
    problemStatement: sanitizeString(project.problemStatement || '', 3000),
    proposedSolution: sanitizeString(project.proposedSolution || '', 4000),
    targetUsers: sanitizeString(project.targetUsers || '', 1000),
    technologies: sanitizeStringArray(project.technologies || [], 15, 50),
    roadmap: sanitizeStringArray(project.roadmap || [], 20, 200),
    tasks: (project.tasks || []).slice(0, 30),
    notes: sanitizeString(project.notes || '', 5000),
    aiMentorApprovedSummary: sanitizeString(project.aiMentorApprovedSummary || '', 5000),
    status: project.status
  };

  try {
    if (isNew) {
      await setDoc(doc(db, 'projects', project.id), {
        id: project.id,
        hackathonId: project.hackathonId,
        organizerId: project.organizerId,
        teamId: project.teamId,
        ownerId: project.ownerId,
        memberIds: sanitizeStringArray(project.memberIds, 10, 128),
        ...mutableFields,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } else {
      await updateDoc(doc(db, 'projects', project.id), {
        ...mutableFields,
        ...(options?.updateMembership
          ? { memberIds: sanitizeStringArray(project.memberIds, 10, 128) }
          : {}),
        updatedAt: serverTimestamp()
      });
    }
  } catch (err) {
    handleFirestoreError(err, isNew ? OperationType.CREATE : OperationType.UPDATE, path);
  }
}

export async function deleteProject(projectId: string): Promise<void> {
  const path = `projects/${projectId}`;
  try {
    await deleteDoc(doc(db, 'projects', projectId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

// --- Submissions ---
export async function listUserSubmissions(userId: string): Promise<ProjectSubmission[]> {
  const path = 'submissions';
  try {
    const q = query(collection(db, 'submissions'), where('memberIds', 'array-contains', userId));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as ProjectSubmission);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function listOrganizerSubmissions(organizerId: string): Promise<ProjectSubmission[]> {
  const path = 'submissions';
  try {
    const q = query(collection(db, 'submissions'), where('organizerId', '==', organizerId));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as ProjectSubmission);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function listJudgeAssignedSubmissions(judgeId: string): Promise<ProjectSubmission[]> {
  const path = 'submissions';
  try {
    const assignments = await listJudgeAssignmentsByJudge(judgeId);
    const eligibleAssignments = assignments.filter(
      (a) => a.status === 'accepted' && !a.conflictDeclared
    );
    const submissionIds = Array.from(
      new Set(eligibleAssignments.flatMap((a) => a.assignedSubmissionIds || []))
    );
    if (submissionIds.length === 0) return [];

    const snaps = await Promise.all(
      submissionIds.map((subId) => getDoc(doc(db, 'submissions', subId)).catch(() => null))
    );
    return snaps
      .filter((s): s is NonNullable<typeof s> => Boolean(s && s.exists()))
      .map((s) => s.data() as ProjectSubmission);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function saveSubmission(
  submission: Omit<ProjectSubmission, 'createdAt' | 'updatedAt' | 'assignedJudgeIds'>,
  isNew: boolean
): Promise<void> {
  const path = `submissions/${submission.id}`;
  const mutableFields = {
    title: sanitizeString(submission.title, 140),
    shortDescription: sanitizeString(submission.shortDescription, 300),
    fullDescription: sanitizeString(submission.fullDescription || '', 8000),
    problemStatement: sanitizeString(submission.problemStatement || '', 3000),
    proposedSolution: sanitizeString(submission.proposedSolution || '', 4000),
    technologies: sanitizeStringArray(submission.technologies || [], 15, 50),
    githubUrl: sanitizeString(submission.githubUrl || '', 300),
    demoUrl: sanitizeString(submission.demoUrl || '', 300),
    videoUrl: sanitizeString(submission.videoUrl || '', 300),
    screenshotUrls: sanitizeStringArray(submission.screenshotUrls || [], 6, 400),
    track: sanitizeString(submission.track || '', 100),
    status: submission.status === 'submitted' ? 'submitted' : 'draft',
    ...(submission.status === 'submitted' && !submission.submittedAt
      ? { submittedAt: serverTimestamp() }
      : {})
  };

  try {
    if (isNew) {
      await setDoc(doc(db, 'submissions', submission.id), {
        id: submission.id,
        hackathonId: submission.hackathonId,
        organizerId: submission.organizerId,
        teamId: submission.teamId,
        teamName: sanitizeString(submission.teamName || '', 80),
        projectId: submission.projectId,
        ownerId: submission.ownerId,
        memberIds: sanitizeStringArray(submission.memberIds, 10, 128),
        memberNames: sanitizeStringArray(submission.memberNames || [], 10, 100),
        ...mutableFields,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } else {
      await updateDoc(doc(db, 'submissions', submission.id), {
        ...mutableFields,
        updatedAt: serverTimestamp()
      });
    }
  } catch (err) {
    handleFirestoreError(err, isNew ? OperationType.CREATE : OperationType.UPDATE, path);
  }
}

// --- Judge Assignments & Evaluations ---
export async function assignJudgeToHackathon(params: {
  hackathonId: string;
  organizerId: string;
  judgeId: string;
  judgeName: string;
  submissionIds: string[];
}): Promise<void> {
  const id = `${params.hackathonId}_${params.judgeId}`;
  const path = `judgeAssignments/${id}`;
  try {
    const existingSnap = await getDoc(doc(db, 'judgeAssignments', id));
    const batch = writeBatch(db);
    const nextIds = sanitizeStringArray(params.submissionIds, 50, 128);

    if (existingSnap.exists()) {
      batch.update(doc(db, 'judgeAssignments', id), {
        assignedSubmissionIds: nextIds,
        updatedAt: serverTimestamp()
      });
    } else {
      batch.set(doc(db, 'judgeAssignments', id), {
        id,
        hackathonId: params.hackathonId,
        organizerId: params.organizerId,
        judgeId: params.judgeId,
        judgeName: sanitizeString(params.judgeName, 100),
        assignedSubmissionIds: nextIds,
        conflictDeclared: false,
        conflictNotes: '',
        status: 'invited',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }

    const subSnaps = await Promise.all(nextIds.map((subId) => getDoc(doc(db, 'submissions', subId))));
    for (const subSnap of subSnaps) {
      if (subSnap.exists()) {
        const subData = subSnap.data() as ProjectSubmission;
        if (subData.status === 'submitted') {
          batch.update(doc(db, 'submissions', subSnap.id), {
            status: 'under_review',
            updatedAt: serverTimestamp()
          });
        }
      }
    }

    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function listJudgeAssignmentsByJudge(judgeId: string): Promise<JudgeAssignment[]> {
  const path = 'judgeAssignments';
  try {
    const q = query(collection(db, 'judgeAssignments'), where('judgeId', '==', judgeId));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as JudgeAssignment);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function listJudgeAssignmentsByOrganizer(organizerId: string): Promise<JudgeAssignment[]> {
  const path = 'judgeAssignments';
  try {
    const q = query(collection(db, 'judgeAssignments'), where('organizerId', '==', organizerId));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as JudgeAssignment);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function updateJudgeAssignmentResponse(params: {
  assignmentId: string;
  status: JudgeAssignment['status'];
  conflictDeclared: boolean;
  conflictNotes: string;
}): Promise<void> {
  const path = `judgeAssignments/${params.assignmentId}`;
  try {
    await updateDoc(doc(db, 'judgeAssignments', params.assignmentId), {
      status: params.status,
      conflictDeclared: params.conflictDeclared,
      conflictNotes: sanitizeString(params.conflictNotes, 1000),
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteJudgeAssignment(assignmentId: string): Promise<void> {
  const path = `judgeAssignments/${assignmentId}`;
  try {
    await deleteDoc(doc(db, 'judgeAssignments', assignmentId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

async function runBoundedTasks<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    await Promise.all(slice.map((item) => worker(item)));
  }
}

async function hydrateEvaluationDocFromSubcollection(
  parentData: Evaluation,
  evalId: string
): Promise<Evaluation> {
  const criteriaSnap = await getDocs(collection(db, 'evaluations', evalId, 'criteria'));
  const subDocs = criteriaSnap.docs.map((d) => d.data() as NormalizedEvaluationCriterionDoc);
  return hydrateEvaluationScoresAndTotal({ ...parentData, id: parentData.id || evalId }, subDocs);
}

export async function getEvaluationWithCriteria(evaluationId: string): Promise<Evaluation | null> {
  const path = `evaluations/${evaluationId}`;
  try {
    const snap = await getDoc(doc(db, 'evaluations', evaluationId));
    if (!snap.exists()) return null;
    return await hydrateEvaluationDocFromSubcollection(snap.data() as Evaluation, snap.id);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function saveCriterionScoreDraft(params: {
  evaluationId: string;
  hackathonId: string;
  submissionId: string;
  judgeId: string;
  criterion: CriterionScore;
}): Promise<void> {
  const path = `evaluations/${params.evaluationId}/criteria/${params.criterion.criterionId}`;
  try {
    const ref = doc(db, 'evaluations', params.evaluationId, 'criteria', params.criterion.criterionId);
    const existing = await getDoc(ref);
    const payload = {
      criterionId: params.criterion.criterionId,
      evaluationId: params.evaluationId,
      hackathonId: params.hackathonId,
      submissionId: params.submissionId,
      judgeId: params.judgeId,
      criterionName: sanitizeString(params.criterion.criterionName || '', 120),
      weight: Number(params.criterion.weight),
      score: Number(params.criterion.score),
      comment: sanitizeString(params.criterion.comment || '', 1000),
      updatedAt: serverTimestamp()
    };
    if (existing.exists()) {
      await updateDoc(ref, payload);
    } else {
      await setDoc(ref, payload);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deleteCriterionScoreDraft(
  evaluationId: string,
  criterionId: string
): Promise<void> {
  const path = `evaluations/${evaluationId}/criteria/${criterionId}`;
  try {
    await deleteDoc(doc(db, 'evaluations', evaluationId, 'criteria', criterionId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function saveEvaluation(
  evaluation: Omit<Evaluation, 'id' | 'createdAt' | 'updatedAt'>,
  options?: { rubric?: RubricCriterion[] }
): Promise<void> {
  const id = `${evaluation.submissionId}_${evaluation.judgeId}`;
  const path = `evaluations/${id}`;
  try {
    const parentRef = doc(db, 'evaluations', id);
    const conflict = Boolean(evaluation.conflictOfInterest);
    const submitFinal = evaluation.status === 'submitted';

    // Deduplicate and sanitize incoming criterion scores
    const dedupedMap = new Map<string, CriterionScore>();
    if (!conflict) {
      for (const rawItem of evaluation.criteriaScores || []) {
        if (!rawItem || !rawItem.criterionId || dedupedMap.has(rawItem.criterionId)) continue;
        dedupedMap.set(rawItem.criterionId, {
          criterionId: rawItem.criterionId,
          criterionName: sanitizeString(rawItem.criterionName || '', 120) || rawItem.criterionId,
          weight: Number(rawItem.weight),
          score: Number(rawItem.score),
          comment: sanitizeString(rawItem.comment || '', 1000)
        });
      }
    }
    const desiredScores = Array.from(dedupedMap.values());

    if (conflict) {
      if (!sanitizeString(evaluation.conflictReason || '', 500).trim()) {
        throw new Error('Conflict of interest reason is required.');
      }
    } else if (desiredScores.length > 0) {
      const strict = calculateWeightedTotalStrict(
        desiredScores,
        submitFinal ? options?.rubric : undefined
      );
      if (!strict.valid) {
        throw new Error(strict.error || 'Invalid evaluation criterion scores.');
      }
    } else if (submitFinal) {
      throw new Error('At least one scored criterion is required before final submission.');
    }

    const existing = await getDoc(parentRef);
    if (existing.exists()) {
      const existingData = existing.data() as Evaluation | undefined;
      if (existingData?.status === 'submitted') {
        throw new Error('Final submitted evaluations are immutable and locked by Firestore security rules.');
      }
    }

    const computedWeightedTotal =
      conflict || desiredScores.length === 0 ? 0 : calculateWeightedTotal(desiredScores);
    const initialStatus: Evaluation['status'] = submitFinal
      ? 'finalizing'
      : evaluation.status === 'finalizing'
        ? 'finalizing'
        : 'draft';

    const mutableParent = {
      criteriaScores: [] as CriterionScore[],
      weightedTotal: computedWeightedTotal,
      scoredCriterionCount: desiredScores.length,
      storageSchema: 'v2_subcollection' as const,
      conflictOfInterest: conflict,
      conflictReason: sanitizeString(evaluation.conflictReason || '', 500),
      humanFeedback: sanitizeString(evaluation.humanFeedback || '', 4000),
      aiReportSummary: sanitizeString(evaluation.aiReportSummary || '', 6000),
      aiInferenceSource: sanitizeString(evaluation.aiInferenceSource || '', 60),
      status: initialStatus
    };

    if (existing.exists()) {
      await updateDoc(parentRef, {
        ...mutableParent,
        updatedAt: serverTimestamp()
      });
    } else {
      await setDoc(parentRef, {
        id,
        hackathonId: evaluation.hackathonId,
        organizerId: evaluation.organizerId,
        submissionId: evaluation.submissionId,
        judgeId: evaluation.judgeId,
        judgeName: sanitizeString(evaluation.judgeName || '', 100),
        ...mutableParent,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }

    // Sync normalized /evaluations/{id}/criteria/{criterionId} subcollection
    const existingCriteriaSnap = await getDocs(collection(db, 'evaluations', id, 'criteria'));
    const existingCriteriaMap = new Map<string, NormalizedEvaluationCriterionDoc>();
    for (const d of existingCriteriaSnap.docs) {
      existingCriteriaMap.set(d.id, d.data() as NormalizedEvaluationCriterionDoc);
    }

    const desiredById = new Map(desiredScores.map((s) => [s.criterionId, s]));
    const staleIds = Array.from(existingCriteriaMap.keys()).filter(
      (existingId) => conflict || !desiredById.has(existingId)
    );

    if (staleIds.length > 0) {
      await runBoundedTasks(staleIds, 5, async (staleId) => {
        await deleteDoc(doc(db, 'evaluations', id, 'criteria', staleId));
      });
    }

    if (!conflict && desiredScores.length > 0) {
      const toUpsert = desiredScores.filter((item) => {
        const prev = existingCriteriaMap.get(item.criterionId);
        if (!prev) return true;
        return (
          prev.criterionName !== item.criterionName ||
          Math.abs(Number(prev.weight) - item.weight) > 0.0001 ||
          Math.abs(Number(prev.score) - item.score) > 0.0001 ||
          (prev.comment || '') !== item.comment
        );
      });

      await runBoundedTasks(toUpsert, 5, async (item) => {
        const critRef = doc(db, 'evaluations', id, 'criteria', item.criterionId);
        const critPayload = {
          criterionId: item.criterionId,
          evaluationId: id,
          hackathonId: evaluation.hackathonId,
          submissionId: evaluation.submissionId,
          judgeId: evaluation.judgeId,
          criterionName: item.criterionName,
          weight: item.weight,
          score: item.score,
          comment: item.comment,
          updatedAt: serverTimestamp()
        };
        if (existingCriteriaMap.has(item.criterionId)) {
          await updateDoc(critRef, critPayload);
        } else {
          await setDoc(critRef, critPayload);
        }
      });
    }

    if (submitFinal) {
      const verifySnap = await getDocs(collection(db, 'evaluations', id, 'criteria'));
      const verifiedDocs = verifySnap.docs.map((d) => d.data() as NormalizedEvaluationCriterionDoc);

      if (conflict) {
        if (verifiedDocs.length > 0) {
          throw new Error('Conflict of interest submission requires zero criterion score documents.');
        }
        await updateDoc(parentRef, {
          status: 'submitted',
          criteriaScores: [],
          weightedTotal: 0,
          scoredCriterionCount: 0,
          storageSchema: 'v2_subcollection',
          submittedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      } else {
        const verifiedScores: CriterionScore[] = verifiedDocs.map((d) => ({
          criterionId: d.criterionId,
          criterionName: d.criterionName,
          weight: Number(d.weight),
          score: Number(d.score),
          comment: d.comment || ''
        }));

        if (verifiedScores.length !== desiredScores.length) {
          throw new Error(
            `Finalization verification mismatch: expected ${desiredScores.length} persisted criteria, found ${verifiedScores.length}. Retry submission to complete.`
          );
        }

        const strictVerify = calculateWeightedTotalStrict(verifiedScores, options?.rubric);
        if (!strictVerify.valid) {
          throw new Error(strictVerify.error || 'Persisted criteria failed final rubric verification.');
        }

        await updateDoc(parentRef, {
          status: 'submitted',
          criteriaScores: [],
          weightedTotal: strictVerify.weightedTotal,
          scoredCriterionCount: verifiedScores.length,
          storageSchema: 'v2_subcollection',
          submittedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function listJudgeEvaluations(judgeId: string): Promise<Evaluation[]> {
  const path = 'evaluations';
  try {
    const q = query(collection(db, 'evaluations'), where('judgeId', '==', judgeId));
    const snap = await getDocs(q);
    return await Promise.all(
      snap.docs.map((d) => hydrateEvaluationDocFromSubcollection(d.data() as Evaluation, d.id))
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function listOrganizerEvaluations(organizerId: string): Promise<Evaluation[]> {
  const path = 'evaluations';
  try {
    const q = query(collection(db, 'evaluations'), where('organizerId', '==', organizerId));
    const snap = await getDocs(q);
    return await Promise.all(
      snap.docs.map((d) => hydrateEvaluationDocFromSubcollection(d.data() as Evaluation, d.id))
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

// --- Hackathon Results ---
export async function saveHackathonResults(
  results: Omit<HackathonResults, 'publishedAt' | 'updatedAt'>
): Promise<void> {
  const path = `hackathonResults/${results.hackathonId}`;
  try {
    const existing = await getDoc(doc(db, 'hackathonResults', results.hackathonId));
    const batch = writeBatch(db);
    if (existing.exists()) {
      batch.update(doc(db, 'hackathonResults', results.hackathonId), {
        published: Boolean(results.published),
        rankings: results.rankings.slice(0, 100),
        ...(results.published ? { publishedAt: serverTimestamp() } : {}),
        updatedAt: serverTimestamp()
      });
    } else {
      batch.set(doc(db, 'hackathonResults', results.hackathonId), {
        hackathonId: results.hackathonId,
        organizerId: results.organizerId,
        published: Boolean(results.published),
        rankings: results.rankings.slice(0, 100),
        ...(results.published ? { publishedAt: serverTimestamp() } : {}),
        updatedAt: serverTimestamp()
      });
    }
    if (results.published) {
      batch.update(doc(db, 'hackathons', results.hackathonId), {
        resultsPublished: true,
        status: 'completed',
        updatedAt: serverTimestamp()
      });
    }
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function listPublishedResults(): Promise<HackathonResults[]> {
  const path = 'hackathonResults';
  try {
    const q = query(collection(db, 'hackathonResults'), where('published', '==', true));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as HackathonResults);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function getHackathonResults(hackathonId: string): Promise<HackathonResults | null> {
  const path = `hackathonResults/${hackathonId}`;
  try {
    const snap = await getDoc(doc(db, 'hackathonResults', hackathonId));
    return snap.exists() ? (snap.data() as HackathonResults) : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

// --- Notifications & Authoritative Spark Activity Feed ---
export async function createNotification(
  notif: Omit<AppNotification, 'id' | 'read' | 'createdAt'>
): Promise<void> {
  const id = generateFirestoreId('ntf');
  const path = `notifications/${id}`;
  const rawLink = sanitizeString(notif.link || '/app', 200);
  const safeLink = isValidInternalAppLink(rawLink) ? rawLink : '/app';
  try {
    await setDoc(doc(db, 'notifications', id), {
      id,
      userId: notif.userId,
      type: notif.type,
      title: sanitizeString(notif.title, 140),
      message: sanitizeString(notif.message, 600),
      link: safeLink,
      read: false,
      createdAt: serverTimestamp()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export interface DerivedActivityItem {
  id: string;
  type: AppNotification['type'];
  title: string;
  message: string;
  link: string;
  actionRequired?: boolean;
  timestampMs: number;
}

function toTimestampMs(val: unknown): number {
  if (
    val &&
    typeof val === 'object' &&
    'toMillis' in val &&
    typeof (val as { toMillis: () => number }).toMillis === 'function'
  ) {
    return (val as { toMillis: () => number }).toMillis();
  }
  if (val && typeof val === 'object' && 'seconds' in val) {
    return Number((val as { seconds: number }).seconds) * 1000;
  }
  return 0;
}

export async function listDerivedUserActivity(userId: string): Promise<DerivedActivityItem[]> {
  const [regs, invites, assigns, pubResults] = await Promise.all([
    listUserRegistrations(userId).catch(() => []),
    listMyInvitations(userId).catch(() => []),
    listJudgeAssignmentsByJudge(userId).catch(() => []),
    listPublishedResults().catch(() => [])
  ]);

  const derived: DerivedActivityItem[] = [];

  for (const inv of invites) {
    if (inv.toUserId === userId && inv.status === 'pending') {
      derived.push({
        id: `drv_inv_in_${inv.id}`,
        type: 'team_invitation',
        title: `Team Invitation: ${inv.teamName}`,
        message: `${inv.fromUserName} invited you to join ${inv.teamName} (${inv.roleOffered || 'Member'}).`,
        link: '/app/teams',
        actionRequired: true,
        timestampMs: toTimestampMs(inv.createdAt)
      });
    } else if (inv.fromUserId === userId && inv.status === 'accepted') {
      derived.push({
        id: `drv_inv_acc_${inv.id}`,
        type: 'team_accepted',
        title: `Invitation Accepted: ${inv.teamName}`,
        message: `${inv.toUserName} accepted your invitation to join ${inv.teamName}.`,
        link: '/app/builder',
        timestampMs: toTimestampMs(inv.updatedAt)
      });
    }
  }

  for (const a of assigns) {
    if (a.status === 'invited') {
      derived.push({
        id: `drv_asg_${a.id}`,
        type: 'judge_assignment',
        title: `Judging Invitation (${a.assignedSubmissionIds.length} submissions)`,
        message: `Review and accept or decline judging assignment for hackathon ${a.hackathonId}.`,
        link: '/app/judging',
        actionRequired: true,
        timestampMs: toTimestampMs(a.updatedAt) || toTimestampMs(a.createdAt)
      });
    }
  }

  for (const reg of regs) {
    if (reg.status === 'approved' || reg.status === 'rejected') {
      derived.push({
        id: `drv_reg_${reg.id}_${reg.status}`,
        type: 'registration',
        title: `Registration ${reg.status === 'approved' ? 'Approved' : 'Rejected'}`,
        message: `Your registration for hackathon ${reg.hackathonId} is ${reg.status}.`,
        link: reg.status === 'approved' ? '/app/builder' : '/app/discover',
        timestampMs: toTimestampMs(reg.updatedAt) || toTimestampMs(reg.createdAt)
      });
    }
  }

  for (const res of pubResults) {
    derived.push({
      id: `drv_res_${res.hackathonId}`,
      type: 'results',
      title: `Official Results Published (${res.hackathonId})`,
      message: `${res.rankings.length} team ranking(s) are now available on the dashboard.`,
      link: '/app',
      timestampMs: toTimestampMs(res.publishedAt) || toTimestampMs(res.updatedAt)
    });
  }

  return derived.sort((a, b) => b.timestampMs - a.timestampMs);
}

export function subscribeUserNotifications(
  userId: string,
  onData: (items: AppNotification[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  const path = 'notifications';
  const q = query(collection(db, 'notifications'), where('userId', '==', userId));
  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => d.data() as AppNotification));
    },
    (err) => {
      if (onError) {
        onError(err);
      } else {
        console.error(`Firestore notifications listener error (${path}):`, err);
      }
    }
  );
}

export async function markNotificationRead(notificationId: string): Promise<void> {
  const path = `notifications/${notificationId}`;
  try {
    await updateDoc(doc(db, 'notifications', notificationId), { read: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteNotification(notificationId: string): Promise<void> {
  const path = `notifications/${notificationId}`;
  try {
    await deleteDoc(doc(db, 'notifications', notificationId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

// --- Audit Logs & AI Telemetry ---
export async function recordAuditLog(
  entry: Omit<AuditLogEntry, 'id' | 'createdAt'>
): Promise<void> {
  const id = generateFirestoreId('aud');
  const path = `auditLogs/${id}`;
  try {
    await setDoc(doc(db, 'auditLogs', id), {
      id,
      actorId: entry.actorId,
      actorName: sanitizeString(entry.actorName || '', 100),
      action: sanitizeString(entry.action, 80),
      targetCollection: sanitizeString(entry.targetCollection, 60),
      targetId: sanitizeString(entry.targetId, 256),
      hackathonId: sanitizeString(entry.hackathonId || '', 128),
      details: sanitizeString(entry.details || '', 1000),
      createdAt: serverTimestamp()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function listUserAuditLogs(actorId: string): Promise<AuditLogEntry[]> {
  const path = 'auditLogs';
  try {
    const q = query(collection(db, 'auditLogs'), where('actorId', '==', actorId));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as AuditLogEntry);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function adminListAllAuditLogs(): Promise<AuditLogEntry[]> {
  const path = 'auditLogs';
  try {
    const snap = await getDocs(collection(db, 'auditLogs'));
    return snap.docs.map((d) => d.data() as AuditLogEntry);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function recordAIUsageInFirestore(
  usage: Omit<AIUsageRecord, 'createdAt'>
): Promise<void> {
  if (!auth?.currentUser?.emailVerified) {
    return;
  }
  const path = `aiUsage/${usage.id}`;
  try {
    await setDoc(doc(db, 'aiUsage', usage.id), {
      id: usage.id,
      userId: usage.userId,
      taskName: sanitizeString(usage.taskName, 80),
      inferenceSource: usage.inferenceSource,
      requestedMode: usage.requestedMode,
      modelId: sanitizeString(usage.modelId || '', 120),
      durationMs: Math.min(600000, Math.max(0, Math.round(usage.durationMs))),
      fallbackOccurred: Boolean(usage.fallbackOccurred),
      status: usage.status === 'failed' ? 'failed' : 'success',
      createdAt: serverTimestamp()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

// --- Sponsors ---
export async function listSponsorRecords(userId: string): Promise<SponsorRecord[]> {
  const path = 'sponsors';
  try {
    const [bySponsor, byOrganizer] = await Promise.all([
      getDocs(query(collection(db, 'sponsors'), where('sponsorUserId', '==', userId))),
      getDocs(query(collection(db, 'sponsors'), where('organizerId', '==', userId)))
    ]);
    const map = new Map<string, SponsorRecord>();
    bySponsor.docs.forEach((d) => map.set(d.id, d.data() as SponsorRecord));
    byOrganizer.docs.forEach((d) => map.set(d.id, d.data() as SponsorRecord));
    return Array.from(map.values());
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function saveSponsorRecord(
  sponsor: Omit<SponsorRecord, 'id' | 'status' | 'tier' | 'createdAt' | 'updatedAt'> & {
    id?: string;
    tier?: SponsorRecord['tier'];
    status?: SponsorStatus;
  },
  options?: { asApprovedOrganizer?: boolean }
): Promise<string> {
  const id = sponsor.id || generateFirestoreId('spn');
  const path = `sponsors/${id}`;
  try {
    const isNew = !sponsor.id;
    const isOrganizer = Boolean(options?.asApprovedOrganizer);
    if (isNew) {
      await setDoc(doc(db, 'sponsors', id), {
        id,
        hackathonId: sponsor.hackathonId,
        organizerId: sponsor.organizerId,
        sponsorUserId: sponsor.sponsorUserId,
        organizationName: sanitizeString(sponsor.organizationName, 120),
        tier: isOrganizer ? sponsor.tier || 'community' : 'community',
        status: isOrganizer && sponsor.status === 'approved' ? 'approved' : 'pending',
        websiteUrl: sanitizeString(sponsor.websiteUrl || '', 300),
        notes: sanitizeString(sponsor.notes || '', 1500),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } else {
      await updateDoc(doc(db, 'sponsors', id), {
        organizationName: sanitizeString(sponsor.organizationName, 120),
        websiteUrl: sanitizeString(sponsor.websiteUrl || '', 300),
        notes: sanitizeString(sponsor.notes || '', 1500),
        updatedAt: serverTimestamp()
      });
    }
    return id;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function reviewSponsorRequest(params: {
  sponsorId: string;
  status: 'approved' | 'rejected';
  tier: SponsorRecord['tier'];
  notes?: string;
}): Promise<void> {
  const path = `sponsors/${params.sponsorId}`;
  try {
    await updateDoc(doc(db, 'sponsors', params.sponsorId), {
      status: params.status,
      tier: params.tier,
      ...(params.notes !== undefined ? { notes: sanitizeString(params.notes, 1500) } : {}),
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}
