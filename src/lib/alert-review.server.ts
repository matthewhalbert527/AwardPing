import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AlertReview, AlertReviewStatus } from "../components/admin-alert-review-board";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { parseProgramTextChangeDetails } from "../../scripts/lib/program-change-contract.mjs";
import { programChangePresentation } from "@/lib/program-change-presentation";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const statuses: AlertReviewStatus[] = ["pending", "approved", "dismissed"];
const labels: Record<string, string> = {
  opening_date: "Application opening", deadline: "Deadline", cycle_status: "Application cycle", important_dates: "Important dates",
  eligibility: "Eligibility", citizenship: "Citizenship", academic_levels: "Academic level", disciplines: "Discipline",
  award_amounts: "Award funding", stipend: "Stipend", tuition: "Tuition", travel_research_allowance: "Travel and research funding",
  tenure: "Award duration", requirements: "Requirements", application_materials: "Application materials", how_to_apply: "How to apply",
  documents: "Program documents", selection: "Selection", application_url: "Application link", contacts: "Program contacts",
};
function sourceUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw Error("Invalid official source.");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw Error("Invalid official source.");
  return url.href;
}
function rows(value: unknown, max = 100): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length > max || !value.every(object)) throw Error("Alert list unavailable.");
  return value;
}
function uniqueMap(values: Array<Record<string, unknown>>) {
  const result = new Map<string, Record<string, unknown>>();
  for (const row of values) {
    if (!uuid(row.id) || result.has(row.id)) throw Error("Invalid alert identity.");
    result.set(row.id, row);
  }
  return result;
}

/** One bounded list. Cold original verification is reserved for the actual decision. */
export async function loadAlertReviews(status: AlertReviewStatus = "pending"): Promise<AlertReview[]> {
  if (!statuses.includes(status)) throw Error("Unsupported alert view.");
  const db = createSupabaseAdminClient() as SupabaseClient;
  const reviews = await db.from("program_text_alert_reviews").select("id,content_hash,status,details,created_at")
    .eq("status", status).order("created_at", { ascending: false }).order("id", { ascending: true }).limit(100);
  if (reviews.error) throw Error("Alert list unavailable.");
  return hydrateAlertReviewRows(db, rows(reviews.data), status);
}

/** Two bounded views share metadata reads; private evidence is still decision-only. */
export async function loadPendingAndApprovedAlertReviews() {
  const db = createSupabaseAdminClient() as SupabaseClient;
  const statuses = ["pending", "approved"] as const;
  const responses = await Promise.all(statuses.map(status => db.from("program_text_alert_reviews")
    .select("id,content_hash,status,details,created_at").eq("status", status)
    .order("created_at", { ascending: false }).order("id", { ascending: true }).limit(100)));
  const reviewRows = responses.flatMap((response, index) => {
    if (response.error) throw Error("Alert list unavailable.");
    const values = rows(response.data);
    if (values.some(row => row.status !== statuses[index])) throw Error("Invalid alert details.");
    return values;
  });
  const hydrated = await hydrateAlertReviewRows(db, reviewRows, undefined, 200);
  return { pending: hydrated.filter(row => row.status === "pending"), approved: hydrated.filter(row => row.status === "approved") };
}

/** Bounded original members for a group; this never makes a review decision. */
export async function loadAlertReviewMembers(ids: string[]): Promise<AlertReview[]> {
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => !uuid(id)) || new Set(ids).size !== ids.length) throw Error("Invalid alert members.");
  if (!ids.length) return [];
  const db = createSupabaseAdminClient() as SupabaseClient;
  const reviews = await db.from("program_text_alert_reviews").select("id,content_hash,status,details,created_at")
    .in("id", ids).limit(100);
  if (reviews.error) throw Error("Alert members unavailable.");
  const result = await hydrateAlertReviewRows(db, rows(reviews.data));
  if (result.length !== ids.length) throw Error("Incomplete alert members.");
  return result;
}

