import { NextResponse } from "next/server";
import { loadPublishedVariationContext } from "@/lib/program-variation-review.server";
import { publicAwardVariantId } from "@/lib/public-award-links";
import { variationCursor, variationFilter } from "@/lib/program-variation-navigation";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });

/** Exposes only a selected, pinned public review and a bounded page of approved routes. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const allowed = new Set(["cohort", "scope", "cursor", "country", "course", "track"]);
  if ([...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length !== 1)) return reply({ error: "Choose one application route." }, 400);
  const cohort = params.get("cohort");
  if (!cohort || !/^[a-z0-9_-]{1,80}$/.test(cohort)) return reply({ error: "Choose a known award." }, 400);
  const scopeKey = params.has("scope") ? publicAwardVariantId(params.get("scope")) : undefined;
  const cursor = params.has("cursor") ? variationCursor(params.get("cursor")) : undefined;
  const country = variationFilter(params.get("country")), course = variationFilter(params.get("course")), track = variationFilter(params.get("track"));
  if (params.has("scope") && !scopeKey || params.has("cursor") && !cursor ||
      ["country", "course", "track"].some(key => params.has(key) && !variationFilter(params.get(key)))) return reply({ error: "Invalid route filters." }, 400);
  try {
    const context = await loadPublishedVariationContext(cohort, { scopeKey, cursor, country, course, track });
    return context ? reply(context) : reply({ error: "Approved application routes are not available for this award." }, 404);
  } catch { return reply({ error: "These application routes could not be confirmed. Reload the award page." }, 409); }
}
