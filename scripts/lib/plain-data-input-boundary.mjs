// The shared structural input boundary for pure, offline, review-only
// modules that accept caller-supplied object graphs.
//
// A caller-supplied object is not a value: it is code. Reading `record.field`
// can run a getter, `array.length` can be trapped, JSON.stringify looks up
// toJSON, and a second read can answer differently from the first. Every
// helper here therefore reads through own property descriptors (which never
// invoke an accessor), reads each field exactly once, and rejects anything
// that could answer a structural question with code rather than data.
//
// ACCEPTED INPUT TYPES (exact - everything else fails closed)
//
//   - a plain object: prototype exactly Object.prototype or null. Not a class
//     instance, not an exotic object, not a Proxy.
//   - a plain array: prototype exactly Array.prototype or null, dense, whose
//     own keys are EXACTLY `length` plus the canonical decimal names of
//     0..length-1. Not a subclass, not a Proxy, no symbol keys, no extra
//     names (toJSON, map, sort, ...), no noncanonical index spellings ("01").
//   - a primitive.
//
// Every accessed field or index must be an OWN, ENUMERABLE, DATA property.
// Accessors are rejected rather than invoked; inherited properties are
// invisible; a non-enumerable property is rejected because JSON.stringify
// would silently omit it, so a graph accepted here could otherwise export
// something different from what was validated. An array's `length` is the
// single exemption: it is non-enumerable on every array and JSON never
// serializes it as content, and it is read from its descriptor, never by
// property access.
//
// Proxies - live or revoked - are rejected before any other inspection, with
// util.types.isProxy, which reads an internal slot and reaches no trap. By
// the time a trap has answered once the answer can no longer be trusted.
//
// A rejected value is never executed to describe it: describeValue quotes
// primitives exactly (a primitive cannot carry user code) and collapses
// everything else to a fixed type-only phrase, so no toJSON, toString,
// valueOf, Symbol.toPrimitive or Symbol.toStringTag - own, inherited, or
// trapped - runs on a value that has just been refused.
//
// Nothing ordinary is refused. Object and array literals, spreads, .map
// results, JSON.parse output, Object.freeze'd values and null-prototype
// records all pass, because all of them produce enumerable own data
// properties with exact key sets.
//
// WHAT THIS MODULE DOES NOT DO
//
// It validates SHAPE only. It has no opinion about URLs, identifiers,
// confidence values, allowlists, digests, or which fields a record may
// carry; each consumer keeps those rules, its output construction, and its
// own failure prefix. The factory takes the consumer's `fail` so every
// message keeps the consumer's prefix while the text after the prefix is
// produced here, once, for every consumer - so two consumers cannot drift.
//
// Pure: no env, filesystem, network, clock, randomness, or I/O of any kind.
// node:util's types.isProxy only inspects a value's kind.
import { types as nodeTypes } from "node:util";

// Describes a REJECTED value for an error message without ever executing it.
//
// Classification uses only trap-free operations - `typeof`, a null
// comparison, util.types.isProxy and Array.isArray - and the Proxy check runs
// before any other inspection of an object-like value.
export function describeValue(value) {
  if (value === null) return "null";
  const valueType = typeof value;
  if (valueType === "string") {
    // Safe: JSON.stringify only consults toJSON for Objects, and a primitive
    // string is not one.
    return JSON.stringify(value);
  }
  if (valueType === "number" || valueType === "boolean" || valueType === "undefined" || valueType === "bigint") {
    return String(value);
  }
  if (valueType === "symbol") return "a symbol";
  if (valueType === "function") return "a function";
  // Object-like from here on: never inspected further, never coerced.
  if (nodeTypes.isProxy(value)) return "a Proxy";
  if (Array.isArray(value)) return "an array";
  return "an object";
}

