type BrandLogoProps = {
  className?: string;
  markOnly?: boolean;
};

export function BrandLogo({ className = "", markOnly = false }: BrandLogoProps) {
  return (
    <span className={`brand-logo ${markOnly ? "brand-logo-mark-only" : ""} ${className}`}>
      <img
        className="brand-logo-image"
        src="/awardping-logo.png"
        alt="AwardPing"
        decoding="async"
      />
    </span>
  );
}
