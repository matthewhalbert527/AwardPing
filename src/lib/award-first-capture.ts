import "server-only";

import type { Stage1PublicationIndex } from "@/lib/stage1-publication";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** Earliest preserved published evidence, not a claim about the first-ever pull. */
export async function loadFirstPublishedCaptureDates({
  admin,
  publicationIndex,
}: {
  admin: AdminClient;
  publicationIndex: Stage1PublicationIndex;
}): Promise<Map<string, string>> {
  if (!publicationIndex.available) return new Map();

  const dates = await Promise.all(publicationIndex.verifiedEntries.map(
    async (entry): Promise<readonly [string, string] | null> => {
      if (!entry.effectivelyVerified || !entry.allowedSourceIds.length) return null;

      try {
        const { data, error } = await admin
          .from("stage1_award_fact_publication_ledger")
          .select("id, cohort_key, source_id, source_captured_at")
          .eq("cohort_key", entry.registry.cohort_key)
          .in("source_id", entry.allowedSourceIds)
          .order("source_captured_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (
          error || !data ||
          data.cohort_key !== entry.registry.cohort_key ||
          !entry.allowedSourceIds.includes(data.source_id) ||
          !isCaptureTimestamp(data.source_captured_at)
        ) return null;

        return [entry.canonicalAwardId, data.source_captured_at];
      } catch {
        // This optional date must not hide the catalog or expose driver errors.
        return null;
      }
    },
  ));

  return new Map(dates.filter((date) => date !== null));
}

function isCaptureTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.exec(value);
  if (!match || /-00:?00$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const calendar = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 10) === match[1];
}
