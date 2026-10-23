import { describe, expect, it } from "vitest";
import { parse } from "libpg-query";
import { buildProgramTextDbRehearsal } from "./program-text-db-rehearsal.mjs";
import { validateProgramTextReference } from "./program-text-storage.mjs";
import { validateProgramTextReviewResult } from "./program-text-review.mjs";

const source = { id: "00c48fd6-aea0-4208-8d85-7d95c5910148", shared_award_id: "85540cb5-55b0-4791-97eb-53f89697ae80",
  url: "https://www.rhodeshouse.ox.ac.uk/scholarships/faqs/", title: "FAQs", page_type: "faq" };
const options = { source, award_name: "Rhodes Scholarship", observed_at: "2026-10-20T12:00:00.000Z",
  epoch: "10000000-0000-0000-0000-000000000001", candidate_id: "20000000-0000-0000-0000-000000000001" };

describe("rollback-only program text database rehearsal generator", () => {
  it("builds real complete capture references, sealed comparison and accepted exact quotations", () => {
    const result = buildProgramTextDbRehearsal(options), c = result.fixture.candidate;
    expect(() => validateProgramTextReference(c.previous_snapshot_ref)).not.toThrow();
    expect(() => validateProgramTextReference(c.new_snapshot_ref)).not.toThrow();
    expect(validateProgramTextReviewResult(c.prompt_payload.comparison, c.prompt_payload.packet_plan, c.ai_result.responses)).toEqual(c.ai_result.program_text_validation);
    expect(c.ai_result.program_text_validation.status).toBe("accepted");
    const q = result.fixture.details.program_changes[0].current_quote;
    expect(c.prompt_payload.comparison.current_text.slice(q.start_utf16, q.end_utf16)).toBe(q.text);
    expect(q.start_utf16).toBeGreaterThan(30);
    expect(result.fixture.localization.supporting_blocks.current[0].text).toContain("🧪");
    expect(c.worker_metadata.synthetic_rollback_rehearsal).toBe(true);
    expect(result.fixture.baseline.successful_checks).toBe(1);
    expect(result.fixture.awaiting.successful_checks).toBe(2);
  });

  it("parses as one bounded transaction, one role, one DO, and a terminal rollback without DDL", async () => {
    const result = buildProgramTextDbRehearsal(options), parsed = await parse(result.sql);
    expect(parsed.stmts.map(row => Object.keys(row.stmt)[0])).toEqual(["TransactionStmt", "VariableSetStmt", "VariableSetStmt", "VariableSetStmt", "VariableSetStmt", "DoStmt", "TransactionStmt"]);
    expect(result.sql.trim().endsWith("rollback;")).toBe(true);
    expect(result.sql).not.toMatch(/\b(?:create|alter|drop|truncate|delete|commit|dblink|http_post|net\.http)\b/i);
    expect(result.sql).toContain("set local role service_role;");
    expect(result.sql).toContain("set local statement_timeout='30s';");
    expect(result.sql).toContain("set local plpgsql.check_asserts=on;");
    expect(result.sql.match(/set constraints all immediate;/g)).toHaveLength(2);
    expect((await parse(result.after_rollback_query)).stmts.map(row => Object.keys(row.stmt)[0])).toEqual(["SelectStmt"]);
  });

  it("includes silent initial coverage, eight rejection checks, positive/idempotent publication and source snapshots", () => {
    const { sql } = buildProgramTextDbRehearsal(options);
    expect(sql).toContain("into strict v_original_source");
    expect(sql).toContain("Rehearsal refuses an existing text epoch");
    expect(sql).toContain("Initial coverage created an update");
    expect(sql).toContain("Initial coverage queued a review");
    expect(sql).toContain("assert v_negatives=8");
    expect(sql.match(/v_rejected:=false;/g)).toHaveLength(8);
    expect(sql).toContain("exception when sqlstate '40001'");
    expect(sql).toContain("False successful-check counter was accepted");
    expect(sql).toContain("Malformed exact quotation was accepted");
    expect(sql).toContain("Wrong event source was accepted");
    expect(sql).toContain("Wrong publication epoch was accepted");
    expect(sql).toContain("Publication is not idempotent");
    expect(sql).toContain("Rehearsal altered unrelated source fields");
    expect(sql).toContain("Split surrogate accepted");
  });

  it("quotes hostile JSON strings without permitting an extra top-level SQL statement", async () => {
    const hostile = { ...options, source: { ...source, title: "' $awardping_program_rehearsal_0$ ; commit; -- $awardping_fixture_json_0$" } };
    const result = buildProgramTextDbRehearsal(hostile), parsed = await parse(result.sql);
    expect(parsed.stmts).toHaveLength(7);
    expect(parsed.stmts[5].stmt.DoStmt).toBeTruthy();
    expect(result.sql).toContain("do $awardping_program_rehearsal_1$");
  });

  it.each([
    { ...options, observed_at: "2999-01-01T00:00:00.000Z" },
    { ...options, observed_at: "not a timestamp" },
    { ...options, candidate_id: "id'; commit;" },
    { ...options, epoch: "00000000-0000-0000-0000-000000000000" },
    { ...options, source: { ...source, id: "bad" } },
  ])("rejects invalid or unsafe source/clock identities", input => {
    expect(() => buildProgramTextDbRehearsal(input)).toThrow();
  });
});
