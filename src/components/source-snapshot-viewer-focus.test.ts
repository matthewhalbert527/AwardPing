import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./source-snapshot-viewer.tsx", import.meta.url),
  "utf8",
);

describe("source snapshot dialog keyboard contract", () => {
  it("moves focus into the modal, traps Tab, closes on Escape, and restores focus", () => {
    expect(source).toContain("closeButtonRef.current?.focus()");
    expect(source).toContain('event.key !== "Tab"');
    expect(source).toContain("dialogFocusableElements(dialog)");
    expect(source).toContain("last.focus()");
    expect(source).toContain("first.focus()");
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("focusReturnTarget?.focus()");
    expect(source).toContain("ref={triggerRef}");
    expect(source).toContain("ref={dialogRef}");
    expect(source).toContain("ref={closeButtonRef}");
  });
});