// Builds the boundary for one consumer. `fail(message)` is the consumer's own
// thrower and supplies its prefix; it is expected to throw. If it ever
// returns instead, the boundary still refuses to proceed - a rejection must
// never fall through into acceptance because of a caller's callback.
export function createPlainDataInputBoundary(fail) {
  if (typeof fail !== "function") {
    throw new Error("plain-data input boundary: fail must be a function that throws.");
  }

  function reject(message) {
    fail(message);
    throw new Error(`plain-data input boundary: fail callback returned instead of throwing: ${message}`);
  }

  // Rejects a Proxy before anything else touches the value. Every structural
  // question below - length, own-property descriptors, prototype - is
  // trappable, so a Proxy can report one shape while yielding another.
  function requireNotProxy(value, label) {
    if (value !== null && (typeof value === "object" || typeof value === "function") && nodeTypes.isProxy(value)) {
      reject(`${label} must not be a Proxy; its traps could report a different shape than it yields.`);
    }
    return value;
  }

  function requirePlainObject(value, label) {
    requireNotProxy(value, label);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      reject(`${label} must be an object.`);
    }
    return value;
  }

  function requireArray(value, label) {
    requireNotProxy(value, label);
    if (!Array.isArray(value)) reject(`${label} must be an array.`);
    return value;
  }

  // Rejects anything but a plain record: no accessor can be inherited, because
  // there is nothing to inherit from but Object.prototype (or nothing at all).
  function requirePlainDataRecord(value, label) {
    requirePlainObject(value, label);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      reject(
        `${label} must be a plain object; its prototype is neither Object.prototype nor null, so an inherited accessor could answer for its fields.`,
      );
    }
    return value;
  }

  // Reads one field exactly once, from an own, enumerable DATA descriptor.
  // Returns undefined for an absent field (callers decide whether that is
  // fatal); throws for an accessor, which can never be read safely, and for
  // a hidden field, which JSON would drop while this read kept it.
  function snapshotOwnField(record, key, label) {
    // Proxy-first here too. This is a factory-returned API, so a direct
    // caller could hand it a Proxy whose getOwnPropertyDescriptor trap would
    // otherwise answer for the field, and a revoked one would escape as a raw
    // TypeError outside the consumer's fail. Consumers already validate the
    // record before reading its fields, so their ordering and messages do
    // not change.
    requireNotProxy(record, label);
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined) return undefined;
    if (!("value" in descriptor)) {
      reject(`${label}.${key} must be a plain data property, not an accessor.`);
    }
    // Decided on the descriptor, so the value is still never read to reach it.
    if (!descriptor.enumerable) {
      reject(
        `${label}.${key} must be an enumerable own property; JSON omits a hidden field, so it would be ` +
          `hashed here and missing from any export of the same graph.`,
      );
    }
    return descriptor.value;
  }

  // Snapshots an array element-by-element through own data descriptors into
  // a fresh array. The check order is fixed and pinned by tests: Proxy,
  // array-ness, prototype, length descriptor, symbol keys, exact own-key set,
  // then per index: hole, accessor, enumerability.
  function snapshotDenseArray(value, label) {
    const array = requireArray(value, label);
    const prototype = Object.getPrototypeOf(array);
    if (prototype !== Array.prototype && prototype !== null) {
      reject(`${label} must be a plain array; its prototype is neither Array.prototype nor null.`);
    }

    // length is taken from its descriptor rather than by property access, so
    // nothing on the array can answer for it.
    const lengthDescriptor = Object.getOwnPropertyDescriptor(array, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !Number.isInteger(lengthDescriptor.value)) {
      reject(`${label} must have a plain integer length.`);
    }
    const length = lengthDescriptor.value;

    // Validating only the indexed slots is not enough. An own toJSON, map,
    // sort or Symbol.iterator - or a stray "01" - is read by nothing below, so
    // the array would be accepted unchanged, yet it travels with the graph: a
    // later JSON.stringify or iteration of that same array does something the
    // validated shape never showed. So the own key set must be exactly
    // `length` plus the canonical decimal names of 0..length-1. Only key NAMES
    // are read here; no value and no accessor is touched.
    if (Object.getOwnPropertySymbols(array).length > 0) {
      reject(`${label} must not carry symbol-keyed own properties; only its length and canonical indices may be own.`);
    }
    const allowedKeys = length === 0 ? "its length" : `its length and the canonical indices 0..${length - 1}`;
    for (const key of Object.getOwnPropertyNames(array)) {
      if (key === "length") continue;
      const index = Number(key);
      // String(index) round-trips only for the canonical spelling, so "01",
      // "1.0", "+1", " 1", "-0" and "1e0" are rejected as names.
      if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
        reject(
          `${label} carries an unexpected own property ${JSON.stringify(key)}; a dense array may own only ` +
            `${allowedKeys}, so nothing extra can ride along unhashed.`,
        );
      }
    }

    const elements = [];
    for (let index = 0; index < length; index += 1) {
      // A hole resolves through the prototype chain, so an inherited numeric
      // index would invisibly supply an element the caller never wrote.
      if (!Object.hasOwn(array, index)) {
        reject(`${label}[${index}] is a hole; ${label} must be a dense array with no inherited or missing indices.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(array, index);
      if (!("value" in descriptor)) {
        reject(`${label}[${index}] must be a plain data property, not an accessor.`);
      }
      // JSON serializes an index regardless of enumerability, so this check
      // is uniformity rather than export safety: one rule covers every own
      // property this boundary accepts, with `length` the sole exemption.
      if (!descriptor.enumerable) {
        reject(`${label}[${index}] must be an enumerable own property; a dense array's indices are all enumerable.`);
      }
      elements.push(descriptor.value);
    }
    return elements;
  }

  // Snapshots a dense array of non-empty strings into a fresh array of
  // primitives, which is inert by construction. Written as a loop rather
  // than a .map so that no Array.prototype method runs while a boundary is
  // being crossed - a consumer's digest path relies on that.
  function snapshotStringArray(value, label) {
    const elements = snapshotDenseArray(value, label);
    const strings = [];
    for (let index = 0; index < elements.length; index += 1) {
      strings.push(requireNonEmptyString(elements[index], `${label}[${index}]`));
    }
    return strings;
  }

  function requireNonEmptyString(value, label) {
    if (typeof value !== "string" || value.trim().length === 0) {
      reject(`${label} must be a non-empty string; got ${describeValue(value)}.`);
    }
    return value;
  }

  return Object.freeze({
    requireNotProxy,
    requirePlainObject,
    requireArray,
    requirePlainDataRecord,
    snapshotOwnField,
    snapshotDenseArray,
    snapshotStringArray,
    requireNonEmptyString,
  });
}
