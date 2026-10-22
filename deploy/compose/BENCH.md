# R9 performance / chaos benchmark suite (Docker host required)

Runbook for the plan §R9 benchmark suite
(`docs/token-resale-implementation-plan-2026-10-15.md`, task F7/#40). Everything
in this suite **requires a Docker host with the managed-SaaS compose stack
running** — none of it was executed on the authoring machine (no docker/colima
available there). The scripts, mock, and compose overlay were verified offline
to the maximum extent possible: `node --check` on every `.mjs`, argument/config
dry-run self-checks of both drivers, YAML structural validation of the overlay,
and a full local functional exercise of the mock upstream plus the
bench driver's scenarios against a locally-run mock (see "Offline verification"
at the bottom).

## Files

| File | Purpose |
| --- | --- |
| `scripts/ops/bench-gateway.mjs` | Performance driver (latency, ttfb, sse-integrity, concurrency, precision, scaling) |
| `scripts/ops/chaos-gateway.mjs` | Chaos driver (account-faults, kill-instance, kill-postgres, token-expiry, soak) |
| `deploy/compose/mock-upstream.mjs` | Programmable HTTPS mock provider + plain-HTTP control plane |
| `deploy/compose/bench-compose.override.yml` | Compose overlay: `mock-upstream` service (profile `bench`) + gateway `NODE_EXTRA_CA_CERTS` |
| `deploy/compose/bench/certs/` | Operator-generated bench TLS material (gitignored) |
| `deploy/compose/bench/reports/` | Suggested report output location (gitignored) |

Both drivers are Node-builtins-only (no new npm dependencies, same as
`scripts/ops/bench-ollama.mjs`) and never log the proxy key.

## Prerequisites (all of them — none are optional)

1. **Docker host with the base stack up.** Follow `deploy/compose/README.md`
   fully: `.env` filled, trusted modules mounted, `postgres`/`redis` healthy,
   `saas:migrate` run, role templates re-applied, all roles healthy.

2. **Bench TLS certificates** (the gateway's provider transport hard-requires
   `https://` upstream targets — `src/saas/gateway/provider-http-transport.ts`
   `validateTargetUrl`; a plain-HTTP mock can never be used):

   ```bash
   cd deploy/compose
   mkdir -p bench/certs
   openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout bench/certs/mock-key.pem -out bench/certs/mock-cert.pem \
     -days 7 -subj "/CN=mock-upstream" \
     -addext "subjectAltName=DNS:mock-upstream"
   ```

   The overlay mounts `bench/certs` into the gateway containers as
   `NODE_EXTRA_CA_CERTS=/bench-certs/mock-cert.pem`, so the gateway's default
   `fetch` trusts the mock. (`NODE_EXTRA_CA_CERTS` is not a role-scoped
   deployment setting; the deployment parser only fail-closes on the fixed
   cross-role list, so it passes through.)

3. **Operator gateway-runtime module wired to the mock.** This is an
   architectural fact, not a bench deficiency: the managed-SaaS gateway routes
   *only* through the operator-supplied trusted module
   (`MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE`, contract in
   `src/saas/runtime/gateway-runtime-module.ts`). The bench copy of that module
   must:
   - resolve provider-account dispatch targets onto
     `https://mock-upstream:8443/v1/chat/completions` (OpenAI-protocol
     accounts) or `https://mock-upstream:8443/v1/messages` (Anthropic);
   - use the default (or NODE_EXTRA_CA_CERTS-trusting) fetch — no custom
     TLS-rejecting agent;
   - present distinguishable bearer tokens per account (the mock identifies
     accounts by the `Authorization: Bearer <token>` it receives upstream) —
     e.g. `bench-account-1` … `bench-account-N`;
   - for the `token-expiry` scenario only: implement OAuth
     client-credentials refresh against the mock's `POST /oauth/token`.

