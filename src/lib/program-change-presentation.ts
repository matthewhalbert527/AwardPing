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

type ContextGroup = "schedule" | "eligibility" | "funding" | "instructions" | "documents" | "selection" | "destination" | "contacts";

const contextGroups: Record<string, ContextGroup> = {
  opening_date: "schedule", deadline: "schedule", cycle_status: "schedule", important_dates: "schedule",
  eligibility: "eligibility", citizenship: "eligibility", academic_levels: "eligibility", disciplines: "eligibility",
  award_amounts: "funding", stipend: "funding", tuition: "funding", travel_research_allowance: "funding", tenure: "funding",
  requirements: "instructions", application_materials: "instructions", how_to_apply: "instructions",
  documents: "documents", selection: "selection", application_url: "destination", contacts: "contacts",
};

const nextSteps: Record<ContextGroup, string> = {
  schedule: "Check the current application schedule for the relevant cycle and time zone before planning a submission.",
  eligibility: "Check the current eligibility criteria for your citizenship, academic level and field before applying.",
  funding: "Check the current funding terms and award duration before budgeting or accepting an offer.",
  instructions: "Check the current application instructions and required materials before submitting.",
  documents: "Check the current official application guidance and document location before preparing materials.",
  selection: "Check the current selection process and any interview or participation requirements.",
  destination: "Check the official application page for the current submission destination before applying.",
  contacts: "Check the official programme page for current contact details before relying on an address.",
};

const removalLimits: Record<ContextGroup, string> = {
  schedule: "Missing date or status text does not establish an extension, an opening, or that applications are closed.",
  eligibility: "Removed wording alone does not establish that an eligibility restriction was lifted.",
  funding: "A missing funding description does not establish the current amount, availability or duration.",
  instructions: "Removed wording alone does not establish that an application requirement was waived.",
  documents: "Removal from this page does not establish that a document was deleted or moved, or that application rules changed.",
  selection: "Removed wording alone does not establish that a selection step was cancelled.",
  destination: "A missing link does not establish that applications closed or that the submission destination moved.",
  contacts: "Removed contact text does not establish whether the contact changed or moved.",
};

function contextForChanges(changes: ProgramChange[]): string {
  const groups = [...new Set(changes.map((change) => contextGroups[change.field]))];
  const group = groups.length === 1 ? groups[0] : undefined;
  const hasRemoval = changes.some((change) => change.operation === "remove");
  const hasDocumentRemoval = changes.some((change) => change.field === "documents" && change.operation === "remove");
  const nextStep = group ? nextSteps[group]
    : "Review the affected application details and current guidance on the official page before acting.";
  const limit = hasDocumentRemoval ? removalLimits.documents
    : hasRemoval ? group ? removalLimits[group]
      : "Removed wording alone does not establish a waiver, an extended deadline, a closed application, or what applies elsewhere."
    : group === "documents"
      ? "A listed reference alone does not confirm that its document is accessible or that its contents changed."
      : "This comparison does not establish how other cycles, tracks or pages are affected.";
  return `${nextStep} ${limit}`;
}

/** Applicant guidance derived only from the accepted contract, without changing its evidence or claims. */
export function programChangeContext(value: unknown): string | null {
  const parsed = parseProgramTextChangeDetails(value);
  return parsed ? contextForChanges(parsed.program_changes as ProgramChange[]) : null;
}

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
    context: contextForChanges(changes),
    quotes: changes.map((change) => ({
      label: labels[change.field],
      previous: change.previous_quote?.text ?? null,
      current: change.current_quote?.text ?? null,
    })),
  };
}
