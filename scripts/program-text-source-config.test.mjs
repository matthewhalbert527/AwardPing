import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({ config: null, sources: [], calls: [], destroyed: 0 }));
vi.mock("node:fs", async original => {
  const actual = await original();
  return { ...actual, existsSync: filename => /(?:\.env\.worker\.local|\.awardping-scrapling-runtime\.json)$/.test(String(filename)) ? false : actual.existsSync(filename),
    readFileSync: (filename, ...args) => String(filename).endsWith("program-text-monitoring.json") ? JSON.stringify(shared.config) : actual.readFileSync(filename, ...args) };
});
vi.mock("@aws-sdk/client-s3", () => ({ S3Client: class { destroy() { shared.destroyed++; } } }));
vi.mock("./supabase-service-client.mjs", () => ({ closeSupabaseServiceTransport: async () => {},
  createSupabaseServiceClient: () => ({ rpc: async name => {
    if (name !== "get_program_text_fact_review_batch") throw new Error("Unexpected mutating RPC");
    return { data: [] };
  }, from(table) {
    const rows = table === "program_text_source_roster" ? [{ cohort_key: "noaa_hollings", source_role: "current_documents",
      source_ids: shared.sources.map(source => source.id), manifest_status: "reviewed_text", revision: "33333333-3333-4333-8333-333333333333",
      evidence: { schema: "awardping.program-text-source-role.v1", source_bindings: Object.fromEntries(shared.sources.map(source =>
        [source.id, { source_url: source.url, shared_award_id: source.shared_award_id }])) } }] :
      table === "shared_award_sources" ? shared.sources : null;
    if (!rows) throw new Error("Unexpected table in source configuration test");
    const query = { select() { return query; }, in() { return query; }, order() { return query; }, limit() { return query; },
      then(yes, no) { return Promise.resolve({ data: rows }).then(yes, no); } };
    return query;
  } }) }));
vi.mock("./lib/program-text-monitor.mjs", () => ({ monitorProgramTextSource: async input => {
  shared.calls.push(input); return { status: "baseline_ready", initial_coverage: true };
}, finalizeProgramTextReview: async () => { throw new Error("Review is not authorized by this source configuration fixture"); } }));
vi.mock("./lib/program-text-browser.mjs", async original => ({ ...await original(),
  findProgramTextBrowserExecutable: () => "C:/Existing/Chrome/chrome.exe" }));

import { runProgramTextWorker } from "./program-text-worker.mjs";

const nativeFs = await vi.importActual("node:fs");
const actualConfig = JSON.parse(nativeFs.readFileSync(new URL("../config/program-text-monitoring.json", import.meta.url), "utf8"));
const canonical = "a9b42e3f-6d7e-4b0d-8132-77c2042b311d", alias = "d53e5643-1f05-4b97-ad7c-84fecb061189";
// These exact identities were independently re-read from shared_award_sources.
// In particular, the current-scholar FAQ legitimately retains its alias owner.
const reviewed = [
  { id: "e179694a-c623-4534-91d6-ef90fa0b0e38", shared_award_id: canonical,
    url: "https://www.noaa.gov/office-education/hollings-scholarship", page_type: "homepage", acquisition: "rendered_html" },
  { id: "3ff68da4-d8e5-4aa2-8ace-2280d8711fc1", shared_award_id: canonical,
    url: "https://www.noaa.gov/office-education/hollings-scholarship/prospective", page_type: "eligibility", acquisition: "rendered_html" },
  { id: "ec1cffa6-9049-4482-a328-ec989506b787", shared_award_id: alias,
    url: "https://www.noaa.gov/office-education/hollings-scholarship/current/faq", page_type: "faq", acquisition: "rendered_html" },
  { id: "8f1f2753-2271-4158-9272-26a66ed2a996", shared_award_id: canonical,
    url: "https://www.noaa.gov/media/file/pdf-hollings-project-plan-form-062316-office-of-education", page_type: "pdf", acquisition: "pdf_text", pdf_transport: "browser" },
];
const sourceRows = () => reviewed.map(({ acquisition: _acquisition, pdf_transport: _transport, ...source }) => ({ ...source, admin_review_status: "open" }));

