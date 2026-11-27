import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronDown,
  ChevronUp,
  Cpu,
  Cloud,
  ArrowRight,
  ArrowLeft,
  Rocket,
  Users,
  Code2,
  Trophy,
  Maximize2,
  X
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import { listPublishedHackathons } from '../services/firebase/firestoreService';
import { detectDeviceCapability } from '../services/hybridAI/deviceCapability';
import type { DeviceCapabilityReport } from '../services/hybridAI/types';
import type { Hackathon } from '../types/domain';
import { BrandLogo } from '../components/common/BrandLogo';
import { SafeImage } from '../components/common/SafeImage';
import heroWorkspaceImg from '../assets/images/hero_hackmind_workspace_1794769584396.jpg';
import edgeAiWorkstationImg from '../assets/images/hackathon_edge_ai_1794769584219.jpg';
import judgingReviewImg from '../assets/images/hackathon_judging_review_1794769585505.jpg';

const OFFICIAL_HERO_COVER_PNG = '/assets/branding/hackmind_official_cover.png';
const OFFICIAL_HERO_COVER_WEBP = '/assets/branding/hackmind_official_cover.webp';

export function LandingPage() {
  const { user } = useAuth();
  const { locale, dir, t, toggleLocale } = useLanguage();
  const [hackathons, setHackathons] = useState<Hackathon[]>([]);
  const [loadingHackathons, setLoadingHackathons] = useState(true);
  const [hackathonsLoadError, setHackathonsLoadError] = useState('');
  const [capability, setCapability] = useState<DeviceCapabilityReport | null>(null);
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [legalModal, setLegalModal] = useState<'docs' | 'privacy' | 'terms' | 'contact' | null>(null);
  const [previewArtworkModal, setPreviewArtworkModal] = useState(false);

  const ArrowIcon = dir === 'rtl' ? ArrowLeft : ArrowRight;

  useEffect(() => {
    setHackathonsLoadError('');
    void listPublishedHackathons()
      .then((list) => setHackathons(list.slice(0, 6)))
      .catch((err) => {
        setHackathons([]);
        setHackathonsLoadError(
          err instanceof Error ? err.message : 'Unable to load published hackathons.'
        );
      })
      .finally(() => setLoadingHackathons(false));

    void detectDeviceCapability(locale).then(setCapability);
  }, [locale]);

  const faqs =
    locale === 'ar'
      ? [
          {
            q: 'كيف يعمل الذكاء الهجين في HACKMIND AI؟',
            a: 'تستخدم المنصة حزمة Firebase AI Logic الرسمية لتشغيل المهام الخفيفة على الجهاز المحلي عبر Chrome Prompt API عندما يكون متاحاً وجاهزاً، وتنتقل تلقائياً أو اختيارياً إلى نماذج Gemini السحابية للمهام المعقدة، مع إظهار المصدر الفعلي لكل عملية.'
          },
          {
            q: 'هل يستبدل الذكاء الاصطناعي المحكمين البشر؟',
            a: 'لا. يساعد الذكاء الاصطناعي المحكمين في فصل الأدلة الموثقة عن ادعاءات الفريق وتحديد الأدلة المفقودة واقتراح الأسئلة، بينما يحتفظ المحكمون البشر بالقرار والدرجة النهائية دائماً.'
          },
          {
            q: 'هل يعمل الاستدلال المحلي على الهواتف الذكية؟',
            a: 'يتطلب الاستدلال المحلي على الويب متصفح Chrome مكتبي متوافق. على الأجهزة المحمولة، تعمل كافة ميزات المنصة بسلاسة عبر الاستدلال السحابي في Firebase AI Logic.'
          },
          {
            q: 'كيف تتم حماية خصوصية المشاريع وبيانات الفرق؟',
            a: 'يتم عزل البيانات الشخصية في مسارات محمية بقواعد أمان Firestore، كما يتطلب إرسال بيانات المشاريع إلى الذكاء السحابي موافقة صريحة من المستخدم.'
          }
        ]
      : [
          {
            q: 'How does Hybrid AI routing work in HACKMIND AI?',
            a: 'HACKMIND AI uses the official Firebase AI Logic SDK. Lightweight single-turn tasks can execute locally through the Chrome Prompt API when supported, while deep analysis routes to cloud Gemini models. Every result displays the verified inferenceSource reported by the SDK.'
          },
          {
            q: 'Does AI replace human judges in scoring?',
            a: 'Never. The AI Judge Assistant separates verified evidence from unverified team claims and surfaces missing documentation. Human judges always enter independent rubric scores and hold final ranking authority.'
          },
          {
            q: 'Is web on-device inference supported on mobile browsers?',
            a: 'No. Web on-device inference requires a compatible desktop Chrome environment with the Prompt API enabled. Mobile browsers automatically operate via Firebase AI Logic Cloud inference.'
          },
          {
            q: 'How is project privacy enforced?',
            a: 'Firestore Security Rules isolate private user PII and restrict team workspaces and submissions to authorized members and assigned judges. Cloud AI transmission requires explicit user consent.'
          }
        ];

  const rolesList =
    locale === 'ar'
      ? [
          {
            num: '01',
            title: 'منظمو الهاكاثونات',
            desc: 'إنشاء المنافسات، صياغة الشروط ومعايير التحكيم بمساعدة الذكاء الاصطناعي، إدارة التسجيلات والفرق، تعيين المحكمين، ونشر النتائج الموثقة.'
          },
          {
            num: '02',
            title: 'المبتكرون والمشاركون',
            desc: 'استكشاف الهاكاثونات المنشورة، تكوين الفرق أو الانضمام إليها بالمطابقة الذكية، تطوير خطة المشروع مع المرشد الذكي، وتسليم المشاريع.'
          },
          {
            num: '03',
            title: 'المحكمون',
            desc: 'فحص التسليمات والمستودعات المتاحة، استخدام مساعد التحكيم لفصل الأدلة عن الادعاءات، وإدخال الدرجات المستقلة بشفافية تامة.'
          },
          {
            num: '04',
            title: 'الرعاة والإدارة',
            desc: 'متابعة إحصائيات المشاركة، اتجاهات التقنيات، والمسارات المدعومة مع تقارير مجمعة تحترم خصوصية المشاركين.'
          }
        ]
      : [
          {
            num: '01',
            title: 'Hackathon Organizers',
            desc: 'Configure tracks, timelines, and custom weighted rubrics, draft guidelines with AI assistance, review participants, assign judges, and publish audited rankings.'
          },
          {
            num: '02',
            title: 'Builders & Participants',
            desc: 'Discover live competitions, match with complementary teammates on fair skill criteria, plan MVPs with the Hybrid AI Mentor, and submit validated deliverables.'
          },
          {
            num: '03',
            title: 'Competition Judges',
            desc: 'Inspect submission metadata and public repositories, review AI-separated verified evidence vs. team claims, declare conflicts, and submit independent scores.'
          },
          {
            num: '04',
            title: 'Sponsors & Admins',
            desc: 'Track authorized competition engagement, technology adoption trends, and sponsored track outcomes without exposing private participant PII.'
          }
        ];

  const modalTitle =
    legalModal === 'docs'
      ? t.landing.footerDocs
      : legalModal === 'privacy'
        ? t.landing.footerPrivacy
        : legalModal === 'terms'
          ? t.landing.footerTerms
          : t.landing.footerContact;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-[#070B14] dark:text-slate-100">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-40 border-b border-slate-200 dark:border-slate-800/80 bg-white/90 dark:bg-[#070B14]/90 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          <Link to="/" className="whitespace-nowrap shrink-0">
            <BrandLogo />
          </Link>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-300">
            <a href="#discover" className="hover:text-slate-950 dark:hover:text-white transition-colors whitespace-nowrap shrink-0">
              {t.nav.discover}
            </a>
            <a href="#hybrid-ai" className="hover:text-slate-950 dark:hover:text-white transition-colors whitespace-nowrap shrink-0">
              {t.nav.architecture}
            </a>
            <a href="#roles" className="hover:text-slate-950 dark:hover:text-white transition-colors whitespace-nowrap shrink-0">
              {t.nav.roles}
            </a>
            <a href="#faq" className="hover:text-slate-950 dark:hover:text-white transition-colors whitespace-nowrap shrink-0">
              {t.nav.faq}
            </a>
            <button
              type="button"
              onClick={toggleLocale}
              className="hover:text-slate-950 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              {locale === 'en' ? 'العربية' : 'English'}
            </button>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <Link
              to={user ? '/app' : '/auth'}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
            >
              <span>{user ? t.nav.workspace : t.nav.signIn}</span>
              <ArrowIcon className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative mx-auto max-w-7xl px-4 sm:px-6 pt-10 pb-16 lg:pt-16 lg:pb-20">
        {/* Ambient Atmospheric Neon Glows (Dark Navy / Electric Blue / Purple) */}
        <div className="pointer-events-none absolute -top-16 inset-x-0 h-96 overflow-hidden -z-10">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[360px] bg-gradient-to-b from-blue-600/15 via-purple-600/10 to-transparent blur-3xl opacity-70 dark:opacity-90" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
          {/* Left Column: Value Proposition & CTAs */}
          <div className="lg:col-span-6 flex flex-col justify-center space-y-6">
            <div className="inline-flex items-center gap-2 self-start rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-600 dark:text-blue-400">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
              <span>{locale === 'ar' ? 'منصة هاكاثونات ذكية مدعومة بالذكاء الاصطناعي' : 'An Intelligent Hackathon Platform Powered by AI'}</span>
            </div>

            <h1
              className="font-display font-extrabold tracking-tight text-slate-900 dark:text-white leading-[1.12]"
              style={{ fontSize: 'clamp(2.25rem, 4.2vw, 3.6rem)', textWrap: 'balance' }}
            >
              {t.landing.heroTitle}
            </h1>

            <p className="text-base sm:text-lg leading-relaxed text-slate-600 dark:text-slate-300 max-w-xl">
              {t.landing.heroSubtitle}
            </p>

            <div className="flex flex-wrap items-center gap-4 pt-1">
              <Link
                to={user ? '/app' : '/auth'}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-blue-500/25 hover:from-blue-500 hover:to-indigo-500 transition-all whitespace-nowrap"
              >
                <span>{t.landing.heroPrimaryCta}</span>
                <ArrowIcon className="h-4 w-4" />
              </Link>
              <a
                href="#discover"
                className="inline-flex items-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700/80 bg-white/50 dark:bg-slate-900/40 backdrop-blur px-6 py-3.5 text-sm font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/80 transition-colors whitespace-nowrap"
              >
                {t.landing.heroSecondaryCta}
              </a>
              <button
                type="button"
                onClick={toggleLocale}
                className="md:hidden text-xs font-semibold text-blue-600 dark:text-blue-400 px-2 py-2"
              >
                {locale === 'en' ? 'التبديل إلى العربية' : 'Switch to English'}
              </button>
            </div>

            {/* Platform Powered-By Indicators */}
            <div className="pt-2 flex flex-wrap items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <Cpu className="h-3.5 w-3.5 text-blue-500" />
                <span>Gemini Nano On-Device</span>
              </span>
              <span aria-hidden="true" className="text-slate-400">·</span>
              <span className="inline-flex items-center gap-1.5 font-medium">
                <Cloud className="h-3.5 w-3.5 text-purple-500" />
                <span>Firebase Cloud AI & Auth</span>
              </span>
              <span aria-hidden="true" className="text-slate-400">·</span>
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                {locale === 'ar' ? 'تحكيم موثق V2' : 'Verifiable Judging V2'}
              </span>
            </div>
          </div>

          {/* Right Column: Official HACKMIND AI Branding Hero Visual */}
          <div className="lg:col-span-6 flex justify-center">
            <div className="relative w-full max-w-2xl rounded-2xl border border-blue-500/30 dark:border-blue-400/25 bg-[#060A14] p-1.5 shadow-[0_0_50px_-15px_rgba(59,130,246,0.35)] dark:shadow-[0_0_60px_-15px_rgba(139,92,246,0.25)] group transition-all duration-300">
              <div className="relative w-full overflow-hidden rounded-xl aspect-[3/2] bg-[#070B14]">
                <SafeImage
                  src={OFFICIAL_HERO_COVER_PNG}
                  webpSrc={OFFICIAL_HERO_COVER_WEBP}
                  alt={
                    locale === 'ar'
                      ? 'الغلاف الرسمي لمنصة HACKMIND AI: منصة هاكاثونات ذكية مدعومة بالذكاء الاصطناعي مع تقنيات Gemini Nano وFirebase وشعار الدماغ والـ H وأدوات إدارة الهاكاثون والتعاون والتحكيم الذكي'
                      : 'Official HACKMIND AI branding artwork: An Intelligent Hackathon Platform powered by Gemini Nano and Firebase, featuring the glowing brain emblem, hackathon management, team collaboration, and smart evaluation.'
                  }
                  fallbackTitle={locale === 'ar' ? 'الهوية البصرية الرسمية لمنصة HACKMIND AI' : 'Official HACKMIND AI Platform Visual'}
                  fallbackSubtitle="Gemini Nano · Firebase · Fair Judging V2"
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.01]"
                  loading="eager"
                />

                {/* Subtle Bottom Ambient Gradient Scrim */}
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#060A14]/90 via-transparent to-transparent" />

                {/* Floating Caption & Fullscreen Trigger */}
                <div className="absolute bottom-3 inset-x-3 sm:bottom-4 sm:inset-x-4 flex items-center justify-between gap-2 rounded-xl bg-slate-950/80 backdrop-blur-md border border-white/10 px-3.5 py-2 text-xs text-slate-200">
                  <div className="flex items-center gap-2 truncate">
                    <span className="h-2 w-2 rounded-full bg-blue-400 shrink-0 shadow-[0_0_6px_#38bdf8]" />
                    <span className="font-semibold text-white truncate">
                      {locale === 'ar' ? 'الهوية البصرية الرسمية · HACKMIND AI' : 'Official Brand Visual · HACKMIND AI'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPreviewArtworkModal(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600/40 hover:bg-blue-600/70 border border-blue-400/30 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors shrink-0"
                    aria-label={locale === 'ar' ? 'تكبير الغلاف الرسمي' : 'View full-size cover artwork'}
                  >
                    <Maximize2 className="h-3 w-3" />
                    <span>{locale === 'ar' ? 'تكبير' : 'View'}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 4 Core Pillars Strip (Echoing Official Cover Badges: Management, Collaboration, AI Dev, Smart Evaluation) */}
        <div className="mt-14 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800/80 bg-white/70 dark:bg-[#0B1120]/70 backdrop-blur p-4 transition-all hover:border-blue-500/40 dark:hover:border-blue-400/40 group">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 group-hover:scale-105 transition-transform">
                <Rocket className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                  {locale === 'ar' ? 'إدارة الهاكاثونات' : 'Hackathon Management'}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {locale === 'ar' ? 'مسارات ذكية ومعايير وجداول مخصصة' : 'Tracks, timelines & weighted rubrics'}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800/80 bg-white/70 dark:bg-[#0B1120]/70 backdrop-blur p-4 transition-all hover:border-indigo-500/40 dark:hover:border-indigo-400/40 group">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 group-hover:scale-105 transition-transform">
                <Users className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                  {locale === 'ar' ? 'التعاون وبناء الفرق' : 'Team Collaboration'}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {locale === 'ar' ? 'مطابقة قائمة على المهارات والأدوار' : 'Skill matching & role complementarity'}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800/80 bg-white/70 dark:bg-[#0B1120]/70 backdrop-blur p-4 transition-all hover:border-purple-500/40 dark:hover:border-purple-400/40 group">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400 group-hover:scale-105 transition-transform">
                <Code2 className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                  {locale === 'ar' ? 'التطوير بالذكاء الاصطناعي' : 'AI-Powered Development'}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {locale === 'ar' ? 'مرشد هجين على الجهاز وعبر السحابة' : 'Hybrid AI Mentor & on-device Prompt API'}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800/80 bg-white/70 dark:bg-[#0B1120]/70 backdrop-blur p-4 transition-all hover:border-amber-500/40 dark:hover:border-amber-400/40 group">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 group-hover:scale-105 transition-transform">
                <Trophy className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                  {locale === 'ar' ? 'التحكيم الذكي الموزون' : 'Smart Evaluation'}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {locale === 'ar' ? 'فصل الأدلة عن الادعاءات وسلطة بشرية' : 'Evidence audit & human authority'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Hybrid AI Architecture Section */}
      <section
        id="hybrid-ai"
        className="border-y border-slate-200 dark:border-slate-800/80 bg-white dark:bg-[#0B1120] py-16 lg:py-24"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-stretch">
            <div className="lg:col-span-5">
              <div className="h-full overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 min-h-[260px]">
                <SafeImage
                  src={edgeAiWorkstationImg}
                  alt={locale === 'ar' ? 'محطة عمل الذكاء الطرفي' : 'Edge AI compute workstation'}
                  fallbackTitle={locale === 'ar' ? 'محطة عمل الذكاء الطرفي' : 'Edge AI Compute Workstation'}
                  fallbackSubtitle={locale === 'ar' ? 'استدلال محلي وسحابي هجين' : 'Hybrid On-Device & Cloud Compute'}
                  fallbackIcon={<Cpu className="h-5 w-5" />}
                  className="h-full w-full object-cover"
                />
              </div>
            </div>

            <div className="lg:col-span-7 flex flex-col justify-center space-y-6">
              <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                {t.landing.hybridSectionTitle}
              </h2>
              <p className="text-base text-slate-600 dark:text-slate-300 leading-relaxed">
                {t.landing.hybridSectionDesc}
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-5 bg-slate-50 dark:bg-[#070B14]">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                    <Cpu className="h-4 w-4 text-emerald-500" />
                    <span>{locale === 'ar' ? 'الاستدلال على الجهاز' : 'On-Device Path'}</span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                    {locale === 'ar'
                      ? 'يفحص توافر Chrome Prompt API وحالة النموذج المحلي بصدق دون ادعاء توفر غير مؤكد.'
                      : 'Inspects Chrome Prompt API availability for single-turn ideation, pitch checks, and match explanations.'}
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-5 bg-slate-50 dark:bg-[#070B14]">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                    <Cloud className="h-4 w-4 text-blue-500" />
                    <span>{locale === 'ar' ? 'الاستدلال السحابي' : 'Cloud Gemini Path'}</span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                    {locale === 'ar'
                      ? 'يتولى التخطيط العميق، هيكلة معايير التحكيم، وتحليل أدلة المشاريع بإخراج JSON منظم.'
                      : 'Handles complex roadmaps, rubric generation, and structured evidence audits with user cloud consent.'}
                  </p>
                </div>
              </div>

              {capability && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 bg-slate-50 dark:bg-[#070B14] text-xs space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      {locale === 'ar' ? 'فحص المتصفح الحالي الفوري:' : 'Live Browser Capability Probe:'}
                    </span>
                    <span className="font-mono text-blue-600 dark:text-blue-400">
                      {capability.localAvailability}
                    </span>
                  </div>
                  <p className="text-slate-600 dark:text-slate-400">{capability.localModelIdentityLabel}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Roles & Workflow */}
      <section id="roles" className="mx-auto max-w-7xl px-4 sm:px-6 py-16 lg:py-24">
        <div className="max-w-2xl mb-10">
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t.landing.rolesTitle}
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {rolesList.map((role) => (
            <div
              key={role.num}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6"
            >
              <div className="font-mono text-xs text-blue-600 dark:text-blue-400 mb-2 tabular-nums">
                {role.num}
              </div>
              <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-white">
                {role.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {role.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Published Hackathons Preview (Real Firestore Only) */}
      <section
        id="discover"
        className="border-t border-slate-200 dark:border-slate-800/80 bg-white dark:bg-[#0B1120] py-16 lg:py-24"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-4 mb-10">
            <div>
              <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                {t.landing.discoveryPreviewTitle}
              </h2>
            </div>
            <Link
              to="/app/discover"
              className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
            >
              {locale === 'ar' ? 'فتح الدليل الكامل' : 'Open full directory'}
            </Link>
          </div>

          {loadingHackathons ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {[1, 2, 3].map((idx) => (
                <div
                  key={idx}
                  className="h-48 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900/50 animate-pulse"
                />
              ))}
            </div>
          ) : hackathonsLoadError ? (
            <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-6 text-center space-y-2">
              <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                {locale === 'ar'
                  ? 'تعذر تحميل الهاكاثونات المنشورة من Firestore.'
                  : 'Unable to load published hackathons from Firestore.'}
              </p>
              <p className="text-xs font-mono break-all text-red-700/90 dark:text-red-300/90 max-w-2xl mx-auto">
                {hackathonsLoadError}
              </p>
            </div>
          ) : hackathons.length === 0 ? (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070B14] p-8 text-center">
              <p className="text-sm text-slate-600 dark:text-slate-300 max-w-xl mx-auto">
                {t.landing.discoveryPreviewEmpty}
              </p>
              <Link
                to={user ? '/app/organizer' : '/auth'}
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
              >
                {locale === 'ar' ? 'إنشاء هاكاثون الآن' : 'Create a Hackathon'}
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {hackathons.map((h) => (
                <div
                  key={h.id}
                  className="rounded-2xl border border-slate-200 dark:border-slate-800/80 bg-slate-50 dark:bg-[#070B14] p-6 flex flex-col justify-between space-y-4 transition-all hover:border-blue-500/40 dark:hover:border-blue-400/30 hover:shadow-lg hover:shadow-blue-500/5"
                >
                  <div>
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="capitalize">{h.mode.replace('_', ' ')}</span>
                      <span aria-hidden="true">·</span>
                      <span className="capitalize">{h.status}</span>
                      {h.submissionDeadline && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums">{h.submissionDeadline}</span>
                        </>
                      )}
                    </div>
                    <h3 className="mt-2 font-display text-lg font-semibold text-slate-900 dark:text-white">
                      {h.title}
                    </h3>
                    <p className="mt-2 text-sm text-slate-600 dark:text-slate-400 line-clamp-3">
                      {h.tagline || h.description}
                    </p>
                  </div>
                  <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs">
                    <span className="text-slate-500 dark:text-slate-400">{h.organizerName}</span>
                    <Link
                      to={`/app/discover`}
                      className="font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {locale === 'ar' ? 'التفاصيل والتسجيل' : 'View & Register'}
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Transparent Judging Preview */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6 py-16 lg:py-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-stretch">
          <div className="lg:col-span-6 flex flex-col justify-center space-y-4">
            <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
              {locale === 'ar'
                ? 'تحكيم شفاف مدعوم بالأدلة لا بالانطباعات'
                : 'Evidence-First Judging, Human Final Authority'}
            </h2>
            <p className="text-sm sm:text-base leading-relaxed text-slate-600 dark:text-slate-300">
              {locale === 'ar'
                ? 'يفصل مساعد التحكيم الذكي بين الأدلة المتحققة وادعاءات الفريق وينبه إلى أي روابط غير قابلة للوصول، بينما يقيّم المحكمون البشر وفق معايير موزونة مع رصد أي تباين في الدرجات.'
                : 'The AI Judge Assistant audits submission descriptions and accessible public GitHub metadata, explicitly separating verified evidence from team claims and missing proof. Multiple human judges score independently with weighted rubrics, disagreement spread checks, and conflict-of-interest declarations.'}
            </p>
          </div>
          <div className="lg:col-span-6">
            <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 h-full min-h-[240px]">
              <SafeImage
                src={judgingReviewImg}
                alt={locale === 'ar' ? 'لجنة التحكيم تفحص بنية المشروع' : 'Judging panel inspecting project architecture'}
                fallbackTitle={locale === 'ar' ? 'مراجعة لجنة التحكيم' : 'Evidence-First Judging Review'}
                fallbackSubtitle={locale === 'ar' ? 'تقييم شفاف مدعوم بالأدلة' : 'Transparent Rubric Scoring & Audit'}
                className="h-full w-full object-cover"
              />
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="border-t border-slate-200 dark:border-slate-800/80 py-16">
        <div className="mx-auto max-w-4xl px-4 sm:px-6">
          <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white mb-8">
            {t.landing.faqTitle}
          </h2>
          <div className="space-y-3">
            {faqs.map((item, i) => (
              <div
                key={item.q}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120]"
              >
                <button
                  type="button"
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="w-full px-5 py-4 text-start flex items-center justify-between gap-4 text-sm font-semibold text-slate-900 dark:text-white"
                >
                  <span>{item.q}</span>
                  {openFaq === i ? (
                    <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
                  )}
                </button>
                {openFaq === i && (
                  <div className="px-5 pb-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                    {item.a}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Quiet Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800/80 py-10">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 flex flex-wrap items-center justify-between gap-6 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex items-center gap-4">
            <BrandLogo />
            <span>© {new Date().getFullYear()} HACKMIND AI · MIT License</span>
          </div>
          <div className="flex flex-wrap items-center gap-6">
            <button type="button" onClick={() => setLegalModal('docs')} className="hover:text-slate-900 dark:hover:text-white">
              {t.landing.footerDocs}
            </button>
            <button type="button" onClick={() => setLegalModal('privacy')} className="hover:text-slate-900 dark:hover:text-white">
              {t.landing.footerPrivacy}
            </button>
            <button type="button" onClick={() => setLegalModal('terms')} className="hover:text-slate-900 dark:hover:text-white">
              {t.landing.footerTerms}
            </button>
            <button type="button" onClick={() => setLegalModal('contact')} className="hover:text-slate-900 dark:hover:text-white">
              {t.landing.footerContact}
            </button>
          </div>
        </div>
      </footer>

      {legalModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
          <div className="max-w-lg w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-6 space-y-4">
            <h3 className="font-display text-lg font-bold text-slate-900 dark:text-white">
              {modalTitle}
            </h3>
            <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              {legalModal === 'privacy' &&
                (locale === 'ar'
                  ? 'تفصل HACKMIND AI البيانات الشخصية في المسار المحمي /users/{uid}/private/info، وتفرض التحقق من البريد الإلكتروني وتدعم App Check، وتشترط موافقة المستخدم الصريحة قبل إرسال بيانات المشروع إلى Gemini السحابي.'
                  : 'HACKMIND AI separates PII in /users/{uid}/private/info, enforces verified Firebase Authentication and App Check support, and requires explicit user consent before routing project inputs to Cloud Gemini.')}
              {legalModal === 'docs' &&
                (locale === 'ar'
                  ? 'تتوفر ملفات التوثيق المعماري وإعداد Firebase والذكاء الهجين وقواعد الأمان والاختبارات في جذر المستودع (README.md, ARCHITECTURE.md, FIREBASE_SETUP.md, HYBRID_AI_SETUP.md, SECURITY.md, TESTING.md).'
                  : 'Architecture, Firebase setup, Hybrid AI verification, Security rules, and Testing documentation are included in the repository root (README.md, ARCHITECTURE.md, HYBRID_AI_SETUP.md, SECURITY.md, TESTING.md).')}
              {legalModal === 'terms' &&
                (locale === 'ar'
                  ? 'برمجيات مفتوحة المصدر موزعة بموجب رخصة MIT. يحتفظ منظمو الهاكاثونات والمحكمون بالمسؤولية الكاملة عن قوانين المنافسة وقرارات التقييم النهائية.'
                  : 'Open-source software distributed under the MIT License. Organizers and judges remain accountable for competition rules and final evaluation decisions.')}
              {legalModal === 'contact' &&
                (locale === 'ar'
                  ? 'لدعم المنافسات أو الإفصاح الأمني أو اعتماد أدوار المنظمين، تواصل مع مسؤول المنصة أو افتح تذكرة في مستودع المشروع.'
                  : 'For competition support, security disclosures, or organizer onboarding, open an issue in the HACKMIND AI repository or contact the platform administrator.')}
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setLegalModal(null)}
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
              >
                {t.common.close}
              </button>
            </div>
          </div>
        </div>
      )}

      {previewArtworkModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={locale === 'ar' ? 'معاينة الغلاف الرسمي لمنصة HACKMIND AI' : 'Official HACKMIND AI Cover Artwork Preview'}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 backdrop-blur-sm p-4 sm:p-6"
          onClick={() => setPreviewArtworkModal(false)}
        >
          <div
            className="relative max-w-4xl w-full rounded-2xl border border-blue-500/30 bg-[#060A14] p-3 sm:p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 px-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <BrandLogo iconSize={24} />
                <span className="text-xs text-slate-400">
                  {locale === 'ar' ? 'الهوية البصرية الرسمية' : 'Official Visual Identity'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setPreviewArtworkModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                aria-label={t.common.close}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="relative mt-3 w-full aspect-[3/2] overflow-hidden rounded-xl bg-slate-950">
              <SafeImage
                src={OFFICIAL_HERO_COVER_PNG}
                webpSrc={OFFICIAL_HERO_COVER_WEBP}
                alt={
                  locale === 'ar'
                    ? 'الغلاف الرسمي لمنصة HACKMIND AI: منصة هاكاثونات ذكية مدعومة بالذكاء الاصطناعي مع تقنيات Gemini Nano وFirebase وشعار الدماغ والـ H وأدوات إدارة الهاكاثون والتعاون والتحكيم الذكي'
                    : 'Official HACKMIND AI branding artwork: An Intelligent Hackathon Platform powered by Gemini Nano and Firebase, featuring the glowing brain emblem, hackathon management, team collaboration, and smart evaluation.'
                }
                fallbackTitle={locale === 'ar' ? 'الهوية البصرية الرسمية لمنصة HACKMIND AI' : 'Official HACKMIND AI Platform Visual'}
                fallbackSubtitle="Gemini Nano · Firebase · Fair Judging V2"
                className="h-full w-full object-contain"
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 px-2 text-xs text-slate-400">
              <span>HACKMIND AI · Innovate · Collaborate · Build Smarter</span>
              <span className="font-mono text-[11px] text-slate-500">1536 × 1024 · WebP / PNG</span>
              <img src={heroWorkspaceImg} alt="" className="hidden" aria-hidden="true" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
