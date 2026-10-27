"use client";

import { useRef, useState } from "react";
import type { VariationAdminPage, VariationCoverageGap, VariationUnit } from "@/lib/program-variation-review-types";

const API = "/api/admin/program-variations";
const MAX_EDITOR = 4 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function gaps(value: unknown): value is VariationCoverageGap[] {
  return Array.isArray(value) && value.length <= 50 && new Set(value.map(gap => object(gap) ? gap.key : null)).size === value.length && value.every(gap => {
    if (!object(gap) || Object.keys(gap).length !== 3 || typeof gap.key !== "string" || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(gap.key) ||
      typeof gap.label !== "string" || !gap.label.trim() || gap.label !== gap.label.trim() || gap.label.length > 500 || /[\u0000-\u001f\u007f]/.test(gap.label)) return false;
    if (gap.source_url === null) return true;
    if (typeof gap.source_url !== "string" || gap.source_url.length > 2048 || /[\u0000-\u0020\u007f]/.test(gap.source_url)) return false;
    try { const url = new URL(gap.source_url); return url.protocol === "https:" && !url.username && !url.password && !url.hash && url.hostname.includes("."); } catch { return false; }
  });
}
type UnitEvidence = { inventory: NonNullable<VariationAdminPage["inventory"]>; scope: VariationAdminPage["scopes"][number];
  shared: { id: string; content_hash: string } | null; unit: VariationUnit; review: { id: string; content_hash: string; blockers: string[] } | null;
  sources: Array<{ id: string; url: string; title: string | null; text: string; blocks: unknown[]; capture_id: string }> };
type ApprovalBatch = { schema: "awardping.program-variation-admin-batch.v1"; revision: string; active: boolean; approval_ids: Record<string, string>;
  awards: Array<{ cohort_key: string; approval_id: string | null; content_hash: string | null; current: boolean; inventory_id: string | null;
    inventory_revision: string | null; expected_variants: number; reviewed_variants: number; blockers: string[] }> };

