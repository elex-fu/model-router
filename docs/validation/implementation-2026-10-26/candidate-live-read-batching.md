# Per-collection live candidate reads

Base: `37b44a6f8557ea2a69f02802c88ee18adbfb1d24`.

## Covered optimization

For four validated, applicable, freshly healthy candidates, native PostgreSQL
health/concurrency reads change from **4 + 4 SQL calls to 1 + 1**. The unchanged
core checks still decode each candidate independently. The final fenced lease
acquisition remains independent and authoritative. This is not an authorization
cache, a TTL extension, a new schema/role, or a production-path substitution.

The core enables phased collection only for the native health store:

1. Structural/scope/attempted-account checks, transient hints, eligibility,
   and window gates finish before any batch health lookup.
2. One health read covers only the surviving identities. Freshness and malformed
   fields are checked when each observation is consumed, against the live clock.
3. One concurrency read covers only health-admitted candidates, after any probes.

Custom health/probe ports keep their original sequential ordering. The optional
Redis slot pre-check retains its per-candidate PostgreSQL count path; no count
is fetched for a slot rejected by Redis. The 8-to-2 claim does not cover probes,
mutation-invalidated observations, or that Redis pre-check shape.

## Safety and lifetime

- Async-local snapshots belong to one collection, use exact caller/owner/account/
  upstream identities, and are single-use. Nested scopes, sticky waits, binding
  reconciliation, and hint fallback open independent collections.
- Every batch context is deactivated and cleared in `finally`; asynchronous
  descendants cannot use a completed scope's observations.
- Batch errors remain fail-closed and do not trigger per-candidate retries.
  Missing health rows retain the native cold-start classification; malformed
  batch indices/duplicates cannot masquerade as a missing row.
- Entering a probe discards all remaining prefetched health for that collection.
  Existing local probe coalescing and bounded cross-instance authoritative
  polling are unchanged. Probe refresh reads always go directly to PostgreSQL.
- Active-read-only, reference-counted mutation tokens invalidate the exact
  physical account across concurrent local requests. Tokens are registered
  before SELECT, advanced before and after native health mutation attempts,
  and removed when the last reader exits. They contain no authority decisions.
  An unrelated account's mutation does not invalidate another account's row.
- A delayed batch completion cannot clear a newer health-write failure latch.
- `HalfOpenProbeHealthPort` still has exactly the reflection-visible own keys
  `leaseProvider`, `maxHealthAgeMs`, and `store`; new bookkeeping is genuinely
  JavaScript-private.

## Verification

- `npm run build:server`: passed.
- Focused scheduler/health/hint unit suites: 519 tests passed, zero skipped.
- Fresh disposable PostgreSQL 18, existing restricted runtime roles:
  - Managed commercial HTTP E2E: 30 tests passed, zero skipped. New marker-only
    assertions verify real BYOK and platform HTTP preparations each issue their
    native health/concurrency batches, without replacing a port or result.
  - Candidate live reads, fenced lease, and runtime-health clock gates:
    29 tests passed, zero skipped.
  - Real PostgreSQL four-account BYOK/platform observations match the original
    eight reads using two queries, including tenant isolation and DB-clock lease
    expiry.
  - Twenty-four stale-health readers across three native scheduler instances
    all receive fresh allowed health after exactly one fenced probe outcome;
    every waiter independently rereads current health after its snapshot.
- Unit regressions cover malformed/missing/error rows, negative health,
  freshness-at-consumption, selective queries, later cooldown after a probe,
  async scope cleanup, overlapping mutations, a collection starting mid-write,
  newer write-failure latch preservation, sticky rechecks, and binding contention.

These are correctness and SQL-round-trip results, **not latency/RPS acceptance
measurements**. End-to-end performance must be remeasured on the integrated branch
with uncontended services. No claim of approaching sub2api is made here.
