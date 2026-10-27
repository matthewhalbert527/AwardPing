import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), start: vi.fn(), finish: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("./public-network-safety.mjs", () => ({ normalizePublicHttpUrl: value => new URL(value), startPublicNetworkProxy: mocks.start }));
vi.mock("./capture-resource-limits.mjs", () => ({ finalizeCaptureNetworkBoundary: mocks.finish }));
import { captureScraplingPublisherJson, captureScraplingSource, scraplingPublisherJsonObservationSchema,
  validateScraplingPublisherJsonObservation } from "./scrapling-capture.mjs";
const hash = x => createHash("sha256").update(x).digest("hex");
const owner = "d7d4d117-f312-456f-a75c-3dbd5d372c99", portal = "f2a05466db71c300b67330ca7c9619f0";
const home = { id: "58aefec0-0d42-4b7b-9887-60d25940b3d0", shared_award_id: owner, url: "https://www.smartscholarship.org/smart" };
const eligibility = { id: "c33cc2f4-2cbd-458c-b630-537eb3d50f72", shared_award_id: owner, url: "https://www.smartscholarship.org/smart/en?id=smart_eligibility" };
const options = { pythonPath: "synthetic-python", executablePath: "synthetic-browser", publisherJsonProfile: "smart-page-v1" };
function observation(source = home) {
  const raw = '{"result":{"public":true}}', uri = new URL(source.url);
  return { schema: scraplingPublisherJsonObservationSchema, profile: "smart-page-v1", source_id: source.id, source_url: source.url,
    captured_at: "2026-10-27T04:00:00.123456Z", raw_json: raw,
    navigation: { url: source.url, final_url: source.url, method: "GET", status_code: 200, content_type: "text/html; charset=utf-8",
      request_id_sha256: hash("main"), frame_id_sha256: hash("frame"), portal_id: portal, base_hrefs: ["/smart"] },
    response: { request_id_sha256: hash("api"), url_sha256: hash("observed-api-url"), path: "/api/now/sp/page", query_sha256: hash("private-query"),
      method: "GET", status_code: 200, content_type: "application/json", frame_id_sha256: hash("frame"), portal_id: portal,
      request_page_id: source.id === home.id ? null : "smart_eligibility", request_uri: uri.pathname + uri.search,
      from_cache: false, from_service_worker: false, redirected: false, finished: true, decoded_bytes: Buffer.byteLength(raw), raw_sha256: hash(raw) } };
}
let output, code, sent, proxy;
beforeEach(() => {
  mocks.spawn.mockReset(); mocks.start.mockReset(); mocks.finish.mockReset();
  output = observation(); code = 0; sent = null;
  proxy = { url: "http://127.0.0.1:43123", policyCheckpoint: vi.fn(() => "checkpoint") };
  mocks.start.mockResolvedValue(proxy); mocks.finish.mockResolvedValue(undefined);
  mocks.spawn.mockImplementation((command) => {
    const child = new EventEmitter(); child.pid = 123456; child.kill = vi.fn();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    if (command === "taskkill.exe") { queueMicrotask(() => child.emit("close", 0)); return child; }
    child.stdin.end = input => { sent = JSON.parse(input); queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("PRIVATE_DIAGNOSTIC_TOKEN"));
      child.stdout.emit("data", Buffer.from(typeof output === "string" ? output : JSON.stringify(output)));
      child.emit("close", code);
    }); };
    return child;
  });
});

