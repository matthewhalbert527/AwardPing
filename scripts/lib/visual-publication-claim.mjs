const publicationStatuses = new Set(["submitted", "processing", "succeeded"]);

export function visualReviewPublicationClaimDecision(
  candidate,
  {
    now = new Date().toISOString(),
    staleAfterMs = 30 * 60_000,
  } = {},
) {
  const metadata = objectValue(candidate?.worker_metadata);
  const eligible = publicationStatuses.has(candidate?.status) || (
    candidate?.status === "failed" &&
    cleanText(candidate?.rejection_reason) === "missing_batch_response"
  );
  if (!eligible) {
    return { action: "none", reason: "candidate_not_publication_eligible" };
  }

  const columnToken = cleanText(candidate?.publication_claim_token);
  const existingToken = cleanText(columnToken || metadata.publication_claim_token);
  if (!existingToken) return { action: "claim", reason: "publication_unclaimed" };

  // A first-class claim token without its matching timestamp is malformed and
  // recoverable immediately. Legacy metadata-only claims retain their prior
  // timestamp fallback during migration rollout.
  const claimedAt = timestampValue(columnToken
    ? candidate?.publication_claimed_at
    : metadata.publication_claimed_at || candidate?.updated_at);
  const nowValue = timestampValue(now);
  const stale = claimedAt === null || nowValue === null ||
    nowValue - claimedAt >= Math.max(1, Number(staleAfterMs) || 1);
  if (!stale) {
    return {
      action: "conflict",
      reason: "publication_claim_active",
      claim_token: existingToken,
      claimed_at: candidate?.publication_claimed_at || metadata.publication_claimed_at || candidate?.updated_at || null,
    };
  }
  return {
    action: "recover",
    reason: "publication_claim_stale",
    stale_claim_token: existingToken,
    stale_claimed_at: candidate?.publication_claimed_at || metadata.publication_claimed_at || candidate?.updated_at || null,
  };
}

export async function acquireVisualReviewPublicationClaim({
  candidate,
  claimToken,
  now = new Date().toISOString(),
  staleAfterMs = 30 * 60_000,
  metadata = {},
  candidatePatch = {},
  compareAndSet,
} = {}) {
  if (typeof compareAndSet !== "function") {
    throw new TypeError("compareAndSet is required to acquire a publication claim.");
  }
  const token = cleanText(claimToken);
  if (!token) throw new TypeError("claimToken is required to acquire a publication claim.");

  const decision = visualReviewPublicationClaimDecision(candidate, {
    now,
    staleAfterMs,
  });
  if (!new Set(["claim", "recover"]).has(decision.action)) {
    return { acquired: false, decision, candidate: null, claim_token: null };
  }

  const existingMetadata = objectValue(candidate?.worker_metadata);
  const claimedMetadata = {
    ...existingMetadata,
    ...objectValue(metadata),
    publication_claim_token: token,
    publication_claimed_at: now,
    publication_claimed_by: "process-visual-review-batch",
  };
  if (decision.action === "recover") {
    claimedMetadata.publication_claim_recovered_at = now;
    claimedMetadata.stale_publication_claim_token = decision.stale_claim_token;
    claimedMetadata.stale_publication_claimed_at = decision.stale_claimed_at;
  }

  const claimed = await compareAndSet({
    expected: {
      id: candidate?.id,
      status: candidate?.status,
      updated_at: candidate?.updated_at,
      publication_claim_token: candidate?.publication_claim_token || null,
    },
    patch: {
      ...objectValue(candidatePatch),
      status: "succeeded",
      publication_claim_token: token,
      publication_claimed_at: now,
      worker_metadata: claimedMetadata,
      updated_at: now,
    },
  });
  if (!claimed) {
    return {
      acquired: false,
      decision: { action: "conflict", reason: "publication_claim_compare_and_set_lost" },
      candidate: null,
      claim_token: null,
    };
  }
  return {
    acquired: true,
    recovered: decision.action === "recover",
    decision,
    candidate: claimed,
    claim_token: token,
  };
}

function timestampValue(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return String(value || "").trim();
}
