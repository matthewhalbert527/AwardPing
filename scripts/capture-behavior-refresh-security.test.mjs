import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workerSource = readFileSync(
  new URL("./capture-visual-snapshots.mjs", import.meta.url),
  "utf8",
);

function functionSource(name, nextName) {
  const start = workerSource.indexOf(`function ${name}`);
  const end = workerSource.indexOf(`function ${nextName}`, start + 1);
  return workerSource.slice(start, end === -1 ? undefined : end);
}

function refreshPredicates() {
  expect(workerSource).toContain(
    "function captureBehaviorRefreshContentIsUnchanged",
  );
  const needsRefresh = functionSource(
    "needsCaptureBehaviorRefresh",
    "captureBehaviorRefreshContentIsUnchanged",
  );
  const contentIsUnchanged = functionSource(
    "captureBehaviorRefreshContentIsUnchanged",
    "orderSourcesForBaselineCoverage",
  );
  return new Function(
    "captureBehaviorVersion",
    `${needsRefresh}\n${contentIsUnchanged}\nreturn { needsCaptureBehaviorRefresh, captureBehaviorRefreshContentIsUnchanged };`,
  )(13);
}

describe("capture behavior refresh security boundary", () => {
  it("rejects a hostile content change instead of adopting it as an unchanged version refresh", () => {
    const predicates = refreshPredicates();
    const baseline = captureFixture({ capture_behavior_version: 11 });
    const hostileCapture = captureFixture({
      text_hash: hash("b"),
      main_content_hash: hash("c"),
    });

    expect(predicates.needsCaptureBehaviorRefresh(baseline, hostileCapture)).toBe(true);
    expect(
      predicates.captureBehaviorRefreshContentIsUnchanged(
        baseline,
        hostileCapture,
      ),
    ).toBe(false);
  });

  it("preserves a legitimate unchanged first capture after a behavior-version upgrade", () => {
    const predicates = refreshPredicates();
    const baseline = captureFixture({ capture_behavior_version: 11 });
    const unchangedCapture = captureFixture();

    expect(predicates.needsCaptureBehaviorRefresh(baseline, unchangedCapture)).toBe(true);
    expect(
      predicates.captureBehaviorRefreshContentIsUnchanged(
        baseline,
        unchangedCapture,
      ),
    ).toBe(true);
  });

  it("fails closed when old evidence lacks a required comparison hash", () => {
    const predicates = refreshPredicates();
    const baseline = captureFixture({
      capture_behavior_version: 11,
      expansion_hash: null,
    });

    expect(
      predicates.captureBehaviorRefreshContentIsUnchanged(
        baseline,
        captureFixture(),
      ),
    ).toBe(false);
  });

  it.each([
    "text_hash",
    "body_text_hash",
    "main_content_hash",
    "nav_header_footer_hash",
    "expansion_hash",
    "expandable_sections_hash",
    "image_hash",
  ])("routes a %s-only change through normal review", (field) => {
    const predicates = refreshPredicates();
    const baseline = captureFixture({ capture_behavior_version: 11 });
    const changedCapture = captureFixture({ [field]: hash("f") });

    expect(
      predicates.captureBehaviorRefreshContentIsUnchanged(
        baseline,
        changedCapture,
      ),
    ).toBe(false);
  });

  it("compares stable hashes before the authoritative refresh branch", () => {
    const processSource = functionSource(
      "processSourceUnlocked",
      "processLocalizationRepairSource",
    );
    const comparison = processSource.indexOf(
      "const hashComparison = compareStableCaptureHashes",
    );
    const refresh = processSource.indexOf("if (needsCaptureBehaviorRefresh");

    expect(comparison).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(comparison);
    expect(
      processSource.slice(refresh, processSource.indexOf(") {", refresh) + 3),
    ).toContain("captureBehaviorRefreshContentIsUnchanged");
  });
});

function captureFixture(overrides = {}) {
  return {
    kind: "webpage",
    capture_behavior_version: 13,
    text_hash: hash("1"),
    body_text_hash: hash("2"),
    main_content_hash: hash("3"),
    nav_header_footer_hash: hash("4"),
    expansion_hash: hash("5"),
    expandable_sections_hash: hash("6"),
    image_hash: hash("7"),
    ...overrides,
  };
}

function hash(character) {
  return character.repeat(64);
}
