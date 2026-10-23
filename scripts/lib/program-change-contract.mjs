// Shared by the worker and public rendering. Keep this module browser-safe.
export const PROGRAM_DETAIL_FIELDS = Object.freeze([
  "opening_date", "deadline", "cycle_status", "important_dates", "eligibility", "citizenship",
  "academic_levels", "disciplines", "award_amounts", "stipend", "tuition", "travel_research_allowance",
  "tenure", "requirements", "application_materials", "how_to_apply", "documents", "selection",
  "application_url", "contacts",
]);

export const PROGRAM_CHANGE_LIMITS = Object.freeze({ changes: 64, summary: 1200, change_summary: 600, quote: 1600 });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const nonempty = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const fields = new Set(PROGRAM_DETAIL_FIELDS);
const flow = value => value.replace(/\s+/gu, " ").trim();
const wellFormed = value => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);

export function hasProgramTextChangeMarker(value) {
  return object(value) && (value.schema === "awardping.program-change.v1" || value.event_kind === "program_details_changed");
}

function quote(value) {
  if (value === null) return null;
  if (!exact(value, ["block_id", "start_utf16", "end_utf16", "text"]) || !nonempty(value.block_id, 200) ||
      !nonempty(value.text, PROGRAM_CHANGE_LIMITS.quote) || !wellFormed(value.text) || !Number.isSafeInteger(value.start_utf16) ||
      !Number.isSafeInteger(value.end_utf16) || value.start_utf16 < 0 || value.end_utf16 - value.start_utf16 !== value.text.length) return undefined;
  return { block_id: value.block_id, start_utf16: value.start_utf16, end_utf16: value.end_utf16, text: value.text };
}

/** Structural public boundary; original-source verification belongs to the worker validator. */
export function parseProgramTextChangeDetails(value) {
  if (!exact(value, ["schema", "event_kind", "summary", "program_changes"]) || value.schema !== "awardping.program-change.v1" ||
      value.event_kind !== "program_details_changed" || !nonempty(value.summary, PROGRAM_CHANGE_LIMITS.summary) ||
      !Array.isArray(value.program_changes) || value.program_changes.length < 1 || value.program_changes.length > PROGRAM_CHANGE_LIMITS.changes) return null;
  const changes = [], seen = new Set();
  for (const change of value.program_changes) {
    if (!exact(change, ["field", "operation", "summary", "previous_quote", "current_quote"]) || !fields.has(change.field) ||
        !["add", "remove", "replace"].includes(change.operation) || !nonempty(change.summary, PROGRAM_CHANGE_LIMITS.change_summary)) return null;
    const previous = quote(change.previous_quote), current = quote(change.current_quote);
    if (previous === undefined || current === undefined ||
        (change.operation === "add" && (previous !== null || current === null)) ||
        (change.operation === "remove" && (previous === null || current !== null)) ||
        (change.operation === "replace" && (previous === null || current === null || flow(previous.text) === flow(current.text)))) return null;
    const parsed = { field: change.field, operation: change.operation, summary: change.summary, previous_quote: previous, current_quote: current };
    const identity = JSON.stringify([parsed.field, parsed.operation, previous, current]);
    if (seen.has(identity)) return null;
    seen.add(identity);
    changes.push(parsed);
  }
  return { schema: value.schema, event_kind: value.event_kind, summary: value.summary, program_changes: changes };
}
