import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../supabase/migrations/20260716150000_initial_official_document_events.sql", import.meta.url),
  "utf8",
);

describe("initial official document migration", () => {
  it("defaults legacy intake to baseline-only and stores immutable acquisition provenance", () => {
    expect(migration).toContain("acquisition_kind text not null default 'legacy_unknown'");
    expect(migration).toContain("notification_mode text not null default 'baseline_only'");
    expect(migration).toContain("create table if not exists public.shared_award_source_acquisitions");
    expect(migration).toContain("before update or delete on public.shared_award_source_acquisitions");
    expect(migration).toContain("revoke insert, update, delete, truncate on table public.shared_award_source_acquisitions");
    expect(migration).toContain("grant select on table public.shared_award_source_acquisitions to service_role");
    expect(migration).not.toContain("grant select, insert on table public.shared_award_source_acquisitions");
    expect(migration).toContain("shared_award_source_id uuid not null unique");
  });

  it("registers a new source and acquisition in one server-controlled transaction", () => {
    const rpc = functionBody(migration, "create or replace function public.register_shared_award_source_from_intake");
    expect(rpc).toContain("pg_advisory_xact_lock");
    expect(rpc).toContain("insert into public.shared_award_sources");
    expect(rpc).toContain("on conflict (shared_award_id, url) do nothing");
    expect(rpc).toContain("insert into public.shared_award_source_acquisitions");
    expect(rpc).toContain("source_inserted := false");
    expect(rpc).toContain("effective_notification_mode := 'baseline_only'");
    expect(rpc).toContain("effective_disposition_reason text");
    expect(rpc).toContain("v_acquisition_kind = 'live_discovery'");
    expect(rpc).toContain("v_request.notification_mode = 'first_capture_candidate'");
    expect(rpc).toContain("v_request.onboarding_batch_id is null");
    expect(rpc).toContain("v_request.capture_metadata ->> 'capture_file_hash'");
    expect(rpc).toContain("position(v_normalized_quote in v_normalized_capture_text) = 0");
    expect(rpc).toContain("v_acquisition_metadata -> 'award_was_created' = 'false'::jsonb");
    expect(rpc).toContain("v_acquisition_metadata -> 'source_was_inserted' = 'true'::jsonb");
    expect(rpc).toContain("v_request.capture_metadata -> 'retained_artifact' = v_retained_artifact");
    expect(rpc).toContain("not (v_request.capture_metadata ? 'artifact_bytes')");
    expect(rpc).toContain("source-intake-first-observation/v1/requests/");
    expect(rpc).toContain("'server_artifact_binding'");
    const liveFailure = rpc.indexOf("elsif v_requested_notification_mode = 'first_capture_candidate'");
    expect(liveFailure).toBeGreaterThan(-1);
    expect(rpc.indexOf("raise exception using", liveFailure)).toBeGreaterThan(liveFailure);
    expect(rpc).toContain("source registration was rolled back for repair and replay");
    expect(rpc).not.toContain("server_live_first_capture_evidence_or_provenance_failed");
    expect(rpc).toContain("'effective_disposition_reason', effective_disposition_reason");
  });

  it("requires the exact locked post-seed discovery ledger binding for live eligibility", () => {
    const rpc = functionBody(migration, "create or replace function public.register_shared_award_source_from_intake");
    const ledgerGate = rpc.slice(
      rpc.indexOf("perform 1\n      from public.shared_award_source_discovered_links link"),
      rpc.indexOf(
        "v_normalized_capture_text :=",
        rpc.indexOf("perform 1\n      from public.shared_award_source_discovered_links link"),
      ),
    );
    expect(ledgerGate).toContain("from public.shared_award_source_discovered_links link");
    expect(ledgerGate).toContain("link.parent_shared_award_source_id = v_parent_shared_award_source_id");
    expect(ledgerGate).toContain("link.url_hash = public.awardping_sha256_text(v_url)");
    expect(ledgerGate).toContain("link.normalized_url = v_url");
    // A missing row leaves FOUND false; baseline-only and mismatched-request rows
    // are excluded by these predicates before exact evidence can become eligible.
    expect(ledgerGate).toContain("link.notification_mode = 'first_capture_candidate'");
    expect(ledgerGate).toContain("link.onboarding_batch_id is null");
    expect(ledgerGate).toContain("link.source_page_request_id = v_origin_source_page_request_id");
    expect(ledgerGate).toContain("for share");
    expect(ledgerGate).toMatch(/for share;\s+\s*if found then/);
  });

  it("seeds existing PDF links baseline-only before allowing live 6 PM discovery", () => {
    expect(migration).toContain("create table if not exists public.shared_award_source_discovery_states");
    expect(migration).toContain("create table if not exists public.shared_award_source_discovered_links");
    expect(migration).toContain("source_page_request_id uuid");
    expect(migration).toContain("request_queued_at timestamptz");
    expect(migration).toContain("p_scan_complete boolean default false");
    const rpc = functionBody(migration, "create or replace function public.register_shared_award_source_pdf_links");
    expect(rpc).toContain("v_seed_completed := found");
    expect(rpc).toMatch(
      /when v_seed_completed\s+and p_live_requested\s+and nullif\(btrim\(p_onboarding_batch_id\), ''\) is null\s+then 'first_capture_candidate'/,
    );
    expect(rpc).not.toMatch(/when v_seed_completed\s+and p_scan_complete\s+and p_live_requested/);
    expect(rpc).toContain("else 'baseline_only'");
    expect(rpc).toContain("on conflict (parent_shared_award_source_id, url_hash) do nothing");
    expect(rpc).toContain("v_link.notification_mode");
    expect(rpc).toContain("request.normalized_url = v_url");
    expect(rpc).toContain("request.homepage_url = v_url");
    expect(rpc).toContain("request.submitted_url = v_url");
    expect(rpc).toContain("source_page_request_id = v_request.id");
    expect(rpc).toContain("prior_source_page_request_id = v_request.id");
    expect(rpc).toContain("request.status in");
    expect(rpc).toContain("request.acquisition_kind = 'live_discovery'");
    expect(rpc).toContain("request.notification_mode = 'first_capture_candidate'");
    expect(rpc).toContain("'prior_terminal_request_requires_action'");
    expect(rpc).toContain("'prior_non_live_request_requires_action'");
    expect(rpc).toContain("'active_live_request_bound'");
    expect(rpc).toContain("p_urls is null");
    expect(rpc).toContain("p_metadata is null");
    expect(rpc).toContain("if v_seed_completed or p_scan_complete then");
    expect(rpc).toContain("'last_scan_complete', p_scan_complete");
    expect(rpc.indexOf("when v_seed_completed")).toBeLessThan(
      rpc.indexOf("if v_seed_completed or p_scan_complete then"),
    );
    expect(rpc).toContain("insert into public.shared_award_source_discovery_states");
    expect(rpc).toContain("on conflict (shared_award_source_id) do update");
    expect(migration).toContain(
      "grant execute on function public.register_shared_award_source_pdf_links(uuid, jsonb, uuid, boolean, text, jsonb, boolean)",
    );
  });

  it("binds only an exact active live request and fails closed on concurrent prior intake", () => {
    const rpc = functionBody(migration, "create or replace function public.bind_shared_award_discovered_link_request");
    expect(rpc).toContain("request.id = p_source_page_request_id");
    expect(rpc).toContain("v_request.normalized_url is not distinct from v_url");
    expect(rpc).toContain("v_request.homepage_url is not distinct from v_url");
    expect(rpc).toContain("v_request.submitted_url is not distinct from v_url");
    expect(rpc).toContain("v_request.matched_shared_award_id = v_source.shared_award_id");
    expect(rpc).toContain("v_link.source_page_request_id <> p_source_page_request_id");
    expect(rpc).toContain("request_queued_at = coalesce(link.request_queued_at, v_request.created_at)");
    expect(rpc).toContain("v_request.acquisition_kind <> 'live_discovery'");
    expect(rpc).toContain("v_request.notification_mode <> 'first_capture_candidate'");
    expect(rpc).toContain("v_request.status not in");
    expect(rpc).toContain("discovered_pdf_prior_request_conflict_no_charge");
    expect(rpc).toContain("prior_source_page_request_id = v_conflicting_request.id");
    expect(rpc).toContain("return false");
    expect(migration).toContain(
      "grant execute on function public.bind_shared_award_discovered_link_request(uuid, text, uuid)",
    );
  });

  it("creates and binds a discovered-PDF request atomically without hiding prior provenance", () => {
    const rpc = functionBody(
      migration,
      "create or replace function public.create_and_bind_shared_award_discovered_link_request",
    );

    expect(rpc).toContain("insert into public.source_page_requests");
    expect(rpc).toContain("update public.shared_award_source_discovered_links link");
    expect(rpc).toContain("source_page_request_id = v_inserted.id");
    expect(rpc).toContain("prior_source_page_request_id = v_existing.id");
    expect(rpc).toContain("quarantine_required := true");
    expect(rpc).toContain("when unique_violation then");
    expect(rpc).toContain("v_existing.acquisition_kind = 'live_discovery'");
    expect(rpc).toContain("v_existing.status <> 'needs_manual_review'");
    expect(rpc).toContain("v_award_name is distinct from v_expected_award_name");
    expect(rpc).toContain("request award name does not match its authoritative award");
    expect(rpc).not.toMatch(/insert into public\.source_page_requests[\s\S]*?return next;[\s\S]*?bind_shared_award_discovered_link_request/);
  });

  it("keeps prior-request conflicts in a durable quarantine with supported safe resolutions", () => {
    const recordRpc = functionBody(
      migration,
      "create or replace function public.record_shared_award_discovered_link_quarantine",
    );
    const resolveRpc = functionBody(
      migration,
      "create or replace function public.resolve_shared_award_discovered_link_quarantine",
    );

    expect(recordRpc).toContain("insert into public.manual_quarantine_registry");
    expect(recordRpc).toContain("'manual_source_intake_provenance_review'");
    expect(recordRpc).toContain("'may_charge'");
    expect(recordRpc).toContain("Replay the same retained live result for $0 when eligible");
    expect(recordRpc).toContain("never relabel historical evidence as live");
    expect(recordRpc).toContain("'shared_award_sources'");

    expect(resolveRpc).toContain("'bind_eligible_live_request'");
    expect(resolveRpc).toContain("'approve_new_live_review'");
    expect(resolveRpc).toContain("p_actor_user_id uuid");
    expect(resolveRpc).toContain("p_expected_evidence_hash text");
    expect(resolveRpc).toContain("v_quarantine.status <> 'in_review'");
    expect(resolveRpc).toContain("v_quarantine.evidence_hash is distinct from p_expected_evidence_hash");
    expect(resolveRpc).toContain("from public.manual_quarantine_operator_assignments assignment");
    expect(resolveRpc).toContain("v_assignment.assigned_to_user_id is distinct from p_actor_user_id");
    expect(resolveRpc).toContain("v_assignment.assigned_to_email is distinct from v_actor");
    expect(resolveRpc).toContain("select request.* into strict v_prior_request");
    expect(resolveRpc).toContain("status = 'rejected'");
    expect(resolveRpc).toContain("superseded_by_operator_approved_post_seed_live_pdf_review");
    expect(resolveRpc).toContain("prior_request_status_before_resolution");
    expect(resolveRpc).toContain("prior_request_evidence_preserved");
    expect(resolveRpc).toContain("when unique_violation then");
    expect(resolveRpc).toContain("The quarantine remains unresolved and no new request was committed");
    expect(resolveRpc.indexOf("status = 'rejected'")).toBeLessThan(
      resolveRpc.indexOf("insert into public.source_page_requests"),
    );
    expect(resolveRpc.indexOf("v_quarantine.evidence_hash is distinct")).toBeLessThan(
      resolveRpc.indexOf("select request.* into strict v_prior_request"),
    );
    expect(migration).toContain(
      "grant execute on function public.resolve_shared_award_discovered_link_quarantine(uuid, text, text, text, uuid, text, uuid)",
    );
  });

  it("rejects redirects by requiring one immutable URL and attestation identity end to end", () => {
    const rpc = functionBody(migration, "create or replace function public.publish_shared_award_initial_document_event");
    expect(rpc).toContain("v_acquisition_final_url");
    expect(rpc).toContain("v_attested_final_url");
    expect(rpc).toContain("v_attested_review_final_url");
    expect(rpc).toContain("{first_observation_attestation,body,capture,final_url}");
    expect(rpc).toContain("{first_observation_attestation,body,sealed_review,capture_final_url}");
    expect(rpc).toContain("v_source_url is distinct from v_source.url");
    expect(rpc).toContain("v_source_url is distinct from v_candidate.source_url");
    expect(rpc).toContain("v_source_url is distinct from v_acquisition_final_url");
    expect(rpc).toContain("v_source_url is distinct from v_attested_source_url");
    expect(rpc).toContain("v_source_url is distinct from v_attested_final_url");
    expect(rpc).toContain("v_source_url is distinct from v_attested_review_final_url");
    expect(rpc).toContain("v_attested_source_id is distinct from v_source_id::text");
    expect(rpc).toContain("v_attested_award_id is distinct from v_award_id::text");
    expect(rpc).toContain("v_attested_acquisition_id is distinct from v_acquisition_id::text");
    expect(rpc).toContain("{first_observation_attestation,canonical_json}");
    expect(rpc).toContain("public.awardping_sha256_text(v_candidate_attestation_json)");
    expect(rpc).toContain("{hashes,first_observation_attestation_sha256}");
    expect(rpc).toContain("v_candidate.previous_file_hash is distinct from v_candidate_attestation_sha256");
    expect(rpc).toContain("v_candidate.previous_snapshot_ref ->> 'attestation_sha256'");
    expect(rpc).toContain("v_attested_capture_file_sha256 is distinct from v_candidate.new_file_hash");
    expect(rpc).toContain("v_candidate.prompt_payload #> '{first_observation_attestation,body}'");
    expect(rpc).toContain("v_change_details #>> '{source,source_url}' is distinct from v_source_url");
    expect(rpc).not.toContain("v_sealed_redirect_allowed");
  });

  it("refreshes stale deterministic policy identity only through a claimed atomic RPC", () => {
    const guard = functionBody(
      migration,
      "create or replace function public.awardping_preserve_published_visual_candidate_identity",
    );
    expect(guard).toContain("awardping.initial_document_policy_refresh_candidate_id");
    expect(guard).toContain("v_authorized_initial_policy_refresh := coalesce(");
    expect(guard).toContain("old.candidate_scope = 'initial_official_document'");
    expect(guard).toContain("not v_has_evidence");
    expect(guard).toContain("old.publication_claim_token is not null");
    expect(guard).toContain("new.publication_claim_token is null");
    expect(guard).toContain("new.actual_usage = '{}'::jsonb");
    expect(guard).toContain("new.ai_result is not distinct from old.ai_result");
    expect(guard).toContain("new.prompt_payload - 'monitoring_policy' - 'monitoring_policy_bundle'");

    const rpc = functionBody(
      migration,
      "create or replace function public.refresh_shared_award_initial_document_candidate_policy",
    );
    expect(rpc).toContain("v_candidate.status <> 'succeeded'");
    expect(rpc).toContain("v_candidate.publication_claim_token is distinct from p_publication_claim_token");
    expect(rpc).toContain("v_candidate.actual_usage <> '{}'::jsonb");
    expect(rpc).toContain("event.visual_review_candidate_id = v_candidate.id");
    expect(rpc).toContain("v_acquisition.notification_mode <> 'first_capture_candidate'");
    expect(rpc).toContain("pg_catalog.set_config");
    expect(rpc).toContain("publication_claim_token = null");
    expect(migration).toContain(
      "grant execute on function public.refresh_shared_award_initial_document_candidate_policy(uuid, text, text, jsonb, jsonb, jsonb)",
    );
  });

  it("allows only the two exact Marshall sources in the approved historical recovery", () => {
    const recovery = migration.slice(
      migration.indexOf("-- These two rows are a deliberately narrow operator-approved recovery"),
      migration.indexOf("create or replace function public.publish_shared_award_initial_document_event"),
    );
    expect(recovery).toContain("37a03efe-cd73-4061-bee0-d194e7ff5c2b");
    expect(recovery).toContain("7dccefb4-3f8c-4fa8-9e9d-c7d909e07ced");
    expect(recovery).toContain("2027-Marshall-Application-Statements.pdf");
    expect(recovery).toContain("2027-Rules-for-Marshall-Scholarship-Candidates_final.pdf");
    expect(recovery.match(/'operator_historical_exception'/g)).toHaveLength(1);
    expect(recovery).toContain("on recovery.source_id = source.id and recovery.url = source.url");
    expect(recovery).toContain("on conflict (shared_award_source_id) do nothing");
    expect(recovery).not.toMatch(/where[\s\S]*?(reason|created_at)\s*[<=>]/i);
  });

  it("publishes through a dedicated atomic RPC bound to the sealed PDF and current-only evidence", () => {
    const rpc = functionBody(migration, "create or replace function public.publish_shared_award_initial_document_event");
    expect(rpc).toContain("for update");
    expect(rpc).toContain("v_acquisition.review_seal ->> 'capture_file_hash' is distinct from v_candidate.new_file_hash");
    expect(rpc).toContain("v_source_url is distinct from v_acquisition_final_url");
    expect(rpc).toContain("@> jsonb_build_array(v_change_details ->> 'exact_after')");
    expect(rpc).toContain("jsonb_typeof(v_previous_capture -> 'full') is distinct from 'null'");
    expect(rpc).toContain("v_current_capture #>> '{full,sha256}' is distinct from v_candidate.new_file_hash");
    expect(rpc).toContain("insert into public.shared_award_change_events");
    expect(rpc).toContain("insert into public.shared_award_change_event_visual_evidence");
    expect(rpc).toContain("'not_applicable_new_document'");
    expect(rpc).toContain("not_applicable_first_observation");
    expect(rpc).toContain("v_candidate.gemini_batch_request_key is not null");
    expect(rpc).toContain("v_candidate.estimated_cost_usd is not null");
  });

  it("binds evidence age to the attested capture and digest time to candidate recognition", () => {
    const rpc = functionBody(migration, "create or replace function public.publish_shared_award_initial_document_event");
    expect(rpc).toContain(
      "v_candidate.prompt_payload #>> '{first_observation_attestation,body,capture,captured_at}'",
    );
    expect(rpc).toContain(
      "v_first_observed_at := nullif(btrim(v_change_details ->> 'first_observed_at'), '')::timestamptz",
    );
    expect(rpc).toContain(
      "v_detected_at := nullif(btrim(p_event ->> 'detected_at'), '')::timestamptz",
    );
    expect(rpc).toContain(
      "v_recognized_at := nullif(btrim(v_change_details ->> 'recognized_at'), '')::timestamptz",
    );
    expect(rpc).toContain(
      "v_generated_at := nullif(btrim(v_change_details ->> 'generated_at'), '')::timestamptz",
    );
    expect(rpc).toContain("v_first_observed_at is distinct from v_attested_capture_at");
    expect(rpc).toContain("v_detected_at is distinct from v_candidate.created_at");
    expect(rpc).toContain("v_recognized_at is distinct from v_candidate.created_at");
    expect(rpc).toContain("v_generated_at is distinct from v_candidate.created_at");
    expect(rpc).toContain("v_existing_event.detected_at is distinct from v_candidate.created_at");
    expect(rpc).not.toContain(
      "coalesce(nullif(p_event ->> 'detected_at', '')::timestamptz, now())",
    );
  });

  it("keeps first-observation evidence failures in a distinct durable operator quarantine", () => {
    expect(migration).toContain("'initial_document'");
    expect(migration).toContain("category in ('public_page', 'visual_review', 'initial_document')");
    const recordRpc = functionBody(
      migration,
      "create or replace function public.record_initial_official_document_quarantine",
    );
    expect(recordRpc).toContain("shared_award_source_acquisitions");
    expect(recordRpc).toContain("'automatic_local_evidence_retry'");
    expect(recordRpc).toContain("'automatic_zero_charge_publication_retry'");
    expect(recordRpc).toContain("'manual_candidate_evidence_repair'");
    expect(recordRpc).toContain("'candidate_artifact_recovery'");
    expect(recordRpc).toContain("'permanent_evidence_preparation'");
    expect(recordRpc).toContain("v_failure_stage = 'publication_persistence'");
    expect(recordRpc).toContain("retry the retained candidate automatically without charge");
    expect(recordRpc).toContain("then 'manual_candidate_evidence_repair'");
    expect(recordRpc).toContain("do not overwrite conflicting bytes");
    expect(recordRpc).toContain("p_evidence || jsonb_build_object('failure_stage', v_failure_stage)");
    expect(recordRpc).toContain("retry_mode = excluded.retry_mode");
    expect(recordRpc).toContain("'none'");
    expect(recordRpc).toContain("public.manual_quarantine_evidence_hash(v_evidence)");
    expect(recordRpc).toContain("public.refresh_manual_quarantine_registry_state(v_now)");
    const resolveRpc = functionBody(
      migration,
      "create or replace function public.resolve_initial_official_document_quarantine",
    );
    expect(resolveRpc).toContain("candidate.candidate_scope = 'initial_official_document'");
    expect(resolveRpc).toContain("candidate.status in ('succeeded', 'published')");
    expect(resolveRpc).toContain("candidate.status = 'published'");
    expect(resolveRpc).toContain("candidate.rejection_reason is null");
    expect(resolveRpc).toContain("not like 'actionable_%'");
    expect(resolveRpc).toContain("registry.evidence #>> '{failure,details,failure_stage}'");
    expect(resolveRpc).toContain("= 'capture_evidence'");
    expect(resolveRpc).toContain("status = 'resolved'");
  });

  it("does not replace the normal changed-content publication RPC", () => {
    expect(migration).not.toContain(
      "create or replace function public.publish_shared_award_change_event_with_evidence",
    );
    expect(migration).toContain(
      "grant execute on function public.publish_shared_award_initial_document_event(jsonb, jsonb)",
    );
    expect(migration).toContain(
      "grant execute on function public.register_shared_award_source_from_intake(jsonb, jsonb)",
    );
  });
});

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing ${signature}`);
  const end = source.indexOf("\n$$;", start);
  if (end < 0) throw new Error(`Missing function terminator for ${signature}`);
  return source.slice(start, end + 4);
}
