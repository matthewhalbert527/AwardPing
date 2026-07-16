"use client";

import { useId, useState, type FormEvent } from "react";
import { Bookmark, Filter, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import type {
  AdminManualQuarantineBacklog,
  AdminManualQuarantineBacklogFilters,
  AdminManualQuarantineBacklogQuery,
  AdminManualQuarantineGroupBy,
} from "@/lib/admin-manual-quarantine-backlog";

type SavedViewOption = {
  href: string;
  id: string;
  name: string;
};

type Props = {
  activeViewId: string | null;
  activeViewName: string;
  available: boolean;
  facets: AdminManualQuarantineBacklog["facets"];
  query: AdminManualQuarantineBacklogQuery;
  savedViewOptions: SavedViewOption[];
  savedViewsAvailable: boolean;
};

type BulkFilterKey =
  | "domains"
  | "evidenceFailures"
  | "policyReasons"
  | "repairs"
  | "owners"
  | "statuses";

type ControlsMessage = {
  text: string;
  tone: "error" | "success";
};

const groupOptions: Array<{
  label: string;
  value: AdminManualQuarantineGroupBy;
}> = [
  { label: "Full repair groups", value: "repair_group" },
  { label: "Domain", value: "domain" },
  { label: "Evidence failure", value: "evidence_failure" },
  { label: "Policy reason", value: "policy_reason" },
  { label: "Likely repair", value: "likely_repair" },
];

const ageOptions = [
  { label: "Under 24 hours", value: "under_24h" },
  { label: "1–3 days", value: "one_to_three_days" },
  { label: "4–7 days", value: "four_to_seven_days" },
  { label: "8–30 days", value: "eight_to_thirty_days" },
  { label: "Over 30 days", value: "over_thirty_days" },
] as const;

export function AdminManualQuarantineBacklogControls({
  activeViewId,
  activeViewName,
  available,
  facets,
  query,
  savedViewOptions,
  savedViewsAvailable,
}: Props) {
  const router = useRouter();
  const searchId = useId();
  const sortId = useId();
  const pageSizeId = useId();
  const savedViewId = useId();
  const savedViewNameId = useId();
  const [draft, setDraft] = useState<AdminManualQuarantineBacklogFilters>(() =>
    filtersFromQuery(query),
  );
  const [sort, setSort] = useState(query.sort);
  const [pageSize, setPageSize] = useState(query.pageSize);
  const [viewName, setViewName] = useState(activeViewName);
  const [busy, setBusy] = useState<"delete" | "save" | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [message, setMessage] = useState<ControlsMessage | null>(null);
  const facetFields: Array<{
    key: BulkFilterKey;
    label: string;
    options: Array<{ cases: number; key: string; label: string }>;
    selected: string[];
  }> = [
    {
      key: "domains",
      label: "Source domain",
      options: facets.domains,
      selected: draft.domains,
    },
    {
      key: "evidenceFailures",
      label: "Evidence failure",
      options: facets.evidenceFailures,
      selected: draft.evidenceFailures,
    },
    {
      key: "policyReasons",
      label: "Policy reason",
      options: facets.policyReasons,
      selected: draft.policyReasons,
    },
    {
      key: "repairs",
      label: "Likely repair",
      options: facets.repairs,
      selected: draft.repairs,
    },
    {
      key: "owners",
      label: "Individual assignment",
      options: facets.owners,
      selected: draft.owners,
    },
    {
      key: "statuses",
      label: "Queue status",
      options:
        facets.statuses.length > 0
          ? facets.statuses
          : [
              { cases: 0, key: "quarantined", label: "Quarantined" },
              { cases: 0, key: "in_review", label: "In review" },
            ],
      selected: draft.statuses,
    },
  ];

  function navigateToGroup(groupBy: AdminManualQuarantineGroupBy) {
    router.push(
      adminManualQuarantineControlsHref({
        ...query,
        activeViewId: null,
        clusterPage: 1,
        groupBy,
        page: 1,
        snapshotAt: null,
        snapshotRevision: null,
        asOfAt: null,
      }),
    );
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    router.push(
      adminManualQuarantineControlsHref({
        ...query,
        ...draft,
        activeViewId: null,
        clusterPage: 1,
        page: 1,
        pageSize,
        snapshotAt: null,
        snapshotRevision: null,
        asOfAt: null,
        sort,
      }),
    );
  }

  function clearFilters() {
    const cleared = emptyFilters();
    setDraft(cleared);
    setSort("oldest");
    setPageSize(25);
    router.push(
      adminManualQuarantineControlsHref({
        ...query,
        ...cleared,
        activeViewId: null,
        clusterPage: 1,
        page: 1,
        pageSize: 25,
        snapshotAt: null,
        snapshotRevision: null,
        asOfAt: null,
        sort: "oldest",
      }),
    );
  }

  async function saveView(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = viewName.trim();
    if (!name) {
      setMessage({ tone: "error", text: "Name this view before saving it." });
      return;
    }

    setBusy("save");
    setMessage(null);
    try {
      const response = await fetch("/api/admin/manual-quarantine/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filters: filtersFromQuery(query),
          groupBy: query.groupBy,
          name,
          pageSize: query.pageSize,
          sort: query.sort,
          viewId: activeViewId,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "The saved view could not be stored.");
      }
      setDeleteArmed(false);
      setMessage({
        tone: "success",
        text: activeViewId ? "Saved view updated." : "Current backlog view saved.",
      });
      router.refresh();
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "The saved view could not be stored.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function deleteView() {
    if (!activeViewId) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      setMessage({
        tone: "error",
        text: "Choose Confirm delete to remove this saved view. Queue cases are not changed.",
      });
      return;
    }

    setBusy("delete");
    setMessage(null);
    try {
      const response = await fetch("/api/admin/manual-quarantine/saved-views", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewId: activeViewId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "The saved view could not be deleted.");
      }
      setDeleteArmed(false);
      setViewName("");
      setMessage({ tone: "success", text: "Saved view deleted. Queue cases were not changed." });
      router.push("/dashboard/admin/issues?tab=quarantine");
      router.refresh();
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "The saved view could not be deleted.",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card manual-backlog-controls">
      <div className="manual-backlog-control-section">
        <div className="manual-backlog-control-heading">
          <div>
            <p className="operator-inbox-kicker">Change the clustering lens</p>
            <h3>Group the same cases another way</h3>
          </div>
          <Bookmark aria-hidden="true" size={18} />
        </div>
        <div aria-label="Backlog grouping" className="manual-backlog-group-selector" role="group">
          {groupOptions.map((option) => (
            <button
              aria-pressed={query.groupBy === option.value}
              className={`admin-subtab ${
                query.groupBy === option.value ? "admin-subtab-active" : ""
              }`}
              disabled={!available}
              key={option.value}
              onClick={() => navigateToGroup(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="manual-backlog-saved-view-bar">
        <label htmlFor={savedViewId}>
          <span>Saved view</span>
          <select
            className="input"
            disabled={!savedViewsAvailable || busy !== null}
            id={savedViewId}
            onChange={(event) => {
              const selected = savedViewOptions.find(
                (view) => view.id === event.target.value,
              );
              if (selected) router.push(selected.href);
            }}
            value={activeViewId || ""}
          >
            <option value="">Current filters</option>
            {savedViewOptions.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </select>
        </label>

        <form className="manual-backlog-save-form" onSubmit={saveView}>
          <label htmlFor={savedViewNameId}>
            <span>View name</span>
            <input
              className="input"
              disabled={!savedViewsAvailable || busy !== null}
              id={savedViewNameId}
              maxLength={80}
              onChange={(event) => setViewName(event.target.value)}
              placeholder="Example: Old unassigned repairs"
              value={viewName}
            />
          </label>
          <button
            className="button-secondary"
            disabled={!savedViewsAvailable || busy !== null || !viewName.trim()}
            type="submit"
          >
            <Save aria-hidden="true" size={15} />
            {busy === "save" ? "Saving…" : activeViewId ? "Update view" : "Save view"}
          </button>
          {activeViewId && (
            <button
              className="admin-issue-button admin-issue-button-danger"
              disabled={busy !== null}
              onClick={deleteView}
              type="button"
            >
              <Trash2 aria-hidden="true" size={14} />
              {busy === "delete"
                ? "Deleting…"
                : deleteArmed
                  ? "Confirm delete"
                  : "Delete view"}
            </button>
          )}
        </form>
      </div>

      <form className="manual-backlog-filter-form" onSubmit={applyFilters}>
        <div className="manual-backlog-control-heading">
          <div>
            <p className="operator-inbox-kicker">Narrow the exact total</p>
            <h3>Filter cases</h3>
            <p>Use Ctrl or Command to choose more than one value in a list.</p>
          </div>
          <Filter aria-hidden="true" size={18} />
        </div>

        <div className="manual-backlog-filter-grid">
          <label htmlFor={searchId}>
            <span>Search title or reason</span>
            <input
              className="input"
              id={searchId}
              maxLength={160}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  search: event.target.value,
                }))
              }
              placeholder="Search the current backlog"
              value={draft.search}
            />
          </label>

          {facetFields.map((field) => (
            <label key={field.key}>
              <span>{field.label}</span>
              <select
                className="input manual-backlog-multi-select"
                multiple
                onChange={(event) => {
                  const values = selectedValues(event.currentTarget);
                  setDraft((current) => ({
                    ...current,
                    [field.key]: values,
                  }));
                }}
                size={Math.min(4, Math.max(2, field.options.length))}
                value={field.selected}
              >
                {field.options.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label} ({formatNumber(option.cases)})
                  </option>
                ))}
              </select>
            </label>
          ))}

          <label>
            <span>Age</span>
            <select
              className="input"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  ageBucket:
                    (event.target.value as AdminManualQuarantineBacklogFilters["ageBucket"]) ||
                    null,
                }))
              }
              value={draft.ageBucket || ""}
            >
              <option value="">Any age</option>
              {ageOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label htmlFor={sortId}>
            <span>Sort</span>
            <select
              className="input"
              id={sortId}
              onChange={(event) =>
                setSort(event.target.value as AdminManualQuarantineBacklogQuery["sort"])
              }
              value={sort}
            >
              <option value="oldest">Oldest first</option>
              <option value="newest">Newest first</option>
              <option value="priority">Highest priority</option>
              <option value="domain">Source domain</option>
            </select>
          </label>

          <label htmlFor={pageSizeId}>
            <span>Cases per page</span>
            <select
              className="input"
              id={pageSizeId}
              onChange={(event) => setPageSize(Number(event.target.value))}
              value={pageSize}
            >
              {[10, 25, 50, 100].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="manual-backlog-filter-actions">
          <button className="button-primary" disabled={!available} type="submit">
            <Filter aria-hidden="true" size={15} />
            Apply filters
          </button>
          <button className="button-secondary" onClick={clearFilters} type="button">
            Clear filters
          </button>
        </div>
      </form>

      {message && (
        <p
          className={`manual-backlog-control-message manual-backlog-control-message-${message.tone}`}
          role={message.tone === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

export function adminManualQuarantineControlsHref(
  query: AdminManualQuarantineBacklogQuery,
) {
  const params = new URLSearchParams({ tab: "quarantine" });
  if (query.pageSize !== 25) params.set("mq_page_size", String(query.pageSize));
  if (query.groupBy !== "repair_group") params.set("mq_group_by", query.groupBy);
  if (query.sort !== "oldest") params.set("mq_sort", query.sort);
  appendAll(params, "mq_domain", query.domains);
  appendAll(params, "mq_failure", query.evidenceFailures);
  appendAll(params, "mq_policy", query.policyReasons);
  appendAll(params, "mq_repair", query.repairs);
  appendAll(params, "mq_owner", query.owners);
  appendAll(params, "mq_status", query.statuses);
  if (query.ageBucket) params.set("mq_age", query.ageBucket);
  if (query.search) params.set("mq_search", query.search);
  if (query.activeViewId) params.set("mq_view", query.activeViewId);
  if (query.snapshotAt) params.set("mq_snapshot", query.snapshotAt);
  if (query.snapshotRevision) {
    params.set("mq_revision", String(query.snapshotRevision));
  }
  if (query.asOfAt) params.set("mq_as_of", query.asOfAt);
  if (query.page > 1) params.set("mq_page", String(query.page));
  if (query.clusterPage > 1) {
    params.set("mq_cluster_page", String(query.clusterPage));
  }
  return `/dashboard/admin/issues?${params.toString()}`;
}

function filtersFromQuery(
  query: AdminManualQuarantineBacklogQuery,
): AdminManualQuarantineBacklogFilters {
  return {
    ageBucket: query.ageBucket,
    domains: [...query.domains],
    evidenceFailures: [...query.evidenceFailures],
    owners: [...query.owners],
    policyReasons: [...query.policyReasons],
    repairs: [...query.repairs],
    search: query.search,
    statuses: [...query.statuses],
  };
}

function emptyFilters(): AdminManualQuarantineBacklogFilters {
  return {
    ageBucket: null,
    domains: [],
    evidenceFailures: [],
    owners: [],
    policyReasons: [],
    repairs: [],
    search: "",
    statuses: [],
  };
}

function selectedValues(select: HTMLSelectElement) {
  return Array.from(select.selectedOptions, (option) => option.value);
}

function appendAll(params: URLSearchParams, key: string, values: readonly string[]) {
  for (const value of values) params.append(key, value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}
