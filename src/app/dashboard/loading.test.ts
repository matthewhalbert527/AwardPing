import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import DashboardLoading from "./loading";
import AdminLoading from "./admin/loading";

describe("private workspace loading boundary", () => {
  it.each([DashboardLoading, AdminLoading])("announces pending work without exposing records or premature decisions", Component => {
    const $ = load(renderToStaticMarkup(createElement(Component)));
    expect($("[aria-busy='true']")).toHaveLength(1);
    expect($("[role='status']").text()).toBe("Loading your workspace…");
    expect($("a, button, input, select, time, blockquote")).toHaveLength(0);
    expect($.text()).not.toMatch(/No alerts|Approved|Dismissed|@/);
  });
});
