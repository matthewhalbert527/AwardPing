import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const worker = readFileSync(new URL("./capture-visual-snapshots.mjs", import.meta.url), "utf8");
function body(name, nextName) {
  const start = worker.indexOf(`function ${name}(`);
  const end = worker.indexOf(`function ${nextName}(`, start + 1);
  if (start < 0 || end < 0) throw new Error("Worker function boundary missing");
  return worker.slice(start, end).replace(/async\s*$/, "");
}

function fixture(status, options = {}) {
  const comparison = { status, reason: "tested_reason", publishable: false, baseline_advance_allowed: false,
    ...(status === "changed_needs_review" ? { diff: { added_text: ["Full current prose"], removed_text: ["Full previous prose"] },
      deterministic: { candidate_change: true, classification: "candidate_change" } } : {}),
  };
  const report = { unchanged: 0, candidate_changes: 0, review: 0, review_paths: [],
    scrapling: { checked: 0, unchanged: 0, changed_needs_review: 0, manual_review_required: 0, unavailable: 0, reasons: {} } };
  const deps = {
    buildScraplingReviewDiff: vi.fn(() => comparison),
    incrementCounterObject: (obj, key) => { obj[key] = (obj[key] || 0) + 1; },
    markSharedSourceVisualCheckSucceeded: vi.fn(async () => {}),
    console: { log: vi.fn() }, sourceLabel: () => "source", keepUnchanged: false,
    removeGeneratedCaptureDir: vi.fn(),
    saveReviewRecord: vi.fn(() => "review.json"), toArchiveRelative: path => path,
    gateVisualReviewCandidateForAi: vi.fn(() => ({ allowed: options.gateAllowed !== false,
      decision: { reason: "legacy_noise" }, deterministic: { candidate_change: true } })),
    interpretVisualChanges: options.reviewEnabled !== false,
    visualReviewMode: options.mode || "batch",
    enqueueVisualReviewCandidate: vi.fn(async () => options.queueResult || { id: "candidate" }),
  };
  const invoke = new Function(...Object.keys(deps), `return async ${body("processScraplingComparison", "processTextOnlyComparison")}`)(...Object.values(deps));
  const source = { id: "source" }, baseline = { image_hash: "previous-image" }, previous = { text: "previous" };
  const capture = { dir: "current", image_hash: options.sameImage ? "previous-image" : "current-image" };
  return { deps, report, comparison, run: () => invoke(source, baseline, previous, capture, report) };
}

