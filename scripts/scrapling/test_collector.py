"""Browser fixtures use local fulfillment or a loopback mock with no forwarding."""

import base64
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import logging
from threading import Thread
import unittest
from unittest.mock import patch

from playwright.sync_api import Page, WebSocketRoute, sync_playwright

from collector import CaptureFailure, EVIDENCE_PROFILE, capture, collect_stable, discover_html_links, jpeg_dimensions, observe, parse_projection, require_document_response_url, screenshot_bounds, validate_url
from html_document import extract_html_document


BROWSER = "C:/Program Files/Google/Chrome/Application/chrome.exe"
REQUEST = {"url": "https://example.com/award", "source_id": "fixture", "proxy_url": "http://127.0.0.1:1", "executable_path": BROWSER}


class ProjectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        logging.disable(logging.CRITICAL)
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(executable_path=BROWSER, headless=True,
            args=["--disable-background-networking", "--disable-component-update", "--disable-quic"])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(service_workers="block")
        self.context.route_web_socket("**/*", lambda socket: socket.close())
        self.context.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body="<title>Fixture</title>"))
        self.page = self.context.new_page()
        self.page.goto(REQUEST["url"])

    def tearDown(self):
        self.context.close()

    def document(self, html):
        self.page.set_content("<!doctype html><title>Fixture award</title>" + html)
        return observe(self.page)[1]

    def test_hidden_duplicates_and_computed_transform(self):
        doc = self.document('<h1>Eligibility</h1><p style="text-transform:uppercase">For U.S. applicants only.</p>'
                            '<p style="display:none">SECRET 2028</p><p style="visibility:hidden">SECRET 2029</p>'
                            '<div style="opacity:0"><p>SECRET 2030</p></div><p>Deadline January 1, 2027.</p>')
        self.assertEqual(doc["text"], "Eligibility FOR U.S. APPLICANTS ONLY. Deadline January 1, 2027.")
        self.assertNotIn("SECRET", str(doc))

    def test_html_opacity_applies_to_all_descendants(self):
        doc = self.document('<style>html {opacity:0}</style><h1>Award January 1, 2027.</h1><p>Not visible.</p>')
        self.assertEqual(doc["text"], "")
        self.assertEqual(doc["blocks"], [])

    def test_inline_word_and_block_boundaries(self):
        doc = self.document('<h1>Award</h1><p>Dead<span>line</span> <b>for</b> <i>U.S.</i> applicants.</p>'
                            '<p>January<br>1, 2027.</p>')
        self.assertEqual(doc["text"], "Award Deadline for U.S. applicants. January 1, 2027.")

    def test_duplicate_occurrences_not_deduplicated(self):
        doc = self.document('<h1>Award</h1><p>Apply January 1, 2027.</p><p>Apply January 1, 2027.</p>')
        self.assertEqual(sum(block["text"] == "Apply January 1, 2027." for block in doc["blocks"]), 2)

    def test_nested_qualifier_context_and_table_association(self):
        doc = self.document('<h1>Award</h1><h2>U.S. citizens</h2><ul><li>Junior applicants<ul><li>Apply January 1, 2027.</li></ul></li></ul>'
                            '<table><tr><th>International</th><td>March 1, 2027</td></tr></table>')
        child = next(block for block in doc["blocks"] if block["text"] == "Apply January 1, 2027.")
        self.assertIn("Junior applicants", child["list_path"][0])
        self.assertEqual(child["heading_path"][-1]["text"], "U.S. citizens")
        table = next(block for block in doc["blocks"] if block["kind"] == "td")
        self.assertEqual(table["table_row"], ["International", "March 1, 2027"])

    def test_material_mutations_change_document(self):
        template = '<h1>Award</h1><p>{qualifier}: apply {date}.</p><a href="/{link}">Application details</a>'
        baseline = self.document(template.format(qualifier="U.S. applicants", date="January 1, 2027", link="apply"))
        for changes in [dict(qualifier="International applicants", date="January 1, 2027", link="apply"),
                        dict(qualifier="U.S. applicants", date="March 1, 2027", link="apply"),
                        dict(qualifier="U.S. applicants", date="January 1, 2027", link="new-application")]:
            with self.subTest(changes=changes):
                current = self.document(template.format(**changes))
                self.assertNotEqual({k: baseline[k] for k in ("text", "blocks", "links")}, {k: current[k] for k in ("text", "blocks", "links")})

    def test_table_spans_and_header_association_are_preserved(self):
        template = '<h1>Deadlines</h1><table><tr><th id="us" scope="col">U.S. applicants</th><td colspan="{span}" headers="us">January 1, 2027</td></tr></table>'
        before = self.document(template.format(span=1))
        after = self.document(template.format(span=2))
        self.assertEqual(before["text"], after["text"])
        self.assertNotEqual(before["blocks"], after["blocks"])
        cell = next(block for block in after["blocks"] if block["kind"] == "td")
        self.assertEqual(cell["table_cell"], {"colspan": 2, "rowspan": 1, "scope": "", "headers": "us", "id": "", "raw_colspan": "2", "raw_rowspan": "1"})

    def test_outside_main_content_is_not_omitted(self):
        doc = self.document('<aside>International deadline March 1, 2027.</aside><main><p>Main deadline January 1, 2027.</p></main><footer>Conditions apply.</footer>')
        self.assertIn("International deadline", doc["text"])
        self.assertIn("Conditions apply.", doc["text"])

    def test_empty_query_uses_browser_url_semantics_and_retains_raw_href(self):
        doc = self.document('<base href="https://example.edu/apply?cycle=2026"><h1>Award deadline January 1, 2027.</h1>'
                            '<a href="?">New cycle</a><a href="?cycle=2026">Old cycle</a>')
        self.assertEqual([link["url"] for link in doc["links"]], ["https://example.edu/apply?", "https://example.edu/apply?cycle=2026"])
        self.assertEqual([link["raw_href"] for link in doc["links"]], ["?", "?cycle=2026"])

    def test_hidden_links_and_closed_details_do_not_leak(self):
        doc = self.document('<h1>Award deadline January 1, 2027.</h1><a style="visibility:hidden" href="/secret">Hidden</a>'
                            '<details><summary>More information</summary><a href="/closed">Hidden deadline</a></details>'
                            '<a href="/apply">Apply</a>')
        self.assertEqual([link["url"] for link in doc["links"]], ["https://example.com/apply"])
        self.assertIn("closed_sections_not_expanded", doc["limitations"])

    def test_closed_details_do_not_reuse_previously_rendered_answer_layout(self):
        self.document('<h1>Award eligibility</h1><details open id="faq"><summary>Who may apply?</summary>'
                      '<p id="answer">Only U.S. citizens may apply January 1, 2027.</p>'
                      '<a href="/requirements">Application requirements</a></details>')
        self.page.evaluate("""() => {
            document.querySelector('#answer').getBoundingClientRect();
            document.querySelector('#faq').open = false;
        }""")
        observed, doc, _ = observe(self.page)
        self.assertIn("Who may apply?", doc["text"])
        self.assertNotIn("Only U.S. citizens", doc["text"])
        self.assertEqual(doc["links"], [])
        self.assertIn("Only U.S. citizens", extract_html_document(observed["html"], observed["url"])["text"])

    def test_closed_details_css_override_can_really_show_the_answer(self):
        doc = self.document('<style>details::details-content {content-visibility:visible;display:block}</style>'
                            '<h1>Award eligibility</h1><details><summary>Who may apply?</summary>'
                            '<p>Only U.S. citizens may apply January 1, 2027.</p>'
                            '<a href="/requirements">Application requirements</a></details>')
        self.assertIn("Only U.S. citizens", doc["text"])
        self.assertEqual(doc["title"], "Fixture award")
        self.assertEqual(doc["links"][0]["url"], "https://example.com/requirements")
        self.assertEqual(doc["links"][0]["heading_path"], [{"level": 1, "text": "Award eligibility"}])
        self.assertFalse(self.page.locator("details").evaluate("element => element.open"))

    def test_pseudo_hidden_details_keep_only_first_direct_summary(self):
        for style in ("content-visibility:hidden", "display:none", "opacity:0"):
            with self.subTest(style=style):
                self.document('<h1>Award eligibility</h1><details open id="faq">'
                              '<summary><a href="/question">Who may apply?</a></summary>'
                              '<summary>Not the active summary</summary><p>Hidden citizenship condition.</p>'
                              '<details open><summary>Nested question</summary><p>Hidden nested answer.</p>'
                              '<a href="/hidden">Hidden application link</a></details></details>')
                self.page.add_style_tag(content=f"#faq::details-content {{{style}}}")
                observation, doc, _ = observe(self.page)
                self.assertIn("Who may apply?", doc["text"])
                self.assertNotIn("Not the active summary", doc["text"])
                self.assertNotIn("Hidden", doc["text"])
                self.assertNotIn("Nested question", doc["text"])
                self.assertEqual([link["url"] for link in doc["links"]], ["https://example.com/question"])
                self.assertIn("Hidden nested answer.", extract_html_document(observation["html"], observation["url"])["text"])

    def test_open_ancestor_remains_visible_while_nested_closed_answer_does_not(self):
        doc = self.document('<h1>Award eligibility</h1><details open id="outer"><summary>Eligibility</summary>'
                            '<p>Open ancestor answer applies to all applicants.</p>'
                            '<details open id="inner"><summary>Citizenship</summary>'
                            '<p>Only U.S. citizens may apply.</p><a href="/hidden">Hidden guide</a></details>'
                            '<a href="/visible">Application guide</a></details>')
        self.assertIn("Only U.S. citizens", doc["text"])
        self.page.evaluate("document.querySelector('#inner').open=false")
        _, doc, _ = observe(self.page)
        self.assertIn("Open ancestor answer", doc["text"])
        self.assertIn("Citizenship", doc["text"])
        self.assertNotIn("Only U.S. citizens", doc["text"])
        self.assertEqual([link["url"] for link in doc["links"]], ["https://example.com/visible"])
        self.page.evaluate("document.querySelector('#inner').open=true;document.querySelector('#outer').open=false")
        _, closed, _ = observe(self.page)
        self.assertEqual(closed["text"], "Award eligibility Eligibility")
        self.assertEqual(closed["links"], [])

    def test_closed_details_without_explicit_summary_do_not_leak(self):
        self.document('<h1>Award eligibility</h1><details open><p>Hidden award condition.</p>'
                      '<a href="/hidden">Hidden application link</a></details>')
        self.page.evaluate("document.querySelector('details').open=false")
        _, doc, _ = observe(self.page)
        self.assertNotIn("Hidden", doc["text"])
        self.assertEqual(doc["links"], [])

    def test_details_style_binding_is_main_document_only(self):
        doc = self.document('<h1>Award eligibility</h1><template><details><summary>Template question</summary>'
                            '<p>Template answer</p></details></template><div id="shadow"></div>'
                            '<details open><summary>Real question</summary><p>Real answer.</p></details>'
                            '<script>document.querySelector("#shadow").attachShadow({mode:"open"}).innerHTML='
                            '\'<details open><summary>Shadow question</summary><p>Shadow answer</p></details>\'</script>')
        self.assertIn("Real answer.", doc["text"])
        self.assertNotIn("Template", doc["text"])
        self.assertNotIn("Shadow", doc["text"])

    def test_details_style_binding_refuses_count_attributes_or_order_mismatch(self):
        self.document('<h1>Award eligibility</h1><details id="first"><summary>Question one</summary>'
                      '<p>First answer</p></details><details id="second"><summary>Question two</summary>'
                      '<p>Second answer</p></details>')
        evaluate = Page.evaluate
        for mismatch in ("count", "attributes", "order"):
            def mismatched(page, expression, arg=None):
                result = evaluate(page, expression, arg=arg)
                if isinstance(arg, dict) and "links" in arg and "limit" in arg:
                    if mismatch == "count":
                        result["details"].pop()
                    elif mismatch == "attributes":
                        result["details"][0]["attributes"].append(["data-wrong", "identity"])
                    else:
                        result["details"].reverse()
                return result
            with self.subTest(mismatch=mismatch), patch.object(Page, "evaluate", mismatched):
                with self.assertRaisesRegex(CaptureFailure, "content_changed_during_capture"):
                    observe(self.page)

    def test_details_style_changes_participate_in_stability_identity(self):
        self.document('<h1>Award eligibility</h1><details open><summary>Who may apply?</summary>'
                      '<p>Only U.S. citizens may apply January 1, 2027.</p></details>')
        _, before, before_signal = observe(self.page)
        self.page.add_style_tag(content="details::details-content {opacity:0.5}")
        _, after, after_signal = observe(self.page)
        self.assertEqual(before["text"], after["text"])
        self.assertNotEqual(before_signal, after_signal)

    def test_full_html_links_retain_hidden_pdf_and_native_resolution(self):
        self.document('<base href="https://example.edu/apply?cycle=2026"><h1>Award</h1>'
                      '<details><summary>More information</summary><p>For juniors: <a href="?" title="Form" aria-label="Download application" download="award.pdf">Apply now</a></p></details>'
                      '<a hidden href="/hidden.pdf">Hidden guide</a><a>No destination</a>')
        links = discover_html_links(self.page)
        self.assertEqual(len(links), 3)
        self.assertEqual(links[0]["url"], "https://example.edu/apply?")
        self.assertEqual(links[0]["raw_href"], "?")
        self.assertEqual(links[0]["text"], "Apply now")
        self.assertEqual(links[0]["title"], "Form")
        self.assertEqual(links[0]["aria_label"], "Download application")
        self.assertEqual(links[0]["download"], "award.pdf")
        self.assertTrue(links[0]["download_present"])
        self.assertEqual(links[0]["context"], "For juniors: Apply now")
        self.assertEqual(links[1]["url"], "https://example.edu/hidden.pdf")
        self.assertEqual(links[2]["href_attribute"], "")
        self.assertEqual(links[2]["url"], "")

    def test_html_link_bounds_and_explicit_context_truncation(self):
        self.document('<h1>Award</h1><p>' + "qualifier " * 100 + '<a href="/guide.pdf">Guide</a></p>')
        link = discover_html_links(self.page)[0]
        self.assertEqual(len(link["context"]), 800)
        self.assertTrue(link["context_truncated"])
        self.page.set_content('<a href="/guide.pdf" title="' + "x" * 10001 + '">Guide</a>')
        with self.assertRaisesRegex(CaptureFailure, "html_link_field_limit"):
            discover_html_links(self.page)
        self.page.set_content('<a href="/guide.pdf">Guide</a>' * 10001)
        with self.assertRaisesRegex(CaptureFailure, "html_link_count_limit"):
            discover_html_links(self.page)

    def test_native_layout_handles_unselectable_transformed_text(self):
        doc = self.document('<h1>Award deadline January 1, 2027.</h1><p style="user-select:none;text-transform:uppercase">Important eligibility</p>')
        self.assertIn("IMPORTANT ELIGIBILITY", doc["text"])

    def test_native_observation_does_not_change_selection(self):
        self.document('<p>Award deadline January 1, 2027. Applicants must be U.S. citizens.</p>'
                      '<script>window.selectionEvents=0;document.addEventListener("selectionchange",()=>window.selectionEvents++)</script>')
        collect_stable(self.page)
        self.assertEqual(self.page.evaluate("window.selectionEvents"), 0)

    def test_shadow_and_iframe_scope_disclosed(self):
        doc = self.document('<h1>Award deadline January 1, 2027.</h1><iframe srcdoc="Inner details"></iframe>'
                            '<div id="shadow"></div><script>document.querySelector("#shadow").attachShadow({mode:"open"}).innerHTML="Shadow requirements"</script>')
        self.assertIn("iframe_content_not_observed", doc["limitations"])
        self.assertIn("shadow_content_not_observed", doc["limitations"])
        self.assertNotIn("Shadow requirements", doc["text"])

    def test_href_only_instability_is_not_accepted(self):
        self.page.set_content('<p>Award deadline January 1, 2027. Check the application instructions.</p><a href="/a" id="link">Apply</a>'
                              '<script>let n=0;setInterval(()=>document.querySelector("#link").href="/"+(n++),50)</script>')
        with self.assertRaisesRegex(CaptureFailure, "page_not_stable"):
            collect_stable(self.page, stable_ms=1000, max_ms=1400)

    def test_raw_script_noise_does_not_prevent_stability(self):
        self.page.set_content('<p>Award deadline January 1, 2027. Check the application instructions.</p>'
                              '<script id="noise"></script><script>setInterval(()=>document.querySelector("#noise").textContent="/*"+Date.now()+"*/",50)</script>')
        _, _, ready = collect_stable(self.page)
        self.assertTrue(ready["stable"])

    def test_dom_size_limit(self):
        with self.assertRaisesRegex(CaptureFailure, "visible_text_limit"):
            self.document('<p>' + "Award " * 50000 + '</p>')


