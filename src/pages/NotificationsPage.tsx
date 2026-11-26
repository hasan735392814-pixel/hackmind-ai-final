import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Check, Trash2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import {
  deleteNotification,
  listDerivedUserActivity,
  markNotificationRead,
  subscribeUserNotifications,
  type DerivedActivityItem
} from '../services/firebase/firestoreService';
import type { AppNotification } from '../types/domain';
import { isValidInternalAppLink } from '../utils/validation';

export function NotificationsPage() {
  const { user } = useAuth();
  const { locale, t } = useLanguage();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [derivedActivity, setDerivedActivity] = useState<DerivedActivityItem[]>([]);
  const [errorMsg, setErrorMsg] = useState('');

  const toMillis = (val: unknown): number => {
    if (val && typeof val === 'object' && 'toMillis' in val && typeof (val as { toMillis: () => number }).toMillis === 'function') {
      return (val as { toMillis: () => number }).toMillis();
    }
    if (val && typeof val === 'object' && 'seconds' in val) {
      return Number((val as { seconds: number }).seconds) * 1000;
    }
    return 0;
  };

  useEffect(() => {
    if (!user) return;
    void listDerivedUserActivity(user.uid)
      .then((activity) => setDerivedActivity(activity))
      .catch(() => setDerivedActivity([]));

    const unsub = subscribeUserNotifications(
      user.uid,
      (list) => {
        const sorted = [...list].sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
        setItems(sorted);
      },
      (err) => {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : locale === 'ar'
              ? 'تعذر مزامنة الإشعارات.'
              : 'Unable to stream notifications.'
        );
      }
    );
    return () => unsub();
  }, [user, locale]);

  const handleMarkRead = async (id: string) => {
    setErrorMsg('');
    try {
      await markNotificationRead(id);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : locale === 'ar'
            ? 'تعذر تحديد الإشعار كمقروء.'
            : 'Failed to mark notification read'
      );
    }
  };

  const handleDelete = async (id: string) => {
    setErrorMsg('');
    try {
      await deleteNotification(id);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : locale === 'ar'
            ? 'تعذر حذف الإشعار.'
            : 'Failed to delete notification'
      );
    }
  };

  const safeInternalLink = (link?: string) => (link && isValidInternalAppLink(link) ? link : '/app');

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
          {t.sidebar.notifications}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {locale === 'ar'
            ? 'نشاطات موثقة مباشرة من سجلات Firestore (الدعوات، التسجيلات، مهام التحكيم، والنتائج) بدون إشعارات عابرة للمستخدمين.'
            : 'Authoritative in-app activity derived directly from Firestore records alongside your personal alerts.'}
        </p>
      </div>

      {errorMsg && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      {derivedActivity.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-display text-sm font-semibold text-slate-700 dark:text-slate-300">
            {locale === 'ar' ? 'تحديثات السجلات الموثقة' : 'Authoritative Activity Updates'}
          </h2>
          {derivedActivity.map((act) => (
            <div
              key={act.id}
              className={`rounded-xl border p-4 flex flex-wrap items-center justify-between gap-4 ${
                act.actionRequired
                  ? 'border-blue-500/40 bg-blue-500/5'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]'
              }`}
            >
              <div className="space-y-1">
                <div className="text-xs font-mono text-blue-500 uppercase">{act.type.replace('_', ' ')}</div>
                <Link
                  to={safeInternalLink(act.link)}
                  className="font-semibold text-sm text-slate-900 dark:text-white hover:underline"
                >
                  {act.title}
                </Link>
                <p className="text-xs text-slate-600 dark:text-slate-400">{act.message}</p>
              </div>
              <Link
                to={safeInternalLink(act.link)}
                className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                {locale === 'ar' ? 'فتح' : 'Open'}
              </Link>
            </div>
          ))}
        </div>
      )}

      {items.length === 0 && derivedActivity.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-10 text-center space-y-2">
          <Bell className="h-6 w-6 text-slate-400 mx-auto" />
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {locale === 'ar' ? 'لا توجد إشعارات حتى الآن.' : 'You have no notifications yet.'}
          </p>
        </div>
      ) : items.length > 0 ? (
        <div className="space-y-3">
          <h2 className="font-display text-sm font-semibold text-slate-700 dark:text-slate-300">
            {locale === 'ar' ? 'التنبيهات الشخصية' : 'Personal Alerts'}
          </h2>
          {items.map((n) => (
            <div
              key={n.id}
              className={`rounded-xl border p-4 flex flex-wrap items-center justify-between gap-4 ${
                n.read
                  ? 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]'
                  : 'border-blue-500/40 bg-blue-500/5'
              }`}
            >
              <div className="space-y-1">
                <div className="text-xs font-mono text-blue-500 uppercase">{n.type.replace('_', ' ')}</div>
                <Link
                  to={safeInternalLink(n.link)}
                  className="font-semibold text-sm text-slate-900 dark:text-white hover:underline"
                >
                  {n.title}
                </Link>
                <p className="text-xs text-slate-600 dark:text-slate-400">{n.message}</p>
              </div>
              <div className="flex items-center gap-2">
                {!n.read && (
                  <button
                    type="button"
                    onClick={() => void handleMarkRead(n.id)}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs"
                  >
                    <Check className="h-3.5 w-3.5" />
                    <span>{locale === 'ar' ? 'تحديد كمقروء' : 'Mark Read'}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleDelete(n.id)}
                  className="p-1.5 rounded-md text-slate-400 hover:text-red-500"
                  aria-label={t.common.delete}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
