import { parseProgramTextChangeDetails } from "../../scripts/lib/program-change-contract.mjs";

export type ProgramQuote = {
  block_id: string;
  start_utf16: number;
  end_utf16: number;
  text: string;
};

type ProgramChange = {
  field: string;
  operation: "add" | "remove" | "replace";
  summary: string;
  previous_quote: ProgramQuote | null;
  current_quote: ProgramQuote | null;
};

const labels: Record<string, string> = {
  opening_date: "Application opening", deadline: "Deadline", cycle_status: "Application cycle",
  important_dates: "Important dates", eligibility: "Eligibility", citizenship: "Citizenship",
  academic_levels: "Academic level", disciplines: "Discipline", award_amounts: "Award funding",
  stipend: "Stipend", tuition: "Tuition", travel_research_allowance: "Travel and research funding",
  tenure: "Award duration", requirements: "Requirements", application_materials: "Application materials",
  how_to_apply: "How to apply", documents: "Program documents", selection: "Selection",
  application_url: "Application link", contacts: "Program contacts",
};

/** Presentation of an accepted program-change contract; never infers quotes from legacy prose. */
export function programChangePresentation(value: unknown) {
  const parsed = parseProgramTextChangeDetails(value);
  if (!parsed) return null;
  const changes = parsed.program_changes as ProgramChange[];
  const fields = [...new Set(changes.map((change) => change.field))];
  const label = fields.length === 1 ? labels[fields[0]] : "Program details";
  return {
    label,
    title: fields.length === 1 ? `${label} changed` : "Program details changed",
    text: parsed.summary as string,
    paragraphs: [parsed.summary as string],
    quotes: changes.map((change) => ({
      label: labels[change.field],
      previous: change.previous_quote?.text ?? null,
      current: change.current_quote?.text ?? null,
    })),
  };
}
