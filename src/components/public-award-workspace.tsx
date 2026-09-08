"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowLeft,
  BookOpen,
  CalendarDays,
  ExternalLink,
  FileText,
  Inbox,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Users,
  type LucideIcon,
} from "lucide-react";
import { presentAwardDateField, presentAwardTimelineDate } from "@/lib/award-date-presentation";
import { pageTypeLabel } from "@/lib/award-discovery-types";
import type { PublicAwardPageData } from "@/lib/public-award-pages";
import {
  PUBLIC_AWARD_PANEL_HEADING_ID,
  PUBLIC_AWARD_PANEL_ID,
  activatePanelSelection,
  readPanelRevealEnvironment,
  revealSelectedPanel,
  shouldRevealPanel,
  type PanelActivationState,
} from "@/lib/public-award-panel-focus";
import { describeTimestamp, formatCentralDate } from "@/lib/time-zone";
import { ChangeEvidencePanel } from "@/components/change-evidence-panel";
import { AwardDateValue } from "@/components/award-date-value";
import { SourceSnapshotInlinePreview } from "@/components/source-snapshot-viewer";

type PublicAwardWorkspaceProps = {
  data: PublicAwardPageData;
  initialChangeId?: string | null;
  initialSourceId?: string | null;
};

export type SelectedPanel =
  | { kind: "overview" }
  | { kind: "eligibility" | "dates" | "application" | "sources" }
  | { kind: "changes" }
  | { kind: "source"; sourceId: string };

type PublicAwardSource = PublicAwardPageData["sources"][number];
type PublicAwardChange = PublicAwardPageData["changes"][number];
type FactValue = string | string[];
// Canonical labels still control section membership; display wording must not
// move a scoped deadline out of the Deadline slot.
type FactRow = { label: string; displayLabel?: string; value: FactValue; icon?: "calendar" | "checklist" };
type MaybeFactRow = { label: string; displayLabel?: string; value: FactValue | null; icon?: "calendar" | "checklist" };

