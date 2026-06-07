#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const projectRef = args["project-ref"] || readLinkedProjectRef();
const outputPath =
  args.output ||
  join(root, "reports", `shared-source-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
const applyCleanup = args["apply-cleanup"] === "true";
const sampleLimit = positiveInt(args["sample-limit"], 40);

const supabase = createSupabaseClient();
const [awards, sources] = await Promise.all([
  loadAll("shared_awards", "id,name,official_homepage,status,updated_at"),
  loadAll("shared_award_sources", "id,shared_award_id,url,title,page_type,confidence,source,updated_at"),
]);

const activeAwards = awards.filter((award) => award.status === "active");
const activeAwardIds = new Set(activeAwards.map((award) => award.id));
const activeSources = sources.filter((source) => activeAwardIds.has(source.shared_award_id));
const badSources = activeSources
  .map((source) => ({ ...source, reason: nonAwardReason(source.url, source.title) }))
  .filter((source) => source.reason);
const duplicateSources = findDuplicateSources(activeSources);
let currentAwards = activeAwards;
let currentSources = activeSources;
let homepageRepairs = buildHomepageRepairs(currentAwards, groupBy(currentSources, (source) => source.shared_award_id));

if (applyCleanup) {
  await cleanupSources([...badSources, ...duplicateSources.map((item) => item.remove)].filter(Boolean));
  currentSources = (
    await loadAll("shared_award_sources", "id,shared_award_id,url,title,page_type,confidence,source,updated_at")
  ).filter((source) => activeAwardIds.has(source.shared_award_id));

  homepageRepairs = buildHomepageRepairs(currentAwards, groupBy(currentSources, (source) => source.shared_award_id));
  await cleanupAwardHomepages(homepageRepairs);
  currentAwards = (await loadAll("shared_awards", "id,name,official_homepage,status,updated_at")).filter(
    (award) => award.status === "active",
  );
}

const sourcesByAward = groupBy(currentSources, (source) => source.shared_award_id);
const awardsWithCounts = currentAwards.map((award) => {
  const awardSources = sourcesByAward.get(award.id) || [];
  return {
    ...award,
    sourceCount: awardSources.length,
    homepageIsBad: Boolean(award.official_homepage && nonAwardReason(award.official_homepage, award.name)),
    hasHomepageSource: awardSources.some((source) => source.page_type === "homepage"),
  };
});

const buckets = {
  zero: awardsWithCounts.filter((award) => award.sourceCount === 0),
  one: awardsWithCounts.filter((award) => award.sourceCount === 1),
  twoToFour: awardsWithCounts.filter((award) => award.sourceCount >= 2 && award.sourceCount <= 4),
  fivePlus: awardsWithCounts.filter((award) => award.sourceCount >= 5),
  badHomepage: awardsWithCounts.filter((award) => award.homepageIsBad),
  noHomepageSource: awardsWithCounts.filter((award) => award.sourceCount > 0 && !award.hasHomepageSource),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  renderReport({ awardsWithCounts, buckets, badSources, duplicateSources, homepageRepairs }),
  "utf8",
);

console.log(
  JSON.stringify(
    {
      outputPath,
      activeAwards: activeAwards.length,
      sourceRows: currentSources.length,
      cleanupApplied: applyCleanup,
      badSources: badSources.length,
      duplicateSources: duplicateSources.length,
      homepageRepairs: homepageRepairs.length,
      buckets: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.length])),
    },
    null,
    2,
  ),
);

async function cleanupSources(rows) {
  const ids = [...new Set(rows.map((row) => row.id).filter(Boolean))];
  const urls = [...new Set(rows.map((row) => row.url).filter(Boolean))];
  if (!ids.length && !urls.length) return;

  await deleteWhereIn("shared_award_change_events", "shared_award_source_id", ids);
  await deleteWhereIn("shared_award_change_events", "source_url", urls);
  await deleteWhereIn("shared_award_source_snapshots", "shared_award_source_id", ids);
  await deleteWhereIn("shared_award_source_snapshots", "source_url", urls);
  await deleteWhereIn("monitors", "shared_award_source_id", ids);
  await deleteWhereIn("award_sources", "shared_award_source_id", ids);
  await deleteWhereIn("shared_award_sources", "id", ids);
}

async function cleanupAwardHomepages(repairs) {
  for (const repair of repairs) {
    const { error } = await supabase
      .from("shared_awards")
      .update({ official_homepage: repair.nextUrl })
      .eq("id", repair.award.id);
    if (error) throw new Error(`shared_awards.official_homepage ${repair.award.id}: ${error.message}`);
  }
}

async function deleteWhereIn(table, column, values) {
  if (!values.length) return;
  const { error } = await supabase.from(table).delete().in(column, values);
  if (error) throw new Error(`${table}.${column}: ${error.message}`);
}

function renderReport({ awardsWithCounts, buckets, badSources, duplicateSources, homepageRepairs }) {
  const lines = [
    "# Shared Source Coverage Audit",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    "",
    `- Active awards: ${awardsWithCounts.length}`,
    `- Awards with 0 sources: ${buckets.zero.length}`,
    `- Awards with 1 source: ${buckets.one.length}`,
    `- Awards with 2-4 sources: ${buckets.twoToFour.length}`,
    `- Awards with 5+ sources: ${buckets.fivePlus.length}`,
    `- Bad source rows: ${badSources.length}`,
    `- Duplicate source rows: ${duplicateSources.length}`,
    `- Award homepages repaired: ${homepageRepairs.length}`,
    `- Bad award homepages: ${buckets.badHomepage.length}`,
    `- Awards with sources but no homepage source row: ${buckets.noHomepageSource.length}`,
    "",
  ];

  appendAwardList(lines, "Awards With 0 Sources", buckets.zero);
  appendAwardList(lines, "Awards With 1 Source", buckets.one);
  appendAwardList(lines, "Awards With 2-4 Sources", buckets.twoToFour);
  appendAwardList(lines, "Bad Award Homepages", buckets.badHomepage);
  appendHomepageRepairList(lines, "Award Homepage Repairs", homepageRepairs);
  appendSourceList(lines, "Bad Source Rows", badSources);
  appendDuplicateList(lines, "Duplicate Source Rows", duplicateSources);

  return `${lines.join("\n")}\n`;
}

function appendHomepageRepairList(lines, title, repairs) {
  lines.push(`## ${title}`, "");
  if (!repairs.length) {
    lines.push("None.", "");
    return;
  }

  for (const repair of repairs.slice(0, sampleLimit)) {
    lines.push(`- ${repair.award.name}`);
    lines.push(`  Old: ${repair.oldUrl}`);
    lines.push(`  New: ${repair.nextUrl || "cleared"}`);
  }
  if (repairs.length > sampleLimit) lines.push(`- ...${repairs.length - sampleLimit} more`);
  lines.push("");
}

