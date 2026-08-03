import { stableRows } from "./stage1-manifest-draft-loader.mjs";
import { reviewedStage1SelectionScope } from "./stage1-reviewed-reconciliation.mjs";

/**
 * Load only the human-selected candidate identities and their direct sources.
 * No ranked, open-source, or broad candidate inventory query is permitted.
 */
export async function loadReviewedStage1ReconciliationDatabase({
  supabase,
  selection,
  now = new Date(),
}) {
  if (!supabase || typeof supabase.from !== "function") {
    throw new Error("Reviewed Stage 1 reconciliation requires a Supabase client.");
  }
  const scope = reviewedStage1SelectionScope(selection, now);
  const [registry, members, identityRules, awards, factCandidates, activeQueue] =
    await Promise.all([
      stableRows(
        () => supabase
          .from("stage1_award_registry")
          .select("cohort_key,canonical_name,canonical_shared_award_id,official_homepage,publication_state,policy_version,created_at,updated_at", { count: "exact" })
          .eq("cohort_key", scope.cohort_key)
          .order("cohort_key", { ascending: true }),
        "reviewed reconciliation registry",
        (row) => `registry:${row.cohort_key}`,
      ),
      stableRows(
        () => supabase
          .from("stage1_award_members")
          .select("shared_award_id,cohort_key,member_kind,reason,created_at,updated_at", { count: "exact" })
          .eq("cohort_key", scope.cohort_key)
          .order("shared_award_id", { ascending: true }),
        "reviewed reconciliation cohort members",
        (row) => `member:${row.shared_award_id}`,
      ),
      stableRows(
        () => supabase
          .from("stage1_award_source_identity_rules")
          .select("id,cohort_key,rule_key,url_pattern,title_pattern,reason,policy_version,created_at,updated_at", { count: "exact" })
          .eq("cohort_key", scope.cohort_key)
          .order("id", { ascending: true }),
        "reviewed reconciliation identity rules",
        (row) => `identity-rule:${row.id}`,
      ),
      stableRows(
        () => supabase
          .from("shared_awards")
          .select("id,search_key,name,slug,official_homepage,summary,public_facts,status,updated_at", { count: "exact" })
          .eq("id", scope.canonical_award_id)
          .order("id", { ascending: true }),
        "reviewed reconciliation canonical award",
        (row) => `award:${row.id}`,
      ),
      stableRows(
        () => supabase
          .from("shared_award_fact_candidates")
          .select("id,shared_award_id,shared_award_source_id,source_url,source_title,source_role,field_name,normalized_value,evidence_quote,evidence_location,extracted_at,model,confidence,candidate_status,rejection_reason,selected_reason,source_page_request_id,intake_value_sha256,metadata,created_at,updated_at", { count: "exact" })
          .in("id", scope.candidate_ids)
          .order("id", { ascending: true }),
        "explicitly reviewed candidates",
        (row) => `candidate:${row.id}`,
      ),
      stableRows(
        () => supabase
          .from("shared_award_reconciliation_queue")
          .select("id,shared_award_id,reason,source_ids,candidate_ids,status,priority,created_at,started_at,completed_at,error,metadata,generation", { count: "exact" })
          .eq("shared_award_id", scope.canonical_award_id)
          .in("status", ["pending", "processing"])
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }),
        "active reviewed reconciliation queue",
        (row) => `queue:${row.id}`,
      ),
    ]);

  const sourceIds = scope.source_ids;
  const [sources, visualSnapshots] = await Promise.all([
    stableRows(
      () => supabase
        .from("shared_award_sources")
        .select("id,shared_award_id,url,title,display_title,page_description,page_type,admin_review_status,last_checked_at,last_error,created_at,updated_at", { count: "exact" })
        .in("id", sourceIds)
        .order("id", { ascending: true }),
      "explicit candidate contributor sources",
      (row) => `source:${row.id}`,
    ),
    stableRows(
      () => supabase
        .from("shared_award_source_visual_snapshots")
        .select("shared_award_source_id,shared_award_id,source_url,source_title,source_page_type,kind,bucket,latest_captured_at,latest_object_keys,latest_hashes,latest_metadata,created_at,updated_at", { count: "exact" })
        .in("shared_award_source_id", sourceIds)
        .order("shared_award_source_id", { ascending: true }),
      "explicit candidate contributor snapshots",
      (row) => `snapshot:${row.shared_award_source_id}`,
    ),
  ]);

  return {
    registry,
    members,
    identity_rules: identityRules,
    awards,
    fact_candidates: factCandidates,
    active_queue: activeQueue,
    sources,
    visual_snapshots: visualSnapshots,
  };
}
