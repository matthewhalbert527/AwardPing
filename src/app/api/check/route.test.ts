import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasSupabaseAdminConfig: vi.fn(),
  fetchExtractedContent: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));
vi.mock("@/lib/extract", () => ({
  fetchExtractedContent: mocks.fetchExtractedContent,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));

import { POST } from "./route";

const attemptId = "11111111-1111-4111-8111-111111111111";
const allowedReservation = {
  attempt_id: attemptId,
  allowed: true,
  retry_after_seconds: 1200,
  effective_limit: 10,
  window_started_at: "2026-07-16T21:00:00.000Z",
};

describe("POST /api/check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.FREE_CHECK_HOURLY_IP_LIMIT;
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "reserve_free_check_attempt"
        ? { data: [allowedReservation], error: null }
        : { data: true, error: null },
    );
    mocks.createSupabaseAdminClient.mockReturnValue({
      rpc: mocks.rpc,
    });
    mocks.fetchExtractedContent.mockResolvedValue({
      url: "https://example.org/final",
      hash: "content-hash",
      sample: "Example content",
      contentType: "text/html",
      byteLength: 15,
    });
  });

  it("fails closed with a generic 503 when admin configuration is missing", async () => {
    mocks.hasSupabaseAdminConfig.mockReturnValue(false);

    const response = await POST(requestFor("https://example.org"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "The checker is temporarily unavailable.",
    });
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mocks.fetchExtractedContent).not.toHaveBeenCalled();
  });

  it("rejects invalid input before reserving or fetching", async () => {
    const response = await POST(requestFor("not a URL"));

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.fetchExtractedContent).not.toHaveBeenCalled();
  });

  it("fails closed when the reservation RPC is unavailable or malformed", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "offline" } });
    const unavailable = await POST(requestFor("https://example.org"));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      ok: false,
      error: "The checker is temporarily unavailable.",
    });
    expect(mocks.fetchExtractedContent).not.toHaveBeenCalled();

    mocks.rpc.mockResolvedValue({ data: [{ allowed: true }], error: null });
    const malformed = await POST(requestFor("https://example.org"));
    expect(malformed.status).toBe(503);
    expect(mocks.fetchExtractedContent).not.toHaveBeenCalled();
  });

  it("fails closed when the configured admin client cannot be created", async () => {
    mocks.createSupabaseAdminClient.mockImplementation(() => {
      throw new Error("bad configuration");
    });

    const response = await POST(requestFor("https://example.org"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "The checker is temporarily unavailable.",
    });
    expect(mocks.fetchExtractedContent).not.toHaveBeenCalled();
  });

  it("returns a generic 429 and never fetches when the atomic reservation denies", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ ...allowedReservation, allowed: false }],
      error: null,
    });

    const response = await POST(requestFor("https://example.org"));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1200");
    expect(await response.json()).toEqual({
      ok: false,
      error: "Too many checks. Try again later.",
    });
    expect(mocks.fetchExtractedContent).not.toHaveBeenCalled();
  });

  it("reserves before fetching and records a successful outcome", async () => {
    const response = await POST(requestFor("https://example.org/path"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      hash: "content-hash",
      sample: "Example content",
      contentType: "text/html",
      byteLength: 15,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("reserve_free_check_attempt", {
      p_ip_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      p_url_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      p_requested_host: "example.org",
      p_limit: 10,
    });
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fetchExtractedContent.mock.invocationCallOrder[0],
    );
    expect(mocks.rpc).toHaveBeenCalledWith("complete_free_check_attempt", {
      p_attempt_id: attemptId,
      p_outcome: "succeeded",
      p_failure_kind: null,
    });
  });

  it("preserves safe fetch rejection details and records the failed attempt", async () => {
    mocks.fetchExtractedContent.mockRejectedValue(
      new Error("Only public HTTP and HTTPS URLs can be checked."),
    );

    const response = await POST(requestFor("http://127.0.0.1/private"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Only public HTTP and HTTPS URLs can be checked.",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("complete_free_check_attempt", {
      p_attempt_id: attemptId,
      p_outcome: "failed",
      p_failure_kind: "fetch_failed",
    });
  });

  it("returns a generic 503 when the terminal audit update fails", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "reserve_free_check_attempt"
        ? { data: [allowedReservation], error: null }
        : { data: null, error: { message: "write failed" } },
    );

    const response = await POST(requestFor("https://example.org"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "The checker is temporarily unavailable.",
    });
  });

  it("fails closed when no reserved audit row accepts the terminal update", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "reserve_free_check_attempt"
        ? { data: [allowedReservation], error: null }
        : { data: false, error: null },
    );

    const response = await POST(requestFor("https://example.org"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "The checker is temporarily unavailable.",
    });
  });
});

function requestFor(url: string) {
  return new NextRequest("https://awardping.test/api/check", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vercel-forwarded-for": "203.0.113.8",
    },
    body: JSON.stringify({ url }),
  });
}
