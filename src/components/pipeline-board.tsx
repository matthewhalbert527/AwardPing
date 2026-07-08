"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, Filter } from "lucide-react";
import type { AwardPriority, AwardWorkflowStatus } from "@/lib/database.types";
import {
  awardPriorities,
  awardWorkflowStatuses,
  priorityLabels,
  workflowStatusLabels,
} from "@/lib/award-workflow";
import { displayAwardSummary } from "@/lib/award-summary";
import { formatCentralDate } from "@/lib/time-zone";

export type PipelineMember = {
  id: string;
  email: string | null;
  role: string;
};

export type PipelineAward = {
  id: string;
  name: string;
  summary: string | null;
  workflowStatus: AwardWorkflowStatus;
  priority: AwardPriority;
  ownerMemberId: string | null;
  ownerEmail: string | null;
  lastReviewedAt: string | null;
  lastCheckedAt: string | null;
  recentChangeAt: string | null;
  trackedSourceCount: number;
  openTaskCount: number;
};

export function PipelineBoard({
  awards,
  members,
}: {
  awards: PipelineAward[];
  members: PipelineMember[];
}) {
  const [statusFilter, setStatusFilter] = useState<"all" | AwardWorkflowStatus>("all");
  const [priorityFilter, setPriorityFilter] = useState<"all" | AwardPriority>("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);

  const filteredAwards = useMemo(() => {
    return awards.filter((award) => {
      if (statusFilter !== "all" && award.workflowStatus !== statusFilter) return false;
      if (priorityFilter !== "all" && award.priority !== priorityFilter) return false;
      if (ownerFilter !== "all" && (award.ownerMemberId || "unassigned") !== ownerFilter) {
        return false;
      }
      if (needsReviewOnly && award.workflowStatus !== "needs_review") return false;
      return true;
    });
  }, [awards, needsReviewOnly, ownerFilter, priorityFilter, statusFilter]);

  const grouped = awardWorkflowStatuses.map((status) => ({
    status,
    awards: filteredAwards.filter((award) => award.workflowStatus === status),
  }));

  return (
    <div className="space-y-6">
      <section className="card rounded-3xl p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="badge">
            <Filter size={14} aria-hidden="true" />
            Filters
          </span>
          <select
            className="input w-auto"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as "all" | AwardWorkflowStatus)}
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            {awardWorkflowStatuses.map((status) => (
              <option value={status} key={status}>
                {workflowStatusLabels[status]}
              </option>
            ))}
          </select>
          <select
            className="input w-auto"
            value={priorityFilter}
            onChange={(event) => setPriorityFilter(event.target.value as "all" | AwardPriority)}
            aria-label="Filter by priority"
          >
            <option value="all">All priorities</option>
            {awardPriorities.map((priority) => (
              <option value={priority} key={priority}>
                {priorityLabels[priority]}
              </option>
            ))}
          </select>
          <select
            className="input w-auto"
            value={ownerFilter}
            onChange={(event) => setOwnerFilter(event.target.value)}
            aria-label="Filter by owner"
          >
            <option value="all">All owners</option>
            <option value="unassigned">Unassigned</option>
            {members.map((member) => (
              <option value={member.id} key={member.id}>
                {member.email || "Advisor"}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm font-bold">
            <input
              type="checkbox"
              checked={needsReviewOnly}
              onChange={(event) => setNeedsReviewOnly(event.target.checked)}
            />
            Review queue only
          </label>
        </div>
      </section>

      <div className="grid gap-5">
        {grouped.map((group) => (
          <section className="card rounded-3xl p-5" key={group.status}>
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-2xl font-black">{workflowStatusLabels[group.status]}</h2>
              <span className="badge">{group.awards.length}</span>
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[820px] border-separate border-spacing-y-2 text-left text-sm">
                <thead className="text-[var(--muted)]">
                  <tr>
                    <th className="px-3 py-2">Award</th>
                    <th className="px-3 py-2">Priority</th>
                    <th className="px-3 py-2">Owner</th>
                    <th className="px-3 py-2">Sources</th>
                    <th className="px-3 py-2">Open tasks</th>
                    <th className="px-3 py-2">Recent update</th>
                    <th className="px-3 py-2">Last reviewed</th>
                    <th className="px-3 py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {group.awards.map((award) => {
                    const summary = displayAwardSummary(award.summary);

                    return (
                      <tr className="rounded-2xl bg-[var(--brand-blue-soft)]" key={award.id}>
                        <td className="rounded-l-2xl px-3 py-3">
                          <p className="font-black">{award.name}</p>
                          {summary && (
                            <p className="mt-1 line-clamp-2 max-w-md text-[var(--muted)]">
                              {summary}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <span className={award.priority === "high" ? "badge bg-[var(--brand-pink-soft)]" : "badge"}>
                            {priorityLabels[award.priority]}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-[var(--muted)]">
                          {award.ownerEmail || "Unassigned"}
                        </td>
                        <td className="px-3 py-3">{award.trackedSourceCount}</td>
                        <td className="px-3 py-3">{award.openTaskCount}</td>
                        <td className="px-3 py-3 text-[var(--muted)]">
                          {award.recentChangeAt ? formatDate(award.recentChangeAt) : "None"}
                        </td>
                        <td className="px-3 py-3 text-[var(--muted)]">
                          {award.lastReviewedAt ? formatDate(award.lastReviewedAt) : "Not yet"}
                        </td>
                        <td className="rounded-r-2xl px-3 py-3">
                          <Link className="button-secondary" href={`/dashboard/pipeline/${award.id}`}>
                            Open
                            <ArrowRight size={15} aria-hidden="true" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {group.awards.length === 0 && (
                <p className="rounded-2xl border border-dashed border-[var(--line)] p-4 text-[var(--muted)]">
                  No awards in this lane.
                </p>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function formatDate(value: string) {
  return formatCentralDate(value);
}