export function PublicAwardWorkspace({
  data,
  initialChangeId,
  initialSourceId,
}: PublicAwardWorkspaceProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const initialContext = initialPanelForQuery(data, initialSourceId, initialChangeId);
  // The selection plus the count of visitor activations; the count starts
  // at zero, so mounting and deep links never run the reveal effect below.
  const [activation, setActivation] = useState<PanelActivationState<SelectedPanel>>(() => ({
    selected: initialContext.panel,
    revealSequence: 0,
  }));
  const selected = activation.selected;
  const highlightedChangeId = initialContext.highlightedChangeId;
  const [readChangeIds, setReadChangeIds] = useState<Set<string>>(
    () => new Set(data.changes.filter((change) => change.unread === false).map((change) => change.id)),
  );
  const panelRef = useRef<HTMLElement>(null);
  const activationOrigin = useRef<"outline" | "panel">("outline");
  const selectedSource =
    selected.kind === "source"
      ? data.sources.find((source) => source.id === selected.sourceId) || null
      : null;
  const selectedSourceChanges = selectedSource
    ? data.changes.filter((change) => isChangeForSource(change, selectedSource))
    : [];
  const sourceChangeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of data.sources) {
      counts.set(
        source.id,
        data.changes.filter((change) => isChangeForSource(change, source)).length,
      );
    }
    return counts;
  }, [data.changes, data.sources]);
  const sourceUnreadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of data.sources) {
      counts.set(
        source.id,
        data.changes.filter(
          (change) =>
            isChangeForSource(change, source) &&
            isUnreadChange(change, readChangeIds),
        ).length,
      );
    }
    return counts;
  }, [data.changes, data.sources, readChangeIds]);
  const unreadChangeCount = useMemo(
    () => data.changes.filter((change) => isUnreadChange(change, readChangeIds)).length,
    [data.changes, readChangeIds],
  );
  const factRows = awardFactRows(data.facts, data.award.name);
  const markChangesRead = (changeIds: string[]) => {
    const uniqueIds = [...new Set(changeIds)].filter(Boolean);
    if (uniqueIds.length === 0) return;
    setReadChangeIds((current) => new Set([...current, ...uniqueIds]));
    postReadChangeIds(uniqueIds);
  };
  // Every outline activation goes through here: it marks what the visitor
  // is about to see as read and applies the pure activation transition,
  // whose advancing sequence drives the reveal effect below.
  const activatePanel = (next: SelectedPanel, origin: "outline" | "panel" = "outline") => {
    if (!isKnownPanel(data, next)) return;
    activationOrigin.current = origin;
    markChangesRead(changeIdsToMarkRead(data, readChangeIds, next));
    setActivation((state) => activatePanelSelection(state, next, (panel) => isKnownPanel(data, panel)));
  };

  useEffect(() => {
    if (!shouldRevealPanel(activation.revealSequence)) return;
    revealSelectedPanel(panelRef.current, readPanelRevealEnvironment(), activationOrigin.current);
  }, [activation.revealSequence]);

  return (
    <div className={`public-award-console ${sidebarOpen ? "" : "public-award-console-collapsed"}`}>
      <header className="public-award-console-header">
        <div>
          <p className="public-award-kicker">Nationally competitive award</p>
          <h1>{data.award.name}</h1>
          <div className="public-award-meta-line">
            <span>{countLabel(data.sources.length, "source page")}</span>
          </div>
          {data.facts.overview && <p>{data.facts.overview}</p>}
        </div>
        <div className="public-award-console-actions">
          {data.officialHomepage && (
            <a className="button-secondary" href={data.officialHomepage} rel="noreferrer" target="_blank">
              <ExternalLink size={15} aria-hidden="true" />
              Official homepage
            </a>
          )}
          {/* One public action for every visitor: the live feed, which also
              offers the daily digest. Contact stays in the site footer. */}
          <Link className="button-primary" href="/updates">
            View all updates
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </header>

      <aside className="public-award-sidebar" aria-label={`${data.award.name} page outline`}>
        <Link className="public-award-directory-link" href="/award-directory" prefetch={false} aria-label="Award Directory" title="Award Directory">
          <ArrowLeft size={15} aria-hidden="true" />
          <span>Award Directory</span>
        </Link>
        <div className="public-award-sidebar-header">
          <div className="min-w-0">
            <p>On this award</p>
            <span>{data.lastCheckedAt ? `Last source check ${formatDate(data.lastCheckedAt)}` : "Source check unavailable"}</span>
          </div>
          <button
            aria-label={sidebarOpen ? "Collapse page outline" : "Expand page outline"}
            aria-expanded={sidebarOpen}
            aria-controls="award-section-navigation"
            className="public-award-sidebar-toggle"
            type="button"
            onClick={() => setSidebarOpen((current) => !current)}
          >
            {sidebarOpen ? (
              <PanelLeftClose size={16} aria-hidden="true" />
            ) : (
              <PanelLeftOpen size={16} aria-hidden="true" />
            )}
          </button>
        </div>

        <nav className="public-award-nav-section public-award-task-nav" aria-label="Award sections" id="award-section-navigation">
          <PanelButton
            active={selected.kind === "overview"}
            label="Overview"
            icon={BookOpen}
            meta="About the award"
            onClick={() => activatePanel({ kind: "overview" })}
          />
          <PanelButton
            active={selected.kind === "eligibility"}
            label="Eligibility"
            icon={Users}
            meta="Who can apply"
            onClick={() => activatePanel({ kind: "eligibility" })}
          />
          <PanelButton
            active={selected.kind === "dates"}
            label="Dates & deadlines"
            icon={CalendarDays}
            meta="When to apply"
            onClick={() => activatePanel({ kind: "dates" })}
          />
          <PanelButton
            active={selected.kind === "application"}
            label="How to apply"
            icon={ListChecks}
            meta="Steps & materials"
            onClick={() => activatePanel({ kind: "application" })}
          />
          <PanelButton
            active={selected.kind === "changes"}
            label="Updates"
            icon={Inbox}
            meta={`${countLabel(data.changes.length, "update")} shown`}
            onClick={() => activatePanel({ kind: "changes" })}
            updateCount={unreadChangeCount}
          />
          <PanelButton
            active={selected.kind === "sources" || selected.kind === "source"}
            label="Official sources"
            icon={FileText}
            meta={countLabel(data.sources.length, "source page")}
            onClick={() => activatePanel({ kind: "sources" })}
          />
        </nav>
      </aside>

      {/* One stable region for whichever panel is selected: outline buttons
          control it, and on the one-column layout a visitor's activation
          moves focus here and scrolls it into view. */}
      <section
        className="public-award-console-panel"
        id={PUBLIC_AWARD_PANEL_ID}
        role="region"
        aria-labelledby={PUBLIC_AWARD_PANEL_HEADING_ID}
        ref={panelRef}
        tabIndex={-1}
      >
        {selected.kind === "overview" && (
          <OverviewPanel
            factRows={factRows}
            headingId={PUBLIC_AWARD_PANEL_HEADING_ID}
          />
        )}
        {(selected.kind === "eligibility" || selected.kind === "dates" || selected.kind === "application") && (
          <AwardFactsPanel
            facts={data.facts}
            awardName={data.award.name}
            section={selected.kind}
            headingId={PUBLIC_AWARD_PANEL_HEADING_ID}
            onViewSources={() => activatePanel({ kind: "sources" }, "panel")}
          />
        )}
        {selected.kind === "sources" && (
          <AwardSourcesPanel
            data={data}
            headingId={PUBLIC_AWARD_PANEL_HEADING_ID}
            sourceChangeCounts={sourceChangeCounts}
            sourceUnreadCounts={sourceUnreadCounts}
            onSelectSource={(sourceId) => activatePanel({ kind: "source", sourceId }, "panel")}
          />
        )}
        {selected.kind === "changes" && (
          <ChangesPanel
            changes={data.changes}
            headingId={PUBLIC_AWARD_PANEL_HEADING_ID}
            highlightedChangeId={highlightedChangeId}
          />
        )}
        {selected.kind === "source" && selectedSource && (
          <SourcePanel
            awardName={data.award.name}
            changes={selectedSourceChanges}
            headingId={PUBLIC_AWARD_PANEL_HEADING_ID}
            highlightedChangeId={highlightedChangeId}
            officialHomepage={data.officialHomepage}
            onViewSources={() => activatePanel({ kind: "sources" }, "panel")}
            source={selectedSource}
          />
        )}
      </section>
    </div>
  );
}

