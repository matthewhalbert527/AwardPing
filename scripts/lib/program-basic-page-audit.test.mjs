import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "libpg-query";
import { auditProgramBasicPage, inspectProgramBasicPageAudit, loadProgramBasicPageAuditAwards, loadLegacyPageAuditAwards, persistProgramBasicPageAudit } from "./program-basic-page-audit.mjs";
import { buildProgramTextCapture } from "./program-text-capture-contract.mjs";
import { programTextReference } from "./program-text-artifacts.mjs";
import { basicAwardFactPublicValues, BASIC_AWARD_FACT_SCHEMA } from "./basic-award-facts.mjs";
import { emptyProgramFactReview } from "./program-text-facts.mjs";
import { currentBasicHash } from "./current-basic-source-proof.mjs";

const awardId = "22222222-2222-4222-8222-222222222222", sourceId = "11111111-1111-4111-8111-111111111111";
const snapshotId = "33333333-3333-4333-8333-333333333333", draftId = "44444444-4444-4444-8444-444444444444";
const at = "2026-11-01T05:00:00.000Z";
function fixture() {
  const source = { id: sourceId, shared_award_id: awardId, url: "https://example.org/rhodes", title: "Rhodes fixture", page_type: "eligibility" };
  const selected = {
    overview: ["Rhodes fixture supports graduate study."], deadline: ["October 1, 2026"],
    eligibility: Array.from({ length: 7 }, (_, i) => `Eligibility requirement ${i + 1}.`),
    citizenship: Array.from({ length: 4 }, (_, i) => `Citizenship route ${i + 1}.`),
    academic_levels: ["Undergraduate final year.", "Recent graduate."],
    award_amounts: Array.from({ length: 4 }, (_, i) => `Funding detail ${i + 1}.`),
  };
  const text = Object.values(selected).flat().join("\n");
  const capture = buildProgramTextCapture({ source, acquisition: "http_html", raw_bytes: Buffer.from(`<main>${text}</main>`),
    content_type: "text/html", text, blocks: [{ id: "body", text, start_utf16: 0, end_utf16: text.length }],
    extractor: { name: "fixture", version: "1" }, captured_at: "2026-10-31T23:00:00.000Z" });
  const ref = programTextReference(capture);
  const roles = [{ source_role: "eligibility", revision: draftId, source_ids: [sourceId] }];
  const review = emptyProgramFactReview({ registry: { cohort_key: "rhodes", canonical_shared_award_id: awardId }, roles,
    sources: [{ ...source, text_monitoring_state: { latest_ref: ref } }], epoch: snapshotId, cycle: "2027" });
  for (const [name, values] of Object.entries(selected)) Object.assign(review.fields.find(row => row.field === name), {
    status: "verified", items: values.map(value => ({ value, track: null, support: [{ source_id: sourceId, capture_id: ref.capture_id,
      block_id: "body", start_utf16: text.indexOf(value), end_utf16: text.indexOf(value) + value.length, text: value }] })),
  });
  const fields = Object.keys(selected), facts = basicAwardFactPublicValues(review, fields);
  const receipt = { schema: BASIC_AWARD_FACT_SCHEMA, cohort_key: "rhodes", award_id: awardId, epoch: snapshotId, cycle: "2027",
    input_review_id: draftId, input_review_hash: "a".repeat(64), selected_fields: fields, reviewed_at: at, roster: review.roster,
    supporting_capture_refs: [ref], current_capture_refs: [ref], public_facts: facts };
  const snapshot = { id: snapshotId, award_id: awardId, cohort_key: "rhodes", kind: "automated_source_verified_basics",
    receipt, content_hash: currentBasicHash(receipt), input_review_id: draftId, input_review_hash: "a".repeat(64), public_facts: facts };
  const context = { schema: "awardping.program-basic-page-audit-context.v1", revision: "b".repeat(64), selected_at: at,
    basis: { schema: "awardping.program-basic-page-audit-basis.v1", award: { id: awardId, name: "Rhodes fixture", slug: "rhodes-fixture", status: "active" },
      cohort_key: "rhodes", snapshot, draft: { id: draftId, content_hash: "a".repeat(64), content_hash_valid: true, review },
      published: [{ award_id: awardId, cohort_key: "rhodes", snapshot_id: snapshotId, kind: snapshot.kind,
        current: true, public_facts: facts, verified_at: at }] } };
  return { context, capture, loadCapture: vi.fn(async () => capture) };
}

