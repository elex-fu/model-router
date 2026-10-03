import { Buffer } from 'node:buffer';
import type { SaasMigration } from './001_initial_schema.js';
import { PLATFORM_WALLET_LEDGER_SAAS_MIGRATION } from './011_platform_wallet_ledger.js';
import { PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION } from './050_prepared_evidence_authorization_advisory_fences.js';

function historicalBody(sql: string, name: string): string {
  const marker = `CREATE FUNCTION ${name}(`;
  const start = sql.indexOf(marker);
  const bodyStart = start < 0 ? -1 : sql.indexOf('AS $$', start);
  const end = bodyStart < 0 ? -1 : sql.indexOf('\n$$;', bodyStart);
  if (start < 0 || bodyStart < 0 || end < 0 || sql.indexOf(marker, start + marker.length) >= 0) {
    throw new Error(`Migration 054 requires exactly one historical ${name} body`);
  }
  return sql.slice(bodyStart + 'AS $$'.length, end + 1);
}

const writerSql = PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql;
const ledgerSql = PLATFORM_WALLET_LEDGER_SAAS_MIGRATION.sql;
const targets = [
  'saas_prepared_evidence_authorization_writer_fence()',
  'saas_billing_check_ledger_transaction()',
  'saas_billing_check_ledger_entry_transaction()',
] as const;
const functions = [
  [targets[0], writerSql, 'trigger', 'v'],
  ['saas_prepared_evidence_writer_require_value(jsonb,text)', writerSql, 'text', 'i'],
  ['saas_prepared_evidence_writer_lock_layer(text[])', writerSql, 'void', 'v'],
  ['saas_prepared_evidence_writer_composite_key(jsonb,text,text[])', writerSql, 'text', 'i'],
  ['saas_billing_assert_ledger_transaction_balanced(uuid)', ledgerSql, 'void', 'v'],
  [targets[1], ledgerSql, 'trigger', 'v'],
  [targets[2], ledgerSql, 'trigger', 'v'],
  ['saas_billing_reject_ledger_mutation()', ledgerSql, 'trigger', 'v'],
] as const;

