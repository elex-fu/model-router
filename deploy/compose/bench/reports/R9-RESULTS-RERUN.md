# R9 Performance & Chaos Benchmark — Re-run After H1–H6 Fixes

**Date:** 2026-10-16 (UTC)
**Runner:** task H7 — re-execution of the R9 suite against the fixed product
**Baseline:** `R9-RESULTS.md` (task G5, same stack shape, same drivers, same thresholds)
**Product under test:** `model-router-saas:local` rebuilt at `2ed1faf` (includes da5fbe2/H6-P1, 228c168/H4-P3+P4, 0e386f6/H3-P2, dc55447/H1+H5-P5+P6+P8, 2ed1faf/H2-P7+P9+P10)
**Verdict:** **FAIL (materially improved) — 6/6 bench thresholds and the core chaos thresholds are still violated, but nearly every number moved in the right direction; 2 chaos thresholds flipped to PASS; 1 regression (all-4-fault success rate) with an understood mechanism; 1 new product bug found (P15, grants).** No thresholds were weakened; nothing below is projected. Raw driver reports (same directory): `bench-1inst-scaling-rerun.json`, `bench-3inst-rerun.json`, `chaos-3inst-rerun.json`, `chaos-account-faults-partial-rerun.json`, plus the labeled supplementary diagnostic `bench-1inst-pool32-concurrency-rerun.json`.

---

## 1. Environment

| Component | Detail |
|---|---|
| Host | Apple M1 Pro (arm64), macOS; colima VM 4 vCPU / 6 GB RAM |
| Docker | 29.5.2; `docker-compose` v5.6.0 standalone (plugin syntax unavailable; `bench/bin/docker` shim for the chaos driver) |
| Stack | **Fresh volume** (postgres-data wiped, full re-migrate + re-seed), control-plane, gateway ×3, credential-validation-worker, postgres:16-alpine, redis:7-alpine, mock-upstream (HTTPS :18443, control :18080) |
| Gateway runtime | Node 22.16.0, image rebuilt from `2ed1faf`; DB pool default 16 (verified: 16 gateway connections in `pg_stat_activity`) |
| **Provider network** | **H6 allowlist route:** mock reached on the **default compose network** (`mock-upstream` → 172.18.0.4, inside the built-in 172.16.0.0/12 deny range) via `MODEL_ROUTER_SAAS_PROVIDER_EGRESS_ALLOWLIST=172.16.0.0/12` on the gateway (override `modules/bench-egress-allowlist.override.yml`). The first run's TEST-NET-1 `bench-public-net.override.yml` workaround is **dropped**. Startup log confirms: `model-router provider egress allowlist: 172.16.0.0/12` |
| **DB role tuning** | **None.** The first run's `join_collapse_limit` role workaround is not applied — the H3 `SET LOCAL` fix replaces it (validated: solo p50 154 ms vs 3.3 s untuned / 153 ms tuned in run 1) |
| **Health warmer** | **Not running at any point.** H5a self-heal validated directly (see §3) |
| Seeded topology | Same chain as run 1 on the fresh DB: `seed-bench.mjs` → `seed-bench-anthropic.mjs` → `seed-bench-anthropic2.mjs` → `seed-bench-openai2.mjs`; openai pool `bench-pool2` (bench-account-1..4), anthropic pool `bench-pool-anthropic2` (bench-anthropic-account-1..4), wallet/capacity/key limits identical (600k rpm / 512 project / 256 key concurrent, lease 64/account) |

---

## 2. Results vs plan §R9 thresholds (before → after)

### 2.1 Bench (`bench-3inst-rerun.json`, openai protocol, 3 instances, `--account-limit 64`)

