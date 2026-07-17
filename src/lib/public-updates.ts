import "server-only";

import crypto from "node:crypto";
import { appConfig, hasSupabaseAdminConfig } from "@/lib/config";
import type { Database, Json } from "@/lib/database.types";
import {
  PublicDigestDeliveryError,
  renderPublicDailyDigestEmail,
  sendFrozenPublicDailyDigestEmail,
  type RenderedPublicDailyDigestEmail,
} from "@/lib/email";
import {
  buildPublicDigestChanges,
  createPublicUnsubscribeToken,
  createPublicUpdateToken,
  hashToken,
  normalizePublicUpdateEmail,
  pendingPublicDigestChangesForSubscriber,
  publicDigestKey,
  splitPublicDigestChanges,
  type PublicDigestCandidate,
} from "@/lib/public-updates-core";
import {
  decryptPersonalData,
  encryptedEmailFields,
  personalDataLookupHash,
} from "@/lib/personal-data";
import { loadEligiblePublicChangeEvents } from "@/lib/public-change-events";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadStage1PublicationIndex } from "@/lib/stage1-publication";

type PublicSubscriberRow =
  Database["public"]["Tables"]["public_update_subscribers"]["Row"];
type PublicSubscriberInsert =
  Database["public"]["Tables"]["public_update_subscribers"]["Insert"];
type SupabaseAdminClient = ReturnType<typeof createSupabaseAdminClient>;

const PUBLIC_DIGEST_READ_PAGE_SIZE = 500;
const PUBLIC_DIGEST_SUBSCRIBER_CHUNK_SIZE = 25;
const PUBLIC_DIGEST_EVENT_CHUNK_SIZE = 75;
const PUBLIC_DIGEST_SUBSCRIBER_SELECT =
  "id, email, email_hash, email_encrypted, status, confirmation_token_hash, unsubscribe_token_hash, confirmation_sent_at, confirmed_at, unsubscribed_at, last_digest_sent_at, digest_started_at, created_at, updated_at";

export async function createOrRefreshPublicUpdateSubscription(rawEmail: string) {
  const email = normalizePublicUpdateEmail(rawEmail);
  const encryptedEmail = encryptedEmailFields(email);
  const supabase = createSupabaseAdminClient();
  const existingResult = await supabase
    .from("public_update_subscribers")
    .select("*")
    .eq("email_hash", encryptedEmail.email_hash)
    .maybeSingle();
  let existing = existingResult.data;

  if (existingResult.error) {
    throw existingResult.error;
  }

  if (!existing) {
    const legacy = await supabase
      .from("public_update_subscribers")
      .select("*")
      .eq("email", email)
      .maybeSingle();

    if (legacy.error) {
      throw legacy.error;
    }

    existing = legacy.data;
  }

  if (existing?.status === "active") {
    return { email, confirmationToken: null, shouldSendConfirmation: false };
  }

  const confirmationToken = createPublicUpdateToken();
  const now = new Date().toISOString();
  const baseSubscriber = existing || {
    id: cryptoRandomUuid(),
    email,
    created_at: now,
  };
  const unsubscribeTokenHash = hashToken(
    createPublicUnsubscribeToken(baseSubscriber, appConfig.cronSecret),
  );

  if (existing) {
    const { error: updateError } = await supabase
      .from("public_update_subscribers")
      .update({
        email: null,
        email_hash: encryptedEmail.email_hash,
        email_encrypted: encryptedEmail.email_encrypted,
        status: "pending",
        confirmation_token_hash: hashToken(confirmationToken),
        unsubscribe_token_hash: unsubscribeTokenHash,
        confirmation_sent_at: now,
        confirmed_at: null,
        unsubscribed_at: null,
        updated_at: now,
      })
      .eq("id", existing.id);

    if (updateError) {
      throw updateError;
    }
  } else {
    const insert: PublicSubscriberInsert = {
      id: baseSubscriber.id,
      email: null,
      email_hash: encryptedEmail.email_hash,
      email_encrypted: encryptedEmail.email_encrypted,
      status: "pending",
      confirmation_token_hash: hashToken(confirmationToken),
      unsubscribe_token_hash: unsubscribeTokenHash,
      confirmation_sent_at: now,
      created_at: now,
      updated_at: now,
    };
    const { error: insertError } = await supabase
      .from("public_update_subscribers")
      .insert(insert);

    if (insertError) {
      throw insertError;
    }
  }

  return { email, confirmationToken, shouldSendConfirmation: true };
}

