import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../supabase/migrations/20260717033000_public_digest_event_ledger.sql", import.meta.url),
  "utf8",
);
const delivery = readFileSync(
  new URL("../src/lib/public-updates.ts", import.meta.url),
  "utf8",
);
const core = readFileSync(
  new URL("../src/lib/public-updates-core.ts", import.meta.url),
  "utf8",
);

describe("public digest event ledger", () => {
  it("reserves every subscriber/event pair exactly once", () => {
    expect(migration).toContain("create table public.public_digest_event_receipts");
    expect(migration).toContain("public_digest_event_receipt_subscriber_event_idx");
    expect(migration).toContain("(subscriber_id, change_event_id)");
    expect(migration).toContain("after insert on public.public_digest_outbox");
    expect(migration).toContain("sync_public_digest_event_receipts");
  });

  it("allows multiple capped batches per UTC day without changing frozen payloads", () => {
    expect(migration).toContain("batch_sequence integer not null default 1");
    expect(migration).toContain("drop constraint if exists public_digest_outbox_subscriber_digest_unique");
    expect(migration).toContain("public_digest_outbox_subscriber_digest_batch_idx");
    expect(migration).toContain("max(outbox.batch_sequence)");
    expect(migration).toContain("freeze_public_digest_batch_sequence");
    expect(migration).toContain("jsonb_array_length(v_bindings) not between 1 and 12");
    expect(delivery).toContain("splitPublicDigestChanges(pendingChanges)");
  });

  it("serializes enqueue against the subscriber ledger and rejects stale overlap", () => {
    const enqueue = migration.slice(
      migration.indexOf("create or replace function public.enqueue_public_digest_outbox("),
    );
    const subscriberLock = enqueue.indexOf("for update;");
    const receiptCheck = enqueue.indexOf("public.public_digest_event_receipts");
    const outboxInsert = enqueue.indexOf("insert into public.public_digest_outbox");
    expect(subscriberLock).toBeGreaterThan(0);
    expect(receiptCheck).toBeGreaterThan(subscriberLock);
    expect(outboxInsert).toBeGreaterThan(receiptCheck);
    expect(enqueue).toContain("A digest event was reserved concurrently");
  });

  it("loads the complete eligible set and filters by durable subscriber receipts", () => {
    expect(delivery).toContain("limit: null");
    expect(delivery).toContain('.from("public_digest_event_receipts")');
    expect(delivery).toContain("pendingPublicDigestChangesForSubscriber");
    expect(core).not.toContain("publicDigestSince");
    expect(core).not.toContain("36 * 60 * 60");
  });

  it("recovers historically omitted events from confirmation time", () => {
    const backfillStart = migration.indexOf(
      "update public.public_update_subscribers subscriber",
    );
    const backfill = migration.slice(
      backfillStart,
      migration.indexOf("alter table public.public_update_subscribers", backfillStart),
    );
    expect(backfill).toContain("subscriber.confirmed_at");
    expect(backfill).toContain("subscriber.created_at");
    expect(backfill).not.toContain("subscriber.last_digest_sent_at");
  });

  it("supersedes only zero-attempt stale-release reservations and retains their audit", () => {
    const supersede = migration.slice(
      migration.indexOf("create or replace function public.supersede_stale_public_digest_reservations("),
      migration.indexOf("create or replace function public.enqueue_public_digest_outbox("),
    );
    expect(supersede).toContain("pg_advisory_xact_lock");
    expect(supersede).toContain("private.public_digest_release_is_current");
    expect(supersede).toContain("outbox.status in ('queued', 'leased', 'release_blocked')");
    expect(supersede).toContain("outbox.send_attempt_count = 0");
    expect(supersede).toContain("outbox.first_provider_attempt_at is null");
    expect(supersede).toContain("outbox.last_provider_attempt_at is null");
    expect(supersede).toContain("delivery.provider_idempotency_key = outbox.provider_idempotency_key");
    expect(supersede).toContain("status = 'release_blocked'");
    expect(supersede).toContain("status = 'superseded_unsent'");
    expect(supersede).toContain("subscriber_id = null");
    expect(supersede).not.toContain("delete from public.public_digest_event_receipts");
    expect(supersede).toContain("v_receipt_count <> v_expected_receipt_count");
    expect(supersede).toContain("after insert or update on public.stage1_publication_release_state");
  });

  it("cuts over historical overlap without allowing a partial outbox to send", () => {
    const firstBackfill = migration.indexOf(
      "insert into public.public_digest_event_receipts",
    );
    const secondBackfill = migration.indexOf(
      "insert into public.public_digest_event_receipts",
      firstBackfill + 1,
    );
    expect(migration.slice(firstBackfill, secondBackfill)).toContain(
      "legacy_delivery_id",
    );
    expect(migration.slice(secondBackfill, migration.indexOf(
      "create or replace function private.public_digest_outbox_owns_complete_receipt_set",
    ))).toContain("outbox_id");
    expect(migration).toContain("Pre-ledger zero-attempt digest was safely frozen");
    expect(migration).toContain("Pre-ledger digest has partial event-receipt ownership");
    expect(migration).toContain("private.public_digest_outbox_owns_complete_receipt_set(old.id)");
    expect(migration).toContain("Digest provider authorization requires complete exclusive event-receipt ownership");
    expect(migration).toContain("Pre-ledger zero-attempt payload reactivated");
    const outboxBackfillOrder = migration.slice(
      migration.indexOf("select distinct on (outbox.subscriber_id, event_id)"),
      migration.indexOf("on conflict do nothing;", secondBackfill),
    );
    expect(outboxBackfillOrder.indexOf("(outbox.status = 'sent') desc")).toBeLessThan(
      outboxBackfillOrder.indexOf("(outbox.provider_message_id is not null) desc"),
    );
    expect(
      outboxBackfillOrder.indexOf("(outbox.provider_message_id is not null) desc"),
    ).toBeLessThan(
      outboxBackfillOrder.indexOf("(outbox.status = 'sending') desc"),
    );
    expect(outboxBackfillOrder.indexOf("(outbox.status = 'sending') desc")).toBeLessThan(
      outboxBackfillOrder.indexOf("(outbox.ambiguous_since is not null) desc"),
    );
    expect(
      outboxBackfillOrder.indexOf("(outbox.ambiguous_since is not null) desc"),
    ).toBeLessThan(
      outboxBackfillOrder.indexOf("outbox.send_attempt_count > 0"),
    );
  });

  it("quarantines an incomplete in-flight historical batch instead of retry-looping", () => {
    const authorize = migration.slice(
      migration.indexOf("create or replace function public.authorize_public_digest_send("),
      migration.indexOf("create or replace function public.fail_public_digest_send("),
    );
    const fail = migration.slice(
      migration.indexOf("create or replace function public.fail_public_digest_send("),
      migration.indexOf("create or replace function private.freeze_public_digest_batch_sequence("),
    );
    expect(authorize).toContain(
      "not private.public_digest_outbox_owns_complete_receipt_set(v_outbox.id)",
    );
    expect(authorize).toContain("status = 'release_blocked'");
    expect(authorize).toContain("return false");
    expect(fail).toContain("v_status in ('queued', 'ambiguous')");
    expect(fail).toContain("v_status := 'release_blocked'");
    expect(fail).toContain("Automatic retry was blocked");
  });

  it("uses bounded, stable keyset reads for subscribers and receipts", () => {
    expect(delivery).toContain("PUBLIC_DIGEST_READ_PAGE_SIZE = 500");
    expect(delivery).toContain("PUBLIC_DIGEST_SUBSCRIBER_CHUNK_SIZE = 25");
    expect(delivery).toContain("PUBLIC_DIGEST_EVENT_CHUNK_SIZE = 75");
    expect(delivery).toContain('.order("id", { ascending: true })');
    expect(delivery).toContain('.gt("id", afterId)');
    expect(delivery).toContain('.gt("id", afterReceiptId)');
    expect(delivery).toContain('rpc(\n    "supersede_stale_public_digest_reservations"');
  });
});
