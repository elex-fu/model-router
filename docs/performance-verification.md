# Console performance verification

`scripts/benchmark-console.mjs` is an isolated, reproducible *exploratory* benchmark for the V2 console design. It creates a fresh config and SQLite database under `mktemp` in the system temporary directory, binds the proxy, admin API, and fixed OpenAI-compatible SSE upstream to `127.0.0.1`, and never reads an existing router config or data directory. It removes only the exact temporary directory it created after a normal completion or error. No real provider is called.

## Run

Build the server first, then run a small smoke profile:

```sh
rtk npm run build:server
rtk node scripts/benchmark-console.mjs --concurrency 4 --requests 12 --history-rows 200 --query-samples 5 --warmup 2
```

The no-argument profile defaults to 100 concurrent SSE requests, 100 requests per measured phase, 1,000 synthetic request/attempt pairs, 20 admin query samples, five warmup requests, 5 ms between mock SSE frames, and a 30 s per-request timeout. For the design's million-row history profile, opt in explicitly on a suitable dedicated 4-logical-core/8-GiB machine with at least 2 GB free in its temporary filesystem:

```sh
rtk node scripts/benchmark-console.mjs --concurrency 100 --requests 1000 --history-rows 1000000 --allow-million --query-samples 20
```

The script caps history at 1 million request/attempt pairs and refuses that size without `--allow-million`. `--help` lists all options. Redirect JSON output to an experiment record if needed; it includes the Git revision, dirty-source flag, machine, exact parameters, observations, baseline availability, and threshold status. A failed request or setup error is reported, not converted into a passing result. For a controlled comparison, run multiple repetitions on an otherwise idle machine and retain the complete JSON from each run; this script does not claim statistical confidence from one run.

## Method and interpretation

The local upstream returns the same three SSE JSON frames, usage frame, and `[DONE]` terminator for every request. The harness checks HTTP 200, terminator presence, and absence of an SSE error event. It measures complete stream latency, rather than time to first token, for a direct-mock phase, proxy with admin disabled, and proxy with admin enabled. `consoleAdditionalProxyP95Ms` is the signed difference between the last two phases' successful-request P95 values; a negative result is sampling noise, not a speedup claim. Phases are sequential, not randomized, and the baseline writes to the same temporary database before the console-on phase.

The other observations are: cursor-based `/requests` pagination P95 (50 rows/page), `/usage/summary` visibility delay after the measured burst, aggregate-job completion time, direct read P95 of the resulting SQLite daily rollup table, `/overview` HTTP P95 after that job, 50 ms sampled peak child RSS, child event-loop-delay P95/max via `monitorEventLoopDelay` at 10 ms resolution, total temporary SQLite/WAL/SHM bytes, and SSE interruption rate. An interruption means a 200 stream lacks `[DONE]` or fails after response headers; other unsuccessful requests are counted separately. The direct daily-rollup read is *not* the admin overview API. `/overview` and `/usage/summary` now have a live minute-preaggregate API path when the native write watermark is fully covered; stale or old databases fall back to exact detail reads. This harness seeds detail in the isolated database, closes the initial store, then calls `SQLiteTelemetryStore.rebuildLiveAggregates({offline:true})` before starting the server. Once the admin API is ready, it verifies the `/overview` live-minute coverage fields before timing that endpoint. A coverage mismatch is a setup failure and produces no benchmark result. JSON records rebuild counts, observed coverage, the actual `preaggregatedOverview` boolean, and `preaggregatedOverviewP95`.

Design targets are console-added proxy P95 at most 10 ms, pagination P95 below 300 ms, preaggregated overview below 500 ms, and usage visibility below 5 s, on the fixed 4-logical-core/8-GiB, 100-concurrent, 1-million-row profile. The JSON marks targets `not_evaluated` unless hardware and workload match that profile, there are at least 1,000 requests per measured phase and 20 query samples, the direct-mock and both proxy phases have all measured requests succeed, and (for overview) live-minute coverage was confirmed. The overview threshold uses P95 measured on the verified preaggregated API path. RSS, event-loop delay, database size, and interruption rate are reported as observations; the design specifies no pass/fail limits for them here. A full-profile result on other hardware is useful for comparison but does not certify the fixed-machine targets.

## Current live-aggregate status

New telemetry writes maintain request/attempt minute aggregates in the same SQLite transaction and advance a coverage sequence. An old database remains on the exact-detail worker path until a **fully stopped** V2 instance is explicitly migrated:

```sh
rtk node dist/cli/index.js telemetry:rebuild-live --config /absolute/path/config.json --expected-revision 1
```

The command requires an exact revision, reserves configured listener ports, refuses any other process holding the telemetry database/WAL/SHM open, and runs the rebuild in a worker. It reports request rows, attempt rows, covered sequence, and elapsed milliseconds. Run it before restarting the service; do not invoke it while serving traffic. Missing `lsof`, an occupied listener, a changed config, or unverifiable file handles cause refusal.

