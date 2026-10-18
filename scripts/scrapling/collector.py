"""One isolated, passive Scrapling capture. Node owns pinned DNS/proxy enforcement."""

import base64
import contextlib
from datetime import datetime, timezone
import hashlib
from html import escape
from importlib.metadata import version
import ipaddress
import json
import logging
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit

from scrapling import Selector
from scrapling.fetchers import DynamicFetcher, Fetcher
from curl_cffi.curl import CURL_WRITEFUNC_ERROR
from html_document import HtmlDocumentError, extract_html_document


SCHEMA = "awardping.scrapling-capture.v1"
PROFILE = "scrapling-visible-v1"
EVIDENCE_PROFILE = "scrapling-evidence-v1"
SOURCE_HTML_PROFILE = "scrapling-source-html-v1"
SCRIPT = Path(__file__).with_name("visible-document.js").read_text(encoding="utf-8")
MAX_BYTES = 5 * 1024 * 1024
MAX_OUTPUT_BYTES = 24 * 1024 * 1024
MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024
MAX_SCREENSHOT_PIXELS = 25000000
CHALLENGE = re.compile(r"\b(checking your browser|verify you are human|access denied|just a moment|enable javascript and cookies to continue|sign in to continue|enable javascript to continue)\b", re.I)
SAFE_REASON = re.compile(r"^[a-z][a-z0-9_]{0,100}$")
SNAPSHOT_STYLES = ["visibility", "display", "opacity", "content-visibility", "clip-path", "clip"]
HTML_LINK_SCRIPT = """() => {
    const anchors = document.querySelectorAll('a');
    if (anchors.length > 10000) return {error: 'html_link_count_limit'};
    const normalized = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const links = [];
    const encoder = new TextEncoder();
    let bytes = 2;
    for (const anchor of anchors) {
        const attribute = anchor.hasAttribute('href') ? 'href' : anchor.hasAttribute('xlink:href') ? 'xlink:href' : '';
        const raw = attribute ? anchor.getAttribute(attribute) : '';
        let url = '';
        if (attribute) { try { url = new URL(raw, document.baseURI).href; } catch { return {error: 'html_link_url_unresolved'}; } }
        const contextNode = anchor.closest('p,li,td,th,dd,dt,figcaption');
        const contextText = normalized(contextNode ? contextNode.textContent : '');
        const link = {url, raw_href: raw, href_attribute: attribute, base_url: document.baseURI,
            text: normalized(anchor.textContent), title: normalized(anchor.getAttribute('title')),
            aria_label: normalized(anchor.getAttribute('aria-label')), download: anchor.getAttribute('download') || '',
            download_present: anchor.hasAttribute('download'), context: contextText.slice(0, 800),
            context_truncated: contextText.length > 800, context_available: Boolean(contextNode)};
        if (Object.values(link).some(value => typeof value === 'string' && value.length > 10000)) return {error: 'html_link_field_limit'};
        bytes += encoder.encode(JSON.stringify(link)).byteLength + (links.length ? 1 : 0);
        if (bytes > 5 * 1024 * 1024) return {error: 'html_links_size_limit'};
        links.push(link);
    }
    return {links};
}"""


class CaptureFailure(Exception):
    """Bounded failure label; no source content or credentials in output."""


def normalize(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def validate_url(value):
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError()
        if parsed.port not in (None, 80 if parsed.scheme == "http" else 443):
            raise ValueError()
        host = parsed.hostname.lower().rstrip(".")
        if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".test", ".invalid")) or "." not in host:
            raise ValueError()
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address and not address.is_global:
            raise ValueError()
    except (TypeError, ValueError):
        raise CaptureFailure("invalid_public_url") from None
    return value


