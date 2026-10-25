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
  type LucideIcon,
} from "lucide-react";
import { presentAwardDateField, presentAwardTimelineDate } from "@/lib/award-date-presentation";
import { pageTypeLabel } from "@/lib/award-discovery-types";
import { readableSourceTitle } from "@/lib/display-text";
import { publicAwardHref, publicAwardQueryId, publicAwardSection } from "@/lib/public-award-links";
import { awardFactCurrentnessNotices, presentAwardDeadlines, type AwardFactCurrentnessNotice } from "@/lib/award-page-presentation";
import { changeSummaryPresentation } from "@/lib/change-summary";
import { programChangePresentation } from "@/lib/program-change-presentation";
import type { PublicAwardPageData } from "@/lib/public-award-pages";
import {
  PUBLIC_AWARD_PANEL_HEADING_ID,
  PUBLIC_AWARD_PANEL_ID,
  activatePanelSelection,
  readPanelRevealEnvironment,
  revealSelectedPanel,
  revealAwardTargetWithoutFocus,
  shouldRevealPanel,
  type PanelActivationState,
} from "@/lib/public-award-panel-focus";
import { describeTimestamp, formatCentralDate } from "@/lib/time-zone";
import { ChangeEvidencePanel } from "@/components/change-evidence-panel";
import { ChangeSummaryDisplay } from "@/components/change-summary-display";
import { AwardDateValue } from "@/components/award-date-value";

type PublicAwardWorkspaceProps = {
  data: PublicAwardPageData;
  initialChangeId?: string | null;
  initialSourceId?: string | null;
  initialSection?: string | null;
};

export type SelectedPanel =
  | { kind: "overview" }
  | { kind: "eligibility" | "dates" | "application" | "sources" }
  | { kind: "changes" }
  | { kind: "source"; sourceId: string };

type AwardPanelContext = { detail?: string; changeId?: string | null };

type PublicAwardSource = PublicAwardPageData["sources"][number];
type PublicAwardChange = PublicAwardPageData["changes"][number];
type FactValue = string | string[];
// Canonical labels still control section membership; display wording must not
// move a scoped deadline out of the Deadline slot.
type FactConflict = { href: string; changeId: string };
type FactRow = { label: string; displayLabel?: string; value: FactValue; icon?: "calendar" | "checklist"; conflict?: FactConflict };
type MaybeFactRow = { label: string; displayLabel?: string; value: FactValue | null; icon?: "calendar" | "checklist" };

