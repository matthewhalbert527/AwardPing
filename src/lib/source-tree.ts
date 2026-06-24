import type { AwardPageType } from "@/lib/award-discovery-types";
import { cleanDisplayText, formatPathSegment, readableSourceTitle } from "@/lib/display-text";

export type SourceTreeSource = {
  id: string;
  title: string;
  displayTitle?: string | null;
  pageMetadata?: unknown;
  url: string;
  pageType?: AwardPageType | null;
};

export type SourceTreeNode<T extends SourceTreeSource> = {
  id: string;
  label: string;
  directSources: T[];
  sources: T[];
  children: SourceTreeNode<T>[];
};

export type SourceTreeOptions = {
  groupByHost?: boolean;
};

type MutableSourceTreeNode<T extends SourceTreeSource> = Omit<
  SourceTreeNode<T>,
  "children"
> & {
  children: MutableSourceTreeNode<T>[];
  childMap: Map<string, MutableSourceTreeNode<T>>;
};

export function buildSourceTree<T extends SourceTreeSource>(
  sources: T[],
  options: SourceTreeOptions = {},
) {
  const normalized = [...sources].sort((a, b) => sortSourceForTree(a).localeCompare(sortSourceForTree(b)));
  const hosts = new Set(
    normalized.map((source) => safeUrl(source.url)?.hostname || "").filter(Boolean),
  );
  const includeHost = options.groupByHost !== false && hosts.size > 1;
  const root = createMutableNode<T>("root", "Sources");

  for (const source of normalized) {
    const url = safeUrl(source.url);
    const sourceLabels = url ? sourceLabelsForTree(source, url) : [cleanTitle(source.title)];
    const labels = includeHost && url ? [formatHost(url.hostname), ...sourceLabels] : sourceLabels;
    const nodeLabels = labels.length > 0 ? labels : [source.pageType === "homepage" ? "Homepage" : cleanTitle(source.title)];
    let current = root;

    for (let index = 0; index < nodeLabels.length; index += 1) {
      const label = nodeLabels[index] || cleanTitle(source.title);
      const key = `${index}:${label.toLowerCase()}`;
      current = getOrCreateChild(current, key, label);
      current.sources.push(source);
    }

    current.directSources.push(source);
  }

  return finalizeNodes(root.children);
}

export function sourceTreeSourceLabel(source: SourceTreeSource) {
  return sourceLeafLabel(source, safeUrl(source.url));
}

function getOrCreateChild<T extends SourceTreeSource>(
  parent: MutableSourceTreeNode<T>,
  key: string,
  label: string,
) {
  const existing = parent.childMap.get(key);
  if (existing) return existing;

  const child = createMutableNode<T>(`${parent.id}/${slugify(label)}-${parent.childMap.size}`, label);
  parent.childMap.set(key, child);
  parent.children.push(child);
  return child;
}

function createMutableNode<T extends SourceTreeSource>(
  id: string,
  label: string,
): MutableSourceTreeNode<T> {
  return {
    id,
    label,
    directSources: [],
    sources: [],
    children: [],
    childMap: new Map(),
  };
}

function finalizeNodes<T extends SourceTreeSource>(
  nodes: MutableSourceTreeNode<T>[],
): SourceTreeNode<T>[] {
  return nodes
    .sort((a, b) => sortNode(a).localeCompare(sortNode(b)))
    .map((node) => ({
      id: node.id,
      label: node.label,
      directSources: node.directSources,
      sources: node.sources,
      children: finalizeNodes(node.children),
    }));
}

function sortNode<T extends SourceTreeSource>(node: SourceTreeNode<T>) {
  const firstSource = node.directSources[0] || node.sources[0];
  if (firstSource?.pageType === "homepage") return `0:${node.label}`;
  return `1:${node.label}`;
}

