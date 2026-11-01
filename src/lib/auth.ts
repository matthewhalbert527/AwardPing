import { redirect } from "next/navigation";
import { cache } from "react";
import { appConfig, hasSupabaseConfig } from "@/lib/config";
import { decryptProfileFields } from "@/lib/personal-data";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Deduplicate only during the current Server Component render. Route handlers
// and decisions still verify the session afresh; nothing persists across users.
export const getCurrentUser = cache(async function getCurrentUser() {
  if (!hasSupabaseConfig()) {
    return null;
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user;
});

export async function requireUser() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return user;
}

export const getUserProfile = cache(async function getUserProfile(userId: string) {
  if (!hasSupabaseConfig()) {
    return null;
  }

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("profiles")
    .select(
      "full_name, organization, full_name_encrypted, organization_encrypted, personal_data_reentry_required, personal_data_reentry_reason, personal_data_reentry_marked_at, personal_data_reentered_at",
    )
    .eq("id", userId)
    .maybeSingle();

  return decryptProfileFields(data);
});

export function isSiteAdminEmail(email?: string | null) {
  if (!email || appConfig.adminEmails.length === 0) return false;
  return appConfig.adminEmails.includes(email.trim().toLowerCase());
}