An isolated local sample with 1,000,000 requests and 1,000,000 attempts measured five live `/usage/summary` reads at approximately 18–23 ms after a roughly 39 s offline rebuild core. This sampled only the all-reported-usage path, not the HTTP console, 100 concurrent SSE streams, fixed 4-core/8-GiB hardware, or worst-case missing-usage distinct counting. It does **not** establish the <500 ms overview target or any full-profile threshold. P95 on the minute-preaggregate path is explicitly unavailable rather than inferred from daily or minute P95s.

## Actual small-scale smoke run, 2026-09-23

The command above completed with exit code 0 on Apple M1 Pro, macOS Darwin 25.5.0, 10 logical cores, 16 GiB RAM, Node v24.18.0, Git `29912d80bf4ec6e6d4ec606189e48c384ff8f130` with a dirty worktree. The source/build state was shared with concurrent development, so these values are a harness validation, not a product performance claim.

| Observation | Result |
| --- | ---: |
| Direct mock complete-stream P95 | 20.84 ms |
| Proxy without console complete-stream P95 | 24.98 ms |
| Proxy with console complete-stream P95 | 24.48 ms |
| Signed console additional P95 | -0.50 ms |
| Cursor pagination P95, 5 samples | 5.03 ms |
| Aggregate job completion | 5.17 ms |
| Materialized rollup direct-read P95, 5 samples | 0.02 ms |
| `/overview` after aggregate P95, 5 samples (detail-backed) | 3.53 ms |
| Usage visibility after burst | 3.32 ms |
| Event-loop-delay P95, console off / on | 10.70 / 11.60 ms |
| Sampled peak child RSS, console off / on | 132,890,624 / 150,913,024 bytes |
| SQLite files, including WAL/SHM | 2,255,088 bytes |
| SSE interruptions / successful proxy-on requests | 0 / 12 |

This historical smoke run predates the harness offline rebuild and coverage check. Its overview result was detail-backed and must not be read as a preaggregated overview measurement. For the updated harness, the smoke command above should report `overviewCoverage.preaggregated: true` and `baseline.preaggregatedOverview: true`. Threshold statuses remain `not_evaluated` because this small profile does not match the fixed hardware and load profile; it does not establish any design threshold.

## Actual small-scale smoke run, 2026-09-24

The instrumented benchmark completed successfully on the same Apple M1 Pro host (10 logical cores, 16 GiB RAM, Node v24.18.0) using concurrency 4, 12 measured requests per phase, 200 seeded request/attempt pairs, five query samples, two warmups, and a 10 s per-request timeout. Direct mock, proxy without console, and proxy with console each succeeded for 12/12 requests. There were zero stream interruptions, and usage became visible 34.74 ms after the measured burst.

| Observation | Result |
| --- | ---: |
| Direct mock complete-stream P95 | 22.01 ms |
| Proxy without console complete-stream P95 | 781.50 ms |
| Proxy with console complete-stream P95 | 799.85 ms |
| Signed console additional P95 | 18.35 ms |
| Usage visibility after burst | 34.74 ms |
| SSE interruptions / successful proxy-on requests | 0 / 12 |

The first instrumented reproduction found that proxy timing values from fractional `performance.now()` elapsed milliseconds reached telemetry persistence, whose live first-event histogram requires integer milliseconds. The resulting `RangeError` degraded the telemetry recorder and stalled later proxy requests. Proxy elapsed latency values are now rounded to integer milliseconds before persistence, and the SSE timing test asserts integer values. The benchmark also records an empty legacy-import cutoff before synthetic seeding, captures response and child diagnostics on failure, exits nonzero for failed traffic or missing usage visibility, and spaces visibility polls to respect the admin API rate limit.

All benchmark thresholds were `not_evaluated`: this is a small workload and the 10-core/16-GiB host does not match the fixed 4-core/8-GiB target machine. The measurements validate the benchmark and telemetry path; they do not establish the design performance targets.

## Million-row profile attempt, 2026-09-25

