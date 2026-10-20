import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ScraplingBaselineTransitionError,
  assertScraplingBaselineTransition,
  getScraplingBaselineTransitionReference,
  loadScraplingBaselineTransition,
  scraplingBaselineTransitionSchema,
} from "./lib/scrapling-baseline-transition.mjs";

const worker = readFileSync(new URL("./capture-visual-snapshots.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("capture.mjs", worker, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function actualFunction(name) {
  const found = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (found.length !== 1) throw new Error(`Exactly one actual ${name} function required`);
  return found[0].getText(ast);
}
function actualVariable(name) {
  const statement = ast.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(row => row.name.getText(ast) === name));
  if (!statement) throw new Error(`Actual startup ${name} declaration missing`);
  return statement.getText(ast);
}
const processSource = actualFunction("processSourceUnlocked");
const processQueued = actualFunction("processQueuedSource");
const enforce = actualFunction("enforceScraplingBaselineTransition");
const runOptions = actualFunction("assertScraplingBaselineTransitionRunOptions");
const deadlineFunction = new Function(`${actualFunction("createSourcePhaseDeadline")}\nreturn createSourcePhaseDeadline;`)();
const startupCall = ast.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(ast) === "assertScraplingBaselineTransitionRunOptions");
if (!startupCall) throw new Error("Actual transition startup safety call missing");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const roots = [];
afterEach(() => {
  vi.useRealTimers();
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

// Real leaf verification, but only tiny newly-owned synthetic files. These are
// not images, actual website captures, retained originals or migration proof.
function referenceFixture() {
  const root = mkdtempSync(join(tmpdir(), "awardping-transition-wiring-"));
  roots.push(root);
  const source = {
    id: "12345678-1234-4234-8234-123456789012",
    shared_award_id: "22345678-1234-4234-8234-123456789012",
    url: "https://example.edu/award", page_type: "eligibility", source: "admin",
    admin_review_status: "open", admin_reviewed_by: "reviewer@example.edu",
    admin_review_note: "owner-reviewed", admin_reviewed_at: "2026-10-19T12:00:00.000Z",
    page_metadata: { monitoring_only: true },
  };
  const baseline = { source: structuredClone(source), capture_profile: "discovery",
    captured_at: "2026-10-18T12:00:00.000Z", text_hash: "a".repeat(64) };
  const native = "International applicants only. Apply in August; preliminary admission is not final.\u200d";
  const text = `${native}\n${JSON.stringify({ blocks: [{ kind: "div", text: native }],
    links: [{ text: "Conditions", raw_href: "/conditions?audience=international" }] })}\n${"Complete final condition. ".repeat(180)}`;
  const capture = { source: structuredClone(source), kind: "webpage", status_code: 200, capture_profile: "scrapling-evidence-v2",
    capture_behavior_name: "scrapling-evidence-v2", capture_behavior_version: 2,
    final_url: source.url, captured_at: "2026-10-20T12:01:00.000Z", text,
    scrapling: { visible_text: native, visible_text_sha256: sha(native) } };
  const row = { source_id: source.id, stored_owner_id: source.shared_award_id, url: source.url,
    page_type: source.page_type,
    old_baseline: { source_id: source.id, stored_owner_id: source.shared_award_id, url: source.url,
      page_type: source.page_type, capture_profile: baseline.capture_profile,
      captured_at: baseline.captured_at, text_hash: baseline.text_hash },
    target_profile: "scrapling-evidence-v2", reference_captured_at: "2026-10-20T12:00:00.000Z",
    review_text_sha256: sha(text), native_visible_text_sha256: sha(native), reference_artifacts: [] };
  const referenceMeta = { ...capture, captured_at: row.reference_captured_at };
  const raws = { meta: Buffer.from(JSON.stringify(referenceMeta)), text: Buffer.from(text + "\n"),
    html: Buffer.from("<main>Complete synthetic reference.</main>"),
    page: Buffer.from("synthetic page, not decoded image evidence"), thumb: Buffer.from("synthetic thumbnail") };
  for (const [kind, bytes] of Object.entries(raws)) {
    const path = join(root, `${kind}.bin`);
    writeFileSync(path, bytes, { flag: "wx" });
    row.reference_artifacts.push({ kind, path, sha256: sha(bytes), byte_length: bytes.length });
  }
  const path = join(root, "reference.json");
  const bytes = Buffer.from(JSON.stringify({ schema: scraplingBaselineTransitionSchema, sources: [row] }, null, 2) + "\n");
  writeFileSync(path, bytes, { flag: "wx" });
  const input = { path, sha256: sha(bytes) };
  return { root, source, baseline, capture, row, input, guard: loadScraplingBaselineTransition(input) };
}

const mutations = ["markSharedSourceReviewLater", "recordBrokenSourceFailure", "markSharedSourceVisualCheckFailed",
  "writeBaseline", "requireR2SnapshotForBaseline", "maybeSyncR2Snapshot", "maybeExtractBaselineFacts",
  "materializeRetainedCaptureAuthority", "enforceStage1FirstVisualBaselineActivation", "persistStage1BaselineActivationFailure",
  "finalizeStage1BaselineActivation", "maybeEnqueueInitialOfficialDocumentCandidate", "enqueueVisualReviewCandidate",
  "markSharedSourceVisualCheckSucceeded", "markSharedSourceInitialDocumentQuarantined", "removeGeneratedCaptureDir"];

// Execute exact AST-extracted worker functions, never the worker entry point.
// DB/network/browser/queue/health/baseline/R2 effects are inert named spies.
function harness(f, { mutateCapture, mutateBefore, mutateAfter, mutateBaseline, secondBaseline,
  guard = f.guard, baselineRefresh = true, selectedProfile = "scrapling-evidence-v2",
  select = true, readError = null, throwRead = false, qualityAllowed = true, throwQuality = false,
  hygieneHold = false, expiredAfterReread = false, actualDeadline = false, delayReread = false,
  initialMissingBaseline = false } = {}) {
  const source = structuredClone(f.source), capture = structuredClone(f.capture), baseline = structuredClone(f.baseline);
  mutateBefore?.(source); mutateCapture?.(capture); mutateBaseline?.(baseline);
  const current = structuredClone(source); mutateAfter?.(current);
  const originalSource = structuredClone(source), originalBaseline = structuredClone(baseline), originalCapture = structuredClone(capture);
  const report = { checked: 0, failed: 0, errors: [], baselined: 0, pdf_checked: 0,
    issue_sources_cleared: 0, issue_sources_still_failing: 0, issue_sources_new_failures: 0 };
  const events = [], effects = Object.fromEntries(mutations.map(name => [name, vi.fn(async () => { events.push(name); })]));
  effects.writeBaseline.mockImplementation(() => { events.push("writeBaseline"); return true; });
  let releaseRead;
  const readGate = new Promise(resolveRead => { releaseRead = resolveRead; });
  const after = vi.fn(async () => {
    events.push("reread");
    if (delayReread) await readGate;
    if (throwRead) throw new Error("synthetic source reread unavailable");
    return { data: current, error: readError };
  });
  const eq = vi.fn((column, id) => {
    expect([column, id]).toEqual(["id", source.id]);
    return { maybeSingle: after };
  });
  let baselineReads = 0;
  const captureSpy = vi.fn(async () => { events.push("capture"); return capture; });
  const deadlineRun = vi.fn(async (task, options) => {
    expect(options).toEqual({ settleAfterTimeout: Boolean(guard) });
    return task();
  });
  const deadline = { run: deadlineRun, expired: () => expiredAfterReread && after.mock.calls.length > 0 };
  const deps = {
    ...effects, report, ScraplingBaselineTransitionError, getScraplingBaselineTransitionReference,
    assertScraplingBaselineTransition, scraplingBaselineTransition: guard,
    baselineRefresh, SCRAPLING_WORKER_PROFILE: "scrapling-evidence-v1", scraplingManifest: {},
    stage1EvidenceSchemaUpgrade: false, initialOfficialDocumentMaterialization: false,
    shouldBlockOrdinaryProcessingForStage1UpgradeRecovery: vi.fn(() => false),
    isPdfSource: vi.fn(() => false), selectScraplingSource: vi.fn(() => select ? { capture_profile: selectedProfile } : null),
    baselinePathForSource: vi.fn(id => `synthetic/${id}/baseline.json`),
    readJsonIfExists: vi.fn(() => {
      baselineReads++;
      if (initialMissingBaseline) return null;
      return baselineReads > 1 && secondBaseline ? secondBaseline : baseline;
    }),
    maybeRehydrateIncompleteLocalBaseline: vi.fn(async () => ({ baseline, failureReason: null })),
    baselineEvidenceStatus: vi.fn(() => ({ ok: true })), sourceIdFilter: null,
    isFirstCaptureCandidateAcquisition: vi.fn(() => false),
    isStage1PendingBaselineActivationSource: vi.fn(() => false), assertScraplingBaselineCompatibility: vi.fn(),
    localizationRepair: false, extractBaselineInfo: false, backfillBaselineInfo: false, discoverHtmlSubpages: false,
    captureConfiguredScraplingSource: captureSpy, captureSource: captureSpy,
    attachHtmlComparisonDiagnostic: vi.fn(() => { events.push("diagnostic"); }),
    cleanText: value => String(value || "").trim(),
    shouldRejectDiscoveredSource: vi.fn(() => ({ action: hygieneHold ? "review_later" : "keep", reason: "synthetic_hygiene" })),
    classifySourceForConsolidation: vi.fn(() => ({ action: "keep" })), automatedHoldExempt: vi.fn(() => false),
    sourceLabel: value => value.id, console: { log: vi.fn() },
    buildSourcesQuery: vi.fn(ids => { expect(ids).toEqual([source.id]); return { eq }; }),
    sourceQualityDecision: vi.fn((_value, options) => {
      expect(options).toEqual({ purpose: "monitoring" });
      if (throwQuality) throw new Error("synthetic quality validation failure");
      return { allowed: qualityAllowed };
    }),
    readBaselineEvidence: vi.fn(() => ({ ok: true, text: "complete old evidence" })),
    processScraplingComparison: vi.fn(async () => { events.push("ordinary_comparison"); }),
    browserStateForWorker: vi.fn(() => ({ context: {}, browserMeta: {}, sourcesSinceBrowserStart: 0, captureContextUsed: false })),
    pdfOnly: false, webOnly: false, skipExistingBaselineEffective: false, maxSourcesPerBrowser: 10,
    restartBrowser: vi.fn(), restartCaptureContext: vi.fn(), waitForDomain: vi.fn(),
    sourceTimeoutMs: 1000, createSourcePhaseDeadline: actualDeadline ? deadlineFunction : () => deadline,
    retryAccessBlockedCaptures: true, isBrowserClosedError: vi.fn(() => true),
    isSourceTimeoutError: vi.fn(error => error?.code === "AWARDPING_SOURCE_TIMEOUT"),
    isCaptureNetworkBoundaryError: vi.fn(() => true), isRetryableAccessBlockError: vi.fn(() => true),
    hasOpenSourceIssue: vi.fn(() => false), maybeUpdateBaselineCoverageProgress: vi.fn(),
    workerRunId: "synthetic-run", coverageSources: [], errorMessage: error => error.message,
  };
  const actual = new Function(...Object.keys(deps), `${enforce}\n${processSource}\nconst processSource = processSourceUnlocked;\n${processQueued}\nreturn { run: processSourceUnlocked, queued: processQueuedSource };`)(...Object.values(deps));
  return { source, capture, baseline, report, effects, deps, events, after, captureSpy,
    originalSource, originalBaseline, originalCapture, releaseRead, deadlineRun,
    run: () => actual.run(source, {}, {}, report, null, deadline), queued: () => actual.queued(source) };
}
function noWrites(h, { verifiedProof = false } = {}) {
  for (const [name, effect] of Object.entries(h.effects)) expect(effect, name).not.toHaveBeenCalled();
  expect(h.source).toEqual(h.originalSource);
  expect(h.baseline).toEqual(h.originalBaseline);
  expect(h.capture).toEqual(h.originalCapture);
  expect(h.report.checked).toBe(0);
  expect(h.report.baselined).toBe(0);
  if (!verifiedProof) expect(h.report.scrapling_baseline_transitions).toBeUndefined();
}

describe("actual source processing binds cross-profile refresh before persistence", () => {
  it("permits only complete bound source reread/capture before the normal baseline and R2 path", async () => {
    const h = harness(referenceFixture());
    await h.run();
    expect(h.events).toEqual(["capture", "reread", "diagnostic", "materializeRetainedCaptureAuthority",
      "maybeExtractBaselineFacts", "writeBaseline", "requireR2SnapshotForBaseline", "markSharedSourceVisualCheckSucceeded"]);
    expect(h.report).toMatchObject({ checked: 1, baselined: 1,
      scrapling_baseline_transitions: [{ required: true, factual_approval: false, migration_authority: false,
        monitoring_first_coverage_only: true, website_change_certified: false }] });
    expect(h.effects.writeBaseline).toHaveBeenCalledExactlyOnceWith(h.source, h.capture, expect.objectContaining({
      reason: "baseline_refresh", previous_baseline: h.baseline,
    }));
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.effects.enforceStage1FirstVisualBaselineActivation).not.toHaveBeenCalled();
    expect(h.effects.enqueueVisualReviewCandidate).not.toHaveBeenCalled();
  });
  it.each([
    ["full retained tail", c => { c.text += "A newly changed final condition."; }],
    ["nested link destination", c => { c.text = c.text.replace("audience=international", "audience=all"); }],
    ["native only", c => { c.scrapling.visible_text += " Changed native restriction."; c.scrapling.visible_text_sha256 = sha(c.scrapling.visible_text); }],
    ["Unicode", c => { c.text = c.text.replace("\u200d", ""); }],
    ["capture owner", c => { c.source.shared_award_id = "3" + c.source.shared_award_id.slice(1); }],
    ["capture URL", c => { c.final_url += "?different=1"; }],
    ["capture profile", c => { c.capture_profile = "scrapling-evidence-v1"; }],
    ["capture behavior", c => { c.capture_behavior_version = 1; }],
  ])("holds a changed %s before any baseline/R2/Stage1/candidate/health write", async (_name, mutateCapture) => {
    const h = harness(referenceFixture(), { mutateCapture });
    await expect(h.run()).rejects.toMatchObject({ scraplingBaselineTransitionHold: true });
    expect(h.events).toEqual(["capture", "reread"]);
    noWrites(h);
  });
  it.each(["shared_award_id", "url", "page_type", "admin_review_status", "page_metadata", "admin_reviewed_at"])(
    "holds fresh source %s drift without reclassifying the website as broken", async field => {
      const h = harness(referenceFixture(), { mutateAfter: source => {
        source[field] = field === "page_metadata" ? { monitoring_only: false } : `${source[field]} changed`;
      } });
      await h.queued();
      noWrites(h);
      expect(h.report.failed).toBe(1);
      expect(h.report.errors).toEqual([expect.objectContaining({ stage: "scrapling_baseline_transition_hold", creates_api_charge: false })]);
      expect(h.deps.restartBrowser).not.toHaveBeenCalled();
      expect(h.deps.isBrowserClosedError).not.toHaveBeenCalled();
      expect(h.deps.hasOpenSourceIssue).not.toHaveBeenCalled();
    });
  it.each([
    ["missing guard", { guard: null }],
    ["wrong before owner", { mutateBefore: source => { source.shared_award_id = "3" + source.shared_award_id.slice(1); } }],
    ["old baseline hash", { mutateBaseline: baseline => { baseline.text_hash = "b".repeat(64); } }],
    ["old baseline timestamp", { mutateBaseline: baseline => { baseline.captured_at = "2026-10-18T12:00:01.000Z"; } }],
    ["old baseline profile", { mutateBaseline: baseline => { baseline.capture_profile = "baseline-rich"; } }],
    ["old baseline owner", { mutateBaseline: baseline => { baseline.source.shared_award_id = "3" + baseline.source.shared_award_id.slice(1); } }],
    ["old baseline URL", { mutateBaseline: baseline => { baseline.source.url += "?different=1"; } }],
    ["pin not applicable", { selectedProfile: "scrapling-evidence-v1", mutateBaseline: baseline => { baseline.capture_profile = "scrapling-evidence-v1"; } }],
    ["source not selected", { select: false }],
  ])("preflights %s before capture, source hygiene, or any write", async (_name, options) => {
    const h = harness(referenceFixture(), { ...options, hygieneHold: true,
      mutateBefore: source => { source.admin_reviewed_by = ""; options.mutateBefore?.(source); } });
    await h.queued();
    noWrites(h);
    expect(h.captureSpy).not.toHaveBeenCalled();
    expect(h.after).not.toHaveBeenCalled();
    expect(h.deps.shouldRejectDiscoveredSource).not.toHaveBeenCalled();
    expect(h.report.errors[0]).toMatchObject({ stage: "scrapling_baseline_transition_hold" });
  });
  it("rechecks the final retained baseline before capture instead of relying on the earlier read alone", async () => {
    const f = referenceFixture();
    const h = harness(f, { secondBaseline: { ...f.baseline, text_hash: "f".repeat(64) } });
    await expect(h.run()).rejects.toMatchObject({ scraplingBaselineTransitionHold: true });
    noWrites(h);
    expect(h.events).toEqual([]);
    expect(h.captureSpy).not.toHaveBeenCalled();
    expect(h.after).not.toHaveBeenCalled();
  });
  it("holds a rehydrated legacy baseline before capture when no transition evidence was supplied", async () => {
    const h = harness(referenceFixture(), { guard: null, initialMissingBaseline: true });
    await h.queued();
    noWrites(h);
    expect(h.deps.maybeRehydrateIncompleteLocalBaseline).toHaveBeenCalledTimes(1);
    expect(h.captureSpy).not.toHaveBeenCalled();
    expect(h.after).not.toHaveBeenCalled();
    expect(h.report.errors[0]).toMatchObject({ stage: "scrapling_baseline_transition_hold" });
  });
  it("keeps ordinary recovered same-profile processing independent from transition evidence", async () => {
    const f = referenceFixture(); f.baseline.capture_profile = "scrapling-evidence-v2";
    const h = harness(f, { guard: null, baselineRefresh: false, initialMissingBaseline: true });
    await h.run();
    expect(h.deps.maybeRehydrateIncompleteLocalBaseline).toHaveBeenCalledTimes(1);
    expect(h.events).toContain("ordinary_comparison");
    expect(h.report.checked).toBe(1);
    expect(h.after).not.toHaveBeenCalled();
    expect(h.effects.writeBaseline).not.toHaveBeenCalled();
    expect(h.effects.requireR2SnapshotForBaseline).not.toHaveBeenCalled();
  });
  it.each([
    ["returned source read error", { readError: { message: "synthetic database error" } }],
    ["monitoring quality refusal", { qualityAllowed: false }],
    ["thrown source read", { throwRead: true }],
    ["thrown quality validation", { throwQuality: true }],
  ])("does not change source health or retry after %s", async (_name, options) => {
    const h = harness(referenceFixture(), options);
    await h.queued();
    noWrites(h);
    expect(h.captureSpy).toHaveBeenCalledTimes(1);
    expect(h.report.errors).toHaveLength(1);
    expect(h.report.errors[0]).toMatchObject({ stage: "scrapling_baseline_transition_hold", creates_api_charge: false });
    expect(h.deps.restartBrowser).not.toHaveBeenCalled();
    expect(h.deps.isRetryableAccessBlockError).not.toHaveBeenCalled();
  });
  it("holds an expired post-read deadline before materialization or persistence", async () => {
    const h = harness(referenceFixture(), { expiredAfterReread: true });
    await h.queued();
    noWrites(h, { verifiedProof: true });
    expect(h.events).toEqual(["capture", "reread"]);
    expect(h.report.errors[0]).toMatchObject({ stage: "scrapling_baseline_transition_hold" });
    expect(h.deadlineRun).toHaveBeenCalledTimes(1);
    expect(h.deps.restartBrowser).not.toHaveBeenCalled();
  });
  it("settles a real timed-out deadline's late verification before returning and never retries it", async () => {
    vi.useFakeTimers();
    const h = harness(referenceFixture(), { actualDeadline: true, delayReread: true });
    let settled = false;
    const pending = h.queued().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.events).toEqual(["capture", "reread"]);
    expect(settled).toBe(false);
    noWrites(h);
    h.releaseRead();
    await pending;
    noWrites(h, { verifiedProof: true });
    expect(h.captureSpy).toHaveBeenCalledTimes(1);
    expect(h.report.failed).toBe(1);
    expect(h.report.errors[0]).toMatchObject({ stage: "scrapling_baseline_transition_hold" });
    expect(h.deps.restartBrowser).not.toHaveBeenCalled();
  });
  it.each([false, true])("keeps existing same-profile behavior unchanged with baselineRefresh=%s", async baselineRefresh => {
    const f = referenceFixture(); f.baseline.capture_profile = "scrapling-evidence-v2";
    const h = harness(f, { guard: null, baselineRefresh });
    await h.run();
    expect(h.after).not.toHaveBeenCalled();
    expect(h.report.scrapling_baseline_transitions).toBeUndefined();
    expect(h.report.checked).toBe(1);
    expect(h.events).toContain(baselineRefresh ? "writeBaseline" : "ordinary_comparison");
    expect(h.effects.recordBrokenSourceFailure).not.toHaveBeenCalled();
  });
  it("preserves the ordinary guardless deadline's non-settling option", async () => {
    const f = referenceFixture(); f.baseline.capture_profile = "scrapling-evidence-v2";
    const h = harness(f, { guard: null, baselineRefresh: false });
    await h.queued();
    expect(h.deadlineRun).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { settleAfterTimeout: false });
    expect(h.events).toContain("ordinary_comparison");
  });
});

