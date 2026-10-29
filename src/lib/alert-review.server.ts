import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AlertReview, AlertReviewStatus } from "../components/admin-alert-review-board";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createR2Client, getR2Bucket } from "@/lib/r2";
import { parseProgramTextChangeDetails } from "../../scripts/lib/program-change-contract.mjs";
import { loadProgramTextCapture } from "../../scripts/lib/program-text-artifacts.mjs";
import { createProgramTextRepository, programTextEqual } from "../../scripts/lib/program-text-repository.mjs";
import { validateProgramTextReviewResult } from "../../scripts/lib/program-text-review.mjs";

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
  const reviewRows = rows(reviews.data), reviewIds = [...uniqueMap(reviewRows).keys()];
  if (!reviewIds.length) return [];
  const candidates = await db.from("shared_award_visual_review_candidates").select("id,shared_award_id,source_url,created_at,candidate_scope")
    .in("id", reviewIds).limit(100);
  if (candidates.error) throw Error("Alert sources unavailable.");
  const candidateRows = rows(candidates.data), byCandidate = uniqueMap(candidateRows);
  if (candidateRows.length !== reviewRows.length) throw Error("Incomplete alert sources.");
  const awardIds = [...new Set(candidateRows.map(row => row.shared_award_id))];
  if (!awardIds.every(uuid)) throw Error("Invalid award identity.");
  const awards = await db.from("shared_awards").select("id,name").in("id", awardIds).limit(100);
  if (awards.error) throw Error("Alert awards unavailable.");
  const byAward = uniqueMap(rows(awards.data));
  return reviewRows.map(row => {
    const candidate = byCandidate.get(row.id as string), details = parseProgramTextChangeDetails(row.details);
    const award = candidate && byAward.get(candidate.shared_award_id as string);
    if (row.status !== status || !hash(row.content_hash) || !candidate || candidate.candidate_scope !== "program_text_change" ||
        !award || typeof award.name !== "string" || !award.name.trim() || award.name.length > 500 || !details ||
        typeof candidate.created_at !== "string" || !Number.isFinite(Date.parse(candidate.created_at))) throw Error("Invalid alert details.");
    return {
      id: row.id as string, contentHash: row.content_hash, status, awardName: award.name,
      summary: details.summary, sourceUrl: sourceUrl(candidate.source_url), detectedAt: candidate.created_at,
      details: details.program_changes.map((change: { field: string; summary: string; previous_quote: { text: string } | null; current_quote: { text: string } | null }) => ({
        category: labels[change.field], summary: change.summary,
        ...(change.previous_quote ? { previous: change.previous_quote.text } : {}),
        ...(change.current_quote ? { current: change.current_quote.text } : {}),
      })),
    };
  });
}

export type AlertReviewDecision = { id: string; expected_hash: string; action: "approve" | "dismiss" };
/** The caller must authenticate the administrator and reject cross-origin mutations. */
export async function decideAlertReview(input: AlertReviewDecision, actor: string) {
  if (!uuid(input.id) || !hash(input.expected_hash) || !["approve", "dismiss"].includes(input.action) || !uuid(actor)) throw Error("Invalid alert decision.");
  const db = createSupabaseAdminClient() as SupabaseClient;
  const review = await db.from("program_text_alert_reviews").select("id,content_hash,status,details").eq("id", input.id).single();
  if (review.error || !object(review.data) || review.data.id !== input.id || review.data.status !== "pending" ||
      review.data.content_hash !== input.expected_hash) throw Error("Alert review changed. Refresh before deciding.");
  const candidate = await db.from("shared_award_visual_review_candidates").select("*").eq("id", input.id).single();
  if (candidate.error || !object(candidate.data) || candidate.data.id !== input.id || candidate.data.status !== "succeeded" ||
      candidate.data.published_at || !object(candidate.data.prompt_payload) || !object(candidate.data.ai_result)) throw Error("Alert candidate unavailable.");
  const client = createR2Client(), bucket = getR2Bucket();
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof loadProgramTextCapture>>>>();
  const loadCapture = (ref: Parameters<typeof loadProgramTextCapture>[0]) => {
    const key = JSON.stringify(ref);
    if (!cache.has(key)) cache.set(key, loadProgramTextCapture(ref, { client, bucket }));
    return cache.get(key)!;
  };
  await createProgramTextRepository(db, { loadCapture, bucket }).verifyCandidate(candidate.data);
  const payload = candidate.data.prompt_payload, aiResult = candidate.data.ai_result;
  const validated = validateProgramTextReviewResult(payload.comparison, payload.packet_plan, aiResult.responses);
  if (validated.status !== "accepted" || !("details" in validated) || !parseProgramTextChangeDetails(review.data.details) ||
      !programTextEqual(validated.details, review.data.details) || !programTextEqual(validated, aiResult.program_text_validation)) {
    throw Error("The saved alert no longer matches its verified source comparison.");
  }
  const result = await db.rpc("decide_program_text_alert", {
    p_id: input.id, p_expected_hash: input.expected_hash, p_action: input.action, p_actor: actor,
  });
  if (result.error || !object(result.data) || result.data.ok !== true) throw Error("No alert decision was confirmed. Refresh before trying again.");
  return { ok: true } as const;
}
