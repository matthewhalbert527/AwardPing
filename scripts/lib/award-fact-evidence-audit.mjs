/**
 * Offline, read-only diagnostic for baseline evidence attribution.
 *
 * It answers one question about an already-exported candidate set: for each
 * value a candidate proposes, what quote is attached to it, and what else was
 * available on the same source? It reads only what it is given. It never
 * regenerates candidates (that would re-derive clock-dependent fields), never
 * reads the filesystem, network or environment, never mutates its inputs, and
 * never decides whether a fact is true.
 *
 * Lexical containment is reported because it points a reviewer at rows worth
 * opening first. It is NOT support and NOT verification:
 *   * a quote can contain the exact value and still describe a different
 *     application round, a prior year, or another program on the same page;
 *   * a correct fact is often paraphrased, so an absent match means nothing.
 * Every flag below is independent. None of them combine into a score, a
 * verdict, or a publication signal, and manual item-bound evidence review is
 * still required for every candidate.
 *
 * Where the diagnostic cannot tell, it says so. A malformed candidate, an
 * unusable value, an identifier of the wrong type and a source whose quote
 * container is missing or self-contradictory each produce an explicit row
 * with a reason, never a silent omission and never a comfortable zero.
 */

export const AUDIT_SCHEMA_VERSION = 1;

export const REVIEW_CAVEAT = [
  "Lexical containment is a review hint only, never evidence support.",
  "Matching text may belong to a different round, year, or program on the same page.",
  "Absent text may simply be a paraphrase of a correct fact.",
  "Manual item-bound evidence review is still required for every candidate.",
].join(" ");

/**
 * Every container a source may carry its page-level quotes in, described by
 * path. `page_metadata.baseline_facts` is the shape production writes and the
 * shape `sourceBaselineFacts` reads; the others are export conveniences and
 * the legacy flat metadata. No path outranks another: if two disagree the row
 * is reported ambiguous rather than resolved by precedence.
 */
export const QUOTE_CONTAINER_PATHS = [
  ["evidence_quotes"],
  ["baseline_facts", "evidence_quotes"],
  ["page_metadata", "baseline_facts", "evidence_quotes"],
  ["page_metadata", "baselineFacts", "evidence_quotes"],
  ["page_metadata", "evidence_quotes"],
];

/** The truncation cap the reconciler applies to a stored quote. */
const QUOTE_TRUNCATION_LENGTH = 240;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A usable identifier is a non-blank string. Anything else is not one. */
function isUsableId(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Casing, whitespace and typographic variants only. Digits, punctuation and
 * round qualifiers such as "(Fall 2026 Application)" are deliberately kept,
 * because dropping them is what makes two different rounds look alike.
 */
function normalizeForComparison(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Classify one proposed value item. Text is comparable; a number, boolean or
 * null is preserved as given and marked not comparable rather than coerced
 * into text that never appeared in any quote; an object or array is refused
 * outright so it can never become "[object Object]".
 */
function classifyValueItem(raw) {
  if (typeof raw === "string") {
    return raw.trim().length > 0
      ? { kind: "text", text: raw, comparable: true, reason: null }
      : { kind: "text", text: raw, comparable: false, reason: "blank_text_value" };
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    return { kind: typeof raw, text: null, comparable: false, reason: "non_text_value" };
  }
  if (raw === null) return { kind: "null", text: null, comparable: false, reason: "null_value" };
  if (raw === undefined) return { kind: "missing", text: null, comparable: false, reason: "missing_value" };
  if (Array.isArray(raw)) return { kind: "array", text: null, comparable: false, reason: "nested_array_value" };
  return { kind: "object", text: null, comparable: false, reason: "object_value" };
}

/** The value items a candidate proposes, or one explicit unassessed marker. */
function valueItemsOf(candidate) {
  const hasRaw = Object.prototype.hasOwnProperty.call(candidate, "raw_value");
  const raw = hasRaw ? candidate.raw_value : candidate.value;
  if (Array.isArray(raw)) {
    // An empty list is a candidate that proposed nothing. It stays visible as
    // its own row so the candidate is never quietly dropped from the counts.
    if (raw.length === 0) return [{ raw: undefined, kind: "empty_list", text: null, comparable: false, reason: "empty_list_value" }];
    return raw.map((item) => ({ raw: item, ...classifyValueItem(item) }));
  }
  return [{ raw, ...classifyValueItem(raw) }];
}

/**
 * Every quote container present on a source, with what each holds. Nothing is
 * chosen here; disagreement is surfaced by the caller.
 */
function quoteContainers(source) {
  const found = [];
  for (const path of QUOTE_CONTAINER_PATHS) {
    let node = source;
    let reachable = true;
    for (const key of path) {
      if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, key)) {
        reachable = false;
        break;
      }
      node = node[key];
    }
    if (!reachable) continue;
    if (Array.isArray(node)) {
      // Count actual quote text, not arbitrary entries. Do not silently drop
      // malformed entries: that would make a partial export look complete.
      const valid = node.every((quote) => typeof quote === "string" && quote.trim().length > 0);
      found.push({
        path: path.join("."),
        kind: valid ? "array" : "invalid_array_entries",
        count: valid ? node.length : null,
        quotes: valid ? node : null,
      });
    } else if (typeof node === "string") {
      found.push({ path: path.join("."), kind: "string", count: null, quotes: null });
    } else {
      found.push({ path: path.join("."), kind: node === null ? "null" : typeof node, count: null, quotes: null });
    }
  }
  return found;
}

