import { BrandLogo } from "@/components/brand-logo";

/** A static shell only: no session, award facts, counts or publication claims. */
export function PublicPageLoading({
  title = "AwardPing",
  status = "Loading…",
}: {
  title?: string;
  status?: string;
}) {
  return (
    <div className="page-shell">
      <header className="app-header">
        <div className="app-header-shell">
          <div className="app-header-bar">
            <div className="brand-link app-header-brand" aria-label="AwardPing">
              <BrandLogo />
            </div>
            <div className="app-header-loading-pill" aria-hidden="true" />
          </div>
        </div>
      </header>
      <main className="public-updates-main" aria-busy="true">
        <div className="public-page-heading">
          <div>
            <h1 className="display-title">{title}</h1>
            <p role="status">{status}</p>
          </div>
        </div>
        <div className="award-directory-loading-grid" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
      </main>
    </div>
  );
}
