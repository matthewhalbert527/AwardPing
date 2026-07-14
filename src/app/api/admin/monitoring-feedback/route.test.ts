import { beforeEach, describe, expect, it, vi } from "vitest";
import { alertBlockingMonitoringPolicyFlagIds } from "@/lib/award-monitoring-policy";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isSiteAdminEmail: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  rpc: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidateTag: mocks.revalidateTag,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.getCurrentUser,
  isSiteAdminEmail: mocks.isSiteAdminEmail,
}));

vi.mock("@/lib/config", () => ({
  hasSupabaseConfig: mocks.hasSupabaseConfig,
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));

import { POST } from "./route";

const requestId = "10000000-0000-4000-8000-000000000001";
const eventId = "20000000-0000-4000-8000-000000000002";
const actorId = "30000000-0000-4000-8000-000000000003";

describe("admin monitoring feedback route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.getCurrentUser.mockResolvedValue({
      id: actorId,
      email: "admin@awardping.test",
    });
    mocks.isSiteAdminEmail.mockReturnValue(true);
    mocks.createSupabaseAdminClient.mockReturnValue({ rpc: mocks.rpc });
  });

  it("requires an authenticated site admin before touching the service role", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);

    const response = await POST(feedbackRequest(validBody()));

    expect(response.status).toBe(401);
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects authenticated users who are not site admins", async () => {
    mocks.isSiteAdminEmail.mockReturnValue(false);

    const response = await POST(feedbackRequest(validBody()));

    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects cross-site mutation requests", async () => {
    const response = await POST(
      feedbackRequest(validBody(), "https://attacker.example"),
    );

    expect(response.status).toBe(403);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([null, "not a valid origin"])(
    "fails closed for a missing or invalid Origin header (%s)",
    async (origin) => {
      const response = await POST(feedbackRequest(validBody(), origin));

      expect(response.status).toBe(403);
      expect(mocks.getCurrentUser).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it("requires context for broader promotion scopes", async () => {
    const response = await POST(
      feedbackRequest(validBody({ requestedScope: "global" })),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/note/i);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects policy IDs that are not active alert-blocking rules", async () => {
    const response = await POST(
      feedbackRequest(validBody({ policyRuleId: "invented_rule" })),
    );

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("uses one atomic RPC and queues novel feedback for review", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          feedback_id: "40000000-0000-4000-8000-000000000004",
          suppressed_event_id: eventId,
          award_id: "50000000-0000-4000-8000-000000000005",
          source_id: null,
          suppressed_at: "2026-07-14T19:00:00.000Z",
          promotion_status: "pending_review",
          recorded_reason_code: "capture_noise",
          recorded_note: null,
          recorded_requested_scope: "event",
          recorded_policy_rule_id: null,
          recorded_event_summary: "The application deadline moved.",
          recorded_event_source_url: "https://example.org/award/deadline",
          recorded_event_source_title: "Award deadline",
          recorded_event_source_page_type: "deadline",
          recorded_event_detected_at: "2026-07-14T18:55:00.000Z",
          recorded_event_evidence: {
            exact_before: "Applications close April 1.",
            exact_after: "Applications close April 15.",
          },
        },
      ],
      error: null,
    });

    const response = await POST(feedbackRequest(validBody()));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      eventId,
      reasonCode: "capture_noise",
      requestedScope: "event",
      policyRuleId: null,
      promotionStatus: "pending_review",
      eventSummary: "The application deadline moved.",
      eventSourceUrl: "https://example.org/award/deadline",
      eventSourceTitle: "Award deadline",
      eventSourcePageType: "deadline",
      eventDetectedAt: "2026-07-14T18:55:00.000Z",
      eventEvidence: {
        exact_before: "Applications close April 1.",
        exact_after: "Applications close April 15.",
      },
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_monitoring_false_positive",
      expect.objectContaining({
        p_request_id: requestId,
        p_event_id: eventId,
        p_actor_user_id: actorId,
        p_actor_email: "admin@awardping.test",
        p_policy_identity: expect.stringContaining("awardping-monitoring-policy@"),
        p_policy_version: expect.stringMatching(/^policy-\d+\.memory-\d+$/),
        p_policy_hash: expect.stringMatching(/^fnv1a32x2-utf16:/),
        p_policy_rule_id: null,
      }),
    );
    expect(mocks.revalidateTag).toHaveBeenCalledWith(
      "award-directory-shared-catalog",
      { expire: 0 },
    );
  });

  it("allows only a known active rule to mark feedback already covered", async () => {
    const policyRuleId = alertBlockingMonitoringPolicyFlagIds[0];
    expect(policyRuleId).toBeTruthy();
    mocks.rpc.mockResolvedValue({
      data: [
        {
          feedback_id: "40000000-0000-4000-8000-000000000004",
          suppressed_event_id: eventId,
          award_id: "50000000-0000-4000-8000-000000000005",
          source_id: null,
          suppressed_at: "2026-07-14T19:00:00.000Z",
          promotion_status: "already_active",
          recorded_reason_code: "capture_noise",
          recorded_note: null,
          recorded_requested_scope: "event",
          recorded_policy_rule_id: policyRuleId,
        },
      ],
      error: null,
    });

    const response = await POST(
      feedbackRequest(validBody({ policyRuleId })),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.promotionStatus).toBe("already_active");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_monitoring_false_positive",
      expect.objectContaining({ p_policy_rule_id: policyRuleId }),
    );
  });

  it("stores an accepted policy alias as its stable canonical rule ID", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          feedback_id: "40000000-0000-4000-8000-000000000004",
          suppressed_event_id: eventId,
          award_id: "50000000-0000-4000-8000-000000000005",
          source_id: null,
          suppressed_at: "2026-07-14T19:00:00.000Z",
          promotion_status: "already_active",
          recorded_reason_code: "capture_noise",
          recorded_note: null,
          recorded_requested_scope: "event",
          recorded_policy_rule_id: "fundraising_form_change",
        },
      ],
      error: null,
    });

    const response = await POST(
      feedbackRequest(validBody({ policyRuleId: "donation_prompt" })),
    );

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_monitoring_false_positive",
      expect.objectContaining({ p_policy_rule_id: "fundraising_form_change" }),
    );
  });

  it("returns not found when the atomic transaction cannot find the event", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "monitoring event was not found" },
    });

    const response = await POST(feedbackRequest(validBody()));

    expect(response.status).toBe(404);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });
});

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    requestId,
    eventId,
    reasonCode: "capture_noise",
    requestedScope: "event",
    ...overrides,
  };
}

function feedbackRequest(
  body: Record<string, unknown>,
  origin: string | null = "https://awardping.test",
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (origin !== null) headers.set("origin", origin);

  return new Request("https://awardping.test/api/admin/monitoring-feedback", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
