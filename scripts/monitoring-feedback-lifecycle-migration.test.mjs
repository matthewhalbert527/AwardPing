import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260714193730_fix_monitoring_feedback_lifecycle.sql",
    import.meta.url,
  ),
  "utf8",
);

const falsePositiveFunction = migration.slice(
  migration.indexOf("create function public.record_monitoring_false_positive("),
  migration.indexOf(
    "revoke execute on function public.record_monitoring_false_positive(",
  ),
);

const promotionFunction = migration.slice(
  migration.indexOf(
    "create or replace function public.record_monitoring_feedback_promotion(",
  ),
  migration.indexOf(
    "revoke execute on function public.record_monitoring_feedback_promotion(",
  ),
);

describe("monitoring feedback lifecycle migration", () => {
  it("exposes the pending anti-join only to the service role", () => {
    expect(migration).toContain(
      "create or replace function public.list_pending_monitoring_feedback(",
    );
    expect(migration).toContain(
      "and not exists (\n        select 1\n        from public.monitoring_feedback_promotions promotion",
    );
    expect(migration).toContain(
      "revoke execute on function public.list_pending_monitoring_feedback(integer)\n  from public, anon, authenticated;",
    );
    expect(migration).toContain(
      "grant execute on function public.list_pending_monitoring_feedback(integer)\n  to service_role;",
    );
  });

  it("compares every normalized false-positive input on an idempotent replay", () => {
    for (const comparison of [
      "v_existing.event_id is distinct from p_event_id",
      "v_existing.actor_user_id is distinct from p_actor_user_id",
      "v_existing.actor_email is distinct from v_actor_email",
      "v_existing.reason_code is distinct from v_reason_code",
      "v_existing.note is distinct from v_note",
      "v_existing.requested_scope is distinct from v_requested_scope",
      "v_existing.policy_rule_id is distinct from v_policy_rule_id",
      "v_existing.policy_identity is distinct from v_policy_identity",
      "v_existing.policy_version is distinct from v_policy_version",
      "v_existing.policy_hash is distinct from v_policy_hash",
      "v_existing.policy_config_version is distinct from p_policy_config_version",
      "v_existing.decision_memory_version is distinct from p_decision_memory_version",
      "v_existing.promotion_status is distinct from v_promotion_status",
    ]) {
      expect(falsePositiveFunction, comparison).toContain(comparison);
    }

    expect(falsePositiveFunction).toContain("when unique_violation then");
    expect(falsePositiveFunction).toContain(
      "where feedback.request_id = p_request_id;",
    );
  });

  it("preserves an existing suppression while still appending the feedback", () => {
    expect(falsePositiveFunction).toContain("if v_suppressed_at is null then");
    expect(falsePositiveFunction).not.toContain(
      "monitoring event is already suppressed",
    );
    expect(falsePositiveFunction.indexOf("if v_suppressed_at is null then")).toBeLessThan(
      falsePositiveFunction.indexOf("insert into public.monitoring_feedback"),
    );
  });

  it("captures immutable event evidence while the change event is locked", () => {
    for (const column of [
      "event_summary text",
      "event_source_url text",
      "event_source_title text",
      "event_source_page_type text",
      "event_detected_at timestamptz",
      "event_evidence jsonb not null default '{}'::jsonb",
    ]) {
      expect(migration, column).toContain(column);
    }

    for (const evidenceField of [
      "'reader_summary', change_event.change_details -> 'reader_summary'",
      "'exact_before', change_event.change_details -> 'exact_before'",
      "'exact_after', change_event.change_details -> 'exact_after'",
      "'structured_diff', change_event.change_details -> 'structured_diff'",
      "'quality_flags', change_event.change_details -> 'quality_flags'",
      "'snapshot', jsonb_strip_nulls(",
    ]) {
      expect(falsePositiveFunction, evidenceField).toContain(evidenceField);
    }

    const lockedRead = falsePositiveFunction.indexOf(
      "from public.shared_award_change_events change_event",
    );
    expect(lockedRead).toBeGreaterThan(-1);
    expect(falsePositiveFunction.indexOf("for update;", lockedRead)).toBeGreaterThan(
      lockedRead,
    );
    expect(
      falsePositiveFunction.indexOf(
        "update public.shared_award_change_events",
        lockedRead,
      ),
    ).toBeGreaterThan(falsePositiveFunction.indexOf("for update;", lockedRead));
    expect(falsePositiveFunction).toContain("v_existing.event_evidence");
    expect(falsePositiveFunction).toContain("v_event_evidence");
  });

  it("returns captured evidence only through the service-role pending RPC", () => {
    for (const field of [
      "pending.event_summary",
      "pending.event_source_url",
      "pending.event_source_title",
      "pending.event_source_page_type",
      "pending.event_detected_at",
      "pending.event_evidence",
    ]) {
      expect(migration, field).toContain(field);
    }

    expect(migration).toContain(
      "revoke execute on function public.record_monitoring_false_positive(",
    );
    expect(migration).toContain(
      ") from public, anon, authenticated;\ngrant execute on function public.record_monitoring_false_positive(",
    );
  });

  it("handles both same-request retries and different-request promotion races", () => {
    for (const comparison of [
      "v_existing.feedback_id is distinct from p_feedback_id",
      "v_existing.actor_user_id is distinct from p_actor_user_id",
      "v_existing.actor_email is distinct from v_actor_email",
      "v_existing.policy_rule_id is distinct from v_policy_rule_id",
      "v_existing.policy_identity is distinct from v_policy_identity",
      "v_existing.policy_version is distinct from v_policy_version",
      "v_existing.policy_hash is distinct from v_policy_hash",
      "v_existing.policy_config_version is distinct from p_policy_config_version",
      "v_existing.decision_memory_version is distinct from p_decision_memory_version",
      "v_existing.note is distinct from v_note",
    ]) {
      expect(promotionFunction, comparison).toContain(comparison);
    }

    const uniqueHandler = promotionFunction.slice(
      promotionFunction.indexOf("when unique_violation then"),
    );
    expect(uniqueHandler).toContain("where promotion.request_id = p_request_id;");
    expect(uniqueHandler).toContain("where promotion.feedback_id = p_feedback_id");
    expect(uniqueHandler).toContain(
      "raise exception 'monitoring feedback is already promoted'\n            using errcode = 'P0001';",
    );
  });
});
