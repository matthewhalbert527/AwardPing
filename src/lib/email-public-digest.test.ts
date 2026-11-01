import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
  },
}));
vi.mock("@/lib/config", () => ({
  appConfig: {
    alertFromEmail: "AwardPing <updates@example.org>",
    resendApiKey: "test-key",
  },
}));

import {
  renderPublicDailyDigestEmail,
  sendFrozenPublicDailyDigestEmail,
} from "@/lib/email";
import { buildPublicDigestChanges, pendingPublicDigestChangesForSubscriber } from "@/lib/public-updates-core";
import { programChangePresentation } from "@/lib/program-change-presentation";
import { KHS_ALIAS, KHS_CANONICAL, KHS_OLD_EVENT, KHS_NEW_EVENT, khsPublishedEvents, khsPublishedGroup } from "./test-support/published-khs-alias-group";
import type { Stage1PublicationEntry } from "./stage1-publication";

const changes = [
  {
    eventId: "40000000-0000-4000-8000-000000000001",
    awardName: "Test & Fellowship",
    sourceTitle: "Eligibility <current>",
    sourceUrl: "https://example.edu/apply?a=1&b=2",
    summary: "Applicants must be <25.",
    detectedAt: "2026-07-16T18:00:00.000Z",
  },
];

describe("public digest frozen email", () => {
  beforeEach(() => mocks.send.mockReset());

  it("renders the actual approved KHS members together without replaying a previously reserved Iran update", () => {
    const publication = { canonicalAwardId: KHS_CANONICAL, memberAwardIds: [KHS_CANONICAL, KHS_ALIAS] } as Stage1PublicationEntry;
    const events = khsPublishedEvents(publication), reference = khsPublishedGroup();
    const group = { id: reference.group_id, revisionHash: reference.content_hash, memberEventIds: reference.event_ids,
      members: events.map(({ event }) => ({ id: event.id, sourceId: event.shared_award_source_id, sourceTitle: "Eligibility", sourceUrl: event.source_url,
        sourcePageType: event.source_page_type, summary: event.summary, changeDetails: event.change_details, detectedAt: event.detected_at })) };
    const changes = buildPublicDigestChanges(events.map(({ event }) => ({ ...event, shared_award_id: KHS_CANONICAL, group })), new Map([[KHS_CANONICAL, "Knight-Hennessy Scholars"]]), null);
    const before = structuredClone(changes), rendered = renderPublicDailyDigestEmail({ changes, unsubscribeUrl: "https://awardping.org/unsubscribe" });
    expect(rendered.subject).toContain("1 award page update");
    expect(rendered.text).toContain("We encourage citizens and residents of all countries to apply.");
    expect(rendered.text).toContain("Stanford cannot process applications");
    expect(changes.map(change => change.eventId)).toEqual([KHS_NEW_EVENT, KHS_OLD_EVENT]);
    const pending = pendingPublicDigestChangesForSubscriber(changes, "2026-10-01T00:00:00Z", new Set([KHS_OLD_EVENT]));
    const followup = renderPublicDailyDigestEmail({ changes: pending, unsubscribeUrl: "https://awardping.org/unsubscribe" });
    expect(pending.map(change => change.eventId)).toEqual([KHS_NEW_EVENT]);
    expect(followup.text).not.toContain("Stanford cannot process applications");
    expect(changes).toEqual(before); expect(mocks.send).not.toHaveBeenCalled();
  });

  it("groups only current batch display rows while retaining every original event for delivery receipts", () => {
    const first = { ...changes[0], eventId: "first", summary: "The previous eligibility condition changed." };
    const second = { ...changes[0], eventId: "second", sourceTitle: "Application rules", sourceUrl: "https://example.edu/application", summary: "A new application statement is required." };
    const group = { id: "related", revisionHash: "a".repeat(64), memberEventIds: [first.eventId, second.eventId], members: [] };
    const batch = [{ ...first, group }, { ...second, group }];
    const before = structuredClone(batch);
    const rendered = renderPublicDailyDigestEmail({ changes: batch, unsubscribeUrl: "https://awardping.org/unsubscribe" });
    expect(rendered.subject).toContain("1 award page update");
    expect(rendered.text).toContain(first.summary);
    expect(rendered.text).toContain(second.summary);
    expect(rendered.text).toContain(first.sourceUrl);
    expect(rendered.text).toContain(second.sourceUrl);
    expect(batch.map(change => change.eventId)).toEqual(["first", "second"]);
    expect(batch).toEqual(before);

    const pending = pendingPublicDigestChangesForSubscriber(batch, "2026-07-01T00:00:00Z", new Set(["first"]));
    const followup = renderPublicDailyDigestEmail({ changes: pending, unsubscribeUrl: "https://awardping.org/unsubscribe" });
    expect(pending.map(change => change.eventId)).toEqual(["second"]);
    expect(followup.text).toContain(second.summary);
    expect(followup.text).not.toContain(first.summary);
    expect(followup.subject).toContain("1 award page update");
  });

  it("renders one deterministic, escaped payload before enqueue", () => {
    const input = {
      changes,
      unsubscribeUrl: "https://awardping.org/unsubscribe?a=1&b=2",
    };
    const first = renderPublicDailyDigestEmail(input);
    const second = renderPublicDailyDigestEmail(input);

    expect(first).toEqual(second);
    expect(first.from).toBe("AwardPing <updates@example.org>");
    expect(first.subject).toContain("1 award page update");
    expect(first.html).toContain("Test &amp; Fellowship");
    expect(first.html).toContain("Eligibility &lt;current&gt;");
    expect(first.text).toContain("Applicants must be <25.");
  });

  it("sends the frozen fields verbatim with the supplied payload key", async () => {
    mocks.send.mockResolvedValue({ data: { id: "provider-1" }, error: null });
    const rendered = renderPublicDailyDigestEmail({
      changes,
      unsubscribeUrl: "https://awardping.org/unsubscribe",
    });
    await expect(
      sendFrozenPublicDailyDigestEmail({
        ...rendered,
        to: "reader@example.org",
        idempotencyKey: `awardping-public-digest:${"a".repeat(64)}`,
      }),
    ).resolves.toEqual({ providerMessageId: "provider-1" });

    expect(mocks.send).toHaveBeenCalledWith(
      { ...rendered, to: "reader@example.org" },
      { idempotencyKey: `awardping-public-digest:${"a".repeat(64)}` },
    );
  });
  it("renders the approved program comparison and applicant guidance consistently in HTML and plain text", () => {
    const url = "https://funding.example.org/application#programme=2027";
    const details = { schema: "awardping.program-change.v1", event_kind: "program_details_changed",
      summary: "Removed the application portal URL.", program_changes: [{ field: "application_url", operation: "remove",
        summary: "Removed the application portal URL.", previous_quote: { block_id: "source-link-000061",
          start_utf16: 0, end_utf16: url.length, text: url }, current_quote: null }] };
    const presentation = programChangePresentation(details)!;
    const changes = buildPublicDigestChanges([{ id: "event-portal", shared_award_id: "award-a", summary: details.summary,
      source_url: "https://example.edu/award/apply", source_title: "Application instructions", source_page_type: "application",
      change_details: details, detected_at: "2026-10-30T23:03:00.000Z" }], new Map([["award-a", "Example Fellowship"]]));
    const before = structuredClone(changes);
    const rendered = renderPublicDailyDigestEmail({ changes, unsubscribeUrl: "https://awardping.org/unsubscribe" });
    expect(rendered.text).toContain(`${presentation.text}\n${presentation.context}`);
    expect(rendered.html).toContain(presentation.text);
    expect(rendered.html).toContain(presentation.context);
    expect(rendered.text).not.toContain("Removed the application portal URL.");
    expect(changes).toEqual(before);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("escapes applicant guidance before rendering it into HTML", () => {
    const rendered = renderPublicDailyDigestEmail({ changes: [{ ...changes[0], context: "Check A & B <before> applying." }],
      unsubscribeUrl: "https://awardping.org/unsubscribe" });
    expect(rendered.html).toContain("Check A &amp; B &lt;before&gt; applying.");
    expect(rendered.text).toContain("Check A & B <before> applying.");
  });
});
