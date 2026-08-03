import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";
import { loadDeterministicSupabaseRows } from "./lib/deterministic-supabase-loader.mjs";

const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROFILE_FIELDS = [
  ["full_name", "full_name_encrypted"],
  ["organization", "organization_encrypted"],
];

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}

async function main() {
  loadEnv(".env.local");
  loadEnv(".vercel/.env.production.local");

  const args = parseArgs(process.argv.slice(2));
  const config = personalDataConfig(process.env, {
    requireLegacyKey: args.recoverLegacyV1,
  });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
    );
  }

  const supabase = createSupabaseServiceClient(supabaseUrl, serviceKey);
  const source = await loadBackfillSource(supabase, args.recoverLegacyV1);
  const plan = buildBackfillPlan(source, config, {
    recoverLegacyV1: args.recoverLegacyV1,
  });
  const planHash = backfillPlanHash(plan);
  const summary = summarizePlan(plan, planHash, args);

  if (!args.apply) {
    console.log(JSON.stringify(summary, null, 2));
    console.log(
      `Dry run only. To apply this exact plan, rerun with --apply --confirm ${planHash}`,
    );
    return;
  }

  if (args.confirm !== planHash) {
    throw new Error(
      `Refusing to apply: --confirm must equal the current plan hash ${planHash}.`,
    );
  }

  const applied = await applyBackfillPlan(supabase, plan, config);
  console.log(JSON.stringify({ ...summary, mode: "applied", applied }, null, 2));
}

export function personalDataConfig(env, { requireLegacyKey = false } = {}) {
  const encryptionMaterial = String(env.APP_DATA_ENCRYPTION_KEY || "").trim();
  const keyId = String(env.APP_DATA_ENCRYPTION_KEY_ID || "").trim();
  const lookupMaterial = String(env.APP_DATA_LOOKUP_HMAC_KEY || "").trim();
  const legacyMaterial = String(
    env.APP_DATA_LEGACY_V1_ENCRYPTION_KEY || "",
  ).trim();

  if (encryptionMaterial.length < 32) {
    throw new Error("APP_DATA_ENCRYPTION_KEY must contain at least 32 characters.");
  }
  if (encryptionMaterial === String(env.CRON_SECRET || "").trim()) {
    throw new Error("The encryption key must be independent from CRON_SECRET.");
  }
  if (!KEY_ID_PATTERN.test(keyId) || keyId === "local-dev") {
    throw new Error("APP_DATA_ENCRYPTION_KEY_ID is not a valid production key ID.");
  }
  if (lookupMaterial.length < 32) {
    throw new Error("APP_DATA_LOOKUP_HMAC_KEY must contain at least 32 characters.");
  }
  if (
    lookupMaterial === encryptionMaterial ||
    lookupMaterial === String(env.CRON_SECRET || "").trim()
  ) {
    throw new Error("The lookup HMAC key must be independent from other secrets.");
  }
  if (requireLegacyKey && legacyMaterial.length === 0) {
    throw new Error(
      "--recover-legacy-v1 requires the exact APP_DATA_LEGACY_V1_ENCRYPTION_KEY.",
    );
  }
  if (
    legacyMaterial &&
    (legacyMaterial === encryptionMaterial ||
      legacyMaterial === lookupMaterial ||
      legacyMaterial === String(env.CRON_SECRET || "").trim())
  ) {
    throw new Error("The recovered legacy key must not be reused by another purpose.");
  }

  return { encryptionMaterial, keyId, lookupMaterial, legacyMaterial };
}

