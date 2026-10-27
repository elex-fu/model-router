# Fixed CPU quota diagnostic — explicit opt-in, not a performance release gate

This is the required follow-on comparison for the opt-in production bounded
worker feature. **Source and pure checks are not a completed benchmark.** Do not
run it until the exact source has passed ordinary CI and the native PG15/18,
Redis, TLS and compiled bounded-CLI correctness workflow, and the owner has
explicitly authorized the diagnostic. Publishing code does not authorize a run.

The separate `fixed-cpu-quota-diagnostic.yml` runs only on an **explicit opt-in**:
repository `elex-fu/model-router`, branch `perf/db-hotpath-20261026`, and the exact
head commit message `[run-fixed-cpu-quota]`. Ordinary pushes skip every diagnostic
job. Do not add this marker without the owner's execution authorization. Future
`workflow_dispatch` is also supported with the explicit authorization input, but
GitHub requires default-branch registration before that event is available;
branch-only publication is not assumed to make it dispatchable.

The diagnostic waits at most 15 minutes for `ci.yml` and
`fast-gateway-required.yml` on the **same checkout SHA** to finish successfully,
including both named native `bounded-two` PG15/18 jobs. It never waits on itself,
dispatches another workflow, or accepts an older green SHA. A failure or timeout
prevents container work. Ordinary CI runs only pure contracts and no-listener Go
helper compilation/tests with exact Go1.24.4 (`CGO_ENABLED=0`, no setup-go cache);
no Docker or timing job is added to ordinary push/PR CI.

## What is compared

Each selected profile/protocol runs exactly **single, bounded, bounded, single**
(ABBA), without selective reruns. A fresh database, Redis, wallet, key, namespace
and owners are provisioned for **every** arm. Both use the same full migrations,
locked dependencies, compiled production CLI and final Docker image ID. The
Docker build context is an exact `git archive` of the checked commit, not
untracked or ignored local files. The
single arm is the ordinary single-native-business gateway; bounded is the actual
production supervisor with two business children, not the older diagnostic
cluster. No production source is modified. Both arms use the same diagnostic startup
wrapper; its limited instrumentation and proof boundaries are described below.

| Aggregate contract | c32 | c200 |
|---|---:|---:|
| Driver concurrency | 32 | 200 |
| HTTP permits | 64 | 256 |
| Native PostgreSQL pool ceiling / role limit | 16 / 16 | 16 / 16 |
| Resident receipts / retained bytes / per tenant | 256 / 2 MiB / 64 | same |
| Receipt SQL lanes + durable-usage reconciliation lanes | 8 + 8 | same |
| Credit stripes | 8 | 8 |
| Maximum request reserve M / actual charge C | 524480 / 35 | same |
| Global wallet backing ceiling T | 67133440 | 268533760 |

The single control explicitly initializes migration147's durable **all-owner**
wallet cap under the wallet fence before startup. It does not compare an uncapped
legacy wallet with a capped bounded wallet. Its normal native journal still
allocates/settles/retires credit; no fabricated intents or receipts are inserted.
Bounded initializes that same ceiling through its production policy. Existing
native test fixtures accept an optional 64/256 concurrency input; their omitted
64/default behavior is unchanged. The built-in estimator remains in use.

Both protocols are supported: JSON and SSE, with a fixed 5 ms local TLS upstream,
10 input / 5 output tokens and native content/usage validation. There is no
Sub2api or external-provider comparison in this phase. This is a synthetic local
upstream qualification, not a public-model or cloud-KMS performance claim.

## Resource and network boundary

The app container has `--cpus=2 --memory=2g --memory-swap=2g`, encompassing its
primary, every business child and all native threads. The runner checks Docker
configuration and reads real cgroup-v2 `cpu.max`, `cpu.stat`, `memory.max`, usage,
peak, events and task lists **before any warm/timed requests** and around timing.
Missing files, unlimited quota, a ratio other than exactly 2 CPUs, or a memory
limit other than 2 GiB fail closed. Affinity is not treated as quota. No cgroup
files, host kernel configuration or security settings are modified.

PostgreSQL is separately capped at 2 CPUs / 2 GiB, `max_connections=32`,
`shared_buffers=128MB`, `fsync=on`, `synchronous_commit=on`, with a fresh owned
Docker volume (not tmpfs). Redis, TLS mock, network holder and helpers/driver each
have separate 1 CPU / 512 MiB bounds. Redis has 384 MiB `noeviction`, no AOF or
snapshots. The source pins PostgreSQL16.8, Redis7.4.2, Node22.16.0 and Go1.24.4
patch tags; the manifest records resolved image IDs/digests. One driver and mock
binary are built once with the pinned standard-library Go toolchain and reused
within the cohort. Tags are not represented as cross-time immutable digests.

