#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const envPath = resolve(root, readArg("--env") || ".env.local");
const production = args.includes("--production");

const results = [];
const env = {
  ...process.env,
  ...(existsSync(envPath) ? parseEnvFile(readFileSync(envPath, "utf8")) : {}),
};

checkEnvFile();
checkRequiredEnv();
checkProductionEnv();
checkVercelProjectLink();
checkVercelCron();
checkMigrations();
checkFreeServiceCopy();
checkRedirects();

for (const result of results) {
  console.log(`${result.status.padEnd(6)} ${result.message}`);
}

const failures = results.filter((result) => result.status === "FAIL");
const warnings = results.filter((result) => result.status === "WARN");

console.log("");
console.log(
  `Private beta readiness: ${failures.length} blocker${
    failures.length === 1 ? "" : "s"
  }, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`,
);

process.exitCode = failures.length ? 1 : 0;

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || null;
}

function pass(message) {
  results.push({ status: "OK", message });
}

function warn(message) {
  results.push({ status: "WARN", message });
}

function fail(message) {
  results.push({ status: "FAIL", message });
}

function parseEnvFile(contents) {
  const parsed = {};

  for (const rawLine of contents.split(/\r?\n/)) {
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

    parsed[key] = value;
  }

  return parsed;
}

function hasValue(key) {
  return typeof env[key] === "string" && env[key].trim().length > 0;
}

function checkEnvFile() {
  if (existsSync(envPath)) {
    pass(`Loaded ${relativePath(envPath)} without printing secret values.`);
  } else {
    fail(`${relativePath(envPath)} does not exist.`);
  }
}

function checkRequiredEnv() {
  const required = [
    ["NEXT_PUBLIC_APP_URL", "hosted app URL"],
    ["NEXT_PUBLIC_SUPABASE_URL", "Supabase project URL"],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "Supabase anon key"],
    ["SUPABASE_SERVICE_ROLE_KEY", "Supabase service role key"],
    ["CRON_SECRET", "cron route secret"],
    ["RESEND_API_KEY", "Resend email delivery"],
    ["ALERT_FROM_EMAIL", "verified email sender"],
    ["CONTACT_TO_EMAIL", "contact form recipient"],
    ["TAVILY_API_KEY", "source finder search"],
    ["OPENAI_API_KEY", "source finder classification"],
  ];

  for (const [key, label] of required) {
    if (hasValue(key)) {
      pass(`${key} is set for ${label}.`);
    } else {
      fail(`${key} is missing; required for ${label}.`);
    }
  }

  if (hasValue("CRON_SECRET")) {
    const secret = env.CRON_SECRET.trim();
    if (secret.length < 24 || /replace|changeme|secret/i.test(secret)) {
      fail("CRON_SECRET must be a long production-only random value.");
    } else {
      pass("CRON_SECRET is not a placeholder and is long enough for launch.");
    }
  }
}

function checkProductionEnv() {
  if (!hasValue("NEXT_PUBLIC_APP_URL")) return;

  let appUrl;
  try {
    appUrl = new URL(env.NEXT_PUBLIC_APP_URL);
    pass("NEXT_PUBLIC_APP_URL is a valid URL.");
  } catch {
    fail("NEXT_PUBLIC_APP_URL is not a valid URL.");
    return;
  }

  if (!production) {
    warn("Run with --production against production env values before inviting beta users.");
    return;
  }

  if (["localhost", "127.0.0.1"].includes(appUrl.hostname)) {
    fail("NEXT_PUBLIC_APP_URL still points at localhost in production mode.");
  } else if (appUrl.protocol !== "https:") {
    fail("NEXT_PUBLIC_APP_URL must use https in production mode.");
  } else {
    pass("NEXT_PUBLIC_APP_URL is an https production URL.");
  }

  if (hasValue("ALERT_FROM_EMAIL") && /example\.com/i.test(env.ALERT_FROM_EMAIL)) {
    fail("ALERT_FROM_EMAIL still uses example.com; configure a verified Resend sender.");
  }

  if (hasValue("NEXT_PUBLIC_SUPABASE_URL")) {
    try {
      const supabaseUrl = new URL(env.NEXT_PUBLIC_SUPABASE_URL);
      if (["localhost", "127.0.0.1"].includes(supabaseUrl.hostname)) {
        fail("NEXT_PUBLIC_SUPABASE_URL still points at local Supabase in production mode.");
      } else if (supabaseUrl.protocol !== "https:") {
        fail("NEXT_PUBLIC_SUPABASE_URL must use https in production mode.");
      } else {
        pass("NEXT_PUBLIC_SUPABASE_URL is an https production URL.");
      }
    } catch {
      fail("NEXT_PUBLIC_SUPABASE_URL is not a valid URL.");
    }
  }
}

