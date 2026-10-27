# Opt-in bounded two-worker gateway

This is a new, deliberately narrow production entrypoint, **not the diagnostic
cluster launcher** and not a replica autoscaler. Existing `start --role gateway`
behavior remains available. Do not deploy this mode until the required native
PostgreSQL/Redis/compiled-CLI and socket gates pass for the exact release.

## Supported scope and prerequisites

- Exactly two business child slots plus one non-business HTTP front/supervisor.
  All three must share one Linux host, PID-observation domain and Linux abstract
  Unix-socket namespace. Multi-host failover and independently scaled containers
  are **not supported**. The kernel singleton is keyed by stable deployment ID,
  not by a chosen state-file path.
  Host identity uses a valid machine-id, or a kernel boot-id in minimal Linux
  containers. With boot-scoped identity, a host reboot makes old state conflict
  and requires operator investigation; recovery never guesses a new identity.
- HTTP/1.1 `/v1` requests, including JSON and SSE. Sequential external keep-alive
  requests are independently placed. WebSocket upgrades return 501; concurrent
  HTTP pipelining closes the connection; Expect: 100-continue returns 417;
  request trailers are refused and response trailers are not forwarded. No
  HTTP/2, WebSocket-round, brand-settings or metrics coverage is implied.
- `/healthz` and `/readyz` are front-owned GET endpoints with no request body.
  Public admin/control/internal routes are not forwarded. Readiness starts only
  after both workers are ready; during a controlled replacement it can remain
  ready with one worker and **half** the steady-state capacity. Each child runs
  one private native readiness probe at a time, every five seconds after its
  prior result; a five-second probe deadline and 15-second primary freshness
  watchdog remove unhealthy/stale workers from placement. No heartbeat failure
  releases an outstanding business grant or starts a replacement.
- Bounded mode always uses production environment semantics; an inherited
  `NODE_ENV=test` cannot disable deployment, privilege or KMS checks.
- Existing managed-gateway database, Redis, trusted runtime and KMS configuration
  must already be provisioned. Migration 147 and its reviewed least-privilege
  grants must already be applied by the normal explicit migration workflow.
  Neither startup nor this feature changes grants, role settings, service units,
  network settings or deployment configuration.
