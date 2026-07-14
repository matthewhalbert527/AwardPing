import { NextResponse } from "next/server";
import { getCurrentUser, isSiteAdminEmail } from "@/lib/auth";
import {
  hasR2Config,
  hasSupabaseAdminConfig,
  hasSupabaseConfig,
  appConfig,
} from "@/lib/config";
import type { Json } from "@/lib/database.types";
import { createR2SignedReadUrl, getR2Bucket, readR2ObjectText } from "@/lib/r2";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type Props = {
  params: Promise<{ sourceId: string }>;
};

type SnapshotObject = {
  key: string;
  url: string;
};

export async function GET(request: Request, { params }: Props) {
  if (!hasSupabaseConfig() || !hasSupabaseAdminConfig()) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  if (!hasR2Config()) {
    return NextResponse.json({ error: "Cloudflare R2 is not configured." }, { status: 503 });
  }

  const { sourceId } = await params;
  const user = await getCurrentUser();
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
    return NextResponse.json({ error: "This snapshot is not available." }, { status: user ? 403 : 404 });
  }

  const [latestObjects, previousObjects, latestMetaResult, previousMetaResult] = await Promise.all([
    createSignedSnapshotObjects(snapshot.latest_object_keys),
    createSignedSnapshotObjects(snapshot.previous_object_keys),
    loadSnapshotMeta(snapshot.latest_object_keys),
    loadSnapshotMeta(snapshot.previous_object_keys),
  ]);
  const requestUrl = new URL(request.url);
  const imagesMatch = snapshotImageHash(snapshot.latest_hashes) === snapshotImageHash(snapshot.previous_hashes) &&
    Boolean(snapshotImageHash(snapshot.latest_hashes));
  const latestFocus = snapshotFocusResult({
    metaResult: latestMetaResult,
    fallbackMetaResult: imagesMatch ? previousMetaResult : null,
    snippets: requestUrl.searchParams.getAll("latest"),
    objectKeys: snapshot.latest_object_keys,
    recordMetadata: snapshot.latest_metadata,
    version: "latest",
  });
  const previousFocus = snapshotFocusResult({
    metaResult: previousMetaResult,
    fallbackMetaResult: imagesMatch ? latestMetaResult : null,
    snippets: requestUrl.searchParams.getAll("previous"),
    objectKeys: snapshot.previous_object_keys,
    recordMetadata: snapshot.previous_metadata,
    version: "previous",
  });

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
      focus_ratio: latestFocus.ratio,
      localization_status: latestFocus.status,
      localization_reason: latestFocus.reason,
    },
    previous: {
      captured_at: snapshot.previous_captured_at,
      hashes: snapshot.previous_hashes,
      metadata: snapshot.previous_metadata,
      objects: previousObjects,
      focus_ratio: previousFocus.ratio,
      localization_status: previousFocus.status,
      localization_reason: previousFocus.reason,
    },
  });
}

