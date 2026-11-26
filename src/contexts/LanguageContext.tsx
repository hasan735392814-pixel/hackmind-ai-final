import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { translations, type Locale, type TranslationKeys } from '../i18n/translations';

interface LanguageContextValue {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  t: TranslationKeys;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);
const LOCALE_STORAGE_KEY = 'hackmind_locale';

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (saved === 'ar' || saved === 'en') return saved;
    }
    return 'en';
  });

  const dir: 'ltr' | 'rtl' = locale === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
      document.documentElement.dir = dir;
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    }
  }, [locale, dir]);

  const setLocale = (next: Locale) => setLocaleState(next);
  const toggleLocale = () => setLocaleState((prev) => (prev === 'en' ? 'ar' : 'en'));

  return (
    <LanguageContext.Provider
      value={{
        locale,
        dir,
        t: translations[locale] as TranslationKeys,
        setLocale,
        toggleLocale
      }}
    >
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error('useLanguage must be used within LanguageProvider');
  }
  return ctx;
}
