import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  extractStructuredHtml, MAX_STRUCTURED_HTML_BYTES, MAX_STRUCTURED_HTML_DEPTH,
  MAX_STRUCTURED_HTML_NODES, STRUCTURED_HTML_SCHEMA,
} from "./structured-html-content.mjs";

const sourceUrl = "https://awards.example/scholarship/rules?year=2027";
const extract = (html, options = {}) => extractStructuredHtml(html, { sourceUrl, ...options });
const digest = (text) => createHash("sha256").update(text).digest("hex");

function expectUnavailable(result, reason) {
  expect(result).toEqual({
    schema: STRUCTURED_HTML_SCHEMA, status: "unavailable", reason, scope: null,
    text: null, blocks: [], links: [], text_hash: null, content_hash: null,
    visibility: "not_verified",
  });
}

describe("structured rendered HTML extraction", () => {
  it("preserves words, date, currency and nested inline prose exactly except whitespace", () => {
    const result = extract("<main><h1>Scholarship&nbsp;rules</h1><p>Apply <strong>October 1, 2027</strong> at 5:00 p.m. CT.<br>Award: $30,000 &amp; travel.</p><div>Deadline: <span>October 1</span>.</div></main>");
    expect(result.status).toBe("ok");
    expect(result.scope).toBe("main");
    expect(result.visibility).toBe("not_verified");
    expect(result.blocks).toEqual([
      { kind: "heading", text: "Scholarship rules", heading_path: ["Scholarship rules"] },
      { kind: "paragraph", text: "Apply October 1, 2027 at 5:00 p.m. CT. Award: $30,000 & travel.", heading_path: ["Scholarship rules"] },
      { kind: "text", text: "Deadline: October 1.", heading_path: ["Scholarship rules"] },
    ]);
    expect(result.text_hash).toBe(digest(result.text.replace(/\s+/gu, " ")));
    expect(result.content_hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("preserves duplicate occurrences and heading hierarchy rather than only last heading", () => {
    const result = extract("<main><h1>Undergraduate</h1><h2>Eligibility</h2><p>U.S. citizen.</p><p>U.S. citizen.</p><h1>Graduate</h1><h2>Eligibility</h2><p>U.S. citizen.</p></main>");
    expect(result.blocks.filter((block) => block.kind === "paragraph")).toEqual([
      { kind: "paragraph", text: "U.S. citizen.", heading_path: ["Undergraduate", "Eligibility"] },
      { kind: "paragraph", text: "U.S. citizen.", heading_path: ["Undergraduate", "Eligibility"] },
      { kind: "paragraph", text: "U.S. citizen.", heading_path: ["Graduate", "Eligibility"] },
    ]);
  });

  it("retains nested list content once and retains prose before and after nested lists", () => {
    const result = extract("<main><ul><li><p>Applicants must:</p><ul><li>Be a junior.</li><li>Submit <b>two</b> references.</li></ul>Apply online.</li></ul></main>");
    expect(result.blocks.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "list_item", text: "Applicants must:" },
      { kind: "list_item", text: "Be a junior." },
      { kind: "list_item", text: "Submit two references." },
      { kind: "list_item", text: "Apply online." },
    ]);
    expect(result.blocks[0]).not.toHaveProperty("list_path");
    expect(result.blocks[1].list_path).toEqual(["Applicants must: Apply online."]);
    expect(result.blocks[2].list_path).toEqual(["Applicants must: Apply online."]);
    expect(result.blocks[3]).not.toHaveProperty("list_path");
  });

  it("distinguishes nested qualifications from sibling bullets without changing flattened text", () => {
    const nested = extract("<main><h1>Requirements</h1><ul><li>Juniors<ul><li>Must study biology.</li></ul></li><li>Seniors</li></ul></main>");
    const siblings = extract("<main><h1>Requirements</h1><ul><li>Juniors</li><li>Must study biology.</li><li>Seniors</li></ul></main>");
    expect(nested.text).toBe(siblings.text);
    expect(nested.text_hash).toBe(siblings.text_hash);
    expect(nested.content_hash).not.toBe(siblings.content_hash);
    expect(nested.blocks.find((block) => block.text === "Must study biology.")).toMatchObject({ list_path: ["Juniors"] });
    expect(siblings.blocks.find((block) => block.text === "Must study biology.")).not.toHaveProperty("list_path");
  });

  it("retains duplicate nested requirements under their own ancestor qualifications", () => {
    const result = extract("<main><h1>Eligibility</h1><ul><li>Juniors<ul><li>U.S. citizen.</li><li>U.S. citizen.</li></ul></li><li>Seniors<ul><li>U.S. citizen.</li></ul></li></ul></main>");
    const requirements = result.blocks.filter((block) => block.text === "U.S. citizen.");
    expect(requirements.map((block) => block.list_path)).toEqual([["Juniors"], ["Juniors"], ["Seniors"]]);
    expect(requirements.every((block) => block.heading_path.join() === "Eligibility")).toBe(true);
    requirements[0].list_path.push("Mutation");
    expect(requirements[1].list_path).toEqual(["Juniors"]);
  });

  it("preserves every ancestor item on nested headings, prose, tables and application links", () => {
    const result = extract('<main><ul><li>Undergraduate<ul><li>Juniors<ul><li><h2>Materials</h2><p>Two references.</p><table><tr><td>Fee</td><td>$0</td></tr></table><a href="/apply">Apply online.</a></li></ul></li></ul></li></ul></main>');
    expect(result.status).toBe("ok");
    for (const block of result.blocks.filter((block) => ["Materials", "Two references.", "Fee $0", "Apply online."].includes(block.text))) {
      expect(block.list_path).toEqual(["Undergraduate", "Juniors"]);
    }
    expect(result.links[0]).toMatchObject({ text: "Apply online.", list_path: ["Undergraduate", "Juniors"] });
    expect(result.blocks.find((block) => block.text === "Undergraduate")).not.toHaveProperty("list_path");
    expect(result.blocks.find((block) => block.text === "Juniors").list_path).toEqual(["Undergraduate"]);
  });

  it("normalizes ancestor own prose without attributing descendants or hidden instructions to it", () => {
    const result = extract('<main><ul><li><p>College <b>juniors</b></p><span hidden>Wrong group</span><button>Expand</button><ul><li>Submit a transcript.</li></ul></li></ul></main>');
    expect(result.blocks.find((block) => block.text === "Submit a transcript.").list_path).toEqual(["College juniors"]);
    expect(result.blocks[0].text).toBe("College juniors");
    const plain = extract('<main><ul><li>College juniors<ul><li>Submit a transcript.</li></ul></li></ul></main>');
    expect(result.content_hash).toBe(plain.content_hash);
  });

  it("retains empty-label nesting without inventing a qualification", () => {
    const result = extract("<main><ul><li><ul><li>Submit two references.</li></ul></li></ul></main>");
    expect(result.blocks).toEqual([{ kind: "list_item", text: "Submit two references.", heading_path: [], list_path: [""] }]);
    const sibling = extract("<main><ul><li>Submit two references.</li></ul></main>");
    expect(result.text).toBe(sibling.text);
    expect(result.content_hash).not.toBe(sibling.content_hash);
  });

  it("bounds repeated ancestor context independently of flattened text and returns no partial result", () => {
    const html = "<main><ul><li>Juniors studying STEM<ul><li>One</li><li>Two</li><li>Three</li></ul></li></ul></main>";
    expect(extract(html).text.length).toBeLessThan(50);
    expectUnavailable(extract(html, { maxTextChars: 50 }), "list_context_limit");
    expect(extract(html, { maxTextChars: 100 }).status).toBe("ok");
  });

  it("counts context on image-only links toward the same bounded list budget", () => {
    const html = `<main><ul><li>${"A".repeat(80)}<ul>${'<li><a href="/apply"><img alt="Guide" src="cover.png"></a></li>'.repeat(3)}</ul></li></ul></main>`;
    const result = extract(html);
    expect(result.blocks).toHaveLength(1);
    expect(result.links).toHaveLength(3);
    expect(result.links.every((link) => link.list_path[0] === "A".repeat(80))).toBe(true);
    expectUnavailable(extract(html, { maxTextChars: 200 }), "list_context_limit");
  });

  it("retains table captions, column headings, rows and nested cell prose without invented separators", () => {
    const result = extract('<main><h1>Deadlines</h1><table><caption>2027 cycle</caption><thead><tr><th>Program</th><th>Deadline</th></tr></thead><tbody><tr><th scope="row">Research</th><td><p>October <b>1, 2027</b></p><p>5 p.m.</p></td></tr><tr><td colspan="2">Final award $30,000</td></tr></tbody></table></main>');
    expect(result.blocks.map((block) => [block.kind, block.text])).toEqual([
      ["heading", "Deadlines"], ["text", "2027 cycle"],
      ["table_row", "Program Deadline"], ["table_row", "Research October 1, 2027 5 p.m."],
      ["table_row", "Final award $30,000"],
    ]);
    expect(result.blocks.every((block) => block.heading_path.join() === "Deadlines")).toBe(true);
    expect(result.blocks[3].cells).toEqual([
      { kind: "header", text: "Research", row_span: 1, col_span: 1 },
      { kind: "data", text: "October 1, 2027 5 p.m.", row_span: 1, col_span: 1 },
    ]);
    expect(result.blocks[4].cells).toEqual([{ kind: "data", text: "Final award $30,000", row_span: 1, col_span: 2 }]);
  });

  it("detects changed table-cell associations even when full row prose is identical", () => {
    const first = extract("<main><table><tr><td>Program A</td><td>October 1</td><td>$100</td></tr></table></main>");
    const second = extract("<main><table><tr><td>Program A October 1</td><td></td><td>$100</td></tr></table></main>");
    expect(first.text).toBe(second.text);
    expect(first.text_hash).toBe(second.text_hash);
    expect(first.content_hash).not.toBe(second.content_hash);
    expect(second.blocks[0].cells).toEqual([
      { kind: "data", text: "Program A October 1", row_span: 1, col_span: 1 },
      { kind: "data", text: "", row_span: 1, col_span: 1 },
      { kind: "data", text: "$100", row_span: 1, col_span: 1 },
    ]);
  });

  it("normalizes bounded table span attributes and preserves the special zero row span", () => {
    const result = extract('<main><table><tr><th rowspan="0">A</th><td rowspan="-2" colspan="0">B</td><td rowspan="1000000" colspan="1000000">C</td><td rowspan="bad" colspan="2">D</td></tr></table></main>');
    expect(result.blocks[0].cells.map((cell) => [cell.row_span, cell.col_span])).toEqual([[0, 1], [1, 1], [65534, 1000], [1, 2]]);
    const one = extract('<main><table><tr><td colspan="02">A</td></tr></table></main>');
    const two = extract('<main><table><tr><td colspan="2">A</td></tr></table></main>');
    expect(one.content_hash).toBe(two.content_hash);
  });

  it("preserves accordion headings, details prose and form instructions, but never field values", () => {
    const result = extract('<main><h1>Apply</h1><details open><summary>Required materials</summary>Two references.<p>One transcript.</p></details><p>General instructions.</p><h2><button aria-expanded="true">Eligibility</button></h2><p>Junior standing.</p><button aria-controls="panel">Application guide</button><form><label>Name <input value="PRIVATE VALUE"></label><p>Use your legal name.</p><textarea>PRIVATE TEXT</textarea><select><option>PRIVATE OPTION</option></select><button>Submit</button></form></main>');
    expect(result.text).toBe("Apply\nRequired materials\nTwo references.\nOne transcript.\nGeneral instructions.\nEligibility\nJunior standing.\nApplication guide\nName\nUse your legal name.");
    expect(result.blocks.find((block) => block.text === "Two references.").heading_path).toEqual(["Apply", "Required materials"]);
    expect(result.blocks.find((block) => block.text === "One transcript.").heading_path).toEqual(["Apply", "Required materials"]);
    expect(result.blocks.find((block) => block.text === "General instructions.").heading_path).toEqual(["Apply"]);
    expect(result.text).not.toContain("PRIVATE");
  });

  it("filters only known non-content/hidden DOM and admits unknown CSS visibility honestly", () => {
    const result = extract(`<body><nav>Nav</nav><header role="banner">Banner</header><main>
      <script>Script</script><style>Style</style><noscript>Noscript</noscript><template>Template</template>
      <svg><text>Vector</text></svg><canvas>Canvas</canvas><iframe>Frame</iframe>
      <div hidden="false">Hidden</div><div inert>Inert</div><div aria-hidden="TRUE"><h1>Aria hidden</h1></div>
      <div style="color:red; DISPLAY: none !important">Display hidden</div>
      <div style="visibility: hidden;">Visibility hidden</div><div style="visibility:collapse">Collapsed</div>
      <p class="hidden invisible d-none">External CSS unknown</p><p style="opacity:0">Opacity not inferred</p>
      <p title="display:none">Available text</p></main><footer>Footer</footer></body>`);
    expect(result.text).toBe("External CSS unknown\nOpacity not inferred\nAvailable text");
    expect(result.visibility).toBe("not_verified");
  });

  it("ignores hidden main roots but fails closed for multiple eligible main roots", () => {
    expectUnavailable(extract("<main>One</main><section role='main'>Two</section>"), "multiple_main_roots");
    expectUnavailable(extract("<main>One<main>Two</main></main>"), "multiple_main_roots");
    expect(extract("<main hidden>Invisible</main><main>Shown</main>").text).toBe("Shown");
  });

  it("prefers main, otherwise a unique article, otherwise retains the whole body", () => {
    expect(extract("<p>Outside</p><article>Article<main>Main</main></article>")).toMatchObject({ scope: "main", text: "Main" });
    expect(extract("<p>Outside</p><article>Article</article>")).toMatchObject({ scope: "article", text: "Article" });
    expect(extract("<nav>Navigation</nav><article>One</article><article>Two</article><footer>Foot</footer>")).toMatchObject({ scope: "body", text: "One\nTwo" });
    expect(extract("Plain body text <b>with emphasis.</b>")).toMatchObject({ scope: "body", text: "Plain body text with emphasis." });
  });

  it("parses malformed HTML without dropping nested prose", () => {
    const result = extract("<main><h1>Rules</h1><p>First <b>bold<p>Second &amp; final<ul><li>A<li>B");
    expect(result.status).toBe("ok");
    expect(result.blocks.map((block) => block.text)).toEqual(["Rules", "First bold", "Second & final", "A", "B"]);
  });

  it("resolves document and application URLs via the first base, retaining case, year queries and remote fragments", () => {
    const result = extract('<head><base href="/Documents/"><base href="https://ignored.example/"></head><main><h1>Apply</h1><a href="Guide.PDF?year=2027&utm_source=email#page=2">2027 guide</a><a href="../Apply?year=2027&gclid=tracker&step=1">Apply online</a></main>');
    expect(result.links).toEqual([
      { text: "2027 guide", url: "https://awards.example/Documents/Guide.PDF?year=2027#page=2", heading_path: ["Apply"] },
      { text: "Apply online", url: "https://awards.example/Apply?year=2027&step=1", heading_path: ["Apply"] },
    ]);
  });

  it("rejects dangerous URLs and same-page anchors, preserving non-HTTP link labels as prose", () => {
    const result = extract('<main><a href="#eligibility">Jump</a><a href="https://awards.example/scholarship/rules?year=2027&utm_source=x#rules">Same page</a><a href="https://other.example/rules#part">Other page</a><a href="mailto:a@example.org">Email</a><a href="javascript:alert(1)">Run</a><a href="data:text/html,bad">Data</a><a href="https://user:secret@example.org/">Credentials</a><a href="/apply?year=2028&fbclid=x">New year</a></main>');
    expect(result.links.map((link) => link.url)).toEqual(["https://other.example/rules#part", "https://awards.example/apply?year=2028"]);
    expect(result.text).toContain("Email");
    expect(result.text).toContain("Credentials");
  });

  it("does not adopt a second base when the first is invalid or use credentialed base URLs", () => {
    expect(extract('<base href="javascript:evil"><base href="https://other.example/"><main><a href="guide.pdf">Guide</a></main>').links[0].url).toBe("https://awards.example/scholarship/guide.pdf");
    expect(extract('<base href="https://user:password@other.example/"><main><a href="guide.pdf">Guide</a></main>').links[0].url).toBe("https://awards.example/scholarship/guide.pdf");
  });

  it("allows omitted sourceUrl only for absolute or absolute-base links", () => {
    const result = extractStructuredHtml('<main><a href="relative.pdf">Relative</a><a href="https://other.example/file.pdf">Absolute</a></main>');
    expect(result.status).toBe("ok");
    expect(result.links.map((link) => link.url)).toEqual(["https://other.example/file.pdf"]);
    expect(extractStructuredHtml('<base href="https://other.example/"><main><a href="guide.pdf">Guide</a></main>').links[0].url).toBe("https://other.example/guide.pdf");
  });

  it("preserves empty-text links without inventing image alt as visible content", () => {
    const result = extract('<main><a href="guide.pdf"><img alt="Not proven visible text" src="cover.png"></a></main>');
    expect(result).toMatchObject({ status: "ok", text: "", blocks: [], links: [{ text: "", url: "https://awards.example/scholarship/guide.pdf", heading_path: [] }] });
  });

  it("ignores attributes, inline markup, neutral wrappers and tracking-only changes in canonical hashes", () => {
    const first = extract('<main id="a"><h1>Rules</h1><p>Apply by <b>October 1.</b></p><a href="/guide.pdf?year=2027&utm_source=one">Guide</a></main>');
    const second = extract('<main class="new"><div><h1 class="large">Rules</h1></div><section><div><p style="color:blue"><span>Apply by October 1.</span></p></div></section><div><a id="new" href="/guide.pdf?year=2027&utm_source=two&FBCLID=abc">Guide</a></div></main>');
    expect(second.text_hash).toBe(first.text_hash);
    expect(second.content_hash).toBe(first.content_hash);
  });

  it("keeps meaningful href differences even when displayed text is unchanged", () => {
    const first = extract('<main><p>Application materials</p><a href="guide.pdf?year=2026">Guide</a></main>');
    const second = extract('<main><p>Application materials</p><a href="guide.pdf?year=2027">Guide</a></main>');
    expect(second.text_hash).toBe(first.text_hash);
    expect(second.content_hash).not.toBe(first.content_hash);
  });

  it("canonicalizes query encoding identically with or without tracking parameters", () => {
    const first = extract('<main><a href="/apply?q=a%20b&amp;year=2027&amp;year=2028">Apply</a></main>');
    const second = extract('<main><a href="/apply?q=a%20b&amp;year=2027&amp;year=2028&amp;utm_source=x">Apply</a></main>');
    expect(second.links).toEqual(first.links);
    expect(second.content_hash).toBe(first.content_hash);
    expect(first.links[0].url).toBe("https://awards.example/apply?q=a+b&year=2027&year=2028");
  });

  it("never mutates input options or leaks arrays across calls", () => {
    const options = Object.freeze({ sourceUrl, maxBlocks: 20, maxTextChars: 500, maxLinks: 10 });
    const html = "<main><h1>Apply</h1><p>Due October 1.</p></main>";
    const first = extractStructuredHtml(html, options);
    const second = extractStructuredHtml(html, options);
    first.blocks[0].heading_path.push("Mutated");
    first.links.push({ text: "Extra" });
    expect(second.blocks[0].heading_path).toEqual(["Apply"]);
    expect(second.links).toEqual([]);
    expect(extractStructuredHtml(html, options)).toEqual(second);
  });

  it.each([null, 123, {}, Buffer.from("<p>text</p>")])("rejects non-string HTML: %s", (html) => {
    expectUnavailable(extract(html), "invalid_html");
  });
  it.each([null, [], "bad", 1, { maxBlocks: 0 }, { maxLinks: -1 }, { maxTextChars: 1.5 }, { maxBlocks: 2001 }, { maxLinks: NaN }, { maxTextChars: Infinity }])("rejects invalid options: %s", (options) => {
    expectUnavailable(extractStructuredHtml("<p>Valid</p>", options), "invalid_options");
  });
  it.each(["", "relative/path", "file:///tmp/page", "https://user:secret@example.org/", null])("rejects a provided invalid source URL: %s", (value) => {
    expectUnavailable(extract("<p>Valid</p>", { sourceUrl: value }), "invalid_source_url");
  });
  it.each(["", "  \n "])("rejects empty HTML: %s", (html) => expectUnavailable(extract(html), "empty_html"));
  it.each(["<!doctype html>", "<main></main>", "<main><script>alert(1)</script></main>", "<body hidden><p>Secret</p></body>"])("rejects empty content: %s", (html) => expectUnavailable(extract(html), "empty_content"));

  it("enforces byte rather than character input limits", () => {
    expectUnavailable(extract("é".repeat(MAX_STRUCTURED_HTML_BYTES / 2 + 1)), "html_too_large");
  });
  it("enforces text and block limits without returning partial results", () => {
    expectUnavailable(extract("<p>First</p><p>Second</p>", { maxBlocks: 1 }), "block_limit");
    expectUnavailable(extract("<p>First</p><p>Second</p>", { maxTextChars: 10 }), "text_limit");
    expect(extract("<p>First</p><p>Second</p>", { maxTextChars: 12 }).status).toBe("ok");
  });
  it("enforces link count and destination size limits without partial results", () => {
    expectUnavailable(extract('<a href="/a">A</a><a href="/b">B</a>', { maxLinks: 1 }), "link_limit");
    expectUnavailable(extract(`<a href="https://example.org/${"a".repeat(100)}">A</a>`, { maxTextChars: 80 }), "link_text_limit");
  });
  it("enforces DOM depth and node limits, including hidden DOM", () => {
    expectUnavailable(extract(`${"<div>".repeat(MAX_STRUCTURED_HTML_DEPTH)}Content${"</div>".repeat(MAX_STRUCTURED_HTML_DEPTH)}`), "depth_limit");
    expectUnavailable(extract(`<main hidden>${"<i></i>".repeat(MAX_STRUCTURED_HTML_NODES)}</main>`), "node_limit");
  });
});
