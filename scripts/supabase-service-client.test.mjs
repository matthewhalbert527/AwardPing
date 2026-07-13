import { describe, expect, it } from "vitest";
import {
  isRetryableSupabaseNetworkError,
  isSupabaseSecretApiKey,
} from "./supabase-service-client.mjs";

describe("Supabase service client transport", () => {
  it("recognizes current secret keys", () => {
    expect(isSupabaseSecretApiKey("sb_secret_example")).toBe(true);
    expect(isSupabaseSecretApiKey("legacy.jwt.value")).toBe(false);
  });

  it("recognizes destroyed HTTP/2 sessions and transient socket failures", () => {
    expect(isRetryableSupabaseNetworkError(Object.assign(new Error("The session has been destroyed"), {
      code: "ERR_HTTP2_INVALID_SESSION",
    }))).toBe(true);
    expect(isRetryableSupabaseNetworkError({ cause: { code: "ECONNRESET" }, message: "fetch failed" })).toBe(true);
    expect(isRetryableSupabaseNetworkError(new Error("permission denied"))).toBe(false);
  });
});
