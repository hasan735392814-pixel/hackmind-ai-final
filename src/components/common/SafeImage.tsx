import { useState, type ReactNode } from 'react';
import { ImageOff } from 'lucide-react';

interface SafeImageProps {
  src: string;
  alt: string;
  className?: string;
  fallbackTitle?: string;
  fallbackSubtitle?: string;
  fallbackIcon?: ReactNode;
  referrerPolicy?: React.HTMLAttributeReferrerPolicy;
  loading?: 'eager' | 'lazy';
}

export function SafeImage({
  src,
  alt,
  className = 'h-full w-full object-cover',
  fallbackTitle,
  fallbackSubtitle,
  fallbackIcon,
  referrerPolicy = 'no-referrer',
  loading
}: SafeImageProps) {
  const [failed, setFailed] = useState(false);

  if (failed || !src) {
    return (
      <div
        role="img"
        aria-label={alt}
        className="flex h-full w-full min-h-[220px] flex-col items-center justify-center gap-2 bg-gradient-to-br from-slate-900 via-[#0B1120] to-blue-950/60 p-6 text-center text-slate-300"
      >
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-700/80 bg-slate-800/80 text-blue-400">
          {fallbackIcon || <ImageOff className="h-5 w-5" />}
        </div>
        <div className="text-sm font-semibold text-white">{fallbackTitle || alt}</div>
        {fallbackSubtitle && (
          <div className="max-w-xs text-xs text-slate-400">{fallbackSubtitle}</div>
        )}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy={referrerPolicy}
      loading={loading}
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
