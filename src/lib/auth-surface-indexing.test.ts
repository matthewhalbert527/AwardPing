import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const sitemap = read("src/app/sitemap.ts");
const robots = read("src/app/robots.ts");

describe("private auth surface indexing", () => {
  it.each([
    ["login", "src/app/login/page.tsx"],
    ["forgot-password", "src/app/forgot-password/page.tsx"],
    ["reset-password", "src/app/reset-password/page.tsx"],
  ])("marks %s as noindex and nofollow", (_name, relativePath) => {
    const page = read(relativePath);

    expect(page).toMatch(/robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
  });

  it.each(["/login", "/forgot-password", "/reset-password"])(
    "blocks %s in robots and omits it from the sitemap",
    (route) => {
      expect(robots).toContain(`"${route}"`);
      expect(sitemap).not.toContain(`"${route}"`);
    },
  );
});

function read(relativePath: string) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}
