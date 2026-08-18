import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliUrl = new URL("./reconcile-reviewed-stage1-selection.mjs", import.meta.url);
const cli = readFileSync(cliUrl, "utf8");
const loader = readFileSync(
  new URL("./lib/stage1-reviewed-reconciliation-loader.mjs", import.meta.url),
  "utf8",
);

describe("reviewed Stage 1 reconciliation CLI", () => {
  it("is preview-only by default and documents the exact confirmation boundary", () => {
    const output = execFileSync(process.execPath, [fileURLToPath(cliUrl), "--help"], {
      encoding: "utf8",
    });
    expect(output).toContain("Preview is the default");
    expect(output).toContain("--apply=true");
    expect(output).toContain("CONFIRM STAGE1 RECONCILIATION <sha256>");
    expect(output).toContain("never ranks or materializes candidates");
  });

  it("performs no remote mutation before confirmation and a second stable read", () => {
    const confirmationCheck = cli.indexOf(
      "cleanText(args.confirm) !== first.confirmation_phrase",
    );
    const secondRead = cli.indexOf("const fresh = await loadPlan");
    const firstMutation = cli.indexOf("const queue = await ensureQueue");
    expect(confirmationCheck).toBeGreaterThan(0);
    expect(secondRead).toBeGreaterThan(confirmationCheck);
    expect(firstMutation).toBeGreaterThan(secondRead);

    const previewBranch = cli.slice(
      cli.indexOf("if (!apply)"),
      confirmationCheck,
    );
    expect(previewBranch).not.toContain(".insert(");
    expect(previewBranch).not.toContain(".update(");
    expect(previewBranch).not.toContain("supabase.rpc(");
  });

  it("loads only explicit candidate IDs and exact human-review-root sources", () => {
    expect(loader).toContain('.in("id", scope.candidate_ids)');
    expect(loader).toContain("const sourceIds = scope.source_ids;");
    expect(loader).toContain('.in("id", sourceIds)');
    expect(loader).toContain('.in("shared_award_source_id", sourceIds)');
    expect(loader).not.toContain('.from("shared_award_fact_candidates")\n          .select("*")');
    expect(loader).not.toContain('.eq("admin_review_status", "open")');
  });

  it("uses deterministic queue identity, generation CAS, atomic RPC, and cleanup", () => {
    expect(cli).toContain("id: plan.queue_binding.id");
    expect(cli).toContain('.eq("generation", queue.generation)');
    expect(cli).toContain('"commit_reviewed_stage1_reconciliation_publication"');
    expect(cli).toContain('"finish_or_requeue_award_reconciliation_claim"');
    expect(cli).toContain("p_review_binding: plan.review_binding");
    expect(cli).toContain("p_generated_candidates: commit.generated_candidates");
  });
});
