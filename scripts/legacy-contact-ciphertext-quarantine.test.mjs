import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260717123000_legacy_contact_ciphertext_quarantine.sql",
    import.meta.url,
  ),
  "utf8",
);
const runtime = readFileSync(
  new URL("../src/lib/public-updates.ts", import.meta.url),
  "utf8",
);
const backfill = readFileSync(
  new URL("./backfill-encrypted-personal-data.mjs", import.meta.url),
  "utf8",
);
const privacyDelete = readFileSync(
  new URL("../src/app/api/privacy/delete/route.ts", import.meta.url),
  "utf8",
);
const privacyExport = readFileSync(
  new URL("../src/app/api/privacy/export/route.ts", import.meta.url),
  "utf8",
);

describe("legacy contact ciphertext quarantine", () => {
  it("inventories every v1 contact deterministically without duplicating ciphertext", () => {
    expect(migration).toContain(
      "create table public.personal_data_legacy_contact_quarantine",
    );
    expect(migration).toContain("subscriber.email_encrypted like 'ap:v1:%'");
    expect(migration).toContain("outbox.recipient_encrypted like 'ap:v1:%'");
    expect(migration).toContain(
      "order by legacy_contact.source_table, legacy_contact.source_record_id",
    );
    expect(migration).toContain(
      "unique (source_table, source_record_id, source_column)",
    );
    expect(migration).not.toMatch(
      /personal_data_legacy_contact_quarantine\s*\([\s\S]{0,1800}\bciphertext\s+text/i,
    );
    expect(migration).toContain(
      "revoke all on table public.personal_data_legacy_contact_quarantine",
    );
  });

  it("disables no-key v1 rows and prevents all non-v2 active/sendable writes", () => {
    expect(migration).toContain("status = 'unsubscribed'");
    expect(migration).toContain("status = 'terminal_failed'");
    expect(migration).toContain(
      "Legacy recipient ciphertext was quarantined and is not sendable.",
    );
    expect(migration).toContain(
      "status not in ('pending', 'active')\n    or coalesce(email_encrypted, '') like 'ap:v2:%'",
    );
    expect(migration).toContain(
      "or coalesce(recipient_encrypted, '') like 'ap:v2:%'",
    );
    expect(migration).toContain("not valid");
  });

  it("refuses v1 enqueue, claim, reactivation, and provider authorization in SQL", () => {
    expect(migration).toContain(
      "coalesce(v_entry ->> 'recipient_encrypted', '') not like 'ap:v2:%'",
    );
    expect(migration).toContain(
      "v_subscriber.email_encrypted is distinct from v_entry ->> 'recipient_encrypted'",
    );
    expect(migration).toContain(
      "coalesce(v_existing.recipient_encrypted, '') like 'ap:v2:%'",
    );
    expect(migration).toContain(
      "coalesce(outbox.recipient_encrypted, '') like 'ap:v2:%'",
    );
    expect(migration).toContain(
      "subscriber.email_encrypted = outbox.recipient_encrypted",
    );
    expect(migration).toContain(
      "coalesce(v_outbox.recipient_encrypted, '') not like 'ap:v2:%'",
    );
  });

  it("uses exact source revision/cipher/hash CAS and tombstone-before-recovery", () => {
    const recovery = migration.slice(
      migration.indexOf(
        "create or replace function public.recover_legacy_contact_ciphertext(",
      ),
      migration.indexOf(
        "create or replace function public.erase_personal_data_for_privacy_request(",
      ),
    );
    for (const contract of [
      "subscriber.updated_at = p_expected_updated_at",
      "outbox.updated_at = p_expected_updated_at",
      "p_expected_ciphertext_sha256",
      "subscriber.email_hash is not distinct from p_expected_lookup_hash",
      "outbox.recipient_hash is not distinct from p_expected_lookup_hash",
      "where tombstone.v2_email_hash = p_v2_email_hash",
      "prior_erasure_tombstone_applied_before_recovery",
      "p_v2_email_encrypted not like 'ap:v2:%'",
    ]) {
      expect(recovery).toContain(contract);
    }
    expect(recovery).toContain("exact_key_recovered_subscriber_v2");
    expect(recovery).toContain("exact_key_recovered_identity_outbox_scrubbed");
    expect(recovery).toContain("Recovery restores identity, not consent");
    expect(recovery).toContain("status = 'unsubscribed'");
    expect(recovery).not.toContain("then v_quarantine.original_status");
    expect(recovery).not.toContain("recipient_encrypted = p_v2_email_encrypted");
  });

  it("resolves every linked outbox quarantine row whenever subscriber recovery scrubs it", () => {
    const recovery = migration.slice(
      migration.indexOf(
        "create or replace function public.recover_legacy_contact_ciphertext(",
      ),
      migration.indexOf(
        "create or replace function public.get_personal_data_legacy_contact_export(",
      ),
    );
    expect(recovery).toContain(
      "v_linked_outbox_ids uuid[] := '{}'::uuid[]",
    );
    expect(recovery).toContain(
      "array_agg(outbox.id order by outbox.id)",
    );
    expect(recovery).toContain(
      "quarantine.source_record_id = any(v_linked_outbox_ids)",
    );
    expect(recovery).toContain(
      "Legacy subscriber tombstone did not resolve every linked outbox quarantine row.",
    );
    expect(recovery).toContain(
      "exact_key_bound_to_existing_canonical_v2_subscriber_outbox_scrubbed",
    );
    expect(recovery).toContain(
      "Legacy canonical merge did not resolve every linked outbox quarantine row.",
    );
    expect(
      recovery.match(/where outbox\.id = any\(v_linked_outbox_ids\)/g),
    ).toHaveLength(3);
  });

  it("makes deletion one pending-request transaction and supports bound unknown-artifact erasure", () => {
    const erasure = migration.slice(
      migration.indexOf(
        "create or replace function public.erase_personal_data_for_privacy_request(",
      ),
      migration.indexOf("do $awardping_v2_enqueue_fence$"),
    );
    expect(erasure).toContain("privacy_request.status = 'pending'");
    expect(erasure).toContain("personal_data_erasure_tombstones");
    expect(erasure).toContain(
      "public.erase_personal_data_legacy_archive_for_privacy_request(",
    );
    expect(erasure).toContain("recipient_encrypted = null");
    expect(erasure).toContain("delete from public.source_page_requests");
    expect(erasure).toContain("delete from public.discovery_requests");
    expect(erasure).toContain("delete from public.alert_deliveries");
    expect(erasure).toContain("update public.shared_awards award");
    expect(erasure).toContain("update public.shared_award_sources source");
    expect(erasure).toContain("where request.user_id = p_user_id");
    expect(erasure).toContain("where delivery.user_id = p_user_id");
    expect(erasure).toContain("where award.submitted_by_user_id = p_user_id");
    expect(erasure).toContain("where source.submitted_by_user_id = p_user_id");
    const requestBindingAt = erasure.indexOf(
      "privacy_request.email_hash is not distinct from p_email_hash",
    );
    const activeLeasePreconditionAt = erasure.indexOf(
      "Privacy erasure must retry after the active public digest send lease.",
    );
    const accountDataErasureAt = erasure.indexOf(
      "delete from public.source_page_requests",
    );
    expect(requestBindingAt).toBeGreaterThan(-1);
    expect(activeLeasePreconditionAt).toBeGreaterThan(requestBindingAt);
    expect(accountDataErasureAt).toBeGreaterThan(activeLeasePreconditionAt);
    expect(erasure).toContain("delete from public.public_update_subscribers");
    expect(erasure).toContain("erasure_tombstone_id = v_tombstone_id");
    expect(erasure).not.toContain("v_legacy_email_hash");
    expect(erasure).not.toContain(
      "quarantine.legacy_lookup_hash = p_email_hash",
    );
    expect(erasure).toContain("legacy_contact_identity_unavailable");
    expect(erasure).toContain("legacy_contact_identity_resolved");
    expect(erasure).toContain("'privacy-app-data-erasure-v1'");
    expect(erasure).toContain("pg_catalog.clock_timestamp() at time zone 'UTC'");
    expect(erasure).toContain("'{app_data_erasure}'");
    expect(erasure).toContain("Personal-data erasure completion marker CAS failed.");
    expect(erasure.indexOf("legacy_contact_erasure_incomplete")).toBeLessThan(
      erasure.indexOf("'{app_data_erasure}'"),
    );
    expect(erasure.indexOf("'{app_data_erasure}'")).toBeLessThan(
      erasure.indexOf("'app_data_erasure_marker', v_app_erasure_marker"),
    );
    expect(erasure).toContain(
      "where quarantine.lifecycle_status = 'disabled_retained'",
    );
    expect(erasure).toContain(
      "revoke all on function public.erase_public_update_subscriber(text, text)",
    );
    expect(erasure).toContain("{legacy_contact_quarantine,id}");
    expect(erasure).toContain("{legacy_contact_quarantine,ciphertext_sha256}");
    expect(privacyDelete).toContain(
      'admin.rpc("erase_personal_data_for_privacy_request"',
    );
    expect(privacyDelete).not.toContain(
      'admin.rpc("erase_public_update_subscriber"',
    );
    expect(privacyDelete).not.toContain(
      'admin.rpc("erase_personal_data_legacy_archive_for_privacy_request"',
    );
    expect(privacyDelete).not.toContain("p_legacy_email_hash");
    expect(privacyDelete).not.toContain(
      'from("source_page_requests").delete()',
    );
    expect(privacyDelete).not.toContain(
      'from("discovery_requests").delete()',
    );
    expect(privacyDelete).not.toContain(
      'from("alert_deliveries").delete()',
    );
    expect(privacyDelete).not.toContain(
      'from("shared_awards").update(',
    );
    expect(privacyDelete).not.toContain(
      'from("shared_award_sources")',
    );
    expect(migration).toContain(
      "before insert or update or delete on public.public_update_subscribers",
    );
    expect(migration).toContain(
      "private.public_digest_subscriber_fence_before_statement()",
    );
  });

  it("binds exact non-v2 counts into both digest and signed Stage 1 gates", () => {
    const delegate = "stage1_gate_without_contact_fence_20260717123000";
    expect(delegate.length).toBeLessThanOrEqual(63);
    expect(migration).toContain(
      `rename to ${delegate};`,
    );
    expect(migration).toContain(
      `private.${delegate}(`,
    );
    expect(migration).toContain("subscriber_non_v2_total");
    expect(migration).toContain("outbox_non_v2_total");
    expect(migration).toContain("unquarantined_non_v2");
    expect(migration).toContain("private.personal_data_legacy_contact_gate_safe()");
    expect(migration).toContain(
      delegate,
    );
    expect(migration).toContain("legacy_contact_ciphertext_not_safe");
    expect(migration).toContain(
      "'state_hash', public.stage1_publication_evidence_hash(v_basis)",
    );
  });

  it("never copies readable v1 and blocks an incomplete legacy export", () => {
    expect(runtime).toContain('storedEmail.format === "ap:v2"');
    expect(runtime).toContain("isV2PersonalDataCiphertext");
    expect(runtime).toContain(
      "Legacy or malformed recipient ciphertext was refused before provider authorization.",
    );
    expect(backfill).toContain('table: "public_digest_outbox"');
    expect(backfill).toContain('"recover_legacy_contact_ciphertext"');
    expect(backfill).toContain('"quarantine_legacy_contact_ciphertext"');
    expect(privacyExport).toContain("admin.rpc(");
    expect(privacyExport).toContain(
      '"get_personal_data_legacy_contact_export"',
    );
    expect(privacyExport).toContain("legacyContactArtifacts");
    expect(privacyExport).toContain(
      "p_v2_email_hash: emailHash",
    );
    expect(privacyExport).not.toContain("p_legacy_email_hash");
    expect(privacyExport).toContain("legacy_contact_identity_unavailable");
    expect(migration).toContain(
      "select count(*)\n  into v_unattributable_retained_items",
    );
    expect(privacyExport).not.toContain("recipient_encrypted");
  });
});
