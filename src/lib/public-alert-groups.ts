import type { Json } from "@/lib/database.types";
import type { AwardPageType } from "@/lib/award-discovery-types";

/** Display metadata only. Every member keeps its own event and source evidence. */
export type PublicAlertGroupMember = {
  id: string;
  sourceId: string | null;
  sourceTitle: string;
  sourceUrl: string;
  sourcePageType: AwardPageType | null;
  summary: string;
  changeDetails: Json;
  detectedAt: string;
};
export type PublicAlertGroup = {
  id: string;
  revisionHash: string;
  memberEventIds: string[];
  members: PublicAlertGroupMember[];
};
export type PublicAlertDisplayRow<T> = { id: string; members: T[]; grouped: boolean };

/** A scoped source view collapses a group only when it contains every member. */
export function publicAlertDisplayRows<T extends { id: string; group?: PublicAlertGroup }>(rows: T[], { allowPartialGroups = false }: { allowPartialGroups?: boolean } = {}): PublicAlertDisplayRow<T>[] {
  const byId = new Map(rows.map(row => [row.id, row])), used = new Set<string>();
  const result: PublicAlertDisplayRow<T>[] = [];
  for (const row of rows) {
    if (used.has(row.id)) continue;
    const group = row.group;
    const presentIds = group?.memberEventIds.filter(id => byId.has(id)) || [];
    const complete = group && group.memberEventIds.length >= 2 && group.memberEventIds.length <= 8 &&
      new Set(group.memberEventIds).size === group.memberEventIds.length && group.memberEventIds.includes(row.id) &&
      presentIds.length >= 2 && (allowPartialGroups || presentIds.length === group.memberEventIds.length) &&
      presentIds.every(id => {
        const member = byId.get(id);
        return member?.group?.id === group.id && member.group.revisionHash === group.revisionHash &&
          JSON.stringify(member.group.memberEventIds) === JSON.stringify(group.memberEventIds);
      });
    const members = complete ? rows.filter(member => group.memberEventIds.includes(member.id)) : [row];
    members.forEach(member => used.add(member.id));
    result.push({ id: row.id, members, grouped: Boolean(complete) });
  }
  return result;
}
