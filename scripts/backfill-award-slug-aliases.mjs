#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const apply = boolArg(args.apply, false);
const limit = positiveInt(args.limit, 100_000);

const genericTokens = new Set([
  "the",
  "and",
  "for",
  "with",
  "of",
  "in",
  "to",
  "a",
  "an",
  "association",
  "american",
  "national",
  "international",
  "foundation",
  "program",
  "programs",
  "award",
  "awards",
  "fellowship",
  "fellowships",
  "grant",
  "grants",
  "scholarship",
  "scholarships",
  "aid",
  "financial",
]);

const supabase = createSupabaseClient();
const awards = await loadAll("shared_awards", "id,name,slug,status,updated_at", limit);
const aliases = await loadAll("shared_award_slug_aliases", "slug,shared_award_id", limit);

const activeAwards = awards.filter((award) => award.status === "active");
const canonicalSlugs = new Map(activeAwards.filter((award) => award.slug).map((award) => [award.slug, award.id]));
const existingAliases = new Map(aliases.map((alias) => [alias.slug, alias.shared_award_id]));
const aliasOwners = new Map();

for (const award of activeAwards) {
  for (const alias of aliasCandidatesForAward(award.name, award.slug)) {
    if (!alias || alias === award.slug) continue;
    if (canonicalSlugs.has(alias) && canonicalSlugs.get(alias) !== award.id) continue;
    const owners = aliasOwners.get(alias) || new Set();
    owners.add(award.id);
    aliasOwners.set(alias, owners);
  }
}

const inserts = [];
const skippedExisting = [];
const skippedAmbiguous = [];

for (const [slug, owners] of aliasOwners.entries()) {
  if (owners.size !== 1) {
    skippedAmbiguous.push({ slug, count: owners.size });
    continue;
  }

  const sharedAwardId = [...owners][0];
  const existingOwner = existingAliases.get(slug);
  if (existingOwner) {
    skippedExisting.push({ slug, shared_award_id: existingOwner });
    continue;
  }

  inserts.push({ slug, shared_award_id: sharedAwardId });
}

if (apply && inserts.length) {
  for (let index = 0; index < inserts.length; index += 500) {
    const batch = inserts.slice(index, index + 500);
    const { error } = await supabase.from("shared_award_slug_aliases").insert(batch);
    if (error) throw new Error(`alias insert failed: ${error.message}`);
  }
}

console.log(
  JSON.stringify(
    {
      apply,
      activeAwards: activeAwards.length,
      inserted: apply ? inserts.length : 0,
      wouldInsert: inserts.length,
      skippedExisting: skippedExisting.length,
      skippedAmbiguous: skippedAmbiguous.length,
      examples: inserts.slice(0, 20),
    },
    null,
    2,
  ),
);

function aliasCandidatesForAward(name, canonicalSlug) {
  const candidates = new Set();
  const normalizedName = cleanText(name);
  const slug = slugFromText(normalizedName);
  const canonical = canonicalSlug || slug;
  if (slug && slug !== canonical) candidates.add(slug);

  const withoutCanonicalSuffix = dropOpportunitySuffix(canonical);
  if (withoutCanonicalSuffix && isUsefulShortAlias(withoutCanonicalSuffix)) {
    candidates.add(withoutCanonicalSuffix);
  }

  const withoutTitleSuffix = dropOpportunitySuffix(slug);
  if (withoutTitleSuffix && withoutTitleSuffix !== withoutCanonicalSuffix && isUsefulShortAlias(withoutTitleSuffix)) {
    candidates.add(withoutTitleSuffix);
  }

  const acronym = acronymFromName(normalizedName);
  if (acronym) candidates.add(acronym);

  return [...candidates].filter((candidate) => candidate.length >= 3 && candidate.length <= 80);
}

function dropOpportunitySuffix(slug) {
  return String(slug || "")
    .replace(/-(scholarships?|fellowships?|grants?|awards?|programs?)$/i, "")
    .replace(/-financial-aid$/i, "")
    .replace(/^-+|-+$/g, "");
}

function isUsefulShortAlias(slug) {
  const tokens = String(slug || "").split("-").filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return false;
  if (tokens.every((token) => genericTokens.has(token))) return false;
  return tokens.some((token) => token.length >= 5 && !genericTokens.has(token));
}

function acronymFromName(value) {
  const words = value
    .replace(/&/g, " and ")
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ""))
    .filter((word) => word && !genericTokens.has(word.toLowerCase()));
  const allCaps = words.filter((word) => /^[A-Z0-9]{2,}$/.test(word));
  if (allCaps.length) return allCaps.map((word) => word.toLowerCase()).join("-");
  if (words.length < 2 || words.length > 5) return "";
  const acronym = words.map((word) => word[0]).join("").toLowerCase();
  return acronym.length >= 3 ? acronym : "";
}

function slugFromText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function loadAll(table, select, rowLimit) {
  const rows = [];
  for (let from = 0; rows.length < rowLimit; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows.slice(0, rowLimit);
}

function createSupabaseClient() {
  const env = { ...loadEnvFile(resolve(root, ".env.local")), ...process.env };
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

function loadEnvFile(path) {
  try {
    const env = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[match[1]] = value;
    }
    return env;
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    const clean = arg.replace(/^--/, "");
    const [key, ...rest] = clean.split("=");
    parsed[key] = rest.length ? rest.join("=") : true;
  }
  return parsed;
}

function boolArg(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  return /^(1|true|yes)$/i.test(String(value));
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