function checkVercelProjectLink() {
  const linkPath = resolve(root, ".vercel", "project.json");
  if (!existsSync(linkPath)) {
    warn("Vercel project is not linked locally; run npx vercel@latest link before deploying.");
    return;
  }

  try {
    const link = JSON.parse(readFileSync(linkPath, "utf8"));
    if (link.projectId && link.orgId) {
      pass(`Vercel project link exists for ${link.projectName || "this app"}.`);
    } else {
      warn(".vercel/project.json exists but is missing projectId or orgId.");
    }
  } catch {
    warn(".vercel/project.json is not valid JSON.");
  }
}

function checkVercelCron() {
  const vercelPath = resolve(root, "vercel.json");
  if (!existsSync(vercelPath)) {
    fail("vercel.json is missing.");
    return;
  }

  let config;
  try {
    config = JSON.parse(readFileSync(vercelPath, "utf8"));
  } catch {
    fail("vercel.json is not valid JSON.");
    return;
  }

  const crons = Array.isArray(config.crons) ? config.crons : [];
  const paths = new Map(crons.map((cron) => [cron.path, cron.schedule]));
  const expected = [
    ["/api/cron/check-monitors", "0 12 * * *"],
    ["/api/cron/send-digests", "0 13 * * *"],
  ];

  for (const [path, schedule] of expected) {
    if (paths.get(path) === schedule) {
      pass(`Vercel cron ${path} is scheduled as ${schedule}.`);
    } else {
      fail(`Vercel cron ${path} is missing or has the wrong schedule.`);
    }
  }
}

