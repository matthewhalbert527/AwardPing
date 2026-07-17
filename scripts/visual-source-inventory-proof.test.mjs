import { describe, expect, it } from "vitest";
import {
  buildVisualSourceInventoryProof,
  sourceIdInventoryHash,
  validateVisualSourceInventoryCohort,
  validateVisualSourceInventoryProof,
} from "./lib/visual-source-inventory-proof.mjs";

const eligibleSources = [
  { id: "source-c", shard: 2 },
  { id: "source-a", shard: 0 },
  { id: "source-d", shard: 0 },
  { id: "source-b", shard: 1 },
];

describe("authoritative visual source inventory proof", () => {
  it("hashes a canonical sorted unique source-ID list", () => {
    expect(sourceIdInventoryHash(["source-b", "source-a", "source-b"]))
      .toBe(sourceIdInventoryHash(["source-a", "source-b"]));
  });

  it("binds the same global inventory and all partitions to an exact loaded shard", () => {
    const proof = proofForShard(0, [eligibleSources[2], eligibleSources[1]]);

    expect(proof).toMatchObject({
      global_source_count: 4,
      partition_source_count_sum: 4,
      expected_shard_source_count: 2,
      loaded_shard_source_count: 2,
      shard_exact_match: true,
      proof_complete: true,
    });
    expect(proof.partitions.map((partition) => partition.source_count)).toEqual([2, 1, 1]);
    expect(validateVisualSourceInventoryProof(proof, { shardCount: 3, shardIndex: 0 }))
      .toMatchObject({ complete: true, reason: "verified" });
  });

  it("fails a shard that loaded only a subset of its authoritative partition", () => {
    const proof = proofForShard(0, [{ id: "source-a", shard: 0 }]);

    expect(proof).toMatchObject({
      expected_shard_source_count: 2,
      loaded_shard_source_count: 1,
      shard_exact_match: false,
      proof_complete: false,
    });
    expect(validateVisualSourceInventoryProof(proof).reason)
      .toBe("loaded_inventory_does_not_match_partition");
  });

  it("requires three agreeing proofs whose partition sum equals the global count", () => {
    const proofs = [0, 1, 2].map((shardIndex) => proofForShard(
      shardIndex,
      eligibleSources.filter((source) => source.shard === shardIndex),
    ));
    expect(validateVisualSourceInventoryCohort(proofs, 3)).toMatchObject({
      complete: true,
      globalCount: 4,
      partitionCountSum: 4,
    });

    const mismatched = structuredClone(proofs);
    mismatched[2].global_source_ids_sha256 = "f".repeat(64);
    expect(validateVisualSourceInventoryCohort(mismatched, 3)).toMatchObject({
      complete: false,
      reason: "inventory_proofs_disagree",
    });
  });
});

function proofForShard(shardIndex, loadedSources) {
  return buildVisualSourceInventoryProof({
    eligibleSources,
    loadedSources,
    shardCount: 3,
    shardIndex,
    shardIndexForSource: (source) => source.shard,
    capturedAt: "2026-07-16T23:00:00.000Z",
  });
}
