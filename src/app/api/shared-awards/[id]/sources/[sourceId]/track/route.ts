import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { canManageOffice, requireOfficeContext } from "@/lib/offices";
import {
  trackSharedAwardForOffice,
  untrackSharedAwardSourceForOffice,
} from "@/lib/shared-awards";
import {
  getStage1PublicationEntryForAward,
  isStage1SourceIdentityExcluded,
} from "@/lib/stage1-publication";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSameOriginMutationRequest } from "@/lib/same-origin-mutation";

export const runtime = "nodejs";

type Props = {
  params: Promise<{ id: string; sourceId: string }>;
};

export async function POST(request: Request, { params }: Props) {
  if (!isSameOriginMutationRequest(request)) {
    return NextResponse.json({ error: "This request is not allowed." }, { status: 403 });
  }

  const setupError = validateSetup();
  if (setupError) return setupError;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const officeContext = await requireOfficeContext(user);
  if (!canManageOffice(officeContext.current.role)) {
    return NextResponse.json(
      { error: "Only office owners and admins can track award source pages." },
      { status: 403 },
    );
  }

  const { id, sourceId } = await params;
  const publication = await getStage1PublicationEntryForAward(id);
  if (!publication?.effectivelyVerified) {
    return NextResponse.json({ error: "Award source page was not found." }, { status: 404 });
  }
  if (!publication.registry.release_epoch) {
    return NextResponse.json({ error: "Award source page was not found." }, { status: 404 });
  }
  const admin = createSupabaseAdminClient();
  const { data: sharedSource, error: sharedSourceError } = await admin
    .from("shared_award_sources")
    .select("*")
    .eq("id", sourceId)
    .in("shared_award_id", publication.memberAwardIds)
    .eq("admin_review_status", "open")
    .maybeSingle();

  if (sharedSourceError) {
    return NextResponse.json({ error: sharedSourceError.message }, { status: 500 });
  }

  if (
    !sharedSource ||
    !publication.allowedSourceIdSet.has(sharedSource.id) ||
    isStage1SourceIdentityExcluded(publication, sharedSource)
  ) {
    return NextResponse.json({ error: "Award source page was not found." }, { status: 404 });
  }

  try {
    const supabase = await createSupabaseServerClient();
    const result = await trackSharedAwardForOffice({
      supabase,
      canonicalSharedAwardId: publication.canonicalAwardId,
      sharedSources: [sharedSource],
      officeId: officeContext.current.officeId,
      cadence: "daily",
      expectedMemberSharedAwardIds: publication.memberAwardIds,
      expectedReleaseEpoch: publication.registry.release_epoch,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Award source page could not be tracked.",
      },
      { status: trackingMutationStatus(error) },
    );
  }
}

export async function DELETE(request: Request, { params }: Props) {
  if (!isSameOriginMutationRequest(request)) {
    return NextResponse.json({ error: "This request is not allowed." }, { status: 403 });
  }

  const setupError = validateSetup();
  if (setupError) return setupError;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const officeContext = await requireOfficeContext(user);
  if (!canManageOffice(officeContext.current.role)) {
    return NextResponse.json(
      { error: "Only office owners and admins can untrack award source pages." },
      { status: 403 },
    );
  }

  const { id, sourceId } = await params;
  const publication = await getStage1PublicationEntryForAward(id);
  try {
    const supabase = await createSupabaseServerClient();
    const result = await untrackSharedAwardSourceForOffice({
      supabase,
      officeId: officeContext.current.officeId,
      requestedSharedAwardId: id,
      sharedAwardSourceId: sourceId,
      expectedMemberSharedAwardIds: publication?.memberAwardIds || null,
      expectedReleaseEpoch: publication?.registry.release_epoch || null,
      validateReleaseEpoch: Boolean(publication),
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Award source page could not be untracked.",
      },
      { status: trackingMutationStatus(error) },
    );
  }
}

function validateSetup() {
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  if (!hasSupabaseAdminConfig()) {
    return NextResponse.json(
      { error: "Shared award directory is not configured." },
      { status: 503 },
    );
  }

  return null;
}

function trackingMutationStatus(error: unknown) {
  const code =
    error instanceof Error && "code" in error
      ? String((error as Error & { code?: string }).code || "")
      : "";
  if (code === "40001") return 409;
  if (code === "42501" || code === "28000") return 403;
  if (code === "P0002") return 404;
  return 500;
}
