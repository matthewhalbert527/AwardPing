import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createPlainDataInputBoundary, describeValue } from "./plain-data-input-boundary.mjs";

const PREFIX = "boundary under test";
function failUnderTest(message) {
  throw new Error(`${PREFIX}: ${message}`);
}
const boundary = createPlainDataInputBoundary(failUnderTest);

// A Proxy that records EVERY trap by name, so "zero traps" is a measurement.
function countingProxy(target, calls) {
  return new Proxy(
    target,
    new Proxy(
      {},
      {
        get:
          (_handler, trap) =>
          (...args) => {
            calls.push(`trap:${String(trap)}`);
            return Reflect[trap](...args);
          },
      },
    ),
  );
}

// An object whose coercion hooks are accessors, so merely LOOKING for one is
// observable, not just calling it.
function accessorCountingObject(calls) {
  const object = {};
  for (const key of ["toJSON", "toString", "valueOf"]) {
    Object.defineProperty(object, key, {
      get() {
        calls.push(key);
        return () => `<${key}>`;
      },
      configurable: true,
    });
  }
  Object.defineProperty(object, Symbol.toPrimitive, {
    get() {
      calls.push("Symbol.toPrimitive");
      return () => "<toPrimitive>";
    },
    configurable: true,
  });
  Object.defineProperty(object, Symbol.toStringTag, {
    get() {
      calls.push("Symbol.toStringTag");
      return "Tagged";
    },
    configurable: true,
  });
  return object;
}

const messageOf = (run) => {
  try {
    run();
  } catch (error) {
    return error.message;
  }
  throw new Error("expected a rejection");
};

