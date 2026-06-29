#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const apply = boolArg(args.apply, false);
const applyCanonicalAcronyms = boolArg(args["apply-canonical-acronyms"], false);
const applyReadableCanonicalSlugs = boolArg(args["apply-readable-canonical-slugs"], false);
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
const canonicalAcronymUpdates = canonicalAcronymUpdatesForAwards(activeAwards, aliases);
const readableCanonicalUpdates = readableCanonicalUpdatesForAwards(activeAwards, aliases);
const canonicalUpdatesToApply = applyReadableCanonicalSlugs
  ? readableCanonicalUpdates
  : applyCanonicalAcronyms
    ? canonicalAcronymUpdates
    : [];

if (apply && canonicalUpdatesToApply.length) {
  await applyCanonicalSlugUpdates(canonicalUpdatesToApply, existingAliases);
}

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
      canonicalAcronyms: {
        apply: apply && applyCanonicalAcronyms,
        wouldUpdate: canonicalAcronymUpdates.length,
        examples: canonicalAcronymUpdates.slice(0, 20),
      },
      readableCanonicalSlugs: {
        apply: apply && applyReadableCanonicalSlugs,
        wouldUpdate: readableCanonicalUpdates.length,
        examples: readableCanonicalUpdates.slice(0, 30),
      },
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

async function applyCanonicalSlugUpdates(updates, existingAliases) {
  for (const update of updates) {
    const previousSlug = update.previous_slug;
    const nextSlug = update.next_slug;
    await supabase
      .from("shared_award_slug_aliases")
      .delete()
      .eq("slug", nextSlug)
      .eq("shared_award_id", update.shared_award_id);

    const { error: updateError } = await supabase
      .from("shared_awards")
      .update({
        slug: nextSlug,
        updated_at: new Date().toISOString(),
      })
      .eq("id", update.shared_award_id);
    if (updateError) throw new Error(`canonical slug update failed for ${update.shared_award_id}: ${updateError.message}`);

    if (previousSlug && previousSlug !== nextSlug) {
      const existingOwner = existingAliases.get(previousSlug);
      if (!existingOwner) {
        const { error: aliasError } = await supabase
          .from("shared_award_slug_aliases")
          .insert({
            slug: previousSlug,
            shared_award_id: update.shared_award_id,
          });
        if (aliasError) throw new Error(`old slug alias insert failed for ${previousSlug}: ${aliasError.message}`);
      } else if (existingOwner !== update.shared_award_id) {
        console.warn(
          `Skipped old slug alias for ${previousSlug}; alias already belongs to ${existingOwner}.`,
        );
      }
    }
  }
}

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

function canonicalAcronymUpdatesForAwards(activeAwards, aliases) {
  const currentCanonicalSlugs = new Map(
    activeAwards.filter((award) => award.slug).map((award) => [award.slug, award.id]),
  );
  const existingAliases = new Map(aliases.map((alias) => [alias.slug, alias.shared_award_id]));
  const candidates = [];

  for (const award of activeAwards) {
    const nextSlug = preferredCanonicalAcronymSlug(award.name);
    if (!nextSlug || award.slug === nextSlug) continue;
    candidates.push({
      shared_award_id: award.id,
      award_name: award.name,
      previous_slug: award.slug,
      next_slug: nextSlug,
    });
  }

  const counts = new Map();
  for (const candidate of candidates) {
    counts.set(candidate.next_slug, (counts.get(candidate.next_slug) || 0) + 1);
  }

  return candidates.filter((candidate) => {
    if (counts.get(candidate.next_slug) !== 1) return false;
    const canonicalOwner = currentCanonicalSlugs.get(candidate.next_slug);
    if (canonicalOwner && canonicalOwner !== candidate.shared_award_id) return false;
    const aliasOwner = existingAliases.get(candidate.next_slug);
    if (aliasOwner && aliasOwner !== candidate.shared_award_id) return false;
    return true;
  });
}

function readableCanonicalUpdatesForAwards(activeAwards, aliases) {
  const currentCanonicalSlugs = new Map(
    activeAwards.filter((award) => award.slug).map((award) => [award.slug, award.id]),
  );
  const existingAliases = new Map(aliases.map((alias) => [alias.slug, alias.shared_award_id]));
  const candidates = activeAwards
    .map((award) => ({
      shared_award_id: award.id,
      award_name: award.name,
      previous_slug: award.slug,
      next_slug: preferredReadableCanonicalSlug(award.name),
    }))
    .filter(
      (candidate) =>
        candidate.next_slug &&
        candidate.previous_slug !== candidate.next_slug &&
        !isUsefulExistingShortCanonical(candidate.previous_slug, candidate.next_slug),
    );

  const counts = new Map();
  for (const candidate of candidates) {
    counts.set(candidate.next_slug, (counts.get(candidate.next_slug) || 0) + 1);
  }

  return candidates.filter((candidate) => {
    if (counts.get(candidate.next_slug) !== 1) return false;
    const canonicalOwner = currentCanonicalSlugs.get(candidate.next_slug);
    if (canonicalOwner && canonicalOwner !== candidate.shared_award_id) return false;
    const aliasOwner = existingAliases.get(candidate.next_slug);
    if (aliasOwner && aliasOwner !== candidate.shared_award_id) return false;
    return true;
  });
}

