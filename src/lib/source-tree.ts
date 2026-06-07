import type { AwardPageType } from "@/lib/award-discovery-types";
import { cleanDisplayText, formatPathSegment, readableSourceTitle } from "@/lib/display-text";

export type SourceTreeSource = {
  id: string;
  title: string;
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

type MutableSourceTreeNode<T extends SourceTreeSource> = Omit<
  SourceTreeNode<T>,
  "children"
> & {
  children: MutableSourceTreeNode<T>[];
  childMap: Map<string, MutableSourceTreeNode<T>>;
};

export function buildSourceTree<T extends SourceTreeSource>(sources: T[]) {
  const normalized = [...sources].sort((a, b) => sortSourceForTree(a).localeCompare(sortSourceForTree(b)));
  const hosts = new Set(
    normalized.map((source) => safeUrl(source.url)?.hostname || "").filter(Boolean),
  );
  const includeHost = hosts.size > 1;
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
  if (source.pageType === "homepage") return `0:${url?.hostname || ""}:${url?.pathname || ""}`;
  return `1:${url?.hostname || ""}:${url?.pathname || ""}:${source.title}`;
}

function safeUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function sourceLabelsForTree(source: SourceTreeSource, url: URL) {
  if (source.pageType === "homepage" || isRootPath(url)) {
    return ["Homepage"];
  }

  if (isPdfSource(source, url) || isCmsUploadPath(url)) {
    return ["Files and PDFs", sourceLeafLabel(source, url)];
  }

  const leafLabel = sourceLeafLabel(source, url);
  const category = categoryLabelForSource(source);
  if (category) {
    return sameLabel(category, leafLabel) ? [category] : [category, leafLabel];
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
  if (source.pageType === "application") return "Application";
  if (source.pageType === "deadline") return "Deadlines";
  if (source.pageType === "eligibility") return "Eligibility";
  if (source.pageType === "requirements") return "Requirements";
  if (source.pageType === "faq") return "FAQ";
  return null;
}

function sourceLeafLabel(source: SourceTreeSource, url: URL) {
  const filename = url.pathname.split("/").filter(Boolean).at(-1);
  const clean = readableSourceTitle(source.title, source.url)
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
    !(isPdfSource(source, url) && isGenericDocumentTitle(clean))
  ) {
    return clean;
  }

  return filename ? formatPathSegment(filename) : "Source page";
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
  return /^(guidelines?|forms?|application|registration form|information|details?|here|learn more)$/i.test(label);
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

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "node";
}
