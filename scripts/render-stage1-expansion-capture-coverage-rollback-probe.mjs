import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STAGE1_EXPANSION_CAPTURE_COVERAGE_MIGRATION =
  "20260814173236_require_stage1_expansion_capture_coverage.sql";
export const STAGE1_EXPANSION_CAPTURE_COVERAGE_SMOKE =
  "stage1_expansion_capture_coverage_smoke.sql";

const migrationMarker = "-- __AWARDPING_EXACT_MIGRATION__";
const smokeMarker = "-- __AWARDPING_EXACT_SMOKE__";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function exactSqlBlock({ label, name, sql }) {
  const normalized = sql.replace(/\r\n/g, "\n").trim();
  if (normalized.includes("\r")) {
    throw new Error(`${name} contains unsupported standalone CR bytes.`);
  }
  if (/^\s*(?:begin|commit|rollback)\s*;/imu.test(normalized)) {
    throw new Error(`${name} contains transaction control and cannot be nested safely.`);
  }
  const sha256 = createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex");
  return [
    `-- BEGIN EXACT ${label} ${name} sha256=${sha256}`,
    normalized,
    `-- END EXACT ${label} ${name}`,
  ].join("\n");
}

export function renderStage1ExpansionCaptureCoverageRollbackProbe() {
  const template = readFileSync(
    resolve(
      scriptDirectory,
      "sql/stage1-expansion-capture-coverage-rollback-probe.sql",
    ),
    "utf8",
  );
  for (const marker of [migrationMarker, smokeMarker]) {
    if (template.split(marker).length !== 2) {
      throw new Error(`Rollback-probe template must contain exactly one ${marker} marker.`);
    }
  }

  const migration = exactSqlBlock({
    label: "MIGRATION",
    name: STAGE1_EXPANSION_CAPTURE_COVERAGE_MIGRATION,
    sql: readFileSync(
      resolve(
        scriptDirectory,
        `../supabase/migrations/${STAGE1_EXPANSION_CAPTURE_COVERAGE_MIGRATION}`,
      ),
      "utf8",
    ),
  });
  const smoke = exactSqlBlock({
    label: "SMOKE",
    name: STAGE1_EXPANSION_CAPTURE_COVERAGE_SMOKE,
    sql: readFileSync(
      resolve(
        scriptDirectory,
        `../supabase/tests/${STAGE1_EXPANSION_CAPTURE_COVERAGE_SMOKE}`,
      ),
      "utf8",
    ),
  });

  return `${template
    .replace(migrationMarker, () => migration)
    .replace(smokeMarker, () => smoke)
    .replace(/\r\n/g, "\n")
    .trimEnd()}\n`;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  process.stdout.write(renderStage1ExpansionCaptureCoverageRollbackProbe());
}
