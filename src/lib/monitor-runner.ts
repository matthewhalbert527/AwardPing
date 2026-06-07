import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchExtractedContent } from "@/lib/extract";
import { generateChangeDetailsForSource } from "@/lib/change-details-ai";
import { workflowStatusAfterSourceChange } from "@/lib/award-workflow";
import { recordSharedAwardSourceCheck } from "@/lib/shared-award-history";
import { nextCheckDate } from "@/lib/plans";
import { sendChangeAlertEmail, sendDailyDigestEmail } from "@/lib/email";
import type { Database, Json } from "@/lib/database.types";

type Monitor = Database["public"]["Tables"]["monitors"]["Row"];
type OfficeMember = Database["public"]["Tables"]["office_members"]["Row"];
type ChangeEvent = Database["public"]["Tables"]["change_events"]["Row"];

export async function runDueMonitorChecks(limit = 20) {
  const supabase = createSupabaseAdminClient();

  const { data: monitors, error } = await supabase
    .from("monitors")
    .select("*")
    .eq("status", "active")
    .lte("next_check_at", new Date().toISOString())
    .order("next_check_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw error;
  }

  const results = [];
  const hostLastCheckedAt = new Map<string, number>();
  for (const monitor of monitors || []) {
    await waitForHostCooldown(monitor.url, hostLastCheckedAt);
    results.push(await runSingleMonitorCheck(monitor));
  }

  return results;
}

export async function runSingleMonitorCheck(monitor: Monitor) {
  const supabase = createSupabaseAdminClient();

  try {
    const content = await fetchExtractedContent(monitor.url, monitor.content_type);

    const { data: previousSnapshot } = await supabase
      .from("monitor_snapshots")
      .select("id, text_sample, hash")
      .eq("monitor_id", monitor.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: newSnapshot, error: snapshotError } = await supabase
      .from("monitor_snapshots")
      .insert({
        office_id: monitor.office_id,
        monitor_id: monitor.id,
        hash: content.hash,
        text_sample: content.sample,
        byte_length: content.byteLength,
        status_code: content.statusCode,
        content_type: content.contentType,
      })
      .select("id")
      .single();

    if (snapshotError) {
      throw snapshotError;
    }

    const changed = Boolean(monitor.last_hash && monitor.last_hash !== content.hash);
    await recordSharedAwardSourceCheck({
      supabase,
      monitor,
      content,
      previousSample: previousSnapshot?.text_sample || null,
    });

    let alerted = false;
    if (changed) {
      const changeDetails = await generateChangeDetailsForSource({
        previousSample: previousSnapshot?.text_sample || null,
        nextText: content.text,
        source: {
          source_title: monitor.label,
          source_url: monitor.url,
          page_type: monitor.page_type,
        },
      });
      const summary = changeDetails.reader_summary;

      if (changeDetails.is_alert_worthy) {
        const { data: event, error: eventError } = await supabase
          .from("change_events")
          .insert({
            office_id: monitor.office_id,
            monitor_id: monitor.id,
            previous_snapshot_id: previousSnapshot?.id || null,
            new_snapshot_id: newSnapshot.id,
            previous_hash: monitor.last_hash,
            new_hash: content.hash,
            summary,
            change_details: changeDetails as Json,
          })
          .select("id")
          .single();

        if (eventError) {
          throw eventError;
        }

        if (monitor.award_id) {
          const { data: award } = await supabase
            .from("awards")
            .select("workflow_status")
            .eq("id", monitor.award_id)
            .maybeSingle();

          if (award) {
            await supabase
              .from("awards")
              .update({
                workflow_status: workflowStatusAfterSourceChange(award.workflow_status),
                updated_at: new Date().toISOString(),
              })
              .eq("id", monitor.award_id);
          }
        }

        const immediateMembers = monitor.office_id
          ? await getMembersForImmediateAlerts(monitor.office_id)
          : [];

        for (const member of immediateMembers) {
          const recipient = member.email;
          if (!recipient) continue;

          try {
            await sendChangeAlertEmail({
              to: recipient,
              label: monitor.label,
              url: monitor.url,
              summary,
              changeDetails,
            });

            await supabase.from("alert_deliveries").insert({
              office_id: monitor.office_id,
              office_member_id: member.id,
              change_event_id: event.id,
              user_id: member.user_id,
              delivery_type: "immediate",
              recipient,
              status: "sent",
            });

            alerted = true;
          } catch (emailError) {
            await supabase.from("alert_deliveries").insert({
              office_id: monitor.office_id,
              office_member_id: member.id,
              change_event_id: event.id,
              user_id: member.user_id,
              delivery_type: "immediate",
              recipient,
              status: "failed",
              error:
                emailError instanceof Error
                  ? emailError.message
                  : "Email delivery failed.",
            });
          }
        }

        if (alerted) {
          await supabase
            .from("change_events")
            .update({ notified_at: new Date().toISOString() })
            .eq("id", event.id);
        }
      }
    }

    await supabase
      .from("monitors")
      .update({
        last_hash: content.hash,
        last_checked_at: new Date().toISOString(),
        next_check_at: nextCheckDate(monitor.cadence),
        consecutive_failures: 0,
        last_error: null,
        status: "active",
        updated_at: new Date().toISOString(),
      })
      .eq("id", monitor.id);

    return { monitorId: monitor.id, changed, alerted, ok: true };
  } catch (error) {
    const message = describeMonitorError(error);

    await supabase
      .from("monitors")
      .update({
        last_checked_at: new Date().toISOString(),
        next_check_at: nextCheckDate(monitor.cadence),
        consecutive_failures: monitor.consecutive_failures + 1,
        last_error: message,
        status: monitor.consecutive_failures + 1 >= 3 ? "error" : "active",
        updated_at: new Date().toISOString(),
      })
      .eq("id", monitor.id);

    return { monitorId: monitor.id, ok: false, error: message };
  }
}

