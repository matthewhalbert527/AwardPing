import { createHash } from "node:crypto";
import {
  stableStage1ManifestJson,
  stage1ManifestReviewRootBindings,
  stage1ManifestDraftScope,
} from "./stage1-manifest-draft.mjs";

const PAGE_SIZE = 1_000;
const MAX_ROWS = 100_000;

/**
 * Load only the evidence needed by an explicit mapping. Every table is read
 * twice with exact counts and a full canonical revision comparison. No ranked
 * source or candidate query is performed.
 */
export async function loadStage1ManifestDraftDatabase({
  supabase,
  mapping,
  now = new Date(),
}) {
  if (!supabase || typeof supabase.from !== "function") {
    throw new Error("Stage 1 manifest draft loading requires a Supabase client.");
  }
  const scope = stage1ManifestDraftScope(mapping, now);
  const reviewRootBindings = stage1ManifestReviewRootBindings(mapping, now);
  const registry = await stableRows(
    () => supabase
      .from("stage1_award_registry")
      .select("cohort_key,launch_rank,canonical_name,canonical_shared_award_id,canonical_slug,official_homepage,publication_state,state_reason,policy_version,fact_ledger_batch_id,release_epoch,evidence_checked_at,last_verified_at,created_at,updated_at", { count: "exact" })
      .in("cohort_key", scope.cohort_keys)
      .order("launch_rank", { ascending: true })
      .order("cohort_key", { ascending: true }),
    "Stage 1 registry",
    (row) => `cohort:${row.cohort_key}`,
  );
  const members = await stableRows(
    () => supabase
      .from("stage1_award_members")
      .select("shared_award_id,cohort_key,member_kind,reason,created_at,updated_at", { count: "exact" })
      .in("cohort_key", scope.cohort_keys)
      .order("cohort_key", { ascending: true })
      .order("member_kind", { ascending: true })
      .order("shared_award_id", { ascending: true }),
    "Stage 1 cohort members",
    (row) => `member:${row.shared_award_id}`,
  );
  const identityRules = await stableRows(
    () => supabase
      .from("stage1_award_source_identity_rules")
      .select("id,cohort_key,rule_key,url_pattern,title_pattern,reason,policy_version,created_at,updated_at", { count: "exact" })
      .in("cohort_key", scope.cohort_keys)
      .order("cohort_key", { ascending: true })
      .order("rule_key", { ascending: true })
      .order("id", { ascending: true }),
    "Stage 1 source identity rules",
    (row) => `identity-rule:${row.id}`,
  );

  const memberAwardIds = [...new Set([
    ...scope.canonical_award_ids,
    ...members.map((row) => row.shared_award_id),
  ])].toSorted();
  const [awards, sources, visualSnapshots, factCandidates] = await Promise.all([
    stableRows(
      () => supabase
        .from("shared_awards")
        .select("id,search_key,name,slug,official_homepage,public_facts,status,created_at,updated_at", { count: "exact" })
        .in("id", memberAwardIds)
        .order("id", { ascending: true }),
      "mapped Stage 1 awards",
      (row) => `award:${row.id}`,
    ),
    stableRows(
      () => supabase
        .from("shared_award_sources")
        .select("id,shared_award_id,url,title,display_title,page_description,page_type,admin_review_status,last_checked_at,last_error,created_at,updated_at", { count: "exact" })
        .in("id", scope.source_ids)
        .order("id", { ascending: true }),
      "explicitly mapped Stage 1 sources",
      (row) => `source:${row.id}`,
    ),
    stableRows(
      () => supabase
        .from("shared_award_source_visual_snapshots")
        .select("shared_award_source_id,shared_award_id,source_url,source_title,source_page_type,kind,bucket,latest_captured_at,latest_object_keys,latest_hashes,latest_metadata,previous_captured_at,previous_object_keys,previous_hashes,previous_metadata,created_at,updated_at", { count: "exact" })
        .in("shared_award_source_id", scope.source_ids)
        .order("shared_award_source_id", { ascending: true }),
      "explicitly mapped latest visual snapshots",
      (row) => `snapshot:${row.shared_award_source_id}`,
    ),
    stableRows(
      () => supabase
        .from("shared_award_fact_candidates")
        .select("id,shared_award_id,shared_award_source_id,source_url,source_title,source_role,source_quality_decision,field_name,raw_value,normalized_value,evidence_quote,evidence_location,extracted_at,model,confidence,candidate_status,rejection_reason,selected_reason,intake_value_sha256,metadata,created_at,updated_at", { count: "exact" })
        .in("id", scope.candidate_ids)
        .order("id", { ascending: true }),
      "explicitly mapped fact candidates",
      (row) => `candidate:${row.id}`,
    ),
  ]);

  const [reconciliations, pageAudits] = await Promise.all([
    stableRows(
      () => supabase
        .from("shared_award_reconciliation_queue")
        .select("id,shared_award_id,reason,source_ids,candidate_ids,status,priority,created_at,started_at,completed_at,error,metadata", { count: "exact" })
        .in("shared_award_id", scope.canonical_award_ids)
        .order("shared_award_id", { ascending: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
      "canonical-award reconciliation history",
      (row) => `reconciliation:${row.id}`,
    ),
    stableRows(
      () => supabase
        .from("shared_award_page_audits")
        .select("id,shared_award_id,audit_kind,audit_status,severity,findings,suggested_fixes,field_conflicts,source_rejections,selected_fact_summary,public_page_snapshot,model,gemini_batch_name,gemini_batch_request_key,created_at,resolved_at,resolved_by,resolution_note", { count: "exact" })
        .in("shared_award_id", memberAwardIds)
        .order("shared_award_id", { ascending: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
      "Stage 1 cohort page-audit history",
      (row) => `page-audit:${row.id}`,
    ),
  ]);

  const persistedReviewRoots = await Promise.all(reviewRootBindings.map(async (binding) => {
    const first = await loadPersistedReviewRoot(supabase, binding.root_sha256);
    const verification = await loadPersistedReviewRoot(supabase, binding.root_sha256);
    if (stableStage1ManifestJson(first) !== stableStage1ManifestJson(verification)) {
      throw readError("persisted Stage 1 human-review root", "immutable root changed between verification reads");
    }
    if (!verification) {
      throw readError(
        "persisted Stage 1 human-review root",
        `root ${binding.root_sha256} is missing`,
      );
    }
    return verification;
  }));

  return {
    registry,
    members,
    identity_rules: identityRules,
    awards,
    sources,
    visual_snapshots: visualSnapshots,
    fact_candidates: factCandidates,
    reconciliations,
    page_audits: pageAudits,
    persisted_review_roots: persistedReviewRoots,
  };
}

async function loadPersistedReviewRoot(supabase, rootSha256) {
  const result = await supabase.rpc("get_stage1_human_review_root", {
    p_root_sha256: rootSha256,
  });
  if (result.error) {
    throw readError(
      "persisted Stage 1 human-review root",
      result.error.message,
      result.error.code,
    );
  }
  return result.data ?? null;
}

export async function stableRows(buildQuery, label, identityFor, {
  pageSize = PAGE_SIZE,
  maxRows = MAX_ROWS,
} = {}) {
  if (typeof buildQuery !== "function" || typeof identityFor !== "function") {
    throw new TypeError(`${label}: stable read requires query and identity functions.`);
  }
  const first = await readPass(buildQuery, label, identityFor, pageSize, maxRows);
  const verification = await readPass(buildQuery, label, identityFor, pageSize, maxRows);
  if (first.count !== verification.count || first.revision !== verification.revision) {
    throw readError(label, "rows changed between the two exact read-only passes");
  }
  return verification.rows;
}

async function readPass(buildQuery, label, identityFor, pageSize, maxRows) {
  const rows = [];
  const identities = new Set();
  let expectedCount = null;
  for (let start = 0; ; start += pageSize) {
    const result = await buildQuery().range(start, start + pageSize - 1);
    if (result.error) throw readError(label, result.error.message, result.error.code);
    if (!Number.isSafeInteger(result.count) || result.count < 0) {
      throw readError(label, "exact row count was unavailable");
    }
    if (result.count > maxRows) {
      throw readError(label, `exact row count ${result.count} exceeds the ${maxRows}-row safety ceiling`);
    }
    if (expectedCount === null) expectedCount = result.count;
    else if (expectedCount !== result.count) {
      throw readError(label, "exact row count changed during pagination");
    }
    const page = Array.isArray(result.data) ? result.data : [];
    const expectedLength = Math.min(pageSize, Math.max(0, expectedCount - start));
    if (page.length !== expectedLength) {
      throw readError(label, `incomplete page at offset ${start}`);
    }
    for (const row of page) {
      const identity = String(identityFor(row) || "").trim();
      if (!identity) throw readError(label, "row identity was missing");
      if (identities.has(identity)) throw readError(label, `duplicate row identity ${identity}`);
      identities.add(identity);
      rows.push(row);
    }
    if (rows.length >= expectedCount) break;
  }
  const revision = createHash("sha256")
    .update(stableStage1ManifestJson(rows), "utf8")
    .digest("hex");
  return { rows, count: expectedCount, revision };
}

function readError(label, message, code = null) {
  const error = new Error(`${label}: stable read-only snapshot failed: ${message}`);
  if (code) error.code = code;
  return error;
}
