"""Bounded, offline HTML-source extraction with Scrapling; never verified facts."""

import contextlib
from html.parser import HTMLParser
import json
import logging
import re
import sys
from urllib.parse import urlsplit

from scrapling import Selector


SCHEMA = "awardping.scrapling-html-document.v1"
MAX_HTML_BYTES = 5 * 1024 * 1024
MAX_REQUEST_BYTES = 32 * 1024 * 1024
MAX_OUTPUT_BYTES = 5 * 1024 * 1024
MAX_NODES = 50000
MAX_DEPTH = 100
MAX_TEXT_CHARS = 250000
MAX_ITEMS = 10000
MAX_ATTRIBUTE_CHARS = 10000
EXCLUDED = {"script", "style", "noscript", "template", "head"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "command", "keygen"}
BOUNDARIES = {"address", "article", "aside", "blockquote", "br", "caption", "dd", "details", "dialog", "div", "dl", "dt", "fieldset",
              "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "main",
              "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"}
SEMANTIC = {"p", "li", "dt", "dd", "th", "td", "caption", "blockquote", "summary", "pre"}
NEUTRAL_DIV_INLINE = {"a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "del", "dfn", "em", "i", "ins", "kbd",
                      "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr"}


class HtmlDocumentError(ValueError):
    """Stable error labels, never HTML or page instructions."""


def require(condition, reason):
    if not condition:
        raise HtmlDocumentError(reason)


def normalize(value):
    return re.sub(r"\s+", " ", value).strip()


def serialized_size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


