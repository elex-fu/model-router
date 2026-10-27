# Redis-authoritative fast gateway admission

This module is only for the separately selected fast gateway. Existing strict
PostgreSQL capacity, provider-account lease and recovery implementations are unchanged.
It is not a Redis pre-check followed by a PostgreSQL lease: an acknowledged Redis
receipt is the capacity authority, and the module contains no SQL or persistence
projection. Wallet credit, monetary budgets, durable dispatch intent and financial
settlement are separate authorities; releasing capacity does not release money.

## Runtime contract

`openRedisFastGatewayAdmission({ url, namespace, maxTtlMs, ... })` opens a bounded
`@redis/client` connection, disables offline queuing and automatic reconnection,
verifies Redis `INFO server` identity and `CONFIG GET maxmemory-policy=noeviction`,
and initializes a shared generation sentinel. The runtime identity/configuration
queries occur at connection bootstrap, not per request. The managed return value
also exposes `cacheCommands.sendCommand` for the encrypted metadata snapshot cache
on the same connection. Bootstrap therefore needs INFO/CONFIG-GET permission in
addition to the Lua and data commands; CONFIG mutation is not required.
The managed connection requires **both EVALSHA and EVAL ACL permission**.
An EVALSHA permission denial fails closed, without falling back to EVAL.

`acquire` normally performs **one EVALSHA** for tenant/project/key/user/group/account limits,
account/model cooldown and a bound request receipt. No money check is represented
as a capacity check. `assertValid` is a conservative monotonic local fence and adds
no Redis command; elapsed command latency is subtracted from its validity.
`renew` normally performs one EVALSHA. `release(feedback?)` normally performs one
EVALSHA and can atomically apply a monotone account/model cooldown. A late success does not erase another
request's failure, and success never writes PostgreSQL health state. RPM is never
refunded: an admitted attempt remains counted even if cancelled. After a durable
validated successful usage receipt, `actualTokenUnits` reconciles only unused TPM
reservation in that lease's original request-start bucket. Missing/failed receipts
retain the bound; a missing old bucket never subtracts from a newer window. Rate
JSON plus the released tombstone use one atomic same-slot MSET, with PEXPIREAT
restoring TTL afterward. Both commands need Redis ACL permission. A post-MSET TTL
failure can retain state longer but cannot refund twice on retry. A script-cache
hit adds no roundtrip or PostgreSQL query.

### Script transport and cache misses

The managed connection hashes the five unchanged static Lua bodies once at
bootstrap and sends their 40-byte SHA-1 digests on cache hits. Acquire's script
argument shrinks from 4,477 to 40 bytes; release and detached usage reconciliation
share the unchanged 6,461-byte body and each send 40 bytes on a hit. Keys, arguments,
reply decoding, authority, rate/capacity limits, fences and TTLs are unchanged.
This removes repeated script-body transport; Redis already caches scripts passed
to EVAL, so it is **not** a claim of reduced compilation or measured throughput.

Only the exact decoded Redis `SimpleError` reply
`NOSCRIPT No matching script. Please use EVAL.` permits one EVAL fallback, using
the same body, argument object and original 2-second command deadline. Cold cache,
SCRIPT FLUSH or script eviction can therefore add one roundtrip per affected
operation. Concurrent cold callers each execute their own operation; they do not
share results or assume that another caller populated the cache. Fallback errors,
network/timeout/unknown-ACK failures, ACL errors and lookalike application errors
never trigger automatic replay. No SCRIPT LOAD/EXISTS commands or new connections
are introduced. A restart still requires explicit managed-client reopening and
the existing generation/quarantine checks; a cache miss never repairs authority.

