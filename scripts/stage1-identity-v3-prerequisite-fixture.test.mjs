import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadModule, parseSync } from "libpg-query";

// CONTRACT tests for the test-only identity v3 prerequisite fixture. They
// prove the file's shape, scope, provenance, and arithmetic offline. They do
// not prove that a real database replay succeeds; that needs the disposable
// runner against PostgreSQL.

const fixtureUrl = new URL(
  "../supabase/tests/fixtures/stage1_identity_v3_prerequisite.sql",
  import.meta.url,
);
const migrationsUrl = new URL("../supabase/migrations/", import.meta.url);
// This new test-fixture directory is not EOL-pinned like frozen migrations.
// Normalize only contract text; the replay runner still hashes/copies raw bytes.
const fixture = readFileSync(fixtureUrl, "utf8").replace(/\r\n/g, "\n");
const identityModule = readFileSync(
  new URL("../src/lib/stage1-cohort-identity.ts", import.meta.url),
  "utf8",
);
const registryMigration = readFileSync(
  new URL("../supabase/migrations/20260716204011_stage1_publication_registry.sql", import.meta.url),
  "utf8",
);
const hertzMigration = readFileSync(
  new URL("../supabase/migrations/20260717153000_hertz_ndseg_canonical_authority.sql", import.meta.url),
  "utf8",
);

const PREFIX_VERSION = "20260830223000";
const GUARDED_VERSION = "20260831210000";
const V2_HASH = "6e7dd7ee1372671cbfb22b17b862d867145a93c7dc0b73d49afc11f504ee6c8f";
const V3_HASH = "71aabb42ea22307645038d2b76aa23ea499609d45755b577b8d22298922a2ea9";
const MARKER_PATTERN = "^awardping-fixture-replay-[0-9a-f]{32}$";
const JULY_17_HERTZ_HOMEPAGE = "https://www.hertzfoundation.org/hertz-fellowship/";
const NDSEG_AWARD_ID = "e776ca2f-4b2c-431e-a3f9-248ad78c30e8";
const HERTZ_AWARD_ID = "4d2f6a7f-024e-4194-be31-1b9f63e497bc";
const SEED_REVIEWED_AT = "2026-07-17T14:41:57.337Z";
const QUARANTINE_KEY = "stage1:ndseg:official-deadline-conflict:2026-07-17";
const IDENTITY_EVIDENCE_KEY = "hertz-current-fellowship-root-2026-07-17";
const AUTHORITY_EVIDENCE_KEY = "ndseg-sysplus-current-contractor-2026-07-17";

// The only six field values the fixture may change: three cohorts, each from
// its exact v2 homepage to its exact v3 homepage, on the registry row and the
// matching canonical shared award row.
const EXPECTED_SWAPS = [
  {
    cohortKey: "truman",
    awardId: "bf04d4c1-4db3-4f4e-bf1b-e4dbca7bb7d3",
    previous: "https://www.truman.gov/",
    next: "https://www.truman.gov/apply",
  },
  {
    cohortKey: "hertz",
    awardId: HERTZ_AWARD_ID,
    previous: JULY_17_HERTZ_HOMEPAGE,
    next: "https://www.hertzfoundation.org/hertz-fellowship",
  },
  {
    cohortKey: "soros",
    awardId: "3cf7c610-0246-4dfb-b26c-289254e40ce6",
    previous: "https://www.pdsoros.org/",
    next: "https://pdsoros.org/",
  },
];

// Tables that must be empty on a fresh chain at the prefix.
const EMPTY_TABLES = [
  "public.stage1_award_publication_events",
  "public.stage1_publication_release_events",
  "public.stage1_award_reconciled_fact_evidence",
  "public.stage1_award_fact_publication_ledger",
  "public.stage1_release_acceptance_artifacts",
  "public.stage1_release_acceptance_records",
  "private.stage1_human_review_roots",
  "private.stage1_reviewed_reconciliation_authorizations",
  "private.stage1_reviewed_candidate_import_bundles",
  "private.stage1_source_disposition_bundles",
  "private.stage1_source_baseline_activation_receipts",
  "public.shared_award_reconciliation_queue",
  "public.shared_award_page_audits",
  "public.shared_award_fact_candidates",
  "public.shared_award_sources",
  "public.shared_award_source_snapshots",
  "public.shared_award_source_visual_snapshots",
  "public.shared_award_change_event_visual_evidence",
];

