import "server-only";
import { parseProgramTextChangeDetails } from "../../scripts/lib/program-change-contract.mjs";
import { loadEligiblePublicChangeEvents, comparePublicChangeEventsNewestFirst, type EligiblePublicChangeEvent } from "@/lib/public-change-events";
import type { Stage1PublicationIndex } from "@/lib/stage1-publication";
import type { PublicAlertGroup, PublicAlertGroupMember } from "@/lib/public-alert-groups";

type GroupReference = {
  group_id: string; revision_id: string; content_hash: string; shared_award_id: string; event_ids: string[];
  member_refs: Array<{ id: string; content_hash: string }>;
  event_refs: Array<{ review_id: string; event_id: string; content_hash: string }>;
  created_at: string;
};
type Client = Parameters<typeof loadEligiblePublicChangeEvents>[0]["admin"];
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const check = (ok: unknown): void => { if (!ok) throw Error("Related award updates could not be verified."); };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

function groupReference(value: unknown, requested: string[]): GroupReference {
  check(exact(value, ["group_id", "revision_id", "content_hash", "shared_award_id", "event_ids", "member_refs", "event_refs", "created_at"]));
  const row = value as GroupReference;
  check(uuid(row.group_id) && uuid(row.revision_id) && hash(row.content_hash) && uuid(row.shared_award_id) &&
    Array.isArray(row.event_ids) && row.event_ids.length >= 2 && row.event_ids.length <= 8 && row.event_ids.every(uuid) &&
    new Set(row.event_ids).size === row.event_ids.length && row.event_ids.some(id => requested.includes(id)) &&
    Array.isArray(row.member_refs) && row.member_refs.length === row.event_ids.length &&
    Array.isArray(row.event_refs) && row.event_refs.length === row.event_ids.length &&
    typeof row.created_at === "string" && Number.isFinite(Date.parse(row.created_at)));
  check(row.member_refs.every(ref => exact(ref, ["id", "content_hash"]) && uuid(ref.id) && hash(ref.content_hash)) &&
    new Set(row.member_refs.map(ref => ref.id)).size === row.member_refs.length &&
    row.event_refs.every(ref => exact(ref, ["review_id", "event_id", "content_hash"]) && uuid(ref.review_id) && uuid(ref.event_id) &&
      row.event_ids.includes(ref.event_id) && row.member_refs.some(member => member.id === ref.review_id && member.content_hash === ref.content_hash)) &&
    new Set(row.event_refs.map(ref => ref.event_id)).size === row.event_ids.length &&
    new Set(row.event_refs.map(ref => ref.review_id)).size === row.event_ids.length);
  return row;
}

/** Service-only grouping is not publication authority. Hydrate missing members
 * through the unchanged raw eligibility loader, then require every member. */
export async function loadPublicAlertGroups({ admin, publicationIndex, events }: {
  admin: Client; publicationIndex: Stage1PublicationIndex; events: EligiblePublicChangeEvent[];
}): Promise<{ events: EligiblePublicChangeEvent[]; groups: GroupReference[] }> {
  if (!events.length) return { events, groups: [] };
  const ids = [...new Set(events.map(row => row.event.id))];
  check(ids.length <= 50_000 && ids.every(uuid));
  const groups = new Map<string, GroupReference>();
  const client = admin as unknown as { rpc(name: string, args: { p_event_ids: string[] }): PromiseLike<{ data: unknown; error: unknown }> };
  for (let start = 0; start < ids.length; start += 1000) {
    const requested = ids.slice(start, start + 1000);
    const result = await client.rpc("get_program_text_published_alert_groups", { p_event_ids: requested });
    check(!result.error && Array.isArray(result.data) && result.data.length <= requested.length);
    for (const value of result.data as unknown[]) {
      const group = groupReference(value, requested), prior = groups.get(group.group_id);
      check(!prior || JSON.stringify(canonical(prior)) === JSON.stringify(canonical(group)));
      groups.set(group.group_id, group);
    }
  }
  const eventGroups = new Map<string, string>();
  for (const group of groups.values()) for (const id of group.event_ids) {
    check(!eventGroups.has(id) || eventGroups.get(id) === group.group_id);
    eventGroups.set(id, group.group_id);
  }
  const byId = new Map(events.map(row => [row.event.id, row]));
  const missing = [...eventGroups.keys()].filter(id => !byId.has(id));
  check(ids.length + missing.length <= 50_000);
  for (let start = 0; start < missing.length; start += 100) {
    const selected = missing.slice(start, start + 100);
    const found = await loadEligiblePublicChangeEvents({ admin, publicationIndex, eventIds: selected, preserveDistinctEventIds: true, limit: null, pageSize: 100 });
    for (const row of found) { check(selected.includes(row.event.id) && !byId.has(row.event.id)); byId.set(row.event.id, row); }
  }
  const complete = [...groups.values()].filter(group => group.event_refs.every(ref => {
    const row = byId.get(ref.event_id);
    return row?.publication.canonicalAwardId === group.shared_award_id &&
      row.event.visual_review_candidate_id === ref.review_id && Boolean(parseProgramTextChangeDetails(row.event.change_details));
  }));
  const retained = new Set([...ids, ...complete.flatMap(group => group.event_ids)]);
  return { events: [...byId.values()].filter(row => retained.has(row.event.id)).sort((a, b) => comparePublicChangeEventsNewestFirst(a.event, b.event)), groups: complete };
}

export function attachPublicAlertGroups<T extends PublicAlertGroupMember>(rows: T[], groups: GroupReference[]): Array<T & { group?: PublicAlertGroup }> {
  const byId = new Map(rows.map(row => [row.id, row]));
  const groupByEvent = new Map<string, PublicAlertGroup>();
  for (const reference of groups) {
    check(reference.event_ids.every(id => byId.has(id)));
    const group: PublicAlertGroup = { id: reference.group_id, revisionHash: reference.content_hash,
      memberEventIds: [...reference.event_ids], members: reference.event_ids.map(id => {
        const member = byId.get(id)!;
        return { id: member.id, sourceId: member.sourceId, sourceTitle: member.sourceTitle, sourceUrl: member.sourceUrl,
          sourcePageType: member.sourcePageType, summary: member.summary, changeDetails: member.changeDetails, detectedAt: member.detectedAt };
      }) };
    reference.event_ids.forEach(id => groupByEvent.set(id, group));
  }
  return rows.map(row => groupByEvent.has(row.id) ? { ...row, group: groupByEvent.get(row.id)! } : row);
}
