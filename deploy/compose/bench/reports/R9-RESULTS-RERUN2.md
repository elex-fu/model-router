# R9 Performance & Chaos Benchmark — Third Run After I1–I3 Fixes

**Date:** 2026-10-16/17 (UTC)
**Runner:** task I4 — third execution of the R9 suite, validating the I-series fixes
**Baselines:** `R9-RESULTS.md` (run 1, task G5) and `R9-RESULTS-RERUN.md` (run 2, task H7, after H1–H6)
**Product under test:** `model-router-saas:local` rebuilt at `8b4661f` (includes 1b04714/I2-P17+P18, cd29865/I1-P15, 8b4661f/I3-P4+P16; image verified to contain the I1 and I3 code paths before bring-up)
**Verdict:** **FAIL (mixed) — 2 of the 3 targeted regressions recovered, 1 target half-fixed with a new residual bug found; every bench throughput/latency threshold is still violated, and the session exposed a compounding systemic cost of the unfixed grant gap.** P17 recovered dramatically (all-4-faulted success 0.067 → 0.425; the 4,698×403 starvation pattern is gone), P18 is fully resolved natively (cold start self-primes, no warmer, no prime script), P15 is half-fixed (the original trigger-read grant gap is closed and proven, but a second grant gap in the same cancel path keeps the stale-admission sweep failing forever — new finding **P15b**), and P4/P16 scaling is still <1× (clean 0.32×) with the c=8 diagnostic confirming the per-tenant admission fence, not instance capacity, is the structural ceiling. No thresholds were weakened; every number below is measured. Raw driver reports (same directory): `bench-1inst-scaling-rerun2.json`, `bench-3inst-rerun2.json`, `chaos-3inst-rerun2.json`, `chaos-account-faults-partial-rerun2.json`, plus labeled diagnostics `bench-3inst-concurrency-clean-rerun2.json`, `bench-3inst-scaling-clean-rerun2.json`, `bench-1inst-c8-diagnostic-rerun2.json`, `bench-3inst-c8-diagnostic-rerun2.json`, `bench-1inst-scaling-anthropic-diagnostic.json`, `bench-3inst-anthropic-diagnostic.json`.

---

## 1. Environment

| Component | Detail |
|---|---|
| Host | Apple M1 Pro (arm64), macOS; colima VM 4 vCPU / 6 GB RAM |
| Docker | 29.5.2; `docker-compose` v5.6.0 standalone (plugin syntax unavailable; `bench/bin/docker` shim for the chaos driver) |
| Stack | **Fresh volume** (postgres-data wiped, full re-migrate + re-seed via the modules/ seed chain), control-plane, gateway ×3, credential-validation-worker, postgres:16-alpine, redis:7-alpine, mock-upstream (HTTPS :18443, control :18080) — all 8 containers healthy at start and left healthy at end |
| Gateway runtime | Node 22.16.0, image rebuilt from `8b4661f`; DB pool default 16 (48 gateway connections observed in `pg_stat_activity` at 3 instances) |
| Provider network | H6 allowlist route (unchanged from run 2): mock on the default compose network via `MODEL_ROUTER_SAAS_PROVIDER_EGRESS_ALLOWLIST=172.16.0.0/12` (override `modules/bench-egress-allowlist.override.yml`); startup log confirms the allowlist line |
| DB role tuning | None (H3 `SET LOCAL` fix carries over) |
| Health warmer | **Not running at any point; no `prime-health.mjs` invocation either** — I2's native cold-start priming replaces both (validated directly, §3.2) |
| Seeded topology | Same chain as runs 1–2 on the fresh DB: `seed-bench.mjs` → `seed-bench-anthropic.mjs` → `seed-bench-anthropic2.mjs` → `seed-bench-openai2.mjs`; openai pool `bench-pool2` (bench-account-1..4), anthropic pool `bench-pool-anthropic2` (bench-anthropic-account-1..4); wallet/capacity/key limits identical |
| Protocol note | **All headline bench numbers use `--protocol openai`, exactly matching runs 1–2.** The bench driver's *default* is anthropic (`BENCH_PROTOCOL ?? 'anthropic'`, `scripts/ops/bench-gateway.mjs:91`); an early un-flagged pass accidentally measured the anthropic route end-to-end and is preserved as labeled diagnostics (§5.4) |

---

## 2. Results vs plan §R9 thresholds (Run 1 → Run 2 → Run 3)