// Tables the prefix seeds and the fixture must leave byte-for-byte unchanged.
const PRESERVED_TABLES = [
  "public.stage1_award_members",
  "public.stage1_award_source_identity_rules",
  "public.stage1_award_source_manifest",
  "public.manual_quarantine_registry",
  "public.manual_quarantine_registry_events",
  "public.manual_quarantine_registry_state",
  "private.stage1_canonical_identity_evidence",
  "private.stage1_delegated_source_authority_evidence",
];

// The same arithmetic as the frozen guard and the app module: rows joined
// with "|" and "\n", hashed as a JSON string.
function identityHash(rows) {
  const payload = rows.map((row) => row.join("|")).join("\n");
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function identityRows() {
  return [
    ...identityModule.matchAll(
      /^\s*\[(\d+), "([a-z_]+)", "([^"]+)", "([0-9a-f-]{36})", "([^"]+)", "([^"]+)"\]/gm,
    ),
  ].map((match) => [match[1], match[2], match[3], match[4], match[5], match[6]]);
}

// The registry rows exactly as the July 16 migration inserts them (the
// search key column is not part of the identity payload).
function insertedRows() {
  return [
    ...registryMigration.matchAll(
      /^\s*\((\d+), '([a-z_]+)', '((?:[^']|'')+)', '(?:[^']|'')+', '([0-9a-f-]{36})'::uuid, '([^']+)', '([^']+)'\)/gm,
    ),
  ].map((match) => [match[1], match[2], match[3].replace(/''/g, "'"), match[4], match[5], match[6]]);
}

function withHomepage(rows, cohortKey, homepage) {
  return rows.map((row) => (row[1] === cohortKey ? [...row.slice(0, 5), homepage] : row));
}

// The plpgsql body between the fixture's dollar quotes.
function doBody() {
  const tag = "$stage1_identity_v3_prerequisite$";
  const start = fixture.indexOf(tag) + tag.length;
  const end = fixture.indexOf(tag, start);
  expect(start).toBeGreaterThan(tag.length);
  expect(end).toBeGreaterThan(start);
  return fixture.slice(start, end);
}

// The fixture's own table list for a named array constant.
function arrayConstant(body, name) {
  const start = body.indexOf(`${name} constant text[] := array[`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const literal = body.slice(start, body.indexOf("];", start));
  return [...literal.matchAll(/'((?:public|private)\.[a-z0-9_]+)'/g)].map((match) => match[1]);
}

// Every string constant in a parse tree, in source order.
function stringConstants(node, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) stringConstants(item, found);
  } else if (node && typeof node === "object") {
    if (node.A_Const?.sval && typeof node.A_Const.sval.sval === "string") {
      found.push(node.A_Const.sval.sval);
    } else {
      for (const value of Object.values(node)) stringConstants(value, found);
    }
  }
  return found;
}

function prefixMigrations() {
  return readdirSync(migrationsUrl)
    .filter((file) => file.endsWith(".sql") && file.split("_")[0] <= PREFIX_VERSION)
    .sort();
}

function tablesCreatedThroughPrefix() {
  const created = new Set();
  for (const file of prefixMigrations()) {
    const sql = readFileSync(new URL(file, migrationsUrl), "utf8");
    for (const match of sql.matchAll(/create table (?:if not exists )?((?:public|private)\.[a-z0-9_]+)/gi)) {
      created.add(match[1].toLowerCase());
    }
  }
  return created;
}

