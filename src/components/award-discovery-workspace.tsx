"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Search,
  X,
} from "lucide-react";
import { presentAwardDateField } from "@/lib/award-date-presentation";
import { type AwardPageType } from "@/lib/award-discovery-types";
import { sortAwardsForSearch } from "@/lib/award-search";
import { compactAwardDirectorySummary } from "@/lib/award-summary";
import { AwardCardGlance } from "@/components/award-card-glance";
import { AwardDateValue } from "@/components/award-date-value";
import styles from "./award-discovery-workspace.module.css";

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
  latestUpdateAt?: string | null;
  firstPublishedCaptureAt?: string | null;
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

// The directory has one award destination for every visitor, the canonical
// public award page; sign-in state never chooses a different path.
export function awardDirectoryHref(award: Pick<SharedAwardCard, "publicPath">) {
  return award.publicPath;
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const pageSizeOptions = [30, 50, 100] as const;
const searchResultLimit = 100;

// `canManage` and `isAuthenticated` stay in the prop contract for the
// directory page, but neither affects what the directory renders or where
// an award links.
export function AwardDiscoveryWorkspace({
  sharedAwards,
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const alphabetNavRef = useRef<HTMLDivElement>(null);
  const hasActiveFilters = [levelFilter, disciplineFilter, citizenshipFilter, deadlineFilter, recentFilter]
    .some((filter) => filter !== "all");

  function resetFilters() {
    // The reset button disappears when filters clear. Keep keyboard focus on
    // a stable control, preserving the query and reopening its results.
    searchInputRef.current?.focus();
    setLevelFilter("all");
    setDisciplineFilter("all");
    setCitizenshipFilter("all");
    setDeadlineFilter("all");
    setRecentFilter("all");
    setLetterPageIndex(0);
  }

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
  const nextLetter = alphabet.find((letter) => letter > activeLetter && availableLetters.has(letter));
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

  // Every ranked match, computed once over the filtered catalog. The panel
  // lists the first `searchResultLimit`; the status always counts the whole set.
  const allMatches = useMemo(() => {
    const filter = query.trim();
    if (!filter) {
      return [];
    }

    return sortAwardsForSearch(
      filter,
      alphabeticalAwards,
      (award) => award.summary,
    );
  }, [alphabeticalAwards, query]);
  const matches = useMemo(() => allMatches.slice(0, searchResultLimit), [allMatches]);
  const searchQuery = query.trim();
  const showSearchResults = searchOpen && searchQuery.length > 0;
  const browseHiddenBySearch = showSearchResults;

  function selectLetter(letter: string) {
    setSelectedLetter(letter);
    setLetterPageIndex(0);
    setSearchOpen(false);
  }

  function renderBrowseControls(position: "top" | "bottom") {
    if (position === "top") {
      return (
        <div className="min-w-0 max-w-full">
          <div ref={alphabetNavRef} tabIndex={-1} role="group" className="award-alpha-nav scroll-mt-40" aria-label="Alphabetical award pages" aria-describedby="award-letter-page-status">
            {alphabet.map((letter) => {
              const enabled = availableLetters.has(letter);
              return (
                <button
                  className={`award-alpha-letter ${activeLetter === letter ? "award-alpha-letter-active" : ""}`}
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
          <p id="award-letter-page-status" role="status" className="mt-3 text-sm font-medium text-[var(--text-tertiary)]">
            Showing {letterAwards.length ? visibleStart + 1 : 0}-{visibleEnd} of{" "}
            {letterAwards.length} awards under {activeLetter}.
          </p>
        </div>
      );
    }

    return (
      <div className="mt-2 min-w-0 max-w-full border-t border-[var(--border-subtle)] pt-4">
        <div className="flex min-w-0 max-w-full flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <p className="text-sm font-medium text-[var(--text-tertiary)]">
            Showing {letterAwards.length ? visibleStart + 1 : 0}-{visibleEnd} of{" "}
            {letterAwards.length} awards under {activeLetter}.
          </p>

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
            {letterPageCount > 1 && <button
              className="button-secondary cursor-pointer px-3 py-3 disabled:cursor-default disabled:opacity-40"
              type="button"
              aria-label={`Previous page of ${activeLetter} awards`}
              disabled={activeLetterPageIndex === 0}
              onClick={() => setLetterPageIndex((page) => Math.max(0, page - 1))}
            >
              <ChevronLeft size={17} aria-hidden="true" />
              Previous
            </button>}
            {letterPageCount > 1 && <button
              className="button-secondary cursor-pointer px-3 py-3 disabled:cursor-default disabled:opacity-40"
              type="button"
              aria-label={`Next page of ${activeLetter} awards`}
              disabled={activeLetterPageIndex >= letterPageCount - 1}
              onClick={() =>
                setLetterPageIndex((page) => Math.min(letterPageCount - 1, page + 1))
              }
            >
              Next
              <ChevronRight size={17} aria-hidden="true" />
            </button>}
            <button
              className="button-secondary cursor-pointer px-3 py-3 disabled:cursor-default disabled:opacity-40"
              type="button"
              disabled={!nextLetter}
              title={!nextLetter ? "You are at the last available letter." : undefined}
              onClick={() => {
                if (!nextLetter) return;
                selectLetter(nextLetter);
                alphabetNavRef.current?.focus({ preventScroll: true });
                alphabetNavRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
              }}
            >
              {nextLetter ? `Next letter: ${nextLetter}` : "Next letter"}
              <ChevronRight size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      <section className="award-directory-controls">
        <div
          className="relative"
          onBlur={(event) => {
            if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) {
              setSearchOpen(false);
            }
          }}
        >
          <label className="sr-only" htmlFor="award-directory-search">
            Search awards
          </label>
          <div className="award-search-control">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]"
              size={17}
              aria-hidden="true"
            />
            {/* A plain search field: the results below are ordinary links with
                no keyboard-driven selection, so no combobox is claimed. */}
            <input
              id="award-directory-search"
              ref={searchInputRef}
              className="input input-with-leading-icon award-search-input"
              type="search"
              placeholder="Goldwater, Fulbright, NSF GRFP..."
              value={query}
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
                <p role="status">{searchStatusText(allMatches.length, matches.length)}</p>
                <button
                  className="award-search-clear"
                  type="button"
                  onClick={() => {
                    // Focus first: the field's own onFocus runs synchronously
                    // with the old query and may queue an open; the resets
                    // below are queued after it, so the results end closed
                    // and the blank field is ready for the next search.
                    searchInputRef.current?.focus();
                    setQuery("");
                    setSearchOpen(false);
                  }}
                >
                  <X size={14} aria-hidden="true" />
                  Clear
                </button>
              </div>
              <div className="award-search-results">
                {matches.map((award) => (
                  <Link
                    className="award-search-option"
                    href={awardDirectoryHref(award)}
                    key={award.id}
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
                    No matching award yet.
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
              <option value="missing">Deadline not listed</option>
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
              {/* The predicate is "has at least one recorded public update";
                  the label states that and promises no recency. */}
              <option value="recent">Has recorded updates</option>
            </select>
          </label>
        </div>

        {hasActiveFilters && (
          <div className="mt-3 flex justify-end">
            <button className="button-secondary" type="button" onClick={resetFilters}>
              Reset filters
            </button>
          </div>
        )}

        {!browseHiddenBySearch && awards.length > 0 && (
          <div className="mt-5 flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium text-[var(--text-tertiary)]">
              {awards.length.toLocaleString()} of {sharedAwards.length.toLocaleString()} monitored awards match.
            </p>
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

      {!browseHiddenBySearch && awards.length === 0 && (
        <section className="panel p-5 text-sm text-[var(--muted)]" role="status">
          <p className="font-bold text-[var(--foreground)]">
            {hasActiveFilters ? "No awards match these filters." : "No awards are listed here right now."}
          </p>
          {hasActiveFilters && <p className="mt-2">Reset the filters to browse the full directory.</p>}
        </section>
      )}

      {!browseHiddenBySearch && browseOpen && awards.length > 0 && (
        <section className="grid min-w-0 gap-3" aria-label="Browse all awards">
          {renderBrowseControls("top")}

          <div className="grid gap-3">
            {visibleLetterAwards.map((award) => {
              const deadline = presentAwardDateField(award.deadline, award.name);
              return (
                <article
                  className="award-row-card dashboard-list-item text-left transition hover:border-[var(--brand)]"
                  key={award.id}
                >
                  <Link className="award-row-summary block" href={awardDirectoryHref(award)}>
                    <div className={`award-row-grid ${styles.rowGrid}`}>
                      <div className="min-w-0">
                        <span className="inline-flex min-w-0 items-center gap-2 font-bold">
                          <span>{award.name}</span>
                          <ChevronRight size={17} aria-hidden="true" />
                        </span>
                        {compactAwardBlurb(award.summary, award.name) && (
                          <p className="award-row-one-line-description mt-2 text-sm leading-6 text-[var(--muted)]">
                            {compactAwardBlurb(award.summary, award.name)}
                          </p>
                        )}
                        <AwardCardGlance
                          academicLevels={award.academicLevels}
                          citizenship={award.citizenship}
                          changeCount={award.changeCount}
                          latestUpdateAt={award.latestUpdateAt}
                          firstPublishedCaptureAt={award.firstPublishedCaptureAt}
                        />
                      </div>
                      <div className="award-row-deadline">
                        <span>{deadline.label}</span>
                        {/* A blank value means no deadline is listed here; it says
                            nothing about whether one is upcoming. A listed value
                            keeps its meaning; a recognized program scope goes
                            in the label rather than beside the date. */}
                        <strong>{deadline.value ? <AwardDateValue value={deadline.value} /> : "Not listed"}</strong>
                      </div>
                    </div>
                  </Link>
                </article>
              );
            })}
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

// "Showing 100 of 101 matching awards" only when the list is capped; otherwise
// the plain count, so an uncapped search reads exactly as before.
function searchStatusText(total: number, shown: number) {
  if (total === 0) return "No matches";
  const awards = `matching award${total === 1 ? "" : "s"}`;
  return shown < total ? `Showing ${shown} of ${total} ${awards}` : `${total} ${awards}`;
}

function searchResultMetaText(award: SharedAwardCard) {
  if (award.sourceCount === null) return null;
  return sourceStatusText(award);
}

function sourceStatusText(award: SharedAwardCard) {
  if (award.sourceCount === null) {
    // The directory carries each award's recorded public update count but
    // not its source pages, so the count is stated and the source guidance
    // stays. A row without a recorded count states nothing about updates.
    const updates = award.changeCount === null ? null : recordedUpdatesText(award.changeCount);
    return updates ? `${updates} · Open to view source pages` : "Open to view source pages";
  }

  const updates = recordedUpdatesText(award.changeCount ?? award.changes.length);
  if (award.sourceCount === 0) return `Source search pending · ${updates}`;

  return [
    `${award.sourceCount} source page${award.sourceCount === 1 ? "" : "s"}`,
    updates,
  ]
    .filter(Boolean)
    .join(" · ");
}

function recordedUpdatesText(changeCount: number) {
  return `${changeCount} recorded update${changeCount === 1 ? "" : "s"}`;
}

function compactAwardBlurb(summary: string | null, awardName: string) {
  return compactAwardDirectorySummary(summary, awardName);
}

function uniqueOptions(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}
