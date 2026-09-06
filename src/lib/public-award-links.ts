import { canonicalAwardPath } from "@/lib/award-slugs";

export const PUBLIC_AWARD_SOURCE_PARAM = "source";
export const PUBLIC_AWARD_CHANGE_PARAM = "change";

// Award-page query ids are database UUIDs. Anything else that can arrive on a
// request (an array from a repeated key, an empty or oversized value, a value
// with unexpected characters) is dropped here, so the workspace only ever
// compares well-formed ids and otherwise falls back to the award overview.
const PUBLIC_AWARD_QUERY_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type PublicAwardContext = {
  sourceId?: string | null;
  changeId?: string | null;
};

export type LiveUpdateLinkInput = {
  id: string;
  awardId: string;
  awardName: string;
  awardSlug: string | null;
  sourceId: string | null;
};

export function publicAwardQueryId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return PUBLIC_AWARD_QUERY_ID.test(trimmed) ? trimmed : undefined;
}

// Builds the same-origin award href used by the public feeds and by alias
// redirects: the award path followed by `source` and then `change`, encoded by
// URLSearchParams so the same ids always produce the same string.
export function publicAwardHref(path: string, context: PublicAwardContext = {}) {
  const params = new URLSearchParams();
  if (context.sourceId) params.set(PUBLIC_AWARD_SOURCE_PARAM, context.sourceId);
  if (context.changeId) params.set(PUBLIC_AWARD_CHANGE_PARAM, context.changeId);
  const query = params.toString();
  const safePath = sameOriginPath(path);
  return query ? `${safePath}?${query}` : safePath;
}

// A public update links to the canonical award page with the exact source and
// change it was detected on, so the award workspace opens that context.
export function liveUpdateAwardHref(update: LiveUpdateLinkInput) {
  return publicAwardHref(canonicalAwardPath(update.awardSlug, update.awardName, update.awardId), {
    sourceId: update.sourceId,
    changeId: update.id,
  });
}

// Every path segment is percent-encoded and empty segments are dropped, so a
// stored slug can never turn the link into a scheme-relative or
// backslash-authority URL or smuggle a query or fragment: the result is always
// an absolute-path reference on this origin. Canonical slugs are lowercase
// letters, digits and hyphens, for which the encoding is a no-op.
function sameOriginPath(path: string) {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  return `/${segments.join("/")}`;
}
