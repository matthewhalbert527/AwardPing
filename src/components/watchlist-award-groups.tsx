"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BellOff,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Pause,
  Play,
  Search,
  Trash2,
} from "lucide-react";
import { type AwardPageType } from "@/lib/award-discovery-types";
import { SourcePageTree } from "@/components/source-page-tree";

export type WatchlistAwardGroup = {
  id: string;
  sharedAwardId: string | null;
  name: string;
  summary: string | null;
  officialHomepage: string | null;
  sources: WatchlistSource[];
};

export type WatchlistSource = {
  id: string;
  sharedAwardSourceId: string | null;
  monitorId: string | null;
  monitorSharedAwardSourceId?: string | null;
  title: string;
  displayTitle?: string | null;
  pageDescription?: string | null;
  pageMetadata?: unknown;
  pageMetadataGeneratedAt?: string | null;
  pageMetadataModel?: string | null;
  url: string;
  pageType: AwardPageType | null;
  status: "active" | "paused" | "error" | "untracked";
  cadence: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
};

export function WatchlistAwardGroups({
  groups,
  canManage,
}: {
  groups: WatchlistAwardGroup[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [openAwards, setOpenAwards] = useState<Set<string>>(() => new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const visibleGroups = useMemo(
    () => groups.filter((group) => matchesWatchlistSearch(group, query)),
    [groups, query],
  );

  function toggleOpen(groupId: string) {
    setOpenAwards((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  async function trackAll(group: WatchlistAwardGroup) {
    if (!group.sharedAwardId) return;
    await runAction(group.id, async () => {
      const response = await fetch(`/api/shared-awards/${group.sharedAwardId}/track`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cadence: "daily" }),
      });
      return response;
    });
  }

  async function untrackAward(group: WatchlistAwardGroup) {
    if (!group.sharedAwardId) return;
    if (!confirm(`Remove ${group.name} and all source pages from the watchlist?`)) return;
    await runAction(group.id, () =>
      fetch(`/api/shared-awards/${group.sharedAwardId}/track`, { method: "DELETE" }),
    );
  }

  async function trackSource(group: WatchlistAwardGroup, source: WatchlistSource) {
    if (!group.sharedAwardId || !source.sharedAwardSourceId) return;
    await runAction(source.id, () =>
      fetch(`/api/shared-awards/${group.sharedAwardId}/sources/${source.sharedAwardSourceId}/track`, {
        method: "POST",
      }),
    );
  }

  async function trackSources(
    group: WatchlistAwardGroup,
    sources: WatchlistSource[],
    label: string,
    actionId: string,
  ) {
    if (!group.sharedAwardId) return;
    const targets = sources.filter((source) => !source.monitorId && source.sharedAwardSourceId);
    if (targets.length === 0) return;

    await runBatchAction(actionId, async () => {
      for (const source of targets) {
        const response = await fetch(
          `/api/shared-awards/${group.sharedAwardId}/sources/${source.sharedAwardSourceId}/track`,
          { method: "POST" },
        );
        if (!response.ok) return response;
      }

      return null;
    }, `${label} could not be tracked.`);
  }

  async function untrackSource(group: WatchlistAwardGroup, source: WatchlistSource) {
    if (!confirm(`Remove ${source.title} from the watchlist?`)) return;

    if (
      source.monitorId &&
      (!group.sharedAwardId ||
        !source.sharedAwardSourceId ||
        source.monitorSharedAwardSourceId !== source.sharedAwardSourceId)
    ) {
      await runAction(source.id, () =>
        fetch(`/api/monitors/${source.monitorId}`, { method: "DELETE" }),
      );
      return;
    }

    if (!group.sharedAwardId || !source.sharedAwardSourceId) return;
    await runAction(source.id, () =>
      fetch(`/api/shared-awards/${group.sharedAwardId}/sources/${source.sharedAwardSourceId}/track`, {
        method: "DELETE",
      }),
    );
  }

  async function untrackSources(
    group: WatchlistAwardGroup,
    sources: WatchlistSource[],
    label: string,
    actionId: string,
  ) {
    const targets = sources.filter((source) => source.monitorId);
    if (targets.length === 0) return;
    if (!confirm(`Remove ${label} from the watchlist?`)) return;

    await runBatchAction(actionId, async () => {
      for (const source of targets) {
        const canDeleteBySharedSource =
          group.sharedAwardId &&
          source.sharedAwardSourceId &&
          source.monitorSharedAwardSourceId === source.sharedAwardSourceId;
        const response = canDeleteBySharedSource
          ? await fetch(
              `/api/shared-awards/${group.sharedAwardId}/sources/${source.sharedAwardSourceId}/track`,
              { method: "DELETE" },
            )
          : await fetch(`/api/monitors/${source.monitorId}`, { method: "DELETE" });
        if (!response.ok) return response;
      }

      return null;
    }, `${label} could not be removed from the watchlist.`);
  }

  async function updateMonitor(source: WatchlistSource, status: "active" | "paused") {
    if (!source.monitorId) return;
    await runAction(source.id, () =>
      fetch(`/api/monitors/${source.monitorId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      }),
    );
  }

  async function runAction(id: string, action: () => Promise<Response>) {
    setBusyId(id);
    setMessage("");
    const response = await action();
    setBusyId(null);

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setMessage(data.error || "Watchlist could not be updated.");
      return;
    }

    router.refresh();
  }

  async function runBatchAction(
    id: string,
    action: () => Promise<Response | null>,
    fallbackError: string,
  ) {
    setBusyId(id);
    setMessage("");
    const response = await action();
    setBusyId(null);

    if (response && !response.ok) {
      const data = await response.json().catch(() => ({}));
      setMessage(data.error || fallbackError);
      return;
    }

    router.refresh();
  }

  if (groups.length === 0) {
    return (
      <div className="dashboard-panel dashboard-panel-pad text-[var(--muted)]">
        No awards on the watchlist yet.
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="dashboard-panel dashboard-panel-pad">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] lg:items-end">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="dashboard-panel-title">Watchlist controls</h2>
            </div>
            <p className="dashboard-panel-copy">
              Showing {visibleGroups.length} of {groups.length} awards.
            </p>
          </div>
          <label className="grid gap-1 text-sm font-bold text-[var(--muted)]">
            Search watchlist
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]"
                size={17}
                aria-hidden="true"
              />
              <input
                className="input input-with-leading-icon text-[var(--foreground)]"
                placeholder="Award, source page, or URL"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </label>
        </div>

        {query && (
          <div className="mt-4 flex justify-end">
            <button
              className="button-secondary"
              type="button"
              onClick={() => {
                setQuery("");
              }}
            >
              Clear search
            </button>
          </div>
        )}
      </div>

      {visibleGroups.length === 0 && (
        <div className="dashboard-panel dashboard-panel-pad text-[var(--muted)]">
          No watchlist awards match the current filters.
        </div>
      )}

      {visibleGroups.map((group) => {
        const open = openAwards.has(group.id);
        const trackedCount = group.sources.filter((source) => source.monitorId).length;
        const sourceCount = group.sources.length;

        return (
          <article className="dashboard-panel dashboard-panel-pad" key={group.id}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-start gap-2">
                  <h2 className="min-w-0 text-2xl font-black">
                    {group.sharedAwardId ? (
                      <Link
                        className="inline-flex min-w-0 items-center gap-2 text-[var(--foreground)] hover:text-[var(--brand)]"
                        href={`/dashboard/awards/${group.sharedAwardId}`}
                      >
                        <span className="min-w-0 break-words">{group.name}</span>
                        <ChevronRight className="shrink-0" size={20} aria-hidden="true" />
                      </Link>
                    ) : (
                      group.name
                    )}
                  </h2>
                  <button
                    className="button-secondary px-3 py-2 text-sm"
                    type="button"
                    onClick={() => toggleOpen(group.id)}
                    aria-expanded={open}
                    aria-label={open ? `Hide source pages for ${group.name}` : `Show source pages for ${group.name}`}
                  >
                    {open ? (
                      <ChevronUp size={16} aria-hidden="true" />
                    ) : (
                      <ChevronDown size={16} aria-hidden="true" />
                    )}
                    Pages
                  </button>
                </div>
                <p className="mt-2 text-xs font-bold uppercase text-[var(--muted)]">
                  {trackedCount} of {sourceCount} pages tracked
                </p>
              </div>

              {canManage && (
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    className="button-secondary"
                    type="button"
                    disabled={!group.sharedAwardId || trackedCount === sourceCount || busyId === group.id}
                    onClick={() => trackAll(group)}
                  >
                    <Play size={15} aria-hidden="true" />
                    {busyId === group.id ? "Tracking..." : "Track all"}
                  </button>
                  <button
                    className="button-secondary"
                    type="button"
                    disabled={!group.sharedAwardId || trackedCount === 0 || busyId === group.id}
                    onClick={() => untrackAward(group)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                    Untrack award
                  </button>
                </div>
              )}
            </div>

            {open && (
              <div className="mt-5">
                <SourcePageTree
                  sources={group.sources}
                  canManage={canManage}
                  busyId={busyId}
                  getSourceTracked={(source) => Boolean(source.monitorId)}
                  onTrackSources={(sources, label, actionId) =>
                    trackSources(group, sources, label, actionId)
                  }
                  onUntrackSources={(sources, label, actionId) =>
                    untrackSources(group, sources, label, actionId)
                  }
                  renderSourceActions={(source) =>
                    canManage ? (
                      <SourceActions
                        busy={busyId === source.id}
                        source={source}
                        onTrack={() => trackSource(group, source)}
                        onUntrack={() => untrackSource(group, source)}
                        onPause={() => updateMonitor(source, "paused")}
                        onResume={() => updateMonitor(source, "active")}
                      />
                    ) : null
                  }
                />
              </div>
            )}
          </article>
        );
      })}

      {message && <p className="text-sm font-semibold text-[var(--foreground)]">{message}</p>}
    </div>
  );
}

function matchesWatchlistSearch(
  group: WatchlistAwardGroup,
  query: string,
) {
  const needle = normalizeSearch(query);
  if (needle && !watchlistSearchText(group).includes(needle)) return false;
  return true;
}

function watchlistSearchText(group: WatchlistAwardGroup) {
  return normalizeSearch(
    [
      group.name,
      group.summary,
      group.officialHomepage,
      ...group.sources.flatMap((source) => [
        source.title,
        source.url,
        source.pageType,
      ]),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase();
}

function SourceActions({
  busy,
  source,
  onTrack,
  onUntrack,
  onPause,
  onResume,
}: {
  busy: boolean;
  source: WatchlistSource;
  onTrack: () => void;
  onUntrack: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  if (!source.monitorId) {
    return (
      <button
        className="button-primary shrink-0"
        type="button"
        disabled={busy || !source.sharedAwardSourceId}
        onClick={onTrack}
      >
        <Play size={15} aria-hidden="true" />
        {busy ? "Tracking..." : "Track page"}
      </button>
    );
  }

  return (
    <div className="flex shrink-0 flex-wrap gap-2">
      {source.status === "paused" ? (
        <button className="button-secondary" type="button" onClick={onResume} disabled={busy}>
          <Play size={15} aria-hidden="true" />
          Resume
        </button>
      ) : (
        <button className="button-secondary" type="button" onClick={onPause} disabled={busy}>
          <Pause size={15} aria-hidden="true" />
          Pause
        </button>
      )}
      <button className="button-secondary" type="button" onClick={onUntrack} disabled={busy}>
        <BellOff size={15} aria-hidden="true" />
        Untrack
      </button>
    </div>
  );
}
