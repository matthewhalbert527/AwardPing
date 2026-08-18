import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const pageSource = fs.readFileSync(
  path.join(projectRoot, "src/app/dashboard/admin/issues/page.tsx"),
  "utf8",
);

describe("admin regression audit Action Inbox wiring", () => {
  it("loads retry state in the existing parallel admin fetch", () => {
    expect(pageSource).toContain(
      'import { loadAdminRegressionAuditFailures } from "@/lib/admin-regression-audit-state";',
    );
    expect(pageSource).toMatch(
      /const \[[\s\S]*regressionAuditFailures[\s\S]*\] = await Promise\.all\(\[[\s\S]*loadAdminRegressionAuditFailures\(admin\)[\s\S]*\]\);/,
    );
  });

  it("keeps loader failures and per-award rows visible in the Action Inbox", () => {
    expect(pageSource).toContain("...regressionAuditFailures.loadErrors,");
    expect(pageSource).toContain(
      "regressionAuditFailures: regressionAuditFailures.failures,",
    );
  });
});
