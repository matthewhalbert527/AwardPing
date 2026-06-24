export function awardSlugFromName(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug || "award";
}

export function normalizeAwardSlug(value: string) {
  return decodeURIComponent(value || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

export function canonicalAwardPath(slug: string | null | undefined, name: string, id?: string) {
  const clean = normalizeAwardSlug(slug || "");
  if (clean) return `/${clean}`;

  const fallback = awardSlugFromName(name);
  return `/${id ? `${fallback}-${id.slice(0, 8)}` : fallback}`;
}
