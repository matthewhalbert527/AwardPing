export async function checkSupabaseHealth(supabase, options = {}) {
  const table = options.table || "shared_awards";
  const timeoutMs = positiveInt(options.timeoutMs, 15_000);

  if (!supabase) {
    return {
      ok: false,
      reason: "missing_supabase_client",
      message: "Supabase client is not configured.",
    };
  }

  try {
    const { error } = await withTimeout(
      supabase.from(table).select("id").limit(1),
      timeoutMs,
      `Supabase health check timed out after ${timeoutMs}ms`,
    );

    if (error) {
      return {
        ok: false,
        reason: supabaseUnavailableReason(error),
        message: describeSupabaseHealthError(error),
      };
    }

    return { ok: true, reason: "ok", message: "Supabase is reachable." };
  } catch (error) {
    return {
      ok: false,
      reason: supabaseUnavailableReason(error),
      message: describeSupabaseHealthError(error),
    };
  }
}

export function isSupabaseUnavailableReason(reason) {
  return reason && reason !== "ok";
}

export function describeSupabaseHealthError(error) {
  if (!error) return "Unknown Supabase error.";
  if (typeof error === "string") return error;

  return [
    error.message || error.name || "Unknown Supabase error",
    error.code ? `code=${error.code}` : "",
    error.details ? `details=${error.details}` : "",
    error.hint ? `hint=${error.hint}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function supabaseUnavailableReason(error) {
  const message = describeSupabaseHealthError(error).toLowerCase();

  if (!message.trim()) return "unknown_supabase_error";
  if (message.includes("schema cache")) return "schema_cache_unavailable";
  if (message.includes("could not query the database")) return "database_unavailable";
  if (message.includes("econnrefused")) return "connection_refused";
  if (message.includes("57p03")) return "database_starting_or_recovering";
  if (message.includes("not accepting connections")) return "database_not_accepting_connections";
  if (message.includes("hot standby")) return "database_recovery_mode";
  if (message.includes("connection terminated")) return "connection_terminated";
  if (message.includes("fetch failed")) return "fetch_failed";
  if (message.includes("timeout")) return "timeout";
  return "supabase_unavailable";
}

async function withTimeout(promise, timeoutMs, message) {
  let timeoutHandle = null;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
