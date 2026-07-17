import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/config", () => ({
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
  hasSupabaseConfig: mocks.hasSupabaseConfig,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));

import { GET } from "./route";

describe("office search authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.hasSupabaseConfig.mockReturnValue(true);
  });

  it("does not disclose office IDs to an unauthenticated caller", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);

    const response = await GET(
      new Request("https://awardping.test/api/offices/search?query=awards"),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      offices: [],
      error: "Authentication required.",
    });
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("retains search for an authenticated account", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
    const builder = queryBuilder({
      data: [{ id: "office-1", name: "Awards Office", organization_id: null }],
      error: null,
    });
    mocks.createSupabaseAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue(builder),
    });

    const response = await GET(
      new Request("https://awardping.test/api/offices/search?query=awards"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      offices: [
        {
          id: "office-1",
          name: "Awards Office",
          officeName: "Awards Office",
          organizationId: null,
          organizationName: null,
        },
      ],
    });
  });
});

function queryBuilder(result: unknown) {
  const builder: Record<string, unknown> & PromiseLike<unknown> = {
    then(onFulfilled, onRejected) {
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
  for (const method of ["select", "neq", "order", "limit", "ilike", "eq"]) {
    builder[method] = vi.fn().mockReturnValue(builder);
  }
  return builder;
}
