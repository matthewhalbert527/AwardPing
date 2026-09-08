/**
 * Compact, display-only facts for an award directory card. Exact aliases make
 * familiar wording consistent; they never infer eligibility from prose. The
 * reviewed arrays remain the source for filtering and the full award record.
 */
export type AwardCardGlanceInput = {
  academicLevels: readonly string[];
  citizenship: readonly string[];
  changeCount: number | null;
};

export type AwardCardGlanceItem = {
  key: "level" | "citizenship" | "updates";
  label: string;
  value: string;
  detail?: string;
  highlight?: boolean;
};

// A visual compactness budget, not an eligibility or publication rule. When a
// complete field will not fit, never show only the first part of its criteria.
const MAX_COMPACT_FIELD_LENGTH = 80;

function aliasKey(value: string) {
  return value.trim().replace(/\s+/g, " ").replace(/\.$/, "").toLowerCase();
}

const LEVEL_ALIASES = new Map([
  ["sophomore", "Sophomores"],
  ["sophomores", "Sophomores"],
  ["junior", "Juniors"],
  ["juniors", "Juniors"],
  ["college senior", "College seniors"],
  ["college seniors", "College seniors"],
  ["graduating senior", "Graduating seniors"],
  ["graduating seniors", "Graduating seniors"],
]);

type UsStatus = "citizens" | "nationals" | "permanent residents" | "dual citizens";
const US_STATUS_ALIASES = new Map<string, readonly UsStatus[]>();
for (const prefix of ["U.S.", "US", "United States"]) {
  for (const [wording, status] of [
    ["citizen", "citizens"],
    ["citizens", "citizens"],
    ["national", "nationals"],
    ["nationals", "nationals"],
    ["permanent resident", "permanent residents"],
    ["permanent residents", "permanent residents"],
    ["lawful permanent resident", "permanent residents"],
    ["lawful permanent residents", "permanent residents"],
    ["dual citizen", "dual citizens"],
    ["dual citizens", "dual citizens"],
  ] as const) {
    US_STATUS_ALIASES.set(aliasKey(`${prefix} ${wording}`), [status]);
  }
  // Whole registered disjunctions only. A qualifier after any of these words
  // makes a different value and cannot match this table.
  for (const wording of ["citizen or national", "citizens or nationals"]) {
    US_STATUS_ALIASES.set(aliasKey(`${prefix} ${wording}`), ["citizens", "nationals"]);
  }
  for (const wording of ["citizen or permanent resident", "citizens or permanent residents"]) {
    US_STATUS_ALIASES.set(aliasKey(`${prefix} ${wording}`), ["citizens", "permanent residents"]);
  }
  for (const wording of ["citizen, national, or permanent resident", "citizens, nationals, or permanent residents"]) {
    US_STATUS_ALIASES.set(aliasKey(`${prefix} ${wording}`), ["citizens", "nationals", "permanent residents"]);
  }
}
US_STATUS_ALIASES.set(aliasKey("Citizen or national of the United States"), ["citizens", "nationals"]);
US_STATUS_ALIASES.set(
  aliasKey("U.S. citizen, U.S. national, or permanent resident of the United States."),
  ["citizens", "nationals", "permanent residents"],
);

const CITIZENSHIP_ALIASES = new Map([
  [aliasKey("United States"), "U.S."],
  [aliasKey("US"), "U.S."],
  [aliasKey("U.S."), "U.S."],
  [aliasKey("United Kingdom"), "U.K."],
  [aliasKey("UK"), "U.K."],
  [aliasKey("U.K."), "U.K."],
]);

function uniqueValues(values: readonly string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = aliasKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function presentUsStatuses(statuses: readonly UsStatus[]) {
  const unique = [...new Set(statuses)];
  const text = unique.length > 1
    ? `${unique.slice(0, -1).join(", ")} or ${unique.at(-1)}`
    : unique[0];
  return `U.S. ${text}`;
}

function citizenshipValues(values: readonly string[]) {
  const statuses = values.map((value) => US_STATUS_ALIASES.get(aliasKey(value)));
  // A shared U.S. prefix is safe only when every entry is a whole recognized
  // status. DACA, regional conditions, country lists, and other prose remain
  // separate entries; they can never inherit or lose a citizenship condition.
  if (statuses.every((value) => value !== undefined)) {
    return presentUsStatuses(statuses.flatMap((value) => value));
  }
  return uniqueValues(values.map((value, index) => {
    const status = statuses[index];
    return status
      ? presentUsStatuses(status)
      : CITIZENSHIP_ALIASES.get(aliasKey(value)) ?? value;
  })).join("; ");
}

function criterionItem(
  key: "level" | "citizenship",
  label: string,
  rawValues: readonly string[],
): AwardCardGlanceItem {
  const present = rawValues.filter((value) => value.trim().length > 0);
  if (present.length === 0) return { key, label, value: "Not listed" };

  const displayed = key === "citizenship"
    ? citizenshipValues(present)
    : uniqueValues(present.map((value) => LEVEL_ALIASES.get(aliasKey(value)) ?? value)).join("; ");
  const value = displayed.length > MAX_COMPACT_FIELD_LENGTH ? "See full criteria" : displayed;
  const original = rawValues.join("; ");
  return { key, label, value, ...(value !== original ? { detail: original } : {}) };
}

export function awardCardGlance(input: AwardCardGlanceInput): AwardCardGlanceItem[] {
  const count = input.changeCount;
  const countKnown = count !== null && Number.isFinite(count) && Number.isInteger(count) && count >= 0;
  return [
    criterionItem("level", "Level", input.academicLevels),
    criterionItem("citizenship", "Citizenship", input.citizenship),
    {
      key: "updates",
      label: "Updates",
      value: countKnown ? (count === 0 ? "None recorded" : `${count} recorded`) : "Not available",
      ...(countKnown && count > 0 ? { highlight: true } : {}),
    },
  ];
}
