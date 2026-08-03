import "server-only";

import crypto from "node:crypto";
import { appConfig } from "@/lib/config";

const legacyCipherPrefix = "ap:v1";
const cipherPrefix = "ap:v2";
const localDevEncryptionKey =
  "awardping-local-development-personal-data-encryption-key";
const localDevLookupKey =
  "awardping-local-development-personal-data-lookup-key";
const localDevKeyId = "local-dev";
const keyIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type PersonalDataUnavailableReason =
  | "legacy_key_unavailable"
  | "unknown_key_id"
  | "invalid_ciphertext"
  | "missing_configuration";

export class PersonalDataUnavailableError extends Error {
  readonly reason: PersonalDataUnavailableReason;
  readonly format: "ap:v1" | "ap:v2" | "unknown";
  readonly keyId: string | null;

  constructor({
    message,
    reason,
    format,
    keyId = null,
    cause,
  }: {
    message: string;
    reason: PersonalDataUnavailableReason;
    format: "ap:v1" | "ap:v2" | "unknown";
    keyId?: string | null;
    cause?: unknown;
  }) {
    super(message, { cause });
    this.name = "PersonalDataUnavailableError";
    this.reason = reason;
    this.format = format;
    this.keyId = keyId;
  }
}

export function normalizePersonalEmail(value: string) {
  return value.trim().toLowerCase();
}

export function personalDataLookupHash(value: string) {
  return crypto
    .createHmac("sha256", lookupHmacKey())
    .update(value.trim().toLowerCase())
    .digest("hex");
}

