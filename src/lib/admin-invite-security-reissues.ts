import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { OperatorInviteSecurityReissueInput } from "@/lib/operator-action-inbox";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export async function loadAdminInviteSecurityReissues(
  admin: AdminClient,
): Promise<{ reissues: OperatorInviteSecurityReissueInput[]; loadErrors: string[] }> {
  const { data, error } = await admin
    .from("office_invite_security_reissues")
    .select("invite_id, office_id, email_hash, status, rotated_at, replacement_prepared_at, delivery_status, last_error")
    .neq("status", "delivered")
    .order("rotated_at", { ascending: true });

  if (error) {
    return {
      reissues: [],
      loadErrors: [`Invite security reissues: ${error.message}`],
    };
  }

  const rows = data || [];
  const officeIds = [...new Set(rows.map((row) => row.office_id))];
  const { data: offices, error: officeError } = officeIds.length
    ? await admin.from("offices").select("id, name").in("id", officeIds)
    : { data: [], error: null };
  if (officeError) {
    return {
      reissues: [],
      loadErrors: [`Invite security reissue offices: ${officeError.message}`],
    };
  }

  const officeNameById = new Map((offices || []).map((office) => [office.id, office.name]));
  return {
    reissues: rows.map((row) => ({
      inviteId: row.invite_id,
      officeId: row.office_id,
      officeName: officeNameById.get(row.office_id) || "Affected office",
      emailHash: row.email_hash,
      status: row.status === "replacement_ready" ? "replacement_ready" : "pending_reissue",
      rotatedAt: row.rotated_at,
      replacementPreparedAt: row.replacement_prepared_at,
      deliveryStatus: row.delivery_status,
      lastError: row.last_error,
    })),
    loadErrors: [],
  };
}
