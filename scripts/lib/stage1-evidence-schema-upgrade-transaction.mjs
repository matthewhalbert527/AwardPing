import { createHash } from "node:crypto";
import {
  assertLatestOnlyVisualSnapshotPointerReplacement,
  assertVisualSnapshotPointerIdentity,
  visualSnapshotPointerIdentity,
  visualSnapshotPointerMatchesIdentity,
} from "./visual-snapshot-latest-only-reconciliation.mjs";

export const STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_SCHEMA =
  "awardping.stage1.evidence-schema-upgrade-journal.v1";

export const stage1EvidenceSchemaUpgradePhases = Object.freeze([
  "prepared",
  "local_candidate_written",
  "pointer_cas_attempted",
  "pointer_candidate_committed",
  "completed",
  "recovery_required",
]);

const phaseTransitions = new Map([
  ["prepared", new Set(["local_candidate_written", "recovery_required"])],
  ["local_candidate_written", new Set(["pointer_cas_attempted", "recovery_required"])],
  ["pointer_cas_attempted", new Set(["pointer_candidate_committed", "recovery_required"])],
  ["pointer_candidate_committed", new Set(["completed", "recovery_required"])],
  // `completed` is normally archived immediately. If the process dies in the
  // narrow pre-archive window and authority has since regressed or become
  // unreadable, the recovery runner must be able to retain it fail-closed.
  ["completed", new Set(["recovery_required"])],
  // A high-level recovery runner may leave this fail-closed state only after
  // rereading the authoritative pointer and exact journaled baseline bytes.
  // The low-level journal deliberately cannot perform those I/O-backed guards.
  ["recovery_required", new Set(["pointer_candidate_committed", "completed"])],
]);

/**
 * Constructs a write-ahead journal. Both local baselines are retained as exact
 * base64 bytes, not reserialized JSON, and both pointer states are retained as
 * canonical identities. The journal itself is content sealed.
 */
export function buildStage1EvidenceSchemaUpgradeJournal({
  transactionId,
  sourceId,
  oldBaselineBytes,
  oldPointer,
  candidateBaselineBytes,
  candidatePointer,
  createdAt,
} = {}) {
  const id = requiredText(transactionId, "transactionId");
  const source = requiredText(sourceId, "sourceId");
  const timestamp = requiredTimestamp(createdAt, "createdAt");
  const oldPointerIdentity = visualSnapshotPointerIdentity(oldPointer);
  const candidatePointerIdentity = visualSnapshotPointerIdentity(candidatePointer);
  if (!candidatePointerIdentity.exists) {
    throw new Error("Stage 1 evidence upgrade requires a candidate pointer.");
  }
  assertCandidatePointer(candidatePointerIdentity);
  if (oldPointerIdentity.exists) {
    assertLatestOnlyVisualSnapshotPointerReplacement(
      oldPointerIdentity.projection,
      candidatePointerIdentity.projection,
    );
  } else {
    assertAbsentOldPointerCandidateHistory(candidatePointerIdentity.projection);
  }
  assertPointerSource(oldPointerIdentity, source, "old");
  assertPointerSource(candidatePointerIdentity, source, "candidate");

  const journal = {
    schema_version: STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_SCHEMA,
    transaction_id: id,
    source_id: source,
    created_at: timestamp,
    updated_at: timestamp,
    phase: "prepared",
    old_baseline: baselineByteEnvelope(oldBaselineBytes, { required: false }),
    old_pointer_identity: oldPointerIdentity,
    candidate_baseline: baselineByteEnvelope(candidateBaselineBytes, { required: true }),
    candidate_pointer_identity: candidatePointerIdentity,
    candidate_object_keys: cloneJson(
      candidatePointerIdentity.projection.latest_object_keys,
    ),
    phase_history: [{ phase: "prepared", at: timestamp, detail: null }],
  };
  return sealJournal(journal);
}

/**
 * Advances the durable phase with an expected-phase check. This is pure: the
 * caller is responsible for atomically persisting the returned journal before
 * performing the next side effect.
 */
