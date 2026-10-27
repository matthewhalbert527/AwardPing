"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import type { PublishedVariationContext } from "@/lib/program-variation-review-types";
import { publicAwardVariantId, type PublicAwardContext } from "@/lib/public-award-links";
import { variationCursor, variationHref, variationOptionLabel, variationRequestUrl, type VariationFilters } from "@/lib/program-variation-navigation";

type Props = { cohort: string; path: string; initial: PublishedVariationContext; navigation?: PublicAwardContext };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function validPage(value: unknown, initial: PublishedVariationContext): value is PublishedVariationContext {
  if (!object(value) || value.inventory_id !== initial.inventory_id || value.revision !== initial.revision ||
      !Number.isSafeInteger(value.total) || (value.total as number) < 0 || !Array.isArray(value.options) || value.options.length > 100 ||
      value.next_cursor !== null && !variationCursor(value.next_cursor)) return false;
  const seen = new Set<string>();
  return value.options.every(option => {
    if (!object(option) || !publicAwardVariantId(option.scope_key) || typeof option.label !== "string" || !option.label.trim() || option.label.length > 240 ||
        !object(option.attributes) || seen.has(option.scope_key as string)) return false;
    seen.add(option.scope_key as string);
    return ["country", "course", "track", "applicant_group"].every(key => option.attributes &&
      ((option.attributes as Record<string, unknown>)[key] === null || typeof (option.attributes as Record<string, unknown>)[key] === "string"));
  });
}

export function PublicAwardVariationPicker({ cohort, path, initial, navigation = {} }: Props) {
  const [page, setPage] = useState(initial);
  const [filters, setFilters] = useState<VariationFilters>({});
  const [applied, setApplied] = useState<VariationFilters>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const selected = initial.selected_option;
  const showFilters = initial.total > 10 || Boolean(initial.next_cursor);

  async function load(nextFilters: VariationFilters, cursor?: string | null) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setNotice("");
    try {
      const response = await fetch(variationRequestUrl(cohort, nextFilters, cursor), { cache: "no-store", credentials: "same-origin" });
      const value: unknown = await response.json();
      if (!response.ok || !validPage(value, initial)) throw new Error("The available routes changed or could not be confirmed. Reload this award page.");
      setPage(value); setApplied(nextFilters);
    } catch (error) { setNotice(error instanceof Error ? error.message : "These routes could not be loaded."); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <section className="card mb-5 space-y-3 p-4 sm:p-5" aria-label="Application routes" aria-busy={busy}>
    <div><h2 className="font-bold">Your application route</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">{initial.selected_scope_key === "common" ? "Showing shared program details. Choose your route for its specific rules and deadlines." : `Showing ${variationOptionLabel(selected)}.`}</p>
    </div>
    {showFilters ? <form className="grid gap-3 sm:grid-cols-4" onSubmit={event => { event.preventDefault(); void load({ ...filters }); }}>
      {(["country", "course", "track"] as const).map(field => <label key={field} className="block text-sm font-semibold">
        {field === "country" ? "Country" : field === "course" ? "Course" : "Applicant track"}
        <input type="search" className="mt-1 w-full" maxLength={200} value={filters[field] || ""} placeholder="Any"
          onChange={event => setFilters(previous => ({ ...previous, [field]: event.target.value }))} />
      </label>)}
      <button className="button-secondary self-end" type="submit" disabled={busy}>Find routes</button>
    </form> : null}
    <ul className="flex flex-wrap gap-2" aria-label="Approved application routes">
      <li><Link className="button-secondary text-sm" href={variationHref(path, "common", navigation)!} prefetch={false}
        aria-current={initial.selected_scope_key === "common" ? "page" : undefined}>Shared details</Link></li>
      {page.options.filter(option => option.scope_key !== "common").map(option => <li key={option.scope_key}>
        <Link className="button-secondary text-sm" href={variationHref(path, option.scope_key, navigation)!} prefetch={false}
          aria-current={initial.selected_scope_key === option.scope_key ? "page" : undefined}>{variationOptionLabel(option)}</Link>
      </li>)}
    </ul>
    {page.options.filter(option => option.scope_key !== "common").length === 0 ? <p className="text-sm">No application routes match these filters.</p> : null}
    {page.next_cursor ? <button type="button" className="button-secondary text-sm" disabled={busy} onClick={() => void load(applied, page.next_cursor)}>More routes</button> : null}
    {Object.keys(applied).length ? <button type="button" className="ml-2 text-sm underline" disabled={busy} onClick={() => { setFilters({}); void load({}); }}>Clear filters</button> : null}
    <p role="status" aria-live="polite" className="text-sm">{busy ? "Loading routes…" : notice}</p>
  </section>;
}
