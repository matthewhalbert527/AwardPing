import crypto from "node:crypto";
import {
  dedupeChangeSummaries,
  displayChangeSummary,
  isUsefulChangeForAward,
} from "@/lib/change-summary";
import { isChangeEventSuppressed } from "@/lib/change-event-suppression";
import { readableSourceTitle } from "@/lib/display-text";
import { isMonitorableOfficialSource } from "@/lib/source-url-policy";

export type PublicDigestCandidate = {
  id: string;
  shared_award_id: string;
  shared_award_source_id?: string | null;
  source_title: string | null;
  source_url: string;
  source_page_type?: string | null;
  summary: string;
  change_details?: unknown;
  suppressed_at?: string | null;
  suppression_reason?: string | null;
  suppression_source?: string | null;
  detected_at: string;
};

export type PublicDigestChange = {
  eventId: string;
  awardName: string;
  sourceTitle: string;
  sourceUrl: string;
  summary: string;
  detectedAt: string;
};

export type PublicDigestSubscriber = {
  id: string;
};

export type PublicDigestDelivery = {
  subscriber_id: string;
  status: "sent" | "failed";
};

export type PublicUnsubscribeTokenSubscriber = {
  id: string;
  created_at: string;
};

const fallbackTokenSecret = "awardping-local-public-update-token";

export function normalizePublicUpdateEmail(value: string) {
  return value.trim().toLowerCase();
}

export function createPublicUpdateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function publicDigestKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function createPublicUnsubscribeToken(
  subscriber: PublicUnsubscribeTokenSubscriber,
  secret: string,
) {
  const key = secret || fallbackTokenSecret;
  const payload = `${subscriber.id}:${subscriber.created_at}:unsubscribe`;
  const signature = crypto.createHmac("sha256", key).update(payload).digest("base64url");

  return `${subscriber.id}.${signature}`;
}

export function buildPublicDigestChanges(
  candidates: PublicDigestCandidate[],
  awardNameById: Map<string, string>,
  limit: number | null = 12,
): PublicDigestChange[] {
  const usefulChanges = candidates
    .slice()
    .sort(
      (left, right) =>
        new Date(right.detected_at).getTime() - new Date(left.detected_at).getTime(),
    )
    .filter((change) => {
      const awardName = awardNameById.get(change.shared_award_id) || null;
      return (
        !isChangeEventSuppressed(change) &&
        isMonitorableOfficialSource({ url: change.source_url, page_type: change.source_page_type }) &&
        isUsefulChangeForAward({
          summary: change.summary,
          change_details: change.change_details,
          awardName,
          sourceTitle: change.source_title,
          sourceUrl: change.source_url,
        })
      );
    });

  const deduped = dedupeChangeSummaries(usefulChanges);
  const retained = limit === null ? deduped : deduped.slice(0, limit);
  return retained
    .map((change) => ({
      eventId: change.id,
      awardName: awardNameById.get(change.shared_award_id) || "Tracked award",
      sourceTitle: readableSourceTitle(change.source_title, change.source_url),
      sourceUrl: change.source_url,
      summary: displayChangeSummary(change.summary, change.source_url, change.change_details),
      detectedAt: change.detected_at,
    }));
}

export function pendingPublicDigestChangesForSubscriber(
  changes: PublicDigestChange[],
  digestStartedAt: string,
  reservedEventIds: ReadonlySet<string>,
) {
  const startedAt = Date.parse(digestStartedAt);
  if (!Number.isFinite(startedAt)) {
    throw new Error("Subscriber digest start time is invalid.");
  }
  return changes
    .filter((change) => {
      const detectedAt = Date.parse(change.detectedAt);
      if (!Number.isFinite(detectedAt)) {
        throw new Error(`Digest event ${change.eventId} has an invalid detection time.`);
      }
      return detectedAt >= startedAt && !reservedEventIds.has(change.eventId);
    })
    .sort((left, right) =>
      Date.parse(left.detectedAt) - Date.parse(right.detectedAt) ||
      left.eventId.localeCompare(right.eventId),
    );
}

export function splitPublicDigestChanges(
  changes: PublicDigestChange[],
  batchSize = 12,
) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 12) {
    throw new Error("Public digest presentation batches must contain 1-12 events.");
  }
  const batches: PublicDigestChange[][] = [];
  for (let start = 0; start < changes.length; start += batchSize) {
    batches.push(changes.slice(start, start + batchSize));
  }
  return batches;
}

export function filterSubscribersWithoutDigestDelivery<
  Subscriber extends PublicDigestSubscriber,
  Delivery extends PublicDigestDelivery,
>(subscribers: Subscriber[], deliveries: Delivery[]) {
  const deliveredSubscriberIds = new Set(
    deliveries
      .filter((delivery) => delivery.status === "sent")
      .map((delivery) => delivery.subscriber_id),
  );

  return subscribers.filter((subscriber) => !deliveredSubscriberIds.has(subscriber.id));
}
