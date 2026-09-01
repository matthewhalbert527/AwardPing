import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  hasExpansionStateCaptureCoverageClaim,
  legacyExpansionStateCaptureCoverageFromMetadata,
} from "./lib/expansion-state-descriptor-canonicalization.mjs";
import { isR2CaptureGeometryReady } from "./lib/r2-capture-artifact-bindings.mjs";
import {
  bindVisualTextGeometry,
  visualTextGeometryLayoutFingerprint,
} from "./lib/visual-event-localization.mjs";

const captureSource = readFileSync(new URL("./capture-visual-snapshots.mjs", import.meta.url), "utf8");
const expansionIsolationSource = readFileSync(new URL("./lib/expansion-state-isolation.mjs", import.meta.url), "utf8");
const expansionCanonicalizationSource = readFileSync(
  new URL("./lib/expansion-state-descriptor-canonicalization.mjs", import.meta.url),
  "utf8",
);
const visibleGeometrySource = readFileSync(new URL("./lib/visible-text-geometry.mjs", import.meta.url), "utf8");

describe("visual event capture wiring", () => {
  it("captures final main text-node geometry after expansion, scrolling, noise suppression, and settle", () => {
    const body = functionBody(captureSource, "captureSource", "expandPageForSnapshot");
    const finalExpansion = body.indexOf("const finalExpanded = await expandPageForSnapshot");
    const scroll = body.indexOf("const scrollActivation = await activateScrollTriggeredContent", finalExpansion);
    const noise = body.indexOf("const finalHiddenNoise = await hideNoiseElements", scroll);
    const settle = body.indexOf("const pageSettle = await waitForPageSettledForSnapshot", noise);
    const stableGate = body.indexOf("finalTextGeometry = pageSettle.stable", settle);
    const guardedGeometry = body.indexOf("await captureStructuredVisibleTextGeometry(page", stableGate);
    const unavailableFallback = body.indexOf("unavailableStructuredVisibleTextGeometry({", stableGate);
    const screenshot = body.indexOf("pageBuffer = await page.screenshot", unavailableFallback);

    expect(finalExpansion).toBeGreaterThan(-1);
    expect(scroll).toBeGreaterThan(finalExpansion);
    expect(noise).toBeGreaterThan(scroll);
    expect(settle).toBeGreaterThan(noise);
    expect(stableGate).toBeGreaterThan(settle);
    expect(body).not.toContain("const finalTextGeometry = await captureStructuredVisibleTextGeometry");
    expect(guardedGeometry).toBeGreaterThan(stableGate);
    expect(unavailableFallback).toBeGreaterThan(guardedGeometry);
    expect(screenshot).toBeGreaterThan(unavailableFallback);
    expect(body.slice(unavailableFallback, screenshot)).not.toContain("await ");
  });

  it("keeps the main full screenshot but marks exact geometry unavailable when settle fails", () => {
    const body = functionBody(captureSource, "captureSource", "expandPageForSnapshot");
    const mainSettle = body.indexOf("const pageSettle = await waitForPageSettledForSnapshot(page)");
    const mainGuard = body.indexOf("finalTextGeometry = pageSettle.stable", mainSettle);
    const unavailable = body.indexOf("unavailableStructuredVisibleTextGeometry({", mainGuard);
    const screenshot = body.indexOf("pageBuffer = await page.screenshot", unavailable);
    const binding = body.indexOf("bindVisualTextGeometry(finalTextGeometry", screenshot);
    const openedBody = functionBody(captureSource, "captureExpansionStateEvidence", "emptySectionExtractionResult");

    expect(mainSettle).toBeGreaterThan(-1);
    expect(mainGuard).toBeGreaterThan(mainSettle);
    expect(unavailable).toBeGreaterThan(mainGuard);
    expect(screenshot).toBeGreaterThan(unavailable);
    expect(binding).toBeGreaterThan(screenshot);
    expect(body).toContain('reason: "page_did_not_settle_before_geometry_capture"');
    expect(openedBody).toContain("if (!preparedStateSettle.stable)");
    expect(openedBody).toContain("if (!captureStateSettle.stable)");

    const fallback = functionBody(
      captureSource,
      "unavailableStructuredVisibleTextGeometry",
      "screenshotBindingFromBuffer",
    );
    expect(fallback).toContain('availability_status: "unavailable_page_not_settled"');
    expect(fallback).toContain("nodes: []");
  });

  it("binds and persists main geometry to the exact screenshot hash and dimensions", () => {
    const body = functionBody(captureSource, "captureSource", "expandPageForSnapshot");
    expect(body).toContain("bindVisualTextGeometry(finalTextGeometry");
    expect(body).toContain("imageHash");
    expect(body).toContain("screenshotBinding = await screenshotBindingFromBuffer(pageBuffer, finalTextGeometry");
    expect(body).toContain("screenshot: screenshotBinding");
    expect(body).toContain("writeFileSync(layoutPath, JSON.stringify(textGeometry");
    expect(body).toContain("layout_hash: textGeometry.geometry_hash");
    expect(body).toContain("layout: toArchiveRelative(layoutPath)");
    expect(body).toContain("const afterScreenshotGeometry = await captureStructuredVisibleTextGeometry(page");
    expect(body).toContain("finalTextGeometry = verifyVisualScreenshotLayoutCapture({");

    const binding = functionBody(captureSource, "screenshotBindingFromBuffer", "screenshotBindingFromGeometry");
    expect(binding).toContain("await sharp(buffer).metadata()");
    expect(binding).toContain("metadata.width");
    expect(binding).toContain("metadata.height");
    const dimensions = functionBody(captureSource, "screenshotBindingFromGeometry", "textGeometryReference");
    expect(dimensions).toContain("uniformScaleError <= 0.01");
    expect(dimensions).toContain("deviceScaleError <= 0.01");
    expect(dimensions).toContain('alignment_status: alignmentStatus');
  });

  it("captures each retained opened-section state geometry immediately before its screenshot", () => {
    const body = functionBody(captureSource, "captureExpansionStateEvidence", "emptySectionExtractionResult");
    const scroll = body.indexOf("await activateScrollTriggeredContent");
    const noise = body.indexOf("await hideNoiseElements", scroll);
    const settle = body.indexOf("await waitForPageSettledForSnapshot", noise);
    const geometry = body.indexOf("let stateTextGeometry = await captureStructuredVisibleTextGeometry", settle);
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
    expect(body).toContain("const afterScreenshotGeometry = await captureStructuredVisibleTextGeometry(statePage");
    expect(body).toContain("stateTextGeometry = verifyVisualScreenshotLayoutCapture({");
  });

  it("captures every accordion candidate on a freshly navigated, target-only page", () => {
    const body = functionBody(captureSource, "captureExpansionStateEvidence", "emptySectionExtractionResult");
    const discovery = body.indexOf("await discoverExpansionStateDescriptors(page");
    const isolated = body.indexOf("const runIsolatedState = () => withIsolatedExpansionStatePage({");
    const prepareScroll = body.indexOf("await activateScrollTriggeredContent(statePage", isolated);
    const captureCallback = body.indexOf("capture: async (statePage, openedIsolation)", prepareScroll);
    const verify = body.indexOf("await verifyExpansionStateIsolation", isolated);
    const screenshot = body.indexOf("const pageBuffer = await statePage.screenshot", verify);

    expect(body).toContain("const descriptors = setup.descriptors || []");
    expect(body).toContain("descriptor: candidate");
    expect(body).toContain("const isolationDescriptors = setup.isolation_descriptors || descriptors");
    expect(body).toContain("descriptors: isolationDescriptors");
    expect(body).toContain("setup.isolation_descriptor_set_complete !== true");
    expect(body).toContain("capture: async (statePage, openedIsolation)");
    expect(body).toContain("state = await runIsolatedState();");
    expect(body).toContain("fresh_page: true");
    expect(body).toContain("const failures = []");
    expect(body).toContain("failures.push({");
    expect(body).toContain("summarizeExpansionStateCapture(setup, { states, failures, inert: inertCandidates })");
    expect(body).not.toContain("page.evaluate(({ maxControls");
    expect(body).not.toContain("restoreExpansionState();");
    expect(discovery).toBeGreaterThan(-1);
    expect(isolated).toBeGreaterThan(discovery);
    expect(prepareScroll).toBeGreaterThan(isolated);
    expect(captureCallback).toBeGreaterThan(prepareScroll);
    expect(verify).toBeGreaterThan(isolated);
    expect(screenshot).toBeGreaterThan(verify);
  });

  it("reports bounded accordion capture as explicitly incomplete instead of silently dropping controls", () => {
    const body = functionBody(captureSource, "captureExpansionStateEvidence", "emptySectionExtractionResult");

    expect(body).toContain("setup.truncated === true");
    expect(body).toContain("expansion_state_capture_truncated:");
    expect(body).toContain("summarizeExpansionStateCapture(setup, { states, failures, inert: inertCandidates })");
    expect(expansionCanonicalizationSource).toContain(": descriptors.length");
    expect(expansionCanonicalizationSource).toContain("attempted: attemptedCount");
    expect(expansionCanonicalizationSource).toContain("truncated_count:");
    expect(captureSource).toContain(
      "expansion_state_capture_complete: expansionStateEvidence.capture_complete === true",
    );
    expect(captureSource).toContain(
      'expansion_state_capture_status: expansionStateEvidence.capture_status || "unavailable_unknown"',
    );
    expect(captureSource).toContain(
      "expansion_state_truncated: expansionStateEvidence.truncated === true",
    );
    expect(captureSource).toContain(
      "expansion_state_truncated_count: expansionStateEvidence.truncated_count || 0",
    );
  });

  it("rejects a partial nested completeness claim before retained projection can publish it", () => {
    const body = functionBody(
      captureSource,
      "materializeRetainedCaptureAuthority",
      "rewriteMatchingBaselineRetainedProjection",
    );
    const strictValidation = body.indexOf(
      "legacyExpansionStateCaptureCoverageFromMetadata({",
    );
    const projection = body.indexOf(
      "projectRetainedCaptureArtifactsForMaterialization(capture",
    );
    expect(strictValidation).toBeGreaterThan(-1);
    expect(projection).toBeGreaterThan(strictValidation);

    const materialize = Function(
      "legacyExpansionStateCaptureCoverageFromMetadata",
      "hasExpansionStateCaptureCoverageClaim",
      `${body}\nreturn materializeRetainedCaptureAuthority;`,
    )(
      legacyExpansionStateCaptureCoverageFromMetadata,
      hasExpansionStateCaptureCoverageClaim,
    );
    const malformedCoverage = {
      complete: true,
      status: "verified_complete",
      raw_candidate_count_exact: true,
      logical_candidate_count_exact: true,
      truncated_count_exact: true,
    };
    const capture = {
      kind: "webpage",
      expansion_state_capture_coverage: malformedCoverage,
      expansion_state_screenshots: [],
    };

    expect(() => materialize({ id: "source-1" }, capture)).toThrow(
      "Capture expansion-state coverage claim is invalid before retained artifact projection.",
    );
    expect(capture.expansion_state_capture_coverage).toBe(malformedCoverage);
    expect(capture).not.toHaveProperty("retained_artifact_projection");
  });

  it("fails expansion-state capture closed when either fresh-page settle check times out", () => {
    const body = functionBody(captureSource, "captureExpansionStateEvidence", "emptySectionExtractionResult");
    const prepared = body.indexOf("const preparedStateSettle = await waitForPageSettledForSnapshot(statePage)");
    const preparedGuard = body.indexOf("if (!preparedStateSettle.stable)", prepared);
    const capture = body.indexOf("const captureStateSettle = await waitForPageSettledForSnapshot(statePage)", preparedGuard);
    const captureGuard = body.indexOf("if (!captureStateSettle.stable)", capture);
    const geometry = body.indexOf("let stateTextGeometry = await captureStructuredVisibleTextGeometry", captureGuard);

    expect(prepared).toBeGreaterThan(-1);
    expect(preparedGuard).toBeGreaterThan(prepared);
    expect(capture).toBeGreaterThan(preparedGuard);
    expect(captureGuard).toBeGreaterThan(capture);
    expect(geometry).toBeGreaterThan(captureGuard);
    expect(body).toContain("Expansion state page did not settle before control resolution");
    expect(body).toContain("Expansion state page did not settle before geometry capture");
  });

  it("discovers only bound actionable controls and counts eligible states beyond the capture cap", () => {
    const navFilter = expansionIsolationSource.indexOf('element.closest("nav, header, [role=\'navigation\']")');
    const dedupe = expansionIsolationSource.indexOf("seenStates.has(binding.key)");
    const count = expansionIsolationSource.indexOf("candidateCount += 1", dedupe);
    const retain = expansionIsolationSource.indexOf("controls.push({ control, binding })", dedupe);
    const canonicalize = expansionIsolationSource.indexOf(
      "canonicalizeExpansionStateDescriptors(rawDiscovery",
      retain,
    );

    expect(expansionIsolationSource).toContain("const binding = stateBindingFor(element)");
    expect(expansionIsolationSource).toContain('kind: "adjacent-panel"');
    expect(expansionIsolationSource).toContain("selectorFromTargetToken");
    expect(expansionIsolationSource).toContain("CSS.escape(raw)");
    expect(expansionIsolationSource).toContain("targetResolution.unresolved > 0");
    expect(expansionIsolationSource).toContain("binding.panels.every(visiblePanel)");
    expect(expansionIsolationSource).not.toContain('kind: "control"');
    expect(navFilter).toBeGreaterThan(-1);
    expect(dedupe).toBeGreaterThan(navFilter);
    expect(count).toBeGreaterThan(dedupe);
    expect(retain).toBeGreaterThan(count);
    expect(canonicalize).toBeGreaterThan(retain);
    expect(expansionIsolationSource).not.toContain("if (controls.length >= controlLimit) break");
    expect(expansionCanonicalizationSource).toContain("logicalPanelKey(descriptor)");
    expect(expansionCanonicalizationSource).toContain("duplicate_controls_removed");
    expect(expansionCanonicalizationSource).toContain("descriptor_set_complete: descriptorSetComplete");
  });

  it("captures isolated accordion states before the whole-page force-open pass", () => {
    const body = functionBody(captureSource, "captureSource", "expandPageForSnapshot");
    const initialScroll = body.indexOf("const initialScrollActivation = await activateScrollTriggeredContent");
    const stateEvidence = body.indexOf("const expansionStateEvidence = await captureExpansionStateEvidence");
    const wholePageExpansion = body.indexOf("const expanded = await expandPageForSnapshot", stateEvidence);

    expect(initialScroll).toBeGreaterThan(-1);
    expect(stateEvidence).toBeGreaterThan(initialScroll);
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
    expect(visibleGeometrySource).toContain("Document.prototype.createTreeWalker");
    expect(visibleGeometrySource).toContain("NodeFilter.SHOW_TEXT");
    expect(visibleGeometrySource).toContain("Document.prototype.createRange");
    expect(visibleGeometrySource).toContain("range.getClientRects()");
    expect(visibleGeometrySource).toContain("[data-awardping-hidden-noise], [hidden], [aria-hidden='true']");
    expect(visibleGeometrySource).toContain("style.contentVisibility === \"hidden\"");
    expect(visibleGeometrySource).toContain("rect.width <= 0 || rect.height <= 0");
    expect(visibleGeometrySource).toContain('session.send("Page.createIsolatedWorld"');
    expect(visibleGeometrySource).toContain('session.send("Runtime.evaluate"');
    expect(visibleGeometrySource).toContain("const visibilityApi = createVisibilityApi");
    expect(visibleGeometrySource).toContain("return await runTask");
    expect(visibleGeometrySource).not.toContain("Object.defineProperty(globalThis");
    expect(visibleGeometrySource).toContain("visibilityApi.elementContext(parent)");
    expect(visibleGeometrySource).toContain("visibilityApi.rectsForRange(range, context");
    expect(visibleGeometrySource).toContain("nativeElementsFromPoint.call(document, x, y)");
    expect(visibleGeometrySource).toContain('contract: "browser-paint-stack-v1"');
    expect(visibleGeometrySource).toContain("right: Math.min(candidate.right, clip.right)");
    expect(visibleGeometrySource).toContain("bottom: Math.min(candidate.bottom, clip.bottom)");
    expect(visibleGeometrySource).toContain("const suspiciousZeroContrast");
    expect(visibleGeometrySource).toContain("const clipPath = clipPathShape");
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

    const unstableMetaStatus = executableBaselineEvidenceStatus({
      existingPaths: completePaths,
      metadataByPath: new Map([[
        "meta.json",
        {
          ...meta,
          localization: {
            status: "unavailable_page_not_settled",
            geometry_ready: false,
          },
        },
      ]]),
    });
    expect(unstableMetaStatus(baseline)).toMatchObject({
      ok: true,
      localizationStatus: "unavailable_page_not_settled",
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

  it("hydrates historical backfill geometry only from retained safe layout artifacts", () => {
    const mainImageHash = "b".repeat(64);
    const expansionImageHash = "d".repeat(64);
    const mainLayout = readyGeometryFixture({
      stateId: "main",
      imageHash: mainImageHash,
      text: "Main wording",
    });
    const expansionLayout = readyGeometryFixture({
      stateId: "expansion-state-01",
      imageHash: expansionImageHash,
      text: "Eligibility wording",
    });
    const reads = [];
    const hydrate = executableRetainedBaselineGeometryHydrator({
      safePaths: new Set(["main-layout.json", "expansion-layout.json", "invalid-layout.json"]),
      layoutsByPath: new Map([
        ["main-layout.json", mainLayout],
        ["expansion-layout.json", expansionLayout],
        ["invalid-layout.json", null],
      ]),
      reads,
    });
    const evidence = {
      layoutPath: "main-layout.json",
      expansionStateScreenshots: [{
        state_id: "expansion-state-01",
        page_path: "expansion-page.jpg",
        layout_path: "expansion-layout.json",
      }],
    };
    const meta = {
      text_geometry: {
        geometry_hash: mainLayout.geometry_hash,
        screenshot: mainLayout.screenshot,
        nodes: [{ text: "Untrusted metadata copy" }],
      },
      expansion_state_screenshots: [{
        state_id: "expansion-state-01",
        label: "Eligibility",
        image_hash: expansionImageHash,
        layout_hash: expansionLayout.geometry_hash,
        text_hash: "e".repeat(64),
        text_length: 19,
        page_bytes: 42,
        text_geometry: {
          geometry_hash: expansionLayout.geometry_hash,
          screenshot: expansionLayout.screenshot,
          nodes: [{ text: "Untrusted metadata copy" }],
        },
      }],
    };

    const hydrated = hydrate(evidence, meta);
    expect(hydrated).toEqual({
      textGeometry: mainLayout,
      expansionStateScreenshots: [expect.objectContaining({
        state_id: "expansion-state-01",
        label: "Eligibility",
        text_hash: "e".repeat(64),
        text_length: 19,
        page_bytes: 42,
        text_geometry: expansionLayout,
        page_path: "expansion-page.jpg",
        layout_path: "expansion-layout.json",
      })],
    });
    expect(isR2CaptureGeometryReady({
      kind: "webpage",
      image_hash: mainImageHash,
      text_geometry: hydrated.textGeometry,
    })).toBe(true);
    expect(isR2CaptureGeometryReady({
      kind: "webpage",
      image_hash: expansionImageHash,
      text_geometry: hydrated.expansionStateScreenshots[0].text_geometry,
    })).toBe(true);
    expect(reads).toEqual(["expansion-layout.json", "main-layout.json"]);

    const unavailable = hydrate({
      ...evidence,
      layoutPath: "outside-layout.json",
      expansionStateScreenshots: [{
        ...evidence.expansionStateScreenshots[0],
        layout_path: "invalid-layout.json",
      }],
    }, meta);
    expect(unavailable.textGeometry).toMatchObject({
      geometry_hash: mainLayout.geometry_hash,
      screenshot: mainLayout.screenshot,
    });
    expect(unavailable.textGeometry).not.toHaveProperty("nodes");
    expect(unavailable.expansionStateScreenshots[0].text_geometry).not.toHaveProperty("nodes");
    expect(reads).not.toContain("outside-layout.json");

    const captureFromBaseline = functionBody(
      captureSource,
      "captureFromBaseline",
      "buildDiffSummary",
    );
    expect(captureFromBaseline).toContain("hydrateRetainedBaselineGeometry(evidence, meta)");
    expect(captureFromBaseline).toContain("text_geometry: retainedGeometry.textGeometry");
    expect(captureFromBaseline).toContain(
      "expansion_state_screenshots: retainedGeometry.expansionStateScreenshots",
    );
    expect(captureFromBaseline).not.toContain("fetch(");
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
    expect(captureSource).toContain("const captureBehaviorVersion = 13;");
    expect(captureSource).toContain(
      '"final-state-text-node-geometry-with-open-sections-semantic-crop-v3-visible-paint-v5-layout-bound-v1";',
    );
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
    "jsonObjectOrEmpty",
    "retainedCaptureArtifactProjectionSchema",
    `${body}\nreturn baselineEvidenceStatus;`,
  )(
    (value) => value || null,
    (path) => existingPaths.has(path),
    (path) => metadataByPath.get(path) || null,
    (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {},
    "awardping.capture-retained-artifact-projection.v1",
  );
}

function executableRetainedBaselineGeometryHydrator({
  safePaths,
  layoutsByPath,
  reads,
}) {
  const readBody = functionBody(
    captureSource,
    "readRetainedBaselineLayout",
    "hydrateRetainedBaselineGeometry",
  );
  const hydrateBody = functionBody(
    captureSource,
    "hydrateRetainedBaselineGeometry",
    "captureFromBaseline",
  );
  return Function(
    "existsSync",
    "resolve",
    "isPathInside",
    "archiveRoot",
    "lstatSync",
    "realpathSync",
    "readJsonIfExists",
    "jsonObjectOrEmpty",
    "textGeometryReference",
    "cleanText",
    `${readBody}\n${hydrateBody}\nreturn hydrateRetainedBaselineGeometry;`,
  )(
    (path) => safePaths.has(path) || path === "outside-layout.json",
    (path) => path,
    (candidate) => safePaths.has(candidate),
    "archive",
    () => ({ isFile: () => true, isSymbolicLink: () => false }),
    (path) => path,
    (path) => {
      reads.push(path);
      return layoutsByPath.get(path) || null;
    },
    (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {},
    (geometry) => ({
      geometry_hash: geometry.geometry_hash || null,
      screenshot: geometry.screenshot || null,
      run_count: geometry.run_count || 0,
    }),
    (value) => String(value || "").trim(),
  );
}

function readyGeometryFixture({ stateId, imageHash, text }) {
  const geometry = {
    version: 1,
    state_id: stateId,
    document: { width: 1365, height: 2400 },
    viewport: { width: 1365, height: 768 },
    device_pixel_ratio: 1,
    paint_stack: {
      contract: "browser-paint-stack-v1",
      status: "verified",
    },
    nodes: [{
      order: 0,
      path: "main > p",
      text,
      separator_before: "",
      rects: [{ x: 120, y: 420, width: 700, height: 28 }],
      runs: [{
        start: 0,
        end: text.length,
        text,
        rects: [{ x: 120, y: 420, width: 700, height: 28 }],
      }],
    }],
  };
  const binding = {
    capturedAt: "2026-07-14T20:00:00.000Z",
    imageHash,
    imageRef: `${stateId}.jpg`,
    screenshot: {
      css_width: 1365,
      css_height: 2400,
      pixel_width: 1365,
      pixel_height: 2400,
    },
  };
  const preliminary = bindVisualTextGeometry(geometry, binding);
  const fingerprint = visualTextGeometryLayoutFingerprint({
    ...preliminary,
    version: 1,
  });
  return bindVisualTextGeometry({
    ...preliminary,
    version: 1,
    geometry_hash: undefined,
    capture_verification: {
      contract: "visual-screenshot-layout-binding-v1",
      status: "verified",
      before_fingerprint: fingerprint,
      after_fingerprint: fingerprint,
    },
  }, binding);
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