export function advanceStage1EvidenceSchemaUpgradeJournal(journal, {
  expectedPhase,
  nextPhase,
  at,
  detail = null,
} = {}) {
  assertStage1EvidenceSchemaUpgradeJournal(journal);
  if (journal.phase !== expectedPhase) {
    throw new Error(
      `Stage 1 evidence upgrade phase changed: expected ${expectedPhase}, observed ${journal.phase}.`,
    );
  }
  if (!phaseTransitions.get(journal.phase)?.has(nextPhase)) {
    throw new Error(`Invalid Stage 1 evidence upgrade phase transition: ${journal.phase} -> ${nextPhase}.`);
  }
  const timestamp = requiredTimestamp(at, "phase timestamp");
  if (Date.parse(timestamp) < Date.parse(journal.updated_at)) {
    throw new Error("Stage 1 evidence upgrade phase timestamp moved backwards.");
  }
  if (detail !== null && !isPlainObject(detail)) {
    throw new TypeError("Stage 1 evidence upgrade phase detail must be an object or null.");
  }
  const next = cloneJson(journal);
  delete next.journal_sha256;
  next.phase = nextPhase;
  next.updated_at = timestamp;
  next.phase_history.push({
    phase: nextPhase,
    at: timestamp,
    detail: detail === null ? null : cloneJson(detail),
  });
  return sealJournal(next);
}

export function assertStage1EvidenceSchemaUpgradeJournal(journal) {
  const value = requirePlainObject(journal, "Stage 1 evidence upgrade journal");
  if (value.schema_version !== STAGE1_EVIDENCE_SCHEMA_UPGRADE_JOURNAL_SCHEMA) {
    throw new Error("Stage 1 evidence upgrade journal schema is invalid.");
  }
  requiredText(value.transaction_id, "journal transaction_id");
  const sourceId = requiredText(value.source_id, "journal source_id");
  requiredTimestamp(value.created_at, "journal created_at");
  requiredTimestamp(value.updated_at, "journal updated_at");
  if (!stage1EvidenceSchemaUpgradePhases.includes(value.phase)) {
    throw new Error("Stage 1 evidence upgrade journal phase is invalid.");
  }
  assertBaselineByteEnvelope(value.old_baseline, { required: false });
  assertBaselineByteEnvelope(value.candidate_baseline, { required: true });
  assertVisualSnapshotPointerIdentity(value.old_pointer_identity);
  assertVisualSnapshotPointerIdentity(value.candidate_pointer_identity);
  if (!value.candidate_pointer_identity.exists) {
    throw new Error("Stage 1 evidence upgrade candidate pointer identity is absent.");
  }
  assertCandidatePointer(value.candidate_pointer_identity);
  assertPointerSource(value.old_pointer_identity, sourceId, "old");
  assertPointerSource(value.candidate_pointer_identity, sourceId, "candidate");
  if (value.old_pointer_identity.exists) {
    assertLatestOnlyVisualSnapshotPointerReplacement(
      value.old_pointer_identity.projection,
      value.candidate_pointer_identity.projection,
    );
  } else {
    assertAbsentOldPointerCandidateHistory(value.candidate_pointer_identity.projection);
  }
  if (stableJson(value.candidate_object_keys) !== stableJson(
    value.candidate_pointer_identity.projection.latest_object_keys,
  )) {
    throw new Error("Stage 1 evidence upgrade candidate object keys are not pointer-bound.");
  }
  assertPhaseHistory(value);
  const expectedSeal = journalSha256(value);
  if (value.journal_sha256 !== expectedSeal) {
    throw new Error("Stage 1 evidence upgrade journal seal does not match its content.");
  }
  return value;
}

/**
 * Classifies a crash recovery snapshot using R2's pointer as authority. A
 * split local baseline is repaired from the exact journaled bytes. Only an
 * unreadable pointer or one matching neither journaled identity is ambiguous.
 */
