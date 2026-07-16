import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260715230000_verified_monitoring_feedback_promotion_workflow.sql",
    import.meta.url,
  ),
  "utf8",
);
const databaseTypes = readFileSync(
  new URL("../src/lib/database.types.ts", import.meta.url),
  "utf8",
);

const listFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.list_monitoring_feedback_promotion_clusters(",
  ),
  migration.indexOf(
    "create or replace function public.advance_monitoring_feedback_promotion_cluster(",
  ),
);
const advanceFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.advance_monitoring_feedback_promotion_cluster(",
  ),
  migration.indexOf(
    "revoke all on function private.monitoring_feedback_promotion_stage_ordinal",
  ),
);
const restartFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.restart_monitoring_feedback_promotion_cluster(",
  ),
  migration.indexOf(
    "create or replace function public.advance_monitoring_feedback_promotion_cluster(",
  ),
);
const workerFailureFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.record_monitoring_feedback_promotion_worker_failure(",
  ),
  migration.indexOf(
    "create or replace function public.apply_monitoring_feedback_promotion_sweep_event(",
  ),
);
const sweepApplyFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.apply_monitoring_feedback_promotion_sweep_event(",
  ),
  migration.indexOf(
    "create or replace function public.mark_monitoring_feedback_promotion_rollback_required(",
  ),
);
const sweepCheckpointFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.checkpoint_monitoring_feedback_promotion_sweep(",
  ),
  migration.indexOf(
    "create or replace function public.mark_monitoring_feedback_promotion_rollback_required(",
  ),
);
const clusterGuardFunction = migration.slice(
  migration.indexOf(
    "create or replace function private.protect_monitoring_feedback_promotion_cluster()",
  ),
  migration.indexOf(
    "drop trigger if exists monitoring_feedback_promotion_clusters_guard",
  ),
);

const stages = [
  "triaged",
  "similar_feedback_clustered",
  "rule_drafted",
  "historical_shadow_test",
  "regression_tests_pass",
  "app_worker_hashes_match",
  "six_pm_canary",
  "retroactive_sweep",
  "resolved",
];