// Every INSERT in the prefix that runs at migration time rather than inside a
// function body: top-level statements and DO blocks. Function bodies only run
// later, at runtime, so they cannot seed a fresh chain.
function seedTimeInserts() {
  const found = [];
  for (const file of prefixMigrations()) {
    const lines = readFileSync(new URL(file, migrationsUrl), "utf8").split("\n");
    let construct = "top";
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*create\s+(?:or\s+replace\s+)?function\b/i.test(line)) construct = "function";
      else if (/^\s*do\s+\$/i.test(line)) construct = "do";
      else if (/^\$[a-z0-9_]*\$;\s*$/i.test(line) || /^end\s+\$[a-z0-9_]*\$;?\s*$/i.test(line)) construct = "top";
      const match = line.match(/insert\s+into\s+((?:public|private)\.[a-z0-9_]+)/i);
      if (match && construct !== "function") {
        const window = lines.slice(index, index + 80).join("\n");
        // A statement ends at a semicolon that ends a line; quoted messages
        // may carry semicolons mid-line.
        const end = window.search(/;\s*(?:\n|$)/);
        const statement = end === -1 ? window : window.slice(0, end + 1);
        found.push({
          file,
          line: index + 1,
          table: match[1].toLowerCase(),
          construct,
          statement,
          // The statement plus any CTE that feeds it from the lines above.
          context: lines.slice(Math.max(0, index - 60), index).join("\n") + "\n" + statement,
        });
      }
    }
  }
  return found;
}

