import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetDoc = vi.fn();
const mockGetDocs = vi.fn();
const mockSetDoc = vi.fn();
const mockDeleteDoc = vi.fn(async (..._args: unknown[]) => undefined);
const mockWriteBatchSet = vi.fn();
const mockWriteBatchUpdate = vi.fn();
const mockWriteBatchCommit = vi.fn();
const mockTxGet = vi.fn();
const mockTxUpdate = vi.fn();
const mockRunTransaction = vi.fn(
  async (_db: unknown, updateFn: (tx: { get: typeof mockTxGet; update: typeof mockTxUpdate }) => Promise<unknown>) =>
    updateFn({ get: mockTxGet, update: mockTxUpdate })
);

const mockAuthState: {
  currentUser: {
    uid: string;
    emailVerified: boolean;
    getIdTokenResult?: () => Promise<{ claims: { email_verified?: boolean } }>;
    getIdToken?: (forceRefresh?: boolean) => Promise<string>;
  } | null;
} = {
  currentUser: null
};

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  arrayUnion: vi.fn((val) => ({ __op: 'arrayUnion', val })),
  collection: vi.fn((_, col) => `collection:${col}`),
  deleteDoc: (...args: unknown[]) => mockDeleteDoc(...args),
  query: vi.fn((colRef, ...constraints) => ({ colRef, constraints })),
  where: vi.fn((field, op, value) => ({ field, op, value })),
  doc: vi.fn((_, ...segments) => segments.join('/')),
  getDoc: (...args: unknown[]) => mockGetDoc(...args),
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
  setDoc: (...args: unknown[]) => mockSetDoc(...args),
  Timestamp: {
    fromDate: vi.fn((d: Date) => ({
      toMillis: () => d.getTime(),
      seconds: Math.floor(d.getTime() / 1000)
    }))
  },
  runTransaction: (db: unknown, fn: (tx: { get: typeof mockTxGet; update: typeof mockTxUpdate }) => Promise<unknown>) =>
    mockRunTransaction(db, fn),
  serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP'),
  writeBatch: vi.fn(() => ({
    set: mockWriteBatchSet,
    update: mockWriteBatchUpdate,
    delete: vi.fn(),
    commit: mockWriteBatchCommit
  }))
}));

vi.mock('../../src/services/firebase/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/firebase/config')>();
  return {
    ...actual,
    db: {},
    auth: {
      get currentUser() {
        return mockAuthState.currentUser;
      }
    }
  };
});

import {
  approveOwnPendingRegistration,
  createTeamWithLeader,
  joinTeamByCode,
  listOrganizerRegistrations,
  listUserRegistrations,
  normalizeHackathonDoc,
  reapplyForHackathon,
  registerForHackathon,
  resolveApprovedRegistrationForHackathon,
  respondToTeamInvitation,
  rotateTeamJoinCode,
  updateRegistrationStatus,
  verifyUserRegistrationApproved,
  withdrawParticipantRegistration
} from '../../src/services/firebase/firestoreService';
import {
  buildRegistrationWithdrawalAuditEntry,
  formatActionableError,
  indexOrganizerRegistrations,
  indexRegistrationsByHackathon,
  mapRegistrationDocData,
  selectPreferredRegistration
} from '../../src/utils/registrationResolution';
import type { HackathonRegistration } from '../../src/types/domain';

function makeRegDoc(reg: Partial<HackathonRegistration> & { id: string }) {
  return {
    id: reg.id,
    data: () => ({
      id: reg.id,
      hackathonId: reg.hackathonId || 'hack_1',
      organizerId: reg.organizerId || 'org_1',
      userId: reg.userId || 'user_1',
      userName: reg.userName || 'Builder',
      userTitle: '',
      preferredTrack: 'AI',
      motivation: '',
      status: reg.status || 'pending',
      createdAt: reg.createdAt,
      updatedAt: reg.updatedAt
    })
  };
}