/**
 * What is actually known about a source's available quotes.
 *
 * `known` carries a count that may legitimately be zero. `unknown` means no
 * documented container exists, which is not the same as zero. `invalid` means
 * a container exists in an unusable shape. `ambiguous` means two containers
 * disagree and no path is treated as authoritative.
 */
function describeQuoteAvailability(binding) {
  if (binding.resolution !== "resolved") {
    return { status: "unresolved_source", count: null, quotes: null, containers: [] };
  }
  const containers = quoteContainers(binding.source);
  const summary = containers.map(({ path, kind, count }) => ({ path, kind, count }));
  if (containers.length === 0) return { status: "unknown", count: null, quotes: null, containers: summary };

  const usable = containers.filter((container) => container.kind === "array");
  if (usable.length === 0) return { status: "invalid", count: null, quotes: null, containers: summary };
  if (usable.length < containers.length) return { status: "ambiguous", count: null, quotes: null, containers: summary };

  const shapes = new Set(usable.map((container) => JSON.stringify(container.quotes)));
  if (shapes.size > 1) return { status: "ambiguous", count: null, quotes: null, containers: summary };

  return { status: "known", count: usable[0].count, quotes: usable[0].quotes, containers: summary };
}

/**
 * Exact identifier resolution only. A missing, mistyped, unknown or duplicated
 * identifier is reported as such; no sibling, title or URL is used to guess a
 * binding, and identifiers of different types never match one another.
 */
function resolveSource(candidate, sources) {
  const id = candidate.shared_award_source_id;
  if (id === null || id === undefined || id === "") return { resolution: "absent", source: null, matches: 0 };
  if (!isUsableId(id)) return { resolution: "invalid_identifier", source: null, matches: 0 };
  const matches = sources.filter((source) => isPlainObject(source) && isUsableId(source.id) && source.id === id);
  if (matches.length === 0) return { resolution: "unmatched", source: null, matches: 0 };
  if (matches.length > 1) return { resolution: "duplicate", source: null, matches: matches.length };
  return { resolution: "resolved", source: matches[0], matches: 1 };
}

function looksTruncated(quote) {
  if (typeof quote !== "string" || !quote) return false;
  return quote.length >= QUOTE_TRUNCATION_LENGTH || /(?:\.\.\.|…)$/.test(quote.trimEnd());
}

/** The assigned quote, or null when it is absent or only whitespace. */
function assignedQuoteOf(candidate) {
  const quote = candidate.evidence_quote;
  if (typeof quote !== "string") return { quote: null, blank: false, present: quote !== undefined && quote !== null };
  // Trim only to decide blankness; the original text is what gets reported.
  if (quote.trim().length === 0) return { quote: null, blank: true, present: true };
  return { quote, blank: false, present: true };
}

function invalidCandidateRow(candidateIndex, candidate, reason) {
  return {
    candidateIndex,
    candidateId: null,
    candidateValid: false,
    fieldName: null,
    sourceIdRef: isPlainObject(candidate) ? candidate.shared_award_source_id ?? null : null,
    sourceResolution: "unassessed",
    sourceIdMatchCount: 0,
    sourceUrl: null,
    valueIndex: 0,
    valueItemCount: 0,
    valueItemRaw: null,
    valueItemText: null,
    valueItemKind: "unassessed",
    valueItemComparable: false,
    unassessedReason: reason,
    assignedQuote: null,
    quoteAvailability: { status: "unresolved_source", count: null, containers: [] },
    sharedWithFields: [],
    otherQuotesContainingValueItem: [],
    flags: {
      noAssignedQuote: true,
      assignedQuoteBlank: false,
      assignedQuoteSharedAcrossFields: false,
      sourceBindingMissingOrAmbiguous: true,
      assignedQuoteApparentlyTruncated: false,
      assignedQuoteContainsValueItem: false,
      otherSourceQuotesContainValueItem: false,
      quoteAvailabilityNotKnown: true,
      valueItemNotComparable: true,
      candidateShapeInvalid: true,
    },
  };
}