- The effective PostgreSQL login must be non-superuser, have no BYPASSRLS, equal
  `session_user`, and already have a positive `CONNECTION LIMIT` no greater than
  the aggregate declared PG budget. Missing/unreadable facts fail startup closed.
  `PGOPTIONS` and URL authority/session overrides are forbidden; the PostgreSQL
  URL must explicitly identify its login. Recovery pins credential-free URL
  scopes for PostgreSQL and Redis, including host, port, database, login and
  query options. Password rotation is allowed; changing endpoints/logins is not
  a recovery operation. DNS/service routing must retain the same backend scope;
  infrastructure migrations need an explicit audited drain/migration workflow. This
  role-level backstop includes other normal connections using that login, such
  as an operator drain CLI; those consume headroom rather than add capacity.
  PostgreSQL documents conservative simultaneous-start rejection, so the limit
  is not an availability guarantee. [PostgreSQL CREATE ROLE](https://www.postgresql.org/docs/16/sql-createrole.html).
- No `NODE_OPTIONS` or Node exec-argument preloads. Use the compiled CLI, not
  `node --import tsx ...`, for the actual supervised process. Test-runner preloads
  must not be propagated into production children.
- A short, absolute, private state directory owned by the runtime user, mode
  0700. State is mode 0600, atomically replaced and fsynced. Workers listen only
  on unique private Unix sockets. Do not share or delete this state to bypass a
  recovery refusal. Keep the same state and stable deployment ID across restarts.
- Trusted runtime extensions must not create unmanaged raw `pg.Pool` instances
  or use other database logins. Core-owned native pools have an immutable
  process budget and cannot be replaced with an opaque injected pool in this
  mode. A trusted extension is executable code, not a security sandbox.

## Fixed resource contract

Default aggregate totals are unchanged from the bounded diagnostic policy:

| Resource | Whole bounded gateway | Per business slot |
|---|---:|---:|
| HTTP work permits | 64 | 32 |
| Native PG pool maxima | 16 | 8 = business 6 + quota 2 |
| Resident receipt entries | 256 | 128 |
| Retained receipt bytes | 2 MiB | 1 MiB |
| Receipt entries per tenant | 64 | 32 |
| Receipt SQL lanes | 8 | 4 |
| Durable-usage reconciliation lanes | 8 | 4 |
| Credit stripes | 8 | 4 |

The supervisor has **no PG pool**. Registration, epoch activation, recovery
checks and old-backend census use the worker's already-budgeted native pool.
Native constructor grants stay owned until the old child actually exits;
`pool.end()` uncertainty, timeout, lost heartbeat or socket EOF never transfers
a process grant. Core native-pool constructor metadata is checked at readiness
and all core pools must close for a graceful worker exit.

The public socket bound is separate (default `2 * HTTP limit + 16`, including
idle sockets). Headers are capped at 16 KiB. Ingress bodies are streamed with a
default 16 MiB cap, and accepted requests have an absolute 120-second front
transfer deadline plus HTTP intake/inactivity bounds. All bounds are explicit
CLI policy inputs; they are not larger receipt queues. Node stream backpressure
bounds buffering, and at most one uncompleted public response is permitted per
socket. Internal HTTP agent waiters can only arise from already-counted request
tickets; there is no additional admission waiting list or retry queue.
Kernel accept backlog is explicitly `min(connection limit,128)`; it is separate
from admitted work, not called a receipt queue. Each private worker listener also
has a fixed connection bound (`local HTTP permits + 1`, the extra socket is the
single readiness probe) and finite accept backlog. This is not an extra PG
connection or business-work permit. A separate local control socket beneath
that same private directory has at most four connections, 1 KiB messages, a
one-second idle deadline and backlog four; it cannot route business requests.

Receipt SQL fallback remains inside an existing HTTP permit. Receipt-phase and
reconciliation worker counts describe the resident queue, not every SQL query
in the process. Per-tenant queue partitions are conservative; this mode does
not promise that a tenant can use the sum of both partitions under arbitrary
post-authentication skew.

## Request placement and trust boundary

The primary reserves an available slot for **each request**, choosing the least
occupied ready child. Equal occupancy rotates slots. A worker at its local cap
does not reject a request while its ready sibling has a free HTTP grant. No
caps are doubled and no socket-based RR distribution is mistaken for request
distribution.

The request body stays paused until a one-use child ticket, sent over parent
IPC, is acknowledged. External internal-ticket headers and all hop-by-hop
headers (including Connection-nominated headers) are stripped. The child
accepts a private request only for an outstanding ticket; it binds the original
socket-peer address from IPC in a request-local WeakMap. Existing configured
forwarded-address policy therefore still runs against the original peer,
without trusting a user-supplied “internal client IP” header. Normal client
Authorization and multi-value response headers remain intact.

There is no automatic upstream replay or proxy retry. A canceled undispatched
ticket is acknowledged once and cannot later be used. Cancellation after the
handler starts destroys transport but does **not** release its permit. The
child sends completion only after the original handler and its
`capacityCompletion` promise settle. Client EOF/abort, frontend response finish,
an IPC delay or a receipt enqueue is not that completion. Existing durable
intent CAS, send fences, cleanup-before-EOF and receipt/TPM separation remain.

## Money invariant, including old generations

`--credit-cap-minor-units T` is required; it is a fixed durable ceiling, not an
automatic target recalculated on every restart. Each slot's desired tranche is
`floor(T/2)`. The global policy applies **separately per tenant and currency**;
currencies and different tenants are never added as though their money units
were interchangeable.

At a wallet's first bounded refill, under the existing wallet fence, migration
147's durable policy/counter is initialized from **all** allocation backing for
that tenant/currency: active and retired, every epoch, registered and legacy
owners alike. Existing backing above T causes a closed admission, not release
or adoption of unresolved money. A different deployment requesting a different
cap for that wallet also fails closed. Policy changes are not implicit restart
operations.
  Once opted in, that wallet cap remains in force even if a later process uses
  legacy single-process mode; switching entrypoints does not disable policy.

Refill clips new backing to both real wallet spendable funds and global cap
headroom. Backing-mutating SQL maintains a trigger-owned global counter;
deferred commit-time validation permits intermediate stripe redistribution but
rejects a final sum above T. An older/legacy backing writer cannot bypass an
already-created wallet cap. Available-only reserve and receipt restoration do
not touch that counter. Durable settlement still independently checks price,
usage, identity and exactly-once ledger constraints.

For example, if retired unresolved backing is 30 and T is 100, all current
owners combined have at most 70 remaining backing capacity—not a fresh 100.
Missing receipts, uncertain ACKs and crashed in-memory evidence retain their
remaining durable liability until existing audited recovery can resolve them.
Neither process death, Redis lease expiry nor an empty new queue releases money.

Stable slot owners require explicit activation. Activations are historical and
epochs cannot be reused. A bounded journal verifies an already-activated owner
instead of blindly replacing its epoch. Existing reserve SQL checks the slot's
active owner epoch in the same statement; there is no new global per-request
database roundtrip. Owner release fences an old epoch but does not invent a
financial resolution.

**Cost qualification:** migration147 adds a backing-write trigger even for a
legacy wallet without a cap (its counter UPDATE matches no row). Default-mode
financial behavior is retained, but this is not zero database overhead. Any
later performance comparison must use the final migrated schema in both arms;
top-level application-statement counts do not expose all trigger execution.

## Start, roll, stop and recover

Build using the ordinary release workflow. Example c32 budget for maximum
request reserve M=524480 and aggregate H=64 is `T=2*M*H=67133440`:

```sh
node dist/cli/index.js saas:bounded-gateway start \
  --state-directory /run/mrg --credit-cap-minor-units 67133440

node dist/cli/index.js saas:bounded-gateway status --state-directory /run/mrg
node dist/cli/index.js saas:bounded-gateway roll --state-directory /run/mrg \
  --expected-generation GENERATION_FROM_STATUS
node dist/cli/index.js saas:bounded-gateway stop --state-directory /run/mrg \
  --expected-generation GENERATION_FROM_STATUS
```

`roll` and `stop` use a generation-authenticated private Unix control socket,
not a persisted-PID check-then-signal sequence. Direct service-manager signals
are still handled by the running supervisor. The supervisor drains slot0, waits for **actual process
exit**, then starts its replacement; only then does it repeat for slot1. No
third business child is started. The replacement checks old generation-specific
PostgreSQL sessions are absent before owner activation/readiness. A failed or
forced old exit fails the group rather than proceeding with a rolling overlap.

Unexpected worker death closes group admission and drains the surviving child.
There is no respawn loop. Shutdown timeout may kill the exact owned child and
reports nonzero failure. State-write/fsync failures do not skip the child-exit
obligation or release native grants early. Shutdown does not report a graceful drain or retire missing
financial evidence. Ordinary external `Restart=on-failure` is not a supported
recovery policy for this entrypoint: `start` will refuse existing state.

After every recorded old process is proven dead, explicitly recover the exact
recorded generation with the same policy:

```sh
node dist/cli/index.js saas:bounded-gateway recover \
  --state-directory /run/mrg --credit-cap-minor-units 67133440 \
  --expected-generation GENERATION_FROM_STATUS
```

Recovery refuses live old workers, a live primary, another machine's state,
unknown PID observation, malformed state, an unproven active database epoch,
remaining old PG sessions or changed policy. It does not kill an unowned process,
steal a timed-out lease or clear financial history. A surviving orphan must be
drained/stopped by an authorized operator before retrying. Corrupt/missing state
requires operator investigation, not a force flag. The kernel singleton
serializes even simultaneous recovery attempts before stale file removal.

The supervisor fsyncs a new child's PID/start identity **before** sending its
bootstrap capability. A child cannot construct a business runtime or pool from
an inherited environment alone. This closes the fork-before-manifest window;
IPC loss fails the worker closed.

Redis restart handling always uses normal run-id/quarantine semantics. This
entrypoint never inherits diagnostic `MODEL_ROUTER_FAST_REDIS_DRAINED=1` and
does not bypass quarantine during replacement or recovery.

## Required validation and current acceptance boundary

- Pure tests: fixed totals, placement, grant retention, stale completion,
  one-use IPC tickets, spoofed headers/peer identity and strict persisted-state
  parsing.
- Native socket tests: persistent-client skew, pre-ACK cancel, SSE/abort,
  explicit unsupported routes/protocols and frontend bounds.
- Native child supervisor tests: no third child during stop-before-start roll,
  unexpected-death group failure and retained recovery identity.
- Required PostgreSQL15/18 gates: real migration/grants, global all-owner cap,
  legacy and retired liabilities, concurrent/late receipt settlement, explicit
  epoch lifecycle and actual compiled-CLI two-worker operation with Redis/TLS.
  No missing-service skip is accepted in the required gate. The bounded compiled
  fixture uses production environment semantics and explicitly enables the
  existing software-KMS pilot allowance for its disposable fake-money fixture;
  this tests privilege gates, not production cloud-KMS qualification.

Local socket test startup can be sandbox-blocked with `listen EPERM`; that is
**not** a functional test pass. Native PG/Redis qualification has to execute in
the authorized CI fixture. There is no measured production-mode throughput or
CPU-efficiency claim in this change.

The user's fixed-CPU comparison remains a required subsequent execution and
acceptance phase, not optional documentation. The separate explicit-opt-in
[fixed CPU quota diagnostic](fixed-cpu-quota-diagnostic.md) now contains the
portable runner, container assets and pure validation contracts. When authorized
after native correctness CI is green, it runs matched single-business and bounded-two ABBA arms from the **same final
image/source**, app-container quota `--cpus=2` with actual `cpu.max` readback,
fixed aggregate PG/queue/credit policy, fresh wallets and full finance/actual-TPM
drain. The app container includes the primary; PG, Redis, mock and driver remain
outside that quota and must be reported separately. Record throttling, all
attempts/rejections, CPU and memory, and refuse timing without quota proof.
CPU affinity is not a CPU quota. This diagnostic must follow native correctness
acceptance and must not relabel historical runs as resource-controlled.

The quota diagnostic distinguishes durable activation claims from process
liveness: clean shutdown leaves the two manifest-matched SQL slot activations
registered until explicit recovery proves the old processes and pools gone.
Qualification still requires zero backing/available/allocated resources, no
active allocations, no native gateway sessions and clean original child exits.
It never clears these claims during benchmark cleanup; exact policy/owner/epoch
and activation-history proofs reject extras or replacement epochs.
