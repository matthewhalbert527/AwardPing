import { describe, expect, it } from "vitest";
import {
  isRetryableSupabaseNetworkError,
  isSupabaseSecretApiKey,
  prepareSupabaseServiceHeaders,
} from "./supabase-service-client.mjs";

describe("Supabase service client transport", () => {
  it("recognizes current secret keys", () => {
    expect(isSupabaseSecretApiKey("sb_secret_example")).toBe(true);
    expect(isSupabaseSecretApiKey("legacy.jwt.value")).toBe(false);
  });

  it("keeps sb_secret only in apikey and removes the SDK fallback Authorization", () => {
    const key = "sb_secret_example";
    const headers = prepareSupabaseServiceHeaders(
      { apikey: key, Authorization: `Bearer ${key}` },
      key,
    );

    expect(headers.get("apikey")).toBe(key);
    expect(headers.has("authorization")).toBe(false);
  });

  it("fails closed when an sb_secret Authorization has no matching apikey", () => {
    const key = "sb_secret_example";
    expect(() =>
      prepareSupabaseServiceHeaders({ Authorization: `Bearer ${key}` }, key),
    ).toThrow(/same key in apikey/i);
  });

  it("does not rewrite legacy JWT or user-session Authorization headers", () => {
    expect(
      prepareSupabaseServiceHeaders(
        { apikey: "legacy.jwt.value", Authorization: "Bearer legacy.jwt.value" },
        "legacy.jwt.value",
      ).get("authorization"),
    ).toBe("Bearer legacy.jwt.value");
    expect(
      prepareSupabaseServiceHeaders(
        { apikey: "sb_secret_example", Authorization: "Bearer user.jwt.value" },
        "sb_secret_example",
      ).get("authorization"),
    ).toBe("Bearer user.jwt.value");
  });

  it("recognizes destroyed HTTP/2 sessions and transient socket failures", () => {
    expect(isRetryableSupabaseNetworkError(Object.assign(new Error("The session has been destroyed"), {
      code: "ERR_HTTP2_INVALID_SESSION",
    }))).toBe(true);
    expect(isRetryableSupabaseNetworkError({ cause: { code: "ECONNRESET" }, message: "fetch failed" })).toBe(true);
    expect(isRetryableSupabaseNetworkError(new Error("permission denied"))).toBe(false);
  });
});
