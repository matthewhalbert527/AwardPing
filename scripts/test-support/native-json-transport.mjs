// Fixture-only lossless transport. It changes no production schema or evidence.
import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const check = (ok, reason) => { if (!ok) throw Error('Native JSON transport: ' + reason); };
const literal = value => "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";

export function prepareNativeJsonTransport(value) {
  const dictionary = [], indices = new Map(), rawGuards = [], compounds = [], compoundIndices = new Map();
  let nodeCount = 0;
  const scalar = value => {
    check(value === null || ['string', 'boolean', 'number'].includes(typeof value), 'JSON scalar required');
    check(typeof value !== 'number' || Number.isFinite(value), 'finite JSON number required');
    const key = JSON.stringify(value);
    if (!indices.has(key)) { indices.set(key, dictionary.length); dictionary.push(value); }
    return indices.get(key);
  };
  const compound = node => {
    const key = JSON.stringify(node);
    if (!compoundIndices.has(key)) { compoundIndices.set(key, compounds.length); compounds.push(node); }
    return [3, compoundIndices.get(key)];
  };
  const encode = (value, path = [], depth = 0) => {
    check(depth <= 128 && ++nodeCount <= 300000, 'bounded JSON structure required');
    if (Array.isArray(value)) return compound([1, value.map((item, index) => encode(item, [...path, String(index)], depth + 1))]);
    if (value && typeof value === 'object') {
      check([Object.prototype, null].includes(Object.getPrototypeOf(value)), 'plain JSON object required');
      return compound([0, Object.entries(value).map(([key, item]) => [scalar(key), encode(item, [...path, key], depth + 1)])]);
    }
    const index = scalar(value);
    if (path.at(-1) === 'raw_base64') {
      check(typeof value === 'string', 'raw base64 must remain a string');
      const bytes = Buffer.from(value, 'base64');
      check(bytes.toString('base64') === value, 'canonical raw base64 required');
      rawGuards.push({ path, dictionary_index: index, string_bytes: Buffer.byteLength(value), string_sha256: sha(value), raw_bytes: bytes.length, raw_sha256: sha(bytes) });
    }
    return [2, index];
  };
  const data = encode(value), canonicalBytes = Buffer.from(JSON.stringify(canonical(value)), 'utf8');
  check(canonicalBytes.length <= 33554432 && dictionary.length <= 100000 && compounds.length <= 100000 && rawGuards.length <= 32, 'bounded original required');
  const transport = { schema: 'awardping.private-native-json-dictionary.v2', dictionary, compounds, data, canonical_sha256: sha(canonicalBytes), canonical_bytes: canonicalBytes.length, raw_guards: rawGuards };
  check(JSON.stringify(decodeNativeJsonTransport(transport)) === JSON.stringify(value), 'exact JSON round trip required');
  return transport;
}

export function decodeNativeJsonTransport(transport) {
  check(transport?.schema === 'awardping.private-native-json-dictionary.v2' && Array.isArray(transport.dictionary) && Array.isArray(transport.compounds), 'transport schema required');
  const decode = (node, depth = 0) => {
    check(depth <= 128 && Array.isArray(node) && node.length === 2, 'bounded tagged node required');
    if (node[0] === 3) {
      check(Number.isInteger(node[1]) && node[1] >= 0 && node[1] < transport.compounds.length && [0, 1].includes(transport.compounds[node[1]]?.[0]), 'compound dictionary index required');
      return decode(transport.compounds[node[1]], depth + 1);
    }
    if (node[0] === 0) {
      check(Array.isArray(node[1]), 'object pairs required');
      const pairs = node[1].map(pair => {
        check(Array.isArray(pair) && pair.length === 2 && Number.isInteger(pair[0]) && typeof transport.dictionary[pair[0]] === 'string', 'string object key required');
        return [transport.dictionary[pair[0]], decode(pair[1], depth + 1)];
      });
      check(new Set(pairs.map(([key]) => key)).size === pairs.length, 'unique object keys required');
      return Object.fromEntries(pairs);
    }
    if (node[0] === 1) { check(Array.isArray(node[1]), 'array entries required'); return node[1].map(item => decode(item, depth + 1)); }
    check(node[0] === 2 && Number.isInteger(node[1]) && node[1] >= 0 && node[1] < transport.dictionary.length, 'scalar dictionary index required');
    const value = transport.dictionary[node[1]];
    check(value === null || ['string', 'boolean', 'number'].includes(typeof value), 'scalar dictionary entry required');
    return value;
  };
  const value = decode(transport.data), bytes = Buffer.from(JSON.stringify(canonical(value)), 'utf8');
  check(bytes.length === transport.canonical_bytes && sha(bytes) === transport.canonical_sha256, 'original canonical bytes changed');
  return value;
}

