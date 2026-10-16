# R9 Performance & Chaos Benchmark — Results

**Date:** 2026-10-16 (UTC)
**Runner:** task G5 (#45) — unattended execution against the real Docker stack
**Verdict:** **FAIL — 6/6 bench thresholds and 6/6 chaos thresholds violated.** Every number below is measured, not projected. Raw driver reports: `bench-1inst-scaling.json`, `bench-3inst.json`, `chaos-3inst.json`, `chaos-account-faults-partial.json` (same directory).

---

## 1. Environment

| Component | Detail |
|---|---|
| Host | Apple M1 Pro (arm64), macOS (Darwin 25.5.0) |
| Docker host | colima VM, 4 vCPU / 6 GB RAM |
| Docker | 29.5.2 (colima context) |
| Compose | `docker-compose` v5.6.0 standalone (plugin syntax unavailable) |
| Stack | control-plane, gateway ×3, credential-validation-worker, postgres:16-alpine, redis:7-alpine, mock-upstream (HTTPS :18443, control :18080) |
| Gateway runtime | Node 22.16.0, image `model-router-saas:local`, software KMS pilot env |
| Bench drivers | `scripts/ops/bench-gateway.mjs`, `scripts/ops/chaos-gateway.mjs` (host, Node 24) |
| Topology | host ports 15007/15008/15009 → gateway container 15007 (assignment shuffles per recreate) |

Seeded bench topology (tenant `ef1c8e9d-…5350`, project `cc81f010-…f54e`, platform proxy key `41a21544-…f722`):
- OpenAI pool `bench-pool2` → accounts `bench-account-1..4` (api-key creds, token = account id), route `bench-r9-platform-route`, endpoint `/v1/chat/completions`
- Anthropic pool `bench-pool-anthropic2` → accounts `bench-anthropic-account-1..4`, route `bench-r9-platform-route-anthropic`, endpoint `/v1/messages` (the chaos driver speaks anthropic only)
- Wallet 100,000,000 minor USD; capacity tenant/project 600k rpm / 600M tpm / 512 concurrent; key 256 concurrent; lease concurrency 64/account

---

## 2. Results vs plan §R9 thresholds

### 2.1 Bench (`bench-3inst.json`, openai protocol, 3 instances, `--account-limit 64`)

| Scenario | Metric | Threshold | Measured | Verdict |
|---|---|---|---|---|
| latency | p99 overhead (non-stream) | < 30 ms | **337.5 ms** (direct p99 6.34 ms → gateway p99 343.9 ms; gateway p50 153 ms) | **FAIL** |
| latency | gateway request errors (300 serial) | — (context) | 125/300 requests never returned 200 (503 blocks) | context |
| ttfb | TTFB overhead (stream) | < 10 ms | **761 ms** (direct p99 8.29 ms → gateway p99 769.3 ms) | **FAIL** |
| ttfb | stream errors | 0 | **45** | **FAIL** |
| sse-integrity | corrupt streams (10 min, c=20) | 0 | **9,605 / 13,289 streams** (all `status 503`/`status 502` rejections; **0 corrupt chunks** across 235,776 chunks on streams that were served) | **FAIL*** |
| concurrency | 200 in-flight, 60 s, transport errors | 0 | **0** | **PASS** |
| concurrency | unexpected 5xx | 0 | **1,103×503 + 65×403, 0 successful** (1,168 requests issued) | **FAIL** |
| precision | over-issue vs `--account-limit 64` | 0 accounts | **0 over-issue** (gateway issued no 429s at all; admission rejected requests before account limits were reachable — precision could not be positively exercised) | PASS (vacuous) |
| scaling | 1→3 instance throughput ratio | ≥ 2.7× | **0×** (1-inst baseline 10 rps → 3-inst 0 rps; 1,026 requests all rejected) | **FAIL** |

\* Every "corrupt" stream in sse-integrity is a stream the gateway **refused to start** (HTTP 503/502 before first byte). Among the streams actually served there was zero payload corruption, zero `bench_seq` discontinuity, and 100% terminal-marker delivery over the full 10 minutes. The scenario as scored counts admission refusals as corruption.

**1-instance baseline** (`bench-1inst-scaling.json`): 10.0 rps at c=200 for 65.3 s — 653×200 / 1,217×503, p50 11.66 s, p90 13.44 s, p99 13.90 s. Throughput ceiling per instance ≈ 10 rps (see §4, findings P3/P4).

### 2.2 Chaos (`chaos-3inst.json`; partial-fault rerun `chaos-account-faults-partial.json`)

| Scenario | Metric | Threshold | Measured | Verdict |
|---|---|---|---|---|
| account-faults (all 4 faulted) | requests to faulted account per fault window | ≤ 5 | **84 / 88 / 69 / 65** (401/429/403/midstream windows) | **FAIL** |
| account-faults (all 4) | post-warmup success rate | ≥ 0.9 | **0.255** (521 ok / 1,661; 401×304, 429×325, 403×244, 503×169, 502×3, transport×95) | **FAIL** |
| account-faults (2 of 4 faulted, rerun) | requests to faulted account per window | ≤ 5 | **50 / 53 / 62 / 25** | **FAIL** |
| account-faults (2 of 4) | post-warmup success rate | ≥ 0.9 | **0.603** (875 ok / 1,427; 503×229 beyond the 302 fault-passthrough failures) | **FAIL** |
| account-faults | leaked upstream connections after drain | 0 | **0** | PASS |
| kill-instance | in-flight streams on kill | breakage recorded, not failed | **40/40 broken, 0 completed** (kill at t+2 s of stream) | recorded |
| kill-instance | new requests on survivors (200) | 0 failures | **43 failures** (157×200, 21×403, 22×503) | **FAIL** |
| kill-instance | leaked in-flight upstream connections | 0 | **0** | PASS |
| kill-postgres | fail-closed HTTP errors ≤ 5,000 ms during 30 s outage | clean fail-closed | mixed: 3×503 fail-closed, **17 transport errors** (ECONNREFUSED / UND_ERR_SOCKET mid-request, no HTTP response), 21×**200 served during the outage** (pre-admitted in-flight requests completing against the reachable mock) | **FAIL** |
| kill-postgres | recovery | recovers | **true** — surviving gateways served 200s after PG restart without process restart; killed replica restored via `docker-compose up -d --scale gateway=3` | PASS |

### 2.3 Soak

**Skipped.** The soak scenario's minimum granularity is 1 hour; the session budget could not cover it after the debugging time consumed by the product issues in §4. Recommendation: re-run `--scenario soak` once findings P1/P3/P5/P6 are fixed — current admission behavior makes a 1 h soak equivalent to the 10-minute sse-integrity result (steady 503 shedding).

---

## 3. What actually happened, end to end

1. **Steady-state, low concurrency (≤ ~20 concurrent), warm paths**: the gateway works. Non-stream p50 ≈ 130–300 ms solo/warm (vs 2.7 ms direct), streams complete with zero corruption, both protocols settle correctly, billing/capacity ledgers reconcile.
2. **Under load (c=200)**: per-instance throughput saturates at ≈ 10 rps; everything beyond that is shed as 503 `REQUEST_BLOCKED` (pool exhaustion + health-authority races, §4 P3/P5) and 403 `REQUEST_REJECTED` (concurrency-ledger poisoning, §4 P10).
3. **Streaming load**: 20 concurrent streams cycle fine in isolation (~40–70 streams/s) but the 10-minute sse-integrity run degenerated into continuous 503/402/403 shedding after the ledger poisoned (9,605 refusals).
4. **Chaos**: no fast fail-away from faulted accounts (the scheduler kept dispatching to accounts returning 401/403/429 for the whole 20 s window); post-fault recovery never reached 90%; killing a gateway cleanly broke all 40 in-flight streams (expected) but survivors served only 157/200 new requests; a PG outage produced transport errors instead of uniform fail-closed HTTP, while pre-admitted streams (correctly) completed; recovery after PG restart worked without gateway restarts.

---

## 4. Product findings (all reproduced on this stack; honest, unmitigated)

**P1 — Provider HTTP SSRF policy has no operator escape hatch (blocks every container-network deployment).**
`src/saas/gateway/provider-http-address.ts` `selectPinnedProviderAddress` fail-closes unless every resolved IP is global, and the deny list covers all private/loopback/link-local ranges but there is no config-level allowlist. The mock provider on the compose network (172.x) was rejected as `dispatch_uncertain` (502). *Bench workaround:* dedicated `bench-public-net.override.yml` network on 192.0.2.0/24 (TEST-NET-1, not in the deny list) with alias `bench-provider.internal`. A real in-cluster provider (k8s service, private VPC) cannot be dispatched to at all without this workaround.

**P2 — Evidence re-fetch query planning ≈ 3 s per request under default planner settings.**
The claim-audit evidence re-fetch (`src/saas/supply/repository.ts` ~960–1050, LATERAL over `saas_audit_events`, ~10-table join) planned at **2,950 ms** vs 0.68 ms execution, on every admission (unnamed statements → no plan cache). Solo request latency was a constant 3.3 s. *Bench workaround (DBA-level role tuning, documented deviation):* `ALTER ROLE model_router_saas_gateway SET join_collapse_limit=1, from_collapse_limit=2` → planning 5.3 ms. This is a per-deployment landmine: without it the gateway caps at ~0.3 rps/instance.

**P3 — Connection pool max=10 with 5 s queue-inclusive acquisition timeout sheds load as 503.**
`src/saas/db/database.ts` defaults. Under c=200 the pool + the tenant-wide exclusive advisory-lock serialization of admission (observed ~2.3 s lock waits at c=20) cap throughput at ≈ 10 rps/instance; surplus requests block (503 `REQUEST_BLOCKED`) — 1,217/1,870 in the 1-instance baseline, 100% of c=200 traffic in the 3-instance run.

**P4 — Per-tenant/wallet admission serialization.**
Billing/admission takes exclusive advisory locks per tenant+wallet; at concurrency every admission queues behind the previous one. This is the structural throughput ceiling behind P3.

**P5 — 30 s health-staleness gate with no self-heal; `observed_at` is `clock_timestamp()` (DB clock) while the gate compares against the gateway's `Date.now()`.**
(a) `tryAdmitHalfOpenProbe` has **no caller** in this tree — nothing refreshes account health, so any 30 s quiet phase permanently walls all traffic (`provider account health authority is unavailable`) until externally primed. *Bench workaround:* `bench/health-warmer.sh` re-primes health rows every ~16 s via a lease-authorized probe.
(b) Under load we repeatedly captured blocks with **negative age** (`ageMs: -1…-23`): the health row's `observed_at` (written by Postgres `clock_timestamp()`) was up to ~23 ms **ahead** of the gateway's `input.now`, and `healthValue`/`getSchedulingView` treat `observedAt > now` as malformed → block. With ~15–30 ms of cross-process clock dispersion in the VM this fails ~5–15% of admissions under load. Fix direction: clamp small negative skew, or use one clock source.

**P6 — `writeFailed` latch permanently blocks scheduling after any failed health write.**
`postgres-provider-account-runtime-health-store.ts` (~389/446/538/567): one failed health write (e.g. transient PG error) sets `writeFailed=true` for the process lifetime; `getSchedulingView` then blocks every selection until a gateway restart. Reproduced: after an overload collapse the gateway returned 503 for everything while an in-process replay stayed `prepared`; force-recreate fixed it. (The kill-postgres recovery path survived this time — the latch did not trip during the 30 s outage — but the failure mode was reproduced earlier in the session.)

**P7 — Unknown-outcome recovery worker cannot run: control-plane column grants omit `state_version`.**
`unknown-outcome-recovery-worker.ts` `claimDue` selects `state_version` from `saas_requests`, but the control-plane column grants (`saas/runtime/runtime-privileges.ts` ~2479) do not grant it → `permission denied for table saas_requests` every cycle. Unknown outcomes never auto-reconcile. **Possibly in-flight:** the grants SQL files are being edited in parallel per the task brief; re-verify after that work lands.

**P8 — No fast failure-feedback for faulted provider accounts.**
During every 20 s fault window (401/429/403/midstream, both all-4 and 2-of-4 variants) the scheduler kept dispatching to the faulted accounts (25–88 requests/window vs ≤5 threshold). Errors are passed through to clients, but nothing de-prioritizes or cools down the account within the window. (Caveat: the bench's health warmer re-primes faulted accounts every 16 s, which masks health-based cooldown; but even within a single 16 s window no fail-away was observed.)

**P9 — `not_sent`/`pending` attempts have no legal terminal transition.**
The guard triggers allow terminal results only for dispatch in (`sent`,`unknown`); 60–96 `not_sent/pending` attempt rows from aborted admissions are permanently stuck. Harmless for capacity (parent request is terminal) but they accumulate forever.

**P10 — Stuck execution rows poison the concurrency ledger indefinitely.**
`postgres-preparation-capacity.ts` counts `saas_requests` in (`pending`,`unknown`) with unfinished attempts as in-flight forever. Every mid-stream kill / dispatch timeout / settle-failure burst (e.g. 255 `usage_missing` unknowns) blocks **all** subsequent admission as `rate_limited` (403) until manual SQL reconciliation. This was the proximate cause of the sse-integrity collapse and the 0 rps scaling number: at c=200 the shedding creates unknowns, the unknowns block admission, in a self-sustaining loop. *Bench workaround:* `modules/cleanup-stuck.sql` (trigger-legal two-step reconciliation) run between scenarios.

**P11 — SSE usage extraction fail-closes to `unknown` on missing usage (correct) and on wire-format deviations (harsh).**
The mock originally emitted no usage in SSE streams → every streamed request settled `usage_missing` → unknown → P10 poisoning. Anthropic streams additionally require an `event:` line on **every** SSE event (deltas without one are `malformed_event` → usage unknown → poisoned). *Bench fix (mock side):* terminal usage chunk (openai `include_usage` shape) and full anthropic usage fields (`message_start` input triple + `message_delta` `output_tokens`) with `event: content_block_delta` lines. The product behavior is defensible fail-closed billing, but the blast radius (P10 total admission block) is disproportionate.

**P12 — Over-settlement spending freeze is fail-closed by design (worked as intended).**
When the bench's usage bounds (16) were below actual mock usage (32), settlement wrote a `saas_billing_spending_freezes` row and blocked all admission until the freeze was cleared. Correct product behavior; documented because it was a bench-wiring fault that looked like an outage.

**P13 — Rights versioning permanently orphans pinned pools (operational sharp edge).**
Appending `saas_provider_rights` v2 (to widen endpoint scope) broke both existing pools: the scheduler resolves pool rights with a LATERAL "latest version" pick and requires `pool_rights.version = pool.rights_version`, while a pool's `rights_id`/`rights_version` are immutable identity (triggers). Any rights rotation therefore requires new pools + new grants + new route versions — no in-place path. Also: one account in two pools granted to the same profile fails **all** resolution (`A unique active upstream authority could not be established`) — protocol-specific pools must use disjoint account sets.

**P14 — kill-postgres produces transport errors, not uniform fail-closed HTTP.**
During the 30 s PG outage, 17 requests failed with raw transport errors (ECONNREFUSED / UND_ERR_SOCKET — connection reset mid-request with no HTTP response) instead of a clean 5xx. 21 in-flight requests (admitted before the outage) completed with 200 against the still-reachable provider, which is arguably correct (authorization already granted) but is flagged by the driver.

**Files under parallel edit** (per task brief): `src/saas/gateway/http-handler.ts`, `request-preparation-service.ts`, `catalog/service.ts`, grants SQL. Findings P5b/P7/P10 intersect those areas — they may be in flight; re-verify against the landed versions.

---

## 5. Deviations & bench-side workarounds (all documented, none weaken thresholds)

1. **SSRF provider network** (P1): `bench-public-net.override.yml`, TEST-NET-1 subnet + `bench-provider.internal` alias. Compose override gotcha handled: services on a custom network must re-declare `default: {}` or they silently drop off the default network.
2. **Planner role tuning** (P2): `join_collapse_limit=1`, `from_collapse_limit=2` on the gateway role.
3. **Health warmer** (P5a): `bench/health-warmer.sh` priming loop (~16 s cycle) — required because nothing in the product refreshes health.
4. **Mock conformance fixes** (P11): terminal usage chunks, anthropic usage fields, `event:` lines on anthropic deltas, anthropic non-stream full counter set. All in `deploy/compose/mock-upstream.mjs` (bench tooling, not product source).
5. **Dual-protocol authority**: chaos driver is anthropic-only (`/v1/messages`); seeded a parallel anthropic pool/route/commercial chain (`modules/seed-bench-anthropic.mjs`, `seed-bench-anthropic2.mjs`, `seed-bench-openai2.mjs`). Account sets are disjoint per P13.
6. **`docker` shim** (`bench/bin/docker`) translating `docker compose …` → `docker-compose …` for the chaos driver (plugin syntax unavailable on this host).
7. **Ledger cleanup between scenarios**: `modules/cleanup-stuck.sql` (P10).
8. **Container dist instrumentation** (diagnostics only, reverted on recreate): temporary `console.error` in `http-handler.js` (block reason) and `postgres-provider-account-runtime-health-store.js` (block branch + row detail). Gateways were restarted/recreated afterward; no product source in `src/` was modified.
9. **Soak skipped** (§2.3).
10. **Usage bounds** in `modules/gateway-runtime.mjs` raised to 4096/4096 input/output after the P12 freeze; estimator still returns fixed bounds (bench simplification, documented).
11. Cert regenerated with `bench-provider.internal` SAN; mock force-recreated to serve it (compose does not recreate on file-content change).
12. **Secrets**: all credentials/proxy key/PG passwords are bench-local random values living only in gitignored files (`.env`, `modules/bench-proxy-key`, `modules/seed.env`); none appear in this report or any committed file.

---

## 6. Recommended fix order (by bench impact)

1. P5b (clock-skew negative age) — small fix, removes ~5–15% of under-load blockings.
2. P10 (+P7 recovery worker) — stuck-row reconciliation + working auto-recovery; unlocks every load scenario.
3. P2 — ship the planner fix as a migration/role default.
4. P3/P4 — pool sizing + admission lock granularity; unlocks the throughput/scaling thresholds.
5. P5a (wire the half-open probe) + P6 (writeFailed latch) + P8 (fault feedback) — unlock the chaos thresholds.
6. P1 — operator-configurable egress allowlist for private provider networks.

Once 1–4 land, re-run: `bench-gateway.mjs --scenario all` (openai + anthropic) with a fresh 1-instance baseline, then `chaos-gateway.mjs --scenario account-faults,kill-instance,kill-postgres`.
