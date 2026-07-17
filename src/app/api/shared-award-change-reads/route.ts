import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { isPublicChangeEvent } from "@/lib/public-change-event";
import { loadPublicEventVisualEvidence } from "@/lib/public-event-visual-evidence";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadStage1PublicationIndex } from "@/lib/stage1-publication";
import { markSharedChangesRead } from "@/lib/update-read-state";
import { isSameOriginMutationRequest } from "@/lib/same-origin-mutation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isSameOriginMutationRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication is required." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { changeIds?: unknown } | null;
  const changeIds = Array.isArray(body?.changeIds)
    ? body.changeIds.filter((id): id is string => typeof id === "string" && Boolean(id)).slice(0, 50)
    : [];

  if (changeIds.length === 0) {
    return NextResponse.json({ ok: true, read: 0 });
  }

  const admin = createSupabaseAdminClient();
  const publicationIndex = await loadStage1PublicationIndex();
  if (!publicationIndex.available || publicationIndex.verifiedMemberAwardIds.length === 0) {
    return NextResponse.json({ ok: true, read: 0 });
  }
  const { data, error } = await admin
    .from("shared_award_change_events")
    .select("id, shared_award_id, shared_award_source_id, source_title, source_url, source_page_type, summary, change_details, suppressed_at, suppression_reason, suppression_source, visual_review_candidate_id, detected_at")
    .in("id", [...new Set(changeIds)])
    .in("shared_award_id", publicationIndex.verifiedMemberAwardIds)
    .is("suppressed_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const events = data || [];
  const evidenceByEventId = await loadPublicEventVisualEvidence(
    admin,
    events.map((event) => event.id),
  );
  const sourceIds = [
    ...new Set(
      events
        .map((event) => event.shared_award_source_id)
        .filter((sourceId): sourceId is string => Boolean(sourceId)),
    ),
  ];
  const { data: sources, error: sourcesError } = sourceIds.length
    ? await admin
        .from("shared_award_sources")
        .select("id, shared_award_id, admin_review_status, url, title, display_title, page_metadata, page_metadata_generated_at, page_metadata_model, page_type, source, reason, submitted_by_user_id")
        .in("id", sourceIds)
    : { data: [], error: null };
  if (sourcesError) {
    return NextResponse.json({ error: sourcesError.message }, { status: 500 });
  }

  const sourceById = new Map((sources || []).map((source) => [source.id, source]));
  const publicEvents = events.filter((event) => {
    const publication = publicationIndex.entryByMemberAwardId.get(
      event.shared_award_id,
    );
    if (!publication) return false;
    const source = event.shared_award_source_id
      ? sourceById.get(event.shared_award_source_id) || null
      : null;
    return isPublicChangeEvent({
      event,
      award: {
        id: publication.canonicalAwardId,
        name: publication.registry.canonical_name,
        status: "active",
      },
      source,
      publication,
      evidence: evidenceByEventId.get(event.id) || null,
    });
  });

  await markSharedChangesRead(user.id, publicEvents);
  return NextResponse.json({ ok: true, read: publicEvents.length });
}
