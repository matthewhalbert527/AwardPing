"""Finite passive SMART response observer. No network, filesystem or browser creation."""
import ast
import base64
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
import re
import time
from urllib.parse import parse_qsl, urlsplit

PROFILE = "smart-page-v1"
SCHEMA = "awardping.scrapling-publisher-json-observation.v1"
OWNER = "d7d4d117-f312-456f-a75c-3dbd5d372c99"
PORTAL = "f2a05466db71c300b67330ca7c9619f0"
HOMEPAGE = "2a47254fdb350300ecc734cc7c961992"
ORIGIN = "https://www.smartscholarship.org"
SOURCES = {
    "58aefec0-0d42-4b7b-9887-60d25940b3d0": (ORIGIN + "/smart", None),
    "c33cc2f4-2cbd-458c-b630-537eb3d50f72": (ORIGIN + "/smart/en?id=smart_eligibility", "smart_eligibility"),
    "203baaf3-2905-4fdf-b4af-af84998195a8": (ORIGIN + "/smart/en?id=kb_article&sys_id=84f05b02db5ac3006bb8f4b40f9619cc", "kb_article"),
    "2562f7c2-4709-4d63-ac25-c4638733a981": (ORIGIN + "/smart?id=kb_article&sys_id=b8fb18e0db8a8300ecc734cc7c9619d7", "kb_article"),
    "39685b8a-3ad9-41c5-834b-b2aaafb2b0e5": (ORIGIN + "/smart?id=kb_article&sys_id=0383c5d6db2a03006bb8f4b40f961956", "kb_article"),
    "92eebc07-7392-4136-ba13-d9cd5455c8f9": (ORIGIN + "/smart/en", None),
}
# Source ownership is exact, including the three registered alias-owned sources.
# This is not an owner canonicalization or a general knowledge-base allowlist.
SOURCE_OWNERS = {
    "2562f7c2-4709-4d63-ac25-c4638733a981": "1efa2a75-e6b8-4bf6-80be-85ef2f6b3108",
    "39685b8a-3ad9-41c5-834b-b2aaafb2b0e5": "1efa2a75-e6b8-4bf6-80be-85ef2f6b3108",
    "92eebc07-7392-4136-ba13-d9cd5455c8f9": "1efa2a75-e6b8-4bf6-80be-85ef2f6b3108",
}
ARTICLE_SYS_IDS = {
    "203baaf3-2905-4fdf-b4af-af84998195a8": "84f05b02db5ac3006bb8f4b40f9619cc",
    "2562f7c2-4709-4d63-ac25-c4638733a981": "b8fb18e0db8a8300ecc734cc7c9619d7",
    "39685b8a-3ad9-41c5-834b-b2aaafb2b0e5": "0383c5d6db2a03006bb8f4b40f961956",
}
GUIDE_SOURCE_IDENTITIES = {
    "bfd3e15c-3905-4db6-ac2c-e0a5b1637872": {
        "url": "https://www.smartscholarship.org/smart?id=kb_article&sys_id=071d5154db068300b67330ca7c961968",
        "owner": "d7d4d117-f312-456f-a75c-3dbd5d372c99",
        "title": "SMART Scholarship Award Details FAQ",
        "page_type": "requirements",
        "article_sys_id": "071d5154db068300b67330ca7c961968"
    },
    "b29da726-dc73-4de6-a67b-1f536a58771e": {
        "url": "https://www.smartscholarship.org/smart?id=kb_article&sys_id=33b85cb7db754300b67330ca7c961911",
        "owner": "d7d4d117-f312-456f-a75c-3dbd5d372c99",
        "title": "SMART",
        "page_type": "homepage",
        "article_sys_id": "33b85cb7db754300b67330ca7c961911"
    },
    "87111fbf-0b03-43e1-bb6f-0f23359617d7": {
        "url": "https://www.smartscholarship.org/smart?id=kb_article&sys_id=3ee85c60db8a8300ecc734cc7c9619dc",
        "owner": "d7d4d117-f312-456f-a75c-3dbd5d372c99",
        "title": "Application Requirements: Academic Background",
        "page_type": "requirements",
        "article_sys_id": "3ee85c60db8a8300ecc734cc7c9619dc"
    },
    "b4ad8c95-9410-4ceb-9fc4-0e077f34f612": {
        "url": "https://www.smartscholarship.org/smart?id=kb_article&sys_id=5b3bd0e0db8a8300ecc734cc7c961930",
        "owner": "d7d4d117-f312-456f-a75c-3dbd5d372c99",
        "title": "Application Requirements: References",
        "page_type": "requirements",
        "article_sys_id": "5b3bd0e0db8a8300ecc734cc7c961930"
    },
    "e6b62753-2830-420b-b6f3-6af6f6ec704e": {
        "url": "https://www.smartscholarship.org/smart?id=kb_article&sys_id=61a7fa06db1ac3006bb8f4b40f961980",
        "owner": "d7d4d117-f312-456f-a75c-3dbd5d372c99",
        "title": "DoW SMART Post Graduate Employment FAQ",
        "page_type": "requirements",
        "article_sys_id": "61a7fa06db1ac3006bb8f4b40f961980"
    },
    "f7d55da4-9abb-4024-a423-d930573fb50f": {
        "url": "https://www.smartscholarship.org/smart?id=kb_article&sys_id=78291c60db8a8300ecc734cc7c9619df",
        "owner": "d7d4d117-f312-456f-a75c-3dbd5d372c99",
        "title": "Application Requirements: Proposed Award",
        "page_type": "requirements",
        "article_sys_id": "78291c60db8a8300ecc734cc7c9619df"
    },
    "2f1c3cc1-7309-481c-9c6b-4c5cba1f648f": {
        "url": "https://www.smartscholarship.org/smart?id=kb_article&sys_id=9ddbd6e91bced4906b6a0e9ee54bcb74",
        "owner": "d7d4d117-f312-456f-a75c-3dbd5d372c99",
        "title": "Application Requirements: Letter of Support",
        "page_type": "requirements",
        "article_sys_id": "9ddbd6e91bced4906b6a0e9ee54bcb74"
    },
    "c3299a3b-f98f-4b65-abe1-c50dba35539d": {
        "url": "https://www.smartscholarship.org/smart?id=kb_article&sys_id=b25b50e0db8a8300ecc734cc7c9619f1",
        "owner": "d7d4d117-f312-456f-a75c-3dbd5d372c99",
        "title": "Application Requirements: School Transcripts",
        "page_type": "requirements",
        "article_sys_id": "b25b50e0db8a8300ecc734cc7c9619f1"
    },
    "32728eb4-99f3-4a2f-a349-d8ab5f73271d": {
        "url": "https://www.smartscholarship.org/smart?id=kb_article&sys_id=c6cd2a0edbd6c3006bb8f4b40f961952",
        "owner": "d7d4d117-f312-456f-a75c-3dbd5d372c99",
        "title": "DoW Summer Internship & Mentor FAQ",
        "page_type": "requirements",
        "article_sys_id": "c6cd2a0edbd6c3006bb8f4b40f961952"
    },
    "bbe47dba-a910-4379-ba16-bc634ea4850c": {
        "url": "https://www.smartscholarship.org/smart?id=kb_article&sys_id=cd881c60db8a8300ecc734cc7c96190f",
        "owner": "d7d4d117-f312-456f-a75c-3dbd5d372c99",
        "title": "Application Requirements: About Me",
        "page_type": "requirements",
        "article_sys_id": "cd881c60db8a8300ecc734cc7c96190f"
    },
    "a66df6fc-6fab-4e8c-8cdd-19fcd48e6015": {
        "url": "https://www.smartscholarship.org/smart?id=kb_article&sys_id=fca954a0db8a8300ecc734cc7c961903",
        "owner": "d7d4d117-f312-456f-a75c-3dbd5d372c99",
        "title": "Application Requirements: Personal Statement",
        "page_type": "requirements",
        "article_sys_id": "fca954a0db8a8300ecc734cc7c961903"
    },
    "5f92d7f3-5b5d-41b1-97ec-16aa0e56be8d": {
        "url": "https://www.smartscholarship.org/smart/en?id=kb_article&sys_id=30d91073dbb54300b67330ca7c96197c",
        "owner": "d7d4d117-f312-456f-a75c-3dbd5d372c99",
        "title": "CLEARANCE PROCESS",
        "page_type": "faq",
        "article_sys_id": "30d91073dbb54300b67330ca7c96197c"
    }
}
SOURCES.update({key: (row["url"], "kb_article") for key, row in GUIDE_SOURCE_IDENTITIES.items()})
ARTICLE_SYS_IDS.update({key: row["article_sys_id"] for key, row in GUIDE_SOURCE_IDENTITIES.items()})
BODY_LIMIT = 512 * 1024
MAIN_LIMIT = 5 * 1024 * 1024
DURATION = 45


