import { NextResponse } from "next/server";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import {
  hasR2Config,
  hasSupabaseAdminConfig,
  hasSupabaseConfig,
  appConfig,
} from "@/lib/config";
import type { Json } from "@/lib/database.types";
import { getOfficeContext } from "@/lib/offices";
import { createR2SignedReadUrl, getR2Bucket } from "@/lib/r2";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Props = {
  params: Promise<{ sourceId: string }>;
};

type SnapshotObject = {
  key: string;
  url: string;
};

export async function GET(_request: Request, { params }: Props) {
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  if (!hasR2Config()) {
    return NextResponse.json({ error: "Cloudflare R2 is not configured." }, { status: 503 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication is required." }, { status: 401 });
  }

  const { sourceId } = await params;
  const admin = createSupabaseAdminClient();
  const { data: snapshot, error } = await admin
    .from("shared_award_source_visual_snapshots")
    .select("*")
    .eq("shared_award_source_id", sourceId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!snapshot) {
    return NextResponse.json({ error: "No visual snapshot is available yet." }, { status: 404 });
  }

  if (!(await canViewSnapshot(user, snapshot.shared_award_id, snapshot.shared_award_source_id))) {
    return NextResponse.json({ error: "You do not have access to this snapshot." }, { status: 403 });
  }

  const [latestObjects, previousObjects] = await Promise.all([
    createSignedSnapshotObjects(snapshot.latest_object_keys),
    createSignedSnapshotObjects(snapshot.previous_object_keys),
  ]);

  return NextResponse.json({
    source_id: snapshot.shared_award_source_id,
    shared_award_id: snapshot.shared_award_id,
    source_url: snapshot.source_url,
    source_title: snapshot.source_title,
    source_page_type: snapshot.source_page_type,
    bucket: getR2Bucket(),
    expires_in_seconds: appConfig.r2SignedUrlTtlSeconds,
    latest: {
      captured_at: snapshot.latest_captured_at,
      kind: snapshot.kind,
      hashes: snapshot.latest_hashes,
      metadata: snapshot.latest_metadata,
      objects: latestObjects,
    },
    previous: {
      captured_at: snapshot.previous_captured_at,
      hashes: snapshot.previous_hashes,
      metadata: snapshot.previous_metadata,
      objects: previousObjects,
    },
  });
}

async function canViewSnapshot(
  user: { id: string; email?: string | null },
  sharedAwardId: string,
  sharedAwardSourceId: string,
) {
  if (isSiteAdminEmail(user.email)) return true;

  const officeContext = await getOfficeContext(user);
  if (!officeContext) return false;

  const admin = createSupabaseAdminClient();
  const [{ data: awardRow, error: awardError }, { data: sourceRow, error: sourceError }] =
    await Promise.all([
      admin
        .from("shared_awards")
        .select("id")
        .eq("id", sharedAwardId)
        .eq("status", "active")
        .maybeSingle(),
      admin
        .from("shared_award_sources")
        .select("id")
        .eq("id", sharedAwardSourceId)
        .eq("shared_award_id", sharedAwardId)
        .maybeSingle(),
    ]);

  if (awardError || sourceError) return false;
  return Boolean(awardRow && sourceRow);
}

async function createSignedSnapshotObjects(value: Json) {
  const keys = jsonObject(value);
  const entries = await Promise.all(
    Object.entries(keys)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]))
      .map(async ([name, key]) => [
        name,
        {
          key,
          url: await createR2SignedReadUrl(key),
        } satisfies SnapshotObject,
      ]),
  );

  return Object.fromEntries(entries) as Record<string, SnapshotObject>;
}

function jsonObject(value: Json) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}