async function hydrateAlertReviewRows(db: SupabaseClient, reviewRows: Array<Record<string, unknown>>, expectedStatus?: AlertReviewStatus, maxRows: 100 | 200 = 100): Promise<AlertReview[]> {
  if (reviewRows.length > maxRows) throw Error("Alert list unavailable.");
  const reviewIds = [...uniqueMap(reviewRows).keys()];
  if (!reviewIds.length) return [];
  const candidates = await db.from("shared_award_visual_review_candidates").select("id,shared_award_id,source_url,created_at,candidate_scope")
    .in("id", reviewIds).limit(maxRows);
  if (candidates.error) throw Error("Alert sources unavailable.");
  const candidateRows = rows(candidates.data, maxRows), byCandidate = uniqueMap(candidateRows);
  if (candidateRows.length !== reviewRows.length) throw Error("Incomplete alert sources.");
  const awardIds = [...new Set(candidateRows.map(row => row.shared_award_id))];
  if (!awardIds.every(uuid)) throw Error("Invalid award identity.");
  const awards = await db.from("shared_awards").select("id,name").in("id", awardIds).limit(maxRows);
  if (awards.error) throw Error("Alert awards unavailable.");
  const byAward = uniqueMap(rows(awards.data, maxRows));
  return reviewRows.map(row => {
    const candidate = byCandidate.get(row.id as string), details = parseProgramTextChangeDetails(row.details);
    const award = candidate && byAward.get(candidate.shared_award_id as string);
    if (!statuses.includes(row.status as AlertReviewStatus) || expectedStatus && row.status !== expectedStatus || !hash(row.content_hash) || !candidate || candidate.candidate_scope !== "program_text_change" ||
        !award || typeof award.name !== "string" || !award.name.trim() || award.name.length > 500 || !details ||
        typeof candidate.created_at !== "string" || !Number.isFinite(Date.parse(candidate.created_at))) throw Error("Invalid alert details.");
    const presentation = programChangePresentation(row.details);
    if (!presentation) throw Error("Invalid alert presentation.");
    return {
      id: row.id as string, contentHash: row.content_hash, status: row.status as AlertReviewStatus, awardName: award.name,
      awardId: candidate.shared_award_id as string,
      summary: presentation.text, sourceUrl: sourceUrl(candidate.source_url), detectedAt: candidate.created_at,
      context: presentation.context,
      details: details.program_changes.map((change: { field: string; summary: string; previous_quote: { text: string } | null; current_quote: { text: string } | null }, index: number) => ({
        category: labels[change.field], summary: presentation.changes[index].summary,
        ...(change.previous_quote ? { previous: change.previous_quote.text } : {}),
        ...(change.current_quote ? { current: change.current_quote.text } : {}),
      })),
    };
  });
}

export type AlertReviewDecision = { id: string; expected_hash: string; action: "approve" | "dismiss" };
/** Reusable cold verification; callers still commit decisions through an atomic RPC. */
export async function verifyPendingAlertReview(id: string, expectedHash: string, db: SupabaseClient = createSupabaseAdminClient() as SupabaseClient) {
  if (!uuid(id) || !hash(expectedHash)) throw Error("Invalid alert version.");
  const review = await db.from("program_text_alert_reviews").select("id,content_hash,status,details").eq("id", id).single();
  if (review.error || !object(review.data) || review.data.id !== id || review.data.status !== "pending" || review.data.content_hash !== expectedHash) throw Error("Alert review changed. Refresh before deciding.");
  const { verifySavedAlertEvidence } = await import("@/lib/alert-evidence.server");
  await verifySavedAlertEvidence(id, review.data.details, db, "pending");
}

/** Historical approved members retain their original captures, not today's baseline. */
export async function verifyApprovedAlertReview(id: string, expectedHash: string, db: SupabaseClient = createSupabaseAdminClient() as SupabaseClient) {
  if (!uuid(id) || !hash(expectedHash)) throw Error("Invalid alert version.");
  const review = await db.from("program_text_alert_reviews").select("id,content_hash,status,details,event_id,localization").eq("id", id).single();
  if (review.error || !object(review.data) || review.data.id !== id || review.data.status !== "approved" || review.data.content_hash !== expectedHash || !uuid(review.data.event_id)) throw Error("Approved alert changed.");
  const { verifySavedAlertEvidence } = await import("@/lib/alert-evidence.server");
  await verifySavedAlertEvidence(id, review.data.details, db, "approved", review.data.event_id, review.data.localization);
}

/** The caller must authenticate the administrator and reject cross-origin mutations. */
export async function decideAlertReview(input: AlertReviewDecision, actor: string) {
  if (!uuid(input.id) || !hash(input.expected_hash) || !["approve", "dismiss"].includes(input.action) || !uuid(actor)) throw Error("Invalid alert decision.");
  const db = createSupabaseAdminClient() as SupabaseClient;
  await verifyPendingAlertReview(input.id, input.expected_hash, db);
  const result = await db.rpc("decide_program_text_alert", {
    p_id: input.id, p_expected_hash: input.expected_hash, p_action: input.action, p_actor: actor,
  });
  if (result.error || !object(result.data) || result.data.ok !== true) throw Error("No alert decision was confirmed. Refresh before trying again.");
  return { ok: true } as const;
}
