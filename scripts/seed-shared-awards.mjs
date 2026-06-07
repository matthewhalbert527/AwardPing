#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const dryRun = process.argv.includes("--dry-run");
const env = {
  ...loadEnvFile(resolve(root, ".env.local")),
  ...process.env,
};
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

const awardSeeds = loadAwardSeeds();
const awardSeedsByKey = new Map(
  awardSeeds.map((award) => [normalizeSharedAwardKey(award.name), award]),
);
const awardSourceOverrides = loadAwardSourceOverrides();
const overridesByAwardKey = new Map(
  awardSourceOverrides.map((override) => [
    normalizeSharedAwardKey(override.awardName),
    override.sources,
  ]),
);
const rows = awardSeeds.map((award) => ({
  search_key: normalizeSharedAwardKey(award.name),
  name: award.name,
  official_homepage: isInstitutionalDiscoveryUrl(award.starterUrl) ? null : award.starterUrl,
  summary: null,
  confidence: 0.6,
  status: "active",
  source: "seed",
}));

if (dryRun) {
  console.log(`Would seed ${rows.length} shared awards.`);
  process.exit(0);
}

if (!supabaseUrl || !serviceRoleKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(1);
}

const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);

let awardCount = 0;
let sourceCount = 0;

for (const batch of chunk(rows, 100)) {
  await withRetry("shared award upsert", () =>
    supabase.from("shared_awards").upsert(batch, { onConflict: "search_key" }),
  );

  const keys = batch.map((award) => award.search_key);
  const sharedAwards =
    (await withRetry("shared award select", () =>
      supabase
        .from("shared_awards")
        .select("id, search_key, name, official_homepage")
        .in("search_key", keys),
    )) || [];

  const sourceRows = (sharedAwards || [])
    .flatMap((award) => {
      const sourceRowsForAward = [];
      const seedAward = awardSeedsByKey.get(award.search_key);
      const starterUrl = seedAward?.starterUrl || award.official_homepage;

      if (starterUrl && !isInstitutionalDiscoveryUrl(starterUrl)) {
        sourceRowsForAward.push({
          shared_award_id: award.id,
          url: starterUrl,
          title: award.name,
          page_type: "homepage",
          confidence: 0.6,
          reason: "Backend-seeded official starter source.",
          source: "seed",
        });
      }

      for (const source of overridesByAwardKey.get(award.search_key) || []) {
        sourceRowsForAward.push({
          shared_award_id: award.id,
          url: source.url,
          title: source.title,
          page_type: source.pageType,
          confidence: source.confidence,
          reason: source.reason,
          source: "admin",
        });
      }

      return sourceRowsForAward;
    });

  if (sourceRows.length) {
    for (const sourceBatch of chunk(sourceRows, 25)) {
      await withRetry("shared award source upsert", () =>
        supabase
          .from("shared_award_sources")
          .upsert(sourceBatch, { onConflict: "shared_award_id,url" }),
      );
    }
  }

  awardCount += batch.length;
  sourceCount += sourceRows.length;
}

console.log(`Seeded ${awardCount} shared awards and ${sourceCount} starter sources.`);

function loadAwardSeeds() {
  return loadTsExport(resolve(root, "src/lib/award-seeds.ts"), "awardSeeds");
}

function loadAwardSourceOverrides() {
  return loadTsExport(resolve(root, "src/lib/award-source-overrides.ts"), "awardSourceOverrides");
}

function loadTsExport(sourcePath, exportName) {
  const source = readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });

  const cjsModule = { exports: {} };
  const requireShim = (id) => {
    if (id === "@/lib/award-discovery-types") return {};
    throw new Error(`Unsupported import while loading ${sourcePath}: ${id}`);
  };
  const fn = new Function("module", "exports", "require", transpiled.outputText);
  fn(cjsModule, cjsModule.exports, requireShim);

  if (!Array.isArray(cjsModule.exports[exportName])) {
    throw new Error(`${exportName} export was not found.`);
  }

  return cjsModule.exports[exportName];
}

function normalizeSharedAwardKey(name) {
  const key = name.trim().toLowerCase().replace(/\s+/g, " ");
  return canonicalSharedAwardKeyAlias(key) || key;
}

function canonicalSharedAwardKeyAlias(key) {
  if (
    key === "national science foundation graduate research fellowship" ||
    key === "national science foundation graduate research fellowship program" ||
    key === "nsf graduate research fellowship"
  ) {
    return "nsf graduate research fellowship program";
  }
  return null;
}

function isInstitutionalDiscoveryUrl(value) {
  if (!value) return false;

  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return hostname === "fellowship-finder.grad.illinois.edu" || hostname === "onsa.asu.edu";
  } catch {
    return false;
  }
}

function chunk(values, size) {
  const batches = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

async function withRetry(label, operation) {
  let lastError;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const { data, error } = await operation();
    if (!error) return data;

    lastError = error;
    await sleep(750 * attempt);
  }

  throw new Error(`${label} failed: ${lastError?.message || "unknown error"}`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function loadEnvFile(path) {
  if (!existsSync(path)) return {};

  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}
