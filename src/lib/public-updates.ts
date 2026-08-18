import "server-only";

import crypto from "node:crypto";
import {
  appConfig,
  hasPublicUpdateDeliveryConfig,
  hasSupabaseAdminConfig,
} from "@/lib/config";
import type { Database, Json } from "@/lib/database.types";
import {
  PublicDigestDeliveryError,
  renderPublicUpdateConfirmationEmail,
  renderPublicDailyDigestEmail,
  sendFrozenPublicUpdateConfirmationEmail,
  sendFrozenPublicDailyDigestEmail,
  type RenderedPublicUpdateConfirmationEmail,
  type RenderedPublicDailyDigestEmail,
} from "@/lib/email";
import {
  buildPublicDigestChanges,
  createPublicUnsubscribeToken,
  hashToken,
  normalizePublicUpdateEmail,
  pendingPublicDigestChangesForSubscriber,
  publicDigestKey,
  splitPublicDigestChanges,
  type PublicDigestCandidate,
} from "@/lib/public-updates-core";
import {
  encryptPersonalData,
  encryptedEmailFields,
  personalDataLookupHash,
  readPersonalData,
} from "@/lib/personal-data";
import { loadEligiblePublicChangeEvents } from "@/lib/public-change-events";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadStage1PublicationIndex } from "@/lib/stage1-publication";

type PublicSubscriberRow =
  Database["public"]["Tables"]["public_update_subscribers"]["Row"];
type SupabaseAdminClient = ReturnType<typeof createSupabaseAdminClient>;

const PUBLIC_DIGEST_READ_PAGE_SIZE = 500;
const PUBLIC_DIGEST_SUBSCRIBER_CHUNK_SIZE = 25;
const PUBLIC_DIGEST_EVENT_CHUNK_SIZE = 75;
const PUBLIC_DIGEST_SUBSCRIBER_SELECT =
  "id, email, email_hash, email_encrypted, status, confirmation_token_hash, unsubscribe_token_hash, confirmation_sent_at, confirmed_at, unsubscribed_at, last_digest_sent_at, digest_started_at, confirmation_generation, confirmation_issued_at, confirmation_expires_at, confirmation_contract_version, created_at, updated_at";

export async function createOrRefreshPublicUpdateSubscription(rawEmail: string) {
  const email = normalizePublicUpdateEmail(rawEmail);
  const encryptedEmail = encryptedEmailFields(email);
  const subscriberId = cryptoRandomUuid();
  const createdAt = new Date().toISOString();
  const confirmationToken = crypto.randomBytes(32).toString("base64url");
  const confirmationTokenHash = hashToken(confirmationToken);
  const confirmationTokenEncrypted = encryptPersonalData(confirmationToken);
  const renderedPayload = renderPublicUpdateConfirmationEmail({
    to: email,
    confirmUrl: `${appConfig.url}/api/public-updates/confirm?token=${encodeURIComponent(confirmationToken)}`,
  });
  const serializedPayload = JSON.stringify(renderedPayload);
  const payloadHash = hashToken(serializedPayload);
  const renderedPayloadEncrypted = encryptPersonalData(serializedPayload);
  const unsubscribeTokenHash = hashToken(
    createPublicUnsubscribeToken(
      { id: subscriberId, created_at: createdAt },
      appConfig.cronSecret,
    ),
  );
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc(
    "enqueue_public_update_confirmation",
    {
      p_subscriber_id: subscriberId,
      p_created_at: createdAt,
      p_legacy_email: email,
      p_recipient_hash: encryptedEmail.email_hash,
      p_recipient_encrypted: encryptedEmail.email_encrypted,
      p_confirmation_token_hash: confirmationTokenHash,
      p_confirmation_token_encrypted: confirmationTokenEncrypted,
      p_rendered_payload_encrypted: renderedPayloadEncrypted,
      p_payload_schema_version: "public-confirmation-render-v1",
      p_payload_hash: payloadHash,
      p_unsubscribe_token_hash: unsubscribeTokenHash,
    },
  );
  if (error) throw error;
  return {
    outboxId: data?.[0]?.outbox_id || null,
    needsDelivery: data?.[0]?.needs_delivery === true,
  };
}

