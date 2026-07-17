export function safeNextPath(value: string | null | undefined) {
  let decoded = value || "";
  try {
    for (let index = 0; index < 3; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return "";
  }
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /\\|%2f|%5c|[\u0000-\u001f\u007f]/i.test(value) ||
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    /\\|[\u0000-\u001f\u007f]/.test(decoded)
  ) {
    return "";
  }

  try {
    const base = new URL("https://awardping.local");
    const resolved = new URL(value, base);
    if (
      resolved.origin !== base.origin ||
      !resolved.pathname.startsWith("/") ||
      resolved.pathname.startsWith("//") ||
      /\\|[\u0000-\u001f\u007f]/.test(resolved.pathname)
    ) {
      return "";
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "";
  }
}
