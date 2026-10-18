"""Source-only collector guards. Native HTTP tests use a loopback fixture only."""
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import collector

URL = "https://example.edu/award"
HTML = ('<!doctype html><html><head><title>Example Award</title></head><body>'
        '<nav>Menu</nav><main><h1>Eligibility</h1><h2>Applicants</h2>'
        '<p>Applications close October 23, 2026. Only U.S. citizens may apply.</p>'
        '<details><summary>Graduate applicants</summary><p>' + 'Complete qualification. ' * 10 +
        '</p></details><a href="/rules.pdf">Official rules</a>'
        '<script>never execute this</script></main></body></html>').encode()
REQUEST = {"url": URL, "source_id": "source-only-test", "proxy_url": "http://127.0.0.1:49151",
           "executable_path": "", "capture_profile": collector.SOURCE_HTML_PROFILE}


def fake_get(raw=HTML, *, status=200, final_url=URL, headers=None, history=None):
    def fetch(url, **options):
        for offset in range(0, len(raw), 1000):
            if options["content_callback"](raw[offset:offset + 1000]) == collector.CURL_WRITEFUNC_ERROR:
                raise RuntimeError("bounded fixture stream aborted")
        return SimpleNamespace(status=status, url=final_url, history=history or [],
                               headers=headers or {"content-type": "text/html; charset=utf-8", "content-length": str(len(raw))})
    return fetch


