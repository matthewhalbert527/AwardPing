import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadAlertReviews, loadAlertReviewMembers, verifyPendingAlertReview, verifyApprovedAlertReview } from "@/lib/alert-review.server";
import type { AlertReview, AlertReviewLeaf, AlertMemberRef, MergeOption, MergePreview, AlertReviewStatus } from "@/lib/alert-group-review";
import { buildProgramTextComparison, buildProgramTextReviewPackets } from "../../scripts/lib/program-text-review.mjs";
import { programTextReference } from "../../scripts/lib/program-text-storage.mjs";
import { programTextEqual } from "../../scripts/lib/program-text-repository.mjs";
import { loadProgramTextCapture } from "../../scripts/lib/program-text-artifacts.mjs";

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const DAYS = 30 * 86400000;
type Revision = { id: string; revision: number; operation: string; content_hash: string; member_refs: AlertMemberRef[]; event_refs: unknown[] | null; created_at: string };
type Group = { id: string; shared_award_id: string; head: Revision; published: Revision | null; retired: boolean };
type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
async function rpc(db: SupabaseClient, name: string, args: Record<string, unknown>) {
  const result = await (db as unknown as RpcClient).rpc(name, args);
  if (result.error) throw Error("The combined update could not be confirmed. Refresh before trying again.");
  return result.data;
}
function refs(v: unknown): AlertMemberRef[] {
  if (!Array.isArray(v) || v.length < 2 || v.length > 8 || !v.every(x => object(x) && Object.keys(x).length === 2 && uuid(x.id) && hash(x.content_hash)) || new Set(v.map(x => x.id)).size !== v.length) throw Error("Invalid combined update members.");
  return v as AlertMemberRef[];
}
function revision(v: unknown): Revision {
  if (!object(v) || !uuid(v.id) || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1 || !["draft", "approved", "undo"].includes(v.operation as string) || !hash(v.content_hash) || (v.operation === "approved" ? !Array.isArray(v.event_refs) || v.event_refs.length > 8 : v.event_refs !== null) || typeof v.created_at !== "string" || !Number.isFinite(Date.parse(v.created_at))) throw Error("Invalid combined update revision.");
  return { id: v.id, revision: Number(v.revision), operation: v.operation as string, content_hash: v.content_hash, member_refs: refs(v.member_refs), event_refs: v.event_refs as unknown[] | null, created_at: v.created_at };
}
async function groupsFor(db: SupabaseClient, ids: string[]): Promise<Group[]> {
  if (ids.length > 100 || ids.some(id => !uuid(id))) throw Error("Choose a bounded alert list.");
  const data = await rpc(db, "get_program_text_alert_groups", { p_review_ids: [...new Set(ids)] });
  if (!Array.isArray(data) || data.length > 100) throw Error("Invalid combined update list.");
  const groups = data.map(v => {
    if (!object(v) || !uuid(v.id) || !uuid(v.shared_award_id) || typeof v.retired !== "boolean") throw Error("Invalid combined update identity.");
    return { id: v.id, shared_award_id: v.shared_award_id, retired: v.retired, head: revision(v.head), published: v.published === null ? null : revision(v.published) };
  });
  if (new Set(groups.map(g => g.id)).size !== groups.length) throw Error("Duplicate combined update.");
  return groups.filter(g => !g.retired);
}
async function membersFor(groups: Group[], leaves: AlertReview[]): Promise<Map<string, AlertReviewLeaf>> {
  const byId = new Map<string, AlertReviewLeaf>(leaves.map(leaf => [leaf.id, leaf]));
  const missing = [...new Set(groups.flatMap(g => [...g.head.member_refs, ...(g.published?.member_refs || [])].map(m => m.id)))].filter(id => !byId.has(id));
  if (missing.length > 800) throw Error("Combined update list is too large.");
  for (let i = 0; i < missing.length; i += 100) {
    for (const leaf of await loadAlertReviewMembers(missing.slice(i, i + 100))) byId.set(leaf.id, leaf);
  }
  return byId;
}
function checkedMembers(group: Group, rev: Revision, byId: Map<string, AlertReviewLeaf>): AlertReviewLeaf[] {
  return rev.member_refs.map(ref => {
    const leaf = byId.get(ref.id);
    if (!leaf || leaf.contentHash !== ref.content_hash || leaf.awardId !== group.shared_award_id || !["pending", "approved"].includes(leaf.status)) throw Error("The combined update or an original alert changed.");
    if (rev.operation === "approved" && leaf.status !== "approved") throw Error("An approved combined update has an unapproved member.");
    return leaf;
  }).sort((a, b) => Date.parse(a.detectedAt) - Date.parse(b.detectedAt) || a.id.localeCompare(b.id));
}
function mergedSummary(members: AlertReviewLeaf[]) {
  const summary = [...new Set(members.map(m => m.summary))].join(" ");
  return summary.length <= 8000 ? summary : `${members.length} related changes. Review each original change below for its application cycle, track and source.`;
}
function groupCard(group: Group, rev: Revision, byId: Map<string, AlertReviewLeaf>, status: AlertReviewStatus): AlertReview {
  const members = checkedMembers(group, rev, byId);
  const publishedMemberIds = group.published?.member_refs.map(m => m.id) || members.filter(m => m.status === "approved").map(m => m.id);
  const latest = members.at(-1)!;
  return { ...latest, id: group.id, contentHash: rev.content_hash, status, summary: mergedSummary(members),
    context: "These changes are grouped for review; each retains its original source and supporting details.", details: [],
    group: { id: group.id, revisionHash: rev.content_hash, members, publishedMemberIds, ...(status === "approved" && group.head.operation === "draft" ? { hasPendingDraft: true } : {}) } };
}
function topic(leaf: AlertReviewLeaf) {
  const categories = leaf.details.map(d => d.category.toLowerCase());
  return categories.some(c => ["eligibility", "citizenship", "academic level", "discipline"].includes(c)) ? "eligibility" : categories.join("|");
}
function recent(leaf: AlertReviewLeaf, now: number) { return leaf.status === "pending" || Date.parse(leaf.detectedAt) >= now - DAYS; }
function option(leaf: AlertReview, others: AlertReview[]): MergeOption {
  const relatedToIds = others.filter(other => other.id !== leaf.id && other.awardId === leaf.awardId && Math.abs(Date.parse(other.detectedAt) - Date.parse(leaf.detectedAt)) <= 7 * 86400000 && (other.sourceUrl === leaf.sourceUrl || topic(other) !== "" && topic(other) === topic(leaf))).map(other => other.id);
  return { id: leaf.id, contentHash: leaf.contentHash, awardId: leaf.awardId!, awardName: leaf.awardName, summary: leaf.summary,
    detectedAt: leaf.detectedAt, status: leaf.status as "pending" | "approved", ...(leaf.group ? { groupId: leaf.group.id, members: leaf.group.members.map(m => ({ id: m.id, content_hash: m.contentHash })) } : {}),
    ...(relatedToIds.length ? { relatedToIds, relatedReason: "Possibly related: same award, nearby dates and overlapping source or topic. Check the preview." } : {}) };
}

