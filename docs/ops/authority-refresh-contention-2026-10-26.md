# Authority 503: stale runtime-health refresh contention

## Cause and reproduction

At base `c07d26bd88446bb53ef9c65da89ea69c67eb0d62`, a quiet period longer than the existing 30-second health freshness window makes the next concurrent scheduling wave race for the same per-account half-open probe. Every request initially sees stale health. The durable CAS admits one probe, but losing requests immediately deny that account, even if the winning refresh is about to finish. When all candidates lose this race, the scheduler returns `authority/capability_unavailable` (HTTP 503).

This was isolated with temporary, bounded diagnostic instrumentation: fixed source locations, exception categories and SQLSTATE only; no raw exceptions, parameters, credentials or request content. The clean failing run emitted no scheduler exceptions. The sampled probe branches were stale-view CAS losses; all 196 authority blocks came from the empty-candidate/durable-health-denied branch, not a catch-all storage exception. Diagnostic instrumentation is **not** included in the fix.

Disposable local fixture: PostgreSQL 18, Redis 7.4.2, four synthetic provider accounts, aggregate tenant/project/API concurrency 64, gateway DB pool 16, the existing TLS upstream mock (5ms delay), no real provider calls. Warm-up: 100 serial successful requests. Workload: wait 35 seconds, then 1,000 requests at concurrency 200.

| Same-condition run | HTTP 200 | HTTP 429 | HTTP 503 | Other |
| --- | ---: | ---: | ---: | ---: |
| Base, diagnostic trace | 260 | 544 | 196 | 0 |
| Fixed | 333 | 667 | 0 | 0 |

All base 503s in this comparison are `authority/capability_unavailable`; fixed has only legal admission `rate_limited` rejections. A separate earlier idle run also experienced 56 admission/storage failures and 7 HTTP 502s under concurrent host activity; those are not relabeled as this authority defect. Warm-state base c32 (1,000 requests) and c200 (3,137 requests) had no 503s, which is why the idle condition matters.

A second paired correctness reproduction used three independent gateway processes against the same PostgreSQL/Redis authorities, with clients split 67/67/66 concurrency and 334/333/333 requests. Base: 339 HTTP 200 + 598 HTTP 429 + 63 HTTP 503. Fixed: 304 HTTP 200 + 696 HTTP 429, **zero 503 or other errors**. Each base 503 was again authority/capability_unavailable.

Bounded per-process fixture-only provenance confirmed a remote owner: for synthetic account bucket 3, gateway 2 admitted the probe at epoch-ms `1793011729775` and completed at `1793011729791`. Gateway 1 lost the CAS at `1793011729776` while gateway 2 owned it, then observed authoritative refreshed health at `1793011729802`. Gateway 0 separately observed the refreshed row. Temporary compiled-artifact trace hooks were removed by the final clean server build.

These runs establish correctness under the specified conditions, **not acceptance latency/throughput comparisons**: other profiling/build workers were active on the host.

## Fix and invariants

- Coalesce only **in-flight** health refresh work by supply mode, BYOK tenant and account. Bound the pending-key map to 1,024 entries; overflow uses uncached fenced probes, so the one-poller coalescing guarantee applies to tracked keys.
- Each waiting request independently re-reads authoritative health with its own caller/account scope after completion. No allow decision or credential/rights authority is cached or shared.
- A losing CAS may belong to another gateway process. Its local coalesced worker polls within a one-second monotonic retry window, in 25ms intervals, and only while the authority says stale/unknown. Each authoritative database read retains its existing timeout; the retry window does not extend health freshness. A genuinely unhealthy/cooldown state, malformed data or storage refusal is never retried into an allow.
- Existing freshness TTLs, timestamp-skew limits, lease fencing, eligibility checks, credential/identity binding and downstream dispatch authority remain unchanged. Expired, failed or fenced refreshes still fail closed. No caller cancellation is attached to shared work; the scheduler's existing input has no AbortSignal contract.

## Regression coverage

A deterministic 32-caller stale-read barrier fails on the base (one allow, 31 blocks) and passes with the fix (32 allows, one probe, 32 independent fresh reads). Additional tests cover three scheduler instances sharing one durable CAS; concurrent write failures, fencing, cooldown, malformed/unavailable and expired refreshed views; tenant/account key isolation; bounded remote waiting and no retries for genuine authority refusals.

Run:

```sh
npm run build:server
node --import tsx --test tests/saas/gateway/postgres-provider-account-scheduler.test.ts tests/saas/gateway/provider-account-scheduler.test.ts
npx biome check src/saas/gateway/postgres-provider-account-scheduler.ts tests/saas/gateway/postgres-provider-account-scheduler.test.ts
```

Final focused scheduler verification: **319 passed, 0 failed**. Server TypeScript build and focused Biome checks passed. Full-repository aggregate validation is performed separately on the combined branch.