| Scenario | Metric | Threshold | Run 1 (before) | Re-run (after) | Verdict |
|---|---|---|---|---|---|
| latency | p99 overhead (non-stream) | < 30 ms | **337.5 ms** (direct p99 6.34 → gw p99 343.9; 125/300 requests 503-blocked) | **185.1 ms** (direct p99 5.25 → gw p99 190.4; **0/300 errors**; gw p50 154.0) | **FAIL** (improved 45%) |
| ttfb | TTFB overhead (stream) | < 10 ms | **761 ms** (gw p99 769.3) | **181.4 ms** (gw p99 188.9) | **FAIL** (improved 76%) |
| ttfb | stream errors | 0 | **45** | **1** | **FAIL** (improved) |
| sse-integrity | corrupt streams (10 min, c=20) | 0 | **9,605 / 13,289** (all admission refusals; 0 corrupt chunks on served streams) | **95 / 9,962** (48×503 + 47×502 refusals; **0 corrupt chunks** across 631,488 chunks; strict `bench_seq` continuity and 100% terminal markers on all served streams) | **FAIL** (improved 99%) |
| concurrency | transport errors (c=200, 60 s) | 0 | **0** | **0** | **PASS** |
| concurrency | unexpected 5xx (c=200, 60 s) | 0 | **1,168** (1,103×503 + 65×403; 0 successful) | **1,181** (1,134×503 + 42×502 + 5×403; **439 successful** at 6.7 rps) | **FAIL** (error count ~unchanged; successes 0 → 439) |
| precision | over-issue vs account limit 64 | 0 accounts | 0 (vacuous — admission shed before accounts were reachable) | **0 over-issue** (maxInFlight ≤ 2 per account across 359 successful dispatches — **positively exercised this time**, still zero over-issue) | **PASS** |
| scaling | 1→3 instance throughput ratio | ≥ 2.7× | **0×** (1-inst 10.0 rps → 3-inst 0 rps; ledger poisoned) | **0.493×** (1-inst 9.94 rps → 3-inst 4.9 rps — **3 instances halve throughput**; see P16) | **FAIL** (0 → 0.493; regression vs 1-inst is a new finding) |

**1-instance baseline** (`bench-1inst-scaling-rerun.json`): 9.94 rps at c=200 for 68.8 s (684×200 / 1,420×503 / 58×403; p50 11.9 s, p99 13.8 s) — statistically identical to run 1's 10.0 rps: **the per-instance ceiling is unchanged by the H4 fix** (see P3/P4 and the pool-32 diagnostic below).

### 2.2 Chaos (`chaos-3inst-rerun.json`; partial rerun `chaos-account-faults-partial-rerun.json`)

| Scenario | Metric | Threshold | Run 1 (before) | Re-run (after) | Verdict |
|---|---|---|---|---|---|
| account-faults (all 4 faulted) | requests to faulted account per fault window (401/429/403/midstream) | ≤ 5 | **84 / 88 / 69 / 65** | **21 / 25 / 28 / 69** | **FAIL** (improved ~3× on status faults; midstream unchanged) |
| account-faults (all 4) | post-warmup success rate | ≥ 0.9 | **0.255** (521/1,661; faults passed through to clients) | **0.0666** (481/5,371; **4,698× gateway 403 rejections** — see P17) | **FAIL — REGRESSED** |
| account-faults (2 of 4 faulted) | requests to faulted account per window | ≤ 5 | **50 / 53 / 62 / 25** | **9 / 8 / 9 / 7** | **FAIL** (improved ~6×, near-miss) |
| account-faults (2 of 4) | post-warmup success rate | ≥ 0.9 | **0.603** (875/1,427) | **0.957** (887/940; only 53 failures: 16×401 + 15×403 + 8×429 + 9×502 + 2×503 + 3 transport) | **PASS** ✅ |
| account-faults | leaked upstream connections after drain | 0 | **0** | **0** | PASS |
| kill-instance | in-flight streams on kill | recorded, not failed | 40/40 broken, 0 completed | 40/40 broken, 0 completed | recorded |
| kill-instance | new requests on survivors (200) | 0 failures | **43** (157×200, 21×403, 22×503) | **36** (164×200, 36×403) | **FAIL** (improved) |
| kill-instance | leaked in-flight upstream connections | 0 | **0** | **0** | PASS |
| kill-postgres | fail-closed during 30 s outage | clean fail-closed HTTP only, ≤ 5 s | 3×503 + **17 transport** + **21×200 served during the outage** (38 violations) | 12×503 + **22 transport** (19 ECONNREFUSED + 3 UND_ERR_SOCKET; 22 violations) — **0×200 served during the outage** | **FAIL** (transport errors unchanged; 200s-during-outage eliminated) |
| kill-postgres | recovery after restart | recovers | true (no gateway restarts) | **true** (no gateway restarts; 3-inst set restored for the partial rerun) | PASS ✅ |

### 2.3 Soak / token-expiry

**Skipped**, same as run 1 (soak's 1 h minimum exceeds this session's budget; token-expiry remains opt-in and the runtime module does not implement the mock OAuth flow). With admission still shedding at c=200, a soak would still be dominated by 503s.

---

## 3. Fix-by-fix verification (what the numbers prove)

