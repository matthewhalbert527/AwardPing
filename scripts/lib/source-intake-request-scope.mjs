// Exact operator selection only. This module grants no intake/review authority
// and performs no network or database I/O.
export const SOURCE_INTAKE_SCOPE_LIMIT = 200;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sourceIntakeRequestScope(argv = []) {
  const ids = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--request-ids" || arg.startsWith("--request-ids=")) {
      throw new Error("Use repeated --request-id flags for exact source-intake selection.");
    }
    if (arg !== "--request-id" && !arg.startsWith("--request-id=")) continue;
    const value = arg === "--request-id" ? argv[++index] : arg.slice("--request-id=".length);
    if (typeof value !== "string" || !uuidPattern.test(value.trim())) {
      throw new Error("Each --request-id must name one exact UUID; repeat the flag for multiple requests.");
    }
    ids.push(value.trim().toLowerCase());
    if (ids.length > SOURCE_INTAKE_SCOPE_LIMIT) throw new Error("Too many explicit source-intake request IDs.");
  }
  return Object.freeze([...new Set(ids)].sort());
}

export function scopeSourceIntakeQuery(query, requestIds) {
  return requestIds.length ? query.in("id", requestIds) : query;
}

// Only this table is narrowed. Other tables and RPCs retain their existing
// clients and policies. Batch-wide *read-only* membership proof uses the
// original client explicitly, never this adapter.
export function scopedSourceIntakeClient(client, requestIds) {
  if (!requestIds.length) return client;
  const scoped = Object.create(client);
  scoped.rpc = (...args) => client.rpc(...args);
  scoped.from = (name) => {
    const table = client.from(name);
    if (name !== "source_page_requests") return table;
    return {
      select: (...args) => scopeSourceIntakeQuery(table.select(...args), requestIds),
      update: (...args) => scopeSourceIntakeQuery(table.update(...args), requestIds),
    };
  };
  return scoped;
}

export function sourceIntakeMembershipDecision(requestIds, { rows, count, reservation = false } = {}) {
  if (!requestIds.length) return { allowed: true, reason: "global_run" };
  if (!Array.isArray(rows) || !Number.isSafeInteger(count) || count < 0 || count !== rows.length) {
    return { allowed: false, reason: "scope_membership_incomplete" };
  }
  const allowed = new Set(requestIds);
  const memberIds = [];
  for (const row of rows) {
    if (!reservation) {
      if (!uuidPattern.test(row?.id || "")) return { allowed: false, reason: "scope_member_identity_invalid" };
      memberIds.push(row.id.toLowerCase());
      continue;
    }
    const ids = row?.metadata?.request_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length !== row.request_count ||
        ids.some((id) => typeof id !== "string" || !uuidPattern.test(id)) ||
        new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) {
      return { allowed: false, reason: "scope_reservation_membership_unproven" };
    }
    memberIds.push(...ids.map((id) => id.toLowerCase()));
  }
  if (memberIds.some((id) => !allowed.has(id))) {
    return { allowed: false, reason: "scope_shared_work_outside_selection" };
  }
  return { allowed: true, reason: "scope_membership_verified" };
}

export function sourceIntakeScopeBindings(rows, batchName = null) {
  const requestBindings = new Map();
  const reservationBindings = new Map();
  const add = (map, field, value, required = false) => {
    if (typeof value !== "string" || !value.trim()) return;
    const key = `${field}:${value.trim()}`;
    const prior = map.get(key);
    map.set(key, { field, value: value.trim(), required: required || prior?.required === true });
  };
  const batch = (value) => {
    add(requestBindings, "gemini_batch_name", value);
    add(requestBindings, "possible_external_batch_name", value);
    add(reservationBindings, "provider_batch_name", value);
  };
  batch(batchName);
  for (const row of rows || []) {
    const review = row?.ai_review || {};
    batch(review.gemini_batch_name);
    batch(review.possible_external_batch_name);
    for (const value of [review.gemini_spend_reservation_id, review.active_work_reservation_id]) {
      add(requestBindings, "gemini_spend_reservation_id", value);
      add(requestBindings, "active_work_reservation_id", value);
      add(reservationBindings, "id", value, true);
    }
    add(requestBindings, "gemini_spend_reservation_key", review.gemini_spend_reservation_key);
    add(reservationBindings, "reservation_key", review.gemini_spend_reservation_key, true);
    for (const value of [review.submission_claim_token, review.gemini_spend_attempt_token]) {
      add(requestBindings, "submission_claim_token", value);
      add(requestBindings, "gemini_spend_attempt_token", value);
      // A claim can exist before its reservation is created.
      add(reservationBindings, "attempt_token", value);
    }
  }
  return { requests: [...requestBindings.values()], reservations: [...reservationBindings.values()] };
}
