import { describe, expect, it } from "vitest";
import { alertMemberRefs, alertSourceLink, isAlertReview, mergePreviewMatchesSelection, parseAlertReviewList, parseMergePreview,
  relatedMergeOptions, type AlertReview, type AlertReviewLeaf, type MergeOption, type MergePreview } from "./alert-group-review";

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const awardId = id(90);
function leaf(n = 1, status: "pending" | "approved" = "pending"): AlertReviewLeaf {
  return { id: id(n), contentHash: String(n).repeat(64).slice(0, 64), awardId, awardName: "Example Scholarship", status,
    summary: `The official page changed requirement ${n}.`, sourceUrl: `https://example.edu/apply/${n}`,
    context: "Check the current instructions before submitting.", detectedAt: "2026-11-01T12:00:00Z",
    details: [{ category: "Requirements", summary: `Requirement ${n} changed.`, previous: `Previous ${n}`, current: `Current ${n}` }] };
}
function option(value = leaf(2)): MergeOption {
  return { id: value.id, contentHash: value.contentHash, awardId: value.awardId!, awardName: value.awardName,
    summary: value.summary, detectedAt: value.detectedAt, status: value.status as "pending" | "approved" };
}
function preview(members = [leaf(), leaf(2)]): MergePreview {
  return { groupId: null, expectedHash: null, members, memberRefs: members.map(member => ({ id: member.id, content_hash: member.contentHash })),
    awardName: members[0].awardName, summary: "The application instructions changed on two official pages.",
    context: "Review both sets of instructions before submitting.", publishedMemberIds: members.filter(member => member.status === "approved").map(member => member.id),
    message: "This will create a combined draft for your review." };
}
function group(): AlertReview {
  const members = [leaf(), leaf(2, "approved")];
  return { ...leaf(), id: id(50), contentHash: "a".repeat(64), summary: "Two official source changes.",
    group: { id: id(50), revisionHash: "a".repeat(64), members, publishedMemberIds: [members[1].id] } };
}
describe("bounded browser alert-group contracts", () => {
  it("accepts old single review lists without enabling unsupported merge actions", () => {
    const old = leaf(); delete old.awardId;
    expect(parseAlertReviewList({ alerts: [old] }, "pending")).toEqual({ alerts: [old], mergeOptions: [] });
    expect(relatedMergeOptions(old, [option()])).toEqual([]);
  });
  it.each(["pending", "approved"] as const)("accepts a %s grouped view with the exact outer revision", status => {
    const value = { ...group(), status };
    const before = structuredClone(value);
    expect(isAlertReview(value, status)).toBe(true);
    expect(parseAlertReviewList({ alerts: [value], mergeOptions: [option(leaf(3))] }, status)?.alerts).toEqual([value]);
    expect(value).toEqual(before);
  });
  it.each(["wrong outer id", "wrong hash", "nested group", "foreign award", "duplicate member", "unknown published id", "unapproved published id", "too many members"])(
    "rejects a group with %s", kind => {
      const value = group();
      if (kind === "wrong outer id") value.group!.id = id(51);
      if (kind === "wrong hash") value.group!.revisionHash = "b".repeat(64);
      if (kind === "nested group") Object.assign(value.group!.members[0], { group: value.group });
      if (kind === "foreign award") value.group!.members[0].awardId = id(91);
      if (kind === "duplicate member") value.group!.members[1] = value.group!.members[0];
      if (kind === "unknown published id") value.group!.publishedMemberIds = [id(99)];
      if (kind === "unapproved published id") value.group!.publishedMemberIds = [value.group!.members[0].id];
      if (kind === "too many members") value.group!.members = Array.from({ length: 9 }, (_, index) => leaf(index + 1));
      expect(isAlertReview(value, "pending")).toBe(false);
    });
  it.each(["foreign award", "mismatched member reference", "extra reference", "missing reference", "unpaired group version", "unsafe official link", "nested group"])(
    "rejects a preview with %s before any decision", kind => {
      const value = preview();
      if (kind === "foreign award") value.members[1].awardId = id(91);
      if (kind === "mismatched member reference") value.memberRefs[1].content_hash = "b".repeat(64);
      if (kind === "extra reference") value.memberRefs.push({ id: id(3), content_hash: "3".repeat(64) });
      if (kind === "missing reference") value.memberRefs.pop();
      if (kind === "unpaired group version") value.groupId = id(50);
      if (kind === "unsafe official link") value.members[1].sourceUrl = "javascript:alert(1)";
      if (kind === "nested group") Object.assign(value.members[1], { group: {} });
      expect(parseMergePreview({ ok: true, preview: value })).toBeNull();
    });
  it.each(["pending", "approved"] as const)("binds a pending source to the displayed %s target without changing originals", status => {
    const source = leaf(), target = option(leaf(2, status)), value = preview([source, leaf(2, status)]);
    const before = structuredClone(value);
    expect(parseMergePreview({ ok: true, preview: value })).toEqual(value);
    expect(mergePreviewMatchesSelection(value, source, target)).toBe(true);
    expect(value).toEqual(before);
    value.memberRefs[1].content_hash = "f".repeat(64);
    expect(mergePreviewMatchesSelection(value, source, target)).toBe(false);
  });
  it("supports combining two approved entries as a new draft, without deciding or resending anything", () => {
    const source = leaf(1, "approved"), target = leaf(2, "approved"), value = preview([source, target]);
    expect(mergePreviewMatchesSelection(value, source, option(target))).toBe(true);
    expect(value.groupId).toBeNull(); expect(value.expectedHash).toBeNull();
    expect(value.publishedMemberIds).toEqual([source.id, target.id]);
  });
  it("requires an existing group's current revision and complete member union", () => {
    const source = group(), target = leaf(3), value = preview([...source.group!.members, target]);
    value.groupId = source.id; value.expectedHash = source.contentHash;
    expect(mergePreviewMatchesSelection(value, source, option(target))).toBe(true);
    value.expectedHash = "b".repeat(64);
    expect(mergePreviewMatchesSelection(value, source, option(target))).toBe(false);
    expect(alertMemberRefs(source).map(ref => ref.id)).toEqual(source.group!.members.map(member => member.id));
  });
  it("does not suggest a different award, the source itself or a group sharing one of its originals", () => {
    const source = group(), unrelated = { ...option(leaf(3)), awardId: id(91) };
    expect(relatedMergeOptions(source, [unrelated, option(source), option(source.group!.members[0]), option(leaf(3))]).map(value => value.id)).toEqual([id(3)]);
  });
  it("orders pair-specific suggestions first without labelling other same-award choices as related", () => {
    const first = leaf(), suggested = { ...option(leaf(2)), relatedToIds: [first.id] }, other = { ...option(leaf(3)), relatedToIds: [id(99)] };
    const options = [other, suggested], before = structuredClone(options);
    expect(relatedMergeOptions(first, options).map(value => value.id)).toEqual([suggested.id, other.id]);
    expect(options).toEqual(before);
  });
  it("does not offer a two-existing-group merge through a one-group revision contract", () => {
    const first = group(), target: MergeOption = { ...option(leaf(3)), id: id(51), contentHash: "e".repeat(64), groupId: id(51),
      members: [leaf(3), leaf(4)].map(member => ({ id: member.id, content_hash: member.contentHash })) };
    expect(relatedMergeOptions(first, [target])).toEqual([]);
    expect(relatedMergeOptions(leaf(), [target])).toEqual([target]);
  });
  it("keeps an older published group from offering a merge against its newer pending revision", () => {
    const value = { ...group(), status: "approved" as const, group: { ...group().group!, hasPendingDraft: true } };
    expect(isAlertReview(value, "approved")).toBe(true);
    expect(relatedMergeOptions(value, [option(leaf(3))])).toEqual([]);
    expect(isAlertReview({ ...value, status: "pending" }, "pending")).toBe(false);
    expect(isAlertReview({ ...value, group: { ...value.group, hasPendingDraft: "yes" } }, "approved")).toBe(false);
  });
  it.each(["duplicate option", "oversized list", "invalid reason", "wrong group id", "wrong singleton ref"])("rejects a list with %s", kind => {
    const options = [option()];
    if (kind === "duplicate option") options.push(options[0]);
    if (kind === "oversized list") options.push(...Array(200).fill(options[0]));
    if (kind === "invalid reason") options[0].relatedReason = "x".repeat(301);
    if (kind === "wrong group id") options[0].groupId = id(99);
    if (kind === "wrong singleton ref") options[0].members = [{ id: id(3), content_hash: "3".repeat(64) }];
    expect(parseAlertReviewList({ alerts: [leaf()], mergeOptions: options }, "pending")).toBeNull();
  });
  it("keeps official links safe and does not turn a relative or credential-bearing URL into evidence", () => {
    expect(alertSourceLink("https://example.edu/apply")).toBe("https://example.edu/apply");
    for (const value of ["#apply", "//example.edu", "javascript:alert(1)", "https://user:password@example.edu/"]) expect(alertSourceLink(value)).toBeNull();
  });
  it("rejects array or object statuses instead of coercing them into a supported member state", () => {
    const value = preview(); Object.assign(value.members[1], { status: ["pending"] });
    expect(parseMergePreview({ ok: true, preview: value })).toBeNull();
    expect(parseAlertReviewList({ alerts: [leaf()], mergeOptions: [{ ...option(), status: ["approved"] }] }, "pending")).toBeNull();
  });
  it.each([[id(1), id(1)], ["not-an-id"], Array(201).fill(id(1))])("rejects invalid or oversized pair-specific suggestion identifiers", relatedToIds => {
    expect(parseAlertReviewList({ alerts: [leaf()], mergeOptions: [{ ...option(), relatedToIds }] }, "pending")).toBeNull();
  });
});
