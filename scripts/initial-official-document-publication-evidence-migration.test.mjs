import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationName = "20260716174800_fix_initial_document_publication_evidence_contract.sql";
const migration = readFileSync(
  new URL(`../supabase/migrations/${migrationName}`, import.meta.url),
  "utf8",
);
const evidenceBuilder = readFileSync(
  new URL("./lib/visual-event-evidence.mjs", import.meta.url),
  "utf8",
);
const baseMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260716150000_initial_official_document_events.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("initial-document publication evidence repair migration", () => {
  it("sorts after the rejected-candidate recovery migration", () => {
    expect(migrationName.localeCompare(
      "20260716171409_recover_rejected_initial_document_candidates.sql",
    )).toBeGreaterThan(0);
  });

  it("aligns the exact RPC predicate with the canonical evidence state ID", () => {
    expect(evidenceBuilder).toContain('state_id: "first-observation"');
    expect(migration).toContain(
      "$predicate$v_previous_capture ->> 'state_id' is distinct from 'first_observation'$predicate$",
    );
    expect(migration).toContain(
      "$predicate$v_previous_capture ->> 'state_id' is distinct from 'first-observation'$predicate$",
    );
    expect(migration).toContain(
      "v_definition := pg_catalog.replace(v_definition, v_old_predicate, v_new_predicate);",
    );
    expect(migration).not.toMatch(
      /state_id[^\n]+first_observation[^\n]+(?:or|in\s*\()[^\n]+first-observation/i,
    );
  });

  it("fails closed for a missing or unexpected RPC definition", () => {
    expect(migration).toContain(
      "pg_catalog.to_regprocedure(\n    'public.publish_shared_award_initial_document_event(jsonb,jsonb)'",
    );
    expect(migration).toContain("if v_function is null then");
    expect(migration).toContain("select pg_catalog.pg_get_functiondef(v_function)");
    expect(migration).toContain(
      "pg_catalog.length(pg_catalog.replace(v_definition, v_old_predicate, ''))",
    );
    expect(migration).toContain(
      "pg_catalog.length(pg_catalog.replace(v_definition, v_new_predicate, ''))",
    );
    expect(migration).toContain(
      "if v_old_occurrences = 1 and v_new_occurrences = 0 then",
    );
    expect(migration).toContain(
      "elsif not (v_old_occurrences = 0 and v_new_occurrences = 1) then",
    );
    expect(migration).toContain(
      "Initial-document publication RPC has an unexpected or ambiguous attestation state-ID contract.",
    );
  });

  it("adds exactly one permanent current-text artifact assertion", () => {
    expect(migration).toContain(
      "$guard$  perform public.awardping_assert_permanent_visual_artifact(v_current_capture -> 'metadata', 'current.metadata');",
    );
    expect(migration).toContain(
      "perform public.awardping_assert_permanent_visual_artifact(v_current_capture -> 'text', 'current.text');",
    );
    expect(migration).toContain(
      "v_old_text_guard_occurrences = 1 and v_new_text_guard_occurrences = 0",
    );
    expect(migration).toContain(
      "Initial-document publication RPC has an unexpected or ambiguous current-text artifact contract.",
    );
    expect(migration).toContain("execute v_definition;");
  });

  it("matches each predecessor contract exactly once and produces one repaired contract", () => {
    const start = baseMigration.indexOf(
      "create or replace function public.publish_shared_award_initial_document_event(",
    );
    const end = baseMigration.indexOf(
      "\nrevoke all on function public.publish_shared_award_initial_document_event",
      start,
    );
    const rpc = baseMigration.slice(start, end);
    const oldState = "v_previous_capture ->> 'state_id' is distinct from 'first_observation'";
    const newState = "v_previous_capture ->> 'state_id' is distinct from 'first-observation'";
    const oldTextGuard = [
      "  perform public.awardping_assert_permanent_visual_artifact(v_current_capture -> 'metadata', 'current.metadata');",
      "  perform public.awardping_validate_candidate_snapshot_manifest(",
    ].join("\n");
    const newTextGuard = [
      "  perform public.awardping_assert_permanent_visual_artifact(v_current_capture -> 'metadata', 'current.metadata');",
      "  perform public.awardping_assert_permanent_visual_artifact(v_current_capture -> 'text', 'current.text');",
      "  perform public.awardping_validate_candidate_snapshot_manifest(",
    ].join("\n");

    expect(occurrences(rpc, oldState)).toBe(1);
    expect(occurrences(rpc, newState)).toBe(0);
    expect(occurrences(rpc, oldTextGuard)).toBe(1);
    expect(occurrences(rpc, newTextGuard)).toBe(0);

    const repaired = rpc.replace(oldState, newState).replace(oldTextGuard, newTextGuard);
    expect(occurrences(repaired, oldState)).toBe(0);
    expect(occurrences(repaired, newState)).toBe(1);
    expect(occurrences(repaired, oldTextGuard)).toBe(0);
    expect(occurrences(repaired, newTextGuard)).toBe(1);
  });

  it("keeps publication callable only by the service role", () => {
    expect(migration).toContain(
      "revoke all on function public.publish_shared_award_initial_document_event(jsonb, jsonb)",
    );
    expect(migration).toContain("from public, anon, authenticated;");
    expect(migration).toContain(
      "grant execute on function public.publish_shared_award_initial_document_event(jsonb, jsonb)",
    );
    expect(migration).toContain("to service_role;");
  });
});

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}
