import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// create-gpt-review-bundle.mjs is an operational entrypoint that exports data
// and deletes its previous bundle directory, so this suite reads its source
// text and evaluates only the extracted pure sanitizer and path guard. No
// directory is created, read, or removed here.

const source = readFileSync(
  new URL("./create-gpt-review-bundle.mjs", import.meta.url),
  "utf8",
).replace(/\r\n?/g, "\n");

function functionText(name) {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}\n", start);
  expect(end, `end of function ${name}`).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

const cleanPathSegment = new Function(`${functionText("cleanPathSegment")}\nreturn cleanPathSegment;`)();
const assertBundleDirBelowOutputRoot = new Function(
  "relative",
  "isAbsolute",
  "sep",
  `${functionText("assertBundleDirBelowOutputRoot")}\nreturn assertBundleDirBelowOutputRoot;`,
)(relative, isAbsolute, sep);

// Path math only: this directory is never created.
const outputRoot = resolve(tmpdir(), "awardping-review-bundles-synthetic");

function guardedRelativePath(rawName) {
  const bundleName = cleanPathSegment(rawName);
  const bundleDir = resolve(outputRoot, bundleName);
  return assertBundleDirBelowOutputRoot(outputRoot, bundleDir, bundleName);
}

describe("GPT review bundle directory safety", () => {
  it("accepts a default-style name as a strict descendant of the output root", () => {
    const name = "awardping-full-review-2026-09-04T00-00-00-000Z";
    expect(guardedRelativePath(name)).toBe(name);
  });

  it("accepts a descendant whose name merely starts with dots", () => {
    expect(guardedRelativePath("..safe")).toBe("..safe");
  });

  it.each([
    ["..", "the repository root"],
    [".", "the whole output directory"],
    ["!!!", "the whole output directory after sanitizing to an empty name"],
  ])("rejects %s, which would target %s", (rawName) => {
    expect(() => guardedRelativePath(rawName)).toThrow(/strict descendant/);
  });

  it("validates the bundle directory before deriving zipPath and before either rmSync", () => {
    const bundleDirIndex = source.indexOf("const bundleDir = resolve(outputRoot, bundleName);");
    const guardIndex = source.indexOf("assertBundleDirBelowOutputRoot(outputRoot, bundleDir, bundleName);");
    const zipPathIndex = source.indexOf("const zipPath = `${bundleDir}.zip`;");
    const removeDirIndex = source.indexOf("rmSync(bundleDir, { recursive: true, force: true });");
    const removeZipIndex = source.indexOf("rmSync(zipPath, { force: true });");
    for (const [label, index] of Object.entries({ bundleDirIndex, guardIndex, zipPathIndex, removeDirIndex, removeZipIndex })) {
      expect(index, label).toBeGreaterThanOrEqual(0);
    }
    expect(guardIndex).toBeGreaterThan(bundleDirIndex);
    expect(guardIndex).toBeLessThan(zipPathIndex);
    expect(guardIndex).toBeLessThan(removeDirIndex);
    expect(guardIndex).toBeLessThan(removeZipIndex);
    expect(source.split("assertBundleDirBelowOutputRoot(outputRoot, bundleDir, bundleName);")).toHaveLength(2);
  });
});
