import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "libpg-query";
import { programBasicPageAuditRollbackFixture } from "./program-basic-page-audit-rollback-fixture.mjs";
const migration = readFileSync(new URL("../../supabase/migrations/20261101061309_program_basic_page_audit_observations.sql", import.meta.url), "utf8");
describe("native basic page audit rollback rehearsal", () => {
  it("parses a bounded rollback-only transaction", async () => {
    const sql = programBasicPageAuditRollbackFixture(migration);
    expect(sql.startsWith("begin isolation level repeatable read;")).toBe(true);
    expect(sql.trim().endsWith("rollback;")).toBe(true);
    expect(sql).not.toMatch(/\bcommit\s*;/i);
    expect((await parse(sql)).stmts.length).toBeGreaterThan(10);
  });
  it("covers actual getter shape, fairness, CAS, types, date, pointer, roles and conservation", () => {
    const sql = programBasicPageAuditRollbackFixture(migration);
    for (const value of ["Actual getter context malformed", "Bounded modern roster incomplete", "Observation deduplication failed",
      "Stale CAS revision accepted", "Publication mutation flag accepted", "String counter accepted", "Changed snapshot pointer accepted",
      "Expired observation accepted", "Audit service boundary changed", "Audit changed public facts, sources, alerts or events"]) expect(sql).toContain(value);
    expect(sql).not.toContain("jsonb_agg(to_jsonb(s)");
  });
  it("refuses caller-supplied transaction endings", () => {
    expect(() => programBasicPageAuditRollbackFixture(migration + "\ncommit;")).toThrow();
  });
});
