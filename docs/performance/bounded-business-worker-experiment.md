# Bounded business-worker experiment (diagnostic only)

This opt-in **test harness**, not a deployment supervisor, compares one business
process with two behind the same Node cluster RR primary and public endpoint.
It changes no production source or default. It promises no performance gain.

## Validated synthetic fixture profiles

`--profile c32` is the unchanged default: 60 seconds at concurrency 32, shared
policy/aggregate local HTTP cap 64 and automatic target 67,133,440. Opt-in
`--profile c200` runs **exactly 10,000 requests at concurrency 200**, with cap
256 and target 268,533,760. The target is derived as `2 × M524480 × cap`.
Only these two named profiles are accepted; JS and Python load the same
`bounded-business-profiles.json`. No arbitrary concurrency, duration, cap or
target overrides are accepted. Every finite c200 attempt and its latency,
including the initial c200 tail, remains in the result.

## Fixed aggregate budgets within each profile

| Resource | One business process | Each of two business processes |
| --- | ---: | ---: |
| Configured PostgreSQL maximum | 16 | 8 |
| Actual gateway / quota pool maxima | 14 + 2 | 6 + 2 |
| Local HTTP in-flight cap, c32 / c200 | 64 / 256 | 32 / 128 |
| Receipt entries / accounted bytes / per tenant | 256 / 2 MiB / 64 | 128 / 1 MiB / 32 |
| Receipt SQL workers / Redis-reconciliation workers | 8 / 8 | 4 / 4 |
| Credit stripes | 8 | 4 |
| Automatic credit target, c32 / c200 | 67,133,440 / 268,533,760 | 33,566,720 / 134,266,880 |

Redis namespace and tenant/project/key/account policy caps (64 for c32, 256 for
c200) stay shared, not multiplied. There is no separate deployment-global Redis
counter. The summed local HTTP cap equals the selected profile cap. The request's
`max_tokens=64` and aggregate receipt per-tenant limit 64 do **not** change with
the profile. Queue counts include running/retrying entries in both
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
node --test scripts/performance/bounded-business-cluster.test.cjs scripts/performance/bounded-business-capacity-probe.test.cjs
python3 -m unittest discover -s scripts/performance -p 'bounded_business_*_test.py'
node --import tsx --test tests/ci/bounded-business-diagnostic-gates.test.ts
```

The runner requires the separately qualified, **hash-pinned GEN17 local harness**
and unchanged client binary. It generates a newly named adapter; historical
launchers/results are not overwritten. No dependencies or service data are
downloaded or copied by this harness. Supply actual local paths, frozen commit,
unique label, and an approved quiet-window generation:

```sh
python3 scripts/performance/bounded_business_performance_pilot.py \
  --execute --harness "$HARNESS" --source "$SOURCE" --expected-source "$COMMIT" \
  --label bounded-business-pilot-UNIQUE --generation "$GENERATION" \
  --client "$UNCHANGED_CLIENT" --workers 2 --scene qualification --pending-term
```

Append `--profile c200` for the c200 profile; omitting it preserves c32. Run
untimed qualification separately for 1 and 2 workers **for the selected profile**
before authorizing timed scenes. Warm remains 10 bootstrap + 128 c32 requests,
never a c200 warmup, with actual completed work
on every owner, exact fees/usage, financial and TPM drain, and a 1s minimum gap.
Ordinary qualification adds 256 JSON at the selected profile's concurrency and
32 SSE at c32 in both arms, checking complete native terminals and the same
usage/fees. The pending-TERM
qualification briefly holds a disposable receipt-table SHARE
lock: 32 paid clients complete while their durable intents retain M and receipts
remain queued. Native snapshots and owner census prove pending work before
TERM; both children must stay alive until explicit rollback, then exit
naturally with exact ledger/receipt/job/TPM reconciliation. Rollback occurs in
`finally`; the normal receipt timeout and financial policy are not relaxed.
Separate mock counter boundaries cover ordinary JSON, SSE and held requests;
a pre-warm to post-shutdown counter proof covers the whole fresh fixture,
including any late sends. This added proof is prospective: original GEN32/33
artifacts lack a separate held-work mock delta and must not be relabeled as
proving upstream-send uniqueness for all 458 qualification requests.

Timed `--scene timed` runs use the unchanged client and the selected fixed load
(c32/60s or finite 10,000/c200), and forbid `--pending-term`. Report client EOF and
client-plus-financial/TPM-drain endpoints,
all statuses, per-owner work, summed business CPU and separate primary CPU.
Repeat/reverse fresh-fixture arms before drawing conclusions. A profile's
nonidle share and process CPU above one core do not prove spare CPU quota or
multicore speedup. No sub2api or production-capacity claim follows from this test.

### Opt-in HTTP-cap rejection diagnosis

`--profile c200 --workers 2 --scene timed --capacity-diagnostic` enables a
strict SHA-256-pinned, startup-only compiled-module transform. Application source
and normal runs are unchanged; the module loader is restored immediately after
loading the target. HTTP stays 128 per child / 256 total, with all financial,
receipt, tenant, pool and worker budgets unchanged. Do not compare instrumented
throughput with ordinary runs.

The probe retains at most 128 accepted-but-unsettled response/socket references
per child and 128 aggregate rejection samples; settlement or synchronous throw
removes each retained reference. Samples include the native counter/limit,
closing flag, PID/monotonic timestamp, ended/finished responses and unique
sockets. The native local `Server._connections` count is reported when available.
Server end/finish is not client EOF, and boundary snapshots are not simultaneous
cross-worker occupancy evidence. No body, credential or per-request log is added.

Only exact `GATEWAY_CAPACITY_EXHAUSTED` 429s may continue this diagnostic through
success-only financial/TPM/mock and post-shutdown proofs. Every attempt remains
in the client artifact, `passed=false` and `performance_acceptance=false` always
for this instrumentation. Successful collection can exit zero with
`diagnostic_collection_complete=true` while the experiment remains failed;
unknown errors or incomplete cleanup still fail collection. Before/after/final
probe artifacts preserve sample drops and invariant violations. Historical
failed experiments must never be relabeled as passes.


## Opt-in serial protocol diagnostics

`--profile serial-json` and `--profile serial-sse` require `--workers 1 --scene timed`.
Each retains all 1000 native-client attempts at c1 (including the first request and all tails),
with the same c32 HTTP cap64/T67133440, PG pool16, queue256/2MiB/per-tenant64, phase8+8 and8 stripes.
Warm remains 10 JSON bootstrap plus 128 protocol-matched c32 requests, real finance/TPM drain
and at least 1 second quiet gap. SSE uses the unchanged native client's `-stream` terminal
validation; JSON does not. Source/runtime pins and shared generation admission remain required.
No inference observer, CPU profiler, capacity probe or queue sampler is installed. Existing
all-attempt, fee35, actual15 tokens, whole-fixture mock, postshutdown finance/TPM and native
owned-process cleanup checks apply unchanged (1138 total successful requests per fixture).
These are diagnostics, not a new performance-acceptance gate or the legacy pilot-six plan.
The original c32/c200 plans and budget definitions are unchanged. Use the same diagnostic
runner revision for baseline/candidate; the application supplied by `--source` is independently pinned.