class PublisherJsonError(Exception):
    """Content-free typed reason only."""


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode("utf-8")).hexdigest()


def integer(value):
    return type(value) is int and value >= 0


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PublisherJsonError("publisher_json_duplicate_key")
        result[key] = value
    return result


def strict_json(value):
    try:
        return json.loads(value, object_pairs_hook=unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except PublisherJsonError:
        raise
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise PublisherJsonError("publisher_json_invalid_json") from None


def source_profile(source_id, url, owner, source_title=None, source_page_type=None):
    guide = GUIDE_SOURCE_IDENTITIES.get(source_id)
    if guide:
        if owner != guide["owner"] or source_title != guide["title"] or source_page_type != guide["page_type"]:
            raise PublisherJsonError("publisher_json_source_identity")
    elif source_title is not None or source_page_type is not None:
        raise PublisherJsonError("publisher_json_source_identity")
    if owner != SOURCE_OWNERS.get(source_id, OWNER) or source_id not in SOURCES or SOURCES[source_id][0] != url:
        raise PublisherJsonError("publisher_json_source_identity")
    return SOURCES[source_id]


class BootScripts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.scripts, self.current, self.base_hrefs = [], None, []

    def handle_starttag(self, tag, attrs):
        if tag == "base":
            if attrs != [("href", "/smart")] or self.base_hrefs:
                raise PublisherJsonError("publisher_json_base_tag")
            self.base_hrefs.append("/smart")
        if tag == "script":
            if self.current is not None:
                raise PublisherJsonError("publisher_json_boot_shape")
            if len(attrs) != len(dict(attrs)):
                raise PublisherJsonError("publisher_json_boot_shape")
            self.current = {"description": dict(attrs).get("data-description"), "text": ""}

    def handle_data(self, data):
        if self.current is not None:
            self.current["text"] += data

    def handle_endtag(self, tag):
        if tag == "script" and self.current is not None:
            self.scripts.append(self.current)
            self.current = None


def boot_portal_id(html):
    """Read literal public boot configuration only; never evaluate script code."""
    if not isinstance(html, str) or len(html.encode("utf-8")) > MAIN_LIMIT:
        raise PublisherJsonError("publisher_json_boot_limit")
    try:
        parser = BootScripts()
        parser.feed(html)
        if parser.base_hrefs != ["/smart"]:
            raise PublisherJsonError("publisher_json_base_tag")
        selected = [s for s in parser.scripts if s["description"] == "set sp.dependencies"]
        if len(selected) != 1 or parser.current is not None:
            raise ValueError()
        # The reviewed publisher emits exactly one constant JSON.parse argument.
        # literal_eval accepts constants only; an explicit escape grammar avoids
        # Python/JavaScript unknown-escape interpretation differences.
        literal = r"(?:'(?:[^'\\\r\n]|\\(?:[\\'\"/bfnrt]|u[0-9a-fA-F]{4}))*'|\"(?:[^\"\\\r\n]|\\(?:[\\'\"/bfnrt]|u[0-9a-fA-F]{4}))*\")"
        matches = re.findall(r"\bvar\s+portal\s*=\s*JSON\.parse\(\s*(" + literal + r")\s*\)", selected[0]["text"])
        if len(matches) != 1 or len(re.findall(r"\bvar\s+portal\s*=", selected[0]["text"])) != 1:
            raise ValueError()
        # JSON only treats escaped slash specially; Python literal constants do
        # not. Unescape slash before decoding this strict literal, never code.
        decoded = ast.literal_eval(matches[0].replace("\\/", "/"))
        if not isinstance(decoded, str):
            raise ValueError()
        portal = strict_json(decoded)
        now_ids, now_assignments = [], 0
        for script in parser.scripts:
            now_ids.extend(re.findall(r"\b(?:window\.)?NOW\.portal_id\s*=\s*['\"]([a-f0-9]{32})['\"]\s*;", script["text"]))
            now_assignments += len(re.findall(r"\b(?:window\.)?NOW\.portal_id\s*=", script["text"]))
        if (not isinstance(portal, dict) or portal.get("sys_id") != PORTAL or portal.get("homepage") != HOMEPAGE or
                portal.get("homepage_dv") != "smart_index" or now_ids != [PORTAL] or now_assignments != 1):
            raise ValueError()
        return PORTAL
    except PublisherJsonError:
        raise
    except (ValueError, TypeError, SyntaxError, UnicodeError, RecursionError):
        raise PublisherJsonError("publisher_json_boot_binding") from None


class SmartPublisherJson:
    def __init__(self, source_id, url, owner, now=time.monotonic, source_title=None, source_page_type=None):
        _, self.request_page_id = source_profile(source_id, url, owner, source_title, source_page_type)
        self.source_id, self.url = source_id, url
        self.now, self.started = now, now()
        self.frame_id, self.failure = None, None
        self.requests, self.by_id = {}, {}
        self.attempted = False

    def fail(self, reason):
        self.failure = self.failure or reason

    def attach(self, session):
        try:
            frame = session.send("Page.getFrameTree")["frameTree"]["frame"]["id"]
            if not isinstance(frame, str) or not 0 < len(frame) <= 256:
                raise ValueError()
            self.frame_id = frame
            for event, callback in (("requestWillBeSent", self.request), ("responseReceived", self.response),
                                    ("dataReceived", self.data), ("loadingFinished", self.finished),
                                    ("loadingFailed", self.failed), ("requestServedFromCache", self.cached)):
                session.on("Network." + event, callback)
            session.send("Network.enable", {"maxTotalBufferSize": 2 * 1024 * 1024, "maxResourceBufferSize": BODY_LIMIT})
        except Exception:
            raise PublisherJsonError("publisher_json_observer_unavailable") from None

    def request(self, event):
        request, raw_id = event.get("request") or {}, event.get("requestId")
        if not isinstance(raw_id, str):
            return
        if raw_id in self.by_id:
            self.fail("publisher_json_redirect_or_reuse")
            return
        raw_url = request.get("url")
        if not isinstance(raw_url, str) or len(raw_url) > 16384:
            return
        try:
            parsed = urlsplit(raw_url)
            is_api = parsed.scheme == "https" and parsed.netloc == "www.smartscholarship.org" and parsed.path == "/api/now/sp/page"
        except ValueError:
            return
        is_main = event.get("type") == "Document" and raw_url == self.url
        if not (is_api or is_main):
            return
        lane = "response" if is_api else "navigation"
        if self.now() - self.started > DURATION:
            self.fail("publisher_json_observation_timeout")
            return
        if lane in self.requests or not isinstance(raw_id, str) or not 0 < len(raw_id) <= 256 or event.get("redirectResponse") is not None:
            self.fail("publisher_json_multiple_or_redirected")
            return
        if request.get("method") != "GET" or event.get("frameId") != self.frame_id or not self.frame_id:
            self.fail("publisher_json_request_frame_or_method")
            return
        if is_api and event.get("type") not in ("XHR", "Fetch"):
            self.fail("publisher_json_api_request_type")
            return
        binding = {}
        if is_api:
            try:
                if parsed.fragment:
                    raise ValueError()
                pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True, errors="strict")
                query = dict(pairs)
                expected_keys = {"time", "portal_id", "request_uri"} | ({"id"} if self.request_page_id else set())
                article_id = ARTICLE_SYS_IDS.get(self.source_id)
                if article_id:
                    expected_keys.add("sys_id")
                source_url = urlsplit(self.url)
                request_uri = source_url.path + ("?" + source_url.query if source_url.query else "")
                if len(query) != len(pairs) or set(query) != expected_keys or query.get("portal_id") != PORTAL or query.get("id") != self.request_page_id or query.get("sys_id") != article_id or query.get("request_uri") != request_uri or not re.fullmatch(r"[0-9]{13}", query.get("time", "")):
                    raise ValueError()
                binding = {"portal_id": query["portal_id"], "request_page_id": query.get("id"), "request_uri": query["request_uri"],
                           "url_sha256": digest(raw_url), "path": parsed.path, "query_sha256": digest(parsed.query)}
            except (ValueError, TypeError, UnicodeError):
                self.fail("publisher_json_query_binding")
                return
        item = {"raw_id": raw_id, "raw_url": raw_url, "frame_id": self.frame_id, "lane": lane,
                "request_id_sha256": digest(raw_id), "binding": binding, "response": None,
                "decoded_bytes": 0, "data_seen": False, "finished": False}
        self.requests[lane], self.by_id[raw_id] = item, item

    def response(self, event):
        item = self.by_id.get(event.get("requestId"))
        if not item:
            return
        response = event.get("response") or {}
        mime = response.get("mimeType")
        expected = ("application/json",) if item["lane"] == "response" else ("text/html", "application/xhtml+xml")
        if item["response"] is not None or event.get("frameId") != self.frame_id or response.get("url") != item["raw_url"] or type(response.get("status")) is not int or response.get("status") != 200 or mime not in expected:
            self.fail("publisher_json_response_identity")
            return
        if any(response.get(k) is True or k in response and type(response[k]) is not bool for k in ("fromDiskCache", "fromServiceWorker", "fromPrefetchCache")):
            self.fail("publisher_json_cached_response")
            return
        item["response"] = {"content_type": mime, "status_code": 200}

    def data(self, event):
        item = self.by_id.get(event.get("requestId"))
        if not item:
            return
        size = event.get("dataLength")
        if not integer(size):
            self.fail("publisher_json_invalid_decoded_bytes")
            return
        limit = BODY_LIMIT if item["lane"] == "response" else MAIN_LIMIT
        item["decoded_bytes"] = min(limit + 1, item["decoded_bytes"] + size)
        item["data_seen"] = item["data_seen"] or size > 0
        if item["decoded_bytes"] > limit:
            self.fail("publisher_json_decoded_body_limit")

    def finished(self, event):
        item = self.by_id.get(event.get("requestId"))
        if item:
            if item["finished"]:
                self.fail("publisher_json_duplicate_finish")
            item["finished"] = True

    def failed(self, event):
        if event.get("requestId") in self.by_id:
            self.fail("publisher_json_loading_failed")

    def cached(self, event):
        if event.get("requestId") in self.by_id:
            self.fail("publisher_json_cached_response")

    def observation(self, session, html, navigation):
        if self.attempted:
            raise PublisherJsonError("publisher_json_body_already_attempted")
        if self.now() - self.started > DURATION:
            self.fail("publisher_json_observation_timeout")
        if self.failure:
            raise PublisherJsonError(self.failure)
        if set(self.requests) != {"navigation", "response"}:
            raise PublisherJsonError("publisher_json_request_pair_missing")
        for item in self.requests.values():
            if not item["response"] or not item["finished"] or not item["data_seen"] or item["decoded_bytes"] <= 0:
                raise PublisherJsonError("publisher_json_request_pair_incomplete")
        portal = boot_portal_id(html)
        main, item = self.requests["navigation"], self.requests["response"]
        if navigation.get("url") != self.url or navigation.get("final_url") != self.url or navigation.get("status_code") != 200 or not re.fullmatch(r"(?:text/html|application/xhtml\+xml)(?:;[^\r\n]{0,200})?", navigation.get("content_type", "")) or portal != item["binding"]["portal_id"]:
            raise PublisherJsonError("publisher_json_navigation_binding")
        before = (item["decoded_bytes"], dict(item["response"]))
        self.attempted = True  # Failed reads are never retried.
        try:
            result = session.send("Network.getResponseBody", {"requestId": item["raw_id"]})
            if self.failure or self.now() - self.started > DURATION or (item["decoded_bytes"], item["response"]) != before or not item["finished"]:
                raise ValueError()
            body = result.get("body")
            if not isinstance(body, str) or type(result.get("base64Encoded", False)) is not bool:
                raise ValueError()
            if result.get("base64Encoded") is True:
                if len(body) > ((BODY_LIMIT + 2) // 3) * 4:
                    raise ValueError()
                raw = base64.b64decode(body, validate=True)
            else:
                if len(body) > BODY_LIMIT:
                    raise ValueError()
                raw = body.encode("utf-8", errors="strict")
            if len(raw) != before[0] or not 0 < len(raw) <= BODY_LIMIT:
                raise ValueError()
            text = raw.decode("utf-8", errors="strict")
            parsed = strict_json(text)
            if not isinstance(parsed, dict):
                raise ValueError()
        except PublisherJsonError:
            raise
        except Exception:
            raise PublisherJsonError("publisher_json_body_unavailable_or_mismatch") from None
        frame_hash = digest(self.frame_id)
        return {"schema": SCHEMA, "profile": PROFILE, "source_id": self.source_id, "source_url": self.url,
                "captured_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "navigation": {"url": self.url, "final_url": navigation["final_url"], "method": "GET", "status_code": 200,
                               "content_type": navigation["content_type"], "request_id_sha256": main["request_id_sha256"],
                               "frame_id_sha256": frame_hash, "portal_id": portal, "base_hrefs": ["/smart"]},
                "response": {**item["binding"], "request_id_sha256": item["request_id_sha256"], "frame_id_sha256": frame_hash,
                             "method": "GET", "status_code": 200, "content_type": "application/json", "from_cache": False,
                             "from_service_worker": False, "redirected": False, "finished": True,
                             "decoded_bytes": len(raw), "raw_sha256": digest(raw)}, "raw_json": text}
