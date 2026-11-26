import { describe, expect, it } from 'vitest';
import {
  analyzeRegistrationDiagnostics,
  formatDiagnosticTimestamp
} from '../../src/utils/registrationDiagnostics';
import type { HackathonRegistration } from '../../src/types/domain';

describe('Registration Diagnostics Analysis', () => {
  it('detects duplicate records with mixed statuses and first-vs-last mismatch between Builder and Discover', () => {
    const result = analyzeRegistrationDiagnostics({
      uid: 'user_123',
      emailVerified: true,
      selectedHackathonId: 'hack_abc',
      queryResult: {
        errorCode: null,
        errorMessage: null,
        records: [
          {
            docId: 'legacy_reg_1',
            docPath: 'registrations/legacy_reg_1',
            dataId: 'legacy_reg_1',
            hackathonId: 'hack_abc',
            userId: 'user_123',
            status: 'pending',
            createdAt: null,
            updatedAt: null
          },
          {
            docId: 'hack_abc_user_123',
            docPath: 'registrations/hack_abc_user_123',
            dataId: 'hack_abc_user_123',
            hackathonId: 'hack_abc',
            userId: 'user_123',
            status: 'approved',
            createdAt: null,
            updatedAt: null
          }
        ]
      },
      compositeResult: {
        expectedCompositeId: 'hack_abc_user_123',
        documentPath: 'registrations/hack_abc_user_123',
        readSucceeded: true,
        exists: true,
        actualDocId: 'hack_abc_user_123',
        storedDataId: 'hack_abc_user_123',
        storedUserId: 'user_123',
        storedHackathonId: 'hack_abc',
        storedStatus: 'approved',
        userIdMatches: true,
        hackathonIdMatches: true,
        statusIsApproved: true,
        verificationResult: true,
        verifyFnResult: true,
        errorCode: null,
        errorMessage: null
      },
      builderStateRegistrations: [
        {
          id: 'legacy_reg_1',
          hackathonId: 'hack_abc',
          organizerId: 'org_1',
          userId: 'user_123',
          userName: 'Test User',
          userTitle: '',
          preferredTrack: 'AI',
          motivation: '',
          status: 'pending'
        } as HackathonRegistration
      ]
    });

    expect(result.matchingSelectedCount).toBe(2);
    expect(result.duplicatesForSelected).toBe(true);
    expect(result.duplicateGroups).toHaveLength(1);
    expect(result.duplicateGroups[0].hasMixedStatuses).toBe(true);
    expect(result.discoverResolvedRecord?.docId).toBe('hack_abc_user_123');
    expect(result.discoverResolvedRecord?.status).toBe('approved');
    expect(result.builderQueryFirstRecord?.docId).toBe('legacy_reg_1');
    expect(result.builderQueryFirstRecord?.status).toBe('pending');
    expect(result.firstVsLastMismatch).toBe(true);
    expect(result.blockReason).toContain('first-vs-last mismatch');
  });

  it('reports non-composite approved record blocking composite verification', () => {
    const result = analyzeRegistrationDiagnostics({
      uid: 'user_123',
      emailVerified: true,
      selectedHackathonId: 'hack_abc',
      queryResult: {
        errorCode: null,
        errorMessage: null,
        records: [
          {
            docId: 'non_composite_id',
            docPath: 'registrations/non_composite_id',
            dataId: 'non_composite_id',
            hackathonId: 'hack_abc',
            userId: 'user_123',
            status: 'approved',
            createdAt: null,
            updatedAt: null
          }
        ]
      },
      compositeResult: {
        expectedCompositeId: 'hack_abc_user_123',
        documentPath: 'registrations/hack_abc_user_123',
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
        verifyFnResult: false,
        errorCode: null,
        errorMessage: null
      },
      builderStateRegistrations: []
    });

    expect(result.approvedRecordsForSelected).toHaveLength(1);
    expect(result.approvedCompositeMatchExists).toBe(false);
    expect(result.blockReason).toContain('non_composite_id');
    expect(result.blockReason).toContain('hack_abc_user_123');
  });

  it('surfaces Firestore permission error instead of converting to generic false', () => {
    const result = analyzeRegistrationDiagnostics({
      uid: 'user_123',
      emailVerified: true,
      selectedHackathonId: 'hack_abc',
      queryResult: {
        errorCode: null,
        errorMessage: null,
        records: []
      },
      compositeResult: {
        expectedCompositeId: 'hack_abc_user_123',
        documentPath: 'registrations/hack_abc_user_123',
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
        errorCode: 'permission-denied',
        errorMessage: 'Missing or insufficient permissions.'
      },
      builderStateRegistrations: []
    });

    expect(result.blockReason).toContain('permission-denied');
    expect(result.blockReason).toContain('Missing or insufficient permissions.');
  });

  it('formats Firestore Timestamp-like and seconds objects safely', () => {
    expect(formatDiagnosticTimestamp(null)).toBe('—');
    expect(formatDiagnosticTimestamp({ seconds: 1700000000 })).toBe('2023-11-14T22:13:20.000Z');
    expect(
      formatDiagnosticTimestamp({ toDate: () => new Date('2026-11-18T10:00:00.000Z') })
    ).toBe('2026-11-18T10:00:00.000Z');
  });
});
