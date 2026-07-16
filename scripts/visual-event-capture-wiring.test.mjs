import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const captureSource = readFileSync(new URL("./capture-visual-snapshots.mjs", import.meta.url), "utf8");
const visibleGeometrySource = readFileSync(new URL("./lib/visible-text-geometry.mjs", import.meta.url), "utf8");

describe("visual event capture wiring", () => {
  it("captures final main text-node geometry after expansion, scrolling, noise suppression, and settle", () => {
    const body = functionBody(captureSource, "captureSource", "expandPageForSnapshot");
    const finalExpansion = body.indexOf("const finalExpanded = await expandPageForSnapshot");
    const scroll = body.indexOf("const scrollActivation = await activateScrollTriggeredContent", finalExpansion);
    const noise = body.indexOf("const finalHiddenNoise = await hideNoiseElements", scroll);
    const settle = body.indexOf("const pageSettle = await waitForPageSettledForSnapshot", noise);
    const geometry = body.indexOf("const finalTextGeometry = await captureStructuredVisibleTextGeometry", settle);
    const screenshot = body.indexOf("const pageBuffer = await page.screenshot", geometry);

    expect(finalExpansion).toBeGreaterThan(-1);
    expect(scroll).toBeGreaterThan(finalExpansion);
    expect(noise).toBeGreaterThan(scroll);
    expect(settle).toBeGreaterThan(noise);
    expect(geometry).toBeGreaterThan(settle);
    expect(screenshot).toBeGreaterThan(geometry);
    const geometryCallEnd = body.indexOf("    });", geometry) + "    });".length;
    expect(body.slice(geometryCallEnd, screenshot)).not.toContain("await ");
  });

  it("binds and persists main geometry to the exact screenshot hash and dimensions", () => {
    const body = functionBody(captureSource, "captureSource", "expandPageForSnapshot");
    expect(body).toContain("bindVisualTextGeometry(finalTextGeometry");
    expect(body).toContain("imageHash");
    expect(body).toContain("const screenshotBinding = await screenshotBindingFromBuffer(pageBuffer, finalTextGeometry");
    expect(body).toContain("screenshot: screenshotBinding");
    expect(body).toContain("writeFileSync(layoutPath, JSON.stringify(textGeometry");
    expect(body).toContain("layout_hash: textGeometry.geometry_hash");
    expect(body).toContain("layout: toArchiveRelative(layoutPath)");

    const binding = functionBody(captureSource, "screenshotBindingFromBuffer", "screenshotBindingFromGeometry");
    expect(binding).toContain("await sharp(buffer).metadata()");
    expect(binding).toContain("metadata.width");
    expect(binding).toContain("metadata.height");
  });

  it("captures each retained opened-section state geometry immediately before its screenshot", () => {
    const body = functionBody(captureSource, "captureExpansionStateEvidence", "emptySectionExtractionResult");
    const scroll = body.indexOf("await activateScrollTriggeredContent");
    const noise = body.indexOf("await hideNoiseElements", scroll);
    const settle = body.indexOf("await waitForPageSettledForSnapshot", noise);
    const geometry = body.indexOf("const stateTextGeometry = await captureStructuredVisibleTextGeometry", settle);
    const screenshot = body.indexOf("const pageBuffer = await statePage.screenshot", geometry);

    expect(scroll).toBeGreaterThan(-1);
    expect(noise).toBeGreaterThan(scroll);
    expect(settle).toBeGreaterThan(noise);
    expect(geometry).toBeGreaterThan(settle);
    expect(screenshot).toBeGreaterThan(geometry);
    const geometryCallEnd = body.indexOf("          });", geometry) + "          });".length;
    expect(body.slice(geometryCallEnd, screenshot)).not.toContain("await ");
    expect(body).toContain("expansion-state-${String(stateNumber).padStart(2, \"0\")}-layout.json");
    expect(body).toContain("layout_hash: textGeometry.geometry_hash");
    expect(body).toContain("const screenshotBinding = await screenshotBindingFromBuffer(pageBuffer, stateTextGeometry");
  });

  it("captures every accordion candidate on a freshly navigated, target-only page", () => {
    const body = functionBody(captureSource, "captureExpansionStateEvidence", "emptySectionExtractionResult");
    const isolated = body.indexOf("await withIsolatedExpansionStatePage");
    const verify = body.indexOf("await verifyExpansionStateIsolation", isolated);
    const screenshot = body.indexOf("const pageBuffer = await statePage.screenshot", verify);

    expect(body).toContain("selector: selectorFor(control)");
    expect(body).toContain("descriptor: candidate");
    expect(body).toContain("descriptors: setup.labels");
    expect(body).toContain("capture: async (statePage, openedIsolation)");
    expect(body).toContain("fresh_page: true");
    expect(body).toContain("const failures = []");
    expect(body).toContain("failures.push({");
    expect(body).toContain("attempted: setup.labels?.length || 0");
    expect(body).not.toContain("restoreExpansionState();");
    expect(isolated).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(isolated);
    expect(screenshot).toBeGreaterThan(verify);
  });

  it("captures isolated accordion states before the whole-page force-open pass", () => {
    const body = functionBody(captureSource, "captureSource", "expandPageForSnapshot");
    const stateEvidence = body.indexOf("const expansionStateEvidence = await captureExpansionStateEvidence");
    const wholePageExpansion = body.indexOf("const expanded = await expandPageForSnapshot", stateEvidence);

    expect(stateEvidence).toBeGreaterThan(-1);
    expect(wholePageExpansion).toBeGreaterThan(stateEvidence);
  });

  it("uses ordered visible TEXT_NODE DOM Ranges and excludes suppressed content", () => {
    const body = functionBody(
      captureSource,
      "captureStructuredVisibleTextGeometry",
      "screenshotBindingFromGeometry",
    );
    expect(body).toContain("captureVisibleTextGeometry(page");
    expect(body).toContain('Capture geometry failed for screenshot state "${stateId}"');
    expect(visibleGeometrySource).toContain("document.createTreeWalker");
    expect(visibleGeometrySource).toContain("NodeFilter.SHOW_TEXT");
    expect(visibleGeometrySource).toContain("document.createRange()");
    expect(visibleGeometrySource).toContain("range.getClientRects()");
    expect(visibleGeometrySource).toContain("[data-awardping-hidden-noise], [hidden], [aria-hidden='true']");
    expect(visibleGeometrySource).toContain("style.contentVisibility === \"hidden\"");
    expect(visibleGeometrySource).toContain("rect.width <= 0 || rect.height <= 0");
    expect(visibleGeometrySource).toContain("rectsForRange(range, clips)");
    expect(visibleGeometrySource).toContain("right = Math.min(right, clip.right)");
    expect(visibleGeometrySource).toContain("bottom = Math.min(bottom, clip.bottom)");
    expect(visibleGeometrySource).toContain("order: nodes.length");
    expect(visibleGeometrySource).toContain('coordinate_space: "document-css-pixels"');
  });

  it("surfaces nonfatal expansion geometry failures to the 6 PM incident report", () => {
    const body = functionBody(captureSource, "captureSource", "expandPageForSnapshot");
    expect(body).toContain("if (report && expansionStateEvidence.error)");
    expect(body).toContain("Capture geometry expansion-state evidence unavailable");
    expect(body).toContain("source_id: source.id");
    expect(body).toContain("source_url: source.url");
    expect(body).toContain("if (report && expansionStateEvidence.failures?.length)");
    expect(body).toContain("expansion_state_failure: failure");
  });

  it("keeps queued candidate state evidence and retains equivalent previous baseline refs", () => {
    const enqueue = functionBody(captureSource, "enqueueVisualReviewCandidate", "queueAwardReconciliationFromSource");
    const prune = functionBody(captureSource, "pruneTransientExpansionStateScreenshots", "isPathInside");
    const baseline = functionBody(captureSource, "writeBaseline", "readBaselineEvidence");
    const baselineStatus = functionBody(captureSource, "baselineEvidenceStatus", "captureFromBaseline");

    expect(enqueue).toContain("capture.persist_expansion_state_screenshots = true");
    expect(prune).toContain("if (capture.persist_expansion_state_screenshots) return 0");
    expect(prune).toContain("state?.layout_path");
    expect(baseline).toContain("layout: capture.layout_path");
    expect(baseline).toContain("expansion_states:");
    expect(baselineStatus).toContain("layoutPath:");
    expect(baselineStatus).toContain("expansionStateScreenshots:");
  });

  it("treats missing main or opened-section geometry as incomplete local baseline evidence", () => {
    const meta = {
      expansion_state_screenshots: [{ state_id: "eligibility-open" }],
      files: {
        expansion_states: [{ state_id: "eligibility-open" }],
      },
    };
    const completePaths = new Set([
      "page.jpg",
      "thumb.jpg",
      "text.txt",
      "meta.json",
      "layout.json",
      "expansion-state-01.jpg",
      "expansion-state-01-layout.json",
    ]);
    const status = executableBaselineEvidenceStatus({
      existingPaths: completePaths,
      metadataByPath: new Map([["meta.json", meta]]),
    });
    const baseline = webpageBaselineDescriptor();

    expect(status(baseline)).toMatchObject({
      ok: true,
      localizationStatus: "exact_geometry_available",
    });

    const withoutMainLayout = structuredClone(baseline);
    withoutMainLayout.capture.layout = null;
    expect(status(withoutMainLayout)).toMatchObject({
      ok: false,
      missing: ["layout"],
    });

    const withoutExpansionLayout = executableBaselineEvidenceStatus({
      existingPaths: new Set([...completePaths].filter((path) => path !== "expansion-state-01-layout.json")),
      metadataByPath: new Map([["meta.json", meta]]),
    });
    expect(withoutExpansionLayout(baseline)).toMatchObject({
      ok: false,
      missing: ["expansion_state_01_layout"],
    });

    const descriptorLost = structuredClone(baseline);
    descriptorLost.capture.expansion_states = [];
    expect(status(descriptorLost)).toMatchObject({
      ok: false,
      missing: ["expansion_state_01_page", "expansion_state_01_layout"],
    });
  });

  it("keeps explicit legacy R2 evidence-only recovery honest without retrying it as exact geometry", () => {
    const evidencePaths = new Set([
      "page.jpg",
      "thumb.jpg",
      "text.txt",
      "meta.json",
      "layout.json",
      "expansion-state-01.jpg",
    ]);
    const status = executableBaselineEvidenceStatus({
      existingPaths: evidencePaths,
      metadataByPath: new Map([[
        "meta.json",
        { expansion_state_screenshots: [{ state_id: "eligibility-open" }] },
      ]]),
    });

    const legacyGeometryUnavailable = webpageBaselineDescriptor();
    legacyGeometryUnavailable.capture.layout = null;
    legacyGeometryUnavailable.summary_metadata = {
      r2_local_rehydration: {
        localization_status: "evidence_only_geometry_unavailable",
        expected_expansion_states: 1,
      },
    };
    expect(status(legacyGeometryUnavailable)).toMatchObject({
      ok: true,
      localizationStatus: "evidence_only_geometry_unavailable",
    });

    const expansionGeometryIncomplete = webpageBaselineDescriptor();
    expansionGeometryIncomplete.summary_metadata = {
      r2_local_rehydration: {
        localization_status: "evidence_only_expansion_geometry_incomplete",
        expected_expansion_states: 1,
      },
    };
    expect(status(expansionGeometryIncomplete)).toMatchObject({
      ok: true,
      localizationStatus: "evidence_only_expansion_geometry_incomplete",
    });

    expansionGeometryIncomplete.capture.layout = null;
    expect(status(expansionGeometryIncomplete)).toMatchObject({
      ok: false,
      missing: ["layout"],
    });

    const selection = functionBody(captureSource, "hasBaselineForSource", "needsMissingBaselineCompletion");
    expect(selection).toContain("baselineEvidenceStatus(baseline).ok");
  });

  it("builds byte-bound snapshot refs before deriving candidate evidence signatures", () => {
    const enqueue = functionBody(captureSource, "enqueueVisualReviewCandidate", "queueAwardReconciliationFromSource");
    const prompt = enqueue.indexOf("const promptPayload = buildVisualReviewPromptPayload");
    const evidence = enqueue.indexOf("const evidenceSignature = visualReviewEvidenceSignature");
    const candidate = enqueue.indexOf("const candidateSignature = visualReviewCandidateSignature");
    expect(prompt).toBeGreaterThan(-1);
    expect(evidence).toBeGreaterThan(prompt);
    expect(candidate).toBeGreaterThan(evidence);
    expect(enqueue).toContain("previousSnapshotRef");
    expect(enqueue).toContain("newSnapshotRef");
  });

  it("version-gates the rendering change so old baselines refresh without false publication", () => {
    expect(captureSource).toContain("const captureBehaviorVersion = 9;");
    expect(captureSource).toContain('const captureBehaviorName = "final-state-text-node-geometry-with-open-sections";');
  });

  it("fails closed instead of publishing an event outside the immutable candidate workflow", () => {
    expect(captureSource).not.toContain('from("shared_award_change_events")');
    expect(captureSource).not.toContain("publishVisualChangeEvent");
    expect(captureSource).toContain(
      "published changes require a retained batch candidate with immutable evidence",
    );
  });
});