/** Admin-only board: original proofs stay separate; no grouping is an approval. */
export async function loadAlertReviewBoard(status: AlertReviewStatus = "pending") {
  if (status === "dismissed") return { alerts: await loadAlertReviews(status), mergeOptions: [] as MergeOption[] };
  const [pending, approved] = await Promise.all([loadAlertReviews("pending"), loadAlertReviews("approved")]);
  const now = Date.now();
  const seeds = [...pending, ...approved.filter(x => recent(x, now))].slice(0, 100);
  const db = createSupabaseAdminClient() as SupabaseClient;
  const groups = await groupsFor(db, seeds.map(x => x.id));
  const byId = await membersFor(groups, [...pending, ...approved]);
  const covered = new Set(groups.flatMap(g => (status === "approved" ? g.published?.member_refs || [] : g.head.member_refs).map(m => m.id)));
  const alerts: AlertReview[] = (status === "approved" ? approved : pending).filter(x => !covered.has(x.id));
  for (const group of groups) {
    const rev = status === "approved" ? group.published : group.head.operation === "draft" ? group.head : null;
    if (rev) alerts.push(groupCard(group, rev, byId, status));
  }
  alerts.sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt) || a.id.localeCompare(b.id));
  const groupedIds = new Set(groups.flatMap(g => g.head.member_refs.map(m => m.id)));
  const choices = [...seeds.filter(x => !groupedIds.has(x.id)), ...groups.map(g => groupCard(g, g.head, byId, g.head.operation === "draft" ? "pending" : "approved"))];
  return { alerts: alerts.slice(0, 100), mergeOptions: choices.filter(x => x.awardId && recent(x, now)).map(x => option(x, choices)).slice(0, 200) };
}

