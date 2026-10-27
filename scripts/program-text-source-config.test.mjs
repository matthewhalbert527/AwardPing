import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({ config: null, sources: [], cohort: "noaa_hollings", calls: [], destroyed: 0 }));
vi.mock("node:fs", async original => {
  const actual = await original();
  return { ...actual, existsSync: filename => /(?:\.env\.worker\.local|\.awardping-scrapling-runtime\.json)$/.test(String(filename)) ? false : actual.existsSync(filename),
    readFileSync: (filename, ...args) => String(filename).endsWith("program-text-monitoring.json") ? JSON.stringify(shared.config) : actual.readFileSync(filename, ...args) };
});
vi.mock("@aws-sdk/client-s3", () => ({ S3Client: class { destroy() { shared.destroyed++; } } }));
vi.mock("./supabase-service-client.mjs", () => ({ closeSupabaseServiceTransport: async () => {},
  createSupabaseServiceClient: () => ({ rpc: async (name, params) => {
    if (name === "get_program_text_fact_review_batch") return { data: [] };
    if (name === "get_program_variation_admin_batch") return { data: emptyVariationBatchFixture() };
    if (name !== "get_program_text_worker_roster_page") throw new Error("Unexpected mutating RPC");
    const roles = [{ cohort_key: shared.cohort, source_role: "current_documents",
      source_ids: shared.sources.map(source => source.id), manifest_status: "reviewed_text", revision: "33333333-3333-4333-8333-333333333333",
      evidence: { schema: "awardping.program-text-source-role.v1", source_bindings: Object.fromEntries(shared.sources.map(source =>
        [source.id, { source_url: source.url, shared_award_id: source.shared_award_id }])) } }];
    return rosterPageFixture(roles, shared.sources)(params);
  } }) }));
vi.mock("./lib/program-text-monitor.mjs", () => ({ monitorProgramTextSource: async input => {
  shared.calls.push(input); return { status: "baseline_ready", initial_coverage: true };
}, finalizeProgramTextReview: async () => { throw new Error("Review is not authorized by this source configuration fixture"); } }));
vi.mock("./lib/program-text-browser.mjs", async original => ({ ...await original(),
  findProgramTextBrowserExecutable: () => "C:/Existing/Chrome/chrome.exe" }));

import { runProgramTextWorker } from "./program-text-worker.mjs";
import { rosterPageFixture, emptyVariationBatchFixture } from "./fixtures/program-text-roster-pages.mjs";
import { SMART_GUIDE_KB_SOURCE_PROFILES } from "./lib/program-text-smart-guide-profiles.mjs";

const nativeFs = await vi.importActual("node:fs");
const actualConfig = JSON.parse(nativeFs.readFileSync(new URL("../config/program-text-monitoring.json", import.meta.url), "utf8"));
const canonical = "a9b42e3f-6d7e-4b0d-8132-77c2042b311d", alias = "d53e5643-1f05-4b97-ad7c-84fecb061189";
// Existing identities were independently read from shared_award_sources.
// The new application identity is reserved in its reviewed pending proposal;
// its actual guarded acquisition was checked without approving collection.
// The current-scholar FAQ legitimately retains its alias owner.
const reviewed = [
  { id: "e179694a-c623-4534-91d6-ef90fa0b0e38", shared_award_id: canonical,
    url: "https://www.noaa.gov/office-education/hollings-scholarship", page_type: "homepage", acquisition: "rendered_html" },
  { id: "3ff68da4-d8e5-4aa2-8ace-2280d8711fc1", shared_award_id: canonical,
    url: "https://www.noaa.gov/office-education/hollings-scholarship/prospective", page_type: "eligibility", acquisition: "rendered_html" },
  { id: "ec1cffa6-9049-4482-a328-ec989506b787", shared_award_id: alias,
    url: "https://www.noaa.gov/office-education/hollings-scholarship/current/faq", page_type: "faq", acquisition: "rendered_html" },
  { id: "8f1f2753-2271-4158-9272-26a66ed2a996", shared_award_id: canonical,
    url: "https://www.noaa.gov/media/file/pdf-hollings-project-plan-form-062316-office-of-education", page_type: "pdf", acquisition: "pdf_text", pdf_transport: "browser" },
  { id: "e5acfcc4-3469-4fc8-99f1-ee14e8dbbda1", shared_award_id: canonical,
    url: "https://www.noaa.gov/office-education/hollings-scholarship/prospective/faq", page_type: "faq", acquisition: "rendered_html" },
  { id: "1cfc6e13-6e13-4917-81c2-a8dc4c0292fb", shared_award_id: canonical,
    url: "https://www.noaa.gov/office-education/undergraduate-scholarships", page_type: "application", acquisition: "rendered_html" },
];
const sourceRows = () => reviewed.map(({ id, shared_award_id, url, page_type }) => ({ id, shared_award_id, url, page_type, admin_review_status: "open" }));
const smartCanonical = "d7d4d117-f312-456f-a75c-3dbd5d372c99", smartAlias = "1efa2a75-e6b8-4bf6-80be-85ef2f6b3108";
// Independent reviewed identities, including the existing alias-owned routes.
// Expected owners, literal URLs and page types do not come from the configuration.
const smartReviewed = [
  { id: "58aefec0-0d42-4b7b-9887-60d25940b3d0", shared_award_id: smartCanonical,
    url: "https://www.smartscholarship.org/smart", page_type: "homepage" },
  { id: "c33cc2f4-2cbd-458c-b630-537eb3d50f72", shared_award_id: smartCanonical,
    url: "https://www.smartscholarship.org/smart/en?id=smart_eligibility", page_type: "eligibility" },
  { id: "203baaf3-2905-4fdf-b4af-af84998195a8", shared_award_id: smartCanonical,
    url: "https://www.smartscholarship.org/smart/en?id=kb_article&sys_id=84f05b02db5ac3006bb8f4b40f9619cc", page_type: "faq" },
  { id: "2562f7c2-4709-4d63-ac25-c4638733a981", shared_award_id: smartAlias,
    url: "https://www.smartscholarship.org/smart?id=kb_article&sys_id=b8fb18e0db8a8300ecc734cc7c9619d7", page_type: "application" },
  { id: "39685b8a-3ad9-41c5-834b-b2aaafb2b0e5", shared_award_id: smartAlias,
    url: "https://www.smartscholarship.org/smart?id=kb_article&sys_id=0383c5d6db2a03006bb8f4b40f961956", page_type: "deadline" },
  { id: "92eebc07-7392-4136-ba13-d9cd5455c8f9", shared_award_id: smartAlias,
    url: "https://www.smartscholarship.org/smart/en", page_type: "homepage" },
];
const smartSourceRows = () => smartReviewed.map(profile => ({ ...profile, admin_review_status: "open" }));
const smartGuides = SMART_GUIDE_KB_SOURCE_PROFILES.map(profile => Object.fromEntries(
  ["id", "shared_award_id", "url", "title", "page_type"].map(key => [key, profile[key]])));

