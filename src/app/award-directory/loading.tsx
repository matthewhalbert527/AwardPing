import { BrandLogo } from "@/components/brand-logo";

export default function AwardDirectoryLoading() {
  return (
    <div className="page-shell">
      <header className="app-header">
        <div className="app-header-shell">
          <div className="app-header-bar">
            <div className="brand-link app-header-brand" aria-label="AwardPing">
              <BrandLogo />
            </div>
            <div className="app-header-loading-pill" />
          </div>
        </div>
      </header>
      <main className="public-directory-main" aria-busy="true">
        <div className="public-directory-heading">
          <div>
            <h1 className="display-title">Award directory</h1>
            <p role="status">Loading awards…</p>
          </div>
        </div>
        <div className="award-directory-loading-grid" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      </main>
    </div>
  );
}
