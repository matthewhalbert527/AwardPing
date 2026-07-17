import crypto from "node:crypto";
import { isIP } from "node:net";

const DEFAULT_HOURLY_LIMIT = 10;
const MAX_HOURLY_LIMIT = 10;
const MIN_HOURLY_LIMIT = 1;

export function resolveFreeCheckHourlyLimit(rawValue: string | undefined) {
  const value = rawValue?.trim();
  if (!value) return DEFAULT_HOURLY_LIMIT;

  // An explicitly malformed value becomes more restrictive instead of
  // disabling the limiter or accidentally expanding its public quota.
  if (!/^\d+$/.test(value)) return MIN_HOURLY_LIMIT;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return MIN_HOURLY_LIMIT;
  return Math.min(MAX_HOURLY_LIMIT, Math.max(MIN_HOURLY_LIMIT, parsed));
}

export function hashFreeCheckValue(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function resolveFreeCheckClientIp(
  headers: Headers,
  isVercelDeployment = process.env.VERCEL === "1",
) {
  if (!isVercelDeployment) return "unknown";

  // Vercel overwrites this header at its edge. Do not trust caller-controlled
  // forwarding fallbacks outside that deployment boundary.
  const platformForwarded = firstForwardedValue(
    headers.get("x-vercel-forwarded-for"),
  );
  return canonicalIp(platformForwarded) || "unknown";
}

function firstForwardedValue(value: string | null) {
  return value
    ?.split(",", 1)[0]
    ?.trim();
}

function canonicalIp(value: string | undefined) {
  if (!value) return null;
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;

  try {
    return new URL(`http://[${value}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}
