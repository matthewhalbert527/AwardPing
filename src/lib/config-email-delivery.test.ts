import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  emailDeliveryConfigReady,
  publicUpdateDeliveryConfigReady,
  publicUpdateTokenConfigReady,
} from "@/lib/config";

describe("email delivery configuration", () => {
  it("requires a Resend key and a non-placeholder sender", () => {
    expect(
      emailDeliveryConfigReady({
        apiKey: "re_live_123",
        from: "AwardPing <alerts@awardping.com>",
      }),
    ).toBe(true);
    expect(
      emailDeliveryConfigReady({
        apiKey: "",
        from: "AwardPing <alerts@awardping.com>",
      }),
    ).toBe(false);
    expect(
      emailDeliveryConfigReady({
        apiKey: "re_live_123",
        from: "AwardPing <alerts@example.com>",
      }),
    ).toBe(false);
  });

  it("rejects malformed keys, senders, and reserved domains", () => {
    for (const input of [
      { apiKey: "not-resend", from: "alerts@awardping.com" },
      { apiKey: "re_test", from: "AwardPing <alerts@awardping.com" },
      { apiKey: "re_test", from: "alerts@localhost" },
      { apiKey: "re_test", from: "alerts@awardping.test" },
    ]) {
      expect(emailDeliveryConfigReady(input)).toBe(false);
    }
  });

  it("requires independent production crypto and token material for subscriptions", () => {
    const valid = {
      apiKey: "re_live_123",
      from: "AwardPing <alerts@awardping.com>",
      cronSecret: "cron-material-0123456789abcdefghijkl",
      encryptionKey: "encryption-material-0123456789abcdef",
      encryptionKeyId: "prod-2026-08",
      lookupHmacKey: "lookup-material-0123456789abcdefghijkl",
    };

    expect(publicUpdateDeliveryConfigReady(valid)).toBe(true);
    expect(
      publicUpdateDeliveryConfigReady({ ...valid, lookupHmacKey: "" }),
    ).toBe(false);
    expect(
      publicUpdateDeliveryConfigReady({
        ...valid,
        lookupHmacKey: valid.encryptionKey,
      }),
    ).toBe(false);
    expect(
      publicUpdateDeliveryConfigReady({
        ...valid,
        cronSecret: "awardping-local-public-update-token",
      }),
    ).toBe(false);
    expect(
      publicUpdateDeliveryConfigReady({
        ...valid,
        encryptionKey:
          "awardping-local-development-personal-data-encryption-key",
      }),
    ).toBe(false);
    expect(
      publicUpdateDeliveryConfigReady({
        ...valid,
        lookupHmacKey:
          "awardping-local-development-personal-data-lookup-key",
      }),
    ).toBe(false);
    expect(
      publicUpdateDeliveryConfigReady(
        { ...valid, cronSecret: "", encryptionKey: "", lookupHmacKey: "" },
        true,
      ),
    ).toBe(true);
  });

  it("rejects the source-known token fallback in production", () => {
    expect(publicUpdateTokenConfigReady("cron-material-0123456789abcdefghijkl")).toBe(
      true,
    );
    expect(publicUpdateTokenConfigReady("awardping-local-public-update-token")).toBe(
      false,
    );
    expect(publicUpdateTokenConfigReady("", true)).toBe(true);
  });
});