export async function confirmPublicUpdateSubscription(token: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc(
    "confirm_public_update_subscription",
    { p_confirmation_token_hash: hashToken(token) },
  );
  if (error) throw error;
  return data === true;
}

class PublicUpdateConfirmationDeliveryError extends Error {
  constructor(
    message: string,
    readonly ambiguous: boolean,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PublicUpdateConfirmationDeliveryError";
  }
}

export async function drainPublicUpdateConfirmationOutbox({
  limit = 10,
  outboxId = null,
  workerId = `public-confirmation:${process.env.VERCEL_REGION || "local"}:${crypto.randomUUID()}`,
}: {
  limit?: number;
  outboxId?: string | null;
  workerId?: string;
} = {}) {
  if (!hasSupabaseAdminConfig() || !hasPublicUpdateDeliveryConfig()) {
    return emptyConfirmationDrainResult(true);
  }

  const supabase = createSupabaseAdminClient();
  const { data: claims, error } = await supabase.rpc(
    "claim_public_update_confirmations",
    {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: 300,
      p_outbox_id: outboxId,
    },
  );
  if (error) throw error;

  const result = {
    ...emptyConfirmationDrainResult(false),
    claimed: claims?.length || 0,
  };
  for (const claim of claims || []) {
    const { data: authorized, error: authorizeError } = await supabase.rpc(
      "authorize_public_update_confirmation_send",
      { p_outbox_id: claim.id, p_lease_token: claim.lease_token },
    );
    if (authorizeError) throw authorizeError;
    if (!authorized) {
      result.stale += 1;
      continue;
    }

    let providerStarted = false;
    let providerAccepted = false;
    try {
      if (
        !isV2PersonalDataCiphertext(claim.recipient_encrypted) ||
        !isV2PersonalDataCiphertext(claim.confirmation_token_encrypted) ||
        !isV2PersonalDataCiphertext(claim.rendered_payload_encrypted)
      ) {
        throw new PublicUpdateConfirmationDeliveryError(
          "Legacy or malformed confirmation delivery ciphertext was refused.",
          false,
          false,
        );
      }
      const recipientRead = readPersonalData(claim.recipient_encrypted);
      const tokenRead = readPersonalData(claim.confirmation_token_encrypted);
      const payloadRead = readPersonalData(claim.rendered_payload_encrypted);
      const recipient =
        recipientRead.status === "available" ? recipientRead.value : null;
      const confirmationToken =
        tokenRead.status === "available" ? tokenRead.value : null;
      const serializedPayload =
        payloadRead.status === "available" ? payloadRead.value : null;
      if (
        !recipient ||
        personalDataLookupHash(recipient) !== claim.recipient_hash ||
        !confirmationToken ||
        hashToken(confirmationToken) !== claim.confirmation_token_hash ||
        !serializedPayload ||
        hashToken(serializedPayload) !== claim.payload_hash ||
        claim.payload_schema_version !== "public-confirmation-render-v1"
      ) {
        throw new PublicUpdateConfirmationDeliveryError(
          "The encrypted confirmation recipient/token binding could not be verified.",
          false,
          false,
        );
      }

      const payload = frozenConfirmationPayload({
        serializedPayload,
        recipient,
        confirmationToken,
      });

      providerStarted = true;
      const delivery = await sendFrozenPublicUpdateConfirmationEmail({
        ...payload,
        idempotencyKey: claim.provider_idempotency_key,
      });
      const accepted = acceptedConfirmationProviderResult(delivery);
      providerAccepted = true;
      const { data: completionStatus, error: completionError } =
        await supabase.rpc("complete_public_update_confirmation_send", {
          p_outbox_id: claim.id,
          p_lease_token: claim.lease_token,
          p_provider_message_id: accepted.providerMessageId,
        });
      if (completionError) {
        throw new PublicUpdateConfirmationDeliveryError(
          `Provider accepted the confirmation but its receipt was not durably recorded: ${completionError.message}`,
          true,
          true,
        );
      }
      if (completionStatus === "accepted") result.accepted += 1;
      else if (completionStatus === "accepted_stale") result.acceptedStale += 1;
      else {
        throw new PublicUpdateConfirmationDeliveryError(
          `Provider accepted the confirmation but the database returned ${String(completionStatus)}.`,
          true,
          true,
        );
      }
    } catch (deliveryError) {
      const classified = classifyConfirmationDeliveryError(deliveryError, {
        providerStarted,
        providerAccepted,
      });
      const { data: nextStatus, error: failureError } = await supabase.rpc(
        "fail_public_update_confirmation_send",
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
          "Confirmation delivery outcome and retry state could not both be persisted.",
        );
      }
      if (nextStatus === "accepted") result.accepted += 1;
      else if (nextStatus === "accepted_stale") result.acceptedStale += 1;
      else if (nextStatus === "retry") result.retry += 1;
      else if (nextStatus === "ambiguous") result.ambiguous += 1;
      else if (nextStatus === "stale") result.stale += 1;
      else result.terminalFailed += 1;
    }
  }
  return result;
}

