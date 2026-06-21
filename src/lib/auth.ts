import { redirect } from "next/navigation";
import { appConfig, hasSupabaseConfig } from "@/lib/config";
import { decryptProfileFields } from "@/lib/personal-data";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function getCurrentUser() {
  if (!hasSupabaseConfig()) {
    return null;
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user;
}

export async function requireUser() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return user;
}

export async function getUserProfile(userId: string) {
  if (!hasSupabaseConfig()) {
    return null;
  }

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("profiles")
    .select("full_name, organization, full_name_encrypted, organization_encrypted")
    .eq("id", userId)
    .maybeSingle();

  return decryptProfileFields(data);
}

export function isSiteAdminEmail(email?: string | null) {
  if (!email || appConfig.adminEmails.length === 0) return false;
  return appConfig.adminEmails.includes(email.trim().toLowerCase());
}