function sortSourceForTree(source: SourceTreeSource) {
  const url = safeUrl(source.url);
  const label = sourceLeafLabel(source, url);
  if (source.pageType === "homepage") return `0:${url?.hostname || ""}:${label}`;
  return `1:${categoryLabelForSource(source) || ""}:${label}:${url?.hostname || ""}:${url?.pathname || ""}`;
}

function safeUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function sourceLabelsForTree(source: SourceTreeSource, url: URL) {
  if (isRootPath(url)) {
    const label = sourceLeafLabel(source, url);
    return sameLabel(label, "Homepage") || sameLabel(label, "Source page")
      ? ["Overview"]
      : ["Overview", label];
  }

  const leafLabel = sourceLeafLabel(source, url);
  const category = categoryLabelForSource(source);

  if (source.pageType === "homepage") {
    return sameLabel(leafLabel, "Homepage") ? ["Overview"] : [leafLabel];
  }

  if (isPdfSource(source, url) || isCmsUploadPath(url)) {
    if (category) {
      return sameLabel(category, leafLabel) ? [category] : [category, leafLabel];
    }
    return ["Files and PDFs", sourceLeafLabel(source, url)];
  }

  if (category) {
    return sameLabel(category, leafLabel) ? [category] : [category, leafLabel];
  }

  const titleCategory = categoryLabelFromText(leafLabel);
  if (titleCategory) {
    return sameLabel(titleCategory, leafLabel) ? [titleCategory] : [titleCategory, leafLabel];
  }

  if (hasUsefulProvidedTitle(source)) {
    return [leafLabel];
  }

  if (source.pageType && source.pageType !== "other") {
    return [pageTypeLabelForTree(source.pageType)];
  }

  const pathLabels = meaningfulPathLabelsForUrl(url);
  if (pathLabels.length === 0) return [leafLabel];
  if (pathLabels.length === 1) return [pathLabels[0]];

  return pathLabels;
}

function meaningfulPathLabelsForUrl(url: URL) {
  const labels = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !isNoisyPathSegment(segment))
    .map(formatPathSegment)
    .filter((segment) => !isGenericContainerSegment(segment));

  return labels.length > 0 ? labels : ["Source page"];
}

function categoryLabelForSource(source: SourceTreeSource) {
  const metadataCategory = categoryLabelFromText(pageCategoryFromMetadata(source.pageMetadata));
  if (metadataCategory) return metadataCategory;
  if (source.pageType === "homepage") return "Overview";
  if (source.pageType === "application") return "Application";
  if (source.pageType === "deadline") return "Deadlines";
  if (source.pageType === "eligibility") return "Eligibility";
  if (source.pageType === "requirements") return "Requirements";
  if (source.pageType === "faq") return "FAQ";
  return null;
}

function pageCategoryFromMetadata(value: unknown) {
  const facts = baselineFactsFromMetadata(value);
  return cleanText(facts.page_category);
}

function categoryLabelFromText(value: string | null) {
  const clean = normalizeLabel(value || "");
  if (!clean) return null;
  if (/^(overview|about|homepage|home)$/.test(clean)) return "Overview";
  if (/eligib|citizen|gpa|academicstanding|fieldofstudy/.test(clean)) return "Eligibility";
  if (/deadline|duedate|importantdate|timeline/.test(clean)) return "Deadlines";
  if (/awardamount|amount|funding|stipend|benefit/.test(clean)) return "Award Amount";
  if (/material|document|essay|transcript|recommendation|letter/.test(clean)) return "Application Materials";
  if (
    /^(apply|howtoapply|application|applicationportal|applicationinstructions|nomination|submit)$/.test(clean) ||
    /howtoapply|application(instructions?|portal|process)|nominationinstructions?/.test(clean)
  ) {
    return "How to Apply";
  }
  if (/selection|criteria|review|evaluation/.test(clean)) return "Selection Criteria";
  if (/contact|links?/.test(clean)) return "Contact / Links";
  if (/faq|question/.test(clean)) return "FAQ";
  return null;
}

