import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("monitoring policy identity route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "app-revision-one");
  });

  it("returns the live app revision, policy hashes, and sealed matcher without caching", async () => {
    const { GET } = await import("@/app/api/monitoring-policy-identity/route");
    const response = GET();
    const payload = await response.json();

    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(payload).toMatchObject({
      schemaVersion: "monitoring-promotion-app-identity-v1",
      revision: "app-revision-one",
      policy_hash: expect.stringMatching(/^fnv1a32x2-utf16:/),
      batch_policy_hash: expect.stringMatching(/^fnv1a32x2-utf16:/),
      suppression_policy_hash: expect.stringMatching(/^fnv1a32x2-utf16:/),
      matcher_identity: "awardping-monitoring-promotion-matcher-bundle",
      matcher_version: "source-bundle-sha256-v1",
      matcher_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      candidateRuleIds: expect.any(Array),
    });
  });
});