export function nativeJsonTransportExpression(transport) {
  decodeNativeJsonTransport(transport);
  return 'pg_temp.awardping_native_json_unpack(' + literal(transport) + ')';
}

export const NATIVE_JSON_TRANSPORT_SQL = `
-- Transaction-local fixture helper only. Every value is reconstructed exactly
-- and checked before it can reach a production validator or mutator.
CREATE TEMP TABLE awardping_native_transport_guard(dummy boolean) ON COMMIT DROP;
CREATE TEMP TABLE awardping_native_transport_scalars(id integer PRIMARY KEY,value_json jsonb NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE awardping_native_transport_compounds(id integer PRIMARY KEY,value_json jsonb NOT NULL) ON COMMIT DROP;
REVOKE ALL ON TABLE pg_temp.awardping_native_transport_guard,pg_temp.awardping_native_transport_scalars,pg_temp.awardping_native_transport_compounds FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION pg_temp.awardping_native_json_value(n jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path='' AS $native_dictionary_value$
DECLARE tag integer;idx integer;result jsonb;
BEGIN
 IF jsonb_typeof(n) IS DISTINCT FROM 'array' OR jsonb_array_length(n)<>2 THEN RAISE EXCEPTION 'Invalid native reference';END IF;
 tag:=(n->>0)::integer;idx:=(n->>1)::integer;
 IF idx<0 THEN RAISE EXCEPTION 'Invalid native reference index';END IF;
 IF tag=2 THEN SELECT value_json INTO STRICT result FROM pg_temp.awardping_native_transport_scalars WHERE id=idx;
 ELSIF tag=3 THEN SELECT value_json INTO STRICT result FROM pg_temp.awardping_native_transport_compounds WHERE id=idx;
 ELSE RAISE EXCEPTION 'Invalid native reference tag';END IF;
 RETURN result;
EXCEPTION WHEN no_data_found THEN RAISE EXCEPTION 'Missing or forward native reference';
END;
$native_dictionary_value$;
CREATE FUNCTION pg_temp.awardping_native_json_materialize(t jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path='' SET jit=off SET enable_seqscan=off SET enable_indexscan=on AS $native_dictionary_materialize$
DECLARE node_json jsonb;idx integer;tag integer;result jsonb;
BEGIN
 TRUNCATE pg_temp.awardping_native_transport_scalars,pg_temp.awardping_native_transport_compounds;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(t->'dictionary') x WHERE jsonb_typeof(x) IN('object','array')) THEN RAISE EXCEPTION 'Non-scalar native dictionary';END IF;
 INSERT INTO pg_temp.awardping_native_transport_scalars(id,value_json) SELECT ord-1,x FROM jsonb_array_elements(t->'dictionary') WITH ORDINALITY a(x,ord);
 FOR node_json,idx IN SELECT x,(ord-1)::integer FROM jsonb_array_elements(t->'compounds') WITH ORDINALITY a(x,ord) LOOP
  IF jsonb_typeof(node_json) IS DISTINCT FROM 'array' OR jsonb_array_length(node_json)<>2 OR jsonb_typeof(node_json->1) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid native compound node';END IF;
  tag:=(node_json->>0)::integer;
  IF tag=0 THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(node_json->1) p WHERE jsonb_typeof(p) IS DISTINCT FROM 'array' OR jsonb_array_length(p)<>2)
    OR (SELECT count(DISTINCT k.value_json#>>'{}') FROM jsonb_array_elements(node_json->1) p JOIN pg_temp.awardping_native_transport_scalars k ON k.id=(p->>0)::integer WHERE jsonb_typeof(k.value_json)='string')<>jsonb_array_length(node_json->1) THEN RAISE EXCEPTION 'Invalid native object keys';END IF;
   SELECT coalesce(jsonb_object_agg(k.value_json#>>'{}',pg_temp.awardping_native_json_value(p->1)),'{}'::jsonb) INTO result
    FROM jsonb_array_elements(node_json->1) p JOIN pg_temp.awardping_native_transport_scalars k ON k.id=(p->>0)::integer;
  ELSIF tag=1 THEN
   SELECT coalesce(jsonb_agg(pg_temp.awardping_native_json_value(x) ORDER BY ord),'[]'::jsonb) INTO result FROM jsonb_array_elements(node_json->1) WITH ORDINALITY a(x,ord);
  ELSE RAISE EXCEPTION 'Unknown native compound tag';END IF;
  INSERT INTO pg_temp.awardping_native_transport_compounds(id,value_json) VALUES(idx,result);
 END LOOP;
 RETURN pg_temp.awardping_native_json_value(t->'data');
END;
$native_dictionary_materialize$;
CREATE FUNCTION pg_temp.awardping_native_json_unpack(t jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path='' SET jit=off AS $native_dictionary_unpack$
DECLARE result jsonb;canonical_text text;g jsonb;path text[];value text;raw bytea;
BEGIN
 IF private.awardping_program_exact_object(t,ARRAY['schema','dictionary','compounds','data','canonical_sha256','canonical_bytes','raw_guards']) IS DISTINCT FROM TRUE
  OR t->>'schema' IS DISTINCT FROM 'awardping.private-native-json-dictionary.v2' OR jsonb_typeof(t->'dictionary') IS DISTINCT FROM 'array'
  OR jsonb_typeof(t->'compounds') IS DISTINCT FROM 'array' OR jsonb_array_length(t->'compounds')>100000
  OR jsonb_array_length(t->'dictionary')>100000 OR (t->>'canonical_bytes')::integer NOT BETWEEN 1 AND 33554432
  OR jsonb_typeof(t->'raw_guards') IS DISTINCT FROM 'array' OR jsonb_array_length(t->'raw_guards')>32 THEN RAISE EXCEPTION 'Invalid bounded native dictionary';END IF;
 result:=pg_temp.awardping_native_json_materialize(t);
 canonical_text:=private.monitoring_feedback_canonical_json(result);
 IF octet_length(convert_to(canonical_text,'UTF8'))<>(t->>'canonical_bytes')::integer
  OR encode(extensions.digest(convert_to(canonical_text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM t->>'canonical_sha256' THEN RAISE EXCEPTION 'Native transport changed original canonical bytes';END IF;
 FOR g IN SELECT guard FROM jsonb_array_elements(t->'raw_guards') guards(guard) LOOP
  IF private.awardping_program_exact_object(g,ARRAY['path','dictionary_index','string_bytes','string_sha256','raw_bytes','raw_sha256']) IS DISTINCT FROM TRUE
   OR jsonb_typeof(g->'path') IS DISTINCT FROM 'array' OR jsonb_array_length(g->'path') NOT BETWEEN 1 AND 128
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(g->'path') p WHERE jsonb_typeof(p) IS DISTINCT FROM 'string')
   OR g#>>ARRAY['path',(jsonb_array_length(g->'path')-1)::text] IS DISTINCT FROM 'raw_base64'
   OR (g->>'dictionary_index')::integer NOT BETWEEN 0 AND jsonb_array_length(t->'dictionary')-1
   OR (g->>'string_bytes')::integer<0 OR (g->>'raw_bytes')::integer<0
   OR coalesce(g->>'string_sha256','') !~ '^[a-f0-9]{64}$' OR coalesce(g->>'raw_sha256','') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid native raw byte guard';END IF;
  SELECT array_agg(v ORDER BY ord) INTO path FROM jsonb_array_elements_text(g->'path') WITH ORDINALITY x(v,ord);
  value:=result#>>path;
  IF value IS NULL OR value IS DISTINCT FROM (t->'dictionary')->>((g->>'dictionary_index')::integer)
   OR octet_length(convert_to(value,'UTF8')) IS DISTINCT FROM (g->>'string_bytes')::integer
   OR encode(extensions.digest(convert_to(value,'UTF8'),'sha256'),'hex') IS DISTINCT FROM g->>'string_sha256' THEN RAISE EXCEPTION 'Native raw base64 bytes changed';END IF;
  raw:=decode(value,'base64');
  IF octet_length(raw)<>(g->>'raw_bytes')::integer OR encode(extensions.digest(raw,'sha256'),'hex') IS DISTINCT FROM g->>'raw_sha256' THEN RAISE EXCEPTION 'Native retained original bytes changed';END IF;
 END LOOP;
 RETURN result;
END;
$native_dictionary_unpack$;
REVOKE ALL ON FUNCTION pg_temp.awardping_native_json_value(jsonb),pg_temp.awardping_native_json_materialize(jsonb),pg_temp.awardping_native_json_unpack(jsonb) FROM PUBLIC,anon,authenticated,service_role;
`;