function sourceLeafLabel(source: SourceTreeSource, url: URL | null) {
  const filename = url?.pathname.split("/").filter(Boolean).at(-1);
  const fileLabel = filename ? formatPathSegment(filename) : "";
  const clean = readableSourceTitle(displayTitleFromSource(source), source.url)
    .replace(/\bdownload\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/[.\s-]+$/g, "")
    .trim();

  if (
    clean &&
    !/^source page$/i.test(clean) &&
    !/^homepage$/i.test(clean) &&
    !/^download$/i.test(clean) &&
    !(url && isPdfSource(source, url) && isGenericDocumentTitle(clean))
  ) {
    if (url && isPdfSource(source, url) && shouldPreferPdfFilename(clean) && fileLabel) {
      return fileLabel;
    }
    return clean;
  }

  if (url && isPdfSource(source, url) && fileLabel) {
    return fileLabel;
  }

  if (source.pageType && source.pageType !== "other") {
    return pageTypeLabelForTree(source.pageType);
  }

  return fileLabel || "Source page";
}

function hasUsefulProvidedTitle(source: SourceTreeSource) {
  const clean = readableSourceTitle(displayTitleFromSource(source), source.url)
    .replace(/\s+/g, " ")
    .trim();
  return Boolean(
    clean &&
      !/^source page$/i.test(clean) &&
      !/^homepage$/i.test(clean) &&
      !/^download$/i.test(clean) &&
      !/^(learn more|read more|click here|here|apply|view|open|details?|information)$/i.test(clean),
  );
}

function displayTitleFromSource(source: SourceTreeSource) {
  const facts = baselineFactsFromMetadata(source.pageMetadata);
  return (
    cleanText(source.displayTitle) ||
    cleanText(facts.display_title) ||
    cleanText(facts.page_title) ||
    cleanText(facts.title) ||
    cleanText(source.title)
  );
}

function baselineFactsFromMetadata(value: unknown) {
  const metadata = objectValue(value);
  return objectValue(metadata.baseline_facts || metadata.baselineFacts || value);
}

function pageTypeLabelForTree(pageType: AwardPageType) {
  const labels: Record<AwardPageType, string> = {
    homepage: "Overview",
    deadline: "Deadlines",
    application: "How to Apply",
    eligibility: "Eligibility",
    requirements: "Requirements",
    pdf: "PDF guide",
    faq: "FAQ",
    other: "Source page",
  };

  return labels[pageType];
}

function isPdfSource(source: SourceTreeSource, url: URL) {
  return source.pageType === "pdf" || /\.pdf$/i.test(url.pathname);
}

function isRootPath(url: URL) {
  return url.pathname.replace(/\/+$/g, "") === "";
}

function isCmsUploadPath(url: URL) {
  return /\/wp-content\/uploads\//i.test(url.pathname);
}

function isNoisyPathSegment(segment: string) {
  return (
    segment.length <= 1 ||
    /^(wp-content|uploads?|files?|documents?|pdfs?|assets?|media|resources?|view)$/i.test(segment)
  );
}

function isGenericContainerSegment(label: string) {
  return /^(our programs?|programs?|awards?|scholarships?|fellowships?|grants?)$/i.test(label);
}

function isGenericDocumentTitle(label: string) {
  return /^(guidelines?|forms?|application|registration form|information|details?|here|learn more|successful proposal)$/i.test(label);
}

function shouldPreferPdfFilename(label: string) {
  return (
    /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+){2,}$/.test(label) ||
    /^this\b/i.test(label) ||
    /\b(sample|example|successful)\b.*\b(application|proposal)\b/i.test(label)
  );
}

function sameLabel(left: string, right: string) {
  return normalizeLabel(left) === normalizeLabel(right);
}

function normalizeLabel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function formatHost(hostname: string) {
  return hostname.replace(/^www\./, "");
}

function cleanTitle(title: string) {
  return cleanDisplayText(title) || "Source page";
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "node";
}
