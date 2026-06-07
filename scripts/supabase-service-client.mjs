import { createClient } from "@supabase/supabase-js";

export function createSupabaseServiceClient(url, key) {
  const options = {
    auth: { autoRefreshToken: false, persistSession: false },
  };

  if (isSupabaseSecretApiKey(key)) {
    options.global = { fetch: createSupabaseSecretKeyFetch(key) };
  }

  return createClient(url, key, options);
}

export function isSupabaseSecretApiKey(key) {
  return Boolean(String(key || "").trim().startsWith("sb_secret_"));
}

function createSupabaseSecretKeyFetch(key) {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") === `Bearer ${key}`) {
      headers.delete("authorization");
    }
    return fetch(input, { ...init, headers });
  };
}
