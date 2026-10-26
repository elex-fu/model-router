# Evaluation-only PostgreSQL lock-window observer

This preload is **not production instrumentation** and adds no SQL, grants or locks. Use it only in a separately labeled diagnostic pass; keep all comparative latency/RPS passes uninstrumented.

```sh
NODE_OPTIONS="--require /absolute/repository/scripts/ops/pg-lock-window-observer.cjs" \
MODEL_ROUTER_BENCH_LOCK_WINDOWS_FILE=/private/evaluation/lock-windows.json \
node dist/cli/index.js start --role gateway
```

Enable these variables on the **gateway child only**, not migration or seeding processes. The same observer can instrument both reference and candidate sources, including anonymous and named prepared-query configs. It observes `pg.Client.prototype.query`; the original SQL/config, values, returned Promise, callback result/context and original failures remain unchanged.

## Phase boundaries

1. Warm the gateway, then drain all warmup requests/settlements.
2. Send **SIGWINCH** to the gateway PID to reset the measurement epoch. Do not use SIGUSR1: Node reserves it for the inspector.
3. Run the diagnostic load; drain all requests/settlements.
4. Send **SIGUSR2** to write a cumulative snapshot. It coexists with the existing prepared-statement census listener. Copy the snapshot to the phase's result filename before another reset. Process exit writes a final snapshot too.

Transactions spanning a reset are excluded from committed windows and counted as `resetCrossingTransactions`; `activeTransactions` shows unfinished explicit transactions. Savepoint/repeated-BEGIN transactions cannot establish a reliable continuous hold interval and do not contribute hold-window samples. If the process terminates without an exit event, use the explicit SIGUSR2 snapshot.

## Definitions — do not conflate these measurements

- `acquiredToCommitAckMs`: **first successful acquisition-query completion → successful COMMIT acknowledgement**, on the same pg.Client. The lock can be acquired before query completion and released before acknowledgement. This is a **completion-to-acknowledgement proxy**, not exact server hold time or a strict bound: it excludes intra-query hold time and includes post-release acknowledgement latency.
- `acquisitionQueryElapsedMs`: **Client.query invocation → successful query completion**. It includes the pg client queue, transport, server execution/lock waiting and decoding. It is **not pure PostgreSQL lock wait**. Use an independent admin-side `pg_stat_activity` / `pg_locks` sampler for actual wait events.
- `queries.successfulElapsedMs` / `queries.failedElapsedMs`: elapsed distributions for **all** Client.query calls in the epoch, including queries outside transactions. These contain no query text/labels or connection identities.
- `transactions.committedDurationMs` / `rolledBackDurationMs`: successful **BEGIN acknowledgement → terminal acknowledgement**, tracked on each client and emitted as aggregate distributions.
- `transactions.committedQueryElapsedTotalMs` / `rolledBackQueryElapsedTotalMs`: per-transaction summed query elapsed, excluding BEGIN and including the terminal query. Corresponding `*QueryCount` fields are total query counts in these transactions. Queued/concurrent Client.query intervals can overlap, so **transaction duration minus summed query elapsed is not an exact application-gap measurement**.
- Domains are `accountCounter` (the admission account-rate UPSERT) and `walletFence` (the canonical wallet advisory-fence query). Only the first successful acquisition in a domain starts its transaction window; repeat calls are counted separately.
- COMMIT failures/ambiguity never become committed windows. PostgreSQL's successful COMMIT command returning `ROLLBACK` is counted as rollback. Rollback windows are separate.
- The two domains overlap within transactions, and concurrent transactions overlap each other. Their sums describe contention exposure: **never sum them as wall time or CPU time**.
- Quantiles are exact nearest-rank over the first100000 observations by default. Counts/sums/min/max include every observation. `quantilesTruncated` identifies prefix truncation; do not interpret truncated quantiles as a representative sample.

The JSON contains only fixed labels, numeric aggregates and these definitions—never SQL, bound parameters, account/tenant/wallet identities, payloads or credentials. Output uses mode0600. Signal dumping and reset occur outside primary timing windows. Diagnostic installation does add JavaScript work and must be symmetric when comparing its measurements.
