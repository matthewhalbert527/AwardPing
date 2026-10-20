"""Offline v2 producer fixtures; no browser, external request or saved capture."""

from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import collector
import html_document


URL = "https://example.edu/award"
BODIES = [
    '<h1>Example Award</h1><div>Only U.S. citizens may apply.<br><strong>November 2</strong> at 5 p.m. Eastern.</div><p>Keep this paragraph.</p>',
    '<div><button>Who may apply?</button><div><p>College juniors may apply.</p><a href="/rules">Rules</a></div></div><details><summary>Exceptions</summary><p>International applicants need a nomination.</p></details>',
    '<h2>Applicants</h2><blockquote><div>Retain the original qualification.</div></blockquote><table><tr><th>Program</th><td>Churchill only</td></tr></table>',
    '<div>Unblocked text</div><script>ignored()</script><section hidden><p>Old source statement.</p></section>',
]
# Taken from the unmodified v1 extractor before adding this option. It covers
# every serialized field, not merely selected snippets or block counts.
V1_CORPUS_SHA256 = "fd22ddc57accc3182ce766d905257f43b8a404b5b940ce66946ce5fdc0953a36"


def html(body):
    return '<!doctype html><html><head><title>Example Award</title></head><body>' + body + '</body></html>'


def extract(body, **options):
    return html_document.extract_html_document(html(body), URL, **options)


