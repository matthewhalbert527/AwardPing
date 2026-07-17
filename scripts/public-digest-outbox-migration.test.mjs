import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717004447_public_digest_outbox.sql",
    import.meta.url,
  ),
  "utf8",
);
const delivery = readFileSync(
  new URL("../src/lib/public-updates.ts", import.meta.url),
  "utf8",
);
const email = readFileSync(
  new URL("../src/lib/email.ts", import.meta.url),
  "utf8",
);
const privacyDelete = readFileSync(
  new URL("../src/app/api/privacy/delete/route.ts", import.meta.url),
  "utf8",
);
const vercel = JSON.parse(
  readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
);

describe("durable public digest outbox", () => {
  it("freezes exact rendered payloads, release identity, and event evidence", () => {
    expect(migration).toContain("create table if not exists public.public_digest_outbox");
    for (const binding of [
      "rendered_payload",
      "payload_hash",
      "event_bindings",
      "change_event_ids",
      "release_epoch",
      "release_identity_hash",
      "recipient_encrypted",
    ]) {
      expect(migration).toContain(binding);
    }
    expect(migration).toContain("private.freeze_public_digest_outbox_row()");
    expect(delivery).toContain('schemaVersion: "public-digest-render-v1"');
    expect(delivery).toContain("visualEvidenceId");
    expect(delivery).toContain("eventChangeDetails");
  });

  it("authorizes each provider request under the national lock and current event predicates", () => {
    const authorize = migration.slice(
      migration.indexOf("create or replace function public.authorize_public_digest_send("),
      migration.indexOf("create or replace function public.complete_public_digest_send("),
    );
    expect(authorize).toContain("stage1-national-25-release");
    expect(authorize).toContain("private.public_digest_release_is_current");
    expect(authorize).toContain("private.public_digest_events_are_current");
    expect(authorize).toContain("public.public_update_subscribers");
    expect(authorize).toContain("v_subscriber.status <> 'active'");
    expect(authorize).toContain("v_subscriber.email_hash is distinct from v_outbox.recipient_hash");
    expect(authorize).toContain("eligibility_seal_hash");
    expect(authorize).toContain("for key share");
    expect(migration).toContain("change_event.suppressed_at is null");
    expect(migration).toContain("source.url = change_event.source_url");
    expect(migration).toContain("change_event.change_details");
    expect(migration).toContain("evidence.evidence_status");
  });

  it("uses leases, skip-locked claims, and a conservative sub-24-hour ambiguous window", () => {
    expect(migration).toContain("for update skip locked");
    expect(migration).toContain("status = 'leased'");
    expect(migration).toContain("status = 'sending'");
    expect(migration).toContain("status = 'ambiguous'");
    expect(migration).toContain("interval '23 hours'");
    expect(migration).toContain("provider_idempotency_key = 'awardping-public-digest:' || payload_hash");
    expect(email).toContain("sendFrozenPublicDailyDigestEmail");
  });

  it("preserves ambiguous provenance across a pre-authorization lease crash", () => {
    const claim = migration.slice(
      migration.indexOf("create or replace function public.claim_public_digest_outbox("),
      migration.indexOf("create or replace function public.authorize_public_digest_send("),
    );
    const authorize = migration.slice(
      migration.indexOf("create or replace function public.authorize_public_digest_send("),
      migration.indexOf("create or replace function public.complete_public_digest_send("),
    );
    expect(claim).toContain("outbox.status = 'leased' and outbox.ambiguous_since is not null");
    expect(claim).toContain("outbox.send_attempt_count < outbox.max_attempts");
    expect(claim).toContain("outbox.first_provider_attempt_at > pg_catalog.clock_timestamp() - interval '23 hours'");
    expect(authorize).toContain("v_outbox.send_attempt_count >= v_outbox.max_attempts");
    expect(authorize).toContain("v_outbox.ambiguous_since is not null");
    expect(authorize).toContain("status = 'terminal_failed'");
  });

  it("serializes unsubscribe with provider authorization and refuses false success", () => {
    const unsubscribe = migration.slice(
      migration.indexOf("create or replace function public.unsubscribe_public_update_subscriber("),
      migration.indexOf("create or replace function public.erase_public_update_subscriber("),
    );
    expect(unsubscribe).toContain("stage1-national-25-release");
    expect(unsubscribe).toContain("for update");
    expect(unsubscribe).toContain("outbox.status = 'sending'");
    expect(unsubscribe).toContain("return 'retry_active_send'");
    expect(unsubscribe).toContain("return 'unsubscribed'");
    expect(migration).toContain("private.public_digest_subscriber_fence_before_statement()");
    expect(migration).toContain("private.fence_sending_digest_subscriber_mutation()");
    expect(migration).toContain("before update or delete on public.public_update_subscribers");
    expect(delivery).toContain('rpc(\n    "unsubscribe_public_update_subscriber"');
    expect(delivery).not.toContain('.eq("unsubscribe_token_hash", tokenHash)');
  });

  it("allows only RPC-owned final delivery writes and preserves legacy rows as unsealed", () => {
    expect(migration).toContain("revoke insert, update, delete, truncate");
    expect(migration).toContain("delivery_contract_version");
    expect(migration).toContain("legacy row has no exact rendered payload");
    expect(delivery).not.toContain('.from("public_update_deliveries")');
    expect(delivery).toContain('"complete_public_digest_send"');
    expect(delivery).toContain('"fail_public_digest_send"');
  });

  it("scrubs delivery PII before deleting a subscriber while retaining non-PII audit seals", () => {
    const erasure = migration.slice(
      migration.indexOf("create or replace function public.erase_public_update_subscriber("),
      migration.indexOf("-- Release invalidation is transactionally refused"),
    );
    expect(erasure).toContain("status = 'privacy_scrubbed'");
    expect(erasure).toContain("recipient_encrypted = null");
    expect(erasure).toContain("rendered_payload = null");
    expect(erasure).toContain("recipient_hash = null");
    expect(erasure).toContain("delete from public.public_update_subscribers");
    expect(erasure).toContain("outbox.recipient_hash = p_email_hash");
    expect(erasure).toContain("delivery.recipient_hash = p_email_hash");
    expect(erasure).toContain("pg_catalog.lower(pg_catalog.btrim(delivery.recipient))");
    expect(erasure).not.toContain("if cardinality(v_subscriber_ids) = 0 then return 0");
    expect(erasure).not.toContain("payload_hash = null");
    expect(migration).toContain("on delete set null");
    expect(privacyDelete).toContain('admin.rpc("erase_public_update_subscriber"');
    expect(privacyDelete).not.toContain('.from("public_update_subscribers")');
  });

  it("runs a Hobby-compatible daily independent retry drain", () => {
    expect(vercel.crons).toContainEqual({
      path: "/api/cron/drain-public-digest-outbox",
      schedule: "0 14 * * *",
    });
    expect(vercel.crons).toHaveLength(2);
  });
});
