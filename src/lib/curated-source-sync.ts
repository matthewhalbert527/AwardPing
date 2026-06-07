import "server-only";

import { awardSourceOverrides } from "@/lib/award-source-overrides";
import { hasSupabaseAdminConfig } from "@/lib/config";
import { normalizeSharedAwardKey } from "@/lib/shared-awards-core";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

let syncPromise: Promise<void> | null = null;

export async function ensureCuratedSharedAwardSources() {
  if (!hasSupabaseAdminConfig() || awardSourceOverrides.length === 0) return;

  syncPromise ??= syncCuratedSharedAwardSources().catch((error) => {
    syncPromise = null;
    console.error("Curated shared award source sync failed", error);
  });

  await syncPromise;
}

async function syncCuratedSharedAwardSources() {
  const admin = createSupabaseAdminClient();

  for (const override of awardSourceOverrides) {
    const searchKey = normalizeSharedAwardKey(override.awardName);
    const homepage =
      override.sources.find((source) => source.pageType === "homepage")?.url ||
      override.sources[0]?.url ||
      null;

    const { data: existingAward, error: selectError } = await admin
      .from("shared_awards")
      .select("id")
      .eq("search_key", searchKey)
      .maybeSingle();

    if (selectError) throw selectError;

    let sharedAwardId = existingAward?.id || null;
    if (!sharedAwardId) {
      const { data: insertedAward, error: insertError } = await admin
        .from("shared_awards")
        .insert({
          search_key: searchKey,
          name: override.awardName,
          official_homepage: homepage,
          summary: null,
          confidence: 0.95,
          status: "active",
          source: "admin",
        })
        .select("id")
        .single();

      if (insertError) throw insertError;
      sharedAwardId = insertedAward.id;
    } else {
      const { error: updateError } = await admin
        .from("shared_awards")
        .update({
          official_homepage: homepage,
          status: "active",
          updated_at: new Date().toISOString(),
        })
        .eq("id", sharedAwardId);

      if (updateError) throw updateError;
    }

    const { error: sourcesError } = await admin.from("shared_award_sources").upsert(
      override.sources.map((source) => ({
        shared_award_id: sharedAwardId,
        url: source.url,
        title: source.title,
        page_type: source.pageType,
        confidence: source.confidence,
        reason: source.reason,
        source: "admin",
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "shared_award_id,url" },
    );

    if (sourcesError) throw sourcesError;
  }
}