function acceptedConfirmationProviderResult(delivery: unknown) {
  if (!delivery || typeof delivery !== "object") {
    throw new PublicUpdateConfirmationDeliveryError(
      "The confirmation provider returned no result.",
      true,
      true,
    );
  }
  const candidate = delivery as {
    skipped?: unknown;
    error?: {
      message?: unknown;
      name?: unknown;
      statusCode?: unknown;
    } | null;
    data?: { id?: unknown } | null;
  };
  if (candidate.skipped === true) {
    throw new PublicUpdateConfirmationDeliveryError(
      "Confirmation email delivery is not configured.",
      false,
      false,
    );
  }
  if (candidate.error) {
    const statusCode = candidate.error.statusCode;
    const concurrentIdempotentRequest =
      statusCode === 409 &&
      candidate.error.name === "concurrent_idempotent_requests";
    const definiteHttpRejection =
      typeof statusCode === "number" &&
      Number.isInteger(statusCode) &&
      statusCode >= 400 &&
      statusCode <= 599 &&
      !concurrentIdempotentRequest;
    const retryableHttpRejection =
      concurrentIdempotentRequest ||
      (definiteHttpRejection &&
        (statusCode >= 500 ||
          statusCode === 408 ||
          statusCode === 429));
    throw new PublicUpdateConfirmationDeliveryError(
      `The confirmation provider rejected the request: ${
        typeof candidate.error?.message === "string"
          ? candidate.error.message
          : "unknown provider error"
      }`,
      !definiteHttpRejection,
      !definiteHttpRejection || retryableHttpRejection,
    );
  }
  if (
    typeof candidate.data?.id !== "string" ||
    candidate.data.id.trim().length === 0
  ) {
    throw new PublicUpdateConfirmationDeliveryError(
      "The confirmation provider did not return an accepted message ID.",
      true,
      true,
    );
  }
  return { providerMessageId: candidate.data.id.trim() };
}