describe("verified monitoring feedback promotion workflow migration", () => {
  it("parenthesizes the late-evidence CASE expression for the PL/pgSQL parser", () => {
    expect(clusterGuardFunction).toContain(
      "new.activation_status is distinct from (case",
    );
    expect(clusterGuardFunction).toContain(
      "else 'blocked_late_evidence'\n        end)",
    );
    expect(clusterGuardFunction).not.toContain(
      "new.activation_status is distinct from case",
    );
  });

  it("keeps immediate suppression intact while removing the one-click promotion bypass", () => {
    expect(migration).not.toContain(
      "create or replace function public.record_monitoring_false_positive(",
    );
    expect(migration).toContain(
      "revoke execute on function public.record_monitoring_feedback_promotion(",
    );
    expect(migration).toContain(
      ") from public, anon, authenticated, service_role;",
    );
    expect(migration).toContain(
      "revoke insert, update, delete on table public.monitoring_feedback_promotions\n  from service_role;",
    );
  });

  it("defines the exact nine completed-stage IDs and a strict next-stage mapping", () => {
    for (const stage of stages) {
      expect(migration, stage).toContain(`'${stage}'`);
      expect(databaseTypes, stage).toContain(`| \"${stage}\"`);
    }

    for (let index = 0; index < stages.length - 1; index += 1) {
      expect(migration).toContain(
        `when '${stages[index]}' then '${stages[index + 1]}'`,
      );
    }
    expect(advanceFunction).toContain(
      "v_to_stage is distinct from v_expected_stage",
    );
    expect(advanceFunction).toContain(
      "promotion stages must advance sequentially",
    );
  });

  it("clusters deterministically by normalized pattern evidence, domain template, and reason", () => {
    expect(migration).toContain(
      "private.monitoring_feedback_pattern_signature(\n        feedback.event_evidence,\n        feedback.event_summary",
    );
    expect(migration).toContain("'mode', 'canonical_policy_noise'");
    expect(migration).toContain("'mode', 'normalized_evidence_fallback'");
    expect(migration).toContain(
      "private.monitoring_feedback_domain_template(\n        feedback.event_source_url,\n        feedback.event_source_page_type",
    );
    expect(migration).toContain(
      "pg_catalog.jsonb_build_array(\n          unresolved.evidence_signature,\n          unresolved.domain_template,\n          unresolved.reason_code",
    );
    expect(migration).toContain(
      "create unique index monitoring_feedback_promotion_clusters_unresolved_key_idx\n  on public.monitoring_feedback_promotion_clusters (cluster_key)\n  where resolved_at is null;",
    );
    expect(migration).toContain("on conflict (feedback_id) do nothing");
    expect(migration).toContain(
      "'visual_occurrence_signature', classified.visual_occurrence_signature",
    );
  });

  it("groups different occurrences of one evidence pattern but separates a different pattern", () => {
    const first = modeledClusterKey({
      occurrenceHash: "a".repeat(64),
      classification: "navigation timestamp churn",
      noiseFlags: ["relative_age_only"],
    });
    const second = modeledClusterKey({
      occurrenceHash: "b".repeat(64),
      classification: "navigation timestamp churn",
      noiseFlags: ["relative_age_only"],
    });
    const different = modeledClusterKey({
      occurrenceHash: "c".repeat(64),
      classification: "applicant fact change",
      noiseFlags: ["deadline_changed"],
    });

    expect(first).toBe(second);
    expect(first).not.toBe(different);
  });

  it("keeps cluster membership and every accepted or rejected attempt append-only", () => {
    expect(migration).toContain(
      "monitoring_feedback_promotion_cluster_members_append_only",
    );
    expect(migration).toContain(
      "monitoring_feedback_promotion_transitions_append_only",
    );
    expect(migration).toContain(
      "for each row execute function private.prevent_monitoring_feedback_mutation();",
    );
    expect(migration).toContain(
      "transition_kind = 'stage_attempt'",
    );
    expect(migration).toContain("not accepted");
    expect(migration).toContain("and resulting_stage = from_stage");
    expect(migration).toContain("transition_kind = 'evidence_restart'");
    expect(migration).toContain("'event', 'feedback_evidence_changed'");
  });

  it("retains append-only many-to-many candidate observations for exact worker runs", () => {
    expect(migration).toContain(
      "create table if not exists public.shared_award_visual_review_candidate_run_observations (",
    );
    expect(migration).toContain("primary key (run_id, candidate_id)");
    expect(migration).toContain(
      "references public.local_worker_runs(id) on delete restrict",
    );
    expect(migration).toContain(
      "references public.shared_award_visual_review_candidates(id) on delete restrict",
    );
    expect(migration).toContain(
      "visual_review_candidate_run_observations_append_only",
    );
    expect(migration).toContain(
      "grant select, insert\n  on table public.shared_award_visual_review_candidate_run_observations\n  to service_role;",
    );
    expect(databaseTypes).toContain(
      "shared_award_visual_review_candidate_run_observations: {",
    );
  });

  it("exposes recurrence, source, sample, stage, and collision evidence only through the service-role list RPC", () => {
    for (const field of [
      "recurrence_count bigint",
      "source_count bigint",
      "sample_evidence jsonb",
      "stage_artifacts jsonb",
      "legitimate_collision_count bigint",
      "legitimate_collisions jsonb",
      "latest_attempt_created_at timestamptz",
      "latest_attempt_evidence jsonb",
      "latest_blocking_transition_kind text",
      "latest_blocking_transition_created_at timestamptz",
      "latest_blocking_transition_evidence jsonb",
    ]) {
      expect(listFunction, field).toContain(field);
    }
    expect(listFunction).toContain("limit 3");
    expect(listFunction).toContain(
      "transition.requested_stage = 'historical_shadow_test'",
    );
    expect(listFunction).toContain("'activation_rollback_required'");
    expect(listFunction).toContain("latest_blocker.transition_kind");
    expect(migration).toContain(
      "revoke execute on function public.list_monitoring_feedback_promotion_clusters(integer, boolean)\n  from public, anon, authenticated;",
    );
    expect(migration).toContain(
      "grant execute on function public.list_monitoring_feedback_promotion_clusters(integer, boolean)\n  to service_role;",
    );
    expect(migration).toContain(
      "grant execute on function public.get_monitoring_feedback_promotion_cluster(uuid)\n  to service_role;",
    );
    expect(migration).toContain(
      "grant execute on function public.list_monitoring_feedback_promotion_cluster_evidence(uuid)\n  to service_role;",
    );
    expect(migration).toContain("visual_occurrence_signature text");
    expect(migration).toContain("pg_catalog.to_jsonb(feedback)");
    expect(migration).toContain("pg_catalog.to_jsonb(change_event)");
  });

  it("gives the worker a service-only queue that cannot be starved by manual stages", () => {
    const queueFunction = migration.slice(
      migration.indexOf(
        "create or replace function public.list_monitoring_feedback_promotion_worker_queue(",
      ),
      migration.indexOf(
        "create or replace function public.get_monitoring_feedback_promotion_cluster(",
      ),
    );

    for (const stage of [
      "rule_drafted",
      "historical_shadow_test",
      "regression_tests_pass",
      "app_worker_hashes_match",
      "six_pm_canary",
      "retroactive_sweep",
    ]) {
      expect(queueFunction, stage).toContain(`'${stage}'`);
    }
    for (const manualStage of [
      "triaged",
      "similar_feedback_clustered",
      "resolved",
    ]) {
      expect(queueFunction, manualStage).not.toContain(`'${manualStage}'`);
    }
    expect(queueFunction).toContain(
      "left join public.monitoring_feedback_promotion_worker_leases lease",
    );
    expect(queueFunction).toContain(
      "coalesce(lease.last_polled_at, '-infinity'::timestamptz)",
    );
    expect(queueFunction).toContain("for update of cluster skip locked");
    expect(queueFunction).toContain("on conflict (cluster_id) do update");
    expect(queueFunction).toContain(
      "cluster.current_stage <> 'retroactive_sweep'",
    );
    expect(queueFunction).toContain(
      "cluster.activation_status in (\n          'blocked_late_evidence',\n          'rollback_required',\n          'sweep_completed'",
    );
    expect(queueFunction).toContain("pg_catalog.least(coalesce(p_limit, 100), 500)");
    expect(migration).toContain(
      "revoke execute on function public.list_monitoring_feedback_promotion_worker_queue(integer)\n  from public, anon, authenticated;",
    );
    expect(migration).toContain(
      "grant execute on function public.list_monitoring_feedback_promotion_worker_queue(integer)\n  to service_role;",
    );
    expect(databaseTypes).toContain(
      "list_monitoring_feedback_promotion_worker_queue: {",
    );
  });

  it("records unexpected worker failures durably without advancing the cluster", () => {
    expect(workerFailureFunction).toContain("security definer\nset search_path = ''");
    expect(workerFailureFunction).toContain(
      "p_expected_evidence_revision is distinct from v_cluster.evidence_revision",
    );
    expect(workerFailureFunction).toContain(
      "v_cluster.current_stage is distinct from v_expected_current_stage",
    );
    expect(workerFailureFunction).toContain(
      "v_failure_stage is distinct from v_expected_failure_stage",
    );
    expect(workerFailureFunction).toContain("'monitoring-promotion-worker-failure-v1'");
    expect(workerFailureFunction).toContain("v_evidence ->> 'safe_action'");
    expect(workerFailureFunction).toContain(
      "private.monitoring_feedback_canonical_json(v_evidence - 'digest')",
    );
    expect(workerFailureFunction).toContain("false,\n    'stage_attempt'");
    expect(workerFailureFunction).toContain(
      "request ID was already used for a different worker failure",
    );
    expect(migration).toContain(
      "grant execute on function public.record_monitoring_feedback_promotion_worker_failure(",
    );
    expect(databaseTypes).toContain(
      "record_monitoring_feedback_promotion_worker_failure: {",
    );
  });

  it("refuses to reattribute a legacy logically suppressed event", () => {
    expect(sweepApplyFunction).toContain(
      "v_event.change_details ->> 'suppressed_at'",
    );
    expect(sweepApplyFunction).toContain(
      "v_event.change_details ->> 'suppression_reason'",
    );
    expect(sweepApplyFunction).toContain(
      "sweep event is already logically suppressed by retained legacy evidence",
    );
  });

  it("uses database mutation and durable checkpoint time for the sweep boundary", () => {
    const retroactiveGate = advanceFunction.slice(
      advanceFunction.indexOf("elsif v_to_stage = 'retroactive_sweep' then"),
      advanceFunction.indexOf("elsif v_to_stage = 'resolved' then"),
    );
    expect(sweepApplyFunction).toContain("mutation_at timestamptz");
    expect(sweepApplyFunction).toContain(
      "suppressed_at = pg_catalog.clock_timestamp()",
    );
    expect(sweepApplyFunction).toContain(
      "guarded promotion suppression timestamps are assigned by the database",
    );
    expect(sweepCheckpointFunction).toContain("for update;");
    expect(sweepCheckpointFunction).toContain(
      "insert into public.monitoring_policy_sweep_state",
    );
    expect(sweepCheckpointFunction).toContain("p_not_before + interval '1 microsecond'");
    expect(sweepCheckpointFunction).toContain(
      "v_previous_checkpoint_at + interval '1 microsecond'",
    );
    expect(sweepCheckpointFunction).toContain(
      "v_last_mutation_at + interval '1 microsecond'",
    );
    expect(sweepCheckpointFunction).toContain(
      "pg_catalog.max(change_event.suppressed_at)",
    );
    expect(sweepCheckpointFunction).toContain(
      "'verified-promotion:' || v_cluster.id::text",
    );
    expect(sweepCheckpointFunction).toContain("updated_at = excluded.updated_at");
    expect(sweepCheckpointFunction).toContain("v_checkpoint_at");
    expect(retroactiveGate).toContain(
      "select pg_catalog.max(change_event.suppressed_at)\n    into v_live_sweep_mutation_at",
    );
    expect(retroactiveGate).toContain(
      "v_live_sweep_mutation_at is distinct from\n        nullif(",
    );
    expect(retroactiveGate).toContain(
      "The final sweep report does not match the latest database mutation.",
    );
    expect(migration).toContain(
      "grant execute on function public.checkpoint_monitoring_feedback_promotion_sweep(",
    );
    expect(databaseTypes).toContain(
      "checkpoint_monitoring_feedback_promotion_sweep: {",
    );
    expect(databaseTypes).toContain("mutation_at: string;");
  });

  it("serializes request IDs and rejects an idempotency key reused with different evidence", () => {
    expect(advanceFunction).toContain(
      "pg_catalog.pg_advisory_xact_lock(\n    pg_catalog.hashtextextended(p_request_id::text, 0)",
    );
    for (const comparison of [
      "v_existing.cluster_id is distinct from p_cluster_id",
      "v_existing.requested_stage is distinct from v_to_stage",
      "v_existing.actor_user_id is distinct from p_actor_user_id",
      "v_existing.policy_rule_id is distinct from v_rule_id",
      "v_existing.policy_hash is distinct from v_policy_hash",
      "v_existing.evidence is distinct from v_evidence",
      "v_existing.evidence_revision is distinct from p_expected_evidence_revision",
    ]) {
      expect(advanceFunction, comparison).toContain(comparison);
    }
  });

  it("absorbs late recurrence into one unresolved cluster and restarts stale gates append-only", () => {
    expect(migration).toContain(
      "where cluster.cluster_key = v_item.cluster_key\n      and cluster.resolved_at is null\n    for update;",
    );
    expect(migration).toContain("evidence_revision = v_cluster.evidence_revision + 1");
    expect(migration).toContain("then 'similar_feedback_clustered'");
    expect(migration).toContain("stage_artifacts = case");
    expect(migration).toContain("'evidence_restart'");
    expect(migration).toContain("'previous_evidence_revision', v_cluster.evidence_revision");
    expect(migration).toContain("and transition.evidence_revision = v_cluster.evidence_revision");
  });

  it("rejects stale advancement while preserving exact request replay", () => {
    expect(advanceFunction).toContain("p_expected_evidence_revision bigint");
    expect(advanceFunction).toContain(
      "if p_expected_evidence_revision is distinct from v_cluster.evidence_revision then",
    );
    expect(advanceFunction).toContain("promotion evidence revision is stale");
    expect(advanceFunction.indexOf("if found then")).toBeLessThan(
      advanceFunction.indexOf(
        "if p_expected_evidence_revision is distinct from v_cluster.evidence_revision then",
      ),
    );
  });

  it("allows only an idempotent audited operator restart after the latest preactivation gate failed", () => {
    expect(restartFunction).toContain("p_expected_evidence_revision bigint");
    expect(restartFunction).toContain("transition.transition_kind = 'stage_attempt'");
    expect(restartFunction).toContain("or v_failed.accepted");
    expect(restartFunction).toContain(
      "v_failed.from_stage is distinct from v_cluster.current_stage",
    );
    expect(restartFunction).toContain("'operator_restart'");
    expect(restartFunction).toContain("current_stage = 'similar_feedback_clustered'");
    expect(restartFunction).toContain("proposed_rule_id = null");
    expect(restartFunction).toContain("stage_artifacts = cluster.stage_artifacts - array[");
    expect(restartFunction).not.toContain("'resolved' then");
    expect(migration).toContain("transition_kind = 'operator_restart'");
    expect(migration).toContain(
      "grant execute on function public.restart_monitoring_feedback_promotion_cluster(",
    );
  });

  it("cryptographically verifies draft and sealed report digests", () => {
    expect(migration).toContain(
      "create or replace function private.monitoring_feedback_canonical_json(",
    );
    expect(migration).toContain(
      "private.monitoring_feedback_canonical_json(p_value - 'digest')",
    );
    expect(advanceFunction).toContain(
      "private.monitoring_feedback_canonical_json(v_evidence -> 'rule')",
    );
  });

  it("permits only persistent alert-blocking candidates that reach Batch prompts", () => {
    const draftGate = advanceFunction.slice(
      advanceFunction.indexOf("elsif v_to_stage = 'rule_drafted' then"),
      advanceFunction.indexOf(
        "elsif v_to_stage = 'historical_shadow_test' then",
      ),
    );

    expect(draftGate).toContain("'alert_blocking'");
    expect(draftGate).toContain("'persistent'");
    expect(draftGate).toContain(
      "pg_catalog.jsonb_typeof(v_evidence #> '{rule,prompt}')",
    );
    expect(draftGate).toContain("#>> '{rule,prompt}'");
    expect(draftGate).toContain("#> '{rule,prompt_scopes}'");
    expect(draftGate).toContain("? 'visual_review_batch'");
    expect(draftGate).toContain("'{rule,promotion_test_mode}'");
    expect(draftGate).toContain("'{rule,matcher_digest}'");
  });

  it("stores failed verification artifacts without advancing the completed stage", () => {
    const failedInsert = advanceFunction.slice(
      advanceFunction.indexOf("if v_failure is not null then"),
      advanceFunction.indexOf("if v_to_stage = 'resolved' then", advanceFunction.indexOf("if v_failure is not null then")),
    );
    expect(failedInsert).toContain("v_cluster.current_stage,");
    expect(failedInsert).toContain("false,");
    expect(failedInsert).toContain("v_cluster.evidence_revision,");
    expect(failedInsert).toContain("v_failure");
    expect(failedInsert).toContain("v_evidence");
    expect(failedInsert).toContain("false,\n      false,\n      v_failure,\n      0,\n      v_recurrence_count");
  });

  it("requires a zero-collision historical shadow pass that covers every distinct cluster event", () => {
    const shadowGate = advanceFunction.slice(
      advanceFunction.indexOf("elsif v_to_stage = 'historical_shadow_test' then"),
      advanceFunction.indexOf("elsif v_to_stage = 'regression_tests_pass' then"),
    );
    expect(shadowGate).toContain("'monitoring-promotion-shadow-v1'");
    expect(shadowGate).toContain("'history_complete'");
    expect(shadowGate).toContain("'rule_active'");
    expect(shadowGate).toContain("'feedback_event_count'");
    expect(shadowGate).toContain("v_evidence -> 'feedback_event_ids' is distinct from");
    expect(shadowGate).toContain("'recurrence_matches'");
    expect(shadowGate).toContain(
      "v_evidence -> 'matched_feedback_event_ids' is distinct from",
    );
    expect(shadowGate).toContain("is distinct from v_distinct_event_count");
    expect(advanceFunction).toContain(
      "pg_catalog.count(distinct feedback.event_id)::bigint",
    );
    expect(advanceFunction).toContain(
      "into v_recurrence_count, v_distinct_event_count, v_source_count",
    );
    expect(shadowGate).toContain("'legitimate_updates_suppressed'");
    expect(shadowGate).toContain("v_evidence -> 'legitimate_updates'");
    expect(shadowGate).toContain("v_collision_count is distinct from v_collision_array_count");
    expect(shadowGate).toContain("elsif v_collision_count <> 0 then");
  });

  it("requires inactive draft-bound regressions and exact app/worker revision and policy hashes", () => {
    const regressionGate = advanceFunction.slice(
      advanceFunction.indexOf("elsif v_to_stage = 'regression_tests_pass' then"),
      advanceFunction.indexOf("elsif v_to_stage = 'app_worker_hashes_match' then"),
    );
    expect(advanceFunction).toContain("'monitoring-promotion-regression-v1'");
    expect(advanceFunction).toContain("'positive_fixture_count'");
    expect(advanceFunction).toContain("'negative_fixture_count'");
    expect(advanceFunction).toContain("'failure_count'");
    expect(advanceFunction).toContain(
      "v_evidence ->> 'app_revision' is distinct from v_evidence ->> 'worker_revision'",
    );
    expect(advanceFunction).toContain(
      "v_evidence ->> 'app_policy_hash' is distinct from\n        v_evidence ->> 'worker_policy_hash'",
    );
    expect(advanceFunction).toContain(
      "v_evidence ->> 'app_batch_policy_hash' is distinct from\n        v_evidence ->> 'worker_batch_policy_hash'",
    );
    expect(advanceFunction).toContain(
      "v_evidence ->> 'app_suppression_policy_hash' is distinct from\n        v_evidence ->> 'worker_suppression_policy_hash'",
    );
    expect(advanceFunction).toContain("is distinct from 5::bigint");
    expect(advanceFunction).toContain("pg_catalog.lower(v_evidence ->> 'app_revision') = 'unavailable'");
    expect(advanceFunction).toContain("'app_matcher_digest'");
    expect(advanceFunction).toContain("'worker_matcher_digest'");
    expect(advanceFunction).toContain("'{rule_drafted,rule,matcher_digest}'");
    expect(regressionGate).toContain(
      "v_evidence -> 'positive_fixture_event_ids' is distinct from",
    );
    expect(regressionGate).toContain(
      "v_regression_positive_ids is distinct from v_distinct_event_ids",
    );
    expect(regressionGate).toContain(
      "v_regression_positive_invalid_count <> 0",
    );
    expect(regressionGate).toContain(
      "not private.monitoring_feedback_json_boolean(\n              regression_item.value,\n              'matched'",
    );
  });

  it("requires the exact inactive three-shard 6 PM canary cohort", () => {
    const canaryGate = advanceFunction.slice(
      advanceFunction.indexOf("elsif v_to_stage = 'six_pm_canary' then"),
      advanceFunction.indexOf("elsif v_to_stage = 'retroactive_sweep' then"),
    );
    expect(canaryGate).toContain("'expected_shards'\n    ) is distinct from 3::bigint");
    expect(canaryGate).toContain("'observed_shards'\n      ) is distinct from 3::bigint");
    expect(canaryGate).toContain("'completed_shards'\n      ) is distinct from 3::bigint");
    expect(canaryGate).toContain("v_evidence ->> 'not_before' is distinct from v_hashes ->> 'completed_at'");
    expect(canaryGate).toContain("'visual-nightly:' || (v_evidence ->> 'monitoring_date')");
    expect(canaryGate).toContain("v_distinct_run_count is distinct from 3::bigint");
    expect(canaryGate).toContain("'expected_candidate_count'");
    expect(canaryGate).toContain("'bound_candidate_count'");
    expect(canaryGate).toContain("'candidate_status_counts'");
    expect(canaryGate).toContain("'candidate_terminal_failures'");
    expect(canaryGate).toContain("v_nonterminal_candidate_count <> 0::numeric");
    expect(canaryGate).toContain("v_candidate_status_total is distinct from");
    expect(canaryGate).toContain(
      "public.shared_award_visual_review_candidate_run_observations observation",
    );
    expect(canaryGate).toContain(
      "v_observation_count is distinct from v_expected_candidate_count",
    );
    expect(canaryGate).toContain(
      "v_published_candidate_count > v_bound_event_count::numeric",
    );
    expect(canaryGate).toContain("binding.value ->> 'worker_run_id'");
    expect(canaryGate).toContain("binding.value ->> 'candidate_id'");
    expect(canaryGate).toContain("v_invalid_binding_count <> 0");
    expect(canaryGate).toContain("v_evidence -> 'shard_indices' is distinct from '[0, 1, 2]'::jsonb");
    expect(canaryGate).toContain("'policy_hashes_match'");
    expect(canaryGate).toContain("v_evidence ->> 'full_hash' is distinct from v_hashes ->> 'app_policy_hash'");
    expect(canaryGate).toContain("left join public.local_worker_runs worker_run");
    expect(canaryGate).toContain("worker_run.status is distinct from 'succeeded'");
    expect(canaryGate).toContain("worker_run.failed_count <> 0");
    expect(canaryGate).toContain("'local-visual-snapshot-worker%'");
    expect(canaryGate).toContain("'{counts,visual_review_candidate_observations}'");
    expect(canaryGate).toContain("'{counts,visual_review_candidate_observation_failures}'");
    expect(canaryGate).toContain("'{counts,section_change_candidates_enqueued}'");
    expect(canaryGate).toContain("'expected_enqueued_count'");
    expect(canaryGate).toContain("v_canary_metadata_observation_count");
    expect(canaryGate).toContain("v_canary_metadata_enqueued_count");
  });

  it("gives each proposed rule one unresolved activation owner", () => {
    expect(migration).toContain(
      "create unique index if not exists monitoring_feedback_promotion_clusters_unresolved_rule_idx",
    );
    expect(migration).toContain(
      "on public.monitoring_feedback_promotion_clusters (proposed_rule_id)\n  where proposed_rule_id is not null and resolved_at is null;",
    );
    expect(advanceFunction).toContain(
      "pg_catalog.hashtextextended('monitoring-promotion-rule:' || v_rule_id, 0)",
    );
    expect(advanceFunction).toContain(
      "Another unresolved promotion cluster already owns this proposed rule ID.",
    );
  });

  it("excludes every unresolved candidate rule from the general sweep without pagination", () => {
    const exclusionFunction = migration.slice(
      migration.indexOf(
        "create or replace function public.list_unresolved_monitoring_feedback_promotion_rule_ids()",
      ),
      migration.indexOf(
        "create or replace function public.get_monitoring_feedback_promotion_cluster(",
      ),
    );
    expect(exclusionFunction).toContain("select distinct cluster.proposed_rule_id");
    expect(exclusionFunction).toContain("cluster.resolved_at is null");
    expect(exclusionFunction).not.toContain("limit ");
    expect(migration).toContain(
      "grant execute on function public.list_unresolved_monitoring_feedback_promotion_rule_ids()\n  to service_role;",
    );
  });

  it("hides stale gate failures after an audited restart or rollback", () => {
    expect(listFunction).toContain(
      "and transition.resulting_stage = selected.current_stage",
    );
    expect(listFunction).toContain(
      "reset_transition.transition_kind in (\n            'evidence_restart',\n            'operator_restart',\n            'activation_rollback'",
    );
    expect(listFunction).toContain(
      "(reset_transition.created_at, reset_transition.id) >",
    );
  });

  it("blocks a failed activation and reverses attributable suppressions in audited batches", () => {
    const markerFunction = migration.slice(
      migration.indexOf(
        "create or replace function public.mark_monitoring_feedback_promotion_rollback_required(",
      ),
      migration.indexOf(
        "create or replace function public.revert_monitoring_feedback_promotion_sweep_events(",
      ),
    );
    const reversalFunction = migration.slice(
      migration.indexOf(
        "create or replace function public.revert_monitoring_feedback_promotion_sweep_events(",
      ),
      migration.indexOf(
        "create or replace function public.rollback_monitoring_feedback_promotion_activation(",
      ),
    );
    const rollbackFunction = migration.slice(
      migration.indexOf(
        "create or replace function public.rollback_monitoring_feedback_promotion_activation(",
      ),
      migration.indexOf(
        "create or replace function public.restart_monitoring_feedback_promotion_cluster(",
      ),
    );

    expect(markerFunction).toContain("'activation_rollback_required'");
    expect(markerFunction).toContain("activation_status = 'rollback_required'");
    expect(reversalFunction).toContain("v_action_count > 500");
    expect(reversalFunction).toContain("v_request_payload_digest");
    expect(reversalFunction).toContain(
      "private.monitoring_feedback_canonical_json(p_event_actions)",
    );
    expect(reversalFunction).toContain("v_activation_cycle_id");
    expect(reversalFunction).toContain("'verified-promotion:' || v_cluster.id::text");
    expect(reversalFunction).toContain("'scheduled-downstream-policy-sweep'");
    expect(reversalFunction).toContain("'admin_feedback:' || v_feedback.reason_code");
    expect(reversalFunction).toContain("v_replacement_reason = v_target_reason");
    expect(reversalFunction).not.toContain("v_replacement_reason !~ '^policy_flag_.+'");
    expect(rollbackFunction).toContain("v_attributable_suppression_count <> 0");
    expect(rollbackFunction).toContain(
      "activation rollback is blocked by % attributable suppression rows",
    );
    expect(migration).toContain(
      "monitoring_feedback_promotion_sweep_reversal_append_only",
    );
    expect(migration).toContain(
      "unique (cluster_id, activation_cycle_id, event_id)",
    );
  });

  it("requires a complete sweep under a distinct, matching active deployment", () => {
    expect(advanceFunction).toContain("v_activation := v_evidence -> 'activation_attestation'");
    expect(advanceFunction).toContain("'active_rule_definition_hash'");
    expect(advanceFunction).toContain("#>> '{rule_drafted,draft_hash}'");
    expect(advanceFunction).toContain("Activation must produce distinct full, Batch, and suppression policy hashes.");
    expect(advanceFunction).toContain(
      "private.monitoring_feedback_json_boolean(v_evidence, 'cursor_complete')",
    );
    expect(advanceFunction).toContain("'error_count'\n    ) is distinct from 0::bigint");
    expect(advanceFunction).toContain("'sweep_run_id'");
    expect(advanceFunction).toContain(
      "v_evidence ->> 'checkpoint_at' is distinct from\n        v_evidence ->> 'completed_at'",
    );
    expect(advanceFunction).toContain(
      "from public.monitoring_policy_sweep_state sweep_state",
    );
    expect(advanceFunction).toContain(
      "sweep_state.updated_at =\n            (v_evidence ->> 'checkpoint_at')::timestamptz",
    );
    expect(advanceFunction).toContain(
      "private.monitoring_feedback_json_boolean(\n        v_evidence -> 'cursor',\n        'end_of_history'",
    );
    expect(advanceFunction).toContain(
      "pg_catalog.jsonb_typeof(\n        v_evidence #> '{cursor,detected_at}'\n      ) is distinct from 'null'",
    );
    expect(advanceFunction).toContain(
      "pg_catalog.jsonb_typeof(\n        v_evidence #> '{cursor,event_id}'\n      ) is distinct from 'null'",
    );
    expect(advanceFunction).toContain(
      "sweep_state.cursor_detected_at is null\n          and sweep_state.cursor_event_id is null",
    );
  });

  it("cannot resolve without all seven accepted gates and appends one existing promotion record per unresolved member", () => {
    const resolvedGate = advanceFunction.slice(
      advanceFunction.indexOf("elsif v_to_stage = 'resolved' then"),
      advanceFunction.indexOf("if v_failure is not null then"),
    );
    expect(resolvedGate).toContain("v_required_gate_count <> 7");
    expect(resolvedGate).toContain("'legitimate_updates_suppressed'");
    expect(resolvedGate).toContain(") is distinct from 0::bigint then");
    expect(resolvedGate).toContain("v_retro #>> '{activation_attestation,app_policy_hash}'");
    expect(resolvedGate).toContain(
      "private.monitoring_feedback_resolution_attestation_run_valid(",
    );
    expect(resolvedGate).toContain(
      "v_evidence ->> 'app_revision' is distinct from\n        v_evidence ->> 'worker_revision'",
    );
    expect(resolvedGate).toContain("v_evidence ->> 'app_matcher_digest'");
    expect(resolvedGate).toContain(
      "next successful matching hourly worker attestation completed after the retroactive sweep",
    );
    expect(advanceFunction).toContain(
      "insert into public.monitoring_feedback_promotions (",
    );
    expect(advanceFunction).toContain("promotion_cluster_id");
    expect(advanceFunction).toContain("promotion_transition_id");
    expect(advanceFunction).toContain(
      "get diagnostics v_inserted_count = row_count;",
    );
    expect(advanceFunction).toContain(
      "if v_inserted_count <> v_unresolved_count then",
    );
  });

  it("selects one immutable earliest matching post-sweep run for idempotent resolution", () => {
    const privateStart = migration.indexOf(
      "create or replace function private.find_monitoring_feedback_resolution_worker_run(",
    );
    const privateFinder = migration.slice(
      privateStart,
      migration.indexOf("create or replace function", privateStart + 40),
    );
    const publicStart = migration.indexOf(
      "create or replace function public.find_monitoring_feedback_resolution_worker_run(",
    );
    const publicFinder = migration.slice(
      publicStart,
      migration.indexOf("create or replace function", publicStart + 40),
    );
    expect(privateStart).toBeGreaterThan(-1);
    expect(publicStart).toBeGreaterThan(-1);
    expect(privateFinder).toContain("worker_run.finished_at > p_not_before");
    expect(privateFinder).toContain("worker_run.failed_count = 0");
    expect(privateFinder).not.toContain("'local-visual-snapshot-worker%'");
    expect(privateFinder).toContain("'local-monitoring-feedback-promotion-worker'");
    expect(privateFinder).toContain(
      "'monitoring_feedback_promotion_resolution_attestation'",
    );
    expect(privateFinder).toContain("metadata ->> 'report_schema_version' = '1'");
    expect(privateFinder).toContain(
      "metadata ->> 'attestation_source' =\n      'hourly_downstream_queue'",
    );
    expect(privateFinder).toContain("metadata ->> 'api_charge' = 'false'");
    expect(privateFinder).toContain("worker_run.ai_provider is null");
    expect(privateFinder).toContain("metadata ->> 'cluster_id' = p_cluster_id::text");
    expect(privateFinder).toContain("metadata ->> 'sweep_completed_at'");
    expect(privateFinder).toContain(
      "order by worker_run.finished_at asc, worker_run.id asc\n  limit 1;",
    );
    expect(publicFinder).toContain(
      "{retroactive_sweep,activation_attestation,worker_revision}",
    );
    expect(publicFinder).toContain(
      "from private.find_monitoring_feedback_resolution_worker_run(",
    );
    expect(migration).toContain(
      "revoke all on function private.find_monitoring_feedback_resolution_worker_run(",
    );
    expect(migration).toContain(
      "create index if not exists local_worker_runs_promotion_resolution_lookup_idx",
    );
    expect(migration).toContain("(metadata ->> 'sweep_completed_at')");
  });

  it("replays a lost accepted resolution only for the original request, actor, revision, and rule", () => {
    const start = migration.indexOf(
      "create or replace function public.replay_monitoring_feedback_promotion_resolution(",
    );
    const replay = migration.slice(
      start,
      migration.indexOf("create or replace function", start + 40),
    );
    expect(start).toBeGreaterThan(-1);
    expect(replay).toContain("transition.request_id = p_request_id");
    expect(replay).toContain("v_transition.cluster_id is distinct from p_cluster_id");
    expect(replay).toContain("v_transition.actor_user_id is distinct from p_actor_user_id");
    expect(replay).toContain("v_transition.policy_rule_id is distinct from p_policy_rule_id");
    expect(replay).toContain("v_cluster.current_stage <> 'resolved'");
    expect(replay).toContain("v_transition.requested_stage <> 'resolved'");
    expect(replay).not.toContain("monitoring_feedback_worker_attestation_runs_valid");
    expect(replay).toContain("recurrence_count bigint");
  });

  it("declares every guarded RPC contract in the generated application types", () => {
    expect(databaseTypes).toContain(
      "list_monitoring_feedback_promotion_clusters: {",
    );
    expect(databaseTypes).toContain(
      "advance_monitoring_feedback_promotion_cluster: {",
    );
    expect(databaseTypes).toContain(
      "get_monitoring_feedback_promotion_cluster: {",
    );
    expect(databaseTypes).toContain(
      "find_monitoring_feedback_resolution_worker_run: {",
    );
    expect(databaseTypes).toContain(
      "replay_monitoring_feedback_promotion_resolution: {",
    );
    expect(databaseTypes).toContain(
      "list_monitoring_feedback_promotion_cluster_evidence: {",
    );
    expect(databaseTypes).toContain(
      "latest_attempt_stage: MonitoringFeedbackPromotionStage | null;",
    );
    expect(databaseTypes).toContain("latest_attempt_created_at: string | null;");
    expect(databaseTypes).toContain(
      "latest_blocking_transition_evidence: Json | null;",
    );
    expect(databaseTypes).toContain("resolution_ready: boolean;");
    expect(databaseTypes).toContain(
      "restart_monitoring_feedback_promotion_cluster: {",
    );
    for (const transitionKind of [
      "stage_attempt",
      "evidence_restart",
      "operator_restart",
      "activation_drift",
      "activation_rollback_required",
      "activation_rollback",
    ]) {
      expect(databaseTypes).toContain(`| "${transitionKind}"`);
    }
    expect(databaseTypes).toContain(
      "mark_monitoring_feedback_promotion_rollback_required: {",
    );
    expect(databaseTypes).toContain(
      "revert_monitoring_feedback_promotion_sweep_events: {",
    );
    expect(databaseTypes).toContain(
      "list_unresolved_monitoring_feedback_promotion_rule_ids: {",
    );
    expect(databaseTypes).toContain(
      "monitoring_feedback_promotion_sweep_reversal_audit: {",
    );
    expect(databaseTypes).toContain("p_expected_evidence_revision: number;");
    expect(databaseTypes).toContain("current_evidence_revision: number;");
    expect(databaseTypes).toContain("evidence_revision: number;");
    expect(databaseTypes).toContain("promotion_cluster_id: string | null;");
    expect(databaseTypes).toContain("promotion_transition_id: string | null;");
  });
});

