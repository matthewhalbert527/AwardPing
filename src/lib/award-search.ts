type AwardSearchAlias = {
  queryKeys: string[];
  preferredPrefixes: string[];
  supportPhrases: string[];
  targetPhrases: string[];
};

const awardSearchAliases: AwardSearchAlias[] = [
  {
    queryKeys: ["nsf grfp", "grfp"],
    preferredPrefixes: [
      "nsf graduate research fellowship",
      "national science foundation graduate research fellowship",
    ],
    supportPhrases: ["nsf", "national science foundation"],
    targetPhrases: [
      "nsf graduate research fellowship",
      "national science foundation graduate research fellowship",
      "graduate research fellowship program",
      "graduate research fellowship",
    ],
  },
  {
    queryKeys: ["nsf reu", "reu", "reus"],
    preferredPrefixes: [
      "nsf research experiences for undergraduates",
      "nsf research experience for undergraduates",
      "national science foundation research experiences for undergraduates",
      "national science foundation research experience for undergraduates",
    ],
    supportPhrases: ["nsf", "national science foundation"],
    targetPhrases: [
      "nsf research experiences for undergraduates",
      "nsf research experience for undergraduates",
      "national science foundation research experiences for undergraduates",
      "national science foundation research experience for undergraduates",
      "research experiences for undergraduates",
      "research experience for undergraduates",
    ],
  },
];

export function sortAwardsForSearch<T extends { name: string }>(
  query: string,
  awards: readonly T[],
  getSummary: (award: T) => string | null | undefined = () => null,
) {
  const queryKey = normalizeSearchText(query);
  if (!queryKey) return [...awards];

  return awards
    .map((award, index) => ({
      award,
      index,
      rank: awardSearchRank(queryKey, award.name, getSummary(award)),
    }))
    .filter((result): result is typeof result & { rank: number } => result.rank !== null)
    .sort((left, right) => {
      return (
        left.rank - right.rank ||
        left.award.name.localeCompare(right.award.name) ||
        left.index - right.index
      );
    })
    .map((result) => result.award);
}

export function awardSearchRank(
  queryKey: string,
  awardName: string,
  awardSummary?: string | null,
) {
  const nameKey = normalizeSearchText(awardName);
  const summaryKey = normalizeSearchText(awardSummary || "");
  const haystackKey = `${nameKey} ${summaryKey}`.trim();
  const queryTokens = searchTokens(queryKey);
  const nameAliasRank = aliasMatchRank(queryKey, nameKey);
  const haystackAliasRank = aliasMatchRank(queryKey, haystackKey);
  const ranks: number[] = [];

  if (nameKey === queryKey) ranks.push(0);
  if (nameAliasRank !== null) ranks.push(nameAliasRank);
  if (nameKey.startsWith(queryKey)) ranks.push(2);
  if (nameKey.includes(queryKey)) ranks.push(3);
  if (queryTokens.length > 0 && queryTokens.every((token) => nameKey.includes(token))) {
    ranks.push(4);
  }
  if (haystackAliasRank !== null) ranks.push(haystackAliasRank + 1);
  if (summaryKey.includes(queryKey)) ranks.push(6);
  if (queryTokens.length > 0 && queryTokens.every((token) => haystackKey.includes(token))) {
    ranks.push(7);
  }

  return ranks.length > 0 ? Math.min(...ranks) : null;
}

export function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function aliasMatchRank(queryKey: string, awardKey: string) {
  const ranks = awardSearchAliases.flatMap((alias) => {
    if (!alias.queryKeys.some((aliasQuery) => queryMatchesAlias(queryKey, aliasQuery))) {
      return [];
    }

    const targetMatch = alias.targetPhrases.some((phrase) =>
      awardKey.includes(normalizeSearchText(phrase)),
    );
    if (!targetMatch) return [];

    const preferredPrefixIndex = alias.preferredPrefixes.findIndex((phrase) =>
      awardKey.startsWith(normalizeSearchText(phrase)),
    );
    if (preferredPrefixIndex >= 0) return [1 + preferredPrefixIndex / 10];

    const supportMatch = alias.supportPhrases.some((phrase) =>
      awardKey.includes(normalizeSearchText(phrase)),
    );
    return [supportMatch ? 2 : 5];
  });

  return ranks.length > 0 ? Math.min(...ranks) : null;
}

function queryMatchesAlias(queryKey: string, aliasQuery: string) {
  if (queryKey === aliasQuery) return true;

  const queryTokenSet = new Set(searchTokens(queryKey));
  return searchTokens(aliasQuery).every((token) => queryTokenSet.has(token));
}

function searchTokens(value: string) {
  return normalizeSearchText(value).split(" ").filter(Boolean);
}
