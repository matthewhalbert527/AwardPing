import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STAGE1_LANE_GATE_CADENCE_SLA_MIGRATION =
  "20260814191514_fix_stage1_lane_gate_cadence_sla.sql";

const migrationMarker = "-- __AWARDPING_EXACT_MIGRATION__";
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

export function renderStage1LaneGateCadenceSlaRollbackProbe() {
  const template = readFileSync(
    resolve(
      scriptDirectory,
      "sql/stage1-lane-gate-cadence-sla-rollback-probe.sql",
    ),
    "utf8",
  );
  if (template.split(migrationMarker).length !== 2) {
    throw new Error(
      `Rollback-probe template must contain exactly one ${migrationMarker} marker.`,
    );
  }

  const migration = exactSqlBlock({
    label: "MIGRATION",
    name: STAGE1_LANE_GATE_CADENCE_SLA_MIGRATION,
    sql: readFileSync(
      resolve(
        scriptDirectory,
        `../supabase/migrations/${STAGE1_LANE_GATE_CADENCE_SLA_MIGRATION}`,
      ),
      "utf8",
    ),
  });

  return `${template
    .replace(migrationMarker, () => migration)
    .replace(/\r\n/g, "\n")
    .trimEnd()}\n`;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  process.stdout.write(renderStage1LaneGateCadenceSlaRollbackProbe());
}
