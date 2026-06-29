import Link from "next/link";
import { BellRing, Inbox, ListChecks, SearchCheck, Sparkles } from "lucide-react";

export type DashboardSection = "database" | "watchlist";
export type DashboardSectionView = "awards" | "updates" | "request";

type Props = {
  section: DashboardSection;
  activeView: DashboardSectionView;
  databaseCount?: number;
  watchlistCount?: number;
};

const sectionCopy = {
  database: {
    eyebrow: "Award Directory",
    title: "Award directory",
    copy: "Search every shared award source and review changes across the full directory.",
    icon: SearchCheck,
  },
  watchlist: {
    eyebrow: "Watchlist",
    title: "Your watchlist",
    copy: "Manage the awards your office tracks and review updates from those exact sources.",
    icon: ListChecks,
  },
} satisfies Record<DashboardSection, {
  eyebrow: string;
  title: string;
  copy: string;
  icon: typeof SearchCheck;
}>;

export function DashboardSectionCard({
  section,
  activeView,
  databaseCount,
  watchlistCount,
}: Props) {
  const content = sectionCopy[section];
  const SectionIcon = content.icon;

  return (
    <section className="dashboard-section-card" aria-label={`${content.eyebrow} workspace`}>
      <div className="dashboard-section-main">
        <span className="dashboard-section-icon">
          <SectionIcon size={20} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="dashboard-label">{content.eyebrow}</p>
          <h1 className="dashboard-section-title">{content.title}</h1>
          <p className="dashboard-section-copy">{content.copy}</p>
        </div>
      </div>

      <div className="dashboard-section-controls">
        <nav className="dashboard-section-tabs" aria-label={`${content.eyebrow} views`}>
          <Link
            className={activeView === "awards" ? "dashboard-section-tab-active" : ""}
            href={section === "database" ? "/dashboard/awards" : "/dashboard/awards?view=watchlist"}
          >
            <SearchCheck size={16} aria-hidden="true" />
            Awards
          </Link>
          <Link
            className={activeView === "updates" ? "dashboard-section-tab-active" : ""}
            href={section === "database" ? "/dashboard?scope=all" : "/dashboard"}
          >
            <Inbox size={16} aria-hidden="true" />
            Updates
          </Link>
        </nav>

        {section === "database" ? (
          <Link
            className={`dashboard-section-action dashboard-section-action-source ${
              activeView === "request" ? "dashboard-section-action-active" : ""
            }`}
            href="/dashboard/awards?view=request"
          >
            <Sparkles size={16} aria-hidden="true" />
            Request source
          </Link>
        ) : (
          <Link
            className="dashboard-section-action dashboard-section-action-subscribe"
            href="/dashboard/office#notification-preferences"
          >
            <BellRing size={16} aria-hidden="true" />
            Subscribe to watchlist
          </Link>
        )}
      </div>

      <div className="dashboard-section-stats" aria-label="Workspace counts">
        {typeof databaseCount === "number" && (
          <span>{databaseCount.toLocaleString()} directory</span>
        )}
        {typeof watchlistCount === "number" && (
          <span>{watchlistCount.toLocaleString()} watchlist</span>
        )}
      </div>
    </section>
  );
}