class SourceBounds(HTMLParser):
    """Reject excessive input before a recovering HTML parser could truncate it.

    Retained browser DOM is serialized with closing tags. Malformed input that
    exceeds this conservative lexical depth is refused, never silently repaired
    into a smaller successful result.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.nodes = 0

    def count(self):
        self.nodes += 1
        require(self.nodes <= MAX_NODES, "html_node_limit")

    def handle_starttag(self, tag, attrs):
        self.count()
        if tag not in VOID:
            self.stack.append(tag)
            require(len(self.stack) <= MAX_DEPTH, "html_depth_limit")

    def handle_startendtag(self, tag, attrs):
        self.count()

    def handle_endtag(self, tag):
        if tag in self.stack:
            reverse_index = self.stack[::-1].index(tag)
            del self.stack[len(self.stack) - reverse_index - 1:]

    def handle_data(self, data):
        if data:
            self.count()

    def handle_comment(self, data):
        self.count()


class Node:
    __slots__ = ("tag", "attrs", "children", "content", "text", "element_count", "interactive_attrs")

    def __init__(self, tag, attrs=None, children=None, content=""):
        self.tag = tag
        self.attrs = attrs or {}
        self.children = children or []
        self.content = content
        self.text = normalize(content)
        self.element_count = 0
        self.interactive_attrs = False


def extract_html_document(html, url, *, neutral_div_blocks=False):
    """Extract all body source content, including hidden and closed sections.

    No fetching, script execution, adaptive matching, visibility assertion, URL
    resolution, or interpretation of which requirements are currently active.
    The default retains v1 semantics; neutral DIV blocks are an explicit v2
    producer option, never a heading, FAQ or visibility assertion.
    """
    require(isinstance(neutral_div_blocks, bool), "invalid_neutral_div_option")
    require(isinstance(html, str) and html.strip() and "\x00" not in html, "invalid_html")
    try:
        html_bytes = len(html.encode("utf-8"))
    except UnicodeError:
        raise HtmlDocumentError("invalid_html_encoding") from None
    require(html_bytes <= MAX_HTML_BYTES, "html_size_limit")
    require(isinstance(url, str) and 0 < len(url) <= MAX_ATTRIBUTE_CHARS, "invalid_source_url")
    try:
        parsed_url = urlsplit(url)
        require(parsed_url.scheme in {"http", "https"} and parsed_url.hostname and not parsed_url.username and not parsed_url.password, "invalid_source_url")
    except (ValueError, TypeError):
        raise HtmlDocumentError("invalid_source_url") from None

    bounds = SourceBounds()
    try:
        bounds.feed(html)
        bounds.close()
        parser = Selector(html, url=url, adaptive=False, huge_tree=False, keep_comments=False, keep_cdata=False)
    except HtmlDocumentError:
        raise
    except Exception:
        raise HtmlDocumentError("html_parse_failed") from None
    body = parser.xpath("/html/body").first
    require(body is not None, "html_body_unavailable")
    title_node = parser.xpath("/html/head/title").first
    title = normalize("".join(title_node.xpath(".//text()").getall())) if title_node is not None else ""
    require(len(title) <= MAX_ATTRIBUTE_CHARS, "title_size_limit")
    base_hrefs = []
    for element in parser.xpath("//base[@href][not(ancestor::template) and not(ancestor::noscript)]"):
        value = str(element.attrib["href"])
        require(len(value) <= MAX_ATTRIBUTE_CHARS, "attribute_size_limit")
        base_hrefs.append(value)
        require(len(base_hrefs) <= MAX_ITEMS, "html_item_limit")

    node_count = 0
    raw_text_chars = 0

    def build(element, depth=1):
        nonlocal node_count, raw_text_chars
        node_count += 1
        require(node_count <= MAX_NODES, "html_node_limit")
        require(depth <= MAX_DEPTH, "html_depth_limit")
        tag = str(element.tag).lower()
        if tag in EXCLUDED:
            return None
        if tag == "#text":
            value = str(element.text)
            raw_text_chars += len(value)
            # Bound actual selected text before repeated ancestor contexts are built.
            require(raw_text_chars <= MAX_TEXT_CHARS, "html_text_limit")
            return Node(tag, content=value)
        children = []
        parts = []
        for child in element.xpath("node()"):
            node = build(child, depth + 1)
            if node is None:
                continue
            children.append(node)
            if node.tag in BOUNDARIES:
                parts.extend((" ", node.content, " "))
            else:
                parts.append(node.content)
        content = "".join(parts)
        require(len(normalize(content)) <= MAX_TEXT_CHARS, "html_text_limit")
        # Keep only semantic attributes that are used below; arbitrary page data
        # and event handlers never become extraction instructions.
        attrs = {key: str(element.attrib[key]) for key in ("href", "colspan", "rowspan", "scope", "headers", "id", "role", "aria-level") if key in element.attrib}
        require(all(len(value) <= MAX_ATTRIBUTE_CHARS for value in attrs.values()), "attribute_size_limit")
        node = Node(tag, attrs=attrs, children=children, content=content)
        # Preserve original child cardinality even when excluded script/template
        # children were removed. They must not manufacture a two-child contract.
        node.element_count = len(element.xpath("./*"))
        node.interactive_attrs = any(key.lower().startswith("on") or key.lower() in {"tabindex", "contenteditable"}
                                     for key in element.attrib)
        return node

    tree = build(body)
    require(tree is not None, "html_body_unavailable")
    blocks, links = [], []
    headings = []
    details_labels = {}
    sibling_buttons = {}
    item_bytes = 0

    def add(items, item):
        nonlocal item_bytes
        require(len(blocks) + len(links) + len(base_hrefs) < MAX_ITEMS, "html_item_limit")
        item_bytes += serialized_size(item)
        require(item_bytes <= MAX_OUTPUT_BYTES, "html_document_size_limit")
        items.append(item)

    def sibling_button(ancestor):
        """A local source shape, not a question/heading or a working UI control."""
        if ancestor in sibling_buttons:
            return sibling_buttons[ancestor]
        result = None
        elements = [child for child in ancestor.children if child.tag != "#text"]
        if (ancestor.tag in {"div", "section"} and ancestor.element_count == 2 and len(elements) == 2
                and elements[0].tag == "button" and elements[1].tag in {"div", "section"}
                and not any(child.text for child in ancestor.children if child.tag == "#text")
                and 0 < len(elements[0].text) <= MAX_ATTRIBUTE_CHARS and elements[1].text):
            label, content = elements
            pending = list(label.children)
            safe = True
            while pending:
                child = pending.pop()
                if (child.tag in {"a", "button", "input", "select", "textarea", "form", "details", "summary", "iframe", "object", "embed", "audio", "video"}
                        or child.attrs.get("role") or child.interactive_attrs
                        or child.element_count != sum(item.tag != "#text" for item in child.children)):
                    safe = False
                    break
                pending.extend(child.children)
            if safe and label.element_count == sum(child.tag != "#text" for child in label.children):
                result = (content, label.text)
        sibling_buttons[ancestor] = result
        return result

    def neutral_div(node, ancestors):
        if not neutral_div_blocks or node.tag != "div" or not node.text:
            return False
        # An already emitted ancestor owns its complete text. Adding its child
        # would duplicate that evidence; a structural DIV parent is not a leaf.
        if any(ancestor.tag in SEMANTIC or re.fullmatch(r"h[1-6]", ancestor.tag)
               or ancestor.attrs.get("role") == "heading" for ancestor in ancestors):
            return False
        pending = [node]
        while pending:
            child = pending.pop()
            if (child is not node and child.tag != "#text" and child.tag not in NEUTRAL_DIV_INLINE
                    or child.attrs.get("role") or child.interactive_attrs
                    or child.element_count != sum(item.tag != "#text" for item in child.children)):
                return False
            pending.extend(child.children)
        return True

    def visit(node, ancestors):
        nonlocal headings
        if node.tag == "#text":
            return
        level = int(node.tag[1]) if re.fullmatch(r"h[1-6]", node.tag) else None
        if node.attrs.get("role") == "heading" and node.attrs.get("aria-level") in {"1", "2", "3", "4", "5", "6"}:
            level = int(node.attrs["aria-level"])
        if level and node.text:
            headings = [item for item in headings if item["level"] < level] + [{"level": level, "text": node.text}]
        heading_path = [dict(item) for item in headings]
        list_path = [ancestor.text for ancestor in ancestors if ancestor.tag == "li"]
        # A summary qualifies only descendants of its actual details container.
        # Keep it separate from headings: a summary does not invent an h1-h6
        # level. Empty labels preserve an unlabeled container's nesting without
        # substituting the browser's default "Details" label or a nested label.
        details_path = []
        for ancestor in ancestors:
            if ancestor.tag != "details":
                continue
            if ancestor not in details_labels:
                summary = next((child for child in ancestor.children if child.tag == "summary"), None)
                details_labels[ancestor] = summary.text if summary is not None else ""
            details_path.append(details_labels[ancestor])
        details_context = {"details_path": details_path} if details_path else {}
        # Only descendants of THIS parent's second child receive its preceding
        # sibling button label. No ID/class lookup, nearest-button search,
        # semantic heading level, deduplication or visibility inference.
        sibling_button_path = []
        if not any(ancestor.tag in {"form", "nav"} for ancestor in ancestors):
            for index, ancestor in enumerate(ancestors):
                match = sibling_button(ancestor)
                branch = ancestors[index + 1] if index + 1 < len(ancestors) else node
                if match is not None and branch is match[0]:
                    sibling_button_path.append(match[1])
        require(len(sibling_button_path) <= 100, "html_depth_limit")
        sibling_context = {"sibling_button_path": sibling_button_path} if sibling_button_path else {}
        if node.text and (node.tag in SEMANTIC or level or neutral_div(node, ancestors)):
            row = next((ancestor for ancestor in reversed(ancestors) if ancestor.tag == "tr"), None)
            table_row = [child.text for child in row.children if child.tag in {"td", "th"}] if row else []
            block = {"kind": "heading" if level else node.tag, "text": node.text,
                     "heading_path": heading_path, "list_path": list_path, "table_row": table_row,
                     **details_context, **sibling_context}
            if node.tag in {"td", "th"}:
                block["table_cell"] = {"raw_colspan": node.attrs.get("colspan", "1"), "raw_rowspan": node.attrs.get("rowspan", "1"),
                    "scope": node.attrs.get("scope", ""), "headers": node.attrs.get("headers", ""), "id": node.attrs.get("id", "")}
            add(blocks, block)
        if node.tag == "a" and "href" in node.attrs:
            add(links, {"text": node.text, "raw_href": node.attrs["href"], "source_url": url,
                        "base_hrefs": list(base_hrefs), "heading_path": heading_path, "list_path": list_path,
                        **details_context, **sibling_context})
        for child in node.children:
            visit(child, [*ancestors, node])

    visit(tree, [])
    if not blocks and tree.text:
        add(blocks, {"kind": "text", "text": tree.text, "heading_path": [], "list_path": [], "table_row": []})
    document = {"schema": SCHEMA, "scope": "html-source-main-document", "source_url": url,
        "publishable": False, "visibility_verified": False, "title": title, "text": tree.text,
        "blocks": blocks, "links": links, "base_hrefs": base_hrefs,
        "limitations": ["HTML source content is not a visibility or verified-award-fact assertion.",
            "Hidden, closed, duplicate and possibly stale body content is intentionally retained.",
            "Headings and ancestor context are source-structure hints, not verified semantic associations.",
            "Scripts, styles, noscript, templates, head content and comments are excluded from body text.",
            "Raw hrefs and base hrefs are preserved without browser URL-resolution claims.",
            "Embedded-document and shadow-root contents absent from retained HTML are not covered.",
            "Whitespace is normalized with HTML block boundaries; CSS layout and generated content are not reconstructed."],
        "counts": {"html_bytes": html_bytes, "nodes": node_count, "blocks": len(blocks), "links": len(links), "base_hrefs": len(base_hrefs)}}
    require(serialized_size(document) <= MAX_OUTPUT_BYTES, "html_document_size_limit")
    return document


def main():
    logging.disable(logging.CRITICAL)
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        require(len(raw) <= MAX_REQUEST_BYTES, "request_size_limit")
        request = json.loads(raw.decode("utf-8"))
        require(isinstance(request, dict) and (set(request) == {"html", "url"} or
                set(request) == {"html", "url", "capture_profile"}
                and request["capture_profile"] == "scrapling-evidence-v2"), "invalid_request")
        with contextlib.redirect_stdout(sys.stderr):
            result = extract_html_document(request["html"], request["url"],
                                           neutral_div_blocks=request.get("capture_profile") == "scrapling-evidence-v2")
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except HtmlDocumentError as error:
        reason = str(error)
    except Exception:
        reason = "invalid_request_or_html"
    print(json.dumps({"error": reason}))
    return 2


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
