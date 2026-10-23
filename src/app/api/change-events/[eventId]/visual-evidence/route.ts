import { NextResponse } from "next/server";

/** Retired: updates use program details and official source links. */
export async function GET() {
  return NextResponse.json(
    { error: "Visual evidence has been retired. Read the update and its official source." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
