import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as current from "./program-text-publisher-json.mjs";
import { syntheticPublisherJsonObservation } from "../fixtures/program-text-publisher-json.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const kbIds = Object.keys(current.smartPublisherSources).filter(id => current.smartPublisherSources[id].request_page_id === "kb_article");
const originalSources = {
  "58aefec0-0d42-4b7b-9887-60d25940b3d0": { url: "https://www.smartscholarship.org/smart", request_page_id: null },
  "c33cc2f4-2cbd-458c-b630-537eb3d50f72": { url: "https://www.smartscholarship.org/smart/en?id=smart_eligibility", request_page_id: "smart_eligibility" },
};
// Independent fixed-byte receipts from the reviewed pre-extension observer and
// unchanged synthetic inputs; no dependency on an external/private checkout.
const oldDigests = {
  home: { observation: "8b8b063aaf85cdb69232cc4d41a1c54cda43f932d5e59e8e71bc2c7f825e715a", metadata: "0443df9638fd79b251e17413c3fd1b9213b24e28d39a878921c3b2a45ee6d19d" },
  eligibility: { observation: "05d9b9f3833957cedc732908ca7e524b6fd52d0b6e4928725417d4303fc7f756", metadata: "fed4d4b4423fb14b550ab90b1bacd8521a7ea1e866d8a73759cc2cb34783aa71" },
};
const priorKbDigests = {
  "203baaf3-2905-4fdf-b4af-af84998195a8": { observation: "7ce7ee8ddc68623319ebc1b484b0c0f6bf58249ad409b9f59f037f8156e9a526", metadata: "b9b74c2ff6056aec376b8056a9661a7af5fcd5766e51534b38f2bf5d48795fe0" },
  "2562f7c2-4709-4d63-ac25-c4638733a981": { observation: "ade700ba160feed2f15029cff8892afb549f3834c81b56d18edf03a970d46100", metadata: "c5b5cba769da70b87a0e5051371c07285cb55c8fa38f549aee2482d412c16d12" },
  "39685b8a-3ad9-41c5-834b-b2aaafb2b0e5": { observation: "6e9f0dbf363a8e2c75df527bc79328b4ae17cc0fd95c96563c0466865bfb3982", metadata: "b7df3b5b63c216b49795dc7e26f893c05a10332fb049d34933ba20ebbd701b00" },
};
const priorKbSources = {
  "203baaf3-2905-4fdf-b4af-af84998195a8": { url: "https://www.smartscholarship.org/smart/en?id=kb_article&sys_id=84f05b02db5ac3006bb8f4b40f9619cc", request_page_id: "kb_article", shared_award_id: "d7d4d117-f312-456f-a75c-3dbd5d372c99", page_type: "faq" },
  "2562f7c2-4709-4d63-ac25-c4638733a981": { url: "https://www.smartscholarship.org/smart?id=kb_article&sys_id=b8fb18e0db8a8300ecc734cc7c9619d7", request_page_id: "kb_article", shared_award_id: "1efa2a75-e6b8-4bf6-80be-85ef2f6b3108", page_type: "application" },
  "39685b8a-3ad9-41c5-834b-b2aaafb2b0e5": { url: "https://www.smartscholarship.org/smart?id=kb_article&sys_id=0383c5d6db2a03006bb8f4b40f961956", request_page_id: "kb_article", shared_award_id: "1efa2a75-e6b8-4bf6-80be-85ef2f6b3108", page_type: "deadline" },
};
function fixture(id) {
  const spec = current.smartPublisherSources[id], { observation } = syntheticPublisherJsonObservation("home");
  const source = { id, shared_award_id: spec.shared_award_id, url: spec.url, title: spec.title ?? "Synthetic article only", page_type: spec.page_type };
  observation.source_id = id; observation.source_url = spec.url;
  observation.navigation.url = spec.url; observation.navigation.final_url = spec.url;
  observation.response.request_page_id = spec.request_page_id;
  observation.response.request_uri = new URL(spec.url).pathname + new URL(spec.url).search;
  observation.raw_json = JSON.stringify({ result: { synthetic_transport_test_only: true } });
  observation.response.raw_sha256 = sha(observation.raw_json); observation.response.decoded_bytes = Buffer.byteLength(observation.raw_json);
  return { source, observation };
}
test("reviewed guide identities extend the unchanged six public transport profiles", () => {
  const guideIds = ["bfd3e15c-3905-4db6-ac2c-e0a5b1637872", "b29da726-dc73-4de6-a67b-1f536a58771e",
    "87111fbf-0b03-43e1-bb6f-0f23359617d7", "b4ad8c95-9410-4ceb-9fc4-0e077f34f612", "e6b62753-2830-420b-b6f3-6af6f6ec704e",
    "f7d55da4-9abb-4024-a423-d930573fb50f", "2f1c3cc1-7309-481c-9c6b-4c5cba1f648f", "c3299a3b-f98f-4b65-abe1-c50dba35539d",
    "32728eb4-99f3-4a2f-a349-d8ab5f73271d", "bbe47dba-a910-4379-ba16-bc634ea4850c", "a66df6fc-6fab-4e8c-8cdd-19fcd48e6015",
    "5f92d7f3-5b5d-41b1-97ec-16aa0e56be8d"];
  assert.equal(Object.keys(current.smartPublisherSources).length, 18); assert.equal(kbIds.length, 15);
  assert.deepEqual(kbIds.filter(id => !Object.hasOwn(priorKbSources, id)).sort(), guideIds.sort());
  for (const [id, profile] of Object.entries(originalSources)) assert.deepEqual(current.smartPublisherSources[id], profile);
  assert.equal(current.scraplingPublisherJsonProfile, "smart-page-v1");
  assert.equal(current.scraplingPublisherJsonObservationSchema, "awardping.scrapling-publisher-json-observation.v1");
  assert.equal(current.publisherJsonOriginalLimit, 512 * 1024);
  assert.deepEqual(current.smartPublisherSources["92eebc07-7392-4136-ba13-d9cd5455c8f9"], {
    url: "https://www.smartscholarship.org/smart/en", request_page_id: null,
    shared_award_id: "1efa2a75-e6b8-4bf6-80be-85ef2f6b3108", page_type: "homepage" });
});
for (const key of ["home", "eligibility"]) test(`old ${key} DTO, metadata and cold restoration stay byte-identical`, () => {
  const { source, observation } = syntheticPublisherJsonObservation(key);
  for (const fn of ["validateScraplingPublisherJsonObservation", "publisherJsonObservationMetadata"]) {
    assert.equal(sha(JSON.stringify(current[fn](observation, { source }))), oldDigests[key][fn === "publisherJsonObservationMetadata" ? "metadata" : "observation"]);
  }
  const metadata = current.publisherJsonObservationMetadata(observation, { source }), raw = Buffer.from(observation.raw_json);
  assert.equal(sha(JSON.stringify(current.restorePublisherJsonObservation(metadata, raw, { source }))), oldDigests[key].observation);
});
for (const id of kbIds) {
  test(`exact article ${id} cold-restores whole original with the existing schema`, () => {
    const { source, observation } = fixture(id), before = structuredClone(observation);
    assert.deepEqual(current.validateScraplingPublisherJsonObservation(observation, { source }), before);
    const metadata = current.publisherJsonObservationMetadata(observation, { source });
    assert.equal(metadata.raw_json, undefined);
    assert.deepEqual(current.restorePublisherJsonObservation(metadata, Buffer.from(observation.raw_json), { source }), before);
    assert.deepEqual(observation, before);
  });
  test(`article ${id} does not canonicalize alias ownership, source URL or page type`, () => {
    for (const edit of [s => { s.shared_award_id = "unregistered"; }, s => { s.shared_award_id = s.shared_award_id === current.smartPublisherOwner ? "1efa2a75-e6b8-4bf6-80be-85ef2f6b3108" : current.smartPublisherOwner; },
      s => { s.url += "&other=1"; }, s => { s.page_type = s.page_type === "deadline" ? "application" : "deadline"; },
      s => { s.id = kbIds.find(other => other !== id); }]) {
      const { source, observation } = fixture(id); edit(source);
      assert.throws(() => current.validateScraplingPublisherJsonObservation(observation, { source }), /source_identity/);
    }
  });
  test(`article ${id} keeps all observation, cold raw and request guards`, () => {
    for (const edit of [v => { v.navigation.final_url += "#other"; }, v => { v.navigation.base_hrefs = []; }, v => { v.response.request_page_id = "smart_eligibility"; },
      v => { v.response.request_uri = v.response.request_uri.replace(/sys_id=.+$/, "sys_id=" + "0".repeat(32)); }, v => { v.response.from_cache = true; },
      v => { v.response.from_service_worker = true; }, v => { v.response.redirected = true; }, v => { v.response.finished = false; },
      v => { v.response.method = "POST"; }, v => { v.response.frame_id_sha256 = "0".repeat(64); }, v => { v.response.decoded_bytes = 512 * 1024 + 1; },
      v => { v.raw_json += " "; }, v => { v.response.raw_sha256 = "0".repeat(64); }, v => { v.response.extra = true; }]) {
      const { source, observation } = fixture(id); edit(observation);
      assert.throws(() => current.validateScraplingPublisherJsonObservation(observation, { source }));
    }
  });
}
test("instructions preserve their existing deadline page type", () => {
  assert.equal(current.smartPublisherSources["39685b8a-3ad9-41c5-834b-b2aaafb2b0e5"].page_type, "deadline");
});
test("the fourth finite route retains its own alias UUID, owner, homepage type and full literal route", () => {
  const id = "92eebc07-7392-4136-ba13-d9cd5455c8f9", { source, observation } = fixture(id);
  assert.equal(observation.source_id, id); assert.equal(observation.response.request_uri, "/smart/en");
  assert.equal(observation.response.request_page_id, null);
  assert.deepEqual(current.validateScraplingPublisherJsonObservation(observation, { source }), observation);
  const metadata = current.publisherJsonObservationMetadata(observation, { source });
  assert.deepEqual(current.restorePublisherJsonObservation(metadata, Buffer.from(observation.raw_json), { source }), observation);
});
test("the fourth route never accepts canonical owner substitution or homepage URL normalization", () => {
  const id = "92eebc07-7392-4136-ba13-d9cd5455c8f9";
  for (const edit of [s => { s.shared_award_id = current.smartPublisherOwner; }, s => { s.url = "https://www.smartscholarship.org/smart"; },
    s => { s.url += "/"; }, s => { s.page_type = "eligibility"; }, s => { s.id = "58aefec0-0d42-4b7b-9887-60d25940b3d0"; }]) {
    const { source, observation } = fixture(id); edit(source);
    assert.throws(() => current.validateScraplingPublisherJsonObservation(observation, { source }), /source_identity/);
  }
});
test("the fourth route preserves same-frame, absent id, complete response, raw and cold-restore guards", () => {
  for (const edit of [v => { v.response.request_page_id = "smart_index"; }, v => { v.response.request_uri = "/smart"; },
    v => { v.navigation.final_url += "/"; }, v => { v.navigation.base_hrefs = []; }, v => { v.response.from_cache = true; },
    v => { v.response.finished = false; }, v => { v.response.frame_id_sha256 = "0".repeat(64); }, v => { v.raw_json += " "; }]) {
    const { source, observation } = fixture("92eebc07-7392-4136-ba13-d9cd5455c8f9"); edit(observation);
    assert.throws(() => current.validateScraplingPublisherJsonObservation(observation, { source }));
  }
});
test("all five prior source entries, accepted DTOs and metadata are unchanged", () => {
  for (const [id, profile] of Object.entries({ ...originalSources, ...priorKbSources })) {
    assert.deepEqual(current.smartPublisherSources[id], profile);
    if (profile.request_page_id === "kb_article") {
      const { source, observation } = fixture(id);
      for (const fn of ["validateScraplingPublisherJsonObservation", "publisherJsonObservationMetadata"]) {
        assert.equal(sha(JSON.stringify(current[fn](observation, { source }))), priorKbDigests[id][fn === "publisherJsonObservationMetadata" ? "metadata" : "observation"]);
      }
    }
  }
});
test("new pure contract adds no acquisition or runtime capability", () => {
  const code = readFileSync(new URL("./program-text-publisher-json.mjs", import.meta.url), "utf8");
  const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map(m => m[1]);
  assert.deepEqual(imports, ["node:crypto", "./program-text-smart-guide-profiles.mjs"]);
  const profiles = readFileSync(new URL("./program-text-smart-guide-profiles.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(profiles, /\b(?:import|fetch|eval|exec|spawn|readFile|writeFile|WebSocket)\s*(?:\(|[{"'])/);
  assert.doesNotMatch(code, /\b(?:fetch|eval|exec|spawn|readFile|writeFile|WebSocket)\s*\(/);
});
