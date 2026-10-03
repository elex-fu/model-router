import type { SaasMigration } from './001_initial_schema.js';
import { COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION } from './023_commercial_metering_policy_authority.js';
import { PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION } from './050_prepared_evidence_authorization_advisory_fences.js';
import { COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION } from './052_commercial_authority_guard_rowtype_safety.js';

function functionBody(sql: string, name: string, signature = '() RETURNS trigger'): string {
  const marker = `FUNCTION ${name}${signature}\nLANGUAGE plpgsql AS $$`;
  const start = sql.indexOf(marker);
  const end = start < 0 ? -1 : sql.indexOf('\n$$;', start);
  if (start < 0 || end < 0 || sql.indexOf(marker, start + 1) >= 0) {
    throw new Error(`Migration 053 requires exactly one ${name} definition`);
  }
  // PostgreSQL prosrc retains the newline immediately before the closing $$.
  return sql.slice(start + marker.length, end + 1);
}

function replaceOnce(source: string, before: string, after: string): string {
  const start = source.indexOf(before);
  if (start < 0 || source.indexOf(before, start + before.length) >= 0) {
    throw new Error('Migration 053 commercial guard anchor is missing or ambiguous');
  }
  return source.slice(0, start) + after + source.slice(start + before.length);
}

// Inline into the SECURITY INVOKER triggers: runtime roles deliberately have
// zero EXECUTE privileges on application functions, including nested helpers.
function readFences(projectIdentity: string): string {
  return `  IF NEW.tenant_id IS NULL OR ${projectIdentity} IS NULL THEN
    RAISE EXCEPTION 'Commercial authority fence identity is missing' USING ERRCODE = '23514';
  END IF;
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'Commercial authority reads require READ COMMITTED' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('saas-authz:tenant:' || NEW.tenant_id::text, 0));
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('saas-authz:project:' || NEW.tenant_id::text || ':' || ${projectIdentity}::text, 0)
  );`;
}

const specs = [
  ['saas_route_config_commercial_authority_guard', COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION.sql, 6],
  ['saas_requests_guard_commercial_authority', COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION.sql, 2],
  ['saas_attempts_guard_commercial_authority', COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION.sql, 3],
] as const;

const rewrites = specs.map(([name, sql, expectedLocks]) => {
  const original = functionBody(sql, name);
  if ((original.match(/FOR SHARE;/g) ?? []).length !== expectedLocks) {
    throw new Error(`Migration 053 ${name} row-lock contract drifted`);
  }
  let rewritten = original;
  if (name === 'saas_attempts_guard_commercial_authority') {
    // A request's project identity is immutable. Obtain only that hint before
    // the earlier authorization fences; retain the full request integrity lock
    // and its fresh snapshot afterwards. No cached authority is trusted.
    rewritten = replaceOnce(rewritten, '  request_record record;', '  request_record record;\n  commercial_project_id uuid;');
    rewritten = replaceOnce(rewritten, '  SELECT r.project_id, r.supply_mode, r.customer_price_version,',
      `  SELECT project_id INTO commercial_project_id FROM saas_requests
   WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SaaS attempt commercial authority request is missing'
      USING ERRCODE = '23514';
  END IF;
${readFences('commercial_project_id')}

  SELECT r.project_id, r.supply_mode, r.customer_price_version,`);
    rewritten = replaceOnce(rewritten,
      '     AND r.id = NEW.request_id\n   FOR SHARE;',
      '     AND r.id = NEW.request_id\n   __KEEP_REQUEST_INTEGRITY_LOCK__;');
  } else {
    const anchor = name === 'saas_requests_guard_commercial_authority'
      ? '  SELECT a.customer_policy_id, a.customer_policy_version,'
      : '  SELECT rv.public_model_id, rv.public_model_version, rv.protocol, rv.supply_mode,';
    rewritten = replaceOnce(rewritten, anchor,
      `${readFences('NEW.project_id')}\n\n${anchor}`);
  }
  // Route/policy heads are mutable, protected by the matching 050 project
  // fence. Route/authority/policy/attestation/price/cost versions are immutable.
  rewritten = rewritten.replace(/FOR SHARE;/g, ';').replace('__KEEP_REQUEST_INTEGRITY_LOCK__;', 'FOR SHARE;');
  for (const kind of ['price', 'cost'] as const) {
    if (!rewritten.includes(`  ${kind}_record record;`)) continue;
    rewritten = replaceOnce(rewritten, `  ${kind}_record record;`,
      `  ${kind}_effective_at timestamptz;\n  ${kind}_expires_at timestamptz;`);
    rewritten = replaceOnce(rewritten, `      INTO ${kind}_record\n`,
      `      INTO ${kind}_effective_at, ${kind}_expires_at\n`);
    rewritten = rewritten.replaceAll(`${kind}_record.effective_at`, `${kind}_effective_at`)
      .replaceAll(`${kind}_record.expires_at`, `${kind}_expires_at`);
  }
  return { name, original, rewritten };
});

const writerBody = functionBody(
  PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql,
  'saas_prepared_evidence_authorization_writer_fence',
);
const writerLayerBody = functionBody(
  PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql,
  'saas_prepared_evidence_writer_lock_layer', '(fence_keys text[]) RETURNS void',
);

