import type { Locale } from '../i18n/translations';

export function formatFirebaseAuthError(
  error: unknown,
  locale: Locale,
  options?: { currentHostname?: string }
): string {
  const errObj = typeof error === 'object' && error !== null ? (error as { code?: unknown; message?: unknown }) : null;
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof errObj?.message === 'string'
        ? errObj.message
        : String(error);
  const explicitCode = typeof errObj?.code === 'string' ? errObj.code : '';
  const codeMatch = (explicitCode || rawMessage).match(/auth\/[a-z0-9.-]+/i);
  const code = codeMatch ? codeMatch[0].toLowerCase() : '';
  const raw = rawMessage;
  const hostname =
    options?.currentHostname ??
    (typeof window !== 'undefined' && window.location?.hostname ? window.location.hostname : '');

  if (code === 'auth/invalid-api-key' || code === 'auth/api-key-not-valid.-please-pass-a-valid-api-key.') {
    return locale === 'ar'
      ? 'إعدادات Firebase Web غير مكتملة في متغيرات البيئة (VITE_FIREBASE_API_KEY / VITE_FIREBASE_APP_ID).'
      : 'Firebase Web configuration is incomplete in environment variables (set VITE_FIREBASE_API_KEY and VITE_FIREBASE_APP_ID in .env.local).';
  }
  if (code === 'auth/operation-not-allowed') {
    return locale === 'ar'
      ? 'طريقة تسجيل الدخول هذه غير مفعّلة في Firebase Console → Authentication → Sign-in method (تأكد من تفعيل موفّر Google أو البريد وكلمة المرور).'
      : 'This sign-in method is disabled in Firebase Console → Authentication → Sign-in method (verify that the Google / Email-Password provider is enabled).';
  }
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return locale === 'ar'
      ? 'البريد الإلكتروني أو كلمة المرور غير صحيحة.'
      : 'Invalid email address or password.';
  }
  if (code === 'auth/email-already-in-use') {
    return locale === 'ar'
      ? 'يوجد حساب مسجل بالفعل بهذا البريد الإلكتروني.'
      : 'An account already exists with this email address.';
  }
  if (code === 'auth/account-exists-with-different-credential') {
    return locale === 'ar'
      ? 'يوجد حساب مسجل بالفعل بهذا البريد الإلكتروني باستخدام طريقة دخول أخرى (مثل البريد الإلكتروني وكلمة المرور). سجّل الدخول بالبريد وكلمة المرور بدلاً من ذلك.'
      : 'An account already exists with the same email using a different sign-in method (such as Email & Password). Sign in with Email & Password instead.';
  }
  if (code === 'auth/credential-already-in-use') {
    return locale === 'ar'
      ? 'بيانات اعتماد Google هذه مرتبطة بالفعل بحساب مستخدم آخر.'
      : 'This Google credential is already linked to another user account.';
  }
  if (code === 'auth/weak-password') {
    return locale === 'ar'
      ? 'كلمة المرور ضعيفة؛ يرجى اختيار كلمة مرور من 6 أحرف على الأقل.'
      : 'Password is too weak; use at least 6 characters.';
  }
  if (code === 'auth/too-many-requests') {
    return locale === 'ar'
      ? 'محاولات متكررة كثيرة. يرجى الانتظار قليلاً قبل المحاولة مجدداً.'
      : 'Too many attempts. Please wait briefly before trying again.';
  }
  if (code === 'auth/popup-blocked') {
    return locale === 'ar'
      ? 'تم حظر نافذة تسجيل الدخول عبر Google من المتصفح أو بيئة العرض المضمّنة. اسمح بالنوافذ المنبثقة لهذا الموقع أو افتح التطبيق في نافذة متصفح مستقلة وحاول مجدداً.'
      : 'The Google sign-in popup was blocked by your browser or embedded preview frame. Allow popups for this site or open the app in a standalone browser tab and try again.';
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return locale === 'ar'
      ? 'تم إغلاق نافذة تسجيل الدخول عبر Google قبل إتمام العملية.'
      : 'Google sign-in popup was closed before completion.';
  }
  if (code === 'auth/unauthorized-domain') {
    return locale === 'ar'
      ? `النطاق الحالي${hostname ? ` (${hostname})` : ''} غير مضاف ضمن النطاقات المصرح بها في Firebase Console → Authentication → Settings → Authorized domains.`
      : `Current domain${hostname ? ` (${hostname})` : ''} is not listed in Firebase Console → Authentication → Settings → Authorized domains.`;
  }
  if (code === 'auth/web-storage-unsupported') {
    return locale === 'ar'
      ? 'تخزين المتصفح أو ملفات تعريف الارتباط للطرف الثالث معطلة؛ يرجى تمكينها لإتمام تسجيل الدخول عبر Google.'
      : 'Browser storage or third-party cookies are disabled; enable them to complete Google sign-in.';
  }
  if (code === 'auth/network-request-failed') {
    return locale === 'ar'
      ? 'تعذر الاتصال بخدمة المصادقة. تحقق من اتصال الشبكة.'
      : 'Network error while contacting Firebase Authentication.';
  }

  return raw;
}