def capture_source_html(request):
    """One bounded ordinary GET through Node's pinned public-network boundary.

    Never a browser fallback: the caller must explicitly select this profile.
    Retained source content is not proof of visibility, current facts or pixels.
    """
    url = validate_url(request["url"])
    if urlsplit(url).scheme != "https" or urlsplit(url).fragment:
        raise CaptureFailure("source_html_https_identity_required")
    proxy = urlsplit(request["proxy_url"])
    if (proxy.scheme != "http" or proxy.hostname != "127.0.0.1" or not proxy.port or
            proxy.username or proxy.password or proxy.path not in ("", "/") or proxy.query or proxy.fragment):
        raise CaptureFailure("invalid_proxy")
    # The bridge supplies a sanitized process environment. In particular,
    # libcurl must never use NO_PROXY to bypass the mandatory local boundary.
    if any(os.environ.get(key) for key in ("NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy")):
        raise CaptureFailure("source_html_proxy_environment_not_clean")
    chunks, size, exceeded = [], 0, False

    def receive(chunk):
        nonlocal size, exceeded
        size += len(chunk)
        if size > MAX_BYTES:
            exceeded = True
            # curl_cffi treats short writes as successful; use its explicit
            # abort sentinel, not 0, so the oversized body stops immediately.
            return CURL_WRITEFUNC_ERROR
        chunks.append(chunk)
        return len(chunk)

    try:
        response = Fetcher.get(url, impersonate=None, stealthy_headers=False,
            follow_redirects=False, retries=1, timeout=20, verify=True,
            proxy=request["proxy_url"], cookies={}, discard_cookies=True,
            default_headers=False, accept_encoding="identity",
            headers={"User-Agent": "AwardPing/1.0 (+https://awardping.com)", "Accept": "text/html, application/xhtml+xml"},
            content_callback=receive,
            selector_config={"adaptive": False, "huge_tree": False, "keep_comments": False, "keep_cdata": False})
    except Exception:
        raise CaptureFailure("source_html_body_limit" if exceeded else "source_html_request_failed") from None
    if exceeded:
        raise CaptureFailure("source_html_body_limit")
    if response.status != 200:
        raise CaptureFailure("source_html_http_status")
    if response.url != url or response.history:
        raise CaptureFailure("source_html_redirect_not_allowed")
    headers = {str(key).lower(): str(value) for key, value in response.headers.items()}
    content_type = headers.get("content-type", "")
    if not re.match(r"^(text/html|application/xhtml\+xml)(;|$)", content_type, re.I):
        raise CaptureFailure("non_html_response")
    charset = re.search(r"charset\s*=\s*[\"']?([^\s;\"']+)", content_type, re.I)
    if charset and charset.group(1).lower() not in ("utf-8", "utf8"):
        raise CaptureFailure("source_html_unsupported_encoding")
    content_encoding = headers.get("content-encoding", "identity").strip().lower() or "identity"
    if content_encoding != "identity":
        raise CaptureFailure("source_html_unsupported_content_encoding")
    if headers.get("x-amzn-waf-action") or headers.get("cf-mitigated"):
        raise CaptureFailure("upstream_challenge_response")
    raw = b"".join(chunks)
    if not raw or len(raw) != size:
        raise CaptureFailure("source_html_empty_response")
    declared_length = headers.get("content-length")
    if declared_length and (not declared_length.isdigit() or int(declared_length) != len(raw)):
        raise CaptureFailure("source_html_content_length_mismatch")
    try:
        html = raw.decode("utf-8", errors="strict")
    except UnicodeError:
        raise CaptureFailure("source_html_unsupported_encoding") from None
    if CHALLENGE.search(html) or re.search(r"awswaf\.integration|AwsWafIntegration", html, re.I):
        raise CaptureFailure("upstream_challenge_response")
    try:
        document = extract_html_document(html, url)
        parsed = Selector(html, url=url, adaptive=False, huge_tree=False, keep_comments=False, keep_cdata=False)
        mains = parsed.css("main")
        if len(mains) != 1:
            raise CaptureFailure("source_html_exact_main_required")
        main_document = extract_html_document("<html><body>" + str(mains[0].html_content) + "</body></html>", url)
        main_document["scope"] = "html-source-main-element"
        main_document["limitations"].append("Selected from exactly one source main element; the complete body is retained separately.")
        if len(main_document["text"].strip()) < 200:
            raise CaptureFailure("source_html_insufficient_main_text")
    except HtmlDocumentError as error:
        raise CaptureFailure(str(error)) from None
    result = {"schema": SCHEMA, "capture_profile": SOURCE_HTML_PROFILE,
        "source_id": request["source_id"], "url": url, "final_url": response.url,
        "captured_at": datetime.now(timezone.utc).isoformat(), "status_code": response.status,
        "content_type": content_type, "html": html, "html_document": document,
        "source_main_document": main_document,
        "source_http": {"schema": "awardping.scrapling-source-http.v1", "method": "GET",
            "response_complete": True, "redirect_count": 0, "body_encoding": "utf-8",
            "content_encoding": "identity", "body_byte_length": len(raw),
            "body_sha256": hashlib.sha256(raw).hexdigest(), "acquisition": "ordinary_anonymous_http",
            "visibility_verified": False, "screenshot_available": False},
        "warnings": ["source_html_only_not_browser_visible_or_screenshot_evidence",
                     "linked_documents_forms_and_client_loaded_content_not_fetched"],
        "engine": {"scrapling": version("scrapling"), "client": "Fetcher", "adaptive": False,
                   "stealth": False, "impersonation": False}}
    if len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) >= MAX_OUTPUT_BYTES:
        raise CaptureFailure("collector_output_limit")
    return result


def require_document_response_url(observed_url, response):
    """A history rewrite is not evidence of an HTTP redirect to that document.

    Both values are Chromium's serialized URLs. Only fragments are ignored:
    they are not sent in HTTP requests. Path and query remain exact, including
    a trailing empty query. No alternate source or canonical URL is inferred.
    """
    response_url = response.get("url") if isinstance(response, dict) else None
    if not isinstance(response_url, str) or not isinstance(observed_url, str):
        raise CaptureFailure("document_response_url_mismatch")
    validate_url(response_url)
    validate_url(observed_url)
    if observed_url.partition("#")[0] != response_url.partition("#")[0]:
        raise CaptureFailure("document_response_url_mismatch")


