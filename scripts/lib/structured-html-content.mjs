import { createHash } from "node:crypto";
import { load } from "cheerio";

export const STRUCTURED_HTML_SCHEMA = "awardping.structured-html.v1";
export const MAX_STRUCTURED_HTML_BYTES = 5 * 1024 * 1024;
export const MAX_STRUCTURED_HTML_NODES = 100000;
export const MAX_STRUCTURED_HTML_DEPTH = 256;

const defaultLimits = Object.freeze({ maxBlocks: 2000, maxTextChars: 250000, maxLinks: 2000 });
const excludedTags = new Set([
  "script", "style", "noscript", "template", "svg", "canvas", "iframe", "nav",
  "input", "select", "option", "textarea", "datalist",
]);
const boundaries = new Set([
  "address", "article", "aside", "blockquote", "caption", "dd", "details", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "form", "header", "hr", "legend", "main", "ol", "p",
  "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "ul",
]);

function unavailable(reason) {
  return {
    schema: STRUCTURED_HTML_SCHEMA, status: "unavailable", reason, scope: null,
    text: null, blocks: [], links: [], text_hash: null, content_hash: null,
    visibility: "not_verified",
  };
}

function normalizeText(text) {
  return text.replace(/\s+/gu, " ").trim();
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeUrl(value, base) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = base ? new URL(value.trim(), base) : new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function withoutTracking(url) {
  const result = new URL(url.href);
  for (const key of new Set(result.searchParams.keys())) {
    if (/^utm_/iu.test(key) || /^(?:fbclid|gclid)$/iu.test(key)) result.searchParams.delete(key);
  }
  // Serialize both tracked and untracked URLs identically. Preserve parameter
  // order (including duplicate keys) rather than assume the server ignores it.
  result.search = result.searchParams.toString();
  return result;
}

function pageIdentity(url) {
  const result = withoutTracking(url);
  result.hash = "";
  return result.href;
}

function tableSpan(value, rowSpan) {
  const parsed = /^\s*\+?(\d+)/u.exec(value || "");
  if (!parsed) return 1;
  const number = Number(parsed[1]);
  if (number === 0) return rowSpan ? 0 : 1;
  return Math.min(number, rowSpan ? 65534 : 1000);
}

function excluded(node, insideContent) {
  if (!node.name) return false;
  const attrs = node.attribs || {};
  if (excludedTags.has(node.name) || (node.name === "footer" && !insideContent)) return true;
  if (Object.hasOwn(attrs, "hidden") || Object.hasOwn(attrs, "inert")) return true;
  if (attrs["aria-hidden"]?.trim().toLowerCase() === "true") return true;
  if (/^(?:banner|navigation|contentinfo)$/iu.test(attrs.role?.trim() || "")) return true;
  // Only explicit inline declarations are known here. External styles/classes and
  // layout are deliberately NOT treated as proof of visibility.
  return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!\s*important\s*)?(?:;|$)/iu
    .test(attrs.style || "");
}

/**
 * Derive non-executable semantic content from retained, untrusted rendered HTML.
 * This does not fetch URLs, execute page code, establish visibility, or claim
 * screenshot alignment. Limits are fail-closed: unavailable never has partial data.
 */
