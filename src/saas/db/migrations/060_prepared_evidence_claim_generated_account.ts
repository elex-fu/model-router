import type { SaasMigration } from './001_initial_schema.js';
import { PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION } from './028_prepared_request_evidence_pool_claim_hardening.js';
import { PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION } from './050_prepared_evidence_authorization_advisory_fences.js';

const signature = 'saas_attempts_guard_prepared_evidence_claim_pool()';
function betweenOnce(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = start < 0 ? -1 : source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || source.indexOf(startMarker, start + startMarker.length) !== -1) {
    throw new Error('060 requires the exact 028/050 claim-pool guard lineage');
  }
  return source.slice(start + startMarker.length, end);
}
function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error('060 claim-pool guard anchor drifted');
  return source.replace(before, after);
}

const historical = betweenOnce(PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION.sql,
  `CREATE OR REPLACE FUNCTION ${signature} RETURNS trigger\nLANGUAGE plpgsql AS $$`, '\n$$;') + '\n';
const fences = PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql;
const poolRead = betweenOnce(fences, '  pool_read_anchor constant text := $pool_read_anchor$', '$pool_read_anchor$;');
const poolFence = betweenOnce(fences, '  pool_fence_preamble constant text := $pool_fence_preamble$', '$pool_fence_preamble$;');
if (!fences.includes("rewritten_definition := replace(claim_definition, pool_read_anchor, pool_fence_preamble || replace(pool_read_anchor, 'FOR SHARE;', ';'));")) {
  throw new Error('060 requires the unchanged 050 claim-pool rewrite');
}

/** Exact prosrc installed by 028 followed by the one 050 pool-reader rewrite. */
export const PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE = replaceOnce(
  historical, poolRead, poolFence + replaceOnce(poolRead, 'FOR SHARE;', ';'),
);
export const PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE = replaceOnce(
  PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE,
  '      OR evidence_record.account_id IS DISTINCT FROM NEW.account_id\n',
  '      OR evidence_record.account_id IS DISTINCT FROM NEW.platform_account_id\n',
);
const updateColumns = [
  'prepared_evidence_id', 'dispatch_state', 'dispatch_authority_state',
  'provider_id', 'product_id', 'pool_id', 'pool_authz_version',
] as const;

