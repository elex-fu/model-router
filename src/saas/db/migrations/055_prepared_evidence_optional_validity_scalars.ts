import type { SaasMigration } from './001_initial_schema.js';
import { PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION } from './024_prepared_request_evidence.js';
import { PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION } from './046_platform_authorization_fences.js';
import { PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION } from './050_prepared_evidence_authorization_advisory_fences.js';

function replaceOnce(source: string, before: string, after: string): string {
  const start = source.indexOf(before);
  if (start < 0 || source.indexOf(before, start + before.length) >= 0) {
    throw new Error('Migration 055 prepared guard anchor is missing or ambiguous');
  }
  return source.slice(0, start) + after + source.slice(start + before.length);
}

function historicalConstant(sql: string, name: string): string {
  const marker = `${name} constant text := $${name}$`;
  const start = sql.indexOf(marker);
  const end = sql.indexOf(`$${name}$;`, start + marker.length);
  if (start < 0 || end < 0 || sql.indexOf(marker, start + marker.length) >= 0) {
    throw new Error(`Migration 055 requires exactly one historical ${name} constant`);
  }
  return sql.slice(start + marker.length, end);
}

// Reconstruct the exact installed prosrc, including its final newline, from
// frozen 024 -> 046 -> 050. 053 changes other commercial guards, not this one;
// 054 changes only writer/ledger wrapper metadata, not this reader's body.
const marker = 'CREATE FUNCTION saas_prepared_request_evidence_guard() RETURNS trigger\nLANGUAGE plpgsql AS $$';
const originalSql = PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION.sql;
const bodyStart = originalSql.indexOf(marker);
const bodyEnd = originalSql.indexOf('\n$$;', bodyStart + marker.length);
if (bodyStart < 0 || bodyEnd < 0 || originalSql.indexOf(marker, bodyStart + marker.length) >= 0) {
  throw new Error('Migration 055 requires exactly one historical prepared guard');
}
let expected = originalSql.slice(bodyStart + marker.length, bodyEnd + 1);
const platform = (name: string) => historicalConstant(PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION.sql, name);
for (const [before, after] of [
  ['unsupported_project_service_guard', 'project_service_guard_replacement'],
  ['member_principal_guard', 'conditional_member_guard'],
  ['key_principal_match', 'key_principal_replacement'],
]) {
  expected = replaceOnce(expected, platform(before!), platform(after!));
}
const historyLock = /AND version = NEW[.]project_policy_version\s+FOR SHARE;/g;
if ([...expected.matchAll(historyLock)].length !== 1) {
  throw new Error('Migration 055 historical policy lock contract drifted');
}
expected = expected.replace(historyLock, 'AND version = NEW.project_policy_version;');
const advisory = (name: string) => historicalConstant(PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql, name);
expected = replaceOnce(expected, advisory('target_fence_key_declaration_anchor'), advisory('target_fence_key_declaration_replacement'));
expected = replaceOnce(expected, advisory('tenant_read_anchor'),
  advisory('authorization_fence_preamble') + advisory('supply_fence_preamble') + advisory('tenant_read_anchor'));
for (const kind of ['request', 'attempt']) {
  const anchor = advisory(`${kind}_lock_anchor`);
  expected = replaceOnce(expected, anchor, anchor.replace('FOR SHARE;', `__KEEP_${kind.toUpperCase()}_LOCK__`));
}
expected = expected.replaceAll('FOR SHARE;', ';');
for (const kind of ['request', 'attempt']) {
  expected = replaceOnce(expected, `__KEEP_${kind.toUpperCase()}_LOCK__`, 'FOR SHARE;');
}