// Resolves the page's query state (`source`, `change`) to the panel that
// should open first and the change to mark in it. A requested source wins;
// otherwise a listed change opens its own source, or the award's recent
// changes when that source is no longer listed. Unknown ids fall back to
// the overview, so a stale link still lands on the award.
function initialPanelForQuery(
  data: PublicAwardPageData,
  sourceId?: string | null,
  changeId?: string | null,
): { panel: SelectedPanel; highlightedChangeId: string | null } {
  const change = changeId
    ? data.changes.find((candidate) => candidate.id === changeId) || null
    : null;
  const requestedSource = sourceId
    ? data.sources.find((source) => source.id === sourceId) || null
    : null;
  if (requestedSource) {
    return {
      panel: { kind: "source", sourceId: requestedSource.id },
      highlightedChangeId: change && isChangeForSource(change, requestedSource) ? change.id : null,
    };
  }
  if (!change) return { panel: { kind: "overview" }, highlightedChangeId: null };
  const changeSource = data.sources.find((source) => isChangeForSource(change, source)) || null;
  if (changeSource) {
    return { panel: { kind: "source", sourceId: changeSource.id }, highlightedChangeId: change.id };
  }
  return { panel: { kind: "changes" }, highlightedChangeId: change.id };
}

// A panel the outline can show: the overview, recent changes, or a listed
// source.
function isKnownPanel(data: Pick<PublicAwardPageData, "sources">, panel: SelectedPanel) {
  return panel.kind !== "source" || data.sources.some((source) => source.id === panel.sourceId);
}

// The changes a visitor is about to see when activating a panel: that
// source's unread changes, every unread change for the recent-changes panel,
// nothing for the overview or an unknown source.
export function changeIdsToMarkRead(
  data: Pick<PublicAwardPageData, "sources" | "changes">,
  readChangeIds: Set<string>,
  next: SelectedPanel,
) {
  if (next.kind !== "changes" && next.kind !== "source") return [];
  const source =
    next.kind === "source"
      ? data.sources.find((candidate) => candidate.id === next.sourceId) || null
      : null;
  if (next.kind === "source" && !source) return [];
  return data.changes
    .filter(
      (change) =>
        (source ? isChangeForSource(change, source) : true) && isUnreadChange(change, readChangeIds),
    )
    .map((change) => change.id);
}

function PanelButton({
  active,
  label,
  meta,
  onClick,
  icon: Icon,
  updateCount = 0,
}: {
  active: boolean;
  label: string;
  meta?: string | null;
  onClick: () => void;
  icon: LucideIcon;
  updateCount?: number;
}) {
  const hasUpdate = updateCount > 0;

  return (
    <button
      aria-controls={PUBLIC_AWARD_PANEL_ID}
      aria-pressed={active}
      aria-label={[label, meta, hasUpdate ? countLabel(updateCount, "unread update") : null].filter(Boolean).join(", ")}
      title={label}
      className={`public-award-nav-button public-award-nav-button-profile ${active ? "public-award-nav-button-active" : ""} ${hasUpdate ? "public-award-nav-button-updated" : ""}`}
      type="button"
      onClick={onClick}
    >
      <Icon className="public-award-nav-icon" size={18} aria-hidden="true" />
      <span className="public-award-nav-text">
        <strong>{label}</strong>
        {meta && <small>{meta}</small>}
      </span>
      {hasUpdate && (
        <span className="public-award-update-count" aria-label={`${updateCount} unread update${updateCount === 1 ? "" : "s"}`}>
          {updateCount > 9 ? "9+" : updateCount}
        </span>
      )}
    </button>
  );
}

const KEY_FACT_LABELS = new Set(["Deadline", "Opening date", "Award amount"]);
const DATE_FACT_LABELS = new Set(["Deadline", "Opening date", "Important dates"]);