async function canViewSnapshot(
  user: { id: string; email?: string | null } | null,
  sharedAwardId: string,
  sharedAwardSourceId: string,
) {
  if (isSiteAdminEmail(user?.email)) return true;

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
        .eq("admin_review_status", "open")
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

async function loadSnapshotMeta(objectKeys: Json) {
  const metaKey = objectKey(objectKeys, "meta");
  if (!metaKey) return { meta: null, error: null };
  try {
    return {
      meta: JSON.parse(await readR2ObjectText(metaKey)) as Record<string, unknown>,
      error: null,
    };
  } catch {
    return { meta: null, error: "Snapshot metadata could not be read." };
  }
}

function snapshotFocusResult({
  metaResult,
  fallbackMetaResult,
  snippets,
  objectKeys,
  recordMetadata,
  version,
}: {
  metaResult: { meta: Record<string, unknown> | null; error: string | null };
  fallbackMetaResult: { meta: Record<string, unknown> | null; error: string | null } | null;
  snippets: string[];
  objectKeys: Json;
  recordMetadata: Json;
  version: "latest" | "previous";
}) {
  const cleanSnippets = snippets.map(cleanSnippet).filter(Boolean).slice(0, 5);
  if (!hasVisualSnapshotObject(objectKeys)) {
    return { ratio: null, status: "not_applicable", reason: "No screenshot image is retained." };
  }
  if (cleanSnippets.length === 0) {
    return { ratio: null, status: "not_requested", reason: "No exact change text was supplied." };
  }

  const candidates = [
    { result: metaResult, status: "localized" },
    { result: fallbackMetaResult, status: "localized_via_identical_version" },
  ];
  let hadLayout = false;
  for (const candidate of candidates) {
    if (!candidate.result?.meta) continue;
    const layoutSample = layoutSampleFromMeta(candidate.result.meta);
    const scrollHeight = scrollHeightFromMeta(candidate.result.meta);
    if (!layoutSample || !scrollHeight) continue;
    hadLayout = true;
    const top = bestLayoutTop(layoutSample, cleanSnippets);
    if (top === null) continue;
    return {
      ratio: Math.max(0, Math.min(1, top / Math.max(1, scrollHeight))),
      status: candidate.status,
      reason: candidate.status === "localized"
        ? "Exact change text matched this screenshot's layout metadata."
        : "Exact change text matched layout metadata from the identical retained version.",
    };
  }

  if (hadLayout) {
    return {
      ratio: null,
      status: "evidence_not_found",
      reason: "The exact change text was not found in this retained screenshot.",
    };
  }
  const localization = jsonObject(jsonObject(recordMetadata).localization as Json);
  if (localization.status === "capture_layout_unavailable") {
    return {
      ratio: null,
      status: "capture_layout_unavailable",
      reason: "The page produced no searchable visual layout during localization capture.",
    };
  }
  return {
    ratio: null,
    status: version === "previous" ? "historical_layout_unavailable" : "repair_needed",
    reason: version === "previous"
      ? "This historical screenshot predates location metadata."
      : metaResult.error || "This screenshot still needs localization metadata.",
  };
}

function objectKey(objectKeys: Json, name: string) {
  const keys = jsonObject(objectKeys);
  const key = keys[name];
  return typeof key === "string" && key ? key : null;
}

function hasVisualSnapshotObject(objectKeys: Json) {
  return Boolean(objectKey(objectKeys, "page") || objectKey(objectKeys, "thumb"));
}

function snapshotImageHash(value: Json) {
  const hashes = jsonObject(value);
  const hash = hashes.image_hash;
  return typeof hash === "string" ? hash : "";
}

function layoutSampleFromMeta(meta: Record<string, unknown>) {
  const pageSettle = meta.page_settle && typeof meta.page_settle === "object"
    ? meta.page_settle as Record<string, unknown>
    : {};
  return typeof pageSettle.after_layout_sample === "string"
    ? pageSettle.after_layout_sample
    : "";
}

function scrollHeightFromMeta(meta: Record<string, unknown>) {
  const dimensions = meta.dimensions && typeof meta.dimensions === "object"
    ? meta.dimensions as Record<string, unknown>
    : {};
  const pageSettle = meta.page_settle && typeof meta.page_settle === "object"
    ? meta.page_settle as Record<string, unknown>
    : {};
  const after = pageSettle.after && typeof pageSettle.after === "object"
    ? pageSettle.after as Record<string, unknown>
    : {};
  const value = numberValue(dimensions.scroll_height) || numberValue(after.scroll_height);
  return value && value > 0 ? value : null;
}

function bestLayoutTop(layoutSample: string, snippets: string[]) {
  let best: { score: number; top: number } | null = null;

  for (const entry of layoutSample.split("|")) {
    const item = parseLayoutSampleEntry(entry);
    if (!item || item.text.length < 4) continue;
    for (const snippet of snippets) {
      const score = layoutMatchScore(item.text, snippet);
      if (score <= 0) continue;
      if (!best || score > best.score) {
        best = {
          score,
          top: Math.max(0, item.top + Math.max(0, item.height) * 0.35),
        };
      }
    }
  }

  return best?.top ?? null;
}

function parseLayoutSampleEntry(entry: string) {
  const parts = entry.split(":");
  if (parts.length < 9) return null;
  const top = numberValue(parts[2]);
  const height = numberValue(parts[4]) || 0;
  const text = cleanText(parts.slice(8).join(":"));
  if (top === null) return null;
  return { top, height, text };
}

function layoutMatchScore(text: string, snippet: string) {
  const haystack = cleanText(text).toLowerCase();
  const needle = cleanText(snippet).toLowerCase();
  if (!haystack || !needle) return 0;
  if (haystack.includes(needle)) return 1000 + needle.length;

  const words = uniqueWords(needle);
  if (words.length < 3) return 0;
  const matched = words.filter((word) => haystack.includes(word));
  const coverage = matched.length / words.length;
  if (matched.length >= 4 && coverage >= 0.5) return Math.round(coverage * 100);
  return 0;
}

function uniqueWords(value: string) {
  return [
    ...new Set(
      (value.match(/[a-z0-9$,.:-]+/gi) || [])
        .map((word) => word.toLowerCase())
        .filter((word) => word.length >= 3),
    ),
  ];
}

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanSnippet(value: string) {
  return cleanText(value)
    .slice(0, 500);
}

function cleanText(value: string) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}