describe("Scrapling daily worker dispatch", () => {
  it("keeps both browser evidence profiles outside legacy HTML diagnostics and redirect rewriting", () => {
    expect(worker).toContain("![SCRAPLING_WORKER_PROFILE, SCRAPLING_WORKER_PROFILE_V2, SOURCE_HTML_PROFILE].includes(capture.capture_profile)");
    const configured = body("captureConfiguredScraplingSource", "captureSource");
    expect(configured).toContain("maybeRecordDiscoveredPdfSources(source, discovery, { profile: capture.capture_profile }, report)");
    for (const profile of ["scrapling-evidence-v1", "scrapling-evidence-v2"]) {
      const metadata = { captured_at: "2026-10-20T12:00:00.000Z", source: { id: "fixture" } };
      const deps = {
        SOURCE_HTML_PROFILE: "scrapling-source-html-v1",
        SCRAPLING_WORKER_PROFILE: "scrapling-evidence-v1",
        SCRAPLING_WORKER_PROFILE_V2: "scrapling-evidence-v2",
        fromArchiveRelative: value => value,
        compareRetainedHtmlCaptures: vi.fn(() => { throw new Error("legacy diagnostic must not run"); }),
        readJsonIfExists: vi.fn(() => metadata), atomicWriteJson: vi.fn(), archiveRoot: "fixture", baselineRefresh: false,
        incrementCounterObject: (obj, key) => { obj[key] = (obj[key] || 0) + 1; },
      };
      const invoke = new Function(...Object.keys(deps), `return ${body("attachHtmlComparisonDiagnostic", "captureR2Files")}`)(...Object.values(deps));
      const capture = { kind: "webpage", capture_profile: profile, captured_at: metadata.captured_at, meta_path: "new-meta.json" };
      const report = { html_comparison: { checked: 0, unavailable: 0, reasons: {} } };
      invoke({ id: "fixture" }, null, capture, report);
      expect(deps.compareRetainedHtmlCaptures).not.toHaveBeenCalled();
      expect(capture.html_comparison).toEqual({ status: "unavailable", reason: "separate_scrapling_semantic_review", publishable: false });
      expect(deps.atomicWriteJson).toHaveBeenCalledExactlyOnceWith("new-meta.json", { ...metadata, html_comparison: capture.html_comparison });
      expect(report.html_comparison).toMatchObject({ checked: 1, unavailable: 1, reasons: { separate_scrapling_semantic_review: 1 } });
    }
  });
  it("verifies the exact installed runtime binding before loading an opt-in manifest", () => {
    const verification = worker.indexOf("verifyScraplingRuntimeBinding({ appDir: root, manifestPath: scraplingManifestPath, pythonPath: scraplingPythonPath })");
    expect(verification).toBeGreaterThan(worker.indexOf("const scraplingPythonPath ="));
    expect(verification).toBeLessThan(worker.indexOf("loadScraplingSourceManifest(scraplingManifestPath)"));
    expect(worker).toContain('from "./lib/scrapling-runtime-binding.mjs"');
    expect(worker).not.toContain("Scrapling requires an installed, pinned Python runtime at an explicit absolute path.");
  });
  it("is explicitly opted in and exact manifest matching precedes collection", () => {
    expect(worker).toContain('loadScraplingSourceManifest(scraplingManifestPath)');
    const source = body("processSourceUnlocked", "stage1EvidenceSchemaUpgradeOperationInterfaces");
    expect(source.indexOf("selectScraplingSource(source, scraplingManifest)")).toBeLessThan(source.indexOf("await captureConfiguredScraplingSource"));
    expect(source.indexOf("assertScraplingBaselineCompatibility")).toBeLessThan(source.indexOf("await captureConfiguredScraplingSource"));
    expect(source).toContain("pdfSource ? null : selectScraplingSource");
  });
  it("routes before legacy hash, behavior refresh, section and noise logic", () => {
    const call = worker.indexOf("await processScraplingComparison(source, baseline, previous, capture, report)");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(worker.indexOf("const hashComparison = compareStableCaptureHashes(baseline, capture"));
    const comparison = body("processScraplingComparison", "processTextOnlyComparison");
    expect(comparison).not.toMatch(/writeBaseline|finishSafeDeterministicNoise|classifyDeterministicChange|buildDiffSummary|maybeSyncR2Snapshot|maybeExtractBaselineFacts/);
  });
  it("refuses unsupported maintenance rather than silently claiming coverage", () => {
    expect(worker).toContain("localizationRepair || extractBaselineInfo || backfillBaselineInfo || discoverHtmlSubpages || stage1EvidenceSchemaUpgrade");
    expect(worker).toContain("Scrapling rollout cannot replace the separate reviewed Stage 1 baseline activation protocol");
    const capture = body("captureConfiguredScraplingSource", "captureSource");
    expect(capture.indexOf("await finalizeCaptureNetworkBoundary")).toBeLessThan(capture.indexOf("await captureScraplingWorkerSource"));
    expect(capture).toContain("discovery.scanComplete = false");
    expect(capture).toContain("scrapling_passive_main_document_only");
  });
  it("retains HTML in manual review bundles alongside complete text", () => {
    const copy = body("copyEvidenceFiles", "writeBaseline");
    expect(copy).toContain('copyIfPresent("previous_html", previous.htmlPath');
    expect(copy).toContain('copyIfPresent("new_html", capture.html_path');
  });
  it("seals the actual capture version in new candidates without changing legacy fallbacks", () => {
    const queue = body("enqueueVisualReviewCandidate", "beginStage1CandidateMutationAccounting");
    expect(queue).toContain("capture?.capture_behavior_version ?? captureBehaviorVersion");
    expect(queue).toContain("capture?.capture_behavior_name || captureBehaviorName");
    expect(queue.match(/behaviorVersion: candidateCaptureBehaviorVersion/g)).toHaveLength(3);
    expect(queue).toContain("capture_behavior_version: candidateCaptureBehaviorVersion");
    expect(queue).toContain("capture_profile: capture?.capture_profile || null");
    expect(queue).not.toContain("behaviorVersion: captureBehaviorVersion");
  });
});