async function request(url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, body === undefined ? { cache: "no-store", credentials: "same-origin" } : {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(object(value) && typeof value.error === "string" ? value.error : "The action was not confirmed. Reload before trying again.");
  return value;
}
function page(value: unknown, cohort: string): value is VariationAdminPage {
  return object(value) && (value.inventory === null || object(value.inventory) && value.inventory.cohort_key === cohort && uuid(value.inventory.id) && uuid(value.inventory.revision) && gaps(value.inventory.coverage_gaps)) &&
    Number.isSafeInteger(value.total) && (value.total as number) >= 0 && Array.isArray(value.scopes) && value.scopes.length <= 100 &&
    new Set(value.scopes.map(scope => object(scope) ? scope.scope_key : null)).size === value.scopes.length &&
    (value.next_cursor === null || typeof value.next_cursor === "string" && value.next_cursor.length <= 256);
}
function pageUrl(cohort: string, inventory?: string, cursor?: string | null) {
  const query = new URLSearchParams({ cohort });
  if (inventory) query.set("inventory", inventory);
  if (cursor) query.set("cursor", cursor);
  return `${API}?${query}`;
}

export function ProgramVariationReviewPanel({ cohort, awardName }: { cohort: string; awardName: string }) {
  const [data, setData] = useState<VariationAdminPage | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [cycle, setCycle] = useState("");
  const [expected, setExpected] = useState("0");
  const [countReason, setCountReason] = useState("");
  const [gapEditor, setGapEditor] = useState("[]");
  const [gapReason, setGapReason] = useState("");
  const [gapsClearedChecked, setGapsClearedChecked] = useState(false);
  const [scopeEditor, setScopeEditor] = useState("[]");
  const [inventoryChecked, setInventoryChecked] = useState(false);
  const [awardChecked, setAwardChecked] = useState(false);
  const [evidence, setEvidence] = useState<UnitEvidence | null>(null);
  const [unitEditor, setUnitEditor] = useState("");
  const inFlight = useRef(false);

  async function exclusive(label: string, action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(label); setNotice("");
    try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : "The action was not confirmed."); }
    finally { inFlight.current = false; setBusy(""); }
  }
  async function reload(inventory?: string, cursor?: string | null) {
    const value = await request(pageUrl(cohort, inventory, cursor));
    if (!page(value, cohort)) throw new Error("The inventory identities could not be confirmed.");
    if (data?.inventory && inventory && (value.inventory?.id !== inventory || value.inventory?.revision !== data.inventory.revision)) throw new Error("The inventory changed. Reload its first page.");
    setData(value); if (value.inventory) { setExpected(String(value.inventory.expected_variants)); setCycle(value.inventory.cycle); }
    setGapEditor(JSON.stringify(value.inventory?.coverage_gaps || [], null, 2)); setGapReason(""); setGapsClearedChecked(false);
    setInventoryChecked(false); setAwardChecked(false); setEvidence(null); setUnitEditor("");
  }
  async function createInventory() {
    const count = Number(expected);
    if (!cycle.trim() || cycle.length > 120 || !Number.isSafeInteger(count) || count < 0 || inFlight.current) return;
    await exclusive("Creating private inventory", async () => {
      await request(API, { action: "create_inventory", cohort, cycle: cycle.trim(), expected_variants: count, previous_revision: data?.inventory?.revision || null });
      await reload(); setNotice("Private inventory created. Its coverage and facts are not approved.");
    });
  }
  async function appendScopes() {
    if (!data?.inventory || data.inventory.status !== "draft") return;
    await exclusive("Saving provider routes", async () => {
      const scopes: unknown = JSON.parse(scopeEditor);
      if (!Array.isArray(scopes) || !scopes.length || scopes.length > 25) throw new Error("Add one to 25 reviewed source scopes at a time.");
      await request(API, { action: "append_scopes", inventory_id: data.inventory!.id, expected_revision: data.inventory!.revision, scopes });
      setScopeEditor("[]"); await reload(); setNotice("Provider routes saved privately. Completeness has not been approved.");
    });
  }
  async function reviseCount() {
    const count = Number(expected), inventory = data?.inventory;
    if (!inventory || inventory.status !== "draft" || !Number.isSafeInteger(count) || count < 0 || countReason.trim().length < 20) return;
    await exclusive("Revising the incomplete inventory", async () => {
      await request(API, { action: "revise_expected_variants", inventory_id: inventory.id, expected_revision: inventory.revision,
        expected_hash: inventory.draft_hash, expected_variants: count, reason: countReason.trim() });
      setCountReason(""); await reload(); setNotice("The expected route count was revised. The inventory remains private and incomplete.");
    });
  }
  async function sealInventory() {
    if (!data?.inventory || !inventoryChecked || data.inventory.status !== "draft" || data.inventory.coverage_gaps.length) return;
    const inventory = data.inventory;
    await exclusive("Confirming complete provider inventory", async () => {
      setInventoryChecked(false);
      await request(API, { action: "seal_inventory", inventory_id: inventory.id, expected_revision: inventory.revision,
        expected_hash: inventory.draft_hash, complete_provider_inventory_reviewed: true });
      await reload(); setNotice("The inventory is sealed. Every route still needs a supported detail review.");
    });
  }
  async function saveGaps() {
    const inventory = data?.inventory;
    if (!inventory || inventory.status !== "draft" || gapReason.trim().length < 20 || gapEditor.length > 128 * 1024) return;
    await exclusive("Saving unresolved provider coverage", async () => {
      const proposed: unknown = JSON.parse(gapEditor);
      if (!gaps(proposed)) throw new Error("Provide up to 50 distinct gaps with a key, description and HTTPS official source link or null.");
      if (inventory.coverage_gaps.some(gap => !proposed.some(next => next.key === gap.key)) && !gapsClearedChecked) throw new Error("Confirm that the removed gaps were resolved before saving.");
      await request(API, { action: "set_inventory_gaps", inventory_id: inventory.id, expected_revision: inventory.revision,
        expected_hash: inventory.draft_hash, coverage_gaps: proposed, reason: gapReason.trim() });
      await reload(); setNotice("Provider coverage gaps saved privately. The inventory remains unapproved.");
    });
  }
  async function loadUnit(scopeKey: string) {
    if (!data?.inventory) return;
    const inventory = data.inventory;
    await exclusive("Loading saved official text", async () => {
      const url = new URL(pageUrl(cohort, inventory.id), "https://awardping.invalid"); url.searchParams.set("scope", scopeKey);
      const value = await request(`${url.pathname}${url.search}`);
      if (!object(value) || !object(value.inventory) || value.inventory.id !== inventory.id || value.inventory.revision !== inventory.revision ||
          !object(value.scope) || value.scope.scope_key !== scopeKey || !object(value.unit) || value.unit.inventory_id !== inventory.id || value.unit.scope_key !== scopeKey ||
          !Array.isArray(value.sources) || value.sources.some(source => !object(source) || !uuid(source.id) || typeof source.url !== "string" || typeof source.text !== "string")) throw new Error("The saved text belongs to a different inventory or route.");
      setEvidence(value as unknown as UnitEvidence); setUnitEditor(JSON.stringify(value.unit, null, 2)); setAwardChecked(false);
    });
  }
  async function saveUnit() {
    if (!evidence || !unitEditor || unitEditor.length > MAX_EDITOR) return;
    await exclusive("Validating private route details", async () => {
      const unit: unknown = JSON.parse(unitEditor);
      if (!object(unit) || unit.inventory_id !== evidence.inventory.id || unit.scope_key !== evidence.scope.scope_key) throw new Error("Keep the inventory and route identities unchanged.");
      await request(API, { action: "save_unit", unit }); await reload();
      setNotice("The supported private review was saved. No approval or public facts changed.");
    });
  }
  async function approveAward() {
    if (!data?.inventory || data.inventory.status !== "sealed" || !awardChecked) return;
    const inventory = data.inventory;
    await exclusive("Checking every route before award approval", async () => {
      setAwardChecked(false);
      const scopes: VariationAdminPage["scopes"] = [];
      const cursors = new Set<string>(); let cursor: string | null = null;
      do {
        const value = await request(pageUrl(cohort, inventory.id, cursor));
        if (!page(value, cohort) || value.inventory?.revision !== inventory.revision || value.inventory.content_hash !== inventory.content_hash) throw new Error("The provider inventory changed. Reload before approval.");
        scopes.push(...value.scopes.filter(scope => !scope.retired));
        cursor = value.next_cursor;
        if (cursor && cursors.has(cursor)) throw new Error("The complete route list could not be confirmed.");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const common = scopes.find(scope => scope.scope_key === "common"), children = scopes.filter(scope => scope.scope_key !== "common");
      if (children.length !== inventory.expected_variants || scopes.length !== new Set(scopes.map(scope => scope.scope_key)).size ||
          !common?.review?.current || !children.length && common.review.blockers.length || scopes.some(scope => !scope.review?.current || scope.scope_key !== "common" && scope.review.blockers.length)) throw new Error("Every provider route needs a current complete review. No award approval was sent.");
      await request(API, { action: "approve_award", inventory_id: inventory.id, expected_inventory_hash: inventory.content_hash,
        shared_review_id: common.review.id, shared_hash: common.review.content_hash,
        child_reviews: Object.fromEntries(children.map(scope => [scope.scope_key, { id: scope.review!.id, content_hash: scope.review!.content_hash }])) });
      await reload(); setNotice("This award's complete provider inventory and current details are approved privately. Publication remains separate.");
    });
  }

  const inventory = data?.inventory;
  return <section className="border-t p-4 sm:p-5" aria-label={`${awardName} provider variation review`} aria-busy={Boolean(busy)}>
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-bold">Provider coverage and current details</h3>
      <p className="mt-1 text-sm text-[var(--muted)]">{inventory ? `${inventory.cycle} · ${inventory.expected_variants} applicant routes · ${inventory.status === "sealed" ? "Inventory checked" : "Inventory incomplete"}` : "Country, course and applicant rules are reviewed separately. Earlier drafts remain available below."}</p></div>
      <button type="button" className="button-secondary text-sm" disabled={Boolean(busy)} onClick={() => exclusive("Loading provider coverage", () => reload())}>{data ? "Refresh coverage" : "Load provider coverage"}</button></div>
    <p role="status" aria-live="polite" className="mt-2 text-sm">{busy || notice}</p>
    {data ? <div className="mt-3 space-y-4">
      {inventory ? <>
        <p className="text-sm font-semibold">{data.approval ? data.approval.current ? "Award approval is current; publication is separate." : "Award approval needs reconciliation." : "No complete award approval recorded."}</p>
        <section className="rounded-md border p-3 text-sm" aria-label="Unresolved provider coverage">
          <h4 className="font-bold">{inventory.coverage_gaps.length ? `${inventory.coverage_gaps.length} provider coverage gaps` : "No provider coverage gaps recorded"}</h4>
          <p className="mt-1 text-[var(--muted)]">{inventory.coverage_gaps.length ? "Resolve these before confirming the inventory is complete." : "An empty list does not establish complete coverage; the official inventory still requires review."}</p>
          {inventory.coverage_gaps.length ? <ul className="mt-2 space-y-2">{inventory.coverage_gaps.map(gap => <li key={gap.key}>{gap.label}{gap.source_url ? <> <a className="underline" href={gap.source_url} target="_blank" rel="noopener noreferrer">Official reference</a></> : null}</li>)}</ul> : null}
        </section>
        <ul className="space-y-2">{data.scopes.map(scope => <li key={scope.scope_key} className="rounded-md border p-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2"><div><strong>{scope.label}</strong><p className="text-[var(--muted)]">{[scope.attributes.country, scope.attributes.course, scope.attributes.track, scope.attributes.applicant_group].filter(Boolean).join(" · ")}</p>
            <p>{scope.retired ? "Historical route" : !scope.review ? "Not reviewed" : !scope.review.current ? "Review needs reconciliation" : scope.review.blockers.length ? `${scope.review.blockers.length} unresolved decisions` : "Supported details prepared"}</p></div>
            {!scope.retired && inventory.status === "sealed" ? <button type="button" className="button-secondary" disabled={Boolean(busy)} onClick={() => loadUnit(scope.scope_key)}>Review saved text and details</button> : null}</div>
        </li>)}</ul>
        {data.next_cursor ? <button type="button" className="button-secondary" disabled={Boolean(busy)} onClick={() => exclusive("Loading more routes", () => reload(inventory.id, data.next_cursor))}>Next routes</button> : null}
        {inventory.status === "draft" ? <details className="rounded-md border p-3"><summary className="cursor-pointer font-semibold">Complete the provider inventory</summary>
          <p className="my-3 text-sm">Include the common scope and every current provider-published route with exact official index passages and approved source roles. Exclude local campus nomination rules. Add up to 25 scopes per save; historical identities are retained.</p>
          <details className="mb-3 rounded-md border p-3"><summary className="cursor-pointer text-sm font-semibold">Record missing guidance and coverage</summary>
            <p className="my-2 text-sm">Keep unavailable guidance, missing routes and contradictory requirements explicit. Each entry has a unique key, label and source_url (an official HTTPS reference, or null). Saving retains the previous list and your reason in the private history.</p>
            <label className="block text-sm" htmlFor={`gaps-${cohort}`}>Unresolved coverage (JSON)</label><textarea id={`gaps-${cohort}`} className="mt-1 min-h-40 w-full font-mono text-xs" maxLength={128 * 1024} disabled={Boolean(busy)} value={gapEditor} onChange={event => { setGapEditor(event.target.value); setGapsClearedChecked(false); setInventoryChecked(false); }} />
            <label className="mt-2 block text-sm">Reason for this coverage revision<input className="mt-1 w-full" maxLength={2000} value={gapReason} disabled={Boolean(busy)} onChange={event => setGapReason(event.target.value)} /></label>
            {inventory.coverage_gaps.length ? <label className="my-2 flex items-start gap-2 text-sm"><input type="checkbox" checked={gapsClearedChecked} disabled={Boolean(busy)} onChange={event => setGapsClearedChecked(event.target.checked)} />Any gaps I removed are resolved by reviewed official guidance. My reason explains the resolution.</label> : null}
            <button type="button" className="button-secondary mt-2" disabled={Boolean(busy) || gapReason.trim().length < 20} onClick={saveGaps}>Save coverage gaps privately</button>
          </details>
          <details className="mb-3 rounded-md border p-3"><summary className="cursor-pointer text-sm font-semibold">Revise the expected route count</summary>
            <p className="my-2 text-sm">Update this while discovering provider routes. Existing scopes and source work are retained; sealed inventories require a new version.</p>
            <label className="block text-sm">Expected applicant routes<input type="number" min={0} step={1} className="mt-1 w-full sm:max-w-xs" value={expected} onChange={event => setExpected(event.target.value)} /></label>
            <label className="mt-2 block text-sm">Official discovery supporting this change<textarea className="mt-1 w-full" maxLength={2000} value={countReason} onChange={event => setCountReason(event.target.value)} /></label>
            <button type="button" className="button-secondary mt-2" disabled={Boolean(busy) || Number(expected) === inventory.expected_variants || countReason.trim().length < 20} onClick={reviseCount}>Save revised draft count</button>
          </details>
          <label className="block text-sm" htmlFor={`scopes-${cohort}`}>Reviewed source scopes (JSON)</label><textarea id={`scopes-${cohort}`} className="mt-1 min-h-48 w-full font-mono text-xs" maxLength={MAX_EDITOR} value={scopeEditor} disabled={Boolean(busy)} onChange={event => setScopeEditor(event.target.value)} />
          <button type="button" className="button-secondary mt-2" disabled={Boolean(busy)} onClick={appendScopes}>Save provider routes privately</button>
          <label className="my-3 flex gap-2 text-sm"><input type="checkbox" checked={inventoryChecked} disabled={Boolean(busy)} onChange={event => setInventoryChecked(event.target.checked)} />I checked every relevant official index and governing guide. This inventory contains every current provider route and its supporting sources.</label>
          <button type="button" className="button-secondary" disabled={Boolean(busy) || !inventoryChecked || !inventory.draft_hash || Boolean(inventory.coverage_gaps.length)} onClick={sealInventory}>Confirm complete inventory</button>
        </details> : <div className="space-y-3"><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={awardChecked} disabled={Boolean(busy)} onChange={event => setAwardChecked(event.target.checked)} />I reviewed the shared rules and every provider route for this cycle. All current details are supported; contradictions and missing guidance are resolved.</label>
          <button type="button" className="button-primary" disabled={Boolean(busy) || !awardChecked} onClick={approveAward}>Approve this award separately</button></div>}
      </> : null}
      {!inventory || inventory.status === "sealed" ? <details className="rounded-md border p-3"><summary className="cursor-pointer font-semibold">{inventory ? "Prepare a new inventory version" : "Prepare the provider inventory"}</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-sm font-semibold">Official cycle<input className="mt-1 w-full" maxLength={120} value={cycle} onChange={event => setCycle(event.target.value)} /></label>
          <label className="text-sm font-semibold">Distinct applicant routes (0 when shared rules cover all applicants)<input className="mt-1 w-full" type="number" min={0} step={1} value={expected} onChange={event => setExpected(event.target.value)} /></label></div>
        <button type="button" className="button-secondary mt-3" disabled={Boolean(busy) || !cycle.trim()} onClick={createInventory}>Create private inventory</button>
      </details> : null}
      {evidence ? <section className="space-y-3 rounded-md border p-4" aria-label={`${evidence.scope.label} official text`}><h4 className="font-bold">{evidence.scope.label}: retained official text</h4>
        {evidence.sources.map(source => <details key={source.id} className="rounded-md border p-3"><summary className="cursor-pointer font-semibold">{source.title || source.url}</summary><p className="my-2 break-words text-xs">{source.url}</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">{source.text}</pre>
          <details className="mt-2"><summary className="cursor-pointer text-sm">Supporting block IDs and text offsets</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(source.blocks, null, 2)}</pre></details></details>)}
        <p className="text-sm">Use explicit field replacements or cite why a shared rule applies to this route. An unresolved override never falls back to a shared answer. Saving validates the retained originals and never publishes.</p>
        <label className="block text-sm font-semibold" htmlFor={`unit-${cohort}`}>Private route decisions (JSON)</label><textarea id={`unit-${cohort}`} className="min-h-80 w-full font-mono text-xs" maxLength={MAX_EDITOR} value={unitEditor} disabled={Boolean(busy)} onChange={event => { setUnitEditor(event.target.value); setAwardChecked(false); }} />
        <button type="button" className="button-secondary" disabled={Boolean(busy) || !unitEditor} onClick={saveUnit}>Validate and save private review</button>
      </section> : null}
    </div> : null}
  </section>;
}