This follows the EVALSHA/EVAL pattern in the installed
[@redis/client 5.12.1 implementation](https://github.com/redis/node-redis/blob/redis%405.12.1/packages/client/lib/client/index.ts),
with stricter error provenance and exact response matching. See also
[Redis EVALSHA](https://redis.io/docs/latest/commands/evalsha/).

The gateway must:

1. Obtain a live snapshot, capacity receipt and independently acknowledged durable
   financial dispatch intent before any upstream send; capacity alone is not a
   permission to dispatch and does not provide financial idempotency.
2. Check the snapshot deadline and `lease.assertValid()` again after every awaited
   prerequisite, immediately before the one-use upstream send.
3. Renew at `lease.renewIntervalMs`. On renewal failure, abort upstream work and
   forbid any new send. The Redis slot remains occupied conservatively.
4. Release only when upstream completion is known, **not on HTTP client disconnect**
   or merely because an abort was requested. An ambiguous upstream termination
   retains occupancy until the safe expiry; financial reconciliation is independent.
5. Enforce the upstream lifetime ceiling passed as `ttlMs` (bounded by `maxTtlMs`).
   The remote provider may continue after a network failure; operators must choose
   a conservative ceiling/grace based on that transport, not the client timeout.

Each lease has a short renewable validity deadline, a longer occupancy expiry
`last renewal + sendValidityMs + ttlMs + abortGraceMs` and an owner-token/binding
fence. The default grace is 30 seconds. The short renewal deadline (`sendValidityMs`)
is at most three renewal intervals and at most `ttlMs`. A ticket can start its
full upstream lifetime just before that deadline, so occupancy includes this send
delay independently of abort grace. A smaller custom grace therefore does not
shorten occupancy below the latest permitted send's lifetime bound. Renewal after
that deadline fails rather than resurrecting an expired lease. A stale release can remove only that request's member; lease records
outlive occupancy and terminal tombstones default to 24 hours. New work must have a
new canonical request ID. Financial durable idempotency remains necessary beyond
the bounded Redis tombstone retention.

Acquisition token, tenant/request identity, account/ownership, model, limits,
token estimate and timeout are bound into the receipt. Repeating an acknowledged
acquire is idempotent. A lost ACK retry uses the same acquisition token (generated
consistently within a process or explicitly supplied across processes). A different
token or changed binding fails closed. Acquire replay does not grant permission to
send an upstream request a second time; the financial one-use dispatch ticket owns
that guarantee. A Lua runtime/ACL error can conservatively reserve some slots or
rate before the final receipt, but never produces an acknowledged lease. These
orphans expire; no PostgreSQL fallback or speculative upstream send is permitted.

## Scopes, rate windows and topology

- Tenant/project/key/user identities include the tenant. Private provider accounts
  include their owning tenant, which must match the caller tenant.
- Platform provider accounts are global across callers. Billing-group RPM is also
  global by group ID, matching the existing PostgreSQL group counter semantics.
- Limit values are not part of counter keys, so a policy change cannot reset a rate
  counter simply by changing the limit value.
- Rate state keeps at most 61 one-second buckets per dimension. A configured
  trailing window is 1–60,000 ms; a partly overlapping second is counted in full.
  This is conservative by less than one second and does not allow fixed-window
  boundary bursts. Token estimates are reserved with the request, not settled
  monetary amounts. Zero/null/absent limits mean unlimited for that dimension.
- All keys for a namespace deliberately have **one Redis hash tag**. Global supply
  constraints cannot be split into tenant-local slots without changing semantics.
  This implementation supports a standalone primary only. Cluster redirection,
  Sentinel, replica reads, transparent failover and multi-slot transactions are
  not implemented. Single-slot key layout is not a claim of Redis Cluster support.
- `noeviction` is required, and its configuration must remain stable while serving.
  Redis memory exhaustion fails closed. Use dedicated keyspace/ACL isolation;
  arbitrary live key deletion or mutation by other applications is unsupported.

## Restart and recovery

Missing sentinel, malformed state, unavailable connection or mismatched generation
fails closed. Requests never initialize an empty Redis namespace. All instances
must use the same namespace and maximum horizon. A new namespace or changed Redis
run ID defaults to a shared quarantine of
`max(61 seconds, maxSendValidityMs + maxTtlMs + abortGraceMs)`, where
`maxSendValidityMs = min(maxTtlMs, 3 * configured renewIntervalMs)`.
This lets prior rate windows and every possible orphan upstream occupancy expire
without consulting PostgreSQL per request. Restoring an old RDB does not bypass
this quarantine because Redis process `run_id` changes. A disconnected managed
client stays unavailable; reopen it explicitly through the bootstrap path.

Only an externally verified full upstream drain (or a provably fresh, isolated test
namespace) may use `drained: true`. A gateway process restart alone does **not** prove
a drain. An existing valid shared generation is reused by rolling replicas without
resetting counters or restarting quarantine. Increasing the configured horizon
requires an explicit coordinated migration/drain; mismatched horizons are rejected.

## Local verification

Run only against a disposable process owned by this test:

```sh
MODEL_ROUTER_FAST_ADMISSION_REDIS_TEST=1 \
MODEL_ROUTER_TEST_REDIS_BIN=/absolute/path/to/redis-server \
node --import tsx --test tests/saas/gateway/fast/redis-admission.local.integration.test.ts
```

The suite checks actual concurrent Redis mutation, global/private scopes, each
limit dimension, rolling window expiration, lost acquire/release ACKs, renewable
long requests, stale-owner fencing, conservative orphan expiry, monotone model
cooldown, missing/corrupt sentinels, a real Lua ACL failure after an earlier write,
noeviction policy rejection, and SIGKILL/restart with a restored old sentinel.
It is not an HTTP benchmark, production failover proof or financial durability test.
Native HTTP integration and durable financial ticket tests are separate gates.

Captured local gate (2026-10-26): Node 24.22.1 and owned Redis 7.4.2,
21 tests passed, 0 failed/skipped (16 real-Redis parent/subtests plus 5 pure contract
checks). Both whole-source and focused-test strict TypeScript checks passed; Biome
on the changed TypeScript files passed with no warnings. These are correctness
results, not a throughput or end-to-end HTTP performance claim.

Follow-up gate on the same date: **22 passed, 0 failed/skipped**, including a
1 ms custom-grace delayed-send regression, exact Redis lease/ZSET horizon checks
after acquire and renew, and real restart quarantine of 120,001 ms for a 90-second
transport ceiling plus a 30-second send-validity window. Focused strict TypeScript
and changed-file Biome passed. No additional Redis command was added to admission.


Transport correctness gate (2026-10-27): **49 passed, 0 failed/skipped**, across
the full owned Redis 7.4.2 admission suite and 17 pure contract checks. This includes
restart/quarantine, natural bucket/tombstone expiry, all five pinned Lua hashes,
unchanged fallback arguments/deadline, concurrent cold calls and unknown-ACK
non-replay. The additional owned Redis transport test verifies
commandstats on cold/hit/flush paths, split release-body reuse, concurrent capacity,
EVALSHA ACL denial without EVAL downgrade, actual server mutation followed by
simulated lost EVAL/EVALSHA ACKs, and fail-closed missing authority. This is not a
performance benchmark. Whole-source and focused-test strict TypeScript and
changed-file Biome passed. The required fast gateway workflow now both executes
and strictly typechecks the transport unit tests; the real transport test runs
inside its existing owned-Redis gate.