export function classifyStage1EvidenceSchemaUpgradeRecovery({
  journal,
  currentBaselineBytes,
  currentPointer,
} = {}) {
  assertStage1EvidenceSchemaUpgradeJournal(journal);
  const baselineState = classifyBaselineState({
    oldEnvelope: journal.old_baseline,
    candidateEnvelope: journal.candidate_baseline,
    currentBaselineBytes,
  });
  const pointerState = classifyPointerState({
    oldIdentity: journal.old_pointer_identity,
    candidateIdentity: journal.candidate_pointer_identity,
    currentPointer,
  });
  let classification;
  let reason;
  let safeAction;
  let targetBaseline;
  if (pointerState === "candidate") {
    classification = "candidate";
    reason = "authoritative_pointer_matches_candidate_identity";
    targetBaseline = journal.candidate_baseline;
    safeAction = baselineState === "candidate" || baselineState === "both"
      ? "candidate_state_current_revalidate_and_complete"
      : "write_exact_journaled_candidate_baseline_then_revalidate";
  } else if (pointerState === "old") {
    classification = "old";
    reason = "authoritative_pointer_matches_old_identity";
    targetBaseline = journal.old_baseline;
    safeAction = baselineState === "old" || baselineState === "both"
      ? "old_state_current_retry_or_abandon_transaction"
      : journal.old_baseline.present
        ? "restore_exact_journaled_old_baseline"
        : "remove_local_baseline_to_restore_journaled_absence";
  } else {
    classification = "ambiguous";
    reason = pointerState === "unknown" || pointerState === "unreadable"
      ? "authoritative_pointer_unreadable"
      : "authoritative_pointer_matches_neither_journal_identity";
    safeAction = "quarantine_and_reconcile_exact_baseline_bytes_and_pointer_identity";
    targetBaseline = null;
  }

  return {
    classification,
    reason,
    safe_action: safeAction,
    journal_phase: journal.phase,
    baseline_state: baselineState,
    pointer_state: pointerState,
    baseline_repair_required: classification !== "ambiguous"
      && ![classification, "both"].includes(baselineState),
    target_baseline_present: targetBaseline?.present ?? null,
    target_baseline_sha256: targetBaseline?.sha256 ?? null,
    candidate_object_keys: cloneJson(journal.candidate_object_keys),
  };
}

export function stage1EvidenceSchemaUpgradeBaselineBytes(envelope) {
  assertBaselineByteEnvelope(envelope, { required: false });
  return envelope.present ? Buffer.from(envelope.bytes_base64, "base64") : null;
}

function classifyBaselineState({ oldEnvelope, candidateEnvelope, currentBaselineBytes }) {
  if (currentBaselineBytes === undefined) return "unknown";
  let current;
  try {
    current = baselineByteEnvelope(currentBaselineBytes, { required: false });
  } catch {
    return "unreadable";
  }
  const matchesOld = sameBaselineEnvelope(current, oldEnvelope);
  const matchesCandidate = sameBaselineEnvelope(current, candidateEnvelope);
  if (matchesOld && matchesCandidate) return "both";
  if (matchesCandidate) return "candidate";
  if (matchesOld) return "old";
  return "other";
}

function classifyPointerState({ oldIdentity, candidateIdentity, currentPointer }) {
  if (currentPointer === undefined) return "unknown";
  let matchesOld;
  let matchesCandidate;
  try {
    matchesOld = visualSnapshotPointerMatchesIdentity(currentPointer, oldIdentity);
    matchesCandidate = visualSnapshotPointerMatchesIdentity(currentPointer, candidateIdentity);
  } catch {
    return "unreadable";
  }
  if (matchesOld && matchesCandidate) return "both";
  if (matchesCandidate) return "candidate";
  if (matchesOld) return "old";
  return "other";
}

function baselineByteEnvelope(value, { required }) {
  if (value === null) {
    if (required) throw new Error("Candidate baseline bytes are required.");
    return {
      present: false,
      encoding: null,
      bytes_base64: null,
      byte_length: 0,
      sha256: null,
    };
  }
  if (value === undefined) {
    throw new Error(required
      ? "Candidate baseline bytes are required."
      : "Old baseline bytes must be supplied as bytes or null.");
  }
  const bytes = exactBytes(value);
  if (required && bytes.byteLength === 0) {
    throw new Error("Candidate baseline bytes must not be empty.");
  }
  return {
    present: true,
    encoding: "base64",
    bytes_base64: bytes.toString("base64"),
    byte_length: bytes.byteLength,
    sha256: sha256Bytes(bytes),
  };
}

