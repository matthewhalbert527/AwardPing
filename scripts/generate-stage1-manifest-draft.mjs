#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStage1ManifestDraft } from "./lib/stage1-manifest-draft.mjs";
import { loadStage1ManifestDraftDatabase } from "./lib/stage1-manifest-draft-loader.mjs";
import { createSupabaseServiceClient } from "./supabase-service-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  await main();
} catch (error) {
  console.error(`Stage 1 manifest draft failed closed: ${safeError(error)}`);
  console.error("Remote mutations: 0; paid API calls: 0; ranked candidates accepted: 0");
  process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const mappingPath = resolve(root, requireArg(args.mapping, "--mapping"));
  if (!existsSync(mappingPath)) throw new Error(`Mapping file does not exist: ${mappingPath}`);
  const mapping = readJson(mappingPath, "mapping");
  const envPath = resolve(root, String(args.env || defaultEnvFile()));
  const env = {
    ...(existsSync(envPath) ? loadEnvFile(envPath) : {}),
    ...process.env,
  };
  const supabaseUrl = cleanText(env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceRoleKey = cleanText(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for read-only evidence verification.",
    );
  }

  const now = new Date();
  const supabase = createSupabaseServiceClient(supabaseUrl, serviceRoleKey);
  const database = await loadStage1ManifestDraftDatabase({ supabase, mapping, now });
  const draft = buildStage1ManifestDraft({ mapping, database, now });
  const outputPath = resolve(root, String(args.output || join(
    "reports",
    `stage1-manifest-draft-${draft.draft_review.target_mode}-${fileTimestamp(now.toISOString())}.json`,
  )));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");

  console.log(`Stage 1 manifest draft: ${outputPath}`);
  console.log(`Target: ${draft.draft_review.target_mode} (${draft.cohorts.length})`);
  console.log(`Manifest SHA-256: ${draft.draft_review.manifest_sha256}`);
  console.log(`Review confirmation SHA-256: ${draft.draft_review.confirmation_sha256}`);
  console.log("Remote mutations: 0; paid API calls: 0; ranked candidates accepted: 0");
  console.log(
    "Next: review the file and its confirmation metadata, then pass it to stage1:promote without --apply for a separate dry-run preview.",
  );
}

function parseArgs(values) {
  const parsed = {};
  const allowed = new Set(["mapping", "env", "output", "help"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected positional argument: ${value}`);
    const raw = value.slice(2);
    const [key, ...inline] = raw.split("=");
    if (!allowed.has(key)) {
      throw new Error(`Unknown option --${key}. This command has no apply or mutation mode.`);
    }
    if (key === "help") {
      parsed.help = true;
      continue;
    }
    if (inline.length) {
      parsed[key] = inline.join("=");
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`--${key} requires a value.`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} JSON ${path}: ${safeError(error)}`);
  }
}

function loadEnvFile(path) {
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function defaultEnvFile() {
  return existsSync(resolve(root, ".env.worker.local"))
    ? ".env.worker.local"
    : ".env.local";
}

function requireArg(value, label) {
  const text = cleanText(value);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function fileTimestamp(value) {
  return value.replace(/[:.]/g, "-");
}

function safeError(error) {
  return String(error?.message || error || "unknown_error")
    .replace(/(eyJ[a-zA-Z0-9._-]+)/g, "[redacted-token]")
    .replace(/(sb_(?:secret|publishable)_[a-zA-Z0-9_-]+)/g, "[redacted-key]")
    .slice(0, 2_000);
}

function printHelp() {
  console.log(`Usage:
  npm run stage1:manifest-draft -- --mapping=<reviewed-mapping.json>

Required:
  --mapping=<path>  Signed Stage 1 human-review root already committed through
                    reviewed reconciliation. It must identify one exact cohort
                    or all exact national 25.

Options:
  --env=<path>      Defaults to .env.worker.local, then .env.local
  --output=<path>   Local promotion-compatible JSON draft
  --help            Show this message without loading credentials

Human-review root contract:
  docs/stage1-manifest-draft-mapping.schema.json
Example:
  docs/stage1-manifest-draft-mapping.example.json

Safety:
  This command performs SELECT-only stable database reads and one local file
  write. It has no --apply mode, never accepts ranked candidates, never calls
  paid providers, never captures pages, and never requests R2 objects.`);
}
