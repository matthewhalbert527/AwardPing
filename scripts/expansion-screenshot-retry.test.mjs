import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { bindVisualTextGeometry, verifyVisualScreenshotLayoutCapture } from "./lib/visual-event-localization.mjs";
import { isR2CaptureGeometryReady, projectRetainedCaptureArtifacts } from "./lib/r2-capture-artifact-bindings.mjs";

const worker = readFileSync(new URL("./capture-visual-snapshots.mjs", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const marker = "capture: async (statePage, openedIsolation) => {";
const start = worker.indexOf(marker);
const end = worker.indexOf("\n            },\n          });", start);
if (start < 0 || end < start) throw new Error("Actual expansion capture callback missing");
const callback = "async (statePage, openedIsolation) => {" + worker.slice(start + marker.length, end) + "\n}";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const isolation = { verified: true, target_state_key: "section-1", target_selector: "#section-1", fresh_page: true };

function geometry(y = 20) {
  return { version: 1, state_id: "expansion-state-01", coordinate_space: "document-css-pixels",
    document: { width: 1365, height: 1600 }, viewport: { width: 1365, height: 1600 },
    device_pixel_ratio: 1, scroll: { x: 0, y: 0 },
    paint_stack: { contract: "browser-paint-stack-v1", status: "verified" },
    nodes: [{ text: "Exact applicant requirement.", rect: { x: 20, y, width: 300, height: 20 },
      rects: [{ x: 20, y, width: 300, height: 20 }],
      runs: [{ start: 0, end: 28, text: "Exact applicant requirement.", rects: [{ x: 20, y, width: 300, height: 20 }] }] }] };
}

// Exercise the real worker callback with inert I/O and real layout/hash guards.
// No browser, network, filesystem writes, provider calls, or worker entry point.
function harness({ movingAttempts = [], texts = [], isolationRows = [], unstableSettleAt = 0,
  advanceMs = 0, expired = () => false, clock = { now: 0 }, deadline = 60_000 } = {}) {
  const events = [], writes = [];
  let observation = 0, geometryRead = 0, isolationRead = 0, settles = 0, screenshots = 0;
  const page = { screenshot: vi.fn(async options => {
    events.push("screenshot"); screenshots++; clock.now += advanceMs;
    expect(options.timeout).toBeGreaterThan(0);
    return Buffer.from(`image-attempt-${screenshots}`);
  }) };
  class ClockDate extends Date { static now() { return clock.now; } }
  const deps = {
    Date: ClockDate, stateCaptureDeadline: deadline, sourceDeadline: { expired },
    activateScrollTriggeredContent: async () => { events.push("scroll"); },
    hideNoiseElements: async () => { events.push("noise"); }, source: {}, profile: "discovery",
    waitForPageSettledForSnapshot: async () => { events.push("settle"); settles++; return { stable: settles !== unstableSettleAt, waited_ms: 1500 }; },
    verifyExpansionStateIsolation: async () => { events.push("isolation"); return isolationRows[isolationRead++] || { ...isolation }; },
    candidate: { index: 0, tag: "button", label: "Requirements", state_kind: "targets", state_selectors: ["#panel-1"] },
    isolationDescriptors: [], stateId: "expansion-state-01", stateNumber: 1,
    capturePageResourceSnapshot: async () => { events.push("text"); return { text: { text: texts[observation++] || "Exact applicant requirement." } }; },
    captureStructuredVisibleTextGeometry: async () => {
      events.push("geometry");
      const attempt = Math.floor(geometryRead / 2) + 1, after = geometryRead++ % 2 === 1;
      return geometry(movingAttempts.includes(attempt) && after ? 22 : 20);
    },
    jpegQuality: 80, timeoutMs: 60_000, hashBuffer: sha,
    screenshotBindingFromBuffer: async () => ({ css_width: 1365, css_height: 1600, pixel_width: 1365,
      pixel_height: 1600, expected_device_pixel_ratio: 1, scale_x: 1, scale_y: 1, alignment_status: "verified" }),
    assertCapturedScreenshotWithinLimits: () => { events.push("resource-limit-check"); },
    verifyVisualScreenshotLayoutCapture, bindVisualTextGeometry,
    toArchiveRelative: value => value,
    pagePath: "sources/fixture/captures/exact/expansion-state-01.jpg",
    layoutPath: "sources/fixture/captures/exact/expansion-state-01-layout.json",
    writeFileSync: (path, bytes) => { events.push("persist"); writes.push({ path, bytes }); },
    normalizeVisibleText: text => text.trim(), hashText: sha, cleanText: text => String(text || "").trim(),
  };
  const capture = new Function(...Object.keys(deps), `return (${callback});`)(...Object.values(deps));
  return { run: () => capture(page, { ...isolation }), page, events, writes };
}

describe("isolated expansion screenshot fresh-observation retries", () => {
  it("retains an already stable state after a single fully bracketed observation", async () => {
    const h = harness();
    const state = await h.run();
    expect(h.page.screenshot).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual(["scroll", "noise", "settle", "isolation", "text", "geometry", "screenshot",
      "resource-limit-check", "geometry", "isolation", "text", "persist", "persist"]);
    expect(isR2CaptureGeometryReady({ kind: "webpage", ...state })).toBe(true);
  });

  it("reobserves every input and persists only the matching second attempt", async () => {
    const h = harness({ movingAttempts: [1] });
    const state = await h.run();
    expect(h.page.screenshot).toHaveBeenCalledTimes(2);
    expect(h.events.filter(event => event === "settle")).toHaveLength(2);
    expect(h.events.filter(event => event === "isolation")).toHaveLength(4);
    expect(h.events.filter(event => event === "text")).toHaveLength(4);
    expect(h.writes).toHaveLength(2);
    expect(h.writes[0].bytes.toString()).toBe("image-attempt-2");
    expect(state.image_hash).toBe(sha("image-attempt-2"));
    expect(state.text_geometry.screenshot.image_hash).toBe(state.image_hash);
    expect(isR2CaptureGeometryReady({ kind: "webpage", ...state })).toBe(true);
  });

  it("caps persistent geometry movement at three and preserves the incomplete contiguous hold", async () => {
    const h = harness({ movingAttempts: [1, 2, 3, 4] });
    const state = await h.run();
    expect(h.page.screenshot).toHaveBeenCalledTimes(3);
    expect(h.writes).toHaveLength(2);
    expect(state.image_hash).toBe(sha("image-attempt-3"));
    expect(state.text_geometry.availability_status).toBe("unavailable_layout_changed_during_screenshot");
    expect(isR2CaptureGeometryReady({ kind: "webpage", ...state })).toBe(false);
    const next = { ...(await harness().run()), state_id: "expansion-state-02" };
    const projection = projectRetainedCaptureArtifacts({ kind: "webpage", expansion_state_screenshots: [state, next] });
    expect(projection.retainedExpansionStates).toHaveLength(0);
    expect(projection.manifest.diagnostics.expansion_states.map(item => item.reason)).toEqual([
      "unavailable_layout_changed_during_screenshot", "non_contiguous_after_unretained_state",
    ]);
  });

  it("holds changed text across retries rather than attaching earlier text to a later screenshot", async () => {
    const h = harness({ movingAttempts: [1], texts: ["Original requirement.", "Original requirement.", "New requirement."] });
    await expect(h.run()).rejects.toThrow("content changed across screenshot attempts");
    expect(h.page.screenshot).toHaveBeenCalledTimes(1);
    expect(h.writes).toHaveLength(0);
  });

  it("holds text changed during the screenshot without retrying away the change", async () => {
    const h = harness({ texts: ["Original requirement.", "New requirement."] });
    await expect(h.run()).rejects.toThrow("content or control identity changed during");
    expect(h.page.screenshot).toHaveBeenCalledTimes(1);
    expect(h.writes).toHaveLength(0);
  });

  it.each([
    [{ ...isolation, target_state_key: "another-section" }],
    [isolation, { ...isolation, verified: false }],
    [isolation, { ...isolation, target_selector: "#another-control" }],
  ])("holds changed control state/identity instead of reopening controls: %j", async (...isolationRows) => {
    const h = harness({ isolationRows });
    await expect(h.run()).rejects.toThrow(/control identity changed/);
    expect(h.writes).toHaveLength(0);
  });

  it("does not start a retry after the existing state budget expires", async () => {
    const h = harness({ movingAttempts: [1], advanceMs: 60_000 });
    await expect(h.run()).rejects.toThrow("existing state budget");
    expect(h.page.screenshot).toHaveBeenCalledTimes(1);
    expect(h.writes).toHaveLength(0);
  });

  it("does not start an observation after the shared source deadline expires", async () => {
    const h = harness({ expired: () => true });
    await expect(h.run()).rejects.toThrow("existing state budget");
    expect(h.page.screenshot).not.toHaveBeenCalled();
    expect(h.writes).toHaveLength(0);
  });

  it("does not reset a state budget already consumed by navigation or a control retry", async () => {
    const h = harness({ clock: { now: 60_000 } });
    await expect(h.run()).rejects.toThrow("existing state budget");
    expect(h.events).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
    const deadline = worker.indexOf("const stateCaptureDeadline = Date.now() + expansionStateTimeoutPerStateMs");
    const freshPage = worker.indexOf("const runIsolatedState = () => withIsolatedExpansionStatePage", deadline);
    expect(deadline).toBeGreaterThan(-1);
    expect(freshPage).toBeGreaterThan(deadline);
    expect(callback).not.toContain("stateCaptureDeadline =");
    expect(callback).not.toContain("openExpansionStateControl");
  });

  it("fails closed if a retry cannot settle", async () => {
    const h = harness({ movingAttempts: [1], unstableSettleAt: 2 });
    await expect(h.run()).rejects.toThrow("did not settle before geometry capture");
    expect(h.page.screenshot).toHaveBeenCalledTimes(1);
    expect(h.writes).toHaveLength(0);
  });
});
