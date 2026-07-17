import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  rpc: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  signInWithPassword: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
  hasSupabaseConfig: mocks.hasSupabaseConfig,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));

import { POST } from "./route";

const genericError = {
  ok: false,
  error: "We could not create an account with that invitation.",
};

describe("invite-only signup route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.createSupabaseAdminClient.mockReturnValue({
      rpc: mocks.rpc,
      auth: {
        admin: {
          createUser: mocks.createUser,
          deleteUser: mocks.deleteUser,
        },
      },
    });
    mocks.createSupabaseServerClient.mockResolvedValue({
      auth: { signInWithPassword: mocks.signInWithPassword },
    });
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "reserve_office_invite_signup") {
        return Promise.resolve({
          data: [
            {
              invite_id: "11111111-1111-4111-8111-111111111111",
              office_id: "22222222-2222-4222-8222-222222222222",
              normalized_email: "advisor@example.edu",
              reservation_id: "33333333-3333-4333-8333-333333333333",
            },
          ],
          error: null,
        });
      }
      if (name === "complete_office_invite_signup") {
        return Promise.resolve({
          data: [{ office_id: "22222222-2222-4222-8222-222222222222" }],
          error: null,
        });
      }
      if (name === "reconcile_office_invite_signup_auth_user") {
        return Promise.resolve({ data: [], error: null });
      }
      if (name === "release_office_invite_signup_reservation") {
        return Promise.resolve({ data: true, error: null });
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    mocks.createUser.mockResolvedValue({
      data: { user: { id: "44444444-4444-4444-8444-444444444444" } },
      error: null,
    });
    mocks.deleteUser.mockResolvedValue({ data: {}, error: null });
    mocks.signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
  });

  it("rejects malformed requests before touching the service-role client", async () => {
    const response = await signupRequest({ inviteToken: "short", password: "123" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(genericError);
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects cross-origin account creation before reserving an invite", async () => {
    const response = await signupRequest(validBody(), "https://evil.test");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(genericError);
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("reserves, creates, atomically completes, and signs in an invited account", async () => {
    const response = await signupRequest({
      inviteToken: "A1B2C3D4E5",
      password: "a secure beta password",
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, signedIn: true });
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "reserve_office_invite_signup", {
      p_invite_secret: "A1B2C3D4E5",
    });
    expect(mocks.createUser).toHaveBeenCalledWith({
      email: "advisor@example.edu",
      password: "a secure beta password",
      email_confirm: true,
      user_metadata: {
        awardping_invite_id: "11111111-1111-4111-8111-111111111111",
        awardping_invite_reservation_id: "33333333-3333-4333-8333-333333333333",
      },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "complete_office_invite_signup", {
      p_invite_id: "11111111-1111-4111-8111-111111111111",
      p_normalized_email: "advisor@example.edu",
      p_reservation_id: "33333333-3333-4333-8333-333333333333",
      p_user_id: "44444444-4444-4444-8444-444444444444",
    });
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({
      email: "advisor@example.edu",
      password: "a secure beta password",
    });
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it.each([
    { data: [], error: null },
    { data: null, error: { message: "database unavailable" } },
  ])("returns the same generic response when reservation fails", async (reservation) => {
    mocks.rpc.mockResolvedValueOnce(reservation);

    const response = await signupRequest(validBody());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(genericError);
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it("preserves a reservation when Auth creation fails before reconciliation can prove the outcome", async () => {
    mocks.createUser.mockResolvedValue({
      data: { user: null },
      error: { message: "A user with this email already exists" },
    });

    const response = await signupRequest(validBody());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(genericError);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "release_office_invite_signup_reservation",
      expect.anything(),
    );
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it("resumes after Auth creation commits but its response is lost", async () => {
    mocks.createUser.mockRejectedValueOnce(new Error("response lost"));
    const defaultImplementation = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation((name: string, args: unknown) => {
      if (name === "reconcile_office_invite_signup_auth_user") {
        return Promise.resolve({
          data: [{ user_id: "44444444-4444-4444-8444-444444444444" }],
          error: null,
        });
      }
      return defaultImplementation?.(name, args);
    });

    const response = await signupRequest(validBody());

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, signedIn: true });
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "reconcile_office_invite_signup_auth_user",
      {
        p_invite_id: "11111111-1111-4111-8111-111111111111",
        p_normalized_email: "advisor@example.edu",
        p_reservation_id: "33333333-3333-4333-8333-333333333333",
      },
    );
  });

  it("preserves the reservation when Auth creation cannot be reconciled", async () => {
    mocks.createUser.mockRejectedValueOnce(new Error("response lost"));
    const defaultImplementation = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation((name: string, args: unknown) => {
      if (name === "reconcile_office_invite_signup_auth_user") {
        return Promise.resolve({ data: null, error: { message: "database unavailable" } });
      }
      return defaultImplementation?.(name, args);
    });

    const response = await signupRequest(validBody());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(genericError);
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "release_office_invite_signup_reservation",
      expect.anything(),
    );
  });

  it("resumes a preserved reservation when a later retry finds the tagged Auth user", async () => {
    mocks.createUser.mockRejectedValue(new Error("response lost"));
    const defaultImplementation = mocks.rpc.getMockImplementation();
    let reconciliations = 0;
    mocks.rpc.mockImplementation((name: string, args: unknown) => {
      if (name === "reconcile_office_invite_signup_auth_user") {
        reconciliations += 1;
        return Promise.resolve(reconciliations === 1
          ? { data: [], error: null }
          : {
              data: [{ user_id: "44444444-4444-4444-8444-444444444444" }],
              error: null,
            });
      }
      return defaultImplementation?.(name, args);
    });

    const first = await signupRequest(validBody());
    const second = await signupRequest(validBody());

    expect(first.status).toBe(503);
    expect(second.status).toBe(201);
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it("deletes the newly created Auth user and releases after completion fails", async () => {
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "reserve_office_invite_signup") {
        return Promise.resolve({
          data: [
            {
              invite_id: "11111111-1111-4111-8111-111111111111",
              office_id: "22222222-2222-4222-8222-222222222222",
              normalized_email: "advisor@example.edu",
              reservation_id: "33333333-3333-4333-8333-333333333333",
            },
          ],
          error: null,
        });
      }
      if (name === "complete_office_invite_signup") {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: true, error: null });
    });

    const response = await signupRequest(validBody());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(genericError);
    expect(mocks.deleteUser).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
    );
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "release_office_invite_signup_reservation",
      {
        p_invite_id: "11111111-1111-4111-8111-111111111111",
        p_reservation_id: "33333333-3333-4333-8333-333333333333",
      },
    );
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it("reconciles a lost completion response without deleting the completed account", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: [
          {
            invite_id: "11111111-1111-4111-8111-111111111111",
            office_id: "22222222-2222-4222-8222-222222222222",
            normalized_email: "advisor@example.edu",
            reservation_id: "33333333-3333-4333-8333-333333333333",
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: { message: "response lost" } })
      .mockResolvedValueOnce({
        data: [{ office_id: "22222222-2222-4222-8222-222222222222" }],
        error: null,
      });

    const response = await signupRequest(validBody());

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, signedIn: true });
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });

  it("preserves an account when completion remains ambiguous", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: [
          {
            invite_id: "11111111-1111-4111-8111-111111111111",
            office_id: "22222222-2222-4222-8222-222222222222",
            normalized_email: "advisor@example.edu",
            reservation_id: "33333333-3333-4333-8333-333333333333",
          },
        ],
        error: null,
      })
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockRejectedValueOnce(new Error("network unavailable"));

    const response = await signupRequest(validBody());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(genericError);
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it("keeps the reservation when compensating Auth deletion fails", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [
        {
          invite_id: "11111111-1111-4111-8111-111111111111",
          office_id: "22222222-2222-4222-8222-222222222222",
          normalized_email: "advisor@example.edu",
          reservation_id: "33333333-3333-4333-8333-333333333333",
        },
      ],
      error: null,
    });
    mocks.rpc.mockResolvedValueOnce({ data: [], error: { message: "completion failed" } });
    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });
    mocks.deleteUser.mockResolvedValue({ data: {}, error: { message: "deletion failed" } });

    const response = await signupRequest(validBody());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(genericError);
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });

  it("does not undo a completed account if automatic sign-in fails", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { message: "temporary auth error" },
    });

    const response = await signupRequest(validBody());

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, signedIn: false });
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });
});

function validBody() {
  return {
    inviteToken: "A1B2C3D4E5",
    password: "a secure beta password",
  };
}

function signupRequest(body: unknown, origin = "https://awardping.test") {
  return POST(
    new Request("https://awardping.test/api/auth/invite-signup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify(body),
    }),
  );
}