let replacement = expected;
for (const kind of ['mapping', 'grant', 'price', 'cost']) {
  const declaration = `  ${kind}_record record;`;
  const scalars = `  ${kind}_effective_at timestamptz := NULL;\n  ${kind}_expires_at timestamptz := NULL;`;
  replacement = replaceOnce(replacement, declaration,
    kind === 'mapping' || kind === 'grant' ? `${declaration}\n${scalars}` : scalars);
  // Scalar NULL means this optional branch was not selected, not a composite
  // tuple test. A present row with nullable columns must still check its dates.
  replacement = replaceOnce(replacement,
    `  IF ${kind}_record IS NOT NULL\n    AND (${kind}_record.effective_at > locked_at\n      OR (${kind}_record.expires_at IS NOT NULL AND ${kind}_record.expires_at <= locked_at))`,
    `  IF ${kind}_effective_at > locked_at\n    OR (${kind}_expires_at IS NOT NULL AND ${kind}_expires_at <= locked_at)`);
}
for (const [kind, error] of [
  ['mapping', 'BYOK profile mapping'], ['grant', 'platform pool grant'],
]) {
  const anchor = `      RAISE EXCEPTION 'Prepared-request evidence ${error} is stale'\n        USING ERRCODE = '23514';\n    END IF;`;
  replacement = replaceOnce(replacement, anchor,
    `${anchor}\n    ${kind}_effective_at := ${kind}_record.effective_at;\n    ${kind}_expires_at := ${kind}_record.expires_at;`);
}
for (const [kind, version, table, error] of [
  ['price', 'customer_price_version', 'saas_customer_price_versions', 'customer price'],
  ['cost', 'supplier_cost_version', 'saas_supplier_cost_versions', 'provider cost'],
]) {
  replacement = replaceOnce(replacement,
    `    SELECT * INTO ${kind}_record FROM ${table}\n     WHERE id = NEW.${version} ;`,
    `    SELECT effective_at, expires_at INTO ${kind}_effective_at, ${kind}_expires_at\n      FROM ${table}\n     WHERE id = NEW.${version} ;\n    IF NOT FOUND THEN\n      RAISE EXCEPTION 'Prepared-request evidence ${error} is missing' USING ERRCODE = '23514';\n    END IF;`);
}

