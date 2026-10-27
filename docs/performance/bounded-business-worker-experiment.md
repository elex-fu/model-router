# Bounded business-worker experiment (diagnostic only)

This opt-in **test harness**, not a deployment supervisor, compares one business
process with two behind the same Node cluster RR primary and public endpoint.
It changes no production source or default. It promises no performance gain.

## Fixed synthetic fixture budgets

| Resource | One business process | Each of two business processes |
| --- | ---: | ---: |
| Configured PostgreSQL maximum | 16 | 8 |
| Actual gateway / quota pool maxima | 14 + 2 | 6 + 2 |
| Local HTTP in-flight cap | 64 | 32 |
| Receipt entries / accounted bytes / per tenant | 256 / 2 MiB / 64 | 128 / 1 MiB / 32 |
| Receipt SQL workers / Redis-reconciliation workers | 8 / 8 | 4 / 4 |
| Credit stripes | 8 | 4 |
| Automatic credit target, fixed M=524,480 | 67,133,440 | 33,566,720 |

Redis namespace and tenant/project/key/account policy caps of 64 stay shared, not
multiplied. There is no separate deployment-global Redis counter. The summed
local HTTP cap is 64. Queue counts include running/retrying entries in both
phases. Max age 5s and native drain timeout 10s remain unchanged.

The target is **not a lifetime aggregate escrow guarantee** across crashes or
restarts. Retired unresolved liabilities stay backed; new epochs may receive
new wallet-backed allocations. Only a fresh fixed-M fixture, exactly the
declared owners and epochs, and **no respawn or rolling replacement** qualify.
The runner checks all active and retired backing, never frees it by TTL, and
never clears Redis to repair an active run. CPU and RAM may increase. Two
journal pollers replace one; PG business/quota lane allocation also changes.
Per-process queue/HTTP/credit partitions may strand capacity under traffic skew.
Node's internal socket-handoff backlog is not a production bounded queue.

## Startup and shutdown proof

`bounded-business-cluster.cjs` imports only built-ins and its diagnostic helpers.
It gives every business child a distinct stable owner, starts slot 0 before
slot 1, and never respawns. `bounded-business-worker.cjs` uses startup-only native
constructor Proxies to observe actual PG maxima, receipt queue limits, executor
local cap, and the composition HTTP cap. Native prototypes are preserved; the
exports are restored before warm traffic. There are no timed request, SQL,
driver-promise, or queue-observer callbacks.

Each child probes its **own real gateway `/readyz` handler** through a private
exclusive loopback readiness-only listener, then closes that listener before
publishing proof. A common public-port health response alone cannot prove both
children are ready. A primary SIGHUP requests one native aggregate queue
snapshot from each child; it neither resets counters nor samples continuously.
Snapshots provide no histograms or percentiles.

The original application's signal handlers own request handoff, receipt drain,
journal drain/retirement, and dependency closure. The primary waits for every
child. A crash, missing proof, timeout, forced kill, or observation-write failure
fails the scene; none is reported as graceful completion.

## Checks and execution

Linux `/proc` is required for PID/start-identity ownership checks. Offline
checks (also wired into the existing CI build/test job):

```sh
node --test scripts/performance/bounded-business-cluster.test.cjs
python3 -m unittest discover -s scripts/performance -p 'bounded_business_*_test.py'
node --import tsx --test tests/ci/bounded-business-diagnostic-gates.test.ts
```

The runner requires the separately qualified, **hash-pinned GEN17 local harness**
and unchanged c32 client. It generates a newly named adapter; historical
launchers/results are not overwritten. No dependencies or service data are
downloaded or copied by this harness. Supply actual local paths, frozen commit,
unique label, and an approved quiet-window generation:

```sh
python3 scripts/performance/bounded_business_performance_pilot.py \
  --execute --harness "$HARNESS" --source "$SOURCE" --expected-source "$COMMIT" \
  --label bounded-business-pilot-UNIQUE --generation "$GENERATION" \
  --client "$UNCHANGED_CLIENT" --workers 2 --scene qualification --pending-term
```

Run untimed qualification separately for 1 and 2 workers before authorizing timed
scenes. Warm remains 10 bootstrap + 128 c32 requests, with actual completed work
on every owner, exact fees/usage, financial and TPM drain, and a 1s minimum gap.
Ordinary qualification adds 256 JSON and 32 SSE requests in both arms, checking
complete native terminals and the same usage/fees. The pending-TERM
qualification briefly holds a disposable receipt-table SHARE
lock: 32 paid clients complete while their durable intents retain M and receipts
remain queued. Native snapshots and owner census prove pending work before
TERM; both children must stay alive until explicit rollback, then exit
naturally with exact ledger/receipt/job/TPM reconciliation. Rollback occurs in
`finally`; the normal receipt timeout and financial policy are not relaxed.

Timed `--scene timed` runs use the unchanged c32/60s client and forbid
`--pending-term`. Report client EOF and client-plus-financial/TPM-drain endpoints,
all statuses, per-owner work, summed business CPU and separate primary CPU.
Repeat/reverse fresh-fixture arms before drawing conclusions. A profile's
nonidle share and process CPU above one core do not prove spare CPU quota or
multicore speedup. No sub2api or production-capacity claim follows from this test.
