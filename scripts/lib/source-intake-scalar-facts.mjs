/**
 * Reports one declared-type problem in the scalar fact fields of an original
 * source-intake provider result.
 *
 * These fields are declared as text. When the model returns some other type
 * the existing normalizer stringifies it, so an object becomes the literal
 * "[object Object]", an array of dates becomes one comma-joined string, and a
 * number becomes an amount with no unit. Reporting the wrong type lets the
 * review be held for a person, instead of silently dropping the value or
 * silently keeping the coerced text.
 *
 * The input is the ORIGINAL provider result. The `raw` property of an already
 * normalized result is not consulted, and neither is any issue flag the model
 * supplied about its own output: a model asserting that its output is fine is
 * not evidence that it is.
 *
 * This reports the declared TYPE only. It parses no date, currency or unit,
 * judges no value as right or wrong, and returns nothing from the input. A
 * literal "null" string and a unitless numeric string are ordinary strings
 * here and are deliberately out of scope.
 *
 * Pure and self-contained: no imports, no I/O, no network, no hashing, no
 * callbacks, and no mutation of the input.
 */

/** A JSON fact record must be an object, not null or an array. */
function isObjectRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks only explicitly present fields from the original JSON result.
 */
function ownProperty(container, key) {
  return Object.prototype.hasOwnProperty.call(container, key) ? container[key] : undefined;
}

/** The scalar fact fields are declared as text; absent and null are allowed. */
function isDeclaredText(value) {
  return value === undefined || value === null || typeof value === "string";
}

/** A fresh result each call, so no caller can corrupt a shared object. */
function issue(field) {
  return { field, reason: `invalid_fact_type_${field}` };
}

/**
 * @param {unknown} review the original provider result, exactly as returned
 * @returns {{ field: string, reason: string } | null} the first issue, or null
 */
export function readSourceIntakeScalarFactIssue(review) {
  if (!isObjectRecord(review)) return null;

  // A review that carries no facts container states no scalar facts, which is
  // not a type error. Anything else present in that position is one.
  const facts = ownProperty(review, "facts");
  if (facts === undefined || facts === null) return null;
  if (!isObjectRecord(facts)) return issue("facts");

  if (!isDeclaredText(ownProperty(facts, "description"))) return issue("description");
  if (!isDeclaredText(ownProperty(facts, "deadline"))) return issue("deadline");

  // The canonical amount is type-checked before its truthiness is read, so a
  // wrong type that happens to be falsy, such as 0 or false, is still
  // reported rather than mistaken for an absent amount.
  const amount = ownProperty(facts, "amount");
  if (!isDeclaredText(amount)) return issue("amount");
  // Precedence follows the existing normalizer: any truthy amount string wins
  // outright and the legacy alias is never consulted, so the alias type cannot
  // matter. A whitespace-only amount is truthy and still wins. That quirk is
  // preserved here on purpose and is not corrected by this module.
  if (amount) return null;

  if (!isDeclaredText(ownProperty(facts, "award_amount"))) return issue("award_amount");
  return null;
}