const sql = `
/* Forward-only optional validity repair. No authorization read, fence, row
 * lock, snapshot/version binding, clock placement, owner, security or ACL is
 * changed. Mapping/grant dates are captured only after their required branch
 * row passes its existing exact status/version checks. Price/cost are scalar
 * reads only when the immutable commercial binding names a version. Missing
 * named versions fail closed; absent optional branches remain typed NULL.
 */
DO $prepared_optional_validity$
DECLARE
  function_oid regprocedure := to_regprocedure('model_router_saas.saas_prepared_request_evidence_guard()');
  managed_schema oid := to_regnamespace('model_router_saas');
  trusted_owner oid := to_regrole('model_router_saas_migrator');
  expected_source constant text := $expected_source$${expected}$expected_source$;
  replacement_source constant text := $replacement_source$${replacement}$replacement_source$;
  installed_source text;
  definition text;
  function_catalog_before jsonb;
  function_catalog_after jsonb;
  table_acl_before jsonb;
  table_acl_after jsonb;
  column_acl_before jsonb;
  column_acl_after jsonb;
  trigger_catalog_before jsonb;
  trigger_catalog_after jsonb;
BEGIN
  IF current_user IS DISTINCT FROM 'model_router_saas_migrator'
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE oid = trusted_owner AND NOT rolsuper AND NOT rolbypassrls)
    OR NOT EXISTS (SELECT 1 FROM pg_namespace WHERE oid = managed_schema AND nspowner = trusted_owner)
    OR NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.oid = function_oid AND p.pronamespace = managed_schema AND p.proowner = trusted_owner
         AND l.lanname = 'plpgsql' AND p.prorettype = 'trigger'::regtype
         AND p.prokind = 'f' AND p.pronargs = 0 AND NOT p.prosecdef AND p.proconfig IS NULL
         AND p.prosrc = expected_source
    )
  THEN
    RAISE EXCEPTION 'Migration 055 prepared reader source, owner or execution contract is missing or drifted';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgfoid = function_oid) <> 1
    OR NOT EXISTS (
      SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgfoid = function_oid AND t.tgrelid = to_regclass('model_router_saas.saas_prepared_request_evidence')
         AND c.relnamespace = managed_schema AND c.relowner = trusted_owner
         AND t.tgname = 'saas_prepared_request_evidence_guard' AND t.tgtype = 7
         AND t.tgenabled = 'O' AND NOT t.tgisinternal AND NOT t.tgdeferrable AND NOT t.tginitdeferred
         AND t.tgconstraint = 0 AND t.tgnargs = 0 AND t.tgargs = decode('', 'hex')
         AND t.tgqual IS NULL AND t.tgattr::text = ''
    )
    OR EXISTS (
      SELECT 1 FROM pg_proc p CROSS JOIN pg_roles r
       WHERE p.pronamespace = managed_schema
         AND r.rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
         AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
    )
  THEN
    RAISE EXCEPTION 'Migration 055 prepared trigger binding or runtime function denial is missing or drifted';
  END IF;
  SELECT jsonb_agg(CASE WHEN p.oid = function_oid THEN to_jsonb(p) - 'prosrc' ELSE to_jsonb(p) END ORDER BY p.oid)
    INTO function_catalog_before FROM pg_proc p WHERE p.pronamespace = managed_schema;
  SELECT jsonb_agg(jsonb_build_array(oid, relowner, relacl) ORDER BY oid)
    INTO table_acl_before FROM pg_class WHERE relnamespace = managed_schema;
  SELECT jsonb_agg(jsonb_build_array(a.attrelid, a.attnum, a.attacl) ORDER BY a.attrelid, a.attnum)
    INTO column_acl_before FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) INTO trigger_catalog_before
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = managed_schema;

  SELECT prosrc, pg_get_functiondef(oid) INTO installed_source, definition FROM pg_proc WHERE oid = function_oid;
  IF installed_source IS DISTINCT FROM expected_source
    OR length(definition) - length(replace(definition, expected_source, '')) <> length(expected_source)
  THEN
    RAISE EXCEPTION 'Migration 055 prepared reader definition is missing or ambiguous';
  END IF;
  EXECUTE replace(definition, expected_source, replacement_source);
  SELECT prosrc INTO installed_source FROM pg_proc WHERE oid = function_oid;
  SELECT jsonb_agg(CASE WHEN p.oid = function_oid THEN to_jsonb(p) - 'prosrc' ELSE to_jsonb(p) END ORDER BY p.oid)
    INTO function_catalog_after FROM pg_proc p WHERE p.pronamespace = managed_schema;
  SELECT jsonb_agg(jsonb_build_array(oid, relowner, relacl) ORDER BY oid)
    INTO table_acl_after FROM pg_class WHERE relnamespace = managed_schema;
  SELECT jsonb_agg(jsonb_build_array(a.attrelid, a.attnum, a.attacl) ORDER BY a.attrelid, a.attnum)
    INTO column_acl_after FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) INTO trigger_catalog_after
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = managed_schema;
  IF installed_source IS DISTINCT FROM replacement_source
    OR function_catalog_after IS DISTINCT FROM function_catalog_before
    OR table_acl_after IS DISTINCT FROM table_acl_before
    OR column_acl_after IS DISTINCT FROM column_acl_before
    OR trigger_catalog_after IS DISTINCT FROM trigger_catalog_before
  THEN
    RAISE EXCEPTION 'Migration 055 changed an unapproved clause, execution attribute, ACL or trigger binding';
  END IF;
END;
$prepared_optional_validity$;
`;

export const PREPARED_EVIDENCE_OPTIONAL_VALIDITY_SCALARS_SAAS_MIGRATION: SaasMigration = {
  version: 55,
  name: 'prepared_evidence_optional_validity_scalars',
  sql,
};