// Bind the elevated writer only to the complete, exact 050 trigger set,
// including binary TG_ARGV identities; no loosely matching trigger names.
const writerTriggers = [...writerSql.matchAll(
  /CREATE TRIGGER (saas_\w+)\n  BEFORE INSERT OR UPDATE OR DELETE ON (saas_\w+)\n  FOR EACH ROW EXECUTE FUNCTION saas_prepared_evidence_authorization_writer_fence\(([^;]+)\);/g,
)].map(([, name, relation, argumentsSql]) => {
  const args = [...argumentsSql!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
  if (args.length === 0 || args.map((arg) => `'${arg}'`).join(', ') !== argumentsSql) {
    throw new Error('Migration 054 writer trigger arguments drifted');
  }
  return { name: name!, relation: relation!, args, hex: args.map((arg) => `${Buffer.from(arg, 'utf8').toString('hex')}00`).join('') };
});
if (writerTriggers.length !== 28) throw new Error('Migration 054 requires all 28 historical writer triggers');

const bindings = [
  ...writerTriggers.map(({ name, relation, args, hex }) =>
    `('${relation}', '${name}', '${targets[0]}', 31, false, ${args.length}, '${hex}')`),
  `('saas_ledger_transactions', 'saas_ledger_transactions_balanced', '${targets[1]}', 5, true, 0, '')`,
  `('saas_ledger_entries', 'saas_ledger_entries_balanced', '${targets[2]}', 5, true, 0, '')`,
  `('saas_ledger_transactions', 'saas_ledger_transactions_immutable', 'saas_billing_reject_ledger_mutation()', 27, false, 0, '')`,
  `('saas_ledger_transactions', 'saas_ledger_transactions_no_truncate', 'saas_billing_reject_ledger_mutation()', 34, false, 0, '')`,
  `('saas_ledger_entries', 'saas_ledger_entries_immutable', 'saas_billing_reject_ledger_mutation()', 27, false, 0, '')`,
  `('saas_ledger_entries', 'saas_ledger_entries_no_truncate', 'saas_billing_reject_ledger_mutation()', 34, false, 0, '')`,
].join(',\n      ');
const expectedFunctions = functions.map(([signature, source, returnType, volatility]) => {
  const name = signature.slice(0, signature.indexOf('('));
  return `('${signature}', $expected_${name}$${historicalBody(source, name)}$expected_${name}$, '${returnType}', '${volatility}')`;
}).join(',\n      ');
const targetList = targets.map((signature) => `'${signature}'`).join(', ');

const sql = `
/* Forward-only metadata repair for confirmed nested-helper 42501 failures.
 * Only these three existing trigger wrappers execute as their trusted owner.
 * Their byte-identical bodies still derive identities solely from OLD/NEW and
 * verified TG_ARGV, keep 050's lock order, and enforce deferred ledger balance.
 * Helpers stay SECURITY INVOKER and non-callable by either application role.
 * No function/table/column grants, body replacements, or history rewrites.
 */
DO $trigger_only_trusted_execution$
DECLARE
  trusted_owner oid := to_regrole('model_router_saas_migrator');
  managed_schema oid := to_regnamespace('model_router_saas');
  expected record;
  routine record;
  binding record;
  target_signature text;
  target_oids oid[];
  all_function_oids oid[];
  function_catalog_before jsonb;
  function_catalog_after jsonb;
  table_acl_before jsonb;
  table_acl_after jsonb;
  column_acl_before jsonb;
  column_acl_after jsonb;
  trigger_catalog_before jsonb;
  trigger_catalog_after jsonb;
BEGIN
  IF trusted_owner IS NULL OR managed_schema IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE oid = trusted_owner
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication)
    OR NOT EXISTS (SELECT 1 FROM pg_namespace WHERE oid = managed_schema AND nspowner = trusted_owner)
    OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')) <> 2
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication
        OR pg_has_role(oid, trusted_owner, 'MEMBER') OR has_schema_privilege(oid, managed_schema, 'CREATE')))
    OR EXISTS (SELECT 1 FROM pg_namespace n,
      LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
      WHERE n.oid = managed_schema AND a.grantee <> trusted_owner AND a.privilege_type = 'CREATE')
  THEN
    RAISE EXCEPTION 'Migration 054 requires the non-superuser managed owner and non-owning runtime roles';
  END IF;

  FOR expected IN SELECT * FROM (VALUES
      ${expectedFunctions}
    ) AS contract(signature, source, return_type, volatility)
  LOOP
    SELECT p.*, l.lanname INTO routine FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = to_regprocedure('model_router_saas.' || expected.signature);
    IF NOT FOUND OR routine.proowner IS DISTINCT FROM trusted_owner
      OR routine.pronamespace IS DISTINCT FROM managed_schema
      OR routine.prosrc IS DISTINCT FROM expected.source OR routine.lanname IS DISTINCT FROM 'plpgsql'
      OR routine.prorettype IS DISTINCT FROM to_regtype('pg_catalog.' || expected.return_type)::oid
      OR routine.provolatile::text IS DISTINCT FROM expected.volatility
      OR routine.prokind <> 'f' OR routine.proretset OR routine.proisstrict OR routine.proleakproof
      OR routine.proparallel <> 'u' OR routine.pronargdefaults <> 0 OR routine.provariadic <> 0
      OR routine.prosupport <> 0 OR routine.prosecdef OR routine.proconfig IS NOT NULL
      OR NOT has_function_privilege(trusted_owner, routine.oid, 'EXECUTE')
    THEN
      RAISE EXCEPTION 'Migration 054 function owner/body/metadata drifted: %', expected.signature;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
      AND has_function_privilege(oid, routine.oid, 'EXECUTE'))
      OR EXISTS (SELECT 1 FROM aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner)))
        WHERE grantee = 0 AND privilege_type = 'EXECUTE')
    THEN
      RAISE EXCEPTION 'Migration 054 trigger/helper is directly executable by an application role or PUBLIC: %', expected.signature;
    END IF;
    all_function_oids := array_append(all_function_oids, routine.oid);
  END LOOP;

  SELECT array_agg(to_regprocedure('model_router_saas.' || signature)::oid ORDER BY signature)
    INTO target_oids FROM unnest(ARRAY[${targetList}]) AS target(signature);
  FOR binding IN SELECT * FROM (VALUES
      ${bindings}
    ) AS contract(relation_name, trigger_name, signature, trigger_type, deferred, argument_count, arguments_hex)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.oid = to_regclass('model_router_saas.' || binding.relation_name)
         AND c.relnamespace = managed_schema AND c.relowner = trusted_owner AND c.relkind = 'r'
         AND t.tgname = binding.trigger_name AND NOT t.tgisinternal AND t.tgenabled = 'O'
         AND t.tgfoid = to_regprocedure('model_router_saas.' || binding.signature)
         AND t.tgtype = binding.trigger_type AND t.tgdeferrable = binding.deferred
         AND t.tginitdeferred = binding.deferred AND (t.tgconstraint <> 0) = binding.deferred
         AND t.tgnargs = binding.argument_count AND t.tgargs = decode(binding.arguments_hex, 'hex')
         AND t.tgqual IS NULL AND t.tgattr::text = ''
    ) OR EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
        AND has_table_privilege(oid, to_regclass('model_router_saas.' || binding.relation_name), 'TRIGGER')
    ) THEN
      RAISE EXCEPTION 'Migration 054 exact trusted trigger binding drifted: %.%', binding.relation_name, binding.trigger_name;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE tgfoid = ANY(target_oids)) <> 30 THEN
    RAISE EXCEPTION 'Migration 054 elevated wrapper has an unexpected trigger attachment';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'model_router_saas_gateway'
    AND has_any_column_privilege(oid, 'model_router_saas.saas_api_keys', 'UPDATE')) THEN
    RAISE EXCEPTION 'Migration 054 requires gateway API-key UPDATE to remain forbidden';
  END IF;

  SELECT jsonb_agg(to_jsonb(p) - 'prosecdef' - 'proconfig' ORDER BY p.oid)
    INTO function_catalog_before FROM pg_proc p WHERE p.oid = ANY(all_function_oids);
  SELECT jsonb_agg(jsonb_build_array(c.oid, c.relowner, c.relacl) ORDER BY c.oid)
    INTO table_acl_before FROM pg_class c WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(jsonb_build_array(a.attrelid, a.attnum, a.attacl) ORDER BY a.attrelid, a.attnum)
    INTO column_acl_before FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relnamespace = managed_schema AND a.attnum > 0 AND NOT a.attisdropped;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) INTO trigger_catalog_before
    FROM pg_trigger t WHERE t.tgfoid = ANY(all_function_oids);

  FOREACH target_signature IN ARRAY ARRAY[${targetList}] LOOP
    EXECUTE format('ALTER FUNCTION model_router_saas.%s SECURITY DEFINER', target_signature);
    EXECUTE format('ALTER FUNCTION model_router_saas.%s SET search_path TO pg_catalog, model_router_saas, pg_temp', target_signature);
  END LOOP;

  SELECT jsonb_agg(to_jsonb(p) - 'prosecdef' - 'proconfig' ORDER BY p.oid)
    INTO function_catalog_after FROM pg_proc p WHERE p.oid = ANY(all_function_oids);
  SELECT jsonb_agg(jsonb_build_array(c.oid, c.relowner, c.relacl) ORDER BY c.oid)
    INTO table_acl_after FROM pg_class c WHERE c.relnamespace = managed_schema;
  SELECT jsonb_agg(jsonb_build_array(a.attrelid, a.attnum, a.attacl) ORDER BY a.attrelid, a.attnum)
    INTO column_acl_after FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relnamespace = managed_schema AND a.attnum > 0 AND NOT a.attisdropped;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) INTO trigger_catalog_after
    FROM pg_trigger t WHERE t.tgfoid = ANY(all_function_oids);
  IF function_catalog_after IS DISTINCT FROM function_catalog_before
    OR table_acl_after IS DISTINCT FROM table_acl_before OR column_acl_after IS DISTINCT FROM column_acl_before
    OR trigger_catalog_after IS DISTINCT FROM trigger_catalog_before
    OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = ANY(all_function_oids) AND (
      p.prosecdef IS DISTINCT FROM (p.oid = ANY(target_oids))
      OR (p.oid = ANY(target_oids) AND p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, model_router_saas, pg_temp'])
      OR (NOT p.oid = ANY(target_oids) AND p.proconfig IS NOT NULL)
      OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('model_router_saas_control_plane', 'model_router_saas_gateway')
        AND has_function_privilege(r.oid, p.oid, 'EXECUTE'))
    ))
  THEN
    RAISE EXCEPTION 'Migration 054 changed body/ACL/trigger binding or exceeded its three-wrapper metadata contract';
  END IF;
END;
$trigger_only_trusted_execution$;
`;

export const TRIGGER_ONLY_TRUSTED_EXECUTION_SAAS_MIGRATION: SaasMigration = {
  version: 54,
  name: 'trigger_only_trusted_execution',
  sql,
};
