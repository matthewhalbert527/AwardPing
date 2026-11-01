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
  "scripts/lib/program-text-deterministic-no-change.mjs",
  "scripts/lib/program-text-review.mjs",
  "scripts/lib/program-text-monitor.mjs",
  "scripts/lib/program-text-collection-quality.mjs",
  "scripts/lib/program-text-repository.mjs",
  "scripts/lib/program-text-review-queue.mjs",
  "scripts/lib/program-text-host-pacing.mjs",
  "scripts/lib/program-text-cycle-runner.mjs",
  "scripts/lib/program-text-collection-cycle.mjs",
  "scripts/lib/scrapling-session-process.mjs",
  "scripts/evaluate-public-page-audit-canaries.mjs",
  "scripts/lib/program-basic-page-audit.mjs",
  "scripts/lib/basic-award-facts.mjs",
  "scripts/lib/program-text-facts.mjs",
  "scripts/lib/current-basic-source-proof.mjs",
  "scripts/lib/current-basic-reviewed-repeat.mjs",
  "scripts/lib/current-basic-technical-probe.mjs",
  "scripts/program-text-worker.mjs",
  "scripts/lib/program-text-source-access.mjs",
  "scripts/lib/program-text-canonical-url-admission.mjs",
  "scripts/lib/program-text-public-drive-pdf.mjs",
  "scripts/lib/program-text-public-drive-transport.mjs",
  "scripts/lib/program-text-capture-contract.mjs",
  "scripts/lib/program-text-capture.mjs",
  "scripts/lib/program-text-artifacts.mjs",
  "scripts/lib/program-text-reviewed-pdf.mjs",
  "scripts/lib/program-text-reviewed-pdf-transition.mjs",
  "scripts/lib/fixtures/khs-2027-reviewed-visible-pdf.mjs",
  "scripts/lib/program-text-publisher-json.mjs",
  "scripts/lib/program-text-smart-publisher-json.mjs",
  "scripts/lib/program-text-smart-kb-publisher-json.mjs",
  "scripts/lib/program-text-smart-kb-reviewed-model.mjs",
  "scripts/lib/program-text-smart-guide-profiles.mjs",
  "scripts/lib/program-text-smart-guide-reviewed-model.mjs",
  "scripts/lib/program-text-smart-body-link.mjs",
  "scripts/lib/program-text-source-raw-anchor.mjs",
  "scripts/lib/scrapling-capture.mjs",
  "scripts/scrapling/collector.py",
  "scripts/scrapling/smart_publisher_json.py",
  "scripts/scrapling/html_document.py",
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
