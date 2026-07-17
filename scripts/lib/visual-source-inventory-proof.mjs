import { createHash } from "node:crypto";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function sourceIdInventoryHash(sourceIds) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalSourceIds(sourceIds)))
    .digest("hex");
}

export function buildVisualSourceInventoryProof({
  eligibleSources = [],
  loadedSources = [],
  shardCount,
  shardIndex,
  shardIndexForSource,
  capturedAt = new Date().toISOString(),
} = {}) {
  const normalizedShardCount = positiveInteger(shardCount);
  const normalizedShardIndex = nonNegativeInteger(shardIndex);
  if (!normalizedShardCount || normalizedShardIndex === null || normalizedShardIndex >= normalizedShardCount) {
    throw new Error("A valid source inventory shard count and index are required.");
  }
  if (typeof shardIndexForSource !== "function") {
    throw new Error("A deterministic source-to-shard function is required.");
  }

  const eligibleById = uniqueSourcesById(eligibleSources);
  const globalIds = [...eligibleById.keys()].sort();
  const partitionIds = Array.from({ length: normalizedShardCount }, () => []);
  for (const source of eligibleById.values()) {
    const assignedShard = nonNegativeInteger(shardIndexForSource(source));
    if (assignedShard === null || assignedShard >= normalizedShardCount) {
      throw new Error(`Source ${source.id} was assigned to an invalid inventory shard.`);
    }
    partitionIds[assignedShard].push(source.id);
  }

  const partitions = partitionIds.map((ids, index) => ({
    shard_index: index,
    source_count: canonicalSourceIds(ids).length,
    source_ids_sha256: sourceIdInventoryHash(ids),
  }));
  const loadedIds = canonicalSourceIds(
    (Array.isArray(loadedSources) ? loadedSources : []).map((source) => source?.id),
  );
  const expected = partitions[normalizedShardIndex];
  const loadedHash = sourceIdInventoryHash(loadedIds);
  const exactMatch = loadedIds.length === expected.source_count &&
    loadedHash === expected.source_ids_sha256;
  const globalCount = globalIds.length;
  const partitionCountSum = partitions.reduce((sum, partition) => sum + partition.source_count, 0);
  const proofComplete = globalCount > 0 && expected.source_count > 0 &&
    partitionCountSum === globalCount && exactMatch;

  return {
    schema_version: 1,
    algorithm: "sha256",
    eligibility_contract: "active_award_open_source_monitoring_policy_v1",
    captured_at: capturedAt,
    shard_count: normalizedShardCount,
    shard_index: normalizedShardIndex,
    global_source_count: globalCount,
    global_source_ids_sha256: sourceIdInventoryHash(globalIds),
    partitions,
    partition_source_count_sum: partitionCountSum,
    expected_shard_source_count: expected.source_count,
    expected_shard_source_ids_sha256: expected.source_ids_sha256,
    loaded_shard_source_count: loadedIds.length,
    loaded_shard_source_ids_sha256: loadedHash,
    shard_exact_match: exactMatch,
    proof_complete: proofComplete,
  };
}

export function validateVisualSourceInventoryProof(value, expected = {}) {
  const proof = objectValue(value);
  const shardCount = positiveInteger(proof.shard_count);
  const shardIndex = nonNegativeInteger(proof.shard_index);
  const globalCount = nonNegativeInteger(proof.global_source_count);
  const globalHash = cleanHash(proof.global_source_ids_sha256);
  const expectedShardCount = nonNegativeInteger(proof.expected_shard_source_count);
  const expectedShardHash = cleanHash(proof.expected_shard_source_ids_sha256);
  const loadedShardCount = nonNegativeInteger(proof.loaded_shard_source_count);
  const loadedShardHash = cleanHash(proof.loaded_shard_source_ids_sha256);
  const partitions = Array.isArray(proof.partitions)
    ? proof.partitions.map(normalizePartition)
    : [];

  const fail = (reason) => ({
    complete: false,
    reason,
    shardCount,
    shardIndex,
    globalCount,
    globalHash,
    expectedShardCount,
    expectedShardHash,
    loadedShardCount,
    loadedShardHash,
    partitions,
  });

  if (Number(proof.schema_version) !== 1 || cleanText(proof.algorithm).toLowerCase() !== "sha256") {
    return fail("missing_or_unsupported_inventory_proof");
  }
  if (!shardCount || shardIndex === null || shardIndex >= shardCount) {
    return fail("invalid_inventory_shard_identity");
  }
  if (positiveInteger(expected.shardCount) && shardCount !== positiveInteger(expected.shardCount)) {
    return fail("unexpected_inventory_shard_count");
  }
  if (nonNegativeInteger(expected.shardIndex) !== null &&
      shardIndex !== nonNegativeInteger(expected.shardIndex)) {
    return fail("unexpected_inventory_shard_index");
  }
  if (!globalCount || !globalHash) return fail("empty_or_invalid_global_inventory");
  if (partitions.length !== shardCount || partitions.some((partition) => !partition)) {
    return fail("invalid_inventory_partitions");
  }
  const sortedPartitions = [...partitions].sort((left, right) => left.shard_index - right.shard_index);
  if (sortedPartitions.some((partition, index) => partition.shard_index !== index)) {
    return fail("invalid_inventory_partition_indices");
  }
  const partitionCountSum = sortedPartitions.reduce((sum, partition) => sum + partition.source_count, 0);
  if (partitionCountSum !== globalCount || Number(proof.partition_source_count_sum) !== globalCount) {
    return fail("inventory_partition_count_mismatch");
  }
  const ownPartition = sortedPartitions[shardIndex];
  if (!ownPartition || !ownPartition.source_count ||
      expectedShardCount !== ownPartition.source_count ||
      expectedShardHash !== ownPartition.source_ids_sha256) {
    return fail("expected_inventory_partition_mismatch");
  }
  if (loadedShardCount !== expectedShardCount || loadedShardHash !== expectedShardHash ||
      proof.shard_exact_match !== true) {
    return fail("loaded_inventory_does_not_match_partition");
  }
  if (proof.proof_complete !== true) return fail("inventory_proof_not_complete");

  return {
    complete: true,
    reason: "verified",
    shardCount,
    shardIndex,
    globalCount,
    globalHash,
    expectedShardCount,
    expectedShardHash,
    loadedShardCount,
    loadedShardHash,
    partitions: sortedPartitions,
  };
}