describe("Scrapling semantic review outcomes", () => {
  it("does not advance a baseline or review images when HTML semantics are unchanged", async () => {
    const f = fixture("unchanged"); await f.run();
    expect(f.report.unchanged).toBe(1);
    expect(f.deps.enqueueVisualReviewCandidate).not.toHaveBeenCalled();
    expect(f.deps.saveReviewRecord).not.toHaveBeenCalled();
    expect(f.deps.console.log).toHaveBeenCalledWith(expect.stringContaining("html_source_semantics_only"));
    expect(f.deps.removeGeneratedCaptureDir).toHaveBeenCalledWith("current");
  });
  it("retains both captures for a proven honeypot-only change during normal daily cleanup", async () => {
    const f = fixture("unchanged");
    Object.assign(f.comparison, { reason: "gravity_forms_honeypot_label_only", retain_both_captures: true });
    await f.run();
    expect(f.report.unchanged).toBe(1);
    expect(f.deps.markSharedSourceVisualCheckSucceeded).toHaveBeenCalledOnce();
    expect(f.deps.removeGeneratedCaptureDir).not.toHaveBeenCalled();
    expect(f.deps.enqueueVisualReviewCandidate).not.toHaveBeenCalled();
    expect(f.deps.saveReviewRecord).not.toHaveBeenCalled();
  });
  it("retains structural changes for manual review without noise rejection", async () => {
    const f = fixture("manual_review_required"); await f.run();
    expect(f.deps.saveReviewRecord).toHaveBeenCalledWith(expect.objectContaining({ diff: { scrapling_comparison: f.comparison } }));
    expect(f.report.review_paths).toEqual(["review.json"]);
    expect(f.deps.gateVisualReviewCandidateForAi).not.toHaveBeenCalled();
    expect(f.deps.removeGeneratedCaptureDir).not.toHaveBeenCalled();
  });
  it("retains invalid evidence and reports failure instead of a successful check", async () => {
    const f = fixture("unavailable"); await expect(f.run()).rejects.toThrow("Scrapling comparison unavailable");
    expect(f.deps.saveReviewRecord).toHaveBeenCalledOnce();
    expect(f.deps.markSharedSourceVisualCheckSucceeded).not.toHaveBeenCalled();
    expect(f.deps.enqueueVisualReviewCandidate).not.toHaveBeenCalled();
  });
  it.each([{ gateAllowed: false }, { reviewEnabled: false }, { mode: "inline" }])("holds complete prose when queue approval is unavailable %j", async options => {
    const f = fixture("changed_needs_review", options); await f.run();
    expect(f.deps.saveReviewRecord).toHaveBeenCalledOnce();
    expect(f.deps.enqueueVisualReviewCandidate).not.toHaveBeenCalled();
    expect(f.deps.removeGeneratedCaptureDir).not.toHaveBeenCalled();
  });
  it.each([false, true])("queues full bounded prose through existing gates; same image=%s", async sameImage => {
    const f = fixture("changed_needs_review", { sameImage }); await f.run();
    expect(f.deps.gateVisualReviewCandidateForAi).toHaveBeenCalledOnce();
    expect(f.deps.enqueueVisualReviewCandidate).toHaveBeenCalledWith(expect.objectContaining({ diff: f.comparison.diff,
      deterministic: expect.objectContaining({ screenshot_changed: !sameImage, text_only: sameImage, visibility_verified: false, baseline_advance_allowed: false }) }));
    expect(f.deps.removeGeneratedCaptureDir).not.toHaveBeenCalled();
  });
  it("does not remove evidence or advance baseline after a rejection ledger match", async () => {
    const f = fixture("changed_needs_review", { queueResult: { absorbed: true } }); await f.run();
    expect(f.deps.removeGeneratedCaptureDir).not.toHaveBeenCalled();
  });
});
