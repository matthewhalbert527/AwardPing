import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadModule, parseSync } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260815023357_durable_public_update_confirmation_outbox.sql",
  import.meta.url,
);
const smokeUrl = new URL(
  "../supabase/tests/public_update_confirmation_outbox_smoke.sql",
  import.meta.url,
);
const migration = readFileSync(migrationUrl, "utf8");
const smoke = readFileSync(smokeUrl, "utf8");
const adapter = readFileSync(
  new URL("../src/lib/public-updates.ts", import.meta.url),
  "utf8",
);
const subscribeRoute = readFileSync(
  new URL(
    "../src/app/api/public-updates/subscribe/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const confirmRoute = readFileSync(
  new URL(
    "../src/app/api/public-updates/confirm/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const recoveryCron = readFileSync(
  new URL(
    "../src/app/api/cron/drain-public-digest-outbox/route.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("durable public-update confirmation migration", () => {
  it("parses the forward migration and executable smoke as PostgreSQL", async () => {
    await loadModule();
    expect(() => parseSync(migration)).not.toThrow();
    expect(() => parseSync(smoke)).not.toThrow();
  });

  it("keeps token material private and exposes only service-role RPCs", () => {
    expect(migration).toContain(
      "create table private.public_update_confirmation_outbox",
    );
    expect(migration).toContain(
      "revoke all on schema private from public",
    );
    expect(migration).not.toContain(
      "revoke all on schema private from public, anon, authenticated, service_role",
    );
    expect(migration).toContain(
      "revoke all on table private.public_update_confirmation_outbox",
    );
    for (const rpc of [
      "enqueue_public_update_confirmation",
      "claim_public_update_confirmations",
      "authorize_public_update_confirmation_send",
      "complete_public_update_confirmation_send",
      "fail_public_update_confirmation_send",
      "confirm_public_update_subscription",
    ]) {
      expect(migration).toContain(`function public.${rpc}`);
      expect(migration).toContain("to service_role");
    }
    expect(migration).toContain(
      "revoke all on function public.erase_public_update_subscriber(text, text)",
    );
    expect(migration).not.toContain(
      "grant execute on function public.erase_public_update_subscriber(text, text)",
    );
    expect(smoke).toContain(
      "The service role invoked the superseded direct erasure RPC.",
    );
    expect(adapter).toContain('createSupabaseAdminClient()');
    expect(adapter).not.toContain("supabaseAnonKey");
  });

  it("uses explicit durable delivery states and one immutable provider key", () => {
    for (const status of [
      "'claimed'",
      "'sending'",
      "'accepted'",
      "'accepted_stale'",
      "'ambiguous'",
      "'retry'",
      "'terminal_failed'",
      "'stale'",
      "'confirmed'",
      "'privacy_scrubbed'",
    ]) {
      expect(migration).toContain(status);
    }
    expect(migration).toContain(
      "'awardping-public-confirmation:' || p_payload_hash",
    );
    expect(migration).toContain("rendered_payload_encrypted text");
    expect(migration).toContain(
      "payload_schema_version = 'public-confirmation-render-v1'",
    );
    expect(adapter).toContain("sendFrozenPublicUpdateConfirmationEmail");
    expect(adapter).toContain("hashToken(serializedPayload)");
    expect(migration).toContain("outbox.first_provider_attempt_at");
    expect(migration).toContain("interval '23 hours'");
    expect(adapter).toContain("claim_public_update_confirmations");
    expect(adapter).toContain("authorize_public_update_confirmation_send");
    expect(adapter).toContain("complete_public_update_confirmation_send");
    expect(adapter).toContain("fail_public_update_confirmation_send");
  });

  it("seals issuance, expiry, and activation to one PostgreSQL clock value", () => {
    const enqueue = migration.slice(
      migration.indexOf(
        "create or replace function public.enqueue_public_update_confirmation(",
      ),
      migration.indexOf(
        "create or replace function public.claim_public_update_confirmations(",
      ),
    );
    const confirm = migration.slice(
      migration.indexOf(
        "create or replace function public.confirm_public_update_subscription(",
      ),
      migration.indexOf(
        "create or replace function private.fence_sending_digest_subscriber_mutation()",
      ),
    );
    expect(enqueue).toContain(
      "v_now := pg_catalog.clock_timestamp()",
    );
    expect(enqueue).toContain("v_now + interval '24 hours'");
    expect(enqueue).toContain(
      "v_subscriber.confirmation_contract_version is null",
    );
    expect(enqueue).toContain(
      "v_subscriber.confirmation_expires_at > v_now",
    );
    expect(enqueue).not.toContain("new Date");
    expect(confirm).toContain(
      "v_now := pg_catalog.clock_timestamp()",
    );
    expect(confirm).toContain("v_now >= v_subscriber.confirmation_expires_at");
    expect(confirm).toContain("status = 'confirmed'");
    expect(confirm).toContain("digest_started_at = v_now");
    expect(adapter).not.toContain("PUBLIC_UPDATE_CONFIRMATION_TTL_MS");
    const backfill = migration.slice(
      migration.indexOf("update public.public_update_subscribers subscriber"),
      migration.indexOf(
        "create table private.public_update_confirmation_outbox",
      ),
    );
    expect(backfill).toContain(
      "subscriber.confirmation_token_hash is not null",
    );
  });

  it("fences unsubscribe, erasure, and rotation from stale provider sends", () => {
    const fence = migration.slice(
      migration.indexOf(
        "create or replace function private.fence_sending_digest_subscriber_mutation()",
      ),
      migration.indexOf(
        "create or replace function public.unsubscribe_public_update_subscriber(",
      ),
    );
    expect(fence).toContain(
      "private.public_update_confirmation_outbox",
    );
    expect(fence).toContain("outbox.status = 'sending'");
    expect(fence).toContain("errcode = '40001'");
    expect(fence).toContain("status = 'privacy_scrubbed'");
    expect(fence).toContain("status = 'stale'");
    expect(fence).toContain(
      "before insert or update or delete on public.public_update_subscribers",
    );
    expect(fence).toContain(
      "Public-update activation requires the atomic DB-clock confirmation RPC.",
    );
    expect(fence).toContain("return old;");
    expect(fence).toContain(
      "new.confirmation_contract_version is distinct from",
    );
    expect(fence).toContain(
      "new.confirmation_sent_at is distinct from old.confirmation_sent_at",
    );
    expect(migration).toContain(
      "Privacy erasure must retry after an active public email send lease.",
    );
    expect(migration).toContain("confirmation_token_hash = null");
  });

  it("locks the subscriber before the outbox at provider authorization", () => {
    const authorize = migration.slice(
      migration.indexOf(
        "create or replace function public.authorize_public_update_confirmation_send(",
      ),
      migration.indexOf(
        "create or replace function public.complete_public_update_confirmation_send(",
      ),
    );
    const subscriberLock = authorize.indexOf(
      "from public.public_update_subscribers subscriber",
    );
    const outboxLock = authorize.indexOf(
      "from private.public_update_confirmation_outbox outbox",
      authorize.indexOf("for update;", subscriberLock) + 1,
    );
    expect(subscriberLock).toBeGreaterThanOrEqual(0);
    expect(outboxLock).toBeGreaterThan(subscriberLock);
    expect(authorize).not.toContain("for key share");
    expect(authorize).toContain(
      "v_subscriber.confirmation_contract_version is distinct from",
    );
    expect(authorize).toContain(
      "v_subscriber.confirmation_sent_at is not null",
    );
  });

  it("locks the subscriber before the outbox when recording provider acceptance", () => {
    const complete = migration.slice(
      migration.indexOf(
        "create or replace function public.complete_public_update_confirmation_send(",
      ),
      migration.indexOf(
        "create or replace function public.fail_public_update_confirmation_send(",
      ),
    );
    const subscriberLock = complete.indexOf(
      "from public.public_update_subscribers subscriber",
    );
    const outboxLock = complete.indexOf(
      "from private.public_update_confirmation_outbox outbox",
      complete.indexOf("for update;", subscriberLock) + 1,
    );
    expect(subscriberLock).toBeGreaterThanOrEqual(0);
    expect(outboxLock).toBeGreaterThan(subscriberLock);
    expect(complete.indexOf("v_now := pg_catalog.clock_timestamp()"))
      .toBeGreaterThan(outboxLock);
    expect(complete).toContain("v_outbox.expires_at > v_now");
  });

  it("keeps the public response non-enumerating and provider work deferred", () => {
    expect(subscribeRoute).toContain("nonEnumeratingResponseFloorMs");
    expect(subscribeRoute).toContain("after(async () =>");
    expect(subscribeRoute).toContain("drainPublicUpdateConfirmationOutbox");
    expect(subscribeRoute).toContain("subscriptionRequestResponse()");
    expect(subscribeRoute).toContain("If confirmation is needed");
    expect(subscribeRoute).not.toContain("confirmationToken");
    expect(confirmRoute).toContain("confirmPublicUpdateSubscription(token)");
    expect(confirmRoute).not.toContain("hasPublicUpdateTokenConfig");
    expect(recoveryCron).toContain("drainPublicUpdateConfirmationOutbox");
    expect(recoveryCron).toContain("drainPublicDigestOutbox");
  });

  it("includes catalog, role, clock, idempotency, activation, and erasure smoke", () => {
    for (const proof of [
      "set role anon",
      "set role authenticated",
      "set role service_role",
      "pg_catalog.clock_timestamp()",
      "same-generation request rotated or duplicated",
      "exact frozen provider payload",
      "direct subscriber activation bypassed",
      "old-shaped rolling-deploy insert was not neutralized",
      "direct confirmation-sent mutation was not fenced",
      "Expired max-attempt cleanup",
      "Provider acceptance was not recorded truthfully",
      "The accepted unexpired token did not activate",
      "Subscriber erasure did not scrub confirmation material",
    ]) {
      expect(smoke).toContain(proof);
    }
  });
});