function modeledClusterKey({ occurrenceHash, classification, noiseFlags }) {
  const evidenceSignature = sha256(
    canonicalJson({
      schema: "monitoring-feedback-pattern-v1",
      mode: "canonical_policy_noise",
      classification: normalizePatternText(classification),
      noise_flags: [...new Set(noiseFlags.map(normalizePatternText))].sort(),
      deterministic_shape: patternShape({
        candidate_scope: "page",
        previous_hash: occurrenceHash,
        current_hash: occurrenceHash.split("").reverse().join(""),
      }),
      page_type: "overview",
    }),
  );
  return sha256(canonicalJson([evidenceSignature, "example.edu/awards/:id|overview", "content_churn"]));
}

function normalizePatternText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/[^\s"<>]+/gi, "<url>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/[0-9a-f]{32,}/gi, "<hash>")
    .replace(/[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}/g, "<date>")
    .replace(/[0-9]+(?:[.,][0-9]+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

function patternShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) =>
        !["snapshot", "monitoring_policy", "monitoring_policy_bundle"].includes(key) &&
        !/(^id$|_id$|_ids$|hash|url|uri|object_key|_path$|_ref$|captured_at$|detected_at$|created_at$|updated_at$)/.test(key),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [
        key,
        item && typeof item === "object" && !Array.isArray(item)
          ? patternShape(item)
          : Array.isArray(item)
            ? "array"
            : item === null
              ? "null"
              : typeof item,
      ]),
  );
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
