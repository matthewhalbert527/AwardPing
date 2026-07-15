"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  ExternalLink,
  FileText,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { pageTypeLabel } from "@/lib/award-discovery-types";
import type { PublicAwardPageData } from "@/lib/public-award-pages";
import { formatCentralDate } from "@/lib/time-zone";
import { ChangeEvidencePanel } from "@/components/change-evidence-panel";
import { SourceSnapshotInlinePreview } from "@/components/source-snapshot-viewer";

type PublicAwardWorkspaceProps = {
  data: PublicAwardPageData;
  initialChangeId?: string | null;
  initialSourceId?: string | null;
};

type SelectedPanel =
  | { kind: "overview" }
  | { kind: "changes" }
  | { kind: "source"; sourceId: string };

type PublicAwardSource = PublicAwardPageData["sources"][number];
type PublicAwardChange = PublicAwardPageData["changes"][number];
type FactValue = string | string[];
type FactRow = { label: string; value: FactValue; icon?: "calendar" | "checklist" };
type MaybeFactRow = { label: string; value: FactValue | null; icon?: "calendar" | "checklist" };

const MAX_VISIBLE_SIDEBAR_SOURCES = 10;

export function PublicAwardWorkspace({
  data,
  initialChangeId,
  initialSourceId,
}: PublicAwardWorkspaceProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const initialSelectedSourceId = initialSourceIdForQuery(data, initialSourceId, initialChangeId);
  const [selected, setSelected] = useState<SelectedPanel>(() =>
    initialSelectedSourceId ? { kind: "source", sourceId: initialSelectedSourceId } : { kind: "overview" },
  );
  const [readChangeIds, setReadChangeIds] = useState<Set<string>>(
    () => new Set(data.changes.filter((change) => change.unread === false).map((change) => change.id)),
  );
  const selectedSource =
    selected.kind === "source"
      ? data.sources.find((source) => source.id === selected.sourceId) || null
      : null;
  const selectedSourceChanges = selectedSource
    ? data.changes.filter(
        (change) =>
          change.sourceId === selectedSource.id ||
          normalizeUrl(change.sourceUrl) === normalizeUrl(selectedSource.url),
      )
    : [];
  const sourceChangeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of data.sources) {
      counts.set(
        source.id,
        data.changes.filter(
          (change) =>
            change.sourceId === source.id ||
            normalizeUrl(change.sourceUrl) === normalizeUrl(source.url),
        ).length,
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
  const sourceOutline = useMemo(
    () =>
      visibleSourcesForSidebar(
        data.sources,
        data.award.name,
        sourceChangeCounts,
        sourceUnreadCounts,
      ),
    [data.award.name, data.sources, sourceChangeCounts, sourceUnreadCounts],
  );
  const unreadChangeCount = useMemo(
    () => data.changes.filter((change) => isUnreadChange(change, readChangeIds)).length,
    [data.changes, readChangeIds],
  );
  const factRows = awardFactRows(data.facts);
  const markChangesRead = (changeIds: string[]) => {
    const uniqueIds = [...new Set(changeIds)].filter(Boolean);
    if (uniqueIds.length === 0) return;
    setReadChangeIds((current) => new Set([...current, ...uniqueIds]));
    postReadChangeIds(uniqueIds);
  };
  const selectSource = (sourceId: string) => {
    const source = data.sources.find((candidate) => candidate.id === sourceId);
    if (!source) return;
    markChangesRead(
      data.changes
        .filter((change) => isChangeForSource(change, source) && isUnreadChange(change, readChangeIds))
        .map((change) => change.id),
    );
    setSelected({ kind: "source", sourceId });
  };
  const selectChanges = () => {
    markChangesRead(
      data.changes
        .filter((change) => isUnreadChange(change, readChangeIds))
        .map((change) => change.id),
    );
    setSelected({ kind: "changes" });
  };

  return (
    <div className={`public-award-console ${sidebarOpen ? "" : "public-award-console-collapsed"}`}>
      <aside className="public-award-sidebar" aria-label={`${data.award.name} page outline`}>
        <div className="public-award-sidebar-header">
          <div className="min-w-0">
            <p>Award outline</p>
            <span>{data.lastCheckedAt ? `Checked ${formatDate(data.lastCheckedAt)}` : "Check pending"}</span>
          </div>
          <button
            aria-label={sidebarOpen ? "Collapse page outline" : "Expand page outline"}
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

        <div className="public-award-nav-section" aria-label="Award profile">
          <p className="public-award-nav-heading">Award profile</p>
          <PanelButton
            active={selected.kind === "overview"}
            label="Overview"
            meta={countLabel(factRows.length, "field")}
            onClick={() => setSelected({ kind: "overview" })}
          />
          <PanelButton
            active={selected.kind === "changes"}
            label="Recent changes"
            meta={countLabel(data.changes.length, "update")}
            onClick={selectChanges}
            updateCount={unreadChangeCount}
          />
        </div>

        {sourceOutline.sources.length > 0 && (
          <div className="public-award-nav-section" aria-label="Official sources">
            <p className="public-award-nav-heading">Sources</p>
            <div className="public-award-source-sublist public-award-source-flat-list">
              {sourceOutline.visibleSources.map((source) => (
                <SourceOutlineButton
                  key={source.id}
                  awardName={data.award.name}
                  officialHomepage={data.officialHomepage}
                  onSelectSource={selectSource}
                  selected={selected}
                  source={source}
                  sourceUnreadCount={sourceUnreadCounts.get(source.id) || 0}
                />
              ))}
              {sourceOutline.hiddenSourceCount > 0 && (
                <div className="public-award-source-overflow-note">
                  {countLabel(sourceOutline.hiddenSourceCount, "more tracked page")}
                </div>
              )}
            </div>
          </div>
        )}
      </aside>

      <main className="public-award-console-main">
        <header className="public-award-console-header">
          <div>
            <h1>{data.award.name}</h1>
            <div className="public-award-meta-line">
              <span>{data.sources.length} source pages</span>
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
            <Link className="button-primary" href="/signup">
              Add to watchlist
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </header>

        <section className="public-award-console-panel">
          {selected.kind === "overview" && (
            <OverviewPanel
              factRows={factRows}
            />
          )}
          {selected.kind === "changes" && <ChangesPanel changes={data.changes} />}
          {selected.kind === "source" && selectedSource && (
            <SourcePanel
              awardName={data.award.name}
              changes={selectedSourceChanges}
              officialHomepage={data.officialHomepage}
              source={selectedSource}
            />
          )}
        </section>
      </main>
    </div>
  );
}

function initialSourceIdForQuery(
  data: PublicAwardPageData,
  sourceId?: string | null,
  changeId?: string | null,
) {
  if (sourceId && data.sources.some((source) => source.id === sourceId)) {
    return sourceId;
  }

  if (!changeId) return null;
  const change = data.changes.find((candidate) => candidate.id === changeId);
  if (!change?.sourceId) return null;
  return data.sources.some((source) => source.id === change.sourceId) ? change.sourceId : null;
}

function SourceOutlineButton({
  awardName,
  officialHomepage,
  onSelectSource,
  selected,
  source,
  sourceUnreadCount,
}: {
  awardName: string;
  officialHomepage?: string | null;
  onSelectSource: (sourceId: string) => void;
  selected: SelectedPanel;
  source: PublicAwardSource;
  sourceUnreadCount: number;
}) {
  return (
    <PanelButton
      active={selected.kind === "source" && selected.sourceId === source.id}
      label={sourceDisplayTitle(source, awardName, officialHomepage)}
      onClick={() => onSelectSource(source.id)}
      tags={sourceTags(source)}
      updateCount={sourceUnreadCount}
      variant="source"
    />
  );
}

function PanelButton({
  active,
  label,
  meta,
  onClick,
  tags = [],
  updateCount = 0,
  variant = "profile",
}: {
  active: boolean;
  label: string;
  meta?: string | null;
  onClick: () => void;
  tags?: string[];
  updateCount?: number;
  variant?: "profile" | "source";
}) {
  const hasUpdate = updateCount > 0;

  return (
    <button
      className={`public-award-nav-button public-award-nav-button-${variant} ${active ? "public-award-nav-button-active" : ""} ${hasUpdate ? "public-award-nav-button-updated" : ""}`}
      type="button"
      onClick={onClick}
    >
      <span className="public-award-nav-marker" aria-hidden="true" />
      <span className="public-award-nav-text">
        <strong>{label}</strong>
        {(meta || tags.length > 0) && (
          <small>
            {meta}
            {tags.length > 0 && (
              <span className="public-award-nav-tags">
                {tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </span>
            )}
          </small>
        )}
      </span>
      {hasUpdate && (
        <span className="public-award-update-count" aria-label={`${updateCount} unread update${updateCount === 1 ? "" : "s"}`}>
          {updateCount > 9 ? "9+" : updateCount}
        </span>
      )}
    </button>
  );
}

function OverviewPanel({
  factRows,
}: {
  factRows: FactRow[];
}) {
  return (
    <div className="public-award-panel-stack">
      <div className="public-award-section-heading">
        <h2>Overview</h2>
      </div>

      <div className="public-award-fact-table public-award-fact-table-compact">
        {factRows.map((fact) => (
          <FactLine fact={fact} key={fact.label} />
        ))}
      </div>
    </div>
  );
}

function SourcePanel({
  awardName,
  changes,
  officialHomepage,
  source,
}: {
  awardName: string;
  changes: PublicAwardPageData["changes"];
  officialHomepage?: string | null;
  source: PublicAwardPageData["sources"][number];
}) {
  const displayTitle = sourceDisplayTitle(source, awardName, officialHomepage);

  return (
    <div className="public-award-panel-stack">
      <div className="public-award-source-detail-heading">
        <div>
          {sourceTags(source).map((tag) => (
            <span className="badge" key={tag}>{tag}</span>
          ))}
          <h2>{displayTitle}</h2>
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
        emptyText="No meaningful updates have been recorded for this source yet."
        showSnapshotPreviews
        sourceIdFallback={source.id}
        title="Source update history"
      />
    </div>
  );
}

function ChangesPanel({
  changes,
  emptyText = "No meaningful updates have been recorded yet.",
  showSnapshotPreviews = false,
  sourceIdFallback,
  title = "Recent changes",
}: {
  changes: PublicAwardPageData["changes"];
  emptyText?: string;
  showSnapshotPreviews?: boolean;
  sourceIdFallback?: string | null;
  title?: string;
}) {
  return (
    <div className="public-award-panel-stack">
      <div className="public-award-section-heading">
        <h2>{title}</h2>
      </div>
      {changes.length > 0 ? (
        <div className="public-award-change-table">
          {changes.map((change) => (
            <article className="public-award-change-line" key={change.id}>
              <time>{formatDate(change.detectedAt)}</time>
              <div>
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
        {fact.label}
      </dt>
      <dd>
        <FactValueDisplay className="public-award-fact-list" value={fact.value} />
      </dd>
    </div>
  );
}

function FactValueDisplay({
  className,
  value,
}: {
  className: string;
  value: FactValue;
}) {
  const items = Array.isArray(value) ? value.flatMap(splitFactItems) : splitFactItems(value);
  if (items.length <= 1) return <>{items[0] || ""}</>;

  return (
    <ul className={className}>
      {items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
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

function awardFactRows(facts: PublicAwardPageData["facts"]): FactRow[] {
  const rows: MaybeFactRow[] = [
    { label: "Deadline", value: facts.deadline, icon: "calendar" as const },
    { label: "Opening date", value: facts.openingDate },
    { label: "Award amount", value: facts.awardAmount },
    { label: "Academic level", value: compactList(facts.academicLevels) },
    { label: "Discipline", value: compactList(facts.disciplines) },
    { label: "Citizenship", value: compactList(facts.citizenship) },
    { label: "Eligibility", value: compactList(facts.eligibility) },
    { label: "Award conditions", value: compactList(facts.requirements) },
    { label: "Application materials", value: compactList(facts.applicationMaterials), icon: "checklist" as const },
    { label: "How to apply", value: compactList(facts.howToApply) },
    { label: "Important dates", value: compactList(facts.importantDates) },
    { label: "Documents", value: compactList(facts.documents) },
    { label: "Contact", value: compactList(facts.contacts) },
  ];

  return rows.filter(isFactRow);
}

function compactList(values: string[]) {
  const clean = values.flatMap(splitFactItems).slice(0, 6);
  if (clean.length === 0) return null;
  return clean.length === 1 ? clean[0] : clean;
}

function splitFactItems(value: string) {
  return value.split(/\s*;\s*/).map((item) => item.trim()).filter(Boolean);
}

function isFactRow(row: MaybeFactRow): row is FactRow {
  return Array.isArray(row.value) ? row.value.length > 0 : Boolean(row.value);
}

function visibleSourcesForSidebar(
  sources: PublicAwardSource[],
  awardName: string,
  sourceChangeCounts: Map<string, number>,
  sourceUnreadCounts: Map<string, number>,
) {
  const awardTokens = distinctiveAwardTokens(awardName);
  const sortedSources = [...sources].sort((a, b) =>
    sourceOutlineSortKey(a, awardTokens).localeCompare(sourceOutlineSortKey(b, awardTokens)),
  );

  if (sortedSources.length <= MAX_VISIBLE_SIDEBAR_SOURCES) {
    return { sources: sortedSources, visibleSources: sortedSources, hiddenSourceCount: 0 };
  }

  const updatedSources = sortedSources.filter((source) =>
    hasSourceUpdate(source, sourceChangeCounts, sourceUnreadCounts),
  );
  const selected = new Map(updatedSources.map((source) => [source.id, source]));

  for (const source of sortedSources) {
    if (selected.size >= Math.max(MAX_VISIBLE_SIDEBAR_SOURCES, updatedSources.length)) break;
    selected.set(source.id, source);
  }

  const visibleSources = [
    ...updatedSources,
    ...sortedSources.filter(
      (source) => selected.has(source.id) && !hasSourceUpdate(source, sourceChangeCounts, sourceUnreadCounts),
    ),
  ];

  return {
    sources: sortedSources,
    visibleSources,
    hiddenSourceCount: sortedSources.length - visibleSources.length,
  };
}

function searchableSourceText(source: PublicAwardSource) {
  const facts = source.facts;
  return [
    source.title,
    source.description,
    source.url,
    facts.deadline,
    facts.openingDate,
    facts.awardAmount,
    ...facts.academicLevels,
    ...facts.disciplines,
    ...facts.citizenship,
    ...facts.eligibility,
    ...facts.requirements,
    ...facts.applicationMaterials,
    ...facts.howToApply,
    ...facts.importantDates,
    ...facts.documents,
    ...facts.contacts,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function hasSourceUpdate(
  source: PublicAwardSource,
  sourceChangeCounts: Map<string, number>,
  sourceUnreadCounts: Map<string, number>,
) {
  return (sourceUnreadCounts.get(source.id) || 0) > 0 || (sourceChangeCounts.get(source.id) || 0) > 0;
}

function sourceOutlineSortKey(source: PublicAwardSource, awardTokens: string[]) {
  return `${sourceOutlinePriority(source, awardTokens)}:${sourceSortLabel(source)}`;
}

function sourceOutlinePriority(source: PublicAwardSource, awardTokens: string[]) {
  const text = searchableSourceText(source);
  if (source.pageType === "homepage") return 0;
  if (sourceMatchesAwardTokens(text, awardTokens)) return 1;
  if (isNoisyOutlineSource(source, text, awardTokens)) return 9;
  if (/\b(named scholarship|scholarship|fellowship|grant|award|funding)\b/.test(text)) return 2;
  if (/\b(application guide|how to apply|when to apply|deadline|eligib|requirement|supporting documents)\b/.test(text)) {
    return 3;
  }
  if (source.pageType && source.pageType !== "other") return 4;
  return 5;
}

function isNoisyOutlineSource(source: PublicAwardSource, text: string, awardTokens: string[]) {
  const title = source.title.toLowerCase();
  const url = safeUrl(source.url);
  const host = url?.hostname.toLowerCase().replace(/^www\./, "") || "";
  const path = url?.pathname.toLowerCase() || "";

  if (/^\d{4}-\d{4}\s*-\s*vol\s+\d+\b/.test(title)) return true;
  if (/\b(charred grains?|administrative and private documents|journal of record|public statistics|sitemap)\b/.test(title)) {
    return true;
  }
  if (host === "portal.sds.ox.ac.uk") {
    if (/^\/(?:browse|groups|stats|sitemap|gazette|authors)(?:\/|$)/.test(path)) return true;
    if (/^\/search(?:\/|$)/.test(path)) return true;
    if (
      /^\/articles\/(?:figure|online_resource)\//.test(path) &&
      !sourceMatchesAwardTokens(text, awardTokens) &&
      !/\b(scholarship|fellowship|grant|award|funding|deadline|eligib)\b/.test(text)
    ) {
      return true;
    }
  }
  return false;
}

function sourceMatchesAwardTokens(text: string, awardTokens: string[]) {
  if (awardTokens.length === 0) return false;
  const matches = awardTokens.filter((token) => new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(text));
  return matches.length >= Math.min(2, awardTokens.length);
}

function distinctiveAwardTokens(value: string) {
  const generic = new Set([
    "award",
    "awards",
    "fellow",
    "fellowship",
    "fellowships",
    "foundation",
    "graduate",
    "program",
    "programme",
    "scholar",
    "scholars",
    "scholarship",
    "scholarships",
    "student",
    "students",
    "university",
  ]);
  return [
    ...new Set(
      (value.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
        (token) => token.length >= 4 && !generic.has(token),
      ),
    ),
  ].slice(0, 8);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceSortLabel(source: PublicAwardSource) {
  const pageTypeRank = source.pageType === "homepage" ? "0" : "1";
  return `${pageTypeRank}:${source.title.toLowerCase()}:${source.url.toLowerCase()}`;
}

function sourceTags(source: PublicAwardSource) {
  return source.pageType === "pdf" ? ["PDF"] : [];
}

function sourceDisplayTitle(source: PublicAwardSource, awardName: string, officialHomepage?: string | null) {
  const cleanTitle = source.title.replace(/\s+/g, " ").trim();
  const isOfficialHomepage =
    Boolean(officialHomepage) && normalizeUrl(source.url) === normalizeUrl(officialHomepage);
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

function safeUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isChangeForSource(change: PublicAwardChange, source: PublicAwardSource) {
  return change.sourceId === source.id || normalizeUrl(change.sourceUrl) === normalizeUrl(source.url);
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

function normalizeUrl(value: string | null | undefined) {
  try {
    const url = new URL(value || "");
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString().toLowerCase();
  } catch {
    return String(value || "").trim().toLowerCase();
  }
}

function formatDate(value: string) {
  return formatCentralDate(value);
}

function countLabel(count: number, singular: string) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