export async function confirmPublicUpdateSubscription(token: string) {
  const tokenHash = hashToken(token);
  const supabase = createSupabaseAdminClient();
  const { data: subscriber, error } = await supabase
    .from("public_update_subscribers")
    .select("*")
    .eq("confirmation_token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!subscriber) {
    return false;
  }

  const now = new Date().toISOString();
  const unsubscribeTokenHash = hashToken(
    createPublicUnsubscribeToken(subscriber, appConfig.cronSecret),
  );
  const { error: updateError } = await supabase
    .from("public_update_subscribers")
    .update({
      status: "active",
      confirmation_token_hash: null,
      unsubscribe_token_hash: unsubscribeTokenHash,
      confirmed_at: subscriber.confirmed_at || now,
      digest_started_at: now,
      unsubscribed_at: null,
      updated_at: now,
    })
    .eq("id", subscriber.id);

  if (updateError) {
    throw updateError;
  }

  return true;
}

export async function unsubscribePublicUpdateSubscriber(token: string) {
  const tokenHash = hashToken(token);
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc(
    "unsubscribe_public_update_subscriber",
    { p_unsubscribe_token_hash: tokenHash },
  );

  if (error) {
    throw error;
  }
  return data;
}

export async function runPublicUpdateDigestDeliveries(date = new Date()) {
  if (!hasSupabaseAdminConfig()) {
    return {
      digestKey: publicDigestKey(date),
      sent: 0,
      failed: 0,
      skipped: true,
      reason: "Supabase service role is not configured.",
    };
  }

  const enqueue = await enqueuePublicUpdateDigest(date);
  const drain = await drainPublicDigestOutbox();
  return {
    digestKey: publicDigestKey(date),
    sent: drain.sent,
    failed: drain.terminalFailed,
    skipped: enqueue.skipped && drain.claimed === 0,
    reason: enqueue.reason,
    changeCount: enqueue.changeCount,
    subscriberCount: enqueue.subscriberCount,
    enqueued: enqueue.enqueued,
    reactivated: enqueue.reactivated,
    alreadyFrozen: enqueue.alreadyFrozen,
    legacyBlocked: enqueue.legacyBlocked,
    outbox: drain,
  };
}

