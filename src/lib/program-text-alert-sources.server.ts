import "server-only";
import type { Stage1PublicationEntry, Stage1PublicationIndex } from "@/lib/stage1-publication";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ProgramTextAlertSourceBinding = { url: string; shared_award_id: string; epoch: string };
export type ProgramTextAlertApproval = { eventId: string; candidateId: string; contentHash: string };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
function officialUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 10_000) return false;
  try { const url = new URL(value); return url.href === value && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.port && !url.hash; }
  catch { return false; }
}

/** Current monitoring-source authority is independent of complete fact inventories.
 * This grants eligibility only to immutable text change events, never public
 * facts, source-card metadata, old visual events or a complete-program badge.
 */
export function applyProgramTextAlertSourceBindings(index: Stage1PublicationIndex, snapshot: unknown, epoch: string): Stage1PublicationIndex {
  if (!index.available || !uuid(epoch) || !exact(snapshot, ["schema", "epoch", "source_count", "bindings"]) ||
      snapshot.schema !== "awardping.program-text-public-alert-sources.v1" || snapshot.epoch !== epoch ||
      !Array.isArray(snapshot.bindings) || !Number.isSafeInteger(snapshot.source_count) || snapshot.source_count !== snapshot.bindings.length ||
      snapshot.bindings.length > 50_000) throw Error("Current text alert source authority is unavailable.");
  const seen = new Set<string>(), byCohort = new Map<string, Array<[string, ProgramTextAlertSourceBinding]>>();
  for (const binding of snapshot.bindings) {
    if (!exact(binding, ["cohort_key", "source_id", "shared_award_id", "url", "epoch"]) ||
        typeof binding.cohort_key !== "string" || !uuid(binding.source_id) || !uuid(binding.shared_award_id) ||
        !officialUrl(binding.url) || binding.epoch !== epoch || seen.has(binding.source_id)) throw Error("Text alert source identity changed.");
    const entry = index.entryByCohortKey.get(binding.cohort_key);
    if (!entry?.effectivelyVerified || !entry.memberAwardIds.includes(binding.shared_award_id)) throw Error("Text alert source has the wrong award owner.");
    seen.add(binding.source_id);
    if (!byCohort.has(binding.cohort_key)) byCohort.set(binding.cohort_key, []);
    byCohort.get(binding.cohort_key)!.push([binding.source_id, { url: binding.url, shared_award_id: binding.shared_award_id, epoch }]);
  }
  const entries = index.entries.map(entry => ({ ...entry, approvedTextAlertSourceBindings: Object.fromEntries(byCohort.get(entry.registry.cohort_key) || []) }));
  return { ...index, entries, verifiedEntries: entries.filter(entry => entry.effectivelyVerified), textAlertSourcesAvailable: true,
    entryByCohortKey: new Map(entries.map(entry => [entry.registry.cohort_key, entry])),
    entryByMemberAwardId: new Map(entries.flatMap(entry => entry.memberAwardIds.map(id => [id, entry] as const))) };
}

/** One service-only bounded SQL snapshot, no per-source HTTP requests or caches. */
export async function loadProgramTextAlertSourceBindings(db: unknown, index: Stage1PublicationIndex, epoch: string): Promise<Stage1PublicationIndex> {
  if (!index.available) return index;
  try {
    const client = db as { rpc(name: string, args: { p_epoch: string }): PromiseLike<{ data: unknown; error: unknown }> };
    const result = await client.rpc("get_program_text_public_alert_source_bindings", { p_epoch: epoch });
    if (result.error) throw Error("Text alert source request failed.");
    return applyProgramTextAlertSourceBindings(index, result.data, epoch);
  } catch {
    // Keep serving the accepted basic details/history while failing closed for
    // additional monitoring sources. Never reuse stale binding permissions.
    const entries = index.entries.map(entry => ({ ...entry, approvedTextAlertSourceBindings: {} }));
    return { ...index, entries, verifiedEntries: entries.filter(entry => entry.effectivelyVerified), textAlertSourcesAvailable: false,
      entryByCohortKey: new Map(entries.map(entry => [entry.registry.cohort_key, entry])),
      entryByMemberAwardId: new Map(entries.flatMap(entry => entry.memberAwardIds.map(id => [id, entry] as const))) };
  }
}

/** Query admission only; final eligibility still verifies the actual text proof. */
export function programTextAlertSourceIds(entry: Stage1PublicationEntry): string[] {
  return Object.keys(entry.approvedTextAlertSourceBindings || {});
}

/** New source permission alone cannot publish a previously automatic alert.
 * The immutable owner decision is loaded separately in bounded event pages.
 */
export async function loadProgramTextAlertApprovals(db: unknown, eventIds: string[]): Promise<Map<string, ProgramTextAlertApproval>> {
  if (!Array.isArray(eventIds) || eventIds.length > 1000 || eventIds.some(id => !uuid(id))) throw Error("Invalid bounded text alert approval scope.");
  const ids = [...new Set(eventIds)], approvals = new Map<string, ProgramTextAlertApproval>();
  for (let start = 0; start < ids.length; start += 100) {
    const selected = ids.slice(start, start + 100);
    const { data, error } = await (db as SupabaseClient).from("program_text_alert_reviews")
      .select("id,event_id,content_hash,status").eq("status", "approved").in("event_id", selected).limit(selected.length);
    if (error || !Array.isArray(data) || data.length > selected.length) throw Error("Owner text alert decisions are unavailable.");
    for (const row of data) {
      if (!object(row) || !uuid(row.id) || !uuid(row.event_id) || !selected.includes(row.event_id) || row.status !== "approved" ||
          typeof row.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(row.content_hash) || approvals.has(row.event_id)) throw Error("Owner text alert decision changed.");
      approvals.set(row.event_id, { eventId: row.event_id, candidateId: row.id, contentHash: row.content_hash });
    }
  }
  return approvals;
}
