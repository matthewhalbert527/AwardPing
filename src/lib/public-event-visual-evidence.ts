import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { PublicChangeEventVisualEvidence } from "@/lib/public-change-event";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export async function loadPublicEventVisualEvidence(
  admin: AdminClient,
  eventIds: string[],
) {
  const uniqueIds = [...new Set(eventIds.filter(Boolean))];
  if (!uniqueIds.length) return new Map<string, PublicChangeEventVisualEvidence>();
  const rows: PublicChangeEventVisualEvidence[] = [];
  for (let index = 0; index < uniqueIds.length; index += 200) {
    const { data, error } = await admin
      .from("shared_award_change_event_visual_evidence")
      .select("*")
      .in("change_event_id", uniqueIds.slice(index, index + 200));
    if (error) {
      throw new Error("Immutable visual evidence is unavailable.");
    }
    rows.push(...((data || []) as PublicChangeEventVisualEvidence[]));
  }
  return new Map(rows.map((row) => [row.change_event_id, row]));
}