class FetchTests(unittest.TestCase):
    def fetch_fixture(self, body, status=200, content_type="text/html", profile=None, headers=None):
        seen = []
        def fixture(route):
            seen.append({"url": route.request.url, "method": route.request.method})
            route.fulfill(status=status, content_type=content_type, body=body, headers=headers)
        request = {**REQUEST, **({"capture_profile": profile} if profile else {})}
        result = capture(request, fixture=fixture)
        return result, seen

    def test_same_document_path_or_query_rewrite_is_not_an_http_redirect(self):
        for method, destination in [("replaceState", "/different-award"),
                                    ("pushState", "/award?cycle=2028")]:
            with self.subTest(method=method, destination=destination):
                body = '<h1>Award deadline</h1><p>Apply January 1, 2027. Only U.S. citizens are eligible.</p>' \
                    f'<script>history.{method}({{}}, "", "{destination}")</script>'
                with self.assertRaisesRegex(CaptureFailure, "document_response_url_mismatch"):
                    self.fetch_fixture(body)

    def test_fragment_only_history_rewrite_preserves_http_identity(self):
        result, seen = self.fetch_fixture('<h1>Award deadline</h1><p>Apply January 1, 2027. Only U.S. citizens are eligible.</p>'
            '<script>history.replaceState({}, "", "#eligibility")</script>')
        self.assertEqual(result["url"], REQUEST["url"])
        self.assertEqual(result["final_url"], REQUEST["url"] + "#eligibility")
        self.assertEqual(seen[0]["url"], REQUEST["url"])

    def test_requested_fragment_is_not_sent_to_http_or_treated_as_navigation(self):
        seen = []
        def fixture(route):
            seen.append(route.request.url)
            route.fulfill(status=200, content_type="text/html", body='<h1>Award deadline</h1><p>Apply January 1, 2027. Only U.S. citizens are eligible.</p>')
        result = capture({**REQUEST, "url": REQUEST["url"] + "#eligibility"}, fixture=fixture)
        self.assertEqual(result["url"], REQUEST["url"] + "#eligibility")
        self.assertEqual(result["final_url"], REQUEST["url"] + "#eligibility")
        self.assertEqual(seen[0], REQUEST["url"])

    @contextmanager
    def redirect_fixture(self, status=201, content_type="text/html; charset=utf-8", headers=None):
        # Playwright's route callback does not handle follow-up redirect requests.
        # This HTTP-only mock never opens an upstream connection or forwards data.
        source_url = "http://example.com/award"
        final_url = "http://example.org/current-award?cycle=2027"
        seen = []
        class Handler(BaseHTTPRequestHandler):
            timeout = 2

            def handle(self):
                try:
                    super().handle()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    # Chromium can abandon a rejected background request.
                    pass

            def do_CONNECT(self):
                self.send_response(403)
                self.send_header("Content-Length", "0")
                self.send_header("Connection", "close")
                self.end_headers()

            def do_GET(self):
                seen.append(self.path)
                body = b'<h1>Current award deadline</h1><p>Apply January 1, 2027. Only U.S. citizens are eligible.</p>'
                if self.path == source_url:
                    self.send_response(302)
                    self.send_header("Location", final_url)
                elif self.path == final_url:
                    self.send_response(status)
                    self.send_header("Content-Type", content_type)
                    for key, value in (headers or {}).items():
                        self.send_header(key, value)
                else:
                    self.send_response(404)
                    body = b"Not a fixture route"
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        class Server(ThreadingHTTPServer):
            # server_close joins handlers; every client socket has a 2s timeout.
            daemon_threads = False

        server = Server(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        try:
            yield {**REQUEST, "url": source_url, "proxy_url": f"http://127.0.0.1:{server.server_port}"}, final_url, seen
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive(), "loopback fixture did not stop")

    def test_http_redirect_keeps_source_identity_and_final_response_metadata(self):
        with self.redirect_fixture() as (request, final_url, seen):
            result = capture(request)
            self.assertEqual(result["source_id"], request["source_id"])
            self.assertEqual(result["url"], request["url"])
            self.assertEqual(result["final_url"], final_url)
            self.assertEqual(result["status_code"], 201)
            self.assertEqual(result["content_type"], "text/html; charset=utf-8")
            self.assertEqual(seen[:2], [request["url"], final_url])

    def test_http_redirect_uses_final_refusal_and_content_type(self):
        for status, content_type, reason in [(403, "text/html", "http_403"),
                                             (200, "application/pdf", "non_html_response")]:
            with self.subTest(reason=reason), self.redirect_fixture(status=status, content_type=content_type) as (request, _, _):
                with self.assertRaisesRegex(CaptureFailure, reason):
                    capture(request)

    def test_history_rewrite_after_observation_is_not_accepted(self):
        def changed_after_capture(page):
            result = collect_stable(page)
            page.evaluate('history.replaceState({}, "", "/different-award")')
            return result
        with patch("collector.collect_stable", changed_after_capture), self.assertRaisesRegex(CaptureFailure, "document_response_url_mismatch"):
            self.fetch_fixture('<h1>Award deadline</h1><p>Apply January 1, 2027. Only U.S. citizens are eligible.</p>')

    def test_same_url_reload_after_observation_is_not_the_captured_response(self):
        def reloaded_after_capture(page):
            result = collect_stable(page)
            page.reload(wait_until="domcontentloaded")
            return result
        with patch("collector.collect_stable", reloaded_after_capture), self.assertRaisesRegex(CaptureFailure, "http_response_changed_during_capture"):
            self.fetch_fixture('<h1>Award deadline</h1><p>Apply January 1, 2027. Only U.S. citizens are eligible.</p>')

    def test_response_identity_only_ignores_fragment(self):
        response = {"url": "https://example.com/award?cycle=2027"}
        require_document_response_url(response["url"] + "#eligibility", response)
        for url in ["https://example.com/award?cycle=2028", "https://example.com/other?cycle=2027",
                    "https://example.org/award?cycle=2027", "http://example.com/award?cycle=2027"]:
            with self.subTest(url=url), self.assertRaisesRegex(CaptureFailure, "document_response_url_mismatch"):
                require_document_response_url(url, response)
        with self.assertRaisesRegex(CaptureFailure, "document_response_url_mismatch"):
            require_document_response_url("https://example.com/award?", {"url": "https://example.com/award"})
        with self.assertRaisesRegex(CaptureFailure, "document_response_url_mismatch"):
            require_document_response_url(response["url"], {"status": 200})

    def test_actual_scrapling_capture_and_pre_navigation_guards(self):
        body = '<h1>Award deadline</h1><p>Apply January 1, 2027. Only U.S. citizens are eligible.</p>' \
               '<script>fetch("/write",{method:"POST",body:"no"}).catch(()=>{});document.cookie="isolated=yes";</script>'
        result, seen = self.fetch_fixture(body)
        self.assertEqual(result["engine"]["scrapling"], "0.4.15")
        self.assertEqual(parse_projection({"projection": result["visible_html"], "url": result["final_url"],
            "title": result["document"]["title"], "limitations": result["document"]["limitations"],
            "counts": result["document"]["counts"]}), result["document"])
        self.assertTrue(result["readiness"]["stable"])
        self.assertEqual(result["telemetry"]["blocked_non_get"], 1)
        self.assertTrue(all(item["method"] == "GET" for item in seen))
        self.assertNotIn("isolated", result["text"])
        fresh, _ = self.fetch_fixture('<h1>Award deadline</h1><p>Apply January 1, 2027. Only U.S. citizens are eligible.</p><script>document.body.append(document.cookie || "Fresh context")</script>')
        self.assertIn("Fresh context", fresh["text"])
        self.assertNotIn("isolated", fresh["text"])
        self.assertNotIn("screenshot", fresh)
        self.assertNotIn("html_document", fresh)
        self.assertNotIn("html_links", fresh)

    def test_evidence_profile_same_capture_image_and_offline_html(self):
        body = '<h1>Award deadline</h1><p>Apply January 1, 2027. Only U.S. citizens are eligible.</p>' \
               '<details><summary>Application details</summary><p>Two references are required before December 1, 2026.</p><a href="/hidden.pdf">Reference guide</a></details>'
        result, _ = self.fetch_fixture(body, profile=EVIDENCE_PROFILE)
        self.assertEqual(result["capture_profile"], EVIDENCE_PROFILE)
        self.assertEqual(result["html_document"], extract_html_document(result["html"], result["final_url"]))
        self.assertIn("Two references", result["html_document"]["text"])
        self.assertNotIn("Two references", result["text"])
        self.assertEqual(result["html_links"][0]["url"], "https://example.com/hidden.pdf")
        self.assertFalse(result["document"]["links"])
        shot = result["screenshot"]
        image = base64.b64decode(shot["base64"], validate=True)
        self.assertEqual(hashlib.sha256(image).hexdigest(), shot["sha256"])
        self.assertEqual(len(image), shot["byte_length"])
        self.assertEqual(jpeg_dimensions(image), (1280, 900))
        self.assertEqual(shot["source_url"], result["final_url"])
        self.assertEqual(shot["geometry_status"], "unavailable")
        self.assertEqual(shot["alignment"], "not_verified")
        self.assertTrue(shot["semantics_bracketed"])
        self.assertEqual(shot["semantic_mismatches"], [])
        self.assertEqual(shot["primary_html_captured_at"], result["captured_at"])
        self.assertFalse(result["html_document"]["visibility_verified"])
        self.assertTrue(result["readiness"]["full_page_dimensions_stable"])
        self.assertEqual(result["readiness"]["screenshot_attempts"], 1)

    def test_full_page_extent_matches_browser_offset_dimensions(self):
        body = '<style>body{margin:0;height:1000px;border-bottom:200px solid;overflow:hidden;' \
               'transform:scale(.5);transform-origin:top left}</style><h1>Award</h1>' \
               '<p>Deadline January 1, 2027. Only U.S. citizens may apply.</p>'
        result, _ = self.fetch_fixture(body, profile=EVIDENCE_PROFILE)
        self.assertEqual(result["screenshot"]["height"], 1200)
        self.assertTrue(result["screenshot"]["semantics_bracketed"])

    def test_one_late_geometry_change_uses_fresh_observation_and_image(self):
        screenshot = Page.screenshot
        body = '<style>body{margin:0}main{height:1100px}</style><main><h1>Award</h1>' \
               '<p>Deadline January 1, 2027. Only U.S. citizens may apply.</p></main>'
        for when in ("before", "after"):
            images, observations = [], []

            def stable(page, *args, **kwargs):
                value = collect_stable(page, *args, **kwargs)
                observations.append(value)
                return value

            def changing_screenshot(page, **kwargs):
                first = not images
                if first and when == "before":
                    page.evaluate("document.body.style.paddingBottom='3px';document.querySelector('p').textContent='New deadline February 2, 2027. International applicants may apply.'")
                image = screenshot(page, **kwargs)
                images.append(image)
                if first and when == "after":
                    page.evaluate("document.body.style.paddingBottom='3px';document.querySelector('p').textContent='New deadline February 2, 2027. International applicants may apply.'")
                return image

            with self.subTest(when=when), patch.object(Page, "screenshot", changing_screenshot), \
                    patch("collector.collect_stable", stable):
                result, _ = self.fetch_fixture(body, profile=EVIDENCE_PROFILE)
            self.assertEqual(len(images), 2)
            self.assertEqual(len(observations), 2)
            self.assertNotEqual(observations[0][0]["html"], observations[1][0]["html"])
            self.assertGreater(result["captured_at"], observations[0][0]["captured_at"])
            self.assertEqual(result["captured_at"], observations[1][0]["captured_at"])
            self.assertEqual(result["html"], observations[1][0]["html"])
            self.assertIn("New deadline February 2, 2027. International applicants", result["text"])
            self.assertNotIn("Only U.S. citizens", result["text"])
            self.assertEqual(result["html_document"], extract_html_document(result["html"], result["final_url"]))
            self.assertEqual(base64.b64decode(result["screenshot"]["base64"]), images[-1])
            self.assertEqual(result["screenshot"]["height"], 1103)
            self.assertEqual(result["readiness"]["screenshot_attempts"], 2)
            self.assertTrue(result["readiness"]["full_page_dimensions_stable"])
            self.assertTrue(result["screenshot"]["semantics_bracketed"])
            self.assertEqual(result["screenshot"]["alignment"], "not_verified")
            self.assertEqual(result["screenshot"]["capture_method"], "document_fitting_viewport")
            self.assertEqual(result["screenshot"]["viewport"], {"width": 1280, "height": 1103})
            self.assertTrue(any("viewport height was set once to fit the document" in item for item in result["screenshot"]["limitations"]))

    def test_viewport_fallback_paints_bottom_and_uses_fresh_responsive_content(self):
        screenshot, resize = Page.screenshot, Page.set_viewport_size
        options, sizes, bottom_pixels = [], [], []

        def resized(page, value):
            sizes.append(value)
            return resize(page, value)

        def image(page, **kwargs):
            options.append(kwargs)
            value = screenshot(page, **kwargs)
            if len(options) == 1:
                page.evaluate("document.body.style.paddingBottom='3px'")
            else:
                bottom_pixels.append(page.evaluate("""async encoded => {
                    const image = new Image(); image.src = 'data:image/jpeg;base64,' + encoded;
                    await image.decode();
                    const canvas = new OffscreenCanvas(image.width, image.height);
                    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
                    return Array.from(context.getImageData(20, image.height - 20, 1, 1).data);
                }""", base64.b64encode(value).decode("ascii")))
            return value

        body = '<style>body{margin:0;background:white}main{height:1200px}footer{height:100px;background:#0000ff}</style>' \
               '<main><h1>Award</h1><p>Deadline January 1, 2027. Only U.S. citizens may apply.</p></main><footer>Official footer</footer>' \
               '<script>addEventListener("resize",()=>{if(innerHeight>900)' \
               'document.querySelector("p").textContent="Apply February 2, 2027. International applicants may apply."})</script>'
        with patch.object(Page, "screenshot", image), patch.object(Page, "set_viewport_size", resized):
            result, _ = self.fetch_fixture(body, profile=EVIDENCE_PROFILE)
        self.assertEqual([item["full_page"] for item in options], [True, False])
        self.assertEqual(sizes, [{"width": 1280, "height": 1303}])
        self.assertEqual(result["screenshot"]["viewport"], sizes[0])
        self.assertTrue(result["screenshot"]["full_page"])
        self.assertTrue(result["screenshot"]["semantics_bracketed"])
        self.assertIn("International applicants", result["text"])
        self.assertIn("International applicants", result["html_document"]["text"])
        self.assertNotIn("Only U.S. citizens", result["text"])
        self.assertEqual(len(bottom_pixels), 1)
        self.assertLess(bottom_pixels[0][0], 10)
        self.assertLess(bottom_pixels[0][1], 10)
        self.assertGreater(bottom_pixels[0][2], 240)

    def test_viewport_dependent_growth_is_not_clipped_or_retried_again(self):
        screenshot, resize = Page.screenshot, Page.set_viewport_size
        images, sizes = [], []

        def resized(page, value):
            sizes.append(value)
            return resize(page, value)

        def image(page, **kwargs):
            value = screenshot(page, **kwargs)
            images.append(value)
            page.evaluate("document.body.style.paddingBottom='3px'")
            return value

        with patch.object(Page, "screenshot", image), patch.object(Page, "set_viewport_size", resized), \
                self.assertRaisesRegex(CaptureFailure, "^screenshot_document_exceeds_viewport$"):
            self.fetch_fixture('<style>body{margin:0}main{height:150vh}</style><main><h1>Award</h1>'
                               '<p>Deadline January 1, 2027. Only U.S. citizens may apply.</p></main>', profile=EVIDENCE_PROFILE)
        self.assertEqual(len(images), 1)
        self.assertEqual(sizes, [{"width": 1280, "height": 1353}])

    def test_horizontal_overflow_is_not_widened_for_viewport_fallback(self):
        screenshot = Page.screenshot
        images = []

        def image(page, **kwargs):
            value = screenshot(page, **kwargs)
            images.append(value)
            page.evaluate("document.body.style.paddingBottom='3px'")
            return value

        with patch.object(Page, "screenshot", image), patch.object(Page, "set_viewport_size") as resize, \
                self.assertRaisesRegex(CaptureFailure, "^screenshot_document_exceeds_viewport$"):
            self.fetch_fixture('<style>body{margin:0}main{width:1400px;height:1100px}</style><main><h1>Award</h1>'
                               '<p>Deadline January 1, 2027. Only U.S. citizens may apply.</p></main>', profile=EVIDENCE_PROFILE)
        self.assertEqual(len(images), 1)
        resize.assert_not_called()

    def test_persistent_screenshot_geometry_change_fails_after_two_attempts(self):
        screenshot = Page.screenshot
        images = []

        def moving_screenshot(page, **kwargs):
            image = screenshot(page, **kwargs)
            images.append(image)
            page.evaluate("document.body.style.paddingBottom=(parseInt(document.body.style.paddingBottom||'0')+3)+'px'")
            return image

        with patch.object(Page, "screenshot", moving_screenshot), \
                self.assertRaisesRegex(CaptureFailure, "^screenshot_dimensions_changed$"):
            self.fetch_fixture('<style>body{margin:0}main{height:1100px}</style><main><h1>Award</h1>'
                               '<p>Deadline January 1, 2027. Only U.S. citizens may apply.</p></main>', profile=EVIDENCE_PROFILE)
        self.assertEqual(len(images), 2)

    def test_geometry_retry_preserves_later_semantic_mismatch_disclosure(self):
        screenshot = Page.screenshot
        images = []

        def changing_screenshot(page, **kwargs):
            image = screenshot(page, **kwargs)
            images.append(image)
            if len(images) == 1:
                page.evaluate("document.body.style.paddingBottom='3px'")
            else:
                page.evaluate("document.querySelector('p').textContent='New deadline February 2, 2027. International applicants may apply.'")
            return image

        with patch.object(Page, "screenshot", changing_screenshot):
            result, _ = self.fetch_fixture('<style>body{margin:0}main{height:1100px}</style><main><h1>Award</h1>'
                                          '<p>Deadline January 1, 2027. Only U.S. citizens may apply.</p></main>', profile=EVIDENCE_PROFILE)
        self.assertEqual(len(images), 2)
        self.assertEqual(result["readiness"]["screenshot_attempts"], 2)
        self.assertIn("Deadline January 1, 2027.", result["html_document"]["text"])
        self.assertFalse(result["screenshot"]["semantics_bracketed"])
        self.assertEqual(result["screenshot"]["alignment"], "not_verified")
        self.assertIn("visible.text", [item["field"] for item in result["screenshot"]["semantic_mismatches"]])
        self.assertIn("supplementary_screenshot_semantics_changed_not_aligned", result["warnings"])

    def test_geometry_retry_does_not_retry_other_evidence_failures(self):
        for reason in ("blocked_page_content", "screenshot_page_identity_or_readiness_changed", "invalid_screenshot"):
            with self.subTest(reason=reason), patch("collector.capture_evidence", side_effect=CaptureFailure(reason)) as evidence:
                with self.assertRaisesRegex(CaptureFailure, "^" + reason + "$"):
                    self.fetch_fixture('<h1>Award</h1><p>Deadline January 1, 2027. Only U.S. citizens may apply.</p>', profile=EVIDENCE_PROFILE)
                self.assertEqual(evidence.call_count, 1)

    def test_late_oversized_page_is_not_retried_or_accepted(self):
        screenshot = Page.screenshot
        images = []

        def oversized_screenshot(page, **kwargs):
            image = screenshot(page, **kwargs)
            images.append(image)
            page.evaluate("document.body.style.height='21000px'")
            return image

        with patch.object(Page, "screenshot", oversized_screenshot), \
                self.assertRaisesRegex(CaptureFailure, "^screenshot_dimension_limit$"):
            self.fetch_fixture('<h1>Award</h1><p>Deadline January 1, 2027. Only U.S. citizens may apply.</p>', profile=EVIDENCE_PROFILE)
        self.assertEqual(len(images), 1)

    def test_dimensions_must_stabilize_even_when_visible_semantics_do_not_change(self):
        calls = []

        def moving_bounds(page):
            page.evaluate("document.body.style.paddingBottom=(parseInt(document.body.style.paddingBottom||'0')+1)+'px'")
            bounds = screenshot_bounds(page)
            calls.append(bounds)
            return bounds

        def bounded_stable(page, *args, **kwargs):
            return collect_stable(page, max_ms=1400, *args, **kwargs)

        with patch("collector.screenshot_bounds", moving_bounds), patch("collector.collect_stable", bounded_stable), \
                patch.object(Page, "screenshot", side_effect=AssertionError("unstable page must not be rendered")) as image:
            with self.assertRaisesRegex(CaptureFailure, "^page_not_stable$"):
                self.fetch_fixture('<style>body{margin:0}main{height:1100px}</style><main><h1>Award</h1>'
                                   '<p>Deadline January 1, 2027. Only U.S. citizens may apply.</p></main>', profile=EVIDENCE_PROFILE)
            image.assert_not_called()
        self.assertGreaterEqual(len(calls), 4)

    def test_closed_after_layout_evidence_keeps_html_without_false_visible_answer(self):
        body = '<h1>Award eligibility and application instructions</h1>' \
               '<p>The January 1, 2027 deadline applies to this award.</p>' \
               '<details open id="faq"><summary>Who may apply?</summary>' \
               '<p id="answer">Only U.S. citizens may apply.</p><a href="/requirements">Requirements</a></details>' \
               '<script>document.querySelector("#answer").getBoundingClientRect();document.querySelector("#faq").open=false</script>'
        result, _ = self.fetch_fixture(body, profile=EVIDENCE_PROFILE)
        self.assertIn("Only U.S. citizens", result["html_document"]["text"])
        self.assertEqual(result["html_document"], extract_html_document(result["html"], result["final_url"]))
        self.assertNotIn("Only U.S. citizens", result["text"])
        self.assertEqual(result["document"]["links"], [])
        self.assertEqual(result["html_links"][0]["url"], "https://example.com/requirements")
        self.assertTrue(result["screenshot"]["semantics_bracketed"])
        self.assertEqual(result["screenshot"]["semantic_mismatches"], [])
        self.assertEqual(result["screenshot"]["alignment"], "not_verified")

    def test_supplementary_screenshot_changes_are_disclosed_not_called_matched(self):
        screenshot = Page.screenshot
        for mutation, field in [("document.querySelector('p').textContent='New deadline January 2, 2027. U.S. citizens may apply.'", "visible.text"),
                                ("document.querySelector('#hidden').textContent='Two references now required.'", "html_source.text"),
                                ("document.querySelector('#hidden').textContent='Countdown seconds 42.'", "html_source.text"),
                                ("document.querySelector('a').title='Changed document label'", "discovery.links")]:
            screenshot_calls = []
            def changing_screenshot(page, **kwargs):
                image = screenshot(page, **kwargs)
                screenshot_calls.append(image)
                page.evaluate(mutation)
                return image
            with self.subTest(mutation=mutation), patch.object(Page, "screenshot", changing_screenshot):
                result, _ = self.fetch_fixture('<h1>Award</h1><p>Deadline January 1, 2027. U.S. citizens may apply.</p>'
                                   '<p id="hidden" hidden>One reference required.</p><a hidden href="/guide.pdf" title="Guide">Guide</a>', profile=EVIDENCE_PROFILE)
                self.assertFalse(result["screenshot"]["semantics_bracketed"])
                self.assertEqual(result["screenshot"]["alignment"], "not_verified")
                self.assertIn("supplementary_screenshot_semantics_changed_not_aligned", result["warnings"])
                self.assertIn(field, [item["field"] for item in result["screenshot"]["semantic_mismatches"]])
                self.assertIn("Deadline January 1, 2027.", result["html_document"]["text"])
                self.assertIn("One reference required.", result["html_document"]["text"])
                self.assertEqual(result["html_document"], extract_html_document(result["html"], result["final_url"]))
                self.assertEqual(result["html_links"][0]["title"], "Guide")
                self.assertEqual(len(screenshot_calls), 1)

    def test_screenshot_navigation_is_still_refused(self):
        screenshot = Page.screenshot
        def navigating_screenshot(page, **kwargs):
            image = screenshot(page, **kwargs)
            page.goto("https://example.com/other")
            return image
        with patch.object(Page, "screenshot", navigating_screenshot), self.assertRaises(CaptureFailure):
            self.fetch_fixture('<h1>Award</h1><p>Deadline January 1, 2027. U.S. citizens may apply.</p>', profile=EVIDENCE_PROFILE)

    def test_screenshot_challenge_is_not_accepted_as_a_semantic_mismatch(self):
        screenshot = Page.screenshot
        def challenged_screenshot(page, **kwargs):
            image = screenshot(page, **kwargs)
            page.evaluate("document.body.innerHTML='<h1>Verify you are human</h1><p>Please confirm your browser before you continue to the scholarship page.</p>'")
            return image
        with patch.object(Page, "screenshot", challenged_screenshot), self.assertRaisesRegex(CaptureFailure, "blocked_page_content"):
            self.fetch_fixture('<h1>Award</h1><p>Deadline January 1, 2027. U.S. citizens may apply.</p>', profile=EVIDENCE_PROFILE)

    def test_screenshot_dimensions_bounded_before_render(self):
        with patch.object(Page, "screenshot", side_effect=AssertionError("must not render an oversized image")) as screenshot:
            with self.assertRaisesRegex(CaptureFailure, "screenshot_dimension_limit"):
                self.fetch_fixture('<h1>Award</h1><p style="height:21000px">Deadline January 1, 2027. U.S. citizens may apply.</p>', profile=EVIDENCE_PROFILE)
            screenshot.assert_not_called()

    def test_invalid_evidence_profile_is_refused(self):
        with self.assertRaisesRegex(CaptureFailure, "invalid_capture_profile"):
            capture({**REQUEST, "capture_profile": "future-profile"})

    def test_http_refusal_and_non_html(self):
        for status, content_type, reason in [(403, "text/html", "http_403"), (200, "application/pdf", "non_html_response")]:
            with self.subTest(reason=reason), self.assertRaisesRegex(CaptureFailure, reason):
                self.fetch_fixture("Award eligibility details are unavailable for this captured source page.", status=status, content_type=content_type)

    def test_challenge_is_unavailable(self):
        with self.assertRaisesRegex(CaptureFailure, "blocked_page_content"):
            self.fetch_fixture("<h1>Verify you are human</h1><p>Please confirm your browser before you continue to the scholarship page.</p>")

    def test_explicit_upstream_challenge_is_rejected_before_content_observation(self):
        with patch("collector.collect_stable", wraps=collect_stable) as stable, patch.object(Page, "screenshot") as screenshot:
            with self.assertRaisesRegex(CaptureFailure, "^upstream_challenge_response$"):
                self.fetch_fixture("<html><head><title></title></head><body></body></html>", status=202,
                    headers={"X-AmZn-WaF-AcTiOn": "challenge"}, profile=EVIDENCE_PROFILE)
            stable.assert_not_called()
            screenshot.assert_not_called()

    def test_upstream_challenge_requires_exact_status_and_action(self):
        for status, action, reason in [(200, "challenge", "insufficient_visible_text"),
                                       (202, "", "insufficient_visible_text"),
                                       (202, "captcha", "insufficient_visible_text"),
                                       (202, "Challenge", "insufficient_visible_text"),
                                       (403, "challenge", "http_403")]:
            with self.subTest(status=status, action=action), self.assertRaisesRegex(CaptureFailure, f"^{reason}$"):
                self.fetch_fixture("<html><body></body></html>", status=status,
                    headers={"x-amzn-waf-action": action} if action else {})

    def test_ordinary_202_content_is_not_a_challenge_by_keyword(self):
        result, _ = self.fetch_fixture('<h1>Award application challenge</h1>'
            '<p>Apply January 1, 2027. Only U.S. citizens are eligible.</p>', status=202)
        self.assertEqual(result["status_code"], 202)
        self.assertIn("Award application challenge", result["text"])

    def test_subresource_challenge_header_does_not_replace_main_response(self):
        def fixture(route):
            if route.request.url.endswith("/dependency"):
                route.fulfill(status=202, content_type="image/svg+xml", headers={"x-amzn-waf-action": "challenge"},
                    body='<svg xmlns="http://www.w3.org/2000/svg"/>')
            else:
                route.fulfill(status=200, content_type="text/html", body='<h1>Award deadline</h1>'
                    '<p>Apply January 1, 2027. Only U.S. citizens are eligible.</p><img src="/dependency">')
        result = capture(REQUEST, fixture=fixture)
        self.assertEqual(result["status_code"], 200)
        self.assertIn("Only U.S. citizens", result["text"])

    def test_late_reload_to_challenge_still_breaks_response_identity(self):
        requests = []
        def fixture(route):
            requests.append(route.request.url)
            if len(requests) == 1:
                route.fulfill(status=200, content_type="text/html", body='<h1>Award deadline</h1>'
                    '<p>Apply January 1, 2027. Only U.S. citizens are eligible.</p>')
            else:
                route.fulfill(status=202, content_type="text/html", headers={"x-amzn-waf-action": "challenge"},
                    body="<html><body></body></html>")
        def reloaded_after_capture(page):
            result = collect_stable(page)
            page.reload(wait_until="domcontentloaded")
            return result
        with patch("collector.collect_stable", reloaded_after_capture):
            with self.assertRaisesRegex(CaptureFailure, "^http_response_changed_during_capture$"):
                capture(REQUEST, fixture=fixture)
        self.assertEqual(requests, [REQUEST["url"], REQUEST["url"]])

    def test_redirect_final_challenge_response_is_not_award_content(self):
        with self.redirect_fixture(status=202, headers={"X-Amzn-Waf-Action": "challenge"}) as (request, _, _):
            with self.assertRaisesRegex(CaptureFailure, "^upstream_challenge_response$"):
                capture(request)

    def test_websocket_sink_does_not_connect_or_deadlock(self):
        body = '<h1>Award deadline</h1><p>Apply January 1, 2027. Only U.S. citizens are eligible.</p>' \
               '<script>const ws=new WebSocket("wss://example.com/live");ws.onopen=()=>ws.send("fixture");' \
               'ws.onmessage=()=>document.body.append("Unexpected server message");</script>'
        with patch.object(WebSocketRoute, "connect_to_server", side_effect=AssertionError("outbound websocket forbidden")) as connect:
            result, _ = self.fetch_fixture(body)
            connect.assert_not_called()
        self.assertEqual(result["telemetry"]["blocked_websockets"], 1)
        self.assertNotIn("Unexpected server message", result["text"])
        self.assertIn("websocket_live_updates_not_observed_client_connection_mocked", result["document"]["limitations"])

    def test_unsafe_subrequest_fails_capture(self):
        with self.assertRaisesRegex(CaptureFailure, "invalid_public_url"):
            self.fetch_fixture('<h1>Award deadline January 1, 2027.</h1><p>U.S. citizens may apply for this scholarship.</p><img src="http://127.0.0.1/private">')

    def test_url_boundary(self):
        for url in ["http://127.0.0.1/", "https://example.com:1234/", "file:///secret", "http://user:pass@example.com/", "http://example.local/"]:
            with self.subTest(url=url), self.assertRaises(CaptureFailure):
                validate_url(url)


if __name__ == "__main__":
    unittest.main(verbosity=2)
