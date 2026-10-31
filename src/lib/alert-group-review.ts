// Browser-safe review DTOs and validation. Publication authority stays on the server.
export type AlertReviewStatus = "pending" | "approved" | "dismissed";
export type AlertReviewLeaf = {
  id: string;
  contentHash: string;
  awardId?: string;
  awardName: string;
  summary: string;
  context?: string;
  sourceUrl: string;
  detectedAt: string;
  status: AlertReviewStatus;
  details: Array<{ category: string; summary: string; previous?: string; current?: string }>;
};
export type AlertMemberRef = { id: string; content_hash: string };
export type AlertReview = AlertReviewLeaf & {
  group?: { id: string; revisionHash: string; members: AlertReviewLeaf[]; publishedMemberIds: string[]; hasPendingDraft?: boolean };
};
export type MergeOption = {
  id: string;
  contentHash: string;
  awardId: string;
  awardName: string;
  summary: string;
  detectedAt: string;
  status: "pending" | "approved";
  groupId?: string;
  members?: AlertMemberRef[];
  relatedReason?: string;
  relatedToIds?: string[];
};
export type MergePreview = {
  groupId: string | null;
  expectedHash: string | null;
  members: AlertReviewLeaf[];
  memberRefs: AlertMemberRef[];
  awardName: string;
  summary: string;
  context?: string;
  publishedMemberIds: string[];
  message: string;
};

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const boundedText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const statuses = ["pending", "approved", "dismissed"];
export function alertSourceLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function isLeaf(value: unknown): value is AlertReviewLeaf {
  return object(value) && uuid(value.id) && hash(value.contentHash) && typeof value.status === "string" && statuses.includes(value.status) &&
    (value.awardId === undefined || uuid(value.awardId)) && boundedText(value.awardName, 500) && boundedText(value.summary, 8000) &&
    (value.context === undefined || boundedText(value.context, 600)) && Boolean(alertSourceLink(value.sourceUrl)) && timestamp(value.detectedAt) &&
    Array.isArray(value.details) && value.details.length <= 64 && value.details.every(detail => object(detail) &&
      boundedText(detail.category, 100) && boundedText(detail.summary, 8000) &&
      (detail.previous === undefined || boundedText(detail.previous, 16000)) && (detail.current === undefined || boundedText(detail.current, 16000)));
}
function isMembers(value: unknown): value is AlertReviewLeaf[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= 8 && value.every(member => isLeaf(member) &&
    !Object.hasOwn(member, "group") && uuid(member.awardId) && member.status !== "dismissed") &&
    new Set(value.map(member => member.id)).size === value.length && new Set(value.map(member => member.awardId)).size === 1;
}
function isPublishedIds(value: unknown, members: AlertReviewLeaf[]): value is string[] {
  return Array.isArray(value) && value.length <= members.length && new Set(value).size === value.length &&
    value.every(id => uuid(id) && members.some(member => member.id === id && member.status === "approved"));
}
function isRefs(value: unknown): value is AlertMemberRef[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 8 && value.every(ref => object(ref) &&
    Object.keys(ref).length === 2 && uuid(ref.id) && hash(ref.content_hash)) && new Set(value.map(ref => ref.id)).size === value.length;
}
export function isAlertReview(value: unknown, status: AlertReviewStatus): value is AlertReview {
  if (!isLeaf(value) || value.status !== status) return false;
  const group = (value as AlertReview).group;
  return group === undefined || object(group) && status !== "dismissed" && group.id === value.id && group.revisionHash === value.contentHash &&
    isMembers(group.members) && value.awardId === group.members[0].awardId && isPublishedIds(group.publishedMemberIds, group.members) &&
    (group.hasPendingDraft === undefined || typeof group.hasPendingDraft === "boolean" && (!group.hasPendingDraft || status === "approved"));
}
function isMergeOption(value: unknown): value is MergeOption {
  return object(value) && uuid(value.id) && hash(value.contentHash) && uuid(value.awardId) && boundedText(value.awardName, 500) &&
    boundedText(value.summary, 8000) && timestamp(value.detectedAt) && typeof value.status === "string" && ["pending", "approved"].includes(value.status) &&
    (value.relatedReason === undefined || boundedText(value.relatedReason, 300)) &&
    (value.relatedToIds === undefined || Array.isArray(value.relatedToIds) && value.relatedToIds.length <= 200 &&
      value.relatedToIds.every(uuid) && new Set(value.relatedToIds).size === value.relatedToIds.length) &&
    (value.members === undefined || isRefs(value.members)) && (value.groupId === undefined
      ? value.members === undefined || isRefs(value.members) && value.members.length === 1 && value.members[0].id === value.id && value.members[0].content_hash === value.contentHash
      : uuid(value.groupId) && value.groupId === value.id && isRefs(value.members) && value.members.length >= 2);
}
export function parseAlertReviewList(value: unknown, status: AlertReviewStatus): { alerts: AlertReview[]; mergeOptions: MergeOption[] } | null {
  if (!object(value) || !Array.isArray(value.alerts) || value.alerts.length > 100 || value.alerts.some(alert => !isAlertReview(alert, status)) ||
      new Set(value.alerts.map(alert => alert.id)).size !== value.alerts.length) return null;
  const options = value.mergeOptions ?? [];
  if (!Array.isArray(options) || options.length > 200 || options.some(option => !isMergeOption(option)) ||
      new Set(options.map(option => option.id)).size !== options.length) return null;
  return { alerts: value.alerts as AlertReview[], mergeOptions: options as MergeOption[] };
}
export function parseMergePreview(value: unknown): MergePreview | null {
  if (!object(value) || value.ok !== true || !object(value.preview)) return null;
  const preview = value.preview;
  if (!(preview.groupId === null && preview.expectedHash === null || uuid(preview.groupId) && hash(preview.expectedHash)) ||
      !isMembers(preview.members) || !isRefs(preview.memberRefs) || preview.memberRefs.length !== preview.members.length ||
      !preview.members.every(member => preview.memberRefs instanceof Array && preview.memberRefs.some(ref => ref.id === member.id && ref.content_hash === member.contentHash)) ||
      !boundedText(preview.awardName, 500) || !boundedText(preview.summary, 8000) ||
      (preview.context !== undefined && !boundedText(preview.context, 600)) || !boundedText(preview.message, 1200) ||
      !isPublishedIds(preview.publishedMemberIds, preview.members)) return null;
  return preview as MergePreview;
}
export function alertMemberRefs(alert: AlertReview): AlertMemberRef[] {
  return alert.group ? alert.group.members.map(member => ({ id: member.id, content_hash: member.contentHash })) : [{ id: alert.id, content_hash: alert.contentHash }];
}
export function relatedMergeOptions(source: AlertReview, options: MergeOption[]): MergeOption[] {
  if (source.status === "dismissed" || !source.awardId || source.group?.hasPendingDraft) return [];
  const memberIds = new Set(alertMemberRefs(source).map(ref => ref.id));
  return options.filter(option => option.awardId === source.awardId && option.id !== source.id &&
    !(source.group && option.groupId) && !(option.members || [{ id: option.id }]).some(ref => memberIds.has(ref.id)))
    .sort((left, right) => Number(Boolean(right.relatedToIds?.includes(source.id))) - Number(Boolean(left.relatedToIds?.includes(source.id))));
}
/** The preview must contain exactly the selected originals, at their displayed versions. */
export function mergePreviewMatchesSelection(preview: MergePreview, source: AlertReview, target: MergeOption): boolean {
  if (!source.awardId || preview.members[0].awardId !== source.awardId || source.awardId !== target.awardId ||
      !relatedMergeOptions(source, [target]).length) return false;
  const required = [...alertMemberRefs(source), ...(target.members || [{ id: target.id, content_hash: target.contentHash }])];
  if (new Set(required.map(ref => ref.id)).size !== required.length || required.length !== preview.memberRefs.length ||
      !required.every(ref => preview.memberRefs.some(member => member.id === ref.id && member.content_hash === ref.content_hash))) return false;
  if (source.group && (preview.groupId !== source.group.id || preview.expectedHash !== source.group.revisionHash)) return false;
  if (target.groupId && (preview.groupId !== target.groupId || preview.expectedHash !== target.contentHash)) return false;
  return true;
}
