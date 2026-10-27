"""Synthetic only. No browser, request, provider, archive or database access."""
import base64
import json
from pathlib import Path
import ast
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.parse import urlencode
from smart_publisher_json import (SmartPublisherJson, PublisherJsonError, SOURCES, SOURCE_OWNERS, ARTICLE_SYS_IDS, OWNER, PORTAL, HOMEPAGE,
                                  BODY_LIMIT, boot_portal_id, digest)

# Independent fixed-clock byte receipts from the reviewed pre-extension pure
# observers. Normal tests never load another checkout or make a live request.
FROZEN_OBSERVATION_SHA256 = {
    "58aefec0-0d42-4b7b-9887-60d25940b3d0": "8862c1f4fb2ffa621809ca5e5075f2f3bc1ce866560614f3f282448e3772b32e",
    "c33cc2f4-2cbd-458c-b630-537eb3d50f72": "124bd0126608050c8723662533a48fff1c4afa915cdd058f4bd8eaab38e8fc0a",
    "203baaf3-2905-4fdf-b4af-af84998195a8": "10a3b0e13df5b3d41ae7b1637ec210cf03db2b07fea38eb03f995a369282e25c",
    "2562f7c2-4709-4d63-ac25-c4638733a981": "bc11a2ccc363b89be75be9a13f2970a3b2a080d1b16dc00198e6b82647d9aaa5",
    "39685b8a-3ad9-41c5-834b-b2aaafb2b0e5": "c7da79b68dc01fb9b27725cb9291d065c0fd22f5652f228c0f8064f062b72512",
}


def boot(portal=PORTAL):
    literal = json.dumps(json.dumps({"sys_id": portal, "homepage": HOMEPAGE, "homepage_dv": "smart_index"}))
    return '<html><base href="/smart"><script>window.NOW.portal_id="' + portal + '";</script><script data-description="set sp.dependencies">var portal=JSON.parse(' + literal + ');</script></html>'


class Session:
    def __init__(self, body='{"result":{"public":true}}'):
        self.body, self.calls, self.handlers, self.callback = body, [], {}, None

    def on(self, name, callback):
        self.handlers[name] = callback

    def send(self, name, value=None):
        self.calls.append((name, value))
        if name == "Page.getFrameTree":
            return {"frameTree": {"frame": {"id": "main-frame"}}}
        if name == "Network.getResponseBody":
            if self.callback:
                self.callback()
            return {"body": self.body, "base64Encoded": False}
        return {}


