import { describe, expect, it } from "vitest";
import { publicAlertDisplayRows, type PublicAlertGroup, type PublicAlertGroupMember } from "./public-alert-groups";
function rows() {
  const members = ["first", "second"].map(id => ({ id, sourceId: id, sourceTitle: id, sourceUrl: `https://example.edu/${id}`,
    sourcePageType: "application", summary: `${id} change`, changeDetails: {}, detectedAt: "2026-10-31T12:00:00Z" })) as PublicAlertGroupMember[];
  const group: PublicAlertGroup = { id: "group", revisionHash: "a".repeat(64), memberEventIds: members.map(member => member.id), members };
  return members.map(member => ({ ...member, group }));
}
describe("related alert display rows", () => {
  it("renders a complete approved family once while retaining both original IDs and order", () => {
    const input = rows(), before = structuredClone(input), result = publicAlertDisplayRows(input);
    expect(result).toEqual([{ id: "first", members: input, grouped: true }]);
    expect(input).toEqual(before);
  });
  it("keeps a source-scoped or subscriber-filtered member standalone without replaying its siblings", () => {
    const [first] = rows();
    expect(publicAlertDisplayRows([first])).toEqual([{ id: first.id, members: [first], grouped: false }]);
  });
  it("does not collapse members with conflicting published revisions", () => {
    const input = rows();
    input[1] = { ...input[1], group: { ...input[1].group, revisionHash: "b".repeat(64) } };
    expect(publicAlertDisplayRows(input)).toHaveLength(2);
  });
  it("can group only newly pending email members without including an already reserved sibling", () => {
    const input = rows();
    const group = { ...input[0].group, memberEventIds: ["earlier", "first", "second"] };
    const pending = input.map(row => ({ ...row, group }));
    expect(publicAlertDisplayRows(pending)).toHaveLength(2);
    const displayed = publicAlertDisplayRows(pending, { allowPartialGroups: true });
    expect(displayed).toHaveLength(1);
    expect(displayed[0].members.map(row => row.id)).toEqual(["first", "second"]);
  });
});