export function extractStructuredHtml(html, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) return unavailable("invalid_options");
  const limits = {};
  for (const [key, maximum] of Object.entries(defaultLimits)) {
    const value = options[key] === undefined ? maximum : options[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) return unavailable("invalid_options");
    limits[key] = value;
  }
  const source = options.sourceUrl === undefined ? null : safeUrl(options.sourceUrl);
  if (options.sourceUrl !== undefined && !source) return unavailable("invalid_source_url");
  if (typeof html !== "string") return unavailable("invalid_html");
  if (Buffer.byteLength(html, "utf8") > MAX_STRUCTURED_HTML_BYTES) return unavailable("html_too_large");
  if (!html.trim()) return unavailable("empty_html");

  try {
    const $ = load(html);
    const ignored = new WeakSet();
    const mains = [];
    const articles = [];
    let baseHref;
    let nodeCount = 0;
    const pending = [{ node: $.root()[0], depth: 0, skip: false, insideContent: false }];
    while (pending.length) {
      const { node, depth, skip, insideContent } = pending.pop();
      if (++nodeCount > MAX_STRUCTURED_HTML_NODES) return unavailable("node_limit");
      if (depth > MAX_STRUCTURED_HTML_DEPTH) return unavailable("depth_limit");
      if (node.name === "base" && baseHref === undefined && Object.hasOwn(node.attribs || {}, "href")) {
        baseHref = node.attribs.href;
      }
      const isMain = node.name === "main" || node.attribs?.role?.trim().toLowerCase() === "main";
      const isArticle = node.name === "article";
      const isIgnored = skip || excluded(node, insideContent);
      if (isIgnored) ignored.add(node);
      if (!isIgnored && isMain) mains.push(node);
      if (!isIgnored && isArticle) articles.push(node);
      const children = node.children || [];
      for (let index = children.length - 1; index >= 0; index--) {
        pending.push({ node: children[index], depth: depth + 1, skip: isIgnored, insideContent: insideContent || isMain || isArticle });
      }
    }
    if (mains.length > 1) return unavailable("multiple_main_roots");
    const scope = mains.length === 1 ? "main" : articles.length === 1 ? "article" : "body";
    const root = mains[0] || (articles.length === 1 ? articles[0] : $("body")[0]);
    if (!root || ignored.has(root)) return unavailable("empty_content");
    // Browsers use the first base href, not the first valid one. An invalid first
    // base does not allow a later base to silently change destination identity.
    const base = (baseHref === undefined ? null : safeUrl(baseHref, source?.href)) || source;
    const blocks = [];
    const links = [];
    const headings = [];
    let textChars = 0;
    let linkChars = 0;
    let listContextChars = 0;
    let pieces = [];
    let active = { kind: "text", localHeadings: [], listPath: [] };
    const listLabels = new WeakMap();

    function path(context = active) {
      return [...headings.map((entry) => entry.text), ...context.localHeadings];
    }

    function retainedListPath(listPath) {
      if (!listPath.length) return {};
      // Repeated ancestor labels can otherwise multiply a small DOM into a
      // large result. Empty labels still represent nesting and consume budget.
      listContextChars += listPath.reduce((total, label) => total + label.length + 1, 0);
      if (listContextChars > limits.maxTextChars) throw new Error("list_context_limit");
      return { list_path: [...listPath] };
    }

    function emit(kind, text, headingPath, cells, listPath = active.listPath) {
      const normalized = normalizeText(text);
      if (!normalized) return;
      if (blocks.length >= limits.maxBlocks) throw new Error("block_limit");
      textChars += normalized.length + (blocks.length ? 1 : 0);
      if (textChars > limits.maxTextChars) throw new Error("text_limit");
      blocks.push({ kind, text: normalized, heading_path: [...headingPath], ...retainedListPath(listPath), ...(cells ? { cells } : {}) });
    }

    function flush() {
      emit(active.kind, pieces.join(""), path(), active.kind === "table_row" ? active.cells : undefined);
      pieces = [];
    }

    function destination(href) {
      const url = safeUrl(href, base?.href);
      if (!url) return null;
      const clean = withoutTracking(url);
      if (source && pageIdentity(clean) === pageIdentity(source) && (url.hash || href.trim().startsWith("#"))) return null;
      return clean.href;
    }

    function addLink(node, text, headingPath) {
      const url = destination(node.attribs?.href);
      if (!url) return;
      if (links.length >= limits.maxLinks) throw new Error("link_limit");
      const normalized = normalizeText(text);
      linkChars += normalized.length + url.length;
      if (linkChars > limits.maxTextChars) throw new Error("link_text_limit");
      links.push({ text: normalized, url, heading_path: [...headingPath], ...retainedListPath(active.listPath) });
    }

    function listItemLabel(node) {
      if (listLabels.has(node)) return listLabels.get(node);
      const parts = [];
      const stack = [node];
      let characters = 0;
      while (stack.length) {
        const current = stack.pop();
        if (current === null) { parts.push(" "); continue; }
        if (ignored.has(current)) continue;
        // Only the ancestor's own qualification belongs in the path. Never
        // turn nested requirements into part of the parent applicant category.
        if (current !== node && ["ul", "ol", "li"].includes(current.name)) continue;
        if (current.name === "button" && !Object.hasOwn(current.attribs || {}, "aria-expanded") && !Object.hasOwn(current.attribs || {}, "aria-controls")) continue;
        if (current.type === "text") {
          characters += current.data.length;
          if (characters > limits.maxTextChars) throw new Error("list_context_limit");
          parts.push(current.data);
          continue;
        }
        if (current.name === "br" || boundaries.has(current.name)) parts.push(" ");
        if (boundaries.has(current.name)) stack.push(null);
        const children = current.children || [];
        for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
      }
      const label = normalizeText(parts.join(""));
      listLabels.set(node, label);
      return label;
    }

    function listPathFor(node) {
      const ancestors = [];
      let ancestor = node.parent;
      while (ancestor && ancestor !== root) {
        if (ancestor.name === "li") ancestors.push(listItemLabel(ancestor));
        ancestor = ancestor.parent;
      }
      return ancestors.reverse();
    }

    // Collect an atomic semantic item (heading/link), respecting the same exclusions.
    // The normal walker skips heading descendants, so they are not emitted twice.
    function inlineText(node) {
      const result = [];
      const stack = [node];
      while (stack.length) {
        const current = stack.pop();
        if (current === null) { result.push(" "); continue; }
        if (ignored.has(current)) continue;
        if (current.type === "text") { result.push(current.data); continue; }
        if (current.name === "br" || boundaries.has(current.name) || current.name === "li") result.push(" ");
        const children = current.children || [];
        if (boundaries.has(current.name) || current.name === "li") stack.push(null);
        for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
      }
      return normalizeText(result.join(""));
    }

    function headingLinks(node, headingPath) {
      const stack = [node];
      while (stack.length) {
        const current = stack.pop();
        if (ignored.has(current)) continue;
        if (current.name === "a") addLink(current, inlineText(current), headingPath);
        const children = current.children || [];
        for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
      }
    }

    function walk(node, context) {
      if (ignored.has(node)) return;
      if (node.type === "text") { pieces.push(node.data); return; }
      const tag = node.name;
      if (tag === "br") { pieces.push(" "); return; }
      const level = /^h[1-6]$/u.test(tag || "") ? Number(tag[1]) : null;
      const accordionButton = tag === "button" && (Object.hasOwn(node.attribs || {}, "aria-expanded") || Object.hasOwn(node.attribs || {}, "aria-controls"));
      if (level || tag === "summary" || accordionButton) {
        flush();
        const text = inlineText(node);
        if (text) {
          if (level) {
            while (headings.length && headings.at(-1).level >= level) headings.pop();
            headings.push({ level, text });
          }
          const headingPath = level ? path(context) : [...path(context), text];
          emit("heading", text, headingPath);
          headingLinks(node, headingPath);
        }
        return;
      }
      if (tag === "button") return;
      const previous = active;
      const specialKind = tag === "tr" ? "table_row" : tag === "li" ? "list_item" : tag === "p" ? "paragraph" : null;
      const atomicParent = ["table_row", "list_item"].includes(context.kind);
      const boundary = tag === "tr" || tag === "li" || (!atomicParent && (specialKind || boundaries.has(tag)));
      if (boundary) {
        flush();
        active = { ...context, kind: specialKind || "text" };
        if (tag === "li") active.listPath = listPathFor(node);
        if (tag === "tr") {
          active.cells = (node.children || [])
            .filter((child) => ["td", "th"].includes(child.name) && !ignored.has(child))
            .map((cell) => ({
              kind: cell.name === "th" ? "header" : "data",
              text: inlineText(cell),
              row_span: tableSpan(cell.attribs?.rowspan, true),
              col_span: tableSpan(cell.attribs?.colspan, false),
            }));
        }
      }
      if (tag === "td" || tag === "th" || (atomicParent && boundaries.has(tag))) pieces.push(" ");
      if (tag === "a") addLink(node, inlineText(node), path(active));
      let childContext = active;
      if (tag === "details") {
        const summary = node.children?.find((child) => child.name === "summary" && !ignored.has(child));
        const title = summary ? inlineText(summary) : "";
        if (title) childContext = { ...active, localHeadings: [...active.localHeadings, title] };
      }
      for (const child of node.children || []) {
        const childState = child.name === "summary" ? active : childContext;
        // Details summary is a local heading, not a lasting global heading.
        const restore = active;
        active = childState;
        walk(child, childState);
        if (childState !== restore) flush();
        active = restore;
      }
      if (tag === "td" || tag === "th" || (atomicParent && boundaries.has(tag))) pieces.push(" ");
      if (boundary) { flush(); active = previous; }
    }

    walk(root, active);
    flush();
    if (!blocks.length && !links.length) return unavailable("empty_content");
    const text = blocks.map((block) => block.text).join("\n");
    // Plain wrapper segmentation is not an award change. Heading hierarchy and
    // destination changes remain significant; duplicate occurrences are retained.
    const canonical = {
      text: normalizeText(text),
      headings: blocks.filter((block) => block.kind === "heading").map(({ text: value, heading_path }) => ({ text: value, heading_path })),
      tables: blocks.filter((block) => block.kind === "table_row").map(({ heading_path, cells }) => ({ heading_path, cells })),
      list_contexts: blocks.filter((block) => block.list_path).map(({ text: value, heading_path, list_path }) => ({ text: value, heading_path, list_path })),
      links,
    };
    return {
      schema: STRUCTURED_HTML_SCHEMA, status: "ok", reason: null, scope, text, blocks, links,
      text_hash: sha256(normalizeText(text)), content_hash: sha256(JSON.stringify(canonical)),
      visibility: "not_verified",
    };
  } catch (error) {
    const reason = ["block_limit", "text_limit", "link_limit", "link_text_limit", "list_context_limit"].includes(error?.message) ? error.message : "parse_failed";
    return unavailable(reason);
  }
}
