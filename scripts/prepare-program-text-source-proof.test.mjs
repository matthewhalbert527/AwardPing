import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildProgramTextCapture } from "./lib/program-text-capture.mjs";
import { programTextReference } from "./lib/program-text-artifacts.mjs";
import { PROGRAM_TEXT_PUBLIC_DRIVE_PDF_VERSION, PROGRAM_TEXT_PUBLIC_DRIVE_PDF_FILE_IDS } from "./lib/program-text-public-drive-pdf.mjs";
import { parseProgramTextSourceProofArgs, runPrepareProgramTextSourceProof,
  validateProgramTextSourcePendingDescriptor } from "./prepare-program-text-source-proof.mjs";

const pendingId = "11111111-1111-4111-8111-111111111111", epoch = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333", owner = "44444444-4444-4444-8444-444444444444";
const revision = "55555555-5555-4555-8555-555555555555", inventoryId = "66666666-6666-4666-8666-666666666666";
const source = { id: sourceId, shared_award_id: owner, url: "https://example.edu/applicant-rules", title: "Official applicant rules",
  page_type: "eligibility", admin_review_status: "review_later", text_monitoring_state: { private_history: "must survive" } };
const args = ["--pending-id", pendingId];
const text = "Official applicant rules: students may apply by March 1, 2027. Keep the original source and its history.";
function makeCapture(options = {}) {
  const value = options.text ?? text;
  return buildProgramTextCapture({ source, final_url: source.url, captured_at: new Date().toISOString(), acquisition: "http_html",
    extractor: { name: "fixture", version: "1" }, raw_bytes: Buffer.from("<html><h1>Official applicant rules</h1><p>" + value + "</p></html>"),
    content_type: "text/html; charset=utf-8", text: value, blocks: [{ id: "block-1", text: value, start_utf16: 0, end_utf16: value.length }],
    completeness: { status: "complete", reasons: [] }, ...options });
}
function descriptor() {
  return { schema: "awardping.program-text-source-pending-capture.v1", id: pendingId, epoch, content_hash: "a".repeat(64),
    source: structuredClone(source), registration_scope: { kind: "legacy_roles" }, role_revisions: [{ source_role: "eligibility", revision }], proof: null };
}
function scenario({ pending = descriptor(), capture = makeCapture(), config = { schema: "awardping.program-text-monitoring.v1", epoch, sources: {} },
  getterError = false, recordError = false, cold = null, uploadRef = null, receiptMutation = null } = {}) {
  const calls = [], originalPending = structuredClone(pending);
  const runtime = { config, storage: { client: { fixture: true }, bucket: "fixture-private" },
    prepareCapture: async options => { calls.push(["prepare", options]); return { pythonPath: "owned-python", executablePath: "owned-browser", archiveRoot: "owned-private-archive" }; },
    close: async () => calls.push(["close"]),
    supabase: { rpc: async (name, payload) => {
      calls.push(["rpc", name, payload]);
      if (name === "get_program_text_source_pending_capture") return { data: structuredClone(pending), error: getterError ? { code: "40001", message: "SECRET provider changed" } : null };
      if (name !== "record_program_text_source_probe") throw new Error("Unexpected database mutation");
      if (recordError) return { error: { code: "40001", message: "SECRET compare-and-swap conflict" } };
      const data = { schema: "awardping.program-text-source-probe-receipt.v1", pending_id: pendingId, reference: payload.p_document.reference, content_hash: "f".repeat(64) };
      receiptMutation?.(data); return { data };
    } } };
  const adapters = { createRuntime: async parsed => { calls.push(["runtime", parsed]); return runtime; },
    captureSource: async input => { calls.push(["capture", input]); return capture; },
    retainCapture: (value, archive) => { calls.push(["retain", archive]); return { reference: programTextReference(value) }; },
    uploadCapture: async value => { calls.push(["upload"]); return uploadRef || programTextReference(value); },
    loadCapture: async ref => { calls.push(["load", ref]); return cold || capture; } };
  return { calls, adapters, runtime, pending, originalPending, capture };
}

