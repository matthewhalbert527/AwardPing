export type SourceHealthKind =
  | "ok"
  | "pending"
  | "blocked"
  | "missing"
  | "rate_limited"
  | "certificate"
  | "dns"
  | "network"
  | "no_text"
  | "timeout"
  | "server_error"
  | "failed";

export type SourceHealthTone = "ok" | "pending" | "warning" | "danger";

export type SourceHealthInput = {
  lastError?: string | null;
  lastCheckedAt?: string | null;
  last_error?: string | null;
  last_checked_at?: string | null;
  status?: string | null;
};

export type SourceHealth = {
  kind: SourceHealthKind;
  label: string;
  detail: string;
  tone: SourceHealthTone;
  needsReview: boolean;
};

export type SourceHealthSummary = {
  total: number;
  checked: number;
  pending: number;
  review: number;
  blocked: number;
  missing: number;
  rateLimited: number;
  certificate: number;
  noReadableText: number;
  timedOut: number;
  dnsFailed: number;
};

export function classifySourceHealth(source: SourceHealthInput): SourceHealth {
  const error = String(source.lastError || source.last_error || "").trim();
  const lastCheckedAt = source.lastCheckedAt || source.last_checked_at;
  const normalized = error.toLowerCase();

  if (!error && source.status === "error") {
    return {
      kind: "failed",
      label: "Check failed",
      detail: "The latest check failed. Open the source if this keeps happening.",
      tone: "warning",
      needsReview: true,
    };
  }

  if (!error) {
    if (lastCheckedAt) {
      return {
        kind: "ok",
        label: "Checked",
        detail: "The latest check completed.",
        tone: "ok",
        needsReview: false,
      };
    }

    return {
      kind: "pending",
      label: "Pending first check",
      detail: "The crawler has not checked this source yet.",
      tone: "pending",
      needsReview: false,
    };
  }

  const httpStatus = httpStatusFromError(error);

  if (
    normalized.includes("cert_has_expired") ||
    normalized.includes("certificate has expired") ||
    normalized.includes("ssl certificate") ||
    normalized.includes("certificate")
  ) {
    return {
      kind: "certificate",
      label: "Certificate issue",
      detail: "The site has a TLS/SSL certificate problem for crawler requests. A browser may still open it, but automated checks cannot safely trust it.",
      tone: "warning",
      needsReview: true,
    };
  }

  if (httpStatus === 404 || httpStatus === 410) {
    return {
      kind: "missing",
      label: "Missing page",
      detail: "This source returned a missing-page response and likely needs a replacement URL.",
      tone: "danger",
      needsReview: true,
    };
  }

  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 405) {
    return {
      kind: "blocked",
      label: "Blocked by site",
      detail: "The site denied the crawler request. Keep it if the URL is official, but it may need a browser-based check.",
      tone: "warning",
      needsReview: true,
    };
  }

  if (httpStatus === 429) {
    return {
      kind: "rate_limited",
      label: "Rate limited",
      detail: "The site asked AwardPing to slow down. A later check may succeed.",
      tone: "warning",
      needsReview: true,
    };
  }

  if (httpStatus && httpStatus >= 500) {
    return {
      kind: "server_error",
      label: "Site error",
      detail: "The source site returned a server error during the last check.",
      tone: "warning",
      needsReview: true,
    };
  }

  if (
    normalized.includes("enotfound") ||
    normalized.includes("getaddrinfo") ||
    normalized.includes("dns")
  ) {
    return {
      kind: "dns",
      label: "Domain failed",
      detail: "The domain did not resolve during the last check and may be retired or mistyped.",
      tone: "danger",
      needsReview: true,
    };
  }

  if (normalized === "fetch failed" || normalized.includes("fetch failed")) {
    return {
      kind: "network",
      label: "Crawler fetch failed",
      detail: "The crawler could not fetch this page even though it may open in a browser. Common causes are bot protection, TLS/certificate issues, or a transient network failure.",
      tone: "warning",
      needsReview: true,
    };
  }

  if (normalized.includes("no readable text")) {
    return {
      kind: "no_text",
      label: "No readable text",
      detail: "The page loaded, but the crawler could not extract readable award text.",
      tone: "warning",
      needsReview: true,
    };
  }

  if (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("abort")
  ) {
    return {
      kind: "timeout",
      label: "Timed out",
      detail: "The source took too long to respond. The next scheduled run can try again.",
      tone: "warning",
      needsReview: true,
    };
  }

  return {
    kind: "failed",
    label: "Check failed",
    detail: "The latest check failed. Keep the source if it is official, or replace it if the failure persists.",
    tone: "warning",
    needsReview: true,
  };
}

export function summarizeSourceHealth(sources: SourceHealthInput[]): SourceHealthSummary {
  const summary: SourceHealthSummary = {
    total: sources.length,
    checked: 0,
    pending: 0,
    review: 0,
    blocked: 0,
    missing: 0,
    rateLimited: 0,
    certificate: 0,
    noReadableText: 0,
    timedOut: 0,
    dnsFailed: 0,
  };

  for (const source of sources) {
    const health = classifySourceHealth(source);
    if (health.kind === "ok") summary.checked += 1;
    if (health.kind === "pending") summary.pending += 1;
    if (health.needsReview) summary.review += 1;
    if (health.kind === "blocked") summary.blocked += 1;
    if (health.kind === "missing") summary.missing += 1;
    if (health.kind === "rate_limited") summary.rateLimited += 1;
    if (health.kind === "certificate") summary.certificate += 1;
    if (health.kind === "no_text") summary.noReadableText += 1;
    if (health.kind === "timeout") summary.timedOut += 1;
    if (health.kind === "dns") summary.dnsFailed += 1;
  }

  return summary;
}

export function sourceHealthSummaryText(summary: SourceHealthSummary) {
  const parts = [
    `${summary.total} source page${summary.total === 1 ? "" : "s"}`,
  ];

  if (summary.review > 0) {
    parts.push(`${summary.review} need review`);
  } else if (summary.checked > 0) {
    parts.push(`${summary.checked} checked`);
  } else if (summary.pending > 0) {
    parts.push("pending first check");
  }

  return parts.join(" · ");
}

function httpStatusFromError(value: string) {
  const match = value.match(/\b(?:HTTP|status)\s*:?[\s-]*(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}