describe("describeValue never executes what it describes", () => {
  it("quotes primitives exactly and collapses everything else to a type-only phrase", () => {
    expect(describeValue(null)).toBe("null");
    expect(describeValue(undefined)).toBe("undefined");
    expect(describeValue("Mitchell")).toBe('"Mitchell"');
    expect(describeValue("")).toBe('""');
    expect(describeValue(42)).toBe("42");
    expect(describeValue(Number.NaN)).toBe("NaN");
    expect(describeValue(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(describeValue(true)).toBe("true");
    expect(describeValue(10n)).toBe("10");
    expect(describeValue(Symbol("s"))).toBe("a symbol");
    expect(describeValue(() => {})).toBe("a function");
    expect(describeValue({})).toBe("an object");
    expect(describeValue([])).toBe("an array");
    expect(describeValue(new Proxy({}, {}))).toBe("a Proxy");
    expect(describeValue(new Proxy([], {}))).toBe("a Proxy");
    expect(describeValue(Object.create(null))).toBe("an object");
  });

  it("reaches no Proxy trap and no coercion accessor", () => {
    const traps = [];
    expect(describeValue(countingProxy({}, traps))).toBe("a Proxy");
    expect(describeValue(countingProxy([], traps))).toBe("a Proxy");
    expect(traps).toEqual([]);

    const accessors = [];
    expect(describeValue(accessorCountingObject(accessors))).toBe("an object");
    expect(accessors).toEqual([]);

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(describeValue(proxy)).toBe("a Proxy");
  });
});

describe("the factory", () => {
  it("requires a fail function and keeps the consumer's prefix", () => {
    expect(() => createPlainDataInputBoundary(undefined)).toThrow(/plain-data input boundary: fail must be a function that throws/);
    expect(() => createPlainDataInputBoundary("fail")).toThrow(/fail must be a function/);
    expect(messageOf(() => boundary.requireArray("x", "seeds"))).toBe(`${PREFIX}: seeds must be an array.`);
    expect(Object.isFrozen(boundary)).toBe(true);
    expect(Object.keys(boundary).sort()).toEqual([
      "requireArray",
      "requireNonEmptyString",
      "requireNotProxy",
      "requirePlainDataRecord",
      "requirePlainObject",
      "snapshotDenseArray",
      "snapshotOwnField",
      "snapshotStringArray",
    ]);
  });

  it("never proceeds past a rejection even if the consumer's fail returns", () => {
    const returned = [];
    const lenient = createPlainDataInputBoundary((message) => {
      returned.push(message);
    });
    expect(() => lenient.requireArray("not an array", "seeds")).toThrow(
      /plain-data input boundary: fail callback returned instead of throwing: seeds must be an array\./,
    );
    expect(() => lenient.snapshotDenseArray(new Proxy([], {}), "seeds")).toThrow(/fail callback returned instead of throwing/);
    expect(returned).toEqual(["seeds must be an array.", "seeds must not be a Proxy; its traps could report a different shape than it yields."]);
  });

  it("produces identical text after the prefix for two consumers", () => {
    const other = createPlainDataInputBoundary((message) => {
      throw new Error(`other consumer: ${message}`);
    });
    const strip = (message, prefix) => message.slice(`${prefix}: `.length);
    const probes = [
      (b) => b.requireNotProxy(new Proxy({}, {}), "L"),
      (b) => b.requirePlainObject([], "L"),
      (b) => b.requireArray({}, "L"),
      (b) => b.requirePlainDataRecord(new Date(0), "L"),
      (b) => b.requirePlainDataRecord(Object.setPrototypeOf(new Boolean(false), Object.prototype), "L"),
      (b) => b.snapshotOwnField(new Proxy({ k: 1 }, {}), "k", "L"),
      (b) => b.snapshotOwnField(Object.defineProperty({}, "k", { get: () => 1, enumerable: true, configurable: true }), "k", "L"),
      (b) => b.snapshotOwnField(Object.defineProperty({}, "k", { value: 1, enumerable: false, configurable: true }), "k", "L"),
      (b) => b.snapshotDenseArray(Object.assign([1], { smuggled: 1 }), "L"),
      (b) => b.snapshotDenseArray(Object.assign([1], { [Symbol("s")]: 1 }), "L"),
      (b) => b.snapshotDenseArray([, 1], "L"),
      (b) => b.snapshotStringArray([""], "L"),
      (b) => b.requireNonEmptyString(7, "L"),
    ];
    for (const probe of probes) {
      expect(strip(messageOf(() => probe(boundary)), PREFIX)).toBe(strip(messageOf(() => probe(other)), "other consumer"));
    }
  });
});

describe("requireNotProxy / requirePlainObject / requireArray / requirePlainDataRecord", () => {
  it("rejects live and revoked Proxies of objects, arrays and functions before any other inspection", () => {
    const traps = [];
    for (const target of [{}, [], () => {}]) {
      const live = countingProxy(target, traps);
      expect(() => boundary.requireNotProxy(live, "L")).toThrow(/L must not be a Proxy/);
      expect(() => boundary.snapshotOwnField(live, "k", "L")).toThrow(/L must not be a Proxy/);
      expect(() => boundary.snapshotDenseArray(live, "L")).toThrow(/L must not be a Proxy/);
      const { proxy, revoke } = Proxy.revocable(target, {});
      revoke();
      expect(() => boundary.requireNotProxy(proxy, "L")).toThrow(/L must not be a Proxy/);
      expect(() => boundary.requirePlainObject(proxy, "L")).toThrow(/L must not be a Proxy/);
      expect(() => boundary.requireArray(proxy, "L")).toThrow(/L must not be a Proxy/);
      expect(() => boundary.requirePlainDataRecord(proxy, "L")).toThrow(/L must not be a Proxy/);
      expect(() => boundary.snapshotOwnField(proxy, "k", "L")).toThrow(/L must not be a Proxy/);
      expect(() => boundary.snapshotDenseArray(proxy, "L")).toThrow(/L must not be a Proxy/);
      expect(() => boundary.snapshotStringArray(proxy, "L")).toThrow(/L must not be a Proxy/);
    }
    expect(traps).toEqual([]);
    // Non-Proxies pass through untouched, primitives included.
    for (const value of [null, undefined, 0, "", false, Symbol("s"), {}, [], () => {}]) {
      expect(boundary.requireNotProxy(value, "L")).toBe(value);
    }
  });

  it("accepts only plain records and plain arrays", () => {
    class Record {}
    const inherited = Object.create({ inheritedMarker: true });
    for (const [value, pattern] of [
      [null, /L must be an object\./],
      [undefined, /L must be an object\./],
      ["record", /L must be an object\./],
      [[], /L must be an object\./],
      [new Record(), /L must be a plain object; its prototype is neither Object\.prototype nor null/],
      [inherited, /prototype is neither Object\.prototype nor null/],
      [new Date(0), /prototype is neither Object\.prototype nor null/],
      [new Map(), /prototype is neither Object\.prototype nor null/],
    ]) {
      expect(() => boundary.requirePlainDataRecord(value, "L")).toThrow(pattern);
    }
    const plain = { a: 1 };
    const nullProto = Object.assign(Object.create(null), { a: 1 });
    expect(boundary.requirePlainDataRecord(plain, "L")).toBe(plain);
    expect(boundary.requirePlainDataRecord(nullProto, "L")).toBe(nullProto);
    expect(boundary.requirePlainDataRecord(Object.freeze({ a: 1 }), "L")).toEqual({ a: 1 });
    expect(boundary.requirePlainDataRecord(JSON.parse('{"a":1}'), "L")).toEqual({ a: 1 });

    for (const value of [null, {}, "x", 1, new Set()]) {
      expect(() => boundary.requireArray(value, "L")).toThrow(/L must be an array\./);
    }
    expect(boundary.requireArray([1], "L")).toEqual([1]);
  });
});

describe("snapshotOwnField", () => {
  it("returns undefined for an absent field and the value for an own enumerable data field", () => {
    expect(boundary.snapshotOwnField({}, "k", "L")).toBeUndefined();
    expect(boundary.snapshotOwnField({ k: 0 }, "k", "L")).toBe(0);
    expect(boundary.snapshotOwnField(Object.freeze({ k: "v" }), "k", "L")).toBe("v");
    expect(boundary.snapshotOwnField(Object.assign(Object.create(null), { k: "v" }), "k", "L")).toBe("v");
    // Inherited is invisible, never trusted.
    const inherited = Object.create({ k: "from the prototype" });
    expect(boundary.snapshotOwnField(inherited, "k", "L")).toBeUndefined();
  });

  it("refuses a live or revoked Proxy record before reading any descriptor", () => {
    // snapshotOwnField is a factory-returned API in its own right, so it
    // cannot rely on a consumer having validated the record first. A live
    // Proxy must never get to answer through its getOwnPropertyDescriptor
    // trap, and a revoked one must be refused as a Proxy rather than escape
    // as a raw TypeError outside the consumer's fail.
    const traps = [];
    const proxyMessage = `${PREFIX}: L must not be a Proxy; its traps could report a different shape than it yields.`;
    const targets = [
      ["object", { k: "v" }],
      ["array", ["v"]],
      ["function", Object.assign(() => {}, { k: "v" })],
    ];
    for (const [kind, target] of targets) {
      expect(messageOf(() => boundary.snapshotOwnField(countingProxy(target, traps), "k", "L")), `live ${kind}`).toBe(proxyMessage);

      const { proxy, revoke } = Proxy.revocable(target, {
        getOwnPropertyDescriptor(object, property) {
          traps.push(`trap:getOwnPropertyDescriptor:${String(property)}`);
          return Reflect.getOwnPropertyDescriptor(object, property);
        },
      });
      revoke();
      let caught;
      try {
        boundary.snapshotOwnField(proxy, "k", "L");
      } catch (error) {
        caught = error;
      }
      expect(caught, `revoked ${kind}`).toBeInstanceOf(Error);
      expect(caught, `revoked ${kind}`).not.toBeInstanceOf(TypeError);
      expect(caught.message, `revoked ${kind}`).toBe(proxyMessage);
    }
    expect(traps).toEqual([]);

    // Still refused, and still never read, when the consumer's fail returns.
    const lenient = createPlainDataInputBoundary(() => {});
    expect(() => lenient.snapshotOwnField(countingProxy({ k: "v" }, traps), "k", "L")).toThrow(
      /plain-data input boundary: fail callback returned instead of throwing: L must not be a Proxy/,
    );
    const { proxy: revokedAgain, revoke: revokeAgain } = Proxy.revocable({ k: "v" }, {});
    revokeAgain();
    expect(() => lenient.snapshotOwnField(revokedAgain, "k", "L")).toThrow(
      /plain-data input boundary: fail callback returned instead of throwing: L must not be a Proxy/,
    );
    expect(traps).toEqual([]);
  });

  it("rejects accessors and hidden fields without invoking anything", () => {
    const calls = [];
    const withGetter = Object.defineProperty({}, "k", {
      get() {
        calls.push("get");
        return "v";
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => boundary.snapshotOwnField(withGetter, "k", "L")).toThrow(/L\.k must be a plain data property, not an accessor\./);

    const hostile = accessorCountingObject(calls);
    const hidden = Object.defineProperty({}, "k", { value: hostile, enumerable: false, configurable: true, writable: true });
    expect(() => boundary.snapshotOwnField(hidden, "k", "L")).toThrow(
      /L\.k must be an enumerable own property; JSON omits a hidden field, so it would be hashed here and missing from any export of the same graph\./,
    );
    expect(calls).toEqual([]);
  });
});

describe("snapshotDenseArray", () => {
  const hooks = () => [];

  it("accepts every ordinary array shape and returns a fresh array", () => {
    const literal = [1, "two", { three: 3 }];
    const out = boundary.snapshotDenseArray(literal, "L");
    expect(out).toEqual(literal);
    expect(out).not.toBe(literal);
    out.push("added");
    expect(literal).toHaveLength(3);

    expect(boundary.snapshotDenseArray([], "L")).toEqual([]);
    expect(boundary.snapshotDenseArray(Object.freeze([1, 2]), "L")).toEqual([1, 2]);
    expect(boundary.snapshotDenseArray(JSON.parse("[1,2]"), "L")).toEqual([1, 2]);
    expect(boundary.snapshotDenseArray([1, 2].map((n) => n * 2), "L")).toEqual([2, 4]);
    expect(boundary.snapshotDenseArray([...[1, 2]], "L")).toEqual([1, 2]);
    const nullProto = [1, 2];
    Object.setPrototypeOf(nullProto, null);
    expect(boundary.snapshotDenseArray(nullProto, "L")).toEqual([1, 2]);
  });

  it("rejects non-arrays, Proxies and subclasses before reading any element", () => {
    const calls = hooks();
    class Hooked extends Array {
      map() {
        calls.push("map");
        return [];
      }
      sort() {
        calls.push("sort");
        return this;
      }
      [Symbol.iterator]() {
        calls.push("iterator");
        return Array.prototype[Symbol.iterator].call(this);
      }
    }
    expect(() => boundary.snapshotDenseArray({ length: 1, 0: "x" }, "L")).toThrow(/L must be an array\./);
    expect(() => boundary.snapshotDenseArray(countingProxy([1], calls), "L")).toThrow(/L must not be a Proxy/);
    expect(() => boundary.snapshotDenseArray(Hooked.from([1, 2]), "L")).toThrow(
      /L must be a plain array; its prototype is neither Array\.prototype nor null\./,
    );
    expect(calls).toEqual([]);
  });

  it("requires the own key set to be exactly length plus canonical indices", () => {
    const calls = hooks();
    const cases = [
      ["an extra own name", (a) => Object.assign(a, { smuggled: "x" }), /L carries an unexpected own property "smuggled"; a dense array may own only its length and the canonical indices 0\.\.1, so nothing extra can ride along unhashed\./],
      ["an own toJSON", (a) => Object.defineProperty(a, "toJSON", { value: () => { calls.push("toJSON"); return []; }, configurable: true, writable: true }), /unexpected own property "toJSON"/],
      ["an own map", (a) => Object.defineProperty(a, "map", { value: () => { calls.push("map"); return []; }, configurable: true, writable: true }), /unexpected own property "map"/],
      ["an own sort", (a) => Object.defineProperty(a, "sort", { value: () => { calls.push("sort"); return []; }, configurable: true, writable: true }), /unexpected own property "sort"/],
      ["an own Symbol.iterator", (a) => Object.defineProperty(a, Symbol.iterator, { value: function* iterate() { calls.push("iterator"); }, configurable: true, writable: true }), /L must not carry symbol-keyed own properties; only its length and canonical indices may be own\./],
      ["a symbol key", (a) => Object.assign(a, { [Symbol("hidden")]: "x" }), /must not carry symbol-keyed own properties/],
      ["an extra accessor", (a) => Object.defineProperty(a, "shadow", { get() { calls.push("shadow"); return "x"; }, configurable: true }), /unexpected own property "shadow"/],
      ['"01"', (a) => Object.assign(a, { "01": "x" }), /unexpected own property "01"/],
      ['"1.0"', (a) => Object.assign(a, { "1.0": "x" }), /unexpected own property "1\.0"/],
      ['"+1"', (a) => Object.assign(a, { "+1": "x" }), /unexpected own property "\+1"/],
      ['" 1"', (a) => Object.assign(a, { " 1": "x" }), /unexpected own property " 1"/],
      ['"-0"', (a) => Object.assign(a, { "-0": "x" }), /unexpected own property "-0"/],
      ['"1e0"', (a) => Object.assign(a, { "1e0": "x" }), /unexpected own property "1e0"/],
      ['""', (a) => Object.assign(a, { "": "x" }), /unexpected own property ""/],
    ];
    for (const [label, install, pattern] of cases) {
      const array = install(["a", "b"]);
      expect(() => boundary.snapshotDenseArray(array, "L"), label).toThrow(pattern);
    }
    expect(calls).toEqual([]);
    // An empty array's allowance is phrased for its own case.
    expect(() => boundary.snapshotDenseArray(Object.assign([], { smuggled: "x" }), "L")).toThrow(
      /a dense array may own only its length, so nothing extra/,
    );
  });

  it("rejects holes, indexed accessors and hidden indices, in that order", () => {
    const calls = hooks();
    const holed = ["a", "b"];
    delete holed[0];
    expect(() => boundary.snapshotDenseArray(holed, "L")).toThrow(/L\[0\] is a hole; L must be a dense array with no inherited or missing indices\./);

    // An index beyond length extends length, so it is reported as the holes
    // it leaves behind - still fail-closed, on the first missing index.
    const beyond = ["a"];
    Object.defineProperty(beyond, "3", { value: "x", enumerable: true, configurable: true, writable: true });
    expect(() => boundary.snapshotDenseArray(beyond, "L")).toThrow(/L\[1\] is a hole/);

    // A polluted Array.prototype cannot fill a hole.
    const sparse = ["a"];
    sparse.length = 2;
    Object.defineProperty(Array.prototype, 1, { value: "injected", configurable: true, writable: true });
    try {
      expect(sparse[1]).toBe("injected");
      expect(() => boundary.snapshotDenseArray(sparse, "L")).toThrow(/L\[1\] is a hole/);
    } finally {
      delete Array.prototype[1];
    }
    expect(Object.hasOwn(Array.prototype, 1)).toBe(false);

    const accessor = ["a"];
    Object.defineProperty(accessor, 0, {
      get() {
        calls.push("index0");
        return "x";
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => boundary.snapshotDenseArray(accessor, "L")).toThrow(/L\[0\] must be a plain data property, not an accessor\./);

    const hidden = ["a"];
    Object.defineProperty(hidden, 0, { value: accessorCountingObject(calls), enumerable: false, configurable: true, writable: true });
    expect(() => boundary.snapshotDenseArray(hidden, "L")).toThrow(
      /L\[0\] must be an enumerable own property; a dense array's indices are all enumerable\./,
    );
    expect(calls).toEqual([]);
  });

  it("pins the check order on multi-defect inputs", () => {
    // Accessor at index 0 with length pinned to 1: the own-key set is exact,
    // so the accessor is what is reported.
    const accessorThenLength = [];
    Object.defineProperty(accessorThenLength, 0, { get: () => "x", enumerable: true, configurable: true });
    Object.defineProperty(accessorThenLength, "length", { value: 1, writable: true });
    expect(messageOf(() => boundary.snapshotDenseArray(accessorThenLength, "L"))).toMatch(/L\[0\] must be a plain data property, not an accessor/);

    // Symbol keys are reported before extra names.
    const both = Object.assign(["a"], { smuggled: 1, [Symbol("s")]: 1 });
    expect(messageOf(() => boundary.snapshotDenseArray(both, "L"))).toMatch(/must not carry symbol-keyed own properties/);

    // Extra names are reported before holes.
    const extraAndHole = Object.assign(["a", "b"], { smuggled: 1 });
    delete extraAndHole[0];
    expect(messageOf(() => boundary.snapshotDenseArray(extraAndHole, "L"))).toMatch(/unexpected own property "smuggled"/);

    // A lying-length Proxy is a Proxy first.
    const lying = new Proxy(["a", "b"], { get: (t, p, r) => (p === "length" ? 1 : Reflect.get(t, p, r)) });
    expect(messageOf(() => boundary.snapshotDenseArray(lying, "L"))).toMatch(/L must not be a Proxy/);
  });

  it("runs no Array.prototype method on the way through", () => {
    const input = ["a", "b", "c"];
    const map = vi.spyOn(Array.prototype, "map");
    const sort = vi.spyOn(Array.prototype, "sort");
    const forEach = vi.spyOn(Array.prototype, "forEach");
    try {
      expect(boundary.snapshotDenseArray(input, "L")).toEqual(input);
      expect(boundary.snapshotStringArray(input, "L")).toEqual(input);
      expect(map.mock.calls.length).toBe(0);
      expect(sort.mock.calls.length).toBe(0);
      expect(forEach.mock.calls.length).toBe(0);
    } finally {
      map.mockRestore();
      sort.mockRestore();
      forEach.mockRestore();
    }
  });
});

describe("snapshotStringArray and requireNonEmptyString", () => {
  it("labels each element and describes a rejected element inertly", () => {
    expect(boundary.snapshotStringArray(["a", " b "], "L")).toEqual(["a", " b "]);
    expect(() => boundary.snapshotStringArray(["a", ""], "L")).toThrow(/L\[1\] must be a non-empty string; got ""\./);
    expect(() => boundary.snapshotStringArray(["a", "   "], "L")).toThrow(/L\[1\] must be a non-empty string; got "   "\./);
    expect(() => boundary.snapshotStringArray(["a", 7], "L")).toThrow(/L\[1\] must be a non-empty string; got 7\./);
    const calls = [];
    expect(() => boundary.snapshotStringArray([accessorCountingObject(calls)], "L")).toThrow(/L\[0\] must be a non-empty string; got an object\./);
    expect(() => boundary.snapshotStringArray([countingProxy({}, calls)], "L")).toThrow(/L\[0\] must be a non-empty string; got a Proxy\./);
    expect(calls).toEqual([]);
  });

  it("rejects every non-string and every blank string", () => {
    for (const [value, described] of [
      [undefined, "undefined"],
      [null, "null"],
      [0, "0"],
      [false, "false"],
      ["", '""'],
      [" \t\n", '" \\t\\n"'],
      [{}, "an object"],
      [[], "an array"],
      [() => {}, "a function"],
      [Symbol("s"), "a symbol"],
    ]) {
      expect(messageOf(() => boundary.requireNonEmptyString(value, "L"))).toBe(`${PREFIX}: L must be a non-empty string; got ${described}.`);
    }
    expect(boundary.requireNonEmptyString("ok", "L")).toBe("ok");
  });
});

describe("the module itself", () => {
  it("imports nothing but node:util and touches no I/O, clock, or randomness", () => {
    const source = readFileSync(resolve(import.meta.dirname, "plain-data-input-boundary.mjs"), "utf8");
    expect(source).toContain("export function createPlainDataInputBoundary");
    expect(source).toContain("export function describeValue");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(imports).toEqual(["node:util"]);
    expect(source).not.toMatch(/\bprocess\.env\b/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bnew Date\s*\(/);
    expect(source).not.toMatch(/\bMath\.random\s*\(/);
    expect(source).not.toMatch(/\bsetTimeout\s*\(/);
    expect(source).not.toMatch(/createHash/);
  });
});

// ---------------------------------------------------------------------------
// Boxed primitives: a prototype check cannot see an internal slot.
// ---------------------------------------------------------------------------
describe("requirePlainDataRecord refuses boxed primitives, laundered or not", () => {
  const WRAPPERS = [
    ["Boolean", () => new Boolean(false)],
    ["Number", () => new Number(0)],
    ["empty String", () => new String("")],
    ["indexed String", () => new String("ab")],
    ["BigInt", () => Object(1n)],
    ["Symbol", () => Object(Symbol("s"))],
  ];
  const BOXED =
    /^boundary under test: L must be a plain object, not a boxed primitive; a Boolean, Number, String, BigInt or Symbol wrapper keeps its primitive in an internal slot, which JSON\.stringify may serialize in place of its fields or refuse outright\.$/;
  // Own coercion hooks and a real field accessor, all as ACCESSORS, so merely
  // looking for one is observable. The slot must be decided before any of
  // them is consulted.
  const withHooks = (object, calls) => {
    for (const key of ["toJSON", "toString", "valueOf"]) {
      Object.defineProperty(object, key, {
        get() {
          calls.push(key);
          return () => "<x>";
        },
        configurable: true,
      });
    }
    Object.defineProperty(object, Symbol.toPrimitive, {
      get() {
        calls.push("Symbol.toPrimitive");
        return () => "<x>";
      },
      configurable: true,
    });
    Object.defineProperty(object, Symbol.toStringTag, {
      get() {
        calls.push("Symbol.toStringTag");
        return "Plain";
      },
      configurable: true,
    });
    Object.defineProperty(object, "field", {
      get() {
        calls.push("field");
        return "v";
      },
      enumerable: true,
      configurable: true,
    });
    return object;
  };

  it("rejects every wrapper kind on both allowed prototypes, reading nothing", () => {
    const calls = [];
    let checked = 0;
    for (const [kind, make] of WRAPPERS) {
      for (const proto of [Object.prototype, null]) {
        const laundered = withHooks(Object.setPrototypeOf(make(), proto), calls);
        const where = `${kind} on ${proto === null ? "null" : "Object.prototype"}`;
        expect(messageOf(() => boundary.requirePlainDataRecord(laundered, "L")), where).toMatch(BOXED);
        checked += 1;
      }
    }
    expect(checked).toBe(12);
    expect(calls).toEqual([]);
  });

  it("keeps the prototype diagnostic for an unlaundered wrapper and names the slot only once the prototype is allowed", () => {
    for (const [kind, make] of WRAPPERS) {
      expect(messageOf(() => boundary.requirePlainDataRecord(make(), "L")), kind).toMatch(
        /^boundary under test: L must be a plain object; its prototype is neither Object\.prototype nor null/,
      );
    }
    // An indexed String wrapper also owns intrinsic "0", "1" and length keys.
    // The slot is reported, so no consumer key check is reached to describe
    // those keys instead.
    const indexed = Object.setPrototypeOf(new String("ab"), Object.prototype);
    expect(Object.getOwnPropertyNames(indexed)).toEqual(["0", "1", "length"]);
    expect(messageOf(() => boundary.requirePlainDataRecord(indexed, "L"))).toMatch(BOXED);
    const empty = Object.setPrototypeOf(new String(""), null);
    expect(Object.getOwnPropertyNames(empty)).toEqual(["length"]);
    expect(messageOf(() => boundary.requirePlainDataRecord(empty, "L"))).toMatch(BOXED);
  });

  it("still refuses a Proxy around a wrapper as a Proxy, live or revoked, with no trap", () => {
    const traps = [];
    const laundered = () => Object.setPrototypeOf(new Boolean(false), Object.prototype);
    expect(() => boundary.requirePlainDataRecord(countingProxy(laundered(), traps), "L")).toThrow(
      /^boundary under test: L must not be a Proxy/,
    );
    const { proxy, revoke } = Proxy.revocable(laundered(), {});
    revoke();
    let caught;
    try {
      boundary.requirePlainDataRecord(proxy, "L");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(caught.message).toMatch(/^boundary under test: L must not be a Proxy/);
    expect(traps).toEqual([]);
  });

  it("keeps the consumer prefix and never proceeds when the consumer's fail returns", () => {
    const other = createPlainDataInputBoundary((message) => {
      throw new Error(`other consumer: ${message}`);
    });
    const laundered = () => Object.setPrototypeOf(new Number(0), null);
    expect(messageOf(() => other.requirePlainDataRecord(laundered(), "L"))).toMatch(
      /^other consumer: L must be a plain object, not a boxed primitive; /,
    );
    const lenient = createPlainDataInputBoundary(() => {});
    expect(() => lenient.requirePlainDataRecord(laundered(), "L")).toThrow(
      /^plain-data input boundary: fail callback returned instead of throwing: L must be a plain object, not a boxed primitive/,
    );
  });

  it("refuses nothing ordinary and leaves arrays and primitive leaves alone", () => {
    for (const value of [
      { a: 1 },
      Object.freeze({ a: 1 }),
      JSON.parse('{"a":1}'),
      { ...{ a: 1 } },
      Object.assign(Object.create(null), { a: 1 }),
    ]) {
      expect(boundary.requirePlainDataRecord(value, "L")).toBe(value);
    }
    expect(() => boundary.requirePlainDataRecord([1], "L")).toThrow(/^boundary under test: L must be an object\./);
    expect(boundary.snapshotDenseArray([1, "a"], "L")).toEqual([1, "a"]);
    expect(boundary.snapshotStringArray(["a", "b"], "L")).toEqual(["a", "b"]);
    expect(boundary.requireNonEmptyString("ok", "L")).toBe("ok");
    expect(boundary.snapshotOwnField({ k: 1 }, "k", "L")).toBe(1);
  });
});