describe("pending source proof arguments", () => {
  it("accepts only a pending request ID and optional existing environment path", () => {
    expect(parseProgramTextSourceProofArgs(["--pending-id=" + pendingId, "--env", "private.env"]))
      .toMatchObject({ pendingId, envPath: expect.stringMatching(/private[.]env$/) });
  });
  it.each([[], ["--pending-id", "bad"], ["--pending-id", "00000000-0000-0000-0000-000000000000"],
    [...args, "--pending-id=" + pendingId], [...args, "--env"], [...args, "--env=one", "--env=two"],
    [...args, "--url=https://example.edu"], [...args, "--source-id=" + sourceId], [...args, "--inventory-id=" + inventoryId],
    [...args, "--config=other.json"], [...args, "--apply=true"], [...args, "--mode=collect"], [...args, "--retry=1"],
    [...args, "--env", "bad\npath"], ["plain", pendingId]])("rejects unauthorized or ambiguous scope %# before runtime access", async argv => {
    let runtimeCalls = 0;
    await expect(runPrepareProgramTextSourceProof(argv, { createRuntime: async () => { runtimeCalls++; } })).rejects.toMatchObject({ proofCode: expect.any(String) });
    expect(runtimeCalls).toBe(0);
  });
});

describe("server-created pending descriptor contract", () => {
  it("accepts legacy role CAS and variation-inventory CAS as distinct descriptor shapes", () => {
    expect(validateProgramTextSourcePendingDescriptor(descriptor(), { pendingId, epoch }).source.id).toBe(sourceId);
    const value = descriptor(); value.registration_scope = { kind: "variation_inventory", inventory_id: inventoryId, revision }; value.role_revisions = [];
    expect(validateProgramTextSourcePendingDescriptor(value, { pendingId, epoch }).registration_scope.kind).toBe("variation_inventory");
  });
  it.each([
    value => { value.id = sourceId; }, value => { value.epoch = pendingId; }, value => { value.content_hash = "bad"; },
    value => { value.source.url = "http://example.edu/applicant-rules"; }, value => { value.source.url = "https://user:SECRET@example.edu/rules"; },
    value => { value.source.url += "#fragment"; }, value => { value.source.shared_award_id = "bad"; },
    value => { value.source.title = null; }, value => { value.source.text_monitoring_state = []; },
    value => { value.role_revisions = []; }, value => { value.role_revisions.push(value.role_revisions[0]); },
    value => { value.role_revisions[0].revision = "bad"; }, value => { value.registration_scope = { kind: "arbitrary" }; },
    value => { value.registration_scope = { kind: "variation_inventory", inventory_id: inventoryId, revision }; },
    value => { value.registration_scope = { kind: "variation_inventory", inventory_id: "bad", revision }; value.role_revisions = []; },
    value => { value.registration_scope = { kind: "legacy_roles", inventory_id: inventoryId }; },
    value => { value.proof = {}; }, value => { value.unapproved_url = "https://example.edu/other"; },
  ])("holds invalid identity, epoch, history or registration scope %#", change => {
    const value = descriptor(); change(value);
    expect(() => validateProgramTextSourcePendingDescriptor(value, { pendingId, epoch })).toThrow();
  });
});

