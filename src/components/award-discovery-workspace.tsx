"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  Search,
  X,
} from "lucide-react";
import { type AwardPageType } from "@/lib/award-discovery-types";
import { dashboardAwardPath } from "@/lib/award-slugs";
import { sortAwardsForSearch } from "@/lib/award-search";
import { compactAwardDirectorySummary } from "@/lib/award-summary";

export type SharedAwardCard = {
  id: string;
  name: string;
  slug: string | null;
  publicPath: string;
  officialHomepage: string | null;
  summary: string | null;
  deadline: string | null;
  academicLevels: string[];
  disciplines: string[];
  citizenship: string[];
  lastCheckedAt: string | null;
  recentlyUpdated: boolean;
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
};

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const pageSizeOptions = [30, 50, 100] as const;

export function AwardDiscoveryWorkspace({
  sharedAwards,
  isAuthenticated,
}: {
  sharedAwards: SharedAwardCard[];
  canManage: boolean;
  isAuthenticated: boolean;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(true);
  const [selectedLetter, setSelectedLetter] = useState("A");
  const [pageSize, setPageSize] = useState<(typeof pageSizeOptions)[number]>(30);
  const [letterPageIndex, setLetterPageIndex] = useState(0);
  const [levelFilter, setLevelFilter] = useState("all");
  const [disciplineFilter, setDisciplineFilter] = useState("all");
  const [citizenshipFilter, setCitizenshipFilter] = useState("all");
  const [deadlineFilter, setDeadlineFilter] = useState("all");
  const [recentFilter, setRecentFilter] = useState("all");

  const levelOptions = useMemo(
    () => uniqueOptions(sharedAwards.flatMap((award) => award.academicLevels)),
    [sharedAwards],
  );
  const disciplineOptions = useMemo(
    () => uniqueOptions(sharedAwards.flatMap((award) => award.disciplines)),
    [sharedAwards],
  );
  const citizenshipOptions = useMemo(
    () => uniqueOptions(sharedAwards.flatMap((award) => award.citizenship)),
    [sharedAwards],
  );
  const awards = useMemo(
    () =>
      sharedAwards.filter((award) => {
        if (levelFilter !== "all" && !award.academicLevels.includes(levelFilter)) return false;
        if (disciplineFilter !== "all" && !award.disciplines.includes(disciplineFilter)) return false;
        if (citizenshipFilter !== "all" && !award.citizenship.includes(citizenshipFilter)) return false;
        if (deadlineFilter === "listed" && !award.deadline) return false;
        if (deadlineFilter === "missing" && award.deadline) return false;
        if (recentFilter === "recent" && !award.recentlyUpdated) return false;
        return true;
      }),
    [
      citizenshipFilter,
      deadlineFilter,
      disciplineFilter,
      levelFilter,
      recentFilter,
      sharedAwards,
    ],
  );

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
      (award) => award.summary,
    ).slice(0, 100);
  }, [alphabeticalAwards, query]);
  const searchQuery = query.trim();
  const showSearchResults = searchOpen && searchQuery.length > 0;
  const browseHiddenBySearch = showSearchResults;

  function selectLetter(letter: string) {
    setSelectedLetter(letter);
    setLetterPageIndex(0);
    setSearchOpen(false);
  }

  function awardHref(award: SharedAwardCard) {
    return isAuthenticated ? dashboardAwardPath(award.slug, award.name, award.id) : award.publicPath;
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
            <span>{awards.length.toLocaleString()} shown</span>
            <span>{sharedAwards.length.toLocaleString()} total</span>
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
                  <Link
                    className="award-search-option"
                    href={awardHref(award)}
                    key={award.id}
                    role="option"
                    aria-selected={false}
                    onClick={() => setSearchOpen(false)}
                  >
                    <span className="award-search-option-title">{award.name}</span>
                    {searchResultMetaText(award) && (
                      <span className="award-search-option-meta">{searchResultMetaText(award)}</span>
                    )}
                  </Link>
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

        <div className="award-directory-filter-grid">
          <label>
            <span>Academic level</span>
            <select
              className="input"
              value={levelFilter}
              onChange={(event) => {
                setLevelFilter(event.target.value);
                setLetterPageIndex(0);
              }}
            >
              <option value="all">All levels</option>
              {levelOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Discipline</span>
            <select
              className="input"
              value={disciplineFilter}
              onChange={(event) => {
                setDisciplineFilter(event.target.value);
                setLetterPageIndex(0);
              }}
            >
              <option value="all">All disciplines</option>
              {disciplineOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Citizenship</span>
            <select
              className="input"
              value={citizenshipFilter}
              onChange={(event) => {
                setCitizenshipFilter(event.target.value);
                setLetterPageIndex(0);
              }}
            >
              <option value="all">All citizenship</option>
              {citizenshipOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Deadline</span>
            <select
              className="input"
              value={deadlineFilter}
              onChange={(event) => {
                setDeadlineFilter(event.target.value);
                setLetterPageIndex(0);
              }}
            >
              <option value="all">Any deadline</option>
              <option value="listed">Deadline listed</option>
              <option value="missing">Deadline pending</option>
            </select>
          </label>
          <label>
            <span>Updates</span>
            <select
              className="input"
              value={recentFilter}
              onChange={(event) => {
                setRecentFilter(event.target.value);
                setLetterPageIndex(0);
              }}
            >
              <option value="all">All awards</option>
              <option value="recent">Recently updated</option>
            </select>
          </label>
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
            {visibleLetterAwards.map((award) => (
              <article
                className="award-row-card dashboard-list-item text-left transition hover:border-[var(--brand)]"
                key={award.id}
              >
                <Link className="award-row-summary block" href={awardHref(award)}>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <span className="inline-flex min-w-0 items-center gap-2 font-black">
                      <span>{award.name}</span>
                      <ChevronRight size={17} aria-hidden="true" />
                    </span>
                    <span className="text-xs font-bold text-[var(--muted)]">
                      {sourceStatusText(award)}
                    </span>
                  </div>
                  {compactAwardBlurb(award.summary, award.name) && (
                    <p className="award-row-one-line-description mt-2 text-sm leading-6 text-[var(--muted)]">
                      {compactAwardBlurb(award.summary, award.name)}
                    </p>
                  )}
                  <div className="award-directory-row-meta">
                    {award.deadline && <span>Deadline: {award.deadline}</span>}
                    {award.academicLevels.slice(0, 2).map((level) => (
                      <span key={level}>{level}</span>
                    ))}
                    {award.citizenship.slice(0, 1).map((citizenship) => (
                      <span key={citizenship}>{citizenship}</span>
                    ))}
                  </div>
                </Link>
                {isAuthenticated && (
                  <div className="award-row-actions">
                    <Link className="button-secondary px-3 py-2 text-sm" href={award.publicPath}>
                      Public page
                      <ExternalLink size={14} aria-hidden="true" />
                    </Link>
                  </div>
                )}
              </article>
            ))}
          </div>

          {renderBrowseControls("bottom")}
        </section>
      )}
    </div>
  );
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
  return compactAwardDirectorySummary(summary, awardName);
}

function uniqueOptions(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}
