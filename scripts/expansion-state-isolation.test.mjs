import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import {
  discoverExpansionStateDescriptors,
  verifyExpansionStateIsolation,
  withIsolatedExpansionStatePage,
} from "./lib/expansion-state-isolation.mjs";
import { captureVisibleTextGeometry } from "./lib/visible-text-geometry.mjs";
import { verifyVisualScreenshotLayoutCapture } from "./lib/visual-event-localization.mjs";

const chromePath = findChromeExecutable();
const browserIt = chromePath ? it : it.skip;

describe("expansion state isolation", () => {
  it("fails closed when a Chromium isolated world cannot be established", async () => {
    const geometry = await captureVisibleTextGeometry({
      viewportSize: () => ({ width: 900, height: 700 }),
      context: () => ({}),
    }, {
      capturedAt: "2026-07-17T19:30:00.000Z",
      stateId: "isolation-unavailable",
    });

    expect(geometry).toMatchObject({
      state_id: "isolation-unavailable",
      availability_status: "unavailable_isolated_world",
      paint_stack: {
        contract: "browser-paint-stack-v1",
        status: "unavailable",
      },
      nodes: [],
    });
    expect(geometry.unavailable_reason).toContain("CDP isolated worlds are unavailable");
  });

  browserIt("captures every stateful accordion candidate on a fresh page without inherited panels", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(statefulAccordionFixture())}`;
    try {
      const sequentialPage = await context.newPage();
      await sequentialPage.goto(url);
      await sequentialPage.click("#eligibility-control");
      await sequentialPage.click("#materials-control");
      expect(await visiblePanelIds(sequentialPage)).toEqual(["eligibility-panel", "materials-panel"]);
      await sequentialPage.close();

      const discoveryPage = await context.newPage();
      await discoveryPage.goto(url);
      const setup = await discoverExpansionStateDescriptors(discoveryPage, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      const collapsedGeometry = await captureVisibleTextGeometry(discoveryPage, { stateId: "main" });
      const collapsedText = geometryText(collapsedGeometry);
      await discoveryPage.close();
      expect(setup.descriptors.map((descriptor) => descriptor.id)).toEqual([
        "eligibility-control",
        "materials-control",
      ]);
      expect(collapsedText).not.toContain("Applicants must have a 3.5 GPA");
      expect(collapsedText).not.toContain("A portfolio and two recommendations are required");

      const captureDescriptor = (descriptor) => withIsolatedExpansionStatePage({
        context,
        url,
        descriptor,
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async (page, opened) => ({
          opened,
          verified: await verifyExpansionStateIsolation(page, {
            descriptor,
            descriptors: setup.descriptors,
          }),
          visiblePanels: await visiblePanelIds(page),
          geometryText: geometryText(await captureVisibleTextGeometry(page, {
            stateId: descriptor.id,
          })),
        }),
      });

      const eligibility = await captureDescriptor(setup.descriptors[0]);
      expect(eligibility.opened).toMatchObject({
        verified: true,
        fresh_page: true,
        other_open_selectors: [],
      });
      expect(eligibility.verified.verified).toBe(true);
      expect(eligibility.visiblePanels).toEqual(["eligibility-panel"]);
      expect(eligibility.geometryText).toContain("Applicants must have a 3.5 GPA");
      expect(eligibility.geometryText).not.toContain("A portfolio and two recommendations are required");
      expect(context.pages()).toHaveLength(0);

      const materials = await captureDescriptor(setup.descriptors[1]);
      expect(materials.opened).toMatchObject({
        verified: true,
        fresh_page: true,
        other_open_selectors: [],
      });
      expect(materials.verified.verified).toBe(true);
      expect(materials.visiblePanels).toEqual(["materials-panel"]);
      expect(materials.visiblePanels).not.toContain("eligibility-panel");
      expect(materials.geometryText).toContain("A portfolio and two recommendations are required");
      expect(materials.geometryText).not.toContain("Applicants must have a 3.5 GPA");
      expect(context.pages()).toHaveLength(0);
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  browserIt("filters containers and navigation before the state cap while retaining actionable controls", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    try {
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(actionableControlsFixture())}`);
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 2,
        relevanceMode: "award-content",
      });

      expect(setup.descriptors.map((descriptor) => descriptor.id)).toEqual([
        "eligibility-button",
        "custom-application-toggle",
      ]);
      expect(setup.descriptors.map((descriptor) => descriptor.tag)).toEqual(["BUTTON", "DIV"]);
      expect(new Set(setup.descriptors.map((descriptor) => descriptor.state_key)).size).toBe(2);
      expect(setup.descriptors.some((descriptor) => descriptor.id?.startsWith("control-"))).toBe(false);

      const disabled = await discoverExpansionStateDescriptors(page, {
        maxControls: 0,
        relevanceMode: "award-content",
      });
      expect(disabled.descriptors).toEqual([]);
    } finally {
      await page.close();
      await context.close();
      await browser.close();
    }
  }, 30_000);

  browserIt("discovers deadline, award, and grant sections in the default award-content mode", async () => {
    await withFixture(coreAwardDetailsFixture(), async ({ page }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });

      expect(setup).toMatchObject({
        candidates: 3,
        descriptor_set_complete: true,
        truncated: false,
        truncated_count: 0,
      });
      expect(setup.descriptors.map((descriptor) => descriptor.label)).toEqual([
        "Deadlines",
        "Award details",
        "Grant terms",
      ]);
    });
  }, 30_000);

  browserIt("reports the complete eligible-control count when the screenshot cap truncates capture", async () => {
    await withFixture(manyFaqDetailsFixture(9), async ({ page }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });

      expect(setup).toMatchObject({
        candidates: 9,
        capture_limit: 8,
        descriptor_set_complete: false,
        truncated: true,
        truncated_count: 1,
      });
      expect(setup.descriptors).toHaveLength(8);
      expect(setup.isolation_descriptors).toHaveLength(9);
      expect(setup.descriptors.at(-1)?.label).toBe("FAQ 8");
    });
  }, 30_000);

  browserIt("isolates against known logical panels beyond the screenshot cap", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(
      manyFaqDetailsFixture(25, { openIndex: 25 }),
    )}`;
    const discoveryPage = await context.newPage();
    try {
      await discoveryPage.goto(url);
      const setup = await discoverExpansionStateDescriptors(discoveryPage, {
        maxControls: 24,
        relevanceMode: "award-content",
      });
      expect(setup).toMatchObject({
        candidates: 25,
        descriptor_set_complete: false,
        isolation_descriptor_set_complete: true,
        truncated_count: 1,
      });
      expect(setup.descriptors).toHaveLength(24);
      expect(setup.isolation_descriptors).toHaveLength(25);
      await discoveryPage.close();

      const target = setup.descriptors[0];
      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: target,
        descriptors: setup.isolation_descriptors,
        timeoutMs: 10_000,
        capture: async (page, opened) => ({
          opened,
          openLabels: await page.locator("details[open] > summary")
            .evaluateAll((elements) => elements.map((element) => element.textContent.trim())),
        }),
      });
      expect(captured.opened).toMatchObject({
        verified: true,
        reason: "target_only_verified",
        other_open_selectors: [],
      });
      expect(captured.openLabels).toEqual(["FAQ 1"]);
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  browserIt("canonicalizes all Samvid-style Elementor panels and captures one exact animated state", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1365, height: 1600 } });
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(samvidElementorFixture())}`;
    const discoveryPage = await context.newPage();
    try {
      await discoveryPage.goto(url);
      const setup = await discoverExpansionStateDescriptors(discoveryPage, {
        maxControls: 24,
        relevanceMode: "award-content",
      });

      // The page's one fragment scroll-link to visible content is excluded at
      // discovery (navigation, not an expansion control) instead of surviving
      // to the non-panel removal pass: one fewer raw candidate, zero removals.
      expect(setup).toMatchObject({
        raw_candidates: 40,
        candidates: 20,
        duplicate_controls_removed: 20,
        non_panel_controls_removed: 0,
        capture_limit: 24,
        descriptor_set_complete: true,
        truncated: false,
        truncated_count: 0,
      });
      expect(setup.descriptors).toHaveLength(20);
      expect(setup.descriptors.every((descriptor) =>
        descriptor.state_kind === "targets" &&
        descriptor.role === "button" &&
        descriptor.aria_controls &&
        descriptor.panel_selectors?.[0] === `#${descriptor.aria_controls}`)).toBe(true);
      expect(setup.descriptors.map((descriptor) => descriptor.id)).toEqual(expect.arrayContaining([
        "elementor-tab-title-2303",
        "elementor-tab-title-23010",
        "elementor-tab-title-6241",
        "elementor-tab-title-6243",
      ]));

      const capped = await discoverExpansionStateDescriptors(discoveryPage, {
        maxControls: 19,
        relevanceMode: "award-content",
      });
      expect(capped).toMatchObject({
        candidates: 20,
        capture_limit: 19,
        descriptor_set_complete: false,
        truncated: true,
        truncated_count: 1,
      });
      expect(capped.descriptors).toHaveLength(19);

      await discoveryPage.close();
      const target = setup.descriptors.find((descriptor) => descriptor.id === "elementor-tab-title-1055");
      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: target,
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async (page, opened) => ({
          opened,
          verification: await verifyExpansionStateIsolation(page, {
            descriptor: target,
            descriptors: setup.descriptors,
          }),
          openControls: await page.locator(".elementor-tab-title[aria-expanded='true']")
            .evaluateAll((elements) => elements.map((element) => element.id)),
          text: geometryText(await captureVisibleTextGeometry(page, {
            stateId: "samvid-elementor-1055",
          })),
        }),
      });

      expect(captured.opened).toMatchObject({
        verified: true,
        reason: "target_only_verified",
        exact_elementor_binding: true,
        bound_content_transition_required: true,
        bound_content_transition_verified: true,
        other_open_selectors: [],
      });
      expect(captured.verification).toMatchObject({
        verified: true,
        exact_elementor_binding: true,
      });
      expect(captured.openControls).toEqual(["elementor-tab-title-1055"]);
      expect(captured.text).toContain("Dual-degree candidates remain eligible");
      expect(captured.text).not.toContain("Default-open content from another widget");
      expect(context.pages()).toHaveLength(0);
    } finally {
      await discoveryPage.close().catch(() => null);
      await context.close();
      await browser.close();
    }
  }, 30_000);

  browserIt("isolates an ARIA-less WPBakery panel whose slide outlasts the default settle budget", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(wpBakeryAccordionFixture())}`;
    const discoveryPage = await context.newPage();
    try {
      await discoveryPage.goto(url);
      const setup = await discoverExpansionStateDescriptors(discoveryPage, {
        maxControls: 24,
        relevanceMode: "award-content",
      });
      await discoveryPage.close();
      // The permanently open browser-help group is not an expansion state: it
      // can never be toggled, so it must not become a candidate.
      expect(setup.descriptors).toHaveLength(4);
      expect(setup.descriptors.some((descriptor) =>
        /Having issues/i.test(descriptor.label || ""))).toBe(false);

      const slowPanel = setup.descriptors.find((descriptor) => /ESSAY/i.test(descriptor.label || ""));
      expect(slowPanel).toBeTruthy();
      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: slowPanel,
        descriptors: setup.descriptors,
        timeoutMs: 20_000,
        capture: async (page, opened) => ({
          opened,
          verification: await verifyExpansionStateIsolation(page, {
            descriptor: slowPanel,
            descriptors: setup.descriptors,
          }),
          openPanels: await page.locator(".vc_tta-panel.vc_active")
            .evaluateAll((elements) => elements.map((element) => element.id)),
          text: geometryText(await captureVisibleTextGeometry(page, {
            stateId: "gilman-vc-tta-essays",
          })),
        }),
      });

      expect(captured.opened).toMatchObject({
        verified: true,
        reason: "target_only_verified",
        exact_accordion_family: "vc_tta",
        exact_elementor_binding: false,
        bound_content_transition_required: true,
        bound_content_transition_verified: true,
        other_open_selectors: [],
      });
      expect(captured.verification).toMatchObject({ verified: true });
      expect(captured.openPanels).toEqual(expect.arrayContaining(["vc-essay"]));
      expect(captured.openPanels).not.toContain("vc-elig");
      expect(captured.text).toContain("Two essays are required");
      expect(captured.text).not.toContain("Applicants must be enrolled at an accredited institution");
      expect(context.pages()).toHaveLength(0);
    } finally {
      await discoveryPage.close().catch(() => null);
      await context.close();
      await browser.close();
    }
  }, 60_000);

  browserIt("keeps WPBakery peer panels out of a captured state", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(wpBakeryAccordionFixture())}`;
    const discoveryPage = await context.newPage();
    try {
      await discoveryPage.goto(url);
      const setup = await discoverExpansionStateDescriptors(discoveryPage, {
        maxControls: 24,
        relevanceMode: "award-content",
      });
      await discoveryPage.close();
      const target = setup.descriptors.find((descriptor) => /ELIGIBILITY/i.test(descriptor.label || ""));
      expect(target).toBeTruthy();
      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: target,
        descriptors: setup.descriptors,
        timeoutMs: 20_000,
        capture: async (page, opened) => ({
          opened,
          openPanels: await page.locator(".vc_tta-panel.vc_active")
            .evaluateAll((elements) => elements.map((element) => element.id)),
          text: geometryText(await captureVisibleTextGeometry(page, {
            stateId: "gilman-vc-tta-eligibility",
          })),
        }),
      });

      expect(captured.opened).toMatchObject({
        verified: true,
        reason: "target_only_verified",
        exact_accordion_family: "vc_tta",
        bound_content_transition_verified: true,
        other_open_selectors: [],
      });
      expect(captured.openPanels).toEqual(expect.arrayContaining(["vc-elig"]));
      expect(captured.openPanels).not.toContain("vc-essay");
      expect(captured.text).toContain("Applicants must be enrolled at an accredited institution");
      expect(captured.text).not.toContain("Two essays are required");
    } finally {
      await discoveryPage.close().catch(() => null);
      await context.close();
      await browser.close();
    }
  }, 60_000);

  browserIt("deduplicates native details aliases and keeps the opened wording in geometry", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(nativeDetailsFixture())}`;
    const discoveryPage = await context.newPage();
    try {
      await discoveryPage.goto(url);
      const setup = await discoverExpansionStateDescriptors(discoveryPage, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(1);
      expect(setup.descriptors[0]).toMatchObject({ tag: "SUMMARY", state_kind: "details" });
      await discoveryPage.close();

      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async (page, opened) => ({
          opened,
          verified: await verifyExpansionStateIsolation(page, {
            descriptor: setup.descriptors[0],
            descriptors: setup.descriptors,
          }),
          text: geometryText(await captureVisibleTextGeometry(page, { stateId: "details-open" })),
        }),
      });

      expect(captured.opened).toMatchObject({ verified: true, reason: "target_only_verified" });
      expect(captured.verified.verified).toBe(true);
      expect(captured.text).toContain("The identification badge requires two official documents");
      expect(context.pages()).toHaveLength(0);
    } finally {
      await discoveryPage.close().catch(() => null);
      await context.close();
      await browser.close();
    }
  }, 30_000);

  browserIt("verifies unannotated accordion buttons through their adjacent content panels", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(adjacentPanelFixture())}`;
    const discoveryPage = await context.newPage();
    try {
      await discoveryPage.goto(url);
      const setup = await discoverExpansionStateDescriptors(discoveryPage, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors.map((descriptor) => descriptor.state_kind)).toEqual([
        "adjacent-panel",
        "adjacent-panel",
      ]);
      await discoveryPage.close();

      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async (page, opened) => ({
          opened,
          verified: await verifyExpansionStateIsolation(page, {
            descriptor: setup.descriptors[0],
            descriptors: setup.descriptors,
          }),
          text: geometryText(await captureVisibleTextGeometry(page, { stateId: "adjacent-open" })),
        }),
      });

      expect(captured.opened).toMatchObject({
        verified: true,
        bound_content_transition_required: true,
        bound_content_transition_verified: true,
      });
      expect(captured.verified.verified).toBe(true);
      expect(captured.text).toContain("Applicants must hold a qualifying undergraduate degree");
      expect(captured.text).not.toContain("Two recommendation letters are required");
      expect(context.pages()).toHaveLength(0);
    } finally {
      await discoveryPage.close().catch(() => null);
      await context.close();
      await browser.close();
    }
  }, 30_000);

  browserIt("opens numeric fragment targets by checking the hidden panel body rather than its visible heading", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(numericFragmentFixture())}`;
    const discoveryPage = await context.newPage();
    try {
      await discoveryPage.goto(url);
      const setup = await discoverExpansionStateDescriptors(discoveryPage, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(2);
      expect(setup.descriptors.every((descriptor) => descriptor.state_kind === "targets")).toBe(true);
      await discoveryPage.close();

      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async (page) => ({
          verified: await verifyExpansionStateIsolation(page, {
            descriptor: setup.descriptors[0],
            descriptors: setup.descriptors,
          }),
          text: geometryText(await captureVisibleTextGeometry(page, { stateId: "numeric-target-open" })),
        }),
      });

      expect(captured.verified.verified).toBe(true);
      expect(captured.text).toContain("Applicants must be United States citizens or nationals");
      expect(captured.text).not.toContain("Applications close on October 6");
      expect(context.pages()).toHaveLength(0);
    } finally {
      await discoveryPage.close().catch(() => null);
      await context.close();
      await browser.close();
    }
  }, 30_000);

  browserIt("fails closed and never captures when a bound panel does not actually open", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(noOpAccordionFixture())}`;
    const discoveryPage = await context.newPage();
    let captureCalled = false;
    try {
      await discoveryPage.goto(url);
      const setup = await discoverExpansionStateDescriptors(discoveryPage, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(1);
      await discoveryPage.close();

      await expect(withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async () => {
          captureCalled = true;
        },
      })).rejects.toThrow(/target_not_open|bound_content_did_not_transition/);
      expect(captureCalled).toBe(false);
      expect(context.pages()).toHaveLength(0);
    } finally {
      await discoveryPage.close().catch(() => null);
      await context.close();
      await browser.close();
    }
  }, 30_000);

  browserIt("fails closed when a non-target says collapsed but its wording remains readable", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(
      genericExclusiveAccordionFixture({ stuckVisible: true }),
    )}`;
    const discoveryPage = await context.newPage();
    let captureCalled = false;
    try {
      await discoveryPage.goto(url);
      const setup = await discoverExpansionStateDescriptors(discoveryPage, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(2);
      await discoveryPage.close();

      await expect(withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.isolation_descriptors,
        timeoutMs: 10_000,
        capture: async () => {
          captureCalled = true;
        },
      })).rejects.toThrow(/other_control_aria_false_but_content_readable/);
      expect(captureCalled).toBe(false);
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  browserIt("waits for a slow generic panel to become unreadable before capturing", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(
      genericExclusiveAccordionFixture({ slowCloseMs: 500 }),
    )}`;
    const discoveryPage = await context.newPage();
    try {
      await discoveryPage.goto(url);
      const setup = await discoverExpansionStateDescriptors(discoveryPage, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      await discoveryPage.close();

      const startedAt = Date.now();
      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.isolation_descriptors,
        timeoutMs: 10_000,
        capture: async (page, opened) => ({
          opened,
          otherHidden: await page.locator("#other-panel").evaluate((element) => element.hidden),
          text: geometryText(await captureVisibleTextGeometry(page, { stateId: "slow-generic-close" })),
        }),
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
      expect(captured.opened).toMatchObject({
        verified: true,
        reason: "target_only_verified",
        other_open_selectors: [],
      });
      expect(captured.otherHidden).toBe(true);
      expect(captured.text).toContain("Target eligibility guidance");
      expect(captured.text).not.toContain("Other application guidance");
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  browserIt("opens an inactive ARIA tab before verifying its active peer closed", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(exclusiveAriaTabsFixture())}`;
    const discoveryPage = await context.newPage();
    try {
      await discoveryPage.goto(url);
      const setup = await discoverExpansionStateDescriptors(discoveryPage, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(2);
      await discoveryPage.close();

      const target = setup.descriptors.find((descriptor) => descriptor.id === "application-tab");
      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: target,
        descriptors: setup.isolation_descriptors,
        timeoutMs: 10_000,
        capture: async (page, opened) => ({
          opened,
          selectedTabs: await page.locator("[role='tab'][aria-selected='true']")
            .evaluateAll((elements) => elements.map((element) => element.id)),
          visiblePanels: await page.locator("[role='tabpanel']:not([hidden])")
            .evaluateAll((elements) => elements.map((element) => element.id)),
          text: geometryText(await captureVisibleTextGeometry(page, { stateId: "aria-tab-application" })),
        }),
      });
      expect(captured.opened).toMatchObject({
        verified: true,
        reason: "target_only_verified",
        other_open_selectors: [],
      });
      expect(captured.selectedTabs).toEqual(["application-tab"]);
      expect(captured.visiblePanels).toEqual(["application-panel"]);
      expect(captured.text).toContain("Application materials require two recommendations");
      expect(captured.text).not.toContain("Eligibility requires an undergraduate degree");
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  browserIt("cycles through a peer to prove an initially active ARIA tab state", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(exclusiveAriaTabsFixture())}`;
    const discoveryPage = await context.newPage();
    try {
      await discoveryPage.goto(url);
      const setup = await discoverExpansionStateDescriptors(discoveryPage, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      await discoveryPage.close();

      const target = setup.descriptors.find((descriptor) => descriptor.id === "eligibility-tab");
      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: target,
        descriptors: setup.isolation_descriptors,
        timeoutMs: 10_000,
        capture: async (page, opened) => ({
          opened,
          selectedTabs: await page.locator("[role='tab'][aria-selected='true']")
            .evaluateAll((elements) => elements.map((element) => element.id)),
          visiblePanels: await page.locator("[role='tabpanel']:not([hidden])")
            .evaluateAll((elements) => elements.map((element) => element.id)),
          text: geometryText(await captureVisibleTextGeometry(page, { stateId: "aria-tab-eligibility" })),
        }),
      });
      expect(captured.opened).toMatchObject({
        verified: true,
        reason: "target_only_verified",
        bound_content_transition_required: true,
        bound_content_transition_verified: true,
        other_open_selectors: [],
      });
      expect(captured.selectedTabs).toEqual(["eligibility-tab"]);
      expect(captured.visiblePanels).toEqual(["eligibility-panel"]);
      expect(captured.text).toContain("Eligibility requires an undergraduate degree");
      expect(captured.text).not.toContain("Application materials require two recommendations");
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  browserIt("finds non-relevant exclusive peers and rejects a target that leaves them readable", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(brokenExclusiveAriaTabsFixture())}`;
    const discoveryPage = await context.newPage();
    let captureCalled = false;
    try {
      await discoveryPage.goto(url);
      const setup = await discoverExpansionStateDescriptors(discoveryPage, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors.map((descriptor) => descriptor.id)).toEqual(["relevant-tab"]);
      await discoveryPage.close();

      await expect(withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.isolation_descriptors,
        timeoutMs: 10_000,
        capture: async () => {
          captureCalled = true;
        },
      })).rejects.toThrow(/bound_content_did_not_transition|other_controls_remain_open/);
      expect(captureCalled).toBe(false);
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  browserIt("rejects a no-ARIA clipped text sliver when clicking does not expand readable content", async () => {
    await withFixture(clippedNoHandlerAccordionFixture(), async ({ context, page, url }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(1);
      expect(setup.descriptors[0].state_kind).toBe("adjacent-panel");
      expect(await page.locator("article").evaluate((panel) => ({
        height: panel.getBoundingClientRect().height,
        scrollHeight: panel.scrollHeight,
      }))).toMatchObject({ height: 2 });
      expect(await page.locator("article").evaluate((panel) => panel.scrollHeight)).toBeGreaterThan(2);
      let captureCalled = false;

      await expect(withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async () => {
          captureCalled = true;
        },
      })).rejects.toThrow(/bound_content_did_not_transition|target_not_open/);
      expect(captureCalled).toBe(false);
    });
  }, 30_000);

  browserIt("uses the same paint and screenshot-bound visibility rules for expansion and geometry", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const rejectedCases = [
      { name: "transparent color", panelStyle: "color: transparent" },
      { name: "near-transparent color alpha", panelStyle: "color: rgba(0, 0, 0, 0.001)" },
      { name: "transparent webkit text fill", panelStyle: "-webkit-text-fill-color: transparent" },
      { name: "near-transparent opacity", panelStyle: "opacity: 0.001" },
      { name: "near-transparent filter opacity", panelStyle: "filter: opacity(0.001)" },
      { name: "cumulative ancestor opacity", wrapperStyle: "opacity: 0.1", panelStyle: "opacity: 0.1" },
      { name: "white on white", panelStyle: "color: white; background-color: white" },
      {
        name: "same foreground and background",
        panelStyle: "color: rgb(24, 48, 72); background-color: rgb(24, 48, 72)",
      },
      { name: "same color on inherited background", wrapperStyle: "background: white", panelStyle: "color: white" },
      {
        name: "unresolved background with suspicious fallback contrast",
        panelStyle: "color: white; background-color: white; background-image: linear-gradient(black, black)",
      },
      {
        name: "background image masks text despite contrasting fallback",
        panelStyle: "color: black; background-color: white; background-image: linear-gradient(black, black)",
      },
      {
        name: "ancestor gradient remains visible through transparent card",
        bodyStyle: "background-image: linear-gradient(red, blue)",
        panelStyle: "color: black; background-color: transparent",
      },
      {
        name: "ancestor gradient remains visible through semitransparent card",
        bodyStyle: "background-image: linear-gradient(red, blue)",
        panelStyle: "color: black; background-color: rgba(255, 255, 255, 0.8)",
      },
      {
        name: "display contents background cannot occlude ancestor gradient",
        bodyStyle: "background-image: linear-gradient(red, blue)",
        wrapperStyle: "display: contents; background-color: white",
        panelStyle: "color: black; background-color: transparent",
      },
      {
        name: "overflow-visible text outside opaque card cannot use its background",
        bodyStyle: "background-image: linear-gradient(red, blue)",
        panelStyle: "position: relative; width: 300px; height: 40px; overflow: visible; color: black; background-color: white",
        contentStyle: "position: absolute; left: 360px; top: 0; white-space: nowrap",
      },
      {
        name: "text outside content-box background clip cannot use opaque card",
        bodyStyle: "background-image: linear-gradient(red, blue)",
        panelStyle: "box-sizing: border-box; position: relative; width: 420px; height: 100px; padding: 40px; overflow: visible; color: black; background-color: white; background-clip: content-box",
        contentStyle: "position: absolute; left: 0; top: 0; white-space: nowrap",
      },
      {
        name: "text in rounded corner outside painted card cannot use opaque background",
        bodyStyle: "background-image: linear-gradient(red, blue)",
        panelStyle: "position: relative; width: 420px; height: 100px; border-radius: 50px; overflow: visible; color: black; background-color: white",
        contentStyle: "position: absolute; left: 0; top: 0; white-space: nowrap",
      },
      {
        name: "ancestor opacity disables opaque-card occlusion proof",
        bodyStyle: "background-image: linear-gradient(red, blue)",
        wrapperStyle: "opacity: 0.9",
        panelStyle: "color: black; background-color: white",
      },
      {
        name: "ancestor filter disables opaque-card occlusion proof",
        bodyStyle: "background-image: linear-gradient(red, blue)",
        wrapperStyle: "filter: opacity(0.9)",
        panelStyle: "color: black; background-color: white",
      },
      {
        name: "ancestor mask disables opaque-card occlusion proof",
        bodyStyle: "background-image: linear-gradient(red, blue)",
        wrapperStyle: "mask-image: linear-gradient(black, black)",
        panelStyle: "color: black; background-color: white",
      },
      {
        name: "ancestor blend disables opaque-card occlusion proof",
        bodyStyle: "background-image: linear-gradient(red, blue)",
        wrapperStyle: "mix-blend-mode: multiply",
        panelStyle: "color: black; background-color: white",
      },
      {
        name: "ancestor backdrop disables opaque-card occlusion proof",
        bodyStyle: "background-image: linear-gradient(red, blue)",
        wrapperStyle: "backdrop-filter: blur(1px)",
        panelStyle: "color: black; background-color: white",
      },
      { name: "empty inset clip path", panelStyle: "clip-path: inset(50%)" },
      { name: "empty legacy clip", panelStyle: "position: absolute; clip: rect(0, 0, 0, 0)" },
      {
        name: "thin diagonal polygon clip",
        panelStyle: "display: block; width: 420px; clip-path: polygon(0 0, 1% 0, 100% 100%, 99% 100%)",
      },
      {
        name: "thin ellipse clip",
        panelStyle: "display: block; width: 420px; clip-path: ellipse(5% 30% at 50% 50%)",
      },
      {
        name: "one pixel screen reader text",
        panelStyle: "position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; white-space: nowrap; border: 0",
      },
      { name: "negative left off-canvas", panelStyle: "position: absolute; left: -5000px" },
      { name: "translated off-canvas", panelStyle: "transform: translateX(-5000px)" },
    ];
    try {
      for (const rejectedCase of rejectedCases) {
        const page = await context.newPage();
        const url = `data:text/html;charset=utf-8,${encodeURIComponent(paintVisibilityFixture(rejectedCase))}`;
        try {
          await page.goto(url);
          const setup = await discoverExpansionStateDescriptors(page, {
            maxControls: 8,
            relevanceMode: "award-content",
          });
          expect(setup.descriptors, rejectedCase.name).toHaveLength(1);
          let captureCalled = false;
          await expect(withIsolatedExpansionStatePage({
            context,
            url,
            descriptor: setup.descriptors[0],
            descriptors: setup.descriptors,
            timeoutMs: 10_000,
            capture: async () => {
              captureCalled = true;
            },
          }), rejectedCase.name).rejects.toThrow(/bound_content_did_not_transition|target_not_open/);
          expect(captureCalled, rejectedCase.name).toBe(false);

          await page.evaluate(() => {
            document.querySelector("button").setAttribute("aria-expanded", "true");
            document.querySelector("section").hidden = false;
          });
          const geometry = await captureVisibleTextGeometry(page, { stateId: `rejected-${rejectedCase.name}` });
          expect(geometry.nodes, rejectedCase.name).toEqual([]);
        } finally {
          await page.close().catch(() => null);
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }
  }, 120_000);

  browserIt("retains normally painted in-bounds text in expansion geometry", async () => {
    await withFixture(paintVisibilityFixture(), async ({ context, page, url }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(1);

      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async (statePage) => captureVisibleTextGeometry(statePage, { stateId: "painted-normal" }),
      });
      expect(captured.nodes).toHaveLength(1);
      expect(captured.nodes[0].text).toContain("Applicants must satisfy eligibility requirements");
    });
  }, 30_000);

  browserIt("retains legitimate inverse foreground contrast against a resolved solid ancestor background", async () => {
    await withFixture(paintVisibilityFixture({
      wrapperStyle: "background-color: rgb(10, 45, 90)",
      panelStyle: "color: white",
    }), async ({ context, page, url }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async (statePage) => captureVisibleTextGeometry(statePage, { stateId: "painted-background" }),
      });
      expect(geometryText(captured)).toContain("Applicants must satisfy eligibility requirements");
    });
  }, 30_000);

  browserIt("retains an opaque normally composited card over a lower body gradient", async () => {
    await withFixture(paintVisibilityFixture({
      bodyStyle: "background-image: linear-gradient(red, blue)",
      panelStyle: "color: black; background-color: white",
    }), async ({ context, page, url }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async (statePage) => captureVisibleTextGeometry(statePage, { stateId: "opaque-over-gradient" }),
      });
      expect(geometryText(captured)).toContain("Applicants must satisfy eligibility requirements");
    });
  }, 30_000);

  browserIt("retains genuinely readable partial rectangular, polygon, ellipse, and legacy clips", async () => {
    const acceptedCases = [
      {
        name: "partial inset",
        panelStyle: "display: block; width: 420px; clip-path: inset(0 0 0 40%)",
      },
      {
        name: "partial polygon",
        panelStyle: "display: block; width: 420px; clip-path: polygon(0 0, 60% 0, 60% 100%, 0 100%)",
      },
      {
        name: "partial ellipse",
        panelStyle: "display: block; width: 420px; clip-path: ellipse(40% 50% at 50% 50%)",
      },
      {
        name: "partial legacy clip",
        panelStyle: "position: absolute; display: block; width: 420px; height: 40px; clip: rect(0px, 380px, 40px, 20px)",
      },
    ];
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    try {
      for (const acceptedCase of acceptedCases) {
        const page = await context.newPage();
        const url = `data:text/html;charset=utf-8,${encodeURIComponent(paintVisibilityFixture(acceptedCase))}`;
        try {
          await page.goto(url);
          const setup = await discoverExpansionStateDescriptors(page, {
            maxControls: 8,
            relevanceMode: "award-content",
          });
          expect(setup.descriptors, acceptedCase.name).toHaveLength(1);
          const captured = await withIsolatedExpansionStatePage({
            context,
            url,
            descriptor: setup.descriptors[0],
            descriptors: setup.descriptors,
            timeoutMs: 10_000,
            capture: async (statePage) => captureVisibleTextGeometry(statePage, {
              stateId: `accepted-${acceptedCase.name}`,
            }),
          });
          expect(geometryText(captured), acceptedCase.name).toContain(
            "Applicants must satisfy eligibility requirements",
          );
        } finally {
          await page.close().catch(() => null);
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }
  }, 60_000);

  browserIt("retains full-page text below the viewport while enforcing screenshot document bounds", async () => {
    await withFixture(paintVisibilityFixture({ wrapperStyle: "margin-top: 900px" }), async ({ context, page, url }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async (statePage) => captureVisibleTextGeometry(statePage, { stateId: "below-viewport" }),
      });
      expect(geometryText(captured)).toContain("Applicants must satisfy eligibility requirements");
      expect(captured.nodes[0].rects[0].y).toBeGreaterThan(captured.viewport.height);
      expect(captured.nodes[0].rects[0].bottom).toBeLessThanOrEqual(captured.document.height);
    });
  }, 30_000);

  browserIt("excludes exact wording covered by clickable or click-through opaque overlays above or below the viewport", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    try {
      for (const pointerEvents of ["auto", "none"]) {
        for (const wrapperStyle of ["", "margin-top: 900px"]) {
          const page = await context.newPage();
          try {
            await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(paintVisibilityFixture({
              wrapperStyle,
              overlayStyle: `position: absolute; inset: 0; z-index: 9999; background: white; pointer-events: ${pointerEvents}`,
            }))}`);
            await page.evaluate(() => {
              document.querySelector("button").setAttribute("aria-expanded", "true");
              document.querySelector("section").hidden = false;
            });
            const geometry = await captureVisibleTextGeometry(page, {
              stateId: `${wrapperStyle ? "covered-below-viewport" : "covered-in-viewport"}-${pointerEvents}`,
            });
            expect(geometry.paint_stack).toMatchObject({
              contract: "browser-paint-stack-v1",
              status: "verified",
            });
            expect(geometryText(geometry)).not.toContain(
              "Applicants must satisfy eligibility requirements",
            );
            expect(geometry.paint_stack.rejected_rect_count).toBeGreaterThan(0);
            await expect.poll(() => page.evaluate(() =>
              document.querySelector("[data-test-paint-overlay]").style.pointerEvents,
            )).toBe(pointerEvents);
          } finally {
            await page.close().catch(() => null);
          }
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }
  }, 45_000);

  browserIt("ignores hostile main-world elementsFromPoint tampering and keeps covered wording unavailable", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1_000, height: 800 } });
    const hiddenPhrase = "Applications close February 1, 2027.";
    const runCase = async (hostile) => {
      const page = await context.newPage();
      const hostileScript = hostile
        ? `<script>
            window.__hostileHitTestCalls = 0;
            const nativeElementsFromPoint = document.elementsFromPoint.bind(document);
            document.elementsFromPoint = function hostileElementsFromPoint(x, y) {
              window.__hostileHitTestCalls += 1;
              const target = document.getElementById("secret");
              const rect = target.getBoundingClientRect();
              if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                return [target, ...nativeElementsFromPoint(x, y).filter((item) => item !== target)];
              }
              return nativeElementsFromPoint(x, y);
            };
          </script>`
        : "";
      try {
        await page.setContent(`<!doctype html>
          <style>
            html, body { margin: 0; width: 1000px; height: 800px; overflow: hidden; background: white; }
            #stage { position: relative; width: 1000px; height: 800px; }
            #secret { position: absolute; left: 120px; top: 230px; z-index: 1; width: 520px; height: 54px; margin: 0; color: #111; background: white; font: 24px/54px Arial; }
            #cover { position: absolute; left: 100px; top: 210px; z-index: 2; width: 580px; height: 94px; color: #064e3b; background: white; font: 700 24px/94px Arial; text-align: center; }
          </style>
          <main id="stage">
            <p id="secret">${hiddenPhrase}</p>
            <div id="cover">PUBLIC SAFE CONTENT</div>
          </main>
          ${hostileScript}`);
        const geometry = await captureVisibleTextGeometry(page, {
          stateId: hostile ? "hostile-main-world" : "clean-main-world",
        });
        return {
          geometry,
          screenshot: await page.screenshot({ type: "png" }),
          hostileCalls: await page.evaluate(() => Number(window.__hostileHitTestCalls || 0)),
          helperPresent: await page.evaluate(() =>
            Object.hasOwn(globalThis, "__awardPingVisibleTextVisibilityV4"),
          ),
        };
      } finally {
        await page.close().catch(() => null);
      }
    };
    try {
      const hostile = await runCase(true);
      const clean = await runCase(false);
      for (const result of [hostile, clean]) {
        expect(result.geometry.paint_stack).toMatchObject({
          contract: "browser-paint-stack-v1",
          status: "verified",
        });
        expect(geometryText(result.geometry)).not.toContain(hiddenPhrase);
        expect(geometryText(result.geometry)).toContain("PUBLIC SAFE CONTENT");
        expect(result.geometry.paint_stack.rejected_rect_count).toBeGreaterThan(0);
        expect(result.helperPresent).toBe(false);
      }
      expect(hostile.hostileCalls).toBe(0);
      expect(hostile.screenshot.equals(clean.screenshot)).toBe(true);
    } finally {
      await context.close().catch(() => null);
      await browser.close();
    }
  }, 30_000);

  browserIt("excludes exact wording covered by an opaque descendant of its text parent", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    try {
      for (const pointerEvents of ["auto", "none"]) {
        const page = await context.newPage();
        try {
          await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(paintVisibilityFixture({
            descendantOverlayStyle: `position: absolute; inset: 0; z-index: 9999; background: white; pointer-events: ${pointerEvents}`,
          }))}`);
          await page.evaluate(() => {
            document.querySelector("button").setAttribute("aria-expanded", "true");
            document.querySelector("section").hidden = false;
          });
          const geometry = await captureVisibleTextGeometry(page, {
            stateId: `covered-by-descendant-${pointerEvents}`,
          });

          expect(geometry.paint_stack).toMatchObject({
            contract: "browser-paint-stack-v1",
            status: "verified",
          });
          expect(geometryText(geometry)).not.toContain(
            "Applicants must satisfy eligibility requirements",
          );
          expect(geometry.paint_stack.rejected_rect_count).toBeGreaterThan(0);
          await expect.poll(() => page.evaluate(() =>
            document.querySelector("[data-test-descendant-overlay]").style.pointerEvents,
          )).toBe(pointerEvents);
        } finally {
          await page.close().catch(() => null);
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  browserIt("fails closed when a painted pseudo-element covers its originating text", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    try {
      await page.setContent(`<!doctype html>
        <style>
          #pseudo-covered {
            position: relative;
            display: inline-block;
            color: black;
          }
          #pseudo-covered::after {
            content: "";
            position: absolute;
            inset: 0;
            background: white;
            z-index: 2;
          }
        </style>
        <p id="pseudo-covered">PSEUDO COVERED UNIQUE WORDING</p>`);

      const geometry = await captureVisibleTextGeometry(page, {
        stateId: "covered-by-pseudo-element",
      });

      expect(geometryText(geometry)).not.toContain(
        "PSEUDO COVERED UNIQUE WORDING",
      );
      expect(geometry.paint_stack.rejected_rect_count).toBeGreaterThan(0);
    } finally {
      await page.close().catch(() => null);
      await browser.close();
    }
  }, 30_000);

  browserIt("uses the nearest rendered ancestor for display-contents text without rejecting static pseudo bullets", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    try {
      await page.setContent(`<!doctype html>
        <style>
          #static-bullet::before { content: "•"; margin-right: 0.5em; }
        </style>
        <p><span style="display: contents">DISPLAY CONTENTS UNIQUE WORDING</span></p>
        <p id="static-bullet">STATIC PSEUDO BULLET WORDING</p>`);

      const geometry = await captureVisibleTextGeometry(page, {
        stateId: "display-contents-and-static-pseudo",
      });
      const text = geometryText(geometry);

      expect(text).toContain("DISPLAY CONTENTS UNIQUE WORDING");
      expect(text).toContain("STATIC PSEUDO BULLET WORDING");
    } finally {
      await page.close().catch(() => null);
      await browser.close();
    }
  }, 30_000);

  browserIt("invalidates pre-screenshot geometry when the DOM resizes before image capture", async () => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    try {
      await page.setContent(`<!doctype html><main><p id="deadline">Applications close March 1.</p></main>`);
      const before = await captureVisibleTextGeometry(page, { stateId: "layout-drift" });
      await page.evaluate(() => {
        document.getElementById("deadline").style.marginTop = "240px";
      });
      await page.screenshot({ fullPage: true, type: "jpeg" });
      const after = await captureVisibleTextGeometry(page, { stateId: "layout-drift" });
      expect(verifyVisualScreenshotLayoutCapture({
        before,
        after,
        screenshot: { alignment_status: "verified" },
        stateId: "layout-drift",
      })).toMatchObject({
        availability_status: "unavailable_layout_changed_during_screenshot",
        capture_verification: { status: "unavailable" },
        nodes: [],
      });
    } finally {
      await page.close().catch(() => null);
      await browser.close();
    }
  }, 30_000);

  browserIt("requires visible bound content even when aria-expanded already says true", async () => {
    await withFixture(hiddenPanelAriaTrueFixture(), async ({ page }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(1);

      const verification = await verifyExpansionStateIsolation(page, {
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
      });
      expect(verification).toMatchObject({
        verified: false,
        reason: "target_not_open",
        target_open: false,
      });
    });
  }, 30_000);

  browserIt("excludes aria-only, unresolved, and unsafe explicit target controls", async () => {
    await withFixture(unboundAriaFixture(), async ({ page }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toEqual([]);
    });
  }, 30_000);

  browserIt("does not treat an ordinary visible hash panel as expansion state", async () => {
    await withFixture(ordinaryPanelAnchorFixture(), async ({ page }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toEqual([]);
    });
  }, 30_000);

  browserIt("parses numeric-leading aria-controls IDREFs and verifies their visible panel", async () => {
    await withFixture(numericAriaControlsFixture(), async ({ context, page, url }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(1);
      expect(setup.descriptors[0]).toMatchObject({
        aria_controls: "123-eligibility-panel",
        state_kind: "targets",
      });

      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: (statePage) => verifyExpansionStateIsolation(statePage, {
          descriptor: setup.descriptors[0],
          descriptors: setup.descriptors,
        }),
      });
      expect(captured.verified).toBe(true);
    });
  }, 30_000);

  browserIt("uses aria-label when a bound control has no visible text", async () => {
    await withFixture(ariaLabelControlFixture(), async ({ context, page, url }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(1);
      expect(setup.descriptors[0].label).toBe("Eligibility requirements");

      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: (statePage) => verifyExpansionStateIsolation(statePage, {
          descriptor: setup.descriptors[0],
          descriptors: setup.descriptors,
        }),
      });
      expect(captured.verified).toBe(true);
    });
  }, 30_000);

  browserIt("keeps stable state binding when a control label changes from Show to Hide", async () => {
    await withFixture(showHideControlFixture(), async ({ context, page, url }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(1);
      expect(setup.descriptors[0].label).toBe("Show application details");

      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async (statePage, opened) => ({
          opened,
          verification: await verifyExpansionStateIsolation(statePage, {
            descriptor: setup.descriptors[0],
            descriptors: setup.descriptors,
          }),
          label: await statePage.locator("#show-hide-control").textContent(),
        }),
      });
      expect(captured.opened).toMatchObject({
        bound_content_transition_required: true,
        bound_content_transition_verified: true,
      });
      expect(captured.verification.verified).toBe(true);
      expect(captured.label).toBe("Hide application details");
    });
  }, 30_000);

  browserIt("rejects a visible controlled wrapper when only ARIA changes and its bound wording stays hidden", async () => {
    await withFixture(visibleWrapperAriaOnlyFixture(), async ({ context, page, url }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(1);
      let captureCalled = false;

      await expect(withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async () => {
          captureCalled = true;
        },
      })).rejects.toThrow(/target_not_open|bound_content_did_not_transition/);
      expect(captureCalled).toBe(false);
    });
  }, 30_000);

  browserIt("accepts a visible controlled wrapper only when its bound body actually becomes visible", async () => {
    await withFixture(visibleWrapperRevealFixture(), async ({ context, page, url }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(1);

      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async (statePage, opened) => ({
          opened,
          verification: await verifyExpansionStateIsolation(statePage, {
            descriptor: setup.descriptors[0],
            descriptors: setup.descriptors,
          }),
          text: geometryText(await captureVisibleTextGeometry(statePage, { stateId: "wrapper-open" })),
        }),
      });
      expect(captured.opened).toMatchObject({
        bound_content_transition_required: true,
        bound_content_transition_verified: true,
      });
      expect(captured.verification.verified).toBe(true);
      expect(captured.text).toContain("Applicants must satisfy the published eligibility requirements");
    });
  }, 30_000);

  browserIt("uses deterministic structure and panel content when control and target IDs regenerate", async () => {
    await withFixture(regeneratedIdsFixture(), async ({ context, page, url }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(1);
      expect(setup.descriptors[0].structural_selector).toBe("html>body>main>button");
      expect(setup.descriptors[0].structural_fingerprint).toBeTruthy();

      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async (statePage) => ({
          controlId: await statePage.locator("main > button").getAttribute("id"),
          verification: await verifyExpansionStateIsolation(statePage, {
            descriptor: setup.descriptors[0],
            descriptors: setup.descriptors,
          }),
          text: geometryText(await captureVisibleTextGeometry(statePage, { stateId: "regenerated-id-open" })),
        }),
      });
      expect(captured.controlId).not.toBe(setup.descriptors[0].id);
      expect(captured.verification.verified).toBe(true);
      expect(captured.text).toContain("Applicants must submit two recommendations");
    });
  }, 30_000);

  browserIt("ignores a true placeholder href without weakening its valid ARIA binding", async () => {
    await withFixture(placeholderHrefFixture(), async ({ context, page, url }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(1);
      expect(setup.descriptors[0]).toMatchObject({
        href: "#",
        state_kind: "targets",
      });

      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: (statePage) => verifyExpansionStateIsolation(statePage, {
          descriptor: setup.descriptors[0],
          descriptors: setup.descriptors,
        }),
      });
      expect(captured.verified).toBe(true);
    });
  }, 30_000);

  browserIt("uses collapsed direct text for relevance when native details has a generic summary", async () => {
    await withFixture(rawTextDetailsFixture(), async ({ context, page, url }) => {
      const setup = await discoverExpansionStateDescriptors(page, {
        maxControls: 8,
        relevanceMode: "award-content",
      });
      expect(setup.descriptors).toHaveLength(1);
      expect(setup.descriptors[0].state_kind).toBe("details");

      const captured = await withIsolatedExpansionStatePage({
        context,
        url,
        descriptor: setup.descriptors[0],
        descriptors: setup.descriptors,
        timeoutMs: 10_000,
        capture: async (statePage) => geometryText(await captureVisibleTextGeometry(statePage, {
          stateId: "raw-details-open",
        })),
      });
      expect(captured).toContain("Applicants must be enrolled full time");
    });
  }, 30_000);
});

async function withFixture(html, run) {
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  try {
    await page.goto(url);
    return await run({ browser, context, page, url });
  } finally {
    await page.close().catch(() => null);
    await context.close();
    await browser.close();
  }
}

async function visiblePanelIds(page) {
  return page.evaluate(() => [...document.querySelectorAll("[data-panel]")]
    .filter((panel) => panel.getBoundingClientRect().height > 8)
    .map((panel) => panel.id));
}

function geometryText(geometry) {
  return geometry.nodes.map((node) => node.text).join(" ").replace(/\s+/g, " ").trim();
}

function statefulAccordionFixture() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      body { font: 16px sans-serif; margin: 32px; }
      button { display: block; margin: 12px 0; }
      [data-panel] { box-sizing: border-box; height: 1px; overflow: hidden; }
      [data-panel] > span { display: block; padding-top: 20px; }
      [data-panel].is-open { border: 1px solid #999; height: auto; padding: 16px; }
      [data-panel].is-open > span { padding-top: 0; }
    </style>
  </head>
  <body>
    <main class="award-accordion">
      <button id="eligibility-control" aria-controls="eligibility-panel" aria-expanded="false">Eligibility requirements</button>
      <section id="eligibility-panel" data-panel><span>Applicants must have a 3.5 GPA.</span></section>
      <button id="materials-control" aria-controls="materials-panel" aria-expanded="false">Application materials</button>
      <section id="materials-panel" data-panel><span>A portfolio and two recommendations are required.</span></section>
    </main>
    <script>
      (() => {
        const state = { openPanels: new Set() };
        const render = () => {
          for (const control of document.querySelectorAll('button[aria-controls]')) {
            const panelId = control.getAttribute('aria-controls');
            const panel = document.getElementById(panelId);
            const open = state.openPanels.has(panelId);
            control.setAttribute('aria-expanded', String(open));
            panel.classList.toggle('is-open', open);
          }
        };
        for (const control of document.querySelectorAll('button[aria-controls]')) {
          control.addEventListener('click', () => {
            state.openPanels.add(control.getAttribute('aria-controls'));
            render();
          });
        }
        render();
      })();
    </script>
  </body>
</html>`;
}

