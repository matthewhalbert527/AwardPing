"use client";

import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import {
  BellOff,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  ExternalLink,
  FolderTree,
  Play,
} from "lucide-react";
import { ChangeEvidencePanel } from "@/components/change-evidence-panel";
import { ChangeSummaryDisplay } from "@/components/change-summary-display";
import { SourceSnapshotViewerButton } from "@/components/source-snapshot-viewer";
import { pageTypeLabel, type AwardPageType } from "@/lib/award-discovery-types";
import { readableSourceTitle } from "@/lib/display-text";
import { buildSourceTree, type SourceTreeNode, type SourceTreeSource } from "@/lib/source-tree";

export type SourcePageTreeChange = {
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

export type SourcePageTreeSource = SourceTreeSource & {
  sharedAwardSourceId?: string | null;
  monitorId?: string | null;
  displayTitle?: string | null;
  pageDescription?: string | null;
  pageMetadata?: unknown;
  pageMetadataGeneratedAt?: string | null;
  pageMetadataModel?: string | null;
  pageType: AwardPageType | null;
  status?: "active" | "paused" | "error" | "untracked";
  cadence?: string | null;
  tracked?: boolean;
  lastCheckedAt?: string | null;
  lastError?: string | null;
  latestChanges?: SourcePageTreeChange[];
};

export function SourcePageTree<T extends SourcePageTreeSource>({
  sources,
  canManage = false,
  emptyMessage = "No source pages have been added yet.",
  busyId = null,
  getSourceTracked = defaultTracked,
  onTrackSources,
  onUntrackSources,
  renderSourceActions,
  showSnapshotActions = true,
}: {
  sources: T[];
  canManage?: boolean;
  emptyMessage?: string;
  busyId?: string | null;
  getSourceTracked?: (source: T) => boolean;
  onTrackSources?: (sources: T[], label: string, actionId: string) => void;
  onUntrackSources?: (sources: T[], label: string, actionId: string) => void;
  renderSourceActions?: (source: T) => ReactNode;
  showSnapshotActions?: boolean;
}) {
  const tree = useMemo(() => buildSourceTree(sources), [sources]);
  const expandableIds = useMemo(() => collectExpandableIds(tree), [tree]);
  const [openNodes, setOpenNodes] = useState<Set<string>>(() => new Set());
  const [openSources, setOpenSources] = useState<Set<string>>(() => new Set());

  const hasExpandableItems =
    expandableIds.nodeIds.length > 0 || expandableIds.sourceIds.length > 0;
  const allExpanded =
    hasExpandableItems &&
    expandableIds.nodeIds.every((id) => openNodes.has(id)) &&
    expandableIds.sourceIds.every((id) => openSources.has(id));

  function toggleNode(nodeId: string) {
    setOpenNodes((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }

  function toggleSource(sourceId: string) {
    setOpenSources((current) => {
      const next = new Set(current);
      if (next.has(sourceId)) {
        next.delete(sourceId);
      } else {
        next.add(sourceId);
      }
      return next;
    });
  }

  function expandAll() {
    setOpenNodes(new Set(expandableIds.nodeIds));
    setOpenSources(new Set(expandableIds.sourceIds));
  }

  function collapseAll() {
    setOpenNodes(new Set());
    setOpenSources(new Set());
  }

  if (sources.length === 0) {
    return <p className="text-[var(--muted)]">{emptyMessage}</p>;
  }

  return (
    <div className="source-tree">
      {hasExpandableItems && (
        <div className="source-tree-controls" aria-label="Source page display controls">
          <button
            className="button-secondary px-3 py-2 text-sm"
            type="button"
            onClick={expandAll}
            disabled={allExpanded}
          >
            <ChevronsDown size={15} aria-hidden="true" />
            Expand all
          </button>
          <button
            className="button-secondary px-3 py-2 text-sm"
            type="button"
            onClick={collapseAll}
            disabled={!openNodes.size && !openSources.size}
          >
            <ChevronsUp size={15} aria-hidden="true" />
            Collapse all
          </button>
        </div>
      )}
      {tree.map((node) =>
        renderNode({
          node,
          depth: 0,
          openNodes,
          openSources,
          canManage,
          busyId,
          getSourceTracked,
          onTrackSources,
          onUntrackSources,
          renderSourceActions,
          showSnapshotActions,
          toggleNode,
          toggleSource,
        }),
      )}
    </div>
  );
}

function renderNode<T extends SourcePageTreeSource>({
  node,
  depth,
  openNodes,
  openSources,
  canManage,
  busyId,
  getSourceTracked,
  onTrackSources,
  onUntrackSources,
  renderSourceActions,
  showSnapshotActions,
  toggleNode,
  toggleSource,
}: {
  node: SourceTreeNode<T>;
  depth: number;
  openNodes: Set<string>;
  openSources: Set<string>;
  canManage: boolean;
  busyId: string | null;
  getSourceTracked: (source: T) => boolean;
  onTrackSources?: (sources: T[], label: string, actionId: string) => void;
  onUntrackSources?: (sources: T[], label: string, actionId: string) => void;
  renderSourceActions?: (source: T) => ReactNode;
  showSnapshotActions: boolean;
  toggleNode: (nodeId: string) => void;
  toggleSource: (sourceId: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const leafOnly = !hasChildren && node.directSources.length === node.sources.length;
  const open = openNodes.has(node.id);

  if (leafOnly) {
    return node.directSources.map((source) => (
      <SourcePageRow
        depth={depth}
        key={source.id}
        open={openSources.has(source.id)}
        renderSourceActions={(rowSource) =>
          renderSourceActions?.(rowSource) ||
          renderDefaultSourceActions({
            source: rowSource,
            canManage,
            busyId,
            getSourceTracked,
            onTrackSources,
            onUntrackSources,
          })
        }
        showSnapshotActions={showSnapshotActions}
        source={source}
        toggleSource={toggleSource}
      />
    ));
  }

  return (
    <div className="source-tree-node" key={node.id}>
      <div
        className="source-tree-branch"
        style={{ "--tree-depth": depth } as CSSProperties}
      >
        <button
          className="source-tree-branch-button"
          type="button"
          onClick={() => toggleNode(node.id)}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown size={17} aria-hidden="true" />
          ) : (
            <ChevronRight size={17} aria-hidden="true" />
          )}
          <FolderTree size={17} aria-hidden="true" />
          <span className="source-tree-branch-title">{node.label}</span>
          <span className="source-tree-count">{branchStatus(node.sources, getSourceTracked)}</span>
        </button>

        {canManage && (onTrackSources || onUntrackSources) && (
          <BranchActions
            actionId={node.id}
            busyId={busyId}
            label={node.label}
            onTrackSources={onTrackSources}
            onUntrackSources={onUntrackSources}
            sources={node.sources}
            trackedCount={node.sources.filter(getSourceTracked).length}
          />
        )}
      </div>

      {open && (
        <div className="source-tree-children">
          {node.directSources.map((source) => (
            <SourcePageRow
              depth={depth + 1}
              key={source.id}
              open={openSources.has(source.id)}
              renderSourceActions={(rowSource) =>
                renderSourceActions?.(rowSource) ||
                renderDefaultSourceActions({
                  source: rowSource,
                  canManage,
                  busyId,
                  getSourceTracked,
                  onTrackSources,
                  onUntrackSources,
                })
              }
              showSnapshotActions={showSnapshotActions}
              source={source}
              toggleSource={toggleSource}
            />
          ))}
          {node.children.map((child) =>
            renderNode({
              node: child,
              depth: depth + 1,
              openNodes,
              openSources,
              canManage,
              busyId,
              getSourceTracked,
              onTrackSources,
              onUntrackSources,
              renderSourceActions,
              showSnapshotActions,
              toggleNode,
              toggleSource,
            }),
          )}
        </div>
      )}
    </div>
  );
}

function renderDefaultSourceActions<T extends SourcePageTreeSource>({
  source,
  canManage,
  busyId,
  getSourceTracked,
  onTrackSources,
  onUntrackSources,
}: {
  source: T;
  canManage: boolean;
  busyId: string | null;
  getSourceTracked: (source: T) => boolean;
  onTrackSources?: (sources: T[], label: string, actionId: string) => void;
  onUntrackSources?: (sources: T[], label: string, actionId: string) => void;
}) {
  if (!canManage || (!onTrackSources && !onUntrackSources)) return null;

  return (
    <BranchActions
      actionId={source.id}
      busyId={busyId}
      label={readableSourceTitle(source.title, source.url)}
      onTrackSources={onTrackSources}
      onUntrackSources={onUntrackSources}
      sources={[source]}
      trackedCount={getSourceTracked(source) ? 1 : 0}
    />
  );
}

function SourcePageRow<T extends SourcePageTreeSource>({
  source,
  depth,
  open,
  renderSourceActions,
  showSnapshotActions,
  toggleSource,
}: {
  source: T;
  depth: number;
  open: boolean;
  renderSourceActions?: (source: T) => ReactNode;
  showSnapshotActions: boolean;
  toggleSource: (sourceId: string) => void;
}) {
  const outline = sourceOutline(source);
  const title = outline.displayTitle || readableSourceTitle(source.title, source.url);
  const latestChanges = source.latestChanges || [];
  const latestChange = latestChanges[0] || null;
  const rowStatus = sourceRowStatus(source, latestChange);
  const rowActions = renderSourceActions?.(source);
  const snapshotSourceId =
    source.sharedAwardSourceId === undefined ? source.id : source.sharedAwardSourceId;
  const checkedLabel = source.lastCheckedAt
    ? new Date(source.lastCheckedAt).toLocaleString()
    : "Not checked yet";

  return (
    <div
      className="source-tree-source dashboard-list-item"
      style={{ "--tree-depth": depth } as CSSProperties}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <button
              className="source-tree-source-title"
              type="button"
              onClick={() => toggleSource(source.id)}
              aria-expanded={open}
            >
              {open ? (
                <ChevronDown size={16} aria-hidden="true" />
              ) : (
                <ChevronRight size={16} aria-hidden="true" />
              )}
              <span>{title}</span>
            </button>
            <span className={rowStatus === "Changed" ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
              {rowStatus}
            </span>
          </div>
          <p className="mt-1 text-xs font-bold uppercase text-[var(--muted)]">
            {sourceMeta(source)}
          </p>
          {outline.description && (
            <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-[var(--muted)]">
              {outline.description}
            </p>
          )}
          <a
            className="mt-2 block truncate text-sm font-semibold text-[var(--brand)] underline"
            href={source.url}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="mr-1 inline" size={13} aria-hidden="true" />
            {source.url}
          </a>
          <div className="source-tree-source-dates">
            <span>Last checked: {checkedLabel}</span>
            <span>
              Latest update: {latestChange ? formatDate(latestChange.detectedAt) : "None recorded"}
            </span>
          </div>
          {open && (
            <div className="source-tree-update-panel">
              <SourcePageOutline source={source} outline={outline} />
              {latestChanges.length > 0 ? (
                latestChanges.slice(0, 2).map((change) => (
                  <article className="source-tree-update" key={change.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="badge">{formatDate(change.detectedAt)}</span>
                      {change.sourcePageType && (
                        <span className="badge">{pageTypeLabel(change.sourcePageType)}</span>
                      )}
                    </div>
                    <ChangeSummaryDisplay
                      compact
                      summary={change.summary}
                      sourceUrl={change.sourceUrl}
                      sourceTitle={change.sourceTitle}
                      changeDetails={change.changeDetails}
                    />
                    <ChangeEvidencePanel
                      compact
                      changeId={change.id}
                      changeKind="shared"
                      sourceUrl={change.sourceUrl}
                      sourceTitle={change.sourceTitle}
                      sourcePageTypeLabel={
                        change.sourcePageType ? pageTypeLabel(change.sourcePageType) : null
                      }
                      summary={change.summary}
                      changeDetails={change.changeDetails}
                      detectedAt={change.detectedAt}
                      previousTextSample={change.previousTextSample}
                      newTextSample={change.newTextSample}
                    />
                  </article>
                ))
              ) : (
                <p className="change-evidence-note">
                  No screenshot updates have been recorded for this source page yet.
                </p>
              )}
            </div>
          )}
        </div>

        {(showSnapshotActions || rowActions) && (
          <div className="source-tree-row-actions">
            {showSnapshotActions && snapshotSourceId && (
              <SourceSnapshotViewerButton
                sourceId={snapshotSourceId}
                sourcePageTypeLabel={source.pageType ? pageTypeLabel(source.pageType) : null}
                sourceTitle={title}
                sourceUrl={source.url}
              />
            )}
            {rowActions}
          </div>
        )}
      </div>
    </div>
  );
}

function SourcePageOutline<T extends SourcePageTreeSource>({
  source,
  outline,
}: {
  source: T;
  outline: SourceOutline;
}) {
  const facts = outline.facts;
  const factRows = sourceFactRows(facts);
  const sections = outline.sections.slice(0, 8);
  const generatedAt = source.pageMetadataGeneratedAt || outline.metadataGeneratedAt;
  const confidence = cleanString(facts.confidence);

  if (!outline.hasMetadata && !outline.description) return null;

  return (
    <section className="source-tree-page-outline">
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge">{outline.category || "Source page"}</span>
        <span className="badge">{relevanceLabel(outline.relevance)}</span>
        {confidence && <span className="badge">Confidence: {titleCase(confidence)}</span>}
      </div>

      {outline.description && (
        <p className="mt-3 text-sm font-semibold leading-6 text-[var(--muted)]">
          {outline.description}
        </p>
      )}

      {sections.length > 0 && (
        <div className="source-tree-outline-sections">
          {sections.map((section, index) => (
            <div className="source-tree-outline-section" key={`${section.title}-${index}`}>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <p className="min-w-0 font-black">{section.title}</p>
                <span className={section.status === "needs_review" ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
                  {sectionStatusLabel(section.status)}
                </span>
              </div>
              {section.description && (
                <p className="mt-1 text-sm leading-6 text-[var(--muted)]">{section.description}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {factRows.length > 0 && (
        <dl className="source-tree-fact-grid">
          {factRows.map((fact) => (
            <div className="source-tree-fact" key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {generatedAt && (
        <p className="mt-3 text-xs font-bold uppercase text-[var(--muted)]">
          Page outline scanned {formatDate(generatedAt)}
          {source.pageMetadataModel ? ` with ${source.pageMetadataModel}` : ""}
        </p>
      )}
    </section>
  );
}

function collectExpandableIds<T extends SourcePageTreeSource>(tree: SourceTreeNode<T>[]) {
  const nodeIds: string[] = [];
  const sourceIds: string[] = [];

  function visit(node: SourceTreeNode<T>) {
    if (node.children.length > 0 || node.directSources.length > 0) {
      nodeIds.push(node.id);
    }
    for (const source of node.directSources) {
      sourceIds.push(source.id);
    }
    for (const child of node.children) {
      visit(child);
    }
  }

  for (const node of tree) {
    visit(node);
  }

  return { nodeIds, sourceIds };
}

function BranchActions<T extends SourcePageTreeSource>({
  sources,
  label,
  actionId,
  busyId,
  trackedCount,
  onTrackSources,
  onUntrackSources,
}: {
  sources: T[];
  label: string;
  actionId: string;
  busyId: string | null;
  trackedCount: number;
  onTrackSources?: (sources: T[], label: string, actionId: string) => void;
  onUntrackSources?: (sources: T[], label: string, actionId: string) => void;
}) {
  const busy = busyId === actionId;

  return (
    <div className="source-tree-actions">
      {onTrackSources && trackedCount < sources.length && (
        <button
          className="button-secondary px-3 py-2 text-sm"
          type="button"
          disabled={busy}
          onClick={() => onTrackSources(sources, label, actionId)}
        >
          <Play size={14} aria-hidden="true" />
          {busy ? "Tracking..." : sources.length === 1 ? "Track page" : "Track branch"}
        </button>
      )}
      {onUntrackSources && trackedCount > 0 && (
        <button
          className="button-secondary px-3 py-2 text-sm"
          type="button"
          disabled={busy}
          onClick={() => onUntrackSources(sources, label, actionId)}
        >
          <BellOff size={14} aria-hidden="true" />
          {busy ? "Removing..." : sources.length === 1 ? "Untrack page" : "Untrack branch"}
        </button>
      )}
    </div>
  );
}

function branchStatus<T extends SourcePageTreeSource>(
  sources: T[],
  getSourceTracked: (source: T) => boolean,
) {
  const trackedCount = sources.filter(getSourceTracked).length;
  const parts = [`${sources.length} page${sources.length === 1 ? "" : "s"}`];

  if (trackedCount > 0) {
    parts.push(`${trackedCount} tracked`);
  }

  return parts.join(" · ");
}

type SourceOutline = {
  displayTitle: string | null;
  description: string | null;
  category: string | null;
  relevance: string | null;
  metadataGeneratedAt: string | null;
  facts: Record<string, unknown>;
  sections: Array<{ title: string; description: string; status: string }>;
  hasMetadata: boolean;
};

function sourceOutline(source: SourcePageTreeSource): SourceOutline {
  const metadata = objectValue(source.pageMetadata);
  const facts = objectValue(metadata.baseline_facts || metadata.baselineFacts || source.pageMetadata);
  const displayTitle =
    cleanString(source.displayTitle) ||
    cleanString(facts.display_title) ||
    cleanString(facts.page_title) ||
    null;
  const description =
    cleanString(source.pageDescription) ||
    cleanString(facts.page_description) ||
    cleanString(facts.page_purpose) ||
    cleanString(arrayValue(facts.notes)[0]) ||
    null;

  return {
    displayTitle,
    description,
    category: cleanString(facts.page_category) || (source.pageType ? pageTypeLabel(source.pageType) : null),
    relevance: cleanString(facts.award_relevance),
    metadataGeneratedAt:
      cleanString(source.pageMetadataGeneratedAt) ||
      cleanString(metadata.generated_at) ||
      cleanString(metadata.baseline_facts_metadata && objectValue(metadata.baseline_facts_metadata).extracted_at),
    facts,
    sections: sectionRows(facts.sections),
    hasMetadata: Object.keys(metadata).length > 0 || Object.keys(facts).length > 0,
  };
}

function sourceFactRows(facts: Record<string, unknown>) {
  const rows = [
    { label: "Deadline", value: cleanString(facts.deadline) },
    { label: "Opening Date", value: cleanString(facts.opening_date) },
    { label: "Award Amount", value: joinArray(facts.award_amounts) },
    { label: "Eligibility", value: joinArray(facts.eligibility) },
    { label: "Requirements", value: joinArray(facts.requirements) },
    { label: "Materials", value: joinArray(facts.application_materials) },
    { label: "How To Apply", value: joinArray(facts.how_to_apply) },
    { label: "Important Dates", value: joinArray(facts.important_dates) },
    { label: "Documents", value: joinArray(facts.documents) },
    { label: "Contact", value: joinArray(facts.contacts) },
  ];

  return rows.filter((row): row is { label: string; value: string } => Boolean(row.value));
}

function sourceRowStatus(
  source: SourcePageTreeSource,
  latestChange: SourcePageTreeChange | null,
) {
  if (source.lastError) return "Needs review";
  if (latestChange) return "Changed";
  if (source.pageMetadata || source.pageDescription || source.displayTitle) return "Unchanged";
  return "Needs scan";
}

function sectionRows(value: unknown) {
  return arrayValue(value)
    .map((item) => {
      const object = objectValue(item);
      const title = cleanString(object.title || object.name || object.label) || cleanString(item);
      const description = cleanString(object.description || object.summary || object.detail) || "";
      const status = cleanString(object.status) || "unchanged";
      return title ? { title, description, status } : null;
    })
    .filter((item): item is { title: string; description: string; status: string } => Boolean(item));
}

function relevanceLabel(value: string | null) {
  if (value === "primary") return "Primary source";
  if (value === "supporting") return "Supporting source";
  if (value === "unrelated") return "Unrelated";
  return "Needs review";
}

function sectionStatusLabel(value: string) {
  if (value === "needs_review") return "Needs review";
  return titleCase(value.replace(/[-_]+/g, " "));
}

function joinArray(value: unknown) {
  const values = arrayValue(value).map(cleanString).filter(Boolean);
  return values.length ? values.slice(0, 4).join("; ") : "";
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function sourceMeta(source: SourcePageTreeSource) {
  return [
    source.pageType ? pageTypeLabel(source.pageType) : "Source page",
    formatCadence(source.cadence),
  ]
    .filter(Boolean)
    .join(" - ");
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function defaultTracked(source: SourcePageTreeSource) {
  return Boolean(source.monitorId || source.tracked);
}

function formatCadence(cadence: string | null | undefined) {
  if (!cadence) return null;
  if (cadence === "daily") return "Daily";
  if (cadence === "hourly") return "Hourly";
  return titleCase(cadence.replace(/[-_]+/g, " "));
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