export function ProgramVariationReleasePanel() {
  const [batch, setBatch] = useState<ApprovalBatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  async function load() {
    const value = await request(API);
    if (!object(value) || value.schema !== "awardping.program-variation-admin-batch.v1" || !uuid(value.revision) || !Array.isArray(value.awards) || value.awards.length !== 25 ||
        new Set(value.awards.map(award => object(award) ? award.cohort_key : null)).size !== 25 || !object(value.approval_ids)) throw new Error("The complete 25-award approval batch could not be confirmed.");
    setBatch(value as unknown as ApprovalBatch); setChecked(false);
  }
  async function act(publish: boolean) {
    if (inFlight.current || publish && (!checked || !ready || !batch)) return;
    inFlight.current = true; setBusy(true); setNotice("");
    try {
      if (publish && batch) {
        setChecked(false);
        await request(API, { action: "publish", expected_revision: batch.revision, approval_ids: Object.fromEntries(batch.awards.map(award => [award.cohort_key, award.approval_id])) });
        setNotice("The exact approved 25-award release was published atomically.");
      }
      await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Publication was not confirmed."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const ready = Boolean(batch && batch.awards.every(award => uuid(award.approval_id) && award.current && !award.blockers.length) &&
    new Set(batch.awards.map(award => award.approval_id)).size === 25);
  const changed = Boolean(batch && batch.awards.some(award => award.approval_id !== batch.approval_ids[award.cohort_key]));
  return <section className="card space-y-3 p-5 sm:p-6" aria-label="Complete provider coverage release" aria-busy={busy}>
    <h2 className="font-bold">Publish verified details for all 25 awards</h2><p className="text-sm">Every provider route must have current supported details and its own award approval. The public release changes together, with no initial-coverage notifications.</p>
    <button type="button" className="button-secondary" disabled={busy} onClick={() => act(false)}>Check all award approvals</button>
    {batch ? <><p className="text-sm font-semibold">{batch.awards.filter(award => award.approval_id && award.current && !award.blockers.length).length}/25 current complete award approvals · {batch.active ? "An approved variation release is live" : "No variation release published"}</p>
      {batch.awards.some(award => award.blockers.length) ? <details><summary className="cursor-pointer text-sm font-semibold">Remaining approval gaps</summary><ul className="mt-2 space-y-1 text-sm">{batch.awards.filter(award => award.blockers.length).map(award => <li key={award.cohort_key}><a className="underline" href={`#award-fact-${award.cohort_key}`}>{award.cohort_key.replace(/_/g, " ")}</a>: {award.blockers.join(", ")}</li>)}</ul></details> : null}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={busy || !ready || !changed} checked={checked} onChange={event => setChecked(event.target.checked)} />I reviewed the separate award approvals and want to publish this exact 25-award release.</label>
      <button type="button" className="button-primary" disabled={busy || !ready || !changed || !checked} onClick={() => act(true)}>Publish complete approved release</button></> : null}
    <p role="status" aria-live="polite" className="text-sm">{busy ? "Checking current approvals…" : notice}</p>
  </section>;
}
