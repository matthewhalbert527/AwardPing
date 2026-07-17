export function isSameOriginMutationRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    const supplied = new URL(origin);
    const expected = new URL(request.url);
    return supplied.origin === origin && supplied.origin === expected.origin;
  } catch {
    return false;
  }
}