export function PublicAwardWorkspace({
  data,
  initialChangeId,
  initialSourceId,
  initialSection,
}: PublicAwardWorkspaceProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const initialContext = initialPanelForQuery(data, initialSourceId, initialChangeId, initialSection);
  // The selection plus the count of visitor activations; the count starts
  // at zero, so mounting and deep links never move keyboard focus.
  const [activation, setActivation] = useState<PanelActivationState<SelectedPanel>>(() => ({
    selected: initialContext.panel,
    revealSequence: 0,
  }));
  const selected = activation.selected;
  const [highlightedChangeId, setHighlightedChangeId] = useState(initialContext.highlightedChangeId);
  const [readChangeIds, setReadChangeIds] = useState<Set<string>>(
    () => new Set(data.changes.filter((change) => change.unread === false).map((change) => change.id)),
  );
  const panelRef = useRef<HTMLElement>(null);
  const activationOrigin = useRef<"outline" | "panel">("outline");
  const activationAnchor = useRef<string | null>(null);
  const lastSelectionSearch = useRef<string | null>(null);
  const historyNavigation = useRef(false);
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
  // Resolve names against the full roster, not the selected/filtered source.
  // Retained IDs are authoritative; ambiguous legacy URL matches keep the
  // recorded title instead of choosing whichever source was listed last.
  const listedSourceNames = useMemo(() => {
    const nameBySourceId = new Map<string, string>();
    const idsByDocumentKey = new Map<string, string[]>();
    for (const source of data.sources) {
      nameBySourceId.set(source.id, sourceDisplayTitle(source, data.award.name, data.officialHomepage));
      const documentKey = sourceDocumentUrlKey(source.url);
      if (documentKey === null) continue;
      const sameDocument = idsByDocumentKey.get(documentKey);
      if (sameDocument) sameDocument.push(source.id);
      else idsByDocumentKey.set(documentKey, [source.id]);
    }

    const names = new Map<string, string>();
    for (const change of data.changes) {
      const sourceId = change.sourceId || uniqueDocumentSourceId(idsByDocumentKey, change.sourceUrl);
      const listedName = sourceId ? nameBySourceId.get(sourceId) : undefined;
      if (listedName !== undefined) names.set(change.id, listedName);
    }
    return names;
  }, [data.award.name, data.changes, data.officialHomepage, data.sources]);
  const currentnessNotices = awardFactCurrentnessNotices(data);
  const currentness = currentnessNotices[0];
  const factConflicts = factConflictLinks(currentnessNotices, data.canonicalPath);
  const factRows = awardFactRows(data.facts, data.award.name, factConflicts);
  const markChangesRead = (changeIds: string[]) => {
    const uniqueIds = [...new Set(changeIds)].filter(Boolean);
    if (uniqueIds.length === 0) return;
    setReadChangeIds((current) => new Set([...current, ...uniqueIds]));
    postReadChangeIds(uniqueIds);
  };
  // Every outline activation goes through here: it marks what the visitor
  // is about to see as read and applies the pure activation transition,
  // whose advancing sequence drives the reveal effect below.
  const activatePanel = (next: SelectedPanel, origin: "outline" | "panel" = "outline", context: AwardPanelContext = {}) => {
    const navigation = awardPanelNavigation(data, next, context);
    if (!navigation) return;
    activationOrigin.current = origin;
    historyNavigation.current = false;
    activationAnchor.current = navigation.anchor;
    setHighlightedChangeId(navigation.highlightedChangeId);
    markChangesRead(changeIdsToMarkRead(data, readChangeIds, next));
    setActivation((state) => activatePanelSelection(state, next, (panel) => isKnownPanel(data, panel)));
    const href = navigation.href;
    if (typeof window !== "undefined" && `${window.location.pathname}${window.location.search}${window.location.hash}` !== href) {
      window.history.pushState(null, "", href);
      lastSelectionSearch.current = window.location.search;
    }
  };

  useEffect(() => {
    lastSelectionSearch.current = window.location.search;
    const restore = () => {
      const hash = window.location.hash.slice(1);
      const knownAnchor = APPLICATION_GROUPS.some((group) => `award-${group.id}` === hash) ? hash : null;
      // A known subsection needs a post-layout reveal: native restoration can
      // remember the position before the panel's click-driven scroll. Never
      // turn an unknown hash-only change into a scroll to the panel top.
      if (lastSelectionSearch.current === window.location.search && !knownAnchor) return;
      lastSelectionSearch.current = window.location.search;
      const params = new URLSearchParams(window.location.search);
      const context = initialPanelForQuery(data, publicAwardQueryId(params.get("source")), publicAwardQueryId(params.get("change")), publicAwardSection(params.get("section")));
      activationOrigin.current = "panel";
      historyNavigation.current = true;
      activationAnchor.current = knownAnchor;
      setHighlightedChangeId(context.highlightedChangeId);
      setActivation((state) => activatePanelSelection(state, context.panel, (panel) => isKnownPanel(data, panel)));
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [data]);

  useEffect(() => {
    const target = activationAnchor.current ? document.getElementById(activationAnchor.current) : null;
    const highlighted = highlightedChangeId && (selected.kind === "changes" || selected.kind === "source")
      ? panelRef.current?.querySelector<HTMLElement>('article[data-highlighted="true"]') : null;
    const fromHistory = historyNavigation.current;
    historyNavigation.current = false;
    if (shouldRevealPanel(activation.revealSequence) && !fromHistory) {
      revealSelectedPanel(target ?? panelRef.current, readPanelRevealEnvironment(), target ? "panel" : activationOrigin.current);
    }
    // Mount/deep links never invoke the panel-focus handoff. Only the selected
    // evidence card may scroll, and only when its start is outside the viewport.
    const scrollTarget = fromHistory ? target ?? highlighted ?? panelRef.current : highlighted;
    if (!scrollTarget) return;
    // Follow React layout and the browser's native history restoration. Cancel
    // queued work if the visitor changes section again before it executes.
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        const headerBottom = document.querySelector<HTMLElement>(".app-header")?.getBoundingClientRect().bottom ?? 0;
        revealAwardTargetWithoutFocus(scrollTarget, {
          viewportHeight: window.innerHeight,
          topInset: Math.max(0, headerBottom) + 16,
          reducedMotion: fromHistory || readPanelRevealEnvironment().reducedMotion,
        }, (options) => window.scrollBy(options));
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activation.revealSequence, highlightedChangeId, selected.kind]);

  return (
    <div className={`public-award-console ${sidebarOpen ? "" : "public-award-console-collapsed"}`}>
      <header className="public-award-console-header">
        <div>
          <h1>{data.award.name}</h1>
        </div>
        {data.officialHomepage && (
          <div className="public-award-console-actions">
            <a className="button-secondary" href={data.officialHomepage} rel="noreferrer" target="_blank">
              <ExternalLink size={15} aria-hidden="true" />
              Official award site
            </a>
          </div>
        )}
      </header>

      <aside className="public-award-sidebar" aria-label={`${data.award.name} page outline`}>
        <Link className="public-award-directory-link" href="/award-directory" prefetch={false} aria-label="Award Directory" title="Award Directory">
          <ArrowLeft size={15} aria-hidden="true" />
          <span>Award Directory</span>
        </Link>
        <div className="public-award-sidebar-header">
          <div className="min-w-0">
            <p>On this award</p>
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
            onClick={() => activatePanel({ kind: "overview" })}
          />
          <PanelButton
            active={selected.kind === "changes"}
            label="Updates"
            icon={Inbox}
            onClick={() => activatePanel({ kind: "changes" })}
            updateCount={unreadChangeCount}
          />
          <PanelButton
            active={selected.kind === "application"}
            label="Eligibility & applying"
            icon={ListChecks}
            onClick={() => activatePanel({ kind: "application" })}
          />
          <PanelButton
            active={selected.kind === "sources" || selected.kind === "source"}
            label="Sources"
            icon={FileText}
            onClick={() => activatePanel({ kind: "sources" })}
          />
        </nav>
        <div className="public-award-mobile-navigation">
          <label htmlFor="award-section-select">On this award</label>
          <select id="award-section-select" value={selected.kind === "source" ? "sources" : selected.kind}
            aria-controls={PUBLIC_AWARD_PANEL_ID}
            onChange={(event) => activatePanel({ kind: event.target.value as "overview" | "changes" | "application" | "sources" })}>
            <option value="overview">Overview</option>
            <option value="changes">Updates{unreadChangeCount ? ` (${unreadChangeCount} unread)` : ""}</option>
            <option value="application">Eligibility & applying</option>
            <option value="sources">Sources</option>
          </select>
        </div>
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
        {currentness && (selected.kind === "overview" || selected.kind === "application") && (
          <div className="public-award-currentness" role="note">
            <strong>{currentness.title}</strong>
            <p>{currentness.message}</p>
            <button className="public-award-context-link" type="button" onClick={() => activatePanel({ kind: "changes" }, "panel", { changeId: currentness.changeId })}>Review the recorded change <ArrowRight size={15} aria-hidden="true" /></button>
          </div>
        )}
        {selected.kind === "overview" && (
          <OverviewPanel
            deadlineConflict={factConflicts.get("Application deadlines")}
            data={data}
            factRows={factRows}
            headingId={PUBLIC_AWARD_PANEL_HEADING_ID}
            overview={data.facts.overview}
            onViewDetails={(detail) => activatePanel({ kind: "application" }, "panel", { detail })}
            onViewUpdates={(changeId) => activatePanel({ kind: "changes" }, "panel", { changeId })}
          />
        )}
        {(selected.kind === "eligibility" || selected.kind === "dates" || selected.kind === "application") && (
          <AwardFactsPanel
            onReviewChange={(changeId) => activatePanel({ kind: "changes" }, "panel", { changeId })}
            factConflicts={factConflicts}
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
            listedSourceNames={listedSourceNames}
          />
        )}
        {selected.kind === "source" && selectedSource && (
          <SourcePanel
            awardName={data.award.name}
            changes={selectedSourceChanges}
            headingId={PUBLIC_AWARD_PANEL_HEADING_ID}
            highlightedChangeId={highlightedChangeId}
            listedSourceNames={listedSourceNames}
            officialHomepage={data.officialHomepage}
            onViewSources={() => activatePanel({ kind: "sources" }, "panel")}
            source={selectedSource}
          />
        )}
      </section>
    </div>
  );
}

// Each activation describes its own destination. Never reuse the highlight
// left over from an older deep link for a new "latest update" action.
export function awardPanelNavigation(data: PublicAwardPageData, panel: SelectedPanel, context: AwardPanelContext = {}) {
  if (!isKnownPanel(data, panel)) return null;
  const requestedChangeId = context.changeId;
  const highlightedChangeId = panel.kind === "changes" && typeof requestedChangeId === "string"
    && data.changes.some((change) => change.id === requestedChangeId) ? requestedChangeId : null;
  const anchor = panel.kind === "application" && APPLICATION_GROUPS.some((group) => group.id === context.detail)
    ? `award-${context.detail}` : null;
  return {
    highlightedChangeId,
    anchor,
    href: awardPanelHref(data.canonicalPath, panel, highlightedChangeId) + (anchor ? `#${anchor}` : ""),
  };
}

// Explicit section navigation is stable across refresh/back. A valid change
// link opens Updates even when it also carries source attribution. A source-
// only link opens source history. Unknown IDs never bypass the loader's gates.
export function initialPanelForQuery(
  data: PublicAwardPageData,
  sourceId?: string | null,
  changeId?: string | null,
  section?: string | null,
): { panel: SelectedPanel; highlightedChangeId: string | null } {
  const change = changeId
    ? data.changes.find((candidate) => candidate.id === changeId) || null
    : null;
  const requestedSource = sourceId
    ? data.sources.find((source) => source.id === sourceId) || null
    : null;
  const requestedSection = publicAwardSection(section);
  if (requestedSection === "overview") return { panel: { kind: "overview" }, highlightedChangeId: null };
  if (requestedSection === "applying") return { panel: { kind: "application" }, highlightedChangeId: null };
  if (requestedSection === "updates" || (change && !requestedSection)) {
    return { panel: { kind: "changes" }, highlightedChangeId: change?.id ?? null };
  }
  if (requestedSource) {
    return {
      panel: { kind: "source", sourceId: requestedSource.id },
      highlightedChangeId: change && isChangeForSource(change, requestedSource) ? change.id : null,
    };
  }
  if (requestedSection === "sources") return { panel: { kind: "sources" }, highlightedChangeId: null };
  if (!change) return { panel: { kind: "overview" }, highlightedChangeId: null };
  const changeSource = data.sources.find((source) => isChangeForSource(change, source)) || null;
  if (changeSource) {
    return { panel: { kind: "source", sourceId: changeSource.id }, highlightedChangeId: change.id };
  }
  return { panel: { kind: "changes" }, highlightedChangeId: change.id };
}

export function awardPanelHref(path: string, panel: SelectedPanel, changeId?: string | null) {
  const section = panel.kind === "overview" ? "overview" : panel.kind === "changes" ? "updates"
    : panel.kind === "source" || panel.kind === "sources" ? "sources" : "applying";
  return publicAwardHref(path, { section, sourceId: panel.kind === "source" ? panel.sourceId : null,
    changeId: panel.kind === "changes" ? changeId : null });
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
  onClick,
  icon: Icon,
  updateCount = 0,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  icon: LucideIcon;
  updateCount?: number;
}) {
  const hasUpdate = updateCount > 0;

  return (
    <button
      aria-controls={PUBLIC_AWARD_PANEL_ID}
      aria-pressed={active}
      aria-label={[label, hasUpdate ? countLabel(updateCount, "unread update") : null].filter(Boolean).join(", ")}
      title={label}
      className={`public-award-nav-button public-award-nav-button-profile ${active ? "public-award-nav-button-active" : ""} ${hasUpdate ? "public-award-nav-button-updated" : ""}`}
      type="button"
      onClick={onClick}
    >
      <Icon className="public-award-nav-icon" size={18} aria-hidden="true" />
      <span className="public-award-nav-text">
        <strong>{label}</strong>
      </span>
      {hasUpdate && (
        <span className="public-award-update-count" aria-label={`${updateCount} unread update${updateCount === 1 ? "" : "s"}`}>
          {updateCount > 9 ? "9+" : updateCount}
        </span>
      )}
    </button>
  );
}

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
    labels: ["Application status", "Deadline", "Opening date", "Important dates"],
  },
  application: {
    title: "Eligibility & applying",
    description: "Full requirements, funding details, and application steps. Check the official source before applying.",
    labels: ["Academic level", "Discipline", "Citizenship", "Eligibility", "Requirements", "How to apply", "Application materials", "Documents", "Application links", "Selection", "Award amount", "Duration", "Application status", "Deadline", "Opening date", "Important dates", "Contact"],
  },
} as const;

