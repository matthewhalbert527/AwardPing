import crypto from "node:crypto";
import { appConfig } from "@/lib/config";

const cipherPrefix = "ap:v1";
const localDevKey = "awardping-local-development-personal-data-key";

export function normalizePersonalEmail(value: string) {
  return value.trim().toLowerCase();
}

export function personalDataLookupHash(value: string) {
  return crypto
    .createHmac("sha256", encryptionKey())
    .update(value.trim().toLowerCase())
    .digest("hex");
}

export function encryptPersonalData(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    cipherPrefix,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptPersonalData(value: string | null | undefined) {
  if (!value) return null;
  const parts = value.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== cipherPrefix) {
    return value;
  }

  const [, , iv, tag, ciphertext] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
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
  };
}

export function decryptProfileFields<
  T extends {
    full_name?: string | null;
    organization?: string | null;
    full_name_encrypted?: string | null;
    organization_encrypted?: string | null;
  },
>(profile: T | null | undefined) {
  if (!profile) return null;

  return {
    ...profile,
    full_name: decryptPersonalData(profile.full_name_encrypted) || profile.full_name || null,
    organization:
      decryptPersonalData(profile.organization_encrypted) || profile.organization || null,
  };
}

function encryptionKey() {
  const material =
    appConfig.dataEncryptionKey ||
    (process.env.NODE_ENV === "production" ? "" : appConfig.cronSecret || localDevKey);

  if (!material) {
    throw new Error("APP_DATA_ENCRYPTION_KEY is required for personal-data encryption.");
  }

  return crypto.createHash("sha256").update(material).digest();
}