function functionBody(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const asyncStart = source.indexOf(`async function ${name}`);
  const resolvedStart = start === -1 ? asyncStart : asyncStart === -1 ? start : Math.min(start, asyncStart);
  if (resolvedStart === -1) throw new Error(`Missing function ${name}`);
  const nextFunction = source.indexOf(`function ${nextName}`, resolvedStart + 1);
  const nextAsyncFunction = source.indexOf(`async function ${nextName}`, resolvedStart + 1);
  const candidates = [nextFunction, nextAsyncFunction].filter((value) => value > resolvedStart);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(resolvedStart, end);
}

function executableBaselineEvidenceStatus({ existingPaths, metadataByPath }) {
  const body = functionBody(captureSource, "baselineEvidenceStatus", "captureFromBaseline");
  return Function(
    "fromArchiveRelative",
    "existsSync",
    "readJsonIfExists",
    `${body}\nreturn baselineEvidenceStatus;`,
  )(
    (value) => value || null,
    (path) => existingPaths.has(path),
    (path) => metadataByPath.get(path) || null,
  );
}

function webpageBaselineDescriptor() {
  return {
    kind: "webpage",
    capture: {
      page: "page.jpg",
      thumb: "thumb.jpg",
      text: "text.txt",
      meta: "meta.json",
      layout: "layout.json",
      expansion_states: [{
        state_id: "eligibility-open",
        page: "expansion-state-01.jpg",
        layout: "expansion-state-01-layout.json",
      }],
    },
  };
}