const FACT_SECTIONS = {
  eligibility: {
    title: "Eligibility",
    description: "Who can apply, based on the details available for this award.",
    labels: ["Eligibility", "Academic level", "Discipline", "Citizenship"],
  },
  dates: {
    title: "Dates & deadlines",
    description: "Published dates are shown as recorded. Check the official source for the current application cycle.",
    labels: ["Deadline", "Opening date", "Important dates"],
  },
  application: {
    title: "How to apply",
    description: "Application steps, required materials, and contacts in one place.",
    labels: ["How to apply", "Requirements", "Application materials", "Documents", "Contact"],
  },
} as const;

export function AwardFactsPanel({ facts, awardName, section, headingId, onViewSources }: {
  facts: PublicAwardPageData["facts"];
  awardName?: string;
  section: keyof typeof FACT_SECTIONS;
  headingId?: string;
  onViewSources: () => void;
}) {
  const definition = FACT_SECTIONS[section];
  const rows = awardFactRows(facts, awardName);
  const sectionRows = definition.labels.flatMap((label) => rows.filter((row) => row.label === label));
  return (
    <div className="public-award-panel-stack">
      <div className="public-award-section-heading">
        <h2 id={headingId}>{definition.title}</h2>
        <p className="public-award-section-description">{definition.description}</p>
      </div>
      {sectionRows.length > 0 ? (
        <div className="public-award-fact-table public-award-fact-table-compact">
          {sectionRows.map((fact) => <FactLine fact={fact} key={fact.label} />)}
        </div>
      ) : (
        <EmptyState text="These details are not available yet. Check the official sources before applying." />
      )}
      <button className="public-award-context-link" type="button" onClick={onViewSources}>
        View official sources <ArrowRight size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

// Search never filters the underlying award data or its publication gates.
// Every source supplied by the loader remains reachable, with no display cap.
export function filterAwardSources(sources: PublicAwardSource[], query: string, officialHomepage?: string | null) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const isHomepage = (source: PublicAwardSource) => sourceUrlsMatch(source.url, officialHomepage);
  return sources.filter((source) => {
    const text = [source.title, source.description, source.url, pageTypeLabel(source.pageType)]
      .filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  }).sort((a, b) => Number(isHomepage(b)) - Number(isHomepage(a)));
}

export function AwardSourcesPanel({ data, headingId, onSelectSource, sourceChangeCounts = new Map(), sourceUnreadCounts = new Map() }: {
  data: PublicAwardPageData;
  headingId?: string;
  onSelectSource: (sourceId: string) => void;
  sourceChangeCounts?: Map<string, number>;
  sourceUnreadCounts?: Map<string, number>;
}) {
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sources = filterAwardSources(data.sources, query, data.officialHomepage);
  return (
    <div className="public-award-panel-stack">
      <div className="public-award-section-heading">
        <h2 id={headingId}>Official sources</h2>
        <p className="public-award-section-description">
          Original pages behind this award. Choose a page to see the updates available here and open the official source.
        </p>
      </div>
      {data.sources.length > 0 && (
        <div className="public-award-source-search">
          <label htmlFor="award-source-search">Find a source page</label>
          <div>
            <Search size={17} aria-hidden="true" />
            <input id="award-source-search" ref={searchInputRef} type="search" placeholder="Search by title, type, or address" value={query}
              onChange={(event) => setQuery(event.target.value)} />
          </div>
          <p role="status">{sources.length} of {countLabel(data.sources.length, "source page")}</p>
        </div>
      )}
      {sources.length > 0 ? (
        <div className="public-award-source-directory">
          {sources.map((source) => (
            <button className="public-award-source-choice" type="button" key={source.id}
              onClick={() => onSelectSource(source.id)} title={source.title}>
              <FileText size={19} aria-hidden="true" />
              <span className="public-award-source-choice-text">
                <strong>{sourceDisplayTitle(source, data.award.name, data.officialHomepage)}</strong>
                <span className="public-award-source-purpose">
                  <span>{pageTypeLabel(source.pageType)}</span>
                  <span>{countLabel(sourceChangeCounts.get(source.id) ?? 0, "update")} shown</span>
                  {(sourceUnreadCounts.get(source.id) ?? 0) > 0 && <span className="public-award-source-unread">Unread updates</span>}
                </span>
                <span className="public-award-source-address">{source.url}</span>
              </span>
              <ArrowRight size={17} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : (
        <div>
          <EmptyState text={data.sources.length ? "No source pages match your search." : "No official source pages are available for this award yet."} />
          {query && <button type="button" className="public-award-context-link" onClick={() => {
            // Keep keyboard users in the search when this recovery button disappears.
            searchInputRef.current?.focus();
            setQuery("");
          }}>Clear search</button>}
        </div>
      )}
    </div>
  );
}

function OverviewPanel({
  factRows,
  headingId,
}: {
  factRows: FactRow[];
  headingId?: string;
}) {
  const keyFacts = factRows.filter((fact) => KEY_FACT_LABELS.has(fact.label));
  const detailRows = factRows.filter((fact) => !KEY_FACT_LABELS.has(fact.label));

  return (
    <div className="public-award-panel-stack">
      {keyFacts.length > 0 && (
        <dl className="public-award-key-facts">
          {keyFacts.map((fact) => (
            <div className="public-award-key-fact" key={fact.label}>
              <dt>{fact.displayLabel ?? fact.label}</dt>
              <dd>
                <FactValueDisplay className="public-award-fact-list" value={fact.value} isDate={DATE_FACT_LABELS.has(fact.label)} />
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="public-award-section-heading">
        <h2 id={headingId}>Overview</h2>
      </div>

      {factRows.length === 0 && (
        <EmptyState text="Award details are not available yet. Check the official sources before applying." />
      )}

      {detailRows.length > 0 && (
        <div className="public-award-fact-table public-award-fact-table-compact">
          {detailRows.map((fact) => (
            <FactLine fact={fact} key={fact.label} />
          ))}
        </div>
      )}
    </div>
  );
}

function SourcePanel({
  awardName,
  changes,
  headingId,
  highlightedChangeId,
  officialHomepage,
  onViewSources,
  source,
}: {
  awardName: string;
  changes: PublicAwardPageData["changes"];
  headingId?: string;
  highlightedChangeId?: string | null;
  officialHomepage?: string | null;
  onViewSources: () => void;
  source: PublicAwardPageData["sources"][number];
}) {
  const displayTitle = sourceDisplayTitle(source, awardName, officialHomepage);

  return (
    <div className="public-award-panel-stack">
      <button className="public-award-context-link" type="button" onClick={onViewSources}>
        <ArrowLeft size={15} aria-hidden="true" /> All official sources
      </button>
      <div className="public-award-source-detail-heading">
        <div>
          {sourceTags(source).map((tag) => (
            <span className="badge" key={tag}>{tag}</span>
          ))}
          <h2 id={headingId}>{displayTitle}</h2>
        </div>
        <div className="public-award-console-actions">
          <a className="button-primary" href={source.url} rel="noreferrer" target="_blank">
            Official source
            <ExternalLink size={15} aria-hidden="true" />
          </a>
        </div>
      </div>

      <ChangesPanel
        changes={changes}
        emptyText="No updates for this source are included in this view."
        highlightedChangeId={highlightedChangeId}
        showSnapshotPreviews
        sourceIdFallback={source.id}
        title="Source update history"
      />
    </div>
  );
}

function ChangesPanel({
  changes,
  emptyText = "No updates are available in this view yet.",
  headingId,
  highlightedChangeId = null,
  showSnapshotPreviews = false,
  sourceIdFallback,
  title = "Updates",
}: {
  changes: PublicAwardPageData["changes"];
  emptyText?: string;
  headingId?: string;
  highlightedChangeId?: string | null;
  showSnapshotPreviews?: boolean;
  sourceIdFallback?: string | null;
  title?: string;
}) {
  const isHighlighted = (change: PublicAwardChange) =>
    highlightedChangeId !== null && change.id === highlightedChangeId;

  return (
    <div className="public-award-panel-stack">
      <div className="public-award-section-heading">
        <h2 id={headingId}>{title}</h2>
      </div>
      {changes.length > 0 ? (
        <div className="public-award-change-table">
          {changes.map((change) => (
            <article
              aria-current={isHighlighted(change) ? "true" : undefined}
              className="public-award-change-line"
              data-highlighted={isHighlighted(change) ? "true" : undefined}
              key={change.id}
            >
              <ChangeTimestamp value={change.detectedAt} />
              <div>
                {isHighlighted(change) && <span className="badge">Selected update</span>}
                <h3>{change.sourceTitle}</h3>
                <p>{change.summary}</p>
                {showSnapshotPreviews && (
                  <SourceSnapshotInlinePreview
                    changeEventId={change.id}
                    changeDetails={change.changeDetails}
                    changeSummary={change.summary}
                    sourceId={change.sourceId || sourceIdFallback}
                    sourceTitle={change.sourceTitle}
                    sourceUrl={change.sourceUrl}
                  />
                )}
                <ChangeEvidencePanel
                  changeEventId={change.id}
                  changeDetails={change.changeDetails}
                  compact
                  detectedAt={change.detectedAt}
                  sourceId={change.sourceId}
                  sourcePageTypeLabel={change.sourcePageType ? pageTypeLabel(change.sourcePageType) : null}
                  sourceTitle={change.sourceTitle}
                  sourceUrl={change.sourceUrl}
                  summary={change.summary}
                />
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState text={emptyText} />
      )}
    </div>
  );
}

// The visible date stays absolute; the element carries the machine-readable
// timestamp and the full Central date and time for titles and assistive
// technology. A value that is not a date renders one plain notice instead
// of a <time> without a datetime.
function ChangeTimestamp({ value }: { value: string }) {
  const stamp = describeTimestamp(value);
  if (!stamp.dateTime) return <span>{stamp.full}</span>;
  return (
    <time dateTime={stamp.dateTime} title={stamp.full}>
      {formatDate(value)}
      <span className="sr-only"> ({stamp.full})</span>
    </time>
  );
}

function FactLine({
  fact,
}: {
  fact: FactRow;
}) {
  return (
    <div className="public-award-fact-line">
      <dt>
        {fact.icon === "calendar" && <CalendarDays size={16} aria-hidden="true" />}
        {fact.icon === "checklist" && <ListChecks size={16} aria-hidden="true" />}
        {fact.displayLabel ?? fact.label}
      </dt>
      <dd>
        <FactValueDisplay className="public-award-fact-list" value={fact.value} isDate={DATE_FACT_LABELS.has(fact.label)} />
      </dd>
    </div>
  );
}

function FactValueDisplay({
  className,
  value,
  isDate = false,
}: {
  className: string;
  value: FactValue;
  isDate?: boolean;
}) {
  const items = Array.isArray(value) ? value.flatMap(splitFactItems) : splitFactItems(value);
  if (items.length <= 1) return isDate ? <AwardDateValue value={items[0] || ""} /> : <>{items[0] || ""}</>;

  return (
    <ul className={className}>
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{isDate ? <AwardDateValue value={item} /> : item}</li>
      ))}
    </ul>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="public-award-empty">
      <FileText size={20} aria-hidden="true" />
      {text}
    </div>
  );
}

function awardFactRows(facts: PublicAwardPageData["facts"], awardName?: string): FactRow[] {
  const deadline = presentAwardDateField(facts.deadline, awardName);
  const opening = presentAwardDateField(facts.openingDate, awardName, "Opening date");
  const rows: MaybeFactRow[] = [
    // Date facts render in the house style; every other reviewed value, and
    // any wording this helper does not recognise, is left exactly as reviewed.
    { label: "Deadline", displayLabel: deadline.label, value: deadline.value, icon: "calendar" as const },
    { label: "Opening date", displayLabel: opening.label, value: opening.value },
    { label: "Award amount", value: facts.awardAmount },
    { label: "Academic level", value: compactList(facts.academicLevels) },
    { label: "Discipline", value: compactList(facts.disciplines) },
    { label: "Citizenship", value: compactList(facts.citizenship) },
    { label: "Eligibility", value: compactList(facts.eligibility) },
    // The editorial policy defines `requirements` as "what must be true of my
    // application" (self-checkable conditions), so the row carries that name.
    { label: "Requirements", value: compactList(facts.requirements) },
    { label: "Application materials", value: compactList(facts.applicationMaterials), icon: "checklist" as const },
    { label: "How to apply", value: compactList(facts.howToApply) },
    { label: "Important dates", value: compactList(facts.importantDates.flatMap(splitFactItems).map((value) => presentAwardTimelineDate(value, awardName))) },
    { label: "Documents", value: compactList(facts.documents) },
    { label: "Contact", value: compactList(facts.contacts) },
  ];

  return rows.filter(isFactRow);
}

function compactList(values: string[]) {
  // Every reviewed item renders; the review, not a display cap, bounds the list.
  const clean = values.flatMap(splitFactItems);
  if (clean.length === 0) return null;
  return clean.length === 1 ? clean[0] : clean;
}

function splitFactItems(value: string) {
  return value.split(/\s*;\s*/).map((item) => item.trim()).filter(Boolean);
}

function isFactRow(row: MaybeFactRow): row is FactRow {
  return Array.isArray(row.value) ? row.value.length > 0 : Boolean(row.value);
}


function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceTags(source: PublicAwardSource) {
  return source.pageType === "pdf" ? ["PDF"] : [];
}

function sourceDisplayTitle(source: PublicAwardSource, awardName: string, officialHomepage?: string | null) {
  const cleanTitle = source.title.replace(/\s+/g, " ").trim();
  const isOfficialHomepage = sourceUrlsMatch(source.url, officialHomepage);
  if (
    (source.pageType === "homepage" || isOfficialHomepage) &&
    (!cleanTitle || /^(homepage|home|source page|official homepage|official page)$/i.test(cleanTitle))
  ) {
    return "Homepage";
  }
  if (source.pageType === "homepage" || isOfficialHomepage || cleanTitle.toLowerCase() === awardName.toLowerCase()) {
    return "Homepage";
  }

  const shortTitle = shortenSourceDisplayTitle(cleanTitle, awardName);
  if (shortTitle) return compactSourceDisplayTitle(shortTitle, true);

  return compactSourceDisplayTitle(cleanTitle || "Source page");
}

function shortenSourceDisplayTitle(title: string, awardName: string) {
  const original = title.replace(/\s+/g, " ").trim();
  const hadDownloadSuffix = /\s*(?:\[(?:download|pdf)\]|\((?:download|pdf)\))\s*$/i.test(original);
  let value = original
    .replace(/\s*\[(?:download|pdf)\]\s*$/i, "")
    .replace(/\s*\((?:download|pdf)\)\s*$/i, "")
    .replace(/^(?:the\s+)?national academies(?: of sciences, engineering, and medicine)?\s+/i, "")
    .replace(/\bapplicant resources?\b/gi, "")
    .trim();

  if (!value) return "";

  const cleanedOriginal = value;
  value = bestNonBrandSegment(value, awardName);
  for (const phrase of removableAwardPhrases(awardName)) {
    value = removePhrase(value, phrase);
  }

  value = bestNonBrandSegment(value, awardName)
    .replace(/^(?:official\s+)?(?:award|awards)\s+committee\s+/i, "")
    .replace(/^(?:official\s+)?(?:award|awards|scholarship|scholarships|fellowship|fellowships|grant|grants|program|programme)\s*[:|-]\s*/i, "")
    .replace(/^(?:official\s+)?(?:award|awards)\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:|/-]+|[\s:|/-]+$/g, "")
    .trim();

  if (!value || (!hadDownloadSuffix && value.toLowerCase() === cleanedOriginal.toLowerCase())) return "";
  return toDisplayTitleCase(value);
}

function compactSourceDisplayTitle(title: string, forceDisplayCase = false) {
  const original = title
    .replace(/[.]{3,}|…/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:|/-]+|[\s:|/-]+$/g, "")
    .trim();
  let value = title
    .replace(/[.]{3,}|…/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:|/-]+|[\s:|/-]+$/g, "")
    .trim();

  if (!value) return "Source page";

  value = value
    .replace(/^frequently asked questions$/i, "FAQ")
    .replace(/^instructions?\s+on\s+submitting\b.*$/i, "Submission Instructions")
    .replace(/^online\s+payment\s+link$/i, "Online Payment")
    .replace(/^a\s+NOFO\s+of\s+up\s+to\s+\$?(\d+(?:\.\d+)?)\s+million$/i, "NOFO up to $$$1M")
    .replace(/^announced\s+a\s+series\s+of\s+fund(?:ing|i).*$/i, "Funding Announcements")
    .replace(/^benefits\s+of\s+working\s+at\s+ener(?:gy)?\b.*$/i, "Benefits")
    .replace(/^apprenticeships?\s+(?:&|and)\s+workfor(?:ce)?\b.*$/i, "Apprenticeships")
    .replace(/^department\s+of\s+energy$/i, "Department of Energy")
    .replace(/\bU\.S\.\s+Department\s+of\s+Energy(?:\s+\(DOE\))?\b/gi, "DOE")
    .replace(/\bOak\s+Ridge\s+Institute\s+for\s+Science\s+(?:&|and)\s+Education\b/gi, "ORISE")
    .replace(/\s+/g, " ")
    .trim();
  const transformed = forceDisplayCase || value.toLowerCase() !== original.toLowerCase();

  if (value.length <= 42) return displaySourceTitleCase(value, transformed);

  const segments = value
    .split(/\s*(?:[|:]|-)\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .sort((a, b) => a.length - b.length);
  const compactSegment = segments.find((segment) => segment.length <= 42);
  if (compactSegment) return displaySourceTitleCase(compactSegment, true);

  const words = value.split(/\s+/).filter(Boolean);
  const compactWords = words.slice(0, 6).join(" ");
  if (compactWords.length >= 12) return displaySourceTitleCase(compactWords, true);

  return displaySourceTitleCase(words.slice(0, 7).join(" ") || value.slice(0, 42), true);
}

function displaySourceTitleCase(value: string, forceDisplayCase: boolean) {
  if (!forceDisplayCase && !isMostlyLowercase(value) && !isMostlyUppercase(value)) return value;
  return toDisplayTitleCase(value);
}

function isMostlyLowercase(value: string) {
  const letters = value.replace(/[^A-Za-z]/g, "");
  return Boolean(letters) && letters === letters.toLowerCase();
}

function isMostlyUppercase(value: string) {
  const letters = value.replace(/[^A-Za-z]/g, "");
  return letters.length >= 3 && letters === letters.toUpperCase();
}

function bestNonBrandSegment(title: string, awardName: string) {
  const parts = title
    .split(/\s*(?:[|:]|-)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return title.trim();

  const awardPhrases = removableAwardPhrases(awardName);
  const hasBrandPart = parts.some((part) => awardPhrases.some((phrase) => phraseMatches(part, phrase)));
  if (!hasBrandPart) return title.trim();

  const nonBrand = parts.find((part) => !awardPhrases.some((phrase) => phraseMatches(part, phrase)));
  return nonBrand || parts[0];
}

function removableAwardPhrases(awardName: string) {
  const withoutParentheticals = awardName.replace(/\([^)]*\)/g, " ");
  const acronyms = [...awardName.matchAll(/\(([A-Z][A-Z0-9&]{1,})\)/g)].map((match) => match[1]);
  const pieces = awardName
    .split(/\s*(?:[|:]|-)\s+/)
    .flatMap((part) => [part, part.replace(/\([^)]*\)/g, " ")]);
  const subphrases = awardSubphrases(withoutParentheticals);
  return [
    awardName,
    withoutParentheticals,
    ...pieces,
    ...subphrases,
    ...acronyms,
  ]
    .flatMap(awardPhraseVariants)
    .map((phrase) => phrase.replace(/\s+/g, " ").trim())
    .filter((phrase, index, phrases) => phrase.length >= 2 && phrases.indexOf(phrase) === index)
    .sort((a, b) => b.length - a.length);
}

function awardSubphrases(value: string) {
  const words = value.split(/\s+/).map((word) => word.trim()).filter(Boolean);
  const phrases: string[] = [];
  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 3; end <= words.length; end += 1) {
      const phrase = words.slice(start, end).join(" ");
      if (/\b(award|scholarships?|fellowships?|grants?|programs?|programme)\b/i.test(phrase)) {
        phrases.push(phrase);
      }
    }
  }
  return phrases;
}

function awardPhraseVariants(value: string) {
  const variants = new Set([value]);
  variants.add(value.replace(/\bfellowship\b/gi, "Fellowships"));
  variants.add(value.replace(/\bfellowships\b/gi, "Fellowship"));
  variants.add(value.replace(/\bscholarship\b/gi, "Scholarships"));
  variants.add(value.replace(/\bscholarships\b/gi, "Scholarship"));
  variants.add(value.replace(/\bprogram\b/gi, "Programs"));
  variants.add(value.replace(/\bprograms\b/gi, "Program"));
  variants.add(value.replace(/\bprogramme\b/gi, "Programmes"));
  variants.add(value.replace(/\bprogrammes\b/gi, "Programme"));
  return [...variants];
}

function removePhrase(value: string, phrase: string) {
  if (!phrase) return value;
  const escaped = escapeRegExp(phrase);
  return value
    .replace(new RegExp(`^(\\d{4}(?:[-–]\\d{2,4})?\\s+)${escaped}\\b\\s*[:|/-]?\\s*`, "i"), "$1")
    .replace(new RegExp(`^${escaped}\\b\\s*[:|/-]?\\s*`, "i"), "")
    .replace(new RegExp(`\\s*[:|/-]?\\s*\\b${escaped}$`, "i"), "")
    .replace(/\s+/g, " ")
    .trim();
}

function phraseMatches(value: string, phrase: string) {
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i").test(value);
}

function toDisplayTitleCase(value: string) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return "";

  const smallWords = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "nor", "of", "on", "or", "the", "to", "up", "with"]);
  return clean
    .split(" ")
    .map((word, index, words) => {
      const normalized = word.toLowerCase();
      if (/^[A-Z0-9&]{2,}$/.test(word)) return word;
      if (/^\$?\d+(?:\.\d+)?[A-Z]+$/.test(word)) return word;
      if (index > 0 && index < words.length - 1 && smallWords.has(normalized)) return normalized;
      return word
        .split(/([/-])/)
        .map((part) => {
          if (/^[/-]$/.test(part)) return part;
          if (/^[A-Z0-9&]{2,}$/.test(part)) return part;
          const lower = part.toLowerCase();
          return lower ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` : part;
        })
        .join("");
    })
    .join(" ");
}

function isChangeForSource(change: PublicAwardChange, source: PublicAwardSource) {
  // A retained source ID is authoritative, including when that source has
  // retired. URL fallback is only for legacy changes without an ID, never a
  // reason to attach an identified change to a different source.
  if (change.sourceId) return change.sourceId === source.id;
  return sourceUrlsMatch(change.sourceUrl, source.url);
}

function isUnreadChange(change: PublicAwardChange, readChangeIds: Set<string>) {
  return change.unread !== false && !readChangeIds.has(change.id);
}

function postReadChangeIds(changeIds: string[]) {
  void fetch("/api/shared-award-change-reads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ changeIds }),
  }).catch(() => {
    // The local UI state should still clear promptly if persistence is unavailable.
  });
}

function sourceUrlsMatch(left: string | null | undefined, right: string | null | undefined) {
  const leftKey = sourceDocumentUrlKey(left);
  return leftKey !== null && leftKey === sourceDocumentUrlKey(right);
}

function sourceDocumentUrlKey(value: string | null | undefined) {
  try {
    const url = new URL(value || "");
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // Unlike source-discovery deduplication, attribution must preserve the
    // document address: paths, query names/values, and query order may matter.
    // A fragment points within the same document, so it alone is ignored.
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function formatDate(value: string) {
  return formatCentralDate(value);
}

function countLabel(count: number, singular: string) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
