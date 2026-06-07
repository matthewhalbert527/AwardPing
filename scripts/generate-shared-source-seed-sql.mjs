#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const awardSeeds = loadTsExport(resolve(root, "src/lib/award-seeds.ts"), "awardSeeds");
const awardSourceOverrides = loadTsExport(
  resolve(root, "src/lib/award-source-overrides.ts"),
  "awardSourceOverrides",
);

const rows = [];

for (const award of awardSeeds) {
  if (!isInstitutionalDiscoveryUrl(award.starterUrl)) {
    rows.push({
      searchKey: normalizeSharedAwardKey(award.name),
      url: award.starterUrl,
      title: award.name,
      pageType: "homepage",
      confidence: 0.6,
      reason: "Backend-seeded official starter source.",
      source: "seed",
      officialHomepage: award.starterUrl,
    });
  }
}

for (const override of awardSourceOverrides) {
  const searchKey = normalizeSharedAwardKey(override.awardName);
  for (const source of override.sources) {
    rows.push({
      searchKey,
      url: source.url,
      title: source.title,
      pageType: source.pageType,
      confidence: source.confidence,
      reason: source.reason,
      source: "admin",
      officialHomepage: source.pageType === "homepage" ? source.url : null,
    });
  }
}

const dedupedRows = [...dedupeRows(rows).values()];
const payload = JSON.stringify(dedupedRows);

process.stdout.write(`
with input_rows as (
  select *
  from jsonb_to_recordset(${sqlString(payload)}::jsonb) as row(
    "searchKey" text,
    url text,
    title text,
    "pageType" text,
    confidence numeric,
    reason text,
    source text,
    "officialHomepage" text
  )
),
matched as (
  select
    shared_awards.id as shared_award_id,
    input_rows.*
  from input_rows
  join public.shared_awards
    on shared_awards.search_key = input_rows."searchKey"
  where input_rows.url is not null
    and input_rows.url <> ''
),
homepage_updates as (
  update public.shared_awards shared_award
  set official_homepage = matched."officialHomepage",
      updated_at = now()
  from matched
  where shared_award.id = matched.shared_award_id
    and matched."officialHomepage" is not null
    and (shared_award.official_homepage is null or shared_award.official_homepage = '')
  returning shared_award.id
),
source_upserts as (
  insert into public.shared_award_sources (
    shared_award_id,
    url,
    title,
    page_type,
    confidence,
    reason,
    source
  )
  select
    matched.shared_award_id,
    matched.url,
    matched.title,
    matched."pageType",
    matched.confidence,
    matched.reason,
    matched.source
  from matched
  on conflict (shared_award_id, url) do update set
    title = excluded.title,
    page_type = excluded.page_type,
    confidence = greatest(public.shared_award_sources.confidence, excluded.confidence),
    reason = coalesce(public.shared_award_sources.reason, excluded.reason),
    source = case
      when public.shared_award_sources.source = 'admin' then public.shared_award_sources.source
      else excluded.source
    end,
    updated_at = now()
  returning id
)
select
  (select count(*) from input_rows) as input_rows,
  (select count(*) from matched) as matched_awards,
  (select count(*) from source_upserts) as source_rows_upserted,
  (select count(*) from homepage_updates) as homepage_rows_updated;
`);

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
    if (id === "@/lib/award-discovery-types") {
      return {};
    }

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

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function dedupeRows(values) {
  const deduped = new Map();
  for (const value of values) {
    const key = `${value.searchKey}\n${value.url}`;
    const existing = deduped.get(key);
    if (!existing || value.confidence > existing.confidence || value.source === "admin") {
      deduped.set(key, {
        ...existing,
        ...value,
        officialHomepage: existing?.officialHomepage || value.officialHomepage,
      });
    }
  }

  return deduped;
}
