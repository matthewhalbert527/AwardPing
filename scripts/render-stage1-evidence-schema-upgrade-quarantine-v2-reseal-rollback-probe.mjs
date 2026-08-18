import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_MIGRATION =
  "20260815012910_reseal_stage1_evidence_schema_upgrade_quarantine_v2.sql";
export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_SMOKE =
  "stage1_evidence_schema_upgrade_quarantine_v2_reseal_smoke.sql";

const migrationMarker = "-- __AWARDPING_EXACT_MIGRATION__";
const smokeMarker = "-- __AWARDPING_EXACT_SMOKE__";
const priorMigrationsMarker =
  "-- __AWARDPING_EXACT_PRIOR_MIGRATION_VERSIONS__";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(scriptDirectory, "../supabase/migrations");

function normalizeSql(name, sql) {
  const normalized = sql.replace(/\r\n/g, "\n").trim();
  if (normalized.includes("\r")) {
    throw new Error(`${name} contains unsupported standalone CR bytes.`);
  }
  if (/^\s*(?:begin|commit|rollback)\s*;/imu.test(normalized)) {
    throw new Error(`${name} contains transaction control and cannot be nested safely.`);
  }
  return normalized;
}

function exactSqlBlock({ label, name, sql }) {
  const normalized = normalizeSql(name, sql);
  const sha256 = createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex");
  return [
    `-- BEGIN EXACT ${label} ${name} sha256=${sha256}`,
    normalized,
    `-- END EXACT ${label} ${name}`,
  ].join("\n");
}

export function listStage1EvidenceSchemaUpgradeQuarantineV2PriorVersions() {
  const targetVersion =
    STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_MIGRATION.split(
      "_",
      1,
    )[0];
  const versions = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .map((name) => ({ name, version: name.split("_", 1)[0] }))
    .filter(({ version }) => version.localeCompare(targetVersion) < 0)
    .sort((left, right) => left.version.localeCompare(right.version));

  if (versions.length === 0) {
    throw new Error("The Stage 1 quarantine v2 reseal has no prior migration preflight set.");
  }
  if (new Set(versions.map(({ version }) => version)).size !== versions.length) {
    throw new Error("Prior migration versions are not unique.");
  }
  return versions.map(({ version }) => version);
}

function exactPriorMigrationsBlock(versions) {
  const sha256 = createHash("sha256")
    .update(versions.join("\n"), "utf8")
    .digest("hex");
  return [
    `-- BEGIN EXACT PRIOR MIGRATION VERSIONS count=${versions.length} sha256=${sha256}`,
    "array[",
    ...versions.map(
      (version, index) =>
        `  '${version}'::text${index === versions.length - 1 ? "" : ","}`,
    ),
    "]::text[]",
    "-- END EXACT PRIOR MIGRATION VERSIONS",
  ].join("\n");
}

export function renderStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbe() {
  const template = readFileSync(
    resolve(
      scriptDirectory,
      "sql/stage1-evidence-schema-upgrade-quarantine-v2-reseal-rollback-probe.sql",
    ),
    "utf8",
  );
  for (const marker of [migrationMarker, smokeMarker, priorMigrationsMarker]) {
    if (template.split(marker).length !== 2) {
      throw new Error(
        `Rollback-probe template must contain exactly one ${marker} marker.`,
      );
    }
  }

  const migration = exactSqlBlock({
    label: "MIGRATION",
    name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_MIGRATION,
    sql: readFileSync(
      resolve(
        migrationsDirectory,
        STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_MIGRATION,
      ),
      "utf8",
    ),
  });
  const smoke = exactSqlBlock({
    label: "SMOKE",
    name: STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_SMOKE,
    sql: readFileSync(
      resolve(
        scriptDirectory,
        `../supabase/tests/${STAGE1_EVIDENCE_SCHEMA_UPGRADE_QUARANTINE_V2_RESEAL_SMOKE}`,
      ),
      "utf8",
    ),
  });
  const priorMigrations = exactPriorMigrationsBlock(
    listStage1EvidenceSchemaUpgradeQuarantineV2PriorVersions(),
  );

  return `${template
    .replace(priorMigrationsMarker, () => priorMigrations)
    .replace(migrationMarker, () => migration)
    .replace(smokeMarker, () => smoke)
    .replace(/\r\n/g, "\n")
    .trimEnd()}\n`;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  process.stdout.write(
    renderStage1EvidenceSchemaUpgradeQuarantineV2RollbackProbe(),
  );
}
