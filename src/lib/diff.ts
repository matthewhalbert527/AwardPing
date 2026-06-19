export function summarizeChange(previousSample: string | null, nextText: string) {
  if (!previousSample) {
    return "Initial award page snapshot captured. Future deadline, eligibility, or document updates will trigger alerts.";
  }

  const previousClean = normalizeText(previousSample);
  const nextClean = normalizeText(nextText);

  if (isLikelySampleExpansion(previousClean, nextClean)) {
    return "No award-relevant wording changed in the stored excerpt.";
  }

  const previousAmounts = new Set(contextualMoneyPhrases(previousClean));
  const newAmounts = unique(
    contextualMoneyPhrases(nextClean).filter((amount) => !previousAmounts.has(amount)),
  ).slice(0, 3);
  if (newAmounts.length > 0) {
    return `New funding amount language appeared: ${newAmounts.join(", ")}.`;
  }

  const previousDates = new Set(datePhrases(previousSample));
  const newDates = unique(datePhrases(nextText).filter((date) => !previousDates.has(date))).slice(
    0,
    4,
  );
  if (newDates.length > 0) {
    const contextualDateSentence = sentenceWithRelevantDate(nextClean, newDates);
    if (contextualDateSentence) {
      return `Added date context: ${contextualDateSentence}`;
    }
  }

  const addedSentences = changedSentences(previousClean, nextClean, "added");
  if (addedSentences.length > 0) {
    return sentenceSummary("Added text includes", addedSentences);
  }

  const removedSentences = changedSentences(previousClean, nextClean, "removed");
  if (removedSentences.length > 0) {
    return sentenceSummary("Removed text includes", removedSentences);
  }

  const excerpt = changedTextExcerpt(previousClean, nextClean);
  if (excerpt) return excerpt;

  const previousWords = new Set(words(previousSample));
  const nextWords = words(nextText);
  const additions = unique(
    nextWords
      .filter((word) => !previousWords.has(word))
      .filter(isUsefulWordAddition),
  ).slice(0, 12);

  if (additions.length === 0) {
    return "No award-relevant wording changed in the stored excerpt.";
  }

  return `New terms found: ${additions.join(", ")}.`;
}

export function buildChangePromptContext(previousSample: string | null, nextText: string) {
  if (!previousSample) return "Initial snapshot; no previous page text was stored.";

  const previousClean = normalizeText(previousSample);
  const nextClean = normalizeText(nextText);
  const addedSentences = changedSentences(previousClean, nextClean, "added").slice(0, 4);
  const removedSentences = changedSentences(previousClean, nextClean, "removed").slice(0, 3);
  const excerpt = changedTextExcerpt(previousClean, nextClean);

  return [
    addedSentences.length ? `Added sentences:\n- ${addedSentences.join("\n- ")}` : "",
    removedSentences.length ? `Removed sentences:\n- ${removedSentences.join("\n- ")}` : "",
    excerpt ? `Character-level diff: ${excerpt}` : "",
  ]
    .filter(Boolean)
    .join("\n\n") || "No concise text-level diff was found in the stored excerpt.";
}

function words(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3);
}

function isUsefulWordAddition(word: string) {
  return !/^(required|statements|social|media|facebook|instagram|twitter|linkedin|youtube|subscribe|newsletter|copyright|privacy|menu|more|store|gift|amount|donate|donation|cart|checkout|publication|udallfoundation|parksinfocus|morris|suite|blvd|boulevard|street|avenue)$/.test(
    word,
  );
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function datePhrases(text: string) {
  const month =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const patterns = [
    new RegExp(`\\b(?:${month})\\.?\\s+\\d{1,2}(?:,\\s*\\d{4})?\\b`, "gi"),
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
    /\b\d{4}-\d{2}-\d{2}\b/g,
  ];

  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => normalizePhrase(match[0])),
  );
}

function contextualMoneyPhrases(text: string) {
  return unique(
    [...text.matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?\b/g)]
      .filter((match) => hasFundingAmountContext(contextAroundMatch(text, match.index || 0)))
      .map((match) => normalizePhrase(match[0])),
  );
}

function contextAroundMatch(text: string, index: number) {
  return normalizeText(text.slice(Math.max(0, index - 180), index + 220));
}

