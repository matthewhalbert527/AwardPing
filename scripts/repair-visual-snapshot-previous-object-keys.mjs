#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const env = {
  ...loadEnvFile(resolve(root, ".env.local")),
  ...process.env,
};

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing Supabase service-role environment.");
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);

const pageSize = 1000;
let offset = 0;
let scanned = 0;
let repairable = 0;
let repaired = 0;
let conflicts = 0;

while (true) {
  const { data, error } = await supabase
    .from("shared_award_source_visual_snapshots")
    .select("shared_award_source_id,previous_captured_at,previous_object_keys,updated_at")
    .order("shared_award_source_id", { ascending: true })
    .range(offset, offset + pageSize - 1);

  if (error) throw new Error(`Snapshot scan failed: ${error.message}`);
  if (!data?.length) break;

  scanned += data.length;
  for (const row of data) {
    const previousKeys = jsonObject(row.previous_object_keys);
    const fixedKeys = previousKeysForPreviousSlot(previousKeys);
    if (!row.previous_captured_at || objectsEqual(previousKeys, fixedKeys)) continue;

    repairable += 1;
    if (!apply) continue;

    let update = supabase
      .from("shared_award_source_visual_snapshots")
      .update({
        previous_object_keys: fixedKeys,
        updated_at: new Date().toISOString(),
      })
      .eq("shared_award_source_id", row.shared_award_source_id);
    update = row.updated_at
      ? update.eq("updated_at", row.updated_at)
      : update.is("updated_at", null);
    const { data: updated, error: updateError } = await update
      .select("shared_award_source_id")
      .maybeSingle();

    if (updateError) {
      throw new Error(`Repair failed for ${row.shared_award_source_id}: ${updateError.message}`);
    }
    if (!updated) {
      conflicts += 1;
      continue;
    }
    repaired += 1;
  }

  if (data.length < pageSize) break;
  offset += pageSize;
}

console.log(JSON.stringify({
  apply,
  scanned,
  repairable,
  repaired,
  conflicts,
}, null, 2));

function previousKeysForPreviousSlot(keys) {
  return Object.fromEntries(
    Object.entries(keys).map(([name, key]) => [
      name,
      typeof key === "string" ? key.replace("/latest/", "/previous/") : key,
    ]),
  );
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function objectsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = unquote(match[2].trim());
  }
  return env;
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
