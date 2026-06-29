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
      <main className="mx-auto max-w-6xl px-5 py-10 lg:py-12">
        <div className="award-directory-loading">
          <div>
            <p className="dashboard-label">Award directory</p>
            <h1>Loading award directory</h1>
            <p>Preparing searchable fellowship records.</p>
          </div>
          <div className="award-directory-loading-grid" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
      </main>
    </div>
  );
}