4. **Seeded bench data**: at least one console-created API key (the
   `BENCH_PROXY_KEY`), its model scopes covering the bench model, and provider
   accounts with **known per-account concurrency limits** (needed by the
   `precision` scenario's over-issue oracle). For the `account-faults` scenario
   you need **≥ 2 accounts, ≥ 1 healthy** so failover has somewhere to go.

5. **Model mapping**: the drivers send model `bench-model` by default
   (`--model` / `BENCH_MODEL` to change). Map it to the mock-routed catalog
   model via your modelMap/catalog configuration, or pass the already-mapped
   public model name.

## Bring-up sequence (Docker host)

```bash
cd deploy/compose

# 1. Generate bench certs (Prerequisite 2) and configure .env additions:
#    GATEWAY_REPLICAS=3
#    GATEWAY_HOST_PORT_START=15007
#    GATEWAY_HOST_PORT_END=15009

# 2. Base stack per README.md (postgres, redis, migrate, role templates, roles)

# 3. Bench overlay: start the mock (profile "bench")
docker compose -f docker-compose.yml -f bench-compose.override.yml \
  --profile bench up -d --wait mock-upstream

# 4. Recreate the gateways so they pick up NODE_EXTRA_CA_CERTS and 3 replicas
docker compose -f docker-compose.yml -f bench-compose.override.yml \
  up -d --scale gateway=3 gateway

# 5. Seed bench data (console API key, provider accounts pointing at the mock
#    via your runtime module) — Prerequisites 3–5.
```

The mock publishes `https://<host>:18443` (provider, TLS) and
`http://<host>:18080` (control) — override with `MOCK_HOST_PORT` /
`MOCK_CONTROL_HOST_PORT`.

### Gateway PostgreSQL pools

Set `MODEL_ROUTER_SAAS_DB_POOL_MAX` and
`MODEL_ROUTER_SAAS_DB_POOL_ACQUISITION_TIMEOUT_MILLIS` in
`deploy/compose/.env`; the base Compose gateway environment forwards them to
each replica, defaulting to 16 connections and a 5000 ms acquisition timeout.
Recreate the gateways after changing these values.

For direct CLI runs, export these variables into each CLI process environment.
Every CLI process and gateway replica owns an independent pool, so include all
processes when budgeting PostgreSQL connections. Provider-account
`maxConcurrency` controls upstream request slots separately from this pool.

### Optional HTTP handler cap

`MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT` is disabled by default when
unset or empty. Set it in `deploy/compose/.env` and recreate the gateways to
forward an explicit value to each replica; for direct CLI runs, export it in
each process environment. A nonempty invalid value fails startup. The value
`8` is an explicit candidate for future benchmark validation.

Each admitted slot remains held until the HTTP handler promise settles,
including its settlement or compensation work. Stream EOF or client abort
does not release the slot early. Detached asynchronous image work after a
`202` response and WebSocket connections are outside this cap.

## Performance suite

```bash
cd <repo root>
export GATEWAY_URLS=http://127.0.0.1:15007,http://127.0.0.1:15008,http://127.0.0.1:15009
export BENCH_PROXY_KEY=<bench api key>
export MOCK_CONTROL_URL=http://127.0.0.1:18080
export MOCK_UPSTREAM_URL=https://127.0.0.1:18443
export NODE_EXTRA_CA_CERTS=deploy/compose/bench/certs/mock-cert.pem

# Self-check first (no network):
node scripts/ops/bench-gateway.mjs --dry-run --scenario all

# Full suite (plan defaults; sse-integrity alone runs 10 minutes):
node scripts/ops/bench-gateway.mjs --scenario all \
  --account-limit <per-account concurrency limit> \
  --out deploy/compose/bench/reports/bench-3inst.json

# Or scenario by scenario:
node scripts/ops/bench-gateway.mjs --scenario latency
node scripts/ops/bench-gateway.mjs --scenario ttfb
node scripts/ops/bench-gateway.mjs --scenario sse-integrity --sse-minutes 10
node scripts/ops/bench-gateway.mjs --scenario concurrency --inflight 200
node scripts/ops/bench-gateway.mjs --scenario precision --account-limit <K>
```

### Targets (plan §R9) and how each is measured

| Target | Scenario | Measurement | Default threshold |
| --- | --- | --- | --- |
| non-streaming p99 proxy overhead < 30ms | `latency` | gateway p99 − direct-to-mock p99 (mock at zero latency, serial) | `--p99-overhead-ms 30` |
| streaming TTFB passthrough overhead < 10ms | `ttfb` | gateway first-body-byte p99 − direct p99 | `--ttfb-overhead-ms 10` |
| SSE zero-corruption, 10min sustained (bridged forms) | `sse-integrity` | every SSE payload carries `bench_seq`; driver enforces strict 0..N−1 continuity + terminal marker; run per protocol with `--protocol anthropic` / `--protocol openai` | `--sse-max-corrupt-streams 0` |
| 200 concurrent in-flight across 3 instances | `concurrency` | closed-loop 200 in flight, round-robin over all URLs; per-instance request counts reported | `--max-transport-errors 0`, `--max-unexpected-5xx 0` |
| 429 precision (zero over-issue) | `precision` | mock is the oracle: per-account `maxInFlight` observed at the upstream vs the configured account limit | zero accounts with `maxInFlight > --account-limit` |
| linear scaling 1→3 ≥ 2.7× | `scaling` | same fixed load on 1 vs 3 instances; ratio of `throughputRps` | `--scaling-min-ratio 2.7` |

The existing `--max-transport-errors` and `--max-unexpected-5xx` budgets apply to
both `concurrency` and `scaling`, with defaults of zero. Scaling counts failed
fetches and body drains as transport errors. HTTP 429 and other non-5xx status
counts remain visible; these budgets introduce no new allowance or failure-rate
threshold for them.

Exit codes: `0` pass / dry-run, `1` threshold violation, `2` bad arguments or
missing config, `3` target unreachable. `--no-fail` keeps exit 0 with
violations recorded in the report.

### Scaling procedure (1 → 3 instances)

```bash
# One instance:
docker compose -f docker-compose.yml -f bench-compose.override.yml up -d --scale gateway=1 gateway
GATEWAY_URLS=http://127.0.0.1:15007 node scripts/ops/bench-gateway.mjs \
  --scenario scaling --scaling-inflight 200 --scaling-seconds 120 \
  --out deploy/compose/bench/reports/bench-1inst.json

# Three instances:
docker compose -f docker-compose.yml -f bench-compose.override.yml up -d --scale gateway=3 gateway
GATEWAY_URLS=http://127.0.0.1:15007,http://127.0.0.1:15008,http://127.0.0.1:15009 \
  node scripts/ops/bench-gateway.mjs --scenario scaling --scaling-inflight 200 --scaling-seconds 120 \
  --baseline-report deploy/compose/bench/reports/bench-1inst.json \
  --out deploy/compose/bench/reports/bench-3inst.json
```

The second run prints and records the 1→3 ratio and fails below 2.7×.
Both reports must have no fatal error or recorded violations, valid positive
scaling throughput and matching HTTP-200/sample counts. The baseline's observed
transport/5xx counters are checked against the **current run's chosen budgets**;
a baseline's own more permissive settings do not make it eligible. A nonexistent
`--baseline-report` path remains an argument error (exit 2). Failed, missing or
malformed evidence in a loaded comparison records `ratio: null`, a fixed invalid
comparison reason, and a violation. The current-build supervisor also checks the
observed counters independently and stops subsequent load after a failed
baseline or full scene, while retaining final statistics, metrics and cleanup.

## Chaos suite

```bash
export GATEWAY_URLS=http://127.0.0.1:15007,http://127.0.0.1:15008,http://127.0.0.1:15009
export BENCH_PROXY_KEY=<bench api key>
export MOCK_CONTROL_URL=http://127.0.0.1:18080
export BENCH_FAULT_ACCOUNTS=<bearer token of the account(s) to fault>

# Self-check (no docker, no network):
node scripts/ops/chaos-gateway.mjs --dry-run --scenario all

# Core chaos scenarios (account-faults + kill-instance + kill-postgres):
node scripts/ops/chaos-gateway.mjs --scenario all

# Opt-in scenarios (NOT part of --scenario all):
node scripts/ops/chaos-gateway.mjs --scenario token-expiry   # see prerequisites below
node scripts/ops/chaos-gateway.mjs --scenario soak --soak-hours 24
```

The chaos driver defaults to `--compose-files
docker-compose.yml,bench-compose.override.yml` and runs all docker commands
from `--compose-dir` (default `deploy/compose`). Keep the `-f` set identical to
the one the stack was brought up with (the bench bring-up sequence above uses
both files), or pass `--compose-files`/`COMPOSE_FILES` to match.

### Scenario semantics

| Scenario | Injects | Verifies (thresholds are flags) |
| --- | --- | --- |
| `account-faults` | 401/429/403 immediate + mid-stream socket abort on the fault accounts, via the mock control plane | failover (post-warmup success ≥ `--fault-min-success-rate` 0.9); health classification (requests to faulted accounts during a fault window ≤ `--classification-max-requests-during-fault` 5); no leaked connections (mock `currentInFlight` → 0 after `--fault-cooldown-seconds`) |
| `kill-instance` | `docker kill` one gateway replica while long streams are in flight | in-flight breakage **counted and recorded, not a failure**; new requests on surviving instances zero-failure (`--kill-post-requests` 200); no leaked upstream connections |
| `kill-postgres` | `docker compose stop postgres` for `--pg-down-seconds` (30) | during outage: no 200s, fail-closed HTTP errors only, latency ≤ `--pg-max-fail-ms` (5000), no transport errors; after restart: recovery to 200 within `--pg-recovery-timeout-seconds` |
| `token-expiry` | `POST /__control/rotate-token` mid-traffic (retires the current bearer → 401 `invalid_grant`) | refresh burst ≤ `--token-max-refresh-burst` (3) per gateway instance (storm detection); recovery window mostly-200; overall success ≥ 0.9 |
| `soak` | none (24h closed-loop traffic at `--soak-concurrency` 8) | per-container RSS growth ≤ `--soak-rss-growth-pct` (50%); gateway fd growth ≤ `--soak-fd-growth` (100); PostgreSQL WAL bytes / connections / db size sampled every `--sample-seconds` (60) into a JSONL trend file |

`token-expiry` is opt-in because it cannot work without the runtime module
implementing OAuth refresh against the mock's `/oauth/token`
(Prerequisite 3, last bullet). The driver exits `2` with an explicit
"prerequisite not met" message if traffic isn't succeeding before rotation.

## Reading the reports

- Both drivers write a JSON report (path printed, or `--out`):
  `config`, per-scenario measurements, and a flat `violations` array
  (`{scenario, metric, value, threshold}`) that exactly mirrors the console
  `VIOLATION` lines. `bench-gateway` also records per-instance request
  distribution and the scaling ratio/baseline linkage.
- The soak writes one JSONL line per sample
  (`docker stats` RSS/CPU/PIDs per container, gateway node-process fd counts,
  PostgreSQL WAL position delta / `pg_stat_activity` count / db size) plus a
  final trends summary in the JSON report.
- Mock-side account stats (`GET /__control/stats`) are the ground truth for
  slot precision and leak checks: the client-side view cannot see upstream
  concurrency.

## Known prerequisites / honest limitations

1. **R6b re-run note (slot pre-check composition).** The pure-PG-lease vs
   Redis-slot concurrency pre-check is a **composition option inside the
   operator gateway-runtime module** (`schedulerAuthorities` /
   `providerPreparationRoute` in `src/saas/runtime/gateway-runtime-module.ts`),
   **not an env-exposed toggle** — the gateway role's env whitelist
   (`src/saas/deployment.ts`) deliberately excludes Redis settings from the
   gateway. Re-running this suite to quantify R6b therefore means swapping the
   runtime-module composition (PG-lease variant vs Redis-slot variant) between
   runs. The bench scripts themselves are agnostic: same commands, compare the
   two reports.
2. **Live-account semantics are simulated by the mock.** Account faults
   (401/429/403, mid-stream aborts, invalid_grant) are mock-injected, which is
   exactly what deterministic chaos testing wants, but it does not prove
   anything about *real* upstream provider behavior (e.g. real Anthropic
   429-window semantics). Health-classification verification is against the
   gateway's reaction to the mock's injected statuses.
3. **Baseline network-path caveat.** The latency/ttfb overhead compares
   bench-host→gateway→mock against bench-host→mock. Both legs share the
   bench-host network; keep the bench driver off the Docker host's saturated
   NICs for clean numbers.
4. **No `/healthz` in managed SaaS.** Gateway reachability probes use
   `/v1/models` (any HTTP answer < 500 proves the listener is alive), matching
   the compose healthcheck philosophy documented in `README.md`.
5. **Scale bound.** The compose port range `15007–15009` caps gateway replicas
   at 3 on one host; more instances need a wider range or an LB in front.

## Offline verification already performed (no Docker host)

- `node --check` clean on all three new `.mjs` files.
- `--dry-run` self-checks of both drivers (config/argument validation, full
  execution plan, missing-env warnings, exit 0; bad args exit 2).
- `bench-compose.override.yml` parsed and structurally validated (services,
  `bench` profile, gateway env merge).
- The mock upstream was run locally (generated throwaway cert) and passed a
  functional test covering: both protocols' non-stream + SSE shapes,
  `bench_seq` integrity encoding, 429 status fault scoping, invalid-grant,
  mid-stream abort-after-N-chunks, delay control, OAuth mint/rotate, and
  per-account stats/drain.
- The bench driver was exercised end-to-end against the locally-run mock
  (mock posed as the "gateway"): all six scenarios ran, reports written,
  thresholds enforced, exit codes correct — including a deliberately corrupted
  stream (seq rewritten by a mangling proxy) being flagged with
  `VIOLATION ... corrupt streams` and exit 1, and a deliberately too-low
  account limit producing the precision over-issue violation and exit 1.
- What is **not** verified offline: any behavior of the real gateway, compose
  topology, docker kill/stop semantics, and the operator-module wiring. Those
  require the Docker host sequence above.