1. **P1 / H6 egress allowlist — VALIDATED.** The mock now lives on the default compose network (172.18.0.4 — a range the default policy blocks; run 1 proved `mock-upstream` at 172.x was `ProviderHttpAddressPolicyError`-blocked). With `MODEL_ROUTER_SAAS_PROVIDER_EGRESS_ALLOWLIST=172.16.0.0/12` the gateway dispatches to it; both protocols return 200 end-to-end. The TEST-NET-1 overlay is gone. Compose accepted the env var via a small override (`modules/bench-egress-allowlist.override.yml`), and the runtime module's target host was switched back to `mock-upstream`.
2. **P2 / H3 planner pin — VALIDATED.** No role tuning was applied on the fresh volume. Solo warm p50 is 154 ms (run 1: 3.3 s constant untuned, 153 ms with the DBA workaround). The 2.9 s planning component is gone via `SET LOCAL join_collapse_limit=1`. Note the honest caveat: the **full** solo path is still ~154 ms p50 / ~190 ms p99 — the remaining time is admission/dispatch/settlement round trips (auth-only `/v1/models` is already ~57 ms p50), not planning. The <30 ms overhead target needs a much shorter admission path, not a planner fix.
3. **P5a / H5 half-open self-heal — VALIDATED for the stale case.** With no warmer running, health rows were left to age 45+ s past the 30 s maxHealthAge window; the next request returned 200 and the rows' `observed_at` jumped to the probe time. Run 1's permanent 30 s-quiet wall is gone. **Residual (P18):** a *zero-row cold start* still blocks — `getSchedulingView` returns `unknown` (block) for a missing row and the half-open probe only fires on `stale`, so a freshly seeded deployment needs one external prime (this run used `prime-health.mjs` once, at cold start only).
4. **P5b / H1 skew clamp — no negative-age failures observed.** No `observedAt`-in-the-future block appeared anywhere in the run (run 1 saw ~5–15% of admissions blocked under load). Not directly measurable from outside, but the failure mode is absent.
5. **P6 / H5b latch — not tripped.** The PG outage + recovery cycle completed with no gateway wedge; writeFailed backoff was not directly forced (bounded-backoff path untested by circumstance).
6. **P7 / H2 recovery worker — RUNNING (new bug in its sweep, see P15).** Zero `permission denied` in control-plane logs; the scanner has processed every unknown into a reconciliation case: **211/211 unknowns have cases, all escalated to `operator_required`** (correct terminal for evidence-less aborts — killed streams/mid-stream aborts leave no usage evidence to auto-settle).
7. **P10 / H2 ledger horizon — behaviorally validated.** `cleanup-stuck.sql` was **never run** at any point (run 1 needed it between scenarios). Through the full suite — including 95 sse-integrity refusals, the 40 broken kill-instance streams and the PG outage — admission never hit the run-1-style permanent 403 `rate_limited` wall. The residual stuck rows are bounded (see P15/P9 disposition).
8. **P8 / H5c fault feedback — partially effective.** Fault-window dispatches to faulted accounts dropped ~3× (all-4) and ~6× (2-of-4), but remain above the ≤5 threshold; midstream aborts are unchanged because `retryableTransportFailure` deliberately excludes transport failures from the in-process cooldown (they are left to the durable PG cooldown, which did not cool within the 20 s window).
9. **P3/P4 / H4 pool + fence — insufficient at c=200.** Pool 16 is active (verified), but c=200 still sheds: the gateways logged **495 pool-acquisition timeouts** (`timeout exceeded when trying to connect`) across the suite, surfacing as both 503 `REQUEST_BLOCKED` and 502. The supplementary diagnostic (below) proves the binding constraint is the per-wallet admission fence, not the pool.

**Supplementary diagnostic (labeled, not a headline number):** with `MODEL_ROUTER_SAAS_DB_POOL_MAX=32` on a single gateway (env override from H4 — works mechanically), c=200 throughput **dropped** to **1.93 rps** (from 9.94 at pool 16; 1,859×503, p99 37 s). More pool connections = more concurrent fence waiters = longer lock queues and more acquisition timeouts. The H4 env knobs are functional; the c=200 ceiling is admission serialization (P4), and adding pool capacity makes it worse, not better.

---

## 4. Findings disposition (P1–P14 from run 1, plus new findings)