export async function previewAlertGroup(sourceId: string, targetId: string): Promise<MergePreview> {
  if (!uuid(sourceId) || !uuid(targetId) || sourceId === targetId) throw Error("Choose two different updates.");
  const db = createSupabaseAdminClient() as SupabaseClient;
  const groups = await groupsFor(db, [sourceId, targetId]);
  // Group IDs are not original review IDs; the getter explicitly accepts either.
  const selectedGroups = groups.filter(g => g.id === sourceId || g.id === targetId);
  if (selectedGroups.length > 1) throw Error("Add an individual update to one combined draft at a time.");
  const group = selectedGroups[0] || null;
  const groupIds = new Set(selectedGroups.map(g => g.id));
  const originalIds = [sourceId, targetId].filter(id => !groupIds.has(id));
  const originals = await loadAlertReviewMembers(originalIds);
  const byId = await membersFor(selectedGroups, originals);
  const baseMembers = group ? checkedMembers(group, group.head, byId) : [];
  const members = [...new Map([...baseMembers, ...originals].map(m => [m.id, m])).values()].sort((a, b) => Date.parse(a.detectedAt) - Date.parse(b.detectedAt) || a.id.localeCompare(b.id));
  if (members.length < 2 || members.length > 8 || members.some(m => m.status === "dismissed" || !m.awardId || m.awardId !== members[0].awardId) || Date.parse(members.at(-1)!.detectedAt) - Date.parse(members[0].detectedAt) > DAYS) throw Error("Choose up to eight recent updates for the same award.");
  // A hidden membership must not be silently stolen from another group.
  if (groups.some(g => g.id !== group?.id && g.head.member_refs.some(r => members.some(m => m.id === r.id)))) throw Error("An update already belongs to another combined update.");
  return { groupId: group?.id || null, expectedHash: group?.head.content_hash || null, members,
    memberRefs: members.map(m => ({ id: m.id, content_hash: m.contentHash })), awardName: members[0].awardName,
    summary: mergedSummary(members), context: "Related changes are presented together. Their original evidence remains separate; this does not establish a common cause.",
    publishedMemberIds: group?.published?.member_refs.map(m => m.id) || members.filter(m => m.status === "approved").map(m => m.id),
    message: members.some(m => m.status === "approved") ? "The approved update stays live until you approve this combined draft. Already prepared or sent emails keep their original wording; only newly approved, undelivered changes enter future alerts." : "Save a combined draft, then review and approve it once. Saving does not publish or notify subscribers." };
}

export async function saveAlertGroup(input: { group_id: string | null; expected_hash: string | null; members: AlertMemberRef[] }, actor: string) {
  if (!uuid(actor) || (input.group_id === null ? input.expected_hash !== null : !uuid(input.group_id) || !hash(input.expected_hash))) throw Error("Invalid combined update version.");
  const memberRefs = refs(input.members);
  const leaves = await loadAlertReviewMembers(memberRefs.map(m => m.id));
  if (leaves.some(m => m.contentHash !== memberRefs.find(ref => ref.id === m.id)?.content_hash || !["pending", "approved"].includes(m.status))) throw Error("An alert changed after preview.");
  const db = createSupabaseAdminClient() as SupabaseClient;
  const result = await rpc(db, "save_program_text_alert_group", { p_group_id: input.group_id, p_expected_hash: input.expected_hash, p_members: memberRefs, p_actor: actor });
  if (!object(result) || result.ok !== true) throw Error("Combined draft was not confirmed.");
  return { ok: true } as const;
}

