"use client";

import { useRef, useState } from "react";
const API = "/api/admin/program-text-sources";
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
type Pending = { id: string; content_hash: string; source: { id: string; url: string; title: string }; proof: unknown;
  proposal: unknown; provider_link: unknown; target_text: string | null; url_alias_boundary?: unknown; approved?: boolean; current?: boolean };
async function request(url: string, body?: unknown) {
  const response = await fetch(url, body === undefined ? { cache: "no-store", credentials: "same-origin" } : {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(object(value) && typeof value.error === "string" ? value.error : "The source operation was not confirmed.");
  return value;
}

export function ProgramTextSourceReviewPanel() {
  const [editor, setEditor] = useState("{}");
  const [pendingId, setPendingId] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  async function act(label: string, action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(label); setNotice("");
    try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : "The source operation was not confirmed."); }
    finally { inFlight.current = false; setBusy(""); }
  }
  async function load() {
    if (!uuid(pendingId)) return;
    const id = pendingId;
    await act("Loading pending source proof", async () => {
      const value = await request(`${API}?id=${encodeURIComponent(id)}`);
      if (!object(value) || value.id !== id || typeof value.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.content_hash) ||
          !object(value.source) || !uuid(value.source.id) || typeof value.source.url !== "string" ||
          value.target_text !== null && typeof value.target_text !== "string") throw new Error("The exact pending source identity could not be confirmed.");
      setPending(value as unknown as Pending); setChecked(false);
    });
  }
  async function prepare() {
    if (editor.length > 256 * 1024) return;
    await act("Preparing one private source", async () => {
      const proposal: unknown = JSON.parse(editor);
      if (!object(proposal)) throw new Error("Enter one reviewed source proposal.");
      const value = await request(API, { action: "prepare", proposal });
      if (!object(value) || !value.ok || !object(value.result) || !uuid(value.result.id)) throw new Error("The pending source was not confirmed. Check its status before trying again.");
      setPendingId(value.result.id); setPending(null); setChecked(false);
      setNotice("The pending source is saved privately. Its guarded PC capture must finish before text-only approval.");
    });
  }
  async function approve() {
    if (!pending || pending.approved || !checked || !pending.proof || !pending.target_text || pending.id !== pendingId) return;
    const current = pending;
    await act("Verifying retained source proof", async () => {
      setChecked(false);
      const result = await request(API, { action: "approve", id: current.id, expected_hash: current.content_hash });
      if (!object(result) || result.ok !== true || !object(result.result) || result.result.approved !== true || typeof result.result.current !== "boolean") throw new Error("The source result was not confirmed. Reload its stored status before trying another operation.");
      setPending({ ...current, approved: true, current: result.result.current });
      setNotice(result.result.current ? "Source approval is current. Collection and repeat readiness are checked separately. No award facts were approved."
        : "The historical approval is recorded, but its collection authority is not current. No source was reactivated.");
    });
  }
  return <details className="card p-5 sm:p-6" aria-busy={Boolean(busy)}><summary className="cursor-pointer font-bold">Review missing official sources</summary>
    <p className="my-3 text-sm text-[var(--muted)]">Approve collection only after checking the official provider link and complete retained target text. Source history and legacy approvals stay separate; this does not publish program details.</p>
    <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-semibold">Prepare a reviewed source proposal</summary>
      <label className="mt-3 block text-sm font-semibold" htmlFor="program-text-source-proposal">Source identity, provider-link proof and exact roster version</label>
      <textarea id="program-text-source-proposal" className="mt-1 min-h-48 w-full font-mono text-xs" maxLength={256 * 1024} value={editor} disabled={Boolean(busy)} onChange={event => setEditor(event.target.value)} />
      <button type="button" className="button-secondary mt-3" disabled={Boolean(busy)} onClick={prepare}>Prepare pending text source</button>
    </details>
    <div className="mt-4 flex flex-wrap items-end gap-3"><label className="min-w-0 flex-1 text-sm font-semibold">Pending source ID<input className="mt-1 w-full" value={pendingId} maxLength={36} disabled={Boolean(busy)} onChange={event => { setPendingId(event.target.value); setPending(null); setChecked(false); }} /></label>
      <button type="button" className="button-secondary" disabled={Boolean(busy) || !uuid(pendingId)} onClick={load}>Load retained source proof</button></div>
    {pending ? <section className="mt-4 space-y-3 rounded-md border p-4" aria-label="Pending source evidence">
      <h3 className="font-bold">{pending.source.title || pending.source.url}</h3><p className="break-words text-sm">{pending.source.url}</p>
      {pending.approved ? <p className="text-sm font-semibold">{pending.current ? "Recorded approval · current collection authority" : "Historical approval · collection authority needs review"}</p> : null}
      <details><summary className="cursor-pointer text-sm font-semibold">Official provider link and proposed collection roles</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ provider_link: pending.provider_link, proposal: pending.proposal, retained_related_records: pending.url_alias_boundary ?? [] }, null, 2)}</pre></details>
      {Array.isArray(pending.url_alias_boundary) && pending.url_alias_boundary.length ? <p className="text-sm">{pending.url_alias_boundary.length} related records keep their separate histories. This approval applies only to the selected source.</p> : null}
      {pending.target_text ? <details><summary className="cursor-pointer text-sm font-semibold">Complete saved target text</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">{pending.target_text}</pre></details> : <p className="text-sm font-semibold">The private guarded capture has not finished. Approval remains unavailable.</p>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={checked} disabled={Boolean(busy) || pending.approved || !pending.proof || !pending.target_text} onChange={event => setChecked(event.target.checked)} />I reviewed the provider link, exact source identity and complete target text. This source belongs to the award and covers the proposed collection role.</label>
      <button type="button" className="button-primary" disabled={Boolean(busy) || pending.approved || !checked || !pending.proof || !pending.target_text} onClick={approve}>Approve text collection only</button>
    </section> : null}
    <p role="status" aria-live="polite" className="mt-3 text-sm">{busy || notice}</p>
  </details>;
}
