import "server-only";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Stage1PublicationEntry } from "@/lib/stage1-publication";
import { readableSourceTitle } from "@/lib/display-text";
import { loadProgramExpansionTrackingContext } from "@/lib/program-expansion-tracking.server";

/** The admitted source context already verifies the exact source IDs, official
 * URLs, canonical owner and current text authority. Publish only those pinned
 * labels/links, never mutable AI metadata, internal review reasons or errors.
 * A REVIEW_LATER label alone grants no public visibility.
 */
export async function loadProgramExpansionPublicSources(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  publication: Stage1PublicationEntry,
) {
  const { sources } = await loadProgramExpansionTrackingContext(admin, publication);
  const data = sources.map(source => ({
    id: source.id,
    shared_award_id: source.shared_award_id,
    url: source.url,
    title: readableSourceTitle(source.title, source.url),
    page_type: source.page_type,
    admin_review_status: source.admin_review_status,
    display_title: null,
    page_description: null,
    page_metadata: null,
    page_metadata_generated_at: null,
    page_metadata_model: null,
    last_checked_at: null,
    last_error: null,
  }));
  return { data, error: null };
}
