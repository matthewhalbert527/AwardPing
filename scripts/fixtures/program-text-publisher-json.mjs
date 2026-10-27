import { createHash } from "node:crypto";
import { SMART_PUBLISHER_JSON_SOURCE_PROFILES } from "../lib/program-text-smart-publisher-json.mjs";
import { scraplingPublisherJsonProfile, scraplingPublisherJsonObservationSchema } from "../lib/program-text-publisher-json.mjs";
import { createSyntheticSmartPublisherJsonFixture } from "./smart-publisher-json.mjs";
import { SMART_KB_PUBLISHER_SOURCE_PROFILES } from "../lib/program-text-smart-kb-publisher-json.mjs";
import { createSyntheticSmartKbPublisherJsonFixture } from "./smart-kb-publisher-json.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
// Test observations only. These identifiers do not attest a real browser request.
export function syntheticPublisherJsonObservation(key = "home", { captured_at = "2026-10-27T04:00:00.000Z", edit } = {}) {
  const extra = key === "home_alias" ? SMART_PUBLISHER_JSON_SOURCE_PROFILES.find(item => item.id === "92eebc07-7392-4136-ba13-d9cd5455c8f9") :
    SMART_KB_PUBLISHER_SOURCE_PROFILES.find(item => item.key === key);
  if (extra) {
    const { observation } = syntheticPublisherJsonObservation("home", { captured_at });
    const document = key === "home_alias" ? createSyntheticSmartPublisherJsonFixture("home") : createSyntheticSmartKbPublisherJsonFixture(key);
    if (key === "home_alias") document.result.theme.header.data.loginWidget.data.pageURI = "/smart/en";
    edit?.(document, extra);
    const source = { id: extra.id, shared_award_id: extra.shared_award_id, url: extra.url, title: `Synthetic ${key}`, page_type: extra.page_type };
    observation.source_id = source.id; observation.source_url = source.url;
    observation.navigation.url = source.url; observation.navigation.final_url = source.url;
    const url = new URL(source.url); observation.response.request_uri = url.pathname + url.search;
    observation.response.request_page_id = extra.key === "home" ? null : "kb_article";
    observation.raw_json = JSON.stringify(document); observation.response.decoded_bytes = Buffer.byteLength(observation.raw_json);
    observation.response.raw_sha256 = sha(observation.raw_json);
    return { source, observation };
  }
  const profile = SMART_PUBLISHER_JSON_SOURCE_PROFILES.find(item => item.key === key);
  if (!profile) throw new Error("Unknown synthetic publisher profile");
  const source = { id: profile.id, shared_award_id: profile.shared_award_id, url: profile.url, title: `Synthetic ${key}`, page_type: key === "home" ? "homepage" : "eligibility" };
  const document = createSyntheticSmartPublisherJsonFixture(key); edit?.(document, profile);
  const raw_json = JSON.stringify(document), raw = Buffer.from(raw_json), url = new URL(source.url);
  return { source, observation: { schema: scraplingPublisherJsonObservationSchema, profile: scraplingPublisherJsonProfile,
    source_id: source.id, source_url: source.url, captured_at,
    navigation: { url: source.url, final_url: source.url, method: "GET", status_code: 200, content_type: "text/html;charset=UTF-8",
      request_id_sha256: sha(`synthetic-nav-${key}`), frame_id_sha256: sha(`synthetic-frame-${key}`), portal_id: profile.portal_id, base_hrefs: ["/smart"] },
    response: { portal_id: profile.portal_id, request_page_id: key === "home" ? null : "smart_eligibility", request_uri: url.pathname + url.search,
      url_sha256: sha(`synthetic-api-${key}`), path: "/api/now/sp/page", query_sha256: sha(`synthetic-query-${key}`),
      request_id_sha256: sha(`synthetic-api-request-${key}`), frame_id_sha256: sha(`synthetic-frame-${key}`),
      method: "GET", status_code: 200, content_type: "application/json", from_cache: false, from_service_worker: false,
      redirected: false, finished: true, decoded_bytes: raw.length, raw_sha256: sha(raw) }, raw_json } };
}
