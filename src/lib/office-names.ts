const officeNameAliases = new Map([
  [
    "office of nationally competitive awards",
    "University of Arkansas, Fayetteville - Office of Nationally Competitive Awards",
  ],
]);

const organizationPrefixes = [
  "University of Arkansas, Fayetteville",
];

export function formatOfficeName(name: string | null | undefined) {
  const fallback = "Award office";
  if (!name) return fallback;

  return officeNameAliases.get(name.trim().toLowerCase()) || name;
}

export function formatOfficeNameWithOrganization(
  officeName: string | null | undefined,
  organizationName: string | null | undefined,
) {
  const office = formatOfficeName(officeName);
  const organization = organizationName?.trim();

  if (!organization || isPlaceholderOfficeName(officeName)) {
    return office;
  }

  if (office.toLowerCase().startsWith(`${organization.toLowerCase()} - `)) {
    return office;
  }

  return `${organization} - ${office}`;
}

export function editableOfficeName(name: string | null | undefined) {
  if (!name) return "";

  const trimmed = name.trim();
  if (isPlaceholderOfficeName(trimmed)) return "";

  for (const organization of organizationPrefixes) {
    const prefix = `${organization} - `;
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      return trimmed.slice(prefix.length).trim();
    }
  }

  return trimmed;
}

export function splitOfficeNameForDisplay(name: string | null | undefined) {
  const formatted = formatOfficeName(name);
  const parts = formatted.split(/\s+-\s+/);

  if (parts.length >= 2) {
    return {
      university: parts[0],
      office: parts.slice(1).join(" "),
    };
  }

  return {
    university: formatted,
    office: null,
  };
}

export function isPlaceholderOfficeName(name: string | null | undefined) {
  const normalized = name?.trim().toLowerCase();
  return normalized === "new office" || normalized === "new award office" || !normalized;
}
