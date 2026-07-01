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
  const requestUrl = new URL(request.url);
  const [latestFocusRatio, previousFocusRatio] = await Promise.all([
    snapshotFocusRatio(snapshot.latest_object_keys, requestUrl.searchParams.getAll("latest")),
    snapshotFocusRatio(snapshot.previous_object_keys, requestUrl.searchParams.getAll("previous")),
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
      focus_ratio: latestFocusRatio,
    },
    previous: {
      captured_at: snapshot.previous_captured_at,
      hashes: snapshot.previous_hashes,
      metadata: snapshot.previous_metadata,
      objects: previousObjects,
      focus_ratio: previousFocusRatio,
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

async function snapshotFocusRatio(objectKeys: Json, snippets: string[]) {
  const metaKey = objectKey(objectKeys, "meta");
  const cleanSnippets = snippets.map(cleanSnippet).filter(Boolean).slice(0, 5);
  if (!metaKey || cleanSnippets.length === 0) return null;

  try {
    const meta = JSON.parse(await readR2ObjectText(metaKey)) as Record<string, unknown>;
    const layoutSample = layoutSampleFromMeta(meta);
    const scrollHeight = scrollHeightFromMeta(meta);
    if (!layoutSample || !scrollHeight) return null;
    const top = bestLayoutTop(layoutSample, cleanSnippets);
    if (top === null) return null;
    return Math.max(0, Math.min(1, top / Math.max(1, scrollHeight)));
  } catch {
    return null;
  }
}

function objectKey(objectKeys: Json, name: string) {
  const keys = jsonObject(objectKeys);
  const key = keys[name];
  return typeof key === "string" && key ? key : null;
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