Each arm creates an owned `--network=none` holder. All services and helpers join
**only that isolated network namespace**, with no published ports or connection
to a host listener. Their cgroups remain separate. The loopback-only fixture can
neither apply SQL to an unrelated host database nor send to an external provider.
The same runtime image runs as the invoking UID/GID so private bind-mounted files
remain readable to its owner. Containers are removed only after their full random run-token label and
captured immutable ID are verified; deletion uses that ID, never an unverified
intended name. A name collision leaves the foreign container untouched. Owned
anonymous volumes are removed with their containers; there is no host-wide
prune or port-owner eviction.

A fresh self-signed certificate is generated for each arm, valid for two days
and verified for its chain and `127.0.0.1` SAN plus at least the complete two-hour
cohort allowance. The public certificate, verification exit results, dates and
SHA256 are retained. The app uses `NODE_EXTRA_CA_CERTS`; neither Node nor the
client disables TLS verification. Redis startup quarantine is not bypassed.

## Native constructor and quiet-queue proof

A startup-only diagnostic observer is installed through the same entry/runtime
wrappers in both arms. It invokes the **original** constructors/factories;
`Reflect.construct(original, args, original)` preserves native prototype,
constructor, JavaScript-private and WeakMap identities. The actual native
journal and queue objects are the exact ones passed to the native executor.
It captures successful constructor calls with explicit scalar arguments (no
unknown/defaulted queue limit is accepted), native journal stripes/tranche,
actual owned native pool maxima, and the primary's actual local permit limit.

Queue `#limits` and HTTP closure state are not publicly introspectable. Their
proof is successful exact-original construction with validated explicit inputs,
plus hashes of the exact compiled implementation and startup call-graph modules;
it is **not** claimed to be private-field introspection or an environment echo.
The known queue implementation validates positive values without changing them,
and the HTTP composition captures the explicit limit unchanged. A changed or
unknown construction contract must fail proof rather than infer defaults.

All replaced exports and the runtime handle's original readiness descriptor are
restored on success and failure before warm traffic. The runtime loader retains
a bound readiness gate, but the pinned call graph invokes it only once during
startup, never on requests or periodic health checks. No request method, SQL,
receipt observer callback, transport, or timing hook is replaced. The sole
retained diagnostic handler takes an explicit read-only native queue snapshot
**outside timing**. Every request uses a fresh nonce and current PID/startTicks;
old files, PID reuse, wrong module/proof hashes and missing fields fail closed.

After real readiness and before the first bootstrap request, a separate process
proof validates the production state, primary PID1 and both known business child
identities, then records their thread membership in the same app cgroup. The
single arm proves PID1 and its native threads. The pre-readiness census alone is
not considered proof that all workers have been created.

## Measurement and evidence

- Exactly **10 JSON requests at c1, then 128 matched-protocol requests at c32**
  warm every arm (138 total, including SSE arms). Both raw files and all warm
  financial/token totals remain in evidence. Production Redis startup
  quarantine is separate and is not substituted for this warmup.
- Warm financial settlement, actual-TPM acknowledgement and actual native
  queue-zero checkpoints precede **at least 1 second of quiet**, followed by a
  fresh queue-zero checkpoint. No measured request starts before these proofs.
- c32 admits attempts for exactly **60 seconds**, using tested duration-only
  `n=0` semantics with **no count cap**. c200 requires **exactly 10000
  attempts**, with no duration override. The fixed 120-second driver deadline is
  a failure bound, never a successful shortened run. Every admitted attempt is
  retained, including timeouts and overload; there are no selective retries.
- The external driver directly writes admission/completion JSONL during its
  loop, retaining unfinished admitted attempts if killed before final JSON. This
  matched driver-side I/O is not subtracted from elapsed time or its CPU usage.
  The 512-MiB driver holds only numeric totals, not an unbounded sample slice or
  error map; final aggregate samples stream from that journal one record at a
  time. The host computes exact tails. Driver OOM/disk/deadline failures remain
  inconclusive, with already-written admission/completion events retained.
  Raw samples retain **every** status, transport/protocol error and latency.
  All-attempt and success-only p50/p95/p99/p999/max are reported separately.
  There is no overload exclusion, tail clipping, hidden retry or extrapolation.
- App CPU is the whole-cgroup delta, with throttled time/periods and memory
  events. Its enclosing interval includes driver-container startup, the request
  loop, driver report serialization, helper inspect/removal and host result
  copying/summary overhead; none is subtracted. It is explicitly **not** an
  exact request-loop-only CPU measure. Background/JIT/GC work inside remains.
- App memory peak is **container lifetime including startup/warmup**, not a
  fabricated interval-only peak. Outside service raw cgroup snapshots and Docker
  stats are separate. Driver `getrusage` reports its request-loop process CPU
  across threads and lifetime peak RSS observed at loop end (before later
  serialization); this is not a driver cgroup or post-loop peak.
- Full drain checks exact receipt/release identities, unchanged M, charge35,
  input10/output5, balanced ledger postings, wallet conservation, no unresolved
  work or legacy fallback, and counter == all-owner backing <= T. Independently,
  Redis lease receipts must be released/settled at actual15, concurrency slots
  zero, and current-window RPM/TPM buckets exact (not a fixed-minute reset).
