import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectLocalBaselineEvidence,
  parseSourceIdsFileContent,
  repairLocalBaselineEvidence,
} from "./lib/local-baseline-evidence.mjs";

const sourceId = "11111111-1111-4111-8111-111111111111";
const otherSourceId = "22222222-2222-4222-8222-222222222222";
const createdRoots = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("local baseline evidence repair", () => {
  it("parses line files, JSON arrays, and source_ids objects without duplicates", () => {
    expect(parseSourceIdsFileContent(`${sourceId}\n# ignored\n${sourceId}\n${otherSourceId}`)).toEqual([
      sourceId,
      otherSourceId,
    ]);
    expect(parseSourceIdsFileContent(JSON.stringify([sourceId, otherSourceId, sourceId]))).toEqual([
      sourceId,
      otherSourceId,
    ]);
    expect(parseSourceIdsFileContent(JSON.stringify({ source_ids: [otherSourceId] }))).toEqual([
      otherSourceId,
    ]);
    expect(() => parseSourceIdsFileContent('{"repair_source_ids":[]}')).toThrow(
      "source_ids array",
    );
    expect(() => parseSourceIdsFileContent(JSON.stringify([sourceId, 7]))).toThrow(
      "must be a string",
    );
  });

  it("accepts complete current evidence and ignores non-path expansion labels", () => {
    const fixture = createWebFixture();
    const meta = readJson(fixture.metaPath);
    meta.files.expansion_states = [{ label: "Admissions", page: fixture.descriptor.page }];
    writeJson(fixture.metaPath, meta);

    const result = inspectLocalBaselineEvidence({
      archiveRoot: fixture.archiveRoot,
      sourceId,
    });

    expect(result.reason).toBe("current_evidence_valid");
    expect(result.evidence_complete).toBe(true);
  });

  it("fails closed for malformed, mismatched, or structurally invalid current metadata", () => {
    const wrongSource = createWebFixture();
    const wrongMeta = readJson(wrongSource.metaPath);
    wrongMeta.source.id = otherSourceId;
    writeJson(wrongSource.metaPath, wrongMeta);
    expect(
      inspectLocalBaselineEvidence({ archiveRoot: wrongSource.archiveRoot, sourceId }).reason,
    ).toBe("current_meta_source_id_mismatch");

    const malformed = createWebFixture();
    writeFileSync(malformed.metaPath, "{", "utf8");
    expect(
      inspectLocalBaselineEvidence({ archiveRoot: malformed.archiveRoot, sourceId }).reason,
    ).toBe("current_meta_json_invalid");

    const invalidFiles = createWebFixture();
    const invalidMeta = readJson(invalidFiles.metaPath);
    invalidMeta.files = "../../outside";
    writeJson(invalidFiles.metaPath, invalidMeta);
    expect(
      inspectLocalBaselineEvidence({ archiveRoot: invalidFiles.archiveRoot, sourceId }).reason,
    ).toBe("current_meta_files_invalid");
  });

  it("atomically restores a validated previous capture and preserves source facts", async () => {
    const fixture = createWebFixture({ writeBaseline: false });
    const dangling = descriptorFor(fixture.archiveRoot, join(fixture.sourceDir, "captures", "new"));
    const baselinePath = join(fixture.sourceDir, "baseline.json");
    writeJson(baselinePath, baselineValue({
      descriptor: { ...dangling, ignored_path: "../../unsafe" },
      previousDescriptor: fixture.descriptor,
      facts: { award_relevance: "primary", cycle_relevance: "evergreen" },
    }));

    const result = await repairLocalBaselineEvidence({
      archiveRoot: fixture.archiveRoot,
      sourceId,
      apply: true,
      now: "2026-07-15T00:00:00.000Z",
    });
    const repaired = readJson(baselinePath);

    expect(result.status).toBe("repaired");
    expect(repaired.capture).toEqual(fixture.descriptor);
    expect(repaired.summary_metadata.baseline_facts.award_relevance).toBe("primary");
    expect(repaired.summary_metadata.local_evidence_repair.dangling_capture).not.toHaveProperty(
      "ignored_path",
    );
    expect(repaired.summary_metadata.previous_baseline_capture).toBeNull();
  });

  it("rejects a source junction that escapes the archive", () => {
    const archiveRoot = makeRoot();
    const outsideRoot = makeRoot();
    const outsideSource = join(outsideRoot, sourceId);
    mkdirSync(outsideSource, { recursive: true });
    const outsideFixture = createWebFixtureAt({ archiveRoot: outsideRoot, sourceDir: outsideSource });
    const archiveSources = join(archiveRoot, "sources");
    mkdirSync(archiveSources, { recursive: true });
    symlinkSync(outsideSource, join(archiveSources, sourceId), "junction");

    const result = inspectLocalBaselineEvidence({ archiveRoot, sourceId });

    expect(outsideFixture.baselinePath).toBeTruthy();
    expect(result.reason).toMatch(
      /^current_(?:source_symlink_outside_archive|path_outside_source)$/,
    );
    expect(result.evidence_complete).not.toBe(true);
  });

  it("rejects evidence redirected outside its capture directory", () => {
    const fixture = createWebFixture({ writeBaseline: false });
    const sibling = join(fixture.sourceDir, "captures", "sibling");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "text.txt"), "redirected", "utf8");
    const link = join(fixture.captureDir, "redirected");
    symlinkSync(sibling, link, "junction");
    const descriptor = {
      ...fixture.descriptor,
      text: archiveRelative(fixture.archiveRoot, join(link, "text.txt")),
    };
    writeJson(fixture.baselinePath, baselineValue({ descriptor }));

    const result = inspectLocalBaselineEvidence({ archiveRoot: fixture.archiveRoot, sourceId });

    expect(result.reason).toBe("current_capture_file_symlink_outside_capture_dir");
    expect(result.evidence_complete).not.toBe(true);
  });

  it("keeps the report marker on a nonzero completion audit and rejects invalid CLI values", () => {
    const archiveRoot = makeRoot();
    const idsPath = join(archiveRoot, "ids.json");
    const reportPath = join(archiveRoot, "report.json");
    writeJson(idsPath, [sourceId]);
    const cliPath = fileURLToPath(new URL("./repair-local-baseline-evidence.mjs", import.meta.url));

    const incomplete = spawnSync(process.execPath, [
      cliPath,
      `--archive-dir=${archiveRoot}`,
      `--source-ids-file=${idsPath}`,
      `--report=${reportPath}`,
      "--require-complete=true",
      "--limit=1",
    ], { encoding: "utf8" });
    expect(incomplete.status).toBe(1);
    expect(incomplete.stdout).toContain("LOCAL_BASELINE_EVIDENCE_REPORT");
    expect(existsSync(reportPath)).toBe(true);

    for (const invalidArg of ["--require-complete=maybe", "--limit=0"]) {
      const invalid = spawnSync(process.execPath, [
        cliPath,
        `--archive-dir=${archiveRoot}`,
        `--source-ids-file=${idsPath}`,
        invalidArg,
      ], { encoding: "utf8" });
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toMatch(/must be true or false|must be a positive integer/);
    }
  });
});

