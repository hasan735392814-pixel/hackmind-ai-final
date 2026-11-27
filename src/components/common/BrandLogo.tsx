interface BrandLogoProps {
  className?: string;
  iconSize?: number;
  showText?: boolean;
}

export function BrandLogo({ className = '', iconSize = 28, showText = true }: BrandLogoProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 whitespace-nowrap shrink-0 ${className}`}>
      {/* Official HACKMIND AI Brain-Circuit Emblem */}
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="shrink-0 drop-shadow-[0_0_8px_rgba(56,189,248,0.4)]"
      >
        <defs>
          <linearGradient id="hm-circuit-grad" x1="4" y1="4" x2="36" y2="36" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#38BDF8" />
            <stop offset="50%" stopColor="#6366F1" />
            <stop offset="100%" stopColor="#A855F7" />
          </linearGradient>
          <linearGradient id="hm-orbit-grad" x1="2" y1="32" x2="38" y2="10" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#F59E0B" />
            <stop offset="60%" stopColor="#FBBF24" />
            <stop offset="100%" stopColor="#FDE68A" />
          </linearGradient>
          <radialGradient id="hm-glow" cx="20" cy="20" r="18" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#38BDF8" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Subtle Ambient Glow */}
        <circle cx="20" cy="20" r="18" fill="url(#hm-glow)" />

        {/* Left Brain Hemisphere Circuit Traces */}
        <path
          d="M14 10C11 10 9 12 9 15C9 16.5 9.8 17.8 11 18.5C9.5 19.3 8.5 21 8.5 23C8.5 25.5 10.5 27.5 13 27.5C13.5 27.5 14 27.4 14.5 27.2"
          stroke="url(#hm-circuit-grad)"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M12 14.5H14.5M10.5 22H14"
          stroke="url(#hm-circuit-grad)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <circle cx="10.5" cy="14.5" r="1" fill="#38BDF8" />
        <circle cx="9" cy="22" r="1" fill="#38BDF8" />

        {/* Right Brain Hemisphere Circuit Traces */}
        <path
          d="M26 10C29 10 31 12 31 15C31 16.5 30.2 17.8 29 18.5C30.5 19.3 31.5 21 31.5 23C31.5 25.5 29.5 27.5 27 27.5C26.5 27.5 26 27.4 25.5 27.2"
          stroke="url(#hm-circuit-grad)"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M28 14.5H25.5M29.5 22H26"
          stroke="url(#hm-circuit-grad)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <circle cx="29.5" cy="14.5" r="1" fill="#A855F7" />
        <circle cx="31" cy="22" r="1" fill="#A855F7" />

        {/* Central Bold 'H' Motif */}
        <path
          d="M16 13V27M24 13V27M16 20H24"
          stroke="white"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]"
        />

        {/* Official Golden Orbit Loop */}
        <path
          d="M6 29C10 34 26 35 34 23C36 19 36 14 33 11"
          stroke="url(#hm-orbit-grad)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="33" cy="11" r="1.5" fill="#FBBF24" />
      </svg>

      {showText && (
        <span className="font-display text-base font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-1.5">
          <span>HACKMIND</span>
          <span className="bg-gradient-to-r from-blue-500 via-indigo-400 to-purple-500 bg-clip-text text-transparent font-extrabold">
            AI
          </span>
        </span>
      )}
    </span>
  );
}
