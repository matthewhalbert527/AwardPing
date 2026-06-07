import { describe, expect, it } from "vitest";
import { insertionIndexForAddedText } from "./highlight-insertion";

describe("insertionIndexForAddedText", () => {
  it("places an insertion marker between matching before and after anchors", () => {
    const previous =
      "Application instructions begin with a stable eligibility paragraph for applicants. " +
      "The deadline section follows with the same wording as before.";
    const added =
      "New recommendation guidance now asks applicants to register recommenders before submitting. ";
    const next =
      "Application instructions begin with a stable eligibility paragraph for applicants. " +
      added +
      "The deadline section follows with the same wording as before.";
    const index = insertionIndexForAddedText(previous, next, next.indexOf(added), added.length);

    expect(index).toBe(previous.indexOf(" The deadline section"));
  });

  it("does not place a marker when the old context is reordered instead of a matching gap", () => {
    const added =
      "Architecture Art Biodiversity Communication Conflict Economics Education Ethnicity Gender " +
      "History Linguistics Media Migration Music Politics Religion Transportation The contents of " +
      "these curricular materials were developed under a grant from the U.S.";
    const previous =
      "The curricular materials below have been created from various ARISC programs through the " +
      "years that have been made possible by funding from the U.S. Department of Education, " +
      "including presentations at the ARISC Caucasus Connections Conference in April 2014, Junior " +
      "Research Fellowship awardees, and participants of the Teaching the South Caucasus Workshops. " +
      "Search for: General Topics: S. Department of Education, including presentations at the ARISC " +
      "Caucasus Connections Conference in April 2014, Junior Research Fellowship awardees, and " +
      "participants of the Teaching the South Caucasus Workshops. Search for: General Topics: " +
      added +
      " Department of Education. However, those contents do not necessarily represent the policy.";
    const next =
      "The curricular materials below have been created from various ARISC programs through the " +
      "years that have been made possible by funding from the U.S. Department of Education, " +
      "including presentations at the ARISC Caucasus Connections Conference in April 2014, Junior " +
      "Research Fellowship awardees, and participants of the Teaching the South Caucasus Workshops. " +
      "Search for: General Topics: " +
      added +
      " Department of Education. However, those contents do not necessarily represent the policy.";

    expect(insertionIndexForAddedText(previous, next, next.indexOf(added), added.length)).toBeNull();
  });
});
