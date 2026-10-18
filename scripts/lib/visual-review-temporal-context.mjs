import { createHash } from "node:crypto";

const MAX_CONTEXT_CHARS = 500_000;
const normalize = (value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const bounded = (value) => typeof value === "string" && value.length > 0 && value.length <= MAX_CONTEXT_CHARS;
const strings = (values) => Array.isArray(values) && values.length <= 64 && values.every(value => typeof value === "string") ? values : [];

// Lexical recognition only: no locale parsing, timezone conversion or inference
// from a bare year/number. Clock values require an explicit meridiem AND zone.
const month = "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)";
const day = "(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?";
const year = "(?:19|20|21)\\d{2}";
const zone = "(?:UK(?:\\s+time)?|UTC(?:[+-]\\d{1,2}(?::?\\d{2})?)?|GMT(?:[+-]\\d{1,2}(?::?\\d{2})?)?|[ECMP][SD]?T|(?:Eastern|Central|Mountain|Pacific)(?:\\s+(?:Standard|Daylight))?(?:\\s+Time)?)";
const clock = `(?:0?[1-9]|1[0-2]):[0-5]\\d\\s*[ap]\\.?m\\.?\\s+(?:\\((?:midnight|noon)\\)\\s+)?${zone}`;
const typedValue = new RegExp(`\\b(?:${clock}|${month}\\.?\\s+${day},?\\s+${year}|${day}\\s+${month}\\.?,?\\s+${year}|${year}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01]))(?![\\w])`, "gi");

function tokens(text) {
  if (!bounded(text)) return [];
  return [...text.matchAll(typedValue)].map(match => normalize(match[0]).toLowerCase()
    .replace(/([0-9])\s*([ap])\.?m\.?/g, "$1$2m")
    .replace(/,\s*/g, ","));
}

function counts(values) {
  const output = new Map();
  for (const value of values) for (const token of tokens(value)) output.set(token, (output.get(token) || 0) + 1);
  return output;
}

function sourceTextPair(candidate, diff) {
  const semantics = diff.scrapling_semantics;
  if (diff.candidate_scope !== "scrapling_html_source") {
    const previous = candidate?.prompt_payload?.previous_text_excerpt;
    const current = candidate?.prompt_payload?.new_text_excerpt;
    return bounded(previous) && bounded(current) ? { previous, current } : null;
  }
  if (semantics?.complete !== true || semantics?.visible_prose_corroborated !== true) return null;
  const current = semantics.current_source_prose;
  if (!bounded(current)) return null;
  if (semantics.version === 2) {
    return bounded(semantics.previous_source_prose) ? { previous: semantics.previous_source_prose, current } : null;
  }
  if (![3, 4].includes(semantics.version) || semantics.source_context_complete !== true ||
      semantics.previous_source_prose_reconstructable !== true ||
      semantics.previous_prose_replacement_offsets !== "utf16_code_units_into_current_source_prose" ||
      (semantics.version === 4 && semantics.context_table_reconstruction_verified !== true) ||
      digest(current) !== semantics.current_source_prose_sha256) return null;
  const added = strings(diff.added_text), removed = strings(diff.removed_text);
  const replacements = semantics.previous_prose_replacements;
  if (!Array.isArray(replacements) || !replacements.length || replacements.length > 64 ||
      replacements.length !== added.length || added.length !== removed.length) return null;
  const ordered = [...replacements].sort((a, b) => a.current_start - b.current_start);
  let previous = "", cursor = 0;
  const seen = new Set();
  for (const replacement of ordered) {
    const { change_index: index, current_start: start, current_end: end, previous_text: old } = replacement;
    if (!Number.isSafeInteger(index) || index < 0 || index >= added.length || seen.has(index) ||
        !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < cursor || end <= start || end > current.length ||
        !bounded(old) || current.slice(start, end) !== normalize(added[index]) || old !== normalize(removed[index])) return null;
    seen.add(index);
    previous += current.slice(cursor, start) + old;
    cursor = end;
    if (previous.length > MAX_CONTEXT_CHARS) return null;
  }
  previous += current.slice(cursor);
  return bounded(previous) && digest(previous) === semantics.previous_source_prose_sha256 ? { previous, current } : null;
}

export function temporalContextAmbiguityDecision({ candidate, facts }) {
  const diff = candidate?.deterministic_diff || candidate?.prompt_payload?.deterministic_diff || {};
  const newValues = new Set();
  for (const fact of Array.isArray(facts) ? facts.slice(0, 12) : []) {
    const old = new Set([...tokens(fact.before), ...tokens(fact.removed_text)]);
    for (const value of [...tokens(fact.after), ...tokens(fact.added_text)]) if (!old.has(value)) newValues.add(value);
  }
  if (!newValues.size) return { allowed: true, reason: "no_fully_specified_temporal_change" };
  const context = sourceTextPair(candidate, diff);
  if (!context) return diff.candidate_scope === "scrapling_html_source"
    ? { allowed: false, reason: "temporal_context_not_verifiable" }
    : { allowed: true, reason: "legacy_context_unavailable_not_a_conflict_check" };
  const before = counts([context.previous]), after = counts([context.current]);
  const removed = counts(strings(diff.removed_text)), added = counts(strings(diff.added_text));
  // Subtract accounted changes, not every identical substring. Removing all
  // occurrences would erase the pre-existing table that makes Gates ambiguous.
  for (const value of newValues) {
    if ((before.get(value) || 0) > (removed.get(value) || 0) &&
        (after.get(value) || 0) > (added.get(value) || 0)) {
      return { allowed: false, reason: "temporal_value_already_in_unchanged_context" };
    }
  }
  return { allowed: true, reason: "no_repeated_temporal_value_observed" };
}
