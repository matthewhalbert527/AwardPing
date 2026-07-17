import { describe, expect, it } from "vitest";
import { isSameOriginMutationRequest } from "@/lib/same-origin-mutation";

describe("same-origin mutation requests", () => {
  it("accepts only an exact same-origin Origin header", () => {
    expect(requestWithOrigin("https://awardping.test")).toBe(true);
    expect(requestWithOrigin("https://evil.test")).toBe(false);
    expect(requestWithOrigin("https://awardping.test/path")).toBe(false);
    expect(requestWithOrigin("null")).toBe(false);
    expect(requestWithOrigin(null)).toBe(false);
  });
});

function requestWithOrigin(origin: string | null) {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  return isSameOriginMutationRequest(
    new Request("https://awardping.test/api/mutate", {
      method: "POST",
      headers,
    }),
  );
}
