"""Real NSF source fragments exercise the existing offline parser, not a new lane.

The exact bounded fragments have public-response hashes/offsets. Synthetic
html/body/main wrappers do not convert source HTML into rendered evidence.
No fetching, browser, provider call or installed runtime is involved.
"""
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from html_document import extract_html_document

FIXTURE_PATH = Path(__file__).resolve().parents[1] / "fixtures/scrapling-accuracy/nsf-source-excerpts-20261018.json"
FIXTURES = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
CASES = {row["id"]: row for row in FIXTURES["fixtures"]}


def extract(case_id):
    row = CASES[case_id]
    with patch("socket.socket", side_effect=AssertionError("source excerpt parsing must stay offline")):
        return extract_html_document("<html><body><main>" + row["html"] + "</main></body></html>", row["source_url"])


class NsfSourceExcerptTests(unittest.TestCase):
    def test_exact_bounded_provenance_for_six_source_fragments(self):
        self.assertEqual(len(CASES), 6)
        self.assertEqual(FIXTURES["receipt_sha256"], "5e8c0216e9e43d02093e80411681c437e0f17248d6f1c14e90c7f48ac8e294be")
        for row in CASES.values():
            with self.subTest(case=row["id"]):
                self.assertRegex(row["raw_sha256"], r"^[0-9a-f]{64}$")
                self.assertEqual(hashlib.sha256(row["html"].encode()).hexdigest(), row["excerpt_sha256"])
                self.assertEqual(len(row["html"].encode("utf-16-le")) // 2, row["raw_utf16_end"] - row["raw_utf16_start"])
                self.assertLess(len(row["html"]), 1500)
                self.assertTrue(row["source_url"].startswith("https://www.nsf.gov/"))

    def test_all_fragments_remain_unverified_source_only(self):
        for case_id in CASES:
            with self.subTest(case=case_id):
                doc = extract(case_id)
                self.assertEqual(doc["scope"], "html-source-main-document")
                self.assertFalse(doc["publishable"])
                self.assertFalse(doc["visibility_verified"])
                self.assertNotIn("screenshot", doc)
                self.assertNotIn("bounding_box", doc)
                self.assertIn(CASES[case_id]["expected"]["text"], doc["text"])

    def test_faq_preserves_required_undergraduate_and_conditional_graduate_rule(self):
        row = CASES["faq_transcripts_full_exception"]
        doc = extract(row["id"])
        answer = next(block for block in doc["blocks"] if block["kind"] == "p")
        self.assertEqual(answer["text"], row["expected"]["text"])
        self.assertEqual(answer["heading_path"][-1], {"level": 3, "text": row["expected"]["heading"]})
        self.assertEqual(answer["text"].count("if your institution"), 1)
        self.assertIn("first-year, first-term", answer["text"])

    def test_reference_and_field_specific_deadlines_keep_separate_list_context(self):
        ids = ["reference_not_application_deadline", "life_sciences_application_deadline"]
        html = "<html><body><main><h2>Applicant deadlines</h2><ul>" + "".join(CASES[key]["html"] for key in ids) + "</ul></main></body></html>"
        doc = extract_html_document(html, CASES[ids[0]]["source_url"])
        items = [block for block in doc["blocks"] if block["kind"] == "li"]
        self.assertEqual([block["text"] for block in items], [CASES[key]["expected"]["text"] for key in ids])
        self.assertNotIn("Life Sciences", items[0]["text"])
        self.assertNotIn("reference letters", items[1]["text"])
        self.assertTrue(all(block["heading_path"] == [{"level": 2, "text": "Applicant deadlines"}] for block in items))

    def test_questionnaire_disclaimer_retains_non_determination(self):
        doc = extract("questionnaire_not_eligibility_determination")
        self.assertIn("not an official determination of an individual's eligibility", doc["text"])
        self.assertEqual([block["text"] for block in doc["blocks"]], [CASES["questionnaire_not_eligibility_determination"]["expected"]["text"]])

    def test_local_print_link_is_retained_raw_not_claimed_as_pdf_evidence(self):
        doc = extract("solicitation_pdf_is_local_print_not_linked_document")
        self.assertEqual(len(doc["links"]), 1)
        self.assertEqual(doc["links"][0]["raw_href"], "javascript:if(window.print)window.print()")
        self.assertNotIn("resolved_url", doc["links"][0])
        self.assertNotIn("pdf_evidence", doc)

    def test_current_solicitation_cycle_is_not_inferred_from_document_number(self):
        row = CASES["solicitation_current_fiscal_cycle"]
        self.assertIn("nsf26-526/solicitation", row["source_url"])
        self.assertEqual(extract(row["id"])["text"], "This solicitation covers the Fiscal Year (FY) 2027 competition.")


if __name__ == "__main__":
    unittest.main()
