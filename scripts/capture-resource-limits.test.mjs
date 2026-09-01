import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import {
  CAPTURE_RESOURCE_LIMIT_CODE,
  assertCaptureNetworkWithinLimits,
  assertCaptureRenderWithinLimits,
  assertCaptureScreenshotBytes,
  assertCaptureScreenshotDimensions,
  captureBoundedBodyInnerText,
  captureResourceLimitError,
  errorChainHasCode,
  finalizeCaptureNetworkBoundary,
  isCaptureResourceLimitError,
  validateCaptureRenderDimensions,
} from "./lib/capture-resource-limits.mjs";

const workerSource = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);
const browserExecutable = [
  process.env.BROWSER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  process.env.EDGE_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  chromium.executablePath(),
].find((value) => value && existsSync(value));

const renderLimits = {
  maxWidthCssPx: 8_000,
  maxHeightCssPx: 60_000,
  maxRenderPixels: 80_000_000,
};

describe("visual capture resource limits", () => {
  it("preserves exact text and permits a legitimate long award page", async () => {
    const exactText = "Eligibility\n  Applicants must be enrolled.\nDeadline: October 1";
    const page = fakePage({
      text: exactText,
      visible_text_characters: exactText.length,
      raw_text_characters: exactText.length,
      text_nodes: 12_000,
      elements: 35_000,
    });

    const snapshot = await captureBoundedBodyInnerText(page, {
      stateId: "main",
      maxChars: 1_500_000,
      maxTextNodes: 150_000,
      maxElements: 250_000,
    });
    expect(snapshot.text).toBe(exactText);

    const render = validateCaptureRenderDimensions({
      viewport_width: 1_440,
      viewport_height: 900,
      scroll_width: 1_440,
      scroll_height: 50_000,
      device_pixel_ratio: 1,
    }, renderLimits);
    expect(render.render_pixels).toBe(72_000_000);
  });

  it.each([
    ["dom_elements", 250_001, 250_000, "elements"],
    ["dom_text_nodes", 150_001, 150_000, "text_nodes"],
    ["dom_raw_text_characters", 3_000_001, 3_000_000, "characters"],
    ["visible_text_characters", 1_500_001, 1_500_000, "characters"],
  ])("rejects %s without accepting partial text", async (resource, observed, limit, unit) => {
    const page = fakePage({
      limit_resource: resource,
      observed,
      limit,
      unit,
    });

    const error = await rejectedError(captureBoundedBodyInnerText(page, {
      stateId: "expansion-state-03",
      maxChars: 1_500_000,
      maxTextNodes: 150_000,
      maxElements: 250_000,
    }));
    expect(error).toMatchObject({
      code: CAPTURE_RESOURCE_LIMIT_CODE,
      failure_type: "capture_resource_limit",
      capture_state_id: "expansion-state-03",
      capture_resource: resource,
      observed,
      limit,
    });
    expect(error.message).toMatch(/rejected before evidence publication/i);
    expect(error.message).toMatch(/recommended safe action/i);
  });

  it("measures the page and rejects excessive full-page height", async () => {
    const page = fakePage({
      viewport_width: 1_440,
      viewport_height: 900,
      scroll_width: 1_440,
      scroll_height: 60_001,
      device_pixel_ratio: 1,
    });
    const error = await rejectedError(assertCaptureRenderWithinLimits(page, {
      stateId: "main",
      ...renderLimits,
    }));
    expect(error).toMatchObject({
      code: CAPTURE_RESOURCE_LIMIT_CODE,
      capture_resource: "render_height_css_px",
      observed: 60_001,
      limit: 60_000,
    });
  });

  it("rejects a high-DPR page whose render surface exceeds the pixel ceiling", () => {
    expect(() => validateCaptureRenderDimensions({
      viewport_width: 1_440,
      viewport_height: 900,
      scroll_width: 1_440,
      scroll_height: 20_000,
      device_pixel_ratio: 2,
    }, renderLimits)).toThrow(/resource=render_pixels/);
  });

  it("validates the encoded bytes and actual decoded screenshot dimensions", () => {
    expect(assertCaptureScreenshotBytes(Buffer.alloc(1_024), {
      stateId: "main",
      maxBytes: 2_048,
    })).toBe(1_024);
    expect(() => assertCaptureScreenshotBytes(Buffer.alloc(2_049), {
      stateId: "main",
      maxBytes: 2_048,
    })).toThrow(/resource=screenshot_bytes/);

    expect(() => assertCaptureScreenshotDimensions({
      expected_device_pixel_ratio: 1,
      pixel_width: 1_440,
      pixel_height: 60_001,
    }, {
      stateId: "expansion-state-01",
      ...renderLimits,
    })).toThrow(/resource=render_height_css_px/);
  });

  it("recognizes a resource-limit error through an error cause", () => {
    const cause = captureResourceLimitError({
      resource: "render_pixels",
      observed: 90_000_000,
      limit: 80_000_000,
      unit: "pixels",
    });
    expect(isCaptureResourceLimitError(new Error("wrapped", { cause }))).toBe(true);
    expect(isCaptureResourceLimitError(new Error("ordinary failure"))).toBe(false);
  });

  it("finds timeout codes through wrapped Stage 1 errors", () => {
    const cause = Object.assign(new Error("proxy drain timed out"), {
      code: "AWARDPING_PROXY_SETTLE_TIMEOUT",
    });
    const wrapped = new Error("Stage 1 capture failed", { cause });
    expect(errorChainHasCode(wrapped, "AWARDPING_PROXY_SETTLE_TIMEOUT")).toBe(true);
    expect(errorChainHasCode(wrapped, "AWARDPING_SOURCE_TIMEOUT")).toBe(false);
  });

  it("turns a proxy byte-cap violation into a typed capture failure", () => {
    const proxy = {
      policyViolationSince: vi.fn(() => ({
        generation: 4,
        kind: "https_tunnel",
        reason: "byte_limit",
        target: "official-award.example.edu",
        port: 443,
        observed_bytes: 1_025,
        limit_bytes: 1_024,
      })),
    };
    expect(() => assertCaptureNetworkWithinLimits(proxy, 3, {
      stateId: "main",
      maxBytes: 1_024,
    })).toThrow(/resource=browser_response_bytes/);
    expect(proxy.policyViolationSince).toHaveBeenCalledWith(3);
  });

  it("turns a blocked private subresource into a typed capture failure", () => {
    const proxy = {
      policyViolationSince: vi.fn(() => ({
        generation: 8,
        kind: "http_policy_refusal",
        reason: "public_network_policy_refusal",
        target: "127.0.0.1",
        port: 80,
      })),
    };
    expect(() => assertCaptureNetworkWithinLimits(proxy, 7, {
      stateId: "main",
      maxBytes: 1_024,
    })).toThrow(/resource=browser_network_policy/);
    expect(proxy.policyViolationSince).toHaveBeenCalledWith(7);
  });

  it("closes the proxy before the final policy snapshot catches delayed bytes", async () => {
    const calls = [];
    let violation = null;
    const proxy = {
      settlePolicyEvaluations: vi.fn(async () => calls.push("settle")),
      close: vi.fn(async () => {
        calls.push("proxy_close");
        violation = {
          generation: 2,
          kind: "http_response",
          reason: "byte_limit",
          target: "official-award.example.edu",
          port: 443,
          observed_bytes: 1_025,
          limit_bytes: 1_024,
        };
      }),
      policyViolationSince: vi.fn(() => {
        calls.push("policy_snapshot");
        return violation;
      }),
    };
    await expect(finalizeCaptureNetworkBoundary({
      page: { close: vi.fn(async () => calls.push("page_close")) },
      context: { close: vi.fn(async () => calls.push("context_close")) },
      networkProxy: proxy,
      checkpoint: 1,
      maxBytes: 1_024,
      shutdownTimeoutMs: 100,
    })).rejects.toMatchObject({
      capture_resource: "browser_response_bytes",
    });
    expect(calls).toEqual([
      "page_close",
      "context_close",
      "settle",
      "proxy_close",
      "policy_snapshot",
    ]);
  });

  it("fails closed after a context shutdown error but still destroys proxy streams", async () => {
    const calls = [];
    const proxy = {
      settlePolicyEvaluations: vi.fn(async () => calls.push("settle")),
      close: vi.fn(async () => calls.push("proxy_close")),
      policyViolationSince: vi.fn(() => {
        calls.push("policy_snapshot");
        return null;
      }),
    };
    await expect(finalizeCaptureNetworkBoundary({
      page: { close: vi.fn(async () => calls.push("page_close")) },
      context: { close: vi.fn(async () => {
        calls.push("context_close");
        throw new Error("context close failed");
      }) },
      networkProxy: proxy,
      checkpoint: 1,
      maxBytes: 1_024,
      shutdownTimeoutMs: 100,
    })).rejects.toMatchObject({
      code: "AWARDPING_CAPTURE_CONTEXT_SHUTDOWN",
      capture_resource: "browser_context_shutdown",
    });
    expect(calls).toEqual([
      "page_close",
      "context_close",
      "settle",
      "proxy_close",
      "policy_snapshot",
    ]);
  });

  it.skipIf(!browserExecutable)(
    "executes the DOM census in a real browser without changing accepted wording",
    async () => {
      const browser = await chromium.launch({
        executablePath: browserExecutable,
        headless: true,
      });
      try {
        const page = await browser.newPage({ viewport: { width: 1_200, height: 800 } });
        await page.setContent([
          "<main>",
          "<h1>Eligibility</h1>",
          "<p>Applicants must be enrolled.</p>",
          "<section style=\"height: 12000px\">Deadline: October 1</section>",
          "</main>",
        ].join(""));
        const browserText = await page.evaluate(() => document.body.innerText);
        const textSnapshot = await captureBoundedBodyInnerText(page, {
          stateId: "main",
          maxChars: 10_000,
          maxTextNodes: 1_000,
          maxElements: 1_000,
        });
        expect(textSnapshot.text).toBe(browserText);

        await expect(assertCaptureRenderWithinLimits(page, {
          stateId: "main",
          maxWidthCssPx: 2_000,
          maxHeightCssPx: 10_000,
          maxRenderPixels: 20_000_000,
        })).rejects.toMatchObject({
          code: CAPTURE_RESOURCE_LIMIT_CODE,
          capture_resource: "render_height_css_px",
        });
      } finally {
        await browser.close();
      }
    },
    20_000,
  );

  it("wires fail-closed checks into main and expansion evidence publication", () => {
    expect(workerSource).toContain("const resourceSnapshot = await capturePageResourceSnapshot(page, { stateId: \"main\" });");
    expect(workerSource).toContain("const resourceSnapshot = await capturePageResourceSnapshot(statePage, { stateId });");
    expect(workerSource).toContain("await capturePageResourceSnapshot(page, { stateId: \"expansion-discovery\" });");
    expect(workerSource.match(/assertCapturedScreenshotWithinLimits\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(workerSource.match(/if \(isCaptureResourceLimitError\(error\)\) throw error;/g)?.length).toBeGreaterThanOrEqual(2);
    expect(workerSource).toContain('if (lower.includes("capture_resource_limit")) return "capture_resource_limit";');
    expect(workerSource).toContain("max_capture_render_pixels: maxCaptureRenderPixels");
    expect(workerSource).toContain("const networkCheckpoint = networkProxy?.policyCheckpoint?.() ?? null;");
    expect(workerSource.match(/assertCaptureNetworkWithinLimits\(/g)?.length).toBeGreaterThanOrEqual(1);
    expect(workerSource).toContain("await finalizeCaptureNetworkBoundary({");
    expect(workerSource).toContain("if (pdfSource) {");
    expect(workerSource).toContain("Do not place them behind the non-cancelling page timeout");
    expect(workerSource.indexOf("if (pdfSource) {"))
      .toBeLessThan(workerSource.indexOf("const sourceDeadline = createSourcePhaseDeadline("));
    expect(workerSource).toContain("await sourceDeadline.run(() => processSource(");
    const fullPageScreenshotCalls = [...workerSource.matchAll(
      /(?:const )?pageBuffer = await (?:page|statePage)\.screenshot\(\{([\s\S]*?)\n\s*\}\);/g,
    )];
    expect(fullPageScreenshotCalls).toHaveLength(2);
    for (const call of fullPageScreenshotCalls) {
      expect(call[1]).toContain("fullPage: true");
      expect(call[1]).not.toContain("path:");
    }
    expect(workerSource.indexOf("assertCapturedScreenshotWithinLimits(pageBuffer, screenshotBinding, { stateId: \"main\" });"))
      .toBeLessThan(workerSource.indexOf("writeFileSync(pagePath, pageBuffer);"));
    expect(workerSource).toContain("const sectionStateId = `section:${section.section_key}`;");
    expect(workerSource).toContain("assertCapturedScreenshotWithinLimits(buffer, screenshotBinding, { stateId: sectionStateId });");
    expect(workerSource.indexOf("assertCapturedScreenshotWithinLimits(buffer, screenshotBinding, { stateId: sectionStateId });"))
      .toBeLessThan(workerSource.indexOf("writeFileSync(path, buffer);"));
    const sectionScreenshot = workerSource.match(
      /const buffer = await page\.screenshot\(\{([\s\S]*?)\n\s*\}\);/,
    );
    expect(sectionScreenshot?.[1]).toContain("clip,");
    expect(sectionScreenshot?.[1]).not.toContain("path,");
  });
});

function fakePage(value) {
  return {
    evaluate: vi.fn(async () => value),
  };
}

async function rejectedError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}
