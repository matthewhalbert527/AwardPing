import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

loadEnv(".env.local");
loadEnv(".vercel/.env.production.local");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const encryptionMaterial = process.env.APP_DATA_ENCRYPTION_KEY;

if (!supabaseUrl || !serviceKey || !encryptionMaterial) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and APP_DATA_ENCRYPTION_KEY are required.",
  );
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceKey);

const subscriberResult = await supabase
  .from("public_update_subscribers")
  .select("id, email, email_hash, email_encrypted")
  .or("email_hash.is.null,email_encrypted.is.null");

if (subscriberResult.error) throw subscriberResult.error;

let subscriberCount = 0;
for (const subscriber of subscriberResult.data || []) {
  if (!subscriber.email) continue;
  const email = normalizeEmail(subscriber.email);
  const { error } = await supabase
    .from("public_update_subscribers")
    .update({
      email: null,
      email_hash: lookupHash(email),
      email_encrypted: encrypt(email),
      updated_at: new Date().toISOString(),
    })
    .eq("id", subscriber.id);

  if (error) throw error;
  subscriberCount += 1;
}

const profileResult = await supabase
  .from("profiles")
  .select("id, email, email_hash, full_name, organization, full_name_encrypted, organization_encrypted")
  .or("email_hash.is.null,full_name_encrypted.is.null,organization_encrypted.is.null");

if (profileResult.error) throw profileResult.error;

let profileCount = 0;
for (const profile of profileResult.data || []) {
  const update = {
    email_hash: profile.email ? lookupHash(profile.email) : profile.email_hash,
    updated_at: new Date().toISOString(),
  };

  if (profile.full_name && !profile.full_name_encrypted) {
    update.full_name = null;
    update.full_name_encrypted = encrypt(profile.full_name);
  }

  if (profile.organization && !profile.organization_encrypted) {
    update.organization = null;
    update.organization_encrypted = encrypt(profile.organization);
  }

  const { error } = await supabase.from("profiles").update(update).eq("id", profile.id);
  if (error) throw error;
  profileCount += 1;
}

const alertResult = await scrubRecipientTable("alert_deliveries");
const publicDeliveryResult = await scrubRecipientTable("public_update_deliveries");

console.log(
  [
    `encrypted_subscribers=${subscriberCount}`,
    `encrypted_profiles=${profileCount}`,
    `scrubbed_alert_deliveries=${alertResult}`,
    `scrubbed_public_update_deliveries=${publicDeliveryResult}`,
  ].join(" "),
);

async function scrubRecipientTable(table) {
  const { data, error } = await supabase
    .from(table)
    .select("id, recipient, recipient_hash")
    .not("recipient", "is", null);

  if (error) throw error;

  let count = 0;
  for (const row of data || []) {
    if (!row.recipient) continue;
    const { error: updateError } = await supabase
      .from(table)
      .update({
        recipient: null,
        recipient_hash: row.recipient_hash || lookupHash(row.recipient),
      })
      .eq("id", row.id);

    if (updateError) throw updateError;
    count += 1;
  }

  return count;
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "ap:v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

function lookupHash(value) {
  return crypto
    .createHmac("sha256", encryptionKey())
    .update(String(value).trim().toLowerCase())
    .digest("hex");
}

function encryptionKey() {
  return crypto.createHash("sha256").update(encryptionMaterial).digest();
}

function normalizeEmail(value) {
  return String(value).trim().toLowerCase();
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
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
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