describe("Stage 1 identity v3 prerequisite fixture", () => {
  it("is parseable SQL: one transaction around one DO block, then the handshake row", async () => {
    await loadModule();
    const tree = parseSync(fixture);
    const kinds = tree.stmts.map((entry) => Object.keys(entry.stmt)[0]);

    expect(kinds).toEqual([
      "TransactionStmt",
      "VariableSetStmt",
      "VariableSetStmt",
      "DoStmt",
      "TransactionStmt",
      "SelectStmt",
    ]);
    expect(tree.stmts[0].stmt.TransactionStmt.kind).toBe("TRANS_STMT_BEGIN");
    expect(tree.stmts[4].stmt.TransactionStmt.kind).toBe("TRANS_STMT_COMMIT");
    for (const index of [1, 2]) {
      expect(tree.stmts[index].stmt.VariableSetStmt.is_local).toBe(true);
      expect(["lock_timeout", "statement_timeout"]).toContain(tree.stmts[index].stmt.VariableSetStmt.name);
    }
    // No psql meta-commands: the file must mean the same thing to any SQL client.
    expect(fixture).not.toMatch(/^\\/m);
    // The handshake row names the exact status the runner should look for.
    const handshakeRow = "'stage1_identity_v3_prerequisite_ok' as fixture_status";
    expect(fixture).toContain(handshakeRow);
    expect(fixture.indexOf("commit;")).toBeLessThan(fixture.indexOf(handshakeRow));
  });

  it("mutates only the six homepage fields through two compare-and-swap updates", async () => {
    await loadModule();
    const body = doBody();
    const updates = [...body.matchAll(/with expected \([\s\S]*?;\n/g)].map((match) => match[0]);
    expect(updates).toHaveLength(2);

    const relations = [];
    for (const statement of updates) {
      const tree = parseSync(statement);
      expect(tree.stmts).toHaveLength(1);
      const update = tree.stmts[0].stmt.UpdateStmt;
      expect(update).toBeDefined();
      relations.push(`${update.relation.schemaname}.${update.relation.relname}`);
      // One assignment, to official_homepage, from the expected row.
      expect(update.targetList).toHaveLength(1);
      expect(update.targetList[0].ResTarget.name).toBe("official_homepage");
      expect(statement).toContain("set official_homepage = expected.next_homepage");
      // The row must still carry the exact v2 value to be touched at all.
      expect(statement).toContain("official_homepage = expected.previous_homepage");
      // The VALUES rows are exactly the three swaps, in order.
      const cte = update.withClause.ctes[0].CommonTableExpr;
      expect(cte.ctename).toBe("expected");
      expect(cte.aliascolnames.map((name) => name.String.sval)).toEqual([
        "cohort_key",
        "award_id",
        "previous_homepage",
        "next_homepage",
      ]);
      const rows = cte.ctequery.SelectStmt.valuesLists.map((list) => stringConstants(list));
      expect(rows).toEqual(EXPECTED_SWAPS.map((swap) => [swap.cohortKey, swap.awardId, swap.previous, swap.next]));
    }
    expect(relations).toEqual(["public.stage1_award_registry", "public.shared_awards"]);
    expect(updates[0]).toContain("registry.canonical_shared_award_id = expected.award_id");
    expect(updates[0]).toContain("registry.publication_state = 'pending'");
    expect(updates[1]).toContain("award.id = expected.award_id");

    // Each update must have changed exactly three rows, or the transaction fails.
    expect(body.match(/get diagnostics v_count = row_count;\s*if v_count <> 3 then/g)).toHaveLength(2);

    // Nothing else may be written: no other statement kind, no trigger or
    // replication tampering, no schema or function change, no ledger write,
    // and no touch of the seeded evidence or quarantine rows.
    expect(body.match(/^\s*update\b/gim)).toHaveLength(2);
    expect(body).not.toMatch(/\b(insert\s+into|delete\s+from|truncate|alter\s+|create\s+|drop\s+|grant\s+|revoke\s+)\b/i);
    expect(fixture).not.toMatch(/session_replication_role|disable\s+trigger|enable\s+trigger|security\s+definer/i);
    expect(body).not.toMatch(/\bset\s+(publication_state|state_reason|release_epoch|evidence_checked_at|last_verified_at|fact_ledger_batch_id|cohort_identity_hash|cohort_identity_version|release_state|activated_at|updated_at|status|evidence|evidence_hash|resolved_at)\b/i);
    for (const match of fixture.matchAll(/supabase_migrations\.schema_migrations/g)) {
      expect(fixture.slice(Math.max(0, match.index - 8), match.index)).toMatch(/from |class\('|^\s+$|\n\s*$/);
    }
    // The only "lock table" statements take share row exclusive mode.
    expect(body.match(/lock table/gi)).toHaveLength(2);
    expect(body.match(/in share row exclusive mode/gi)).toHaveLength(2);
  });

  it("makes its guards stable: release-wide advisory lock, then every inspected table locked before any check", () => {
    const body = doBody();
    const advisory = body.indexOf("pg_advisory_xact_lock(\n    pg_catalog.hashtextextended('stage1-national-25-release', 0)\n  )");
    const staticLock = body.indexOf("lock table\n    supabase_migrations.schema_migrations,");
    const dynamicLock = body.indexOf("foreach v_table in array v_preserved_tables || v_empty_tables loop");
    const firstGuard = body.indexOf("-- 1. Connection handshake");

    expect(advisory).toBeGreaterThanOrEqual(0);
    expect(staticLock).toBeGreaterThan(advisory);
    expect(dynamicLock).toBeGreaterThan(staticLock);
    expect(firstGuard).toBeGreaterThan(dynamicLock);
    for (const table of [
      "public.stage1_award_registry",
      "public.shared_awards",
      "public.stage1_publication_release_state",
      "public.manual_quarantine_backlog_state",
    ]) {
      expect(body.slice(staticLock, body.indexOf(";", staticLock))).toContain(table);
    }
    expect(body).toContain("execute pg_catalog.format('lock table %s in share row exclusive mode', v_table::regclass)");
  });

  it("refuses anything but a pending v2 replay database at the exact prefix", () => {
    const body = doBody();

    // Handshake: database, user, and the runner's application_name marker.
    expect(body).toContain("pg_catalog.current_database() <> 'postgres' or current_user <> 'postgres'");
    expect(body).toContain(`'${MARKER_PATTERN}'`);
    expect(body).toContain("v_application_name !~ v_marker_pattern");
    expect(new RegExp(MARKER_PATTERN).test(`awardping-fixture-replay-${"0123456789abcdef".repeat(2)}`)).toBe(true);
    expect(new RegExp(MARKER_PATTERN).test("awardping-fixture-replay-0123456789ABCDEF0123456789ABCDEF")).toBe(false);
    expect(new RegExp(MARKER_PATTERN).test("psql")).toBe(false);
    expect(fixture).toContain("not authorization");
    expect(fixture).toMatch(/cannot verify loopback\n-- from inside Docker/);

    // Ledger: the prefix is applied and nothing after it is.
    expect(body).toContain(`v_prefix_version constant text := '${PREFIX_VERSION}'`);
    expect(body).toContain(`v_guarded_version constant text := '${GUARDED_VERSION}'`);
    expect(body).toContain("where ledger.version = v_prefix_version");
    expect(body).toContain("where ledger.version > v_prefix_version");

    // Registry: exact count, exact v2 hash, pending, policy v1, no evidence pointers.
    expect(body).toContain(`'${V2_HASH}'`);
    expect(body).toContain(`'${V3_HASH}'`);
    expect(body).toContain("if v_hash is distinct from v_v2_hash then");
    for (const column of ["fact_ledger_batch_id", "release_epoch", "evidence_checked_at", "last_verified_at"]) {
      expect(body).toContain(`registry.${column} is not null`);
    }
    expect(body).toContain("registry.publication_state <> 'pending'");
    expect(body).toContain("registry.policy_version <> 'stage1-publication-v1'");

    // Release row: pending v2, no epoch, no activation, and left alone afterwards.
    expect(body).toContain("release_state.release_state = 'pending'");
    expect(body).toContain("release_state.cohort_identity_version = 'stage1-national-25-v2'");
    expect(body).toContain("release_state.cohort_identity_hash = v_v2_hash");
    expect(body).toContain("if v_release_after is distinct from v_release_before then");

    // Identity integrity and the manifest: no bound sources anywhere.
    expect(body).toContain("member.member_kind = 'canonical'");
    expect(body).toContain("member.member_kind = 'alias'");
    expect(body).toContain("manifest.manifest_status <> 'missing'");
    expect(body).toContain("pg_catalog.cardinality(manifest.source_ids) <> 0");

    // Result: exact v3 hash and every other column untouched on both tables.
    expect(body).toContain("if v_hash is distinct from v_v3_hash then");
    expect(body).toContain("if v_registry_after is distinct from v_registry_before then");
    expect(body).toContain("if v_awards_after is distinct from v_awards_before then");
    expect(body.match(/- 'official_homepage'\)::text/g)).toHaveLength(4);
    // The one intended side effect is asserted exactly, not tolerated loosely.
    expect(body).toContain("if v_backlog_after is distinct from v_backlog_before + 1 then");
  });

  it("recognizes exactly the reviewed records the frozen July 17 migration seeds, and preserves them", () => {
    const body = doBody();

    // Provenance: the migration inserts all three unconditionally, at top level,
    // and its own postcondition requires the quarantine row.
    for (const [table, key] of [
      ["private.stage1_canonical_identity_evidence", IDENTITY_EVIDENCE_KEY],
      ["private.stage1_delegated_source_authority_evidence", AUTHORITY_EVIDENCE_KEY],
      ["public.manual_quarantine_registry", QUARANTINE_KEY],
    ]) {
      const seeds = seedTimeInserts().filter((entry) => entry.table === table);
      expect(seeds.map((entry) => [entry.file, entry.construct]), table).toEqual([
        ["20260717153000_hertz_ndseg_canonical_authority.sql", "top"],
      ]);
      expect(seeds[0].context, table).toContain(`'${key}'`);
      expect(seeds[0].statement, table).toMatch(/on conflict \([a-z_]+\) do nothing;$/);
    }
    const postcondition = hertzMigration.slice(hertzMigration.indexOf("$awardping_stage1_canonical_identity_postcondition$"));
    expect(postcondition).toContain(`quarantine.quarantine_key =\n      '${QUARANTINE_KEY}'`);
    expect(postcondition).toContain("raise exception");
    // The quarantine insert fires the audit trigger, which writes one "opened" event.
    expect(hertzMigration).not.toContain("manual_quarantine_registry_events");
    // No later migration in the prefix touches the seeded key.
    for (const file of prefixMigrations().filter((name) => name.split("_")[0] > "20260717153000")) {
      expect(readFileSync(new URL(file, migrationsUrl), "utf8"), file).not.toContain(QUARANTINE_KEY);
    }

    // The fixture pins each seeded row by its exact key and reviewed values,
    // requires it to be the only row in its table, and never writes to it.
    expect(body).toContain(`v_quarantine_key constant text := '${QUARANTINE_KEY}'`);
    expect(body).toContain(`evidence.identity_key = '${IDENTITY_EVIDENCE_KEY}'`);
    expect(body).toContain(`authority.authority_key = '${AUTHORITY_EVIDENCE_KEY}'`);
    expect(body).toContain(`v_seed_reviewed_at constant timestamptz := '${SEED_REVIEWED_AT}'`);
    expect(body).toContain(`v_ndseg_award_id constant uuid := '${NDSEG_AWARD_ID}'`);
    expect(body).toContain(`v_hertz_award_id constant uuid := '${HERTZ_AWARD_ID}'`);
    for (const literal of [
      "quarantine.case_key = 'stage1:ndseg:official-deadline-conflict'",
      "quarantine.classification = 'actionable_quarantine'",
      "quarantine.status = 'quarantined'",
      "quarantine.evidence_record_count = 2",
      "quarantine.evidence ->> 'publication_decision' = 'not_published'",
      "quarantine.evidence_hash = public.manual_quarantine_evidence_hash(quarantine.evidence)",
      "quarantine.policy_hash = '4a12c7a0c4e088bca3b5c4b9ef28c6ddb8b108ac8b324c23dbde4aa5e0646ae4'",
      "quarantine.resolved_at is null",
      "event.event_type = 'opened'",
      "event.next_status = 'quarantined'",
      "evidence.current_homepage = 'https://www.hertzfoundation.org/hertz-fellowship/'",
      "evidence.evidence_hash = public.stage1_publication_evidence_hash(evidence.evidence)",
      "authority.delegated_host = 'ndseg.sysplus.com'",
      "authority.evidence_hash = public.stage1_publication_evidence_hash(authority.evidence)",
    ]) {
      expect(body).toContain(literal);
    }
    // Every seeded literal the fixture pins appears verbatim in the migration.
    for (const literal of [
      QUARANTINE_KEY,
      "'stage1:ndseg:official-deadline-conflict'",
      "'awardping-stage1-official-source-conflict'",
      "'NDSEG official application-cycle date conflict'",
      "'official_source_fact_conflict'",
      IDENTITY_EVIDENCE_KEY,
      AUTHORITY_EVIDENCE_KEY,
      "'https://www.hertzfoundation.org/hertz-fellowship/application-help/faq/'",
      "'ndseg.sysplus.com'",
      "'https://ndseg.org/apply-link'",
      `'${SEED_REVIEWED_AT}'::timestamptz`,
    ]) {
      expect(hertzMigration).toContain(literal);
    }
    expect(body.match(/from public\.manual_quarantine_registry;\n\s*if v_count <> 1 then/g)).toHaveLength(1);
    expect(body.match(/from private\.stage1_canonical_identity_evidence;\n\s*if v_count <> 1 then/g)).toHaveLength(1);
    expect(body.match(/from private\.stage1_delegated_source_authority_evidence;\n\s*if v_count <> 1 then/g)).toHaveLength(1);
    expect(body.match(/from public\.manual_quarantine_registry_events;\n\s*if v_count <> 1 then/g)).toHaveLength(1);

    // Preserved tables are snapshotted whole before the swap and compared after it.
    expect(arrayConstant(body, "v_preserved_tables")).toEqual(PRESERVED_TABLES);
    expect(body.match(/foreach v_table in array v_preserved_tables loop/g)).toHaveLength(2);
    expect(body).toContain("raise exception 'Fixture aborted: seeded table % changed during the swap.', v_table;");
  });

  it("requires emptiness only where a fresh chain is provably empty at the prefix", () => {
    const body = doBody();
    const listed = arrayConstant(body, "v_empty_tables");
    expect(listed).toEqual(EMPTY_TABLES);
    expect(listed).not.toContain("public.manual_quarantine_registry");

    const created = tablesCreatedThroughPrefix();
    for (const table of [...EMPTY_TABLES, ...PRESERVED_TABLES]) {
      expect(created.has(table), `${table} must exist by ${PREFIX_VERSION}`).toBe(true);
    }

    // Exactly two migration-time inserts touch an "empty" table, and neither
    // can add a row to a fresh chain: the 0008 backfill copies rows out of
    // legacy tables that are themselves empty, and the July 17 publication
    // event is written only for cohorts already in verified_beta, while every
    // cohort is still pending at the prefix.
    const seeds = seedTimeInserts().filter((entry) => EMPTY_TABLES.includes(entry.table));
    expect(seeds.map((entry) => [entry.file, entry.table, entry.construct])).toEqual([
      ["0008_shared_award_history.sql", "public.shared_award_source_snapshots", "top"],
      ["20260717153000_hertz_ndseg_canonical_authority.sql", "public.stage1_award_publication_events", "do"],
    ]);
    const [backfill, verifiedOnlyEvent] = seeds;
    expect(backfill.statement).toMatch(/\bselect\b/i);
    expect(backfill.statement).not.toMatch(/\bvalues\b/i);
    expect(backfill.statement).toMatch(/from public\.monitor_snapshots\b/i);
    expect(verifiedOnlyEvent.statement).toContain("registry.publication_state = 'verified_beta'");
    expect(verifiedOnlyEvent.statement).toMatch(/;\s*$/);

    // The loop runs twice: refusal before the swap, abort after it.
    expect(body.match(/foreach v_table in array v_empty_tables loop/g)).toHaveLength(2);
    expect(body).toContain("from %s', v_table::regclass");
  });

  it("reproduces the guard arithmetic offline: exact v2 before the swap, exact v3 after it", () => {
    const inserted = insertedRows();
    const v3 = identityRows();
    expect(inserted).toHaveLength(25);
    expect(v3).toHaveLength(25);

    // The prefix leaves the July 16 rows plus the July 17 Hertz homepage.
    expect(hertzMigration).toContain(`'${JULY_17_HERTZ_HOMEPAGE}'::text`);
    const prefixState = withHomepage(inserted, "hertz", JULY_17_HERTZ_HOMEPAGE);
    expect(identityHash(prefixState)).toBe(V2_HASH);
    expect(identityHash(v3)).toBe(V3_HASH);

    // Exactly the three swapped homepages separate the two states.
    const differences = [];
    prefixState.forEach((row, index) => {
      row.forEach((value, field) => {
        if (value !== v3[index][field]) differences.push({ cohortKey: row[1], field, before: value, after: v3[index][field] });
      });
    });
    expect(differences).toEqual(
      EXPECTED_SWAPS.map((swap) => ({ cohortKey: swap.cohortKey, field: 5, before: swap.previous, after: swap.next })),
    );
    for (const swap of EXPECTED_SWAPS) {
      const row = prefixState.find((candidate) => candidate[1] === swap.cohortKey);
      expect(row[3], swap.cohortKey).toBe(swap.awardId);
    }

    // Applying the fixture's swaps to the prefix state yields the v3 hash.
    let swapped = prefixState;
    for (const swap of EXPECTED_SWAPS) swapped = withHomepage(swapped, swap.cohortKey, swap.next);
    expect(identityHash(swapped)).toBe(V3_HASH);
    expect(swapped).toEqual(v3);
  });

  it("is a fixture under supabase/tests, never a migration", () => {
    expect(fixtureUrl.pathname).toMatch(/\/supabase\/tests\/fixtures\/stage1_identity_v3_prerequisite\.sql$/);
    for (const file of readdirSync(migrationsUrl)) {
      expect(file).not.toMatch(/identity_v3_prerequisite/);
    }
    expect(fixture).toMatch(/^-- TEST-ONLY prerequisite fixture/);
    expect(fixture).toContain("NOT a migration");
    expect(fixture).toContain("does not repair a bare `supabase db reset`");
    expect(fixture).toContain("bump_manual_quarantine_backlog_revision()");
    expect(fixture).toContain("seeds unconditionally");
  });
});
