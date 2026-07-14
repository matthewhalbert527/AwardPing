import { NextResponse } from "next/server";

const crossSiteAdminRequestError = {
  ok: false,
  error: "Admin mutation requests require a valid same-origin Origin header.",
} as const;

export function validateSameOriginAdminMutation(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return invalidOriginResponse();

  try {
    const expectedOrigin = new URL(request.url).origin;
    const suppliedOrigin = new URL(origin).origin;
    if (suppliedOrigin !== origin || suppliedOrigin !== expectedOrigin) {
      return invalidOriginResponse();
    }
  } catch {
    return invalidOriginResponse();
  }

  return null;
}

function invalidOriginResponse() {
  return NextResponse.json(crossSiteAdminRequestError, { status: 403 });
}
