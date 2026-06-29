import "server-only";

import crypto from "node:crypto";
import { appConfig, hasSupabaseAdminConfig } from "@/lib/config";
import type { Database } from "@/lib/database.types";
import { sendPublicDailyDigestEmail } from "@/lib/email";
import {
  buildPublicDigestChanges,
  createPublicUnsubscribeToken,
  createPublicUpdateToken,
  filterSubscribersWithoutDigestDelivery,
  hashToken,
  normalizePublicUpdateEmail,
  publicDigestKey,
  publicDigestSince,
  type PublicDigestCandidate,
} from "@/lib/public-updates-core";
import {
  decryptPersonalData,
  encryptedEmailFields,
  personalDataLookupHash,
} from "@/lib/personal-data";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type PublicSubscriberRow =
  Database["public"]["Tables"]["public_update_subscribers"]["Row"];
type PublicSubscriberInsert =
  Database["public"]["Tables"]["public_update_subscribers"]["Insert"];
type SharedAwardRow = Pick<
  Database["public"]["Tables"]["shared_awards"]["Row"],
  "id" | "name"
>;
type SharedChangeRow = Pick<
  Database["public"]["Tables"]["shared_award_change_events"]["Row"],
  "id" | "shared_award_id" | "source_title" | "source_url" | "summary" | "change_details" | "detected_at"
>;

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
  const { data: subscriber, error } = await supabase
    .from("public_update_subscribers")
    .select("id")
    .eq("unsubscribe_token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!subscriber) {
    return false;
  }

  const { error: updateError } = await supabase
    .from("public_update_subscribers")
    .update({
      status: "unsubscribed",
      unsubscribed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", subscriber.id);

  if (updateError) {
    throw updateError;
  }

  return true;
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

  const supabase = createSupabaseAdminClient();
  const digestKey = publicDigestKey(date);
  const changes = await loadPublicDigestChanges(date);

  if (changes.length === 0) {
    return {
      digestKey,
      sent: 0,
      failed: 0,
      skipped: true,
      reason: "No useful public award changes.",
    };
  }

  const { data: subscribers, error: subscriberError } = await supabase
    .from("public_update_subscribers")
    .select("id, email, email_hash, email_encrypted, status, confirmation_token_hash, unsubscribe_token_hash, confirmation_sent_at, confirmed_at, unsubscribed_at, last_digest_sent_at, created_at, updated_at")
    .eq("status", "active")
    .order("created_at", { ascending: true });

  if (subscriberError) {
    throw subscriberError;
  }

  if (!subscribers?.length) {
    return {
      digestKey,
      sent: 0,
      failed: 0,
      skipped: true,
      reason: "No active public update subscribers.",
      changeCount: changes.length,
    };
  }

  const subscriberIds = subscribers.map((subscriber) => subscriber.id);
  const { data: deliveries, error: deliveryError } = await supabase
    .from("public_update_deliveries")
    .select("subscriber_id")
    .eq("digest_key", digestKey)
    .in("subscriber_id", subscriberIds);

  if (deliveryError) {
    throw deliveryError;
  }

  const undeliveredSubscribers = filterSubscribersWithoutDigestDelivery(
    subscribers as PublicSubscriberRow[],
    deliveries || [],
  );
  let sent = 0;
  let failed = 0;
  const changeEventIds = changes.map((change) => change.eventId);

  for (const subscriber of undeliveredSubscribers) {
    const subscriberEmail = publicSubscriberEmail(subscriber);
    if (!subscriberEmail) continue;

    const unsubscribeToken = createPublicUnsubscribeToken(subscriber, appConfig.cronSecret);
    const unsubscribeUrl = `${appConfig.url}/api/public-updates/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
    const unsubscribeTokenHash = hashToken(unsubscribeToken);
    const recipientHash = personalDataLookupHash(subscriberEmail);

    if (subscriber.unsubscribe_token_hash !== unsubscribeTokenHash) {
      const { error: tokenUpdateError } = await supabase
        .from("public_update_subscribers")
        .update({
          unsubscribe_token_hash: unsubscribeTokenHash,
          updated_at: new Date().toISOString(),
        })
        .eq("id", subscriber.id);

      if (tokenUpdateError) {
        throw tokenUpdateError;
      }
    }

    try {
      await sendPublicDailyDigestEmail({
        to: subscriberEmail,
        changes,
        unsubscribeUrl,
      });

      const now = new Date().toISOString();
      const { error: insertError } = await supabase
        .from("public_update_deliveries")
        .insert({
          subscriber_id: subscriber.id,
          digest_key: digestKey,
          change_event_ids: changeEventIds,
          recipient: null,
          recipient_hash: recipientHash,
          status: "sent",
          sent_at: now,
        });

      if (insertError) {
        throw insertError;
      }

      await supabase
        .from("public_update_subscribers")
        .update({ last_digest_sent_at: now, updated_at: now })
        .eq("id", subscriber.id);

      sent += 1;
    } catch (error) {
      failed += 1;
      await supabase.from("public_update_deliveries").insert({
        subscriber_id: subscriber.id,
        digest_key: digestKey,
        change_event_ids: changeEventIds,
        recipient: null,
        recipient_hash: recipientHash,
        status: "failed",
        error: error instanceof Error ? error.message : "Public digest email failed.",
      });
    }
  }

  return {
    digestKey,
    sent,
    failed,
    skipped: false,
    changeCount: changes.length,
    subscriberCount: subscribers.length,
    skippedAlreadyDelivered: subscribers.length - undeliveredSubscribers.length,
  };
}

async function loadPublicDigestChanges(date: Date) {
  const supabase = createSupabaseAdminClient();
  const { data: changes, error } = await supabase
    .from("shared_award_change_events")
    .select("id, shared_award_id, source_title, source_url, source_page_type, summary, change_details, detected_at")
    .gte("detected_at", publicDigestSince(date))
    .order("detected_at", { ascending: false })
    .limit(80);

  if (error) {
    throw error;
  }

  if (!changes?.length) {
    return [];
  }

  const awardIds = [
    ...new Set((changes as SharedChangeRow[]).map((change) => change.shared_award_id)),
  ];
  const { data: awards, error: awardsError } = await supabase
    .from("shared_awards")
    .select("id, name")
    .in("id", awardIds);

  if (awardsError) {
    throw awardsError;
  }

  const awardNameById = new Map(
    ((awards || []) as SharedAwardRow[]).map((award) => [award.id, award.name]),
  );

  return buildPublicDigestChanges(changes as PublicDigestCandidate[], awardNameById, 12);
}

function cryptoRandomUuid() {
  return crypto.randomUUID();
}

function publicSubscriberEmail(subscriber: PublicSubscriberRow) {
  return decryptPersonalData(subscriber.email_encrypted) || subscriber.email || null;
}
