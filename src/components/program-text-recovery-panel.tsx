"use client";

import { useRef, useState } from "react";
const API = "/api/admin/program-text-recovery";
const CANDIDATE = "8d40add5-89ea-4f96-9c31-f1f68c1fa472";
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
type Preview = {
  schema: "awardping.program-text-quote-id-recovery-preview.v1"; candidate_id: string; preimage_hash: string; projection_hash: string;
  summary: string; source: { id: string; url: string; title: string; final_url: string };
  changed_text: { previous: string; current: string };
  changes: Array<{ path: string; side: string; old_block_id: string; new_block_id: string; quote: string }>;
  validation: { status: "accepted" }; warning: string; already_applied: false;
};
function officialUrl(value: string) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function preview(value: unknown): value is Preview {
  return object(value) && value.schema === "awardping.program-text-quote-id-recovery-preview.v1" && value.candidate_id === CANDIDATE &&
    value.already_applied === false && hash(value.preimage_hash) && hash(value.projection_hash) && typeof value.summary === "string" &&
    object(value.validation) && value.validation.status === "accepted" && object(value.source) && uuid(value.source.id) &&
    typeof value.source.url === "string" && officialUrl(value.source.url) !== null && typeof value.source.title === "string" &&
    typeof value.source.final_url === "string" && officialUrl(value.source.final_url) !== null && object(value.changed_text) &&
    [value.changed_text.previous, value.changed_text.current].every(text => typeof text === "string" && text.length > 0 && text.length <= 1_000_000) &&
    Array.isArray(value.changes) && value.changes.length === 2 && new Set(value.changes.map(change => object(change) ? change.side : null)).size === 2 &&
    value.changes.every(change => object(change) && ["previous", "current"].includes(String(change.side)) &&
      [change.path, change.old_block_id, change.new_block_id, change.quote].every(part => typeof part === "string" && part.length > 0));
}
async function request(body?: unknown) {
  const response = await fetch(body === undefined ? `${API}?candidate=${CANDIDATE}` : API, body === undefined ? { credentials: "same-origin", cache: "no-store" } : {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(object(result) && typeof result.error === "string" ? result.error : "The saved review operation was not confirmed.");
  return result;
}
export function ProgramTextRecoveryPanel() {
  const [data, setData] = useState<Preview | null>(null);
  const [checked, setChecked] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [applied, setApplied] = useState(false);
  const inFlight = useRef(false);
  async function act(label: string, operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(label); setNotice("");
    try { await operation(); } catch (error) { setNotice(error instanceof Error ? error.message : "The saved review was not confirmed."); }
    finally { inFlight.current = false; setBusy(""); }
  }
  async function load() {
    await act("Checking the original saved comparison", async () => {
      setData(null); setChecked(false);
      const value = await request();
      if (object(value) && value.candidate_id === CANDIDATE && value.already_applied === true && object(value.receipt) && uuid(value.receipt.journal_id)) {
        setApplied(true); setNotice("The recorded correction is historical. Check normal monitoring for its final result."); return;
      }
      if (!preview(value)) throw new Error("The exact original passages and permitted correction could not be confirmed.");
      setData(value); setApplied(false);
    });
  }
  async function approve() {
    if (!data || !checked || reason.trim().length < 20 || applied) return;
    const current = data;
    await act("Recording the reviewed correction", async () => {
      setChecked(false);
      const value = await request({ candidate_id: CANDIDATE, preimage_hash: current.preimage_hash, projection_hash: current.projection_hash, reason: reason.trim() });
      if (!object(value) || value.ok !== true || !object(value.result) || value.result.candidate_id !== CANDIDATE || !uuid(value.result.journal_id) ||
          !["succeeded", "historical_receipt"].includes(String(value.result.status))) throw new Error("The correction receipt is unavailable. Reload its status before another action.");
      setApplied(true); setData(null);
      setNotice(value.result.status === "historical_receipt" ? "The historical correction receipt was confirmed; no review was restarted."
        : "The correction and original failure are recorded. The existing worker may now publish the scoped update after its normal checks. Award facts still need their separate approval.");
    });
  }
  return <details className="card p-5 sm:p-6" aria-busy={Boolean(busy)}><summary className="cursor-pointer font-bold">Review the saved NSF quotation correction</summary>
    <p className="my-3 text-sm">This action can correct only the two quotation references in one saved NSF review. The original failure is retained. Approval resumes normal processing and may publish the scoped application-closure update.</p>
    <button type="button" className="button-secondary" disabled={Boolean(busy)} onClick={load}>Load saved NSF comparison</button>
    {data ? <section className="mt-4 space-y-4" aria-label="Saved NSF review correction">
      <p className="font-semibold">{data.summary}</p><a className="text-sm underline" href={officialUrl(data.source.final_url)!} target="_blank" rel="noreferrer">Open official source</a>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">{(["previous", "current"] as const).map(side => <div key={side} className="min-w-0 rounded-md border p-3"><h3 className="text-sm font-bold">{side === "previous" ? "Previous saved passage" : "Current saved passage"}</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm">{data.changed_text[side]}</p></div>)}</div>
      <details><summary className="cursor-pointer text-sm font-semibold">Exact quotation reference corrections</summary><ul className="mt-2 space-y-2 text-sm">{data.changes.map(change => <li key={change.path}><span className="font-semibold">{change.side}: </span><code>{change.old_block_id}</code> → <code>{change.new_block_id}</code><p className="mt-1 whitespace-pre-wrap break-words">{change.quote}</p></li>)}</ul></details>
      <p className="text-sm font-semibold">Approving resumes the existing worker. It may publish this scoped update after unchanged normal checks. This does not approve current award facts.</p>
      <label className="block text-sm font-semibold">Review explanation<textarea className="mt-1 min-h-24 w-full" value={reason} maxLength={2000} disabled={Boolean(busy)} onChange={event => setReason(event.target.value)} /></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={checked} disabled={Boolean(busy) || applied} onChange={event => setChecked(event.target.checked)} />I checked both saved passages, the scoped summary and the exact reference-only corrections, and want normal review to resume.</label>
      <button type="button" className="button-primary" disabled={Boolean(busy) || applied || !checked || reason.trim().length < 20} onClick={approve}>Approve correction and resume review</button>
    </section> : null}
    <p role="status" aria-live="polite" className="mt-3 text-sm">{busy || notice}</p>
  </details>;
}
