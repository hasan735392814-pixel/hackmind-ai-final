import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from 'react';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User
} from 'firebase/auth';
import { auth } from '../services/firebase/config';
import {
  checkIsAdminUser,
  getUserPrivateInfo,
  getUserProfile,
  upsertUserPrivateInfo,
  upsertUserProfile
} from '../services/firebase/firestoreService';
import type { AccountRole, UserPrivateInfo, UserProfile } from '../types/domain';

interface AuthContextValue {
  user: User | null;
  profile: UserProfile | null;
  privateInfo: UserPrivateInfo | null;
  isAdmin: boolean;
  loading: boolean;
  emailVerified: boolean;
  signInEmail: (email: string, password: string) => Promise<void>;
  registerEmail: (params: {
    email: string;
    password: string;
    displayName: string;
    requestedRole: AccountRole;
    locale: 'en' | 'ar';
  }) => Promise<{ verificationSent: boolean }>;
  signInGoogle: (defaultRole?: AccountRole, locale?: 'en' | 'ar') => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  resendVerification: () => Promise<void>;
  reloadUserAndProfile: () => Promise<void>;
  updateCloudConsent: (consent: boolean) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function sanitizeOptionalPhotoUrl(url: string | null | undefined): string {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed || trimmed.length > 500) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : '';
}

export interface AuthSyncDefaults {
  requestedRole?: AccountRole;
  locale?: 'en' | 'ar';
  throwOnWriteError?: boolean;
}

const inFlightSyncByUid = new Map<
  string,
  Promise<{
    profile: UserProfile | null;
    privateInfo: UserPrivateInfo | null;
    isAdmin: boolean;
  }>
>();

let pendingGoogleAuthDefaults: { requestedRole: AccountRole; locale: 'en' | 'ar' } | null = null;

export async function ensureVerifiedIdToken(firebaseUser: User): Promise<void> {
  if (!firebaseUser.emailVerified) return;
  const tokenResult = await firebaseUser.getIdTokenResult().catch(() => null);
  if (!tokenResult?.claims?.email_verified) {
    await firebaseUser.getIdToken(true);
  }
}