def parse_projection(observation):
    """Scrapling parses only the same-capture, browser-rendered inert projection."""
    parser = Selector(observation["projection"], url=observation["url"], adaptive=False, huge_tree=False)
    root = parser.css("ap-document").first
    if root is None:
        raise CaptureFailure("invalid_visible_projection")
    text_of = lambda element: normalize("".join(element.xpath(".//text()").getall()))
    text = text_of(root)
    if len(text) > 250000:
        raise CaptureFailure("visible_text_limit")
    headings = []
    blocks, links = [], []
    semantic_tags = {"p", "li", "dt", "dd", "th", "td", "caption", "blockquote", "summary", "pre"}
    for element in root.css("ap-node"):
        tag = str(element.attrib.get("data-tag", ""))
        value = text_of(element)
        level = int(tag[1]) if re.fullmatch("h[1-6]", tag) else None
        if element.attrib.get("data-heading-level", "") in ("1", "2", "3", "4", "5", "6"):
            level = int(element.attrib["data-heading-level"])
        if level and value:
            headings = [h for h in headings if h["level"] < level] + [{"level": level, "text": value}]
        heading_path = [dict(h) for h in headings]
        list_path = [text_of(ancestor) for ancestor in element.xpath("ancestor::ap-node[@data-tag='li']")]
        if len(list_path) > 100:
            raise CaptureFailure("list_depth_limit")
        if value and (tag in semantic_tags or level):
            rows = element.xpath("ancestor::ap-node[@data-tag='tr'][1]")
            row = rows[0] if rows else None
            table_row = [text_of(cell) for cell in row.xpath("./ap-node[@data-tag='td' or @data-tag='th']")] if row else []
            blocks.append({"kind": "heading" if level else tag, "text": value, "heading_path": heading_path,
                           "list_path": list_path, "table_row": table_row})
            if tag in ("td", "th"):
                blocks[-1]["table_cell"] = {"colspan": int(element.attrib.get("data-colspan", "1")),
                    "rowspan": int(element.attrib.get("data-rowspan", "1")),
                    "scope": str(element.attrib.get("data-scope", "")), "headers": str(element.attrib.get("data-headers", "")),
                    "id": str(element.attrib.get("data-id", "")),
                    "raw_colspan": str(element.attrib.get("data-raw-colspan", "1")),
                    "raw_rowspan": str(element.attrib.get("data-raw-rowspan", "1"))}
        if tag == "a" and element.attrib.get("data-href"):
            links.append({"text": value, "url": str(element.attrib["data-href"]),
                          "raw_href": str(element.attrib.get("data-raw-href", "")),
                          "base_url": str(element.attrib.get("data-base-url", "")),
                          "heading_path": heading_path, "list_path": list_path})
        if len(blocks) > 10000 or len(links) > 10000:
            raise CaptureFailure("document_item_limit")
    if not blocks and text:
        blocks = [{"kind": "text", "text": text, "heading_path": [], "list_path": [], "table_row": []}]
    document = {"schema": "awardping.scrapling-document.v1", "scope": "whole-visible-main-document",
                "title": observation["title"], "text": text, "blocks": blocks, "links": links,
                "limitations": observation["limitations"], "counts": observation["counts"]}
    if len(json.dumps(document, ensure_ascii=False).encode("utf-8")) > MAX_BYTES:
        raise CaptureFailure("document_size_limit")
    return document


