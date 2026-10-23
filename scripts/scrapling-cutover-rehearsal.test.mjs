import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicWriteJson } from "./lib/visual-baseline-lock.mjs";
import { SOURCE_HTML_PROFILE } from "./lib/source-html-evidence.mjs";
import {
  assertScraplingBaselineCompatibility, SCRAPLING_WORKER_PROFILE,
  selectScraplingSource, validateScraplingSourceManifest,
} from "./lib/scrapling-worker.mjs";
import { getScraplingBaselineTransitionReference, ScraplingBaselineTransitionError } from "./lib/scrapling-baseline-transition.mjs";

// Execute the current worker's orchestration, writer and restoration functions,
// not its CLI (which loads live credentials). All remote boundaries are fakes.
// Capture decoding/retention and real HTML comparison have separate contract
// suites; this rehearsal does not claim a real R2 transaction or AI review.
const worker = readFileSync(new URL("./capture-visual-snapshots.mjs", import.meta.url), "utf8");
function workerFunction(name, nextName, asynchronous = false) {
  const start = worker.indexOf(`function ${name}(`);
  const end = worker.indexOf(`function ${nextName}(`, start + 1);
  if (start < 0 || end <= start) throw new Error(`Missing worker boundary: ${name}`);
  return `${asynchronous ? "async " : ""}${worker.slice(start, end).replace(/async\s*$/, "")}`;
}
const functions = [
  workerFunction("processSourceUnlocked", "stage1EvidenceSchemaUpgradeOperationInterfaces", true),
  workerFunction("writeBaseline", "buildBaselineRecord"),
  workerFunction("restoreBaselineAfterFailedStage1Activation", "buildStage1BaselineActivationPersistenceEvidence"),
  workerFunction("requireR2SnapshotForBaseline", "maybeRepairMissingR2Snapshot", true),
  workerFunction("maybeSyncR2Snapshot", "recordR2CleanupDebt", true),
  workerFunction("maybeExtractBaselineFacts", "extractBaselineFactsWithGemini", true),
  workerFunction("processScraplingComparison", "processTextOnlyComparison", true),
  workerFunction("sourceMetadata", "sourceLabel"),
  workerFunction("isPdfSource", "readJsonIfExists"),
  workerFunction("readJsonIfExists", "toArchiveRelative"),
  workerFunction("toArchiveRelative", "fromArchiveRelative"),
].join("\n");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const prefix = join(tmpdir(), "awardping-cutover-rehearsal-");
    if (!resolve(root).startsWith(resolve(prefix))) throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
