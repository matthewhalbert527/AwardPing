"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Bell,
  BellOff,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  Plus,
  Search,
  X,
} from "lucide-react";
import { type AwardPageType } from "@/lib/award-discovery-types";
import { sortAwardsForSearch } from "@/lib/award-search";
import { displayAwardSummary } from "@/lib/award-summary";
import { SourcePageTree } from "@/components/source-page-tree";

export type SharedAwardCard = {
  id: string;
  name: string;
  officialHomepage: string | null;
  summary: string | null;
  sourceCount: number | null;
  sourceIssueCount: number | null;
  changeCount: number | null;
  tracked: boolean;
  detailsLoaded?: boolean;
  sources: Array<{
    id: string;
    url: string;
    title: string;
    pageType: AwardPageType;
    tracked?: boolean;
    lastCheckedAt: string | null;
    lastError: string | null;
    latestChanges?: SharedAwardChange[];
  }>;
  changes: SharedAwardChange[];
};

export type SharedAwardChange = {
  id: string;
  sourceTitle: string | null;
  sourceUrl: string;
  sourcePageType: AwardPageType | null;
  summary: string;
  changeDetails?: unknown;
  detectedAt: string;
  previousTextSample?: string | null;
  newTextSample?: string | null;
};

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const pageSizeOptions = [30, 50, 100] as const;

