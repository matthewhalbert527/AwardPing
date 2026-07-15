"use client";

import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
import {
  SourceSnapshotInlinePreview,
  SourceSnapshotViewerButton,
} from "@/components/source-snapshot-viewer";
import { pageTypeLabel, type AwardPageType } from "@/lib/award-discovery-types";
import { normalizeImportantDateItems } from "@/lib/important-dates";
import {
  buildSourceTree,
  sourceTreeSourceLabel,
  type SourceTreeNode,
  type SourceTreeSource,
} from "@/lib/source-tree";
import { formatCentralDateTime } from "@/lib/time-zone";

export type SourcePageTreeChange = {
  id: string;
  sourceTitle: string | null;
  sourceUrl: string;
  sourcePageType: AwardPageType | null;
  summary: string;
  changeDetails?: unknown;
  detectedAt: string;
  unread?: boolean;
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

type FactValue = string | string[];
type SourceFactRow = { label: string; value: FactValue };

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
  layout = "inline",
  initiallyExpanded,
  groupByHost = true,
  splitDetailIntro,
  splitSidebarFooter,
  splitSidebarIntro,
  initialSelectedSourceId,
  selectedChangeId,
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
  layout?: "inline" | "split";
  initiallyExpanded?: boolean;
  groupByHost?: boolean;
  splitDetailIntro?: ReactNode;
  splitSidebarFooter?: ReactNode;
  splitSidebarIntro?: ReactNode;
  initialSelectedSourceId?: string | null;
  selectedChangeId?: string | null;
}) {
  const tree = useMemo(() => buildSourceTree(sources, { groupByHost }), [sources, groupByHost]);
  const expandableIds = useMemo(() => collectExpandableIds(tree), [tree]);
  const flatSources = useMemo(() => flattenTreeSources(tree), [tree]);
  const initialSelectedSource = useMemo(
    () =>
      (initialSelectedSourceId &&
      flatSources.find((source) => source.id === initialSelectedSourceId)) ||
      flatSources[0] ||
      null,
    [flatSources, initialSelectedSourceId],
  );
  const initialReadChangeIds = useMemo(
    () =>
      initialSelectedSourceId && initialSelectedSource
        ? unreadChangeIdsForSource(initialSelectedSource, new Set())
        : [],
    [initialSelectedSource, initialSelectedSourceId],
  );
  const initialReadSourceIdRef = useRef<string | null>(null);
  const [openNodes, setOpenNodes] = useState<Set<string>>(() =>
    (initiallyExpanded ?? layout === "split") ? new Set(expandableIds.nodeIds) : new Set(),
  );
  const [openSources, setOpenSources] = useState<Set<string>>(() => new Set());
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(
    () => initialSelectedSource?.id || null,
  );
  const [readChangeIds, setReadChangeIds] = useState<Set<string>>(
    () => new Set(initialReadChangeIds),
  );
  const selectedSource = flatSources.find((source) => source.id === selectedSourceId) || flatSources[0] || null;
  const selectedSourceIdForRender = selectedSource?.id || null;

  useEffect(() => {
    if (!initialSelectedSourceId || initialReadSourceIdRef.current === initialSelectedSourceId) {
      return;
    }

    const explicitSource = flatSources.find((source) => source.id === initialSelectedSourceId);
    if (!explicitSource) return;

    initialReadSourceIdRef.current = initialSelectedSourceId;
    postReadChangeIds(unreadChangeIdsForSource(explicitSource, new Set()));
  }, [flatSources, initialSelectedSourceId]);

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

  function selectSource(sourceId: string) {
    const nextSource = flatSources.find((source) => source.id === sourceId) || null;
    const unreadIds = nextSource ? unreadChangeIdsForSource(nextSource, readChangeIds) : [];
    if (unreadIds.length > 0) {
      setReadChangeIds((current) => new Set([...current, ...unreadIds]));
      postReadChangeIds(unreadIds);
    }
    setSelectedSourceId(sourceId);
  }

  if (sources.length === 0) {
    return <p className="text-[var(--muted)]">{emptyMessage}</p>;
  }

  const controls = hasExpandableItems ? (
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
  ) : null;

  const treeContent = tree.map((node) =>
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
      variant: layout === "split" ? "summary" : "inline",
      selectedSourceId: selectedSourceIdForRender,
      onSelectSource: selectSource,
      readChangeIds,
    }),
  );

  if (layout === "split") {
    return (
      <div className="source-tree source-tree-split">
        <div className="source-tree-list">
          {splitSidebarIntro}
          <details className="source-tree-sidebar-group" open>
            <summary>
              <ChevronDown size={15} aria-hidden="true" />
              <span>Sources</span>
            </summary>
            <div className="source-tree-sidebar-list">
              {controls}
              {treeContent}
            </div>
          </details>
          {splitSidebarFooter}
        </div>
        <div className="source-tree-detail-stack">
          {splitDetailIntro}
          <SourcePageDetailPanel
            source={selectedSource}
            renderSourceActions={renderSourceActions}
            selectedChangeId={selectedChangeId}
            showSnapshotActions={showSnapshotActions}
            readChangeIds={readChangeIds}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="source-tree">
      {controls}
      {treeContent}
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
  variant,
  selectedSourceId,
  onSelectSource,
  readChangeIds,
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
  variant: "inline" | "summary";
  selectedSourceId: string | null;
  onSelectSource: (sourceId: string) => void;
  readChangeIds: Set<string>;
}) {
  const hasChildren = node.children.length > 0;
  const leafOnly = !hasChildren && node.directSources.length === node.sources.length;
  const open = openNodes.has(node.id);
  const unreadCount = unreadChangeIdsForSources(node.sources, readChangeIds).length;

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
        active={selectedSourceId === source.id}
        showSnapshotActions={showSnapshotActions}
        source={source}
        toggleSource={toggleSource}
        variant={variant}
        onSelectSource={onSelectSource}
        unreadCount={unreadChangeIdsForSource(source, readChangeIds).length}
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
          {unreadCount > 0 && (
            <span className="source-tree-unread-badge" aria-label="Recent updates" />
          )}
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
              active={selectedSourceId === source.id}
              showSnapshotActions={showSnapshotActions}
              source={source}
              toggleSource={toggleSource}
              variant={variant}
              onSelectSource={onSelectSource}
              unreadCount={unreadChangeIdsForSource(source, readChangeIds).length}
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
              variant,
              selectedSourceId,
              onSelectSource,
              readChangeIds,
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
      label={sourceTreeSourceLabel(source)}
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
  active = false,
  renderSourceActions,
  showSnapshotActions,
  toggleSource,
  variant = "inline",
  onSelectSource,
  unreadCount = 0,
}: {
  source: T;
  depth: number;
  open: boolean;
  active?: boolean;
  renderSourceActions?: (source: T) => ReactNode;
  showSnapshotActions: boolean;
  toggleSource: (sourceId: string) => void;
  variant?: "inline" | "summary";
  onSelectSource?: (sourceId: string) => void;
  unreadCount?: number;
}) {
  const outline = sourceOutline(source);
  const title = outline.displayTitle || sourceTreeSourceLabel(source);
  const latestChanges = source.latestChanges || [];
  const latestChange = latestChanges[0] || null;
  const summaryMode = variant === "summary";
  const rowStatus = sourceRowStatus(source, latestChange, unreadCount);
  const showUpdateDot = summaryMode ? latestChanges.length > 0 : unreadCount > 0;
  const rowActions = renderSourceActions?.(source);
  const snapshotSourceId =
    source.sharedAwardSourceId === undefined ? source.id : source.sharedAwardSourceId;
  const checkedLabel = source.lastCheckedAt
    ? formatCentralDateTime(source.lastCheckedAt)
    : "Not checked yet";

  function handleSourceClick() {
    if (summaryMode) {
      onSelectSource?.(source.id);
      return;
    }
    toggleSource(source.id);
  }

  return (
    <div
      className={`source-tree-source dashboard-list-item ${summaryMode ? "source-tree-source-summary" : ""} ${active ? "source-tree-source-active" : ""}`}
      style={{ "--tree-depth": depth } as CSSProperties}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <button
              className="source-tree-source-title"
              type="button"
              onClick={handleSourceClick}
              aria-expanded={summaryMode ? undefined : open}
              aria-pressed={summaryMode ? active : undefined}
            >
              {summaryMode ? (
                <ChevronRight size={16} aria-hidden="true" />
              ) : open ? (
                <ChevronDown size={16} aria-hidden="true" />
              ) : (
                <ChevronRight size={16} aria-hidden="true" />
              )}
              <span>{title}</span>
            </button>
            <span className={rowStatus === "Changed" || rowStatus === "New update" ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
              {rowStatus}
            </span>
            {showUpdateDot && (
              <span className="source-tree-unread-badge" aria-label="Recent updates" />
            )}
          </div>
          <p className="mt-1 text-xs font-bold uppercase text-[var(--muted)]">
            {summaryMode ? sourceCompactMeta(source) : sourceMeta(source)}
          </p>
          {!summaryMode && outline.description && (
            <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-[var(--muted)]">
              {outline.description}
            </p>
          )}
          {!summaryMode && (
            <>
              <a
                className="mt-2 inline-flex min-w-0 max-w-full items-center gap-1 truncate text-sm font-semibold text-[var(--brand)] underline"
                href={source.url}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={13} aria-hidden="true" />
                <span className="truncate">Open source</span>
              </a>
              <div className="source-tree-source-dates">
                <span>Checked: {checkedLabel}</span>
                <span>
                  Update: {latestChange ? formatDate(latestChange.detectedAt) : "None"}
                </span>
              </div>
            </>
          )}
          {open && !summaryMode && (
            <div className="source-tree-update-panel">
              <SourcePageDetails source={source} outline={outline} latestChanges={latestChanges} />
            </div>
          )}
        </div>

        {!summaryMode && (showSnapshotActions || rowActions) && (
          <div className="source-tree-row-actions">
            {showSnapshotActions && (latestChange?.id || snapshotSourceId) && (
              <SourceSnapshotViewerButton
                changeEventId={latestChange?.id}
                changeDetectedAt={latestChange?.detectedAt}
                changeDetails={latestChange?.changeDetails}
                changeSummary={latestChange?.summary}
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

function SourcePageDetailPanel<T extends SourcePageTreeSource>({
  source,
  renderSourceActions,
  selectedChangeId,
  showSnapshotActions,
  readChangeIds,
}: {
  source: T | null;
  renderSourceActions?: (source: T) => ReactNode;
  selectedChangeId?: string | null;
  showSnapshotActions: boolean;
  readChangeIds: Set<string>;
}) {
  if (!source) {
    return (
      <aside className="source-tree-detail-panel">
        <p className="text-sm font-semibold text-[var(--muted)]">No source page selected.</p>
      </aside>
    );
  }

  const outline = sourceOutline(source);
  const title = outline.displayTitle || sourceTreeSourceLabel(source);
  const latestChanges = source.latestChanges || [];
  const unreadCount = unreadChangeIdsForSource(source, readChangeIds).length;
  const orderedChanges = orderSelectedChange(latestChanges, selectedChangeId);
  const selectedChange = orderedChanges[0] || null;
  const rowStatus = sourceRowStatus(source, selectedChange, unreadCount);
  const rowActions = renderSourceActions?.(source);
  const snapshotSourceId =
    source.sharedAwardSourceId === undefined ? source.id : source.sharedAwardSourceId;

  return (
    <aside className="source-tree-detail-panel">
      <div className="source-tree-detail-header">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={rowStatus === "Changed" || rowStatus === "New update" ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
              {rowStatus}
            </span>
            <span className="badge">
              {source.pageType ? pageTypeLabel(source.pageType) : "Source page"}
            </span>
          </div>
          <h3 className="source-tree-detail-title">{title}</h3>
          <a
            className="source-tree-detail-link"
            href={source.url}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={13} aria-hidden="true" />
            Open source
          </a>
          <p className="source-tree-detail-host">{sourceHost(source.url)}</p>
        </div>

        {(showSnapshotActions || rowActions) && (
          <div className="source-tree-row-actions">
            {showSnapshotActions && (selectedChange?.id || snapshotSourceId) && (
              <SourceSnapshotViewerButton
                changeEventId={selectedChange?.id}
                changeDetectedAt={selectedChange?.detectedAt}
                changeDetails={selectedChange?.changeDetails}
                changeSummary={selectedChange?.summary}
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

      <div className="source-tree-update-panel source-tree-detail-content">
        <SourcePageDetails source={source} outline={outline} latestChanges={orderedChanges} selectedChangeId={selectedChangeId} />
      </div>
    </aside>
  );
}

function SourcePageDetails<T extends SourcePageTreeSource>({
  source,
  outline,
  latestChanges,
  selectedChangeId,
}: {
  source: T;
  outline: SourceOutline;
  latestChanges: SourcePageTreeChange[];
  selectedChangeId?: string | null;
}) {
  const snapshotSourceId =
    source.sharedAwardSourceId === undefined ? source.id : source.sharedAwardSourceId;

  return (
    <>
      <SourcePageOutline outline={outline} />
      {latestChanges.length > 0 ? (
        latestChanges.slice(0, 2).map((change) => (
          <article className={`source-tree-update ${selectedChangeId === change.id ? "source-tree-update-selected" : ""}`} key={change.id}>
            <div className="flex flex-wrap items-center gap-2">
              {selectedChangeId === change.id && <span className="source-tree-selected-badge">Selected update</span>}
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
            <SourceSnapshotInlinePreview
              changeEventId={change.id}
              changeDetails={change.changeDetails}
              changeSummary={change.summary}
              sourceId={snapshotSourceId}
              sourceTitle={change.sourceTitle || sourceTreeSourceLabel(source)}
              sourceUrl={change.sourceUrl}
            />
            <ChangeEvidencePanel
              changeEventId={change.id}
              compact
              sourceId={snapshotSourceId}
              sourceUrl={change.sourceUrl}
              sourceTitle={change.sourceTitle}
              sourcePageTypeLabel={
                change.sourcePageType ? pageTypeLabel(change.sourcePageType) : null
              }
              summary={change.summary}
              changeDetails={change.changeDetails}
              detectedAt={change.detectedAt}
            />
          </article>
        ))
      ) : (
        <p className="change-evidence-note">No updates recorded for this source.</p>
      )}
    </>
  );
}

function SourcePageOutline({
  outline,
}: {
  outline: SourceOutline;
}) {
  const facts = outline.facts;
  const factRows = sourceFactRows(facts);
  const sections = outline.sections.slice(0, 5);

  if (!outline.hasMetadata && !outline.description) return null;

  return (
    <section className="source-tree-page-outline">
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge">{outline.category || "Source page"}</span>
        {outline.relevance && outline.relevance !== "primary" && (
          <span className="badge">{relevanceLabel(outline.relevance)}</span>
        )}
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
                {section.status === "needs_review" && (
                  <span className="badge bg-[var(--brand-pink-soft)]">
                    {sectionStatusLabel(section.status)}
                  </span>
                )}
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
          {factRows.slice(0, 6).map((fact) => (
            <div className="source-tree-fact" key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>
                <FactValueDisplay className="source-tree-fact-list" value={fact.value} />
              </dd>
            </div>
          ))}
        </dl>
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

function flattenTreeSources<T extends SourcePageTreeSource>(tree: SourceTreeNode<T>[]) {
  const sources: T[] = [];

  function visit(node: SourceTreeNode<T>) {
    sources.push(...node.directSources);
    for (const child of node.children) {
      visit(child);
    }
  }

  for (const node of tree) {
    visit(node);
  }

  return sources;
}

function unreadChangeIdsForSource<T extends SourcePageTreeSource>(
  source: T,
  readChangeIds: Set<string>,
) {
  return (source.latestChanges || [])
    .filter((change) => change.unread && !readChangeIds.has(change.id))
    .map((change) => change.id);
}

function unreadChangeIdsForSources<T extends SourcePageTreeSource>(
  sources: T[],
  readChangeIds: Set<string>,
) {
  return [
    ...new Set(sources.flatMap((source) => unreadChangeIdsForSource(source, readChangeIds))),
  ];
}

function postReadChangeIds(changeIds: string[]) {
  if (changeIds.length === 0) return;
  void fetch("/api/shared-award-change-reads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changeIds }),
  }).catch(() => undefined);
}

function orderSelectedChange<T extends SourcePageTreeChange>(
  changes: T[],
  selectedChangeId?: string | null,
) {
  if (!selectedChangeId) return changes;
  return [...changes].sort((a, b) => {
    if (a.id === selectedChangeId) return -1;
    if (b.id === selectedChangeId) return 1;
    return 0;
  });
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
  const metadataRejected =
    metadata.baseline_facts_rejected === true ||
    objectValue(metadata.baseline_facts_metadata).rejected === true;
  const metadataFacts = objectValue(metadata.baseline_facts || metadata.baselineFacts);
  const facts = metadataRejected || !baselineFactsAreUsable(metadataFacts) ? {} : metadataFacts;
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
    { label: "Award conditions", value: joinArray(facts.requirements) },
    { label: "Materials", value: joinArray(facts.application_materials) },
    { label: "How To Apply", value: joinArray(facts.how_to_apply) },
    { label: "Important Dates", value: importantDatesValue(facts) },
    { label: "Documents", value: joinArray(facts.documents) },
    { label: "Contact", value: joinArray(facts.contacts) },
  ];

  return rows.filter(isSourceFactRow);
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

function isSourceFactRow(row: { label: string; value: FactValue | null }): row is SourceFactRow {
  return Array.isArray(row.value) ? row.value.length > 0 : Boolean(row.value);
}

function sourceRowStatus(
  source: SourcePageTreeSource,
  latestChange: SourcePageTreeChange | null,
  unreadCount = 0,
) {
  if (source.lastError) return "Needs review";
  if (unreadCount > 0) return "New update";
  if (latestChange) return "Changed";
  if (source.pageMetadata || source.pageDescription || source.displayTitle) return "Unchanged";
  return "Details pending";
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
  const values = arrayValue(value).map(cleanString).filter(Boolean).flatMap(splitFactItems);
  const clean = values.slice(0, 4);
  if (clean.length === 0) return null;
  return clean.length === 1 ? clean[0] : clean;
}

function importantDatesValue(facts: Record<string, unknown>) {
  const values = arrayValue(facts.important_dates).map(cleanString).filter(Boolean);
  const clean = normalizeImportantDateItems(values, {
    deadline: cleanString(facts.deadline),
    openingDate: cleanString(facts.opening_date),
  }).slice(0, 4);
  if (clean.length === 0) return null;
  return clean.length === 1 ? clean[0] : clean;
}

function splitFactItems(value: string) {
  return value.split(/\s*;\s*/).map((item) => item.trim()).filter(Boolean);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function baselineFactsAreUsable(facts: Record<string, unknown>) {
  const relevance = cleanMetadataKey(facts.award_relevance);
  const cycleRelevance = cleanMetadataKey(facts.cycle_relevance);
  if (relevance === "unrelated") return false;
  if (cycleRelevance === "not_program_page" || cycleRelevance === "archived_or_past") return false;
  return true;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanMetadataKey(value: unknown) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function sourceMeta(source: SourcePageTreeSource) {
  return [
    source.pageType ? pageTypeLabel(source.pageType) : "Source page",
    formatCadence(source.cadence),
  ]
    .filter(Boolean)
    .join(" - ");
}

function sourceCompactMeta(source: SourcePageTreeSource) {
  const updateCount = source.latestChanges?.length || 0;
  return [
    source.pageType ? pageTypeLabel(source.pageType) : "Source page",
    `${updateCount} update${updateCount === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" / ");
}

function sourceHost(value: string | null | undefined) {
  try {
    return new URL(value || "").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function formatDate(value: string) {
  return formatCentralDateTime(value);
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
