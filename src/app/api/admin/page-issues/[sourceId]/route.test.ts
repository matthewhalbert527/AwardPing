import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chains: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  createSupabaseAdminClient: vi.fn(),
  from: vi.fn(),
  getCurrentUser: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  isSiteAdminEmail: vi.fn(),
  results: [] as Array<unknown>,
  updatePayload: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.getCurrentUser,
  isSiteAdminEmail: mocks.isSiteAdminEmail,
}));
vi.mock("@/lib/config", () => ({
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
  hasSupabaseConfig: mocks.hasSupabaseConfig,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));

import { PATCH } from "@/app/api/admin/page-issues/[sourceId]/route";

const sourceId = "30000000-0000-4000-8000-000000000003";

describe("admin page-issue monitoring restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chains.length = 0;
    mocks.results.length = 0;
    mocks.updatePayload = null;
    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.getCurrentUser.mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000001",
      email: "operator@example.edu",
    });
    mocks.isSiteAdminEmail.mockReturnValue(true);
    mocks.from.mockImplementation(() => query(mocks.results.shift()));
    mocks.createSupabaseAdminClient.mockReturnValue({ from: mocks.from });
  });

  it("restores only an AI-unclear source and returns its actual monitoring decision", async () => {
    const source = reviewLaterSource();
    mocks.results.push(
      { data: source, error: null },
      () => ({ data: { ...source, ...mocks.updatePayload }, error: null }),
    );

    const response = await PATCH(restoreRequest(), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      action: "restore",
      monitoring: {
        allowed: true,
        reason: "operator_review_restored_ai_unclear_monitoring_only",
      },
      publicFactsApproved: false,
      publicUpdatesApproved: false,
    });
    expect(mocks.updatePayload).toMatchObject({
      admin_review_status: "open",
      admin_review_note: expect.stringContaining("monitoring_restore_v1"),
      admin_reviewed_by: "operator@example.edu",
    });
    const mutation = mocks.chains[1];
    expect(mutation.eq).toHaveBeenCalledWith("admin_review_status", "review_later");
    expect(mutation.eq).toHaveBeenCalledWith("updated_at", source.updated_at);
    expect(mutation.eq).toHaveBeenCalledWith("admin_reviewed_at", source.admin_reviewed_at);
    expect(mutation.eq).toHaveBeenCalledWith("admin_review_note", source.admin_review_note);
    expect(mutation.eq).toHaveBeenCalledWith("admin_reviewed_by", source.admin_reviewed_by);
  });

  it("keeps hard-rejected sources excluded instead of claiming monitoring resumed", async () => {
    mocks.results.push({
      data: reviewLaterSource({
        page_metadata: {
          baseline_facts: {
            award_relevance: "unrelated",
            cycle_relevance: "current_or_upcoming",
            confidence: "high",
            evidence_quotes: ["A different award."],
          },
        },
      }),
      error: null,
    });

    const response = await PATCH(restoreRequest(), routeContext());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      monitoring: { allowed: false },
      aiReviewStatus: "reviewed_rejected_unrelated",
    });
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.updatePayload).toBeNull();
  });

  it("keeps AI-unclear sources excluded when a non-AI source check fails", async () => {
    mocks.results.push({
      data: reviewLaterSource({ url: "https://example.edu/award/application.docx" }),
      error: null,
    });

    const response = await PATCH(restoreRequest(), routeContext());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      aiReviewStatus: "reviewed_unclear_needs_manual_review",
      monitoring: { allowed: false, reason: "url_not_monitorable" },
    });
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the review marker or timestamp changes before update", async () => {
    mocks.results.push(
      { data: reviewLaterSource(), error: null },
      { data: null, error: null },
    );

    const response = await PATCH(restoreRequest(), routeContext());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("changed after the page loaded"),
    });
  });
});

function reviewLaterSource(overrides: Record<string, unknown> = {}) {
  return {
    id: sourceId,
    shared_award_id: "award-1",
    url: "https://example.edu/award/faq",
    title: "FAQ",
    display_title: "Frequently asked questions",
    page_description: null,
    page_metadata: {
      baseline_facts: {
        award_relevance: "primary",
        cycle_relevance: "unclear",
        confidence: "medium",
        evidence_quotes: ["Official FAQ wording."],
      },
    },
    page_metadata_generated_at: "2026-07-09T00:00:00.000Z",
    page_metadata_model: "gemini-test",
    page_type: "faq",
    source: "seed",
    reason: null,
    submitted_by_user_id: null,
    admin_review_status: "review_later",
    admin_review_note: "AI review requires operator judgment.",
    admin_reviewed_at: "2026-07-10T00:00:00.000Z",
    admin_reviewed_by: "awardping-worker",
    last_checked_at: "2026-07-09T00:00:00.000Z",
    last_error: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function restoreRequest() {
  return new Request(`https://awardping.test/api/admin/page-issues/${sourceId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "restore" }),
  });
}

function routeContext() {
  return { params: Promise.resolve({ sourceId }) };
}

function query(result: unknown) {
  const chain = {
    eq: vi.fn(),
    is: vi.fn(),
    maybeSingle: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  };
  chain.eq.mockReturnValue(chain);
  chain.is.mockReturnValue(chain);
  chain.select.mockReturnValue(chain);
  chain.update.mockImplementation((payload: Record<string, unknown>) => {
    mocks.updatePayload = payload;
    return chain;
  });
  chain.maybeSingle.mockImplementation(() =>
    Promise.resolve(typeof result === "function" ? result() : result),
  );
  mocks.chains.push(chain);
  return chain;
}
