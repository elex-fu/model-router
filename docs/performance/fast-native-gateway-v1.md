# Native fast gateway, first vertical slice

Status: implemented behind an **off-by-default** flag; native integration and paired performance acceptance are pending. This is a separate data plane, not another small reduction in the legacy proof chain. No deployment is implied.

## Ordinary warm request

1. Existing HTTP authentication, request limits and moderation remain. Authoritative routing, entitlement, price and sealed credential policy are cached for an absolute maximum of 5 seconds. Cold loads retain their original validation timestamp; cache hits never extend it.
2. Deployment model compatibility and authentication-header policy callbacks are captured only on cold load. The built-in callbacks normally perform PostgreSQL queries; the fast compiler/transport use exact-bound frozen facts instead. Core authority uses one repeatable-read transaction; these auxiliary deployment callbacks are a separately observed bounded view, not falsely claimed to share that transaction.
3. One Redis Lua admission enforces operational rate/token/concurrency limits. Redis is not the money authority. Missing sentinel, lost connection and unsafe eviction policy fail closed; restart quarantine is explicit.
4. One PostgreSQL autocommit statement reserves a genuine maximum charge from prepaid instance credit and inserts the immutable may-send intent. No global wallet lock, prepared-evidence registration, preflight, claim or dispatch-proof reread occurs here. Duplicate/ambiguous acknowledgement never authorizes another send.
5. A private one-use ticket drives the existing HTTP transport, including endpoint/DNS/header protections and credential unsealing. Authority expiry is checked after intent acknowledgement and again at ticket/credential consumption.
6. Exact observed usage is validated against the same journal calculator before a durable receipt acknowledgement. JSON final byte/EOF and SSE terminal DONE/EOF wait for that acknowledgement; preceding SSE events stream normally. The durable billing worker posts an idempotent exact ledger effect asynchronously.

Target: **0 warm metadata PostgreSQL queries + 1 pre-upstream intent statement**. Cold loads, receipt persistence, asynchronous billing, refill, health polling and legacy fallbacks must be reported separately. This is a design budget, not a measured result. Initial acceptance goals are serial 15–20 ms and at least 300 RPS in the existing paired local mock conditions, then at least 90% of paired sub2api throughput, with financial drains and crash gates passing.

## Enable only in an isolated validation deployment

- `MODEL_ROUTER_FAST_GATEWAY=reserved-max`
- `MODEL_ROUTER_FAST_REDIS_URL` (or existing `MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL`)
- `MODEL_ROUTER_FAST_NAMESPACE`: deployment-specific shared namespace
- `MODEL_ROUTER_FAST_OWNER`: stable unique gateway-instance allocation identity
- `MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS`: positive integer, default `1000000`
- `MODEL_ROUTER_FAST_REDIS_DRAINED=1`: only for a proven fresh/drained Redis namespace; never blindly on restart
- Optional `MODEL_ROUTER_FAST_SNAPSHOT_KEY_BASE64`: deployment-owned 32-byte AES key enables encrypted shared Redis L2. Without it the bounded L1 cache is used. Never use an API/provider secret as this key.

The equivalent `fastGateway` production-composition option is available for isolated native fixtures. Migration 143 and its explicit restricted-role grants are required. Initial credit shortage schedules off-path refill and rejects that request; it does not silently bill free or fall through after an intent. Keep the same instance owner exclusive across live replicas; owner epochs fence an older process.

Response headers identify selection: `x-model-router-execution-mode: fast-reserved-max` or `strict`, with `x-model-router-fast-fallback` for unsupported work. Benchmark acceptance must assert paid fast selection, not infer it from a flag.

## Initial supported and fallback scope

Supported: ordinary OpenAI-compatible `/v1/chat/completions`, text-only message strings, explicit positive output bound, one choice, default service tier, API-key credentials, ordinary token pricing, platform prepaid or BYOK, JSON or SSE.

Before any fast intent, these use strict mode: client idempotency keys; other operations/protocols; tools/audio/images/non-text content; absent output ceiling; multiple choices; special service tiers; per-unit/token-multiplier or advanced group finance; finite key monetary/token budgets; OAuth or special account controls; bound egress proxy/TLS profiles. Native policy denial is not a fallback permission. Verified active accounts without PG health history are neutral schedulable; a historical probe timestamp does not invalidate a healthy/degraded account. Current cooldown and unhealthy/half-open states still exclude candidates. The current first slice selects the first eligible candidate; it does not claim general multi-account scheduling or safe post-send retries. Completed 429/5xx outcomes update bounded Redis cooldown; ambiguous remote execution retains its slot conservatively.

## Deliberately changed contracts

- Authority revocation/spending-freeze visibility is bounded by the original **5-second hard snapshot lease**, not immediate per-send PostgreSQL locking. No durable invalidation outbox is claimed yet. Local invalidation/outage hooks fail closed.
- Money stays conservative: a hard enforceable maximum, not an ML estimate; unknown usage retains its reserved liability indefinitely pending explicit reconciliation. Credit cannot be recycled by a timeout. Legacy wallet/refund/correction paths account for allocation backing.
- A completed response has a durable receipt before terminal completion. A crash after upstream send but before a receipt remains UNKNOWN; exact provider usage is not magically reconstructible without upstream lookup. No automatic replay, fake refund or silent deletion resolves that ambiguity.
- Redis operational lease horizons bound capacity recovery, not a proof that a remote provider stopped after cancellation. Production Redis must use `noeviction`; connection loss requires explicit managed recovery.
- Credential plaintext is never serialized to the snapshot or journal. This slice still unseals per request; local software-KMS benchmark results cannot promise remote-KMS latency.

Rollback disables the flag for **new requests**, while the durable receipt worker/recovery must continue draining existing fast intents. Never replay a may-send fast intent through strict mode. Schema/credit liabilities cannot be dropped until reconciled.

## Validation at the integration checkpoint

Focused tests cover paid JSON/SSE reserve and exact usage; mixed-case SSE media type; durable terminal barrier; duplicate and lost intent acknowledgement; expiry during intent wait; strict pre-intent fallback; receipt storage failure; cold-only callback invocation and exact routing identity; unsafe header rejection. Existing HTTP/composition regressions remain green. Real restricted-role PostgreSQL/Redis tests are separately supplied by the journal, snapshots and admission components. Native paid HTTP, request-scoped SQL census, crash/restart/invalidation and paired throughput are the next acceptance gate, not assumed from unit tests.

## Read-side integration boundary

Fast usage is durable in intents/receipts/jobs, not fabricated legacy request/attempt/usage rows. Existing dashboard/export readers need an explicit fast-journal projection or union before broad feature enablement. Native acceptance counts both formats separately and reconciles their exact ledger effects. This first checkpoint does not claim legacy usage pages already show fast traffic.
