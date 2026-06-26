"use client";

import { useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { ChangeEvidencePanel } from "@/components/change-evidence-panel";
import { ChangeSummaryDisplay } from "@/components/change-summary-display";
import { awardPageTypes, pageTypeLabel, type AwardPageType } from "@/lib/award-discovery-types";
import { dashboardAwardPath } from "@/lib/award-slugs";
import { changeDetailsSearchText } from "@/lib/change-details";
import { readableSourceTitle } from "@/lib/display-text";

export type UpdateFeedRow = {
  id: string;
  changeId?: string | null;
  awardId: string | null;
  awardSlug?: string | null;
  sourceId?: string | null;
  title: string;
  sourceTitle: string;
  sourceUrl: string | null;
  sourcePageType: AwardPageType | null;
  summary: string;
  changeDetails?: unknown;
  detectedAt: string;
  kind: "shared" | "office";
  inWatchlist: boolean;
  unread?: boolean;
};

type ScopeFilter = "watchlist" | "all";
type SortFilter = "newest" | "oldest" | "award";
type TimeFilter = "7d" | "30d" | "90d" | "all";

const defaultFilters = {
  scope: "watchlist" as ScopeFilter,
  sort: "newest" as SortFilter,
  time: "30d" as TimeFilter,
  type: "all",
  q: "",
};
type FilterKey = keyof typeof defaultFilters;

type AppliedFilter = {
  key: FilterKey;
  label: string;
  value: string;
};

export function UpdateFeedWorkspace({
  rows,
  scope,
}: {
  rows: UpdateFeedRow[];
  scope?: ScopeFilter;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const filters = { ...readFilters(searchParams), ...(scope ? { scope } : {}) };
  const appliedFilters = appliedFilterChips(filters).filter(
    (filter) => !scope || filter.key !== "scope",
  );
  const hasActiveFilters = appliedFilters.length > 0;

  function replaceParams(params: URLSearchParams) {
    startTransition(() => {
      router.replace(`${pathname}${params.toString() ? `?${params.toString()}` : ""}`, {
        scroll: false,
      });
    });
  }

  function setFilter(key: FilterKey, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    const defaultValue = String(defaultFilters[key] || "");

    if (value === "" || value === defaultValue) {
      params.delete(key);
    } else {
      params.set(key, value);
    }

    replaceParams(params);
  }

  function clearAllFilters() {
    replaceParams(new URLSearchParams());
  }

  const filteredRows = filterRows(rows, filters);
  const watchlistCount = rows.filter((row) => row.inWatchlist).length;

  return (
    <div className="grid gap-5">
      <section className={`update-filter-panel ${isPending ? "update-filter-panel-pending" : ""}`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="dashboard-label">{filters.scope === "all" ? "Database updates" : "Watchlist updates"}</p>
            <p className="dashboard-panel-copy">
              {filters.scope === "all"
                ? "Changes from the shared award database."
                : "Changes from awards and source pages on your watchlist."}
            </p>
          </div>
          <div className="update-feed-stats">
            <span>{filteredRows.length} shown</span>
            <span>{watchlistCount} watchlist</span>
          </div>
        </div>

        <div className="update-filter-grid mt-4 update-filter-grid-primary">
          <label className="update-search-field">
            <span>Search updates</span>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]"
                size={17}
                aria-hidden="true"
              />
              <input
                className="input input-with-leading-icon"
                placeholder="Award, source, URL, or update text"
                value={filters.q}
                onChange={(event) => setFilter("q", event.target.value)}
              />
            </div>
          </label>
          <label>
            <span>Type</span>
            <select
              className="input"
              value={filters.type}
              onChange={(event) => setFilter("type", event.target.value)}
            >
              <option value="all">All source types</option>
              {awardPageTypes.map((type) => (
                <option key={type} value={type}>
                  {pageTypeLabel(type)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Time</span>
            <select
              className="input"
              value={filters.time}
              onChange={(event) => setFilter("time", event.target.value)}
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
              <option value="all">All time</option>
            </select>
          </label>
          <label>
            <span>Sort</span>
            <select
              className="input"
              value={filters.sort}
              onChange={(event) => setFilter("sort", event.target.value)}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="award">Award A-Z</option>
            </select>
          </label>
        </div>

        {hasActiveFilters && (
          <div className="update-filter-chips" aria-label="Applied filters">
            {appliedFilters.map((filter) => (
              <button
                className="update-filter-chip"
                key={filter.key}
                type="button"
                onClick={() => setFilter(filter.key, "")}
                title={`Remove ${filter.label} filter`}
              >
                <span>{filter.label}: {filter.value}</span>
                <X size={14} aria-hidden="true" />
              </button>
            ))}
            <button className="update-filter-clear" type="button" onClick={clearAllFilters}>
              Clear all
            </button>
          </div>
        )}
      </section>

      <section className="grid gap-3">
        {filteredRows.map((change) => (
          <article className={`update-feed-card ${change.unread ? "update-feed-card-unread" : ""}`} key={change.id}>
            <div className="update-feed-card-meta">
              {change.unread && <span className="update-feed-unread-pill">Unread</span>}
              <span>{formatDate(change.detectedAt)}</span>
              <span>{change.kind === "shared" ? "Shared" : "Office"}</span>
              {change.sourcePageType && <span>{pageTypeLabel(change.sourcePageType)}</span>}
            </div>

            <div className="update-feed-card-body">
              <div className="min-w-0">
                <h2 className="update-feed-card-title">{change.title}</h2>
                <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
                  {readableSourceTitle(change.sourceTitle, change.sourceUrl)}
                </p>
                <ChangeSummaryDisplay
                  summary={change.summary}
                  sourceUrl={change.sourceUrl}
                  sourceTitle={change.sourceTitle}
                  changeDetails={change.changeDetails}
                />
                <ChangeEvidencePanel
                  compact
                  sourceId={change.sourceId}
                  sourceUrl={change.sourceUrl}
                  sourceTitle={change.sourceTitle}
                  sourcePageTypeLabel={change.sourcePageType ? pageTypeLabel(change.sourcePageType) : null}
                  summary={change.summary}
                  changeDetails={change.changeDetails}
                  detectedAt={change.detectedAt}
                />
              </div>
              {change.awardId && (
                <Link className="button-secondary self-start whitespace-nowrap" href={awardUpdateHref(change)}>
                  Award page
                </Link>
              )}
            </div>

          </article>
        ))}

        {filteredRows.length === 0 && (
          <div className="dashboard-panel dashboard-panel-pad text-[var(--muted)]">
            No updates match these filters.
          </div>
        )}
      </section>
    </div>
  );
}

function awardUpdateHref(change: UpdateFeedRow) {
  if (!change.awardId) return "/dashboard";
  const params = new URLSearchParams();
  if (change.sourceId) params.set("source", change.sourceId);
  if (change.changeId) params.set("change", change.changeId);
  const query = params.toString();
  return `${dashboardAwardPath(change.awardSlug, change.title, change.awardId)}${query ? `?${query}` : ""}`;
}

function readFilters(searchParams: URLSearchParams) {
  return {
    scope: readEnum(searchParams.get("scope"), ["watchlist", "all"], defaultFilters.scope),
    sort: readEnum(searchParams.get("sort"), ["newest", "oldest", "award"], defaultFilters.sort),
    time: readEnum(searchParams.get("time"), ["7d", "30d", "90d", "all"], defaultFilters.time),
    type: readEnum(searchParams.get("type"), ["all", ...awardPageTypes], defaultFilters.type),
    q: searchParams.get("q") || "",
  };
}

function appliedFilterChips(filters: ReturnType<typeof readFilters>): AppliedFilter[] {
  const chips: AppliedFilter[] = [];

  if (filters.scope !== defaultFilters.scope) {
    chips.push({ key: "scope", label: "Scope", value: filters.scope === "all" ? "All updates" : "Watchlist" });
  }
  if (filters.q.trim()) {
    chips.push({ key: "q", label: "Search", value: filters.q.trim() });
  }
  if (filters.type !== defaultFilters.type) {
    chips.push({ key: "type", label: "Type", value: pageTypeLabel(filters.type as AwardPageType) });
  }
  if (filters.time !== defaultFilters.time) {
    chips.push({ key: "time", label: "Time", value: timeFilterLabel(filters.time) });
  }
  if (filters.sort !== defaultFilters.sort) {
    chips.push({ key: "sort", label: "Sort", value: sortFilterLabel(filters.sort) });
  }
  return chips;
}

function readEnum<T extends string>(value: string | null, allowed: readonly T[], fallback: T) {
  return value && allowed.includes(value as T) ? (value as T) : fallback;
}

function filterRows(rows: UpdateFeedRow[], filters: ReturnType<typeof readFilters>) {
  const query = filters.q.trim().toLowerCase();
  const cutoff = cutoffDate(filters.time);

  return rows
    .filter((row) => filters.scope === "all" || row.inWatchlist)
    .filter((row) => filters.type === "all" || row.sourcePageType === filters.type)
    .filter((row) => !cutoff || new Date(row.detectedAt).getTime() >= cutoff)
    .filter((row) => {
      if (!query) return true;
      return [row.title, row.sourceTitle, row.sourceUrl, row.summary, changeDetailsSearchText(row.changeDetails)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .sort((a, b) => {
      if (filters.sort === "award") {
        return a.title.localeCompare(b.title) || new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime();
      }

      const diff = new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime();
      return filters.sort === "oldest" ? -diff : diff;
    });
}

function cutoffDate(time: TimeFilter) {
  if (time === "all") return null;
  const days = Number(time.replace("d", ""));
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function timeFilterLabel(value: TimeFilter) {
  if (value === "7d") return "Last 7 days";
  if (value === "30d") return "Last 30 days";
  if (value === "90d") return "Last 90 days";
  return "All time";
}

function sortFilterLabel(value: SortFilter) {
  if (value === "oldest") return "Oldest first";
  if (value === "award") return "Award A-Z";
  return "Newest first";
}
