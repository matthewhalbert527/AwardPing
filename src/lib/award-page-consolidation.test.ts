import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoots = ["src/app", "src/components", "src/lib"];
const sourceExtensions = new Set([".ts", ".tsx", ".css"]);

const forbiddenPatterns = [
  {
    pattern: /\baward-detail[-\w]*/i,
    label: "old award-detail page classes",
  },
  {
    pattern: /\bdashboard-sidebar[-\w]*/i,
    label: "old dashboard left-rail classes",
  },
  {
    pattern: /\/dashboard\/awards\//,
    label: "old dashboard award detail URLs",
  },
  {
    pattern: /["'`]\/dashboard(?:["'`?#]|\/(?:awards|updates)(?:["'`/?#]|$))/,
    label: "old dashboard workspace entry URLs",
  },
];

describe("award page design consolidation", () => {
  it("does not reintroduce the old dashboard award detail surface", () => {
    const violations = activeSourceFiles()
      .flatMap((file) => forbiddenMatches(file))
      .map((match) => `${match.file}: ${match.label}`);

    expect(violations).toEqual([]);
  });
});

function forbiddenMatches(file: string) {
  const text = readFileSync(file, "utf8");
  return forbiddenPatterns
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => ({ file: relative(process.cwd(), file), label }));
}

function activeSourceFiles() {
  return sourceRoots.flatMap((root) => collectSourceFiles(join(process.cwd(), root)));
}

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stats = statSync(path);

    if (stats.isDirectory()) return collectSourceFiles(path);
    if (!stats.isFile()) return [];
    if (name.includes(".test.") || name.includes(".spec.")) return [];
    if (!sourceExtensions.has(extensionFor(name))) return [];
    return [path];
  });
}

function extensionFor(name: string) {
  const lastDot = name.lastIndexOf(".");
  return lastDot === -1 ? "" : name.slice(lastDot);
}