describe('Registration Resolution & Team Creation Authorization (10 Scenarios)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState.currentUser = null;
    mockWriteBatchCommit.mockResolvedValue(undefined);
    mockSetDoc.mockResolvedValue(undefined);
    mockTxUpdate.mockReturnValue(undefined);
  });

  it('1a. Approved participant (composite ID) can verify & create a team without second organizer approval', async () => {
    mockAuthState.currentUser = { uid: 'user_approved', emailVerified: true };
    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      id: 'hack_1_user_approved',
      data: () => ({
        id: 'hack_1_user_approved',
        hackathonId: 'hack_1',
        organizerId: 'org_1',
        userId: 'user_approved',
        status: 'approved'
      })
    });

    const resolved = await resolveApprovedRegistrationForHackathon('user_approved', 'hack_1');
    expect(resolved.approved).toBe(true);
    expect(resolved.registrationId).toBe('hack_1_user_approved');

    // Reset mockGetDoc for createTeamWithLeader call
    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      id: 'hack_1_user_approved',
      data: () => ({
        id: 'hack_1_user_approved',
        hackathonId: 'hack_1',
        organizerId: 'org_1',
        userId: 'user_approved',
        status: 'approved'
      })
    });

    const created = await createTeamWithLeader({
      hackathonId: 'hack_1',
      organizerId: 'org_1',
      name: 'Alpha Squad',
      description: '',
      leaderId: 'user_approved',
      memberIds: ['user_approved'],
      memberNames: ['Approved Builder'],
      lookingForRoles: ['Designer'],
      track: 'AI',
      status: 'forming'
    });

    expect(created.id).toMatch(/^team_/);
    expect(created.joinCode).toMatch(/^HM-/);
    expect(mockWriteBatchCommit).toHaveBeenCalledTimes(1);

    const teamSetCall = mockWriteBatchSet.mock.calls.find(([p]) =>
      String(p).startsWith('teams/team_') && !String(p).includes('/members/') && !String(p).includes('/private/')
    );
    expect(teamSetCall).toBeDefined();
    expect(teamSetCall?.[1]).toEqual(
      expect.objectContaining({
        id: created.id,
        hackathonId: 'hack_1',
        organizerId: 'org_1',
        leaderId: 'user_approved',
        memberIds: ['user_approved'],
        memberNames: ['Approved Builder'],
        status: 'forming'
      })
    );
    // Canonical composite registration IDs must omit registrationId so both current and legacy rules verify registrations/{hackathonId}_{uid}
    expect(teamSetCall?.[1]).not.toHaveProperty('registrationId');

    const memberSetCall = mockWriteBatchSet.mock.calls.find(([p]) =>
      String(p).includes(`/members/user_approved`)
    );
    expect(memberSetCall).toBeDefined();
    expect(memberSetCall?.[1]).not.toHaveProperty('registrationId');
  });

  it('1b. Approved participant with non-composite doc ID OR duplicate stale pending record can still create a team (including registrationId fallback)', async () => {
    mockAuthState.currentUser = { uid: 'user_legacy', emailVerified: true };
    // Composite doc does not exist
    mockGetDoc.mockResolvedValueOnce({
      exists: () => false,
      data: () => null
    });
    // Query returns stale pending record first, then approved non-composite record
    mockGetDocs.mockResolvedValueOnce({
      docs: [
        makeRegDoc({
          id: 'reg_old_pending',
          hackathonId: 'hack_1',
          userId: 'user_legacy',
          status: 'pending'
        }),
        makeRegDoc({
          id: 'reg_non_composite_approved',
          hackathonId: 'hack_1',
          userId: 'user_legacy',
          status: 'approved'
        })
      ]
    });

    const resolved = await resolveApprovedRegistrationForHackathon('user_legacy', 'hack_1');
    expect(resolved.approved).toBe(true);
    expect(resolved.registrationId).toBe('reg_non_composite_approved');

    mockGetDoc.mockResolvedValueOnce({ exists: () => false, data: () => null });
    mockGetDocs.mockResolvedValueOnce({
      docs: [
        makeRegDoc({
          id: 'reg_non_composite_approved',
          hackathonId: 'hack_1',
          userId: 'user_legacy',
          status: 'approved'
        })
      ]
    });

    const created = await createTeamWithLeader({
      hackathonId: 'hack_1',
      organizerId: 'org_1',
      name: 'Legacy Squad',
      description: '',
      leaderId: 'user_legacy',
      memberIds: ['user_legacy'],
      memberNames: ['   '],
      lookingForRoles: ['Engineer'],
      track: 'AI',
      status: 'forming'
    });

    expect(created.id).toMatch(/^team_/);
    const teamSetCall = mockWriteBatchSet.mock.calls.find(([p]) =>
      String(p).startsWith('teams/team_') && !String(p).includes('/members/') && !String(p).includes('/private/')
    );
    expect(teamSetCall?.[1]).toEqual(
      expect.objectContaining({
        registrationId: 'reg_non_composite_approved'
      })
    );
    const memberSetCall = mockWriteBatchSet.mock.calls.find(([p]) =>
      String(p).includes('/members/user_legacy')
    );
    expect(memberSetCall?.[1]).toEqual(
      expect.objectContaining({
        displayName: 'Team Lead',
        registrationId: 'reg_non_composite_approved'
      })
    );
  });

  it('2. Pending participant cannot verify approval or create a team', async () => {
    mockAuthState.currentUser = { uid: 'user_pending', emailVerified: true };
    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      id: 'hack_1_user_pending',
      data: () => ({
        id: 'hack_1_user_pending',
        hackathonId: 'hack_1',
        userId: 'user_pending',
        status: 'pending'
      })
    });
    mockGetDocs.mockResolvedValueOnce({
      docs: [
        makeRegDoc({
          id: 'hack_1_user_pending',
          hackathonId: 'hack_1',
          userId: 'user_pending',
          status: 'pending'
        })
      ]
    });

    await expect(
      createTeamWithLeader({
        hackathonId: 'hack_1',
        organizerId: 'org_1',
        name: 'Pending Squad',
        description: '',
        leaderId: 'user_pending',
        memberIds: ['user_pending'],
        memberNames: ['Pending Builder'],
        lookingForRoles: [],
        track: 'AI',
        status: 'forming'
      })
    ).rejects.toThrow(/pending registration must be confirmed/i);
    expect(mockWriteBatchCommit).not.toHaveBeenCalled();
  });

  it('3. Rejected participant cannot create a team', async () => {
    mockAuthState.currentUser = { uid: 'user_rejected', emailVerified: true };
    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      id: 'hack_1_user_rejected',
      data: () => ({
        id: 'hack_1_user_rejected',
        hackathonId: 'hack_1',
        userId: 'user_rejected',
        status: 'rejected'
      })
    });
    mockGetDocs.mockResolvedValueOnce({ docs: [] });

    const res = await resolveApprovedRegistrationForHackathon('user_rejected', 'hack_1');
    expect(res.approved).toBe(false);
    expect(res.status).toBe('rejected');
    expect(res.reason).toMatch(/rejected/i);
  });

  it('4. Withdrawn participant cannot create a team', async () => {
    mockAuthState.currentUser = { uid: 'user_withdrawn', emailVerified: true };
    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      id: 'hack_1_user_withdrawn',
      data: () => ({
        id: 'hack_1_user_withdrawn',
        hackathonId: 'hack_1',
        userId: 'user_withdrawn',
        status: 'withdrawn'
      })
    });
    mockGetDocs.mockResolvedValueOnce({ docs: [] });

    const res = await resolveApprovedRegistrationForHackathon('user_withdrawn', 'hack_1');
    expect(res.approved).toBe(false);
    expect(res.status).toBe('withdrawn');
    expect(res.reason).toMatch(/withdrawn/i);
  });

  it('5. Unregistered user cannot create a team', async () => {
    mockAuthState.currentUser = { uid: 'user_unregistered', emailVerified: true };
    mockGetDoc.mockResolvedValueOnce({
      exists: () => false,
      data: () => null
    });
    mockGetDocs.mockResolvedValueOnce({ docs: [] });

    const isApproved = await verifyUserRegistrationApproved('user_unregistered', 'hack_1');
    expect(isApproved).toBe(false);
  });

  it('6. Approval for Hackathon A does not authorize team creation in Hackathon B', async () => {
    mockAuthState.currentUser = { uid: 'user_hack_a', emailVerified: true };
    mockGetDoc.mockResolvedValueOnce({
      exists: () => false,
      data: () => null
    });
    mockGetDocs.mockResolvedValueOnce({
      docs: [
        makeRegDoc({
          id: 'hack_A_user_hack_a',
          hackathonId: 'hack_A',
          userId: 'user_hack_a',
          status: 'approved'
        })
      ]
    });

    const res = await resolveApprovedRegistrationForHackathon('user_hack_a', 'hack_B');
    expect(res.approved).toBe(false);
    expect(res.registration).toBeNull();
  });

  it('7. Empty/unauthenticated UID is rejected and Firestore errors propagate instead of returning false', async () => {
    const noUid = await resolveApprovedRegistrationForHackathon('', 'hack_1');
    expect(noUid.approved).toBe(false);

    mockGetDoc.mockRejectedValueOnce(new Error('permission-denied: Missing permissions'));
    await expect(verifyUserRegistrationApproved('user_1', 'hack_1')).rejects.toThrow(
      /permission-denied/i
    );
  });

  it('8. Participant cannot create a team on behalf of another user', async () => {
    mockAuthState.currentUser = { uid: 'attacker_uid', emailVerified: true };
    await expect(
      createTeamWithLeader({
        hackathonId: 'hack_1',
        organizerId: 'org_1',
        name: 'Spoofed Team',
        description: '',
        leaderId: 'victim_uid',
        memberIds: ['victim_uid'],
        memberNames: ['Victim'],
        lookingForRoles: [],
        track: 'AI',
        status: 'forming'
      })
    ).rejects.toThrow(/another user/i);
    expect(mockWriteBatchCommit).not.toHaveBeenCalled();
  });

  it('9. Mismatched userId inside a composite registration document is rejected', async () => {
    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      id: 'hack_1_user_approved',
      data: () => ({
        id: 'hack_1_user_approved',
        hackathonId: 'hack_1',
        userId: 'user_approved',
        status: 'approved'
      })
    });
    mockGetDocs.mockResolvedValueOnce({ docs: [] });

    const isApproved = await verifyUserRegistrationApproved('user_attacker', 'hack_1');
    expect(isApproved).toBe(false);
  });

  it('10. Unified registration indexing ensures Discover & Builder always agree regardless of record order', () => {
    const records: HackathonRegistration[] = [
      {
        id: 'legacy_pending',
        hackathonId: 'hack_1',
        organizerId: 'org_1',
        userId: 'u1',
        userName: 'U1',
        userTitle: '',
        preferredTrack: 'AI',
        motivation: '',
        status: 'pending'
      },
      {
        id: 'hack_1_u1',
        hackathonId: 'hack_1',
        organizerId: 'org_1',
        userId: 'u1',
        userName: 'U1',
        userTitle: '',
        preferredTrack: 'AI',
        motivation: '',
        status: 'approved'
      },
      {
        id: 'legacy_withdrawn',
        hackathonId: 'hack_1',
        organizerId: 'org_1',
        userId: 'u1',
        userName: 'U1',
        userTitle: '',
        preferredTrack: 'AI',
        motivation: '',
        status: 'withdrawn'
      }
    ];

    const preferred = selectPreferredRegistration(records, 'hack_1', 'u1');
    const indexed = indexRegistrationsByHackathon(records, 'u1');
    expect(preferred?.id).toBe('hack_1_u1');
    expect(preferred?.status).toBe('approved');
    expect(indexed.get('hack_1')?.id).toBe('hack_1_u1');
    expect(indexed.get('hack_1')?.status).toBe('approved');

    expect(
      formatActionableError(
        new Error(
          JSON.stringify({
            error: 'Missing or insufficient permissions.',
            path: 'teams/team_1'
          })
        ),
        'Fallback'
      )
    ).toBe('Missing or insufficient permissions. (teams/team_1)');
  });
});

