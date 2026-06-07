import { createClient } from "@supabase/supabase-js";
import { appConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import {
  createSupabaseSecretKeyFetch,
  isSupabaseSecretApiKey,
} from "@/lib/supabase/secret-key-fetch";

export function createSupabaseAdminClient() {
  const global = isSupabaseSecretApiKey(appConfig.supabaseServiceRoleKey)
    ? { fetch: createSupabaseSecretKeyFetch(appConfig.supabaseServiceRoleKey) }
    : undefined;

  return createClient<Database>(
    appConfig.supabaseUrl,
    appConfig.supabaseServiceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global,
    },
  );
}