function frozenConfirmationPayload({
  serializedPayload,
  recipient,
  confirmationToken,
}: {
  serializedPayload: string;
  recipient: string;
  confirmationToken: string;
}): RenderedPublicUpdateConfirmationEmail {
  let value: unknown;
  try {
    value = JSON.parse(serializedPayload);
  } catch {
    throw new PublicUpdateConfirmationDeliveryError(
      "The frozen confirmation provider payload is not valid JSON.",
      false,
      false,
    );
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new PublicUpdateConfirmationDeliveryError(
      "The frozen confirmation provider payload is not an object.",
      false,
      false,
    );
  }
  const candidate = value as Record<string, unknown>;
  const expectedKeys = ["from", "to", "subject", "html", "text"];
  const payload = {
    from: candidate.from,
    to: candidate.to,
    subject: candidate.subject,
    html: candidate.html,
    text: candidate.text,
  };
  if (
    Object.keys(candidate).sort().join("\u0000") !==
      expectedKeys.slice().sort().join("\u0000") ||
    Object.values(payload).some(
      (field) => typeof field !== "string" || field.trim().length === 0,
    ) ||
    payload.to !== recipient ||
    JSON.stringify(payload) !== serializedPayload
  ) {
    throw new PublicUpdateConfirmationDeliveryError(
      "The frozen confirmation provider payload shape or recipient is invalid.",
      false,
      false,
    );
  }
  const confirmationPath =
    `/api/public-updates/confirm?token=${encodeURIComponent(confirmationToken)}`;
  if (
    !(payload.html as string).includes(confirmationPath) ||
    !(payload.text as string).includes(confirmationPath)
  ) {
    throw new PublicUpdateConfirmationDeliveryError(
      "The frozen confirmation provider payload is not bound to its token.",
      false,
      false,
    );
  }
  return payload as RenderedPublicUpdateConfirmationEmail;
}

function classifyConfirmationDeliveryError(
  error: unknown,
  state: { providerStarted: boolean; providerAccepted: boolean },
) {
  if (error instanceof PublicUpdateConfirmationDeliveryError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new PublicUpdateConfirmationDeliveryError(
    message,
    state.providerStarted || state.providerAccepted,
    state.providerStarted || state.providerAccepted,
  );
}

function emptyConfirmationDrainResult(skipped: boolean) {
  return {
    claimed: 0,
    accepted: 0,
    acceptedStale: 0,
    retry: 0,
    ambiguous: 0,
    terminalFailed: 0,
    stale: 0,
    skipped,
  };
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
  let unreadableSubscriberCount = 0;
  for (const subscriber of subscribers) {
    const pendingChanges = pendingPublicDigestChangesForSubscriber(
      digest.changes,
      subscriber.digest_started_at,
      reservedBySubscriber.get(subscriber.id) || new Set<string>(),
    );
    if (!pendingChanges.length) continue;
    pendingEventCount += pendingChanges.length;
    const email = publicSubscriberEmail(subscriber);
    if (!email) {
      unreadableSubscriberCount += 1;
      continue;
    }
    const encrypted = encryptedEmailFields(email);
    const storedEmail = readPersonalData(subscriber.email_encrypted);
    const recipientEncrypted =
      subscriber.email_encrypted &&
      storedEmail.status === "available" &&
      storedEmail.format === "ap:v2" &&
      storedEmail.value === email
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
  let legacyBlocked = unreadableSubscriberCount;
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
    if (!isV2PersonalDataCiphertext(claim.recipient_encrypted)) {
      const { data: nextStatus, error: failureError } = await supabase.rpc(
        "fail_public_digest_send",
        {
          p_outbox_id: claim.id,
          p_lease_token: claim.lease_token,
          p_error:
            "Legacy or malformed recipient ciphertext was refused before provider authorization.",
          p_ambiguous: false,
          p_retryable: false,
        },
      );
      if (failureError) throw failureError;
      if (nextStatus === "release_blocked") result.releaseBlocked += 1;
      else result.terminalFailed += 1;
      continue;
    }
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
      const recipientRead = readPersonalData(claim.recipient_encrypted);
      if (recipientRead.status === "unavailable") {
        throw new PublicDigestDeliveryError(
          "The frozen digest recipient uses unavailable or unsupported encryption and cannot be sent safely.",
          false,
          false,
        );
      }
      const recipient = recipientRead.value;
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
  const encrypted = readPersonalData(subscriber.email_encrypted);
  if (encrypted.status === "available" && encrypted.format === "ap:v2") {
    return encrypted.value;
  }
  if (encrypted.status === "unavailable") return null;
  if (encrypted.format === "ap:v1") return null;
  return subscriber.email || null;
}

function isV2PersonalDataCiphertext(value: string | null | undefined) {
  return typeof value === "string" && value.startsWith("ap:v2:");
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
