import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { hasSupabaseAdminConfig, hasSupabaseConfig } from "@/lib/config";
import { canManageOffice, requireOfficeContext } from "@/lib/offices";
import {
  trackSharedAwardForOffice,
  untrackSharedAwardForOffice,
} from "@/lib/shared-awards";
import {
  getStage1PublicationEntryForAward,
  isStage1SourceIdentityExcluded,
} from "@/lib/stage1-publication";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSameOriginMutationRequest } from "@/lib/same-origin-mutation";

export const runtime = "nodejs";

const trackSchema = z.object({
  cadence: z.literal("daily").default("daily"),
});

type Props = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: Props) {
  if (!isSameOriginMutationRequest(request)) {
    return NextResponse.json({ error: "This request is not allowed." }, { status: 403 });
  }

  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  if (!hasSupabaseAdminConfig()) {
    return NextResponse.json(
      { error: "Shared award directory is not configured." },
      { status: 503 },
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const officeContext = await requireOfficeContext(user);
  if (!canManageOffice(officeContext.current.role)) {
    return NextResponse.json(
      { error: "Only office owners and admins can track shared awards." },
      { status: 403 },
    );
  }

  const { id } = await params;
  const publication = await getStage1PublicationEntryForAward(id);
  if (!publication?.effectivelyVerified) {
    return NextResponse.json({ error: "Shared award was not found." }, { status: 404 });
  }
  const parsed = trackSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the tracking cadence." }, { status: 400 });
  }

  if (!publication.registry.release_epoch) {
    return NextResponse.json({ error: "Shared award was not found." }, { status: 404 });
  }
  const admin = createSupabaseAdminClient();
  const { data: sharedSources, error: sharedSourcesError } = await admin
    .from("shared_award_sources")
    .select("*")
    .in("shared_award_id", publication.memberAwardIds)
    .eq("admin_review_status", "open")
    .order("created_at", { ascending: true });

  if (sharedSourcesError) {
    return NextResponse.json({ error: sharedSourcesError.message }, { status: 500 });
  }

  const publicSharedSources = (sharedSources || []).filter(
    (source) =>
      publication.allowedSourceIdSet.has(source.id) &&
      !isStage1SourceIdentityExcluded(publication, source),
  );
  if (publicSharedSources.length === 0) {
    return NextResponse.json(
      { error: "This shared award does not have trackable source pages yet." },
      { status: 400 },
    );
  }

  try {
    const supabase = await createSupabaseServerClient();
    const result = await trackSharedAwardForOffice({
      supabase,
      canonicalSharedAwardId: publication.canonicalAwardId,
      sharedSources: publicSharedSources,
      officeId: officeContext.current.officeId,
      cadence: parsed.data.cadence,
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
            : "Shared award could not be tracked.",
      },
      { status: trackingMutationStatus(error) },
    );
  }
}

export async function DELETE(request: Request, { params }: Props) {
  if (!isSameOriginMutationRequest(request)) {
    return NextResponse.json({ error: "This request is not allowed." }, { status: 403 });
  }

  if (!hasSupabaseConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  if (!hasSupabaseAdminConfig()) {
    return NextResponse.json(
      { error: "Shared award directory is not configured." },
      { status: 503 },
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Log in first." }, { status: 401 });
  }

  const officeContext = await requireOfficeContext(user);
  if (!canManageOffice(officeContext.current.role)) {
    return NextResponse.json(
      { error: "Only office owners and admins can untrack shared awards." },
      { status: 403 },
    );
  }

  const { id } = await params;
  const publication = await getStage1PublicationEntryForAward(id);
  try {
    const supabase = await createSupabaseServerClient();
    const result = await untrackSharedAwardForOffice({
      supabase,
      officeId: officeContext.current.officeId,
      requestedSharedAwardId: id,
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
            : "Shared award could not be untracked.",
      },
      { status: trackingMutationStatus(error) },
    );
  }
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
