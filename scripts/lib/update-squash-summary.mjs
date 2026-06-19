const rawSpecificTextSentence =
  /^The specific text (?:added|removed|changed) was:\s*['"`]/i;

export function buildConciseReadableSummary(summary) {
  const clean = cleanDisplayText(summary);
  if (!clean || clean.length < 120) return "";

  const stripped = stripRawChangeLead(clean);
  const candidate = firstUsefulSentences(stripped, 2);
  if (
    candidate &&
    candidate.length >= 35 &&
    candidate.length <= 360 &&
    actionableAwardSignal(candidate) &&
    !looksLikeTruncatedFragment(candidate) &&
    !hasRawScrapeSignals(candidate)
  ) {
    return candidate;
  }

  return "";
}

export function stripRawChangeLead(summary) {
  return cleanDisplayText(summary)
    .replace(
      /^The\s+.+?\s+page\s+(?:has\s+)?(?:added|removed)(?:\s+(?:the\s+following|new))?\s+wording:?\s*/i,
      "",
    )
    .replace(
      /^The\s+.+?\s+page\s+added\s+date\s+or\s+deadline\s+text:\s*/i,
      "New date or deadline text: ",
    )
    .replace(/^The\s+.+?\s+page\s+(?:has\s+)?added\s+/i, "Added ")
    .replace(/^The\s+.+?\s+page\s+(?:has\s+)?removed\s+/i, "Removed ")
    .replace(/^The\s+.+?\s+page\s+(?:has\s+)?changed\s+/i, "Changed ");
}

function firstUsefulSentences(value, maxSentences) {
  const clean = cleanDisplayText(value);
  if (!clean) return "";

  const sentences = splitReadableSentences(clean);
  const selected = [];
  for (const sentence of sentences) {
    let trimmed = cleanDisplayText(sentence);
    if (!trimmed || rawSpecificTextSentence.test(trimmed)) continue;
    trimmed = trimmed.replace(/^['"`]\s*/, "");
    trimmed = trimmed.replace(/^(Additionally|Also),\s*/i, "");
    if (!trimmed) continue;
    trimmed = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    selected.push(trimmed);
    const combined = cleanDisplayText(selected.join(" "));
    if (selected.length >= maxSentences || combined.length >= 240) return combined;
  }

  return cleanDisplayText(selected.join(" "));
}

function actionableAwardSignal(value) {
  return /\b(applications?|applicants?|apply|deadline|due|eligible|eligibility|requirements?|recommendations?|transcripts?|essays?|interviews?|tuition|stipend|funding|grants?|fellowships?|scholarships?|award amount|admission|selection|nomination|candidates?|submit|submission|opens?|reopens?|closes?|citizenship|gpa|pdf|guide|instructions?)\b/i.test(
    value,
  );
}

function looksLikeTruncatedFragment(summary) {
  const normalized = summary.toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean);
  const lastWord = words.at(-1)?.replace(/[^a-z0-9]+/g, "") || "";
  const quoteCount = (summary.match(/"/g) || []).length;

  return (
    words.length < 6 ||
    (quoteCount % 2 === 1 && summary.length < 120) ||
    /^(the|on the|in the|from the)\s+"?[\w\s-]{0,40}$/.test(normalized) ||
    /^(the|on the|in the|from the)\s+[a-z]{1,8}$/.test(normalized) ||
    /^(a|an|the|and|or|of|on|to|for|from|with|in|by|through|into|about|over|under|must|should|can|will|may)$/.test(lastWord)
  );
}

function hasRawScrapeSignals(value) {
  return (
    hasRawMarkupSignals(value) ||
    hasSeoInstrumentationSignals(value) ||
    hasJumpLinkHeadingPrefixSignals(value) ||
    /\b(indicates required fields|field is for validation purposes|submit x)\b/i.test(String(value || "")) ||
    /\b(learn more|read more|click here|skip to|main menu|toggle menu|toggle page navigation|search menu|read current issue|cart|dismiss|login|copyright|privacy policy|all rights reserved|facebook|instagram|x\.com|twitter|linkedin|youtube|subscribe|newsletter)\b/i.test(String(value || "")) ||
    hasNavigationBoilerplate(value) ||
    hasStorefrontBoilerplate(value)
  );
}

function hasJumpLinkHeadingPrefixSignals(value) {
  const clean = cleanDisplayText(value);
  return /\bTop\s+(?:Applications?|The Selection Process|Selection Process|Eligibility|Requirements?|Deadlines?|Timeline|FAQs?|Funding|References?|Courses?)\b/.test(
    clean,
  );
}

function hasSeoInstrumentationSignals(value) {
  const clean = cleanDisplayText(value);
  return (
    /\bbe_ixf\b/i.test(clean) ||
    /\bym_20\d{4}\s+d_\d{2}\b/i.test(clean) ||
    /\bphp_sdk(?:_\d+(?:\.\d+){1,3})?\b/i.test(clean) ||
    /\bct_\d+\s+be_ixf\b/i.test(clean)
  );
}

function hasRawMarkupSignals(value) {
  const clean = cleanDisplayText(value);
  return (
    /<\/?(?:picture|source|img|script|style|div|span|section|article|figure|figcaption|a|p|br|ul|ol|li|svg|path)\b/i.test(clean) ||
    /\b(?:srcset|classname|referrerpolicy|loading|sizes|alt|href|style)=["'][^"']{8,}/i.test(clean) ||
    /https?:\/\/[^\s"']+\.(?:jpg|jpeg|png|gif|webp|svg)(?:[?#][^\s"']*)?/i.test(clean)
  );
}

function hasStorefrontBoilerplate(value) {
  const clean = cleanDisplayText(value);
  return (
    /\b(view item|featured products?|shop for materials?|add to cart|checkout|subtotal|merchandise)\b/i.test(clean) ||
    /\bprice:\s*\$\s?\d/i.test(clean)
  );
}

function hasNavigationBoilerplate(value) {
  const clean = cleanDisplayText(value);
  const lower = clean.toLowerCase();
  const structuralNavMarkers = /\b(primary sidebar|secondary sidebar|sidebar navigation|site navigation|breadcrumb|footer)\b/i.test(
    clean,
  );
  const navTerms = [
    "application overview",
    "eligibility",
    "essays",
    "priorities",
    "selection criteria",
    "submission tips",
    "requirements",
    "deadlines",
    "timeline",
    "applicants faq",
    "current recipients",
    "scholars abroad",
    "alumni",
    "advisors",
    "general inquiries",
  ];
  const navTermCount = navTerms.filter((term) => lower.includes(term)).length;
  if (structuralNavMarkers && navTermCount >= 4) return true;
  return (
    /\b(back|previous|next)\s+(?:application|overview|news|search|winners?|representatives?)\b/i.test(clean) &&
    /\b(application overview|search|winners?|representatives?|districts?|brochure|frequently asked questions?)\b/i.test(clean) &&
    /\b(apply|back|search|toggle menu)\b/i.test(clean)
  );
}

function cleanDisplayText(value) {
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
    .replace(/\bM\.\s*D\./g, "M.D.")
    .replace(/\bPh\.\s*D\./gi, "Ph.D.")
    .replace(/\bU\.\s*S\./g, "U.S.")
    .replace(/\bU\.\s*K\./g, "U.K.")
    .replace(/\bi\.\s*e\./gi, "i.e.")
    .replace(/\be\.\s*g\./gi, "e.g.")
    .replace(/\s+/g, " ")
    .trim();
}

function splitReadableSentences(value) {
  const clean = cleanDisplayText(value);
  if (!clean) return [];
  return protectSentenceAbbreviations(clean)
    .match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)
    ?.map(restoreSentenceAbbreviations) || [clean];
}

const sentenceDotPlaceholder = "__AP_SENTENCE_DOT__";

function protectSentenceAbbreviations(value) {
  return String(value || "")
    .replace(/\bM\.\s*D\./g, "M" + sentenceDotPlaceholder + "D" + sentenceDotPlaceholder)
    .replace(/\bPh\.\s*D\./gi, "Ph" + sentenceDotPlaceholder + "D" + sentenceDotPlaceholder)
    .replace(/\bU\.\s*S\./g, "U" + sentenceDotPlaceholder + "S" + sentenceDotPlaceholder)
    .replace(/\bU\.\s*K\./g, "U" + sentenceDotPlaceholder + "K" + sentenceDotPlaceholder)
    .replace(/\bi\.\s*e\./gi, "i" + sentenceDotPlaceholder + "e" + sentenceDotPlaceholder)
    .replace(/\be\.\s*g\./gi, "e" + sentenceDotPlaceholder + "g" + sentenceDotPlaceholder);
}

function restoreSentenceAbbreviations(value) {
  return value.replaceAll(sentenceDotPlaceholder, ".");
}
