import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({ config: null, sources: [], calls: [] }));
vi.mock("node:fs", async original => {
  const actual = await original();
  return { ...actual, existsSync: filename => /(?:\.env\.worker\.local|\.awardping-scrapling-runtime\.json)$/.test(String(filename)) ? false : actual.existsSync(filename),
    readFileSync: (filename, ...args) => String(filename).endsWith("program-text-monitoring.json") ? JSON.stringify(shared.config) : actual.readFileSync(filename, ...args) };
});
vi.mock("@aws-sdk/client-s3", () => ({ S3Client: class { destroy() {} } }));
vi.mock("./supabase-service-client.mjs", () => ({ closeSupabaseServiceTransport: async () => {},
  createSupabaseServiceClient: () => ({ rpc: async (name, params) => {
    if (name === "get_program_text_fact_review_batch") return { data: [] };
    if (name === "get_program_variation_admin_batch") return { data: emptyVariationBatchFixture() };
    if (name !== "get_program_text_worker_roster_page") throw new Error("Unexpected mutating RPC");
    const roles = [{ cohort_key: "cls", source_role: "funding", source_ids: shared.sources.map(source => source.id),
      manifest_status: "reviewed_text", revision: "33333333-3333-4333-8333-333333333333",
      evidence: { schema: "awardping.program-text-source-role.v1", source_bindings: Object.fromEntries(shared.sources.map(source =>
        [source.id, { source_url: source.url, shared_award_id: source.shared_award_id }])) } }];
    return rosterPageFixture(roles, shared.sources)(params);
  } }) }));
vi.mock("./lib/program-text-monitor.mjs", () => ({ monitorProgramTextSource: async input => {
  shared.calls.push(input); return { status: "baseline_ready", initial_coverage: true };
}, finalizeProgramTextReview: async () => { throw new Error("No paid review in acquisition fixture"); } }));
vi.mock("./lib/program-text-browser.mjs", async original => ({ ...await original(),
  findProgramTextBrowserExecutable: () => "C:/Existing/Chrome/chrome.exe" }));

import { runProgramTextWorker } from "./program-text-worker.mjs";
import { rosterPageFixture, emptyVariationBatchFixture } from "./fixtures/program-text-roster-pages.mjs";

const nativeFs = await vi.importActual("node:fs");
const config = JSON.parse(nativeFs.readFileSync(new URL("../config/program-text-monitoring.json", import.meta.url), "utf8"));
const source = { id: "1760f785-9797-40bb-91e4-446495c1047b", shared_award_id: "ba1a3c76-4868-42b4-994b-6cbae72a7044",
  url: "https://clscholarship.org/about/program-overview", page_type: "other", admin_review_status: "open" };

beforeEach(() => {
  shared.config = structuredClone(config); shared.sources = [structuredClone(source)]; shared.calls = [];
  for (const [key, value] of Object.entries({ NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "fake-never-sent",
    R2_BUCKET: "private-bucket", R2_ENDPOINT: "https://fixture.invalid", R2_ACCESS_KEY_ID: "fake-never-sent", R2_SECRET_ACCESS_KEY: "fake-never-sent" })) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

describe("stable CLS overview acquisition after ordinary HTTP coverage", () => {
  it("preserves the successful ordinary HTTP acquisition and keeps diagnostics off", async () => {
    expect(config.sources[source.id]).toBeUndefined();
    const report = await runProgramTextWorker(["--mode=collect", "--apply=true", "--domain-delay-ms=0"]);
    expect(report.results).toHaveLength(1); expect(shared.calls).toHaveLength(1);
    expect(shared.calls[0].source.id).toBe(source.id);
    expect(shared.calls[0].captureOptions).toMatchObject({ acquisition: "http_html", pdf_transport: "http", executablePath: "C:/Existing/Chrome/chrome.exe" });
    expect(shared.calls[0].captureOptions).not.toHaveProperty("browserDiagnostics");
  });
  it("does not infer a browser policy for other CLS pages or a new identity at the same URL", async () => {
    shared.sources = [{ ...source, id: "11111111-1111-4111-8111-111111111111" },
      { ...source, id: "22222222-2222-4222-8222-222222222222", url: "https://clscholarship.org/applicants/applicant-faq" }];
    await runProgramTextWorker(["--mode=collect", "--apply=true", "--domain-delay-ms=0"]);
    expect(shared.calls.map(call => call.captureOptions.acquisition)).toEqual(["http_html", "http_html"]);
  });
});
