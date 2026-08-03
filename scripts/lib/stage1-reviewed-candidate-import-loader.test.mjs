import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  readStage1CandidateImportLocalEvidence,
  STAGE1_CANDIDATE_IMPORT_MAX_TEXT_BYTES,
} from "./stage1-reviewed-candidate-import-loader.mjs";
import { STAGE1_CANDIDATE_IMPORT_SCHEMA_VERSION } from "./stage1-reviewed-candidate-import.mjs";
import { STAGE1_POLICY_VERSION } from "./stage1-cohort-readiness.mjs";

const NOW = new Date("2026-07-17T19:00:00.000Z");
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const CAPTURED_AT = "2026-06-01T18:35:00.000Z";
const TEXT = "Exact immutable local text";
const TEXT_HASH = sha(TEXT);
const temporary = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Stage 1 candidate-import local evidence loader", () => {
  it("reads only the derived capture path and verifies semantic text separately from final newline bytes", () => {
    const root = archiveRoot(`${TEXT}\n`);
    const [evidence] = readStage1CandidateImportLocalEvidence({
      bundle: bundle(),
      archiveRoot: root,
      now: NOW,
    });
    expect(evidence).toMatchObject({
      source_id: SOURCE_ID,
      raw_bytes: Buffer.byteLength(`${TEXT}\n`, "utf8"),
      semantic_text: TEXT,
      semantic_text_sha256: TEXT_HASH,
      text_length: TEXT.length,
    });
  });

  it("fails closed on missing files or a non-capture text representation", () => {
    const empty = mkdtempSync(join(tmpdir(), "awardping-stage1-import-empty-"));
    temporary.push(empty);
    expect(() => readStage1CandidateImportLocalEvidence({
      bundle: bundle(),
      archiveRoot: empty,
      now: NOW,
    })).toThrow(/local text is missing/i);

    const noNewline = archiveRoot(TEXT);
    expect(() => readStage1CandidateImportLocalEvidence({
      bundle: bundle(),
      archiveRoot: noNewline,
      now: NOW,
    })).toThrow(/final newline/i);
  });

  it("rejects a capture path redirected through a symbolic link", () => {
    const root = mkdtempSync(join(tmpdir(), "awardping-stage1-import-link-"));
    temporary.push(root);
    const capture = new Date(CAPTURED_AT).toISOString().replace(/[:.]/g, "-");
    const sourceCaptures = join(root, "sources", SOURCE_ID, "captures");
    const elsewhere = join(root, "sources", "33333333-3333-4333-8333-333333333333", "captures", capture);
    mkdirSync(sourceCaptures, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "text.txt"), `${TEXT}\n`, "utf8");
    try {
      symlinkSync(elsewhere, join(sourceCaptures, capture), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) return;
      throw error;
    }
    expect(() => readStage1CandidateImportLocalEvidence({
      bundle: bundle(),
      archiveRoot: root,
      now: NOW,
    })).toThrow(/symbolic link/i);
  });

  it("checks the 20 MiB limit before reading immutable text", () => {
    const root = archiveRoot(`${TEXT}\n`);
    const capture = new Date(CAPTURED_AT).toISOString().replace(/[:.]/g, "-");
    truncateSync(
      join(root, "sources", SOURCE_ID, "captures", capture, "text.txt"),
      STAGE1_CANDIDATE_IMPORT_MAX_TEXT_BYTES + 1,
    );
    expect(() => readStage1CandidateImportLocalEvidence({
      bundle: bundle(),
      archiveRoot: root,
      now: NOW,
    })).toThrow(/20 MiB safety limit/i);
  });

  it("rejects traversal-like source IDs before deriving any filesystem path", () => {
    const root = archiveRoot(`${TEXT}\n`);
    const invalid = bundle();
    invalid.sources[0].source_id = "../outside";
    invalid.items[0].source_id = "../outside";
    expect(() => readStage1CandidateImportLocalEvidence({
      bundle: invalid,
      archiveRoot: root,
      now: NOW,
    })).toThrow(/source_id must be a valid UUID/i);
  });
});

function archiveRoot(content) {
  const root = mkdtempSync(join(tmpdir(), "awardping-stage1-import-"));
  temporary.push(root);
  const capture = new Date(CAPTURED_AT).toISOString().replace(/[:.]/g, "-");
  const directory = join(root, "sources", SOURCE_ID, "captures", capture);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "text.txt"), content, "utf8");
  return root;
}

function bundle() {
  const start = TEXT.indexOf("immutable");
  return {
    schema_version: STAGE1_CANDIDATE_IMPORT_SCHEMA_VERSION,
    policy_version: STAGE1_POLICY_VERSION,
    review: {
      reviewed_by: "operator@example.edu",
      reviewed_at: "2026-07-17T18:50:00.000Z",
      reason: "Exact local text review.",
      selection_method: "explicit_human_review",
      paid_api_calls: 0,
    },
    cohort: {
      cohort_key: "marshall",
      canonical_award: {
        id: "11111111-1111-4111-8111-111111111111",
        search_key: "marshall scholarship",
        name: "Marshall Scholarship",
        official_homepage: "https://www.marshallscholarship.org/",
      },
    },
    sources: [{
      source_id: SOURCE_ID,
      source_url: "https://www.marshallscholarship.org/",
      official_identity: {
        host: "www.marshallscholarship.org",
        classification: "canonical_program_host",
        evidence_url: "https://www.marshallscholarship.org/",
        reviewed_reason: "Exact canonical program homepage.",
      },
      source_updated_at: "2026-07-17T18:30:00.000Z",
      last_checked_at: "2026-07-17T18:30:00.000Z",
      snapshot_updated_at: "2026-07-17T18:35:00.000Z",
      captured_at: CAPTURED_AT,
      capture_text_sha256: TEXT_HASH,
      capture_text_object_key:
        `visual-snapshots/sources/${SOURCE_ID}/captures/${"a".repeat(32)}/text.txt`,
    }],
    items: [{
      item_key: "overview.immutable",
      source_id: SOURCE_ID,
      source_relevance: "primary",
      field_name: "overview",
      normalized_value: "immutable",
      evidence_quote: "immutable",
      evidence_location: `immutable_text_chars:${start}-${start + "immutable".length}`,
    }],
  };
}

function sha(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
