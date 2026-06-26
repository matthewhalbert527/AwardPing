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

export function dashboardAwardPath(slug: string | null | undefined, name: string, id: string) {
  const clean = normalizeAwardSlug(slug || "");
  if (clean) return `/dashboard/awards/${clean}`;

  return `/dashboard/awards/${id}`;
}

export type AwardSourceSlugInput = {
  id: string;
  title?: string | null;
  display_title?: string | null;
  page_type?: string | null;
  url?: string | null;
};

export function awardSourceSlugBase(source: AwardSourceSlugInput) {
  const pageType = normalizeAwardSlug(source.page_type || "");
  const titleSlug = conciseSourceSlug(source.display_title || source.title || "");
  const urlSlug = source.url ? sourceSlugFromUrl(source.url) : "";

  if (pageType === "homepage") return "overview";
  if (titleSlug && !isGenericSourceSlug(titleSlug)) return titleSlug;
  if (urlSlug && !isGenericSourceSlug(urlSlug)) return urlSlug;
  if (pageType === "deadline") return "deadlines";
  if (pageType === "pdf") return "guide";
  if (["application", "eligibility", "requirements", "faq"].includes(pageType)) return pageType;
  return "source";
}

export function withUniqueAwardSourceSlugs<T extends AwardSourceSlugInput>(sources: T[]) {
  const counts = new Map<string, number>();

  return sources.map((source) => {
    const base = awardSourceSlugBase(source);
    const count = (counts.get(base) || 0) + 1;
    counts.set(base, count);
    return {
      ...source,
      sourceSlug: count === 1 ? base : `${base}-${count}`,
    };
  });
}

function conciseSourceSlug(value: string) {
  const clean = value
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b(pdf|document|download)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const slug = awardSlugFromName(clean)
    .replace(/^(official|source|page|award|scholarship|fellowship)-+/i, "")
    .replace(/-+(official|source|page)$/i, "");

  return slug.split("-").filter(Boolean).slice(0, 7).join("-");
}

function sourceSlugFromUrl(value: string) {
  try {
    const url = new URL(value);
    const meaningful = url.pathname
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !/^(page|pages|resources?|view|programs?|awards?|scholarships?|fellowships?|grants?)$/i.test(part))
      .at(-1);
    return conciseSourceSlug(decodeURIComponent(meaningful || ""));
  } catch {
    return "";
  }
}

function isGenericSourceSlug(value: string) {
  return /^(home|homepage|overview|source|source-page|official|official-page|page|other|other-source|learn-more|read-more|details?|apply|applications?)$/i.test(
    value,
  );
}
