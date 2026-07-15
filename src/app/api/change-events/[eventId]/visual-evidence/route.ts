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
        "id, shared_award_id, shared_award_source_id, source_url, source_title, source_page_type, suppressed_at",
      )
      .eq("id", eventId)
      .maybeSingle(),
    admin
      .from("shared_award_change_event_visual_evidence")
      .select(
        "change_event_id, shared_award_id, shared_award_source_id, bucket, evidence_status, previous_capture, current_capture, localization, evidence_schema_version",
      )
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
  if (!(await canViewEventEvidence(admin, user, event))) {
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
  let previous: EventVisualEvidenceSide;
  let latest: EventVisualEvidenceSide;
  try {
    [previous, latest] = await Promise.all([
      buildEventVisualEvidenceSide({
        captureValue: evidence.previous_capture,
        localizationValue: localizationSides.previous,
        signObjectKey: createR2SignedReadUrl,
      }),
      buildEventVisualEvidenceSide({
        captureValue: evidence.current_capture,
        localizationValue: localizationSides.current,
        signObjectKey: createR2SignedReadUrl,
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
    evidence_status: evidence.evidence_status,
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
    shared_award_id: string;
    shared_award_source_id: string | null;
    suppressed_at: string | null;
  },
) {
  if (isSiteAdminEmail(user?.email)) return true;
  if (event.suppressed_at || !event.shared_award_source_id) return false;

  const [awardResult, sourceResult] = await Promise.all([
    admin
      .from("shared_awards")
      .select("id")
      .eq("id", event.shared_award_id)
      .eq("status", "active")
      .maybeSingle(),
    admin
      .from("shared_award_sources")
      .select("id")
      .eq("id", event.shared_award_source_id)
      .eq("shared_award_id", event.shared_award_id)
      .eq("admin_review_status", "open")
      .maybeSingle(),
  ]);

  if (awardResult.error || sourceResult.error) return false;
  return Boolean(awardResult.data && sourceResult.data);
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
