import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const cliPath = resolve(root, "scripts/generate-stage1-manifest-draft.mjs");
const loaderPath = resolve(root, "scripts/lib/stage1-manifest-draft-loader.mjs");

describe("Stage 1 manifest-draft CLI boundary", () => {
  it("documents the explicit mapping contract and has no apply mode", () => {
    const output = execFileSync(process.execPath, [cliPath, "--help"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(output.toLowerCase()).toContain("stage 1 human-review root");
    expect(output).toContain("never accepts ranked candidates");
    expect(output).toContain("no --apply mode");
    expect(output).toContain("stage1-manifest-draft-mapping.schema.json");
  });

  it("uses SELECT-only scoped reads and contains no paid, capture, R2-read, ranking, or mutation surface", () => {
    const cli = readFileSync(cliPath, "utf8");
    const loader = readFileSync(loaderPath, "utf8");
    const executable = `${cli}\n${loader}`;
    expect(loader).toContain("stage1ManifestDraftScope(mapping, now)");
    expect(loader).toContain('.select("');
    expect(loader).toContain('.rpc("get_stage1_human_review_root"');
    expect([...executable.matchAll(/\.rpc\s*\(/g)]).toHaveLength(1);
    expect(executable).not.toMatch(/\.(?:insert|upsert|delete)\s*\(/);
    const updateCalls = [...executable.matchAll(/\.update\s*\(/g)];
    expect(updateCalls).toHaveLength(1);
    expect(executable.slice(updateCalls[0].index - 80, updateCalls[0].index + 100))
      .toContain("createHash");
    expect(executable).not.toMatch(/Gemini|generateContent|batchRequests|PutObject|GetObject|captureIntakePage|rankOfficialSourceCandidates/);
  });

  it("rejects unknown and apply flags before credentials or remote access", () => {
    for (const option of ["--apply", "--unknown-option"]) {
      const result = spawnSync(process.execPath, [cliPath, option], {
        cwd: root,
        encoding: "utf8",
        env: {},
        timeout: 20_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown option");
      expect(result.stderr).toContain("Remote mutations: 0");
      expect(result.stderr).not.toContain("SUPABASE");
    }
  }, 20_000);

  it("ships parseable schema and an eight-role, no-auto-accept example", () => {
    const schema = JSON.parse(readFileSync(
      resolve(root, "docs/stage1-manifest-draft-mapping.schema.json"),
      "utf8",
    ));
    const example = JSON.parse(readFileSync(
      resolve(root, "docs/stage1-manifest-draft-mapping.example.json"),
      "utf8",
    ));
    expect(schema.$schema).toContain("2020-12");
    expect(example.review).toMatchObject({
      selection_method: "explicit_human_review",
      auto_accept_ranked_candidates: false,
      materialize_candidates: false,
    });
    expect(example.schema_version).toBe("awardping.stage1.human-review-root.v1");
    expect(example.cohorts[0]).not.toHaveProperty("reconciliation");
    expect(example.cohorts[0]).not.toHaveProperty("page_audit");
    expect(example.cohorts[0].field_choices[0]).toMatchObject({
      composition_method: "direct_exact",
      candidate_evidence: [expect.objectContaining({
        capture_text_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        capture_text_object_key: expect.stringMatching(/\/text[.]txt$/),
      })],
    });
    expect(example.cohorts[0].roles).toHaveLength(8);
    for (const role of example.cohorts[0].roles) {
      for (const source of role.sources) {
        expect(source.snapshot.metadata).toMatchObject({
          page_bytes: expect.any(Number),
          text_object_bytes: expect.any(Number),
          text_length: expect.any(Number),
        });
      }
    }
    expect(schema.$defs.captureMetadata.required).toEqual([
      "text_object_bytes",
      "text_length",
    ]);
    expect(example.cohorts[0].roles.at(-1)).toMatchObject({
      source_role: "current_documents",
      manifest_status: "not_published",
      fact_candidate_ids: [],
    });
  });
});
