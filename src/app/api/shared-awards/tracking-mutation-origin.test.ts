import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/config", () => ({
  hasSupabaseConfig: mocks.hasSupabaseConfig,
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));
vi.mock("@/lib/offices", () => ({
  canManageOffice: vi.fn(),
  requireOfficeContext: vi.fn(),
}));
vi.mock("@/lib/shared-awards", () => ({
  trackSharedAwardForOffice: vi.fn(),
  untrackSharedAwardForOffice: vi.fn(),
  untrackSharedAwardSourceForOffice: vi.fn(),
}));
vi.mock("@/lib/stage1-publication", () => ({
  getStage1PublicationEntryForAward: vi.fn(),
  isStage1SourceIdentityExcluded: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: vi.fn(),
}));

import {
  DELETE as deleteAward,
  POST as trackAward,
} from "./[id]/track/route";
import {
  DELETE as deleteSource,
  POST as trackSource,
} from "./[id]/sources/[sourceId]/track/route";

describe("shared award tracking mutation origin boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["track award", trackAward, { id: "canonical-award" }],
    ["untrack award", deleteAward, { id: "canonical-award" }],
    [
      "track source",
      trackSource,
      { id: "canonical-award", sourceId: "shared-source" },
    ],
    [
      "untrack source",
      deleteSource,
      { id: "canonical-award", sourceId: "shared-source" },
    ],
  ])("rejects cross-origin %s before setup or authentication", async (_label, handler, params) => {
    const response = await handler(
      new Request("https://awardping.test/api/shared-awards/mutate", {
        method: "POST",
        headers: { origin: "https://attacker.test" },
      }),
      { params: Promise.resolve(params) } as never,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "This request is not allowed." });
    expect(mocks.hasSupabaseConfig).not.toHaveBeenCalled();
    expect(mocks.hasSupabaseAdminConfig).not.toHaveBeenCalled();
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });
});
