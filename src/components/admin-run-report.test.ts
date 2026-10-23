import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AdminRunReport } from "./admin-run-report";
import { buildAdminRunReportFeed } from "@/lib/admin-run-report";

describe("truthful text-monitoring dashboard boundary", () => {
  it.each([false, true])("does not relabel any legacy report as text readiness (compact: %s)", compact => {
    const legacy = buildAdminRunReportFeed([], new Date("2026-10-23T12:00:00Z"));
    const html = renderToStaticMarkup(createElement(AdminRunReport, { compact, initialFeed: legacy }));
    expect(html).toContain("New text-monitoring coverage is not yet reported in this dashboard");
    expect(html).toContain("6-SHOW-VISUAL-SNAPSHOT-STATUS.bat");
    expect(html).toContain("First coverage is not a program update");
    expect(html).toContain("No completion count is inferred here");
    expect(html).not.toMatch(/3\/25|6 PM scan report|pages captured|shards complete|<a|<button|<iframe|<img/);
  });

  it("keeps the notice static and labels the ops source/run counters as historical", () => {
    const component = readFileSync(new URL("./admin-run-report.tsx", import.meta.url), "utf8");
    const ops = readFileSync(new URL("../app/dashboard/ops/page.tsx", import.meta.url), "utf8");
    expect(component).not.toMatch(/useEffect|fetch\(|useState/);
    expect(ops).toContain("<AdminRunReport compact />");
    expect(ops).toContain('label="Last recorded legacy run"');
    expect(ops).toContain('label="7-day recorded events"');
    expect(ops).toContain("historical and do not establish new text-monitoring coverage");
  });
});
