import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * The former on-demand discovery endpoint called Tavily and OpenAI directly,
 * outside the two account-wide paid review lanes. Source intake remains an
 * operator workflow; any AI review it creates must enter new_page_review.
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Automated award discovery is retired. Submit official pages through the operator source-intake workflow.",
    },
    { status: 410 },
  );
}