export function encryptPersonalDataV2(value, config) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    deriveAesKey(config.encryptionMaterial),
    iv,
  );
  cipher.setAAD(Buffer.from(`ap:v2:${config.keyId}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "ap:v2",
    config.keyId,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptLegacyPersonalDataV1(value, config) {
  const parts = String(value || "").split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== "ap:v1") {
    throw new Error("Only exact ap:v1 ciphertext can use legacy recovery.");
  }
  const iv = Buffer.from(parts[2], "base64url");
  const tag = Buffer.from(parts[3], "base64url");
  const ciphertext = Buffer.from(parts[4], "base64url");
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) {
    throw new Error("The legacy ciphertext is malformed.");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveAesKey(config.legacyMaterial),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

export function personalDataLookupHashV2(value, config) {
  const hmacKey = crypto
    .createHash("sha256")
    .update("awardping:personal-data-lookup:v2\0")
    .update(config.lookupMaterial)
    .digest();
  return crypto
    .createHmac("sha256", hmacKey)
    .update(String(value).trim().toLowerCase())
    .digest("hex");
}

export function personalDataLookupHashV1(value, config) {
  if (!config.legacyMaterial) {
    throw new Error("The exact legacy encryption key is required for a v1 lookup hash.");
  }
  return crypto
    .createHmac("sha256", deriveAesKey(config.legacyMaterial))
    .update(normalizeRecoveredEmail(value))
    .digest("hex");
}

export function buildBackfillPlan(
  source,
  config,
  { recoverLegacyV1 = false } = {},
) {
  const archive = new Map();
  for (const row of source.archive || []) {
    const key = `${row.user_id}:${row.source_column}`;
    const rows = archive.get(key) || [];
    rows.push(row);
    archive.set(key, rows);
  }
  const profileOperations = [];
  const subscriberOperations = [];
  const recipientOperations = [];
  const legacyContactRecoveryOperations = [];
  const legacyContactQuarantineOperations = [];
  const blocked = [];

  for (const profile of source.profiles || []) {
    const fields = {};
    let fieldBlocked = false;
    for (const [plainColumn, encryptedColumn] of PROFILE_FIELDS) {
      const plaintext = profile[plainColumn];
      const ciphertext = profile[encryptedColumn];
      if (
        plaintext &&
        (!ciphertext || String(ciphertext).startsWith("ap:v1:"))
      ) {
        fields[encryptedColumn] = String(plaintext);
        continue;
      }
      if (
        recoverLegacyV1 &&
        profile.personal_data_reentry_required &&
        typeof ciphertext === "string" &&
        ciphertext.startsWith("ap:v1:")
      ) {
        const ciphertextHash = sha256(ciphertext);
        const archived = (archive.get(`${profile.id}:${encryptedColumn}`) || [])
          .find(
            (row) =>
              row.ciphertext === ciphertext &&
              row.ciphertext_sha256 === ciphertextHash,
          );
        if (!archived) {
          fieldBlocked = true;
          blocked.push({
            kind: "profile",
            id: profile.id,
            reason: `archive_mismatch:${encryptedColumn}`,
          });
          continue;
        }
        try {
          fields[encryptedColumn] = decryptLegacyPersonalDataV1(
            archived.ciphertext,
            config,
          );
        } catch {
          fieldBlocked = true;
          blocked.push({
            kind: "profile",
            id: profile.id,
            reason: `legacy_key_failed:${encryptedColumn}`,
          });
        }
      }
    }

    const effectiveV2 = Object.fromEntries(
      PROFILE_FIELDS.map(([, encryptedColumn]) => [
        encryptedColumn,
        typeof fields[encryptedColumn] === "string" ||
          String(profile[encryptedColumn] || "").startsWith("ap:v2:"),
      ]),
    );
    const emailHash = profile.email
      ? personalDataLookupHashV2(profile.email, config)
      : profile.email_hash || null;
    const shouldClearReentry =
      !fieldBlocked &&
      profile.personal_data_reentry_required &&
      PROFILE_FIELDS.every(([, encryptedColumn]) => effectiveV2[encryptedColumn]);
    const needsEmailHash = emailHash !== profile.email_hash;
    if (Object.keys(fields).length || shouldClearReentry || needsEmailHash) {
      profileOperations.push({
        id: profile.id,
        expectedUpdatedAt: profile.updated_at,
        fields,
        emailHash,
        shouldClearReentry,
      });
    }
  }

  for (const subscriber of source.subscribers || []) {
    if (
      subscriber.email &&
      !subscriber.email_encrypted
    ) {
      subscriberOperations.push({
        id: subscriber.id,
        expectedUpdatedAt: subscriber.updated_at,
        email: String(subscriber.email).trim().toLowerCase(),
        emailHash: personalDataLookupHashV2(subscriber.email, config),
      });
    } else if (
      subscriber.email &&
      String(subscriber.email_encrypted).startsWith("ap:v1:")
    ) {
      const email = normalizeRecoveredEmail(subscriber.email);
      legacyContactRecoveryOperations.push({
        sourceTable: "public_update_subscribers",
        sourceRecordId: subscriber.id,
        expectedUpdatedAt: subscriber.updated_at,
        expectedCiphertextSha256: sha256(subscriber.email_encrypted),
        expectedLookupHash: subscriber.email_hash || null,
        email,
        legacyEmailHash: null,
        v2EmailHash: personalDataLookupHashV2(email, config),
        recoveryKind: "retained_plaintext",
      });
    } else if (
      typeof subscriber.email_encrypted === "string" &&
      !subscriber.email_encrypted.startsWith("ap:v2:")
    ) {
      planLegacyContact({
        row: subscriber,
        sourceTable: "public_update_subscribers",
        ciphertextColumn: "email_encrypted",
        hashColumn: "email_hash",
        recoverLegacyV1,
        config,
        recoveryOperations: legacyContactRecoveryOperations,
        quarantineOperations: legacyContactQuarantineOperations,
        blocked,
      });
    }
  }

  for (const outbox of source.publicDigestOutbox || []) {
    if (
      typeof outbox.recipient_encrypted === "string" &&
      !outbox.recipient_encrypted.startsWith("ap:v2:")
    ) {
      planLegacyContact({
        row: outbox,
        sourceTable: "public_digest_outbox",
        ciphertextColumn: "recipient_encrypted",
        hashColumn: "recipient_hash",
        recoverLegacyV1,
        config,
        recoveryOperations: legacyContactRecoveryOperations,
        quarantineOperations: legacyContactQuarantineOperations,
        blocked,
      });
    }
  }

  for (const [table, rows] of Object.entries(source.recipientTables || {})) {
    for (const row of rows || []) {
      if (!row.recipient) continue;
      recipientOperations.push({
        table,
        id: row.id,
        expectedRecipient: row.recipient,
        recipientHash: personalDataLookupHashV2(row.recipient, config),
      });
    }
  }

  return {
    schemaVersion: "personal-data-v2-backfill-plan-v2",
    profileOperations,
    subscriberOperations,
    recipientOperations,
    legacyContactRecoveryOperations,
    legacyContactQuarantineOperations,
    blocked,
  };
}

function planLegacyContact({
  row,
  sourceTable,
  ciphertextColumn,
  hashColumn,
  recoverLegacyV1,
  config,
  recoveryOperations,
  quarantineOperations,
  blocked,
}) {
  const ciphertext = row[ciphertextColumn];
  const expectedCiphertextSha256 = sha256(ciphertext);
  const base = {
    sourceTable,
    sourceRecordId: row.id,
    expectedUpdatedAt: row.updated_at,
    expectedCiphertextSha256,
    expectedLookupHash: row[hashColumn] || null,
  };

  if (!String(ciphertext).startsWith("ap:v1:")) {
    quarantineOperations.push(base);
    blocked.push({
      kind: sourceTable,
      id: row.id,
      reason: "unsupported_non_v2_contact_ciphertext",
    });
    return;
  }

  if (!recoverLegacyV1) {
    quarantineOperations.push(base);
    blocked.push({
      kind: sourceTable,
      id: row.id,
      reason: "legacy_contact_exact_key_not_requested",
    });
    return;
  }

  try {
    const email = normalizeRecoveredEmail(
      decryptLegacyPersonalDataV1(ciphertext, config),
    );
    const v2EmailHash = personalDataLookupHashV2(email, config);
    const legacyEmailHash = personalDataLookupHashV1(email, config);
    if (
      base.expectedLookupHash &&
      base.expectedLookupHash !== legacyEmailHash &&
      base.expectedLookupHash !== v2EmailHash
    ) {
      quarantineOperations.push(base);
      blocked.push({
        kind: sourceTable,
        id: row.id,
        reason: "legacy_contact_lookup_hash_mismatch",
      });
      return;
    }
    recoveryOperations.push({
      ...base,
      email,
      legacyEmailHash,
      v2EmailHash,
    });
  } catch {
    quarantineOperations.push(base);
    blocked.push({
      kind: sourceTable,
      id: row.id,
      reason: "legacy_contact_exact_key_failed",
    });
  }
}

export function backfillPlanHash(plan) {
  const identity = {
    schemaVersion: plan.schemaVersion,
    profiles: plan.profileOperations.map((operation) => ({
      id: operation.id,
      expectedUpdatedAt: operation.expectedUpdatedAt,
      fields: Object.fromEntries(
        Object.entries(operation.fields)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([column, plaintext]) => [column, sha256(plaintext)]),
      ),
      emailHash: operation.emailHash,
      clearsReentry: operation.shouldClearReentry,
    })),
    subscribers: plan.subscriberOperations.map((operation) => ({
      id: operation.id,
      expectedUpdatedAt: operation.expectedUpdatedAt,
      emailHash: operation.emailHash,
    })),
    recipients: plan.recipientOperations.map((operation) => ({
      table: operation.table,
      id: operation.id,
      expectedRecipientSha256: sha256(operation.expectedRecipient),
    })),
    legacyContactRecovery: plan.legacyContactRecoveryOperations.map(
      (operation) => ({
        sourceTable: operation.sourceTable,
        sourceRecordId: operation.sourceRecordId,
        expectedUpdatedAt: operation.expectedUpdatedAt,
        expectedCiphertextSha256: operation.expectedCiphertextSha256,
        expectedLookupHash: operation.expectedLookupHash,
        recoveredEmailSha256: sha256(operation.email),
        legacyEmailHash: operation.legacyEmailHash,
        v2EmailHash: operation.v2EmailHash,
      }),
    ),
    legacyContactQuarantine: plan.legacyContactQuarantineOperations,
    blocked: plan.blocked,
  };
  return sha256(stableJson(identity));
}

export async function applyBackfillPlan(supabase, plan, config) {
  const applied = {
    profiles: 0,
    subscribers: 0,
    recipients: 0,
    legacyContactsRecovered: 0,
    legacyContactsQuarantined: 0,
    legacyContactsHeld: 0,
    legacyContactsErasedByTombstone: 0,
  };
  for (const operation of plan.profileOperations) {
    const update = {
      email_hash: operation.emailHash,
      updated_at: new Date().toISOString(),
    };
    for (const [encryptedColumn, plaintext] of Object.entries(operation.fields)) {
      update[encryptedColumn] = encryptPersonalDataV2(plaintext, config);
      update[encryptedColumn.replace("_encrypted", "")] = null;
    }
    if (operation.shouldClearReentry) {
      update.personal_data_reentry_required = false;
      update.personal_data_reentry_reason = null;
      update.personal_data_reentry_marked_at = null;
      update.personal_data_reentered_at = new Date().toISOString();
    }
    const { data, error } = await supabase
      .from("profiles")
      .update(update)
      .eq("id", operation.id)
      .eq("updated_at", operation.expectedUpdatedAt)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`Profile ${operation.id} changed after planning.`);
    applied.profiles += 1;
  }

  for (const operation of plan.subscriberOperations) {
    const { data, error } = await supabase
      .from("public_update_subscribers")
      .update({
        email: null,
        email_hash: operation.emailHash,
        email_encrypted: encryptPersonalDataV2(operation.email, config),
        updated_at: new Date().toISOString(),
      })
      .eq("id", operation.id)
      .eq("updated_at", operation.expectedUpdatedAt)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`Subscriber ${operation.id} changed after planning.`);
    applied.subscribers += 1;
  }

  for (const operation of plan.recipientOperations) {
    const { data, error } = await supabase
      .from(operation.table)
      .update({ recipient: null, recipient_hash: operation.recipientHash })
      .eq("id", operation.id)
      .eq("recipient", operation.expectedRecipient)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new Error(
        `${operation.table} recipient ${operation.id} changed after planning.`,
      );
    }
    applied.recipients += 1;
  }

  for (const operation of plan.legacyContactQuarantineOperations) {
    const { data, error } = await supabase.rpc(
      "quarantine_legacy_contact_ciphertext",
      {
        p_source_table: operation.sourceTable,
        p_source_record_id: operation.sourceRecordId,
        p_expected_updated_at: operation.expectedUpdatedAt,
        p_expected_ciphertext_sha256: operation.expectedCiphertextSha256,
      },
    );
    if (error) throw error;
    if (!data) {
      throw new Error(
        `${operation.sourceTable} ${operation.sourceRecordId} changed after planning.`,
      );
    }
    const outcome = jsonObject(data);
    if (outcome.state === "gate_hold" || outcome.disabled !== true) {
      applied.legacyContactsHeld += 1;
    } else if (outcome.state === "disabled_retained") {
      applied.legacyContactsQuarantined += 1;
    } else {
      throw new Error(
        `${operation.sourceTable} ${operation.sourceRecordId} returned an unknown quarantine state.`,
      );
    }
  }

  const orderedLegacyRecoveries = [...plan.legacyContactRecoveryOperations].sort(
    (left, right) => {
      const leftRank = left.sourceTable === "public_digest_outbox" ? 0 : 1;
      const rightRank = right.sourceTable === "public_digest_outbox" ? 0 : 1;
      return leftRank - rightRank ||
        left.sourceRecordId.localeCompare(right.sourceRecordId);
    },
  );
  for (const operation of orderedLegacyRecoveries) {
    const { data, error } = await supabase.rpc(
      "recover_legacy_contact_ciphertext",
      {
        p_source_table: operation.sourceTable,
        p_source_record_id: operation.sourceRecordId,
        p_expected_updated_at: operation.expectedUpdatedAt,
        p_expected_ciphertext_sha256: operation.expectedCiphertextSha256,
        p_expected_lookup_hash: operation.expectedLookupHash,
        p_v2_email_hash: operation.v2EmailHash,
        p_v2_email_encrypted: encryptPersonalDataV2(operation.email, config),
      },
    );
    if (error) throw error;
    if (!data) {
      throw new Error(
        `${operation.sourceTable} ${operation.sourceRecordId} changed after planning.`,
      );
    }
    const outcome = jsonObject(data);
    if (
      [
        "recovered_v2",
        "recovered_v2_outbox_scrubbed",
        "canonical_v2_merged",
      ].includes(outcome.state)
    ) {
      applied.legacyContactsRecovered += 1;
    } else if (outcome.state === "erased_by_tombstone") {
      applied.legacyContactsErasedByTombstone += 1;
    } else {
      throw new Error(
        `${operation.sourceTable} ${operation.sourceRecordId} returned an unknown recovery state.`,
      );
    }
  }
  return applied;
}

export async function loadBackfillSource(
  supabase,
  includeArchive,
  { pageSize, maximumRows } = {},
) {
  const common = { supabase, pageSize, maximumRows };
  const [
    profiles,
    subscribers,
    publicDigestOutbox,
    alertDeliveries,
    publicUpdateDeliveries,
    archive,
  ] =
    await Promise.all([
      loadDeterministicSupabaseRows({
        ...common,
        table: "profiles",
        select:
          "id, email, email_hash, full_name, organization, full_name_encrypted, organization_encrypted, personal_data_reentry_required, updated_at",
        label: "personal-data backfill profiles",
      }),
      loadDeterministicSupabaseRows({
        ...common,
        table: "public_update_subscribers",
        select: "id, email, email_hash, email_encrypted, status, updated_at",
        label: "personal-data backfill subscribers",
      }),
      loadDeterministicSupabaseRows({
        ...common,
        table: "public_digest_outbox",
        select:
          "id, subscriber_id, recipient_hash, recipient_encrypted, status, updated_at",
        label: "personal-data backfill public digest outbox",
      }),
      loadDeterministicSupabaseRows({
        ...common,
        table: "alert_deliveries",
        select: "id, recipient, recipient_hash, created_at",
        revisionColumn: "created_at",
        filterQuery: (query) => query.not("recipient", "is", null),
        label: "personal-data backfill alert deliveries",
      }),
      loadDeterministicSupabaseRows({
        ...common,
        table: "public_update_deliveries",
        select: "id, recipient, recipient_hash, created_at",
        revisionColumn: "created_at",
        filterQuery: (query) => query.not("recipient", "is", null),
        label: "personal-data backfill public update deliveries",
      }),
      includeArchive
        ? loadDeterministicSupabaseRows({
            ...common,
            table: "personal_data_legacy_ciphertext_archive",
            select:
              "id, user_id, source_column, ciphertext, ciphertext_sha256, archived_at",
            revisionColumn: "archived_at",
            label: "personal-data legacy ciphertext archive",
          })
        : Promise.resolve([]),
    ]);
  return {
    profiles,
    subscribers,
    publicDigestOutbox,
    archive,
    recipientTables: {
      alert_deliveries: alertDeliveries,
      public_update_deliveries: publicUpdateDeliveries,
    },
  };
}

function summarizePlan(plan, planHash, args) {
  return {
    schemaVersion: plan.schemaVersion,
    mode: args.apply ? "apply_requested" : "dry_run",
    legacyRecoveryRequested: args.recoverLegacyV1,
    planHash,
    profiles: plan.profileOperations.length,
    subscribers: plan.subscriberOperations.length,
    recipients: plan.recipientOperations.length,
    legacyContactsRecovered: plan.legacyContactRecoveryOperations.length,
    legacyContactsQuarantined: plan.legacyContactQuarantineOperations.length,
    blocked: plan.blocked.length,
    blockedReasons: countBy(plan.blocked, (item) => item.reason),
    secretValuesPrinted: false,
    plaintextValuesPrinted: false,
  };
}

function parseArgs(args) {
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run");
  if (apply && dryRun) throw new Error("Choose --apply or --dry-run, not both.");
  const confirmIndex = args.indexOf("--confirm");
  return {
    apply,
    confirm: confirmIndex >= 0 ? args[confirmIndex + 1] || null : null,
    recoverLegacyV1: args.includes("--recover-legacy-v1"),
  };
}

function deriveAesKey(material) {
  return crypto.createHash("sha256").update(material).digest();
}

function normalizeRecoveredEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Recovered legacy contact plaintext is not a valid email address.");
  }
  return email;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function countBy(rows, picker) {
  return Object.fromEntries(
    Array.from(
      rows.reduce((counts, row) => {
        const key = picker(row);
        counts.set(key, (counts.get(key) || 0) + 1);
        return counts;
      }, new Map()),
    ).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function loadEnv(path) {
  const fullPath = resolve(path);
  if (!existsSync(fullPath)) return;
  const content = readFileSync(fullPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = unquote(trimmed.slice(index + 1).trim());
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
