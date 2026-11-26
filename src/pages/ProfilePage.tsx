import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import {
  upsertUserPrivateInfo,
  upsertUserProfile
} from '../services/firebase/firestoreService';
import type {
  AccountRole,
  AvailabilityLevel,
  ExperienceLevel,
  TeamPreference
} from '../types/domain';
import { isValidHttpUrl } from '../utils/validation';

export function ProfilePage() {
  const { user, profile, privateInfo, emailVerified, reloadUserAndProfile } = useAuth();
  const { locale, setLocale, t } = useLanguage();

  const [displayName, setDisplayName] = useState('');
  const [title, setTitle] = useState('');
  const [bio, setBio] = useState('');
  const [skillsText, setSkillsText] = useState('');
  const [interestsText, setInterestsText] = useState('');
  const [rolesText, setRolesText] = useState('');
  const [languagesText, setLanguagesText] = useState('English');
  const [experienceLevel, setExperienceLevel] = useState<ExperienceLevel>('intermediate');
  const [availability, setAvailability] = useState<AvailabilityLevel>('full_time');
  const [teamPreference, setTeamPreference] = useState<TeamPreference>('looking_for_team');
  const [requestedRole, setRequestedRole] = useState<AccountRole>('participant');
  const [portfolioUrl, setPortfolioUrl] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [linkedinUrl, setLinkedinUrl] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [aiCloudConsent, setAiCloudConsent] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (profile) {
      setDisplayName(profile.displayName || '');
      setTitle(profile.title || '');
      setBio(profile.bio || '');
      setSkillsText((profile.skills || []).join(', '));
      setInterestsText((profile.interests || []).join(', '));
      setRolesText((profile.preferredRoles || []).join(', '));
      setLanguagesText((profile.preferredLanguages || ['English']).join(', '));
      setExperienceLevel(profile.experienceLevel || 'intermediate');
      setAvailability(profile.availability || 'full_time');
      setTeamPreference(profile.teamPreference || 'looking_for_team');
      setRequestedRole(profile.requestedRole || profile.accountRole || 'participant');
      setPortfolioUrl(profile.portfolioUrl || '');
      setGithubUrl(profile.githubUrl || '');
      setLinkedinUrl(profile.linkedinUrl || '');
      setPhotoUrl(profile.photoUrl || '');
    } else if (user) {
      setDisplayName(user.displayName || '');
    }
    if (privateInfo) {
      setAiCloudConsent(privateInfo.aiCloudConsent);
      setNotificationsEnabled(privateInfo.notificationsEnabled);
    }
  }, [profile, privateInfo, user]);

  const splitList = (text: string) =>
    text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setErrorMsg('');
    setStatusMsg('');

    if (!emailVerified) {
      setErrorMsg(
        locale === 'ar'
          ? 'يرجى تأكيد البريد الإلكتروني أولاً لتحديث ملفك في Firestore.'
          : 'Verify your email address before saving profile updates to Firestore.'
      );
      return;
    }

    for (const url of [portfolioUrl, githubUrl, linkedinUrl, photoUrl]) {
      if (url.trim() && !isValidHttpUrl(url)) {
        setErrorMsg(
          locale === 'ar'
            ? 'يرجى إدخال روابط http/https صحيحة فقط.'
            : 'All URL fields must start with http:// or https://'
        );
        return;
      }
    }

    setSaving(true);
    try {
      await upsertUserProfile(
        {
          uid: user.uid,
          displayName: displayName.trim() || 'Builder',
          title,
          bio,
          skills: splitList(skillsText),
          experienceLevel,
          interests: splitList(interestsText),
          preferredRoles: splitList(rolesText),
          preferredLanguages: splitList(languagesText),
          availability,
          teamPreference,
          portfolioUrl,
          githubUrl,
          linkedinUrl,
          photoUrl,
          requestedRole
        },
        !profile,
        { ensureParticipantRoleIfMissing: Boolean(profile && !profile.approvedRole) }
      );

      await upsertUserPrivateInfo(
        {
          uid: user.uid,
          email: privateInfo?.email || user.email || '',
          notificationsEnabled,
          aiCloudConsent,
          preferredLocale: locale
        },
        !privateInfo
      );

      await reloadUserAndProfile();
      setStatusMsg(
        locale === 'ar' ? 'تم حفظ الملف الشخصي وإعدادات الخصوصية بنجاح.' : 'Profile and privacy settings saved.'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
          {t.sidebar.profile}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {locale === 'ar'
            ? 'البيانات الشخصية الخاصة معزولة عن القراءة العامة، وتُستخدم المهارات والأدوار فقط في المطابقة العادلة.'
            : 'Private PII (email and consent) is isolated in owner-only storage; skills and roles power fair team matching.'}
        </p>
      </div>

      {errorMsg && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
          {errorMsg}
        </div>
      )}
      {statusMsg && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-300">
          {statusMsg}
        </div>
      )}

      <form onSubmit={(e) => void handleSave(e)} className="space-y-6">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">
            {locale === 'ar' ? 'الهوية المهنية والمهارات' : 'Builder Identity & Skills'}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                {locale === 'ar' ? 'الاسم الكامل' : 'Full Name'}
              </label>
              <input
                type="text"
                required
                maxLength={80}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                {locale === 'ar' ? 'المسمى المهني' : 'Professional Title'}
              </label>
              <input
                type="text"
                maxLength={100}
                placeholder="Full-Stack & Edge AI Engineer"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                {t.auth.roleLabel}
              </label>
              <select
                value={requestedRole}
                onChange={(e) => setRequestedRole(e.target.value as AccountRole)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              >
                <option value="participant">{t.auth.roleParticipant}</option>
                <option value="organizer">{t.auth.roleOrganizer}</option>
                <option value="judge">{t.auth.roleJudge}</option>
                <option value="sponsor">{t.auth.roleSponsor}</option>
              </select>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                <span>
                  {t.auth.approvedRoleLabel}:{' '}
                  <strong className="capitalize text-slate-700 dark:text-slate-200">
                    {profile?.approvedRole || 'participant'}
                  </strong>
                </span>
                {requestedRole !== (profile?.approvedRole || 'participant') && (
                  <span className="text-amber-600 dark:text-amber-400">
                    {locale === 'ar' ? 'بانتظار موافقة الإدارة' : 'Pending admin approval'}
                  </span>
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                {locale === 'ar' ? 'مستوى الخبرة' : 'Experience Level'}
              </label>
              <select
                value={experienceLevel}
                onChange={(e) => setExperienceLevel(e.target.value as ExperienceLevel)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              >
                <option value="beginner">{locale === 'ar' ? 'مبتدئ' : 'Beginner'}</option>
                <option value="intermediate">{locale === 'ar' ? 'متوسط' : 'Intermediate'}</option>
                <option value="advanced">{locale === 'ar' ? 'متقدم' : 'Advanced'}</option>
                <option value="expert">{locale === 'ar' ? 'خبير' : 'Expert'}</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                {locale === 'ar' ? 'التفرغ' : 'Availability'}
              </label>
              <select
                value={availability}
                onChange={(e) => setAvailability(e.target.value as AvailabilityLevel)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              >
                <option value="full_time">
                  {locale === 'ar' ? 'تفرغ كامل خلال الهاكاثون' : 'Full-time during hackathon'}
                </option>
                <option value="part_time">{locale === 'ar' ? 'دوام جزئي' : 'Part-time'}</option>
                <option value="weekends_only">
                  {locale === 'ar' ? 'نهاية الأسبوع فقط' : 'Weekends only'}
                </option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                {locale === 'ar' ? 'تفضيل الفريق' : 'Team Preference'}
              </label>
              <select
                value={teamPreference}
                onChange={(e) => setTeamPreference(e.target.value as TeamPreference)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              >
                <option value="looking_for_team">
                  {locale === 'ar' ? 'أبحث عن فريق' : 'Looking for a team'}
                </option>
                <option value="open_to_join">
                  {locale === 'ar' ? 'منفتح لدعوات الفرق' : 'Open to team invitations'}
                </option>
                <option value="already_have_team">
                  {locale === 'ar' ? 'لدي فريق بالفعل' : 'Already have a team'}
                </option>
                <option value="solo">{locale === 'ar' ? 'مشارك منفرد' : 'Solo builder'}</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
              {locale === 'ar' ? 'نبذة تعريفية' : 'Biography'}
            </label>
            <textarea
              rows={3}
              maxLength={1000}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                {locale === 'ar' ? 'المهارات (مفصولة بفاصلة)' : 'Skills (comma-separated)'}
              </label>
              <input
                type="text"
                placeholder="TypeScript, React, Firebase, Python"
                value={skillsText}
                onChange={(e) => setSkillsText(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                {locale === 'ar' ? 'الأدوار المفضلة' : 'Preferred Roles (comma-separated)'}
              </label>
              <input
                type="text"
                placeholder="AI Engineer, Frontend Lead, Product"
                value={rolesText}
                onChange={(e) => setRolesText(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                {locale === 'ar' ? 'الاهتمامات' : 'Interests (comma-separated)'}
              </label>
              <input
                type="text"
                placeholder="Healthcare, Climate, Edge AI"
                value={interestsText}
                onChange={(e) => setInterestsText(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                {locale === 'ar' ? 'لغات البرمجة والتواصل' : 'Preferred Languages'}
              </label>
              <input
                type="text"
                placeholder="English, Arabic, TypeScript"
                value={languagesText}
                onChange={(e) => setLanguagesText(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                GitHub URL
              </label>
              <input
                type="url"
                placeholder="https://github.com/username"
                value={githubUrl}
                onChange={(e) => setGithubUrl(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                LinkedIn URL
              </label>
              <input
                type="url"
                placeholder="https://linkedin.com/in/username"
                value={linkedinUrl}
                onChange={(e) => setLinkedinUrl(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                Portfolio URL
              </label>
              <input
                type="url"
                placeholder="https://portfolio.example.com"
                value={portfolioUrl}
                onChange={(e) => setPortfolioUrl(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              />
            </div>
          </div>
        </div>

        {/* Private Settings & AI Cloud Consent */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">
            {locale === 'ar' ? 'إعدادات الخصوصية وموافقة الذكاء السحابي' : 'Privacy & Hybrid AI Consent'}
          </h2>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {locale === 'ar' ? 'البريد الإلكتروني الخاص:' : 'Private Email:'}{' '}
            <span className="font-mono text-slate-800 dark:text-slate-200">{user?.email}</span>
          </div>

          <label className="flex items-start gap-3 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={aiCloudConsent}
              onChange={(e) => setAiCloudConsent(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600"
            />
            <span>
              <span className="font-medium text-slate-900 dark:text-white block">
                {locale === 'ar'
                  ? 'السماح بإرسال سياق المشروع إلى الذكاء الاصطناعي السحابي عند الحاجة'
                  : 'Allow Cloud Gemini AI processing when on-device inference is unavailable or cloud mode is selected'}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {locale === 'ar'
                  ? 'عند إلغاء التحديد، ستقتصر طلبات الذكاء الاصطناعي على وضع الجهاز المحلي فقط.'
                  : 'When disabled, cloud-routed AI requests are blocked until you explicitly consent.'}
              </span>
            </span>
          </label>

          <label className="flex items-center gap-3 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={notificationsEnabled}
              onChange={(e) => setNotificationsEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600"
            />
            <span className="font-medium text-slate-900 dark:text-white">
              {locale === 'ar' ? 'تفعيل الإشعارات داخل التطبيق' : 'Enable in-app Firestore notifications'}
            </span>
          </label>

          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
              {locale === 'ar' ? 'لغة الواجهة:' : 'Interface Language:'}
            </span>
            <button
              type="button"
              onClick={() => setLocale('en')}
              className={`rounded-md px-3 py-1 text-xs font-medium ${
                locale === 'en' ? 'bg-blue-600 text-white' : 'border border-slate-300 dark:border-slate-700'
              }`}
            >
              English (LTR)
            </button>
            <button
              type="button"
              onClick={() => setLocale('ar')}
              className={`rounded-md px-3 py-1 text-xs font-medium ${
                locale === 'ar' ? 'bg-blue-600 text-white' : 'border border-slate-300 dark:border-slate-700'
              }`}
            >
              العربية (RTL)
            </button>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? t.common.saving : t.common.save}
          </button>
        </div>
      </form>
    </div>
  );
}