def native_projection(snapshot, page):
    """Project native Chromium layout text without touching selection or page DOM."""
    if len(json.dumps(snapshot, ensure_ascii=False).encode("utf-8")) > 4 * MAX_BYTES:
        raise CaptureFailure("native_snapshot_size_limit")
    strings = snapshot["strings"]
    string = lambda index: strings[index] if isinstance(index, int) and index >= 0 else ""
    document = snapshot["documents"][0]
    nodes = document["nodes"]
    layout = document["layout"]
    count = len(nodes["nodeType"])
    if count > 50000:
        raise CaptureFailure("dom_node_limit")
    children = [[] for _ in range(count)]
    for index, parent in enumerate(nodes["parentIndex"]):
        if parent >= 0:
            children[parent].append(index)
    layouts = {index: position for position, index in enumerate(layout["nodeIndex"])}
    shadows = set(nodes.get("shadowRootType", {}).get("index", []))
    pseudos = set(nodes.get("pseudoType", {}).get("index", []))
    limitations = {"passive_main_document_only_no_expansion_or_scrolling",
                  "pixel_occlusion_and_partial_clipping_not_verified", "image_text_not_observed",
                  "raw_html_is_adjacent_ancillary_observation_not_visibility_authority"}
    if shadows:
        limitations.add("shadow_content_not_observed")
    if pseudos:
        limitations.add("css_generated_content_not_observed")
    if len(snapshot["documents"]) > 1:
        limitations.add("iframe_content_not_observed")
    selected_nodes, text_chars = 0, 0
    omitted = {"script", "style", "noscript", "template", "head"}

    def attributes(index):
        values = nodes["attributes"][index]
        return {string(values[i]): string(values[i + 1]) for i in range(0, len(values), 2)}

    base_url = string(document["baseURL"])
    raw_hrefs = {}
    for index in range(count):
        if string(nodes["nodeName"][index]).lower() == "a":
            attrs = attributes(index)
            if "href" in attrs:
                if len(attrs["href"]) > 10000:
                    raise CaptureFailure("link_url_limit")
                raw_hrefs[str(index)] = attrs["href"]
    # Use the browser's WHATWG URL semantics, not Python's different RFC3986
    # urljoin rules (e.g. an empty '?' clears the query in a browser).
    browser_annotations = page.evaluate("""({base, links, limit}) => {
        const elements = document.querySelectorAll('details');
        if (elements.length > 10000) return {error: 'details_visibility_limit'};
        const encoder = new TextEncoder(), details = [];
        let bytes = 2;
        for (const element of elements) {
            const style = getComputedStyle(element, '::details-content');
            const item = {attributes: Array.from(element.attributes, a => [a.name, a.value]),
                content_visibility: style.contentVisibility, display: style.display, opacity: style.opacity};
            bytes += encoder.encode(JSON.stringify(item)).byteLength + 1;
            if (bytes > limit) return {error: 'details_visibility_limit'};
            details.push(item);
        }
        return {details, links: Object.fromEntries(Object.entries(links).map(([id, href]) => {
            try { return [id, new URL(href, base).href]; } catch { return [id, null]; }
        }))};
    }""", {"base": base_url, "links": raw_hrefs, "limit": MAX_BYTES})
    if browser_annotations.get("error"):
        raise CaptureFailure(browser_annotations["error"])
    resolved_hrefs = browser_annotations["links"]

    def main_details(index):
        if nodes["nodeType"][index] != 1 or string(nodes["nodeName"][index]).lower() != "details":
            return False
        ancestor = index
        while ancestor >= 0:
            if ancestor in shadows or ancestor in pseudos or string(nodes["nodeName"][ancestor]).lower() == "template":
                return False
            ancestor = nodes["parentIndex"][ancestor]
        return True

    detail_indices = [index for index in range(count) if main_details(index)]
    detail_states = browser_annotations["details"]
    if len(detail_states) != len(detail_indices):
        raise CaptureFailure("content_changed_during_capture")
    hidden_details_content = set()
    for index, state in zip(detail_indices, detail_states):
        # CDP retains old child layout after a details element closes, and omits
        # ::details-content itself. Bind this adjacent style read by exact main-
        # document order/count/attributes; both native observations include it.
        # This is bracketed evidence, not an atomic DOM/CSS transaction.
        if dict(state["attributes"]) != attributes(index):
            raise CaptureFailure("content_changed_during_capture")
        if state["content_visibility"] not in ("hidden", "visible", "auto") or not state["display"]:
            raise CaptureFailure("details_visibility_unavailable")
        try:
            opacity = float(state["opacity"])
        except (TypeError, ValueError):
            raise CaptureFailure("details_visibility_unavailable") from None
        if not 0 <= opacity <= 1:
            raise CaptureFailure("details_visibility_unavailable")
        if state["content_visibility"] == "hidden" or state["display"] == "none" or opacity == 0:
            hidden_details_content.add(index)

    def style_and_bounds(index):
        position = layouts.get(index)
        if position is None:
            return {}, None
        return dict(zip(SNAPSHOT_STYLES, (string(value) for value in layout["styles"][position]))), layout["bounds"][position]

    def text_escape(value):
        return re.sub(r"\s", "&#160;", escape(value, quote=False))

    def visit(index, depth):
        nonlocal selected_nodes, text_chars
        if depth > 100:
            raise CaptureFailure("dom_depth_limit")
        if index in shadows or index in pseudos:
            return ""
        kind = nodes["nodeType"][index]
        tag = string(nodes["nodeName"][index]).lower()
        style, bounds = style_and_bounds(index)
        if style.get("display") == "none" or style.get("content-visibility") == "hidden" or style.get("opacity") == "0":
            return ""
        if kind == 3:
            if index not in layouts or style.get("visibility") in ("hidden", "collapse") or not bounds or bounds[2] <= 0 or bounds[3] <= 0:
                return ""
            text = string(layout["text"][layouts[index]])
            selected_nodes += 1
            text_chars += len(text)
            if text_chars > 250000:
                raise CaptureFailure("visible_text_limit")
            return text_escape(text)
        if kind != 1 or tag in omitted:
            return ""
        attrs = attributes(index)
        if tag in ("iframe", "frame"):
            limitations.add("iframe_content_not_observed")
            return ""
        if tag in ("svg", "canvas"):
            limitations.add("canvas_or_svg_text_not_observed")
            return ""
        if style.get("clip-path", "none") != "none" or style.get("clip", "auto") != "auto":
            limitations.add("css_clipping_present_not_resolved")
        if attrs.get("aria-expanded") == "false" or (tag == "details" and "open" not in attrs):
            limitations.add("closed_sections_not_expanded")
        if tag in ("input", "select", "textarea"):
            limitations.add("form_control_values_not_observed")
        if tag == "br":
            return "&#160;" if bounds else ""
        retained_attrs = f' data-tag="{escape(tag, quote=True)}"'
        if attrs.get("role") == "heading":
            retained_attrs += f' data-heading-level="{escape(attrs.get("aria-level", "2"), quote=True)}"'
        if tag in ("td", "th"):
            for key in ("colspan", "rowspan", "scope", "headers", "id"):
                value = attrs.get(key, "1" if key in ("colspan", "rowspan") else "")
                if len(value) > 10000:
                    raise CaptureFailure("table_attribute_limit")
                if key in ("colspan", "rowspan"):
                    retained_attrs += f' data-raw-{key}="{escape(value, quote=True)}"'
                    value = str(max(0 if key == "rowspan" else 1, min(65534, int(value)))) if re.fullmatch(r"[0-9]{1,8}", value) else "1"
                retained_attrs += f' data-{key}="{escape(value, quote=True)}"'
        before_text = text_chars
        visible_children = children[index]
        if index in hidden_details_content:
            # The first direct summary is outside ::details-content. Do not
            # retain later summaries or open details nested inside a hidden one.
            summary = next((child for child in visible_children if nodes["nodeType"][child] == 1 and
                            string(nodes["nodeName"][child]).lower() == "summary"), None)
            visible_children = [] if summary is None else [summary]
        content = "".join(visit(child, depth + 1) for child in visible_children)
        has_box = bounds and bounds[2] > 0 and bounds[3] > 0 and style.get("visibility") not in ("hidden", "collapse")
        if tag == "a" and "href" in attrs and (text_chars > before_text or has_box):
            href = resolved_hrefs.get(str(index))
            if href is None:
                limitations.add("unresolvable_link_url")
                href = attrs["href"]
            if len(href) > 10000:
                raise CaptureFailure("link_url_limit")
            retained_attrs += f' data-href="{escape(href, quote=True)}"'
            retained_attrs += f' data-raw-href="{escape(attrs["href"], quote=True)}" data-base-url="{escape(base_url, quote=True)}"'
            if text_chars == before_text:
                limitations.add("image_only_or_unlabelled_link_text_not_observed")
        boundary = style.get("display", "contents") not in ("inline", "contents")
        space = "&#160;" if boundary else ""
        return f"{space}<ap-node{retained_attrs}>{content}</ap-node>{space}"

    body = next((i for i in range(count) if nodes["nodeType"][i] == 1 and string(nodes["nodeName"][i]).lower() == "body" and i not in shadows), None)
    root = next((i for i in range(count) if nodes["nodeType"][i] == 1 and string(nodes["nodeName"][i]).lower() == "html" and i not in shadows), None)
    if body is None or root is None:
        raise CaptureFailure("missing_document")
    # Include root styles in ancestry (e.g. html { opacity:0 }); head is omitted.
    projection = f"<ap-document>{visit(root, 0)}</ap-document>"
    if len(projection.encode("utf-8")) > MAX_BYTES:
        raise CaptureFailure("projection_size_limit")
    return {"projection": projection, "title": string(document["title"]), "url": string(document["documentURL"]),
            "details_content_states": detail_states,
            "limitations": sorted(limitations), "counts": {"dom_nodes": count, "rendered_text_nodes": selected_nodes}}


