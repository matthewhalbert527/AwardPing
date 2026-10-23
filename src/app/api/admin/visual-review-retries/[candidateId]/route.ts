import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Retired text-only-release boundary: no authentication, asset or queue I/O. */
export async function POST() {
  return NextResponse.json(
    { ok: false, error: "Historical image-review retries are retired. Existing review records are preserved; no new review was queued." },
    { status: 410, headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