export function AwardDiscoveryWorkspace({
  sharedAwards,
  canManage,
  isAuthenticated,
}: {
  sharedAwards: SharedAwardCard[];
  canManage: boolean;
  isAuthenticated: boolean;
}) {
  const router = useRouter();
  const [awards, setAwards] = useState(sharedAwards);
  const [query, setQuery] = useState("");
  const [selectedAwardId, setSelectedAwardId] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(true);
  const [selectedLetter, setSelectedLetter] = useState("A");
  const [pageSize, setPageSize] = useState<(typeof pageSizeOptions)[number]>(30);
  const [letterPageIndex, setLetterPageIndex] = useState(0);
  const [trackingAwardId, setTrackingAwardId] = useState<string | null>(null);
  const [loadingDetailsId, setLoadingDetailsId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const alphabeticalAwards = useMemo(
    () => sortAwardsAlphabetically(awards),
    [awards],
  );
  const availableLetters = useMemo(
    () => new Set(alphabeticalAwards.map((award) => awardInitial(award.name))),
    [alphabeticalAwards],
  );
  const activeLetter =
    availableLetters.has(selectedLetter)
      ? selectedLetter
      : alphabet.find((letter) => availableLetters.has(letter)) || "#";
  const letterAwards = useMemo(
    () => alphabeticalAwards.filter((award) => awardInitial(award.name) === activeLetter),
    [activeLetter, alphabeticalAwards],
  );
  const letterPageCount = Math.max(1, Math.ceil(letterAwards.length / pageSize));
  const activeLetterPageIndex = Math.min(letterPageIndex, letterPageCount - 1);
  const visibleStart = activeLetterPageIndex * pageSize;
  const visibleLetterAwards = useMemo(
    () => letterAwards.slice(visibleStart, visibleStart + pageSize),
    [letterAwards, pageSize, visibleStart],
  );
  const visibleEnd = visibleStart + visibleLetterAwards.length;

  const matches = useMemo(() => {
    const filter = query.trim();
    if (!filter) {
      return [];
    }

    return sortAwardsForSearch(
      filter,
      alphabeticalAwards,
      (award) => displayAwardSummary(award.summary),
    ).slice(0, 100);
  }, [alphabeticalAwards, query]);
  const searchQuery = query.trim();
  const showSearchResults = searchOpen && searchQuery.length > 0;
  const browseHiddenBySearch = showSearchResults;

  async function trackSharedAward(award: SharedAwardCard) {
    if (!isAuthenticated) return;
    if (!canManage) {
      setMessage("Only office owners and admins can add awards to the watchlist.");
      return;
    }

    setTrackingAwardId(award.id);
    setMessage("");

    const response = await fetch(`/api/shared-awards/${award.id}/track`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cadence: "daily" }),
    });
    const data = await response.json();
    setTrackingAwardId(null);

    if (!response.ok) {
      setMessage(data.error || "Award could not be added to the watchlist.");
      return;
    }

    setMessage(
      data.alreadyTracked
        ? `${award.name} is already on your watchlist.`
        : `${award.name} was added to your watchlist.`,
    );
    setAwards((current) => updateAwardTracking(current, award.id, true));
    router.refresh();
  }

  async function trackSourceSet(
    award: SharedAwardCard,
    sources: SharedAwardCard["sources"],
    label: string,
    actionId: string,
  ) {
    if (!isAuthenticated) return;
    if (!canManage) {
      setMessage("Only office owners and admins can add source pages to the watchlist.");
      return;
    }

    setTrackingAwardId(actionId);
    setMessage("");

    for (const source of sources.filter((source) => !source.tracked)) {
      const response = await fetch(`/api/shared-awards/${award.id}/sources/${source.id}/track`, {
        method: "POST",
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setTrackingAwardId(null);
        setMessage(data.error || `${label} could not be added to the watchlist.`);
        return;
      }
    }

    setTrackingAwardId(null);
    setMessage(`${label} was added to your watchlist.`);
    setAwards((current) =>
      updateAwardTracking(
        current,
        award.id,
        true,
        new Set(sources.map((source) => source.id)),
      ),
    );
    router.refresh();
  }

  async function untrackSourceSet(
    award: SharedAwardCard,
    sources: SharedAwardCard["sources"],
    label: string,
    actionId: string,
  ) {
    if (!isAuthenticated) return;
    if (!canManage) {
      setMessage("Only office owners and admins can remove source pages from the watchlist.");
      return;
    }

    const trackedSources = sources.filter((source) => source.tracked);
    if (trackedSources.length === 0) return;
    if (!confirm(`Remove ${label} from your watchlist?`)) return;

    setTrackingAwardId(actionId);
    setMessage("");

    for (const source of trackedSources) {
      const response = await fetch(`/api/shared-awards/${award.id}/sources/${source.id}/track`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setTrackingAwardId(null);
        setMessage(data.error || `${label} could not be removed from the watchlist.`);
        return;
      }
    }

    setTrackingAwardId(null);
    setMessage(`${label} was removed from your watchlist.`);
    setAwards((current) =>
      updateAwardTracking(
        current,
        award.id,
        false,
        new Set(trackedSources.map((source) => source.id)),
      ),
    );
    router.refresh();
  }

  async function untrackSharedAward(award: SharedAwardCard) {
    if (!isAuthenticated) return;
    if (!canManage) {
      setMessage("Only office owners and admins can remove awards from the watchlist.");
      return;
    }

    if (!confirm(`Remove ${award.name} from your watchlist?`)) return;

    setTrackingAwardId(award.id);
    setMessage("");

    const response = await fetch(`/api/shared-awards/${award.id}/track`, {
      method: "DELETE",
    });
    const data = await response.json();
    setTrackingAwardId(null);

    if (!response.ok) {
      setMessage(data.error || "Award could not be removed from the watchlist.");
      return;
    }

    setMessage(`${award.name} was removed from your watchlist.`);
    setAwards((current) => updateAwardTracking(current, award.id, false));
    router.refresh();
  }

  async function loadAwardDetails(awardId: string) {
    const existing = awards.find((award) => award.id === awardId);
    if (!existing || existing.detailsLoaded || loadingDetailsId === awardId) return;

    setLoadingDetailsId(awardId);
    setMessage("");

    try {
      const response = await fetch(`/api/shared-awards/${awardId}`, {
        headers: { accept: "application/json" },
      });
      const data = await response.json();

      if (!response.ok) {
        setMessage(data.error || "Award details could not be loaded.");
        return;
      }

      setAwards((current) =>
        current.map((award) =>
          award.id === awardId ? { ...award, ...data.award, detailsLoaded: true } : award,
        ),
      );
    } catch {
      setMessage("Award details could not be loaded. Try again.");
    } finally {
      setLoadingDetailsId((current) => (current === awardId ? null : current));
    }
  }

  function selectLetter(letter: string) {
    setSelectedLetter(letter);
    setLetterPageIndex(0);
    setSearchOpen(false);
  }

  function showAwardInBrowse(award: SharedAwardCard) {
    const initial = awardInitial(award.name);
    const awardsForLetter = alphabeticalAwards.filter(
      (candidate) => awardInitial(candidate.name) === initial,
    );
    const awardIndex = Math.max(
      0,
      awardsForLetter.findIndex((candidate) => candidate.id === award.id),
    );

    setSelectedLetter(initial);
    setLetterPageIndex(Math.floor(awardIndex / pageSize));
    setSelectedAwardId(award.id);
    setSearchOpen(false);
    setBrowseOpen(true);
    void loadAwardDetails(award.id);
  }

  function expandVisibleAward(award: SharedAwardCard) {
    setSelectedAwardId(award.id);
    setSearchOpen(false);
    void loadAwardDetails(award.id);
  }

  function renderBrowseControls(position: "top" | "bottom") {
    return (
      <div
        className={
          position === "top"
            ? "min-w-0 max-w-full"
            : "mt-5 min-w-0 max-w-full border-t border-[var(--line)] pt-5"
        }
      >
        <div className="flex min-w-0 max-w-full flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <p className={`${position === "top" ? "mt-1" : ""} text-sm font-semibold text-[var(--muted)]`}>
              Showing {letterAwards.length ? visibleStart + 1 : 0}-{visibleEnd} of{" "}
              {letterAwards.length} awards under {activeLetter}.
            </p>
          </div>

          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <label className="grid gap-1 text-sm font-bold text-[var(--muted)]">
              Awards per page
              <select
                className="input min-w-28 py-2 text-base text-[var(--foreground)]"
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value) as (typeof pageSizeOptions)[number]);
                  setLetterPageIndex(0);
                }}
              >
                {pageSizeOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button-secondary px-3 py-3"
              type="button"
              disabled={activeLetterPageIndex === 0}
              onClick={() => setLetterPageIndex((page) => Math.max(0, page - 1))}
            >
              <ChevronLeft size={17} aria-hidden="true" />
              Previous
            </button>
            <button
              className="button-secondary px-3 py-3"
              type="button"
              disabled={activeLetterPageIndex >= letterPageCount - 1}
              onClick={() =>
                setLetterPageIndex((page) => Math.min(letterPageCount - 1, page + 1))
              }
            >
              Next
              <ChevronRight size={17} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="award-alpha-nav mt-4" aria-label="Alphabetical award pages">
          {alphabet.map((letter) => {
            const enabled = availableLetters.has(letter);
            return (
              <button
                className={`rounded-full border text-sm font-black transition ${
                  activeLetter === letter
                    ? "border-[var(--brand)] bg-[var(--brand-blue-soft)] text-[var(--brand)]"
                    : "border-[var(--line)] bg-white text-[var(--muted)] hover:border-[var(--brand)] hover:text-[var(--brand)]"
                } disabled:cursor-not-allowed disabled:opacity-35`}
                disabled={!enabled}
                key={letter}
                type="button"
                aria-pressed={activeLetter === letter}
                onClick={() => selectLetter(letter)}
              >
                {letter}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      <section className="update-filter-panel">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="dashboard-label">Award database</p>
            <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-[var(--muted)]">
              Search the shared source database first. Browse alphabetically only when you need to explore.
            </p>
          </div>
          <div className="update-feed-stats">
            <span>{awards.length.toLocaleString()} awards</span>
            <span>{availableLetters.size} browse letters</span>
          </div>
        </div>

        <div
          className="relative mt-4"
          onBlur={(event) => {
            if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) {
              setSearchOpen(false);
            }
          }}
        >
          <label className="dashboard-label" htmlFor="award-database-search">
            Search awards
          </label>
          <div className="award-search-control mt-2">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]"
              size={17}
              aria-hidden="true"
            />
            <input
              id="award-database-search"
              className="input input-with-leading-icon award-search-input"
              placeholder="Goldwater, Fulbright, NSF GRFP..."
              value={query}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showSearchResults}
              aria-controls="award-search-results"
              onFocus={() => setSearchOpen(query.trim().length > 0)}
              onChange={(event) => {
                const nextQuery = event.target.value;
                setQuery(nextQuery);
                setSelectedAwardId("");
                setSearchOpen(nextQuery.trim().length > 0);
              }}
            />
          </div>

          {showSearchResults && (
            <div className="award-search-panel">
              <div className="award-search-panel-header">
                <p>
                  {matches.length === 0
                    ? "No matches"
                    : `${matches.length} matching award${matches.length === 1 ? "" : "s"}`}
                </p>
                <button
                  className="award-search-clear"
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setSearchOpen(false);
                  }}
                >
                  <X size={14} aria-hidden="true" />
                  Clear
                </button>
              </div>
              <div
                id="award-search-results"
                className="award-search-results"
                role="listbox"
                aria-label="Matching awards"
                tabIndex={-1}
              >
                {matches.map((award) => (
                  <button
                    className={`award-search-option ${
                      selectedAwardId === award.id ? "award-search-option-active" : ""
                    }`}
                    key={award.id}
                    type="button"
                    role="option"
                    aria-selected={selectedAwardId === award.id}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      setQuery(award.name);
                      showAwardInBrowse(award);
                    }}
                  >
                    <span className="award-search-option-title">{award.name}</span>
                    {searchResultMetaText(award) && (
                      <span className="award-search-option-meta">{searchResultMetaText(award)}</span>
                    )}
                  </button>
                ))}
                {matches.length === 0 && (
                  <p className="award-search-empty">
                    No matching database award yet.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {!browseHiddenBySearch && (
          <div className="mt-4 flex flex-col gap-3 border-t border-[var(--line)] pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="dashboard-label">Alphabetical browse</p>
              <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
                Use the A-Z list when search is not the fastest path.
              </p>
            </div>
            <button
              className="button-secondary"
              type="button"
              onClick={() => setBrowseOpen((current) => !current)}
              aria-expanded={browseOpen}
            >
              {browseOpen ? <ChevronUp size={17} aria-hidden="true" /> : <ChevronDown size={17} aria-hidden="true" />}
              {browseOpen ? "Hide browse" : "Browse all"}
            </button>
          </div>
        )}
      </section>

      {!browseHiddenBySearch && browseOpen && (
        <section className="grid min-w-0 gap-3" aria-label="Browse all awards">
          {renderBrowseControls("top")}

          <div className="grid gap-3">
            {visibleLetterAwards.map((award) => {
              const expanded = selectedAwardId === award.id;

              return (
                <article
                  className={`award-row-card dashboard-list-item text-left transition hover:border-[var(--brand)] ${
                    expanded ? "award-row-card-expanded" : ""
                  }`}
                  key={award.id}
                >
                  <button
                    className="award-row-summary"
                    type="button"
                    onClick={() => {
                      if (expanded) {
                        setSelectedAwardId("");
                        return;
                      }

                      setQuery("");
                      expandVisibleAward(award);
                    }}
                    aria-expanded={expanded}
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <span className="inline-flex min-w-0 items-center gap-2 font-black">
                        {expanded ? (
                          <ChevronUp size={17} aria-hidden="true" />
                        ) : (
                          <ChevronDown size={17} aria-hidden="true" />
                        )}
                        <span>{award.name}</span>
                      </span>
                      <span className="text-xs font-bold text-[var(--muted)]">
                        {sourceStatusText(award)}
                      </span>
                    </div>
                    {!expanded && compactAwardBlurb(award.summary, award.name) && (
                      <p className="award-row-one-line-description mt-2 text-sm leading-6 text-[var(--muted)]">
                        {compactAwardBlurb(award.summary, award.name)}
                      </p>
                    )}
                  </button>

                  {expanded && (
                    <AwardInlineDetails
                      award={award}
                      canManage={canManage}
                      isAuthenticated={isAuthenticated}
                      trackingAwardId={trackingAwardId}
                      detailsLoading={loadingDetailsId === award.id && !award.detailsLoaded}
                      onTrackAward={trackSharedAward}
                      onUntrackAward={untrackSharedAward}
                      onTrackSources={trackSourceSet}
                      onUntrackSources={untrackSourceSet}
                    />
                  )}
                </article>
              );
            })}
          </div>

          {renderBrowseControls("bottom")}
        </section>
      )}
      {message && <p className="text-sm font-semibold">{message}</p>}
    </div>
  );
}

