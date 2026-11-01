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
    expect(sql).toContain("set local statement_timeout='15s';");
    expect(sql).toContain("set local lock_timeout='2s';");
    expect((await parse(sql)).stmts.length).toBeGreaterThan(10);
  });
  it("bounds a distinct roster-only scope before reading source state", () => {
    const sql = programBasicPageAuditRollbackFixture(migration);
    expect(sql).toMatch(/create temporary table basic_audit_fixture_scope on commit drop as\s+select distinct unnest\(roster\.source_ids\) as source_id from public\.program_text_source_roster roster limit 1001;/);
    const cap = sql.indexOf("source_total>1000");
    const stateRead = sql.indexOf("octet_length(s.text_monitoring_state::text)");
    const firstAggregate = sql.indexOf("jsonb_agg(jsonb_build_object('id',s.id");
    expect(cap).toBeGreaterThan(0);
    expect(stateRead).toBeGreaterThan(cap);
    expect(firstAggregate).toBeGreaterThan(stateRead);
    expect(sql).toContain("Rehearsal source scope contains missing identities");
    expect(sql.match(/from public\.shared_award_sources/g)).toBeNull();
    expect(sql.match(/from basic_audit_fixture_scope scope join public\.shared_award_sources s on s\.id=scope\.source_id/g)).toHaveLength(8);
  });
  it("streams computed quality and both 8 MiB guards before each scoped aggregate", () => {
    const sql = programBasicPageAuditRollbackFixture(migration);
    expect(sql).not.toMatch(/\bs\.text_collection_quality\b/);
    expect(sql).toContain("private.awardping_program_text_collection_quality(s.id)");
    expect(sql.match(/sum\(coalesce\(octet_length\(s\.text_monitoring_state::text\),0\)::bigint\+\s+coalesce\(octet_length\(private\.awardping_program_text_collection_quality\(s\.id\)::text\),0\)\)/g)).toHaveLength(2);
    expect(sql.match(/if source_bytes>8\*1024\*1024/g)).toHaveLength(2);
    expect(sql.match(/if projection_bytes>8\*1024\*1024/g)).toHaveLength(2);
    const aggregates = [...sql.matchAll(/jsonb_agg\(jsonb_build_object\('id',s\.id/g)].map(match => match.index);
    expect(aggregates).toHaveLength(2);
    const guards = [...sql.matchAll(/if projection_bytes>8\*1024\*1024/g)].map(match => match.index);
    expect(guards[0]).toBeLessThan(aggregates[0]);
    expect(guards[1]).toBeGreaterThan(aggregates[0]);
    expect(guards[1]).toBeLessThan(aggregates[1]);
    // The unchanged migration intentionally projects one modern snapshot as s;
    // source conservation must never serialize an entire legacy source row.
    expect(sql.replace(migration, "")).not.toMatch(/to_jsonb\(s\)/);
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
