import { describe, expect, it } from "vitest";
import { parseProgramTextArgs, loadProgramTextSources, programTextCoverage } from "./program-text-worker.mjs";
import { buildProgramTextCapture } from "./lib/program-text-capture.mjs";
import { programTextReference } from "./lib/program-text-storage.mjs";

const sourceId = "11111111-1111-4111-8111-111111111111", ownerId = "22222222-2222-4222-8222-222222222222", epoch = "33333333-3333-4333-8333-333333333333";
const source = { id: sourceId, shared_award_id: ownerId, url: "https://example.org/award", admin_review_status: "open" };
const role = (extra = {}) => ({ cohort_key: "example", source_role: "eligibility", source_ids: [sourceId], manifest_status: "reviewed_text", revision: epoch,
  evidence: { schema: "awardping.program-text-source-role.v1", source_bindings: { [sourceId]: { source_url: source.url, shared_award_id: ownerId } } }, ...extra });
function client(outcomes) {
  const calls = [];
  return { calls, from(table) {
    const call = { table, filters: [] }; calls.push(call);
    const query = { select(value) { call.select = value; return query; }, order(value) { call.order = value; return query; },
      in(...args) { call.filters.push(["in", ...args]); return query; }, limit(value) { call.limit = value; return query; },
      then(yes, no) { return Promise.resolve(outcomes.shift()).then(yes, no); } };
    return query;
  } };
}
function completeSource() {
  const text = "The application deadline is March 15, 2027. Applicants must be enrolled full time.";
  const capture = buildProgramTextCapture({ source, acquisition: "http_html", raw_bytes: Buffer.from(`<html><body>${text}</body></html>`), content_type: "text/html", text,
    blocks: [{ id: "one", text, start_utf16: 0, end_utf16: text.length }], extractor: { name: "fixture", version: "1" }, captured_at: "2026-10-23T01:01:00.000Z" });
  const ref = programTextReference(capture);
  return { ...source, manifest_bound: true, text_monitoring_state: { schema: "awardping.program-text-state.v1", epoch, status: "baseline_ready", baseline_ref: ref, latest_ref: ref,
    first_captured_at: "2026-10-23T01:00:00.000Z", last_checked_at: ref.captured_at, successful_checks: 2 } };
}

describe("program text worker arguments", () => {
  it("defaults to a non-applying plan", () => expect(parseProgramTextArgs([])).toMatchObject({ mode: "plan", apply: false, pilot: false, shardCount: 1, shardIndex: 0, limit: 50000 }));
  it("accepts explicit bounded source pilots and scheduler shards", () => {
    expect(parseProgramTextArgs(["--mode=collect", "--apply=true", "--pilot=true", `--source-id=${sourceId}`, "--run-trigger=manual", "--limit", "1", "--domain-delay-ms=0"])).toMatchObject({ mode: "collect", apply: true, pilot: true, limit: 1, delay: 0 });
    expect(parseProgramTextArgs(["--mode=collect", "--shard-count=3", "--shard-index=2", "--run-trigger=scheduled"])).toMatchObject({ shardCount: 3, shardIndex: 2 });
  });
  it.each([["collect"], ["--unknown=x"], ["--mode=visual"], ["--apply=yes"], ["--apply=true", "--apply=false"],
    ["--shard-count=0"], ["--shard-count=3", "--shard-index=3"], ["--limit=-1"], ["--limit=50001"], ["--domain-delay-ms=60001"],
    ["--source-id=not-a-uuid"], ["--cohort=../../other"], ["--pilot=true"], ["--pilot=true", `--source-id=${sourceId}`, "--run-trigger=scheduled"]])("rejects invalid or expanding arguments %j", args => {
      expect(() => parseProgramTextArgs(args)).toThrow();
    });
});

