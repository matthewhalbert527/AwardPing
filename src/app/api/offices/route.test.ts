import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser }));

import { POST } from "./route";

describe("invite-only office creation boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires authentication", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);

    const response = await POST();

    expect(response.status).toBe(401);
  });

  it("does not let an authenticated orphan user create an office", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "orphan-auth-user" });

    const response = await POST();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Self-service office creation is disabled during the invite-only beta.",
    });
  });
});