The documented full-profile command was run after confirming 30.29 GiB free in the temporary filesystem and building the server. It emitted benchmark JSON but exited 1 because proxy requests failed; this is a failed run, not a full-profile acceptance result. The JSON timestamp was `2026-09-24T16:02:34.397Z` (2026-09-25 in the host's Asia/Shanghai timezone). The host was Apple M1 Pro, 10 logical cores, 16 GiB RAM, Node v24.18.0, so every target remained `not_evaluated` despite matching the requested workload.

| Observation | Result |
| --- | ---: |
| Direct mock | 1000 / 1000 succeeded; P95 45.70 ms |
| Proxy without console | 991 / 1000 succeeded; 9 HTTP 503 failures; P95 154.49 ms |
| Proxy with console | 994 / 1000 succeeded; 6 HTTP 503 failures; P95 189.89 ms |
| Signed console additional P95 | 35.40 ms |
| Usage visibility | 4,251.60 ms; visible |
| Cursor pagination P95, 20 samples | 5.22 ms |
| Verified preaggregated `/overview` P95, 20 samples | 2,039.08 ms |
| Aggregate job | Completed in 2,825.39 ms |
| Offline live-aggregate rebuild | 1,000,000 requests; 1,000,000 attempts; sequence 2,000,000 |
| Database files including WAL/SHM | 732,612,928 bytes |
| SSE interruptions / successful proxy-on requests | 0 / 994 |

Failed proxy responses were HTTP 503 with `Proxy temporarily unavailable`; the proxy child logged `Error: database is locked` from telemetry writes. The mock received and completed all 3,000 requests. The benchmark's failure guard correctly returned exit code 1. Threshold results (`consoleAdditionalProxyP95Ms`, pagination, preaggregated overview, usage visibility) were all `not_evaluated`; this host does not match the fixed 4-core/8-GiB machine, and the proxy phases did not achieve full success.

## Million-row profile rerun, 2026-09-25

The full-profile command was rerun after adding `busy_timeout=5000` to the legacy log connection and changing quota read/modify/write transactions to acquire the SQLite writer reservation immediately. The latter prevents a concurrent legacy log commit from invalidating a deferred WAL read snapshot before the quota transaction writes. The concurrent legacy-log/telemetry regression passed, including quota admission during a controlled transient write lock. This run completed successfully; its generated timestamp is `2026-09-24T16:27:04.538Z` (2026-09-25 in the host's Asia/Shanghai timezone). Command: `rtk node scripts/benchmark-console.mjs --concurrency 100 --requests 1000 --history-rows 1000000 --allow-million --query-samples 20 --warmup 5`.

| Observation | Result |
| --- | ---: |
| Direct mock | 1000 / 1000 succeeded; P95 71.13 ms |
| Proxy without console | 1000 / 1000 succeeded; P95 196.12 ms |
| Proxy with console | 1000 / 1000 succeeded; P95 163.78 ms |
| Signed console additional P95 | -32.34 ms |
| Stream interruptions | 0 |
| Usage visibility | 6,369.86 ms; visible |
| Cursor pagination P95, 20 samples | 5.38 ms |
| Verified preaggregated `/overview` P95, 20 samples | 6,600.56 ms |
| Aggregate job | Completed in 4,815.36 ms |
| Offline live-aggregate rebuild | 1,000,000 requests; 1,000,000 attempts; sequence 2,000,000 |
| Database files including WAL/SHM | 732,329,128 bytes |
| Sampled peak proxy RSS | 289,046,528 bytes |

The host was Apple M1 Pro, 10 logical cores, 16 GiB RAM, Node v24.18.0. Every performance threshold remains `not_evaluated`: this host does not match the fixed 4-core/8-GiB acceptance machine. Successful traffic on this host is not certification of those targets; notably, observed overview P95 and usage visibility were 6,600.56 ms and 6,369.86 ms, respectively.

## Stage instrumentation follow-up, 2026-09-25

`MODEL_ROUTER_PERF=1` now emits payload-free read stages for worker lifecycle, SQLite open/pragma, snapshot watermark and legacy checks, live aggregate and detail-tail request/attempt/cost queries, first-event and recent-error queries, and response assembly. It also emits writer enqueue-to-post and worker acknowledgement/commit timings in batches; neither write identifiers nor request data are logged. The environment flag is off by default. The benchmark aggregates observed stage samples into P50/P95 and records snapshot/current watermarks. Usage visibility reports every poll's endpoint RTT, cadence, watermarks and observed count, plus the first-seen time and interval bounded by adjacent polls. Poll spacing starts at one second and backs off to two seconds to stay within the API's 120-requests-per-minute client budget.

Two exploratory runs completed with exit code 0 on the 10-core/16-GiB M1 Pro, using local mock traffic only:

| Profile | Proxy success | Preaggregated `/overview` P95 | Usage first seen | Stage observations |
| --- | ---: | ---: | ---: | --- |
| 4 concurrency, 12 measured requests, 200 seeded rows, 5 query samples | 12/12 in each phase | 29.84 ms | 27 ms; one poll, 26.96 ms RTT | Read-worker lifecycle P95 25.52 ms; worker total P95 3.54 ms; response assembly P95 0.67 ms |
| 10 concurrency, 40 measured requests, 100,000 seeded rows, 10 query samples | 40/40 in each phase | 227.61 ms | 192 ms; one poll, 192.45 ms RTT | Usage worker lifecycle P95 188.33 ms; detail attempt SQL observed at about 40 ms P50; response assembly remained below 1 ms |

These runs are exploratory only. A concurrent Rust compile/test and local Ollama process were discovered after the measurements, so the 100k result cannot identify the cause of the prior 1M latency or support a before/after optimization claim. The 1M run started for this follow-up was stopped with Ctrl-C (exit 130) after discovering that concurrent workload; it produced no usable result. No 1M acceptance result or controlled optimization comparison was obtained. No performance threshold or pass rule was changed; fixed 4-core/8-GiB acceptance remains outstanding. Re-run the same profile on an otherwise idle fixed target, retain its complete JSON, then optimize the measured dominant stage and repeat under identical conditions.