@contextmanager
def native_fixture(payload):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            try:
                for offset in range(0, len(payload), 8192):
                    self.wfile.write(payload[offset:offset + 8192])
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/fixture"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class SourceHtmlCollectorTests(unittest.TestCase):
    def run_capture(self, fetch=None, request=None):
        with patch.dict(os.environ, {}, clear=True), patch.object(collector.Fetcher, "get", side_effect=fetch or fake_get()) as mocked:
            result = collector.capture(request or REQUEST)
            self.assertEqual(mocked.call_count, 1)
            return result, mocked.call_args.kwargs

    def test_complete_body_and_main_are_source_only_not_visible(self):
        result, options = self.run_capture()
        self.assertEqual(result["html"].encode(), HTML)
        self.assertEqual(result["source_http"]["body_sha256"], hashlib.sha256(HTML).hexdigest())
        self.assertEqual(result["source_http"]["body_byte_length"], len(HTML))
        self.assertFalse(result["source_http"]["visibility_verified"])
        self.assertFalse(result["source_http"]["screenshot_available"])
        self.assertEqual(result["source_main_document"]["scope"], "html-source-main-element")
        self.assertIn("Menu", result["html_document"]["text"])
        self.assertNotIn("Menu", result["source_main_document"]["text"])
        self.assertNotIn("never execute this", result["html_document"]["text"])
        self.assertIn("Complete qualification.", result["source_main_document"]["text"])
        self.assertTrue(any(block.get("details_path") == ["Graduate applicants"] for block in result["source_main_document"]["blocks"]))
        self.assertFalse(any(key in result for key in ("visible_html", "text", "document", "screenshot", "readiness", "html_links")))
        self.assertIsNone(options["impersonate"])
        self.assertFalse(options["stealthy_headers"])
        self.assertFalse(options["follow_redirects"])
        self.assertEqual(options["retries"], 1)
        self.assertTrue(options["verify"])
        self.assertEqual(options["proxy"], REQUEST["proxy_url"])
        self.assertEqual(options["cookies"], {})
        self.assertTrue(options["discard_cookies"])
        self.assertEqual(options["accept_encoding"], "identity")
        self.assertFalse(options["default_headers"])
        self.assertFalse(options["selector_config"]["adaptive"])
        self.assertEqual(set(options["headers"]), {"User-Agent", "Accept"})

    def test_rejects_status_redirect_challenge_and_non_html(self):
        cases = [(dict(status=status), "source_html_http_status") for status in (204, 206, 301, 302, 401, 403, 429, 500)]
        cases += [(dict(final_url="https://example.edu/other"), "source_html_redirect_not_allowed"),
                  (dict(history=[{}]), "source_html_redirect_not_allowed"),
                  (dict(headers={"content-type": "application/pdf"}), "non_html_response"),
                  (dict(headers={"content-type": "text/html", "x-amzn-waf-action": "challenge"}), "upstream_challenge_response"),
                  (dict(headers={"content-type": "text/html", "cf-mitigated": "challenge"}), "upstream_challenge_response"),
                  (dict(raw=b"<html><body>Verify you are human</body></html>"), "upstream_challenge_response")]
        for settings, reason in cases:
            with self.subTest(settings=settings), self.assertRaisesRegex(collector.CaptureFailure, reason):
                self.run_capture(fake_get(**settings))

    def test_rejects_non_utf8_compression_length_and_parse_boundaries(self):
        for fetch, reason in [(fake_get(raw=b""), "source_html_empty_response"),
                              (fake_get(raw=b"\xff"), "source_html_unsupported_encoding"),
                              (fake_get(headers={"content-type": "text/html; charset=latin1"}), "source_html_unsupported_encoding"),
                              (fake_get(headers={"content-type": "text/html", "content-encoding": "gzip"}), "source_html_unsupported_content_encoding"),
                              (fake_get(headers={"content-type": "text/html", "content-length": "1"}), "source_html_content_length_mismatch"),
                              (fake_get(raw=HTML.replace(b"<main>", b"<div>").replace(b"</main>", b"</div>")), "source_html_exact_main_required"),
                              (fake_get(raw=HTML.replace(b"</main>", b"</main><main>other</main>")), "source_html_exact_main_required"),
                              (fake_get(raw=b"<html><body><main>Short</main></body></html>"), "source_html_insufficient_main_text")]:
            with self.subTest(reason=reason), self.assertRaisesRegex(collector.CaptureFailure, reason):
                self.run_capture(fetch)

    def test_rejects_proxy_bypass_and_invalid_public_identity_without_request(self):
        for request in [{**REQUEST, "url": "http://example.edu/award"}, {**REQUEST, "url": "https://127.0.0.1/"},
                        {**REQUEST, "url": URL + "#fragment"}, {**REQUEST, "proxy_url": "http://proxy.example.edu:80"},
                        {**REQUEST, "proxy_url": REQUEST["proxy_url"] + "?bypass=true"}]:
            with patch.dict(os.environ, {}, clear=True), patch.object(collector.Fetcher, "get") as mocked:
                with self.assertRaises(collector.CaptureFailure):
                    collector.capture(request)
                mocked.assert_not_called()
        with patch.dict(os.environ, {"NO_PROXY": "*"}, clear=True), patch.object(collector.Fetcher, "get") as mocked:
            with self.assertRaisesRegex(collector.CaptureFailure, "proxy_environment_not_clean"):
                collector.capture(REQUEST)
            mocked.assert_not_called()

    def test_stream_limit_uses_native_abort_sentinel_and_never_parses_partial(self):
        with patch.object(collector, "extract_html_document") as parsed:
            with self.assertRaisesRegex(collector.CaptureFailure, "source_html_body_limit"):
                self.run_capture(fake_get(raw=b"x" * (collector.MAX_BYTES + 1)))
            parsed.assert_not_called()

    def test_transport_exception_is_not_retried_or_exposed(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(collector.Fetcher, "get", side_effect=RuntimeError("secret cookie")) as fetch:
            with self.assertRaisesRegex(collector.CaptureFailure, "^source_html_request_failed$"):
                collector.capture(REQUEST)
            self.assertEqual(fetch.call_count, 1)

    def test_actual_fetcher_callback_returns_complete_bytes_even_when_response_body_empty(self):
        real_get = collector.Fetcher.get
        with native_fixture(HTML) as local_url:
            def local_get(url, **kwargs):
                self.assertEqual(url, URL)
                kwargs.pop("proxy")
                response = real_get(local_url, proxies={"all": ""}, **kwargs)
                self.assertEqual(response.body, b"")
                response.url = URL
                return response
            result, _ = self.run_capture(local_get)
            self.assertEqual(result["html"].encode(), HTML)

    def test_actual_fetcher_aborts_oversized_stream_before_parsing(self):
        real_get = collector.Fetcher.get
        with native_fixture(b"x" * (collector.MAX_BYTES + 65536)) as local_url:
            def local_get(_url, **kwargs):
                kwargs.pop("proxy")
                return real_get(local_url, proxies={"all": ""}, **kwargs)
            with patch.object(collector, "extract_html_document") as parsed:
                with self.assertRaisesRegex(collector.CaptureFailure, "source_html_body_limit"):
                    self.run_capture(local_get)
                parsed.assert_not_called()


if __name__ == "__main__":
    unittest.main()
