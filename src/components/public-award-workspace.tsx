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
import { ChangeEvidencePanel } from "@/components/change-evidence-panel";

type PublicAwardWorkspaceProps = {
  data: PublicAwardPageData;
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

export function PublicAwardWorkspace({ data }: PublicAwardWorkspaceProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selected, setSelected] = useState<SelectedPanel>({ kind: "overview" });
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
            <div className="award-detail-meta-line">
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
              changes={selectedSourceChanges}
              source={selectedSource}
            />
          )}
        </section>
      </main>
    </div>
  );
}

function SourceOutlineButton({
  awardName,
  onSelectSource,
  selected,
  source,
  sourceUnreadCount,
}: {
  awardName: string;
  onSelectSource: (sourceId: string) => void;
  selected: SelectedPanel;
  source: PublicAwardSource;
  sourceUnreadCount: number;
}) {
  return (
    <PanelButton
      active={selected.kind === "source" && selected.sourceId === source.id}
      label={sourceDisplayTitle(source, awardName)}
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
        <span className="public-award-update-count" aria-label="Recent updates" />
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
  changes,
  source,
}: {
  changes: PublicAwardPageData["changes"];
  source: PublicAwardPageData["sources"][number];
}) {
  const factRows = sourceFactRows(source.facts);

  return (
    <div className="public-award-panel-stack">
      <div className="public-award-source-detail-heading">
        <div>
          {sourceTags(source).map((tag) => (
            <span className="badge" key={tag}>{tag}</span>
          ))}
          <h2>{source.title}</h2>
          {source.description && <p>{source.description}</p>}
        </div>
        <div className="public-award-console-actions">
          <a className="button-primary" href={source.url} rel="noreferrer" target="_blank">
            Official source
            <ExternalLink size={15} aria-hidden="true" />
          </a>
        </div>
      </div>

      {factRows.length > 0 ? (
        <div className="public-award-fact-table">
          {factRows.slice(0, 6).map((fact) => (
            <FactLine fact={fact} key={fact.label} />
          ))}
        </div>
      ) : (
        <EmptyState text="No structured details have been extracted from this source page yet." />
      )}

      <ChangesPanel changes={changes} title="Recent changes on this page" />
    </div>
  );
}

function ChangesPanel({
  changes,
  title = "Recent changes",
}: {
  changes: PublicAwardPageData["changes"];
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
                <ChangeEvidencePanel
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
        <EmptyState text="No meaningful updates have been recorded yet." />
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

function sourceFactRows(facts: PublicAwardPageData["facts"]): FactRow[] {
  const rows: MaybeFactRow[] = [
    { label: "Deadline", value: facts.deadline, icon: "calendar" as const },
    { label: "Award amount", value: facts.awardAmount },
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

function sourceDisplayTitle(source: PublicAwardSource, awardName: string) {
  const cleanTitle = source.title.replace(/\s+/g, " ").trim();
  if (
    source.pageType === "homepage" &&
    (!cleanTitle || /^(homepage|home|source page|official homepage|official page)$/i.test(cleanTitle))
  ) {
    return "Award homepage";
  }
  if (cleanTitle && cleanTitle.toLowerCase() !== awardName.toLowerCase()) return cleanTitle;
  return source.pageType === "homepage" ? "Award homepage" : cleanTitle || "Source page";
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
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function countLabel(count: number, singular: string) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
