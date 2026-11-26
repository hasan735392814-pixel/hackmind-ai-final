import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdTokenResult, User } from 'firebase/auth';

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
  upsertUserProfile: (...args: unknown[]) => mockUpsertUserProfile(...args),
  upsertUserPrivateInfo: (...args: unknown[]) => mockUpsertUserPrivateInfo(...args)
}));

import {
  sanitizeOptionalPhotoUrl,
  syncUserRecordsOnAuth
} from '../../src/contexts/AuthContext';

function verifiedTokenResult(): IdTokenResult {
  return {
    token: 'google-jwt',
    authTime: '',
    issuedAtTime: '',
    expirationTime: '',
    signInProvider: 'google.com',
    signInSecondFactor: null,
    claims: { email_verified: true }
  };
}

function createGoogleUser(overrides: Partial<User> = {}): User {
  return {
    uid: 'google_uid_123',
    email: 'builder@gmail.com',
    displayName: 'Google Builder',
    photoURL: 'https://lh3.googleusercontent.com/a/avatar.png',
    emailVerified: true,
    getIdTokenResult: vi.fn(async () => verifiedTokenResult()),
    getIdToken: vi.fn(async () => 'google-jwt'),
    ...overrides
  } as unknown as User;
}

describe('Google User Profile & Role Synchronization (Mocked Unit Tests)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserProfile.mockResolvedValue(null);
    mockGetUserPrivateInfo.mockResolvedValue(null);
    mockCheckIsAdminUser.mockResolvedValue(false);
    mockUpsertUserProfile.mockResolvedValue(undefined);
    mockUpsertUserPrivateInfo.mockResolvedValue(undefined);
  });

  it('creates a brand-new Google user profile once with participant role default and creates private/info', async () => {
    const user = createGoogleUser();
    const createdProfile = {
      uid: user.uid,
      displayName: 'Google Builder',
      requestedRole: 'participant',
      approvedRole: 'participant'
    };
    const createdPriv = {
      uid: user.uid,
      email: 'builder@gmail.com',
      notificationsEnabled: true,
      aiCloudConsent: true,
      preferredLocale: 'en'
    };

    mockGetUserProfile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createdProfile);
    mockGetUserPrivateInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createdPriv);

    const res = await syncUserRecordsOnAuth(user, { requestedRole: 'participant', locale: 'en' });

    expect(mockUpsertUserProfile).toHaveBeenCalledTimes(1);
    expect(mockUpsertUserProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: 'google_uid_123',
        displayName: 'Google Builder',
        photoUrl: 'https://lh3.googleusercontent.com/a/avatar.png',
        requestedRole: 'participant'
      }),
      true
    );
    expect(mockUpsertUserPrivateInfo).toHaveBeenCalledTimes(1);
    expect(res.profile).toEqual(createdProfile);
    expect(res.privateInfo).toEqual(createdPriv);
  });

  it('deduplicates concurrent sync calls for the same UID so duplicate profiles are never written', async () => {
    const user = createGoogleUser();
    let releaseRead!: () => void;
    const readGate = new Promise<null>((resolve) => {
      releaseRead = () => resolve(null);
    });

    mockGetUserProfile.mockReturnValueOnce(readGate).mockResolvedValueOnce({
      uid: user.uid,
      displayName: 'Google Builder',
      requestedRole: 'participant',
      approvedRole: 'participant'
    });

    const p1 = syncUserRecordsOnAuth(user, { requestedRole: 'participant', locale: 'en' });
    const p2 = syncUserRecordsOnAuth(user, { requestedRole: 'participant', locale: 'en' });

    releaseRead();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(mockUpsertUserProfile).toHaveBeenCalledTimes(1);
    expect(mockUpsertUserPrivateInfo).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  it('preserves existing user profile and approvedRole untouched when returning Google user signs in', async () => {
    const user = createGoogleUser();
    const existingOrganizer = {
      uid: user.uid,
      displayName: 'Existing Organizer Name',
      requestedRole: 'organizer',
      approvedRole: 'organizer'
    };
    const existingPriv = {
      uid: user.uid,
      email: 'builder@gmail.com',
      notificationsEnabled: false,
      aiCloudConsent: true,
      preferredLocale: 'ar'
    };

    mockGetUserProfile.mockResolvedValue(existingOrganizer);
    mockGetUserPrivateInfo.mockResolvedValue(existingPriv);

    const res = await syncUserRecordsOnAuth(user, { requestedRole: 'participant', locale: 'en' });

    expect(mockUpsertUserProfile).not.toHaveBeenCalled();
    expect(mockUpsertUserPrivateInfo).not.toHaveBeenCalled();
    expect(res.profile).toEqual(existingOrganizer);
    expect(res.profile?.approvedRole).toBe('organizer');
  });

  it('does NOT attempt to overwrite or create a profile when getUserProfile fails with a read error', async () => {
    const user = createGoogleUser();
    mockGetUserProfile.mockRejectedValue(new Error('network offline'));
    mockGetUserPrivateInfo.mockRejectedValue(new Error('network offline'));

    const res = await syncUserRecordsOnAuth(user, { throwOnWriteError: true });

    expect(mockUpsertUserProfile).not.toHaveBeenCalled();
    expect(mockUpsertUserPrivateInfo).not.toHaveBeenCalled();
    expect(res.profile).toBeNull();
  });

  it('sanitizes non-HTTP or overlong Google photoURL values to satisfy Firestore security rules', () => {
    expect(sanitizeOptionalPhotoUrl('https://lh3.googleusercontent.com/photo.png')).toBe(
      'https://lh3.googleusercontent.com/photo.png'
    );
    expect(sanitizeOptionalPhotoUrl('data:image/png;base64,AAA')).toBe('');
    expect(sanitizeOptionalPhotoUrl(`https://example.com/${'a'.repeat(500)}`)).toBe('');
    expect(sanitizeOptionalPhotoUrl(null)).toBe('');
  });
});
