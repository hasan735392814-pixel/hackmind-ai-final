import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Award,
  BarChart3,
  Bell,
  Compass,
  FolderGit2,
  Gavel,
  Globe,
  Hammer,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Send,
  ShieldCheck,
  Sparkles,
  Sun,
  UserCircle,
  Users,
  X
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useTheme } from '../contexts/ThemeContext';
import { listDerivedUserActivity, subscribeUserNotifications } from '../services/firebase/firestoreService';
import type { AppNotification } from '../types/domain';
import { BrandLogo } from '../components/common/BrandLogo';

export function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, profile, emailVerified, resendVerification, reloadUserAndProfile, logout } = useAuth();
  const { locale, t, toggleLocale } = useLanguage();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [verifyMsg, setVerifyMsg] = useState('');

  useEffect(() => {
    if (!user) {
      setUnreadCount(0);
      return;
    }
    let selfUnread = 0;
    let derivedPending = 0;
    const syncTotal = () => setUnreadCount(selfUnread + derivedPending);

    void listDerivedUserActivity(user.uid)
      .then((items) => {
        derivedPending = items.filter((i) => i.actionRequired).length;
        syncTotal();
      })
      .catch(() => {});

    const unsub = subscribeUserNotifications(user.uid, (items: AppNotification[]) => {
      selfUnread = items.filter((n) => !n.read).length;
      syncTotal();
    });
    return () => unsub();
  }, [user]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const navItems = [
    { to: '/app', label: t.sidebar.overview, icon: LayoutDashboard, end: true },
    { to: '/app/discover', label: t.sidebar.discover, icon: Compass },
    { to: '/app/builder', label: t.sidebar.builder, icon: Hammer },
    { to: '/app/teams', label: t.sidebar.teams, icon: Users },
    { to: '/app/mentor', label: t.sidebar.mentor, icon: Sparkles },
    { to: '/app/submissions', label: t.sidebar.submissions, icon: Send },
    { to: '/app/organizer', label: t.sidebar.organizer, icon: FolderGit2 },
    { to: '/app/judging', label: t.sidebar.judging, icon: Gavel, end: true },
    { to: '/app/judging-v2', label: t.sidebar.judgingV2, icon: ShieldCheck },
    { to: '/app/sponsors', label: t.sidebar.sponsors, icon: BarChart3 },
    { to: '/app/diagnostics', label: t.sidebar.diagnostics, icon: Activity },
    { to: '/app/notifications', label: t.sidebar.notifications, icon: Bell, badge: unreadCount },
    { to: '/app/profile', label: t.sidebar.profile, icon: UserCircle }
  ];

  const handleResend = async () => {
    try {
      await resendVerification();
      setVerifyMsg(
        locale === 'ar'
          ? 'تم إرسال رسالة التحقق إلى بريدك الإلكتروني.'
          : 'Verification email sent. Check your inbox.'
      );
    } catch (err) {
      setVerifyMsg(err instanceof Error ? err.message : 'Failed to send email');
    }
  };

  const handleSignOut = async () => {
    await logout();
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-[#070B14] dark:text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 border-e border-slate-200 dark:border-slate-800/80 bg-white dark:bg-[#0B1120]">
        <div className="flex h-16 items-center px-5 border-b border-slate-200 dark:border-slate-800/80">
          <Link to="/" className="focus:outline-none">
            <BrandLogo />
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex items-center justify-between gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-white'
                  }`
                }
              >
                <span className="flex items-center gap-2.5 truncate">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </span>
                {typeof item.badge === 'number' && item.badge > 0 && (
                  <span className="font-mono text-xs tabular-nums rounded px-1.5 py-0.5 bg-blue-500/20 text-blue-700 dark:text-blue-200">
                    {item.badge}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 dark:border-slate-800/80 p-3 space-y-2">
          <div className="px-2 py-1">
            <p className="text-xs font-semibold truncate text-slate-900 dark:text-white">
              {profile?.displayName || user?.displayName || user?.email}
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 capitalize">
              {profile?.approvedRole || 'participant'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            <span>{t.nav.signOut}</span>
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/60"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <div className="relative z-10 flex w-72 max-w-[85vw] flex-col bg-white dark:bg-[#0B1120] border-e border-slate-200 dark:border-slate-800">
            <div className="flex h-16 items-center justify-between px-4 border-b border-slate-200 dark:border-slate-800">
              <BrandLogo />
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white"
                aria-label={t.common.close}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      `flex items-center justify-between gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium ${
                        isActive
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                      }`
                    }
                  >
                    <span className="flex items-center gap-2.5">
                      <Icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                    </span>
                    {typeof item.badge === 'number' && item.badge > 0 && (
                      <span className="font-mono text-xs tabular-nums">{item.badge}</span>
                    )}
                  </NavLink>
                );
              })}
            </nav>
            <div className="border-t border-slate-200 dark:border-slate-800 p-3">
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60"
              >
                <LogOut className="h-4 w-4" />
                <span>{t.nav.signOut}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:ps-64 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 h-16 border-b border-slate-200 dark:border-slate-800/80 bg-white/90 dark:bg-[#070B14]/90 backdrop-blur px-4 sm:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <span className="text-sm font-semibold text-slate-700 dark:text-slate-200 truncate">
              {navItems.find((i) =>
                i.end
                  ? location.pathname === i.to
                  : location.pathname === i.to || location.pathname.startsWith(`${i.to}/`)
              )?.label || t.sidebar.overview}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Link
              to="/app/notifications"
              className="relative inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-800 p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label={t.sidebar.notifications}
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="ms-1 font-mono text-xs tabular-nums text-blue-600 dark:text-blue-400">
                  {unreadCount}
                </span>
              )}
            </Link>

            <button
              type="button"
              onClick={toggleLocale}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              <Globe className="h-3.5 w-3.5" />
              <span>{locale === 'en' ? 'العربية' : 'English'}</span>
            </button>

            <button
              type="button"
              onClick={toggleTheme}
              className="inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-800 p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </header>

        {user && !emailVerified && (
          <div className="mx-4 sm:mx-6 mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
                <Award className="h-4 w-4 shrink-0" />
                <span>{t.auth.verifyBannerTitle}</span>
              </div>
              <p className="text-xs text-amber-800 dark:text-amber-300">{t.auth.verifyBannerDesc}</p>
              {verifyMsg && <p className="text-xs font-medium text-amber-900 dark:text-amber-100">{verifyMsg}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void handleResend()}
                className="rounded-lg border border-amber-600/40 px-3 py-1.5 text-xs font-medium text-amber-900 dark:text-amber-200 hover:bg-amber-500/20"
              >
                {t.auth.resendVerification}
              </button>
              <button
                type="button"
                onClick={() => void reloadUserAndProfile()}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
              >
                {t.auth.refreshVerification}
              </button>
            </div>
          </div>
        )}

        <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto">{children}</main>
      </div>
    </div>
  );
}
