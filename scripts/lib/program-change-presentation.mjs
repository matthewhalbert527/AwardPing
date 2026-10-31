import { parseProgramTextChangeDetails } from "./program-change-contract.mjs";

export const PROGRAM_CHANGE_LABELS = Object.freeze({
  opening_date: "Application opening", deadline: "Deadline", cycle_status: "Application cycle",
  important_dates: "Important dates", eligibility: "Eligibility", citizenship: "Citizenship",
  academic_levels: "Academic level", disciplines: "Discipline", award_amounts: "Award funding",
  stipend: "Stipend", tuition: "Tuition", travel_research_allowance: "Travel and research funding",
  tenure: "Award duration", requirements: "Requirements", application_materials: "Application materials",
  how_to_apply: "How to apply", documents: "Program documents", selection: "Selection",
  application_url: "Application link", contacts: "Program contacts",
});

const groups = {
  opening_date: "opening", deadline: "deadline", cycle_status: "cycle", important_dates: "dates",
  eligibility: "eligibility", citizenship: "eligibility", academic_levels: "eligibility", disciplines: "eligibility",
  award_amounts: "funding", stipend: "funding", tuition: "funding", travel_research_allowance: "funding", tenure: "funding",
  requirements: "instructions", application_materials: "instructions", how_to_apply: "instructions",
  documents: "documents", selection: "selection", application_url: "destination", contacts: "contacts",
};
const guidance = {
  opening: "Use the published opening date for the stated application cycle when planning when to apply.",
  deadline: "Plan your submission around the revised deadline and any published application track or time zone.",
  cycle: "Check the stated application cycle before starting or continuing an application.",
  dates: "Use the revised schedule for the relevant application cycle and track.",
  eligibility: "Check whether you qualify under the revised criteria before applying.",
  funding: "Use the revised funding details when planning your budget.",
  instructions: "Follow the revised instructions when preparing and submitting your application.",
  documents: "Review the listed official guidance before preparing your application; a listed reference alone does not confirm that its contents changed.",
  selection: "Use the revised selection guidance when preparing for assessment or an interview.",
  destination: "Use the application destination listed in the current official instructions.",
  contacts: "Use the current official contact details for application questions.",
};
const removalGuidance = {
  opening: "Confirm when applications open in the current official instructions; removed date wording does not establish a new opening date.",
  deadline: "Confirm the current deadline before planning a submission; removed date wording does not establish an extension or closure.",
  cycle: "Confirm the application status on the official page; removed status wording alone does not establish that applications opened or closed.",
  dates: "Confirm the current schedule in the official guidance; removed date wording does not establish a replacement date.",
  eligibility: "Check the current eligibility rules before applying; removed wording alone does not establish that a restriction was lifted.",
  funding: "Confirm the current funding terms before budgeting; removed wording alone does not establish that support ended or an amount changed.",
  instructions: "Check the current application instructions; removed wording alone does not establish that a requirement was waived.",
  documents: "Check the current official guidance before preparing materials. Removal from this page does not establish that a document was deleted or moved, or that application rules changed.",
  selection: "Check the current selection guidance; removed wording alone does not establish that an assessment or interview was cancelled.",
  destination: "Check the official application instructions for current portal access. A missing link alone does not establish that applications are closed.",
  contacts: "Check the official page for current contact details; removal from this page does not establish whether the contact is still available.",
};
const removedSubject = {
  opening_date: "the previously listed application opening date", deadline: "the previously listed application deadline",
  cycle_status: "the previous application-status wording", important_dates: "some previously listed schedule information",
  eligibility: "some previous eligibility wording", citizenship: "some previous citizenship or residency wording",
  academic_levels: "some previous academic-level wording", disciplines: "some previous subject-area wording",
  award_amounts: "some previous award-funding wording", stipend: "some previous stipend wording",
  tuition: "some previous tuition-support wording", travel_research_allowance: "some previous travel or research-funding wording",
  tenure: "some previous award-duration wording", requirements: "some previous requirement wording",
  application_materials: "some previous application-materials wording", how_to_apply: "some previous application instructions",
  documents: "the previously listed program guidance", selection: "some previous selection-process wording",
  application_url: "the previously listed application link", contacts: "the previously listed program contact information",
};

