import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyBackfillPlan,
  backfillPlanHash,
  buildBackfillPlan,
  decryptLegacyPersonalDataV1,
  encryptPersonalDataV2,
  loadBackfillSource,
  personalDataConfig,
  personalDataLookupHashV1,
  personalDataLookupHashV2,
} from "./backfill-encrypted-personal-data.mjs";

const script = readFileSync(
  new URL("./backfill-encrypted-personal-data.mjs", import.meta.url),
  "utf8",
);
const config = {
  encryptionMaterial: "v2-encryption-material-000000000000000000000000",
  keyId: "prod-2026-07",
  lookupMaterial: "stable-lookup-material-000000000000000000000000",
  legacyMaterial: "legacy-material-0000000000000000000000000000",
};

describe("personal-data v2 recovery tooling", () => {
  it("uses explicit v2 key identity and a separate versioned lookup hash", () => {
    const encrypted = encryptPersonalDataV2("Advisor Example", config);
    const lookup = personalDataLookupHashV2("Advisor@Example.edu ", config);

    expect(encrypted).toMatch(/^ap:v2:prod-2026-07:/);
    expect(encrypted).not.toContain("Advisor Example");
    expect(lookup).toMatch(/^[0-9a-f]{64}$/);
    expect(lookup).toBe(
      personalDataLookupHashV2("advisor@example.edu", config),
    );
  });

  it("recovers only exact archived v1 bytes across retained archive history", () => {
    const fullNameCiphertext = encryptV1("Advisor Example", config.legacyMaterial);
    const organizationCiphertext = encryptV1(
      "Example University",
      config.legacyMaterial,
    );
    expect(decryptLegacyPersonalDataV1(fullNameCiphertext, config)).toBe(
      "Advisor Example",
    );

    const plan = buildBackfillPlan(
      {
        profiles: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            email: "advisor@example.edu",
            email_hash: "legacy-hash",
            full_name: null,
            organization: null,
            full_name_encrypted: fullNameCiphertext,
            organization_encrypted: organizationCiphertext,
            personal_data_reentry_required: true,
            updated_at: "2026-07-17T12:00:00.000Z",
          },
        ],
        archive: [
          archiveRow("full_name_encrypted", fullNameCiphertext),
          archiveRow("organization_encrypted", organizationCiphertext),
          archiveRow(
            "full_name_encrypted",
            encryptV1("Older Advisor Name", config.legacyMaterial),
          ),
        ],
        subscribers: [],
        recipientTables: {},
      },
      config,
      { recoverLegacyV1: true },
    );

    expect(plan.blocked).toEqual([]);
    expect(plan.profileOperations).toHaveLength(1);
    expect(plan.profileOperations[0]).toMatchObject({
      fields: {
        full_name_encrypted: "Advisor Example",
        organization_encrypted: "Example University",
      },
      shouldClearReentry: true,
    });
    expect(backfillPlanHash(plan)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("blocks recovery when current and archived bytes differ", () => {
    const current = encryptV1("Current", config.legacyMaterial);
    const archived = encryptV1("Archived", config.legacyMaterial);
    const plan = buildBackfillPlan(
      {
        profiles: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            email: null,
            email_hash: null,
            full_name: null,
            organization: null,
            full_name_encrypted: current,
            organization_encrypted: null,
            personal_data_reentry_required: true,
            updated_at: "2026-07-17T12:00:00.000Z",
          },
        ],
        archive: [archiveRow("full_name_encrypted", archived)],
        subscribers: [],
        recipientTables: {},
      },
      config,
      { recoverLegacyV1: true },
    );

    expect(plan.blocked).toContainEqual(
      expect.objectContaining({ reason: "archive_mismatch:full_name_encrypted" }),
    );
    expect(plan.profileOperations).toEqual([]);
  });

  it("recovers exact-key subscriber and outbox identities with the v2 lookup hash", () => {
    const email = "Legacy.Reader@Example.edu";
    const subscriberCiphertext = encryptV1(email, config.legacyMaterial);
    const outboxCiphertext = encryptV1(email, config.legacyMaterial);
    const legacyHash = personalDataLookupHashV1(email, config);
    const plan = buildBackfillPlan(
      {
        profiles: [],
        archive: [],
        subscribers: [
          {
            id: "00000000-0000-4000-8000-000000000101",
            email: null,
            email_hash: legacyHash,
            email_encrypted: subscriberCiphertext,
            status: "active",
            updated_at: "2026-07-17T12:00:00.000Z",
          },
        ],
        publicDigestOutbox: [
          {
            id: "00000000-0000-4000-8000-000000000102",
            subscriber_id: "00000000-0000-4000-8000-000000000101",
            recipient_hash: legacyHash,
            recipient_encrypted: outboxCiphertext,
            status: "terminal_failed",
            updated_at: "2026-07-17T12:01:00.000Z",
          },
        ],
        recipientTables: {},
      },
      config,
      { recoverLegacyV1: true },
    );

    expect(plan.blocked).toEqual([]);
    expect(plan.legacyContactQuarantineOperations).toEqual([]);
    expect(plan.legacyContactRecoveryOperations).toHaveLength(2);
    expect(plan.legacyContactRecoveryOperations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTable: "public_update_subscribers",
          email: "legacy.reader@example.edu",
          legacyEmailHash: legacyHash,
          v2EmailHash: personalDataLookupHashV2(email, config),
        }),
        expect.objectContaining({
          sourceTable: "public_digest_outbox",
          email: "legacy.reader@example.edu",
          v2EmailHash: personalDataLookupHashV2(email, config),
        }),
      ]),
    );
  });

  it("quarantines without plaintext when the exact key is absent or the old hash disagrees", () => {
    const ciphertext = encryptV1("legacy@example.edu", config.legacyMaterial);
    const source = {
      profiles: [],
      archive: [],
      subscribers: [
        {
          id: "00000000-0000-4000-8000-000000000103",
          email: null,
          email_hash: "f".repeat(64),
          email_encrypted: ciphertext,
          status: "active",
          updated_at: "2026-07-17T12:00:00.000Z",
        },
      ],
      publicDigestOutbox: [],
      recipientTables: {},
    };

    const withoutKey = buildBackfillPlan(source, config);
    expect(withoutKey.legacyContactRecoveryOperations).toEqual([]);
    expect(withoutKey.legacyContactQuarantineOperations).toHaveLength(1);
    expect(withoutKey.blocked[0].reason).toBe(
      "legacy_contact_exact_key_not_requested",
    );
    expect(withoutKey.legacyContactQuarantineOperations[0]).not.toHaveProperty(
      "email",
    );

    const hashMismatch = buildBackfillPlan(source, config, {
      recoverLegacyV1: true,
    });
    expect(hashMismatch.legacyContactRecoveryOperations).toEqual([]);
    expect(hashMismatch.legacyContactQuarantineOperations).toHaveLength(1);
    expect(hashMismatch.blocked[0].reason).toBe(
      "legacy_contact_lookup_hash_mismatch",
    );
  });

  it("uses retained plaintext to replace v1 profile and subscriber fields without the old key", () => {
    const plan = buildBackfillPlan(
      {
        profiles: [
          {
            id: "00000000-0000-4000-8000-000000000104",
            email: null,
            email_hash: "a".repeat(64),
            full_name: "Retained Name",
            organization: "Retained Organization",
            full_name_encrypted: "ap:v1:unreadable:name:ciphertext",
            organization_encrypted: "ap:v1:unreadable:org:ciphertext",
            personal_data_reentry_required: true,
            updated_at: "2026-07-17T12:00:00.000Z",
          },
        ],
        archive: [],
        subscribers: [
          {
            id: "00000000-0000-4000-8000-000000000105",
            email: "Retained.Reader@Example.edu",
            email_hash: "b".repeat(64),
            email_encrypted: "ap:v1:unreadable:email:ciphertext",
            status: "active",
            updated_at: "2026-07-17T12:01:00.000Z",
          },
        ],
        publicDigestOutbox: [],
        recipientTables: {},
      },
      config,
    );

    expect(plan.profileOperations[0]).toMatchObject({
      emailHash: "a".repeat(64),
      fields: {
        full_name_encrypted: "Retained Name",
        organization_encrypted: "Retained Organization",
      },
    });
    expect(plan.subscriberOperations).toEqual([]);
    expect(plan.legacyContactRecoveryOperations[0]).toMatchObject({
      sourceTable: "public_update_subscribers",
      recoveryKind: "retained_plaintext",
      email: "retained.reader@example.edu",
      v2EmailHash: personalDataLookupHashV2(
        "retained.reader@example.edu",
        config,
      ),
    });
    expect(plan.legacyContactQuarantineOperations).toEqual([]);
  });

  it("preserves an existing profile lookup hash when plaintext email is absent", () => {
    const existingHash = "c".repeat(64);
    const plan = buildBackfillPlan(
      {
        profiles: [
          {
            id: "00000000-0000-4000-8000-000000000106",
            email: null,
            email_hash: existingHash,
            full_name: null,
            organization: null,
            full_name_encrypted: "ap:v2:prod-2026-07:iv:tag:ciphertext",
            organization_encrypted: "ap:v2:prod-2026-07:iv:tag:ciphertext",
            personal_data_reentry_required: false,
            updated_at: "2026-07-17T12:00:00.000Z",
          },
        ],
        archive: [],
        subscribers: [],
        publicDigestOutbox: [],
        recipientTables: {},
      },
      config,
    );

    expect(plan.profileOperations).toEqual([]);
  });

  it("defaults to dry-run and requires a current plan hash for writes", () => {
    expect(script).toContain('if (!args.apply)');
    expect(script).toContain('args.confirm !== planHash');
    expect(script).toContain('.eq("updated_at", operation.expectedUpdatedAt)');
    expect(script).toContain('.eq("recipient", operation.expectedRecipient)');
    expect(script).not.toContain("console.log(operation.email)");
  });

  it("rejects shared lookup and encryption secrets", () => {
    expect(() =>
      personalDataConfig({
        APP_DATA_ENCRYPTION_KEY: "a".repeat(40),
        APP_DATA_ENCRYPTION_KEY_ID: "prod-2026-07",
        APP_DATA_LOOKUP_HMAC_KEY: "a".repeat(40),
      }),
    ).toThrow(/independent/);
  });

  it("accepts exact short decrypt-only material from the retired v1 writer", () => {
    expect(
      personalDataConfig(
        {
          APP_DATA_ENCRYPTION_KEY: "n".repeat(40),
          APP_DATA_ENCRYPTION_KEY_ID: "prod-2026-07",
          APP_DATA_LOOKUP_HMAC_KEY: "h".repeat(40),
          APP_DATA_LEGACY_V1_ENCRYPTION_KEY: "old-v1-key",
        },
        { requireLegacyKey: true },
      ).legacyMaterial,
    ).toBe("old-v1-key");
  });

  it("loads every exact filtered source row beyond one page", async () => {
    const tables = backfillTables();
    const supabase = inMemorySupabase(tables);

    const source = await loadBackfillSource(supabase, true, { pageSize: 2 });

    expect(source.profiles).toHaveLength(3);
    expect(source.subscribers).toHaveLength(3);
    expect(source.publicDigestOutbox).toHaveLength(3);
    expect(source.recipientTables.alert_deliveries).toHaveLength(3);
    expect(source.recipientTables.public_update_deliveries).toHaveLength(3);
    expect(source.archive).toHaveLength(3);
    expect(source.archive.map((row) => row.id)).toEqual(["ar-a", "ar-b", "ar-c"]);

    for (const table of Object.keys(tables)) {
      const calls = supabase.calls.filter((call) => call.table === table);
      expect(calls).toHaveLength(6);
      expect(calls.every((call) => call.selectOptions?.count === "exact")).toBe(true);
      expect(calls.some((call) => call.gt?.[0] === "id")).toBe(true);
    }
    for (const table of ["alert_deliveries", "public_update_deliveries"]) {
      const calls = supabase.calls.filter((call) => call.table === table);
      expect(calls.every((call) =>
        call.not.some((operation) =>
          operation[0] === "recipient" &&
          operation[1] === "is" &&
          operation[2] === null,
        ),
      )).toBe(true);
    }
  });

  it("fails closed when an exact backfill total is unavailable", async () => {
    const supabase = inMemorySupabase(backfillTables(), {
      countUnavailableFor: "profiles",
    });

    await expect(
      loadBackfillSource(supabase, false, { pageSize: 2 }),
    ).rejects.toThrow("exact row count was unavailable");
  });

  it("reports live-lease holds and tombstone erasure without claiming recovery", async () => {
    const supabase = {
      async rpc(name) {
        if (name === "quarantine_legacy_contact_ciphertext") {
          return { data: { state: "gate_hold", disabled: false }, error: null };
        }
        if (name === "recover_legacy_contact_ciphertext") {
          return { data: { state: "erased_by_tombstone" }, error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
      },
    };
    const base = {
      sourceTable: "public_update_subscribers",
      sourceRecordId: "00000000-0000-4000-8000-000000000107",
      expectedUpdatedAt: "2026-07-17T12:00:00.000Z",
      expectedCiphertextSha256: "d".repeat(64),
      expectedLookupHash: "e".repeat(64),
    };
    const applied = await applyBackfillPlan(
      supabase,
      {
        profileOperations: [],
        subscriberOperations: [],
        recipientOperations: [],
        legacyContactQuarantineOperations: [base],
        legacyContactRecoveryOperations: [
          {
            ...base,
            email: "erased@example.edu",
            v2EmailHash: personalDataLookupHashV2("erased@example.edu", config),
          },
        ],
      },
      config,
    );

    expect(applied).toMatchObject({
      legacyContactsQuarantined: 0,
      legacyContactsHeld: 1,
      legacyContactsRecovered: 0,
      legacyContactsErasedByTombstone: 1,
    });
  });
});