- The app must exit with code0, without OOM; bounded final state must pass the production schema, deployment/budget
  identity checks and show both original child slots exited with code0, no
  signal and no forced termination.
  All historical allocations must be retired with backing0. Retained bounded
  owner claims must match the exact lifecycle proof below; no gateway-role
  PostgreSQL sessions may remain. Forced cleanup is not a
  graceful-exit proof. Raw mock send/completion/error counts must match all
  successful warm plus measured requests.

Missing required audit/constructor/queue/process/exit artifacts invalidate the
arm. Failed builds retain sanitized compiler output; failed arms preserve any
already-written raw attempts and audit files plus best-effort owned container,
cgroup, mock and production-state evidence **before** teardown. A failed arm
stops the cohort and requires
investigation. No successful earlier arms are selected into a passing result.
`comparison.json` retains every arm and emits descriptive bounded/single ratios
of arm-mean throughput and CPU/success only for a complete valid ABBA block; it
never averages away failed arms or pools quantiles. Its top-level cohort
conclusion stays `inconclusive` unless **every planned arm** is present and valid,
even if an earlier individual ABBA block has descriptive ratios. Even a fully valid cohort
sets `performanceAcceptance: false`: compare ABBA
replicates, throttling, overload and tails explicitly before making any gain
claim. The hosted runner's physical CPUs are shared with infrastructure; these
are enforced aggregate app quotas, **not** dedicated-core or production-capacity
claims. Replacement/failure correctness belongs to the earlier native workflow;
this steady-state timed diagnostic does not introduce a fault during timing.

## Plan, run and bounded cost

A plan is safe without Docker and performs no network/service work:

```sh
python3 scripts/performance/fixed_cpu_quota_runner.py \
  --profiles both --protocols both
```

For an owner-authorized CI run on the exact repository/branch above, the owner
publishes a commit whose **entire message** is `[run-fixed-cpu-quota]`. Push has
fixed defaults **both profiles × both protocols = 16 arms**; it does not read missing manual
inputs as empty values. Future registered manual dispatch allows c32, c200 or
both, and JSON, SSE or both, with `RUN_FIXED_CPU_DIAGNOSTIC`. The marker route never silently reduces this cohort to one profile; an
expired deadline remains incomplete rather than a smaller qualification. There are no replication, duration, endpoint, CPU or
resource-size escape hatches.

The single 135-minute job budgets at most 15 minutes for correctness waiting,
110 minutes for runner build/setup/cohort work and 10 minutes for cleanup/upload
and workflow overhead, with no matrix fan-out. It can incur up to 135 hosted
runner-minutes per explicit opt-in; artifact retention is 14 days. No ordinary
push starts a quota job. Expired deadlines are failures, never partial passes.

The CLI additionally requires `--execute --authorization RUN_FIXED_CPU_DIAGNOSTIC`
and `--native-correctness-sha <exact checkout SHA>`, and refuses dirty/untracked
source. The CLI SHA is an operator attestation; **the workflow** independently
checks GitHub's native results. Use the workflow, not a manually supplied SHA, as
the supported correctness-gated execution route.

Only the `quota-evidence` directory and safe exact-SHA correctness proof are uploaded. Private API keys, KMS keys,
signing/TLS private keys, environment files and raw gateway logs stay outside
that directory and are removed. Failed-arm assertion labels and safe accounting
facts remain. If Docker/cgroup/native sockets are unavailable, report that
boundary; do not substitute CPU affinity, a smoke test or host security changes.

## Validation status boundary

Pure Python/Node tests and formatting do not prove Go1.24.4 compilation, Docker
assembly, real cgroup enforcement, or a performance benefit. The ordinary CI Go
step and Docker build both compile/test the helpers with the pinned toolchain;
the actual diagnostic still requires native correctness and explicit execution
GO. No local smoke result or unmeasured resource claim substitutes for that run.

## Durable activation claims at clean stop

SQL slot `active` identifies a durable activation claim, not process liveness.
A clean bounded stop retains exactly its two original active claims until explicit
recovery proves the old processes and native sessions gone, then rotates/fences
the epochs. The diagnostic does not clear flags or rotate epochs during cleanup.

The ready and closed manifests must match exactly in generation, deployment,
policy, budgets, primary/child PID-start identities and both distinct epochs,
with no recovery history. Every policy, slot, owner, activation-history and
allocation-owner row in the fresh database is retained and compared: no missing,
extra, foreign or reused epoch is accepted. Both original children must have
exited normally. All allocation/backing/available/allocated resources and gateway
sessions still must be zero; money, actual TPM and native queue proofs remain
mandatory. Merely observing two active SQL rows is not sufficient.

The single control retains its exact two inactive seed slots and one native
namespace owner, with no activation history; its stopped identity snapshot must
match warmup. Safe allowlisted numeric finance and failure labels are also
printed in CI logs, never private keys, arbitrary exception text or raw bodies.
The failed attempt 2 remains unchanged and inconclusive. A corrected qualification
must run a fresh full 16-arm cohort, not splice completed arms from that attempt.
