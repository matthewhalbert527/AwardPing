type BrandLogoProps = {
  className?: string;
  markOnly?: boolean;
};

export function BrandLogo({ className = "", markOnly = false }: BrandLogoProps) {
  return (
    <span className={`brand-logo ${markOnly ? "brand-logo-mark-only" : ""} ${className}`}>
      <svg
        aria-hidden={markOnly ? undefined : "true"}
        className="brand-logo-mark"
        fill="none"
        role={markOnly ? "img" : undefined}
        viewBox="0 0 28 28"
      >
        {markOnly && <title>AwardPing</title>}
        <circle cx="14" cy="14" r="12" stroke="currentColor" strokeWidth="2.2" />
        <circle cx="14" cy="14" r="7" opacity="0.45" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="14" cy="14" fill="var(--accent)" r="2.6" />
      </svg>
      {!markOnly && (
        <span className="brand-logo-wordmark">
          Award<span className="brand-logo-wordmark-accent">Ping</span>
        </span>
      )}
    </span>
  );
}
