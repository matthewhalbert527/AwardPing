import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// run-source-preflight.mjs has top-level logging, health, and operational
// effects, so this suite reads its source text instead of importing it.
//
// The runner forwards its env file to every child it spawns. Two of those
// children (cleanup-source-failures, backfill-source-page-titles) parse only
// the inline `--key=value` form: given the split form ["--env", path] they
// record env=true and skip the path token, then resolve a nonexistent env
// file. Every child accepts the inline form, which is also the convention
// run-downstream-lane.mjs uses, so the producer must emit `--env=<path>`.

const runner = readFileSync(
  new URL("./run-source-preflight.mjs", import.meta.url),
  "utf8",
).replace(/\r\n?/g, "\n");

const CHILD_SCRIPTS = [
  "cleanup-source-failures",
  "prune-dead-shared-sources",
  "prune-snapshot-history",
  "backfill-source-page-titles",
  "capture-visual-snapshots",
];

describe("source preflight child env forwarding", () => {
  it("forwards the env file to children as one inline --env=<path> token", () => {
    expect(runner).toContain(
      "const childEnvArgs = envPath ? [`--env=${envPath}`] : [];",
    );
    expect(runner).not.toMatch(/\[\s*"--env",\s*envPath\s*\]/);
    expect(runner).not.toMatch(/^\s*"--env",\s*$/m);
  });

  it("keeps every child forwarding site wired through childEnvArgs", () => {
    for (const child of CHILD_SCRIPTS) {
      expect(runner).toMatch(
        new RegExp(`"scripts/${child}\\.mjs",\\n\\s*\\.\\.\\.childEnvArgs,`),
      );
    }
    expect(runner.match(/\.\.\.childEnvArgs,/g)).toHaveLength(CHILD_SCRIPTS.length);
  });
});
