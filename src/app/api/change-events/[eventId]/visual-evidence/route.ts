import { NextResponse } from "next/server";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import {
  buildEventVisualEvidenceSide,
  type EventVisualEvidenceSide,
} from "@/lib/change-event-visual-evidence";
import {
  appConfig,
  hasR2Config,
  hasSupabaseAdminConfig,
  hasSupabaseConfig,
} from "@/lib/config";
import { createR2SignedReadUrl, getR2Bucket } from "@/lib/r2";
import {
  eventVisualEvidencePresentation,
  isPublicChangeEvent,
  type PublicChangeEventVisualEvidence,
} from "@/lib/public-change-event";
import { getStage1PublicationEntryForAward } from "@/lib/stage1-publication";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Props = {
  params: Promise<{ eventId: string }>;
};

type CurrentUser = Awaited<ReturnType<typeof getCurrentUser>>;
type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

const unavailableMessage = "Exact visual evidence is unavailable for this update.";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: Props) {
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }
  if (!hasR2Config()) {
    return NextResponse.json({ error: "Cloudflare R2 is not configured." }, { status: 503 });
  }

  const { eventId } = await params;
  if (!uuidPattern.test(eventId)) {
    return NextResponse.json({ error: unavailableMessage }, { status: 404 });
  }

  const admin = createSupabaseAdminClient();
  const [user, eventResult, evidenceResult] = await Promise.all([
    getCurrentUser(),
    admin
      .from("shared_award_change_events")
      .select(
        "id, shared_award_id, shared_award_source_id, source_url, source_title, source_page_type, summary, change_details, suppressed_at, suppression_reason, suppression_source, visual_review_candidate_id",
      )
      .eq("id", eventId)
      .maybeSingle(),
    admin
      .from("shared_award_change_event_visual_evidence")
      .select("*")
      .eq("change_event_id", eventId)
      .maybeSingle(),
  ]);

  if (eventResult.error || evidenceResult.error) {
    return NextResponse.json(
      { error: "Stored visual evidence could not be read." },
      { status: 500 },
    );
  }

  const event = eventResult.data;
  const evidence = evidenceResult.data;
  if (!event || !evidence || !hasMatchingEvidenceIdentity(event, evidence)) {
    return NextResponse.json({ error: unavailableMessage }, { status: 404 });
  }

  const sourceId = event.shared_award_source_id;
  if (!(await canViewEventEvidence(admin, user, event, evidence))) {
    return NextResponse.json(
      { error: "This visual evidence is not available." },
      { status: user ? 403 : 404 },
    );
  }

  const bucket = getR2Bucket();
  if (evidence.bucket && evidence.bucket !== bucket) {
    return NextResponse.json({ error: unavailableMessage }, { status: 404 });
  }

  const localization = jsonObject(evidence.localization);
  const localizationSides = jsonObject(localization.sides);
  const presentation = eventVisualEvidencePresentation(event, evidence);
  let previous: EventVisualEvidenceSide;
  let latest: EventVisualEvidenceSide;
  try {
    [previous, latest] = await Promise.all([
      buildEventVisualEvidenceSide({
        captureValue: evidence.previous_capture,
        localizationValue: localizationSides.previous,
        signObjectKey: createR2SignedReadUrl,
        exactCropAllowed: presentation.exactCropAllowed,
        fallbackReason: presentation.fallbackReason,
      }),
      buildEventVisualEvidenceSide({
        captureValue: evidence.current_capture,
        localizationValue: localizationSides.current,
        signObjectKey: createR2SignedReadUrl,
        exactCropAllowed: presentation.exactCropAllowed,
        fallbackReason: presentation.fallbackReason,
      }),
    ]);
  } catch {
    return NextResponse.json(
      { error: "Stored visual evidence could not be opened." },
      { status: 503 },
    );
  }

  return NextResponse.json({
    change_event_id: event.id,
    evidence_scope: "change_event",
    evidence_status: presentation.evidenceStatus,
    stored_evidence_status: evidence.evidence_status,
    evidence_schema_version: evidence.evidence_schema_version,
    localization_direction: localizationDirection(localization.direction),
    source_id: sourceId,
    shared_award_id: event.shared_award_id,
    source_url: event.source_url,
    source_title: event.source_title,
    source_page_type: event.source_page_type,
    bucket,
    expires_in_seconds: appConfig.r2SignedUrlTtlSeconds,
    latest,
    previous,
  });
}

async function canViewEventEvidence(
  admin: AdminClient,
  user: CurrentUser,
  event: {
    id: string;
    shared_award_id: string;
    shared_award_source_id: string | null;
    source_url: string;
    source_title: string | null;
    source_page_type: string | null;
    summary: string;
    change_details: unknown;
    suppressed_at: string | null;
    suppression_reason: string | null;
    suppression_source: string | null;
    visual_review_candidate_id: string | null;
  },
  evidence: PublicChangeEventVisualEvidence,
) {
  if (isSiteAdminEmail(user?.email)) return true;
  if (!event.shared_award_source_id) return false;

  const [sourceResult, publication] = await Promise.all([
    admin
      .from("shared_award_sources")
      .select("id, shared_award_id, admin_review_status, url, title, display_title, page_metadata, page_metadata_generated_at, page_metadata_model, page_type, source, reason, submitted_by_user_id")
      .eq("id", event.shared_award_source_id)
      .eq("shared_award_id", event.shared_award_id)
      .eq("admin_review_status", "open")
      .maybeSingle(),
    getStage1PublicationEntryForAward(event.shared_award_id),
  ]);

  if (sourceResult.error || !publication) return false;
  return isPublicChangeEvent({
    event,
    award: {
      id: publication.canonicalAwardId,
      name: publication.registry.canonical_name,
      status: "active",
    },
    source: sourceResult.data,
    publication,
    evidence,
  });
}

function hasMatchingEvidenceIdentity(
  event: {
    id: string;
    shared_award_id: string;
    shared_award_source_id: string | null;
  },
  evidence: {
    change_event_id: string;
    shared_award_id: string;
    shared_award_source_id: string | null;
  },
) {
  return Boolean(
    evidence.change_event_id === event.id &&
      evidence.shared_award_id === event.shared_award_id &&
      evidence.shared_award_source_id === event.shared_award_source_id,
  );
}

function localizationDirection(value: unknown): "added" | "removed" | "changed" | "mixed" {
  if (value === "added" || value === "removed" || value === "changed" || value === "mixed") {
    return value;
  }
  // Normalize manifests written by the pre-publication prototype so the
  // client only has one semantic direction vocabulary.
  if (value === "previous") return "removed";
  if (value === "current") return "added";
  if (value === "both") return "mixed";
  return "changed";
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
