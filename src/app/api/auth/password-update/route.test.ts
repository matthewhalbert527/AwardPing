import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getUser: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  hasSupabaseConfig: mocks.hasSupabaseConfig,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));

import { POST } from "./route";

const validPassword = "correct horse battery staple";

describe("password recovery update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    });
    mocks.updateUser.mockResolvedValue({ data: { user: {} }, error: null });
    mocks.createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: mocks.getUser,
        updateUser: mocks.updateUser,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("server-validates the session before updating the password", async () => {
    const response = await POST(updateRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getUser).toHaveBeenCalledOnce();
    expect(mocks.updateUser).toHaveBeenCalledWith({
      password: validPassword,
    });
    expect(mocks.getUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateUser.mock.invocationCallOrder[0],
    );
  });

  it("rejects an invalid or expired server-side session", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "invalid session" },
    });

    const response = await POST(updateRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error:
        "This password-reset session is invalid or expired. Request a new link.",
    });
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it.each([
    { password: "too short", confirmation: "too short" },
    { password: validPassword, confirmation: `${validPassword}!` },
    { password: validPassword, confirmation: validPassword, extra: true },
  ])("rejects an invalid password payload: %o", async (body) => {
    const response = await POST(updateRequest(body));

    expect(response.status).toBe(400);
    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("rejects cross-origin updates before reading the session", async () => {
    const response = await POST(
      updateRequest(undefined, "https://attacker.example"),
    );

    expect(response.status).toBe(403);
    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("does not report success when Supabase rejects the password change", async () => {
    mocks.updateUser.mockResolvedValue({
      data: { user: null },
      error: { code: "weak_password", message: "Password is too weak" },
    });

    const response = await POST(updateRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error:
        "The password could not be updated. Request a new reset link and try again.",
    });
  });

  it("fails closed when server-side session validation is unavailable", async () => {
    mocks.getUser.mockRejectedValue(new Error("Auth service unavailable"));

    const response = await POST(updateRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Password recovery is temporarily unavailable.",
    });
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});

function updateRequest(
  body: unknown = {
    password: validPassword,
    confirmation: validPassword,
  },
  origin = "https://awardping.test",
) {
  return new Request("https://awardping.test/api/auth/password-update", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify(body),
  });
}
