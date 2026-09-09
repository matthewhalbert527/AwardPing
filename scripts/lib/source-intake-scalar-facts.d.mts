/**
 * One reported issue. Each field is paired with its own reason, so a reason
 * can never be attached to a field it does not name.
 */
export type SourceIntakeScalarFactIssue =
  | { field: "facts"; reason: "invalid_fact_type_facts" }
  | { field: "description"; reason: "invalid_fact_type_description" }
  | { field: "deadline"; reason: "invalid_fact_type_deadline" }
  | { field: "amount"; reason: "invalid_fact_type_amount" }
  | { field: "award_amount"; reason: "invalid_fact_type_award_amount" };

/** The fact fields this checker can report on. */
export type SourceIntakeScalarFactField = SourceIntakeScalarFactIssue["field"];

/** Every reason this checker can return. */
export type SourceIntakeScalarFactIssueReason = SourceIntakeScalarFactIssue["reason"];

/**
 * Reports the first declared-type problem among the scalar fact fields of an
 * ORIGINAL provider result, or null when no checked field has a type issue.
 *
 * Priority is fixed: the facts container, then description, then deadline,
 * then the canonical amount, then the legacy award_amount alias. The alias is
 * reached only when the canonical amount is absent, null or an empty string.
 *
 * No value from the input is returned, and the input is never mutated.
 */
export declare function readSourceIntakeScalarFactIssue(
  review: unknown,
): SourceIntakeScalarFactIssue | null;
