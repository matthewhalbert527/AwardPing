import { describe, it, expect } from "vitest";
import { parse } from "libpg-query";
import { readFileSync } from "node:fs";
import { generateProgramFactDbRehearsal, factDbRehearsalVerificationQuery } from "./program-text-fact-db-rehearsal.mjs";

const award = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222", epoch = "33333333-3333-4333-8333-333333333333";
function fixture() {
  const source = { id, shared_award_id: award, url: "https://example.org/award", admin_review_status: "open", text_monitoring_state: {} };
  return { expectedAwards: 1, expectedSources: 1, epoch, now: new Date("2026-10-25T16:00:00.000Z"),
    registries: [{ cohort_key: "example", canonical_shared_award_id: award }], members: [{ cohort_key: "example", shared_award_id: award }], sources: [source],
    roles: [{ cohort_key: "example", source_role: "application", revision: epoch, source_ids: [id], manifest_status: "reviewed_text",
      evidence: { schema: "awardping.program-text-source-role.v1", source_bindings: { [id]: { source_url: source.url, shared_award_id: award } } } }] };
}

describe("explicit rollback-only fact SQL rehearsal generator", () => {
  it("builds actual synthetic captures and valid all-field proof without R2 or providers", async () => {
    const result = await generateProgramFactDbRehearsal(fixture());
    expect(result.schema).toBe("awardping.program-fact-db-rehearsal.v1");
    expect(result.expected).toMatchObject({ rollback_only: true, synthetic_facts_only: true, awards: 1, sources: 1, roles: 1 });
    expect(result.query).toContain("TEST ONLY — fictitious SQL runtime rehearsal; never award advice.");
    expect(result.query).toContain("blocks_json"); expect(result.query).toContain("TEST ONLY Track B");
    expect(result.query).toContain("Application deadline — TEST ONLY Track A: January 31, 2027");
    expect(result.expected.query_bytes).toBeLessThan(1_800_000);
    expect(result.expected.query_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.expected.input_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("emits exactly one explicit transaction whose last command is rollback, never commits", async () => {
    const { query } = await generateProgramFactDbRehearsal(fixture()); const ast = await parse(query);
    const transactions = ast.stmts.map(stmt => stmt.stmt.TransactionStmt).filter(Boolean);
    expect(transactions.map(tx => tx.kind)).toEqual(["TRANS_STMT_BEGIN", "TRANS_STMT_ROLLBACK"]);
    expect(ast.stmts.at(-1).stmt.TransactionStmt.kind).toBe("TRANS_STMT_ROLLBACK");
    expect(query).not.toMatch(/\bCOMMIT\s*;/i);
    expect(query).toContain("pg_try_advisory_xact_lock"); expect(query).toContain("SET LOCAL statement_timeout='45s'");
    expect(query).toContain("SET LOCAL lock_timeout='1s'");
  });
  it("guards the original exact source states and roster before any synthetic state mutation", async () => {
    const { query } = await generateProgramFactDbRehearsal(fixture());
    const assertion = query.indexOf("private.stage1_canonical_json_sha256(s.text_monitoring_state) IS DISTINCT FROM x->>'state_sha256'");
    const update = query.indexOf("UPDATE public.shared_award_sources s SET text_monitoring_state=jsonb_build_object(");
    expect(assertion).toBeGreaterThan(0); expect(update).toBeGreaterThan(assertion);
    expect(query).toContain("program_text_fact_reviews)<>0");
    expect(query).toContain("rehearsal refuses an active fact release");
    expect(query).not.toMatch(/(?:SET|UPDATE)\s+(?:page_metadata|url|shared_award_id|admin_review_status)/i);
    expect(query).toContain("jsonb_agg((doc-'source_id')||jsonb_build_object('reference',ref)");
  });
  it("exercises save/approval/publication parity, rejection and idempotence with caught subtransactions", async () => {
    const { query, expected } = await generateProgramFactDbRehearsal(fixture());
    for (const value of ["public.save_program_text_fact_review", "public.approve_program_text_fact_review", "public.publish_program_text_fact_batch",
      "private.awardping_program_fact_public_values", "private.awardping_program_fact_validation_valid", "public.set_program_text_source_state",
      "public.replace_program_text_source_role", "public.get_program_text_fact_publication", "EXCEPTION WHEN check_violation", "EXCEPTION WHEN insufficient_privilege",
      "EXCEPTION WHEN serialization_failure", "last_program_update_at", "stale roster CAS accepted", "whole-25 atomic fact publication failed"]) expect(query).toContain(value);
    expect(expected.negative).toHaveLength(12); expect(expected.final).toHaveLength(5);
  });
  it("emits an independent read-only before/after verification query covering original state and private history", async () => {
    const query = factDbRehearsalVerificationQuery([id]); await parse(query);
    expect(query).not.toMatch(/\b(?:insert|update|delete|create|alter|drop)\s/i);
    for (const value of ["source_states_sha256", "roster_sha256", "legacy_registry_sha256", "legacy_fact_ledger_sha256", "text_queue_sha256",
      "failed_text_reviews", "fact_reviews", "fact_review_events", "roster_events"]) expect(query).toContain(value);
  });
  it.each([
    input => { input.sources = []; }, input => { input.sources[0].admin_review_status = "closed"; },
    input => { input.members[0].shared_award_id = id; }, input => { input.roles[0].evidence.source_bindings[id].source_url = "https://other.example/"; },
  ])("rejects an incomplete, unapproved or wrong-owner input snapshot %#", async mutate => {
    const input = fixture(); mutate(input); await expect(generateProgramFactDbRehearsal(input)).rejects.toThrow();
  });
  it("contains no SQL execution path or paid/storage operation and performs read requests only once", () => {
    const source = readFileSync(new URL("./program-text-fact-db-rehearsal.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.rpc\(|\.insert\(|\.delete\(|uploadProgram|PutObjectCommand|submitProgramTextBatch|supabase_execute_sql/);
    expect(source).toContain("const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })");
    expect(source).toContain("no retry."); expect(source).not.toContain("createSupabaseServiceClient(");
  });
});