function hasFundingAmountContext(value: string) {
  const lower = value.toLowerCase();
  if (
    /\b(cart|donate|donation|shop|store|subscribe|subscription|ticket|tickets|purchase|checkout|subtotal|merchandise|membership|sponsor|sponsorship)\b/.test(
      lower,
    )
  ) {
    return false;
  }

  return /\b(stipend|tuition|funding|funds?|grant|scholarships?|fellowships?|award amount|awards?:|amount awarded|prize|financial support|honorarium|living allowance|travel expenses?|research expenses?)\b/.test(
    lower,
  );
}

function normalizePhrase(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function changedSentences(previousText: string, nextText: string, mode: "added" | "removed") {
  const previousSentences = sentenceCandidates(previousText);
  const nextSentences = sentenceCandidates(nextText);
  const previousKeys = new Set(previousSentences.map(sentenceKey));
  const nextKeys = new Set(nextSentences.map(sentenceKey));
  const source = mode === "added" ? nextSentences : previousSentences;
  const comparison = mode === "added" ? previousKeys : nextKeys;
  const comparisonTextKey = ` ${sentenceKey(mode === "added" ? previousText : nextText)} `;
  const comparisonCompactTextKey = compactSentenceKey(
    mode === "added" ? previousText : nextText,
  );

  return source
    .filter((sentence) => !comparison.has(sentenceKey(sentence)))
    .filter((sentence) => !comparisonTextKey.includes(` ${sentenceKey(sentence)} `))
    .filter((sentence) => !comparisonContainsCompactSentence(comparisonCompactTextKey, sentence))
    .filter(isUsefulSentence)
    .slice(0, 3);
}

function sentenceCandidates(text: string) {
  return splitChangeSentences(normalizeText(text))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 35 && sentence.length <= 320);
}

function splitChangeSentences(text: string) {
  return protectSentenceAbbreviations(text)
    .split(/(?<=[.!?])\s+|(?<=:)\s+(?=[A-Z0-9])/)
    .map(restoreSentenceAbbreviations);
}

const sentenceDotPlaceholder = "__AP_SENTENCE_DOT__";

function protectSentenceAbbreviations(value: string) {
  return value
    .replace(/\bM\.\s*D\./g, `M${sentenceDotPlaceholder}D${sentenceDotPlaceholder}`)
    .replace(/\bPh\.\s*D\./gi, `Ph${sentenceDotPlaceholder}D${sentenceDotPlaceholder}`)
    .replace(/\bU\.\s*S\./g, `U${sentenceDotPlaceholder}S${sentenceDotPlaceholder}`)
    .replace(/\bU\.\s*K\./g, `U${sentenceDotPlaceholder}K${sentenceDotPlaceholder}`)
    .replace(/\bi\.\s*e\./gi, `i${sentenceDotPlaceholder}e${sentenceDotPlaceholder}`)
    .replace(/\be\.\s*g\./gi, `e${sentenceDotPlaceholder}g${sentenceDotPlaceholder}`);
}

function restoreSentenceAbbreviations(value: string) {
  return value.replaceAll(sentenceDotPlaceholder, ".");
}

