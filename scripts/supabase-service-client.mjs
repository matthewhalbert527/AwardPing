import { createClient } from "@supabase/supabase-js";
import { Agent, Headers, fetch as undiciFetch } from "undici";

const supabaseDispatcher = new Agent({
  allowH2: false,
  connections: 12,
  pipelining: 1,
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
});

export function createSupabaseServiceClient(url, key) {
  const options = {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: createSupabaseFetch(key) },
  };

  return createClient(url, key, options);
}

export function isSupabaseSecretApiKey(key) {
  return Boolean(String(key || "").trim().startsWith("sb_secret_"));
}

export function isRetryableSupabaseNetworkError(error) {
  const message = errorMessage(error).toLowerCase();
  const code = String(error?.code || error?.cause?.code || "").toLowerCase();
  return /err_http2_invalid_session|econnreset|econnrefused|etimedout|socket|fetch failed|network|connection closed|other side closed/.test(
    `${code} ${message}`,
  );
}

function createSupabaseFetch(key) {
  const secretKey = isSupabaseSecretApiKey(key);
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (secretKey && headers.get("authorization") === `Bearer ${key}`) {
      headers.delete("authorization");
    }

    const method = String(init?.method || input?.method || "GET").toUpperCase();
    const maxAttempts = ["GET", "HEAD", "OPTIONS"].includes(method) ? 4 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await undiciFetch(input, {
          ...init,
          headers,
          dispatcher: supabaseDispatcher,
        });
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableSupabaseNetworkError(error)) throw error;
        const waitMs = Math.min(4_000, 500 * (2 ** (attempt - 1)));
        console.warn(
          `SUPABASE_RETRY method=${method} attempt=${attempt}/${maxAttempts} wait_ms=${waitMs} message=${truncate(errorMessage(error), 240)}`,
        );
        await sleep(waitMs);
      }
    }

    throw new Error(`Supabase ${method} request failed after ${maxAttempts} attempts.`);
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error || "Unknown Supabase network error.");
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}
