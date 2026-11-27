import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Globe, Info, Mail, Lock, User } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { getFirebaseConfigStatus } from '../services/firebase/config';
import type { AccountRole } from '../types/domain';
import { formatFirebaseAuthError } from '../utils/firebaseErrors';
import { BrandLogo } from '../components/common/BrandLogo';

type AuthMode = 'signin' | 'signup' | 'reset';

export function AuthPage() {
  const { signInEmail, registerEmail, signInGoogle, resetPassword } = useAuth();
  const { locale, t, toggleLocale } = useLanguage();
  const navigate = useNavigate();
  const configStatus = getFirebaseConfigStatus();

  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [requestedRole, setRequestedRole] = useState<AccountRole>('participant');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');

    if (!configStatus.configured) {
      setError(
        locale === 'ar'
          ? `إعدادات عميل Firebase Web غير مكتملة لمشروع (${configStatus.projectId}). المتغيرات الناقصة: ${configStatus.missingKeys.join('، ')}`
          : `Firebase Web client configuration is incomplete for project "${configStatus.projectId}". Missing env vars: ${configStatus.missingKeys.join(', ')}`
      );
      return;
    }

    if (!email.trim() || !email.includes('@')) {
      setError(locale === 'ar' ? 'يرجى إدخال بريد إلكتروني صحيح.' : 'Please enter a valid email address.');
      return;
    }

    if (mode !== 'reset' && password.length < 6) {
      setError(
        locale === 'ar'
          ? 'يجب أن تتكون كلمة المرور من 6 أحرف على الأقل.'
          : 'Password must be at least 6 characters.'
      );
      return;
    }

    if (mode === 'signup' && !displayName.trim()) {
      setError(locale === 'ar' ? 'يرجى إدخال الاسم الكامل.' : 'Full name is required.');
      return;
    }

    setBusy(true);
    try {
      if (mode === 'signin') {
        await signInEmail(email, password);
        navigate('/app');
      } else if (mode === 'signup') {
        const res = await registerEmail({ email, password, displayName, requestedRole, locale });
        setMessage(
          res.verificationSent
            ? locale === 'ar'
              ? 'تم إنشاء الحساب وإرسال رابط التحقق إلى بريدك الإلكتروني.'
              : 'Account created. A verification link was sent to your email.'
            : locale === 'ar'
              ? 'تم إنشاء الحساب، لكن تعذر إرسال رسالة التحقق الآن. استخدم زر إعادة الإرسال داخل مساحة العمل.'
              : 'Account created, though verification email delivery could not be confirmed. Use Resend inside the workspace.'
        );
        navigate('/app');
      } else {
        await resetPassword(email);
        setMessage(
          locale === 'ar'
            ? 'تم إرسال رابط إعادة تعيين كلمة المرور إلى بريدك.'
            : 'Password reset link sent to your email.'
        );
      }
    } catch (err) {
      setError(formatFirebaseAuthError(err, locale));
    } finally {
      setBusy(false);
    }
  };

  const handleGoogle = async () => {
    setError('');
    setMessage('');
    if (!configStatus.configured) {
      setError(
        locale === 'ar'
          ? `إعدادات عميل Firebase Web غير مكتملة لمشروع (${configStatus.projectId}). المتغيرات الناقصة: ${configStatus.missingKeys.join('، ')}`
          : `Firebase Web client configuration is incomplete for project "${configStatus.projectId}". Missing env vars: ${configStatus.missingKeys.join(', ')}`
      );
      return;
    }
    setBusy(true);
    try {
      await signInGoogle(mode === 'signup' ? requestedRole : 'participant', locale);
      navigate('/app');
    } catch (err) {
      setError(formatFirebaseAuthError(err, locale));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-slate-50 dark:bg-[#070B14] flex flex-col justify-between p-4 sm:p-6 overflow-hidden">
      {/* Ambient Atmospheric Neon Glow */}
      <div className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[600px] h-72 bg-gradient-to-b from-blue-600/15 via-purple-600/10 to-transparent blur-3xl opacity-70 dark:opacity-90" />

      <div className="mx-auto max-w-6xl w-full flex items-center justify-between relative z-10">
        <Link to="/">
          <BrandLogo />
        </Link>
        <button
          type="button"
          onClick={toggleLocale}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 backdrop-blur px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-blue-500/40"
        >
          <Globe className="h-3.5 w-3.5" />
          <span>{locale === 'en' ? 'العربية' : 'English'}</span>
        </button>
      </div>

      <div className="relative z-10 mx-auto max-w-md w-full my-8 rounded-2xl border border-slate-200 dark:border-blue-500/20 bg-white dark:bg-[#0B1120] shadow-[0_0_40px_-15px_rgba(59,130,246,0.25)] overflow-hidden">
        {/* Top Neon Accent Rim */}
        <div className="h-1 w-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500" />

        <div className="p-6 sm:p-8 space-y-6">
          <div className="space-y-1">
            <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white">
              {mode === 'signin'
                ? t.auth.titleSignIn
                : mode === 'signup'
                  ? t.auth.titleSignUp
                  : t.auth.titleReset}
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {locale === 'ar' ? 'ابتكر · تعاون · ابنِ بذكاء' : 'Innovate · Collaborate · Build Smarter'}
            </p>
          </div>

        {!configStatus.configured && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-semibold">
                {locale === 'ar'
                  ? `متغيرات Firebase Web غير مضبوطة (${configStatus.projectId})`
                  : `Firebase Web Env Setup Required (${configStatus.projectId})`}
              </div>
              <p className="text-[11px]">
                {locale === 'ar'
                  ? `أضف المتغيرات التالية في .env.local من إعدادات تطبيق الويب في Firebase Console: ${configStatus.missingKeys.join('، ')}`
                  : `Add these public client values to .env.local from Firebase Console → Project Settings → Web App: ${configStatus.missingKeys.join(', ')}`}
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
            {error}
          </div>
        )}
        {message && (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-300">
            {message}
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {mode === 'signup' && (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.auth.fullName}
                </label>
                <div className="relative">
                  <User className="h-4 w-4 text-slate-400 absolute top-2.5 start-3" />
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    maxLength={80}
                    required
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] ps-9 pe-3 py-2 text-sm text-slate-900 dark:text-white focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.auth.roleLabel}
                </label>
                <select
                  value={requestedRole}
                  onChange={(e) => setRequestedRole(e.target.value as AccountRole)}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-blue-500 focus:outline-none"
                >
                  <option value="participant">{t.auth.roleParticipant}</option>
                  <option value="organizer">{t.auth.roleOrganizer}</option>
                  <option value="judge">{t.auth.roleJudge}</option>
                  <option value="sponsor">{t.auth.roleSponsor}</option>
                </select>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  {t.auth.roleApprovalNote}
                </p>
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {t.auth.email}
            </label>
            <div className="relative">
              <Mail className="h-4 w-4 text-slate-400 absolute top-2.5 start-3" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] ps-9 pe-3 py-2 text-sm text-slate-900 dark:text-white focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>

          {mode !== 'reset' && (
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t.auth.password}
              </label>
              <div className="relative">
                <Lock className="h-4 w-4 text-slate-400 absolute top-2.5 start-3" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={6}
                  required
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] ps-9 pe-3 py-2 text-sm text-slate-900 dark:text-white focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-blue-500/25 hover:from-blue-500 hover:to-purple-500 disabled:opacity-50 transition-all"
          >
            {busy
              ? t.common.loading
              : mode === 'signin'
                ? t.auth.signInBtn
                : mode === 'signup'
                  ? t.auth.signUpBtn
                  : t.auth.resetBtn}
          </button>
        </form>

        <div className="relative flex py-1 items-center">
          <div className="flex-grow border-t border-slate-200 dark:border-slate-800" />
          <span className="shrink mx-3 text-xs text-slate-400">
            {locale === 'ar' ? 'أو' : 'or'}
          </span>
          <div className="flex-grow border-t border-slate-200 dark:border-slate-800" />
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => void handleGoogle()}
          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-4 py-2.5 text-sm font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/60"
        >
          {t.auth.googleBtn}
        </button>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400">
          {mode === 'signin' && (
            <>
              <button type="button" onClick={() => setMode('signup')} className="hover:text-blue-500">
                {t.auth.switchToSignUp}
              </button>
              <button type="button" onClick={() => setMode('reset')} className="hover:text-blue-500">
                {t.auth.forgotPassword}
              </button>
            </>
          )}
          {mode === 'signup' && (
            <button type="button" onClick={() => setMode('signin')} className="hover:text-blue-500">
              {t.auth.switchToSignIn}
            </button>
          )}
          {mode === 'reset' && (
            <button type="button" onClick={() => setMode('signin')} className="hover:text-blue-500">
              {t.auth.backToSignIn}
            </button>
          )}
        </div>

        <div className="flex items-start gap-2 rounded-lg bg-slate-100 dark:bg-slate-900/70 p-3 text-[11px] text-slate-600 dark:text-slate-400">
          <Info className="h-4 w-4 shrink-0 text-blue-500 mt-0.5" />
          <span>{t.auth.emailProviderHint}</span>
        </div>
      </div>
    </div>

      <div className="text-center text-xs text-slate-500">
        {locale === 'ar'
          ? `HACKMIND AI · مصادقة Firebase (${configStatus.projectId})`
          : `HACKMIND AI · Firebase Authentication (${configStatus.projectId})`}
      </div>
    </div>
  );
}
