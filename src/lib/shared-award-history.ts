import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtractedContent } from "@/lib/extract";
import type { Database, Json } from "@/lib/database.types";
import { generateChangeDetailsForSource } from "@/lib/change-details-ai";

type AdminClient = SupabaseClient<Database>;
type Monitor = Database["public"]["Tables"]["monitors"]["Row"];
type SharedAwardSource = Database["public"]["Tables"]["shared_award_sources"]["Row"];

const sharedSourceCheckMinutes = 90;

export async function recordSharedAwardSourceCheck(input: {
  supabase: AdminClient;
  monitor: Monitor;
  content: ExtractedContent;
  previousSample?: string | null;
}) {
  const context = await getMonitorSharedSource(input.supabase, input.monitor);
  if (!context) return null;

  const now = new Date().toISOString();
  const previousHash = context.sharedSource.last_hash;
  const previousSharedSnapshot = previousHash
    ? await getSharedSnapshotByHash(
        input.supabase,
        context.sharedSource.shared_award_id,
        context.sharedSource.url,
        previousHash,
      )
    : null;

  const newSnapshot = await upsertSharedSnapshot(input.supabase, {
    sharedAwardId: context.sharedSource.shared_award_id,
    sharedAwardSourceId: context.sharedSource.id,
    sourceUrl: context.sharedSource.url,
    sourceTitle: context.sharedSource.title,
    sourcePageType: context.sharedSource.page_type,
    content: input.content,
    createdAt: now,
  });

  let sharedChangeInserted = false;
  if (previousHash && previousHash !== input.content.hash) {
    const previousSample =
      previousSharedSnapshot?.text_sample || input.previousSample || null;
    const changeDetails = await generateChangeDetailsForSource({
      previousSample,
      nextText: input.content.text,
      source: {
        source_title: context.sharedSource.title,
        source_url: context.sharedSource.url,
        page_type: context.sharedSource.page_type,
      },
    });
    const summary = changeDetails.reader_summary;

    if (changeDetails.is_alert_worthy) {
      const { error } = await input.supabase
        .from("shared_award_change_events")
        .upsert(
          {
            shared_award_id: context.sharedSource.shared_award_id,
            shared_award_source_id: context.sharedSource.id,
            source_url: context.sharedSource.url,
            source_title: context.sharedSource.title,
            source_page_type: context.sharedSource.page_type,
            previous_snapshot_id: previousSharedSnapshot?.id || null,
            new_snapshot_id: newSnapshot?.id || null,
            previous_hash: previousHash,
            new_hash: input.content.hash,
            summary,
            change_details: changeDetails as Json,
            first_reported_by_office_id: input.monitor.office_id,
            first_reported_by_monitor_id: input.monitor.id,
            detected_at: now,
          },
          {
            onConflict: "shared_award_id,source_url,previous_hash,new_hash",
            ignoreDuplicates: true,
          },
        );

      if (error) throw error;
      sharedChangeInserted = true;
    }
  }

  await input.supabase
    .from("shared_award_sources")
    .update({
      last_hash: input.content.hash,
      last_checked_at: now,
      next_check_at: nextSharedSourceCheckDate(),
      consecutive_failures: 0,
      last_error: null,
      updated_at: now,
    })
    .eq("id", context.sharedSource.id);

  return {
    sharedAwardId: context.sharedSource.shared_award_id,
    sharedAwardSourceId: context.sharedSource.id,
    sharedChangeInserted,
  };
}

async function getMonitorSharedSource(supabase: AdminClient, monitor: Monitor) {
  if (monitor.shared_award_source_id) {
    const { data, error } = await supabase
      .from("shared_award_sources")
      .select("*")
      .eq("id", monitor.shared_award_source_id)
      .maybeSingle();

    if (error) throw error;
    if (data) return { sharedSource: data };
  }

  if (!monitor.award_id) return null;

  const { data: award, error: awardError } = await supabase
    .from("awards")
    .select("shared_award_id")
    .eq("id", monitor.award_id)
    .maybeSingle();

  if (awardError) throw awardError;
  if (!award?.shared_award_id) return null;

  const { data: sharedSource, error: sourceError } = await supabase
    .from("shared_award_sources")
    .select("*")
    .eq("shared_award_id", award.shared_award_id)
    .eq("url", monitor.url)
    .maybeSingle();

  if (sourceError) throw sourceError;
  if (!sharedSource) return null;

  await supabase
    .from("monitors")
    .update({ shared_award_source_id: sharedSource.id })
    .eq("id", monitor.id);

  return { sharedSource };
}

async function getSharedSnapshotByHash(
  supabase: AdminClient,
  sharedAwardId: string,
  sourceUrl: string,
  hash: string,
) {
  const { data, error } = await supabase
    .from("shared_award_source_snapshots")
    .select("id, text_sample")
    .eq("shared_award_id", sharedAwardId)
    .eq("source_url", sourceUrl)
    .eq("hash", hash)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function upsertSharedSnapshot(
  supabase: AdminClient,
  input: {
    sharedAwardId: string;
    sharedAwardSourceId: string | null;
    sourceUrl: string;
    sourceTitle: string | null;
    sourcePageType: SharedAwardSource["page_type"] | null;
    content: ExtractedContent;
    createdAt: string;
  },
) {
  const row = {
    shared_award_id: input.sharedAwardId,
    shared_award_source_id: input.sharedAwardSourceId,
    source_url: input.sourceUrl,
    source_title: input.sourceTitle,
    source_page_type: input.sourcePageType,
    hash: input.content.hash,
    text_sample: input.content.sample,
    byte_length: input.content.byteLength,
    status_code: input.content.statusCode,
    content_type: input.content.contentType,
    created_at: input.createdAt,
  };

  const { data, error } = await supabase
    .from("shared_award_source_snapshots")
    .upsert(row, {
      onConflict: "shared_award_id,source_url,hash",
      ignoreDuplicates: true,
    })
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (data) return data;

  const { data: existing, error: existingError } = await supabase
    .from("shared_award_source_snapshots")
    .select("id, text_sample")
    .eq("shared_award_id", input.sharedAwardId)
    .eq("source_url", input.sourceUrl)
    .eq("hash", input.content.hash)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing && existing.text_sample !== input.content.sample) {
    const { error: refreshError } = await supabase
      .from("shared_award_source_snapshots")
      .update({
        shared_award_source_id: input.sharedAwardSourceId,
        source_title: input.sourceTitle,
        source_page_type: input.sourcePageType,
        text_sample: input.content.sample,
        byte_length: input.content.byteLength,
        status_code: input.content.statusCode,
        content_type: input.content.contentType,
      })
      .eq("id", existing.id);

    if (refreshError) throw refreshError;
  }
  return existing;
}

function nextSharedSourceCheckDate() {
  return new Date(Date.now() + sharedSourceCheckMinutes * 60 * 1000).toISOString();
}