describe("actual CLI-only evidence load and run safety contract", () => {
  function startup(args, root, load = loadScraplingBaselineTransition) {
    return new Function("args", "root", "env", "resolve", "cleanText", "loadScraplingBaselineTransition",
      `${actualVariable("scraplingTransitionRequested")}\n${actualVariable("scraplingBaselineTransition")}\nreturn scraplingBaselineTransition;`)(
      args, root, { AWARDPING_BASELINE_REFRESH_EVIDENCE: "must-not-authorize", AWARDPING_BASELINE_REFRESH_EVIDENCE_SHA256: "a".repeat(64) },
      resolve, value => String(value || "").trim(), load,
    );
  }
  it("has no inherited-environment authorization and requires both explicit CLI pins", () => {
    const load = vi.fn(); expect(startup({}, "/synthetic-not-read", load)).toBeNull(); expect(load).not.toHaveBeenCalled();
    const f = referenceFixture();
    expect(startup({ "baseline-refresh-evidence": f.input.path, "baseline-refresh-evidence-sha256": f.input.sha256 }, f.root).sha256).toBe(f.input.sha256);
    for (const args of [{ "baseline-refresh-evidence": f.input.path }, { "baseline-refresh-evidence-sha256": f.input.sha256 },
      { "baseline-refresh-evidence": f.input.path, "baseline-refresh-evidence-sha256": "a".repeat(64) }]) {
      expect(() => startup(args, f.root)).toThrow(ScraplingBaselineTransitionError);
    }
  });
  it("rejects a changed raw reference artifact during actual startup loading, even with the original pin-file SHA", () => {
    const f = referenceFixture();
    writeFileSync(f.row.reference_artifacts.find(row => row.kind === "html").path, "different synthetic retained reference");
    expect(() => startup({ "baseline-refresh-evidence": f.input.path,
      "baseline-refresh-evidence-sha256": f.input.sha256 }, f.root)).toThrow(ScraplingBaselineTransitionError);
  });
  function runConfiguration(f, changes = {}) {
    const deps = { ScraplingBaselineTransitionError, scraplingBaselineTransition: f.guard,
      sourceIdFilter: f.source.id, sourceIdsFile: null, sourceUrlFilter: null, awardFilter: null, limit: 1,
      baselineRefresh: true, runTrigger: "maintenance", continuous: false, webOnly: true, pdfOnly: false,
      includeNotDue: true, keepUnchanged: true, shardCount: 1, shardIndex: 0, visualWebConcurrency: 1,
      r2SnapshotSync: true, scraplingManifest: {}, aiRequired: false, aiProvider: null, requestedAiProvider: "none",
      visualReviewMode: "none", interpretVisualChanges: false, extractBaselineInfo: false, backfillBaselineInfo: false,
      sourceQualityMode: "deterministic", stage1EvidenceSchemaUpgrade: false, initialOfficialDocumentMaterialization: false,
      localizationRepair: false, discoveryMode: false, discoverHtmlSubpages: false, discoverPdfSubpages: false,
      snapshotHistoryPrune: false, r2BackfillBaselines: false, forceR2SnapshotRefresh: false, resetPreviousSnapshot: false,
      r2RepairMissingSnapshots: false, completeMissingBaselines: false, aiReviewEvidenceCapture: false, promote: false,
      ...changes };
    return new Function(...Object.keys(deps), `${runOptions}\n${startupCall.getText(ast)}`)(...Object.values(deps));
  }
  it("admits the exact one-source no-AI maintenance collection and ignores guardless ordinary settings", () => {
    const f = referenceFixture(); expect(() => runConfiguration(f)).not.toThrow();
    expect(() => runConfiguration(f, { scraplingBaselineTransition: null, limit: 25, requestedAiProvider: "gemini", promote: true })).not.toThrow();
  });
  it.each([
    ["sourceIdFilter", ""], ["sourceIdFilter", "32345678-1234-4234-8234-123456789012"],
    ["sourceIdsFile", "synthetic-list"], ["sourceUrlFilter", "https://example.edu/award"],
    ["awardFilter", "synthetic-award"], ["limit", 2], ["baselineRefresh", false], ["runTrigger", "scheduled"],
    ["continuous", true], ["webOnly", false], ["pdfOnly", true], ["includeNotDue", false], ["keepUnchanged", false],
    ["shardCount", 2], ["shardIndex", 1], ["visualWebConcurrency", 2], ["r2SnapshotSync", false], ["scraplingManifest", null],
    ["aiRequired", true], ["aiProvider", "gemini"], ["requestedAiProvider", "gemini"], ["visualReviewMode", "queue"],
    ["interpretVisualChanges", true], ["extractBaselineInfo", true], ["backfillBaselineInfo", true],
    ["sourceQualityMode", "ai"], ["stage1EvidenceSchemaUpgrade", true], ["initialOfficialDocumentMaterialization", true],
    ["localizationRepair", true], ["discoveryMode", true], ["discoverHtmlSubpages", true], ["discoverPdfSubpages", true],
    ["snapshotHistoryPrune", true], ["r2BackfillBaselines", true], ["forceR2SnapshotRefresh", true],
    ["resetPreviousSnapshot", true], ["r2RepairMissingSnapshots", true], ["completeMissingBaselines", true],
    ["aiReviewEvidenceCapture", true], ["promote", true],
  ])("refuses the actual startup's unsafe %s=%s before worker construction", (field, value) => {
    expect(() => runConfiguration(referenceFixture(), { [field]: value })).toThrow(ScraplingBaselineTransitionError);
  });
});
