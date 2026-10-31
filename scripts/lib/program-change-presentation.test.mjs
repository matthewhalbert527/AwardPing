import { describe, expect, it } from "vitest";
import { PROGRAM_DETAIL_FIELDS } from "./program-change-contract.mjs";
import { programChangePresentation, programChangeContext } from "./program-change-presentation.mjs";

const quote = text => ({ block_id: "source-1", start_utf16: 0, end_utf16: text.length, text });
const details = (field, operation = "replace", summary = "The stated application detail changed.") => ({
  schema: "awardping.program-change.v1", event_kind: "program_details_changed", summary,
  program_changes: [{ field, operation, summary,
    previous_quote: operation === "add" ? null : quote("Previous source-supported wording"),
    current_quote: operation === "remove" ? null : quote("Current source-supported wording") }],
});

describe("clear source-bound alert descriptions", () => {
  it("explains the saved DAAD portal removal without claiming the application has closed", () => {
    const value = details("application_url", "remove", "Removed the application portal URL.");
    value.program_changes[0].previous_quote = quote("https://funding.meindaad.de/sites/personalfunding#PBFApplication-Start?originCountry=402&fundingProgramInstance=57860210&targetGroup=5B&targetCountry=995");
    const original = JSON.stringify(value);
    const result = programChangePresentation(value);
    expect(result.text).toBe("The official page no longer lists the previously listed application link.");
    expect(result.context).toContain("current portal access");
    expect(result.context).toContain("does not establish that applications are closed");
    expect(result.text).not.toMatch(/closed|deleted|unavailable|deadline|October|Apply here/);
    expect(result.quotes[0].previous).toBe(value.program_changes[0].previous_quote.text);
    expect(result.changes[0].summary).toBe(result.text);
    expect(JSON.stringify(value)).toBe(original);
  });

  it.each(PROGRAM_DETAIL_FIELDS.flatMap(field => ["add", "remove", "replace"].map(operation => [field, operation])))(
    "provides a change description and relevant applicant guidance for %s / %s", (field, operation) => {
      const input = details(field, operation), before = structuredClone(input);
      const result = programChangePresentation(input);
      expect(result.label).toBeTruthy();
      expect(result.text.length).toBeGreaterThan(10);
      expect(result.context.length).toBeGreaterThan(20);
      expect(result.context.length).toBeLessThanOrEqual(600);
      expect(result.changes).toHaveLength(1);
      expect(result.quotes[0]).toEqual({ label: result.label,
        previous: input.program_changes[0].previous_quote?.text ?? null,
        current: input.program_changes[0].current_quote?.text ?? null });
      if (operation === "remove") expect(result.text).toContain("page");
      expect(input).toEqual(before);
    });

  it.each([
    ["deadline", "The U.S. applicant deadline moved from October 1 to October 15, 2027 at 5 p.m. ET.", "revised deadline"],
    ["stipend", "The monthly stipend increased from EUR 900 to EUR 992 for the 2027–2028 cycle.", "budget"],
    ["eligibility", "Applicants now need three years of relevant experience rather than two.", "qualify"],
    ["application_materials", "Applicants must now provide two references rather than three.", "preparing"],
  ])("preserves the supported specifics and gives the relevant next step for %s", (field, summary, action) => {
    const result = programChangePresentation(details(field, "replace", summary));
    expect(result.text).toBe(summary);
    expect(result.context).toContain(action);
    expect(result.context).not.toMatch(/guaranteed|automatically|all applicants|extended|waived/);
  });

  it("keeps supported qualifications in the complete accepted summary", () => {
    const value = details("deadline", "replace", "The deadline moved to April 15.");
    value.summary += " The deadline remains 5 p.m. Eastern Time and applies only to institutional nominees.";
    expect(programChangePresentation(value).text).toBe(value.summary);
  });

  it("preserves an aggregate cycle and applicant-group qualification while clarifying a link", () => {
    const value = details("application_url", "remove", "Removed the application portal URL.");
    const deadline = details("deadline", "replace", "The deadline moved to April 15.").program_changes[0];
    value.program_changes.push(deadline);
    value.summary = `For U.S. applicants in the 2027 cycle: ${value.summary} ${deadline.summary}`;
    const result = programChangePresentation(value);
    expect(result.text).toContain("For U.S. applicants in the 2027 cycle:");
    expect(result.text).toContain("The deadline moved to April 15.");
    expect(result.text).not.toContain("Removed the application portal URL.");
    expect(result.paragraphs).toEqual([result.text]);
  });

  it("does not mistake a changed URL spelling for a proven different destination", () => {
    const value = details("application_url", "replace", "The application destination moved.");
    value.program_changes[0].previous_quote = quote("/apply");
    value.program_changes[0].current_quote = quote("https://example.edu/apply");
    expect(programChangePresentation(value).text).toBe("The application link listed on the official page changed.");
    expect(programChangePresentation(value).text).not.toContain("different destination");
  });

  it("never turns a removed requirement, funding statement or document listing into a waiver or deletion", () => {
    for (const [field, summary] of [["requirements", "Applicants no longer need references."],
      ["stipend", "The stipend ended."], ["documents", "The programme deleted its guide."]]) {
      const result = programChangePresentation(details(field, "remove", summary));
      expect(result.text).toMatch(/^The official page no longer (?:lists|states)/);
      expect(result.text).not.toBe(summary);
      expect(result.context).toContain("does not establish");
    }
  });

  it("identifies a removed short rule rather than hiding the actual change behind a field name", () => {
    const value = details("application_materials", "remove", "References are no longer required.");
    value.program_changes[0].previous_quote = quote("Applicants must provide three references.");
    const result = programChangePresentation(value);
    expect(result.text).toBe("The official page no longer states: “Applicants must provide three references.”");
    expect(result.context).toContain("does not establish that a requirement was waived");
    expect(result.text).not.toContain("no longer required");
  });

  it("keeps verified page-reference titles without claiming their contents changed", () => {
    const summary = "The page no longer lists “Information for Candidates - USA”.";
    const result = programChangePresentation(details("documents", "remove", summary));
    expect(result.text).toBe(summary);
    expect(result.context).toContain("does not establish that a document was deleted or moved");
  });

  it("keeps all individual details while bounding large mixed summaries and applicant guidance", () => {
    const value = details("application_url", "remove", "Removed application link.");
    value.program_changes.push(...PROGRAM_DETAIL_FIELDS.filter(field => field !== "application_url").map(field =>
      details(field, "replace", `${field}: ` + "A qualified source-supported change. ".repeat(12)).program_changes[0]));
    value.summary = "A mixed set of application details changed.";
    const result = programChangePresentation(value);
    expect(result.changes).toHaveLength(PROGRAM_DETAIL_FIELDS.length);
    expect(result.paragraphs).toHaveLength(1);
    expect(result.quotes).toHaveLength(PROGRAM_DETAIL_FIELDS.length);
    expect(result.text.length).toBeLessThanOrEqual(1200);
    expect(result.context.length).toBeLessThanOrEqual(600);
    expect(result.text).toContain("official page changed");
  });

  it("does not invent modern evidence or applicant implications for legacy or malformed records", () => {
    for (const value of [null, undefined, {}, { reader_summary: "The portal closed." },
      { ...details("deadline"), program_changes: [] }]) {
      expect(programChangePresentation(value)).toBeNull();
      expect(programChangeContext(value)).toBeNull();
    }
    const value = details("deadline");
    value.program_changes[0].current_quote.end_utf16++;
    expect(programChangePresentation(value)).toBeNull();
  });
});
