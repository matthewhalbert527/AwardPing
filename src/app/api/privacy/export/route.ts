import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { decryptProfileFields, personalDataLookupHash } from "@/lib/personal-data";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const emailHash = user.email ? personalDataLookupHash(user.email) : null;
  const publicUpdatesPromise = getPublicUpdateSubscriptions(
    admin,
    emailHash,
    user.email || null,
  );
  const [
    profile,
    subscription,
    memberships,
    awards,
    awardSources,
    monitors,
    sourceRequests,
    discoveryRequests,
    alertDeliveries,
    publicUpdates,
  ] = await Promise.all([
    admin
      .from("profiles")
      .select("id, email, email_hash, full_name, organization, full_name_encrypted, organization_encrypted, created_at, updated_at")
      .eq("id", user.id)
      .maybeSingle(),
    admin.from("subscriptions").select("*").eq("user_id", user.id).maybeSingle(),
    admin.from("office_members").select("*").eq("user_id", user.id),
    admin.from("awards").select("*").eq("user_id", user.id).order("created_at", { ascending: true }),
    admin.from("award_sources").select("*").eq("user_id", user.id).order("created_at", { ascending: true }),
    admin.from("monitors").select("*").eq("user_id", user.id).order("created_at", { ascending: true }),
    admin.from("source_page_requests").select("*").eq("user_id", user.id).order("created_at", { ascending: true }),
    admin.from("discovery_requests").select("*").eq("user_id", user.id).order("created_at", { ascending: true }),
    admin.from("alert_deliveries").select("*").eq("user_id", user.id).order("created_at", { ascending: true }),
    publicUpdatesPromise,
  ]);

  const errors = [
    profile.error,
    subscription.error,
    memberships.error,
    awards.error,
    awardSources.error,
    monitors.error,
    sourceRequests.error,
    discoveryRequests.error,
    alertDeliveries.error,
    publicUpdates.error,
  ].filter(Boolean);

  if (errors.length) {
    return NextResponse.json(
      { error: errors[0]?.message || "Data export could not be created." },
      { status: 500 },
    );
  }

  await admin.from("privacy_requests").insert({
    user_id: user.id,
    email_hash: emailHash,
    request_type: "export",
    status: "completed",
    completed_at: new Date().toISOString(),
  });

  return NextResponse.json({
    exportedAt: new Date().toISOString(),
    account: {
      id: user.id,
      email: user.email,
      createdAt: user.created_at,
      lastSignInAt: user.last_sign_in_at,
      note: "Passwords are managed by Supabase Auth as non-reversible hashes and are not exportable by AwardPing.",
    },
    profile: decryptProfileFields(profile.data),
    subscription: subscription.data,
    officeMemberships: memberships.data || [],
    awards: awards.data || [],
    awardSources: awardSources.data || [],
    monitors: monitors.data || [],
    sourceRequests: sourceRequests.data || [],
    discoveryRequests: discoveryRequests.data || [],
    alertDeliveries: alertDeliveries.data || [],
    publicUpdateSubscriptions: publicUpdates.data || [],
  });
}

async function getPublicUpdateSubscriptions(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  emailHash: string | null,
  email: string | null,
) {
  const selectColumns =
    "id, email_hash, status, confirmation_sent_at, confirmed_at, unsubscribed_at, last_digest_sent_at, created_at, updated_at";
  const results = await Promise.all([
    emailHash
      ? admin.from("public_update_subscribers").select(selectColumns).eq("email_hash", emailHash)
      : Promise.resolve({ data: [], error: null }),
    email
      ? admin.from("public_update_subscribers").select(selectColumns).eq("email", email)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const error = results.find((result) => result.error)?.error || null;
  const byId = new Map<string, NonNullable<(typeof results)[number]["data"]>[number]>();
  for (const result of results) {
    for (const row of result.data || []) {
      byId.set(row.id, row);
    }
  }

  return { data: Array.from(byId.values()), error };
}