describe("required source inventory", () => {
  it("counts factual approval only from a separate current exact-source receipt", () => {
    const roster = { manifest: [role()], sources: [completeSource()] };
    const receipt = { cohort_key: "example", sources: [{ id: sourceId }], review: { id: ownerId, status: "approved", current: true } };
    expect(programTextCoverage(roster, epoch, [receipt])[0].factual_review_complete).toBe(true);
    for (const review of [null, { ...receipt.review, status: "draft" }, { ...receipt.review, current: false }]) {
      expect(programTextCoverage(roster, epoch, [{ ...receipt, review }])[0].factual_review_complete).toBe(false);
    }
    expect(programTextCoverage(roster, epoch, [{ ...receipt, sources: [{ id: ownerId }] }])[0].factual_review_complete).toBe(false);
    expect(programTextCoverage(roster, epoch, [receipt, receipt])[0].factual_review_complete).toBe(false);
  });
  it("loads the complete manifest then exact required IDs and preserves shared roles", async () => {
    const db = client([{ data: [role(), role({ source_role: "application" })] }, { data: [source] }]);
    const result = await loadProgramTextSources(db);
    expect(result.sources).toHaveLength(1); expect(result.sources[0]).toMatchObject({ id: sourceId, cohorts: ["example"], manifest_bound: true });
    expect(db.calls[1].filters).toEqual([["in", "id", [sourceId]]]);
    expect(db.calls[0].table).toBe("program_text_source_roster");
    expect(db.calls.every(call => call.limit === 1000)).toBe(true);
  });
  it.each([[], Array.from({ length: 1000 }, () => role())])("refuses missing or truncated source manifests", async roles => {
    await expect(loadProgramTextSources(client([{ data: roles }]))).rejects.toThrow("missing or incomplete");
  });
  it("refuses missing source rows rather than reporting partial completion", async () => {
    await expect(loadProgramTextSources(client([{ data: [role()] }, { data: [] }]))).rejects.toThrow("identities are incomplete");
  });
  it("marks changed source URLs and missing roles as unbound", async () => {
    for (const roles of [[role()], [role({ manifest_status: "missing" })]]) {
      const db = client([{ data: roles }, { data: [{ ...source, url: "https://example.org/moved" }] }]);
      expect((await loadProgramTextSources(db)).sources[0].manifest_bound).toBe(false);
    }
  });
  it("does not include database error text in failures", async () => {
    await expect(loadProgramTextSources(client([{ error: { code: "XX000", message: "private raw data" } }]))).rejects.toThrow("XX000");
  });
  it.each([
    value => { value.evidence.source_bindings[sourceId].shared_award_id = sourceId; },
    value => { value.revision = null; },
    value => { value.evidence.schema = "legacy-visual"; },
    value => { value.manifest_status = "reviewed"; },
  ])("refuses stale ownership or legacy authority %#", async mutate => {
    const entry = role(); mutate(entry);
    expect((await loadProgramTextSources(client([{ data: [entry] }, { data: [source] }]))).sources[0].manifest_bound).toBe(false);
  });
});

describe("all-required-source collection coverage", () => {
  it("does not count preserved loading-only originals as complete program coverage", () => {
    const value = completeSource();
    for (const ref of [value.text_monitoring_state.baseline_ref, value.text_monitoring_state.latest_ref]) {
      ref.text_length = 76;
      ref.text_sha256 = "0690da223815dc8171e2ec5e6699cf455373bb41644063cd276de152a1ac197c";
      ref.artifacts.text.sha256 = ref.text_sha256;
    }
    expect(programTextCoverage({ manifest: [role()], sources: [value] }, epoch)[0]).toMatchObject({
      repeated_text_sources: 0, collection_complete: false, factual_review_complete: false,
    });
    // Identity/history references remain intact; a quality hold is not a reset.
    expect(value.text_monitoring_state.successful_checks).toBe(2);
    expect(value.text_monitoring_state.status).toBe("baseline_ready");
  });
  it("counts repeated collection separately from facts approval", () => {
    const result = programTextCoverage({ manifest: [role(), role({ source_role: "application" })], sources: [completeSource()] }, epoch);
    expect(result).toEqual([{ cohort: "example", required_sources: 1, repeated_text_sources: 1, collection_complete: true, factual_review_complete: false }]);
  });
  it.each([
    value => { value.text_monitoring_state.successful_checks = 1; },
    value => { value.text_monitoring_state.successful_checks = 2147483648; },
    value => { value.text_monitoring_state.status = "awaiting_review"; },
    value => { value.text_monitoring_state.epoch = ownerId; },
    value => { value.text_monitoring_state.schema = "legacy"; },
    value => { value.text_monitoring_state.first_captured_at = value.text_monitoring_state.last_checked_at; },
    value => { value.text_monitoring_state.latest_ref.source.shared_award_id = sourceId; },
    value => { value.text_monitoring_state.latest_ref.source.url = "https://example.org/wrong"; },
    value => { value.manifest_bound = false; },
    value => { value.admin_review_status = "review_later"; },
    value => { value.text_monitoring_state = { epoch, status: "baseline_ready", successful_checks: 2 }; },
  ])("does not count incomplete, stale or invalid coverage %#", mutate => {
    const value = completeSource(); mutate(value);
    expect(programTextCoverage({ manifest: [role()], sources: [value] }, epoch)[0].collection_complete).toBe(false);
  });
  it("requires every source and every role, not one migrated page per award", () => {
    const result = programTextCoverage({ manifest: [role(), role({ source_role: "funding", source_ids: [ownerId], manifest_status: "missing" })], sources: [completeSource()] }, epoch)[0];
    expect(result).toMatchObject({ required_sources: 2, repeated_text_sources: 1, collection_complete: false });
  });
});
