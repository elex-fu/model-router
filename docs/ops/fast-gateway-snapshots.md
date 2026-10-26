# Cache-first gateway authority snapshots (experimental)

This opt-in native OpenAI chat slice replaces the strict path's mandatory
PostgreSQL rechecks with bounded, authoritative snapshots. It does not modify
strict mode. Gateway integration and the mode switch are separate from these
modules; the new mode must remain disabled until its end-to-end acceptance gates
pass. Unit cache tests are not evidence of an HTTP throughput improvement.

## Warm and cold paths

`CachedFastGatewaySnapshots` resolves the complete authenticated
tenant/project/key/principal/entitlement/profile/model/protocol/operation scope
from an immutable L1 entry, then repeats status, expiry, scope, IP and body-size
checks using only that entry and the request. The payload compiler must still
prove actual token/output bounds. Every hit emits `l1_hit` or `l2_hit`; no
PostgreSQL freshness query runs on a hit. It is not a hint cache feeding the old
per-request registration/proof transaction chain.

One bounded, single-flight cold loader is admitted per scope. The default is 64
pending scopes, 4,096 L1 entries, 3-second wait bound and 500ms negative cache for
unsupported configurations. Saturation is an explicit unavailable response,
never a bypass spawning unbounded loaders. Timed-out work retains its capacity
slot until it exits and cannot publish late. There is no stale-while-revalidate.
A detached PostgreSQL loader additionally enforces its own remaining-time SQL
statement/lock limits; the wait timer alone cannot cancel a database query.

The native loader runs the existing read-only caller, entitlement, route,
commercial and catalog authorities **only on cold load**, in one READ ONLY
REPEATABLE READ transaction. It revalidates current persisted key/principal
identity even if the authenticator supplied cached key metadata. It obtains
current sealed credential envelopes and pinned price versions from their native
repositories. It never registers a request, claims dispatch evidence, reserves a
wallet or creates a financial row. Cold latency/statement count is intentionally
not claimed to be optimal: warm requests avoid the old chain rather than merely
hiding a per-request copy behind a new interface.

## Freshness and revocation contract

The default and initial maximum positive TTL are **5 seconds**. The original
`observedAtMs`, source validity windows and hard `validUntilMs` are preserved
through L2 promotion. The minimum of every captured absolute expiry and the TTL
bounds the snapshot. Cache fills, hits and L2 reads never extend that deadline.
L1 also has a monotonic deadline; a hybrid wall/monotonic clock prevents a local
wall-clock rollback from renewing authority. Expired key/credential/price data
is rejected even if a TTL entry still exists.

A control-plane mutation can therefore remain unseen for at most the remainder
of that snapshot's five-second lifetime. This is **not immediate-revocation or
strict-mode linearizability equivalence**. The original cold validation timestamp
is never replaced by the timestamp of a cached-authentication hit. SQL/database
and gateway wall clocks must be synchronized; unexplained future authority
timestamps fail closed.

`invalidate(committedEpoch)` globally evicts local entries and fences in-flight
loads. Epochs are monotonic and replays cannot regress them. A detected Redis or
invalidation-channel failure invokes `markUnavailable()`, closing even L1.
Recovery requires a verified non-regressing durable epoch through `recover()`.
There is no silent stale fallback or automatic recovery from a successful GET.
Without a background connection monitor, an *undetected* disconnect can leave an
already-loaded L1 usable only until its original hard expiry; the next failed L2
operation closes the cache. Redis restart/missing cache data is a miss requiring
a fresh bounded SQL snapshot, never evidence of an allow.

### Durable invalidation follow-on (not yet wired)

No broad control-plane outbox triggers are installed by this batch. The TTL is
the implemented cross-process revocation bound. Before widening it, a separate
migration must cover every authority writer: key/IP/model scope, identity and
membership, entitlement/profile/plan, group/pool/grants, route/catalog/rights,
credential versions/wrapping, price/commercial policy and relevant provider
health/cooldown changes.

Each such mutation must atomically increment a durable change epoch and enqueue
its invalidation in the **same PostgreSQL transaction**. The outbox consumer must
publish only committed changes, compare epochs monotonically in Redis, recover
from a durable checkpoint (not Pub/Sub alone), and acknowledge only after the
cache gate is updated. Gateway startup/reconnect must establish the durable epoch
before serving L2; a bounded background heartbeat/lease must close L1 on gaps or
outage. Recovery from Redis loss must replay the durable epoch, not reset it to
zero. No per-request PostgreSQL check is necessary for that eventual design.
This document defines that next integration contract, not a claim it exists.

## Scope and security

Only ordinary native OpenAI chat JSON/SSE, platform or BYOK API-key credentials,
are currently eligible. Unsupported protocol bridges, composite/special-provider
routes, non-neutral group pricing/spend limits, key budgets and unsupported
account scheduling/egress policies return `null` **before** admission intent, so
the caller may use strict mode without retrying a charged/dispatched request.
Fixed unsupported reason labels contain no IDs, SQL, request contents or secrets.
A tenant-wide spending freeze is loaded in the same cold snapshot and denies
platform spending within the hard TTL; BYOK has no platform spend and is
explicitly unaffected. Current account health/cooldown facts are part of the cold view; the old stale
health probe transaction does not run per request in this mode. This is an
explicit bounded-freshness scheduler policy, not strict-path equivalence.

Cache keys are SHA-256 of the full safe caller scope; they never contain raw API
keys. The existing authentication boundary separately hashes raw customer keys.
Credentials in snapshots are the existing owner-bound encrypted envelope shape,
not plaintext. Redis L2 additionally AES-256-GCM encrypts the whole serialized
snapshot with a deployment-owned key and binds ciphertext to the complete cache
key as AAD. It uses acknowledged `SET ... PX`, ordinary non-refreshing `GET`,
bounded values and safe fixed errors. Do not use the old fail-open runtime cache
adapter. Cache encryption-key rotation requires a distinct namespace or expiry
of old entries; invalid ciphertext fails closed rather than becoming a cache
miss. No secret material belongs in configuration files or logs.

## Refresh handoff and known rejections

The managed fast runtime starts a single-flight refresh at 1.5 seconds remaining
and stops handing out old positive snapshots at one second remaining. Refreshes
bypass old L2 entries and never change an issued object's original deadline.
Compilation may reload/recompile once before Redis admission, including when the
old snapshot expired during compilation; cancellation never triggers admission
or a replay of an acquired lease.

An explicit cold-source `SNAPSHOT_DENIED` or unsupported `null` fences every
previously issued fast object in that exact hashed scope, even after L1 eviction.
A later fresh allow cannot revive the old objects. Retained per-scope sequences
are bounded by `maxEntries + maxPending`, retained through the cold timeout plus
maximum lease lifetime, and expire only after all affected leases must expire.
New scopes fail with `SNAPSHOT_BUSY` at saturation; unrelated warm objects remain
usable. Known-rejected scopes bypass stale L2. Explicit denials are negatively
cached for the normal short negative TTL; null still means pre-intent strict
fallback. Network, storage and timeout errors are not relabeled as revocation.