### 2.1 Bench (`bench-3inst-rerun2.json`, openai protocol, 3 instances, `--account-limit 64`)

| Scenario | Metric | Threshold | Run 1 | Run 2 | Run 3 | Verdict |
|---|---|---|---|---|---|---|
| latency | p99 overhead (non-stream) | < 30 ms | **337.5 ms** (125/300 blocked) | **185.1 ms** (0 errors; gw p50 154.0) | **1368.3 ms** (direct p99 72.5 → gw p99 1440.8; gw p50 192.0; gw p90 931.3 — periodic multi-second spikes; 1/300 non-200) | **FAIL** (worse than run 2; see §3.5 — direct-path p99 itself degraded 5→72 ms this session) |
| ttfb | TTFB overhead (stream) | < 10 ms | **761 ms** | **181.4 ms** | **270.1 ms** (gw p99 280.0) | **FAIL** (worse than run 2, better than run 1) |
| ttfb | stream errors | 0 | **45** | **1** | **0** | **PASS** ✅ |
| sse-integrity | corrupt streams (10 min, c=20) | 0 | **9,605 / 13,289** (all refusals) | **95 / 9,962** (0 corrupt chunks) | **69 / 5,501** (66×503 + 3×502 admission refusals; **0 corrupt chunks** across 347,648 chunks; strict `bench_seq` continuity, 100% terminal markers) | **FAIL** (refusal rate 1.25% vs run 2's 0.95% — comparable; absolute count improved) |
| concurrency | transport errors (c=200, 60 s) | 0 | **0** | **0** | **18** (18×60 s TimeoutError; clean re-measure on drained ledger: 16) | **FAIL** (new violation class vs run 2) |
| concurrency | unexpected 5xx (c=200, 60 s) | 0 | **1,168** (0 ok) | **1,181** (439 ok at 6.7 rps) | in-suite: **431** (101 ok at 1.11 rps; 24×403 + 68×502 + 363×503); clean re-measure: **946** (2 ok; 75×403 + 17×502 + 929×503) | **FAIL** (fewer 5xx than run 2, but successes collapsed late in the session — §3.5) |
| precision | over-issue vs account limit 64 | 0 accounts | 0 (vacuous) | **0** (359 dispatches, maxInFlight ≤ 2) | **0** (oracle positively exercised: 111 dispatches across bench-account-1..4, maxInFlight ≤ 2) | **PASS** ✅ |
| scaling | 1→3 instance throughput ratio | ≥ 2.7× | **0×** | **0.493×** (9.94 → 4.9 rps) | in-suite: **0.099×** (10.14 → 1.0 rps); **clean re-measure on drained ledger: 0.32×** (10.14 → 3.24 rps) | **FAIL** (see §3.4 — the c=8 diagnostic shows the ceiling is the per-tenant fence, not instances) |

**1-instance baseline** (`bench-1inst-scaling-rerun2.json`): **10.14 rps** at c=200 for 78.9 s (800×200 / 754×503; p50 13.4 s, p99 19.4 s) — statistically identical to run 2's 9.94 rps. Variance disclosure: repeated c=200 baselines this session ranged 5.6–10.1 rps. Two systematic effects were isolated: (a) a gateway's *first* c=200 run after (re)create measures ≈ 5.6–5.7 rps vs ≈ 9–10 warm (JIT/pool warmup); (b) back-to-back c=200 runs self-poison — each run leaves in-horizon stuck pendings (600 s ledger horizon) that consume the 256-key concurrency budget (observed 9.6 → 8.4 → 6.6 rps across consecutive runs, recovering to 10.14 only after full horizon drain). The official baseline (10.14) was taken on a warm gateway with a fully drained ledger, matching run 2's methodology.

### 2.2 Chaos (`chaos-3inst-rerun2.json`; partial rerun `chaos-account-faults-partial-rerun2.json`)

| Scenario | Metric | Threshold | Run 1 | Run 2 | Run 3 | Verdict |
|---|---|---|---|---|---|---|
| account-faults (all 4 faulted) | requests to faulted account per fault window | ≤ 5 | **84 / 88 / 69 / 65** | **21 / 25 / 28 / 69** | **31 / 8 / 16 / 42** (401/429/403/midstream; midstream concentrated on 2 accounts: 38/42) | **FAIL** (429/403/midstream improved vs run 2; 401 window regressed 21 → 31) |
| account-faults (all 4) | post-warmup success rate | ≥ 0.9 | **0.255** | **0.0666** (4,698×403 gateway rejections — P17) | **0.4248** (256/515; statuses 401×115, 403×53, 429×28, 503×13, transport×50 — provider statuses passed through, **no gateway-403 starvation pattern**) | **FAIL — RECOVERED from the run-2 regression** (0.067 → 0.425; §3.3) |
| account-faults (2 of 4 faulted) | requests to faulted account per window | ≤ 5 | **50 / 53 / 62 / 25** | **9 / 8 / 9 / 7** | **9 / 5 / 5 / 5** (401/429/403/midstream) | **FAIL by one window** (429/403/midstream now *within* threshold; 401 window 9) |
| account-faults (2 of 4) | post-warmup success rate | ≥ 0.9 | **0.603** | **0.957** | **0.9199** (573/635; 401×17, 403×9, 429×6, 503×24, transport×6) | **PASS** ✅ |
| account-faults | leaked upstream connections after drain | 0 | **0** | **0** | **0** (both variants) | PASS |
| kill-instance | in-flight streams on kill | recorded, not failed | 40/40 broken | 40/40 broken | **40/40 broken, 0 completed** | recorded |
| kill-instance | new requests on survivors (200) | 0 failures | **43** (157×200) | **36** (164×200, 36×403) | **12** (188×200, 12×403) | **FAIL** (improved 3× vs run 1, 3× vs run 2) |
| kill-instance | leaked in-flight upstream connections | 0 | **0** | **0** | **0** | PASS |
| kill-postgres | fail-closed during 30 s outage | clean fail-closed HTTP only, ≤ 5 s | 3×503 + **17 transport** + **21×200 served** | 12×503 + **22 transport**, 0×200 | 19×503 + **38 transport** (34 ECONNREFUSED + 4 UND_ERR_SOCKET; 38 violations), **0×200 served during the outage** | **FAIL** (transport count worse than run 2; the 200s-during-outage elimination holds) |
| kill-postgres | recovery after restart | recovers | true | true | **true** (no gateway restarts; 3-instance set restored for the partial rerun) | PASS ✅ |

### 2.3 Soak / token-expiry

**Skipped**, same as runs 1–2 (1 h minimum exceeds the session budget; token-expiry remains opt-in and the runtime module does not implement the mock OAuth flow).

---

## 3. Fix-by-fix verification (what the numbers prove)

1. **P15 / I1 grant closure — HALF-VALIDATED; new residual gap (P15b).** The original P15 root cause is fixed: replaying `cancelStaleAdmission`'s steps as the control-plane role on live stuck rows, the candidate SELECT, both `FOR UPDATE` reads, and the previously-failing `UPDATE saas_attempts` (whose 018/019 guard trigger reads `saas_requests.supply_profile_id`/`endpoint`) all succeed — `supply_profile_id`/`endpoint` SELECT grants are present in the applied template. But the sweep *still* fails on every candidate, and **I1's new count-only warn surfaced it exactly as designed**: `model-router unknown-outcome recovery: 25 stale-admission cancellation(s) failed this cycle and will retry; a non-varying count indicates a systematic failure…` (no tenant/request identifiers, no error text — 700+ cycles observed). PostgreSQL's error log names the real failure: **`permission denied for table saas_api_key_budget_reservations`** — the cancel path's `keyBudget.release` (`releaseKeyBudgetReservation`, `src/saas/keys/budget-store.ts:527-541`) UPDATEs `saas_api_key_budget_reservations` (and `adjustCounters` decrements `token_outstanding_reserved`/`charge_outstanding_reserved` on `saas_api_key_budget_counters`), but the control-plane role holds **SELECT-only** on the reservations table and UPDATE grants only on `token_settled`/`charge_settled`/`updated_at` for the counters table (`src/saas/db/runtime-privileges.ts:908-919`; the gateway role has the needed UPDATE(state, updated_at) at :4108-4111). Consequence: the stale-admission cancel actor still never succeeds — 250 pending/unknown rows were stuck at session end, and the endlessly-retrying sweep generated **27,700 `permission denied` errors** (≈25 doomed transactions every ~10 s cycle for the whole session). Fix direction: add `UPDATE(state, updated_at)` on `saas_api_key_budget_reservations` and `UPDATE(token_outstanding_reserved, charge_outstanding_reserved)` on `saas_api_key_budget_counters` to the control-plane grant mirror. **Not fixed here (product source change; documented per red lines).**
2. **P18 / I2 cold-start priming — VALIDATED natively.** Fresh volume, zero health rows, **no warmer and no prime script at any point**: the very first openai request returned 200 in ~1.0 s (probe included), the first anthropic request 200 in ~0.6 s, and the health table filled to 8 rows (one per account, both pools) written by traffic alone. The run-2 residual (a freshly seeded deployment walled until externally primed) is gone.
3. **P17 / I2 cooldown all-excluded fallback — VALIDATED (regression recovered).** With all 4 anthropic accounts faulted, run 2 collapsed to 0.0666 because in-process cooldown emptied the candidate set and admission failed closed as gateway 403 (4,698 of 5,371 requests). Run 3 measures **0.4248** with the failure budget now dominated by *provider* statuses passed through to clients (401×115, 429×28, 403×53) plus 503×13 and transport×50 — the gateway-403 starvation pattern is absent (53×403 total across 515 requests). The 2-of-4 variant stays above threshold (0.9199). The remaining distance to 0.9 in the all-4 case is the fail-away speed itself (windows 31/8/16/42): with every candidate faulted, clients see the provider's status until the cooldown/fail-away machinery moves traffic — which is the correct degraded-mode behavior, but still slower than the ≤5-requests-per-window classification target.
4. **P4/P16 / I3 late tenant fence — scaling still FAIL; the fence is confirmed as the structural ceiling.** Clean, drained-ledger measurement: 1 instance 10.14 rps → 3 instances 3.24 rps = **0.32×** (in-suite, after ~45 min of accumulated session state: 0.099×). The supplementary **c=8 diagnostic** (`bench-1inst-c8-diagnostic-rerun2.json`, `bench-3inst-c8-diagnostic-rerun2.json`) is the decisive evidence: at c=8, 1 instance = 9.61 rps and 3 instances = 10.88 rps (**1.13×**) — i.e. even at trivial load the tenant's total admission rate sits at ~10 admissions/s regardless of instance count, because every admission serializes on the tenant-scoped advisory lock (`pg_advisory_xact_lock(hashtextextended('model-router:request-capacity:tenant:<id>'))`, `postgres-preparation-capacity.ts` `takeScopeLock`), which I3 deliberately kept as the single late fence for double-spend safety. Adding instances cannot raise a per-tenant serialized rate; at c=200 the 3 processes' 48 pool connections additionally contend on the same fence/row convoy, driving the ratio *below* 1. This matches the I3 report's own statement that a single-wallet (single-tenant) bench cannot exceed ~1× by design. **Multi-key and multi-wallet traffic cannot change this** — the fence is tenant-scoped and covers every project/key/wallet of the tenant (code-cited equivalence proof in `postgres-preparation-capacity.ts:196-232`). A meaningful ≥2.7× scaling demonstration requires a multi-tenant topology, which this bench's single-tenant seed chain does not express (a second full supply-chain tenant seeder was out of this session's time budget; §5.6).
5. **Session degradation caveat (honesty note on absolute numbers).** The run-3 absolute numbers for the late-suite scenarios are *worse* than run 2 (concurrency 101 ok in-suite and 2 ok on the clean re-measure vs run 2's 439; direct-to-mock p99 72.5 ms vs run 2's 5.3 ms; solo warm p50 ~250 ms vs run 2's ~154 ms). Two compounding causes were identified, neither attributable to the I-series code: (a) the P15b perpetual sweep loop (§3.1) is a sustained background PG load that grows with the stuck-row count (25 doomed transactions/cycle, 27,700 permission errors, 250 stuck rows by session end); (b) general VM/session aging (the mock's direct p99 rose 3→10→72 ms across the session even for paths that never touch PG). The *relative* comparisons that matter for the I-series verdicts (P17 success rate, P18 cold start, P15 reproduction, the 1-inst vs 3-inst ratios measured back-to-back on drained ledgers) were all taken under matched conditions.
6. **P10 / ledger horizon — still behaviorally bounded, with a measured caveat.** No `cleanup-stuck.sql` at any point; no admission wall ever formed; the in-horizon stuck count returned to 0 repeatedly without operator action. Caveat measured this run: within the 600 s horizon, stuck pendings from one c=200 run measurably depress the next (§2.1 variance note) — bounded, self-draining, but real.
7. **P6 / writeFailed latch — not tripped.** The PG outage + recovery cycle completed with no gateway wedge; no negative-age blocks observed all session (P5b skew clamp holds).

---

## 4. Findings disposition (P1–P18 from runs 1–2, plus new)

| # | Finding | Disposition after run 3 | Evidence |
|---|---|---|---|
| P1 | SSRF policy has no operator escape hatch | **RESOLVED** (H6, re-validated) | Allowlist route active on the default compose network; both protocols 200 end-to-end |
| P2 | Evidence re-fetch plans at ~3 s | **RESOLVED** (H3, re-validated) | No role tuning; solo warm p50 stable ~250 ms (elevated vs run 2's 154 ms — session environment, §3.5; no planning signature) |
| P3 | Pool max + acquisition timeout sheds as 503 | **PARTIAL** (H4) | Pool 16 ×3 verified; session totals 370/93/136 `timeout exceeded` pool-acquisition errors across gateway-1/2/3 |
| P4 | Per-tenant admission serialization | **UNRESOLVED — structural, by I3 design** | Clean 0.32×; c=8 diagnostic 1.13× with ~10 admissions/s tenant ceiling on both counts (§3.4) |
| P5 | Health staleness: no self-heal + skew | **RESOLVED** (H1/H5) | No staleness wall all session with zero warming |
| P6 | `writeFailed` permanent latch | **RESOLVED by design** | Not tripped; PG outage/recovery clean |
| P7 | Recovery worker blocked on grants | **PARTIAL** | Worker runs; 0 permission errors on claim/case paths; sweep still fails on P15b |
| P8 | No fast failure-feedback for faulted accounts | **PARTIAL (improving)** | All-4 windows 21/25/28/69 → 31/8/16/42; 2-of-4 windows 9/8/9/7 → 9/5/5/5 (three windows now pass); 401 windows remain the slowest to cool; midstream still excluded from in-process cooldown by design (H5c) |
| P9 | `not_sent`/`pending` attempts have no terminal actor | **PARTIAL — blocked by P15b** | 250 pending/unknown rows at session end; cancel actor still never succeeds |
| P10 | Stuck rows poison the concurrency ledger forever | **RESOLVED behaviorally** (H2) | No manual cleanup; no admission wall; horizon drain observed repeatedly; in-horizon depression of consecutive runs measured and disclosed (§3.6) |
| P11 | SSE usage fail-closed → unknown poisoning | **N/A (bench-side fixed)** | 0 corrupt chunks both protocols, all runs |
| P12 | Over-settlement spending freeze | **N/A (bench wiring)** | No freeze hit |
| P13 | Rights versioning orphans pinned pools | **UNRESOLVED / DEFERRED** | Fresh-DB seed chain used the same `*2`-seeder workaround as runs 1–2 |
| P14 | kill-postgres transport errors, not fail-closed HTTP | **UNRESOLVED (worse this run)** | 22 → 38 transport errors (34 ECONNREFUSED + 4 UND_ERR_SOCKET); 0×200-during-outage holds for the second consecutive run |
| P15 | Control-plane grants miss guard-trigger columns | **HALF-RESOLVED (I1)** | Trigger-read gap closed and proven by direct role replay; **P15b residual below** |
| P16 | 3 instances halve throughput | **UNRESOLVED — same root as P4** | 0.32× clean (run 2: 0.493×); in-suite 0.099× under session degradation |
| P17 | All-faulted success collapse (H5c regression) | **LARGELY RECOVERED (I2)** | 0.0666 → 0.4248; provider-status passthrough restored; no gateway-403 starvation |
| P18 | Zero-health-row cold start walls traffic | **RESOLVED (I2)** | Native self-priming validated: first request 200, health rows written by traffic alone, no warmer/prime (§3.2) |

### New finding from this run

**P15b (new, product bug — the residual half of P15) — control-plane grants miss the key-budget release path; the stale-admission sweep fails on every candidate forever, with a compounding systemic cost.**
The I1 audit closed the guard-trigger SELECT gaps but not the cancel path's `keyBudget.release`: `releaseKeyBudgetReservation` needs `UPDATE(state, updated_at)` on `saas_api_key_budget_reservations` (its `SELECT … FOR UPDATE` prices as UPDATE privilege on ≥1 column — the same PG rule I1 itself documented for the 028 guard) and `adjustCounters` needs `UPDATE(token_outstanding_reserved, charge_outstanding_reserved)` on `saas_api_key_budget_counters`; the control-plane role has SELECT-only on the former and settled-columns-only UPDATE on the latter (`src/saas/db/runtime-privileges.ts:908-919`). Every cycle of `sweepStaleAdmissions` runs up to 25 doomed transactions that roll back at the first key-budget statement. Measured consequences on this deployment: **250 permanently stuck pending/unknown rows**, **27,700 `permission denied` errors** in the PG log (≈2/s sustained), continuous background PG churn that plausibly contributed to the late-session throughput degradation (§3.5), and the I1 warn line firing non-stop — which is the visibility fix working exactly as specified, and is precisely how this residual was found within minutes. Capacity impact remains bounded by the 600 s ledger horizon (no admission wall at any point). Fix: two additional column-grant lines in the control-plane mirror in `src/saas/db/runtime-privileges.ts` (and `deploy/managed-saas-postgres-roles.sql`). **Not fixed here (product source change; documented per red lines).**

---

## 5. Deviations & diagnostics (none weaken thresholds)

1. **Egress-allowlist route** (same as run 2), no TEST-NET-1 overlay, no DBA role tuning, no `cleanup-stuck.sql` at any point.
2. **No warmer and no prime script** — stricter than run 2 (which primed once at cold start); required to validate I2/P18 natively.
3. **Protocol-flag discovery (methodology, not a product finding):** the bench driver defaults to anthropic; runs 1–2 used `--protocol openai`. An early un-flagged pass (one full 3-inst suite + several 1-inst baselines) measured the anthropic route — **saved as labeled diagnostics** (`bench-*-anthropic-diagnostic.json`; anthropic p99 overhead 1479 ms, TTFB 690 ms, sse 333/3,676 refusals with 0 corrupt chunks, concurrency 325 ok / 3.99 rps, scaling 3.93 rps — the anthropic route carries materially higher overhead and the same sub-1× scaling). All headline numbers in §2 were re-measured with `--protocol openai` on drained ledgers. The protocol mix-up also produced a useful cross-check: openai-protocol client traffic served via the anthropic route (o→a bridge) worked end-to-end with correct per-account attribution at the mock.
4. **Baseline variance disclosed:** five 1-inst c=200 measurements (5.59 cold / 9.6 / 8.36 / 6.59 / 6.82 contaminated / **10.14 clean-warm official**); the cold-first-run (~5.6 rps) and in-horizon self-poisoning effects are characterized in §2.1.
5. **Clean re-measures of the late-suite scenarios** (`bench-3inst-concurrency-clean-rerun2.json`, `bench-3inst-scaling-clean-rerun2.json`) taken after full 600 s ledger drain, to separate the I3 signal from session degradation; both the in-suite and clean numbers are reported.
6. **c=8 scaling diagnostic** (§3.4) substitutes for the multi-tenant scaling demonstration the mission suggested: multi-key/multi-wallet load provably cannot raise the ceiling (the fence is tenant-scoped), and a second full supply-chain tenant seeder exceeded the session budget. The c=8 pair (9.61 → 10.88 rps, 1.13×) plus the code-cited fence establish the same conclusion a multi-tenant run would frame: positive scaling requires tenant-parallel load.
7. **Soak and token-expiry skipped** (same as runs 1–2).
8. **Secrets:** all credentials live only in gitignored files (`.env`, `modules/bench-proxy-key`, `modules/seed.env`); none appear in this report or any committed JSON.

---

## 6. Recommended next steps (by measured impact)

1. **P15b** (two column-grant lines) — trivial; unblocks the sweep, clears the 250-row backlog automatically, and removes the 2/s doomed-transaction churn that this run showed depresses everything else.
2. **P4/P16** — the c=8 diagnostic shows instance count is nearly irrelevant to per-tenant throughput; the ≥2.7× target needs either de-serialized admission (optimistic/sharded admission) or a bench topology with ≥3 tenants. Ship a second-tenant seeder before the next R9 re-run so scaling is measured on tenant-parallel load.
3. **P8/P17 residual** — the 401 fault window (31 all-4 / 9 partial) is now the slowest fail-away path; midstream stays excluded from in-process cooldown by design.
4. **P14** — transport-error count during PG outages worsened (38); uniform fail-closed HTTP is still missing.
5. **Latency overhead** — unchanged workstream; the admission path is ~190–250 ms p50 solo regardless of protocol this session.
6. Re-run soak once 1–2 land.

The stack is left running and healthy (3 gateways, mock, control-plane, worker, postgres, redis) with the egress-allowlist override in the compose set; colima VM healthy.