| # | Run-1 finding | Disposition after re-run | Evidence |
|---|---|---|---|
| P1 | SSRF policy has no operator escape hatch | **RESOLVED** (H6) | §3.1 — allowlist env var validated on a genuinely-denied range; workaround overlay dropped |
| P2 | Evidence re-fetch plans at ~3 s | **RESOLVED** (H3) | §3.2 — no role tuning; solo p50 154 ms ≈ run-1 tuned baseline |
| P3 | Pool max=10 + 5 s acquisition timeout sheds as 503 | **PARTIAL** (H4) | Pool 16 active but 495 acquisition timeouts at c=200; pool=32 override works and makes it worse (1.93 rps) → pool size is not the binding constraint |
| P4 | Per-tenant/wallet admission serialization | **UNRESOLVED** | 1-inst ceiling unchanged (10.0 → 9.94 rps); see new P16: 3 instances now *halve* total throughput |
| P5 | Health staleness: no self-heal + negative-age blocks | **RESOLVED for stale + skew; residual for cold start** (H1/H5) | §3.3/§3.4; zero-row bootstrap gap filed as P18 |
| P6 | `writeFailed` permanent latch | **RESOLVED by design** (bounded 1 s→60 s backoff) | Not tripped this run; PG-outage recovery clean (caveat: not directly forced) |
| P7 | Recovery worker blocked on missing column grants | **PARTIAL — worker runs; NEW GRANT BUG (P15)** | 0 permission errors on claim/case paths; 211/211 cases escalated to `operator_required`; but the stale-admission cancel path fails silently on a *different* missing grant (P15) |
| P8 | No fast failure-feedback for faulted accounts | **PARTIAL** (H5c) | Windows 84/88/69/65 → 21/25/28/69 (all-4) and 50/53/62/25 → 9/8/9/7 (2-of-4); midstream unchanged by design |
| P9 | `not_sent`/`pending` attempts have no terminal actor | **PARTIAL** (H2) | The lifecycle is legal and the sweep exists, but it fails on P15's grant gap in practice: 62 not_sent/pending attempts (all on `pending` requests) remain >30 min after the runs |
| P10 | Stuck execution rows poison the concurrency ledger forever | **RESOLVED behaviorally** (H2) | No manual cleanup all run; no admission wall ever; horizon bounds capacity impact. Row-level cleanup still blocked by P15 |
| P11 | SSE usage fail-closed → unknown poisoning | **N/A (bench-side already fixed)** | Mock conformance fixes committed before run 1; 0 corrupt chunks both runs; product fail-closed posture unchanged (by design) |
| P12 | Over-settlement spending freeze | **N/A (bench wiring)** | Usage bounds 4096/4096; no freeze hit this run |
| P13 | Rights versioning permanently orphans pinned pools | **UNRESOLVED / DEFERRED** (no fix claimed by H1–H6) | Fresh-DB seed chain worked around it exactly as run 1 did (the `*2` seeders exist because of this); product sharp edge unchanged |
| P14 | kill-postgres produces transport errors, not uniform fail-closed HTTP | **UNRESOLVED (one dimension improved)** | 17 → 22 transport errors during the outage; but **0×200 served during the outage** (was 21) — pre-admitted in-flight requests now fail closed too |

### New findings from this re-run

**P15 (new, product bug) — control-plane grants miss two `saas_requests` columns the attempts guard trigger reads; the stale-admission cancel sweep fails silently on every candidate.**
`cancelStaleAdmission` (H2) UPDATEs `saas_attempts`; the migration-019 trigger `saas_attempts_guard_dispatch_authority` runs `SELECT supply_mode, supply_profile_id, protocol, endpoint FROM saas_requests …` with the invoker's privileges. The control-plane role's column grants include `supply_mode` and `protocol` but **not `supply_profile_id` and `endpoint`** → `permission denied for table saas_requests` → the whole cancel transaction rolls back → `sweepStaleAdmissions`'s catch swallows it and retries forever. Reproduced directly: the candidate SELECT and both `FOR UPDATE` reads succeed as the control-plane role; the attempts UPDATE fails inside the trigger. Consequence: 53+ never-dispatched stale pendings (62 not_sent/pending attempts) sit at `execution_state='pending'` indefinitely; capacity impact is bounded by the 600 s ledger horizon (traffic was never walled), so this is a row-hygiene + operator-noise bug rather than an outage — but P9's terminal-cancellation actor never succeeds on this deployment. Fix direction: add the two columns to the control-plane grant mirrors in `deploy/managed-saas-postgres-roles.sql` / `src/saas/db/runtime-privileges.ts` (or have the trigger read via a SECURITY DEFINER helper). **Not fixed here (product source change; documented per the task red lines).**

