import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const monitoringPromotionMatcherBundleSchemaVersion =
  "awardping-promotion-matcher-source-bundle-v1";

export const monitoringPromotionMatcherBundleSources = Object.freeze([
  "scripts/lib/monitoring-promotion-matcher-bundle.mjs",
  "scripts/lib/change-event-suppression.mjs",
  "scripts/lib/change-event-sweep-state.mjs",
  "scripts/lib/award-monitoring-policy.mjs",
  "scripts/lib/source-quality.mjs",
  "scripts/lib/source-ai-review-status.mjs",
  "scripts/lib/monitoring-feedback-promotion-verification.mjs",
  "scripts/lib/visual-nightly-run-contract.mjs",
  "scripts/lib/visual-source-inventory-proof.mjs",
  "scripts/process-monitoring-feedback-promotions.mjs",
  "src/lib/change-event-suppression.ts",
  "src/lib/award-monitoring-policy.ts",
  "src/lib/source-quality.ts",
  "src/lib/source-ai-review-status.ts",
  "src/lib/source-url-policy.ts",
]);

const defaultRepositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export function buildMonitoringPromotionMatcherBundleManifest({
  repositoryRoot = defaultRepositoryRoot,
  readSource = (absolutePath) => readFileSync(absolutePath, "utf8"),
} = {}) {
  return Object.freeze(
    monitoringPromotionMatcherBundleSources
      .map((source) => {
        const normalizedSource = normalizeMatcherSource(
          readSource(resolve(repositoryRoot, ...source.split("/"))),
        );
        return Object.freeze({
          source,
          sha256: sha256(normalizedSource),
        });
      })
      .sort((left, right) => left.source.localeCompare(right.source)),
  );
}

export function monitoringPromotionMatcherBundleDigestFromManifest(manifest) {
  const sources = (Array.isArray(manifest) ? manifest : [])
    .map((entry) => ({
      source: String(entry?.source || "").trim().replaceAll("\\", "/"),
      sha256: String(entry?.sha256 || "").trim().toLowerCase(),
    }))
    .sort((left, right) => left.source.localeCompare(right.source));

  if (
    sources.length !== monitoringPromotionMatcherBundleSources.length ||
    sources.some(
      (entry, index) =>
        entry.source !==
          [...monitoringPromotionMatcherBundleSources].sort()[index] ||
        !/^[0-9a-f]{64}$/.test(entry.sha256),
    )
  ) {
    throw new Error("Promotion matcher bundle manifest is incomplete or invalid.");
  }

  return sha256(
    JSON.stringify({
      schema_version: monitoringPromotionMatcherBundleSchemaVersion,
      sources,
    }),
  );
}

export const monitoringPromotionMatcherBundleManifest =
  buildMonitoringPromotionMatcherBundleManifest();

export const monitoringPromotionMatcherBundleHash =
  monitoringPromotionMatcherBundleDigestFromManifest(
    monitoringPromotionMatcherBundleManifest,
  );

function normalizeMatcherSource(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
