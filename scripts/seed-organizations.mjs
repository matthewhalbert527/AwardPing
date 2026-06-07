#!/usr/bin/env node

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const hipoUrl =
  "https://raw.githubusercontent.com/Hipo/university-domains-list/master/world_universities_and_domains.json";
const sourceLabel = "hipo";
const batchSize = 500;

const response = await fetch(hipoUrl);
if (!response.ok) {
  throw new Error(`Could not fetch organization dataset: ${response.status}`);
}

const hipoRows = await response.json();
const rows = dedupeOrganizations([
  ...hipoRows.map((row) => ({
    name: normalizeOrganizationName(row.name),
    country: cleanText(row.country),
    country_code: cleanText(row.alpha_two_code),
    state_province: cleanText(row["state-province"]),
    domains: cleanArray(row.domains),
    web_pages: cleanArray(row.web_pages),
    source: sourceLabel,
  })),
  {
    name: "University of Arkansas, Fayetteville",
    country: "United States",
    country_code: "US",
    state_province: "Arkansas",
    domains: ["uark.edu"],
    web_pages: ["https://www.uark.edu/"],
    source: "admin",
  },
]);

const tempDir = await mkdtemp(join(tmpdir(), "awardping-organizations-"));

try {
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    const sql = buildBatchSql(batch);
    const sqlPath = join(tempDir, `organizations-${index / batchSize + 1}.sql`);
    await writeFile(sqlPath, sql);

    const result = spawnSync(
      "npx",
      ["supabase", "db", "query", "--linked", "--file", sqlPath],
      { stdio: "inherit" },
    );

    if (result.status !== 0) {
      throw new Error(`Organization seed batch failed at row ${index + 1}.`);
    }
  }

  console.log(`Seeded ${rows.length} organizations from Hipo plus AwardPing curated entries.`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function dedupeOrganizations(inputRows) {
  const byKey = new Map();

  for (const row of inputRows) {
    if (!row.name) continue;

    const key = normalizedLookupName(row.name);
    if (!key) continue;

    const existing = byKey.get(key);
    if (!existing || row.source === "admin") {
      byKey.set(key, { ...row, normalized_name: key });
      continue;
    }

    byKey.set(key, {
      ...existing,
      domains: [...new Set([...existing.domains, ...row.domains])],
      web_pages: [...new Set([...existing.web_pages, ...row.web_pages])],
    });
  }

  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function buildBatchSql(batch) {
  const values = batch
    .map(
      (row) =>
        `(${sqlString(row.name)}, ${sqlString(row.normalized_name)}, ${sqlString(row.country)}, ${sqlString(
          row.country_code,
        )}, ${sqlString(row.state_province)}, ${sqlArray(row.domains)}, ${sqlArray(
          row.web_pages,
        )}, ${sqlString(row.source)})`,
    )
    .join(",\n");

  return `
insert into public.organizations
  (name, normalized_name, country, country_code, state_province, domains, web_pages, source)
values
${values}
on conflict (normalized_name) do update set
  country = coalesce(public.organizations.country, excluded.country),
  country_code = coalesce(public.organizations.country_code, excluded.country_code),
  state_province = coalesce(public.organizations.state_province, excluded.state_province),
  domains = case
    when cardinality(public.organizations.domains) = 0 then excluded.domains
    else public.organizations.domains
  end,
  web_pages = case
    when cardinality(public.organizations.web_pages) = 0 then excluded.web_pages
    else public.organizations.web_pages
  end,
  updated_at = now();
`.trim();
}

function cleanText(value) {
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/\s+/g, " ");
  return clean || null;
}

function cleanArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => cleanText(item)).filter(Boolean))]
    : [];
}

function sqlString(value) {
  if (value === null || value === undefined || value === "") return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlArray(values) {
  if (!values.length) return "'{}'::text[]";
  return `array[${values.map(sqlString).join(", ")}]::text[]`;
}

function normalizedLookupName(value) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeOrganizationName(value) {
  const clean = cleanText(value);
  if (!clean) return "";

  return clean
    .split(/(\s+|-|,|\/|&)/)
    .map((part, index, parts) => normalizeOrganizationPart(part, index, parts))
    .join("")
    .replace(/\s+([,])/g, "$1")
    .trim();
}

function normalizeOrganizationPart(part, index, parts) {
  if (!part || /^[\s,\/-]$/.test(part) || part === "&") return part;

  const lower = part.toLowerCase();
  const previousText = parts.slice(0, index).some((item) => /\w/.test(item));
  const lowercaseJoiners = new Set([
    "a",
    "an",
    "and",
    "at",
    "by",
    "da",
    "de",
    "del",
    "der",
    "di",
    "du",
    "for",
    "in",
    "la",
    "le",
    "of",
    "on",
    "or",
    "the",
    "to",
    "van",
    "von",
  ]);

  if (lowercaseJoiners.has(lower) && previousText) return lower;
  if (/^[A-Z0-9]{2,}$/.test(part) || part.includes(".")) return part.toUpperCase();

  return lower.replace(/(^|')([a-z])/g, (match) => match.toUpperCase());
}
