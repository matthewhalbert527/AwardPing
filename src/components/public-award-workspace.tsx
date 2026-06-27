"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  ChevronDown,
  ExternalLink,
  FileText,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { pageTypeLabel } from "@/lib/award-discovery-types";
import type { PublicAwardPageData } from "@/lib/public-award-pages";

type PublicAwardWorkspaceProps = {
  data: PublicAwardPageData;
  initialSourceId?: string | null;
};

type SelectedPanel =
  | { kind: "overview" }
  | { kind: "facts" }
  | { kind: "changes" }
  | { kind: "source"; sourceId: string };

export function PublicAwardWorkspace({
  data,
  initialSourceId = null,
}: PublicAwardWorkspaceProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selected, setSelected] = useState<SelectedPanel>(() =>
    initialSourceId ? { kind: "source", sourceId: initialSourceId } : { kind: "overview" },
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
  const selectedTitle =
    selected.kind === "overview"
      ? "Award overview"
      : selected.kind === "facts"
        ? "Key details"
        : selected.kind === "changes"
          ? "Recent changes"
          : selectedSource?.title || "Source page";
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
  const factRows = awardFactRows(data.facts);

  return (
    <div className={`public-award-console ${sidebarOpen ? "" : "public-award-console-collapsed"}`}>
      <aside className="public-award-sidebar" aria-label={`${data.award.name} page outline`}>
        <div className="public-award-sidebar-header">
          <div className="min-w-0">
            <p>Award outline</p>
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

        <div className="public-award-sidebar-card public-award-sidebar-page-card">
          <ListChecks size={24} aria-hidden="true" />
          <strong>Page outline</strong>
        </div>

        <details className="public-award-nav-group" open>
          <summary>
            <ChevronDown size={15} aria-hidden="true" />
            <span>Award profile</span>
          </summary>
          <div className="public-award-nav-list">
            <PanelButton
              active={selected.kind === "overview"}
              label="Overview"
              meta={countLabel(data.sources.length, "source")}
              onClick={() => setSelected({ kind: "overview" })}
            />
            <PanelButton
              active={selected.kind === "facts"}
              label="Key details"
              meta={countLabel(factRows.length, "field")}
              onClick={() => setSelected({ kind: "facts" })}
            />
            <PanelButton
              active={selected.kind === "changes"}
              label="Recent changes"
              meta={countLabel(data.changes.length, "update")}
              onClick={() => setSelected({ kind: "changes" })}
              updateCount={data.changes.length}
            />
          </div>
        </details>

        <details className="public-award-nav-group" open>
          <summary>
            <ChevronDown size={15} aria-hidden="true" />
            <span>Official sources</span>
          </summary>
          <div className="public-award-nav-list">
            {data.sources.map((source) => {
              const changeCount = sourceChangeCounts.get(source.id) || 0;
              return (
                <PanelButton
                  active={selected.kind === "source" && selected.sourceId === source.id}
                  key={source.id}
                  label={source.title}
                  meta={`${pageTypeLabel(source.pageType)} / ${countLabel(changeCount, "update")}`}
                  onClick={() => setSelected({ kind: "source", sourceId: source.id })}
                  updateCount={changeCount}
                  variant="source"
                />
              );
            })}
          </div>
        </details>

        <div className="public-award-sidebar-card public-award-sidebar-last-checked">
          <span>Last checked</span>
          <strong>{data.lastCheckedAt ? formatDate(data.lastCheckedAt) : "Pending"}</strong>
        </div>
      </aside>

      <main className="public-award-console-main">
        <div className="public-award-console-breadcrumb">
          <Link href="/award-directory" prefetch={false}>Award Directory</Link>
          <span>/</span>
          <Link href={data.canonicalPath}>{data.award.name}</Link>
          <span>/</span>
          <strong>{selectedTitle}</strong>
        </div>

        <header className="public-award-console-header">
          <div>
            <div className="award-detail-meta-line">
              <span>{data.sources.length} source pages</span>
              <span>{data.changes.length} recent updates</span>
              {data.facts.confidence && <span>{data.facts.confidence} confidence</span>}
            </div>
            <h1>{data.award.name}</h1>
            {data.facts.overview && <p>{data.facts.overview}</p>}
          </div>
          <div className="public-award-console-actions">
            <Link className="button-primary" href="/signup">
              Add to watchlist
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
            {data.officialHomepage && (
              <a className="button-secondary" href={data.officialHomepage} rel="noreferrer" target="_blank">
                <ExternalLink size={15} aria-hidden="true" />
                Official homepage
              </a>
            )}
          </div>
        </header>

        <section className="public-award-overview-strip" aria-label="Award summary">
          <Metric label="Deadline" value={data.facts.deadline || "Not listed"} />
          <Metric label="Award amount" value={data.facts.awardAmount || "Not listed"} />
          <Metric label="Last checked" value={data.lastCheckedAt ? formatDate(data.lastCheckedAt) : "Pending"} />
        </section>

        <section className="public-award-console-panel">
          {selected.kind === "overview" && (
            <OverviewPanel data={data} factRows={factRows} sourceChangeCounts={sourceChangeCounts} />
          )}
          {selected.kind === "facts" && <FactsPanel rows={factRows} />}
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

function PanelButton({
  active,
  label,
  meta,
  onClick,
  updateCount = 0,
  variant = "profile",
}: {
  active: boolean;
  label: string;
  meta: string;
  onClick: () => void;
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
        <small>{meta}</small>
      </span>
      {hasUpdate && (
        <span className="public-award-update-count" aria-label="Recent updates" />
      )}
    </button>
  );
}

function OverviewPanel({
  data,
  factRows,
  sourceChangeCounts,
}: {
  data: PublicAwardPageData;
  factRows: Array<{ label: string; value: string; icon?: "calendar" | "checklist" }>;
  sourceChangeCounts: Map<string, number>;
}) {
  return (
    <div className="public-award-panel-stack">
      <div className="public-award-section-heading">
        <h2>Overview</h2>
      </div>

      <div className="public-award-fact-table public-award-fact-table-compact">
        {factRows.slice(0, 5).map((fact) => (
          <FactLine fact={fact} key={fact.label} />
        ))}
      </div>

      <div className="public-award-source-table">
        <div className="public-award-table-heading">
          <h3>Official source pages</h3>
          <span>{data.sources.length} tracked</span>
        </div>
        {data.sources.slice(0, 6).map((source) => {
          const changes = sourceChangeCounts.get(source.id) || 0;
          return (
            <article className={changes ? "public-award-source-line public-award-source-line-updated" : "public-award-source-line"} key={source.id}>
              <div>
                <span>{pageTypeLabel(source.pageType)}</span>
                <h4>
                  <Link href={source.publicPath}>{source.title}</Link>
                </h4>
              </div>
              <strong>{changes ? `${changes} updates` : "Stable"}</strong>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function FactsPanel({
  rows,
}: {
  rows: Array<{ label: string; value: string; icon?: "calendar" | "checklist" }>;
}) {
  return (
    <div className="public-award-panel-stack">
      <div className="public-award-section-heading">
        <h2>Key details</h2>
      </div>
      <div className="public-award-fact-table">
        {rows.map((fact) => (
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
          <span className="badge">{pageTypeLabel(source.pageType)}</span>
          <h2>{source.title}</h2>
          {source.description && <p>{source.description}</p>}
        </div>
        <div className="public-award-console-actions">
          <a className="button-primary" href={source.url} rel="noreferrer" target="_blank">
            Official source
            <ExternalLink size={15} aria-hidden="true" />
          </a>
          <Link className="button-secondary" href={source.publicPath}>
            Source page
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="public-award-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function FactLine({
  fact,
}: {
  fact: { label: string; value: string; icon?: "calendar" | "checklist" };
}) {
  return (
    <div className="public-award-fact-line">
      <dt>
        {fact.icon === "calendar" && <CalendarDays size={16} aria-hidden="true" />}
        {fact.icon === "checklist" && <ListChecks size={16} aria-hidden="true" />}
        {fact.label}
      </dt>
      <dd>{fact.value}</dd>
    </div>
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

function awardFactRows(facts: PublicAwardPageData["facts"]) {
  return [
    { label: "Deadline", value: facts.deadline, icon: "calendar" as const },
    { label: "Opening date", value: facts.openingDate },
    { label: "Award amount", value: facts.awardAmount },
    { label: "Academic level", value: compactList(facts.academicLevels) },
    { label: "Discipline", value: compactList(facts.disciplines) },
    { label: "Citizenship", value: compactList(facts.citizenship) },
    { label: "Eligibility", value: compactList(facts.eligibility) },
    { label: "Requirements", value: compactList(facts.requirements) },
    { label: "Application materials", value: compactList(facts.applicationMaterials), icon: "checklist" as const },
    { label: "How to apply", value: compactList(facts.howToApply) },
    { label: "Important dates", value: compactList(facts.importantDates) },
    { label: "Documents", value: compactList(facts.documents) },
    { label: "Contact", value: compactList(facts.contacts) },
  ].filter((row): row is { label: string; value: string; icon?: "calendar" | "checklist" } =>
    Boolean(row.value),
  );
}

function sourceFactRows(facts: PublicAwardPageData["facts"]) {
  return [
    { label: "Deadline", value: facts.deadline, icon: "calendar" as const },
    { label: "Award amount", value: facts.awardAmount },
    { label: "Eligibility", value: compactList(facts.eligibility) },
    { label: "Requirements", value: compactList(facts.requirements) },
    { label: "Application materials", value: compactList(facts.applicationMaterials), icon: "checklist" as const },
    { label: "How to apply", value: compactList(facts.howToApply) },
    { label: "Important dates", value: compactList(facts.importantDates) },
    { label: "Documents", value: compactList(facts.documents) },
    { label: "Contact", value: compactList(facts.contacts) },
  ].filter((row): row is { label: string; value: string; icon?: "calendar" | "checklist" } =>
    Boolean(row.value),
  );
}

function compactList(values: string[]) {
  return values.filter(Boolean).slice(0, 6).join("; ");
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