function backfillTables() {
  const timestamp = (index) => `2026-07-17T0${index}:00:00.000Z`;
  return {
    profiles: [1, 2, 3].map((index) => ({
      id: `p-${index}`,
      email: `profile${index}@example.edu`,
      email_hash: null,
      full_name: `Profile ${index}`,
      organization: "Example University",
      full_name_encrypted: null,
      organization_encrypted: null,
      personal_data_reentry_required: false,
      updated_at: timestamp(index),
    })),
    public_update_subscribers: [1, 2, 3].map((index) => ({
      id: `s-${index}`,
      email: `subscriber${index}@example.edu`,
      email_hash: null,
      email_encrypted: null,
      status: "active",
      updated_at: timestamp(index),
    })),
    public_digest_outbox: [1, 2, 3].map((index) => ({
      id: `ob-${index}`,
      subscriber_id: `s-${index}`,
      recipient_hash: null,
      recipient_encrypted: null,
      status: "terminal_failed",
      updated_at: timestamp(index),
    })),
    alert_deliveries: [1, 2, 3, 4].map((index) => ({
      id: `ad-${index}`,
      recipient: index === 4 ? null : `alert${index}@example.edu`,
      recipient_hash: null,
      created_at: timestamp(index),
    })),
    public_update_deliveries: [1, 2, 3, 4].map((index) => ({
      id: `pd-${index}`,
      recipient: index === 4 ? null : `public${index}@example.edu`,
      recipient_hash: null,
      created_at: timestamp(index),
    })),
    personal_data_legacy_ciphertext_archive: ["a", "b", "c"].map(
      (suffix, index) => ({
        id: `ar-${suffix}`,
        user_id: `p-${index + 1}`,
        source_column: "full_name_encrypted",
        ciphertext: `ap:v1:archive-${suffix}`,
        ciphertext_sha256: suffix.repeat(64),
        archived_at: timestamp(index + 1),
      }),
    ),
  };
}