describe("finite passive publisher JSON observation", () => {
  it.each([home, eligibility])("validates both source-bound snapshots without HTML completeness claims $id", source => {
    const value = observation(source), result = validateScraplingPublisherJsonObservation(value, { source });
    expect(result).toEqual(value); expect(result).not.toBe(value);
    expect(result).not.toHaveProperty("html"); expect(result).not.toHaveProperty("readiness"); expect(result).not.toHaveProperty("publishable");
  });
  it.each([
    v => { v.source_id = eligibility.id; }, v => { v.source_url += "?other"; }, v => { v.profile = "generic-json"; },
    v => { v.html = "<p>fake evidence</p>"; }, v => { v.captured_at = "yesterday"; },
    v => { v.navigation.final_url += "/login"; }, v => { v.navigation.portal_id = "wrong"; },
    v => { v.navigation.status_code = 201; }, v => { v.navigation.content_type = "application/json"; },
    v => { delete v.navigation.base_hrefs; }, v => { v.navigation.base_hrefs = ["https://elsewhere.example/"]; },
    v => { v.navigation.base_hrefs = []; }, v => { v.navigation.base_hrefs = ["/smart", "/smart"]; },
    v => { v.response.frame_id_sha256 = hash("sub-frame"); }, v => { v.response.request_id_sha256 = v.navigation.request_id_sha256; },
    v => { v.response.portal_id = "wrong"; }, v => { v.response.path = "/api/now/table"; },
    v => { v.response.request_page_id = "smart_eligibility"; }, v => { v.response.request_uri += "?other"; },
    v => { v.response.method = "POST"; }, v => { v.response.status_code = 302; }, v => { v.response.content_type = "text/html"; },
    v => { v.response.from_cache = true; }, v => { v.response.from_service_worker = true; },
    v => { v.response.redirected = true; }, v => { v.response.finished = false; },
    v => { v.response.decoded_bytes = 0; }, v => { v.response.decoded_bytes = 512 * 1024 + 1; },
    v => { v.response.raw_sha256 = hash("different"); }, v => { v.raw_json += " "; },
    v => { v.response.raw_headers = { Authorization: "PRIVATE" }; }, v => { v.response.url_sha256 = "not-a-hash"; },
  ])("rejects a mismatched or unreviewed observation guard", mutate => {
    const value = observation(); mutate(value);
    expect(() => validateScraplingPublisherJsonObservation(value, { source: home })).toThrow();
  });
  it.each(["[]", "null", "{broken", '"scalar"', '{"title":"\ud800"}'])("rejects invalid JSON/UTF8 or nonobject raw input", raw => {
    const value = observation(); value.raw_json = raw; value.response.decoded_bytes = Buffer.byteLength(raw); value.response.raw_sha256 = hash(raw);
    expect(() => validateScraplingPublisherJsonObservation(value, { source: home })).toThrow();
  });
  it.each([{ ...home, shared_award_id: "wrong" }, { ...home, id: "another" }, { ...home, url: home.url + "?extra=1" }])("cannot use a host-wide identity exception", async source => {
    expect(() => validateScraplingPublisherJsonObservation(observation(), { source })).toThrow();
    await expect(captureScraplingPublisherJson(source, options)).rejects.toThrow(); expect(mocks.start).not.toHaveBeenCalled();
  });
  it.each([{}, { ...options, publisherJsonProfile: undefined }, { ...options, publisherJsonProfile: "unreviewed" }, { ...options, timeoutMs: 120001 }])("requires separate explicit opt-in before starting any transport", async opts => {
    await expect(captureScraplingPublisherJson(home, opts)).rejects.toThrow(); expect(mocks.start).not.toHaveBeenCalled();
  });
  it("uses the guarded ordinary proxy boundary and a distinct finite collector protocol", async () => {
    expect(await captureScraplingPublisherJson(home, options)).toEqual(observation());
    expect(sent).toEqual({ url: home.url, source_id: home.id, proxy_url: proxy.url, executable_path: options.executablePath,
      publisher_json_profile: "smart-page-v1", shared_award_id: owner });
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    expect(mocks.start).toHaveBeenCalledWith({ timeoutMs: 15000, maxResponseBytes: 60 * 1024 * 1024 });
    expect(mocks.finish).toHaveBeenCalledWith({ networkProxy: proxy, checkpoint: "checkpoint", maxBytes: 60 * 1024 * 1024, shutdownTimeoutMs: 5000 });
  });
  it("finalizes the network boundary even if the collector proof is rejected", async () => {
    output.response.finished = false;
    await expect(captureScraplingPublisherJson(home, options)).rejects.toMatchObject({ pilotReason: "publisher_json_response_binding" });
    expect(mocks.finish).toHaveBeenCalledOnce();
  });
  it("rejects a failed final boundary instead of returning otherwise valid data", async () => {
    mocks.finish.mockRejectedValueOnce(new Error("PRIVATE_BOUNDARY_DETAIL"));
    await expect(captureScraplingPublisherJson(home, options)).rejects.toMatchObject({ pilotReason: "network_boundary_rejected" });
  });
  it("limits typed child output independently and sanitizes failed child errors", async () => {
    output = "x".repeat(2 * 1024 * 1024 + 1);
    await expect(captureScraplingPublisherJson(home, options)).rejects.toMatchObject({ pilotReason: "collector_output_limit" });
    output = { error: "https://private.example/nonce=SECRET" }; code = 2;
    await expect(captureScraplingPublisherJson(home, options)).rejects.toMatchObject({ pilotReason: "collector_failed" });
  });
  it("leaves the default HTML request protocol unchanged", async () => {
    await expect(captureScraplingSource(home, { pythonPath: "synthetic-python", executablePath: "synthetic-browser" })).rejects.toThrow();
    expect(sent).toEqual({ url: home.url, source_id: home.id, proxy_url: proxy.url, executable_path: "synthetic-browser" });
  });
  it("retains original browser safety controls and a separate protocol branch", () => {
    const text = readFileSync(new URL("../scrapling/collector.py", import.meta.url), "utf8");
    for (const literal of ['context.route_web_socket("**/*", websocket_sink)', 'socket.on_message(lambda _: None)',
      'if req.method not in ("GET", "HEAD"):', '"ignore_https_errors": False', '"service_workers": "block"',
      '"accept_downloads": False', 'require_document_response_url(page.url, response)', '"capture_profile" in request or "diagnostic_mode" in request']) expect(text).toContain(literal);
    expect(text).not.toContain("connect_to_server(");
  });
});