beforeEach(() => {
  shared.config = structuredClone(actualConfig); shared.sources = sourceRows(); shared.calls = []; shared.destroyed = 0;
  for (const [key, value] of Object.entries({ NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "fake-never-sent",
    R2_BUCKET: "private-bucket", R2_ENDPOINT: "https://fixture.invalid", R2_ACCESS_KEY_ID: "fake-never-sent", R2_SECRET_ACCESS_KEY: "fake-never-sent" })) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

describe("reviewed source-bound browser acquisition configuration", () => {
  it("enables browser acquisition for exactly the four reviewed NOAA source identities", () => {
    const browserOverrides = Object.entries(actualConfig.sources).filter(([, options]) => options.acquisition === "rendered_html" || options.pdf_transport === "browser");
    expect(browserOverrides.map(([id]) => id).sort()).toEqual(reviewed.map(source => source.id).sort());
    for (const source of reviewed) {
      expect(actualConfig.sources[source.id]).toEqual({ source_url: source.url, shared_award_id: source.shared_award_id,
        acquisition: source.acquisition, ...(source.pdf_transport ? { pdf_transport: source.pdf_transport } : {}) });
    }
    expect(actualConfig.sources[reviewed[2].id].shared_award_id).toBe(alias);
    expect(actualConfig.sources[reviewed[3].id].source_url).not.toContain("/sites/default/files/");
  });
  it("passes explicit per-source acquisition and transport without replacing source identities", async () => {
    const report = await runProgramTextWorker(["--mode=collect", "--apply=true", "--domain-delay-ms=0"]);
    expect(report.results).toHaveLength(4); expect(shared.calls).toHaveLength(4);
    for (const source of reviewed) {
      const call = shared.calls.find(value => value.source.id === source.id);
      expect(call.source).toMatchObject({ url: source.url, shared_award_id: source.shared_award_id });
      expect(call.captureOptions).toMatchObject({ executablePath: "C:/Existing/Chrome/chrome.exe", acquisition: source.acquisition,
        pdf_transport: source.pdf_transport || "http" });
    }
    expect(shared.destroyed).toBe(1);
  });
  it.each(reviewed.flatMap(source => [
    { id: source.id, field: "url", value: `${source.url}/changed` },
    { id: source.id, field: "shared_award_id", value: source.shared_award_id === alias ? canonical : alias },
  ]))("holds changed exact source binding $id / $field before acquisition", async ({ id, field, value }) => {
    shared.sources.find(source => source.id === id)[field] = value;
    const report = await runProgramTextWorker(["--mode=collect", "--apply=true", `--source-id=${id}`, "--domain-delay-ms=0"]);
    expect(report.results).toEqual([{ source_id: id, status: "held", reason: "source_configuration_changed" }]);
    expect(shared.calls).toEqual([]);
  });
  it("does not select browser transport for unconfigured ordinary HTML or PDF sources", async () => {
    shared.config.sources = {};
    shared.sources = [{ id: "11111111-1111-4111-8111-111111111111", shared_award_id: canonical, url: "https://example.org/award", page_type: "application", admin_review_status: "open" },
      { id: "22222222-2222-4222-8222-222222222222", shared_award_id: canonical, url: "https://example.org/award.pdf", page_type: "pdf", admin_review_status: "open" }];
    await runProgramTextWorker(["--mode=collect", "--apply=true", "--domain-delay-ms=0"]);
    expect(shared.calls.map(value => [value.captureOptions.acquisition, value.captureOptions.pdf_transport])).toEqual([["http_html", "http"], ["pdf_text", "http"]]);
  });
});