export async function syncUserRecordsOnAuth(
  firebaseUser: User,
  defaults?: AuthSyncDefaults
): Promise<{
  profile: UserProfile | null;
  privateInfo: UserPrivateInfo | null;
  isAdmin: boolean;
}> {
  const existingInFlight = inFlightSyncByUid.get(firebaseUser.uid);
  if (existingInFlight) {
    return existingInFlight;
  }

  const runSync = (async () => {
    await ensureVerifiedIdToken(firebaseUser).catch(() => {});

    let profileReadFailed = false;
    let privReadFailed = false;

    const [prof, priv, adminFlag] = await Promise.all([
      getUserProfile(firebaseUser.uid).catch(() => {
        profileReadFailed = true;
        return null;
      }),
      getUserPrivateInfo(firebaseUser.uid).catch(() => {
        privReadFailed = true;
        return null;
      }),
      checkIsAdminUser(firebaseUser.uid).catch(() => false)
    ]);

    if (!profileReadFailed && !prof && firebaseUser.emailVerified) {
      let pending: { displayName?: string; requestedRole?: AccountRole; locale?: 'en' | 'ar' } | null = null;
      if (typeof localStorage !== 'undefined') {
        const pendingRaw = localStorage.getItem(`hackmind_pending_reg_${firebaseUser.uid}`);
        if (pendingRaw) {
          try {
            pending = JSON.parse(pendingRaw);
          } catch {
            pending = null;
          }
          localStorage.removeItem(`hackmind_pending_reg_${firebaseUser.uid}`);
        }
      }
      const googleHint = pendingGoogleAuthDefaults;
      const localePref = pending?.locale || defaults?.locale || googleHint?.locale || 'en';
      const requestedRole =
        pending?.requestedRole || defaults?.requestedRole || googleHint?.requestedRole || 'participant';

      const initialProfile: Omit<UserProfile, 'approvedRole' | 'createdAt' | 'updatedAt'> = {
        uid: firebaseUser.uid,
        displayName:
          pending?.displayName ||
          firebaseUser.displayName ||
          firebaseUser.email?.split('@')[0] ||
          'Builder',
        title: '',
        bio: '',
        skills: [],
        experienceLevel: 'intermediate',
        interests: [],
        preferredRoles: [],
        preferredLanguages: [localePref === 'ar' ? 'Arabic' : 'English'],
        availability: 'full_time',
        teamPreference: 'looking_for_team',
        portfolioUrl: '',
        githubUrl: '',
        linkedinUrl: '',
        photoUrl: sanitizeOptionalPhotoUrl(firebaseUser.photoURL),
        requestedRole
      };

      if (defaults?.throwOnWriteError) {
        await upsertUserProfile(initialProfile, true);
      } else {
        await upsertUserProfile(initialProfile, true).catch(() => {});
      }

      if (!privReadFailed && !priv) {
        const privPayload: Omit<UserPrivateInfo, 'updatedAt'> = {
          uid: firebaseUser.uid,
          email: firebaseUser.email || '',
          notificationsEnabled: true,
          aiCloudConsent: true,
          preferredLocale: localePref
        };
        if (defaults?.throwOnWriteError) {
          await upsertUserPrivateInfo(privPayload, true);
        } else {
          await upsertUserPrivateInfo(privPayload, true).catch(() => {});
        }
      }

      const [createdProf, createdPriv] = await Promise.all([
        getUserProfile(firebaseUser.uid).catch(() => null),
        priv ? Promise.resolve(priv) : getUserPrivateInfo(firebaseUser.uid).catch(() => null)
      ]);
      return { profile: createdProf, privateInfo: createdPriv, isAdmin: adminFlag };
    }

    if (!privReadFailed && !priv && firebaseUser.emailVerified) {
      const privPayload: Omit<UserPrivateInfo, 'updatedAt'> = {
        uid: firebaseUser.uid,
        email: firebaseUser.email || '',
        notificationsEnabled: true,
        aiCloudConsent: true,
        preferredLocale: defaults?.locale || pendingGoogleAuthDefaults?.locale || 'en'
      };
      if (defaults?.throwOnWriteError) {
        await upsertUserPrivateInfo(privPayload, true);
      } else {
        await upsertUserPrivateInfo(privPayload, true).catch(() => {});
      }
      const createdPriv = await getUserPrivateInfo(firebaseUser.uid).catch(() => null);
      return { profile: prof, privateInfo: createdPriv, isAdmin: adminFlag };
    }

    return { profile: prof, privateInfo: priv, isAdmin: adminFlag };
  })();

  inFlightSyncByUid.set(firebaseUser.uid, runSync);
  try {
    return await runSync;
  } finally {
    inFlightSyncByUid.delete(firebaseUser.uid);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [privateInfo, setPrivateInfo] = useState<UserPrivateInfo | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadUserRecords = useCallback(
    async (firebaseUser: User | null, defaults?: AuthSyncDefaults) => {
      if (!firebaseUser) {
        setProfile(null);
        setPrivateInfo(null);
        setIsAdmin(false);
        return;
      }

      const synced = await syncUserRecordsOnAuth(firebaseUser, defaults);
      setProfile(synced.profile);
      setPrivateInfo(synced.privateInfo);
      setIsAdmin(synced.isAdmin);
    },
    []
  );

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      return;
    }
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser && !firebaseUser.emailVerified) {
        await firebaseUser.reload().catch(() => {});
      }
      setUser(firebaseUser);
      setEmailVerified(Boolean(firebaseUser?.emailVerified));
      await loadUserRecords(firebaseUser);
      setLoading(false);
    });
    return () => unsub();
  }, [loadUserRecords]);

  const requireAuthInstance = () => {
    if (!auth) {
      throw new Error('Firebase: Error (auth/invalid-api-key).');
    }
    return auth;
  };

  const signInEmail = async (email: string, password: string) => {
    const cred = await signInWithEmailAndPassword(requireAuthInstance(), email.trim(), password);
    await loadUserRecords(cred.user);
  };

  const registerEmail = async (params: {
    email: string;
    password: string;
    displayName: string;
    requestedRole: AccountRole;
    locale: 'en' | 'ar';
  }): Promise<{ verificationSent: boolean }> => {
    const cred = await createUserWithEmailAndPassword(
      requireAuthInstance(),
      params.email.trim(),
      params.password
    );
    await updateProfile(cred.user, { displayName: params.displayName.trim() });
    let verificationSent = true;
    try {
      await sendEmailVerification(cred.user);
    } catch {
      verificationSent = false;
    }
    // Persist intended role locally until user completes email verification
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        `hackmind_pending_reg_${cred.user.uid}`,
        JSON.stringify({
          displayName: params.displayName.trim(),
          requestedRole: params.requestedRole,
          locale: params.locale
        })
      );
    }
    setUser(cred.user);
    return { verificationSent };
  };

  const signInGoogle = async (defaultRole: AccountRole = 'participant', locale: 'en' | 'ar' = 'en') => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    pendingGoogleAuthDefaults = { requestedRole: defaultRole, locale };
    try {
      const cred = await signInWithPopup(requireAuthInstance(), provider);
      await loadUserRecords(cred.user, {
        requestedRole: defaultRole,
        locale,
        throwOnWriteError: true
      });
    } finally {
      pendingGoogleAuthDefaults = null;
    }
  };

  const resetPassword = async (email: string) => {
    await sendPasswordResetEmail(requireAuthInstance(), email.trim());
  };

  const resendVerification = async () => {
    const authInstance = requireAuthInstance();
    if (!authInstance.currentUser) throw new Error('Not signed in');
    await sendEmailVerification(authInstance.currentUser);
  };

  const reloadUserAndProfile = async () => {
    if (!auth?.currentUser) return;
    await auth.currentUser.reload();
    const refreshed = auth.currentUser;
    if (refreshed.emailVerified) {
      await refreshed.getIdToken(true);
    }
    setUser(refreshed);
    setEmailVerified(Boolean(refreshed.emailVerified));
    await loadUserRecords(refreshed);
  };

  const updateCloudConsent = async (consent: boolean) => {
    if (!user || !user.emailVerified) return;
    await upsertUserPrivateInfo(
      {
        uid: user.uid,
        email: privateInfo?.email || user.email || '',
        notificationsEnabled: privateInfo?.notificationsEnabled ?? true,
        aiCloudConsent: consent,
        preferredLocale: privateInfo?.preferredLocale ?? 'en'
      },
      !privateInfo
    );
    const updated = await getUserPrivateInfo(user.uid).catch(() => null);
    setPrivateInfo(updated);
  };

  const logout = async () => {
    if (auth) {
      await signOut(auth);
    }
    setProfile(null);
    setPrivateInfo(null);
    setIsAdmin(false);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        privateInfo,
        isAdmin,
        loading,
        emailVerified,
        signInEmail,
        registerEmail,
        signInGoogle,
        resetPassword,
        resendVerification,
        reloadUserAndProfile,
        updateCloudConsent,
        logout
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
