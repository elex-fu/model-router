# Redis quota recovery repair (2026-10-25)

This is an offline source/test repair, not a deployment or a zero-loss HA claim.

## Recovery order

On Redis process identity change, a retained write-behind journal is replayed into SQL in its original generation under the bootstrap lease. SQL's per-row generation/version checks make duplicate and stale-snapshot replay idempotent. Only after SQL confirms every batch is the journal acknowledged atomically under the lease and exact metadata fence. Generation advancement and Redis reinitialization happen afterward. This ordering survives a lost SQL replay acknowledgement, partial replay, and a lost generation-commit reply without deleting unconfirmed evidence.

Malformed/gapped journals, unavailable SQL, lost bootstrap fences, or a pending journal from a different SQL generation refuse initialization. They must not silently discard evidence or reopen admission. A restored old disk snapshot with a pending journal from a prior SQL generation remains deliberately fail-closed: it cannot be safely merged using row version numbers from a different generation.

## Operational response to a generation mismatch

1. Keep affected gateway admission paused. Preserve the Redis journal and a consistent SQL snapshot; do not delete the Redis hash or edit generation numbers to force startup.
2. Have an authorized operator inspect namespace identity, SQL generation, Redis generation/head/tail, and all retained journal batches against durable request/usage records. Protect these snapshots as private operational data.
3. Restore a mutually consistent snapshot or perform an explicitly reviewed reconciliation. Only reopen admission after usage, reservations and live-request capacity have been checked. This repair does not supply an automatic cross-generation reconciliation tool.

## Remaining durability boundary

The hot path still acknowledges Redis mutations before SQL write-behind completes. If a mutation survives in neither Redis persistence nor SQL, no replay can reconstruct it. This repair prevents deletion of surviving journal evidence; it does not remove the existing write-behind RPO. Zero-loss acceptance would require a separately designed durable-acknowledgement contract or a fail-closed data-loss detection/reconciliation protocol, with corresponding latency/availability tradeoffs.

## Long-running requests

SaaS capacity is released only after the SQL request reaches a terminal state, or after an expired reservation is confirmed to have no corresponding SQL request. The ten-minute deadline is a scan hint, not execution-completion evidence. Existing canonical stale-admission/unknown-outcome recovery must establish the terminal result; unresolved unknown outcomes may conservatively retain capacity and need operational reconciliation. Recovery queries exclude live pending/unknown rows so they cannot starve terminal cleanup under LIMIT 100.

Standalone Redis admission uses at least ten minutes, extended to the configured request timeout plus cleanup grace. The proxy supplies that bound. Existing pre-repair reservations retain their old deadline; this change does not rewrite live production state.

## Validation

Tests use an owned loopback Redis server and temporary SQLite database, not a production service or paid model. Coverage includes unflushed snapshot recovery, newer SQL versus older snapshot, partial replay/lost commit ACK, generation mismatch fail-closed, lost generation reply, concurrent initializers, and long-request capacity retention. Full-system PostgreSQL/live-provider/disaster-recovery acceptance is separate.
