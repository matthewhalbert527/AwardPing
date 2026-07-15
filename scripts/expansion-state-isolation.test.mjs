import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import {
  discoverExpansionStateDescriptors,
  verifyExpansionStateIsolation,
  withIsolatedExpansionStatePage,
} from "./lib/expansion-state-isolation.mjs";
import { captureVisibleTextGeometry } from "./lib/visible-text-geometry.mjs";

const chromePath = findChromeExecutable();
const browserIt = chromePath ? it : it.skip;

describe("expansion state isolation", () => {
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
});

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