**P16 (new) — 3 gateway instances halve total throughput under single-wallet closed-loop load (scaling 0.493×).**
1-inst: 9.94 rps. 3-inst: 4.9 rps. The per-wallet admission `FOR UPDATE` fence now contends *across processes*: 3 × 16 pool connections queue on the same wallet row, lengthening lock convoys until the 5 s queue-inclusive acquisition timeout sheds requests (495 pool timeouts logged). The pool=32 diagnostic (1-inst, 1.93 rps) confirms the same signature on one process. This is P4's structural serialization, now with a *negative* multi-instance scaling coefficient — the more admission capacity you add, the worse the convoy gets. The ≥2.7× scaling target requires de-serializing admission (per-wallet sharding, shorter fences, or optimistic admission), not more pool/pod capacity.

**P17 (new, regression introduced by H5c) — all-accounts-faulted success rate collapsed 0.255 → 0.067 because in-process cooldown rejects at admission instead of passing provider statuses through.**
With all 4 anthropic accounts faulted, H5c's per-process cooldown (401/403 from first failure, 10 s doubling to 60 s; 429 from second, 1 s to 30 s) marks every candidate account cooled within seconds of each 20 s window, and subsequent admissions fail closed as gateway **403 REQUEST_REJECTED** (4,698 of 5,371 requests) instead of dispatching and surfacing the provider's status. Fail-away is faster (windows dropped ~3×) and the 2-of-4 variant now passes at 0.957, but the zero-healthy-candidates case converts "client sees provider 401/429/403" into "client sees gateway 403" and starves the success metric. Design question for the product: when *every* candidate is in in-process cooldown, admission has no route to a probe — a bounded half-open probe for cooled accounts (mirroring the H5a health probe) would recover this case.

**P18 (new, P5a residual) — cold start with zero health rows still walls traffic.**
`getSchedulingView` returns `unknown` (fail-closed block) when no row exists; the H5a half-open probe only triggers on `stale` (row exists, too old). A freshly seeded deployment cannot serve its first request until something externally primes health (this run: one `prime-health.mjs` invocation at cold start, no recurring warmer). Options: treat a missing row as stale (probe-eligible), or have account provisioning/validation write an initial row.

---

## 5. Deviations & bench-side changes (none weaken thresholds)

1. **Egress allowlist instead of TEST-NET-1** (§3.1): new gitignored override `modules/bench-egress-allowlist.override.yml`; `modules/gateway-runtime.mjs` target host switched `bench-provider.internal` → `mock-upstream`; `bench-public-net.override.yml` dropped from the compose set (chaos `--compose-files` updated to match).
2. **One-time cold-start prime** (`prime-health.mjs`, single invocation on the fresh volume) — required by P18; the recurring `health-warmer.sh` was NOT used at any point.
3. **No planner role tuning** — deliberate, to validate H3 (run 1's workaround would have masked it).
4. **No `cleanup-stuck.sql` at any point** — deliberate, to validate P10 behaviorally.
5. **Fresh volume + full seed chain**; the base seeder's proxy-key write needed a writable mount fix (`SEED_OUT` + a 0777 host dir) — bench-tooling only, DB seeding itself was already complete before the write.
6. **kill-instance victim restored** via `up -d --scale gateway=3` before the partial rerun (the driver's kill leaves the replica down by design).
7. **Supplementary pool-32 diagnostic** (labeled `bench-1inst-pool32-concurrency-rerun.json`, override `modules/bench-pool32.override.yml`) — diagnostic only, excluded from the headline table.
8. **BENCH_FAULT_ACCOUNTS set to the anthropic accounts** (`bench-anthropic-account-1..4` / `-1,-2`), matching what run 1's chaos traffic actually exercised (the driver speaks anthropic; `bench-env.sh`'s default openai-account value was a run-1 shell artifact).
9. **GATEWAY_REPLICAS=3** pinned in the gitignored `.env` so plain `up -d` cannot silently de-scale between scenarios.
10. **Soak and token-expiry skipped** (same as run 1).

---

## 6. Recommended next steps (by measured impact)

1. **P15** (two-column grant fix) — trivial, unblocks P9's cancel actor and clears the pending-row backlog automatically.
2. **P16/P4** — de-serialize admission (the 0.493× scaling coefficient means adding gateways actively hurts); the pool-32 diagnostic shows pool tuning moves it the wrong way.
3. **P17** — bounded probe path for all-cooled candidates to recover the zero-healthy-account case.
4. **P18** — treat missing health rows as probe-eligible (or prime at provisioning) to close the cold-start gap.
5. **Latency overhead (<30 ms)** — needs admission-path statement-count/round-trip reduction (auth alone is ~57 ms on this topology), a different workstream from H1–H6.
6. Re-run soak once 1–2 land.

The stack is left running (3 healthy gateways, mock, control-plane, worker, postgres, redis) with the egress-allowlist override in the compose set.
