import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mode: "domain" as "domain" | "unexpected",
  providerMode: "ok" as "ok" | "domain" | "unexpected",
  effects: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/admin-request-security", () => ({
  validateSameOriginAdminMutation: vi.fn(() => null),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(async () => ({ email: "admin@awardping.com" })),
  isSiteAdminEmail: vi.fn(() => true),
}));

vi.mock("@/lib/config", () => ({
  hasSupabaseAdminConfig: vi.fn(() => true),
  hasSupabaseConfig: vi.fn(() => true),
}));

vi.mock("@/lib/source-intake-provider-binding.server", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/source-intake-provider-binding.server")
  >();
  return {
    ...actual,
    verifySourceIntakeProviderBindingForAdminApproval: vi.fn(() => {
      if (state.providerMode === "domain") {
        throw new actual.SourceIntakeProviderBindingValidationError(
          "The retained provider binding is stale.",
        );
      }
      if (state.providerMode === "unexpected") {
        throw new Error("unexpected verifier defect");
      }
      return { ok: true };
    }),
  };
});

vi.mock("@/lib/source-intake-operator-actions", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/source-intake-operator-actions")
  >();
  return {
    ...actual,
    sourceIntakeActionAllowedWithContext: vi.fn(() => true),
    sourceIntakeProtectedRecovery: vi.fn(() => ({
      protected: false,
      mode: "ordinary",
      explanation: "",
      apiCharge: "none",
      refetchesPage: false,
      runsAiReview: false,
    })),
    sourceIntakeBackfillApprovalPatch: vi.fn(() => {
      if (state.mode === "domain") {
        throw new actual.SourceIntakeOperatorValidationError(
          "The selected award does not match the award sealed into the discovery evidence.",
          409,
        );
      }
      throw new TypeError("unexpected implementation defect");
    }),
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: vi.fn(() => ({
    from: (table: string) => {
      let updating = false;
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        update: vi.fn((payload: unknown) => {
          updating = true;
          state.effects.push({ type: "update", table, payload });
          return builder;
        }),
        maybeSingle: vi.fn(async () => ({
          data: updating
            ? { id: "request-id" }
            : {
                id: "11111111-1111-4111-8111-111111111111",
                award_name: "Example Award",
                homepage_url: "https://example.org/",
                notes: null,
                intake_type: "award_page",
                submitted_url: "https://example.org/apply",
                normalized_url: "https://example.org/apply",
                status: "needs_manual_review",
                status_reason:
                  "low_coverage_backfill_reviewed_manual_source_activation_required",
                ai_review: {},
                deterministic_review: {},
                capture_metadata: {},
                acquisition_kind: "admin_intake",
                notification_mode: "manual_review",
                onboarding_batch_id: "low-coverage-source-backfill-v1",
                matched_shared_award_id:
                  "22222222-2222-4222-8222-222222222222",
                updated_at: "2026-07-17T12:00:00.000Z",
              },
          error: null,
        })),
      };
      return builder;
    },
  })),
}));

import { PATCH } from "./route";

const request = () =>
  new Request(
    "https://awardping.com/api/admin/source-intake/11111111-1111-4111-8111-111111111111",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "approve_backfill_source",
        sharedAwardId: "33333333-3333-4333-8333-333333333333",
      }),
    },
  );

const context = {
  params: Promise.resolve({
    id: "11111111-1111-4111-8111-111111111111",
  }),
};

describe("admin source-intake approval validation", () => {
  beforeEach(() => {
    state.mode = "domain";
    state.providerMode = "ok";
    state.effects.length = 0;
  });

  it("returns a structured 409 for a normal sealed-evidence conflict", async () => {
    const response = await PATCH(request(), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error:
        "The selected award does not match the award sealed into the discovery evidence.",
    });
    expect(state.effects).toEqual([]);
  });

  it("keeps an unexpected implementation error as a non-disclosing 500", async () => {
    state.mode = "unexpected";

    const response = await PATCH(request(), context);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "The source-intake action could not be applied.",
    });
    expect(state.effects).toEqual([]);
  });

  it("returns 409 for normal stale-binding validation but 500 for verifier defects", async () => {
    state.providerMode = "domain";

    const validationResponse = await PATCH(request(), context);
    expect(validationResponse.status).toBe(409);
    expect(await validationResponse.json()).toEqual({
      ok: false,
      error: "The retained provider binding is stale.",
    });

    state.providerMode = "unexpected";
    const unexpectedResponse = await PATCH(request(), context);
    expect(unexpectedResponse.status).toBe(500);
    expect(await unexpectedResponse.json()).toEqual({
      ok: false,
      error: "The source-intake evidence binding could not be verified.",
    });
    expect(state.effects).toEqual([]);
  });
});
