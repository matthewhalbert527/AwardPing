import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "vitest";
import { parse } from "libpg-query";
import { PROGRAM_DETAIL_FIELDS } from "./lib/program-change-contract.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261023180338_program_text_monitoring.sql", import.meta.url), "utf8");
const publicationPermissions = readFileSync(new URL("../supabase/migrations/20261023184127_program_text_atomic_publication_permissions.sql", import.meta.url), "utf8");
const approvalPreflight = readFileSync(new URL("../supabase/migrations/20261023190124_program_text_source_approval_preflight.sql", import.meta.url), "utf8");
const sourceHtmlMigration = readFileSync(new URL("../supabase/migrations/20261018205752_source_html_evidence_publication.sql", import.meta.url), "utf8");
const priorFreezeMigration = readFileSync(new URL("../supabase/migrations/20260716181500_secure_visual_candidate_publication_trigger.sql", import.meta.url), "utf8");
const parsed = await parse(migration);
const functions = new Map(parsed.stmts.filter(row => row.stmt.CreateFunctionStmt).map(row => {
  const value = row.stmt.CreateFunctionStmt;
  return [value.funcname.map(part => part.String.sval).join("."), value];
}));
const option = (value, name) => value.options.find(row => row.DefElem.defname === name)?.DefElem.arg;
const body = value => option(value, "as").List.items[0].String.sval;
const normalized = value => value.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
async function priorFunction(sql, name) {
  return (await parse(sql)).stmts.map(row => row.stmt.CreateFunctionStmt).filter(Boolean)
    .find(value => value.funcname.map(part => part.String.sval).join(".") === name);
}

test("the new migration parses without altering or deleting historical data", () => {
  for (const row of parsed.stmts) {
    assert.ok(["GrantStmt", "AlterTableStmt", "CreateFunctionStmt"].includes(Object.keys(row.stmt)[0]));
  }
  assert.ok(functions.has("public.publish_program_text_event"));
  assert.ok(functions.has("public.set_program_text_source_state"));
});

test("all SQL-language helper bodies parse as real SQL", async () => {
  for (const value of functions.values()) {
    if (option(value, "language").String.sval === "sql") await parse(body(value));
  }
});

test("the paid-review approval RPC only wraps existing policy with stable invoker service-only access", async () => {
  const rows = (await parse(approvalPreflight)).stmts;
  assert.deepEqual(rows.map(row => Object.keys(row.stmt)[0]), ["CreateFunctionStmt", "GrantStmt", "GrantStmt"]);
  const fn = rows[0].stmt.CreateFunctionStmt;
  assert.deepEqual(fn.funcname.map(part => part.String.sval), ["public", "program_text_source_is_approved"]);
  assert.equal(option(fn, "language").String.sval, "sql");
  assert.equal(option(fn, "volatility").String.sval, "stable");
  assert.equal(option(fn, "security")?.Boolean.boolval ?? false, false);
  assert.ok(fn.options.some(row => row.DefElem.defname === "set" && row.DefElem.arg.VariableSetStmt.name === "search_path" &&
    row.DefElem.arg.VariableSetStmt.args[0].A_Const.sval.sval === ""));
  assert.equal(normalized(body(fn)), "select private.awardping_program_source_allowed(p_source_id);");
  await parse(body(fn));
  for (const row of rows.slice(1)) assert.deepEqual(row.stmt.GrantStmt.objects[0].ObjectWithArgs.objname.map(part => part.String.sval), ["public", "program_text_source_is_approved"]);
  assert.equal(rows[1].stmt.GrantStmt.is_grant ?? false, false);
  assert.deepEqual(rows[1].stmt.GrantStmt.grantees.map(part => part.RoleSpec.rolename || "public"), ["public", "anon", "authenticated"]);
  assert.equal(rows[2].stmt.GrantStmt.is_grant, true);
  assert.deepEqual(rows[2].stmt.GrantStmt.grantees.map(part => part.RoleSpec.rolename), ["service_role"]);
  assert.deepEqual(rows[2].stmt.GrantStmt.privileges.map(part => part.AccessPriv.priv_name), ["execute"]);
});

