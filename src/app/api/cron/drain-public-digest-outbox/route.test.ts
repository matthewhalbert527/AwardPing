import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  hasPublicUpdateTokenConfig: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  startJobRun: vi.fn(),
  finishJobRun: vi.fn(),
  drainPublicDigestOutbox: vi.fn(),
  drainPublicUpdateConfirmationOutbox: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  appConfig: { cronSecret: "awardping-local-public-update-token" },
  hasPublicUpdateTokenConfig: mocks.hasPublicUpdateTokenConfig,
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));
vi.mock("@/lib/job-runs", () => ({
  errorMessage: (error: unknown) => String(error),
  finishJobRun: mocks.finishJobRun,
  startJobRun: mocks.startJobRun,
}));
vi.mock("@/lib/public-updates", () => ({
  drainPublicDigestOutbox: mocks.drainPublicDigestOutbox,
  drainPublicUpdateConfirmationOutbox:
    mocks.drainPublicUpdateConfirmationOutbox,
}));

import { GET } from "@/app/api/cron/drain-public-digest-outbox/route";

describe("public email outbox cron authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
  });

  it("rejects the source-known fallback even when its header matches", async () => {
    mocks.hasPublicUpdateTokenConfig.mockReturnValue(false);
    const response = await GET(request("awardping-local-public-update-token"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized." });
    expect(mocks.startJobRun).not.toHaveBeenCalled();
    expect(mocks.drainPublicUpdateConfirmationOutbox).not.toHaveBeenCalled();
    expect(mocks.drainPublicDigestOutbox).not.toHaveBeenCalled();
  });

  it("retains exact header comparison after the strict configuration gate", async () => {
    mocks.hasPublicUpdateTokenConfig.mockReturnValue(true);
    const response = await GET(request("wrong-secret"));

    expect(response.status).toBe(401);
    expect(mocks.startJobRun).not.toHaveBeenCalled();
  });
});

function request(secret: string) {
  return new NextRequest(
    "https://awardping.test/api/cron/drain-public-digest-outbox",
    { headers: { authorization: `Bearer ${secret}` } },
  );
}