function assertBaselineByteEnvelope(envelope, { required }) {
  const value = requirePlainObject(envelope, "baseline byte envelope");
  if (value.present === false) {
    if (
      required
      || value.encoding !== null
      || value.bytes_base64 !== null
      || value.byte_length !== 0
      || value.sha256 !== null
    ) {
      throw new Error("Absent baseline byte envelope is invalid.");
    }
    return value;
  }
  if (
    value.present !== true
    || value.encoding !== "base64"
    || typeof value.bytes_base64 !== "string"
    || !Number.isSafeInteger(value.byte_length)
    || value.byte_length < (required ? 1 : 0)
    || !/^[0-9a-f]{64}$/.test(String(value.sha256 || ""))
  ) {
    throw new Error("Baseline byte envelope is invalid.");
  }
  const decoded = Buffer.from(value.bytes_base64, "base64");
  if (
    decoded.toString("base64") !== value.bytes_base64
    || decoded.byteLength !== value.byte_length
    || sha256Bytes(decoded) !== value.sha256
  ) {
    throw new Error("Baseline byte envelope bytes do not match their bindings.");
  }
  return value;
}

function sameBaselineEnvelope(left, right) {
  return left.present === right.present
    && left.byte_length === right.byte_length
    && left.sha256 === right.sha256
    && left.bytes_base64 === right.bytes_base64;
}

function assertPointerSource(identity, sourceId, label) {
  if (
    identity.exists
    && identity.projection.shared_award_source_id !== sourceId
  ) {
    throw new Error(`Stage 1 evidence upgrade ${label} pointer source does not match sourceId.`);
  }
}

function assertCandidatePointer(identity) {
  const projection = identity.projection;
  if (
    !isPlainObject(projection.latest_object_keys)
    || !Object.keys(projection.latest_object_keys).length
    || Object.values(projection.latest_object_keys).some((key) => !requiredKey(key))
  ) {
    throw new Error("Stage 1 evidence upgrade candidate pointer object keys are invalid.");
  }
  if (!projection.latest_captured_at || !projection.updated_at) {
    throw new Error("Stage 1 evidence upgrade candidate pointer timestamps are incomplete.");
  }
}

function assertAbsentOldPointerCandidateHistory(candidate) {
  if (
    candidate.previous_captured_at !== null
    || Object.keys(isPlainObject(candidate.previous_object_keys)
      ? candidate.previous_object_keys
      : {}).length
    || Object.keys(isPlainObject(candidate.previous_hashes)
      ? candidate.previous_hashes
      : {}).length
    || Object.keys(isPlainObject(candidate.previous_metadata)
      ? candidate.previous_metadata
      : {}).length
  ) {
    throw new Error("Stage 1 evidence upgrade candidate invented previous history for an absent old pointer.");
  }
}

function requiredKey(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function assertPhaseHistory(journal) {
  if (!Array.isArray(journal.phase_history) || !journal.phase_history.length) {
    throw new Error("Stage 1 evidence upgrade phase history is missing.");
  }
  let prior = null;
  let priorAt = null;
  for (const [index, entry] of journal.phase_history.entries()) {
    if (!isPlainObject(entry) || !stage1EvidenceSchemaUpgradePhases.includes(entry.phase)) {
      throw new Error("Stage 1 evidence upgrade phase history entry is invalid.");
    }
    const at = requiredTimestamp(entry.at, "phase history timestamp");
    if (entry.detail !== null && !isPlainObject(entry.detail)) {
      throw new Error("Stage 1 evidence upgrade phase history detail is invalid.");
    }
    if (index === 0 && entry.phase !== "prepared") {
      throw new Error("Stage 1 evidence upgrade phase history must begin prepared.");
    }
    if (prior && !phaseTransitions.get(prior)?.has(entry.phase)) {
      throw new Error("Stage 1 evidence upgrade phase history transition is invalid.");
    }
    if (priorAt && Date.parse(at) < Date.parse(priorAt)) {
      throw new Error("Stage 1 evidence upgrade phase history moved backwards.");
    }
    prior = entry.phase;
    priorAt = at;
  }
  if (
    prior !== journal.phase
    || priorAt !== journal.updated_at
    || journal.phase_history[0].at !== journal.created_at
  ) {
    throw new Error("Stage 1 evidence upgrade phase history does not match the journal head.");
  }
}

function sealJournal(journal) {
  const value = cloneJson(journal);
  value.journal_sha256 = journalSha256(value);
  assertStage1EvidenceSchemaUpgradeJournal(value);
  return value;
}

function journalSha256(journal) {
  const value = cloneJson(journal);
  delete value.journal_sha256;
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function exactBytes(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("Baseline bytes must be a string, Buffer, Uint8Array, or null.");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredText(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function requiredTimestamp(value, label) {
  const text = requiredText(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid.`);
  return new Date(milliseconds).toISOString();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
