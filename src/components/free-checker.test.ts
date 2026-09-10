import { load } from "cheerio";
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the component's actual form handler with controlled hook state.
// This is a component/markup test, not a substitute for browser interaction QA.
const hooks = vi.hoisted(() => ({ slot: 0, values: [] as unknown[] }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const slot = hooks.slot++;
      if (!(slot in hooks.values)) hooks.values[slot] = initial;
      return [hooks.values[slot], (value: unknown) => {
        hooks.values[slot] = typeof value === "function" ? value(hooks.values[slot]) : value;
      }];
    },
  };
});

import { FreeChecker } from "@/components/free-checker";

const goodResult = {
  ok: true,
  hash: "fixture-hash",
  sample: "Full readable text. Applicants must meet every condition. <not-a-tag>",
  contentType: "text/html",
  byteLength: 123456,
};

function render() {
  hooks.slot = 0;
  return load(renderToStaticMarkup(createElement(FreeChecker)));
}

function findElement(node: ReactNode, type: string): ReactElement<Record<string, unknown>> | undefined {
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (node.type === type) return node;
  for (const child of Children.toArray(node.props.children as ReactNode)) {
    const found = findElement(child, type);
    if (found) return found;
  }
  return undefined;
}

function boundForm() {
  hooks.slot = 0;
  const tree = FreeChecker();
  const form = findElement(tree, "form");
  if (!form) throw new Error("Checker form missing");
  return form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>;
}

beforeEach(() => { hooks.values = ["", null, false]; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("simple page checker", () => {
  it("keeps a visible required URL label and explains the limited check", () => {
    const $ = render();
    expect($('label[for="url-check"]').text()).toBe("Page URL");
    expect($('label[for="url-check"]').hasClass("sr-only")).toBe(false);
    expect($("#url-check").attr("type")).toBe("url");
    expect($("#url-check[required]")).toHaveLength(1);
    expect($("#url-check").attr("aria-describedby")).toBe("url-check-scope");
    expect($("#url-check-scope").text()).toContain("It does not verify that a page is official or start monitoring it.");
    expect($('button[type="submit"]').text()).toBe("Check URL");
    expect($("[role=status]")).toHaveLength(1);
    expect($("details")).toHaveLength(0);
  });

  it("shows readable content without technical metadata or an official-source claim", () => {
    hooks.values[1] = goodResult;
    const $ = render();
    expect($("[role=status]").text()).toBe("This page has readable content.");
    expect($("details")).toHaveLength(1);
    expect($("details[open]")).toHaveLength(0);
    expect($("summary").text()).toBe("View readable text");
    expect($("details p").text()).toBe(goodResult.sample);
    expect($("details p").attr("class")).not.toContain("line-clamp");
    expect($.html()).not.toContain("<not-a-tag>");
    for (const removed of ["text/html", "123,456", "bytes", "fixture-hash", "This exact award source"]) {
      expect($.text()).not.toContain(removed);
    }
  });

  it("does not claim readable content when the returned sample is empty", () => {
    hooks.values[1] = { ...goodResult, sample: "  " };
    const $ = render();
    expect($("[role=status]").text()).toBe("No readable text was returned for this page.");
    expect($("details")).toHaveLength(0);
  });

  it("keeps server errors visible and safely escaped", () => {
    hooks.values[1] = { ok: false, error: "That <page> could not be checked." };
    const $ = render();
    expect($("[role=status]").text()).toBe("That <page> could not be checked.");
    expect($("[role=status] page")).toHaveLength(0);
    expect($("details")).toHaveLength(0);
  });

  it("submits the entered URL to the existing endpoint and exposes pending state", async () => {
    hooks.values[0] = "https://example.org/public-page";
    let finish!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const preventDefault = vi.fn();
    const pending = boundForm()({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.org/public-page" }),
    });
    const $ = render();
    expect($("form").attr("aria-busy")).toBe("true");
    expect($('button[type="submit"][disabled]')).toHaveLength(1);
    expect($("[role=status]").text()).toBe("Checking the page…");
    finish({ json: async () => goodResult } as Response);
    await pending;
    expect(render()("[role=status]").text()).toBe("This page has readable content.");
    expect(render()("form").attr("aria-busy")).toBe("false");
  });

  it("keeps the network-failure message and enables retry after a failed request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await boundForm()({ preventDefault: () => undefined });
    const $ = render();
    expect($("[role=status]").text()).toBe("The check failed. Try another URL.");
    expect($('button[type="submit"][disabled]')).toHaveLength(0);
    expect($("form").attr("aria-busy")).toBe("false");
  });

  it("preserves a rejected URL response without showing a success preview", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({ ok: false, error: "Too many checks. Try again later." }),
    }));
    await boundForm()({ preventDefault: () => undefined });
    const $ = render();
    expect($("[role=status]").text()).toBe("Too many checks. Try again later.");
    expect($("details")).toHaveLength(0);
    expect($('button[type="submit"][disabled]')).toHaveLength(0);
  });
});