function appendAwardList(lines, title, awards) {
  lines.push(`## ${title}`, "");
  if (!awards.length) {
    lines.push("None.", "");
    return;
  }

  for (const award of awards.slice(0, sampleLimit)) {
    lines.push(`- ${award.name} (${award.sourceCount} sources)`);
  }
  if (awards.length > sampleLimit) lines.push(`- ...${awards.length - sampleLimit} more`);
  lines.push("");
}

function appendSourceList(lines, title, sources) {
  lines.push(`## ${title}`, "");
  if (!sources.length) {
    lines.push("None.", "");
    return;
  }

  for (const source of sources.slice(0, sampleLimit)) {
    lines.push(`- ${source.reason}: ${source.title} - ${source.url}`);
  }
  if (sources.length > sampleLimit) lines.push(`- ...${sources.length - sampleLimit} more`);
  lines.push("");
}

function appendDuplicateList(lines, title, duplicates) {
  lines.push(`## ${title}`, "");
  if (!duplicates.length) {
    lines.push("None.", "");
    return;
  }

  for (const duplicate of duplicates.slice(0, sampleLimit)) {
    lines.push(`- Remove ${duplicate.remove.title} - ${duplicate.remove.url}`);
    lines.push(`  Keep ${duplicate.keep.title} - ${duplicate.keep.url}`);
  }
  if (duplicates.length > sampleLimit) lines.push(`- ...${duplicates.length - sampleLimit} more`);
  lines.push("");
}

function findDuplicateSources(sources) {
  const grouped = new Map();
  for (const source of sources) {
    const key = `${source.shared_award_id}\n${canonicalUrlKey(source.url)}`;
    grouped.set(key, [...(grouped.get(key) || []), source]);
  }

  const duplicates = [];
  for (const values of grouped.values()) {
    if (values.length < 2) continue;
    const sorted = [...values].sort((a, b) => preferenceScore(b) - preferenceScore(a));
    const keep = sorted[0];
    for (const remove of sorted.slice(1)) {
      duplicates.push({ keep, remove });
    }
  }
  return duplicates;
}

function preferenceScore(source) {
  let score = 0;
  try {
    const url = new URL(source.url);
    if (url.protocol === "https:") score += 10;
    if (source.page_type === "homepage") score += 8;
    score += Number(source.confidence || 0);
    if (!url.search) {
      score += 20;
    } else {
      score -= 20;
    }
    if (/%0a|%0d/i.test(url.search)) score -= 50;
  } catch {
    score -= 10;
  }
  return score;
}

function canonicalUrlKey(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = url.pathname
      .replace(/\/index\.(html?|php|aspx?)$/i, "/")
      .replace(/\.aspx$/i, "")
      .replace(/\/+$/g, "")
      .toLowerCase();
    const search = canonicalSearchParams(url.searchParams);
    return `${hostname}${pathname || "/"}${search}`;
  } catch {
    return String(value || "").trim().toLowerCase().replace(/\/+$/g, "");
  }
}