/**
 * One row per proposed value item, plus an explicit row for each candidate
 * that could not be assessed.
 *
 * @param {unknown} candidates exported fact candidates, read as given
 * @param {unknown} sources exported sources, read as given
 * @returns {{ schemaVersion: number, caveat: string, rows: object[] }}
 */
export function auditCandidateEvidence(candidates, sources) {
  const candidateList = Array.isArray(candidates) ? candidates : [];
  const sourceList = Array.isArray(sources) ? sources : [];

  // Sharing is only meaningful inside one resolved source, so the index is
  // keyed by the source object itself. Identifiers are never stringified into
  // a key, so a numeric 1 and a string "1" can never collide.
  const fieldsByQuote = new Map();
  for (const candidate of candidateList) {
    if (!isPlainObject(candidate)) continue;
    const binding = resolveSource(candidate, sourceList);
    if (binding.resolution !== "resolved") continue;
    const { quote } = assignedQuoteOf(candidate);
    if (!quote) continue;
    if (typeof candidate.field_name !== "string" || !candidate.field_name.trim()) continue;
    const perSource = fieldsByQuote.get(binding.source) || new Map();
    const key = normalizeForComparison(quote);
    const fields = perSource.get(key) || new Set();
    fields.add(candidate.field_name);
    perSource.set(key, fields);
    fieldsByQuote.set(binding.source, perSource);
  }

  const rows = [];
  candidateList.forEach((candidate, candidateIndex) => {
    if (!isPlainObject(candidate)) {
      rows.push(invalidCandidateRow(candidateIndex, candidate, Array.isArray(candidate) ? "candidate_is_array" : "candidate_not_object"));
      return;
    }
    const fieldNameValid = typeof candidate.field_name === "string" && candidate.field_name.trim().length > 0;
    const binding = resolveSource(candidate, sourceList);
    const availability = describeQuoteAvailability(binding);
    const { quote: assignedQuote, blank: assignedQuoteBlank } = assignedQuoteOf(candidate);
    const normalizedAssigned = normalizeForComparison(assignedQuote ?? "");
    const perSource = binding.resolution === "resolved" ? fieldsByQuote.get(binding.source) : null;
    const sharedWithFields = assignedQuote && fieldNameValid && perSource
      ? [...(perSource.get(normalizedAssigned) || new Set())].filter((field) => field !== candidate.field_name).sort()
      : [];

    const items = valueItemsOf(candidate);
    items.forEach((item, valueIndex) => {
      const normalizedItem = item.comparable ? normalizeForComparison(item.text) : "";
      const canCompare = fieldNameValid && item.comparable && normalizedItem.length > 0;
      const otherQuotesContainingValueItem = canCompare && availability.status === "known"
        ? availability.quotes
            .map((quote, index) => ({ index, quote: typeof quote === "string" ? quote : "" }))
            .filter(({ quote }) => normalizeForComparison(quote) !== normalizedAssigned)
            .filter(({ quote }) => normalizeForComparison(quote).includes(normalizedItem))
            .map(({ index }) => index)
        : [];

      rows.push({
        candidateIndex,
        candidateId: isUsableId(candidate.id) ? candidate.id : null,
        candidateValid: fieldNameValid,
        fieldName: fieldNameValid ? candidate.field_name : null,
        sourceIdRef: candidate.shared_award_source_id ?? null,
        sourceResolution: binding.resolution,
        sourceIdMatchCount: binding.matches,
        sourceUrl: binding.resolution === "resolved" && typeof binding.source.url === "string" ? binding.source.url : null,
        valueIndex,
        valueItemCount: items.length,
        valueItemRaw: item.kind === "object" || item.kind === "array" ? null : item.raw ?? null,
        valueItemText: item.text,
        valueItemKind: item.kind,
        valueItemComparable: canCompare,
        unassessedReason: !fieldNameValid ? "invalid_field_name" : canCompare ? null : item.reason,
        assignedQuote,
        quoteAvailability: { status: availability.status, count: availability.count, containers: availability.containers },
        sharedWithFields,
        otherQuotesContainingValueItem,
        flags: {
          noAssignedQuote: assignedQuote === null,
          assignedQuoteBlank,
          assignedQuoteSharedAcrossFields: sharedWithFields.length > 0,
          sourceBindingMissingOrAmbiguous: binding.resolution !== "resolved",
          assignedQuoteApparentlyTruncated: looksTruncated(assignedQuote),
          assignedQuoteContainsValueItem: Boolean(assignedQuote) && canCompare && normalizedAssigned.includes(normalizedItem),
          otherSourceQuotesContainValueItem: otherQuotesContainingValueItem.length > 0,
          quoteAvailabilityNotKnown: availability.status !== "known",
          valueItemNotComparable: !canCompare,
          candidateShapeInvalid: !fieldNameValid,
        },
      });
    });
  });

  return { schemaVersion: AUDIT_SCHEMA_VERSION, caveat: REVIEW_CAVEAT, rows };
}