export function validateVisualSourceInventoryCohort(values, expectedShardCount = 3) {
  const proofs = (Array.isArray(values) ? values : []).map((value, index) =>
    validateVisualSourceInventoryProof(value, {
      shardCount: expectedShardCount,
      shardIndex: objectValue(value).shard_index ?? index,
    }),
  );
  const fail = (reason) => ({
    complete: false,
    reason,
    globalCount: proofs[0]?.globalCount ?? null,
    globalHash: proofs[0]?.globalHash || null,
    partitionCountSum: proofs[0]?.partitions?.reduce(
      (sum, partition) => sum + (partition?.source_count || 0),
      0,
    ) ?? null,
  });

  if (!positiveInteger(expectedShardCount) || proofs.length !== expectedShardCount) {
    return fail("inventory_proof_shard_count_mismatch");
  }
  if (proofs.some((proof) => !proof.complete)) {
    return fail(proofs.find((proof) => !proof.complete)?.reason || "invalid_inventory_proof");
  }
  const byShard = new Map(proofs.map((proof) => [proof.shardIndex, proof]));
  if (byShard.size !== expectedShardCount ||
      Array.from({ length: expectedShardCount }, (_, index) => index).some((index) => !byShard.has(index))) {
    return fail("inventory_proof_duplicate_or_missing_shard");
  }
  const first = proofs[0];
  const canonicalPartitions = JSON.stringify(first.partitions);
  if (proofs.some((proof) =>
    proof.globalCount !== first.globalCount ||
    proof.globalHash !== first.globalHash ||
    JSON.stringify(proof.partitions) !== canonicalPartitions)) {
    return fail("inventory_proofs_disagree");
  }
  const partitionCountSum = first.partitions.reduce(
    (sum, partition) => sum + partition.source_count,
    0,
  );
  const loadedCountSum = proofs.reduce((sum, proof) => sum + proof.loadedShardCount, 0);
  if (partitionCountSum !== first.globalCount || loadedCountSum !== first.globalCount) {
    return fail("inventory_partition_sum_mismatch");
  }

  return {
    complete: true,
    reason: "verified",
    globalCount: first.globalCount,
    globalHash: first.globalHash,
    partitionCountSum,
  };
}

function normalizePartition(value) {
  const partition = objectValue(value);
  const shardIndex = nonNegativeInteger(partition.shard_index);
  const sourceCount = nonNegativeInteger(partition.source_count);
  const sourceHash = cleanHash(partition.source_ids_sha256);
  if (shardIndex === null || sourceCount === null || !sourceHash) return null;
  return {
    shard_index: shardIndex,
    source_count: sourceCount,
    source_ids_sha256: sourceHash,
  };
}

function uniqueSourcesById(sources) {
  const byId = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    const id = cleanText(source?.id);
    if (!id || byId.has(id)) continue;
    byId.set(id, { ...source, id });
  }
  return byId;
}

function canonicalSourceIds(sourceIds) {
  return [...new Set((Array.isArray(sourceIds) ? sourceIds : [])
    .map(cleanText)
    .filter(Boolean))].sort();
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanHash(value) {
  const hash = cleanText(value).toLowerCase();
  return SHA256_PATTERN.test(hash) ? hash : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}