function canonicalSearchParams(searchParams) {
  const kept = [];
  for (const [rawKey, rawValue] of searchParams.entries()) {
    const key = rawKey.toLowerCase();
    const value = rawValue.trim();
    if (!key || key.startsWith("utm_")) continue;
    if (["fbclid", "gclid", "msclkid", "mc_cid", "mc_eid", "share", "replytocom"].includes(key)) continue;
    if (["lang", "locale", "view", "campaign"].includes(key)) continue;
    if (key === "page" && (!value || value === "1")) continue;
    if (key === "s" && !value) continue;
    kept.push([key, value.toLowerCase()]);
  }

  kept.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    `${leftKey}=${leftValue}`.localeCompare(`${rightKey}=${rightValue}`),
  );
  return kept.length ? `?${kept.map(([key, value]) => `${key}=${value}`).join("&")}` : "";
}

function buildHomepageRepairs(awards, sourcesByAward) {
  return awards
    .filter((award) => award.official_homepage && nonAwardReason(award.official_homepage, award.name))
    .map((award) => {
      const replacement = [...(sourcesByAward.get(award.id) || [])]
        .filter((source) => !nonAwardReason(source.url, source.title))
        .sort((left, right) => homepageCandidateScore(right) - homepageCandidateScore(left))[0];
      return {
        award,
        oldUrl: award.official_homepage,
        nextUrl: replacement?.url || null,
      };
    });
}

function homepageCandidateScore(source) {
  let score = preferenceScore(source);
  if (source.page_type === "homepage") score += 20;
  try {
    const url = new URL(source.url);
    const cleanPath = url.pathname.replace(/\/+$/g, "");
    if (!cleanPath) score += 10;
    if (cleanPath.split("/").filter(Boolean).length <= 1) score += 4;
  } catch {
    score -= 10;
  }
  return score;
}

function nonAwardReason(value, title = "") {
  if (!value) return null;

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const full = url.toString();
    const lower = `${title} ${full}`.toLowerCase();
    if (["fellowship-finder.grad.illinois.edu", "onsa.asu.edu"].includes(host)) {
      return "institutional_discovery_host";
    }
    if (host === "a.cms.omniupdate.com") {
      return "cms_admin_host";
    }
    if (/\/(wp-login\.php|login|signin|sign-in|cart|donate|privacy|terms|terms-of-use|terms-of-service|termsofuse|jobregister)\b/i.test(url.pathname)) {
      return "generic_non_award_path";
    }
    if (/\/(sign-up|signup|subscribe|newsletter)\b|\/portal\/user\/u_login\.php/i.test(url.pathname)) {
      return "generic_non_award_path";
    }
    if (/[?&](share|replytocom|utm_|fbclid|gclid|redirect_to=)/i.test(full)) {
      return "tracking_or_redirect_query";
    }
    if (/\/(news|events|calendar|tag|category)\b/i.test(url.pathname) && !/(scholar|fellow|award|grant|program|apply|application|deadline|eligib)/i.test(lower)) {
      return "generic_listing_path";
    }
    if (/\.(jpg|jpeg|png|gif|webp|svg|zip|ics|mp4|mp3|doc|docx|xls|xlsx|ppt|pptx)$/i.test(url.pathname)) {
      return "non_monitorable_asset";
    }
  } catch {
    return "invalid_url";
  }

  return null;
}

async function loadAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

function createSupabaseClient() {
  const env = { ...loadEnvFile(resolve(root, ".env.local")), ...process.env };
  if (env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && !env.NEXT_PUBLIC_SUPABASE_URL.includes("127.0.0.1")) {
    return createSupabaseServiceClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }

  if (!projectRef) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or link Supabase.");
  }

  const keys = JSON.parse(
    execFileSync(
      "npx",
      ["supabase", "projects", "api-keys", "--project-ref", projectRef, "--output", "json"],
      { encoding: "utf8", cwd: root },
    ),
  );
  const serviceRoleKey = keys.find((key) => key.name === "service_role")?.api_key;
  if (!serviceRoleKey) throw new Error(`Could not read service_role key for ${projectRef}.`);
  return createSupabaseServiceClient(`https://${projectRef}.supabase.co`, serviceRoleKey);
}

function readLinkedProjectRef() {
  try {
    return readFileSync(resolve(root, "supabase/.temp/project-ref"), "utf8").trim();
  } catch {
    return "";
  }
}

function loadEnvFile(path) {
  try {
    const env = {};
    for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index === -1) continue;
      const key = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

function groupBy(values, keyFor) {
  const grouped = new Map();
  for (const value of values) {
    const key = keyFor(value);
    grouped.set(key, [...(grouped.get(key) || []), value]);
  }
  return grouped;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [key, inlineValue] = value.slice(2).split("=");
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
    } else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[key] = values[index + 1];
      index += 1;
    } else {
      parsed[key] = "true";
    }
  }
  return parsed;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