describe("single-capture source proof preparation", () => {
  it("retains, uploads and cold-restores one complete capture before the sole pending-proof CAS", async () => {
    const s = scenario(), result = await runPrepareProgramTextSourceProof(args, s.adapters);
    expect(result.reused).toBe(false); expect(result.content_hash).toBe("f".repeat(64));
    expect(s.calls.map(call => call[0])).toEqual(["runtime", "rpc", "prepare", "capture", "retain", "upload", "load", "rpc", "close"]);
    const writes = s.calls.filter(call => call[0] === "rpc" && call[1] === "record_program_text_source_probe");
    expect(writes).toHaveLength(1); expect(writes[0][2]).toMatchObject({ p_pending_id: pendingId, p_expected_hash: "a".repeat(64) });
    expect(Object.keys(writes[0][2].p_document).sort()).toEqual(["blocks", "blocks_json", "reference", "text"]);
    expect(JSON.parse(writes[0][2].p_document.blocks_json)).toEqual(s.capture.blocks);
    expect(writes[0][2].p_document.blocks_json).toBe(JSON.stringify(s.capture.blocks.map(block =>
      Object.fromEntries(Object.keys(block).sort().map(key => [key, block[key]])))));
    expect(s.pending).toEqual(s.originalPending);
    expect(s.calls.find(call => call[0] === "capture")[1]).toMatchObject({ source, acquisition: "http_html", timeoutMs: 90000, pdf_transport: "http" });
  });
  it("uses a bound rendered override without enabling diagnostics or a fallback", async () => {
    const config = { schema: "awardping.program-text-monitoring.v1", epoch, sources: { [sourceId]: { source_url: source.url, shared_award_id: owner, acquisition: "rendered_html" } } };
    const s = scenario({ config, capture: makeCapture({ acquisition: "rendered_html" }) }); await runPrepareProgramTextSourceProof(args, s.adapters);
    const options = s.calls.find(call => call[0] === "capture")[1];
    expect(options.acquisition).toBe("rendered_html"); expect(options).not.toHaveProperty("browserDiagnostics");
  });
  it("accepts a variation-only target without injecting it into legacy roles", async () => {
    const pending = descriptor(); pending.registration_scope = { kind: "variation_inventory", inventory_id: inventoryId, revision }; pending.role_revisions = [];
    const s = scenario({ pending }); await runPrepareProgramTextSourceProof(args, s.adapters);
    expect(s.calls.filter(call => call[0] === "capture")).toHaveLength(1);
    expect(s.calls.filter(call => call[0] === "rpc").map(call => call[1])).toEqual(["get_program_text_source_pending_capture", "record_program_text_source_probe"]);
  });
  it("selects one native PDF acquisition for a PDF descriptor without automatic OCR", async () => {
    const pending = descriptor(); pending.source = { ...pending.source, page_type: "pdf", url: "https://example.edu/rules.pdf" };
    const capture = makeCapture({ source: pending.source, final_url: pending.source.url, acquisition: "pdf_text",
      content_type: "application/pdf", raw_bytes: Buffer.from("%PDF-1.7\nPrivate fixture only"),
      blocks: [{ id: "page-1-block-1", text, start_utf16: 0, end_utf16: text.length, page: 1, kind: "pdf_page" }] });
    const s = scenario({ pending, capture }); await runPrepareProgramTextSourceProof(args, s.adapters);
    expect(s.calls.find(call => call[0] === "capture")[1]).toMatchObject({ acquisition: "pdf_text", pdf_transport: "http" });
    expect(s.calls.filter(call => call[0] === "capture")).toHaveLength(1);
  });
  it.each([false, true])("accepts only a source-bound finite Drive redirect for a %s saved proof", async saved => {
    const pending = descriptor(), fileId = PROGRAM_TEXT_PUBLIC_DRIVE_PDF_FILE_IDS[0];
    pending.source = { ...pending.source, page_type: "pdf", url: `https://drive.usercontent.google.com/uc?id=${fileId}&export=download` };
    // Injected capture fixture tests the pending-proof boundary only. The
    // separate native-transport suite really parses valid all-page PDFs.
    const capture = makeCapture({ source: pending.source,
      final_url: `https://drive.usercontent.google.com/download?id=${fileId}&export=download`, acquisition: "pdf_text",
      extractor: { name: "pdf-parse", version: PROGRAM_TEXT_PUBLIC_DRIVE_PDF_VERSION }, content_type: "application/octet-stream",
      raw_bytes: Buffer.from("%PDF-1.7\nInjected proof-boundary fixture\n%%EOF\n"),
      blocks: [{ id: "page-1-block-1", text, start_utf16: 0, end_utf16: text.length, page: 1, kind: "pdf_page" }] });
    if (saved) pending.proof = { reference: programTextReference(capture), content_hash: "e".repeat(64) };
    const s = scenario({ pending, capture }), result = await runPrepareProgramTextSourceProof(args, s.adapters);
    expect(result.reused).toBe(saved);
    expect(result.reference.final_url).toBe(capture.final_url);
    expect(result.reference.source.url).toBe(pending.source.url);
    expect(result.reference.artifacts.raw.content_type).toBe("application/octet-stream");
    expect(s.calls.filter(call => call[0] === "capture")).toHaveLength(saved ? 0 : 1);
    expect(s.pending).toEqual(s.originalPending);
  });
  it("cold-verifies an existing immutable proof without capture, upload, retention or DB mutation", async () => {
    const capture = makeCapture(), pending = descriptor(); pending.proof = { reference: programTextReference(capture), content_hash: "e".repeat(64) };
    const s = scenario({ pending, capture }), result = await runPrepareProgramTextSourceProof(args, s.adapters);
    expect(result.reused).toBe(true); expect(result.content_hash).toBe("e".repeat(64));
    expect(s.calls.map(call => call[0])).toEqual(["runtime", "rpc", "load", "close"]);
  });
  it("does not retry or capture when the admin-created descriptor is stale or unavailable", async () => {
    const s = scenario({ getterError: true });
    await expect(runPrepareProgramTextSourceProof(args, s.adapters)).rejects.toMatchObject({ proofCode: "pending_request_rejected" });
    expect(s.calls.map(call => call[0])).toEqual(["runtime", "rpc", "close"]);
  });
  it("does not recapture or write if a saved immutable proof cannot be restored", async () => {
    const capture = makeCapture(), pending = descriptor(); pending.proof = { reference: programTextReference(capture), content_hash: "e".repeat(64) };
    const s = scenario({ pending, capture }); s.adapters.loadCapture = async () => { throw new Error("saved original unavailable"); };
    await expect(runPrepareProgramTextSourceProof(args, s.adapters)).rejects.toThrow("saved original unavailable");
    expect(s.calls.map(call => call[0])).toEqual(["runtime", "rpc", "close"]);
  });
  it.each(["url", "owner", "unbound", "ocr"])("holds an invalid %s override before capture", async kind => {
    const config = { schema: "awardping.program-text-monitoring.v1", epoch, sources: { [sourceId]: { source_url: source.url, shared_award_id: owner, acquisition: "rendered_html" } } };
    if (kind === "url") config.sources[sourceId].source_url += "/changed";
    if (kind === "owner") config.sources[sourceId].shared_award_id = pendingId;
    if (kind === "unbound") delete config.sources[sourceId].shared_award_id;
    if (kind === "ocr") config.sources[sourceId].acquisition = "pdf_ocr";
    const s = scenario({ config }); await expect(runPrepareProgramTextSourceProof(args, s.adapters)).rejects.toThrow();
    expect(s.calls.some(call => call[0] === "capture")).toBe(false);
  });
  it("holds incomplete capture before private retention, upload or mutation", async () => {
    const s = scenario({ capture: makeCapture({ completeness: { status: "incomplete", reasons: ["rendered_live_content_not_observed"] } }) });
    await expect(runPrepareProgramTextSourceProof(args, s.adapters)).rejects.toMatchObject({ proofCode: "capture_incomplete" });
    expect(s.calls.map(call => call[0])).toEqual(["runtime", "rpc", "prepare", "capture", "close"]);
  });
  it("holds a valid capture for a different identity or final URL before retention", async () => {
    const other = { ...source, url: "https://example.edu/different" };
    const s = scenario({ capture: makeCapture({ source: other, final_url: other.url }) });
    await expect(runPrepareProgramTextSourceProof(args, s.adapters)).rejects.toMatchObject({ proofCode: "proof_source_mismatch" });
    expect(s.calls.some(call => call[0] === "retain")).toBe(false);
  });
  it("holds a mismatched acquisition even when the returned capture is otherwise valid", async () => {
    const config = { schema: "awardping.program-text-monitoring.v1", epoch, sources: { [sourceId]: { source_url: source.url, shared_award_id: owner, acquisition: "rendered_html" } } };
    const s = scenario({ config });
    await expect(runPrepareProgramTextSourceProof(args, s.adapters)).rejects.toMatchObject({ proofCode: "capture_acquisition_mismatch" });
    expect(s.calls.some(call => call[0] === "retain")).toBe(false);
  });
  it.each(["retainCapture", "uploadCapture"])("holds on %s failure without a pending receipt write or retry", async method => {
    const s = scenario(); s.adapters[method] = async () => { throw new Error("fixture storage unavailable"); };
    // Retention is a synchronous create-only operation in the real adapter.
    if (method === "retainCapture") s.adapters[method] = () => { throw new Error("fixture storage unavailable"); };
    await expect(runPrepareProgramTextSourceProof(args, s.adapters)).rejects.toThrow("fixture storage unavailable");
    expect(s.calls.filter(call => call[0] === "rpc")).toHaveLength(1);
    expect(s.calls.filter(call => call[0] === "capture")).toHaveLength(1);
    expect(s.pending).toEqual(s.originalPending);
  });
  it("preserves astral text offsets and recursively canonical blocks without truncation", async () => {
    const unicode = "Award 😀 rules: students may apply. Full retained text and offsets remain unchanged.";
    const capture = makeCapture({ text: unicode, blocks: [{ text: unicode, end_utf16: unicode.length, start_utf16: 0, id: "block-1",
      context: { table_row: [], list_path: [], heading_path: [{ text: "Award 😀", level: 1 }] } }] });
    const s = scenario({ capture }); await runPrepareProgramTextSourceProof(args, s.adapters);
    const document = s.calls.find(call => call[0] === "rpc" && call[1] === "record_program_text_source_probe")[2].p_document;
    expect(document.text).toBe(unicode); expect(document.blocks[0].end_utf16).toBe(unicode.length);
    expect(JSON.parse(document.blocks_json)).toEqual(document.blocks);
    expect(document.blocks_json).toContain('"heading_path":[{"level":1,"text":"Award 😀"}]');
  });
  it("refuses cold-original mismatch before the pending receipt write", async () => {
    const s = scenario({ cold: makeCapture({ text: text.replace("2027", "2028") }) });
    await expect(runPrepareProgramTextSourceProof(args, s.adapters)).rejects.toThrow();
    expect(s.calls.filter(call => call[0] === "rpc")).toHaveLength(1);
  });
  it("refuses mismatched uploaded reference without a receipt write", async () => {
    const ref = programTextReference(makeCapture()); ref.capture_id = "b".repeat(64);
    const s = scenario({ uploadRef: ref });
    await expect(runPrepareProgramTextSourceProof(args, s.adapters)).rejects.toMatchObject({ proofCode: "uploaded_reference_mismatch" });
    expect(s.calls.some(call => call[0] === "load")).toBe(false);
  });
  it("leaves immutable uploaded artifacts and source history intact on CAS failure; never retries", async () => {
    const s = scenario({ recordError: true });
    await expect(runPrepareProgramTextSourceProof(args, s.adapters)).rejects.toMatchObject({ proofCode: "pending_request_rejected" });
    expect(s.calls.filter(call => call[0] === "capture")).toHaveLength(1);
    expect(s.calls.filter(call => call[0] === "upload")).toHaveLength(1);
    expect(s.calls.filter(call => call[0] === "rpc")).toHaveLength(2);
    expect(s.pending.source.text_monitoring_state).toEqual({ private_history: "must survive" });
  });
  it("rejects an unexpected server receipt without claiming success", async () => {
    const s = scenario({ receiptMutation: value => { value.pending_id = sourceId; } });
    await expect(runPrepareProgramTextSourceProof(args, s.adapters)).rejects.toMatchObject({ proofCode: "invalid_probe_receipt" });
  });
  it("contains no monitor, queue, provider, publication, source-state or scheduler mutation path", () => {
    const code = readFileSync(new URL("./prepare-program-text-source-proof.mjs", import.meta.url), "utf8");
    expect(code).not.toMatch(/monitorProgramTextSource|finalizeProgramTextReview|submitProgramTextBatch|pollProgramTextBatch|\.from\(|\.update\(|\.delete\(|\.insert\(|Start-ScheduledTask|Install-AwardPingWorker/);
    expect([...code.matchAll(/rpc\("([a-z_]+)"/g)].map(match => match[1])).toEqual(["get_program_text_source_pending_capture", "record_program_text_source_probe"]);
  });
});
