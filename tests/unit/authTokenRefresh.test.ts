import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdTokenResult, User } from 'firebase/auth';

const callOrder: string[] = [];

const mockGetUserProfile = vi.fn();
const mockGetUserPrivateInfo = vi.fn();
const mockCheckIsAdminUser = vi.fn();
const mockUpsertUserProfile = vi.fn();
const mockUpsertUserPrivateInfo = vi.fn();

vi.mock('../../src/services/firebase/config', () => ({
  auth: null
}));

vi.mock('../../src/services/firebase/firestoreService', () => ({
  getUserProfile: (...args: unknown[]) => mockGetUserProfile(...args),
  getUserPrivateInfo: (...args: unknown[]) => mockGetUserPrivateInfo(...args),
  checkIsAdminUser: (...args: unknown[]) => mockCheckIsAdminUser(...args),
  upsertUserProfile: (...args: unknown[]) => {
    callOrder.push('upsertUserProfile');
    return mockUpsertUserProfile(...args);
  },
  upsertUserPrivateInfo: (...args: unknown[]) => {
    callOrder.push('upsertUserPrivateInfo');
    return mockUpsertUserPrivateInfo(...args);
  }
}));

import { ensureVerifiedIdToken, syncUserRecordsOnAuth } from '../../src/contexts/AuthContext';

function fakeTokenResult(emailVerified: boolean): IdTokenResult {
  return {
    token: 'mock-jwt',
    authTime: '',
    issuedAtTime: '',
    expirationTime: '',
    signInProvider: 'password',
    signInSecondFactor: null,
    claims: { email_verified: emailVerified }
  };
}

function createMockUser(overrides: {
  emailVerified?: boolean;
  getIdTokenResult?: () => Promise<IdTokenResult>;
  getIdToken?: (forceRefresh?: boolean) => Promise<string>;
} = {}): User {
  return {
    uid: 'user_test_auth_1',
    email: 'judge@example.test',
    displayName: 'Test Judge',
    photoURL: null,
    emailVerified: overrides.emailVerified ?? false,
    getIdTokenResult: overrides.getIdTokenResult ?? vi.fn(async () => fakeTokenResult(false)),
    getIdToken: overrides.getIdToken ?? vi.fn(async () => 'mock-jwt')
  } as unknown as User;
}

describe('Verified ID Token Refresh Before Firestore User Profile & Private Info Creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    mockGetUserProfile.mockResolvedValue(null);
    mockGetUserPrivateInfo.mockResolvedValue(null);
    mockCheckIsAdminUser.mockResolvedValue(false);
    mockUpsertUserProfile.mockResolvedValue(undefined);
    mockUpsertUserPrivateInfo.mockResolvedValue(undefined);
  });

  it('does not refresh token or create Firestore records while emailVerified is false', async () => {
    const user = createMockUser({ emailVerified: false });
    await ensureVerifiedIdToken(user);
    const res = await syncUserRecordsOnAuth(user);

    expect(user.getIdToken).not.toHaveBeenCalled();
    expect(mockUpsertUserProfile).not.toHaveBeenCalled();
    expect(mockUpsertUserPrivateInfo).not.toHaveBeenCalled();
    expect(res).toEqual({ profile: null, privateInfo: null, isAdmin: false });
  });

  it('forces getIdToken(true) BEFORE creating users/{uid} and users/{uid}/private/info when JWT email_verified claim is stale', async () => {
    let claimVerified = false;
    const user = createMockUser({
      emailVerified: true,
      getIdTokenResult: vi.fn(async () => fakeTokenResult(claimVerified)),
      getIdToken: vi.fn(async (force?: boolean) => {
        callOrder.push(`getIdToken(${Boolean(force)})`);
        if (force) claimVerified = true;
        return 'fresh-verified-token';
      })
    });

    await syncUserRecordsOnAuth(user);

    expect(user.getIdToken).toHaveBeenCalledWith(true);
    expect(mockUpsertUserProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: 'user_test_auth_1',
        displayName: 'Test Judge',
        requestedRole: 'participant'
      }),
      true
    );
    expect(mockUpsertUserPrivateInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: 'user_test_auth_1',
        email: 'judge@example.test'
      }),
      true
    );
    expect(callOrder.indexOf('getIdToken(true)')).toBeLessThan(
      callOrder.indexOf('upsertUserProfile')
    );
    expect(callOrder.indexOf('getIdToken(true)')).toBeLessThan(
      callOrder.indexOf('upsertUserPrivateInfo')
    );
  });

  it('skips forced token refresh when JWT email_verified claim is already true', async () => {
    const user = createMockUser({
      emailVerified: true,
      getIdTokenResult: vi.fn(async () => fakeTokenResult(true)),
      getIdToken: vi.fn(async () => 'token')
    });

    await syncUserRecordsOnAuth(user);

    expect(user.getIdToken).not.toHaveBeenCalled();
    expect(mockUpsertUserProfile).toHaveBeenCalledTimes(1);
    expect(mockUpsertUserPrivateInfo).toHaveBeenCalledTimes(1);
  });

  it('creates only missing private/info when users/{uid} profile already exists', async () => {
    const user = createMockUser({
      emailVerified: true,
      getIdTokenResult: vi.fn(async () => fakeTokenResult(true))
    });
    mockGetUserProfile.mockResolvedValue({
      uid: user.uid,
      displayName: 'Test Judge',
      approvedRole: 'participant',
      requestedRole: 'participant'
    });
    mockGetUserPrivateInfo.mockResolvedValueOnce(null).mockResolvedValueOnce({
      uid: user.uid,
      email: 'judge@example.test',
      notificationsEnabled: true,
      aiCloudConsent: true,
      preferredLocale: 'en'
    });

    const res = await syncUserRecordsOnAuth(user);

    expect(mockUpsertUserProfile).not.toHaveBeenCalled();
    expect(mockUpsertUserPrivateInfo).toHaveBeenCalledTimes(1);
    expect(mockUpsertUserPrivateInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: user.uid,
        email: 'judge@example.test'
      }),
      true
    );
    expect(res.profile?.uid).toBe(user.uid);
    expect(res.privateInfo?.email).toBe('judge@example.test');
  });
});
