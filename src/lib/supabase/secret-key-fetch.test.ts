import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSupabaseSecretKeyFetch,
  isSupabaseSecretApiKey,
} from "@/lib/supabase/secret-key-fetch";

describe("Supabase secret-key fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognizes only the new elevated key type", () => {
    expect(isSupabaseSecretApiKey(" sb_secret_example ")).toBe(true);
    expect(isSupabaseSecretApiKey("legacy.jwt.value")).toBe(false);
    expect(isSupabaseSecretApiKey("sb_publishable_example")).toBe(false);
  });

  it("sends sb_secret in apikey but not Authorization", async () => {
    const key = "sb_secret_example";
    let sentHeaders = new Headers();
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        sentHeaders = new Headers(init?.headers);
        return new Response(null, { status: 204 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await createSupabaseSecretKeyFetch(key)("https://example.supabase.co/rest/v1/rpc", {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });

    expect(sentHeaders.get("apikey")).toBe(key);
    expect(sentHeaders.has("authorization")).toBe(false);
  });

  it("fails closed instead of forwarding a secret Bearer without apikey", async () => {
    const key = "sb_secret_example";
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createSupabaseSecretKeyFetch(key)("https://example.supabase.co/rest/v1/rpc", {
        headers: { Authorization: `Bearer ${key}` },
      }),
    ).rejects.toThrow(/same key in apikey/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a distinct signed-in user JWT", async () => {
    const key = "sb_secret_example";
    let sentHeaders = new Headers();
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        sentHeaders = new Headers(init?.headers);
        return new Response(null, { status: 204 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await createSupabaseSecretKeyFetch(key)("https://example.supabase.co/rest/v1/rpc", {
      headers: { apikey: key, Authorization: "Bearer user.jwt.value" },
    });

    expect(sentHeaders.get("authorization")).toBe("Bearer user.jwt.value");
  });
});
