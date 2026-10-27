"""Offline programme-table regression; no browser, fetching or real source writes."""
import unittest
from html_document import extract_html_document

URL = "https://example.edu/funding"


def extract(body, neutral=False):
    return extract_html_document("<html><body>" + body + "</body></html>", URL, neutral_div_blocks=neutral)


class TableCellCoverageTests(unittest.TestCase):
    def test_nested_paragraphs_cannot_become_later_repeated_cell_evidence(self):
        doc = extract('<table><tr><td><p>MA</p></td><td><p>N/A</p></td></tr>'
                      '<tr><td><p>JD</p></td><td><p>N/A</p></td></tr>'
                      '<tr><td><p>JD/MBA</p></td><td><p>Need-based aid</p></td></tr></table>')
        self.assertEqual([b["kind"] for b in doc["blocks"]], ["td"] * 6)
        self.assertEqual([b["text"] for b in doc["blocks"]], ["MA", "N/A", "JD", "N/A", "JD/MBA", "Need-based aid"])
        self.assertEqual(doc["blocks"][3]["table_row"], ["JD", "N/A"])
        self.assertEqual(doc["blocks"][4]["table_row"], ["JD/MBA", "Need-based aid"])
        self.assertEqual(doc["text"], "MA N/A JD N/A JD/MBA Need-based aid")

    def test_identical_sibling_cells_and_rows_are_not_deduplicated(self):
        doc = extract('<table><tr><td><p>N/A</p></td><td><p>N/A</p></td></tr>' * 1
                      + '<tr><td><p>N/A</p></td><td><p>N/A</p></td></tr></table>')
        self.assertEqual(len(doc["blocks"]), 4)
        self.assertEqual([b["text"] for b in doc["blocks"]], ["N/A"] * 4)
        self.assertEqual(doc["text"], "N/A N/A N/A N/A")

    def test_substrings_in_separate_cells_retain_their_own_full_text_and_context(self):
        doc = extract('<table><tr><td>JD/MBA</td><td>JD</td><td>Not JD</td><td>JD</td></tr></table>')
        self.assertEqual([b["text"] for b in doc["blocks"]], ["JD/MBA", "JD", "Not JD", "JD"])
        self.assertTrue(all(b["table_row"] == ["JD/MBA", "JD", "Not JD", "JD"] for b in doc["blocks"]))

    def test_links_in_covered_children_are_still_retained_with_actual_row_context(self):
        doc = extract('<h1>Funding</h1><table><tr><td><p>JD <a href="/aid">School aid</a></p></td>'
                      '<td><ul><li>Apply <a href="/rules">rules</a></li></ul></td></tr></table>')
        self.assertEqual([link["raw_href"] for link in doc["links"]], ["/aid", "/rules"])
        self.assertIn("School aid", doc["text"])
        self.assertIn("Apply rules", doc["text"])
        self.assertEqual([b["kind"] for b in doc["blocks"]], ["heading", "td", "td"])

    def test_nested_table_is_wholly_retained_once_by_its_emitted_outer_cell(self):
        doc = extract('<table><tr><td><p>Outer</p><table><tr><td>Inner A</td><td>Inner B</td></tr></table>'
                      '<p>Tail</p></td><td>Sibling</td></tr></table><p>Outside</p>')
        self.assertEqual([b["text"] for b in doc["blocks"]], ["Outer Inner A Inner B Tail", "Sibling", "Outside"])
        self.assertEqual(doc["text"], "Outer Inner A Inner B Tail Sibling Outside")
        self.assertEqual(doc["blocks"][-1]["table_row"], [])

    def test_header_cell_nested_heading_is_not_matched_again_to_a_later_heading(self):
        doc = extract('<table><tr><th><h2>Degree</h2></th><th><p>Funding</p></th></tr></table><h2>Degree</h2>')
        self.assertEqual([b["kind"] for b in doc["blocks"]], ["th", "th", "heading"])
        self.assertEqual([b["text"] for b in doc["blocks"]], ["Degree", "Funding", "Degree"])

    def test_outside_table_semantic_children_are_unchanged(self):
        doc = extract('<ul><li>Parent <p>Child</p></li></ul><p>Sibling</p>')
        self.assertEqual([b["kind"] for b in doc["blocks"]], ["li", "p", "p"])
        self.assertEqual([b["text"] for b in doc["blocks"]], ["Parent Child", "Child", "Sibling"])

    def test_existing_v2_neutral_div_mode_does_not_reintroduce_covered_children(self):
        doc = extract('<table><tr><td><div>Same <b>rule</b></div></td><td><div>Same <b>rule</b></div></td></tr></table>', True)
        self.assertEqual([b["kind"] for b in doc["blocks"]], ["td", "td"])
        self.assertEqual(doc["text"], "Same rule Same rule")


if __name__ == "__main__":
    unittest.main()