describe('Registration Approval Integrity & Transactional Transition Guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState.currentUser = null;
    mockSetDoc.mockResolvedValue(undefined);
    mockTxUpdate.mockReturnValue(undefined);
  });

  it('A. Organizer approval uses the real Firestore document snapshot ID (d.id), ignoring stale data.id', async () => {
    mockAuthState.currentUser = { uid: 'org_1', emailVerified: true };
    const realDocId = 'hack_mwl6rcwa_6545644f368d41_user_1';

    mockGetDocs.mockResolvedValueOnce({
      docs: [
        {
          id: realDocId,
          data: () => ({
            id: 'stale_wrong_data_id',
            hackathonId: 'hack_mwl6rcwa_6545644f368d41',
            organizerId: 'org_1',
            userId: 'user_1',
            userName: 'Participant One',
            userTitle: '',
            preferredTrack: 'AI',
            motivation: '',
            status: 'pending'
          })
        }
      ]
    });

    const orgRegs = await listOrganizerRegistrations('org_1');
    expect(orgRegs).toHaveLength(1);
    expect(orgRegs[0].id).toBe(realDocId);

    mockTxGet.mockResolvedValueOnce({
      exists: () => true,
      id: realDocId,
      data: () => ({
        status: 'pending'
      })
    });

    await updateRegistrationStatus(orgRegs[0].id, 'approved', {
      expectedCurrentStatus: orgRegs[0].status,
      actorRole: 'organizer'
    });

    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
    expect(mockTxUpdate).toHaveBeenCalledWith(
      `registrations/${realDocId}`,
      expect.objectContaining({ status: 'approved' })
    );
  });

  it('B. Approved registration is never masked by withdrawn duplicates across Discover, Organizer Studio, and Builder Workspace', async () => {
    const hackId = 'hack_mwl6rcwa_6545644f368d41';
    const uid = 'user_1';
    const docs = [
      mapRegistrationDocData(`${hackId}_${uid}`, {
        id: `${hackId}_${uid}`,
        hackathonId: hackId,
        organizerId: 'org_1',
        userId: uid,
        userName: 'Builder',
        userTitle: '',
        preferredTrack: 'AI',
        motivation: '',
        status: 'withdrawn'
      }),
      mapRegistrationDocData('reg_approved_alt', {
        id: 'reg_approved_alt',
        hackathonId: hackId,
        organizerId: 'org_1',
        userId: uid,
        userName: 'Builder',
        userTitle: '',
        preferredTrack: 'AI',
        motivation: '',
        status: 'approved'
      })
    ];

    // Reversed order as well
    const reversed = [...docs].reverse();

    const discoverA = indexRegistrationsByHackathon(docs, uid).get(hackId);
    const discoverB = indexRegistrationsByHackathon(reversed, uid).get(hackId);
    const orgA = indexOrganizerRegistrations(docs).resolved[0];
    const orgB = indexOrganizerRegistrations(reversed).resolved[0];

    expect(discoverA?.id).toBe('reg_approved_alt');
    expect(discoverA?.status).toBe('approved');
    expect(discoverB?.id).toBe('reg_approved_alt');
    expect(orgA?.id).toBe('reg_approved_alt');
    expect(orgA?.status).toBe('approved');
    expect(orgB?.id).toBe('reg_approved_alt');
    expect(indexOrganizerRegistrations(docs).duplicateCountByKey.get(`${hackId}::${uid}`)).toBe(2);

    // Builder verification also resolves to the exact approved doc ID
    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      id: `${hackId}_${uid}`,
      data: () => docs[0]
    });
    mockGetDocs.mockResolvedValueOnce({
      docs: docs.map((d) => ({ id: d.id, data: () => d }))
    });

    const verified = await resolveApprovedRegistrationForHackathon(uid, hackId);
    expect(verified.approved).toBe(true);
    expect(verified.status).toBe('approved');
    expect(verified.registrationId).toBe('reg_approved_alt');
  });

  it('C. Stale withdrawal action cannot overwrite an approved status in Firestore', async () => {
    const hackId = 'hack_mwl6rcwa_6545644f368d41';
    const uid = 'user_1';
    const regId = `${hackId}_${uid}`;
    mockAuthState.currentUser = { uid, emailVerified: true };

    // Case 1: Stale UI thinks status is still 'pending', but Firestore already has 'approved'
    mockTxGet.mockResolvedValueOnce({
      exists: () => true,
      id: regId,
      data: () => ({ status: 'approved' })
    });

    await expect(
      withdrawParticipantRegistration({
        registration: {
          id: regId,
          hackathonId: hackId,
          organizerId: 'org_1',
          userId: uid,
          userName: 'Builder',
          userTitle: '',
          preferredTrack: 'AI',
          motivation: '',
          status: 'pending'
        },
        actorId: uid,
        actorName: 'Builder',
        confirmed: true
      })
    ).rejects.toThrow(/Registration status conflict/i);
    expect(mockTxUpdate).not.toHaveBeenCalled();

    // Case 2: Unconfirmed withdrawal call is rejected before touching Firestore
    await expect(
      withdrawParticipantRegistration({
        registration: {
          id: regId,
          hackathonId: hackId,
          organizerId: 'org_1',
          userId: uid,
          userName: 'Builder',
          userTitle: '',
          preferredTrack: 'AI',
          motivation: '',
          status: 'approved'
        },
        actorId: uid,
        actorName: 'Builder',
        confirmed: false
      })
    ).rejects.toThrow(/Explicit confirmation is required/i);
    expect(mockTxUpdate).not.toHaveBeenCalled();

    // Case 3: Direct updateRegistrationStatus(..., 'withdrawn') without confirmed + expectedCurrentStatus rejects
    mockTxGet.mockResolvedValueOnce({
      exists: () => true,
      id: regId,
      data: () => ({ status: 'approved' })
    });
    await expect(updateRegistrationStatus(regId, 'withdrawn')).rejects.toThrow(
      /Explicit participant confirmation is required/i
    );
    expect(mockTxUpdate).not.toHaveBeenCalled();

    // Case 4: Stale reapplyForHackathon cannot revert an 'approved' registration back to 'pending'
    mockTxGet.mockResolvedValueOnce({
      exists: () => true,
      id: regId,
      data: () => ({ status: 'approved' })
    });
    await expect(
      reapplyForHackathon(regId, { preferredTrack: 'AI', motivation: 'Retry' })
    ).rejects.toThrow(/Registration status conflict/i);
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });

  it('D. Successful approval remains approved after refreshing user & organizer views', async () => {
    const hackId = 'hack_mwl6rcwa_6545644f368d41';
    const uid = 'user_1';
    const regId = `${hackId}_${uid}`;
    mockAuthState.currentUser = { uid: 'org_1', emailVerified: true };

    mockTxGet.mockResolvedValueOnce({
      exists: () => true,
      id: regId,
      data: () => ({ status: 'pending' })
    });

    await updateRegistrationStatus(regId, 'approved', {
      expectedCurrentStatus: 'pending',
      actorRole: 'organizer'
    });
    expect(mockTxUpdate).toHaveBeenCalledWith(
      `registrations/${regId}`,
      expect.objectContaining({ status: 'approved' })
    );

    // Simulate page refresh for participant and organizer
    mockGetDocs.mockResolvedValueOnce({
      docs: [
        {
          id: regId,
          data: () => ({
            id: regId,
            hackathonId: hackId,
            organizerId: 'org_1',
            userId: uid,
            userName: 'Builder',
            userTitle: '',
            preferredTrack: 'AI',
            motivation: '',
            status: 'approved'
          })
        }
      ]
    });
    const refreshedUserRegs = await listUserRegistrations(uid);
    expect(indexRegistrationsByHackathon(refreshedUserRegs, uid).get(hackId)?.status).toBe(
      'approved'
    );

    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      id: regId,
      data: () => ({
        id: regId,
        hackathonId: hackId,
        organizerId: 'org_1',
        userId: uid,
        userName: 'Builder',
        userTitle: '',
        preferredTrack: 'AI',
        motivation: '',
        status: 'approved'
      })
    });
    const builderVerification = await resolveApprovedRegistrationForHackathon(uid, hackId);
    expect(builderVerification.approved).toBe(true);
    expect(builderVerification.status).toBe('approved');
  });

  it('E. Confirmed participant withdrawal records a validated registration_withdrawn audit event', async () => {
    const hackId = 'hack_mwl6rcwa_6545644f368d41';
    const uid = 'user_1';
    const regId = `${hackId}_${uid}`;
    mockAuthState.currentUser = { uid, emailVerified: true };

    mockTxGet.mockResolvedValueOnce({
      exists: () => true,
      id: regId,
      data: () => ({ status: 'approved' })
    });

    const result = await withdrawParticipantRegistration({
      registration: {
        id: regId,
        hackathonId: hackId,
        organizerId: 'org_1',
        userId: uid,
        userName: 'Builder',
        userTitle: '',
        preferredTrack: 'AI',
        motivation: '',
        status: 'approved'
      },
      actorId: uid,
      actorName: 'Builder',
      confirmed: true
    });

    expect(result).toEqual({ previousStatus: 'approved', registrationId: regId });
    expect(mockTxUpdate).toHaveBeenCalledWith(
      `registrations/${regId}`,
      expect.objectContaining({ status: 'withdrawn' })
    );
    expect(mockSetDoc).toHaveBeenCalledWith(
      expect.stringMatching(/^auditLogs\/aud_/),
      expect.objectContaining({
        actorId: uid,
        action: 'registration_withdrawn',
        targetCollection: 'registrations',
        targetId: regId,
        hackathonId: hackId
      })
    );

    expect(() =>
      buildRegistrationWithdrawalAuditEntry({
        actorId: '',
        registrationId: regId,
        hackathonId: hackId,
        previousStatus: 'approved'
      })
    ).toThrow(/actorId is required/i);
  });

  it('F. Team creation validates team name, refreshes stale email_verified JWT claims, normalizes hackathon docId, and keeps canonical join/invite payloads compatible', async () => {
    const getIdToken = vi.fn(async () => 'fresh-token');
    mockAuthState.currentUser = {
      uid: 'u_fresh',
      emailVerified: true,
      getIdTokenResult: vi.fn(async () => ({ claims: { email_verified: false } })),
      getIdToken
    };

    // Short trimmed team name is rejected prior to any Firestore write
    await expect(
      createTeamWithLeader({
        hackathonId: 'hack_1',
        organizerId: 'org_1',
        name: 'A   ',
        description: '',
        leaderId: 'u_fresh',
        memberIds: ['u_fresh'],
        memberNames: ['Builder'],
        lookingForRoles: [],
        track: 'AI',
        status: 'forming'
      })
    ).rejects.toThrow(/at least 2 characters/i);
    expect(getIdToken).toHaveBeenCalledWith(true);
    expect(mockWriteBatchCommit).not.toHaveBeenCalled();

    // normalizeHackathonDoc uses authoritative snapshot docId over stale raw.id
    const normalized = normalizeHackathonDoc('hack_real_doc_id', {
      id: 'hack_stale_raw_id',
      organizerId: 'org_1',
      title: 'Recreated Hackathon',
      description: 'Valid hackathon description',
      status: 'published'
    });
    expect(normalized.id).toBe('hack_real_doc_id');

    // joinTeamByCode reads hackathonId from teamJoinCodes without pre-join teams/{teamId} read and omits registrationId
    mockGetDoc
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ teamId: 'team_1', hackathonId: 'hack_1', leaderId: 'leader_1', active: true })
      })
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_1_u_fresh',
        data: () => ({
          id: 'hack_1_u_fresh',
          hackathonId: 'hack_1',
          userId: 'u_fresh',
          status: 'approved'
        })
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ id: 'team_1', hackathonId: 'hack_1' })
      });

    await joinTeamByCode('HM-00112233445566778899AABBCCDDEEFF', 'u_fresh', 'Fresh Builder');
    // Verify pre-join reads did NOT read teams/team_1; teams/team_1 was only read post-commit (3rd call)
    expect(mockGetDoc).toHaveBeenCalledTimes(3);
    expect(String(mockGetDoc.mock.calls[0]?.[0])).toMatch(/^teamJoinCodes\//);
    expect(String(mockGetDoc.mock.calls[1]?.[0])).toBe('registrations/hack_1_u_fresh');
    expect(String(mockGetDoc.mock.calls[2]?.[0])).toBe('teams/team_1');
    const joinClaimCall = mockWriteBatchSet.mock.calls.find(([p]) =>
      String(p).includes('/joinClaims/u_fresh')
    );
    expect(joinClaimCall?.[1]).not.toHaveProperty('registrationId');

    // respondToTeamInvitation omits registrationId for canonical composite registration
    vi.clearAllMocks();
    mockWriteBatchCommit.mockResolvedValue(undefined);
    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      id: 'hack_1_u_fresh',
      data: () => ({
        id: 'hack_1_u_fresh',
        hackathonId: 'hack_1',
        userId: 'u_fresh',
        status: 'approved'
      })
    });
    await respondToTeamInvitation(
      {
        id: 'inv_1',
        teamId: 'team_1',
        teamName: 'Alpha',
        hackathonId: 'hack_1',
        fromUserId: 'leader_1',
        fromUserName: 'Leader',
        toUserId: 'u_fresh',
        toUserName: 'Fresh Builder',
        roleOffered: 'Engineer',
        message: 'Join',
        status: 'pending'
      },
      true,
      'Fresh Builder'
    );
    const invClaimCall = mockWriteBatchSet.mock.calls.find(([p]) =>
      String(p).includes('/joinClaims/u_fresh')
    );
    expect(invClaimCall?.[1]).not.toHaveProperty('registrationId');
  });

  it('G. registerForHackathon immediately approves eligible participants and prevents duplicates or rejected bypasses', async () => {
    const getIdToken = vi.fn(async () => 'fresh-token');
    mockAuthState.currentUser = {
      uid: 'u_new',
      emailVerified: true,
      getIdTokenResult: vi.fn(async () => ({ claims: { email_verified: true } })),
      getIdToken
    };

    const futureHack = {
      id: 'hack_open',
      organizerId: 'org_1',
      status: 'published',
      registrationDeadline: '2099-12-31'
    };

    // 1. Brand new registration creates approved record immediately
    mockGetDoc.mockResolvedValueOnce({ exists: () => true, id: 'hack_open', data: () => futureHack });
    mockGetDocs.mockResolvedValueOnce({ docs: [] });
    mockTxGet.mockResolvedValueOnce({ exists: () => false, data: () => null });
    const mockTxSet = vi.fn();
    mockRunTransaction.mockImplementationOnce(async (_db, fn) =>
      fn({ get: mockTxGet, update: mockTxUpdate, set: mockTxSet } as unknown as {
        get: typeof mockTxGet;
        update: typeof mockTxUpdate;
      })
    );

    const createdRegId = await registerForHackathon({
      hackathonId: 'hack_open',
      organizerId: 'org_1',
      userId: 'u_new',
      userName: 'New Builder',
      userTitle: 'Developer',
      preferredTrack: 'AI',
      motivation: 'Excited to build'
    });
    expect(createdRegId).toBe('hack_open_u_new');
    expect(mockTxSet).toHaveBeenCalledWith(
      'registrations/hack_open_u_new',
      expect.objectContaining({
        id: 'hack_open_u_new',
        hackathonId: 'hack_open',
        userId: 'u_new',
        status: 'approved'
      })
    );

    // 2. Duplicate registration while already approved is rejected
    vi.clearAllMocks();
    mockGetDoc.mockResolvedValueOnce({ exists: () => true, id: 'hack_open', data: () => futureHack });
    mockGetDocs.mockResolvedValueOnce({
      docs: [
        makeRegDoc({
          id: 'hack_open_u_new',
          hackathonId: 'hack_open',
          userId: 'u_new',
          status: 'approved'
        })
      ]
    });
    await expect(
      registerForHackathon({
        hackathonId: 'hack_open',
        organizerId: 'org_1',
        userId: 'u_new',
        userName: 'New Builder',
        userTitle: '',
        preferredTrack: 'AI',
        motivation: ''
      })
    ).rejects.toThrow(/already registered and approved/i);

    // 3. Rejected participant cannot re-register to bypass organizer rejection
    vi.clearAllMocks();
    mockGetDoc.mockResolvedValueOnce({ exists: () => true, id: 'hack_open', data: () => futureHack });
    mockGetDocs.mockResolvedValueOnce({
      docs: [
        makeRegDoc({
          id: 'hack_open_u_new',
          hackathonId: 'hack_open',
          userId: 'u_new',
          status: 'rejected'
        })
      ]
    });
    await expect(
      registerForHackathon({
        hackathonId: 'hack_open',
        organizerId: 'org_1',
        userId: 'u_new',
        userName: 'New Builder',
        userTitle: '',
        preferredTrack: 'AI',
        motivation: ''
      })
    ).rejects.toThrow(/rejected and cannot be re-submitted/i);

    // 4. Existing pending registration is upgraded in-place to approved
    vi.clearAllMocks();
    mockGetDoc.mockResolvedValueOnce({ exists: () => true, id: 'hack_open', data: () => futureHack });
    mockGetDocs.mockResolvedValueOnce({
      docs: [
        makeRegDoc({
          id: 'hack_open_u_new',
          hackathonId: 'hack_open',
          userId: 'u_new',
          status: 'pending'
        })
      ]
    });
    mockTxGet
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_open_u_new',
        data: () => ({ hackathonId: 'hack_open', userId: 'u_new', status: 'pending' })
      })
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_open',
        data: () => futureHack
      });

    const upgradedId = await registerForHackathon({
      hackathonId: 'hack_open',
      organizerId: 'org_1',
      userId: 'u_new',
      userName: 'New Builder',
      userTitle: '',
      preferredTrack: 'Data',
      motivation: 'Ready'
    });
    expect(upgradedId).toBe('hack_open_u_new');
    expect(mockTxUpdate).toHaveBeenCalledWith(
      'registrations/hack_open_u_new',
      expect.objectContaining({ status: 'approved', preferredTrack: 'Data', motivation: 'Ready' })
    );
  });

  it('H. approveOwnPendingRegistration & reapplyForHackathon auto-approve eligible registrations and enforce rejection & deadline locks', async () => {
    mockAuthState.currentUser = {
      uid: 'u_1',
      emailVerified: true,
      getIdTokenResult: vi.fn(async () => ({ claims: { email_verified: true } }))
    };

    const futureHack = {
      id: 'hack_open',
      organizerId: 'org_1',
      status: 'published',
      registrationDeadline: '2099-12-31'
    };

    // Pending -> Approved succeeds
    mockTxGet
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_open_u_1',
        data: () => ({ hackathonId: 'hack_open', userId: 'u_1', status: 'pending' })
      })
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_open',
        data: () => futureHack
      });
    await approveOwnPendingRegistration('hack_open_u_1');
    expect(mockTxUpdate).toHaveBeenCalledWith(
      'registrations/hack_open_u_1',
      expect.objectContaining({ status: 'approved' })
    );

    // Rejected -> Approved is permanently blocked
    vi.clearAllMocks();
    mockTxGet.mockResolvedValueOnce({
      exists: () => true,
      id: 'hack_open_u_1',
      data: () => ({ hackathonId: 'hack_open', userId: 'u_1', status: 'rejected' })
    });
    await expect(approveOwnPendingRegistration('hack_open_u_1')).rejects.toThrow(
      /Registration status conflict|rejected/i
    );
    expect(mockTxUpdate).not.toHaveBeenCalled();

    // Withdrawn -> Approved via reapplyForHackathon succeeds
    vi.clearAllMocks();
    mockTxGet
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_open_u_1',
        data: () => ({ hackathonId: 'hack_open', userId: 'u_1', status: 'withdrawn' })
      })
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_open',
        data: () => futureHack
      });
    await reapplyForHackathon('hack_open_u_1', { preferredTrack: 'Systems', motivation: 'Back in' });
    expect(mockTxUpdate).toHaveBeenCalledWith(
      'registrations/hack_open_u_1',
      expect.objectContaining({ status: 'approved', preferredTrack: 'Systems', motivation: 'Back in' })
    );

    // Expired deadline blocks pending self-approval
    vi.clearAllMocks();
    mockTxGet
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_closed_u_1',
        data: () => ({ hackathonId: 'hack_closed', userId: 'u_1', status: 'pending' })
      })
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_closed',
        data: () => ({
          id: 'hack_closed',
          organizerId: 'org_1',
          status: 'published',
          registrationDeadline: '2020-01-01'
        })
      });
    await expect(approveOwnPendingRegistration('hack_closed_u_1')).rejects.toThrow(
      /deadline.*passed/i
    );
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });

  it('I. joinTeamByCode rejects revoked codes & self-leader joins, and auto-activates eligible pending registrations before joining', async () => {
    mockAuthState.currentUser = {
      uid: 'u_pending',
      emailVerified: true,
      getIdTokenResult: vi.fn(async () => ({ claims: { email_verified: true } }))
    };

    // Revoked code fails with actionable message
    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({ teamId: 'team_1', hackathonId: 'hack_1', leaderId: 'leader_1', active: false })
    });
    await expect(
      joinTeamByCode('HM-00112233445566778899AABBCCDDEEFF', 'u_pending', 'Pending Builder')
    ).rejects.toThrow(/revoked or rotated/i);

    // Self-leader join fails cleanly
    vi.clearAllMocks();
    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({ teamId: 'team_1', hackathonId: 'hack_1', leaderId: 'u_pending', active: true })
    });
    await expect(
      joinTeamByCode('HM-00112233445566778899AABBCCDDEEFF', 'u_pending', 'Pending Builder')
    ).rejects.toThrow(/already the leader/i);

    // Eligible pending registration auto-activates and completes joinTeamByCode cleanly
    vi.clearAllMocks();
    mockWriteBatchCommit.mockResolvedValue(undefined);
    mockGetDoc
      // 1. teamJoinCodes lookup
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ teamId: 'team_1', hackathonId: 'hack_1', leaderId: 'leader_1', active: true })
      })
      // 2. First resolveApprovedRegistrationForHackathon -> composite doc pending
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_1_u_pending',
        data: () => ({ id: 'hack_1_u_pending', hackathonId: 'hack_1', userId: 'u_pending', status: 'pending' })
      })
      // 3. Second resolveApprovedRegistrationForHackathon after approveOwnPendingRegistration -> now approved
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_1_u_pending',
        data: () => ({ id: 'hack_1_u_pending', hackathonId: 'hack_1', userId: 'u_pending', status: 'approved' })
      })
      // 4. Post-join team read
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ id: 'team_1', hackathonId: 'hack_1', name: 'Nova Squad', memberIds: ['leader_1', 'u_pending'] })
      });
    mockGetDocs.mockResolvedValueOnce({ docs: [] }); // fallback inside first resolve
    mockTxGet
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_1_u_pending',
        data: () => ({ id: 'hack_1_u_pending', hackathonId: 'hack_1', userId: 'u_pending', status: 'pending' })
      })
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_1',
        data: () => ({ id: 'hack_1', organizerId: 'org_1', status: 'published', registrationDeadline: '2099-12-31' })
      });

    const joined = await joinTeamByCode(
      '  hm\u201400112233445566778899aabbccddeeff ',
      'u_pending',
      'Pending Builder'
    );
    expect(joined?.id).toBe('team_1');
    expect(mockTxUpdate).toHaveBeenCalledWith(
      'registrations/hack_1_u_pending',
      expect.objectContaining({ status: 'approved' })
    );
    expect(mockWriteBatchCommit).toHaveBeenCalledTimes(1);
  });

  it('J. New Google-verified participant registers on 3-segment hackathon ID, appears in Builder Workspace, and unlocks team creation immediately', async () => {
    const uid = '2Gr6CjBPT8Ua84UMLOG3ikm9gDl2';
    const hackId = 'hack_mwmjdbkp_676fccf86e8848';
    const orgId = 'org_test_approval_1';
    const expectedRegId = `${hackId}_${uid}`;

    mockAuthState.currentUser = {
      uid,
      emailVerified: true,
      getIdTokenResult: vi.fn(async () => ({ claims: { email_verified: true } })),
      getIdToken: vi.fn(async () => 'fresh-google-token')
    };

    const liveHack = {
      id: hackId,
      organizerId: orgId,
      status: 'published',
      registrationDeadline: '2026-12-10',
      registrationDeadlineAt: { toMillis: () => Date.UTC(2026, 11, 10) }
    };

    // Initial reads during registerForHackathon: hackathon exists, 0 existing registrations, missing composite doc inside transaction
    mockGetDoc.mockResolvedValueOnce({ exists: () => true, id: hackId, data: () => liveHack });
    mockGetDocs.mockResolvedValueOnce({ docs: [] });
    mockTxGet.mockResolvedValueOnce({ exists: () => false, data: () => null });
    const mockTxSet = vi.fn();
    mockRunTransaction.mockImplementationOnce(async (_db, fn) =>
      fn({ get: mockTxGet, update: mockTxUpdate, set: mockTxSet } as unknown as {
        get: typeof mockTxGet;
        update: typeof mockTxUpdate;
      })
    );

    const regId = await registerForHackathon({
      hackathonId: hackId,
      organizerId: orgId,
      userId: uid,
      userName: '   ',
      userTitle: '',
      preferredTrack: 'Artificial Intelligence',
      motivation: 'Ready to build'
    });

    expect(regId).toBe(expectedRegId);
    expect(mockTxGet).toHaveBeenCalledWith(`registrations/${expectedRegId}`);
    expect(mockTxSet).toHaveBeenCalledWith(
      `registrations/${expectedRegId}`,
      expect.objectContaining({
        id: expectedRegId,
        hackathonId: hackId,
        organizerId: orgId,
        userId: uid,
        userName: 'Participant',
        status: 'approved'
      })
    );

    // Post-registration read & Builder Workspace resolution
    const approvedDoc = makeRegDoc({
      id: expectedRegId,
      hackathonId: hackId,
      organizerId: orgId,
      userId: uid,
      userName: 'Participant',
      status: 'approved'
    });
    mockGetDocs.mockResolvedValueOnce({ docs: [approvedDoc] });
    const builderRegs = await listUserRegistrations(uid);
    const builderResolved = indexRegistrationsByHackathon(builderRegs, uid).get(hackId);
    expect(builderResolved?.id).toBe(expectedRegId);
    expect(builderResolved?.status).toBe('approved');

    // Immediate team creation verification and batch commit
    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      id: expectedRegId,
      data: approvedDoc.data
    });
    const teamResult = await createTeamWithLeader({
      hackathonId: hackId,
      organizerId: orgId,
      name: 'Google Builders',
      description: '',
      leaderId: uid,
      memberIds: [uid],
      memberNames: ['Participant'],
      lookingForRoles: ['Frontend'],
      track: 'Artificial Intelligence',
      status: 'forming'
    });
    expect(teamResult.id).toMatch(/^team_/);
    expect(mockWriteBatchCommit).toHaveBeenCalledTimes(1);
  });

  it('K. Reusable invitation code lets 1st, 2nd, and 3rd eligible participants join without deactivating or deleting teamJoinCodes', async () => {
    const sharedCode = 'HM-00112233445566778899AABBCCDDEEFF';
    const joiners = [
      { uid: 'u_join_1', name: 'First Joiner' },
      { uid: 'u_join_2', name: 'Second Joiner' },
      { uid: 'u_join_3', name: 'Third Joiner' }
    ];

    for (const [idx, joiner] of joiners.entries()) {
      vi.clearAllMocks();
      mockWriteBatchCommit.mockResolvedValue(undefined);
      mockAuthState.currentUser = {
        uid: joiner.uid,
        emailVerified: true,
        getIdTokenResult: vi.fn(async () => ({ claims: { email_verified: true } }))
      };

      mockGetDoc
        .mockResolvedValueOnce({
          exists: () => true,
          data: () => ({
            teamId: 'team_reusable',
            hackathonId: 'hack_1',
            leaderId: 'leader_1',
            active: true,
            expiresAt: { toMillis: () => Date.now() + 3_600_000 }
          })
        })
        .mockResolvedValueOnce({
          exists: () => true,
          id: `hack_1_${joiner.uid}`,
          data: () => ({
            id: `hack_1_${joiner.uid}`,
            hackathonId: 'hack_1',
            userId: joiner.uid,
            status: 'approved'
          })
        })
        .mockResolvedValueOnce({
          exists: () => true,
          data: () => ({
            id: 'team_reusable',
            hackathonId: 'hack_1',
            memberIds: ['leader_1', ...joiners.slice(0, idx + 1).map((j) => j.uid)]
          })
        });

      const joinedTeam = await joinTeamByCode(sharedCode, joiner.uid, joiner.name);
      expect(joinedTeam?.id).toBe('team_reusable');
      expect(joinedTeam?.memberIds).toContain(joiner.uid);
      expect(mockWriteBatchCommit).toHaveBeenCalledTimes(1);

      // Only the per-user transient joinClaim is deleted post-commit; teamJoinCodes stays active
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
      expect(String(mockDeleteDoc.mock.calls[0]?.[0])).toBe(
        `teams/team_reusable/joinClaims/${joiner.uid}`
      );
      const deactivatedCodeUpdate = mockWriteBatchUpdate.mock.calls.find(([p]) =>
        String(p).startsWith('teamJoinCodes/')
      );
      expect(deactivatedCodeUpdate).toBeUndefined();
    }
  });

  it('L. Reusable code handles expiration, rotation clearing stale expiresAt, duplicate joins, locked teams, and full-team permission denials', async () => {
    // 1. Expired joinCode rejects clearly prior to writing
    mockAuthState.currentUser = {
      uid: 'u_late',
      emailVerified: true,
      getIdTokenResult: vi.fn(async () => ({ claims: { email_verified: true } }))
    };
    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({
        teamId: 'team_1',
        hackathonId: 'hack_1',
        leaderId: 'leader_1',
        active: true,
        expiresAt: { toMillis: () => Date.now() - 60_000 }
      })
    });
    await expect(
      joinTeamByCode('HM-00112233445566778899AABBCCDDEEFF', 'u_late', 'Late User')
    ).rejects.toThrow(/expired/i);
    expect(mockWriteBatchCommit).not.toHaveBeenCalled();

    // 2. Duplicate membership on permission-denied surfaces specific message
    vi.clearAllMocks();
    mockAuthState.currentUser = {
      uid: 'u_dup',
      emailVerified: true,
      getIdTokenResult: vi.fn(async () => ({ claims: { email_verified: true } }))
    };
    mockGetDoc
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ teamId: 'team_1', hackathonId: 'hack_1', leaderId: 'leader_1', active: true })
      })
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_1_u_dup',
        data: () => ({ id: 'hack_1_u_dup', hackathonId: 'hack_1', userId: 'u_dup', status: 'approved' })
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ id: 'team_1', hackathonId: 'hack_1', status: 'forming', memberIds: ['leader_1', 'u_dup'] })
      });
    mockWriteBatchCommit.mockRejectedValueOnce(
      Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' })
    );
    await expect(
      joinTeamByCode('HM-00112233445566778899AABBCCDDEEFF', 'u_dup', 'Dup User')
    ).rejects.toThrow(/already a member/i);

    // 3. Locked/submitted team surfaces locked/submitted error
    vi.clearAllMocks();
    mockAuthState.currentUser = {
      uid: 'u_lock',
      emailVerified: true,
      getIdTokenResult: vi.fn(async () => ({ claims: { email_verified: true } }))
    };
    mockGetDoc
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ teamId: 'team_1', hackathonId: 'hack_1', leaderId: 'leader_1', active: true })
      })
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_1_u_lock',
        data: () => ({ id: 'hack_1_u_lock', hackathonId: 'hack_1', userId: 'u_lock', status: 'approved' })
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ id: 'team_1', hackathonId: 'hack_1', status: 'locked', memberIds: ['leader_1'] })
      });
    mockWriteBatchCommit.mockRejectedValueOnce(
      Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' })
    );
    await expect(
      joinTeamByCode('HM-00112233445566778899AABBCCDDEEFF', 'u_lock', 'Locked User')
    ).rejects.toThrow(/locked or already submitted/i);

    // 4. Full team (unreadable pre-join team doc) surfaces full/invalid error
    vi.clearAllMocks();
    mockAuthState.currentUser = {
      uid: 'u_full',
      emailVerified: true,
      getIdTokenResult: vi.fn(async () => ({ claims: { email_verified: true } }))
    };
    mockGetDoc
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ teamId: 'team_1', hackathonId: 'hack_1', leaderId: 'leader_1', active: true })
      })
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'hack_1_u_full',
        data: () => ({ id: 'hack_1_u_full', hackathonId: 'hack_1', userId: 'u_full', status: 'approved' })
      })
      .mockRejectedValueOnce(new Error('permission-denied'));
    mockWriteBatchCommit.mockRejectedValueOnce(
      Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' })
    );
    await expect(
      joinTeamByCode('HM-00112233445566778899AABBCCDDEEFF', 'u_full', 'Full User')
    ).rejects.toThrow(/may already be full/i);

    // 5. createTeamWithLeader & rotateTeamJoinCode reject past expiresAt and propagate future expiresAt / clean overwrite
    vi.clearAllMocks();
    mockAuthState.currentUser = { uid: 'leader_1', emailVerified: true };
    await expect(
      createTeamWithLeader(
        {
          hackathonId: 'hack_1',
          organizerId: 'org_1',
          name: 'Expiring Team',
          description: '',
          leaderId: 'leader_1',
          memberIds: ['leader_1'],
          memberNames: ['Leader'],
          lookingForRoles: [],
          track: 'AI',
          status: 'forming'
        },
        { joinCodeExpiresAt: new Date(Date.now() - 10_000) }
      )
    ).rejects.toThrow(/must be in the future/i);

    const futureDate = new Date(Date.now() + 3_600_000);
    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      id: 'hack_1_leader_1',
      data: () => ({ id: 'hack_1_leader_1', hackathonId: 'hack_1', userId: 'leader_1', status: 'approved' })
    });
    await createTeamWithLeader(
      {
        hackathonId: 'hack_1',
        organizerId: 'org_1',
        name: 'Timed Team',
        description: '',
        leaderId: 'leader_1',
        memberIds: ['leader_1'],
        memberNames: ['Leader'],
        lookingForRoles: [],
        track: 'AI',
        status: 'forming'
      },
      { joinCodeExpiresAt: futureDate }
    );
    const createdCodeSet = mockWriteBatchSet.mock.calls.find(([p]) =>
      String(p).startsWith('teamJoinCodes/')
    );
    expect(createdCodeSet?.[1]).toHaveProperty('expiresAt');

    // Rotate without expiresAt uses batch.set on private/joinCode (clearing any previous expiresAt)
    vi.clearAllMocks();
    mockWriteBatchCommit.mockResolvedValue(undefined);
    mockGetDoc
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ id: 'team_1', hackathonId: 'hack_1', organizerId: 'org_1', leaderId: 'leader_1' })
      })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ verifierHash: 'old_hash', active: true, expiresAt: { toMillis: () => 9999999999999 } })
      });
    const nextToken = await rotateTeamJoinCode('team_1');
    expect(nextToken).toMatch(/^HM-/);
    const rotatedPrivateSet = mockWriteBatchSet.mock.calls.find(
      ([p]) => String(p) === 'teams/team_1/private/joinCode'
    );
    expect(rotatedPrivateSet).toBeDefined();
    expect(rotatedPrivateSet?.[1]).not.toHaveProperty('expiresAt');
  });
});



