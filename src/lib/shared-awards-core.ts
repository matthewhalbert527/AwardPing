export function normalizeSharedAwardKey(name: string) {
  const key = name.trim().toLowerCase().replace(/\s+/g, " ");
  return canonicalSharedAwardKeyAlias(key) || key;
}

function canonicalSharedAwardKeyAlias(key: string) {
  if (
    key === "national science foundation graduate research fellowship" ||
    key === "national science foundation graduate research fellowship program" ||
    key === "nsf graduate research fellowship"
  ) {
    return "nsf graduate research fellowship program";
  }
  return null;
}
