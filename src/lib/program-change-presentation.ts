// One browser-safe presentation is used by public pages, admin review and email.
// Stored source quotations and approval hashes remain in the unchanged contract.
export { programChangeContext, programChangePresentation } from "../../scripts/lib/program-change-presentation.mjs";

export type ProgramQuote = {
  block_id: string;
  start_utf16: number;
  end_utf16: number;
  text: string;
};