function preferredCanonicalAcronymSlug(name) {
  return terminalAcronymSlug(name);
}

function preferredReadableCanonicalSlug(name) {
  const terminalAcronym = terminalAcronymSlug(name);
  if (terminalAcronym) return terminalAcronym;

  const clean = cleanAwardNameForSlug(name);
  const parts = clean.split(/\s[-–—:]\s/).map(cleanText).filter(Boolean);
  const opportunity = preferredOpportunityPart(parts, clean);
  const opportunityPart = opportunity.value;
  const orgPart = opportunity.index > 0 ? parts[opportunity.index - 1] || "" : "";
  const orgPrefix = orgPart ? conciseOrganizationPrefix(orgPart) : "";
  const opportunitySlug = trimSlugTokens(slugFromText(removeParentheticalAcronyms(opportunityPart)), 12);

  if (!opportunitySlug) return "award";
  if (shouldPrefixOpportunitySlug(opportunitySlug) && orgPrefix) {
    return trimSlugTokens(`${orgPrefix}-${opportunitySlug}`, 12);
  }
  return trimSlugTokens(opportunitySlug, 12);
}

function preferredOpportunityPart(parts, fallback) {
  if (parts.length <= 1) return { value: fallback, index: 0 };
  const opportunityPattern =
    /\b(scholarship|scholarships|fellowship|fellowships|grant|grants|award|awards|financial aid|program|internship|internships|prize|prizes|summer school|school)\b/i;
  const lastIndex = parts.length - 1;
  if (opportunityPattern.test(parts[lastIndex])) {
    return { value: parts[lastIndex], index: lastIndex };
  }
  for (let index = lastIndex - 1; index >= 1; index -= 1) {
    if (opportunityPattern.test(parts[index])) {
      return {
        value: [parts[index], ...parts.slice(index + 1)].join(" "),
        index,
      };
    }
  }
  return { value: parts[lastIndex], index: lastIndex };
}

function terminalAcronymSlug(name) {
  const clean = cleanText(name);
  const tail = clean.split(/\s+-\s+/).pop() || clean;
  const match = tail.match(/\(([A-Z][A-Z0-9&+.-]{2,})\)\s*$/);
  if (!match) return "";
  const slug = slugFromText(match[1]);
  return slug.length >= 3 && slug.length <= 24 ? slug : "";
}

function cleanAwardNameForSlug(name) {
  return cleanText(name)
    .replace(/\bPh\.\s*D\.?\b/gi, "PhD")
    .replace(/\bM\.\s*D\.?\b/gi, "MD")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b(application|program)?\s*guidelines?\b/gi, " ")
    .replace(/\b(pdf|document|download)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeParentheticalAcronyms(value) {
  return String(value || "")
    .replace(/\(([A-Z][A-Za-z0-9&+./-]{1,})\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function conciseOrganizationPrefix(value) {
  const parentheticalAcronyms = [...String(value || "").matchAll(/\(([A-Z][A-Za-z0-9&+./-]{2,})\)/g)]
    .map((match) => slugFromText(match[1]))
    .filter((slug) => slug.length >= 2 && slug.length <= 12);
  if (parentheticalAcronyms.length) return parentheticalAcronyms[parentheticalAcronyms.length - 1];

  const slug = slugFromText(removeParentheticalAcronyms(value));
  const tokens = slug
    .split("-")
    .filter((token) => token && !genericTokens.has(token))
    .slice(0, 3);
  return tokens.join("-");
}

function isUsefulExistingShortCanonical(previousSlug, nextSlug) {
  const previousTokens = String(previousSlug || "").split("-").filter(Boolean);
  const nextTokens = String(nextSlug || "").split("-").filter(Boolean);
  if (previousTokens.length > 2 || previousTokens.join("-").length > 32) return false;
  if (nextTokens.length <= previousTokens.length + 2) return false;
  return previousTokens.some((token) => token.length >= 3 && !genericTokens.has(token));
}

function shouldPrefixOpportunitySlug(slug) {
  const tokens = String(slug || "").split("-").filter(Boolean);
  if (tokens.length <= 2) return true;
  if (genericTokens.has(tokens[0])) return true;
  const distinctiveTokens = tokens.filter((token) => !genericTokens.has(token));
  if (distinctiveTokens.length <= 1) return true;
  const first = tokens[0];
  if (
    [
      "graduate",
      "undergraduate",
      "phd",
      "md",
      "doctoral",
      "postdoctoral",
      "predoctoral",
      "dissertation",
      "research",
      "student",
      "students",
      "summer",
      "travel",
      "diversity",
      "minority",
      "merit",
      "short",
      "term",
    ].includes(first)
  ) {
    return true;
  }
  return false;
}

function trimSlugTokens(value, maxTokens) {
  const trailingStopwords = new Set(["and", "or", "of", "for", "in", "on", "to", "with", "the", "a", "an"]);
  const tokens = String(value || "")
    .split("-")
    .filter(Boolean)
    .slice(0, maxTokens);
  while (tokens.length > 1 && trailingStopwords.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join("-");
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