const hash = value => createHash("sha256").update(value).digest("hex");
const awardIds = Array.from({ length: 25 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
const source = {
  id: "10000000-0000-4000-8000-000000000000", shared_award_id: awardIds[0],
  url: "https://example.edu/award", title: "Offline rehearsal award", page_type: "eligibility",
  admin_review_status: "open", admin_reviewed_by: "fixture@example.edu", admin_review_note: "owner-reviewed",
};
const initialTime = "2026-10-15T12:00:00.000Z";
const nextTime = "2026-10-16T12:00:00.000Z";
const unexpected = name => vi.fn(() => { throw new Error(`Unexpected boundary: ${name}`); });

function fixture({ initialProfile = "stable-daily", useScrapling = true, refresh = true,
  persisted = true, persistenceEnabled = true, hasBaseline = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "awardping-cutover-rehearsal-"));
  roots.push(root);
  const baselinePath = join(root, "sources", source.id, "baseline.json");
  const readBaseline = () => existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
  const retainedFiles = [];
  function capture(profile, time) {
    const dir = join(root, "sources", source.id, "captures", `${profile}-${time.replace(/[:.]/g, "-")}`);
    mkdirSync(dir, { recursive: true });
    // Deliberately plain fixture bytes, not a claim of validated screenshot data.
    const files = { text: "Applicants must be juniors. Deadline October 31, 2026.",
      html: "<main><p>Applicants must be juniors. Deadline October 31, 2026.</p></main>",
      page: "synthetic screenshot boundary", meta: JSON.stringify({ fixture: true, profile, time }) };
    const paths = {};
    for (const [name, bytes] of Object.entries(files)) {
      const path = join(dir, `${name}.fixture`);
      writeFileSync(path, bytes, { flag: "wx" });
      paths[`${name}_path`] = path;
      retainedFiles.push({ path, sha256: hash(bytes) });
    }
    return { ...paths, dir, kind: "webpage", capture_profile: profile, captured_at: time,
      final_url: source.url, page_title: source.title, text: files.text, text_hash: hash(files.text),
      image_hash: hash(files.page), text_length: files.text.length, dimensions: { width: 1280, height: 900 },
      html_capture: { status: "captured", sha256: hash(files.html) } };
  }
  const report = { checked: 0, baselined: 0, unchanged: 0, candidate_changes: 0, review: 0, review_paths: [],
    r2_uploaded: 0, r2_rotated: 0, r2_previous_snapshots_reset: 0, r2_failed: 0, errors: [],
    scrapling: { checked: 0, unchanged: 0, changed_needs_review: 0, manual_review_required: 0, unavailable: 0, reasons: {} } };
  const events = [];
  let pendingCapture;
  const deps = {
    SOURCE_HTML_PROFILE, SCRAPLING_WORKER_PROFILE,
    // This legacy v1 rehearsal has no pinned v2 transition. Use the actual
    // imported preflight, just as the worker does with its default null guard.
    getScraplingBaselineTransitionReference, ScraplingBaselineTransitionError, scraplingBaselineTransition: null,
    archiveRoot: root, dirname, relative, resolve, mkdirSync, readFileSync, existsSync, rmSync, atomicWriteJson,
    baselinePathForSource: id => join(root, "sources", id, "baseline.json"),
    localBaselineEvidenceCache: new Map(),
    captureBehaviorVersion: 1, captureBehaviorName: "fixture", captureProfile: "stable-daily",
    sectionExtractionProfile: "fixture", aiProvider: "none", aiModel: null,
    baselineRefresh: refresh, stage1EvidenceSchemaUpgrade: false, initialOfficialDocumentMaterialization: false,
    localizationRepair: false, extractBaselineInfo: false, backfillBaselineInfo: false, discoverHtmlSubpages: false,
    sourceIdFilter: source.id, r2SnapshotSync: persistenceEnabled, keepUnchanged: true,
    forceR2SnapshotRefresh: false, existingR2SnapshotSourceIds: new Set(),
    recordR2CleanupDebt: vi.fn(), errorMessage: error => error.message,
    shouldBlockOrdinaryProcessingForStage1UpgradeRecovery: () => false,
    cleanText: value => String(value || "").trim(),
    maybeRehydrateIncompleteLocalBaseline: async (_source, baseline) => ({ baseline }),
    baselineEvidenceStatus: baseline => ({ ok: Boolean(baseline?.capture?.text && existsSync(join(root, baseline.capture.text))) }),
    loadSharedSourceReviewState: vi.fn(async () => ({ admin_review_status: "open" })),
    isStage1PendingBaselineActivationSource: () => false, isFirstCaptureCandidateAcquisition: () => false,
    selectScraplingSource, assertScraplingBaselineCompatibility,
    scraplingManifest: useScrapling ? validateScraplingSourceManifest({
      schema: "awardping.scrapling-source-manifest.v1", profile: SCRAPLING_WORKER_PROFILE,
      reviewed_at: initialTime, award_ids: awardIds,
      sources: [{ id: source.id, award_id: source.shared_award_id, url: source.url, kind: "html", roles: ["eligibility"] }],
    }) : null,
    captureConfiguredScraplingSource: vi.fn(async () => { events.push("capture"); return pendingCapture; }),
    captureSource: vi.fn(async () => { events.push("capture"); return pendingCapture; }),
    attachHtmlComparisonDiagnostic: vi.fn(),
    materializeRetainedCaptureAuthority: vi.fn((_source, item) => {
      for (const path of [item.text_path, item.meta_path, item.html_path, item.page_path]) {
        if (!existsSync(path)) throw new Error("Fixture retained artifact is missing");
      }
      return { authoritative: { layout_retained: false } };
    }),
    assertAiAvailable: unexpected("baseline AI request"),
    syncR2SnapshotPair: vi.fn(async () => {
      events.push("persistence");
      // Observe the actual new local baseline before acknowledging storage.
      expect(readBaseline()?.capture_profile).toBe(pendingCapture.capture_profile);
      if (!persisted) throw new Error("Simulated authoritative storage failure");
      return { uploaded: 5, rotated: 1 };
    }),
    markSharedSourceVisualCheckSucceeded: vi.fn(async () => { events.push("health_success"); }),
    maybeEnqueueInitialOfficialDocumentCandidate: vi.fn(async () => null),
    readBaselineEvidence: baseline => ({ ok: true, text: readFileSync(join(root, baseline.capture.text), "utf8") }),
    buildScraplingReviewDiff: vi.fn(() => ({ status: "unchanged", reason: "fixture_unchanged", publishable: false })),
    incrementCounterObject: (object, key) => { object[key] = (object[key] || 0) + 1; },
    enqueueVisualReviewCandidate: unexpected("public candidate queue"),
    gateVisualReviewCandidateForAi: unexpected("AI review gate"),
    saveReviewRecord: unexpected("review record"),
    removeGeneratedCaptureDir: unexpected("capture deletion"),
    compareStableCaptureHashes: unexpected("legacy comparison"),
    sourceLabel: () => "offline fixture", console: { log: vi.fn() },
  };
  const runtime = runInNewContext(`${functions}\n({ processSourceUnlocked, writeBaseline })`, deps, { timeout: 1000 });
  if (hasBaseline) {
    runtime.writeBaseline(source, capture(initialProfile, initialTime), {
      reason: "fixture_existing_baseline", baseline_facts: { deadline: "October 31, 2026" },
    });
  }
  const original = readBaseline();
  pendingCapture = capture(useScrapling ? SCRAPLING_WORKER_PROFILE : "stable-daily", nextTime);
  return { root, baselinePath, deps, report, events, original, readBaseline,
    get capture() { return pendingCapture; },
    setCaptureTime(time) { pendingCapture.captured_at = time; },
    run: (overrides = {}) => runtime.processSourceUnlocked({ ...source, ...overrides }, null, null, report),
    assertEvidencePreserved() {
      for (const file of retainedFiles) expect(hash(readFileSync(file.path))).toBe(file.sha256);
    },
    assertNoPublication() {
      expect(deps.enqueueVisualReviewCandidate).not.toHaveBeenCalled();
      expect(deps.gateVisualReviewCandidateForAi).not.toHaveBeenCalled();
      expect(deps.assertAiAvailable).not.toHaveBeenCalled();
      expect(deps.maybeEnqueueInitialOfficialDocumentCandidate).not.toHaveBeenCalled();
      expect(report.candidate_changes).toBe(0);
    },
  };
}

describe("offline actual-worker baseline-only cutover rehearsal", () => {
  it.each([
    { initialProfile: "stable-daily", useScrapling: true },
    { initialProfile: SCRAPLING_WORKER_PROFILE, useScrapling: false },
  ])("blocks cross-profile comparison before capture: %j", async options => {
    const f = fixture({ ...options, refresh: false });
    await expect(f.run()).rejects.toThrow("baseline-only");
    expect(f.deps.captureConfiguredScraplingSource).not.toHaveBeenCalled();
    expect(f.deps.captureSource).not.toHaveBeenCalled();
    expect(f.readBaseline()).toEqual(f.original);
    expect(f.events).toEqual([]);
    f.assertEvidencePreserved(); f.assertNoPublication();
  });

  it.each([
    { initialProfile: "stable-daily", useScrapling: true },
    { initialProfile: SCRAPLING_WORKER_PROFILE, useScrapling: false },
  ])("migrates or rolls back only as a retained baseline: %j", async options => {
    const f = fixture(options);
    await f.run();
    expect(f.readBaseline()).toMatchObject({ capture_profile: f.capture.capture_profile,
      summary_metadata: { reason: "baseline_refresh", baseline_facts: f.original.summary_metadata.baseline_facts,
        previous_baseline: { captured_at: initialTime, capture: f.original.capture } } });
    expect(f.report.baselined).toBe(1);
    expect(f.events).toEqual(["capture", "persistence", "health_success"]);
    expect(f.deps.syncR2SnapshotPair).toHaveBeenCalledOnce();
    expect(f.report.r2_uploaded).toBe(5);
    f.assertEvidencePreserved(); f.assertNoPublication();
  });

  it.each([
    { persisted: false, initialProfile: "stable-daily", useScrapling: true },
    { persistenceEnabled: false, initialProfile: "stable-daily", useScrapling: true },
    { persisted: false, initialProfile: SCRAPLING_WORKER_PROFILE, useScrapling: false },
  ])("restores the complete previous baseline when persistence fails: %j", async options => {
    const f = fixture(options);
    await expect(f.run()).rejects.toThrow("local baseline was rolled back");
    expect(f.readBaseline()).toEqual(f.original);
    expect(f.deps.localBaselineEvidenceCache.get(source.id)).toBe(true);
    expect(f.report.baselined).toBe(0);
    expect(f.events).toEqual(options.persistenceEnabled === false ? ["capture"] : ["capture", "persistence"]);
    expect(f.report.r2_failed).toBe(options.persistenceEnabled === false ? 0 : 1);
    expect(f.deps.markSharedSourceVisualCheckSucceeded).not.toHaveBeenCalled();
    f.assertEvidencePreserved(); f.assertNoPublication();
  });

  it("removes only a failed initial baseline pointer, retaining its evidence", async () => {
    const f = fixture({ hasBaseline: false, persisted: false });
    await expect(f.run()).rejects.toThrow("rolled back");
    expect(f.readBaseline()).toBeNull();
    expect(f.deps.localBaselineEvidenceCache.get(source.id)).toBe(false);
    expect(f.report.baselined).toBe(0);
    f.assertEvidencePreserved(); f.assertNoPublication();
  });

  it("cannot move the baseline backwards in time", async () => {
    const f = fixture();
    f.setCaptureTime("2026-10-14T12:00:00.000Z");
    await expect(f.run()).rejects.toThrow("older than the retained baseline");
    expect(f.readBaseline()).toEqual(f.original);
    expect(f.deps.syncR2SnapshotPair).not.toHaveBeenCalled();
    expect(f.deps.markSharedSourceVisualCheckSucceeded).not.toHaveBeenCalled();
    f.assertEvidencePreserved(); f.assertNoPublication();
  });

  it.each([{ url: "https://example.edu/unreviewed" }, { shared_award_id: awardIds[1] }])(
    "rejects changed reviewed source identity before capture: %j", async overrides => {
      const f = fixture();
      await expect(f.run(overrides)).rejects.toThrow("live source identity differs");
      expect(f.events).toEqual([]);
      expect(f.readBaseline()).toEqual(f.original);
      f.assertEvidencePreserved(); f.assertNoPublication();
    },
  );

  it("honors a newly held source before attempting collection", async () => {
    const f = fixture();
    f.deps.loadSharedSourceReviewState.mockResolvedValue({ admin_review_status: "review_later" });
    await f.run();
    expect(f.events).toEqual([]);
    expect(f.readBaseline()).toEqual(f.original);
    f.assertEvidencePreserved(); f.assertNoPublication();
  });

  it("retains the previous baseline if acquisition or evidence retention fails", async () => {
    const f = fixture();
    f.deps.captureConfiguredScraplingSource.mockRejectedValue(new Error("acquisition unavailable"));
    await expect(f.run()).rejects.toThrow("acquisition unavailable");
    f.deps.captureConfiguredScraplingSource.mockResolvedValue(f.capture);
    f.deps.materializeRetainedCaptureAuthority.mockImplementation(() => { throw new Error("retention failed"); });
    await expect(f.run()).rejects.toThrow("retention failed");
    expect(f.readBaseline()).toEqual(f.original);
    expect(f.deps.syncR2SnapshotPair).not.toHaveBeenCalled();
    expect(f.deps.markSharedSourceVisualCheckSucceeded).not.toHaveBeenCalled();
    f.assertEvidencePreserved(); f.assertNoPublication();
  });

  it("does not rotate or publish on the next same-profile unchanged observation", async () => {
    const f = fixture({ initialProfile: SCRAPLING_WORKER_PROFILE, refresh: false });
    await f.run();
    expect(f.report.unchanged).toBe(1);
    expect(f.report.baselined).toBe(0);
    expect(f.deps.buildScraplingReviewDiff).toHaveBeenCalledOnce();
    expect(f.deps.syncR2SnapshotPair).not.toHaveBeenCalled();
    expect(f.readBaseline()).toEqual(f.original);
    f.assertEvidencePreserved(); f.assertNoPublication();
  });
});