export function encryptPersonalData(value: string) {
  const { keyId, key } = activeEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${cipherPrefix}:${keyId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    cipherPrefix,
    keyId,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptPersonalData(value: string | null | undefined) {
  if (!value) return null;
  const parts = value.split(":");
  const format = `${parts[0] || ""}:${parts[1] || ""}`;

  if (format === legacyCipherPrefix) {
    if (parts.length !== 5) {
      throw unavailable(
        "The legacy personal-data ciphertext is malformed.",
        "invalid_ciphertext",
        "ap:v1",
      );
    }
    return decryptAesGcm({
      value,
      format: "ap:v1",
      keyId: null,
      key: legacyV1EncryptionKey(),
      iv: parts[2],
      tag: parts[3],
      ciphertext: parts[4],
    });
  }

  if (format !== cipherPrefix || parts.length !== 6) {
    throw unavailable(
      "The personal-data ciphertext format is not supported.",
      "invalid_ciphertext",
      "unknown",
    );
  }

  const [, , keyId, iv, tag, ciphertext] = parts;
  if (!keyIdPattern.test(keyId)) {
    throw unavailable(
      "The personal-data ciphertext key identifier is invalid.",
      "invalid_ciphertext",
      "ap:v2",
      keyId,
    );
  }
  return decryptAesGcm({
    value,
    format: "ap:v2",
    keyId,
    key: decryptionKeyForId(keyId),
    iv,
    tag,
    ciphertext,
  });
}

export function readPersonalData(value: string | null | undefined) {
  if (!value) {
    return {
      status: "empty" as const,
      value: null,
      format: null,
      keyId: null,
      reason: null,
    };
  }

  try {
    const plaintext = decryptPersonalData(value);
    const parts = value.split(":");
    return {
      status: "available" as const,
      value: plaintext,
      format: `${parts[0]}:${parts[1]}` as "ap:v1" | "ap:v2",
      keyId: parts[1] === "v2" ? parts[2] : null,
      reason: null,
    };
  } catch (error) {
    if (!(error instanceof PersonalDataUnavailableError)) throw error;
    return {
      status: "unavailable" as const,
      value: null,
      format: error.format,
      keyId: error.keyId,
      reason: error.reason,
    };
  }
}

export function encryptedEmailFields(rawEmail: string) {
  const email = normalizePersonalEmail(rawEmail);

  return {
    email,
    email_hash: personalDataLookupHash(email),
    email_encrypted: encryptPersonalData(email),
  };
}

export function encryptedProfileFields(input: {
  email?: string | null;
  fullName: string;
  organization: string;
}) {
  return {
    email_hash: input.email ? personalDataLookupHash(input.email) : null,
    full_name: null,
    organization: null,
    full_name_encrypted: encryptPersonalData(input.fullName.trim()),
    organization_encrypted: encryptPersonalData(input.organization.trim()),
    personal_data_reentry_required: false,
    personal_data_reentry_reason: null,
    personal_data_reentry_marked_at: null,
    personal_data_reentered_at: new Date().toISOString(),
  };
}

export function decryptProfileFields<
  T extends {
    full_name?: string | null;
    organization?: string | null;
    full_name_encrypted?: string | null;
    organization_encrypted?: string | null;
    personal_data_reentry_required?: boolean;
    personal_data_reentry_reason?: string | null;
  },
>(profile: T | null | undefined) {
  if (!profile) return null;

  const {
    full_name_encrypted: fullNameEncrypted,
    organization_encrypted: organizationEncrypted,
    ...safeProfile
  } = profile;
  const fullName = readPersonalData(fullNameEncrypted);
  const organization = readPersonalData(organizationEncrypted);
  const unavailableFields = [
    ...(fullName.status === "unavailable" ? ["full_name"] : []),
    ...(organization.status === "unavailable" ? ["organization"] : []),
  ];
  const unavailableReasons = Array.from(
    new Set(
      [fullName.reason, organization.reason].filter(
        (reason): reason is PersonalDataUnavailableReason => Boolean(reason),
      ),
    ),
  );
  const reentryRequired = Boolean(
    profile.personal_data_reentry_required || unavailableFields.length,
  );
  const legacyRecoveryAvailable = Boolean(
    profile.personal_data_reentry_required &&
      unavailableFields.length === 0 &&
      [fullName, organization].some(
        (field) => field.status === "available" && field.format === "ap:v1",
      ),
  );
  const resolvedFullName =
    fullName.status === "available"
      ? fullName.value
      : fullName.status === "empty"
        ? profile.full_name || null
        : null;
  const resolvedOrganization =
    organization.status === "available"
      ? organization.value
      : organization.status === "empty"
        ? profile.organization || null
        : null;

  return {
    ...safeProfile,
    full_name: resolvedFullName,
    organization: resolvedOrganization,
    personal_data_reentry_required: reentryRequired,
    personal_data_status: legacyRecoveryAvailable
      ? ("legacy_recovery_available" as const)
      : reentryRequired
        ? ("reentry_required" as const)
        : resolvedFullName && resolvedOrganization
          ? ("available" as const)
          : ("missing" as const),
    personal_data_legacy_recovery_available: legacyRecoveryAvailable,
    personal_data_unavailable_fields: unavailableFields,
    personal_data_unavailable_reasons: unavailableReasons,
  };
}

function activeEncryptionKey() {
  const material = productionValue(
    appConfig.dataEncryptionKey,
    localDevEncryptionKey,
  );
  const keyId = productionValue(
    appConfig.dataEncryptionKeyId,
    localDevKeyId,
  );

  if (
    material.length < 32 ||
    !keyId ||
    !keyIdPattern.test(keyId) ||
    (appConfig.dataLookupHmacKey && material === appConfig.dataLookupHmacKey) ||
    (appConfig.cronSecret && material === appConfig.cronSecret)
  ) {
    throw unavailable(
      "APP_DATA_ENCRYPTION_KEY and a valid APP_DATA_ENCRYPTION_KEY_ID are required.",
      "missing_configuration",
      "ap:v2",
      keyId || null,
    );
  }

  return { keyId, key: deriveAesKey(material) };
}

function decryptionKeyForId(keyId: string) {
  if (
    appConfig.dataEncryptionKey.length >= 32 &&
    appConfig.dataEncryptionKeyId === keyId
  ) {
    return deriveAesKey(appConfig.dataEncryptionKey);
  }
  if (process.env.NODE_ENV !== "production" && keyId === localDevKeyId) {
    return deriveAesKey(
      appConfig.dataEncryptionKey || localDevEncryptionKey,
    );
  }

  const keyring = decryptionKeyring();
  const material = keyring[keyId];
  if (!material || material.length < 32) {
    throw unavailable(
      `No decryption key is configured for personal-data key ID ${keyId}.`,
      "unknown_key_id",
      "ap:v2",
      keyId,
    );
  }
  return deriveAesKey(material);
}

function legacyV1EncryptionKey() {
  const material = appConfig.dataLegacyV1EncryptionKey;
  if (
    // The retired v1 writer derived AES-256 material by hashing the configured
    // string and did not impose a minimum input length. Recovery must therefore
    // accept the exact historical nonempty material, even when it does not meet
    // the stronger v2 generation policy. This key is decrypt-only: v2 remains
    // the sole write format and still requires independent 32+ character keys.
    material.length === 0 ||
    (appConfig.dataEncryptionKey && material === appConfig.dataEncryptionKey) ||
    (appConfig.dataLookupHmacKey && material === appConfig.dataLookupHmacKey) ||
    (appConfig.cronSecret && material === appConfig.cronSecret)
  ) {
    throw unavailable(
      "The legacy v1 personal-data key is unavailable; re-entry is required.",
      "legacy_key_unavailable",
      "ap:v1",
    );
  }
  return deriveAesKey(material);
}

function lookupHmacKey() {
  const material = productionValue(
    appConfig.dataLookupHmacKey,
    localDevLookupKey,
  );
  if (
    material.length < 32 ||
    (appConfig.dataEncryptionKey && material === appConfig.dataEncryptionKey) ||
    (appConfig.cronSecret && material === appConfig.cronSecret)
  ) {
    throw unavailable(
      "APP_DATA_LOOKUP_HMAC_KEY is required for personal-data lookup.",
      "missing_configuration",
      "unknown",
    );
  }
  return crypto
    .createHash("sha256")
    .update("awardping:personal-data-lookup:v2\0")
    .update(material)
    .digest();
}

function decryptionKeyring() {
  if (!appConfig.dataDecryptionKeyringJson.trim()) {
    return {} as Record<string, string>;
  }
  try {
    const parsed: unknown = JSON.parse(appConfig.dataDecryptionKeyringJson);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("Keyring must be an object.");
    }
    const keyring: Record<string, string> = {};
    for (const [keyId, material] of Object.entries(parsed)) {
      if (
        !keyIdPattern.test(keyId) ||
        typeof material !== "string" ||
        material.length < 32
      ) {
        throw new Error("Keyring entries require valid IDs and strong keys.");
      }
      keyring[keyId] = material;
    }
    return keyring;
  } catch (error) {
    throw unavailable(
      "APP_DATA_DECRYPTION_KEYRING_JSON is invalid.",
      "missing_configuration",
      "ap:v2",
      null,
      error,
    );
  }
}

function decryptAesGcm({
  value,
  format,
  keyId,
  key,
  iv,
  tag,
  ciphertext,
}: {
  value: string;
  format: "ap:v1" | "ap:v2";
  keyId: string | null;
  key: Buffer;
  iv: string;
  tag: string;
  ciphertext: string;
}) {
  try {
    const ivBytes = Buffer.from(iv, "base64url");
    const tagBytes = Buffer.from(tag, "base64url");
    const ciphertextBytes = Buffer.from(ciphertext, "base64url");
    if (ivBytes.length !== 12 || tagBytes.length !== 16 || !ciphertextBytes.length) {
      throw new Error("Invalid AES-GCM payload lengths.");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, ivBytes);
    if (format === "ap:v2" && keyId) {
      decipher.setAAD(Buffer.from(`${cipherPrefix}:${keyId}`, "utf8"));
    }
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([
      decipher.update(ciphertextBytes),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw unavailable(
      `The ${format} personal-data ciphertext could not be authenticated.`,
      "invalid_ciphertext",
      format,
      keyId,
      error instanceof Error ? error : new Error(`Invalid ciphertext: ${value.length} bytes`),
    );
  }
}

function deriveAesKey(material: string) {
  return crypto.createHash("sha256").update(material).digest();
}

function productionValue(value: string, developmentFallback: string) {
  return value ||
    (process.env.NODE_ENV === "production" ? "" : developmentFallback);
}

function unavailable(
  message: string,
  reason: PersonalDataUnavailableReason,
  format: "ap:v1" | "ap:v2" | "unknown",
  keyId: string | null = null,
  cause?: unknown,
) {
  return new PersonalDataUnavailableError({
    message,
    reason,
    format,
    keyId,
    cause,
  });
}
