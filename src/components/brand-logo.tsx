type BrandLogoProps = {
  className?: string;
  markOnly?: boolean;
};

export function BrandLogo({ className = "", markOnly = false }: BrandLogoProps) {
  return (
    <span className={`brand-logo ${markOnly ? "brand-logo-mark-only" : ""} ${className}`}>
      <picture>
        {/* Dark-background variant; generated from the primary asset. The
            data-theme override has no UI yet, so the OS preference decides. */}
        <source srcSet="/awardping-logo-dark.png" media="(prefers-color-scheme: dark)" />
        <img
          className="brand-logo-image"
          src="/awardping-logo.png"
          alt="AwardPing"
          decoding="async"
        />
      </picture>
    </span>
  );
}