class NeutralDivParserTests(unittest.TestCase):
    def test_v1_all_serialized_fields_match_prechange_golden(self):
        docs = [extract(body) for body in BODIES]
        serialized = json.dumps(docs, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
        self.assertEqual(hashlib.sha256(serialized).hexdigest(), V1_CORPUS_SHA256)
        self.assertEqual(docs, [extract(body, neutral_div_blocks=False) for body in BODIES])

    def test_v2_adds_one_complete_inline_div_without_changing_v1_fields(self):
        before = extract(BODIES[0])
        after = extract(BODIES[0], neutral_div_blocks=True)
        added = [block for block in after["blocks"] if block["kind"] == "div"]
        self.assertEqual(len(added), 1)
        self.assertEqual(added[0], {"kind": "div",
            "text": "Only U.S. citizens may apply. November 2 at 5 p.m. Eastern.",
            "heading_path": [{"level": 1, "text": "Example Award"}], "list_path": [], "table_row": []})
        stripped = deepcopy(after)
        stripped["blocks"] = [block for block in stripped["blocks"] if block["kind"] != "div"]
        stripped["counts"]["blocks"] = len(stripped["blocks"])
        self.assertEqual(stripped, before)
        self.assertFalse(after["publishable"])
        self.assertFalse(after["visibility_verified"])

    def test_five_synthetic_whole_answers_keep_inline_qualifiers_links_and_heading_context(self):
        answers = [
            'Other funding may be held concurrently.<br><strong>However,</strong> consult both providers before accepting.',
            'Artificial intelligence cannot substitute for your own statement; retain the complete condition.',
            'Medical school can begin in July or August.<br>Consult the institution about visas and residency.<br><a href="/conditions">Complete conditions</a>',
            'The supervisor need not be affiliated with this college; verify the research placement directly.',
            'Other United Kingdom scholarships have different nomination and application requirements.',
        ]
        body = ''.join('<div class="w-row"><h1 class="faq-title">Question ' + str(index) + '</h1>'
                       '<div class="body-paragraph">' + answer + '</div></div>'
                       for index, answer in enumerate(answers, 1))
        doc = extract(body, neutral_div_blocks=True)
        blocks = [block for block in doc["blocks"] if block["kind"] == "div"]
        self.assertEqual(len(blocks), 5)
        for index, (answer, block) in enumerate(zip(answers, blocks), 1):
            self.assertEqual(block["text"], extract(answer)["text"])
            self.assertEqual(block["heading_path"], [{"level": 1, "text": 'Question ' + str(index)}])
        self.assertEqual(doc["links"][0]["raw_href"], "/conditions")
        self.assertEqual(doc["links"][0]["heading_path"], [{"level": 1, "text": "Question 3"}])

    def test_nested_div_emits_only_leaf_and_retains_duplicate_occurrences_in_order(self):
        doc = extract('<div>Unscoped outer text<div>Same requirement.</div></div>'
                      '<div>Same requirement.</div><div>Last requirement.</div>', neutral_div_blocks=True)
        self.assertEqual([block["text"] for block in doc["blocks"]],
                         ["Same requirement.", "Same requirement.", "Last requirement."])
        self.assertIn("Unscoped outer text", doc["text"])

    def test_emitted_semantic_or_heading_ancestor_prevents_double_count(self):
        doc = extract('<blockquote><div>Complete quotation.</div></blockquote>'
                      '<ul><li><div>Complete list qualification.</div></li></ul>'
                      '<div role="heading" aria-level="2"><div>Real source heading.</div></div>',
                      neutral_div_blocks=True)
        self.assertFalse(any(block["kind"] == "div" for block in doc["blocks"]))
        self.assertEqual([block["kind"] for block in doc["blocks"]], ["blockquote", "li", "heading"])

    def test_existing_details_and_local_sibling_button_context_are_retained(self):
        doc = extract('<h2>Eligibility</h2><details><summary>Exceptions</summary>'
                      '<div><button>Applicants</button><div>Only nominated applicants may apply.</div></div>'
                      '</details>', neutral_div_blocks=True)
        block = next(block for block in doc["blocks"] if block["kind"] == "div")
        self.assertEqual(block["details_path"], ["Exceptions"])
        self.assertEqual(block["sibling_button_path"], ["Applicants"])
        self.assertEqual(block["heading_path"], [{"level": 2, "text": "Eligibility"}])

    def test_hidden_source_div_is_retained_without_inventing_visibility(self):
        doc = extract('<h2>Rules</h2><div hidden style="display:none">Old applicant condition.</div>', neutral_div_blocks=True)
        self.assertEqual(doc["blocks"][-1]["text"], "Old applicant condition.")
        self.assertFalse(doc["visibility_verified"])

    def test_structural_semantic_control_media_and_unknown_children_do_not_manufacture_leaf(self):
        children = ['<p>Nested rule.</p>', '<h2>Nested rule.</h2>', '<section>Nested rule.</section>',
                    '<div>Nested rule.</div>', '<button>Nested rule.</button>', '<input value="rule">',
                    '<select><option>Nested rule.</option></select>', '<textarea>Nested rule.</textarea>',
                    '<form>Nested rule.</form>', '<details><summary>Nested rule.</summary></details>',
                    '<iframe>Nested rule.</iframe>', '<video>Nested rule.</video>', '<img alt="rule">',
                    '<svg><text>Nested rule.</text></svg>', '<custom-label>Nested rule.</custom-label>']
        for child in children:
            with self.subTest(child=child):
                doc = extract('<p>Existing block.</p><div>Outer condition ' + child + '</div>', neutral_div_blocks=True)
                self.assertFalse(any(block["kind"] == "div" and block["text"].startswith("Outer condition")
                                     for block in doc["blocks"]))

    def test_excluded_or_interactive_descendants_cannot_manufacture_inline_eligibility(self):
        contents = ['Condition<script>ignored()</script>', 'Condition<template>ignored</template>',
                    'Condition<noscript>ignored</noscript>', '<span>Condition<style>ignored</style></span>',
                    '<span role="button">Condition</span>', '<span tabindex="0">Condition</span>',
                    '<span contenteditable="false">Condition</span>', '<a onclick="ignored()" href="/x">Condition</a>']
        for content in contents:
            with self.subTest(content=content):
                doc = extract('<p>Existing block.</p><div>' + content + '</div>', neutral_div_blocks=True)
                self.assertFalse(any(block["kind"] == "div" for block in doc["blocks"]))

    def test_pure_option_rejects_truthy_nonbooleans(self):
        for value in (None, 1, "true", [], {}):
            with self.subTest(value=value), self.assertRaisesRegex(html_document.HtmlDocumentError, "^invalid_neutral_div_option$"):
                extract('Condition', neutral_div_blocks=value)

    def test_v2_added_blocks_obey_existing_item_and_output_bounds(self):
        body = '<div>First condition.</div><div>Second condition.</div><div>Third condition.</div>'
        with patch.object(html_document, "MAX_ITEMS", 2), \
                self.assertRaisesRegex(html_document.HtmlDocumentError, "^html_item_limit$"):
            extract(body, neutral_div_blocks=True)
        with patch.object(html_document, "MAX_OUTPUT_BYTES", 100), \
                self.assertRaisesRegex(html_document.HtmlDocumentError, "^html_document_size_limit$"):
            extract(body, neutral_div_blocks=True)

    def parser_cli(self, request):
        output = io.StringIO()
        stdin = io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()))
        with patch.object(html_document.sys, "stdin", stdin), patch.object(html_document.sys, "stdout", output):
            status = html_document.main()
        return status, json.loads(output.getvalue())

    def test_cli_existing_request_defaults_to_exact_v1_and_only_explicit_v2_opts_in(self):
        request = {"html": html(BODIES[0]), "url": URL}
        self.assertEqual(self.parser_cli(request), (0, extract(BODIES[0])))
        self.assertEqual(self.parser_cli({**request, "capture_profile": "scrapling-evidence-v2"}),
                         (0, extract(BODIES[0], neutral_div_blocks=True)))

    def test_cli_rejects_unknown_profiles_and_generic_boolean_controls(self):
        request = {"html": html(BODIES[0]), "url": URL}
        for extra in ({"capture_profile": "scrapling-evidence-v1"}, {"capture_profile": "scrapling-evidence-v3"},
                      {"capture_profile": True}, {"neutral_div_blocks": True},
                      {"capture_profile": "scrapling-evidence-v2", "extra": 1}):
            with self.subTest(extra=extra):
                self.assertEqual(self.parser_cli({**request, **extra}), (2, {"error": "invalid_request"}))


