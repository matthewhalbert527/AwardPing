// Pure finite retained-HTML link proof. Caller must cold-load complete originals.
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { programTextReference, validateProgramTextReference } from './program-text-artifacts.mjs';
import { validateProgramTextCapture } from './program-text-capture-contract.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = why => { throw new Error('Text source raw anchor: ' + why); };
const OWNER = 'd955a846-cee1-4c01-932e-e3cb7215f3fb';
const SOURCE = 'c49e85e3-3b19-4052-891f-c2bc67e8b8f6';
const AUTHORITY = 'https://www.nsf.gov/funding/opportunities/grfp-nsf-graduate-research-fellowship-program/nsf26-526/solicitation';
const GUIDE_INDEX = 'https://www.nsf.gov/policies/document/graduate-research-fellowship-program-grfp-administrative';
const GUIDE_PDF = 'https://nsf-gov-resources.nsf.gov/files/nsf25033.pdf';
// Each target has one independently reviewed authority and literal link. The
// PDF grant does not authorize arbitrary NSF subdomains, years or documents.
const PROFILES = Object.freeze([
  { target: GUIDE_INDEX, authority_id: SOURCE, authority_url: AUTHORITY, page_type: 'other', literal_href: GUIDE_INDEX },
  { target: 'https://www.nsf.gov/policies/pappg', authority_id: SOURCE, authority_url: AUTHORITY, page_type: 'other', literal_href: '/policies/pappg' },
  { target: GUIDE_PDF, authority_id: '89681230-d6b4-46ba-8649-a8c19633c7aa', authority_url: GUIDE_INDEX, page_type: 'pdf', literal_href: GUIDE_PDF },
].map(Object.freeze));
export const FINITE_NSF_TARGETS = Object.freeze(PROFILES.map(profile => profile.target));
const FORBIDDEN = new Set(['head', 'script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'header', 'nav', 'footer']);
const whitespace = char => /[\t\n\f\r ]/.test(char ?? '');

// Tokenizes only an already located <a> START TAG. It is not an HTML parser.
// DOM membership, namespace and ancestors are independently read from parse5.
function startTagAttributes(tag, absoluteStart) {
  if (!/^<a(?:[\t\n\f\r />])/i.test(tag) || !tag.endsWith('>')) fail('invalid_located_anchor_start_tag');
  let at = 2; const attributes = [];
  while (at < tag.length - 1) {
    while (whitespace(tag[at])) at++;
    if (tag[at] === '/' && at === tag.length - 2) break;
    if (tag[at] === '>') break;
    const start = at;
    while (at < tag.length - 1 && !whitespace(tag[at]) && !['=', '>', '/'].includes(tag[at])) at++;
    const name = tag.slice(start, at); if (!name || /[\0"'<]/u.test(name)) fail('malformed_attribute_name');
    while (whitespace(tag[at])) at++;
    let value = null, valueStart = at, valueEnd = at;
    if (tag[at] === '=') {
      at++; while (whitespace(tag[at])) at++; const quote = ['"', "'"].includes(tag[at]) ? tag[at++] : null;
      valueStart = at;
      if (quote) {
        while (at < tag.length - 1 && tag[at] !== quote) at++;
        if (tag[at] !== quote) fail('unterminated_attribute'); valueEnd = at; value = tag.slice(valueStart, at++);
      } else {
        while (at < tag.length - 1 && !whitespace(tag[at]) && tag[at] !== '>') at++;
        valueEnd = at; value = tag.slice(valueStart, at);
        if (!value || /[\0"'<=`]/u.test(value)) fail('malformed_unquoted_attribute');
      }
    }
    attributes.push({ name: name.toLowerCase(), value, start: absoluteStart + start, end: absoluteStart + at,
      value_start: absoluteStart + valueStart, value_end: absoluteStart + valueEnd });
  }
  return attributes;
}

function resolveFiniteHref(literal, finalURL, target, profile) {
  // Initial increment deliberately excludes entity/percent encoded URLs,
  // dot segments, relative-directory resolution, queries and delegation.
  if (typeof literal !== 'string' || !literal || literal.length > 2048 || /[^\x21-\x7e]/u.test(literal) || /[\\&%]/u.test(literal) ||
      literal.startsWith('//') || (!literal.startsWith('/') && !literal.startsWith('https://'))) fail('unsupported_literal_href');
  const pathPart = literal.replace(/^https:\/\/[^/]+/, '').split('#')[0];
  if (pathPart.includes('//') || pathPart.split('/').some(part => part === '.' || part === '..')) fail('ambiguous_path_normalization');
  let linked, requested; try { linked = new URL(literal, finalURL); requested = new URL(target); } catch { fail('invalid_url'); }
  if (linked.protocol !== 'https:' || linked.username || linked.password || linked.search || linked.origin !== new URL(profile.target).origin ||
      requested.protocol !== 'https:' || requested.username || requested.password || requested.search || requested.hash || requested.href !== target ||
      requested.origin !== linked.origin) fail('URL_or_ownership_boundary');
  if (literal.startsWith('https://') && linked.href !== literal) fail('noncanonical_absolute_href');
  if (linked.hash && !/^#[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(linked.hash)) fail('unsupported_fragment');
  const page = new URL(linked); page.hash = '';
  if (page.href === finalURL) fail('same_page_section_not_new_source');
  if (page.href !== target) fail('target_page_mismatch');
  if (!FINITE_NSF_TARGETS.includes(target)) fail('target_not_in_finite_initial_increment');
  return { resolved_href: linked.href, target_page_url: page.href, fragment: linked.hash || null };
}

/** Input offset is a locator only, never trusted evidence. Cold restoration and
 * current source/epoch/role CAS still belong to the existing server workflow. */
function deriveRawAnchor({ authority_ref: ref, rawBytes, anchor_start_utf16, target_page_url, profile }) {
  validateProgramTextReference(ref);
  if (ref.source.id !== profile.authority_id || ref.source.shared_award_id !== OWNER || ref.source.page_type !== 'other' ||
      ref.source.url !== profile.authority_url || ref.final_url !== profile.authority_url ||
      ref.acquisition !== 'http_html' || ref.completeness.status !== 'complete' || ref.completeness.reasons.length ||
      !ref.artifacts.raw.object_key.endsWith('/original.html') || !/^text\/html(?:;|$)/i.test(ref.artifacts.raw.content_type)) fail('authority_identity_or_transport');
  if (!Buffer.isBuffer(rawBytes) || rawBytes.length < 1 || rawBytes.length > 2 * 1024 * 1024 ||
      rawBytes.length !== ref.artifacts.raw.byte_length || sha(rawBytes) !== ref.artifacts.raw.sha256) fail('raw_original_binding');
  const html = rawBytes.toString('utf8');
  if (!Buffer.from(html, 'utf8').equals(rawBytes) || html.startsWith('\ufeff') || html.includes('\0')) fail('unsupported_raw_encoding');
  if (!Number.isSafeInteger(anchor_start_utf16) || anchor_start_utf16 < 0 || anchor_start_utf16 >= html.length) fail('invalid_anchor_locator');
  const $ = load(html, { sourceCodeLocationInfo: true });
  if ($('base').length) fail('base_element_requires_separate_profile');
  const all = $('a[href]').toArray(), matches = all.filter(node => node.sourceCodeLocation?.startTag?.startOffset === anchor_start_utf16);
  if (matches.length !== 1) fail('no_unique_actual_DOM_anchor');
  const node = matches[0], startTag = node.sourceCodeLocation.startTag;
  if (node.namespace !== 'http://www.w3.org/1999/xhtml' || !$(node).parents('body').length) fail('anchor_not_body_HTML');
  const bodies = $('body').toArray(), bodyLocation = bodies[0]?.sourceCodeLocation;
  if (bodies.length !== 1 || !bodyLocation?.startTag || !bodyLocation.endTag ||
      bodyLocation.startTag.endOffset > startTag.startOffset || bodyLocation.endTag.startOffset < startTag.endOffset) fail('anchor_not_explicit_body');
  for (let ancestor = node; ancestor; ancestor = ancestor.parent) {
    if (FORBIDDEN.has(ancestor.name) || ancestor.attribs && (Object.hasOwn(ancestor.attribs, 'hidden') || ancestor.attribs['aria-hidden'] === 'true')) fail('inert_or_nonprogramme_ancestor');
  }
  const rawStartTag = html.slice(startTag.startOffset, startTag.endOffset), attributes = startTagAttributes(rawStartTag, startTag.startOffset);
  const hrefs = attributes.filter(a => a.name === 'href');
  if (hrefs.length !== 1 || hrefs[0].value === null || hrefs[0].value !== $(node).attr('href')) fail('duplicate_encoded_or_missing_href');
  const href = hrefs[0], resolved = resolveFiniteHref(href.value, ref.final_url, target_page_url, profile);
  const byteOffset = offset => Buffer.byteLength(html.slice(0, offset), 'utf8');
  const anchor = { tag: 'a', namespace: node.namespace, ordinal: all.indexOf(node), start_utf16: startTag.startOffset, end_utf16: startTag.endOffset,
    start_byte: byteOffset(startTag.startOffset), end_byte: byteOffset(startTag.endOffset), start_tag: rawStartTag, start_tag_sha256: sha(Buffer.from(rawStartTag)),
    href_attribute_start_utf16: href.start, href_attribute_end_utf16: href.end,
    href_value_start_byte: byteOffset(href.value_start), href_value_end_byte: byteOffset(href.value_end), literal_href: href.value,
    label: $(node).text().replace(/\s+/gu, ' ').trim().slice(0, 1000),
    parent_context: $(node).parent().text().replace(/\s+/gu, ' ').trim().slice(0, 1600) };
  if (!rawBytes.subarray(anchor.start_byte, anchor.end_byte).equals(Buffer.from(rawStartTag)) ||
      rawBytes.subarray(anchor.href_value_start_byte, anchor.href_value_end_byte).toString('utf8') !== href.value) fail('byte_locator_mismatch');
  return { kind: 'retained_raw_html_anchor.v1', source_id: ref.source.id, capture_id: ref.capture_id,
    raw_artifact: structuredClone(ref.artifacts.raw), raw_base64: rawBytes.toString('base64'),
    parser_profile: 'program-text-raw-anchor-v1/cheerio1.2.0-parse5-7.3.0', anchor, resolved_url: resolved.target_page_url };
}

const object = x => x && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(key => Object.hasOwn(x, key));
const canonical = x => Array.isArray(x) ? x.map(canonical) : object(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
export const PROGRAM_TEXT_RAW_ANCHOR_KIND = 'retained_raw_html_anchor.v1';
/** No client receipt is accepted. A complete cold capture is replayed here. */
export function buildProgramTextRawAnchorProviderLink(proposal, capture) {
  const profile = PROFILES.find(item => item.target === proposal.source?.url);
  if (!exact(proposal.link_proof, ['kind', 'anchor_start_utf16', 'target_page_url']) ||
      proposal.link_proof.kind !== PROGRAM_TEXT_RAW_ANCHOR_KIND || proposal.link_proof.target_page_url !== proposal.source.url ||
      proposal.cohort_key !== 'nsf_grfp' || proposal.expected_canonical_shared_award_id !== OWNER ||
      proposal.source.shared_award_id !== OWNER || proposal.source.expected_member_kind !== 'canonical' ||
      !profile || proposal.source.page_type !== profile.page_type) fail('finite_NSF_scope');
  validateProgramTextCapture(capture);
  if (JSON.stringify(canonical(programTextReference(capture))) !== JSON.stringify(canonical(proposal.authority_ref))) fail('cold_capture_reference_changed');
  const link = deriveRawAnchor({ authority_ref: proposal.authority_ref, rawBytes: capture.raw_source.bytes,
    anchor_start_utf16: proposal.link_proof.anchor_start_utf16, target_page_url: proposal.source.url, profile });
  // Exact observed literal forms only, including the one indexed NSF PDF.
  // No fragment, alias, query, new base or directory-resolution grant.
  const expectedHref = profile.literal_href;
  if (!FINITE_NSF_TARGETS.includes(proposal.source.url) || link.anchor.literal_href !== expectedHref || Buffer.byteLength(link.anchor.start_tag)>4096) fail('finite_literal_href');
  return link;
}

/** Browser-facing audit preview: immutable raw bytes stay private to validators. */
export function programTextRawAnchorLinkDisplay(value) {
  if (!object(value) || value.kind !== PROGRAM_TEXT_RAW_ANCHOR_KIND) return value;
  return { kind: value.kind, source_id: value.source_id, capture_id: value.capture_id, raw_artifact: value.raw_artifact,
    parser_profile: value.parser_profile, anchor: value.anchor, resolved_url: value.resolved_url, raw_bytes_retained_privately: true };
}