function checkMigrations() {
  const expected = [
    "0001_initial.sql",
    "0002_award_discovery.sql",
    "0003_offices_notifications.sql",
    "0004_job_runs.sql",
    "0005_award_pipeline.sql",
    "0006_discovery_rate_limits.sql",
    "0007_shared_award_catalog.sql",
    "0008_shared_award_history.sql",
    "0009_office_workspace_invites.sql",
    "0016_public_updates_contact.sql",
    "0017_structured_change_details.sql",
  ];

  for (const file of expected) {
    const migrationPath = resolve(root, "supabase", "migrations", file);
    if (existsSync(migrationPath)) {
      pass(`Migration ${file} is present.`);
    } else {
      fail(`Migration ${file} is missing.`);
    }
  }

  const jobRuns = readIfExists("supabase/migrations/0004_job_runs.sql");
  if (/create\s+table\s+(if\s+not\s+exists\s+)?public\.job_runs/i.test(jobRuns)) {
    pass("job_runs migration is present for cron observability.");
  } else {
    fail("job_runs table creation was not found in migration 0004.");
  }

  const pipeline = readIfExists("supabase/migrations/0005_award_pipeline.sql");
  if (/public\.award_notes/i.test(pipeline) && /public\.award_tasks/i.test(pipeline)) {
    pass("Award pipeline migration includes notes and tasks.");
  } else {
    fail("Award pipeline migration does not include both notes and tasks.");
  }

  const rateLimits = readIfExists("supabase/migrations/0006_discovery_rate_limits.sql");
  if (/public\.discovery_requests/i.test(rateLimits)) {
    pass("Award discovery rate-limit migration is present.");
  } else {
    fail("Award discovery rate-limit migration is missing.");
  }

  const sharedCatalog = readIfExists("supabase/migrations/0007_shared_award_catalog.sql");
  if (
    /public\.shared_awards/i.test(sharedCatalog) &&
    /public\.shared_award_sources/i.test(sharedCatalog)
  ) {
    pass("Shared award catalog migration is present.");
  } else {
    fail("Shared award catalog migration is missing.");
  }

  const sharedHistory = readIfExists("supabase/migrations/0008_shared_award_history.sql");
  if (
    /public\.shared_award_source_snapshots/i.test(sharedHistory) &&
    /public\.shared_award_change_events/i.test(sharedHistory)
  ) {
    pass("Shared award history migration is present.");
  } else {
    fail("Shared award history migration is missing.");
  }

  const officeInvites = readIfExists("supabase/migrations/0009_office_workspace_invites.sql");
  if (/invite_code/i.test(officeInvites) && /New award office/i.test(officeInvites)) {
    pass("Office invite-code migration is present.");
  } else {
    fail("Office invite-code migration is missing.");
  }

  const publicUpdates = readIfExists("supabase/migrations/0016_public_updates_contact.sql");
  if (
    /public\.public_update_subscribers/i.test(publicUpdates) &&
    /public\.public_form_rate_limits/i.test(publicUpdates)
  ) {
    pass("Public update subscriber and contact rate-limit migration is present.");
  } else {
    fail("Public update/contact migration is missing.");
  }

  const structuredDetails = readIfExists("supabase/migrations/0017_structured_change_details.sql");
  if (
    /public\.shared_award_change_events[\s\S]*change_details/i.test(structuredDetails) &&
    /public\.change_events[\s\S]*change_details/i.test(structuredDetails)
  ) {
    pass("Structured change-details migration is present.");
  } else {
    fail("Structured change-details migration is missing change_details on both change tables.");
  }
}

function checkFreeServiceCopy() {
  const files = listTextFiles(["src", "README.md"]).filter(
    (file) => !file.includes("node_modules"),
  );
  const offenders = files.filter((file) => /without a paywall|paywall/i.test(readIfExists(file)));

  if (offenders.length === 0) {
    pass("User-facing text avoids paywall wording.");
  } else {
    fail(`Remove paywall wording from ${offenders.map(relativePath).join(", ")}.`);
  }
}

function checkRedirects() {
  const pricing = readIfExists("src/app/pricing/page.tsx");
  const billing = readIfExists("src/app/dashboard/billing/page.tsx");

  if (/redirect\(["']\/signup["']\)/.test(pricing)) {
    pass("/pricing redirects to /signup.");
  } else {
    fail("/pricing should redirect to /signup for the free beta.");
  }

  if (/redirect\(["']\/dashboard["']\)/.test(billing)) {
    pass("/dashboard/billing redirects to /dashboard.");
  } else {
    fail("/dashboard/billing should redirect to /dashboard for the free beta.");
  }
}

function readIfExists(file) {
  const absolute = resolve(root, file);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
}

function listTextFiles(entries) {
  const files = [];

  for (const entry of entries) {
    const absolute = resolve(root, entry);
    if (!existsSync(absolute)) continue;

    const stats = readdirSafe(absolute);
    if (!stats) {
      files.push(entry);
      continue;
    }

    for (const child of stats) {
      const childPath = `${entry}/${child.name}`;
      if (child.isDirectory()) {
        files.push(...listTextFiles([childPath]));
      } else if (/\.(ts|tsx|js|jsx|md|txt)$/.test(child.name)) {
        files.push(childPath);
      }
    }
  }

  return files;
}

function readdirSafe(absolute) {
  try {
    return readdirSync(absolute, { withFileTypes: true });
  } catch {
    return null;
  }
}

function relativePath(absoluteOrRelative) {
  const absolute = resolve(root, absoluteOrRelative);
  return absolute.startsWith(root) ? absolute.slice(root.length + 1) : absoluteOrRelative;
}
