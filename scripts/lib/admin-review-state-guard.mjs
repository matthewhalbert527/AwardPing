const guardedAdminReviewColumns = [
  "admin_reviewed_at",
  "admin_review_note",
  "admin_reviewed_by",
];

/**
 * Adds a compare-and-swap guard for an automated source mutation. A later
 * operator decision keeps the row open because at least one guarded value no
 * longer matches the state used to make the automated decision.
 */
export function guardAdminReviewMutation(query, source, { requiredStatus = "open" } = {}) {
  let guarded = query.eq("admin_review_status", requiredStatus);
  for (const column of guardedAdminReviewColumns) {
    const value = source?.[column];
    guarded = value === null || value === undefined
      ? guarded.is(column, null)
      : guarded.eq(column, value);
  }
  return guarded;
}