class FakeContext:
    def route_web_socket(self, *_args):
        pass

    def route(self, *_args):
        pass

    def on(self, *_args):
        pass


class FakePage:
    def __init__(self):
        self.context = FakeContext()
        self.main_frame = object()
        self.events = {}
        self.url = URL
        self.viewport_size = {"width": 100, "height": 200}
        self.screenshot_count = 0

    def on(self, event, callback):
        self.events[event] = callback

    def evaluate(self, _script):
        return dict(self.viewport_size)

    def screenshot(self, **_options):
        self.screenshot_count += 1
        return b"synthetic-jpeg-bytes-no-real-image"

    def set_viewport_size(self, viewport):
        self.viewport_size = dict(viewport)


class NeutralDivCollectorTests(unittest.TestCase):
    def observed(self, body=BODIES[0]):
        text = extract(body)["text"]
        return ({"html": html(body), "url": URL, "ready_state": "complete", "fonts_status": "loaded",
                 "captured_at": "2026-10-20T00:00:00.000Z", "projection": "<ap-document>synthetic</ap-document>"},
                {"title": "Example Award", "text": text, "blocks": [], "links": [], "limitations": []},
                {"full_page_dimensions": {"width": 100, "height": 200}})

    def fake_capture(self, profile, *, resize_once=False, change_after=False):
        page = FakePage()
        stable = self.observed()
        after = self.observed(BODIES[0].replace("November 2", "November 3")) if change_after else deepcopy(stable)

        def fetch(_url, **options):
            options["page_setup"](page)
            response = SimpleNamespace(url=URL, status=200, headers={"content-type": "text/html"},
                request=SimpleNamespace(is_navigation_request=lambda: True, frame=page.main_frame))
            page.events["response"](response)
            options["page_action"](page)

        dimensions = [(99, 200), (100, 200)] if resize_once else [(100, 200)]
        with patch.object(collector.DynamicFetcher, "fetch", side_effect=fetch) as fetcher, \
                patch.object(collector, "collect_stable", side_effect=lambda *_args, **_kwargs: deepcopy(stable)) as collect, \
                patch.object(collector, "observe", return_value=after), \
                patch.object(collector, "discover_html_links", return_value=[]), \
                patch.object(collector, "screenshot_bounds", return_value={"width": 100, "height": 200}), \
                patch.object(collector, "jpeg_dimensions", side_effect=dimensions), \
                patch.object(collector, "extract_html_document", wraps=html_document.extract_html_document) as parser, \
                patch.object(collector, "version", return_value="synthetic-only"):
            # The executable is never launched: the complete fetch boundary is
            # replaced above. This is only the existing regular-file option check.
            result = collector.capture({"url": URL, "source_id": "synthetic-v2", "proxy_url": "http://127.0.0.1:1",
                "executable_path": str(Path(collector.sys.executable).resolve()), "capture_profile": profile})
        self.assertEqual(fetcher.call_count, 1)
        return result, page, collect, parser

    def test_v2_produces_new_complete_blocks_and_uses_same_option_before_and_after(self):
        result, page, collect, parser = self.fake_capture(collector.EVIDENCE_PROFILE_V2)
        self.assertEqual(result["capture_profile"], "scrapling-evidence-v2")
        self.assertEqual(result["schema"], "awardping.scrapling-capture.v1")
        self.assertEqual(result["html_document"]["schema"], "awardping.scrapling-html-document.v1")
        self.assertEqual(sum(block["kind"] == "div" for block in result["html_document"]["blocks"]), 1)
        self.assertEqual([call.kwargs for call in parser.call_args_list], [{"neutral_div_blocks": True}] * 2)
        self.assertEqual(collect.call_args.kwargs, {"geometry": True})
        self.assertEqual(page.screenshot_count, 1)
        self.assertTrue(result["screenshot"]["semantics_bracketed"])

    def test_v1_still_uses_exact_original_parser_body_on_both_sides(self):
        result, _page, _collect, parser = self.fake_capture(collector.EVIDENCE_PROFILE)
        self.assertEqual(result["html_document"], extract(BODIES[0]))
        self.assertEqual([call.kwargs for call in parser.call_args_list], [{"neutral_div_blocks": False}] * 2)
        self.assertEqual(result["capture_profile"], "scrapling-evidence-v1")

    def test_visible_v1_still_has_no_html_evidence_or_neutral_div_parser_call(self):
        result, page, collect, parser = self.fake_capture(collector.PROFILE)
        self.assertEqual(result["capture_profile"], "scrapling-visible-v1")
        self.assertNotIn("html_document", result)
        self.assertNotIn("screenshot", result)
        self.assertEqual(page.screenshot_count, 0)
        self.assertEqual(collect.call_args.kwargs, {})
        parser.assert_not_called()

    def test_v2_fitted_screenshot_reobservation_keeps_same_profile_and_parser_option(self):
        result, page, collect, parser = self.fake_capture(collector.EVIDENCE_PROFILE_V2, resize_once=True)
        self.assertEqual(page.screenshot_count, 2)
        self.assertEqual(collect.call_count, 2)
        self.assertEqual([call.kwargs for call in parser.call_args_list], [{"neutral_div_blocks": True}] * 3)
        self.assertEqual(result["readiness"]["screenshot_attempts"], 2)
        self.assertEqual(result["screenshot"]["capture_method"], "document_fitting_viewport")

    def test_v2_real_before_after_prose_change_still_marks_screenshot_mismatch(self):
        result, _page, _collect, _parser = self.fake_capture(collector.EVIDENCE_PROFILE_V2, change_after=True)
        self.assertFalse(result["screenshot"]["semantics_bracketed"])
        self.assertIn("html_source.blocks", [item["field"] for item in result["screenshot"]["semantic_mismatches"]])
        self.assertIn("supplementary_screenshot_semantics_changed_not_aligned", result["warnings"])

    def test_source_html_v1_does_not_enable_neutral_divs_in_body_or_main(self):
        raw = html('<main><h1>Example Award</h1><p>' + 'Existing complete condition. ' * 12 +
                   '</p><div>Do not add a source-only DIV block.</div></main>').encode()

        def fetch(_url, **options):
            options["content_callback"](raw)
            return SimpleNamespace(status=200, url=URL, history=[],
                headers={"content-type": "text/html", "content-length": str(len(raw))})

        with patch.object(collector.Fetcher, "get", side_effect=fetch), \
                patch.object(collector, "extract_html_document", wraps=html_document.extract_html_document) as parser:
            result = collector.capture({"url": URL, "source_id": "synthetic-source-only",
                "proxy_url": "http://127.0.0.1:1", "executable_path": "", "capture_profile": collector.SOURCE_HTML_PROFILE})
        self.assertEqual([call.kwargs for call in parser.call_args_list], [{}, {}])
        for key in ("html_document", "source_main_document"):
            self.assertFalse(any(block["kind"] == "div" for block in result[key]["blocks"]))
        self.assertEqual(result["source_http"]["body_sha256"], hashlib.sha256(raw).hexdigest())

    def test_capture_rejects_unknown_profile_before_any_acquisition(self):
        with patch.object(collector.DynamicFetcher, "fetch") as fetcher, patch.object(collector.Fetcher, "get") as http:
            with self.assertRaisesRegex(collector.CaptureFailure, "^invalid_capture_profile$"):
                collector.capture({"url": URL, "capture_profile": "scrapling-evidence-v3"})
        fetcher.assert_not_called()
        http.assert_not_called()


if __name__ == "__main__":
    unittest.main()