beforeEach(() => {
  shared.config = structuredClone(actualConfig); shared.sources = sourceRows(); shared.cohort = "noaa_hollings"; shared.calls = []; shared.destroyed = 0;
  for (const [key, value] of Object.entries({ NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "fake-never-sent",
    R2_BUCKET: "private-bucket", R2_ENDPOINT: "https://fixture.invalid", R2_ACCESS_KEY_ID: "fake-never-sent", R2_SECRET_ACCESS_KEY: "fake-never-sent" })) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

describe("reviewed source-bound browser acquisition configuration", () => {
  it("preserves the six SMART identities and uses explicit reviewed modes for the twelve guides", async () => {
    expect(Object.entries(actualConfig.sources).filter(([, value]) => value.acquisition === "publisher_json").map(([id]) => id).sort())
      .toEqual([...smartReviewed, ...smartGuides].map(profile => profile.id).sort());
    for (const profile of smartReviewed) expect(actualConfig.sources[profile.id]).toEqual({ source_url: profile.url, shared_award_id: profile.shared_award_id,
      acquisition: "publisher_json", publisher_json_profile: "smart-page-v1" });
    for (const profile of smartGuides) expect(actualConfig.sources[profile.id]).toEqual({ source_url: profile.url, shared_award_id: profile.shared_award_id,
      source_title: profile.title, page_type: profile.page_type, acquisition: "publisher_json", publisher_json_profile: "smart-page-v1" });
    shared.sources = [...smartSourceRows(), ...smartGuides.map(profile => ({ ...profile, admin_review_status: "open" }))]; shared.cohort = "smart";
    await runProgramTextWorker(["--mode=collect", "--apply=true", "--domain-delay-ms=0"]);
    expect(shared.calls).toHaveLength(18);
    for (const profile of [...smartReviewed, ...smartGuides]) {
      const call = shared.calls.find(value => value.source.id === profile.id);
      expect(call.source).toMatchObject(profile);
      expect(call.captureOptions).toMatchObject({ acquisition: "publisher_json", publisher_json_profile: "smart-page-v1" });
    }
  });
  it.each(smartReviewed.flatMap(source => [
    { id: source.id, field: "url", value: `${source.url}/changed` },
    { id: source.id, field: "shared_award_id", value: source.shared_award_id === smartCanonical ? smartAlias : smartCanonical },
  ]))("holds changed SMART literal binding $id / $field before acquisition", async ({ id, field, value }) => {
    shared.sources = smartSourceRows(); shared.cohort = "smart";
    shared.sources.find(source => source.id === id)[field] = value;
    const report = await runProgramTextWorker(["--mode=collect", "--apply=true", `--source-id=${id}`, "--domain-delay-ms=0"]);
    expect(report.results).toEqual([{ source_id: id, status: "held", reason: "source_configuration_changed" }]);
    expect(shared.calls).toEqual([]);
  });
  it("enables browser acquisition only for the six reviewed NOAA identities", () => {
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
    expect(report.results).toHaveLength(6); expect(shared.calls).toHaveLength(6);
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
