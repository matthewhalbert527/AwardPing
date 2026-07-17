export type VisualSourceInventoryPartition = {
  shard_index: number;
  source_count: number;
  source_ids_sha256: string;
};

export type VisualSourceInventoryProof = {
  schema_version: 1;
  algorithm: "sha256";
  eligibility_contract: string;
  captured_at: string;
  shard_count: number;
  shard_index: number;
  global_source_count: number;
  global_source_ids_sha256: string;
  partitions: VisualSourceInventoryPartition[];
  partition_source_count_sum: number;
  expected_shard_source_count: number;
  expected_shard_source_ids_sha256: string;
  loaded_shard_source_count: number;
  loaded_shard_source_ids_sha256: string;
  shard_exact_match: boolean;
  proof_complete: boolean;
};

export type VisualSourceInventoryProofValidation = {
  complete: boolean;
  reason: string;
  shardCount: number | null;
  shardIndex: number | null;
  globalCount: number | null;
  globalHash: string | null;
  expectedShardCount: number | null;
  expectedShardHash: string | null;
  loadedShardCount: number | null;
  loadedShardHash: string | null;
  partitions: Array<VisualSourceInventoryPartition | null>;
};

export type VisualSourceInventoryCohortValidation = {
  complete: boolean;
  reason: string;
  globalCount: number | null;
  globalHash: string | null;
  partitionCountSum: number | null;
};

export declare function sourceIdInventoryHash(sourceIds: unknown[]): string;
export declare function buildVisualSourceInventoryProof(options: {
  eligibleSources: Array<{ id?: unknown }>;
  loadedSources: Array<{ id?: unknown }>;
  shardCount: number;
  shardIndex: number;
  shardIndexForSource: (source: { id: string; [key: string]: unknown }) => number;
  capturedAt?: string;
}): VisualSourceInventoryProof;
export declare function validateVisualSourceInventoryProof(
  value: unknown,
  expected?: { shardCount?: number; shardIndex?: number },
): VisualSourceInventoryProofValidation;
export declare function validateVisualSourceInventoryCohort(
  values: unknown[],
  expectedShardCount?: number,
): VisualSourceInventoryCohortValidation;