function changeDescription(change) {
  // A display projection never rewrites stored evidence, model responses or
  // approval hashes. Absence has a deliberately local, page-specific scope.
  if (change.operation === "remove") {
    if (change.field === "documents" && /^The page no longer lists [“"].+[”"]\.$/u.test(change.summary)) return change.summary;
    const previous = change.previous_quote?.text;
    // A short exact statement explains which rule disappeared without treating
    // disappearance as a waiver. Long passages stay in optional supporting details.
    if (change.field !== "application_url" && previous && previous.length <= 180 && !/https?:\/\/|[\r\n]/u.test(previous)) {
      return `The official page no longer states: “${previous}”${/[.!?]$/u.test(previous) ? "" : "."}`;
    }
    return `The official page no longer lists ${removedSubject[change.field]}.`;
  }
  if (change.field === "application_url") {
    return change.operation === "add"
      ? "The official page now includes an application link."
      : "The application link listed on the official page changed.";
  }
  return change.summary;
}

/** Read-only presentation of accepted source-bound claims for web and email. */
export function programChangePresentation(value) {
  const parsed = parseProgramTextChangeDetails(value);
  if (!parsed) return null;
  const changes = parsed.program_changes.map(change => ({
    field: change.field, operation: change.operation, label: PROGRAM_CHANGE_LABELS[change.field],
    summary: changeDescription(change),
    context: (change.operation === "remove" ? removalGuidance : guidance)[groups[change.field]],
    previous: change.previous_quote?.text ?? null, current: change.current_quote?.text ?? null,
  }));
  const fields = [...new Set(changes.map(change => change.field))];
  const label = fields.length === 1 ? PROGRAM_CHANGE_LABELS[fields[0]] : "Program details";
  let combined = parsed.summary;
  // Replace only known descriptions, preserving qualifications in the accepted
  // aggregate. If they cannot be located, do not strip cycle/track context and
  // reassemble claims with a broader apparent scope.
  for (const [index, change] of changes.entries()) {
    const original = parsed.program_changes[index].summary;
    if (change.summary === original) continue;
    if (!combined.includes(original)) { combined = ""; break; }
    combined = combined.replaceAll(original, change.summary);
  }
  if (!combined) combined = `The official page changed its ${fields.map(field => PROGRAM_CHANGE_LABELS[field].toLowerCase()).join(", ")} information. Review the individual changes for the relevant cycle or track.`;
  const text = combined.length <= 1200 ? combined
    : `${changes.length} program details changed on the official page. Review the individual changes and current official guidance.`;
  const contexts = [...new Set(changes.map(change => change.context))];
  // Keep the bounded admin DTO concise for large mixed changes; individual
  // claims and their unmodified quotations remain available in supporting details.
  const hasRemoval = changes.some(change => change.operation === "remove");
  const documentRemoved = changes.some(change => change.field === "documents" && change.operation === "remove");
  const fallback = "Review the changed details for your application cycle and track in the current official guidance before applying.";
  const context = contexts.join(" ").length <= 600 ? contexts.join(" ")
    : documentRemoved ? `${fallback} ${removalGuidance.documents}`
      : hasRemoval ? `${fallback} Removed wording alone does not establish a waiver, closure or replacement rule.` : fallback;
  return { label, title: fields.length === 1 ? `${label} changed` : "Program details changed",
    text, paragraphs: [text], context, changes,
    quotes: changes.map(change => ({ label: change.label, previous: change.previous, current: change.current })),
  };
}

export function programChangeContext(value) {
  return programChangePresentation(value)?.context ?? null;
}
