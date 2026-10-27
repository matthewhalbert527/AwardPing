import test from "node:test";
import assert from "node:assert/strict";
import { captureProgramTextSource } from "./program-text-capture.mjs";
import { SMART_GUIDE_KB_SOURCE_PROFILES } from "./program-text-smart-guide-profiles.mjs";

// A registered programme guide must never silently fall back to a loading shell
// or unrelated transport when its reviewed publisher mode/identity is missing.
test("SMART guides reject fallback transports before any acquisition", async () => {
  let acquisitions = 0;
  const unexpected = async () => { acquisitions++; throw new Error("Unexpected acquisition"); };
  for (const profile of SMART_GUIDE_KB_SOURCE_PROFILES) {
    const source = Object.fromEntries(["id", "shared_award_id", "url", "title", "page_type"].map(key => [key, profile[key]]));
    for (const acquisition of ["http_html", "rendered_html", "pdf_text", "pdf_ocr"]) {
      await assert.rejects(captureProgramTextSource({ source, acquisition,
        adapters: { fetch: unexpected, browser: unexpected, publisherJson: unexpected } }),
      error => error.code === "program_text_invalid_publisher_json_mode");
    }
    for (const changed of [{ title: source.title + " changed" }, { page_type: "pdf" },
      { url: source.url + "&unreviewed=1" }, { shared_award_id: "11111111-2222-4333-8444-555555555555" }]) {
      await assert.rejects(captureProgramTextSource({ source: { ...source, ...changed }, acquisition: "publisher_json",
        publisher_json_profile: "smart-page-v1", adapters: { publisherJson: unexpected } }),
      error => error.code === "program_text_invalid_publisher_json_mode");
    }
  }
  assert.equal(acquisitions, 0);
});