describe("current published basic-details page audit", () => {
  it("checks all 19 Rhodes fixture values against the live getter and cold originals without legacy facts", async () => {
    const f = fixture(), frozen = structuredClone(f.context);
    const result = await auditProgramBasicPage(f.context, f);
    expect(result).toMatchObject({ audit_status: "passed", field_count: 6, value_count: 19, capture_count: 1,
      applied_to_public: false, observation_only: true, findings: [] });
    expect(f.loadCapture).toHaveBeenCalledOnce(); expect(f.context).toEqual(frozen);
  });
  it("reports a missing snapshot instead of passing sparse old facts", async () => {
    const f = fixture(); f.context.basis.snapshot = null; f.context.basis.published = [];
    expect(await auditProgramBasicPage(f.context, f)).toMatchObject({ audit_status: "failed", findings: [{ code: "basic_details_missing" }] });
    expect(f.loadCapture).not.toHaveBeenCalled();
  });
  it("recognizes stale details hidden by the website getter", async () => {
    const f = fixture(); Object.assign(f.context.basis.published[0], { current: false, public_facts: null });
    expect(await auditProgramBasicPage(f.context, f)).toMatchObject({ audit_status: "failed", findings: [{ code: "basic_details_stale_or_unavailable" }] });
  });
  it.each([
    ["snapshot", f => { f.context.basis.snapshot.award_id = sourceId; }],
    ["saved review", f => { f.context.basis.draft.content_hash_valid = false; }],
    ["receipt digest", f => { f.context.basis.snapshot.receipt.reviewed_at = "2020-01-01T00:00:00.000Z"; }],
    ["getter", f => { f.context.basis.published = []; }],
    ["getter identity", f => { f.context.basis.published[0].award_id = sourceId; }],
    ["getter projection", f => { f.context.basis.published[0].public_facts = { overview: "Different" }; }],
    ["formatter projection", f => { f.context.basis.draft.review.fields.find(row => row.field === "overview").items[0].value = "Invented overview"; }],
    ["missing selected field", f => { f.context.basis.draft.review.fields.find(row => row.field === "citizenship").status = "unresolved"; }],
    ["quote", f => { f.context.basis.draft.review.fields.find(row => row.field === "citizenship").items[0].support[0].text = "Invented route"; }],
    ["source roster", f => { f.context.basis.draft.review.capture_refs = []; }],
    ["missing original", f => { f.loadCapture = async () => { throw Error("Credentials SECRET must not leak"); }; }],
    ["changed original", f => { f.loadCapture = async () => ({ ...f.capture, text: f.capture.text + "x" }); }],
  ])("fails on changed %s", async (_, mutate) => {
    const f = fixture(); mutate(f); const result = await auditProgramBasicPage(f.context, f);
    expect(result.audit_status).toBe("failed"); expect(result.findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("SECRET"); expect(result.observation_only).toBe(true);
  });
  it("rejects a fabricated date year even with a matching formatter projection", async () => {
    const f = fixture(), b = f.context.basis;
    b.draft.review.fields.find(row => row.field === "deadline").items[0].value = "October 1, 2027";
    const facts = basicAwardFactPublicValues(b.draft.review, b.snapshot.receipt.selected_fields);
    b.snapshot.public_facts = b.snapshot.receipt.public_facts = b.published[0].public_facts = facts;
    b.snapshot.content_hash = currentBasicHash(b.snapshot.receipt);
    expect(await auditProgramBasicPage(f.context, f)).toMatchObject({ findings: [{ code: "published_date_year_not_quoted" }] });
  });
  it("uses only the explicitly service-scoped audit RPCs, preserving CAS revision", async () => {
    const f = fixture(), rpc = vi.fn(async name => ({ data: name === "list_program_basic_page_audit_awards"
      ? { schema: "awardping.program-basic-page-audit-roster.v1", registered_award_ids: [awardId], awards: [{ award_id: awardId,
        cohort_key: "rhodes", name: "Rhodes fixture", slug: "rhodes-fixture" }] }
      : name === "inspect_program_basic_page_audit" ? f.context
      : { audit_id: draftId, inserted: true, observation_only: true }, error: null }));
    const roster = await loadProgramBasicPageAuditAwards({ rpc }); expect(roster.awards).toHaveLength(1);
    await inspectProgramBasicPageAudit({ rpc }, roster.awards[0]);
    const result = await auditProgramBasicPage(f.context, f); await persistProgramBasicPageAudit({ rpc }, f.context, result);
    expect(rpc.mock.calls[2]).toEqual(["record_program_basic_page_audit", { p_award_id: awardId, p_expected_revision: "b".repeat(64), p_result: result }]);
    expect(rpc.mock.calls.some(([name]) => /commit|approve|publish|regression/.test(name))).toBe(false);
  });
});

describe("legacy page audit selection beside the modern journal", () => {
  const id = index => `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`;
  function database(modernCount, legacyCount) {
    const modern = Array.from({ length: modernCount }, (_, index) => ({ id: id(index + 1), created: index }));
    const legacy = Array.from({ length: legacyCount }, (_, index) => ({ id: id(index + 1000), created: modernCount + index,
      regression_evaluation: { revision: `saved-${index}`, sources: [] } }));
    const attempted = new Map();
    const rpc = vi.fn(async (_name, parameters) => ({ data: [...modern, ...legacy].sort((left, right) => {
      const leftAt = attempted.get(left.id) ?? Number.NEGATIVE_INFINITY, rightAt = attempted.get(right.id) ?? Number.NEGATIVE_INFINITY;
      return (leftAt === rightAt ? 0 : leftAt < rightAt ? -1 : 1) || left.created - right.created;
    }).slice(0, parameters.p_limit), error: null }));
    return { modern, legacy, attempted, rpc };
  }
  it("returns a full legacy batch past 35 untouched modern cursors and keeps rotating legacy awards", async () => {
    const db = database(35, 50), scope = { limit: 25, registeredAwardIds: db.modern.map(row => row.id) };
    const first = await loadLegacyPageAuditAwards(db, scope);
    expect(first).toHaveLength(25); expect(db.rpc.mock.calls[0]).toEqual(["list_shared_awards_for_regression_audit", {
      p_limit: 60, p_slugs: null, p_include_deferred: false,
    }]);
    for (const row of first) db.attempted.set(row.id, 1);
    const second = await loadLegacyPageAuditAwards(db, scope);
    expect(second).toHaveLength(25); expect(new Set([...first, ...second].map(row => row.id)).size).toBe(50);
    for (const row of second) db.attempted.set(row.id, 2);
    expect((await loadLegacyPageAuditAwards(db, scope)).map(row => row.id)).toEqual(first.map(row => row.id));
    expect(db.modern.every(row => !db.attempted.has(row.id))).toBe(true);
    expect(first[0]).toBe(db.legacy[0]); // Keep immutable evaluation envelopes untouched.
  });
  it("still reaches 25 legacy awards when a future 100-program roster leads the selector", async () => {
    const db = database(100, 50);
    const rows = await loadLegacyPageAuditAwards(db, { registeredAwardIds: db.modern.map(row => row.id) });
    expect(rows.map(row => row.id)).toEqual(db.legacy.slice(0, 25).map(row => row.id));
    expect(db.rpc.mock.calls[0][1].p_limit).toBe(125);
  });
  it("caps the selector response and returned legacy batch at the existing 250-row boundary", async () => {
    const db = database(100, 300);
    const rows = await loadLegacyPageAuditAwards(db, { limit: 250, registeredAwardIds: db.modern.map(row => row.id) });
    expect(db.rpc.mock.calls[0][1].p_limit).toBe(250); expect(rows.length).toBeLessThanOrEqual(250);
    expect(rows.every(row => !db.modern.some(modern => modern.id === row.id))).toBe(true);
  });
  it.each([false, true])("preserves explicit canary slugs and deferred selection: %s", async includeDeferred => {
    const canary = { id: id(1000), slug: "legacy-canary", deferred: true, regression_evaluation: { sources: [] } };
    const rpc = vi.fn(async (_name, parameters) => ({ data: parameters.p_include_deferred ? [canary] : [], error: null }));
    const rows = await loadLegacyPageAuditAwards({ rpc }, { limit: 1, slugs: ["legacy-canary"], includeDeferred, registeredAwardIds: [id(1)] });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("list_shared_awards_for_regression_audit", {
      p_limit: 2, p_slugs: ["legacy-canary"], p_include_deferred: includeDeferred,
    });
    expect(rows).toEqual(includeDeferred ? [canary] : []);
  });
  it("rejects malformed or duplicate selector rows and retains transport failures", async () => {
    for (const data of [null, [{ id: "foreign" }], [{ id: id(1) }, { id: id(1) }]]) {
      await expect(loadLegacyPageAuditAwards({ rpc: async () => ({ data, error: null }) })).rejects.toThrow("invalid bounded award array");
    }
    await expect(loadLegacyPageAuditAwards({ rpc: async () => ({ error: { message: "selector unavailable" } }) })).rejects.toThrow("selector unavailable");
  });
});

describe("basic page audit database boundary", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261101061309_program_basic_page_audit_observations.sql", import.meta.url), "utf8");
  it("parses all additive journal and CAS functions", async () => { expect((await parse(sql)).stmts.length).toBeGreaterThan(5); });
  it("journals only observation results and keeps legacy publication controls intact", () => {
    expect(sql).toContain("public.get_program_basic_facts(array[p_award_id])");
    expect(sql).toContain("context->>'revision' is distinct from p_expected_revision");
    expect(sql).toContain("alter table private.program_basic_page_audit_observations enable row level security");
    expect(sql).toContain("from public,anon,authenticated,service_role");
    expect(sql).not.toMatch(/(?:update|insert into|delete from) public\./i);
    expect(sql).not.toContain("invalidate_stage1_release");
    expect(sql).not.toContain("create or replace");
  });
  it("routes modern programs away from the legacy fact reconciler", () => {
    const runner = readFileSync(new URL("../evaluate-public-page-audit-canaries.mjs", import.meta.url), "utf8");
    expect(runner).toContain("registeredAwardIds: basic.registered_award_ids");
    expect(runner).toContain("const legacy = await loadLegacyPageAuditAwards(supabase");
    expect(runner).toContain('purpose: "current_published_basic_details"');
    expect(runner).toContain("if (apply && !award.basic_page_audit_target)");
  });
});
