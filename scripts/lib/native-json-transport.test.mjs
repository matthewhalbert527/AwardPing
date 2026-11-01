import { describe, it, expect } from 'vitest';
import { prepareNativeJsonTransport, decodeNativeJsonTransport, nativeJsonTransportExpression } from '../test-support/native-json-transport.mjs';

describe('fixture-only lossless JSON dictionary transport', () => {
  it('preserves JSON types, empty containers, Unicode, quotes, backslashes and exact retained bytes', () => {
    const original = Buffer.from('A complete retained original: • 😀 \' " \\ \n', 'utf8');
    const value = { status: 'published', owner_review: { status: 'approved' }, null: null, zero: 0, false: false, decimal: 0.125,
      array: [[], {}, null, true, '😀'], raw: { raw_base64: original.toString('base64') } };
    const transport = prepareNativeJsonTransport(value);
    expect(decodeNativeJsonTransport(transport)).toStrictEqual(value);
    expect(transport.raw_guards).toHaveLength(1);
    expect(transport.raw_guards[0].raw_bytes).toBe(original.length);
    expect(Buffer.from(decodeNativeJsonTransport(transport).raw.raw_base64, 'base64')).toEqual(original);
    expect(nativeJsonTransportExpression(transport)).toContain('pg_temp.awardping_native_json_unpack(');
  });

  it('reduces repeated source strings while retaining their complete contents', () => {
    const text = 'Exact complete source text. '.repeat(300);
    const value = { previous_text: text, current_text: text, documents: Array.from({ length: 12 }, () => ({ text, status: 'complete' })) };
    const transport = prepareNativeJsonTransport(value);
    expect(Buffer.byteLength(JSON.stringify(transport))).toBeLessThan(Buffer.byteLength(JSON.stringify(value)) / 3);
    expect(decodeNativeJsonTransport(transport)).toStrictEqual(value);
  });

  it('rejects a changed dictionary value before producing a SQL expression', () => {
    const transport = prepareNativeJsonTransport({ status: 'published' });
    transport.dictionary[transport.dictionary.indexOf('published')] = 'rejected';
    expect(() => nativeJsonTransportExpression(transport)).toThrow('original canonical bytes changed');
  });

  it('rejects invalid tags, missing dictionary entries and non-JSON scalars', () => {
    const original = prepareNativeJsonTransport({ a: 1 });
    expect(() => decodeNativeJsonTransport({ ...original, data: [9, 0] })).toThrow('scalar dictionary index required');
    expect(() => decodeNativeJsonTransport({ ...original, data: [2, 9000] })).toThrow('scalar dictionary index required');
    expect(() => prepareNativeJsonTransport({ impossible: undefined })).toThrow('JSON scalar required');
    expect(() => prepareNativeJsonTransport({ impossible: Infinity })).toThrow('finite JSON number required');
    expect(() => prepareNativeJsonTransport({ raw_base64: 'YQ' })).toThrow('canonical raw base64 required');
  });

  it('rejects a cyclic compound reference within the bounded decoder', () => {
    const transport = prepareNativeJsonTransport({ nested: { value: 'unchanged' } });
    const root = transport.data[1];
    transport.compounds[root] = [1, [[3, root]]];
    expect(() => decodeNativeJsonTransport(transport)).toThrow('bounded tagged node required');
  });
});
