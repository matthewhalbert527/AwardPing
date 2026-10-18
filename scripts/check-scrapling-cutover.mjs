#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyScraplingRuntimeBinding } from "./lib/scrapling-runtime-binding.mjs";
import { validateScraplingSourceManifest } from "./lib/scrapling-worker.mjs";

const usage = "Usage: node scripts/check-scrapling-cutover.mjs --app-dir <absolute-app-directory> --manifest <absolute-app-manifest> --python <absolute-runtime-python>\nRead-only local preflight. No credentials, network, Python execution, installation or activation. Exit 0 validates local bindings only; production readiness remains unverified.";

/** One local installation snapshot, never approval or an activation command. */
export function checkScraplingCutover({ appDir, manifestPath, pythonPath } = {}) {
  for (const value of [appDir, manifestPath, pythonPath]) {
    if (typeof value !== "string" || !isAbsolute(value)) {
      throw new Error("Explicit absolute app, manifest and interpreter paths are required.");
    }
  }
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) {
    throw new Error("Invalid or oversized source manifest.");
  }
  const bytes = readFileSync(manifestPath);
  if (bytes.length !== stat.size) throw new Error("Source manifest changed during preflight.");
  const manifest = validateScraplingSourceManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  const binding = verifyScraplingRuntimeBinding({ appDir, manifestPath, pythonPath });
  if (!binding || createHash("sha256").update(bytes).digest("hex") !== binding.manifestSha256) {
    throw new Error("Source manifest changed during preflight.");
  }
  return {
    schema: "awardping.scrapling-local-preflight.v1",
    status: "local_binding_verified_not_ready_for_cutover",
    production_ready: false,
    activation_authorized: false,
    external_actions: 0,
    verified_local_binding: binding,
    source_manifest: {
      profile: manifest.profile,
      reviewed_at: manifest.reviewed_at,
      source_count: manifest.sources.length,
      selected_award_count: new Set(manifest.sources.map(source => source.award_id)).size,
      declared_award_count: manifest.award_ids.length,
      live_approval_verified: false,
    },
    remaining_gates: [
      "Fresh exact source UUID, award, URL and approval-state verification.",
      "Successful real AI review and independently checked change-summary accuracy.",
      "Complete intended source coverage; explicit handling of NSF, image-PDF and oversized-context gaps.",
      "Clean isolated worker release and exact-release tests, including the offline migration rehearsal.",
      "Required authoritative baseline-only persistence and compatible rollback verified on the exact release.",
      "Installed selection and scheduled end-to-end health verified independently after controlled activation.",
    ],
    limitations: [
      "This checks selected local manifest/runtime bytes, not current websites, source approvals, Python imports or provider health.",
      "The receipt is a local integrity check, not an authentication boundary or future-integrity guarantee.",
      "No environment file was loaded, worker run started, baseline changed or scheduled task modified.",
    ],
  };
}

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!["--app-dir", "--manifest", "--python"].includes(name) || options[name] ||
        !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error(usage);
    }
    options[name] = args[index + 1];
  }
  console.log(JSON.stringify(checkScraplingCutover({
    appDir: options["--app-dir"], manifestPath: options["--manifest"], pythonPath: options["--python"],
  }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