function actionableControlsFixture() {
  return `<!doctype html>
<html>
  <body>
    <header><nav><a id="control-RANDOM" role="button" aria-expanded="false" aria-controls="RANDOM" href="#">3. Check Your Eligibility and Apply</a><div id="RANDOM">Navigation menu</div></nav></header>
    <main>
      <a href="#eligibility-overview">Eligibility overview</a>
      <section id="eligibility-overview">This is ordinary in-page navigation, not an expandable panel.</section>
      <div class="paragraph-item ptype-stanford-accordion">
        <div class="ptype-stanford-accordion">
          <div class="jumpstart-accordion">
            <button id="eligibility-button" aria-expanded="false" aria-controls="eligibility-content">Eligibility requirements</button>
            <section id="eligibility-content" hidden>Applicants must hold a qualifying degree.</section>
          </div>
        </div>
      </div>
      <div class="gb-accordion">
        <div id="custom-application-toggle" class="gb-accordion__toggle" role="button" tabindex="0" aria-expanded="false" aria-controls="application-content">Application materials</div>
        <section id="application-content" hidden>Submit two recommendations.</section>
      </div>
    </main>
  </body>
</html>`;
}

function coreAwardDetailsFixture() {
  return `<!doctype html>
<html>
  <body>
    <main>
      <details><summary>Deadlines</summary><p>Applications close March 1, 2027.</p></details>
      <details><summary>Award details</summary><p>The award supports one year of study.</p></details>
      <details><summary>Grant terms</summary><p>The grant provides a stipend.</p></details>
    </main>
  </body>
</html>`;
}

