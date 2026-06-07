export function insertionIndexForAddedText(
  previousText: string,
  nextText: string,
  addedStart: number,
  addedLength: number,
) {
  const prefix = nextText.slice(0, addedStart);
  const suffix = nextText.slice(addedStart + addedLength);
  const trailingMatches = trailingAnchorCandidates(prefix)
    .map((anchor) => {
      const index = uniqueIndexOfInsensitive(previousText, anchor);
      return index === null ? null : { anchor, index, end: index + anchor.length };
    })
    .filter((match): match is { anchor: string; index: number; end: number } => Boolean(match));
  const leadingMatches = leadingAnchorCandidates(suffix)
    .map((anchor) => {
      const index = uniqueIndexOfInsensitive(previousText, anchor);
      return index === null ? null : { anchor, index };
    })
    .filter((match): match is { anchor: string; index: number } => Boolean(match));

  for (const trailing of trailingMatches) {
    for (const leading of leadingMatches) {
      if (trailing.end > leading.index) continue;
      const gap = previousText.slice(trailing.end, leading.index);
      if (isCredibleInsertionGap(gap)) return trailing.end;
    }
  }

  return null;
}

function trailingAnchorCandidates(value: string) {
  return uniqueCandidates(
    anchorLengths().flatMap((length) => {
      const raw = value.slice(Math.max(0, value.length - length));
      return [raw, raw.replace(/^\s*\S+\s+/, "")];
    }),
  ).filter(isReliableInsertionAnchor);
}

function leadingAnchorCandidates(value: string) {
  return uniqueCandidates(
    anchorLengths().flatMap((length) => {
      const raw = value.slice(0, length);
      return [raw, raw.replace(/\s+\S+\s*$/, "")];
    }),
  ).filter(isReliableInsertionAnchor);
}

function anchorLengths() {
  return [220, 160, 110, 72, 44];
}

function isReliableInsertionAnchor(anchor: string) {
  if (anchor.length < 44) return false;
  const words = anchor.match(/[A-Za-z0-9$]+/g) || [];
  return words.length >= 6;
}

function isCredibleInsertionGap(value: string) {
  if (value.length > 260) return false;
  const words = value.match(/[A-Za-z0-9$]+/g) || [];
  return words.length <= 18;
}

function uniqueCandidates(values: string[]) {
  return [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function uniqueIndexOfInsensitive(text: string, search: string) {
  const haystack = text.toLowerCase();
  const needle = search.toLowerCase();
  const first = haystack.indexOf(needle);
  if (first === -1) return null;
  const second = haystack.indexOf(needle, first + needle.length);
  return second === -1 ? first : null;
}
