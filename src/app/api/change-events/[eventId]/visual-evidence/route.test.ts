import { describe, expect, it, vi } from "vitest";

const forbidden = vi.hoisted(() => ({
  database: vi.fn(() => { throw new Error("Retired routes must not query the database."); }),
  sign: vi.fn(() => { throw new Error("Retired routes must not sign assets."); }),
  read: vi.fn(() => { throw new Error("Retired routes must not read saved assets."); }),
  auth: vi.fn(() => { throw new Error("Retired routes need no authentication lookup."); }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: forbidden.database }));
vi.mock("@/lib/r2", () => ({ createR2SignedReadUrl: forbidden.sign, getR2TextObject: forbidden.read }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: forbidden.auth }));

import { GET as eventEvidence } from "./route";
import { GET as sourceSnapshot } from "../../../source-snapshots/[sourceId]/route";

describe("retired visual evidence endpoints", () => {
  it.each([["event evidence", eventEvidence], ["source snapshot", sourceSnapshot]])(
    "%s returns 410 without inspecting identities, users, saved artifacts or signatures",
    async (_label, handler) => {
      const response = await handler();
      expect(response.status).toBe(410);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "Visual evidence has been retired. Read the update and its official source." });
      for (const call of Object.values(forbidden)) expect(call).not.toHaveBeenCalled();
    },
  );
});
