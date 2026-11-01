const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

/** A conservative existence check, never an authorization or a selected work set.
 * A positive result must still pass the complete current roster, source access,
 * retained evidence and claim checks before any provider or publication work.
 * Cohort/shard filters deliberately remain in that authoritative path: work
 * outside a requested subset can cause extra setup, but cannot be reviewed.
 */
export async function hasPotentialProgramTextReview(supabase, { epoch, sourceId } = {}) {
  if (!uuid(epoch) || sourceId !== undefined && !uuid(sourceId)) throw new Error("Invalid text review queue probe scope");
  let query = supabase.from("shared_award_visual_review_candidates").select("id")
    .eq("candidate_scope", "program_text_change").eq("worker_metadata->>epoch", epoch)
    .is("worker_metadata->>admin_alert_review_id", null).in("status", ["pending", "submitted", "succeeded"]);
  if (sourceId !== undefined) query = query.eq("shared_award_source_id", sourceId);
  const { data, error } = await query.limit(1);
  if (error || !Array.isArray(data) || data.length > 1 || data.some(row => !uuid(row?.id))) {
    throw new Error("Text review queue probe failed");
  }
  return data.length === 1;
}
