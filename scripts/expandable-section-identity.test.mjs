import { describe, expect, it } from "vitest";
import {
  canonicalizeExpandableSections,
  sectionPresenceEvidence,
} from "./lib/expandable-section-identity.mjs";

const question = "Should I apply after I take the LSAT even if it will be past the deadline?";
const answer = "Applications must include an LSAT or GRE score by the deadline.";

describe("expandable section identity", () => {
  it("uses the visible label instead of randomized accordion ids", () => {
    const first = canonicalizeExpandableSections([
      {
        section_key: "button_accordion-1f6l493hc3-6_tab",
        section_path: 'button#accordion-1f6l493hc3-6_tab[aria-controls="accordion-1f6l493hc3-6"]',
        label: question,
        text: answer,
      },
    ])[0];
    const second = canonicalizeExpandableSections([
      {
        section_key: "button_accordion-9ja6fh7nd1-6_tab",
        section_path: 'button#accordion-9ja6fh7nd1-6_tab[aria-controls="accordion-9ja6fh7nd1-6"]',
        label: question,
        text: answer,
      },
    ])[0];

    expect(first.section_key).toBe(second.section_key);
    expect(first.section_key).toContain("should-i-apply-after-i-take-the-lsat");
    expect(first.legacy_section_key).toBe("button_accordion-1f6l493hc3-6_tab");
  });

  it("rejects a removal when the current page still contains the section label", () => {
    const evidence = sectionPresenceEvidence({
      changeKind: "removed",
      section: { label: question, text: answer },
      previousPageText: `${question}\n${answer}`,
      currentPageText: `Frequently Asked Questions\n${question}`,
      previousMainContentHash: "previous-main",
      currentMainContentHash: "current-main",
      extractionEnabled: true,
    });

    expect(evidence).toMatchObject({
      confirmed: false,
      reason: "section_still_present_in_current_page_text",
      current_label_present: true,
    });
  });

  it("confirms a removal only when the label is absent and main content changed", () => {
    const evidence = sectionPresenceEvidence({
      changeKind: "removed",
      section: { label: question, text: answer },
      previousPageText: `${question}\n${answer}`,
      currentPageText: "Frequently Asked Questions\nA different question",
      previousMainContentHash: "previous-main",
      currentMainContentHash: "current-main",
      extractionEnabled: true,
    });

    expect(evidence).toMatchObject({
      confirmed: true,
      reason: "section_absent_from_current_page_text",
      current_label_present: false,
      main_content_hash_changed: true,
    });
  });

  it("does not infer an addition from a section that was already visible", () => {
    const evidence = sectionPresenceEvidence({
      changeKind: "added",
      section: { label: question, text: answer },
      previousPageText: `Frequently Asked Questions\n${question}`,
      currentPageText: `${question}\n${answer}`,
      previousMainContentHash: "previous-main",
      currentMainContentHash: "current-main",
      extractionEnabled: true,
    });

    expect(evidence).toMatchObject({
      confirmed: false,
      reason: "section_already_present_in_previous_page_text",
      previous_label_present: true,
    });
  });
});
