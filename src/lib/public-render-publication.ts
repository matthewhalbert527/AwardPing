import "server-only";
import { cache } from "react";
import { loadStage1PublicationIdentityIndex } from "@/lib/stage1-publication";
import { loadProgramAwardExpansionIdentities } from "@/lib/program-award-expansion.server";
import { loadProgramTextAlertSourceBindings } from "@/lib/program-text-alert-sources.server";
import { loadProgramBasicFacts } from "@/lib/program-basic-facts.server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import textMonitoring from "../../config/program-text-monitoring.json";

/** Share public authority reads only within one React server render. React
 * discards this memo for the next request. Never use a persistent cache, user
 * data, or this render reader for actions, delivery or publication decisions. */
export const loadPublicRenderPublicationIndex = cache(async () => {
  const index = await loadStage1PublicationIdentityIndex();
  if (!index.available || !index.verifiedEntries.length) return index;
  const admin = createSupabaseAdminClient();
  const expanded = await loadProgramAwardExpansionIdentities(admin, index, textMonitoring.epoch);
  return loadProgramTextAlertSourceBindings(admin, expanded, textMonitoring.epoch);
});

/** Only the directory needs every award's details. Its single bounded fact
 * query starts after the thin identity/source-authority read has completed. */
export const loadPublicRenderDirectoryPublicationIndex = cache(async () => {
  const index = await loadPublicRenderPublicationIndex();
  if (!index.available || !index.verifiedEntries.length) return index;
  return loadProgramBasicFacts(createSupabaseAdminClient(), index);
});
