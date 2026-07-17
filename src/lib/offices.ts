import "server-only";

import { cookies } from "next/headers";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Database, NotificationPreference, OfficeRole } from "@/lib/database.types";
import { formatOfficeNameWithOrganization } from "@/lib/office-names";

export const officeCookieName = "awardping-office-id";

export type OfficeMembership = {
  id: string;
  officeId: string;
  officeName: string;
  userId: string;
  email: string | null;
  role: OfficeRole;
  notificationPreference: NotificationPreference;
};

export type OfficeContext = {
  current: OfficeMembership;
  memberships: OfficeMembership[];
};

type MembershipRow = Database["public"]["Tables"]["office_members"]["Row"];

export function canManageOffice(role: OfficeRole) {
  return role === "owner" || role === "admin";
}

export async function getOfficeContext(user: { id: string; email?: string | null }) {
  const supabase = await createSupabaseServerClient();
  const memberships = await fetchMemberships(supabase, user.id);

  if (memberships.length === 0) {
    return null;
  }

  const cookieStore = await cookies();
  const requestedOfficeId = cookieStore.get(officeCookieName)?.value;
  const current =
    memberships.find((membership) => membership.officeId === requestedOfficeId) ||
    memberships[0];

  return { current, memberships };
}

export async function requireOfficeContext(user: { id: string; email?: string | null }) {
  const context = await getOfficeContext(user);
  if (!context) {
    throw new Error("No office workspace is available for this account.");
  }
  return context;
}

export async function getMembershipForOffice(userId: string, officeId: string) {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("office_members")
    .select("*")
    .eq("user_id", userId)
    .eq("office_id", officeId)
    .eq("status", "active")
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function requireOfficeRole(
  userId: string,
  officeId: string,
  allowedRoles: OfficeRole[],
) {
  const membership = await getMembershipForOffice(userId, officeId);
  if (!membership || !allowedRoles.includes(membership.role)) {
    throw new Error("You do not have permission to manage this office workspace.");
  }
  return membership;
}

async function fetchMemberships(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
) {
  const { data, error } = await supabase
    .from("office_members")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  const rows = (data || []) as MembershipRow[];
  const officeIds = rows.map((row) => row.office_id);
  const { data: offices, error: officesError } = await supabase
    .from("offices")
    .select("id, name, organization_id")
    .in("id", officeIds.length ? officeIds : ["00000000-0000-0000-0000-000000000000"]);

  if (officesError) {
    throw officesError;
  }

  const organizationIds = [
    ...new Set((offices || []).map((office) => office.organization_id).filter(Boolean)),
  ] as string[];
  const { data: organizations, error: organizationsError } = organizationIds.length
    ? await supabase
        .from("organizations")
        .select("id, name")
        .in("id", organizationIds)
    : { data: [], error: null };

  if (organizationsError) {
    throw organizationsError;
  }

  const organizationsById = new Map(
    (organizations || []).map((organization) => [organization.id, organization.name]),
  );
  const officesById = new Map((offices || []).map((office) => [office.id, office]));

  return rows
    .filter((row) => officesById.has(row.office_id))
    .map((row) => {
      const office = officesById.get(row.office_id);

      return {
        id: row.id,
        officeId: row.office_id,
        officeName: formatOfficeNameWithOrganization(
          office?.name,
          office?.organization_id ? organizationsById.get(office.organization_id) : null,
        ),
        userId: row.user_id,
        email: row.email,
        role: row.role,
        notificationPreference: row.notification_preference,
      };
    });
}
