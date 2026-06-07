export function cleanDisplayText(value: string | null | undefined) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/([.!?])(?=[A-Z0-9])/g, "$1 ")
    .replace(/([a-z])([A-Z][a-z])/g, "$1 $2")
    .replace(/\bArticle\s+\d+\s+Min\s+Read\b/gi, "")
    .replace(/\bArticle\s+\d+\s+hours?\s+ago\s+\d+\s+min\s+read\b/gi, "")
    .replace(/\b\d+\s+min\s+read\b/gi, "")
    .replace(/\s*;\s*/g, "; ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.!?])\s*-\s*(?=The\b)/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

export function readableSourceTitle(sourceTitle?: string | null, sourceUrl?: string | null) {
  const cleanTitle = cleanDisplayText(sourceTitle);
  const titleUrl = safeUrl(cleanTitle);
  if (titleUrl) {
    return readableTitleFromUrl(titleUrl);
  }
  if (/^\/+$/.test(cleanTitle)) return "Homepage";
  if (
    cleanTitle &&
    !/^(source page|homepage|other source)$/i.test(cleanTitle) &&
    !isGenericActionTitle(cleanTitle) &&
    !looksLikeUrlPathTitle(cleanTitle)
  ) {
    return cleanTitle;
  }

  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      return readableTitleFromUrl(url);
    } catch {
      // Fall through to generic label.
    }
  }

  return "source";
}

function isGenericActionTitle(value: string) {
  return /^(apply|applications?|learn more|read more|view more|more information|details?|click here|here|tips here\.?)$/i.test(
    value.trim(),
  );
}

function readableTitleFromUrl(url: URL) {
  const segments = meaningfulUrlSegments(url);
  const segment = segments.at(-1);
  if (!segment) return "Homepage";

  if (/^application-tips-/i.test(segment)) {
    return `${formatPathSegment(segment.replace(/^application-tips-/i, ""))} Application Tips`;
  }

  if (/^(apply|application)$/i.test(segment)) {
    const context = segments.slice(0, -1).at(-1);
    return context ? `${formatPathSegment(context)} Application` : "Application Page";
  }

  if (/^(tips|tips-here)$/i.test(segment)) {
    const context = segments.slice(0, -1).at(-1);
    return context ? `${formatPathSegment(context)} Tips` : "Tips";
  }

  if (segment) return formatPathSegment(segment);
  return "Homepage";
}

function meaningfulUrlSegments(url: URL) {
  return url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter(
      (segment) =>
        segment.length > 1 &&
        !/^(page|pages|resources?|view|programs?|awards?|scholarships?|fellowships?|grants?)$/i.test(
          segment,
        ),
    );
}

function safeUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function formatPathSegment(segment: string) {
  const decoded = decodeURIComponent(segment).replace(/\.(html?|php|aspx?|pdf)$/i, "");
  const cleaned = decoded
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Page";

  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (/^(faq|faqs|pdf|nsf|grfp|usa|us|uk|phd|nasa|rd|r&d)$/i.test(word)) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

export function looksLikeUrlPathTitle(value: string | null | undefined) {
  const clean = String(value || "").trim();
  return (
    /^\/+$/.test(clean) ||
    /^\/[^/]+(?:\/[^/]+)*\/?$/i.test(clean) ||
    /^[a-z0-9-]+(?:\/[a-z0-9-]+)+\/?$/i.test(clean)
  );
}
