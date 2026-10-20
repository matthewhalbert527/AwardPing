import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scraplingBaselineTransitionSchema, ScraplingBaselineTransitionError, loadScraplingBaselineTransition, requiresScraplingBaselineTransition, getScraplingBaselineTransitionReference, assertScraplingBaselineTransition } from "./scrapling-baseline-transition.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const roots = [];
const source = { id: "12345678-1234-4234-8234-123456789012", shared_award_id: "22345678-1234-4234-8234-123456789012", url: "https://example.edu/programme", page_type: "faq", source: "admin", admin_review_status: "open", page_metadata: { audience: "international", approval: "retained existing review" }, reason: "reviewed official", admin_review_note: "current retained approval", admin_reviewed_by: "operator", admin_reviewed_at: "2026-10-20T10:00:00.000Z" };
const profile = "scrapling-evidence-v2";
const referenceAt = "2026-10-20T12:00:00.000Z";
const baseline = { source: { ...source }, capture_profile: "discovery", captured_at: "2026-10-18T12:00:00.000Z", text_hash: sha("full old retained baseline") };
const native = "International nominees may apply in August. Preliminary admission is not final admission.\u200d";
const context = { blocks: [{ kind: "div", text: native, heading_path: [{ level: 2, text: "Eligibility" }], sibling_button_path: ["International applicants"] }], links: [{ text: "Apply", raw_href: "/apply?route=international", download: "", attributes: { title: "Conditions apply" } }] };
const review = `${native}\n\nHTML source context: ${JSON.stringify(context)}\n${"Full retained tail with exception. ".repeat(200)}`;
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "awardping-transition-")); roots.push(root);
  const capture = { source: { ...source }, status_code: 200, capture_profile: profile, capture_behavior_name: profile, capture_behavior_version: 2, final_url: source.url, captured_at: referenceAt, text: review, scrapling: { visible_text: native, visible_text_sha256: sha(native) } };
  const row = { source_id: source.id, stored_owner_id: source.shared_award_id, url: source.url, page_type: source.page_type, old_baseline: { source_id: source.id, stored_owner_id: source.shared_award_id, url: source.url, page_type: source.page_type, capture_profile: baseline.capture_profile, captured_at: baseline.captured_at, text_hash: baseline.text_hash }, target_profile: profile, reference_captured_at: referenceAt, review_text_sha256: sha(review), native_visible_text_sha256: sha(native), reference_artifacts: [] };
  const raws = { meta: Buffer.from(JSON.stringify(capture, null, 2)), text: Buffer.from(review + "\n"), html: Buffer.from("<html><main>Retained reference</main></html>"), page: Buffer.from("synthetic retained page bytes, no image verification claimed"), thumb: Buffer.from("synthetic thumbnail bytes") };
  for (const kind of ["meta", "text", "html", "page", "thumb"]) { const path = join(root, kind + ".bin"); writeFileSync(path, raws[kind], { flag: "wx" }); row.reference_artifacts.push({ kind, path, sha256: sha(raws[kind]), byte_length: raws[kind].length }); }
  const data = { schema: scraplingBaselineTransitionSchema, sources: [row] }; const path = join(root, "pins.json");
  const save = () => { const raw = Buffer.from(JSON.stringify(data, null, 2) + "\n"); writeFileSync(path, raw); return { path, sha256: sha(raw) }; };
  const load = () => loadScraplingBaselineTransition(save());
  const check = (guard = load(), overrides = {}) => assertScraplingBaselineTransition({ guard, sourceBefore: structuredClone(source), sourceAfter: structuredClone(source), baseline: structuredClone(baseline), capture: structuredClone(capture), baselineRefresh: true, captureProfile: profile, ...overrides });
  return { root, capture, row, data, path, save, load, check, raws };
}

