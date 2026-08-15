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

export type PublicConfirmationTokenSubscriber = PublicUnsubscribeTokenSubscriber & {
  email_hash: string;
  attempted_at: string;
};

export type PublicConfirmationLifecycleState = {
  status: "pending" | "active" | "unsubscribed";
  confirmation_sent_at: string | null;
  updated_at: string;
};

export type PublicConfirmationAttemptPlan =
  | {
      shouldSendConfirmation: false;
      attemptSeal: null;
      reason: "active" | "pending_confirmation_fresh";
    }
  | {
      shouldSendConfirmation: true;
      attemptSeal: string;
      reason:
        | "pending_delivery_retry"
        | "pending_confirmation_expired"
        | "resubscribe";
    };

const fallbackTokenSecret = "awardping-local-public-update-token";
export const PUBLIC_UPDATE_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

export function normalizePublicUpdateEmail(value: string) {
  return value.trim().toLowerCase();
}

export function createPublicConfirmationToken(
  subscriber: PublicConfirmationTokenSubscriber,
  secret: string,
) {
  const key = tokenSigningKey(secret);
  const payload = [
    subscriber.id,
    subscriber.created_at,
    subscriber.email_hash,
    subscriber.attempted_at,
    "confirmation:v1",
  ].join(":");
  const signature = crypto
    .createHmac("sha256", key)
    .update(payload)
    .digest("base64url");

  return `${subscriber.id}.${signature}`;
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function publicUpdateConfirmationExpiresAt(sentAt: string) {
  const sentAtMs = requireTimestamp(sentAt, "confirmation sent time");
  return new Date(sentAtMs + PUBLIC_UPDATE_CONFIRMATION_TTL_MS).toISOString();
}

export function isPublicUpdateConfirmationFresh(
  sentAt: string | null,
  now = new Date(),
) {
  if (sentAt === null) return false;
  const sentAtMs = Date.parse(sentAt);
  const nowMs = now.getTime();
  return (
    Number.isFinite(sentAtMs) &&
    Number.isFinite(nowMs) &&
    sentAtMs <= nowMs &&
    nowMs < sentAtMs + PUBLIC_UPDATE_CONFIRMATION_TTL_MS
  );
}

export function planPublicUpdateConfirmationAttempt(
  state: PublicConfirmationLifecycleState,
  now = new Date(),
): PublicConfirmationAttemptPlan {
  if (state.status === "active") {
    return {
      shouldSendConfirmation: false,
      attemptSeal: null,
      reason: "active",
    };
  }

  if (
    state.status === "pending" &&
    isPublicUpdateConfirmationFresh(state.confirmation_sent_at, now)
  ) {
    return {
      shouldSendConfirmation: false,
      attemptSeal: null,
      reason: "pending_confirmation_fresh",
    };
  }

  if (state.status === "pending" && state.confirmation_sent_at !== null) {
    return {
      shouldSendConfirmation: true,
      attemptSeal: publicUpdateConfirmationExpiresAt(state.confirmation_sent_at),
      reason: "pending_confirmation_expired",
    };
  }

  const priorStateSealMs = requireTimestamp(
    state.updated_at,
    "subscriber update time",
  );
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("Public-update confirmation planning time is invalid.");
  }
  const elapsedWindows = Math.max(
    0,
    Math.floor((nowMs - priorStateSealMs) / PUBLIC_UPDATE_CONFIRMATION_TTL_MS),
  );
  const attemptSeal = new Date(
    priorStateSealMs + elapsedWindows * PUBLIC_UPDATE_CONFIRMATION_TTL_MS,
  ).toISOString();
  return {
    shouldSendConfirmation: true,
    attemptSeal,
    reason:
      state.status === "pending" ? "pending_delivery_retry" : "resubscribe",
  };
}

export function publicDigestKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function createPublicUnsubscribeToken(
  subscriber: PublicUnsubscribeTokenSubscriber,
  secret: string,
) {
  const key = tokenSigningKey(secret);
  const payload = `${subscriber.id}:${subscriber.created_at}:unsubscribe`;
  const signature = crypto.createHmac("sha256", key).update(payload).digest("base64url");

  return `${subscriber.id}.${signature}`;
}

function tokenSigningKey(secret: string) {
  const material = secret.trim();
  if (
    process.env.NODE_ENV === "production" &&
    (material.length < 24 || material === fallbackTokenSecret)
  ) {
    throw new Error("A strong production public-update token secret is required.");
  }
  return material || fallbackTokenSecret;
}

function requireTimestamp(value: string, label: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Public-update ${label} is invalid.`);
  }
  return timestamp;
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