function sentenceKey(sentence: string) {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compactSentenceKey(sentence: string) {
  return sentence.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function comparisonContainsCompactSentence(comparisonCompactTextKey: string, sentence: string) {
  const compactKey = compactSentenceKey(sentence);
  return compactKey.length >= 40 && comparisonCompactTextKey.includes(compactKey);
}

function isUsefulSentence(sentence: string) {
  const lower = sentence.toLowerCase();
  if (isBoilerplateOrNavigationText(sentence)) {
    return false;
  }

  if (isNewsOrMarketingText(sentence)) {
    return false;
  }

  const meaningfulTerms =
    /\b(applications?|apply|deadline|eligible|eligibility|requirements?|recommendations?|transcripts?|essays?|interviews?|tuition|stipend|funding|fellows?|fellowship|scholarships?|awards?|admissions?|selection|nomination|candidates?|program|internship|grant|submit|submission|citizenship|gpa)\b/.test(
      lower,
    );
  return meaningfulTerms;
}

function sentenceWithRelevantDate(text: string, dates: string[]) {
  const dateSet = new Set(dates.map((date) => date.toLowerCase()));
  return sentenceCandidates(text)
    .filter((sentence) =>
      datePhrases(sentence).some((date) => dateSet.has(date.toLowerCase())),
    )
    .find((sentence) => isAwardDateContext(sentence));
}

function isAwardDateContext(sentence: string) {
  const lower = sentence.toLowerCase();
  if (/(latest news|news|blog|story|stories|read more|published|press release)/.test(lower)) {
    return false;
  }

  return /\b(deadline|due|application|apply|opens?|closes?|timeline|round|eligible|eligibility|interview|selection|notification|nomination|submit|submission)\b/.test(
    lower,
  );
}

function sentenceSummary(prefix: string, sentences: string[]) {
  const snippets = sentences.slice(0, 2).map((sentence) => `"${truncateSnippet(sentence, 220)}"`);
  return `${prefix}: ${snippets.join("; ")}.`;
}

function changedTextExcerpt(previousText: string, nextText: string) {
  if (!previousText || !nextText || previousText === nextText) return null;

  if (isLikelySampleExpansion(previousText, nextText)) {
    return "No award-relevant wording changed in the stored excerpt.";
  }

  const prefixLength = commonPrefixLength(previousText, nextText);
  const suffixLength = commonSuffixLength(
    previousText.slice(prefixLength),
    nextText.slice(prefixLength),
  );
  const previousChanged = previousText.slice(
    prefixLength,
    previousText.length - suffixLength,
  );
  const nextChanged = nextText.slice(prefixLength, nextText.length - suffixLength);
  const removed = truncateSnippet(previousChanged, 180);
  const added = truncateSnippet(nextChanged, 220);

  if (isNewsOrMarketingText(added) || isBoilerplateOrNavigationText(added)) return null;

  if (added.length >= 25 && removed.length >= 25) {
    return `Changed text from "${removed}" to "${added}".`;
  }
  if (added.length >= 25) return `Added text includes: "${added}".`;
  if (removed.length >= 25) return `Removed text includes: "${removed}".`;
  return null;
}

function commonPrefixLength(left: string, right: string) {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left: string, right: string) {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[left.length - 1 - index] === right[right.length - 1 - index]) {
    index += 1;
  }
  return index;
}

function truncateSnippet(value: string, maxLength: number) {
  const clean = normalizeText(value).replace(/^[-:;,.\s]+/, "").replace(/[-:;,\s]+$/, "");
  if (clean.length <= maxLength) return clean;
  const truncated = clean.slice(0, maxLength + 1);
  const boundary = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, boundary > 80 ? boundary : maxLength).trim()}...`;
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").replace(/\u0000/g, "").trim();
}

function isLikelySampleExpansion(previousText: string, nextText: string) {
  if (previousText.length < 500 || nextText.length <= previousText.length + 80) {
    return false;
  }

  if (nextText.startsWith(previousText)) return true;
  if (compactSentenceKey(nextText).startsWith(compactSentenceKey(previousText))) {
    return true;
  }
  if (!endsLikeTruncatedSample(previousText)) return false;

  for (const length of [180, 140, 100, 70]) {
    const tail = previousText.slice(-length).trim();
    if (tail.length < 60) continue;
    const index = nextText.indexOf(tail);
    if (index >= 0 && index + tail.length < nextText.length - 40) return true;
  }

  return false;
}

function endsLikeTruncatedSample(value: string) {
  const clean = normalizeText(value);
  if (!clean) return false;
  if (/[([{:/,-]\s*$/.test(clean)) return true;
  if (/[.!?)]['"]?$/.test(clean)) return false;
  const lastWord = clean.match(/[A-Za-z]+$/)?.[0] || "";
  return lastWord.length <= 3 || clean.length >= 1950;
}

function isNewsOrMarketingText(value: string) {
  return /\b(latest news|news|blog|story|stories|read more|published|press release|past recipients?|received the .* award|receives the .* award|photo by|getty images)\b/i.test(
    value,
  );
}

function isBoilerplateOrNavigationText(value: string) {
  const lower = value.toLowerCase();
  return (
    /(cookie|privacy|copyright|all rights reserved|subscribe|newsletter|menu|skip to)/.test(lower) ||
    /(toggle page navigation|search menu|read current issue|cart|dismiss|login|donate|donation|shop|store|gift amount|support the publication|purchase|checkout)/.test(lower) ||
    /(social media|facebook|instagram|twitter|x\.com|linkedin|youtube|@[\w.-]+)/.test(lower) ||
    /(contact us|staff directory|site map|accessibility|required statements)/.test(lower) ||
    /\b(suite|blvd|boulevard|street|avenue)\b/.test(lower)
  );
}
