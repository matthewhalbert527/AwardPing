import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  decryptProfileFields,
  personalDataLookupHash,
} from "@/lib/personal-data";
import type { Database } from "@/lib/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type PrivacyRequestInsert =
  Database["public"]["Tables"]["privacy_requests"]["Insert"];

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
  const legacyContactPromise = admin.rpc(
    "get_personal_data_legacy_contact_export",
    {
      p_v2_email_hash: emailHash,
    },
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
    legacyPersonalDataArchive,
    legacyContactResult,
  ] = await Promise.all([
    admin
      .from("profiles")
      .select("id, email, email_hash, full_name, organization, full_name_encrypted, organization_encrypted, personal_data_reentry_required, personal_data_reentry_reason, personal_data_reentry_marked_at, personal_data_reentered_at, created_at, updated_at")
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
    admin
      .from("personal_data_legacy_ciphertext_archive")
      .select(
        "id, source_table, source_column, ciphertext_format, ciphertext, ciphertext_sha256, archived_at",
      )
      .eq("user_id", user.id)
      .order("archived_at", { ascending: true }),
    legacyContactPromise,
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
    legacyPersonalDataArchive.error,
    legacyContactResult.error,
  ].filter(Boolean);

  if (errors.length) {
    reportPrivatePrivacyExportError("load_export_data", errors[0]);
    return NextResponse.json(
      { error: "Data export could not be created." },
      { status: 500 },
    );
  }

  const legacyContactExport = parseLegacyContactExport(
    legacyContactResult.data,
  );
  if (!legacyContactExport) {
    reportPrivatePrivacyExportError(
      "validate_legacy_contact_export",
      "Legacy contact export RPC returned an invalid payload.",
    );
    return NextResponse.json(
      { error: "Legacy contact export evidence was invalid." },
      { status: 500 },
    );
  }
  if (legacyContactExport.state !== "complete") {
    const audit = await recordPrivacyExportAudit(admin, {
      user_id: user.id,
      email_hash: emailHash,
      request_type: "export",
      status: "failed",
      details: {
        reason: "legacy_contact_identity_unavailable",
        unattributable_legacy_contact_items:
          legacyContactExport.unattributableRetainedItems,
      },
      completed_at: new Date().toISOString(),
    });
    return NextResponse.json(
      {
        error:
          "A complete data export cannot be created until retained legacy contact evidence is safely attributed or erased.",
        code: "legacy_contact_identity_unavailable",
        auditStatus: audit.recorded ? "failure_recorded" : "recording_failed",
        ...(audit.recorded ? {} : { warning: audit.warning }),
      },
      { status: 409 },
    );
  }

  const decryptedProfile = decryptProfileFields(profile.data);
  const personalDataStatus =
    decryptedProfile?.personal_data_status || "missing";
  const unavailableFields =
    decryptedProfile?.personal_data_unavailable_fields || [];

  const audit = await recordPrivacyExportAudit(admin, {
    user_id: user.id,
    email_hash: emailHash,
    request_type: "export",
    status: "completed",
    details: {
      personal_data_status: personalDataStatus,
      unavailable_fields: unavailableFields,
      legacy_archive_items: legacyPersonalDataArchive.data?.length || 0,
      linked_legacy_contact_items: legacyContactExport.items.length,
    },
    completed_at: new Date().toISOString(),
  });

  return NextResponse.json({
    exportedAt: new Date().toISOString(),
    auditStatus: audit.recorded ? "completion_recorded" : "recording_failed",
    ...(audit.recorded ? {} : { warning: audit.warning }),
    account: {
      id: user.id,
      email: user.email,
      createdAt: user.created_at,
      lastSignInAt: user.last_sign_in_at,
      note: "Passwords are managed by Supabase Auth as non-reversible hashes and are not exportable by AwardPing.",
    },
    profile: decryptedProfile,
    personalDataRecovery: {
      status: personalDataStatus,
      reentryRequired:
        decryptedProfile?.personal_data_reentry_required || false,
      unavailableFields,
      unavailableReasons:
        decryptedProfile?.personal_data_unavailable_reasons || [],
      explanation:
        personalDataStatus === "reentry_required"
          ? "The legacy encryption key is unavailable. AwardPing cannot truthfully recover the affected plaintext unless that exact key is later found; re-entering the profile creates new v2 ciphertext without changing this archive."
          : personalDataStatus === "legacy_recovery_available"
            ? "The exact legacy key can currently recover these values, but the profile remains marked until a controlled save or recovery run writes authenticated v2 ciphertext."
          : null,
      archivedCiphertext: legacyPersonalDataArchive.data || [],
      legacyContactArtifacts: legacyContactExport.items,
      legacyContactExplanation:
        legacyContactExport.items.length
          ? "These legacy contact artifacts are disabled or historical. They are linked by the current v2 lookup identity for truthful export and future erasure; raw contact ciphertext is not included here."
          : null,
    },
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

async function recordPrivacyExportAudit(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  payload: PrivacyRequestInsert,
) {
  try {
    const result = await admin.from("privacy_requests").insert(payload);
    if (result.error) {
      reportPrivatePrivacyExportError("record_export_audit", result.error);
      return {
        recorded: false as const,
        warning:
          "The privacy export audit record could not be persisted and requires operator reconciliation.",
      };
    }
    return { recorded: true as const };
  } catch (error) {
    reportPrivatePrivacyExportError("record_export_audit", error);
    return {
      recorded: false as const,
      warning:
        "The privacy export audit record could not be persisted and requires operator reconciliation.",
    };
  }
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

type LegacyContactExport =
  | {
      state: "complete";
      items: Array<Record<string, unknown>>;
      unattributableRetainedItems: 0;
    }
  | {
      state: "incomplete";
      items: [];
      unattributableRetainedItems: number;
    };

function parseLegacyContactExport(value: unknown): LegacyContactExport | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const rawItems = record.items;
  const rawCount = record.unattributable_retained_items;
  if (
    (record.state !== "complete" && record.state !== "incomplete") ||
    !Array.isArray(rawItems) ||
    typeof rawCount !== "number" ||
    !Number.isSafeInteger(rawCount) ||
    rawCount < 0
  ) {
    return null;
  }
  if (record.state === "incomplete") {
    if (rawItems.length) return null;
    return {
      state: "incomplete",
      items: [],
      unattributableRetainedItems: rawCount,
    };
  }
  if (
    rawCount !== 0 ||
    rawItems.some(
      (item) => !item || Array.isArray(item) || typeof item !== "object",
    )
  ) {
    return null;
  }
  return {
    state: "complete",
    items: rawItems as Array<Record<string, unknown>>,
    unattributableRetainedItems: 0,
  };
}

function reportPrivatePrivacyExportError(stage: string, error: unknown) {
  console.error("[privacy-export] operation failed", {
    stage,
    message: error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String((error as { message?: unknown } | null)?.message || error),
  });
}