/** Staged only: no registry/export integration or business-row rewrite. */
export const PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION: SaasMigration = {
  version: 60,
  name: 'prepared_evidence_claim_generated_account',
  sql: `
DO $prepared_evidence_claim_generated_account$
DECLARE
  owner_id oid := pg_catalog.to_regrole('model_router_saas_migrator');
  schema_id oid := pg_catalog.to_regnamespace('model_router_saas');
  attempt_table oid := pg_catalog.to_regclass('model_router_saas.saas_attempts');
  evidence_table oid := pg_catalog.to_regclass('model_router_saas.saas_prepared_request_evidence');
  guard_id oid := pg_catalog.to_regprocedure('model_router_saas.${signature}');
  routine record;
  metadata_before jsonb;
  metadata_after jsonb;
  bindings_before jsonb;
  bindings_after jsonb;
  relations_before jsonb;
  relations_after jsonb;
BEGIN
  IF current_user IS DISTINCT FROM 'model_router_saas_migrator' OR session_user IS DISTINCT FROM current_user
    OR owner_id IS NULL OR schema_id IS NULL OR attempt_table IS NULL OR evidence_table IS NULL OR guard_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid = owner_id
      AND NOT rolsuper AND NOT rolinherit AND NOT rolbypassrls AND NOT rolcreaterole
      AND NOT rolcreatedb AND NOT rolreplication)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE oid = schema_id AND nspowner = owner_id)
    OR (SELECT count(*) FROM pg_catalog.pg_class WHERE oid IN (attempt_table, evidence_table)
      AND relnamespace = schema_id AND relowner = owner_id AND relkind = 'r' AND relpersistence = 'p'
      AND NOT relispartition AND NOT relrowsecurity AND NOT relforcerowsecurity) <> 2 THEN
    RAISE EXCEPTION '060 requires the trusted managed schema owner and original claim relations' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE model_router_saas.saas_attempts, model_router_saas.saas_prepared_request_evidence IN ACCESS EXCLUSIVE MODE;
  SELECT * INTO routine FROM pg_catalog.pg_proc WHERE oid = guard_id;
  IF routine.prosrc IS DISTINCT FROM $expected_claim_guard$${PREPARED_EVIDENCE_CLAIM_ACCOUNT_EXPECTED_SOURCE}$expected_claim_guard$
    OR routine.proowner <> owner_id OR routine.pronamespace <> schema_id
    OR routine.prosecdef OR routine.proconfig IS NOT NULL
    OR routine.prorettype <> 'pg_catalog.trigger'::regtype OR routine.pronargs <> 0 OR routine.prokind <> 'f'
    OR routine.proretset OR routine.proisstrict OR routine.proleakproof OR routine.provolatile <> 'v'
    OR routine.proparallel <> 'u' OR routine.pronargdefaults <> 0 OR routine.provariadic <> 0 OR routine.prosupport <> 0
    OR routine.prolang <> (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
    OR (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgfoid = guard_id) <> 1
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = attempt_table
      AND t.tgname = 'saas_attempts_guard_prepared_evidence_claim_pool' AND t.tgfoid = guard_id
      AND t.tgtype = 23 AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgqual IS NULL
      AND t.tgnargs = 0 AND t.tgargs = pg_catalog.decode('', 'hex') AND t.tgconstraint = 0
      AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgparentid = 0
      AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND t.tgattr::text = pg_catalog.array_to_string(ARRAY(SELECT a.attnum
        FROM pg_catalog.unnest(ARRAY[${updateColumns.map((name) => `'${name}'`).join(', ')}]::text[])
          WITH ORDINALITY cols(name, position)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = attempt_table AND a.attname = cols.name
          AND a.attnum > 0 AND NOT a.attisdropped ORDER BY cols.position), ' ')
      AND (SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid = attempt_table
        AND attname = ANY(ARRAY[${updateColumns.map((name) => `'${name}'`).join(', ')}]::text[])
        AND attnum > 0 AND NOT attisdropped) = ${updateColumns.length}) THEN
    RAISE EXCEPTION '060 exact 050 claim-pool body or trigger binding drifted' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid = attempt_table
      AND attname IN ('account_owner_kind', 'tenant_account_id', 'platform_account_id')
      AND atttypid = 'pg_catalog.text'::regtype AND attgenerated = '' AND NOT attisdropped) <> 3
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_attrdef d
        ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = attempt_table AND a.attname = 'account_id' AND a.attgenerated = 's'
        AND a.atttypid = 'pg_catalog.text'::regtype AND NOT a.attisdropped
        AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '[[:space:]]+', '', 'g') =
          $account_expression$CASEWHEN(account_owner_kind=ANY(ARRAY['tenant'::text,'platform'::text]))THENCOALESCE(tenant_account_id,platform_account_id)ELSENULL::textEND$account_expression$) THEN
    RAISE EXCEPTION '060 owner-specific account projection drifted' USING ERRCODE = '55000';
  END IF;

  SELECT pg_catalog.to_jsonb(p) - 'prosrc' INTO metadata_before FROM pg_catalog.pg_proc p WHERE oid = guard_id;
  SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) INTO bindings_before
    FROM pg_catalog.pg_trigger t WHERE t.tgrelid IN (attempt_table, evidence_table);
  SELECT pg_catalog.jsonb_build_object(
    'acl', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c.oid, c.relowner, c.relacl) ORDER BY c.oid)
      FROM pg_catalog.pg_class c WHERE c.oid IN (attempt_table, evidence_table)),
    'columns', (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid, a.attnum)
      FROM pg_catalog.pg_attribute a WHERE a.attrelid IN (attempt_table, evidence_table)),
    'constraints', (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid)
      FROM pg_catalog.pg_constraint c WHERE c.conrelid IN (attempt_table, evidence_table))) INTO relations_before;

  EXECUTE $claim_guard_ddl$CREATE OR REPLACE FUNCTION model_router_saas.${signature}
    RETURNS trigger LANGUAGE plpgsql AS $fixed_claim_guard$${PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE}$fixed_claim_guard$$claim_guard_ddl$;

  SELECT pg_catalog.to_jsonb(p) - 'prosrc' INTO metadata_after FROM pg_catalog.pg_proc p WHERE oid = guard_id;
  SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) INTO bindings_after
    FROM pg_catalog.pg_trigger t WHERE t.tgrelid IN (attempt_table, evidence_table);
  SELECT pg_catalog.jsonb_build_object(
    'acl', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c.oid, c.relowner, c.relacl) ORDER BY c.oid)
      FROM pg_catalog.pg_class c WHERE c.oid IN (attempt_table, evidence_table)),
    'columns', (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid, a.attnum)
      FROM pg_catalog.pg_attribute a WHERE a.attrelid IN (attempt_table, evidence_table)),
    'constraints', (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid)
      FROM pg_catalog.pg_constraint c WHERE c.conrelid IN (attempt_table, evidence_table))) INTO relations_after;
  IF metadata_after IS DISTINCT FROM metadata_before OR bindings_after IS DISTINCT FROM bindings_before
    OR relations_after IS DISTINCT FROM relations_before
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid = guard_id
      AND prosrc = $installed_claim_guard$${PREPARED_EVIDENCE_CLAIM_ACCOUNT_SOURCE}$installed_claim_guard$) THEN
    RAISE EXCEPTION '060 exceeded its single claim-account comparison contract' USING ERRCODE = '55000';
  END IF;
END;
$prepared_evidence_claim_generated_account$;
`,
};