function AwardInlineDetails({
  award,
  canManage,
  isAuthenticated,
  trackingAwardId,
  detailsLoading,
  onTrackAward,
  onUntrackAward,
  onTrackSources,
  onUntrackSources,
}: {
  award: SharedAwardCard;
  canManage: boolean;
  isAuthenticated: boolean;
  trackingAwardId: string | null;
  detailsLoading: boolean;
  onTrackAward: (award: SharedAwardCard) => void;
  onUntrackAward: (award: SharedAwardCard) => void;
  onTrackSources: (
    award: SharedAwardCard,
    sources: SharedAwardCard["sources"],
    label: string,
    actionId: string,
  ) => void;
  onUntrackSources: (
    award: SharedAwardCard,
    sources: SharedAwardCard["sources"],
    label: string,
    actionId: string,
  ) => void;
}) {
  const awardSummary = expandedAwardBlurb(award.summary);

  return (
    <div className="award-inline-details">
      <div className="award-inline-section award-inline-overview">
        <div className="min-w-0">
          <h4 className="award-inline-section-title">Overview</h4>
          {awardSummary && (
            <p className="mt-2 max-w-3xl leading-7 text-[var(--muted)]">{awardSummary}</p>
          )}
          {award.officialHomepage && (
            <a
              className={`${awardSummary ? "mt-3" : ""} inline-flex max-w-full items-center gap-2 truncate text-sm font-bold text-[var(--brand)] underline`}
              href={award.officialHomepage}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={15} aria-hidden="true" />
              <span className="truncate">{award.officialHomepage}</span>
            </a>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-2">
          {!isAuthenticated ? (
            <Link className="button-primary" href="/signup">
              <Bell size={17} aria-hidden="true" />
              Create account for updates
            </Link>
          ) : (
            <button
              className={award.tracked ? "button-secondary" : "button-primary"}
              type="button"
              disabled={!canManage || trackingAwardId === award.id}
              onClick={() => (award.tracked ? onUntrackAward(award) : onTrackAward(award))}
            >
              {award.tracked ? (
                <BellOff size={17} aria-hidden="true" />
              ) : (
                <Plus size={17} aria-hidden="true" />
              )}
              {trackingAwardId === award.id
                ? award.tracked
                  ? "Removing..."
                  : "Adding..."
                : award.tracked
                  ? "Untrack all"
                  : "Track all"}
            </button>
          )}
          {isAuthenticated && (
            <Link className="button-secondary" href={`/dashboard/awards/${award.id}`}>
              Full award page
            </Link>
          )}
        </div>
      </div>

      <div className="award-inline-section">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h4 className="award-inline-section-title">Source pages and latest updates</h4>
            <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
              Expand a source page to see its most recent detected text update. Open the full award
              page for the complete update history.
            </p>
          </div>
        </div>
        <div className="mt-3">
          {detailsLoading ? (
            <p className="rounded-2xl border border-dashed border-[var(--line)] p-4 text-[var(--muted)]">
              Loading source pages...
            </p>
          ) : (
            <SourcePageTree
              sources={award.sources}
              canManage={isAuthenticated && canManage}
              busyId={trackingAwardId}
              getSourceTracked={(source) => Boolean(source.tracked)}
              onTrackSources={(sources, label, actionId) =>
                onTrackSources(award, sources, label, actionId)
              }
              onUntrackSources={(sources, label, actionId) =>
                onUntrackSources(award, sources, label, actionId)
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

function updateAwardTracking(
  awards: SharedAwardCard[],
  awardId: string,
  tracked: boolean,
  sourceIds?: Set<string>,
) {
  return awards.map((award) => {
    if (award.id !== awardId) return award;

    const sources = award.sources.map((source) =>
      !sourceIds || sourceIds.has(source.id) ? { ...source, tracked } : source,
    );
    const nextTracked = tracked || sources.some((source) => source.tracked);

    return {
      ...award,
      tracked: nextTracked,
      sources,
    };
  });
}

function sortAwardsAlphabetically(awards: SharedAwardCard[]) {
  return [...awards].sort((a, b) => {
    return a.name.localeCompare(b.name);
  });
}

function awardInitial(value: string) {
  const initial = value.trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(initial) ? initial : "#";
}

function searchResultMetaText(award: SharedAwardCard) {
  if (award.sourceCount === null) return null;
  return sourceStatusText(award);
}

function sourceStatusText(award: SharedAwardCard) {
  if (award.sourceCount === null) return "Open to view source pages";

  const changeCount = award.changeCount ?? award.changes.length;
  const updates = `${changeCount} recorded update${changeCount === 1 ? "" : "s"}`;
  if (award.sourceCount === 0) return `Source search pending · ${updates}`;

  return [
    `${award.sourceCount} source page${award.sourceCount === 1 ? "" : "s"}`,
    updates,
  ]
    .filter(Boolean)
    .join(" · ");
}

function compactAwardBlurb(summary: string | null, awardName: string) {
  const clean = displayAwardSummary(summary);
  if (!clean) return null;

  const firstSentence = firstMeaningfulSentence(clean) || clean;
  return singleLineAwardSentence(firstSentence, awardName);
}

function expandedAwardBlurb(summary: string | null) {
  return boundedAwardBlurb(summary, 560);
}

function boundedAwardBlurb(summary: string | null, maxLength: number) {
  const clean = displayAwardSummary(summary);
  if (!clean) return null;

  const firstSentence = firstMeaningfulSentence(clean);
  const value = maxLength <= 180 && firstSentence ? firstSentence : clean;
  return truncateAtWord(value, maxLength);
}

function firstMeaningfulSentence(value: string) {
  return (
    value
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .find((sentence) => sentence.length >= 35) || null
  );
}

function singleLineAwardSentence(value: string, awardName: string) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return null;

  const normalizedName = awardName.replace(/\s+/g, " ").trim();
  const withoutParenthetical = clean.replace(/\s*\([^)]{2,80}\)\s*/g, " ");
  const sentence = withoutParenthetical.replace(/\s+/g, " ").trim();
  if (sentence.length <= 145) return ensureSentencePunctuation(sentence);

  const leadMatch = sentence.match(
    /^(The\s+)?(.+?)\s+(provides?|offers?|supports?|funds?|awards?|gives?|recognizes?|honors?|helps?|enables?)\s+(.+?)(?:\s+(?:for|to|that|who|from|through|including|matching|with)\b|,|;|$)/i,
  );
  if (leadMatch) {
    const subject = leadMatch[2]?.length > 58 ? normalizedName : `${leadMatch[1] || ""}${leadMatch[2]}`.trim();
    const verb = leadMatch[3]?.toLowerCase() || "supports";
    const object = leadMatch[4]?.trim() || "applicants";
    const concise = `${subject} ${verb} ${object}`;
    if (concise.length <= 145) return ensureSentencePunctuation(concise);
  }

  const boundary = sentence.slice(0, 146).search(/\s(?:for|to|that|who|from|through|including|matching|with)\b/i);
  if (boundary > 65) return ensureSentencePunctuation(sentence.slice(0, boundary).trim());

  const words = sentence.split(/\s+/);
  const limited = words.reduce((acc, word) => {
    const next = acc ? `${acc} ${word}` : word;
    return next.length <= 135 ? next : acc;
  }, "");

  return ensureSentencePunctuation(limited || sentence.slice(0, 135).trim());
}

function ensureSentencePunctuation(value: string) {
  const clean = value.replace(/\s+/g, " ").replace(/[,:;-\s]+$/g, "").trim();
  if (!clean) return null;
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function truncateAtWord(value: string, maxLength: number) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;

  const truncated = clean.slice(0, maxLength + 1);
  const boundary = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, boundary > 80 ? boundary : maxLength).trim()}...`;
}
