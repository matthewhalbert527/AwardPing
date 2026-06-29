import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type ReadableSharedChange = {
  id: string;
  shared_award_id: string;
  shared_award_source_id?: string | null;
  detected_at: string;
};

export async function ensureSharedUpdateReadBaseline(userId: string) {
  const admin = createSupabaseAdminClient();
  const now = new Date().toISOString();
  const { data: existing, error: existingError } = await admin
    .from("shared_award_update_read_baselines")
    .select("baseline_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing?.baseline_at) return existing.baseline_at;

  const { data, error } = await admin
    .from("shared_award_update_read_baselines")
    .upsert(
      { user_id: userId, baseline_at: now, updated_at: now },
      { onConflict: "user_id", ignoreDuplicates: true },
    )
    .select("baseline_at")
    .maybeSingle();

  if (error) throw error;
  return data?.baseline_at || now;
}

export async function unreadSharedChangeIdsForUser(
  userId: string,
  changes: ReadableSharedChange[],
) {
  if (changes.length === 0) return new Set<string>();
  const baselineAt = await ensureSharedUpdateReadBaseline(userId);
  const candidateIds = changes
    .filter((change) => new Date(change.detected_at).getTime() > new Date(baselineAt).getTime())
    .map((change) => change.id);
  if (candidateIds.length === 0) return new Set<string>();

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("shared_award_change_reads")
    .select("shared_award_change_event_id")
    .eq("user_id", userId)
    .in("shared_award_change_event_id", candidateIds);

  if (error) throw error;
  const readIds = new Set((data || []).map((row) => row.shared_award_change_event_id));
  return new Set(candidateIds.filter((id) => !readIds.has(id)));
}

export async function markSharedChangesRead(userId: string, changes: ReadableSharedChange[]) {
  if (changes.length === 0) return;
  await ensureSharedUpdateReadBaseline(userId);

  const now = new Date().toISOString();
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("shared_award_change_reads").upsert(
    changes.map((change) => ({
      user_id: userId,
      shared_award_change_event_id: change.id,
      shared_award_id: change.shared_award_id,
      shared_award_source_id: change.shared_award_source_id || null,
      read_at: now,
    })),
    { onConflict: "user_id,shared_award_change_event_id" },
  );

  if (error) throw error;
}
