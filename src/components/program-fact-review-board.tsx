"use client";

import { useRef, useState } from "react";
import type { ProgramFactBatchItem, ProgramFactPublication } from "@/lib/program-fact-review-types";
import { formatCentralDateTime } from "@/lib/time-zone";

type Props = { initialAwards: ProgramFactBatchItem[]; initialPublication: ProgramFactPublication };
type SavedSource = { id: string; url: string; title: string | null; text: string; blocks?: unknown[] };
type Evidence = { id: string; hash: string; review: unknown; sources: SavedSource[] };
type Batch = { awards: ProgramFactBatchItem[]; publication: ProgramFactPublication };
const API = "/api/admin/program-facts";
const MAX_DRAFT_LENGTH = 4 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function safeOfficialUrl(value: string) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function fieldLabel(value: string) { return value.replace(/_/g, " ").replace(/^./, letter => letter.toUpperCase()); }
function ready(award: ProgramFactBatchItem) {
  return award.sources.length > 0 && award.sources.every(source => source.ready === true) && Boolean(award.review && award.review.blockers.length === 0 && award.review.fields.length === 21 && award.review.fields.every(field => field.status !== "unresolved"));
}
function isBatch(value: unknown): value is Batch {
  return object(value) && Array.isArray(value.awards) && value.awards.length === 25 && new Set(value.awards.map(item => object(item) ? item.cohort_key : null)).size === 25 && object(value.publication) && value.publication.schema === "awardping.program-fact-publication.v1";
}
async function request(url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, body === undefined ? { cache: "no-store", credentials: "same-origin" } : {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(object(value) && typeof value.error === "string" ? value.error.slice(0, 1000) : "The request failed. No successful change was confirmed.");
  return value;
}

export function ProgramFactReviewBoard({ initialAwards, initialPublication }: Props) {
  const [batch, setBatch] = useState<Batch>({ awards: initialAwards, publication: initialPublication });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [results, setResults] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [editor, setEditor] = useState("");
  const [cycles, setCycles] = useState<Record<string, string>>({});
  const [publishChecked, setPublishChecked] = useState(false);
  // Synchronous duplicate prevention also protects against a stale click handler
  // before the disabled state has reached the DOM. The server rechecks identity.
  const inFlight = useRef(false);
  const attestations = useRef<Record<string, string>>({});
  const evidenceVersion = useRef("");
  const editorDirty = Boolean(evidence && editor !== JSON.stringify(evidence.review, null, 2));
  const selected = batch.awards.filter(award => award.review?.status === "draft" && ready(award) && checked[award.review.id] === award.review.content_hash);
  const published = new Map(batch.publication.cohorts.map(item => [item.cohort_key, item]));
  const publishable = batch.awards.length === 25 && batch.awards.every(award => award.review?.status === "approved" &&
    (ready(award) && award.review.current || (batch.publication.active && published.get(award.cohort_key)?.review_id === award.review.id)));
  const hasUnpublishedApproval = batch.awards.some(award => award.review?.status === "approved" && published.get(award.cohort_key)?.review_id !== award.review.id);

  async function exclusive(label: string, action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(label); setNotice("");
    try { await action(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "The request failed. Reload before trying again."); }
    finally { inFlight.current = false; setBusy(null); }
  }
  async function reload() {
    const value = await request(API);
    if (!isBatch(value)) throw new Error("The complete 25-award batch could not be confirmed. Reload the page.");
    setBatch(value); setChecked({}); attestations.current = {}; setEvidence(null); evidenceVersion.current = ""; setEditor(""); setPublishChecked(false);
  }
  async function loadEvidence(award: ProgramFactBatchItem) {
    if (!award.review) return;
    const review = award.review;
    await exclusive("Loading saved text", async () => {
      const value = await request(`${API}?review=${encodeURIComponent(review.id)}`);
      if (!object(value) || value.id !== review.id || value.content_hash !== review.content_hash || !object(value.review) || value.review.cohort_key !== award.cohort_key || value.review.award_id !== award.award_id ||
          !Array.isArray(value.sources) || value.sources.length !== award.sources.length || value.sources.some(source => !object(source) || typeof source.id !== "string" || typeof source.url !== "string" || typeof source.text !== "string" || !award.sources.some(expected => expected.id === source.id && expected.url === source.url)) ||
          new Set(value.sources.map(source => (source as SavedSource).id)).size !== award.sources.length) throw new Error("Saved source identities could not be confirmed. Approval remains unavailable.");
      setEvidence({ id: review.id, hash: review.content_hash, review: value.review, sources: value.sources as SavedSource[] });
      evidenceVersion.current = `${review.id}:${review.content_hash}`; setEditor(JSON.stringify(value.review, null, 2));
    });
  }
  async function approveChecked() {
    const targets = selected.filter(award => award.review && attestations.current[award.review.id] === award.review.content_hash);
    if (!targets.length) return;
    await exclusive("Approving checked awards", async () => {
      // Each award has its own version, request, authorization check and result.
      // A failure does not claim approval for the remaining awards or retry it.
      const outcomes: Record<string, string> = {};
      for (const award of targets) {
        const review = award.review!;
        delete attestations.current[review.id];
        setChecked(previous => { const next = { ...previous }; delete next[review.id]; return next; });
        try { await request(API, { action: "approve", id: review.id, expected_hash: review.content_hash }); outcomes[award.cohort_key] = "Approval recorded. Not yet published."; }
        catch (error) { outcomes[award.cohort_key] = error instanceof Error ? error.message : "Approval was not confirmed."; }
        setResults(previous => ({ ...previous, ...outcomes }));
      }
      await reload();
      setNotice("Checked awards processed separately. Review each result below; publication is a separate step.");
    });
  }
  async function prepare(award: ProgramFactBatchItem) {
    const cycle = cycles[award.cohort_key]?.trim();
    if (!cycle || cycle.length > 120 || award.sources.length === 0 || award.sources.some(source => source.ready !== true)) return;
    await exclusive("Preparing empty draft", async () => {
      await request(API, { action: "prepare", cohort: award.cohort_key, cycle }); await reload();
      setNotice("An empty, unresolved draft was prepared. No program details were inferred or approved.");
    });
  }
  async function saveDraft() {
    if (!evidence || !editorDirty || editor.length > MAX_DRAFT_LENGTH || evidenceVersion.current !== `${evidence.id}:${evidence.hash}`) return;
    await exclusive("Saving draft", async () => {
      let review: unknown;
      try { review = JSON.parse(editor); } catch { throw new Error("The private draft is not valid JSON. Nothing was saved."); }
      if (!object(review) || !object(evidence.review) || review.cohort_key !== evidence.review.cohort_key || review.award_id !== evidence.review.award_id) throw new Error("Keep the original award identity. Nothing was saved.");
      await request(API, { action: "save", review }); await reload();
      setNotice("Draft saved as a checked private version. It has not been approved or published.");
    });
  }
  async function publishBatch() {
    if (!publishChecked || !publishable || !hasUnpublishedApproval) return;
    await exclusive("Publishing approved batch", async () => {
      setPublishChecked(false);
      await request(API, { action: "publish", expected_revision: batch.publication.revision,
        review_ids: Object.fromEntries(batch.awards.map(award => [award.cohort_key, award.review!.id])) });
      await reload(); setNotice("The exact 25-award release was published together. Separate approval records are retained.");
    });
  }

  return <section aria-label="Current award details review" aria-busy={busy !== null} className="space-y-5">
    <header className="card space-y-3 p-5 sm:p-6">
      <h1 className="admin-page-title">Current award details</h1>
      <p className="max-w-4xl text-[var(--muted)]">Review the official text and proposed details for each of the 25 awards. Approvals are recorded separately; public details change only when the approved batch is published.</p>
      <p className="text-sm font-semibold">{batch.awards.filter(award => award.review).length} prepared · {batch.awards.filter(award => award.review?.status === "approved").length} approved · {batch.publication.active ? batch.publication.cohorts.length : 0} in public release</p>
      <div className="flex flex-wrap gap-2"><button type="button" className="button-secondary" disabled={busy !== null} onClick={() => exclusive("Refreshing", reload)}>Refresh status</button><button type="button" className="button-primary" disabled={busy !== null || selected.length === 0} onClick={approveChecked}>Approve checked ({selected.length})</button></div>
      <p className="text-xs text-[var(--muted)]">No AI requests, paid retries, notifications, or initial-coverage updates are created by this screen.</p>
    </header>
    <p role="status" aria-live="polite" className="text-sm">{busy || notice}</p>
    <div className="space-y-3">{batch.awards.map(award => {
      const review = award.review, publication = published.get(award.cohort_key);
      const pinned = Boolean(batch.publication.active && publication?.review_id === review?.id);
      const activeEvidence = evidence?.id === review?.id && evidence?.hash === review?.content_hash ? evidence : null;
      const canAttest = Boolean(review?.status === "draft" && ready(award) && activeEvidence && !editorDirty);
      const unavailable = award.sources.filter(source => source.ready !== true);
      return <article key={award.cohort_key} className="card overflow-hidden" aria-labelledby={`award-fact-${award.cohort_key}`}>
        <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0"><h2 id={`award-fact-${award.cohort_key}`} className="font-bold">{award.name}</h2><p className="mt-1 text-sm text-[var(--muted)]">{review ? `Cycle: ${review.cycle}` : "No current-details proposal prepared"}</p><p className="mt-1 text-xs">{award.sources.length - unavailable.length}/{award.sources.length} source pages ready{review?.reviewed_at ? ` · Approved ${formatCentralDateTime(review.reviewed_at)}` : ""}</p></div>
          <div className="flex flex-wrap gap-2 text-xs font-semibold" aria-label={`${award.name} review status`}><span className="rounded-md border px-2 py-1">{review?.status === "approved" ? "Approved" : review ? "Draft" : "Not prepared"}</span><span className="rounded-md border px-2 py-1">{pinned ? publication?.current ? "Published · current" : "Published · needs reconciliation" : batch.publication.active && publication ? "Earlier approved version is live" : "Not in public release"}</span></div>
        </div>
        {results[award.cohort_key] ? <p role="status" className="border-t px-5 py-3 text-sm">{results[award.cohort_key]}</p> : null}
        <details className="border-t p-4 sm:p-5"><summary className="cursor-pointer font-semibold">Review details and sources</summary>
          {unavailable.length ? <div className="mt-4 rounded-md border p-3 text-sm"><p className="font-bold">Source collection or comparison is incomplete.</p><p>Approval is unavailable until the complete official source set has verified repeat captures and no blocking comparison.</p></div> : null}
          {review?.blockers.length ? <section className="mt-4 text-sm" aria-label="Unresolved issues"><h3 className="font-bold">Unresolved issues</h3><ul className="mt-2 list-disc space-y-1 pl-5">{review.blockers.map((issue, index) => <li key={`${index}:${issue}`}>{issue}</li>)}</ul></section> : null}
          <section className="mt-4" aria-label="Official sources"><h3 className="font-bold">Official sources</h3><ul className="mt-2 space-y-2 text-sm">{award.sources.map(source => { const href = safeOfficialUrl(source.url); return <li key={source.id} className="break-words">{href ? <a className="underline" href={href} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a> : <span>{source.title || source.url}</span>} <span className="text-[var(--muted)]">— {source.ready === true ? "Repeat text capture ready" : `Held: ${source.state || "collection unavailable"}`}</span></li>; })}</ul></section>
          {review ? <>
            <dl className="mt-5 divide-y border-y">{review.fields.map(field => <div className="grid gap-1 py-3 text-sm sm:grid-cols-[12rem_1fr]" key={field.field}><dt className="font-semibold">{fieldLabel(field.field)}</dt><dd>{field.status === "verified" ? <ul className="space-y-1">{field.items.map((item, index) => <li key={index}>{item.track ? <strong>{item.track}: </strong> : null}{item.value}</li>)}</ul> : <span className={field.status === "unresolved" ? "font-semibold" : "text-[var(--muted)]"}>{field.status === "unresolved" ? "Unresolved" : "Not published"}</span>}{field.note ? <p className="mt-1 text-[var(--muted)]">{field.note}</p> : null}</dd></div>)}</dl>
            <button type="button" className="button-secondary mt-4" disabled={busy !== null} onClick={() => loadEvidence(award)}>{activeEvidence ? "Reload saved text and proposal" : "Load saved text and proposal"}</button>
            {activeEvidence ? <section className="mt-4 space-y-3 rounded-md border p-4" aria-label={`${award.name} saved text review`}>
              <h3 className="font-bold">Saved official text</h3><p className="text-sm text-[var(--muted)]">These are the retained captures supporting this exact draft. Review all pages, applicant groups, and application tracks. Page content is displayed as text only.</p>
              {activeEvidence.sources.map(source => <details key={source.id} className="rounded-md border p-3"><summary className="cursor-pointer font-semibold">{source.title || source.url}</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">{source.text}</pre><details className="mt-3"><summary className="cursor-pointer text-sm underline">Text block IDs and offsets for citations</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(source.blocks ?? [], null, 2)}</pre></details></details>)}
              <details><summary className="cursor-pointer font-semibold">Private draft editor</summary><p id={`draft-help-${award.cohort_key}`} className="my-2 text-sm text-[var(--muted)]">Edit the JSON proposal using exact supporting passages and UTF-16 text offsets from the saved blocks. Keep source, roster, capture, and award identities unchanged. Use unresolved for gaps or contradictions; use not_published only after checking the complete official source set. Saving never approves or publishes.</p><label className="sr-only" htmlFor={`draft-${award.cohort_key}`}>Private proposal for {award.name}</label><textarea id={`draft-${award.cohort_key}`} aria-describedby={`draft-help-${award.cohort_key}`} className="min-h-96 w-full font-mono text-xs" value={editor} maxLength={MAX_DRAFT_LENGTH} disabled={busy !== null} onChange={event => { setEditor(event.target.value); delete attestations.current[review.id]; setChecked(previous => { const next = { ...previous }; delete next[review.id]; return next; }); }} /><button type="button" className="button-secondary mt-2" disabled={busy !== null || !editorDirty} onClick={saveDraft}>Save private draft</button></details>
            </section> : null}
            {review.status === "draft" ? <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm"><input type="checkbox" className="mt-1" disabled={busy !== null || !canAttest} checked={checked[review.id] === review.content_hash} onChange={event => {
              if (!canAttest || inFlight.current || evidenceVersion.current !== `${review.id}:${review.content_hash}`) return;
              if (event.target.checked) { attestations.current[review.id] = review.content_hash; setChecked(previous => ({ ...previous, [review.id]: review.content_hash })); }
              else { delete attestations.current[review.id]; setChecked(previous => { const next = { ...previous }; delete next[review.id]; return next; }); }
            }} /><span>I checked the complete saved source set and this exact proposal, including its cycle and application tracks. These current details are supported and ready for separate approval.{!canAttest ? <span className="mt-1 block text-[var(--muted)]">Load the saved text, resolve every issue, and save any edits first.</span> : null}</span></label> : review.current ? <p className="mt-4 text-sm">This approval is current. Publication is a separate step.</p> : <p className="mt-4 text-sm font-semibold">This approval needs reconciliation with the current sources before it can replace public details.</p>}
            <details className="mt-4 rounded-md border p-3"><summary className="cursor-pointer text-sm font-semibold">Prepare a replacement from current sources</summary><p className="mt-2 text-sm text-[var(--muted)]">If sources or the cycle have changed, create a new empty proposal from the current repeat captures. Previous proposals, approvals, and public details are retained. No previous facts are marked verified automatically.</p><label className="mt-3 block text-sm font-semibold" htmlFor={`replacement-cycle-${award.cohort_key}`}>Current application cycle or track</label><input id={`replacement-cycle-${award.cohort_key}`} className="mt-2 w-full sm:max-w-sm" value={cycles[award.cohort_key] || ""} maxLength={120} disabled={busy !== null} onChange={event => setCycles(previous => ({ ...previous, [award.cohort_key]: event.target.value }))} /><button type="button" className="button-secondary mt-3" disabled={busy !== null || !cycles[award.cohort_key]?.trim() || unavailable.length > 0 || award.sources.length === 0} onClick={() => prepare(award)}>Prepare replacement draft</button></details>
          </> : <div className="mt-5 space-y-2"><label className="block text-sm font-semibold" htmlFor={`cycle-${award.cohort_key}`}>Application cycle or track</label><input id={`cycle-${award.cohort_key}`} className="w-full sm:max-w-sm" value={cycles[award.cohort_key] || ""} maxLength={120} placeholder="Use the cycle stated by official sources" disabled={busy !== null} onChange={event => setCycles(previous => ({ ...previous, [award.cohort_key]: event.target.value }))} /><p className="text-sm text-[var(--muted)]">Preparing creates an empty, unresolved proposal—not approved facts from older data.</p><button type="button" className="button-secondary" disabled={busy !== null || !cycles[award.cohort_key]?.trim() || unavailable.length > 0 || award.sources.length === 0} onClick={() => prepare(award)}>Prepare empty draft</button></div>}
        </details>
      </article>;
    })}</div>
    <section className="card space-y-3 p-5 sm:p-6" aria-label="Publish approved award details">
      <h2 className="font-bold">Publish approved details</h2><p className="text-sm text-[var(--muted)]">The first public release requires all 25 awards to have current, source-supported approvals. Later releases retain each unchanged award’s previously approved details. Collection holds do not become invented facts.</p>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={publishChecked} disabled={busy !== null || !publishable || !hasUnpublishedApproval} onChange={event => setPublishChecked(event.target.checked)} /><span>I reviewed the separate approval results and want to publish this exact 25-award batch together.</span></label>
      <button type="button" className="button-primary" disabled={busy !== null || !publishChecked || !publishable || !hasUnpublishedApproval} onClick={publishBatch}>Publish approved 25-award batch</button>
      {!publishable ? <p className="text-sm font-semibold">Publication is unavailable until all required approvals are ready.</p> : !hasUnpublishedApproval ? <p className="text-sm">The approved versions are already in the public release.</p> : null}
    </section>
  </section>;
}