const FLAG_NAMES = [
  "noAssignedQuote",
  "assignedQuoteBlank",
  "assignedQuoteSharedAcrossFields",
  "sourceBindingMissingOrAmbiguous",
  "assignedQuoteApparentlyTruncated",
  "assignedQuoteContainsValueItem",
  "otherSourceQuotesContainValueItem",
  "quoteAvailabilityNotKnown",
  "valueItemNotComparable",
  "candidateShapeInvalid",
];

/**
 * Independent counts over audit rows. Nothing here is a score or a verdict.
 * An empty input means no candidates were assessed, never a clean result, and
 * a candidate whose value could not be assessed is counted, not hidden.
 *
 * @param {unknown} rows rows from {@link auditCandidateEvidence}
 */
export function summarizeEvidenceAudit(rows) {
  const rowList = Array.isArray(rows) ? rows : [];
  const flagCounts = {};
  for (const name of FLAG_NAMES) flagCounts[name] = rowList.filter((row) => row?.flags?.[name] === true).length;

  const reasonCounts = {};
  for (const row of rowList) {
    const reason = row?.unassessedReason;
    if (typeof reason === "string" && reason) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }

  const availabilityCounts = {};
  for (const row of rowList) {
    const status = row?.quoteAvailability?.status ?? "unknown";
    availabilityCounts[status] = (availabilityCounts[status] || 0) + 1;
  }

  const candidateIndexes = new Set(rowList.map((row) => row?.candidateIndex));
  const valueItemsAssessed = rowList.filter((row) => row?.valueItemComparable === true && !row?.unassessedReason).length;
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    caveat: REVIEW_CAVEAT,
    rowsProduced: rowList.length,
    candidatesSeen: candidateIndexes.size,
    valueItemsAssessed,
    valueItemsUnassessed: rowList.length - valueItemsAssessed,
    fieldsSeen: [...new Set(rowList.map((row) => row?.fieldName).filter((name) => typeof name === "string"))].sort(),
    flagCounts,
    reasonCounts,
    availabilityCounts,
    noCandidatesProvided: candidateIndexes.size === 0,
  };
}

/**
 * Validate the exported input document. Returns the awards array or throws a
 * plain Error naming the first problem; nothing from the file is imported,
 * evaluated, or resolved as a path.
 *
 * @param {unknown} document parsed JSON
 */
export function parseAuditInput(document) {
  if (!isPlainObject(document)) throw new Error("input must be a JSON object");
  if (document.schemaVersion !== AUDIT_SCHEMA_VERSION) {
    throw new Error(`input schemaVersion must be ${AUDIT_SCHEMA_VERSION}, received ${JSON.stringify(document.schemaVersion)}`);
  }
  if (!Array.isArray(document.awards)) throw new Error("input.awards must be an array");

  document.awards.forEach((award, index) => {
    if (!isPlainObject(award)) throw new Error(`input.awards[${index}] must be an object`);
    if (!isUsableId(award.id)) throw new Error(`input.awards[${index}].id must be a non-empty string`);
    if (!Array.isArray(award.candidates)) throw new Error(`input.awards[${index}].candidates must be an array`);
    if (!Array.isArray(award.sources)) throw new Error(`input.awards[${index}].sources must be an array`);
    award.sources.forEach((source, sourceIndex) => {
      if (!isPlainObject(source)) throw new Error(`input.awards[${index}].sources[${sourceIndex}] must be an object`);
      if (source.id !== undefined && !isUsableId(source.id)) {
        throw new Error(`input.awards[${index}].sources[${sourceIndex}].id must be a non-empty string when present`);
      }
    });
  });

  return document.awards;
}

/** Audit every award in a validated input document, in input order. */
export function auditAwards(awards) {
  return (Array.isArray(awards) ? awards : []).map((award) => {
    const audit = auditCandidateEvidence(award.candidates, award.sources);
    return {
      awardId: award.id,
      awardName: typeof award.name === "string" ? award.name : null,
      rows: audit.rows,
      summary: summarizeEvidenceAudit(audit.rows),
    };
  });
}
