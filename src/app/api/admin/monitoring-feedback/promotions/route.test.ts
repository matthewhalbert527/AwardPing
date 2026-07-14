import { beforeEach, describe, expect, it, vi } from "vitest";
import { alertBlockingMonitoringPolicyFlagIds } from "@/lib/award-monitoring-policy";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isSiteAdminEmail: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  rpc: vi.fn(),
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

const requestId = "60000000-0000-4000-8000-000000000006";
const feedbackId = "70000000-0000-4000-8000-000000000007";
const actorId = "80000000-0000-4000-8000-000000000008";

describe("admin monitoring feedback promotion route", () => {
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

  it("requires a site admin", async () => {
    mocks.isSiteAdminEmail.mockReturnValue(false);

    const response = await POST(promotionRequest(validBody()));

    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([null, "not a valid origin"])(
    "fails closed for a missing or invalid Origin header (%s)",
    async (origin) => {
      const response = await POST(promotionRequest(validBody(), origin));

      expect(response.status).toBe(403);
      expect(mocks.getCurrentUser).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it("rejects a resolution rule that is not active and alert-blocking", async () => {
    const response = await POST(
      promotionRequest(validBody({ policyRuleId: "not_a_live_rule" })),
    );

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("appends a resolution under the current policy identity", async () => {
    const policyRuleId = alertBlockingMonitoringPolicyFlagIds[0];
    mocks.rpc.mockResolvedValue({
      data: [
        {
          promotion_id: "90000000-0000-4000-8000-000000000009",
          promoted_feedback_id: feedbackId,
          active_policy_rule_id: policyRuleId,
          promoted_at: "2026-07-14T19:10:00.000Z",
        },
      ],
      error: null,
    });

    const response = await POST(promotionRequest(validBody({ policyRuleId })));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      feedbackId,
      policyRuleId,
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_monitoring_feedback_promotion",
      expect.objectContaining({
        p_request_id: requestId,
        p_feedback_id: feedbackId,
        p_actor_user_id: actorId,
        p_policy_rule_id: policyRuleId,
        p_policy_identity: expect.stringContaining("awardping-monitoring-policy@"),
        p_policy_version: expect.stringMatching(/^policy-\d+\.memory-\d+$/),
        p_policy_hash: expect.stringMatching(/^fnv1a32x2-utf16:/),
      }),
    );
  });

  it("stores an accepted policy alias as its stable canonical rule ID", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        {
          promotion_id: "90000000-0000-4000-8000-000000000009",
          promoted_feedback_id: feedbackId,
          active_policy_rule_id: "fundraising_form_change",
          promoted_at: "2026-07-14T19:10:00.000Z",
        },
      ],
      error: null,
    });

    const response = await POST(
      promotionRequest(validBody({ policyRuleId: "donation_prompt" })),
    );

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_monitoring_feedback_promotion",
      expect.objectContaining({ p_policy_rule_id: "fundraising_form_change" }),
    );
  });

  it("reports an already-resolved race as a conflict", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "monitoring feedback is already promoted" },
    });

    const response = await POST(promotionRequest(validBody()));

    expect(response.status).toBe(409);
  });
});

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    requestId,
    feedbackId,
    policyRuleId: alertBlockingMonitoringPolicyFlagIds[0],
    ...overrides,
  };
}

function promotionRequest(
  body: Record<string, unknown>,
  origin: string | null = "https://awardping.test",
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (origin !== null) headers.set("origin", origin);

  return new Request(
    "https://awardping.test/api/admin/monitoring-feedback/promotions",
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
}