describe("reviewed first-coverage baseline transition", () => {
  it("binds all five original artifacts and returns no factual/migration authority", () => {
    const f = fixture(); const options = f.save(); const before = readFileSync(options.path); const guard = loadScraplingBaselineTransition(options);
    expect(f.check(guard)).toEqual({ required: true, reference_sha256: options.sha256, source_id: source.id, monitoring_first_coverage_only: true, factual_approval: false, migration_authority: false, website_change_certified: false });
    expect(readFileSync(options.path)).toEqual(before); expect(Object.isFrozen(guard.sources[0].reference_artifacts)).toBe(true);
  });
  it.each(["nested link attributes", "condition", "full tail", "Unicode", "native only", "terminal LF"])("holds an exact %s change without normalization", scenario => {
    const f = fixture(); const guard = f.load(); const capture = structuredClone(f.capture);
    if (scenario === "nested link attributes") capture.text = capture.text.replace("Conditions apply", "No conditions");
    if (scenario === "condition") capture.text = capture.text.replace("Preliminary admission is not final admission.", "Preliminary admission is final admission.");
    if (scenario === "full tail") capture.text = capture.text.slice(0, -2) + " changed";
    if (scenario === "Unicode") capture.text = capture.text.replace("\u200d", "");
    if (scenario === "native only") { capture.scrapling.visible_text += " Changed native condition."; capture.scrapling.visible_text_sha256 = sha(capture.scrapling.visible_text); }
    if (scenario === "terminal LF") capture.text += "\n";
    expect(() => f.check(guard, { capture })).toThrow("full review/native text changed");
  });
  it.each(["id", "shared_award_id", "url", "page_type"])("requires exact before/after/capture source %s", key => {
    const f = fixture(); const guard = f.load();
    for (const where of ["sourceBefore", "sourceAfter", "capture"]) { const options = { [where]: where === "capture" ? structuredClone(f.capture) : { ...source } }; const target = where === "capture" ? options.capture.source : options[where]; target[key] += "changed"; expect(() => f.check(guard, options)).toThrow("source identity"); }
  });
  it.each([
    ["wrong profile", c => { c.capture_profile = "scrapling-evidence-v1"; }],
    ["wrong behavior name", c => { c.capture_behavior_name = "discovery"; }],
    ["wrong behavior version", c => { c.capture_behavior_version = 1; }],
    ["changed final URL", c => { c.final_url += "?other=1"; }],
    ["earlier capture", c => { c.captured_at = "2026-10-20T11:59:59.999Z"; }],
    ["invalid time", c => { c.captured_at = "2026-02-30T12:00:00.000Z"; }],
  ])("holds %s", (_, mutate) => { const f = fixture(); const guard = f.load(); const capture = structuredClone(f.capture); mutate(capture); expect(() => f.check(guard, { capture })).toThrow("capture profile/URL/time"); });
  it("allows a later bound observation but not a forged/deserialized loaded guard", () => { const f = fixture(); const guard = f.load(); const capture = { ...f.capture, captured_at: "2026-10-20T12:01:00.000Z" }; expect(f.check(guard, { capture }).required).toBe(true); for (const bad of [null, {}, structuredClone(guard)]) expect(() => f.check(bad)).toThrow("loaded SHA-bound reference"); });
  it.each([403, 304])("holds an actual HTTP %s capture even with identical text", status_code => { const f = fixture(); expect(() => f.check(f.load(), { capture: { ...f.capture, status_code } })).toThrow("capture profile/URL/time mismatch"); });
  it.each([baseline.captured_at, "2026-10-18T11:59:59.999Z"])("holds an actual observation not strictly newer than the old baseline: %s", captured_at => { const f = fixture(); expect(() => f.check(f.load(), { capture: { ...f.capture, captured_at } })).toThrow("capture profile/URL/time mismatch"); });
  it.each([false, undefined, "true"])("requires explicit boolean refresh %s for crossing", baselineRefresh => { const f = fixture(); expect(() => f.check(f.load(), { baselineRefresh })).toThrow("explicit v2"); });
  it("does not alter same-profile ordinary daily or absent-baseline decisions", () => { for (const baseline of [null, { capture_profile: profile }]) expect(assertScraplingBaselineTransition({ baseline, baselineRefresh: false, captureProfile: profile })).toEqual({ required: false, factual_approval: false, migration_authority: false }); });
  it("exposes a boolean exact-refresh requirement and a pre-network reference check", () => {
    const f = fixture(); const guard = f.load(); expect(requiresScraplingBaselineTransition({ baseline, baselineRefresh: true, captureProfile: profile })).toBe(true);
    expect(requiresScraplingBaselineTransition({ baseline, baselineRefresh: false, captureProfile: profile })).toBe(false);
    expect(getScraplingBaselineTransitionReference({ guard, source, baseline, baselineRefresh: true, captureProfile: profile })).toBe(guard.sources[0]);
    expect(getScraplingBaselineTransitionReference({ baseline: null, captureProfile: profile })).toBeNull();
  });
  it.each(["capture_profile", "captured_at", "text_hash", "owner", "URL", "page_type"])("holds stale OLD baseline %s before capture", key => {
    const f = fixture(); const old = structuredClone(baseline); if (key === "owner") old.source.shared_award_id = "other"; else if (key === "URL") old.source.url += "/other"; else if (key === "page_type") old.source.page_type = "other"; else old[key] += "changed";
    expect(() => getScraplingBaselineTransitionReference({ guard: f.load(), source, baseline: old, baselineRefresh: true, captureProfile: profile })).toThrow("old baseline changed");
  });
  it.each(["source", "admin_review_status", "page_metadata", "reason", "admin_review_note", "admin_reviewed_by", "admin_reviewed_at", "page_metadata_generated_at", "page_metadata_model"])("holds fresh-source approval drift %s", key => {
    const f = fixture(); const after = structuredClone(source); after[key] = key === "page_metadata" ? { audience: "different" } : "changed";
    expect(() => f.check(f.load(), { sourceAfter: after })).toThrow("source identity/approval changed");
  });
  it("holds absent actual capture with a typed marker for non-health-mutation handling", () => {
    const f = fixture(); for (const capture of [null, undefined, {}]) { try { f.check(f.load(), { capture }); throw new Error("must hold"); } catch (error) { expect(error).toBeInstanceOf(ScraplingBaselineTransitionError); expect(error.scraplingBaselineTransitionHold).toBe(true); } }
  });
  it.each(["scrapling-evidence-v1", "scrapling-source-html-v1"])("leaves an existing %s workflow outside this v2-only proof (not permission)", captureProfile => {
    const f = fixture(); const guard = f.load(); expect(f.check(guard, { captureProfile })).toEqual({ required: false, factual_approval: false, migration_authority: false });
    expect(getScraplingBaselineTransitionReference({ guard, source, baseline, baselineRefresh: true, captureProfile })).toBeNull();
    expect(requiresScraplingBaselineTransition({ baseline, baselineRefresh: true, captureProfile })).toBe(false);
  });
  it.each([
    ["duplicate source", f => { f.data.sources.push(structuredClone(f.row)); }],
    ["source UUID", f => { f.row.source_id = "invalid"; }],
    ["owner UUID", f => { f.row.stored_owner_id = "INVALID"; }],
    ["wrong URL", f => { f.row.url = "https://user:password@example.edu/programme"; }],
    ["wrong target", f => { f.row.target_profile = "scrapling-evidence-v1"; }],
    ["reference time", f => { f.row.reference_captured_at = "later"; }],
    ["old baseline identity", f => { f.row.old_baseline.source_id = "other"; }],
    ["old baseline time", f => { f.row.old_baseline.captured_at = "2026-10-20T12:00:01.000Z"; }],
    ["old baseline equal to reference time", f => { f.row.old_baseline.captured_at = f.row.reference_captured_at; }],
    ["unknown field", f => { f.row.approval = true; }],
    ["empty rows", f => { f.data.sources = []; }],
    ["too many rows", f => { f.data.sources = Array(26).fill(f.row); }],
    ["missing artifact", f => { f.row.reference_artifacts.pop(); }],
    ["duplicate artifact role", f => { f.row.reference_artifacts[1].kind = "meta"; }],
    ["duplicate artifact path", f => { f.row.reference_artifacts[1].path = f.row.reference_artifacts[0].path; }],
    ["artifact drift", f => { writeFileSync(f.row.reference_artifacts[2].path, "different original"); }],
    ["oversized artifact", f => { f.row.reference_artifacts[3].byte_length = 32 * 1024 ** 2 + 1; }],
  ])("holds malformed reference %s", (_, change) => { const f = fixture(); change(f); expect(() => f.load()).toThrow(); });
  it("requires exact raw file SHA and canonical non-duplicate JSON", () => {
    const f = fixture(); const options = f.save(); expect(() => loadScraplingBaselineTransition({ ...options, sha256: "a".repeat(64) })).toThrow("file SHA256 mismatch");
    for (const raw of [Buffer.from(JSON.stringify(f.data)), Buffer.from('{"schema":"other","schema":"' + scraplingBaselineTransitionSchema + '","sources":[]}'), Buffer.from([255])]) { writeFileSync(f.path, raw); expect(() => loadScraplingBaselineTransition({ path: f.path, sha256: sha(raw) })).toThrow(); }
  });
  it.each(["meta owner", "meta URL", "meta time", "meta native", "text LF", "text body"])("holds well-hashed but contradictory %s", scenario => {
    const f = fixture(); const meta = structuredClone(f.capture); let raw;
    if (scenario === "meta owner") meta.source.shared_award_id = "32345678-1234-4234-8234-123456789012";
    if (scenario === "meta URL") meta.final_url += "?different=1";
    if (scenario === "meta time") meta.captured_at = "2026-10-20T12:00:01.000Z";
    if (scenario === "meta native") meta.scrapling.visible_text += " changed";
    const binding = f.row.reference_artifacts[scenario.startsWith("meta") ? 0 : 1];
    raw = scenario.startsWith("meta") ? Buffer.from(JSON.stringify(meta, null, 2)) : Buffer.from(scenario === "text LF" ? review : review + "different\n");
    writeFileSync(binding.path, raw); binding.byte_length = raw.length; binding.sha256 = sha(raw); expect(() => f.load()).toThrow();
  });
  it.each([403, 304])("holds a well-hashed HTTP %s reference artifact", status_code => { const f = fixture(); const raw = Buffer.from(JSON.stringify({ ...f.capture, status_code }, null, 2)); const binding = f.row.reference_artifacts[0]; writeFileSync(binding.path, raw); binding.sha256 = sha(raw); binding.byte_length = raw.length; expect(() => f.load()).toThrow("reference metadata identity/native binding"); });
  it("refuses a linked artifact and linked ancestor without following them", () => {
    const f = fixture(); const target = f.row.reference_artifacts[2]; const link = join(f.root, "linked-html");
    // Windows file symlinks require a privilege unavailable to ordinary workers.
    // A native junction exercises the same lstat link refusal without elevation.
    symlinkSync(process.platform === "win32" ? f.root : target.path, link, process.platform === "win32" ? "junction" : "file"); target.path = link; expect(() => f.load()).toThrow("file type/size");
    const parent = join(f.root, "directory"); mkdirSync(parent); const linked = join(f.root, "linked-directory"); symlinkSync(parent, linked, process.platform === "win32" ? "junction" : "dir"); const file = join(parent, "html"); writeFileSync(file, f.raws.html); target.path = join(linked, "html"); expect(() => f.load()).toThrow("linked reference ancestor");
  });
});
