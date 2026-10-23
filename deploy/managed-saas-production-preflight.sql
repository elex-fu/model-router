-- READ ONLY. Run on the writable endpoint using each actual workload login.
-- psql uses PG* environment / private service+pass files, never URL argv.
-- This observes current state only; it cannot attest failure-domain placement,
-- fencing or future durability, and does not grant charging admission.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
DO $$
BEGIN
  IF pg_is_in_recovery() THEN RAISE EXCEPTION 'preflight: writable primary required'; END IF;
  IF current_setting('fsync') <> 'on' OR current_setting('full_page_writes') <> 'on'
    OR current_setting('synchronous_commit') NOT IN ('on', 'remote_apply') THEN
    RAISE EXCEPTION 'preflight: durable synchronous commit settings required';
  END IF;
  IF current_setting('synchronous_standby_names') = '' THEN
    RAISE EXCEPTION 'preflight: synchronous target missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_stat_replication
    WHERE state = 'streaming' AND sync_state IN ('sync', 'quorum') AND flush_lsn IS NOT NULL) THEN
    RAISE EXCEPTION 'preflight: no visible synchronous streaming WAL flush peer';
  END IF;
END $$;
SELECT 'observed_primary_sync_flush_only_not_production_admission' AS result;
ROLLBACK;
