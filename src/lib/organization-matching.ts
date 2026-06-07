import { normalizedLookupName, normalizeOrganizationName } from "@/lib/organizations";

type OrganizationLike = {
  name: string;
  country?: string | null;
  country_code?: string | null;
  state_province?: string | null;
};

export function organizationMatchKey(value: string) {
  return normalizedLookupName(normalizeOrganizationName(value));
}

export function looseOrganizationMatchKey(value: string) {
  return organizationMatchKey(value)
    .replace(/\s+[-,]\s+/g, " ")
    .replace(/[-,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function organizationSearchTokens(value: string) {
  return looseOrganizationMatchKey(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .slice(0, 8);
}

export function organizationMatchRank(query: string, organizationName: string) {
  const queryKey = organizationMatchKey(query);
  const organizationKey = organizationMatchKey(organizationName);
  const looseQueryKey = looseOrganizationMatchKey(query);
  const looseOrganizationKey = looseOrganizationMatchKey(organizationName);

  if (!queryKey) return 10;
  if (organizationKey === queryKey || looseOrganizationKey === looseQueryKey) return 0;
  if (organizationKey.startsWith(queryKey)) return 1;
  if (looseOrganizationKey.startsWith(looseQueryKey)) return 2;

  const tokens = organizationSearchTokens(query);
  if (tokens.length && tokens.every((token) => looseOrganizationKey.includes(token))) {
    return 3;
  }

  if (organizationKey.includes(queryKey) || looseOrganizationKey.includes(looseQueryKey)) {
    return 4;
  }

  return 10;
}

export function sortOrganizationsForQuery<T extends OrganizationLike>(query: string, organizations: T[]) {
  return [...organizations].sort((left, right) => {
    return compareOrganizationsForQuery(query, left, right);
  });
}

export function dedupeOrganizationsForQuery<T extends OrganizationLike>(
  query: string,
  organizations: T[],
) {
  const deduped = new Map<string, T>();

  for (const organization of sortOrganizationsForQuery(query, organizations)) {
    const key = looseOrganizationMatchKey(organization.name);
    const existing = deduped.get(key);

    if (!existing || compareOrganizationsForQuery(query, organization, existing) < 0) {
      deduped.set(key, organization);
    }
  }

  return sortOrganizationsForQuery(query, [...deduped.values()]);
}

export function bestExistingOrganizationMatch<T extends OrganizationLike>(
  query: string,
  organizations: T[],
) {
  const sorted = sortOrganizationsForQuery(query, organizations);
  const best = sorted[0];
  if (!best) return null;
  return organizationMatchRank(query, best.name) <= 2 ? best : null;
}

function compareOrganizationsForQuery<T extends OrganizationLike>(
  query: string,
  left: T,
  right: T,
) {
  const rankDelta =
    organizationMatchRank(query, left.name) - organizationMatchRank(query, right.name);
  if (rankDelta !== 0) return rankDelta;

  const metadataDelta = organizationMetadataScore(right) - organizationMetadataScore(left);
  if (metadataDelta !== 0) return metadataDelta;

  return left.name.localeCompare(right.name);
}

function organizationMetadataScore(organization: OrganizationLike) {
  return Number(Boolean(organization.state_province)) * 2 +
    Number(Boolean(organization.country_code)) +
    Number(Boolean(organization.country)) * 0.5;
}
