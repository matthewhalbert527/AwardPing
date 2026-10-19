import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSourceIntakePanel, type SourceIntakeRequestView } from "@/components/admin-source-intake-panel";

const request: SourceIntakeRequestView = {
  id: "11111111-1111-4111-8111-111111111111",
  award_name: "Synthetic timezone fixture",
  homepage_url: "https://example.org/award",
  normalized_url: "https://example.org/award",
  intake_type: "official_source",
  status: "needs_manual_review",
  status_reason: "missing_evidence_quotes",
  detected_award_name: null,
  detected_sponsor: null,
  matched_shared_award_id: null,
  created_shared_award_id: null,
  created_source_ids: null,
  ai_review: {},
  capture_metadata: {},
  acquisition_kind: "admin_intake",
  notification_mode: "baseline_only",
  onboarding_batch_id: null,
  deterministic_review: {},
  error: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-10-19T18:15:16.360Z",
  processed_at: null,
};

function initialRender(hostTimeZone: string, updatedAt: string) {
  vi.stubEnv("TZ", hostTimeZone);
  expect(new Intl.DateTimeFormat("en-US").resolvedOptions().timeZone).toBe(hostTimeZone);
  const html = renderToStaticMarkup(createElement(AdminSourceIntakePanel, {
    initialRequests: [{ ...request, updated_at: updatedAt }],
    awardOptions: [],
  }));
  const $ = load(html);
  return {
    html,
    updated: $("dt").filter((_, element) => $(element).text() === "Updated").next("dd").text(),
    // The old host-local formatter really differs in these two environments.
    hostHour: new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(updatedAt)),
  };
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected_action_or_network_call"); })));
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("source-intake Updated label uses the same timezone in both initial renders", () => {
  it.each([
    ["daylight time", "2026-10-19T18:15:16.360Z", "Oct 19, 2026, 1:15 PM CDT"],
    ["standard time", "2026-01-08T15:30:00.000Z", "Jan 8, 2026, 9:30 AM CST"],
    ["Central calendar-day rollover", "2026-07-08T04:30:00.000Z", "Jul 7, 2026, 11:30 PM CDT"],
  ])("keeps %s identical under UTC server and Central client host timezones", (_case, timestamp, expected) => {
    // Same component/props, different host environments: an initial-render
    // parity regression, not a browser hydration or action-dispatch test.
    const server = initialRender("UTC", timestamp);
    const client = initialRender("America/Chicago", timestamp);
    expect(server.hostHour).not.toBe(client.hostHour);
    expect(server.updated).toBe(expected);
    expect(client.updated).toBe(expected);
    expect(server.html).toBe(client.html);
  });
});
