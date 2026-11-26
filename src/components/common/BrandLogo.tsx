export function BrandLogo({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 whitespace-nowrap shrink-0 ${className}`}>
      <svg
        width="26"
        height="26"
        viewBox="0 0 28 28"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="shrink-0"
      >
        <rect x="2" y="2" width="24" height="24" rx="6" className="fill-blue-600" />
        <path
          d="M9 8V20M19 8V20M9 14H19"
          stroke="white"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <circle cx="14" cy="14" r="2.2" className="fill-indigo-200" />
      </svg>
      <span className="font-display text-base font-bold tracking-tight text-slate-900 dark:text-white">
        HACKMIND AI
      </span>
    </span>
  );
}
