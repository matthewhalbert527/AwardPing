import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("retired paid award discovery route", () => {
  it("cannot invoke an unbudgeted third-party paid provider", async () => {
    const response = await POST();
    const payload = await response.json();

    expect(response.status).toBe(410);
    expect(payload).toEqual({
      error:
        "Automated award discovery is retired. Submit official pages through the operator source-intake workflow.",
    });
  });
});