function manyFaqDetailsFixture(count, { openIndex = null } = {}) {
  const sections = Array.from({ length: count }, (_, index) => `
      <details${index + 1 === openIndex ? " open" : ""}><summary>FAQ ${index + 1}</summary><p>Answer ${index + 1} contains applicant guidance.</p></details>`)
    .join("");
  return `<!doctype html>
<html>
  <body>
    <main>${sections}
    </main>
  </body>
</html>`;
}

function samvidElementorFixture() {
  const widgets = [
    {
      heading: "Scholarship Eligibility Frequently Asked Questions",
      ids: ["1051", "1052", "1053", "1054", "1055", "1056", "1057"],
      labels: [
        "Can I apply before choosing a graduate school?",
        "Which graduate programs are eligible?",
        "Is my STEM program a good fit?",
        "Can a Master's/PhD student apply?",
        "Am I eligible if I am pursuing a dual degree?",
        "What are the citizenship rules?",
        "Can I receive another scholarship?",
      ],
    },
    {
      heading: "Application Requirements",
      ids: ["2301", "2302", "2303", "2304", "2305", "2306", "2307", "2308", "2309", "23010"],
      labels: [
        "What does the application consist of?",
        "What are the essay questions?",
        "What transcripts do I need to provide?",
        "Must the transcript be official?",
        "How is GPA considered?",
        "Are there minimum test scores?",
        "Which test scores are required?",
        "What awards should I include?",
        "Who should be my recommenders?",
        "How many recommendations should I submit?",
      ],
    },
    {
      heading: "Cohort Announcement and Programming",
      ids: ["6241", "6242", "6243"],
      labels: [
        "When will I be notified of a decision?",
        "Will finalists provide supplemental materials?",
        "What does leadership development programming entail?",
      ],
    },
  ];
  const markup = widgets.map(({ heading, ids, labels }, widgetIndex) => `
    <section class="elementor-widget-accordion">
      <h2>${heading}</h2>
      <div class="elementor-accordion" data-widget="${widgetIndex}">
        ${ids.map((id, index) => `
          <div class="elementor-accordion-item">
            <div id="elementor-tab-title-${id}" class="elementor-tab-title${index === 0 ? " elementor-active" : ""}"
              role="button" aria-controls="elementor-tab-content-${id}" aria-expanded="${index === 0}">
              <a class="elementor-accordion-title" tabindex="0">${labels[index]}</a>
            </div>
            <div id="elementor-tab-content-${id}" class="elementor-tab-content${index === 0 ? " elementor-active" : ""}"
              style="${index === 0 ? "display:block;height:auto;overflow:visible" : "display:none;height:0;overflow:hidden"}">
              ${id === "1055"
                ? "Dual-degree candidates remain eligible. This exact short answer appears after the animated panel settles."
                : index === 0 && widgetIndex > 0
                  ? "Default-open content from another widget must be closed before capture."
                  : `Official applicant guidance for panel ${id}.`}
            </div>
          </div>`).join("")}
      </div>
    </section>`).join("");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      body { font: 16px sans-serif; margin: 24px; }
      .elementor-tab-title { cursor: pointer; padding: 8px; }
      .elementor-tab-content { box-sizing: border-box; padding: 12px; }
    </style>
  </head>
  <body>
    <main>
      <p><a id="eligibility-jump-link" href="#elementor-tab-title-1052">See the eligible graduate program FAQ</a></p>
      ${markup}
    </main>
    <script>
      const closePanel = (control) => {
        const panel = document.getElementById(control.getAttribute('aria-controls'));
        control.setAttribute('aria-expanded', 'false');
        control.classList.remove('elementor-active');
        panel.classList.remove('elementor-active');
        panel.style.display = 'none';
        panel.style.height = '0px';
        panel.style.overflow = 'hidden';
      };
      for (const control of document.querySelectorAll('.elementor-tab-title[aria-controls]')) {
        control.addEventListener('click', () => {
          const panel = document.getElementById(control.getAttribute('aria-controls'));
          if (control.getAttribute('aria-expanded') === 'true') {
            closePanel(control);
            return;
          }
          for (const peer of control.closest('.elementor-accordion').querySelectorAll('.elementor-tab-title[aria-controls]')) {
            closePanel(peer);
          }
          control.setAttribute('aria-expanded', 'true');
          control.classList.add('elementor-active');
          panel.classList.add('elementor-active');
          panel.style.display = 'block';
          panel.style.height = '2px';
          panel.style.overflow = 'hidden';
          setTimeout(() => { panel.style.height = '52px'; }, 220);
          setTimeout(() => {
            panel.style.height = 'auto';
            panel.style.overflow = 'visible';
          }, 500);
        });
      }
    </script>
  </body>
</html>`;
}

function nativeDetailsFixture() {
  return `<!doctype html>
<html>
  <body>
    <main>
      <section class="paragraph paragraph--type-accordion">
        <details>
          <summary><h3 class="accordion-title">What identification documents are required?</h3></summary>
          <div>The identification badge requires two official documents.</div>
        </details>
      </section>
    </main>
  </body>
</html>`;
}

function adjacentPanelFixture() {
  return `<!doctype html>
<html>
  <head>
    <style>
      .accordion > article { display: none; }
      .accordion.active > article { display: block; padding: 12px; }
    </style>
  </head>
  <body>
    <main>
      <ul class="accordions-container">
        <li class="accordion"><button class="accordion__item-label">Eligibility requirements</button><article>Applicants must hold a qualifying undergraduate degree.</article></li>
        <li class="accordion"><button class="accordion__item-label">Application materials</button><article>Two recommendation letters are required.</article></li>
      </ul>
    </main>
    <script>
      for (const button of document.querySelectorAll('.accordion > button')) {
        button.addEventListener('click', () => {
          for (const item of document.querySelectorAll('.accordion')) item.classList.remove('active');
          button.parentElement.classList.add('active');
        });
      }
    </script>
  </body>
</html>`;
}

function numericFragmentFixture() {
  return `<!doctype html>
<html>
  <head>
    <style>
      .vc_tta-panel-heading { display: block; min-height: 40px; }
      .vc_tta-panel-body { display: none; }
      .vc_tta-panel.vc_active > .vc_tta-panel-body { display: block; padding: 12px; }
    </style>
  </head>
  <body>
    <main>
      <div id="1563384913686-eligibility" class="vc_tta-panel">
        <div class="vc_tta-panel-heading"><a href="#1563384913686-eligibility">Eligibility requirements</a></div>
        <div class="vc_tta-panel-body">Applicants must be United States citizens or nationals.</div>
      </div>
      <div id="1773944541775-application" class="vc_tta-panel">
        <div class="vc_tta-panel-heading"><a href="#1773944541775-application">Application deadline</a></div>
        <div class="vc_tta-panel-body">Applications close on October 6.</div>
      </div>
    </main>
    <script>
      for (const anchor of document.querySelectorAll('a[href^="#"]')) {
        anchor.addEventListener('click', (event) => {
          event.preventDefault();
          for (const panel of document.querySelectorAll('.vc_tta-panel')) panel.classList.remove('vc_active');
          document.getElementById(anchor.getAttribute('href').slice(1)).classList.add('vc_active');
        });
      }
    </script>
  </body>
</html>`;
}

function noOpAccordionFixture() {
  return `<!doctype html>
<html>
  <head><style>.accordion__item > article { display: none; }</style></head>
  <body>
    <main>
      <div class="accordion__item">
        <button>Eligibility requirements</button>
        <article>The panel must stay hidden because this control is broken.</article>
      </div>
    </main>
  </body>
</html>`;
}

function genericExclusiveAccordionFixture({ stuckVisible = false, slowCloseMs = 0 } = {}) {
  return `<!doctype html>
<html>
  <body>
    <main>
      <button id="target-control" aria-expanded="false" aria-controls="target-panel">Eligibility FAQ</button>
      <section id="target-panel" hidden>Target eligibility guidance</section>
      <button id="other-control" aria-expanded="${stuckVisible ? "false" : "true"}" aria-controls="other-panel">Application FAQ</button>
      <section id="other-panel">Other application guidance</section>
    </main>
    <script>
      const target = document.getElementById("target-control");
      const targetPanel = document.getElementById("target-panel");
      const other = document.getElementById("other-control");
      const otherPanel = document.getElementById("other-panel");
      target.addEventListener("click", () => {
        target.setAttribute("aria-expanded", "true");
        targetPanel.hidden = false;
      });
      other.addEventListener("click", () => {
        other.setAttribute("aria-expanded", "false");
        setTimeout(() => { otherPanel.hidden = true; }, ${Number(slowCloseMs) || 0});
      });
    </script>
  </body>
</html>`;
}

function exclusiveAriaTabsFixture() {
  return `<!doctype html>
<html>
  <body>
    <main>
      <div id="award-tabs" role="tablist" aria-label="Award guidance">
        <button id="eligibility-tab" role="tab" aria-selected="true" aria-controls="eligibility-panel">Eligibility</button>
        <button id="application-tab" role="tab" aria-selected="false" aria-controls="application-panel">Application</button>
      </div>
      <section id="eligibility-panel" role="tabpanel" aria-labelledby="eligibility-tab">Eligibility requires an undergraduate degree</section>
      <section id="application-panel" role="tabpanel" aria-labelledby="application-tab" hidden>Application materials require two recommendations</section>
    </main>
    <script>
      const tabs = [...document.querySelectorAll("[role='tab']")];
      for (const tab of tabs) {
        tab.addEventListener("click", () => {
          if (tab.getAttribute("aria-selected") === "true") return;
          for (const peer of tabs) {
            const selected = peer === tab;
            peer.setAttribute("aria-selected", String(selected));
            document.getElementById(peer.getAttribute("aria-controls")).hidden = !selected;
          }
        });
      }
    </script>
  </body>
</html>`;
}

function brokenExclusiveAriaTabsFixture() {
  return `<!doctype html>
<html>
  <body>
    <main>
      <div id="generic-tabs" role="tablist" aria-label="Program sections">
        <button id="generic-tab" role="tab" aria-selected="true" aria-controls="generic-panel">Overview</button>
        <button id="relevant-tab" role="tab" aria-selected="false" aria-controls="relevant-panel">More</button>
      </div>
      <section id="generic-panel" role="tabpanel" aria-labelledby="generic-tab">Welcome to this year's cohort</section>
      <section id="relevant-panel" role="tabpanel" aria-labelledby="relevant-tab" hidden>Eligibility requirements include an undergraduate degree</section>
    </main>
    <script>
      const target = document.getElementById("relevant-tab");
      target.addEventListener("click", () => {
        target.setAttribute("aria-selected", "true");
        document.getElementById("relevant-panel").hidden = false;
        // Deliberately broken: the active peer and its panel remain readable.
      });
    </script>
  </body>
</html>`;
}

function clippedNoHandlerAccordionFixture() {
  return `<!doctype html>
<html>
  <head>
    <style>
      .accordion__item > article { box-sizing: border-box; height: 2px; overflow: hidden; }
    </style>
  </head>
  <body>
    <main>
      <div class="accordion__item">
        <button>Eligibility requirements</button>
        <article>Applicants must satisfy the published eligibility requirements.</article>
      </div>
    </main>
  </body>
</html>`;
}

function paintVisibilityFixture({
  bodyStyle = "",
  contentStyle = null,
  descendantOverlayStyle = "",
  overlayStyle = "",
  panelStyle = "",
  wrapperStyle = "",
} = {}) {
  const descendantOverlay = descendantOverlayStyle
    ? `<span data-test-descendant-overlay style="${descendantOverlayStyle}"></span>`
    : "";
  const content = descendantOverlay
    ? `<span style="position: relative; display: inline-block; ${contentStyle || ""}">Applicants must satisfy eligibility requirements.${descendantOverlay}</span>`
    : contentStyle === null
      ? "Applicants must satisfy eligibility requirements."
      : `<span style="${contentStyle}">Applicants must satisfy eligibility requirements.</span>`;
  return `<!doctype html>
<html>
  <body style="${bodyStyle}">
    <main>
      <div style="position: relative; ${wrapperStyle}">
        <button aria-label="Eligibility requirements" aria-expanded="false" aria-controls="paint-panel"></button>
        <section id="paint-panel" hidden style="${panelStyle}">${content}</section>
        ${overlayStyle ? `<div data-test-paint-overlay style="${overlayStyle}"></div>` : ""}
      </div>
    </main>
    <script>
      document.querySelector('button').addEventListener('click', (event) => {
        event.currentTarget.setAttribute('aria-expanded', 'true');
        document.getElementById('paint-panel').hidden = false;
      });
    </script>
  </body>
</html>`;
}

function hiddenPanelAriaTrueFixture() {
  return `<!doctype html>
<html>
  <body>
    <main>
      <button id="false-open-control" aria-expanded="true" aria-controls="false-open-panel">Eligibility requirements</button>
      <section id="false-open-panel" hidden>The panel is still hidden despite the ARIA claim.</section>
    </main>
  </body>
</html>`;
}

function unboundAriaFixture() {
  return `<!doctype html>
<html>
  <body>
    <main>
      <button aria-expanded="false">Eligibility requirements</button>
      <button aria-expanded="false" aria-controls="missing-application-panel">Application requirements</button>
      <button data-toggle="collapse" data-target="#unsafe-target .child">Application documents</button>
      <section id="unsafe-target" class="collapse"><span class="child">Unsafe selector targets must not be partially accepted.</span></section>
      <a href="#unsafe-panel .child">Eligibility guidance</a>
      <section id="unsafe-panel" class="tab-pane"><span class="child">Unsafe href selectors must not be partially accepted.</span></section>
    </main>
  </body>
</html>`;
}

function ordinaryPanelAnchorFixture() {
  return `<!doctype html>
<html>
  <body>
    <main>
      <a href="#award-panel">Eligibility information</a>
      <section id="award-panel">This ordinary visible section is a scroll destination, not expandable content.</section>
    </main>
  </body>
</html>`;
}

function numericAriaControlsFixture() {
  return `<!doctype html>
<html>
  <body>
    <main>
      <button id="numeric-aria-control" aria-expanded="false" aria-controls="123-eligibility-panel">Eligibility requirements</button>
      <section id="123-eligibility-panel" hidden>Applicants must satisfy the published eligibility requirements.</section>
    </main>
    <script>
      document.getElementById('numeric-aria-control').addEventListener('click', (event) => {
        event.currentTarget.setAttribute('aria-expanded', 'true');
        document.getElementById('123-eligibility-panel').hidden = false;
      });
    </script>
  </body>
</html>`;
}

function ariaLabelControlFixture() {
  return `<!doctype html>
<html>
  <body>
    <main>
      <button id="aria-label-control" aria-label="Eligibility requirements" aria-expanded="false" aria-controls="aria-label-panel"></button>
      <section id="aria-label-panel" hidden>Applicants must submit proof of eligibility.</section>
    </main>
    <script>
      document.getElementById('aria-label-control').addEventListener('click', (event) => {
        event.currentTarget.setAttribute('aria-expanded', 'true');
        document.getElementById('aria-label-panel').hidden = false;
      });
    </script>
  </body>
</html>`;
}

function showHideControlFixture() {
  return `<!doctype html>
<html>
  <body>
    <main>
      <button id="show-hide-control" aria-expanded="false" aria-controls="show-hide-panel">Show application details</button>
      <section id="show-hide-panel" hidden>Applications require two recommendations.</section>
    </main>
    <script>
      document.getElementById('show-hide-control').addEventListener('click', (event) => {
        event.currentTarget.setAttribute('aria-expanded', 'true');
        event.currentTarget.textContent = 'Hide application details';
        document.getElementById('show-hide-panel').hidden = false;
      });
    </script>
  </body>
</html>`;
}

function visibleWrapperAriaOnlyFixture() {
  return `<!doctype html>
<html>
  <body>
    <main>
      <button id="wrapper-control" aria-expanded="false" aria-controls="eligibility-wrapper">Eligibility requirements</button>
      <section id="eligibility-wrapper"><h3>Eligibility</h3><div hidden>Applicants must satisfy the published eligibility requirements.</div></section>
    </main>
    <script>
      document.getElementById('wrapper-control').addEventListener('click', (event) => {
        event.currentTarget.setAttribute('aria-expanded', 'true');
      });
    </script>
  </body>
</html>`;
}

function visibleWrapperRevealFixture() {
  return `<!doctype html>
<html>
  <body>
    <main>
      <button id="wrapper-reveal-control" aria-expanded="false" aria-controls="eligibility-wrapper">Eligibility requirements</button>
      <section id="eligibility-wrapper"><h3>Eligibility</h3><div hidden>Applicants must satisfy the published eligibility requirements.</div></section>
    </main>
    <script>
      document.getElementById('wrapper-reveal-control').addEventListener('click', (event) => {
        event.currentTarget.setAttribute('aria-expanded', 'true');
        document.querySelector('#eligibility-wrapper > div').hidden = false;
      });
    </script>
  </body>
</html>`;
}

function regeneratedIdsFixture() {
  return `<!doctype html>
<html>
  <body>
    <main>
      <button aria-expanded="false">Application requirements</button>
      <section hidden>Applicants must submit two recommendations.</section>
    </main>
    <script>
      (() => {
        const suffix = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        const control = document.querySelector('main > button');
        const panel = document.querySelector('main > section');
        control.id = 'control-' + suffix;
        panel.id = 'panel-' + suffix;
        control.setAttribute('aria-controls', panel.id);
        control.addEventListener('click', () => {
          control.setAttribute('aria-expanded', 'true');
          panel.hidden = false;
        });
      })();
    </script>
  </body>
</html>`;
}

function placeholderHrefFixture() {
  return `<!doctype html>
<html>
  <body>
    <main>
      <a id="placeholder-control" href="#" aria-expanded="false" aria-controls="placeholder-panel">Application requirements</a>
      <section id="placeholder-panel" hidden>Applicants must submit two recommendations.</section>
    </main>
    <script>
      document.getElementById('placeholder-control').addEventListener('click', (event) => {
        event.preventDefault();
        event.currentTarget.setAttribute('aria-expanded', 'true');
        document.getElementById('placeholder-panel').hidden = false;
      });
    </script>
  </body>
</html>`;
}

function rawTextDetailsFixture() {
  return `<!doctype html>
<html>
  <body>
    <main><details><summary>Read more</summary>Applicants must be enrolled full time and satisfy eligibility requirements.</details></main>
  </body>
</html>`;
}

// Mirrors the Gilman applicants FAQ: a WPBakery/Visual Composer accordion with
// no ARIA anywhere, heading anchors whose href points at the PANEL WRAPPER (not
// the body), one panel the page opens by default, animated heights, and a
// separate single-panel group that is permanently open and cannot be closed.
function wpBakeryAccordionFixture() {
  const panels = [
    { id: "vc-elig", label: "ELIGIBILITY", body: "Applicants must be enrolled at an accredited institution to qualify." },
    { id: "vc-appl", label: "APPLICATION", body: "The online application opens in the spring for the following cycle." },
    { id: "vc-essay", label: "ESSAY REQUIREMENTS", body: "Two essays are required and each is reviewed by the selection panel." },
    { id: "vc-award", label: "AWARD PROCESS & RECIPIENT INFO", body: "Award notifications are sent by the program office." },
  ];
  const group = panels.map((panel) => `
    <div class="vc_tta-panel" id="${panel.id}">
      <div class="vc_tta-panel-heading"><h4 class="vc_tta-panel-title"><a href="#${panel.id}">${panel.label}</a></h4></div>
      <div class="vc_tta-panel-body" style="display:none;height:0;overflow:hidden">${panel.body}</div>
    </div>`).join("");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      body { font: 16px sans-serif; margin: 24px; }
      .vc_tta-panel-heading { cursor: pointer; padding: 8px; background: #eee; }
      .vc_tta-panel-body { box-sizing: border-box; padding: 12px; }
    </style>
  </head>
  <body>
    <main>
      <div class="vc_tta vc_tta-accordion vc_tta-o-all-clickable">${group}</div>
      <div class="vc_tta vc_tta-accordion">
        <div class="vc_tta-panel vc_active" id="vc-notice">
          <div class="vc_tta-panel-heading"><h4 class="vc_tta-panel-title"><a href="#vc-notice">Having issues with the website?</a></h4></div>
          <div class="vc_tta-panel-body" style="display:block;height:auto;overflow:visible">Please update to the latest version of your preferred browser ( i.e Chrome, Safari, Edge etc.)</div>
        </div>
      </div>
    </main>
    <script>
      const bodyOf = (panel) => panel.querySelector('.vc_tta-panel-body');
      const close = (panel) => {
        if (panel.slideTimer) { clearInterval(panel.slideTimer); panel.slideTimer = null; }
        panel.classList.remove('vc_active');
        const body = bodyOf(panel);
        body.style.display = 'none';
        body.style.height = '0px';
        body.style.overflow = 'hidden';
      };
      for (const anchor of document.querySelectorAll('.vc_tta-panel-heading a[href^="#"]')) {
        const panel = anchor.closest('.vc_tta-panel');
        // The lone notice group has no toggle behaviour at all: it stays open.
        if (panel.id === 'vc-notice') {
          anchor.addEventListener('click', (event) => event.preventDefault());
          continue;
        }
        anchor.addEventListener('click', (event) => {
          event.preventDefault();
          if (panel.classList.contains('vc_active')) { close(panel); return; }
          for (const peer of panel.closest('.vc_tta').querySelectorAll('.vc_tta-panel')) close(peer);
          panel.classList.add('vc_active');
          const body = bodyOf(panel);
          body.style.display = 'block';
          body.style.height = '2px';
          body.style.overflow = 'hidden';
          // A tall panel slides CONTINUOUSLY for well over the two second
          // default settle budget, exactly like the 4000-6900px Gilman FAQ
          // panels: there is no stable window to sample until it lands.
          const startedAt = performance.now();
          panel.slideTimer = setInterval(() => {
            const elapsed = performance.now() - startedAt;
            if (elapsed >= 2600) {
              clearInterval(panel.slideTimer);
              panel.slideTimer = null;
              body.style.height = 'auto';
              body.style.overflow = 'visible';
              return;
            }
            body.style.height = (2 + elapsed * 0.06) + 'px';
          }, 30);
        });
      }
    </script>
  </body>
</html>`;
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROME_EXECUTABLE_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    `${process.env.LOCALAPPDATA || ""}/Google/Chrome/Application/chrome.exe`,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}