function inMemorySupabase(
  tables,
  { countUnavailableFor = null } = {},
) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = {
        table,
        columns: null,
        selectOptions: null,
        orders: [],
        limit: null,
        gt: null,
        not: [],
      };
      calls.push(call);
      const builder = {
        select(columns, options) {
          call.columns = columns;
          call.selectOptions = options;
          return builder;
        },
        order(column, options) {
          call.orders.push([column, options]);
          return builder;
        },
        limit(value) {
          call.limit = value;
          return builder;
        },
        gt(column, value) {
          call.gt = [column, value];
          return builder;
        },
        not(column, operator, value) {
          call.not.push([column, operator, value]);
          return builder;
        },
        then(resolve, reject) {
          return Promise.resolve(runInMemoryQuery(tables, call, countUnavailableFor))
            .then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

function runInMemoryQuery(tables, call, countUnavailableFor) {
  let rows = [...(tables[call.table] || [])];
  for (const [column, operator, value] of call.not) {
    if (operator !== "is" || value !== null) {
      return { data: null, count: null, error: { message: "unsupported test filter" } };
    }
    rows = rows.filter((row) => row[column] !== null);
  }
  if (call.gt) {
    const [column, value] = call.gt;
    rows = rows.filter((row) => String(row[column]) > String(value));
  }
  rows.sort((left, right) => compareRows(left, right, call.orders));
  const count = call.table === countUnavailableFor ? null : rows.length;
  if (call.limit !== null) rows = rows.slice(0, call.limit);
  const columns = call.columns.split(",").map((column) => column.trim());
  return {
    data: rows.map((row) =>
      Object.fromEntries(columns.map((column) => [column, row[column]])),
    ),
    count,
    error: null,
  };
}

function compareRows(left, right, orders) {
  for (const [column, options] of orders) {
    const leftValue = left[column];
    const rightValue = right[column];
    if (leftValue === rightValue) continue;
    if (leftValue === null || leftValue === undefined) {
      return options?.nullsFirst ? -1 : 1;
    }
    if (rightValue === null || rightValue === undefined) {
      return options?.nullsFirst ? 1 : -1;
    }
    const comparison = String(leftValue) < String(rightValue) ? -1 : 1;
    return options?.ascending === false ? -comparison : comparison;
  }
  return 0;
}

function archiveRow(sourceColumn, ciphertext) {
  return {
    user_id: "00000000-0000-0000-0000-000000000001",
    source_column: sourceColumn,
    ciphertext,
    ciphertext_sha256: crypto
      .createHash("sha256")
      .update(ciphertext)
      .digest("hex"),
  };
}

function encryptV1(value, material) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(material).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "ap:v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}