const sql = `
/* Requires 050/052. Do not rewrite their SQL/checksums or expand runtime ACLs.
 * Heads' 050 BEFORE ROW writers fence OLD and NEW tenant/project identities
 * exclusively in that order. Readers use the same shared transaction fences.
 * The application prelock already holds them before request/idempotency locks;
 * reacquisition here is reentrant. Attempt guards discover immutable project
 * identity before acquiring fences and retaining their request integrity lock.
 * All reads are separate statements after waits; the clock remains after reads.
 */
DO $commercial_writer_contract$
DECLARE
  installed_source text;
  relation_name text;
  trigger_name text;
  trigger_spec text;
  expected_arguments text;
BEGIN
  SELECT prosrc INTO installed_source FROM pg_proc
   WHERE oid = to_regprocedure('model_router_saas.saas_prepared_evidence_authorization_writer_fence()');
  IF installed_source IS DISTINCT FROM $expected_writer$${writerBody}$expected_writer$ THEN
    RAISE EXCEPTION 'Migration 053 matching 050 writer fence is missing or drifted';
  END IF;
  SELECT prosrc INTO installed_source FROM pg_proc
   WHERE oid = to_regprocedure('model_router_saas.saas_prepared_evidence_writer_lock_layer(text[])');
  IF installed_source IS DISTINCT FROM $expected_writer_layer$${writerLayerBody}$expected_writer_layer$ THEN
    RAISE EXCEPTION 'Migration 053 matching 050 exclusive lock helper is missing or drifted';
  END IF;
  SELECT prosrc INTO installed_source FROM pg_proc
   WHERE oid = to_regprocedure('model_router_saas.saas_reject_immutable_change()');
  IF installed_source IS DISTINCT FROM $expected_immutable$
BEGIN
  RAISE EXCEPTION 'SaaS records are immutable' USING ERRCODE = '55000';
END;
$expected_immutable$ THEN
    RAISE EXCEPTION 'Migration 053 immutable commercial fact function is missing or drifted';
  END IF;
  FOREACH trigger_spec IN ARRAY ARRAY[
    'saas_route_config_heads:saas_route_config_heads_prepared_evidence_authorization_fence',
    'saas_customer_metering_policy_heads:saas_customer_metering_policy_heads_pe_authz_fence',
    'saas_provider_metering_policy_heads:saas_provider_metering_policy_heads_pe_authz_fence'
  ] LOOP
    relation_name := split_part(trigger_spec, ':', 1);
    trigger_name := split_part(trigger_spec, ':', 2);
    expected_arguments := CASE relation_name
      WHEN 'saas_route_config_heads' THEN '(''project'', ''tenant_id'', ''project_id'')'
      WHEN 'saas_customer_metering_policy_heads' THEN '(''commercial'', ''customer'', ''tenant_id'', ''project_id'', ''policy_id'')'
      ELSE '(''commercial'', ''provider'', ''tenant_id'', ''project_id'', ''policy_id'')'
    END;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgrelid = to_regclass('model_router_saas.' || relation_name)
         AND tgname = trigger_name AND NOT tgisinternal AND tgenabled IN ('O', 'A')
         AND tgtype = 31
         AND tgfoid = to_regprocedure('model_router_saas.saas_prepared_evidence_authorization_writer_fence()')
         AND position(expected_arguments IN pg_get_triggerdef(oid)) > 0
    ) THEN
      RAISE EXCEPTION 'Migration 053 matching commercial head writer trigger is missing or drifted: %', trigger_spec;
    END IF;
  END LOOP;
  FOREACH relation_name IN ARRAY ARRAY[
    'saas_route_config_versions', 'saas_route_config_commercial_authorities',
    'saas_customer_metering_policy_versions', 'saas_provider_metering_policy_versions',
    'saas_contract_test_attestations', 'saas_customer_price_versions', 'saas_supplier_cost_versions'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgrelid = to_regclass('model_router_saas.' || relation_name)
         AND NOT tgisinternal AND tgenabled IN ('O', 'A') AND tgtype = 27
         AND tgfoid = to_regprocedure('model_router_saas.saas_reject_immutable_change()')
    ) THEN
      RAISE EXCEPTION 'Migration 053 immutable commercial fact guard is missing: %', relation_name;
    END IF;
  END LOOP;
END;
$commercial_writer_contract$;

${rewrites.map(({ name, original, rewritten }) => `DO $rewrite_${name}$
DECLARE
  function_oid regprocedure := to_regprocedure('model_router_saas.${name}()');
  installed_source text;
  definition text;
  expected_source constant text := $expected_source$${original}$expected_source$;
  replacement_source constant text := $replacement_source$${rewritten}$replacement_source$;
BEGIN
  SELECT prosrc, pg_get_functiondef(oid) INTO installed_source, definition FROM pg_proc WHERE oid = function_oid;
  IF installed_source IS DISTINCT FROM expected_source THEN
    RAISE EXCEPTION 'Migration 053 ${name} source is missing or drifted';
  END IF;
  EXECUTE replace(definition, expected_source, replacement_source);
  SELECT prosrc INTO installed_source FROM pg_proc WHERE oid = function_oid;
  IF installed_source IS DISTINCT FROM replacement_source THEN
    RAISE EXCEPTION 'Migration 053 ${name} rewrite changed an unapproved clause';
  END IF;
END;
$rewrite_${name}$;`).join('\n\n')}
`;

export const COMMERCIAL_AUTHORITY_READ_FENCES_SAAS_MIGRATION: SaasMigration = {
  version: 53,
  name: 'commercial_authority_read_fences',
  sql,
};
