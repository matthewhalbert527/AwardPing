import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STAGE1_PENDING_MIGRATIONS = Object.freeze([
  "20260717070000_incremental_manual_quarantine_sync.sql",
  "20260717071500_stage1_regression_audit_observations.sql",
  "20260717073548_reconciliation_disposition_atomicity.sql",
  "20260717101505_fix_stage1_release_gate_worker_run_composite.sql",
  "20260717105043_harden_stage1_vault_service_role.sql",
  "20260717113112_preserve_legacy_personal_data_for_reentry.sql",
  "20260717114500_rhodes_us_source_identity_fence.sql",
  "20260717114600_gilman_source_identity_fence.sql",
  "20260717121500_source_cleanup_compare_and_swap.sql",
  "20260717123000_legacy_contact_ciphertext_quarantine.sql",
  "20260717133922_durable_stage1_verification_epoch.sql",
  "20260717144500_stage1_reviewed_candidate_import.sql",
  "20260717150000_reviewed_stage1_reconciliation.sql",
  "20260717153000_hertz_ndseg_canonical_authority.sql",
]);

const marker = "-- __AWARDPING_PENDING_MIGRATIONS__";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export function renderStage1PendingMigrationRollbackProbe() {
  const template = readFileSync(
    resolve(scriptDirectory, "sql/stage1-pending-migration-rollback-probe.sql"),
    "utf8",
  );
  if (template.split(marker).length !== 2) {
    throw new Error(`Rollback-probe template must contain exactly one ${marker} marker.`);
  }

  const migrations = STAGE1_PENDING_MIGRATIONS.map((name) => {
    const sql = readFileSync(
      resolve(scriptDirectory, `../supabase/migrations/${name}`),
      "utf8",
    ).trim();
    if (/^\s*(?:begin|commit|rollback)\s*;/imu.test(sql)) {
      throw new Error(`${name} contains transaction control and cannot be nested safely.`);
    }
    const sha256 = createHash("sha256").update(sql, "utf8").digest("hex");
    return [
      `-- BEGIN EXACT MIGRATION ${name} sha256=${sha256}`,
      sql,
      `-- END EXACT MIGRATION ${name}`,
    ].join("\n");
  }).join("\n\n");

  // A replacement callback is required: a replacement string would collapse
  // every PostgreSQL `$$` delimiter to `$` under String.replace semantics.
  return `${template.replace(marker, () => migrations).replace(/\r\n/g, "\n").trimEnd()}\n`;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  process.stdout.write(renderStage1PendingMigrationRollbackProbe());
}
