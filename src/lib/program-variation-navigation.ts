import { publicAwardHref, publicAwardVariantId, type PublicAwardContext } from "@/lib/public-award-links";

export type VariationAttributes = {
  country: string | null;
  course: string | null;
  track: string | null;
  applicant_group: string | null;
};
export type VariationOption = { scope_key: string; label: string; attributes: VariationAttributes };
export type VariationFilters = { country?: string; course?: string; track?: string };

export function variationFilter(value: unknown) {
  if (typeof value !== "string" || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value.trim() || undefined;
}

export function variationCursor(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value) ? value : undefined;
}

/** Preserve update/source navigation when a visitor selects an application route. */
export function variationHref(path: string, scope: unknown, context: PublicAwardContext = {}) {
  const scopeKey = publicAwardVariantId(scope);
  return scopeKey ? publicAwardHref(path, { ...context, variantId: scopeKey }) : null;
}

/** Do not synthesize combinations absent from the provider's approved inventory. */
export function matchingVariationOptions(options: VariationOption[], filters: VariationFilters) {
  const entries = Object.entries(filters).filter((entry): entry is [keyof VariationFilters, string] => Boolean(entry[1]));
  return options.filter(option => entries.every(([key, value]) => option.attributes[key] === value));
}

export function variationOptionLabel(option: VariationOption) {
  const attributes = [...new Set(Object.values(option.attributes).filter((value): value is string => Boolean(value)))];
  return attributes.length ? `${option.label} — ${attributes.join(" · ")}` : option.label;
}

export function variationRequestUrl(cohort: string, filters: VariationFilters = {}, cursor?: string | null) {
  if (!/^[a-z0-9_-]{1,80}$/.test(cohort)) throw new Error("Choose a known award.");
  const params = new URLSearchParams({ cohort });
  for (const key of ["country", "course", "track"] as const) {
    const value = variationFilter(filters[key]);
    if (value) params.set(key, value);
  }
  if (cursor) {
    const safeCursor = variationCursor(cursor);
    if (!safeCursor) throw new Error("Invalid variation page.");
    params.set("cursor", safeCursor);
  }
  return `/api/public/program-variations?${params}`;
}
