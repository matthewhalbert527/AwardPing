import { createHash } from "node:crypto";

// Pure retained transport binding. No process, browser, filesystem or network
// dependency belongs here; the server replays the same contract from originals.
export const scraplingPublisherJsonProfile = "smart-page-v1";
export const scraplingPublisherJsonObservationSchema = "awardping.scrapling-publisher-json-observation.v1";
export const publisherJsonOriginalLimit = 512 * 1024;
export const smartPublisherOwner = "d7d4d117-f312-456f-a75c-3dbd5d372c99";
export const smartPublisherPortal = "f2a05466db71c300b67330ca7c9619f0";
export const smartPublisherSources = Object.freeze({
  "58aefec0-0d42-4b7b-9887-60d25940b3d0": Object.freeze({ url: "https://www.smartscholarship.org/smart", request_page_id: null }),
  "c33cc2f4-2cbd-458c-b630-537eb3d50f72": Object.freeze({ url: "https://www.smartscholarship.org/smart/en?id=smart_eligibility", request_page_id: "smart_eligibility" }),
});
const digest = value => createHash("sha256").update(value).digest("hex");
const fail = reason => { throw Object.assign(new Error(reason), { pilotReason: reason, code: `program_text_${reason}` }); };

/** A complete initial publisher response, never an HTML completeness waiver. */
export function validateScraplingPublisherJsonObservation(value, { source } = {}) {
  const exact = (object, keys) => object && typeof object === "object" && !Array.isArray(object) &&
    Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
  const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const spec = smartPublisherSources[source?.id];
  if (!spec || source.url !== spec.url || source.shared_award_id !== smartPublisherOwner) fail("publisher_json_source_identity");
  const top = ["schema", "profile", "source_id", "source_url", "captured_at", "navigation", "response", "raw_json"];
  if (!exact(value, top) || value.schema !== scraplingPublisherJsonObservationSchema || value.profile !== scraplingPublisherJsonProfile ||
      value.source_id !== source.id || value.source_url !== source.url || typeof value.captured_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value.captured_at) || !Number.isFinite(Date.parse(value.captured_at))) fail("publisher_json_observation_shape");
  // Python may retain microseconds. Compare calendar/time at millisecond
  // precision, rejecting date rollover rather than accepting Date.parse alone.
  const timestamp = value.captured_at.replace(/(?:\.(\d{1,6}))?Z$/, (_, fraction = "") => `.${fraction.padEnd(3, "0").slice(0, 3)}Z`);
  if (new Date(value.captured_at).toISOString() !== timestamp) fail("publisher_json_observation_shape");
  const nav = value.navigation, response = value.response;
  if (!exact(nav, ["url", "final_url", "method", "status_code", "content_type", "request_id_sha256", "frame_id_sha256", "portal_id", "base_hrefs"]) ||
      nav.url !== source.url || nav.final_url !== source.url || nav.method !== "GET" || nav.status_code !== 200 ||
      typeof nav.content_type !== "string" || !/^(?:text\/html|application\/xhtml\+xml)(?:;[^\r\n]{0,200})?$/.test(nav.content_type) ||
      !hash(nav.request_id_sha256) || !hash(nav.frame_id_sha256) || nav.portal_id !== smartPublisherPortal ||
      !Array.isArray(nav.base_hrefs) || nav.base_hrefs.length !== 1 || nav.base_hrefs[0] !== "/smart") fail("publisher_json_navigation_binding");
  const url = new URL(source.url), requestUri = url.pathname + url.search;
  if (!exact(response, ["portal_id", "request_page_id", "request_uri", "url_sha256", "path", "query_sha256", "request_id_sha256", "frame_id_sha256",
    "method", "status_code", "content_type", "from_cache", "from_service_worker", "redirected", "finished", "decoded_bytes", "raw_sha256"]) ||
      response.portal_id !== smartPublisherPortal || response.request_page_id !== spec.request_page_id || response.request_uri !== requestUri ||
      response.path !== "/api/now/sp/page" || !hash(response.url_sha256) || !hash(response.query_sha256) || !hash(response.request_id_sha256) ||
      response.request_id_sha256 === nav.request_id_sha256 || response.frame_id_sha256 !== nav.frame_id_sha256 || response.method !== "GET" ||
      response.status_code !== 200 || response.content_type !== "application/json" || response.from_cache !== false || response.from_service_worker !== false ||
      response.redirected !== false || response.finished !== true || !Number.isInteger(response.decoded_bytes) || response.decoded_bytes <= 0 ||
      response.decoded_bytes > publisherJsonOriginalLimit || !hash(response.raw_sha256)) fail("publisher_json_response_binding");
  if (typeof value.raw_json !== "string" || value.raw_json.length > publisherJsonOriginalLimit || Buffer.byteLength(value.raw_json, "utf8") !== response.decoded_bytes ||
      Buffer.from(value.raw_json, "utf8").toString("utf8") !== value.raw_json || digest(value.raw_json) !== response.raw_sha256) fail("publisher_json_raw_binding");
  try {
    const parsed = JSON.parse(value.raw_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("publisher_json_invalid_json");
  } catch { fail("publisher_json_invalid_json"); }
  return structuredClone(value);
}

/** Metadata stores bindings once; the separately retained raw artifact supplies
 * the original body again for every replay, avoiding duplicate mutable copies. */
export function publisherJsonObservationMetadata(observation, { source } = {}) {
  const metadata = validateScraplingPublisherJsonObservation(observation, { source });
  delete metadata.raw_json;
  return metadata;
}

export function restorePublisherJsonObservation(metadata, raw, { source } = {}) {
  const keys = ["schema", "profile", "source_id", "source_url", "captured_at", "navigation", "response"];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || Object.keys(metadata).length !== keys.length ||
      !keys.every(key => Object.hasOwn(metadata, key)) || !Buffer.isBuffer(raw)) fail("publisher_json_raw_binding");
  let raw_json;
  try { raw_json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { fail("publisher_json_raw_binding"); }
  if (!Buffer.from(raw_json).equals(raw)) fail("publisher_json_raw_binding");
  return validateScraplingPublisherJsonObservation({ ...metadata, raw_json }, { source });
}
