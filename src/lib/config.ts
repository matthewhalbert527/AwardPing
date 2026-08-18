import "server-only";

export const appConfig = {
  name: "AwardPing",
  url: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  resendApiKey: process.env.RESEND_API_KEY || "",
  alertFromEmail: process.env.ALERT_FROM_EMAIL || "AwardPing <alerts@example.com>",
  contactToEmail: process.env.CONTACT_TO_EMAIL || "",
  cronSecret: process.env.CRON_SECRET || "",
  dataEncryptionKey: textFromEnv("APP_DATA_ENCRYPTION_KEY"),
  dataEncryptionKeyId: textFromEnv("APP_DATA_ENCRYPTION_KEY_ID"),
  dataDecryptionKeyringJson:
    textFromEnv("APP_DATA_DECRYPTION_KEYRING_JSON"),
  dataLookupHmacKey: textFromEnv("APP_DATA_LOOKUP_HMAC_KEY"),
  dataLegacyV1EncryptionKey:
    textFromEnv("APP_DATA_LEGACY_V1_ENCRYPTION_KEY"),
  r2AccountId: textFromEnv("R2_ACCOUNT_ID"),
  r2Endpoint: textFromEnv("R2_ENDPOINT"),
  r2AccessKeyId: textFromEnv("R2_ACCESS_KEY_ID"),
  r2SecretAccessKey: textFromEnv("R2_SECRET_ACCESS_KEY"),
  r2Bucket: textFromEnv("R2_BUCKET", "awardping-snapshots"),
  r2SignedUrlTtlSeconds: numberFromEnv("R2_SIGNED_URL_TTL_SECONDS", 900),
  adminEmails: emailListFromEnv("AWARDPING_ADMIN_EMAILS"),
};

export function hasSupabaseConfig() {
  return Boolean(appConfig.supabaseUrl && appConfig.supabaseAnonKey);
}

export function hasSupabaseAdminConfig() {
  return Boolean(
    appConfig.supabaseUrl &&
      appConfig.supabaseServiceRoleKey,
  );
}

export function hasR2Config() {
  return Boolean(
    appConfig.r2Bucket &&
      appConfig.r2AccessKeyId &&
      appConfig.r2SecretAccessKey &&
      (appConfig.r2Endpoint || appConfig.r2AccountId),
  );
}

export function hasEmailDeliveryConfig() {
  return emailDeliveryConfigReady({
    apiKey: appConfig.resendApiKey,
    from: appConfig.alertFromEmail,
  });
}

export function hasPublicUpdateDeliveryConfig() {
  return publicUpdateDeliveryConfigReady(
    {
      apiKey: appConfig.resendApiKey,
      from: appConfig.alertFromEmail,
      cronSecret: appConfig.cronSecret,
      encryptionKey: appConfig.dataEncryptionKey,
      encryptionKeyId: appConfig.dataEncryptionKeyId,
      lookupHmacKey: appConfig.dataLookupHmacKey,
    },
    process.env.NODE_ENV !== "production",
  );
}

export function hasPublicUpdateTokenConfig() {
  return publicUpdateTokenConfigReady(
    appConfig.cronSecret,
    process.env.NODE_ENV !== "production",
  );
}

export function emailDeliveryConfigReady(input: { apiKey: string; from: string }) {
  const apiKey = input.apiKey.trim();
  const address = senderAddress(input.from);
  if (!/^re_[A-Za-z0-9_-]+$/.test(apiKey) || !address) {
    return false;
  }

  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return !(
    domain === "example.com" ||
    domain === "example.net" ||
    domain === "example.org" ||
    domain === "localhost" ||
    domain.endsWith(".localhost") ||
    domain.endsWith(".example") ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".test")
  );
}

export function publicUpdateDeliveryConfigReady(
  input: {
    apiKey: string;
    from: string;
    cronSecret: string;
    encryptionKey: string;
    encryptionKeyId: string;
    lookupHmacKey: string;
  },
  allowDevelopmentFallbacks = false,
) {
  if (!emailDeliveryConfigReady(input)) return false;
  if (allowDevelopmentFallbacks) return true;

  const cronSecret = input.cronSecret.trim();
  const encryptionKey = input.encryptionKey.trim();
  const encryptionKeyId = input.encryptionKeyId.trim();
  const lookupHmacKey = input.lookupHmacKey.trim();
  return Boolean(
    publicUpdateTokenConfigReady(cronSecret) &&
      encryptionKey.length >= 32 &&
      /^[a-z0-9][a-z0-9._-]{0,63}$/.test(encryptionKeyId) &&
      lookupHmacKey.length >= 32 &&
      encryptionKey !==
        "awardping-local-development-personal-data-encryption-key" &&
      lookupHmacKey !==
        "awardping-local-development-personal-data-lookup-key" &&
      cronSecret !== encryptionKey &&
      cronSecret !== lookupHmacKey &&
      encryptionKey !== lookupHmacKey,
  );
}

export function publicUpdateTokenConfigReady(
  secret: string,
  allowDevelopmentFallbacks = false,
) {
  const material = secret.trim();
  return (
    allowDevelopmentFallbacks ||
    (material.length >= 24 &&
      material !== "awardping-local-public-update-token")
  );
}

function numberFromEnv(key: string, fallback: number) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function textFromEnv(key: string, fallback = "") {
  return (process.env[key] || fallback).replace(/^\uFEFF/, "").trim();
}

function senderAddress(value: string) {
  const trimmed = value.trim();
  const namedAddress = /^[^<>]*<([^<>]+)>$/.exec(trimmed);
  if (!namedAddress && /[<>]/.test(trimmed)) {
    return "";
  }

  const address = (namedAddress?.[1] || trimmed).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) ? address : "";
}

function emailListFromEnv(key: string) {
  return (process.env[key] || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}