export function AwardFactsPanel({ facts, awardName, section, headingId, onViewSources, factConflicts, onReviewChange }: {
  facts: PublicAwardPageData["facts"];
  awardName?: string;
  section: keyof typeof FACT_SECTIONS;
  headingId?: string;
  onViewSources: () => void;
  factConflicts?: ReadonlyMap<string, FactConflict>;
  onReviewChange?: (changeId: string) => void;
}) {
  const definition = FACT_SECTIONS[section];
  const rows = awardFactRows(facts, awardName, factConflicts);
  const sectionRows = definition.labels.flatMap((label) => rows.filter((row) => row.label === label));
  return (
    <div className="public-award-panel-stack">
      <div className="public-award-section-heading">
        <h2 id={headingId}>{definition.title}</h2>
        <p className="public-award-section-description">{definition.description}</p>
      </div>
      {sectionRows.length > 0 ? (
        section === "application" ? <ApplicationSections rows={sectionRows} onReviewChange={onReviewChange} /> : (
          <dl className="public-award-fact-table public-award-fact-table-compact">
            {sectionRows.map((fact) => <FactLine fact={fact} key={fact.label} onReviewChange={onReviewChange} />)}
          </dl>
        )
      ) : (
        <EmptyState text="These details are not available yet. Check the official sources before applying." />
      )}
      <button className="public-award-context-link" type="button" onClick={onViewSources}>
        View official sources <ArrowRight size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

const APPLICATION_GROUPS = [
  { id: "eligibility", title: "Who can apply", labels: ["Academic level", "Discipline", "Citizenship", "Eligibility", "Requirements"] },
  { id: "application", title: "Application checklist", labels: ["How to apply", "Application materials", "Documents", "Application links", "Selection"] },
  { id: "funding", title: "Funding", labels: ["Award amount", "Duration"] },
  { id: "schedule", title: "Dates & deadlines", labels: ["Application status", "Deadline", "Opening date", "Important dates"] },
  { id: "contact", title: "Contact", labels: ["Contact"] },
];

function ApplicationSections({ rows, onReviewChange }: { rows: FactRow[]; onReviewChange?: (changeId: string) => void }) {
  const groups = APPLICATION_GROUPS.map((group) => ({ ...group, rows: rows.filter((row) => group.labels.includes(row.label)) })).filter((group) => group.rows.length);
  return <>
    <nav className="public-award-facts-jumps" aria-label="Application details">
      {groups.map((group) => <a key={group.id} href={`#award-${group.id}`}>{group.title}</a>)}
    </nav>
    {groups.map((group) => <section key={group.id} id={`award-${group.id}`} className="public-award-facts-section" aria-labelledby={`award-${group.id}-heading`} tabIndex={-1}>
      <h3 id={`award-${group.id}-heading`}>{group.title}</h3>
      <dl className="public-award-fact-table public-award-fact-table-compact">
        {group.rows.map((fact) => <FactLine fact={fact} key={fact.label} onReviewChange={onReviewChange} />)}
      </dl>
    </section>)}
  </>;
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
        <h2 id={headingId}>Sources</h2>
        <p className="public-award-section-description">
          Official pages used for this award. Check dates belong to individual pages, not verification of every award detail.
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
          <p role="status">{query.trim() ? `${sources.length} of ${countLabel(data.sources.length, "source page")}` : countLabel(sources.length, "source page")}</p>
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
                  <span>{source.lastCheckedAt ? `Checked ${formatDate(source.lastCheckedAt)}` : "Check date unavailable"}</span>
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
  deadlineConflict,
  data,
  factRows,
  headingId,
  overview,
  onViewDetails,
  onViewUpdates,
}: {
  deadlineConflict?: FactConflict;
  data: PublicAwardPageData;
  factRows: FactRow[];
  headingId?: string;
  overview: string | null;
  onViewDetails: (detail?: string) => void;
  onViewUpdates: (changeId: string) => void;
}) {
  const keyFacts = factRows.filter((fact) => ["Award amount", "Academic level", "Citizenship"].includes(fact.label));
  const deadlines = presentAwardDeadlines(data.facts, data.award.name, data.presentationAsOf ? new Date(data.presentationAsOf) : undefined);
  const latestChange = data.changes[0];

  return (
    <div className="public-award-panel-stack">
      <div className="public-award-section-heading">
        <h2 id={headingId}>Overview</h2>
        {overview && <p className="public-award-section-description">{overview}</p>}
        {data.factsReviewedAt && <p className="public-award-review-date">Details reviewed {formatDate(data.factsReviewedAt)}. Recorded changes are shown separately below.</p>}
        {data.factsNeedReview && <p role="status" className="public-award-date-notice">The last approved details are shown. An official-source change or collection issue needs review; check the official source before applying.</p>}
      </div>
      <dl className="public-award-deadlines">
        <div>
          <dt>{deadlines.label}</dt>
          <dd>
            <FactConflictNotice conflict={deadlineConflict} onReviewChange={onViewUpdates} />
            {deadlines.entries.length > 0 && <ul className="public-award-deadline-list">
              {deadlines.entries.map((entry) => <li key={`${entry.label}:${entry.value}`}>
                {deadlines.entries.length > 1 && entry.label !== "Application deadline" && entry.label !== "Deadline" && <span>{entry.label}: </span>}
                <AwardDateValue value={entry.value} />
                {entry.status === "past" && <span className="public-award-past-date">Date passed</span>}
              </li>)}
            </ul>}
            {deadlines.notice && <p className="public-award-date-notice">{deadlines.notice}</p>}
          </dd>
        </div>
      </dl>
      {keyFacts.length > 0 && (
        <dl className="public-award-key-facts">
          {keyFacts.map((fact) => (
            <div className="public-award-key-fact" key={fact.label}>
              <dt>{fact.displayLabel ?? fact.label}</dt>
              <dd>
                <FactConflictNotice conflict={fact.conflict} onReviewChange={onViewUpdates} />
                {factTextLength(fact.value) <= 220 ? <FactValueDisplay className="public-award-fact-list" value={fact.value} />
                  : <button type="button" className="public-award-context-link" onClick={() => onViewDetails(fact.label === "Award amount" ? "funding" : "eligibility")}>View {fact.label === "Award amount" ? "funding details" : "full criteria"} <ArrowRight size={15} aria-hidden="true" /></button>}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {factRows.length === 0 && !overview && (
        <EmptyState text="Award details are not available yet. Check the official sources before applying." />
      )}

      <div className="public-award-overview-next">
        <p>This is a summary. Eligibility exceptions, nomination requirements and application materials are in the full details.</p>
        <button type="button" className="public-award-context-link" onClick={() => onViewDetails()}>Eligibility & applying <ArrowRight size={15} aria-hidden="true" /></button>
      </div>
      <section className="public-award-latest" aria-labelledby="award-latest-heading">
        <div className="public-award-latest-heading"><h3 id="award-latest-heading">Latest update</h3>
          {latestChange && <ChangeTimestamp value={latestChange.detectedAt} />}</div>
        {latestChange ? <>
          <ChangeSummaryDisplay summary={latestChange.summary} changeDetails={latestChange.changeDetails} sourceTitle={latestChange.sourceTitle} sourceUrl={latestChange.sourceUrl} compact />
          <button className="public-award-context-link" type="button" onClick={() => onViewUpdates(latestChange.id)}>View updates <ArrowRight size={15} aria-hidden="true" /></button>
        </> : <p>No updates are available in this view yet. This does not confirm that the official pages have stayed unchanged.</p>}
      </section>
    </div>
  );
}

function factTextLength(value: FactValue) {
  return (Array.isArray(value) ? value.join(" ") : value).length;
}

function SourcePanel({
  awardName,
  changes,
  headingId,
  highlightedChangeId,
  listedSourceNames,
  officialHomepage,
  onViewSources,
  source,
}: {
  awardName: string;
  changes: PublicAwardPageData["changes"];
  headingId?: string;
  highlightedChangeId?: string | null;
  listedSourceNames: ReadonlyMap<string, string>;
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
        listedSourceNames={listedSourceNames}
        hideSourceLink
        showHeading={false}
      />
    </div>
  );
}

function ChangesPanel({
  changes,
  emptyText = "No updates are available in this view yet.",
  headingId,
  highlightedChangeId = null,
  listedSourceNames,
  hideSourceLink = false,
  showHeading = true,
}: {
  changes: PublicAwardPageData["changes"];
  emptyText?: string;
  headingId?: string;
  highlightedChangeId?: string | null;
  listedSourceNames: ReadonlyMap<string, string>;
  hideSourceLink?: boolean;
  showHeading?: boolean;
}) {
  const isHighlighted = (change: PublicAwardChange) =>
    highlightedChangeId !== null && change.id === highlightedChangeId;

  return (
    <div className="public-award-panel-stack">
      {showHeading && (
        <div className="public-award-section-heading">
          <h2 id={headingId}>Updates</h2>
        </div>
      )}
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
                <h3>{(programChangePresentation(change.changeDetails) ?? changeSummaryPresentation(change.summary, change.sourceUrl, change.sourceTitle, change.changeDetails)).title}</h3>
                <p className="public-award-update-source">{listedSourceNames.get(change.id) ?? change.sourceTitle}</p>
                <ChangeSummaryDisplay
                  summary={change.summary}
                  changeDetails={change.changeDetails}
                  sourceTitle={change.sourceTitle}
                  sourceUrl={change.sourceUrl}
                  compact
                />
                <ChangeEvidencePanel
                  hideSourceLink={hideSourceLink}
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
      Recorded {formatDate(value)}
      <span className="sr-only"> ({stamp.full})</span>
    </time>
  );
}

function FactLine({
  fact,
  onReviewChange,
}: {
  fact: FactRow;
  onReviewChange?: (changeId: string) => void;
}) {
  return (
    <div className="public-award-fact-line">
      <dt>
        {fact.icon === "calendar" && <CalendarDays size={16} aria-hidden="true" />}
        {fact.icon === "checklist" && <ListChecks size={16} aria-hidden="true" />}
        {fact.displayLabel ?? fact.label}
      </dt>
      <dd>
        <FactConflictNotice conflict={fact.conflict} onReviewChange={onReviewChange} />
        <FactValueDisplay className="public-award-fact-list" value={fact.value} isDate={DATE_FACT_LABELS.has(fact.label)} isLink={fact.label === "Application links"} />
      </dd>
    </div>
  );
}

function FactConflictNotice({ conflict, onReviewChange }: { conflict?: FactConflict; onReviewChange?: (changeId: string) => void }) {
  if (!conflict) return null;
  return <p className="public-award-review-date" role="note">
    <strong>These details need review.</strong>{" "}
    <Link href={conflict.href} prefetch={false} onNavigate={(event) => {
      // Local panel state also changes through pushState buttons. Reusing the
      // initial Next route alone need not remount it; use the same activation.
      // Modified/new-tab clicks still follow the real href normally.
      if (onReviewChange) {
        event.preventDefault();
        onReviewChange(conflict.changeId);
      }
    }}>Review the change before using this information.</Link>
  </p>;
}

const FACT_FIELD_LABELS: Record<string, string> = {
  deadline: "Deadline", openingDate: "Opening date", awardAmount: "Award amount",
  academicLevels: "Academic level", disciplines: "Discipline", citizenship: "Citizenship",
  eligibility: "Eligibility", requirements: "Requirements", applicationMaterials: "Application materials",
  howToApply: "How to apply", importantDates: "Important dates", documents: "Documents", contacts: "Contact",
};

function factConflictLinks(notices: AwardFactCurrentnessNotice[], canonicalPath: string) {
  const links = new Map<string, FactConflict>();
  for (const notice of notices) {
    const conflict = { href: publicAwardHref(canonicalPath, { changeId: notice.changeId }), changeId: notice.changeId };
    if (notice.affectsApplicationDeadline && !links.has("Application deadlines")) {
      links.set("Application deadlines", conflict);
    }
    for (const field of notice.fields) {
      const label = FACT_FIELD_LABELS[field];
      if (label && !links.has(label)) links.set(label, conflict);
    }
  }
  return links;
}

function FactValueDisplay({
  className,
  value,
  isDate = false,
  isLink = false,
}: {
  className: string;
  value: FactValue;
  isDate?: boolean;
  isLink?: boolean;
}) {
  // An array already carries one criterion per item: reviewed facts arrive
  // whole and the legacy summary-derived fields are split before they leave
  // the normalizer. Splitting again cut a reviewed criterion that contains a
  // semicolon into two rules. A scalar keeps the existing split, so dates and
  // a single award amount render exactly as before.
  const items = Array.isArray(value)
    ? value.map((item) => item.trim()).filter(Boolean)
    : splitFactItems(value);
  const display = (item: string) => isDate ? <AwardDateValue value={item} /> : isLink ? <ApplicationDestination value={item} /> : item;
  if (items.length <= 1) return <>{display(items[0] || "")}</>;

  return (
    <ul className={className}>
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{display(item)}</li>
      ))}
    </ul>
  );
}

function ApplicationDestination({ value }: { value: string }) {
  const match = /^(?:(.{1,200}): )?(https:\/\/\S+)$/.exec(value);
  if (!match) return <>{value}</>;
  try {
    const url = new URL(match[2]);
    if (url.protocol !== "https:" || url.username || url.password) return <>{value}</>;
    return <a href={url.href} target="_blank" rel="noopener noreferrer">{match[1] ? `${match[1]} — ` : ""}Official application <ExternalLink size={13} aria-hidden="true" /></a>;
  } catch { return <>{value}</>; }
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="public-award-empty">
      <FileText size={20} aria-hidden="true" />
      {text}
    </div>
  );
}

function awardFactRows(facts: PublicAwardPageData["facts"], awardName?: string, conflicts?: ReadonlyMap<string, FactConflict>): FactRow[] {
  const deadline = presentAwardDateField(facts.deadline, awardName);
  const opening = presentAwardDateField(facts.openingDate, awardName, "Opening date");
  const rows: MaybeFactRow[] = [
    // Date facts render in the house style; every other reviewed value, and
    // any wording this helper does not recognise, is left exactly as reviewed.
    { label: "Deadline", displayLabel: deadline.label, value: deadline.value, icon: "calendar" as const },
    { label: "Opening date", displayLabel: opening.label, value: opening.value },
    { label: "Application status", value: facts.cycleStatus || null },
    { label: "Award amount", value: facts.awardAmount },
    { label: "Duration", value: compactList(facts.tenure || []) },
    { label: "Academic level", value: compactList(facts.academicLevels) },
    { label: "Discipline", value: compactList(facts.disciplines) },
    { label: "Citizenship", value: compactList(facts.citizenship) },
    { label: "Eligibility", value: compactList(facts.eligibility) },
    // The editorial policy defines `requirements` as "what must be true of my
    // application" (self-checkable conditions), so the row carries that name.
    { label: "Requirements", value: compactList(facts.requirements) },
    { label: "Application materials", value: compactList(facts.applicationMaterials), icon: "checklist" as const },
    { label: "How to apply", value: compactList(facts.howToApply) },
    { label: "Application links", value: compactList(facts.applicationUrls || []) },
    { label: "Selection", value: compactList(facts.selection || []) },
    { label: "Important dates", value: compactList(facts.importantDates.flatMap(splitFactItems).map((value) => presentAwardTimelineDate(value, awardName))) },
    { label: "Documents", value: compactList(facts.documents) },
    { label: "Contact", value: compactList(facts.contacts) },
  ];

  return rows.filter(isFactRow).map((row) => ({ ...row, conflict: conflicts?.get(row.label) }));
}

function compactList(values: string[]) {
  // Every reviewed item renders; the review, not a display cap, bounds the
  // list. The normalizer decides where one criterion ends, so the item
  // boundaries it produced are kept, blank entries aside. The array shape is
  // kept even for a single item, which the display renders as plain text, so
  // that one criterion cannot be re-split on its way through the scalar path.
  const clean = values.map((value) => value.trim()).filter(Boolean);
  return clean.length === 0 ? null : clean;
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
  if (source.pageType === "homepage" || isOfficialHomepage) {
    return "Homepage";
  }
  // A title that is exactly the award name names the program, not the page, so
  // it cannot tell one document from another, and a page that is neither the
  // homepage nor typed as one must not be called the homepage. Its address is
  // what is left to identify it, read here by the same helper the rest of the
  // app uses, including that helper's generic label for an unusable address.
  if (cleanTitle.toLowerCase() === awardName.toLowerCase()) {
    const derivedTitle = readableSourceTitle(null, source.url);
    return compactSourceDisplayTitle(derivedTitle === "Homepage" ? "Source" : derivedTitle, true);
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
    .replace(/^admissions$/i, "Admissions")
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

// Index lookup uses exactly the existing document-address comparison. Only
// legacy changes without a retained source ID may use this fallback.
function uniqueDocumentSourceId(idsByDocumentKey: ReadonlyMap<string, string[]>, sourceUrl: string) {
  const documentKey = sourceDocumentUrlKey(sourceUrl);
  const sourceIds = documentKey === null ? undefined : idsByDocumentKey.get(documentKey);
  return sourceIds?.length === 1 ? sourceIds[0] : null;
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