function createWebFixture({ writeBaseline = true } = {}) {
  const archiveRoot = makeRoot();
  const sourceDir = join(archiveRoot, "sources", sourceId);
  return createWebFixtureAt({ archiveRoot, sourceDir, writeBaseline });
}

function createWebFixtureAt({ archiveRoot, sourceDir, writeBaseline = true }) {
  const captureDir = join(sourceDir, "captures", "old");
  mkdirSync(captureDir, { recursive: true });
  const pagePath = join(captureDir, "page.jpg");
  const thumbPath = join(captureDir, "thumb.jpg");
  const textPath = join(captureDir, "text.txt");
  const metaPath = join(captureDir, "meta.json");
  writeFileSync(pagePath, "page", "utf8");
  writeFileSync(thumbPath, "thumb", "utf8");
  writeFileSync(textPath, "evidence", "utf8");
  const descriptor = descriptorFor(archiveRoot, captureDir);
  writeJson(metaPath, {
    kind: "webpage",
    source: { id: sourceId },
    captured_at: "2026-07-14T00:00:00.000Z",
    text_hash: "text-hash",
    image_hash: "image-hash",
    files: { ...descriptor, dir: undefined },
  });
  const baselinePath = join(sourceDir, "baseline.json");
  if (writeBaseline) writeJson(baselinePath, baselineValue({ descriptor }));
  return {
    archiveRoot,
    sourceDir,
    captureDir,
    descriptor,
    baselinePath,
    metaPath,
  };
}

function baselineValue({ descriptor, previousDescriptor = null, facts = null }) {
  return {
    version: 1,
    kind: "webpage",
    source: { id: sourceId, shared_award_id: "award-1" },
    captured_at: "2026-07-14T00:00:00.000Z",
    text_hash: "text-hash",
    image_hash: "image-hash",
    capture: descriptor,
    summary_metadata: {
      reason: "fixture",
      previous_baseline_capture: previousDescriptor,
      baseline_facts: facts,
      baseline_facts_metadata: facts ? { status: "succeeded" } : null,
    },
  };
}

function descriptorFor(archiveRoot, captureDir) {
  return {
    dir: archiveRelative(archiveRoot, captureDir),
    page: archiveRelative(archiveRoot, join(captureDir, "page.jpg")),
    thumb: archiveRelative(archiveRoot, join(captureDir, "thumb.jpg")),
    pdf: null,
    text: archiveRelative(archiveRoot, join(captureDir, "text.txt")),
    expansion_text: null,
    sections_text: null,
    sections_json: null,
    meta: archiveRelative(archiveRoot, join(captureDir, "meta.json")),
  };
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "awardping-baseline-evidence-"));
  createdRoots.push(root);
  return root;
}

function archiveRelative(archiveRoot, path) {
  return relative(archiveRoot, path).replaceAll("\\", "/");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
