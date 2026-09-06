import { describe, expect, it } from "vitest";
import { publicDigestStatusMessage } from "@/lib/public-digest-copy";

describe("public digest status copy", () => {
  it.each([
    [{ confirmed: "1" }, "Your AwardPing daily digest is confirmed."],
    [{ confirmed: "invalid" }, "That confirmation link is no longer valid."],
    [{ unsubscribed: "1" }, "You have been unsubscribed from the AwardPing daily digest."],
    [{ unsubscribed: "retry" }, "A digest is already being sent. Please use the unsubscribe link again in a few minutes."],
    [{ unsubscribed: "invalid" }, "That unsubscribe link is no longer valid."],
  ])("keeps the meaning of each supported redirect state: %j", (params, message) => {
    expect(publicDigestStatusMessage(params)).toBe(message);
  });

  it("does not report success for missing or unknown values", () => {
    for (const params of [{}, { confirmed: "true" }, { unsubscribed: "false" }, { confirmed: "<script>" }]) {
      expect(publicDigestStatusMessage(params)).toBe("");
    }
  });

  it("preserves the existing confirmation-first precedence for mixed query parameters", () => {
    expect(publicDigestStatusMessage({ confirmed: "1", unsubscribed: "1" })).toBe("Your AwardPing daily digest is confirmed.");
    expect(publicDigestStatusMessage({ confirmed: "invalid", unsubscribed: "1" })).toBe("That confirmation link is no longer valid.");
    expect(publicDigestStatusMessage({ confirmed: "unknown", unsubscribed: "retry" })).toContain("already being sent");
  });
});
