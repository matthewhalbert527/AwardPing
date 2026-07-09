"use client";

import { useMemo, useState } from "react";
import type { SourcePageRequestIntakeType, SourcePageRequestStatus } from "@/lib/database.types";
import { sourceIntakeTypes } from "@/lib/source-intake";

export type SourceIntakeRequestView = {
  id: string;
  award_name: string;
  homepage_url: string;
  normalized_url: string | null;
  intake_type: SourcePageRequestIntakeType;
  status: SourcePageRequestStatus;
  status_reason: string | null;
  detected_award_name: string | null;
  detected_sponsor: string | null;
  matched_shared_award_id: string | null;
  created_shared_award_id: string | null;
  created_source_ids: string[] | null;
  ai_review: unknown;
  deterministic_review: unknown;
  error: string | null;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
};

export type SourceIntakeAwardOption = {
  id: string;
  name: string;
  slug: string | null;
};

export function AdminSourceIntakePanel({
  initialRequests,
  awardOptions,
}: {
  initialRequests: SourceIntakeRequestView[];
  awardOptions: SourceIntakeAwardOption[];
}) {
  const [urls, setUrls] = useState("");
  const [awardName, setAwardName] = useState("");
  const [notes, setNotes] = useState("");
  const [intakeType, setIntakeType] = useState<SourcePageRequestIntakeType>("unknown");
  const [requests, setRequests] = useState(initialRequests);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const awardById = useMemo(() => new Map(awardOptions.map((award) => [award.id, award])), [awardOptions]);

  async function submit(dryRun = false) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/source-intake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          urls,
          awardName: awardName || undefined,
          notes: notes || undefined,
          intakeType,
          dryRun,
        }),
      });
      const payload = await response.json();
      if (!response.ok && response.status !== 207) throw new Error(payload.error || "Source intake failed.");
      const created = Array.isArray(payload.results) ? payload.results : [];
      const okCount = created.filter((item: { ok?: boolean }) => item.ok).length;
      const failCount = created.length - okCount;
      setMessage(`${dryRun ? "Validated" : "Queued"} ${okCount} request${okCount === 1 ? "" : "s"}${failCount ? `; ${failCount} need attention` : ""}.`);
      if (!dryRun) window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Source intake failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runAction(id: string, action: string, sharedAwardId?: string) {
    setActionBusyId(id);
    setMessage("");
    try {
      const response = await fetch(`/api/admin/source-intake/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, sharedAwardId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Action failed.");
      setRequests((current) => current.map((row) => (row.id === id ? payload.request : row)));
      setMessage("Request updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setActionBusyId(null);
    }
  }

  return (
    <div className="grid gap-6">
      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <span className="badge">Source Intake</span>
            <h2 className="mt-3 text-2xl font-black">Paste new official sources</h2>
            <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-[var(--muted)]">
              One URL per line. You can also paste lines as <code>url | award name | notes</code>.
              The worker will capture, quality-gate, Gemini Batch review, match/create the award,
              add accepted sources, and queue reconciliation.
            </p>
          </div>
          {message && <span className="badge bg-[var(--brand-pink-soft)]">{message}</span>}
        </div>
        <div className="mt-5 grid gap-4">
          <textarea
            className="input min-h-40 font-mono text-sm"
            placeholder="https://example.edu/scholarship"
            value={urls}
            onChange={(event) => setUrls(event.target.value)}
          />
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_220px]">
            <label className="grid gap-2 text-sm font-black">
              Optional award name
              <input className="input" value={awardName} onChange={(event) => setAwardName(event.target.value)} />
            </label>
            <label className="grid gap-2 text-sm font-black">
              Shared notes
              <input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} />
            </label>
            <label className="grid gap-2 text-sm font-black">
              Intake type
              <select
                className="input"
                value={intakeType}
                onChange={(event) => setIntakeType(event.target.value as SourcePageRequestIntakeType)}
              >
                {sourceIntakeTypes.map((type) => (
                  <option key={type} value={type}>
                    {labelize(type)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="button-primary" disabled={busy} type="button" onClick={() => submit(false)}>
              Queue intake
            </button>
            <button className="button-secondary" disabled={busy} type="button" onClick={() => submit(true)}>
              Dry-run validate
            </button>
          </div>
        </div>
      </section>

      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black">Recent intake requests</h2>
            <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
              Ambiguous requests should be attached or retried; rejected requests stay available for audit.
            </p>
          </div>
          <span className="badge">{requests.length} shown</span>
        </div>
        <div className="mt-5 grid gap-3">
          {requests.map((request) => (
            <SourceIntakeRow
              actionBusy={actionBusyId === request.id}
              awardById={awardById}
              awardOptions={awardOptions}
              key={request.id}
              request={request}
              onAction={runAction}
            />
          ))}
          {requests.length === 0 && (
            <p className="text-sm font-semibold text-[var(--muted)]">No source intake requests yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function SourceIntakeRow({
  request,
  awardOptions,
  awardById,
  actionBusy,
  onAction,
}: {
  request: SourceIntakeRequestView;
  awardOptions: SourceIntakeAwardOption[];
  awardById: Map<string, SourceIntakeAwardOption>;
  actionBusy: boolean;
  onAction: (id: string, action: string, sharedAwardId?: string) => Promise<void>;
}) {
  const [selectedAwardId, setSelectedAwardId] = useState(request.matched_shared_award_id || "");
  const deterministic = objectValue(request.deterministic_review);
  const ai = objectValue(request.ai_review);
  const matchedAward = request.matched_shared_award_id ? awardById.get(request.matched_shared_award_id) : null;
  return (
    <article className={`admin-pipeline-row ${attentionStatus(request.status) ? "admin-pipeline-row-attention" : ""}`}>
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="badge">{labelize(request.status)}</span>
            <span className="badge">{labelize(request.intake_type)}</span>
            {request.created_source_ids?.length ? <span className="badge">{request.created_source_ids.length} source</span> : null}
          </div>
          <h3 className="mt-3 text-lg font-black">{request.detected_award_name || request.award_name}</h3>
          <p className="mt-1 break-all text-sm font-semibold text-[var(--muted)]">
            {request.normalized_url || request.homepage_url}
          </p>
          <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
            <Detail label="Reason" value={request.status_reason || "Not reported"} />
            <Detail label="Sponsor" value={request.detected_sponsor || cleanText(ai.detected_sponsor) || "Not detected"} />
            <Detail label="Deterministic" value={cleanText(deterministic.reason) || "Not run"} />
            <Detail label="Gemini" value={cleanText(ai.status) || cleanText(ai.source_relevance) || "Not run"} />
            <Detail label="Matched award" value={matchedAward?.name || request.created_shared_award_id || "None yet"} />
            <Detail label="Updated" value={formatDate(request.updated_at)} />
          </dl>
          {request.error && <p className="mt-3 text-sm font-black text-[var(--brand-burgundy)]">{request.error}</p>}
        </div>
        <div className="grid content-start gap-3">
          <select
            className="input"
            value={selectedAwardId}
            onChange={(event) => setSelectedAwardId(event.target.value)}
          >
            <option value="">Attach to award...</option>
            {awardOptions.map((award) => (
              <option key={award.id} value={award.id}>
                {award.name}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-2">
            <button
              className="button-secondary"
              disabled={actionBusy || !selectedAwardId}
              type="button"
              onClick={() => onAction(request.id, "attach_to_award", selectedAwardId)}
            >
              Attach
            </button>
            <button className="button-secondary" disabled={actionBusy} type="button" onClick={() => onAction(request.id, "retry")}>
              Retry
            </button>
            <button className="button-secondary" disabled={actionBusy} type="button" onClick={() => onAction(request.id, "rerun_ai_review")}>
              Rerun AI
            </button>
            <button className="button-secondary" disabled={actionBusy} type="button" onClick={() => onAction(request.id, "reject")}>
              Reject
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-black uppercase text-[var(--muted)]">{label}</dt>
      <dd className="font-bold">{value}</dd>
    </div>
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function labelize(value: string) {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function attentionStatus(status: SourcePageRequestStatus) {
  return status === "failed" || status === "needs_manual_review" || status === "rejected";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