export async function enqueuePublicUpdateDigest(date = new Date()) {
  const digestKey = publicDigestKey(date);
  const supabase = createSupabaseAdminClient();
  const publicationIndex = await loadStage1PublicationIndex();
  const release = publicationIndex.release;
  if (
    !publicationIndex.available ||
    !release?.effectivelyReleased ||
    !release.releaseEpoch ||
    !release.policyVersion ||
    !release.cohortIdentityVersion ||
    !release.cohortIdentityHash
  ) {
    throw new Error("Stage 1 digest release identity is unavailable.");
  }

  const { error: supersedeError } = await supabase.rpc(
    "supersede_stale_public_digest_reservations",
    {
      p_expected_release_epoch: release.releaseEpoch,
      p_expected_release_policy_version: release.policyVersion,
      p_expected_release_identity_version: release.cohortIdentityVersion,
      p_expected_release_identity_hash: release.cohortIdentityHash,
    },
  );
  if (supersedeError) throw supersedeError;

  const subscribers = await loadAllActivePublicDigestSubscribers(supabase);
  if (!subscribers.length) {
    return {
      ...emptyEnqueueResult(digestKey, "No active public update subscribers."),
      changeCount: 0,
    };
  }

  const digestStartedAt = earliestDigestStart(subscribers);
  const digest = await loadPublicDigestChanges({
    publicationIndex,
    since: digestStartedAt,
  });
  if (!digest.changes.length) {
    return {
      ...emptyEnqueueResult(digestKey, "No useful undelivered public award changes."),
      subscriberCount: subscribers.length,
    };
  }
  const reservedBySubscriber = await loadReservedPublicDigestEvents(
    supabase,
    subscribers.map((subscriber) => subscriber.id),
    digest.changes.map((change) => change.eventId),
  );
  const eventBindingById = new Map(
    digest.eventBindings.map((binding) => [String(binding.eventId), binding]),
  );

  const entries: Json[] = [];
  let pendingEventCount = 0;
  for (const subscriber of subscribers) {
    const pendingChanges = pendingPublicDigestChangesForSubscriber(
      digest.changes,
      subscriber.digest_started_at,
      reservedBySubscriber.get(subscriber.id) || new Set<string>(),
    );
    if (!pendingChanges.length) continue;
    pendingEventCount += pendingChanges.length;
    const email = publicSubscriberEmail(subscriber);
    if (!email) continue;
    const encrypted = encryptedEmailFields(email);
    const recipientEncrypted =
      subscriber.email_encrypted &&
      decryptPersonalData(subscriber.email_encrypted) === email
        ? subscriber.email_encrypted
        : encrypted.email_encrypted;
    const unsubscribeToken = createPublicUnsubscribeToken(
      subscriber,
      appConfig.cronSecret,
    );
    const unsubscribeTokenHash = hashToken(unsubscribeToken);
    if (
      subscriber.email !== null ||
      subscriber.email_hash !== encrypted.email_hash ||
      subscriber.email_encrypted !== recipientEncrypted ||
      subscriber.unsubscribe_token_hash !== unsubscribeTokenHash
    ) {
      const { error: subscriberUpdateError } = await supabase
        .from("public_update_subscribers")
        .update({
          email: null,
          email_hash: encrypted.email_hash,
          email_encrypted: recipientEncrypted,
          unsubscribe_token_hash: unsubscribeTokenHash,
          updated_at: new Date().toISOString(),
        })
        .eq("id", subscriber.id)
        .eq("status", "active");
      if (subscriberUpdateError) throw subscriberUpdateError;
    }
    const unsubscribeUrl = `${appConfig.url}/api/public-updates/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
    for (const batch of splitPublicDigestChanges(pendingChanges)) {
      const eventBindings = batch.map((change) => {
        const binding = eventBindingById.get(change.eventId);
        if (!binding) {
          throw new Error(`Digest event ${change.eventId} lost its immutable binding.`);
        }
        return binding;
      });
      const rendered = renderPublicDailyDigestEmail({
        changes: batch,
        unsubscribeUrl,
      });
      entries.push({
        subscriber_id: subscriber.id,
        recipient_hash: encrypted.email_hash,
        recipient_encrypted: recipientEncrypted,
        rendered_payload: {
          schemaVersion: "public-digest-render-v1",
          digestKey,
          recipientHash: encrypted.email_hash,
          ...rendered,
          release: {
            releaseKey: release.releaseKey,
            releaseEpoch: release.releaseEpoch,
            policyVersion: release.policyVersion,
            identityVersion: release.cohortIdentityVersion,
            identityHash: release.cohortIdentityHash,
          },
          eventBindings,
        },
      });
    }
  }

  let enqueued = 0;
  let reactivated = 0;
  let alreadyFrozen = 0;
  let legacyBlocked = 0;
  for (let start = 0; start < entries.length; start += 100) {
    const { data, error: enqueueError } = await supabase.rpc(
      "enqueue_public_digest_outbox",
      {
        p_digest_key: digestKey,
        p_expected_release_epoch: release.releaseEpoch,
        p_expected_release_policy_version: release.policyVersion,
        p_expected_release_identity_version: release.cohortIdentityVersion,
        p_expected_release_identity_hash: release.cohortIdentityHash,
        p_entries: entries.slice(start, start + 100),
      },
    );
    if (enqueueError) throw enqueueError;
    const result = jsonObject(data);
    enqueued += jsonNumber(result.enqueued);
    reactivated += jsonNumber(result.reactivated);
    alreadyFrozen += jsonNumber(result.already_frozen);
    legacyBlocked += jsonNumber(result.legacy_blocked);
  }
  return {
    digestKey,
    enqueued,
    reactivated,
    alreadyFrozen,
    legacyBlocked,
    skipped: entries.length === 0,
    reason: entries.length === 0 ? "No deliverable subscriber addresses." : undefined,
    changeCount: pendingEventCount,
    subscriberCount: subscribers.length,
    batchCount: entries.length,
  };
}

export async function drainPublicDigestOutbox({
  limit = 25,
  workerId = `public-digest:${process.env.VERCEL_REGION || "local"}:${crypto.randomUUID()}`,
}: {
  limit?: number;
  workerId?: string;
} = {}) {
  if (!hasSupabaseAdminConfig()) {
    return {
      claimed: 0,
      sent: 0,
      retryQueued: 0,
      ambiguous: 0,
      terminalFailed: 0,
      releaseBlocked: 0,
      skipped: true,
    };
  }
  const supabase = createSupabaseAdminClient();
  const { data: claims, error } = await supabase.rpc(
    "claim_public_digest_outbox",
    { p_worker_id: workerId, p_limit: limit, p_lease_seconds: 300 },
  );
  if (error) throw error;

  const result = {
    claimed: claims?.length || 0,
    sent: 0,
    retryQueued: 0,
    ambiguous: 0,
    terminalFailed: 0,
    releaseBlocked: 0,
    skipped: false,
  };
  for (const claim of claims || []) {
    const { data: authorized, error: authorizeError } = await supabase.rpc(
      "authorize_public_digest_send",
      { p_outbox_id: claim.id, p_lease_token: claim.lease_token },
    );
    if (authorizeError) throw authorizeError;
    if (!authorized) {
      result.releaseBlocked += 1;
      continue;
    }

    let providerAccepted = false;
    try {
      const recipient = decryptPersonalData(claim.recipient_encrypted);
      if (!recipient || personalDataLookupHash(recipient) !== claim.recipient_hash) {
        throw new PublicDigestDeliveryError(
          "The frozen digest recipient could not be verified.",
          false,
          false,
        );
      }
      const payload = frozenRenderedPayload(claim.rendered_payload);
      const provider = await sendFrozenPublicDailyDigestEmail({
        ...payload,
        to: recipient,
        idempotencyKey: claim.provider_idempotency_key,
      });
      providerAccepted = true;
      const { data: completed, error: completionError } = await supabase.rpc(
        "complete_public_digest_send",
        {
          p_outbox_id: claim.id,
          p_lease_token: claim.lease_token,
          p_provider_message_id: provider.providerMessageId,
        },
      );
      if (completionError || !completed) {
        throw new PublicDigestDeliveryError(
          `Provider accepted the digest but completion was not durably recorded${
            completionError ? `: ${completionError.message}` : "."
          }`,
          true,
          true,
        );
      }
      result.sent += 1;
    } catch (deliveryError) {
      const classified = classifyDigestDeliveryError(deliveryError, providerAccepted);
      const { data: nextStatus, error: failureError } = await supabase.rpc(
        "fail_public_digest_send",
        {
          p_outbox_id: claim.id,
          p_lease_token: claim.lease_token,
          p_error: classified.message,
          p_ambiguous: classified.ambiguous,
          p_retryable: classified.retryable,
        },
      );
      if (failureError) {
        throw new AggregateError(
          [deliveryError, failureError],
          "Digest delivery outcome and retry state could not both be persisted.",
        );
      }
      if (nextStatus === "queued") result.retryQueued += 1;
      else if (nextStatus === "ambiguous") result.ambiguous += 1;
      else if (nextStatus === "sent") result.sent += 1;
      else if (nextStatus === "release_blocked") result.releaseBlocked += 1;
      else result.terminalFailed += 1;
    }
  }
  return result;
}

async function loadPublicDigestChanges({
  publicationIndex,
  since,
}: {
  publicationIndex: Awaited<ReturnType<typeof loadStage1PublicationIndex>>;
  since: string;
}) {
  const supabase = createSupabaseAdminClient();
  if (!publicationIndex.available || publicationIndex.verifiedMemberAwardIds.length === 0) {
    return { changes: [], eventBindings: [], publicationIndex: null };
  }
  const eligibleEvents = await loadEligiblePublicChangeEvents({
    admin: supabase,
    publicationIndex,
    limit: null,
    since,
  });

  const awardNameById = new Map(
    publicationIndex.verifiedEntries.map((publication) => [
      publication.canonicalAwardId,
      publication.registry.canonical_name,
    ]),
  );
  const canonicalChangeRows = eligibleEvents.map(({ event, publication }) => ({
    ...event,
    shared_award_id: publication.canonicalAwardId,
  }));

  const changes = buildPublicDigestChanges(
      canonicalChangeRows as PublicDigestCandidate[],
      awardNameById,
      null,
    );
  const eligibleByEventId = new Map(
    eligibleEvents.map((eligible) => [eligible.event.id, eligible]),
  );
  const eventBindings = changes.map((change) => {
    const eligible = eligibleByEventId.get(change.eventId);
    if (!eligible?.event.shared_award_source_id) {
      throw new Error("A public digest event lost its immutable source binding.");
    }
    return {
      eventId: change.eventId,
      memberAwardId: eligible.event.shared_award_id,
      awardId: eligible.publication.canonicalAwardId,
      awardName: change.awardName,
      sourceId: eligible.event.shared_award_source_id,
      eventSourceTitle: eligible.event.source_title,
      sourceTitle: change.sourceTitle,
      sourceUrl: change.sourceUrl,
      eventSourcePageType: eligible.event.source_page_type,
      eventSummary: eligible.event.summary,
      eventChangeDetails: eligible.event.change_details,
      summary: change.summary,
      detectedAt: change.detectedAt,
      visualReviewCandidateId: eligible.event.visual_review_candidate_id,
      visualEvidenceId: eligible.evidence.id,
      visualEvidenceStatus: eligible.evidence.evidence_status,
      visualEvidenceSchemaVersion: eligible.evidence.evidence_schema_version,
      visualEvidenceCandidateSignature: eligible.evidence.candidate_signature,
    };
  });

  return {
    changes,
    eventBindings,
    publicationIndex,
  };
}

function earliestDigestStart(subscribers: PublicSubscriberRow[]) {
  const starts = subscribers.map((subscriber) => {
    const milliseconds = Date.parse(subscriber.digest_started_at);
    if (!Number.isFinite(milliseconds)) {
      throw new Error(`Subscriber ${subscriber.id} has an invalid digest start time.`);
    }
    return milliseconds;
  });
  return new Date(Math.min(...starts)).toISOString();
}

export async function loadAllActivePublicDigestSubscribers(
  supabase: SupabaseAdminClient,
) {
  const subscribers: PublicSubscriberRow[] = [];
  let afterId: string | null = null;
  while (true) {
    let query = supabase
      .from("public_update_subscribers")
      .select(PUBLIC_DIGEST_SUBSCRIBER_SELECT)
      .eq("status", "active")
      .order("id", { ascending: true })
      .limit(PUBLIC_DIGEST_READ_PAGE_SIZE);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) throw error;
    const page = (data || []) as PublicSubscriberRow[];
    subscribers.push(...page);
    if (page.length < PUBLIC_DIGEST_READ_PAGE_SIZE) break;
    const nextAfterId = page.at(-1)?.id || null;
    if (!nextAfterId || (afterId !== null && nextAfterId <= afterId)) {
      throw new Error("Active public digest subscriber pagination did not advance.");
    }
    afterId = nextAfterId;
  }
  return subscribers;
}

export async function loadReservedPublicDigestEvents(
  supabase: SupabaseAdminClient,
  subscriberIds: string[],
  eventIds: string[],
) {
  const reserved = new Map<string, Set<string>>();
  for (
    let subscriberStart = 0;
    subscriberStart < subscriberIds.length;
    subscriberStart += PUBLIC_DIGEST_SUBSCRIBER_CHUNK_SIZE
  ) {
    const subscriberChunk = subscriberIds.slice(
      subscriberStart,
      subscriberStart + PUBLIC_DIGEST_SUBSCRIBER_CHUNK_SIZE,
    );
    for (
      let eventStart = 0;
      eventStart < eventIds.length;
      eventStart += PUBLIC_DIGEST_EVENT_CHUNK_SIZE
    ) {
      const eventChunk = eventIds.slice(
        eventStart,
        eventStart + PUBLIC_DIGEST_EVENT_CHUNK_SIZE,
      );
      let afterReceiptId: string | null = null;
      while (true) {
        let query = supabase
          .from("public_digest_event_receipts")
          .select("id, subscriber_id, change_event_id")
          .in("subscriber_id", subscriberChunk)
          .in("change_event_id", eventChunk)
          .order("id", { ascending: true })
          .limit(PUBLIC_DIGEST_READ_PAGE_SIZE);
        if (afterReceiptId) query = query.gt("id", afterReceiptId);
        const { data, error } = await query;
        if (error) throw error;
        const page = data || [];
        for (const receipt of page) {
          if (!receipt.subscriber_id) continue;
          const eventSet = reserved.get(receipt.subscriber_id) || new Set<string>();
          eventSet.add(receipt.change_event_id);
          reserved.set(receipt.subscriber_id, eventSet);
        }
        if (page.length < PUBLIC_DIGEST_READ_PAGE_SIZE) break;
        const nextAfterReceiptId = page.at(-1)?.id || null;
        if (
          !nextAfterReceiptId ||
          (afterReceiptId !== null && nextAfterReceiptId <= afterReceiptId)
        ) {
          throw new Error("Public digest receipt pagination did not advance.");
        }
        afterReceiptId = nextAfterReceiptId;
      }
    }
  }
  return reserved;
}

function cryptoRandomUuid() {
  return crypto.randomUUID();
}

function publicSubscriberEmail(subscriber: PublicSubscriberRow) {
  return decryptPersonalData(subscriber.email_encrypted) || subscriber.email || null;
}

function emptyEnqueueResult(digestKey: string, reason: string) {
  return {
    digestKey,
    enqueued: 0,
    reactivated: 0,
    alreadyFrozen: 0,
    legacyBlocked: 0,
    skipped: true,
    reason,
    changeCount: 0,
    subscriberCount: 0,
  };
}

function frozenRenderedPayload(value: Json): RenderedPublicDailyDigestEmail {
  const payload = jsonObject(value);
  const from = jsonText(payload.from);
  const subject = jsonText(payload.subject);
  const html = jsonText(payload.html);
  const text = jsonText(payload.text);
  if (
    payload.schemaVersion !== "public-digest-render-v1" ||
    !from ||
    !subject ||
    !html ||
    !text
  ) {
    throw new PublicDigestDeliveryError(
      "The frozen public digest payload is incomplete.",
      false,
      false,
    );
  }
  return { from, subject, html, text };
}

function classifyDigestDeliveryError(error: unknown, providerAccepted: boolean) {
  if (error instanceof PublicDigestDeliveryError) return error;
  return new PublicDigestDeliveryError(
    error instanceof Error ? error.message : "Public digest delivery failed.",
    providerAccepted,
    providerAccepted,
  );
}

function jsonObject(value: unknown): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}

function jsonText(value: Json | undefined) {
  return typeof value === "string" && value.trim() ? value : "";
}

function jsonNumber(value: Json | undefined) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