def observe(page):
    try:
        page.evaluate(SCRIPT)  # Bound the main document before requesting native snapshot data.
        session = page.context.new_cdp_session(page)
        try:
            before = native_projection(session.send("DOMSnapshot.captureSnapshot", {"computedStyles": SNAPSHOT_STYLES}), page)
            ancillary = page.evaluate(SCRIPT)
            observation = native_projection(session.send("DOMSnapshot.captureSnapshot", {"computedStyles": SNAPSHOT_STYLES}), page)
        finally:
            session.detach()
        if before != observation or ancillary["url"] != observation["url"]:
            raise CaptureFailure("content_changed_during_capture")
        observation.update(ancillary)
    except CaptureFailure:
        raise
    except Exception as error:
        message = str(error)
        reason = next((word for word in ("missing_document", "dom_node_limit", "html_size_limit", "visible_text_limit",
                                         "dom_depth_limit", "link_url_limit", "projection_size_limit", "table_attribute_limit",
                                         "native_snapshot_size_limit") if word in message), "document_observation_failed")
        raise CaptureFailure(reason) from None
    validate_url(observation["url"])
    document = parse_projection(observation)
    semantic = {key: document[key] for key in ("title", "text", "blocks", "links")}
    signal = hashlib.sha256(json.dumps({"url": observation["url"], **semantic,
        "details_content_states": observation["details_content_states"]}, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    return observation, document, signal


def screenshot_bounds(page):
    """Use the same full-page extent as Playwright, without changing the DOM."""
    bounds = page.evaluate("""() => {
        if (!document.body || !document.documentElement) return null;
        const b = document.body, r = document.documentElement;
        return {width: Math.max(b.scrollWidth, r.scrollWidth, b.offsetWidth, r.offsetWidth, b.clientWidth, r.clientWidth),
            height: Math.max(b.scrollHeight, r.scrollHeight, b.offsetHeight, r.offsetHeight, b.clientHeight, r.clientHeight)};
    }""")
    if not bounds:
        raise CaptureFailure("missing_document")
    width, height = bounds["width"], bounds["height"]
    if not (type(width) is int and type(height) is int and 0 < width <= 4096 and
            0 < height <= 20000 and width * height <= MAX_SCREENSHOT_PIXELS):
        raise CaptureFailure("screenshot_dimension_limit")
    return bounds


def collect_stable(page, stable_ms=1000, max_ms=12000, *, geometry=False):
    started = time.monotonic()
    last_changed = started
    previous = None
    samples = 0
    while (time.monotonic() - started) * 1000 <= max_ms:
        try:
            bounds = screenshot_bounds(page) if geometry else None
            observation, document, signal = observe(page)
            if geometry:
                if screenshot_bounds(page) != bounds:
                    raise CaptureFailure("content_changed_during_capture")
                signal = (signal, bounds)
        except CaptureFailure as error:
            if str(error) != "content_changed_during_capture":
                raise
            previous = None
            last_changed = time.monotonic()
            page.wait_for_timeout(300)
            continue
        samples += 1
        ready = observation["ready_state"] == "complete" and observation["fonts_status"] == "loaded"
        now = time.monotonic()
        if not ready or previous != signal:
            last_changed = now
        previous = signal
        if ready and samples >= 3 and (now - last_changed) * 1000 >= stable_ms:
            if len(document["text"]) < 40:
                raise CaptureFailure("insufficient_visible_text")
            if CHALLENGE.search(document["text"][:1000]):
                raise CaptureFailure("blocked_page_content")
            readiness = {"ready_state": "complete", "fonts_status": "loaded", "stable": True,
                         "samples": samples, "stable_ms": stable_ms, "waited_ms": round((now - started) * 1000),
                         "basis": "native_layout_rendered_text_and_links_bracketing_ancillary_dom"}
            if geometry:
                readiness.update({"full_page_dimensions_stable": True,
                                  "full_page_dimensions": bounds,
                                  "basis": readiness["basis"] + "_and_full_page_dimensions"})
            return observation, document, readiness
        page.wait_for_timeout(300)
    raise CaptureFailure("page_not_stable")


def jpeg_dimensions(data):
    """Read bounded JPEG frame dimensions; downstream image handling still decodes it."""
    if len(data) < 4 or data[:2] != b"\xff\xd8" or data[-2:] != b"\xff\xd9":
        raise CaptureFailure("invalid_screenshot")
    offset = 2
    while offset + 4 <= len(data):
        if data[offset] != 255:
            break
        while offset < len(data) and data[offset] == 255:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker in (0xD8, 0xD9, 0xDA):
            break
        length = int.from_bytes(data[offset:offset + 2], "big")
        if length < 2 or offset + length > len(data):
            break
        if marker in (0xC0, 0xC1, 0xC2):
            if length < 8:
                break
            return int.from_bytes(data[offset + 5:offset + 7], "big"), int.from_bytes(data[offset + 3:offset + 5], "big")
        offset += length
    raise CaptureFailure("invalid_screenshot")


def discover_html_links(page):
    result = page.evaluate(HTML_LINK_SCRIPT)
    if result.get("error"):
        raise CaptureFailure(result["error"])
    return result["links"]


def semantic_mismatches(before, after, prefix, fields):
    result = []
    for field in fields:
        if before[field] == after[field]:
            continue
        left = json.dumps(before[field], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        right = json.dumps(after[field], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        result.append({"field": f"{prefix}.{field}", "before_sha256": hashlib.sha256(left).hexdigest(),
                       "after_sha256": hashlib.sha256(right).hexdigest(), "before_bytes": len(left), "after_bytes": len(right)})
    return result


def capture_evidence(page, observed, *, viewport_capture=None):
    """Passive screenshot + source text, not fabricated geometry or visibility for HTML."""
    observation, document, _ = observed
    try:
        html_document = extract_html_document(observation["html"], observation["url"])
    except HtmlDocumentError as error:
        raise CaptureFailure(str(error)) from None
    html_links = discover_html_links(page)
    bounds = screenshot_bounds(page)
    width, height = bounds["width"], bounds["height"]
    if viewport_capture is not None:
        if (bounds != viewport_capture or page.viewport_size != viewport_capture or
                page.evaluate("() => ({width: innerWidth, height: innerHeight})") != viewport_capture):
            raise CaptureFailure("screenshot_document_exceeds_viewport")
    image = page.screenshot(type="jpeg", quality=80, full_page=viewport_capture is None, scale="css", animations="allow", caret="initial", timeout=15000)
    captured_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if len(image) > MAX_SCREENSHOT_BYTES:
        raise CaptureFailure("screenshot_size_limit")
    image_width, image_height = jpeg_dimensions(image)
    if image_width != width or image_height != height:
        raise CaptureFailure("screenshot_dimensions_changed")
    after, after_document, _ = observe(page)
    try:
        after_html_document = extract_html_document(after["html"], after["url"])
    except HtmlDocumentError as error:
        raise CaptureFailure(str(error)) from None
    if after["url"] != observation["url"] or after["ready_state"] != "complete" or after["fonts_status"] != "loaded":
        raise CaptureFailure("screenshot_page_identity_or_readiness_changed")
    if len(after_document["text"]) < 40:
        raise CaptureFailure("screenshot_page_unreadable")
    if CHALLENGE.search(after_document["text"][:1000]):
        raise CaptureFailure("blocked_page_content")
    if screenshot_bounds(page) != bounds:
        raise CaptureFailure("screenshot_dimensions_changed")
    if viewport_capture is not None and (page.viewport_size != viewport_capture or
            page.evaluate("() => ({width: innerWidth, height: innerHeight})") != viewport_capture):
        raise CaptureFailure("screenshot_dimensions_changed")
    after_links = discover_html_links(page)
    mismatches = (semantic_mismatches(document, after_document, "visible", ("title", "text", "blocks", "links"))
                  + semantic_mismatches(html_document, after_html_document, "html_source", ("title", "text", "blocks", "links", "base_hrefs"))
                  + semantic_mismatches({"links": html_links}, {"links": after_links}, "discovery", ("links",)))
    return {"html_document": html_document, "html_links": html_links, "screenshot": {
        "schema": "awardping.scrapling-screenshot.v1", "mime_type": "image/jpeg",
        "base64": base64.b64encode(image).decode("ascii"), "sha256": hashlib.sha256(image).hexdigest(),
        "byte_length": len(image), "width": image_width, "height": image_height,
        "captured_at": captured_at, "source_url": observation["url"], "full_page": True,
        **({"capture_method": "document_fitting_viewport", "viewport": viewport_capture} if viewport_capture is not None else {}),
        "geometry_status": "unavailable", "alignment": "not_verified", "semantics_bracketed": not mismatches,
        "semantic_mismatches": mismatches, "primary_html_captured_at": observation["captured_at"],
        "limitations": ["No change coordinates or screenshot/text pixel alignment were verified.",
            "No scrolling or section expansion; hidden HTML source text is not asserted to appear in this image.",
            "Image pixels, animation, embedded documents and lazy content were not independently stabilized.",
            "The pre-screenshot atomic HTML snapshot is primary; this later screenshot is supplementary."]
            + (["After a full-page screenshot changed layout, the viewport height was set once to fit the document; primary HTML and visible content were observed again in that viewport."] if viewport_capture is not None else [])
            + (["Content changed during the supplementary screenshot; it must not be presented as matching the primary snapshot."] if mismatches else [])}}


def capture(request, fixture=None):
    """fixture is an in-process test seam, never accepted from CLI JSON."""
    url = validate_url(request["url"])
    profile = request.get("capture_profile", PROFILE)
    if profile not in (PROFILE, EVIDENCE_PROFILE, SOURCE_HTML_PROFILE):
        raise CaptureFailure("invalid_capture_profile")
    source_id = request.get("source_id")
    if not isinstance(source_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,160}", source_id):
        raise CaptureFailure("invalid_source_id")
    proxy = urlsplit(request["proxy_url"])
    if proxy.scheme != "http" or proxy.hostname != "127.0.0.1" or not proxy.port or proxy.username or proxy.password:
        raise CaptureFailure("invalid_proxy")
    if profile == SOURCE_HTML_PROFILE:
        if fixture is not None:
            raise CaptureFailure("source_html_browser_fixture_not_allowed")
        return capture_source_html(request)
    executable = Path(request["executable_path"])
    if not executable.is_absolute() or not executable.is_file():
        raise CaptureFailure("invalid_browser_path")
    state = {"failure": None, "observed": None, "response": None, "captured_response": None,
             "telemetry": {"blocked_non_get": 0, "blocked_media": 0, "blocked_websockets": 0,
                           "failed_requests": 0, "page_errors": 0}}

    def page_setup(page):
        try:
            context = page.context
            def websocket_sink(socket):
                # Playwright routes never contact a server without connect_to_server.
                # A synchronous close here deadlocks before Playwright's ensureOpened
                # step (observed with 1.64). Consume messages without connecting,
                # responding or making synchronous browser calls from this callback.
                state["telemetry"]["blocked_websockets"] += 1
                socket.on_message(lambda _: None)
            context.route_web_socket("**/*", websocket_sink)

            def route_request(route):
                req = route.request
                try:
                    if req.method not in ("GET", "HEAD"):
                        state["telemetry"]["blocked_non_get"] += 1
                        return route.abort()
                    if req.resource_type == "media":
                        state["telemetry"]["blocked_media"] += 1
                        return route.abort()
                    if urlsplit(req.url).scheme in ("data", "blob") and not req.is_navigation_request():
                        return route.continue_()
                    validate_url(req.url)
                    if req.is_navigation_request():
                        if req.frame.page != page:
                            raise CaptureFailure("unexpected_navigation")
                        if req.frame == page.main_frame and req.url != url.partition("#")[0] and req.redirected_from is None:
                            raise CaptureFailure("unexpected_navigation")
                    if fixture is not None:
                        return fixture(route)
                    return route.continue_()
                except CaptureFailure as error:
                    state["failure"] = str(error)
                    return route.abort()

            context.route("**/*", route_request)
            context.on("page", lambda created: created.close() if created != page else None)
            page.on("dialog", lambda dialog: dialog.dismiss())
            page.on("download", lambda download: download.cancel())
            page.on("pageerror", lambda _: state["telemetry"].__setitem__("page_errors", state["telemetry"]["page_errors"] + 1))

            def failed(req):
                state["telemetry"]["failed_requests"] += 1
                if re.search(r"ERR_(CERT_|SSL_|TLS_|INSECURE_RESPONSE)", req.failure or "", re.I):
                    state["failure"] = "transport_security_refused"

            def response_seen(response):
                req = response.request
                if req.is_navigation_request() and req.frame == page.main_frame:
                    headers = response.headers  # Playwright normalizes HTTP header names to lowercase.
                    state["response"] = {"url": response.url, "status": response.status,
                                         "content_type": headers.get("content-type", "").lower(),
                                         "upstream_challenge": response.status == 202 and headers.get("x-amzn-waf-action") == "challenge"}

            page.on("requestfailed", failed)
            page.on("response", response_seen)
        except Exception:
            state["failure"] = "browser_guard_setup_failed"
            page.close()
            raise CaptureFailure("browser_guard_setup_failed") from None

    def page_action(page):
        try:
            response = state["response"]
            if not response or not 200 <= response["status"] < 300:
                raise CaptureFailure(f"http_{response['status']}" if response else "http_unavailable")
            if not re.match(r"^(text/html|application/xhtml\+xml)(;|$)", response["content_type"]):
                raise CaptureFailure("non_html_response")
            require_document_response_url(page.url, response)
            if response["upstream_challenge"]:
                # An explicit upstream interstitial is unavailable, not an empty applicant page.
                raise CaptureFailure("upstream_challenge_response")
            viewport_capture = None
            for attempt in range(2 if profile == EVIDENCE_PROFILE else 1):
                state["observed"] = (collect_stable(page, geometry=True) if profile == EVIDENCE_PROFILE
                                     else collect_stable(page))
                require_document_response_url(state["observed"][0]["url"], response)
                if profile == EVIDENCE_PROFILE:
                    try:
                        state["evidence"] = capture_evidence(page, state["observed"], viewport_capture=viewport_capture)
                    except CaptureFailure as error:
                        # Chromium's beyond-viewport screenshot temporarily resizes
                        # to 1x1 and can trigger a site's responsive JS. One bounded
                        # fixed-width, document-fitting viewport avoids that path.
                        # Discard the first shot and re-observe ALL primary content;
                        # no script suppression, DOM edits, or geometry tolerance.
                        if str(error) != "screenshot_dimensions_changed" or attempt:
                            raise
                        previous_bounds = state["observed"][2]["full_page_dimensions"]
                        current_bounds = screenshot_bounds(page)
                        viewport = page.viewport_size
                        if not viewport or max(previous_bounds["width"], current_bounds["width"]) > viewport["width"]:
                            raise CaptureFailure("screenshot_document_exceeds_viewport")
                        viewport_capture = {"width": viewport["width"],
                                            "height": max(previous_bounds["height"], current_bounds["height"], viewport["height"])}
                        page.set_viewport_size(viewport_capture)
                        continue
                    state["observed"][2]["screenshot_attempts"] = attempt + 1
                break
            require_document_response_url(page.url, response)
            if state["response"] is not response:
                raise CaptureFailure("http_response_changed_during_capture")
            state["captured_response"] = response
        except CaptureFailure as error:
            state["failure"] = str(error)
        except Exception:
            state["failure"] = "document_capture_failed"

    # additional_args override Scrapling's browser defaults: no spoofed UA, no
    # anti-automation flags, standard browser automation marker, strict TLS.
    try:
        DynamicFetcher.fetch(url, headless=True, executable_path=str(executable), retries=1,
                             google_search=False, disable_resources=False, network_idle=False, load_dom=True,
                             timeout=30000, wait=0, page_setup=page_setup, page_action=page_action,
                             proxy=request["proxy_url"], locale="en-US", timezone_id="America/Chicago",
                             selector_config={"adaptive": False, "huge_tree": False},
                             additional_args={"proxy": {"server": request["proxy_url"], "bypass": "<-loopback>"},
                                              "viewport": {"width": 1280, "height": 900}, "device_scale_factor": 1,
                                              "color_scheme": "light", "ignore_https_errors": False,
                                              "service_workers": "block", "accept_downloads": False,
                                              "user_agent": None, "ignore_default_args": []},
                             extra_flags=["--disable-background-networking", "--disable-component-update",
                                          "--disable-default-apps", "--disable-extensions", "--disable-quic",
                                          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                                          "--webrtc-ip-handling-policy=disable_non_proxied_udp"])
    except Exception:
        raise CaptureFailure(state["failure"] or "browser_fetch_failed") from None
    if state["failure"]:
        raise CaptureFailure(state["failure"])
    if state["observed"] is None:
        raise CaptureFailure("capture_unavailable")
    if state["response"] is not state["captured_response"]:
        raise CaptureFailure("http_response_changed_during_capture")
    if not state["response"] or not 200 <= state["response"]["status"] < 300:
        raise CaptureFailure("http_status_changed_during_capture")
    if not re.match(r"^(text/html|application/xhtml\+xml)(;|$)", state["response"]["content_type"]):
        raise CaptureFailure("non_html_response")
    observation, document, readiness = state["observed"]
    require_document_response_url(observation["url"], state["response"])
    if state["telemetry"]["blocked_websockets"]:
        document["limitations"] = sorted(set(document["limitations"]) | {"websocket_live_updates_not_observed_client_connection_mocked"})
    result = {"schema": SCHEMA, "source_id": source_id, "url": url, "final_url": observation["url"],
            "captured_at": observation["captured_at"], "status_code": state["response"]["status"],
            "content_type": state["response"]["content_type"], "html": observation["html"],
            "visible_html": observation["projection"], "text": document["text"],
            "document": document, "capture_profile": profile, "readiness": readiness,
            "warnings": [], "telemetry": state["telemetry"],
            "engine": {"scrapling": version("scrapling"), "playwright": version("playwright"), "adaptive": False, "stealth": False}}
    if profile == EVIDENCE_PROFILE:
        result.update(state["evidence"])
        if not result["screenshot"]["semantics_bracketed"]:
            result["warnings"].append("supplementary_screenshot_semantics_changed_not_aligned")
    if len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) >= MAX_OUTPUT_BYTES:
        raise CaptureFailure("collector_output_limit")
    return result


def main():
    logging.disable(logging.CRITICAL)
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise CaptureFailure("request_size_limit")
        request = json.loads(raw)
        required = {"url", "source_id", "proxy_url", "executable_path"}
        if not isinstance(request, dict) or not required <= set(request) or set(request) - required - {"capture_profile"}:
            raise CaptureFailure("invalid_request")
        with contextlib.redirect_stdout(sys.stderr):
            result = capture(request)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except CaptureFailure as error:
        reason = str(error) if SAFE_REASON.fullmatch(str(error)) else "capture_failed"
    except Exception:
        reason = "invalid_request_or_capture_failure"
    print(json.dumps({"error": reason}))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
