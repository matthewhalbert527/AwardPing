"""Pure, offline source-document fixtures; no browsers or external requests."""

import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import html_document as module
from html_document import HtmlDocumentError, extract_html_document


URL = "https://example.edu/awards/example"


def document(body, head="<title>Example Award</title>"):
    return extract_html_document(f"<!doctype html><html><head>{head}</head><body>{body}</body></html>", URL)


class HtmlSourceDocumentTests(unittest.TestCase):
    def test_closed_gilman_deadline_is_retained_without_visibility_claim(self):
        doc = document('<h1>Gilman Scholarship</h1><button aria-expanded="false">Deadlines</button>'
            '<section hidden><h2>March 2027 application</h2><p>Submit by March 4, 2027 at 11:59 p.m. Pacific Time.</p></section>')
        self.assertIn("March 4, 2027 at 11:59 p.m. Pacific Time.", doc["text"])
        self.assertFalse(doc["visibility_verified"])
        self.assertFalse(doc["publishable"])
        self.assertEqual(doc["scope"], "html-source-main-document")

    def test_scroll_hidden_luce_sections_are_not_dropped(self):
        doc = document('<h1>Luce Scholars</h1><section style="opacity:0;transform:translateY(50px)" data-sal="slide-up">'
            '<h2>Eligibility</h2><p>Applicants must be under age 32 when the program begins.</p></section>'
            '<div style="display:none"><p>Applicants with substantial Asia experience should review exceptions.</p></div>')
        self.assertIn("under age 32", doc["text"])
        self.assertIn("review exceptions", doc["text"])

    def test_closed_truman_faq_answer_and_soros_details_are_retained(self):
        doc = document('<h1>Frequently asked questions</h1><div aria-hidden="true"><h2>Can seniors apply?</h2>'
            '<p>Applicants must be juniors during the nomination year.</p></div>'
            '<details><summary>Soros eligibility</summary><p>Applicants must be 30 or younger on the deadline.</p></details>')
        self.assertIn("juniors during the nomination year", doc["text"])
        self.assertIn("30 or younger", doc["text"])

    def test_opening_same_details_does_not_manufacture_a_source_content_change(self):
        closed = document('<details><summary>Eligibility</summary><p>U.S. applicants only.</p></details>')
        opened = document('<details open><summary>Eligibility</summary><p>U.S. applicants only.</p></details>')
        for key in ("title", "text", "blocks", "links", "base_hrefs"):
            self.assertEqual(closed[key], opened[key])
        self.assertEqual(closed["blocks"][1]["details_path"], ["Eligibility"])

    def test_details_question_qualifies_answer_and_links_without_invented_heading(self):
        # Reduced, source-shaped Beinecke advisor FAQ fixture. Its institution
        # deadline is not a student application deadline.
        question = "How can my school become a participating institution?"
        doc = document('<h1>Advisor FAQs</h1><details><summary><span>' + question + '</span></summary>'
            '<div><p>Institution applications must be received by May 1. Contact the '
            '<a href="/contact/">Program Director</a>.</p></div></details>')
        answer = next(block for block in doc["blocks"] if block["kind"] == "p")
        self.assertEqual(answer["details_path"], [question])
        self.assertEqual(answer["heading_path"], [{"level": 1, "text": "Advisor FAQs"}])
        self.assertEqual(doc["links"][0]["details_path"], [question])
        self.assertFalse(doc["visibility_verified"])
        self.assertFalse(doc["publishable"])

    def test_moving_answer_outside_details_changes_relationship_despite_equal_prose(self):
        before = document('<h1>Award FAQ</h1><details><summary>U.S. applicants</summary>'
            '<p>The deadline is October 1.</p></details><p>Other guidance.</p>')
        after = document('<h1>Award FAQ</h1><details><summary>U.S. applicants</summary></details>'
            '<p>The deadline is October 1.</p><p>Other guidance.</p>')
        self.assertEqual(before["text"], after["text"])
        self.assertNotEqual(before["blocks"], after["blocks"])
        self.assertEqual(before["blocks"][2]["details_path"], ["U.S. applicants"])
        self.assertNotIn("details_path", after["blocks"][2])

    def test_moving_link_outside_details_changes_relationship_despite_equal_prose_and_href(self):
        before = document('<details><summary>U.S. applicants</summary><a href="/apply/">Apply</a></details>')
        after = document('<details><summary>U.S. applicants</summary></details><a href="/apply/">Apply</a>')
        self.assertEqual(before["text"], after["text"])
        self.assertEqual(before["links"][0]["raw_href"], after["links"][0]["raw_href"])
        self.assertNotEqual(before["links"], after["links"])
        self.assertEqual(before["links"][0]["details_path"], ["U.S. applicants"])
        self.assertNotIn("details_path", after["links"][0])

    def test_nested_details_use_first_direct_summary_not_nested_or_later_summary(self):
        doc = document('<details><summary>Outer applicants</summary><summary>Not the controlling summary</summary>'
            '<details><summary>Graduate applicants</summary><p>Graduate requirement.</p>'
            '<a href="/graduate/">Graduate form</a></details><p>Outer requirement.</p></details>')
        graduate = next(block for block in doc["blocks"] if block["text"] == "Graduate requirement.")
        outer = next(block for block in doc["blocks"] if block["text"] == "Outer requirement.")
        self.assertEqual(graduate["details_path"], ["Outer applicants", "Graduate applicants"])
        self.assertEqual(outer["details_path"], ["Outer applicants"])
        self.assertEqual(doc["links"][0]["details_path"], ["Outer applicants", "Graduate applicants"])

    def test_missing_or_empty_summary_keeps_unlabeled_ancestor_without_guessing(self):
        for summary in ("", "<summary>  </summary>"):
            with self.subTest(summary=summary):
                doc = document('<details>' + summary + '<details><summary>Nested applicants</summary>'
                    '<p>Nested requirement.</p></details><p>Outer requirement.</p>'
                    '<a href="/rules/">Rules</a></details><p>Outside requirement.</p>')
                nested = next(block for block in doc["blocks"] if block["text"] == "Nested requirement.")
                outer = next(block for block in doc["blocks"] if block["text"] == "Outer requirement.")
                outside = next(block for block in doc["blocks"] if block["text"] == "Outside requirement.")
                self.assertEqual(nested["details_path"], ["", "Nested applicants"])
                self.assertEqual(outer["details_path"], [""])
                self.assertEqual(doc["links"][0]["details_path"], [""])
                self.assertNotIn("details_path", outside)

    def test_details_scope_does_not_leak_to_sibling_questions_or_outside_links(self):
        doc = document('<h1>Eligibility</h1><details><summary>Age exceptions?</summary>'
            '<p>No age exceptions.</p></details><details><summary>Extensions?</summary>'
            '<p>No extensions.</p></details><p>General requirement.</p><a href="/help/">Help</a>')
        answers = {block["text"]: block for block in doc["blocks"] if block["kind"] == "p"}
        self.assertEqual(answers["No age exceptions."]["details_path"], ["Age exceptions?"])
        self.assertEqual(answers["No extensions."]["details_path"], ["Extensions?"])
        self.assertNotIn("details_path", answers["General requirement."])
        self.assertNotIn("details_path", doc["links"][0])

    def test_summary_links_and_summary_blocks_keep_their_actual_container(self):
        doc = document('<details><summary>Questions for <a href="/us/">U.S. applicants</a></summary>'
            '<p>Requirements.</p></details>')
        self.assertEqual(doc["blocks"][0]["details_path"], ["Questions for U.S. applicants"])
        self.assertEqual(doc["links"][0]["details_path"], ["Questions for U.S. applicants"])

    def test_details_context_repetition_remains_bounded(self):
        with patch.object(module, "MAX_OUTPUT_BYTES", 1500):
            with self.assertRaisesRegex(HtmlDocumentError, "html_document_size_limit"):
                document('<details><summary>' + "Question " * 25 + '</summary>' +
                    '<p>Requirement.</p>' * 5 + '</details>')

    def test_hidden_duplicate_and_stale_wording_are_preserved_without_claiming_active_facts(self):
        doc = document('<p>Deadline October 1, 2027.</p><p style="display:none">Deadline October 1, 2026.</p>'
                       '<p>U.S. applicants only.</p><p>U.S. applicants only.</p>')
        self.assertIn("October 1, 2026", doc["text"])
        self.assertIn("October 1, 2027", doc["text"])
        self.assertEqual(doc["text"].count("U.S. applicants only."), 2)
        self.assertEqual(sum(block["text"] == "U.S. applicants only." for block in doc["blocks"]), 2)

    def test_noncontent_subtrees_and_comment_text_do_not_enter_body_output(self):
        doc = document('<p>Real award requirement.</p><script>FAKE_SCRIPT deadline 2039</script>'
            '<style>.x{content:"FAKE_STYLE"}</style><noscript>FAKE_NOSCRIPT</noscript>'
            '<template><p>FAKE_TEMPLATE</p></template><!-- FAKE_COMMENT -->'
            '<p>Second real requirement.</p>', '<title>Real Title</title><meta content="FAKE_META"><script>FAKE_HEAD</script>')
        self.assertEqual(doc["title"], "Real Title")
        self.assertEqual(doc["text"], "Real award requirement. Second real requirement.")
        self.assertNotIn("FAKE_", json.dumps({key: doc[key] for key in ("text", "blocks", "links")}))

    def test_inline_word_parts_entities_and_excluded_node_tails_remain_in_order(self):
        doc = document('<p>A<span>ward</span> for <span>U.S.</span> <strong>applicants</strong> &amp; nationals.</p>'
            '<p>Dead<script>noise</script>line: <b>Oct</b>ober 31.</p>')
        self.assertEqual(doc["text"], "Award for U.S. applicants & nationals. Deadline: October 31.")

    def test_semantic_block_boundaries_do_not_fuse_adjacent_words(self):
        doc = document('<div>Alpha</div><div>Beta</div><p>One<br>Two</p>'
            '<ul><li>Junior</li><li>Senior</li></ul><table><tr><td>U.S.</td><td>2027</td></tr></table>')
        self.assertEqual(doc["text"], "Alpha Beta One Two Junior Senior U.S. 2027")

    def test_unstructured_body_text_is_authoritative_even_without_semantic_blocks(self):
        doc = document('<div><span>Scholarship applications are due November 1.</span></div>')
        self.assertEqual(doc["text"], "Scholarship applications are due November 1.")
        self.assertEqual(doc["blocks"][0]["kind"], "text")

    def test_headings_are_retained_as_context_hints(self):
        doc = document('<h1>Example Award</h1><h2>U.S. applicants</h2><p>Deadline October 1.</p>'
            '<h2>International applicants</h2><p>Deadline December 1.</p>')
        paragraphs = [block for block in doc["blocks"] if block["kind"] == "p"]
        self.assertEqual(paragraphs[0]["heading_path"][-1], {"level": 2, "text": "U.S. applicants"})
        self.assertEqual(paragraphs[1]["heading_path"][-1], {"level": 2, "text": "International applicants"})
        self.assertTrue(any("hints" in limitation for limitation in doc["limitations"]))

    def test_nested_list_qualifiers_are_not_separated_from_requirements(self):
        doc = document('<h1>Eligibility</h1><ul><li>For juniors only<ul><li>Minimum GPA 3.7.</li>'
            '<li><a href="/apply">Apply</a> after campus nomination.</li></ul></li></ul>')
        requirement = next(block for block in doc["blocks"] if block["text"] == "Minimum GPA 3.7.")
        self.assertIn("For juniors only", requirement["list_path"][0])
        self.assertIn("For juniors only", doc["links"][0]["list_path"][0])
        self.assertIn("after campus nomination", doc["text"])

    def test_moving_same_wording_between_list_conditions_changes_context(self):
        before = document('<ul><li>Juniors<ul><li>GPA 3.7.</li></ul></li><li>Seniors</li></ul>')
        after = document('<ul><li>Juniors</li><li>Seniors<ul><li>GPA 3.7.</li></ul></li></ul>')
        get = lambda doc: next(block["list_path"] for block in doc["blocks"] if block["text"] == "GPA 3.7.")
        self.assertNotEqual(get(before), get(after))

    def test_table_row_and_raw_cell_relationships_are_preserved(self):
        doc = document('<table><tr><th id="citizen" scope="row">U.S. applicants</th>'
            '<td headers="citizen" colspan="02" rowspan="1">October 1, 2027</td></tr></table>')
        deadline = next(block for block in doc["blocks"] if block["kind"] == "td")
        self.assertEqual(deadline["table_row"], ["U.S. applicants", "October 1, 2027"])
        self.assertEqual(deadline["table_cell"], {"raw_colspan": "02", "raw_rowspan": "1", "headers": "citizen", "scope": "", "id": ""})

    def test_raw_links_and_all_base_hrefs_are_preserved_without_urljoin(self):
        doc = document('<p><a href="../Apply?Cycle=2027&amp;x=1">Application</a></p>'
            '<a href="javascript:void(0)">Non-navigation action</a><a href="">Current document</a>',
            '<title>Example</title><base href="/Award/2027/"><base href="https://elsewhere.example/">')
        self.assertEqual(doc["base_hrefs"], ["/Award/2027/", "https://elsewhere.example/"])
        self.assertEqual(doc["links"][0]["raw_href"], "../Apply?Cycle=2027&x=1")
        self.assertEqual(doc["links"][0]["source_url"], URL)
        self.assertEqual(doc["links"][0]["base_hrefs"], doc["base_hrefs"])
        self.assertNotIn("url", doc["links"][0])
        self.assertEqual(doc["links"][1]["raw_href"], "javascript:void(0)")
        self.assertEqual(doc["links"][2]["raw_href"], "")

    def test_link_query_case_and_base_mutations_remain_comparison_candidates(self):
        before = document('<p><a href="Apply?year=2026">Apply</a></p>', '<base href="/2026/">')
        after = document('<p><a href="apply?year=2027">Apply</a></p>', '<base href="/2027/">')
        self.assertEqual(before["text"], after["text"])
        self.assertNotEqual(before["links"], after["links"])
        self.assertNotEqual(before["base_hrefs"], after["base_hrefs"])

    def test_document_keeps_source_identity_and_unicode(self):
        doc = document('<p>Beca académica: ciudadanía española; café; 世界.</p>')
        self.assertEqual(doc["source_url"], URL)
        self.assertIn("ciudadanía española", doc["text"])
        self.assertIn("世界", doc["text"])
        self.assertEqual(doc["schema"], "awardping.scrapling-html-document.v1")

    def test_hidden_markup_is_inert_not_executed_or_used_as_instructions(self):
        with patch("socket.socket.connect", side_effect=AssertionError("Network prohibited")):
            doc = document('<p>Actual deadline October 1.</p><img src="https://example.edu/track">'
                '<script>fetch("https://example.edu/send")</script><a href="https://example.edu/">Official source</a>')
        self.assertIn("Actual deadline October 1", doc["text"])

    def test_source_size_is_bounded_by_utf8_bytes(self):
        with patch.object(module, "MAX_HTML_BYTES", 200):
            with self.assertRaisesRegex(HtmlDocumentError, "html_size_limit"):
                document("界" * 60)

    def test_input_node_limit_is_checked_before_parse(self):
        with patch.object(module, "MAX_NODES", 10):
            with self.assertRaisesRegex(HtmlDocumentError, "html_node_limit"):
                document("<i>x</i>" * 10)

    def test_excess_depth_is_refused_instead_of_silently_truncated(self):
        with self.assertRaisesRegex(HtmlDocumentError, "html_depth_limit"):
            document("<div>" * 101 + "Important final requirement." + "</div>" * 101)

    def test_full_source_text_limit_is_not_truncation(self):
        with patch.object(module, "MAX_TEXT_CHARS", 60):
            with self.assertRaisesRegex(HtmlDocumentError, "html_text_limit"):
                document("<p>" + "a" * 61 + "</p>")

    def test_item_and_output_bounds_fail_explicitly(self):
        with patch.object(module, "MAX_ITEMS", 2):
            with self.assertRaisesRegex(HtmlDocumentError, "html_item_limit"):
                document("<p>One</p><p>Two</p><p>Three</p>")
        with patch.object(module, "MAX_OUTPUT_BYTES", 100):
            with self.assertRaisesRegex(HtmlDocumentError, "html_document_size_limit"):
                document("<p>Important award requirement.</p>")

    def test_long_attributes_are_refused_not_cut_off(self):
        with patch.object(module, "MAX_ATTRIBUTE_CHARS", 100):
            with self.assertRaisesRegex(HtmlDocumentError, "attribute_size_limit"):
                document('<a href="' + "x" * 101 + '">Apply</a>')

    def test_invalid_input_has_bounded_failure(self):
        for bad in (None, "", "\x00", 123):
            with self.subTest(value=bad), self.assertRaises(HtmlDocumentError):
                extract_html_document(bad, URL)
        for url in ("file:///secret", "https://user:password@example.edu/", "not a URL"):
            with self.subTest(url=url), self.assertRaisesRegex(HtmlDocumentError, "invalid_source_url"):
                extract_html_document("<html><body>Award</body></html>", url)

    def test_cli_outputs_only_json_and_refuses_extra_fields(self):
        command = [sys.executable, "-B", str(Path(module.__file__).resolve())]
        good = subprocess.run(command, input=json.dumps({"html": "<html><body><p>Beca académica.</p></body></html>", "url": URL}),
            text=True, encoding="utf-8", capture_output=True, check=False, timeout=15)
        self.assertEqual(good.returncode, 0, good.stderr)
        self.assertEqual(json.loads(good.stdout)["text"], "Beca académica.")
        bad = subprocess.run(command, input=json.dumps({"html": "<p>Example</p>", "url": URL, "fetch": True}),
            text=True, encoding="utf-8", capture_output=True, check=False, timeout=15)
        self.assertEqual(bad.returncode, 2)
        self.assertEqual(json.loads(bad.stdout), {"error": "invalid_request"})


if __name__ == "__main__":
    unittest.main()