test("only the fixed atomic publisher gains definer privilege; state and validation helpers remain invokers", async () => {
  const legacy = new Set(["public.awardping_validate_visual_evidence_insert",
    "public.awardping_freeze_published_visual_candidate_event_binding"]);
  for (const [name, value] of functions) {
    assert.equal(option(value, "security")?.Boolean.boolval ?? false, legacy.has(name));
    assert.ok(value.options.some(row => row.DefElem.defname === "set" &&
      row.DefElem.arg.VariableSetStmt.name === "search_path" &&
      row.DefElem.arg.VariableSetStmt.args[0].A_Const.sval.sval === ""));
    assert.ok(migration.includes(`revoke all on function ${name}(`));
    assert.ok(new RegExp(`grant execute on function ${name.replaceAll(".", "\\.")}\\([^;]*?\\) to service_role;`, "i").test(migration));
  }
  assert.doesNotMatch(migration, /grant\s+(?:all|execute)[^;]*\bto\s+(?:public|anon|authenticated)\b/i);
  const permissionChanges = (await parse(publicationPermissions)).stmts;
  assert.deepEqual(permissionChanges.map(row => Object.keys(row.stmt)[0]), ["AlterFunctionStmt", "GrantStmt", "GrantStmt"]);
  const change = permissionChanges[0].stmt.AlterFunctionStmt;
  assert.equal(change.objtype, "OBJECT_FUNCTION");
  assert.deepEqual(change.func.objname.map(part => part.String.sval), ["public", "publish_program_text_event"]);
  assert.deepEqual(change.func.objargs.map(part => part.TypeName.names.map(name => name.String.sval).join(".")), ["uuid", "jsonb", "jsonb"]);
  assert.equal(change.actions.length, 1);
  assert.equal(change.actions[0].DefElem.defname, "security");
  assert.equal(change.actions[0].DefElem.arg.Boolean.boolval, true);
  for (const row of permissionChanges.slice(1)) {
    const grant = row.stmt.GrantStmt;
    assert.equal(grant.objtype, "OBJECT_FUNCTION");
    assert.equal(grant.objects.length, 1);
    assert.deepEqual(grant.objects[0].ObjectWithArgs.objname.map(part => part.String.sval), ["public", "publish_program_text_event"]);
  }
  assert.equal(permissionChanges[1].stmt.GrantStmt.is_grant ?? false, false);
  assert.deepEqual(permissionChanges[1].stmt.GrantStmt.grantees.map(part => part.RoleSpec.rolename || "public"), ["public", "anon", "authenticated"]);
  assert.equal(permissionChanges[2].stmt.GrantStmt.is_grant, true);
  assert.deepEqual(permissionChanges[2].stmt.GrantStmt.grantees.map(part => part.RoleSpec.rolename), ["service_role"]);
  assert.deepEqual(permissionChanges[2].stmt.GrantStmt.privileges.map(part => part.AccessPriv.priv_name), ["execute"]);
  assert.match(publicationPermissions, /revoke\s+all\s+on\s+function\s+public\.publish_program_text_event\(uuid,jsonb,jsonb\)\s+from\s+public,anon,authenticated\s*;/i);
  assert.match(publicationPermissions, /grant\s+execute\s+on\s+function\s+public\.publish_program_text_event\(uuid,jsonb,jsonb\)\s+to\s+service_role\s*;/i);
  assert.doesNotMatch(publicationPermissions, /grant\s+(?:all|execute)[^;]*\bto\s+(?:public|anon|authenticated)\b/i);
  assert.doesNotMatch(normalized(publicationPermissions), /\b(?:insert|update|delete|truncate|create|drop|alter\s+table)\b/i);
  const publisher = functions.get("public.publish_program_text_event");
  assert.ok(publisher.options.some(row => row.DefElem.defname === "set" &&
    row.DefElem.arg.VariableSetStmt.name === "search_path" && row.DefElem.arg.VariableSetStmt.args[0].A_Const.sval.sval === ""));
  const publisherBody = body(publisher);
  assert.match(publisherBody, /perform public\.awardping_validate_program_text_evidence\(v_evidence,to_jsonb\(v_c\),p_details\);/);
  assert.match(publisherBody, /pg_advisory_xact_lock/);
  assert.match(publisherBody, /v_c\.candidate_scope is distinct from 'program_text_change'/);
  assert.doesNotMatch(publisherBody, /\bexecute\b|format\s*\(/i);
});

test("database program field vocabulary exactly matches the public and worker contract", () => {
  const proof = body(functions.get("public.awardping_validate_program_text_evidence"));
  const fields = [...proof.match(/v_allowed text\[\]:=array\[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(fields, PROGRAM_DETAIL_FIELDS);
});

test("the complete prior evidence insert guard survives the narrow text branch", async () => {
  const name = "public.awardping_validate_visual_evidence_insert";
  let next = body(functions.get(name));
  const begin = next.indexOf("  if new.evidence_schema_version='program-text-event-evidence-v1'");
  const end = next.indexOf("  if to_jsonb(new) ->> 'evidence_status'", begin);
  assert.ok(begin >= 0 && end > begin);
  next = next.slice(0, begin) + next.slice(end);
  assert.equal(normalized(next), normalized(body(await priorFunction(sourceHtmlMigration, name))));
});

test("the complete prior candidate publication guard survives both additional text guards", async () => {
  const name = "public.awardping_freeze_published_visual_candidate_event_binding";
  let next = body(functions.get(name));
  const scope = next.indexOf("  if new.candidate_scope is distinct from old.candidate_scope");
  const transition = next.indexOf("  if old.status <> 'published' and new.status = 'published' then", scope);
  assert.ok(scope >= 0 && transition > scope);
  next = next.slice(0, scope) + next.slice(transition);
  const begin = next.indexOf("    if new.candidate_scope='program_text_change' then");
  const end = next.indexOf("    if new.candidate_scope = 'initial_official_document' then", begin);
  assert.ok(begin >= 0 && end > begin);
  next = next.slice(0, begin) + next.slice(end);
  assert.equal(normalized(next), normalized(body(await priorFunction(priorFreezeMigration, name))));
});
