import "server-only";

import { getMembershipForOffice } from "@/lib/offices";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/database.types";

export type AwardRow = Database["public"]["Tables"]["awards"]["Row"];
export type OfficeMemberRow = Database["public"]["Tables"]["office_members"]["Row"];

export async function getAwardAndMembership(userId: string, awardId: string) {
  const admin = createSupabaseAdminClient();
  const { data: award, error } = await admin
    .from("awards")
    .select("*")
    .eq("id", awardId)
    .maybeSingle();

  if (error) throw error;
  if (!award?.office_id) return null;

  const membership = await getMembershipForOffice(userId, award.office_id);
  if (!membership) return null;

  return { award, membership };
}

export async function assertOfficeMember(officeId: string, memberId: string | null | undefined) {
  if (!memberId) return null;

  const admin = createSupabaseAdminClient();
  const { data: member, error } = await admin
    .from("office_members")
    .select("*")
    .eq("id", memberId)
    .eq("office_id", officeId)
    .eq("status", "active")
    .maybeSingle();

  if (error) throw error;
  return member;
}