export async function decideAlertGroup(input: { id: string; expected_hash: string; action: "approve" | "undo" }, actor: string) {
  if (!uuid(input.id) || !hash(input.expected_hash) || !uuid(actor) || !["approve", "undo"].includes(input.action)) throw Error("Invalid combined update decision.");
  const db = createSupabaseAdminClient() as SupabaseClient;
  const group = (await groupsFor(db, [input.id])).find(g => g.id === input.id);
  if (!group || group.head.content_hash !== input.expected_hash || group.head.operation !== "draft") throw Error("Combined draft changed. Refresh before deciding.");
  if (input.action === "approve") {
    const byId = await membersFor([group], []);
    for (const member of checkedMembers(group, group.head, byId)) {
      if (member.status === "pending") await verifyPendingAlertReview(member.id, member.contentHash, db);
      else await verifyApprovedAlertReview(member.id, member.contentHash, db);
    }
  }
  const result = await rpc(db, "decide_program_text_alert_group", { p_id: input.id, p_expected_hash: input.expected_hash, p_action: input.action, p_actor: actor });
  if (!object(result) || result.ok !== true) throw Error("Combined decision was not confirmed.");
  return { ok: true } as const;
}

/** Cold-check a historical member without pretending its old pair is today's baseline. */
export async function verifyApprovedGroupEvidence(candidate: Record<string, unknown>, details: unknown, eventId: string, db: SupabaseClient,
  loadCapture: (ref: Parameters<typeof loadProgramTextCapture>[0]) => ReturnType<typeof loadProgramTextCapture>, localization?: unknown) {
  if (candidate.candidate_scope !== "program_text_change" || ["previous_image_hash", "new_image_hash", "previous_file_hash", "new_file_hash"].some(key => candidate[key] != null) || !object(candidate.worker_metadata) || !object(candidate.prompt_payload) || !object(candidate.ai_result) || candidate.worker_metadata.change_event_id !== eventId || candidate.worker_metadata.evidence_signature !== candidate.candidate_signature || candidate.worker_metadata.monitoring_contract !== "program-text-v1") throw Error("Invalid approved source evidence.");
  const [event, evidence] = await Promise.all([
    db.from("shared_award_change_events").select("id,shared_award_id,shared_award_source_id,source_url,visual_review_candidate_id,change_details").eq("id", eventId).single(),
    db.from("shared_award_change_event_visual_evidence").select("change_event_id,visual_review_candidate_id,candidate_signature,bucket,evidence_status,evidence_schema_version,previous_capture,current_capture,localization").eq("change_event_id", eventId).single(),
  ]);
  const e = event.data, proof = evidence.data;
  if (event.error || evidence.error || !object(e) || !object(proof) || e.id !== eventId || e.visual_review_candidate_id !== candidate.id || e.shared_award_id !== candidate.shared_award_id || e.shared_award_source_id !== candidate.shared_award_source_id || e.source_url !== candidate.source_url || !programTextEqual(e.change_details, details) || !object(localization) || !programTextEqual(proof.localization, localization) || proof.change_event_id !== eventId || proof.visual_review_candidate_id !== candidate.id || proof.candidate_signature !== candidate.candidate_signature || proof.bucket !== candidate.worker_metadata.bucket || proof.evidence_status !== "verified_text" || proof.evidence_schema_version !== "program-text-event-evidence-v1" || !programTextEqual(proof.previous_capture, candidate.previous_snapshot_ref) || !programTextEqual(proof.current_capture, candidate.new_snapshot_ref)) throw Error("The approved event does not match its retained evidence.");
  const payload = candidate.prompt_payload;
  if (!object(payload.comparison) || !object(payload.comparison.context) || !object(payload.packet_plan) || !object(payload.packet_plan.limits)) throw Error("Invalid approved comparison.");
  const [previous, current] = await Promise.all([loadCapture(candidate.previous_snapshot_ref as Parameters<typeof loadProgramTextCapture>[0]), loadCapture(candidate.new_snapshot_ref as Parameters<typeof loadProgramTextCapture>[0])]);
  const comparison = buildProgramTextComparison(previous, current, { epoch: candidate.worker_metadata.epoch, cycle_id: payload.comparison.context.cycle_id });
  if (!programTextEqual(comparison, payload.comparison) || comparison.comparison_id !== candidate.candidate_signature || !programTextEqual(programTextReference(previous), candidate.previous_snapshot_ref) || !programTextEqual(programTextReference(current), candidate.new_snapshot_ref) || !programTextEqual(buildProgramTextReviewPackets(comparison, payload.packet_plan.limits), payload.packet_plan)) throw Error("Approved originals no longer match the saved comparison.");
}