class Tests(unittest.TestCase):
    def pair(self, source_id=None, body='{"result":{"public":true}}'):
        source_id = source_id or next(iter(SOURCES))
        url, page_id = SOURCES[source_id]
        observer, session = SmartPublisherJson(source_id, url, SOURCE_OWNERS.get(source_id, OWNER)), Session(body)
        observer.attach(session)
        self.complete(observer, "main", url, "Document", "text/html", "public initial HTML")
        parsed = url.split(".org", 1)[1]
        query = {"time": "1793070000000", "portal_id": PORTAL, "request_uri": parsed}
        if page_id:
            query["id"] = page_id
        if source_id in ARTICLE_SYS_IDS:
            query["sys_id"] = ARTICLE_SYS_IDS[source_id]
        api = "https://www.smartscholarship.org/api/now/sp/page?" + urlencode(query)
        self.complete(observer, "api", api, "XHR", "application/json", body)
        return observer, session, {"url": url, "final_url": url, "status_code": 200, "content_type": "text/html; charset=utf-8"}

    def complete(self, observer, key, url, resource, mime, text):
        observer.request({"requestId": key, "frameId": "main-frame", "type": resource,
                          "request": {"url": url, "method": "GET", "headers": {"Authorization": "PRIVATE_HEADER"}}})
        observer.response({"requestId": key, "frameId": "main-frame", "response": {"url": url, "status": 200, "mimeType": mime}})
        observer.data({"requestId": key, "dataLength": len(text.encode())})
        observer.finished({"requestId": key})

    def test_all_finite_sources_return_a_distinct_bound_snapshot(self):
        for source_id in SOURCES:
            with self.subTest(source=source_id):
                observer, session, navigation = self.pair(source_id)
                result = observer.observation(session, boot(), navigation)
                self.assertEqual(result["source_id"], source_id)
                self.assertEqual(result["navigation"]["portal_id"], PORTAL)
                self.assertEqual(result["navigation"]["base_hrefs"], ["/smart"])
                self.assertEqual(result["response"]["frame_id_sha256"], result["navigation"]["frame_id_sha256"])
                self.assertEqual(result["response"]["raw_sha256"], digest(session.body))
                self.assertEqual(result["response"]["request_page_id"], SOURCES[source_id][1])
                self.assertEqual([x[0] for x in session.calls], ["Page.getFrameTree", "Network.enable", "Network.getResponseBody"])
                self.assertNotIn("PRIVATE_HEADER", json.dumps(result))
                self.assertNotIn("html", result)
                self.assertNotIn("publishable", result)
                self.assertNotIn("readiness", result)

    def test_finite_identity_is_not_a_hostname_allowlist(self):
        key = next(iter(SOURCES))
        for args in [(key, SOURCES[key][0], "wrong"), ("other", SOURCES[key][0], OWNER),
                     (key, SOURCES[key][0] + "?other=1", OWNER), (key, "http://www.smartscholarship.org/smart", OWNER)]:
            with self.assertRaises(PublisherJsonError):
                SmartPublisherJson(*args)

    def test_boot_requires_constant_public_portal_object_and_NOW_agreement(self):
        self.assertEqual(boot_portal_id(boot()), PORTAL)
        for html in [boot("0" * 32), boot().replace("window.NOW.portal_id", "window.OTHER.portal_id"),
                     boot() + boot(), boot().replace('var portal=JSON.parse(', 'var portal=runCode('),
                     boot().replace('data-description="set sp.dependencies"', 'data-description="other"'),
                     boot().replace('sys_id', 'wrong')]:
            with self.subTest(shape=html[:20]), self.assertRaises(PublisherJsonError):
                boot_portal_id(html)

    def test_boot_single_quoted_actual_publisher_literal_style(self):
        payload = json.dumps({"sys_id": PORTAL, "homepage": HOMEPAGE, "homepage_dv": "smart_index"}).replace('"', '\\"')
        html = "<base href='/smart'><script>NOW.portal_id='" + PORTAL + "';</script><script data-description='set sp.dependencies'>var portal=JSON.parse('" + payload + "');</script>"
        self.assertEqual(boot_portal_id(html), PORTAL)
        with self.assertRaises(PublisherJsonError):
            boot_portal_id(html.replace("JSON.parse('", "JSON.parse(('"))
        for changed in [html.replace(HOMEPAGE, "0" * 32), html.replace("smart_index", "different_page")]:
            with self.assertRaises(PublisherJsonError):
                boot_portal_id(changed)

    def test_boot_ambiguous_assignments_and_duplicate_attributes_are_held(self):
        for html in [boot().replace("</script>", ";NOW.portal_id=unobserved;</script>", 1),
                     boot().replace("</script></html>", ";var portal=unobserved;</script></html>"),
                     boot().replace('data-description="set sp.dependencies"', 'data-description="other" data-description="set sp.dependencies"')]:
            with self.assertRaises(PublisherJsonError):
                boot_portal_id(html)

    def test_every_unreviewed_missing_or_multiple_base_is_rejected_before_link_resolution(self):
        for tag in ['', '<base>', '<base href="https://elsewhere.example/">', '<base href="https://www.smartscholarship.org/smart">',
                    '<BASE HREF="/different/" />', '<base href="smart">', '<base target="_blank">',
                    '<base href="/smart" target="_blank">', '<base href="/smart" href="/smart">',
                    '<base href="/smart"><base href="/smart">']:
            observer, session, navigation = self.pair()
            with self.assertRaisesRegex(PublisherJsonError, "^publisher_json_base_tag$"):
                observer.observation(session, boot().replace('<base href="/smart">', tag), navigation)
            self.assertNotIn("Network.getResponseBody", [x[0] for x in session.calls])

    def test_literal_base_inside_script_or_comment_is_not_an_HTML_base_element(self):
        html = boot().replace("<html>", '<html><!-- <base href="/not-real"> --><script>var harmless="<base>";</script>')
        self.assertEqual(boot_portal_id(html), PORTAL)
        observer, session, navigation = self.pair()
        self.assertEqual(observer.observation(session, html, navigation)["navigation"]["base_hrefs"], ["/smart"])

    def test_missing_incomplete_or_zero_byte_pairs_do_not_read_body(self):
        for change in [lambda o: o.requests.pop("navigation"), lambda o: o.requests.pop("response"),
                       lambda o: o.requests["response"].update(finished=False),
                       lambda o: o.requests["navigation"].update(finished=False),
                       lambda o: o.requests["response"].update(data_seen=False),
                       lambda o: o.requests["response"].update(decoded_bytes=0),
                       lambda o: o.requests["response"].update(response=None)]:
            observer, session, navigation = self.pair(); change(observer)
            with self.assertRaises(PublisherJsonError):
                observer.observation(session, boot(), navigation)
            self.assertNotIn("Network.getResponseBody", [x[0] for x in session.calls])

    def test_redirect_cache_failure_and_frame_races_fail_closed(self):
        for event, args in [("cached", {"requestId": "api"}), ("failed", {"requestId": "api"}),
                            ("request", {"requestId": "api", "redirectResponse": {}}),
                            ("response", {"requestId": "api", "frameId": "other", "response": {}})]:
            observer, session, navigation = self.pair(); getattr(observer, event)(args)
            with self.assertRaises(PublisherJsonError):
                observer.observation(session, boot(), navigation)
            self.assertNotIn("Network.getResponseBody", [x[0] for x in session.calls])

    def test_wrong_response_status_mime_cache_or_url_rejected(self):
        for patch in [{"status": 302}, {"status": 200.0}, {"mimeType": "text/html"},
                      {"fromDiskCache": True}, {"fromServiceWorker": True}, {"fromPrefetchCache": True},
                      {"fromDiskCache": "false"}, {"url": "https://www.smartscholarship.org/account"}]:
            observer, session, navigation = self.pair(); item = observer.requests["response"]; item["response"] = None
            response = {"url": item["raw_url"], "status": 200, "mimeType": "application/json", **patch}
            observer.response({"requestId": "api", "frameId": "main-frame", "response": response})
            with self.assertRaises(PublisherJsonError):
                observer.observation(session, boot(), navigation)

    def test_second_or_wrong_method_frame_resource_API_is_never_accepted(self):
        for patch in [{"frameId": "sub-frame"}, {"type": "Script"}, {"request": {"method": "POST"}}]:
            observer, session, navigation = self.pair(); raw = observer.requests["response"]["raw_url"]
            observer.requests.pop("response"); observer.by_id.pop("api")
            event = {"requestId": "new", "frameId": "main-frame", "type": "XHR", "request": {"method": "GET", "url": raw}}
            if "request" in patch:
                event["request"].update(patch["request"])
            else:
                event.update(patch)
            observer.request(event)
            with self.assertRaises(PublisherJsonError):
                observer.observation(session, boot(), navigation)
        observer, session, navigation = self.pair()
        observer.request({"requestId": "second", "frameId": "main-frame", "type": "XHR", "request": {"url": observer.requests["response"]["raw_url"], "method": "GET"}})
        with self.assertRaises(PublisherJsonError):
            observer.observation(session, boot(), navigation)

    def test_query_portal_page_request_URI_duplicates_unknowns_and_nonce_not_guessed(self):
        for suffix in ["&id=wrong", "&portal_id=other", "&request_uri=%2Faccount", "&nonce=PRIVATE_NONCE", "#fragment"]:
            observer, session, navigation = self.pair()
            raw = observer.requests["response"]["raw_url"] + suffix
            observer.requests.pop("response"); observer.by_id.pop("api")
            observer.request({"requestId": "api", "frameId": "main-frame", "type": "Fetch", "request": {"url": raw, "method": "GET"}})
            with self.assertRaises(PublisherJsonError):
                observer.observation(session, boot(), navigation)
            self.assertNotIn("Network.getResponseBody", [x[0] for x in session.calls])

    def test_decoded_limit_and_invalid_counts_precede_body_retrieval(self):
        for size in [BODY_LIMIT + 1, -1, True, 1.5, None]:
            observer, session, navigation = self.pair(); observer.data({"requestId": "api", "dataLength": size})
            with self.assertRaises(PublisherJsonError):
                observer.observation(session, boot(), navigation)
            self.assertNotIn("Network.getResponseBody", [x[0] for x in session.calls])

    def test_timeout_before_or_during_get_never_returns_partial_data(self):
        observer, session, navigation = self.pair(); observer.now = lambda: observer.started + 46
        with self.assertRaises(PublisherJsonError):
            observer.observation(session, boot(), navigation)
        observer, session, navigation = self.pair(); session.callback = lambda: setattr(observer, "now", lambda: observer.started + 46)
        with self.assertRaises(PublisherJsonError):
            observer.observation(session, boot(), navigation)

    def test_late_cache_or_byte_change_rejects_and_body_never_retries(self):
        for callback in [lambda o: o.cached({"requestId": "api"}), lambda o: o.data({"requestId": "api", "dataLength": 1})]:
            observer, session, navigation = self.pair(); session.callback = lambda: callback(observer)
            with self.assertRaises(PublisherJsonError):
                observer.observation(session, boot(), navigation)
            with self.assertRaisesRegex(PublisherJsonError, "already_attempted"):
                observer.observation(session, boot(), navigation)
            self.assertEqual(len([x for x in session.calls if x[0] == "Network.getResponseBody"]), 1)

    def test_failed_body_read_is_one_attempt_and_error_contains_no_source_details(self):
        observer, session, navigation = self.pair()
        original = session.send
        def failed(name, args=None):
            if name == "Network.getResponseBody":
                session.calls.append((name, args))
                raise RuntimeError("PRIVATE_SOURCE_NONCE_HEADER")
            return original(name, args)
        session.send = failed
        with self.assertRaisesRegex(PublisherJsonError, "^publisher_json_body_unavailable_or_mismatch$"):
            observer.observation(session, boot(), navigation)
        with self.assertRaisesRegex(PublisherJsonError, "already_attempted"):
            observer.observation(session, boot(), navigation)
        self.assertEqual(len([x for x in session.calls if x[0] == "Network.getResponseBody"]), 1)

    def test_unrelated_requests_do_not_fill_or_create_a_programme_pair(self):
        observer, session, navigation = self.pair()
        for i in range(100):
            observer.request({"requestId": str(i), "frameId": "main-frame", "type": "Script",
                              "request": {"url": "https://www.smartscholarship.org/scripts/library.js", "method": "GET"}})
        self.assertEqual(len(observer.requests), 2)
        self.assertEqual(len(observer.by_id), 2)
        self.assertEqual(observer.observation(session, boot(), navigation)["response"]["finished"], True)

    def test_raw_length_utf8_and_duplicate_JSON_keys_are_exact(self):
        for body in ['{"a":1,"a":2}', '{"a":{"b":1,"b":2}}', '[]', 'null', '{"a":NaN}', '{broken']:
            observer, session, navigation = self.pair(body=body)
            with self.assertRaises(PublisherJsonError):
                observer.observation(session, boot(), navigation)
        observer, session, navigation = self.pair(); session.body += " "
        with self.assertRaises(PublisherJsonError):
            observer.observation(session, boot(), navigation)

    def test_unicode_and_base64_preserve_actual_UTF8_body(self):
        body = json.dumps({"title": "海洋😀e\u0301"}, ensure_ascii=False)
        observer, session, navigation = self.pair(body=body)
        original = session.send
        session.send = lambda name, args=None: {"body": base64.b64encode(body.encode()).decode(), "base64Encoded": True} if name == "Network.getResponseBody" else original(name, args)
        self.assertEqual(observer.observation(session, boot(), navigation)["raw_json"], body)

    def test_navigation_boot_and_source_must_remain_exact(self):
        for patch in [{"final_url": "https://www.smartscholarship.org/account"}, {"status_code": 201},
                      {"content_type": "application/json"}, {"url": "https://www.smartscholarship.org/smart?other"}]:
            observer, session, navigation = self.pair(); navigation.update(patch)
            with self.assertRaises(PublisherJsonError):
                observer.observation(session, boot(), navigation)

    def test_observer_has_no_transport_or_script_execution_primitive(self):
        text = Path(__file__).with_name("smart_publisher_json.py").read_text()
        tree = ast.parse(text)
        names = [n.func.id for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)]
        self.assertNotIn("eval", names); self.assertNotIn("exec", names); self.assertNotIn("open", names)
        sends = [n.args[0].value for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "send"]
        self.assertEqual(sorted(sends), sorted(["Page.getFrameTree", "Network.enable", "Network.getResponseBody"]))

    def test_exact_six_sources_only_and_three_registered_alias_owners(self):
        self.assertEqual(len(SOURCES), 6)
        self.assertEqual(len(ARTICLE_SYS_IDS), 3)
        self.assertEqual(set(SOURCE_OWNERS), {"2562f7c2-4709-4d63-ac25-c4638733a981", "39685b8a-3ad9-41c5-834b-b2aaafb2b0e5", "92eebc07-7392-4136-ba13-d9cd5455c8f9"})
        self.assertIn("92eebc07-7392-4136-ba13-d9cd5455c8f9", SOURCES)
        for source_id in ARTICLE_SYS_IDS:
            owner = SOURCE_OWNERS.get(source_id, OWNER)
            SmartPublisherJson(source_id, SOURCES[source_id][0], owner)
            for wrong in {OWNER, "1efa2a75-e6b8-4bf6-80be-85ef2f6b3108", "unregistered"} - {owner}:
                with self.subTest(source=source_id, wrong_owner=wrong), self.assertRaisesRegex(PublisherJsonError, "source_identity"):
                    SmartPublisherJson(source_id, SOURCES[source_id][0], wrong)

    def test_KB_routes_cannot_be_reordered_normalized_or_swapped(self):
        for source_id in ARTICLE_SYS_IDS:
            url = SOURCES[source_id][0]
            for changed in [url.replace("?id=kb_article&sys_id=", "?sys_id=") + "&id=kb_article", url.replace("/smart?", "/smart/en?"),
                            url + "&view=other", url.replace(ARTICLE_SYS_IDS[source_id], "0" * 32)]:
                if changed == url:
                    continue
                with self.subTest(source=source_id), self.assertRaisesRegex(PublisherJsonError, "source_identity"):
                    SmartPublisherJson(source_id, changed, SOURCE_OWNERS.get(source_id, OWNER))

    def test_KB_API_requires_exact_copied_article_parameter_and_entire_navigation_URI(self):
        for source_id in ARTICLE_SYS_IDS:
            for mutation in [lambda q: q.pop("sys_id"), lambda q: q.update(sys_id="0" * 32),
                             lambda q: q.update(request_uri=q["request_uri"].replace(ARTICLE_SYS_IDS[source_id], "0" * 32)),
                             lambda q: q.update(id="smart_eligibility"), lambda q: q.update(extra="unreviewed")]:
                observer, session, navigation = self.pair(source_id)
                from urllib.parse import parse_qsl, urlsplit
                query = dict(parse_qsl(urlsplit(observer.requests["response"]["raw_url"]).query)); mutation(query)
                observer.requests.pop("response"); observer.by_id.pop("api")
                observer.request({"requestId": "api", "frameId": "main-frame", "type": "XHR", "request": {
                    "method": "GET", "url": "https://www.smartscholarship.org/api/now/sp/page?" + urlencode(query)}})
                with self.subTest(source=source_id), self.assertRaisesRegex(PublisherJsonError, "query_binding"):
                    observer.observation(session, boot(), navigation)
                self.assertNotIn("Network.getResponseBody", [c[0] for c in session.calls])

    def test_KB_duplicate_article_parameter_is_not_collapsed_into_a_valid_binding(self):
        for source_id in ARTICLE_SYS_IDS:
            observer, session, navigation = self.pair(source_id)
            url = observer.requests["response"]["raw_url"] + "&sys_id=" + ARTICLE_SYS_IDS[source_id]
            observer.requests.pop("response"); observer.by_id.pop("api")
            observer.request({"requestId": "api", "frameId": "main-frame", "type": "XHR", "request": {"method": "GET", "url": url}})
            with self.assertRaisesRegex(PublisherJsonError, "query_binding"):
                observer.observation(session, boot(), navigation)

    def test_KB_incomplete_cached_redirected_post_crossframe_and_oversize_still_never_read(self):
        mutations = [lambda o: o.requests["response"].update(finished=False), lambda o: o.cached({"requestId": "api"}),
                     lambda o: o.failed({"requestId": "api"}), lambda o: o.data({"requestId": "api", "dataLength": BODY_LIMIT + 1}),
                     lambda o: o.request({"requestId": "api", "redirectResponse": {}})]
        for source_id in ARTICLE_SYS_IDS:
            for mutation in mutations:
                observer, session, navigation = self.pair(source_id); mutation(observer)
                with self.assertRaises(PublisherJsonError):
                    observer.observation(session, boot(), navigation)
                self.assertNotIn("Network.getResponseBody", [c[0] for c in session.calls])
            for method, frame in [("POST", "main-frame"), ("GET", "subframe")]:
                observer, session, navigation = self.pair(source_id)
                raw = observer.requests["response"]["raw_url"]; observer.requests.pop("response"); observer.by_id.pop("api")
                observer.request({"requestId": "api", "frameId": frame, "type": "XHR", "request": {"method": method, "url": raw}})
                with self.assertRaisesRegex(PublisherJsonError, "frame_or_method"):
                    observer.observation(session, boot(), navigation)
                self.assertNotIn("Network.getResponseBody", [c[0] for c in session.calls])

    def test_old_two_observation_bytes_match_frozen_previous_receipts_with_fixed_clock(self):
        fixed = SimpleNamespace(now=lambda _tz: __import__("datetime").datetime(2026, 10, 27, 6, 0, tzinfo=__import__("datetime").timezone.utc))
        for source_id in list(FROZEN_OBSERVATION_SHA256)[:2]:
            observer, session, navigation = self.pair(source_id)
            with patch("smart_publisher_json.datetime", fixed):
                current = observer.observation(session, boot(), navigation)
            self.assertEqual(digest(json.dumps(current, ensure_ascii=False)), FROZEN_OBSERVATION_SHA256[source_id])

    def test_own_home_alias_identity_does_not_become_the_canonical_home_source(self):
        source_id = "92eebc07-7392-4136-ba13-d9cd5455c8f9"
        observer, session, navigation = self.pair(source_id)
        result = observer.observation(session, boot(), navigation)
        self.assertEqual(result["source_id"], source_id)
        self.assertEqual(result["source_url"], "https://www.smartscholarship.org/smart/en")
        self.assertEqual(result["response"]["request_uri"], "/smart/en")
        self.assertIsNone(result["response"]["request_page_id"])
        for url, owner in [(SOURCES[source_id][0], OWNER), ("https://www.smartscholarship.org/smart", SOURCE_OWNERS[source_id]),
                           (SOURCES[source_id][0] + "/", SOURCE_OWNERS[source_id])]:
            with self.assertRaisesRegex(PublisherJsonError, "source_identity"):
                SmartPublisherJson(source_id, url, owner)

    def test_home_alias_copies_no_id_or_sys_id_and_rejects_another_navigation_route(self):
        source_id = "92eebc07-7392-4136-ba13-d9cd5455c8f9"
        for suffix in ["&id=smart_index", "&sys_id=" + "0" * 32, "&request_uri=%2Fsmart"]:
            observer, session, navigation = self.pair(source_id)
            raw = observer.requests["response"]["raw_url"] + suffix
            observer.requests.pop("response"); observer.by_id.pop("api")
            observer.request({"requestId": "api", "frameId": "main-frame", "type": "XHR", "request": {"method": "GET", "url": raw}})
            with self.assertRaisesRegex(PublisherJsonError, "query_binding"):
                observer.observation(session, boot(), navigation)
            self.assertNotIn("Network.getResponseBody", [c[0] for c in session.calls])

    def test_home_alias_keeps_all_complete_fresh_bounded_triple_guards(self):
        source_id = "92eebc07-7392-4136-ba13-d9cd5455c8f9"
        for mutation in [lambda o: o.cached({"requestId": "api"}), lambda o: o.failed({"requestId": "api"}),
                         lambda o: o.requests["response"].update(finished=False), lambda o: o.data({"requestId": "api", "dataLength": BODY_LIMIT + 1}),
                         lambda o: setattr(o, "now", lambda: o.started + 46)]:
            observer, session, navigation = self.pair(source_id); mutation(observer)
            with self.assertRaises(PublisherJsonError):
                observer.observation(session, boot(), navigation)
            self.assertNotIn("Network.getResponseBody", [c[0] for c in session.calls])

    def test_all_five_previous_profile_observation_bytes_are_unchanged(self):
        fixed = SimpleNamespace(now=lambda _tz: __import__("datetime").datetime(2026, 10, 27, 6, 0, tzinfo=__import__("datetime").timezone.utc))
        for source_id, expected_sha256 in FROZEN_OBSERVATION_SHA256.items():
            observer, session, navigation = self.pair(source_id)
            with patch("smart_publisher_json.datetime", fixed):
                current = observer.observation(session, boot(), navigation)
            self.assertEqual(digest(json.dumps(current, ensure_ascii=False)), expected_sha256)


class CollectorIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Pure tests above need only Python. These mock-only integration cases
        # additionally use the normal collector's installed dependencies.
        try:
            import collector
            cls.collector = collector
        except ModuleNotFoundError as error:
            raise unittest.SkipTest("Normal collector dependencies unavailable: " + error.name) from None

    def test_opt_in_normal_navigation_hooks_return_only_typed_response(self):
        self.run_capture(False)

    def test_opt_in_does_not_accept_an_API_from_a_subframe(self):
        with self.assertRaisesRegex(self.collector.CaptureFailure, "publisher_json_request_frame_or_method"):
            self.run_capture(True)

    def run_capture(self, wrong_frame):
        source_id = next(iter(SOURCES)); url = SOURCES[source_id][0]
        request = {"source_id": source_id, "url": url, "shared_award_id": OWNER,
                   "publisher_json_profile": "smart-page-v1", "proxy_url": "http://127.0.0.1:1",
                   "executable_path": str(Path(__file__).resolve())}
        session, callbacks = Session(), {}
        context = SimpleNamespace(route_web_socket=Mock(), route=Mock(), on=Mock(), new_cdp_session=Mock(return_value=session))
        page = SimpleNamespace(context=context, main_frame=object(), url=url, close=Mock(),
                               on=lambda name, callback: callbacks.setdefault(name, []).append(callback))
        observation = {"url": url, "html": boot(), "captured_at": "2026-10-27T04:00:00Z"}
        def fake_fetch(_url, **options):
            self.assertEqual(_url, url)
            self.assertEqual(options["additional_args"]["ignore_https_errors"], False)
            self.assertEqual(options["additional_args"]["service_workers"], "block")
            self.assertEqual(options["retries"], 1)
            options["page_setup"](page)
            for key, target, resource, mime, text in [
                ("main", url, "Document", "text/html", "initial public HTML"),
                ("api", "https://www.smartscholarship.org/api/now/sp/page?" + urlencode({"time": "1793070000000", "portal_id": PORTAL, "request_uri": "/smart"}), "XHR", "application/json", session.body)]:
                frame = "different-frame" if wrong_frame and key == "api" else "main-frame"
                session.handlers["Network.requestWillBeSent"]({"requestId": key, "frameId": frame, "type": resource, "request": {"method": "GET", "url": target}})
                session.handlers["Network.responseReceived"]({"requestId": key, "frameId": frame, "response": {"url": target, "status": 200, "mimeType": mime}})
                session.handlers["Network.dataReceived"]({"requestId": key, "dataLength": len(text.encode())})
                session.handlers["Network.loadingFinished"]({"requestId": key})
            main_request = SimpleNamespace(is_navigation_request=lambda: True, frame=page.main_frame)
            response = SimpleNamespace(request=main_request, url=url, status=200, headers={"content-type": "text/html; charset=utf-8"})
            for callback in callbacks["response"]:
                callback(response)
            options["page_action"](page)
        with patch.object(self.collector.DynamicFetcher, "fetch", side_effect=fake_fetch) as fetch, \
                patch.object(self.collector, "collect_stable", return_value=(observation, {"text": "public programme"}, {})) as stable:
            result = self.collector.capture(request)
        fetch.assert_called_once(); stable.assert_called_once_with(page)
        self.assertEqual(result["schema"], "awardping.scrapling-publisher-json-observation.v1")
        self.assertEqual(result["raw_json"], session.body)
        self.assertNotIn("html", result); self.assertNotIn("readiness", result)
        context.route_web_socket.assert_called_once()
        return result


if __name__ == "__main__":
    unittest.main()