function describeMonitorError(error: unknown) {
  if (!(error instanceof Error)) return "Unknown monitor failure.";

  const parts = [error.message || "Unknown monitor failure."];
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  if (cause && typeof cause === "object") {
    if (typeof cause.message === "string" && !parts.some((part) => part.includes(cause.message as string))) {
      parts.push(cause.message);
    }

    if (typeof cause.code === "string" && !parts.some((part) => part.includes(cause.code as string))) {
      parts.push(`(${cause.code})`);
    }
  }

  return parts.filter(Boolean).join(": ");
}

async function waitForHostCooldown(rawUrl: string, hostLastCheckedAt: Map<string, number>) {
  const host = hostForUrl(rawUrl);
  if (!host) return;

  const now = Date.now();
  const lastCheckedAt = hostLastCheckedAt.get(host) || 0;
  const waitMs = Math.max(0, 1_500 - (now - lastCheckedAt));
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  hostLastCheckedAt.set(host, Date.now());
}

function hostForUrl(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export async function runDailyDigestDeliveries() {
  const supabase = createSupabaseAdminClient();
  const digestKey = new Date().toISOString().slice(0, 10);

  const { data: offices, error: officesError } = await supabase
    .from("offices")
    .select("id, name");

  if (officesError) throw officesError;

  const results = [];
  for (const office of offices || []) {
    const { data: members, error: membersError } = await supabase
      .from("office_members")
      .select("*")
      .eq("office_id", office.id)
      .eq("status", "active")
      .in("notification_preference", ["daily_digest", "both"]);

    if (membersError) throw membersError;

    const { data: changes, error: changesError } = await supabase
      .from("change_events")
      .select("*")
      .eq("office_id", office.id)
      .gte("detected_at", new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString())
      .order("detected_at", { ascending: false });

    if (changesError) throw changesError;
    if (!changes?.length) continue;

    const monitorIds = [...new Set(changes.map((change) => change.monitor_id))];
    const { data: monitors, error: monitorsError } = await supabase
      .from("monitors")
      .select("id, label, url")
      .in("id", monitorIds);

    if (monitorsError) throw monitorsError;

    const monitorDetails = new Map(
      (monitors || []).map((monitor) => [
        monitor.id,
        { label: monitor.label, url: monitor.url },
      ]),
    );
    const changesWithMonitors = changes.map((change) => ({
      ...change,
      monitors: monitorDetails.get(change.monitor_id) || null,
    }));

    for (const member of members || []) {
      if (!member.email) continue;

      const undelivered = await filterDigestChangesForMember(
        member,
        changesWithMonitors,
      );

      if (undelivered.length === 0) continue;

      try {
        await sendDailyDigestEmail({
          to: member.email,
          officeName: office.name,
          changes: undelivered.map((change) => ({
            label: change.monitors?.label || "Tracked award page",
            url: change.monitors?.url || "",
            summary: change.summary,
            changeDetails: change.change_details,
            detectedAt: change.detected_at,
          })),
        });

        const recipient = member.email;
        await supabase.from("alert_deliveries").insert(
          undelivered.map((change) => ({
            office_id: office.id,
            office_member_id: member.id,
            change_event_id: change.id,
            user_id: member.user_id,
            delivery_type: "digest",
            digest_key: digestKey,
            recipient,
            status: "sent",
          })),
        );

        results.push({ officeId: office.id, memberId: member.id, sent: undelivered.length });
      } catch (error) {
        await supabase.from("alert_deliveries").insert({
          office_id: office.id,
          office_member_id: member.id,
          user_id: member.user_id,
          delivery_type: "digest",
          digest_key: digestKey,
          recipient: member.email,
          status: "failed",
          error: error instanceof Error ? error.message : "Digest email failed.",
        });

        results.push({ officeId: office.id, memberId: member.id, sent: 0, ok: false });
      }
    }
  }

  return results;
}

async function getMembersForImmediateAlerts(officeId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("office_members")
    .select("*")
    .eq("office_id", officeId)
    .eq("status", "active")
    .in("notification_preference", ["immediate", "both"]);

  if (error) throw error;
  return data || [];
}

async function filterDigestChangesForMember(
  member: OfficeMember,
  changes: Array<ChangeEvent & { monitors: { label: string; url: string } | null }>,
) {
  const supabase = createSupabaseAdminClient();
  const changeIds = changes.map((change) => change.id);
  const { data: existing, error } = await supabase
    .from("alert_deliveries")
    .select("change_event_id")
    .eq("office_member_id", member.id)
    .eq("delivery_type", "digest")
    .in("change_event_id", changeIds);

  if (error) throw error;

  const delivered = new Set((existing || []).map((row) => row.change_event_id));
  return changes.filter((change) => !delivered.has(change.id));
}
