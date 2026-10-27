# Pinned Sub2api fresh diagnostic arms

`sub2api_fresh_performance_pilot.py` runs only an explicitly authorized,
fresh Sub2api JSON arm. It is not a production launcher,
new upstream version download, or an automatic performance-parity verdict.

Exactly two test profiles are supported:

| `--profile` | Timed requests | Concurrency | User / each account cap |
| --- | --- | --- | --- |
| `c32` (default, unchanged) | 60 seconds | 32 | 64 |
| `c200` | Exactly 10,000 attempts, no duration flag | 200 | 256 |

The c200 cap uses the existing pinned fixture's supported seed path, not a
product change or performance tuning. Both profiles keep PG pool16, pricing,
max_tokens64, mock5ms, the pinned client and the same 138-success c32 warm-up.
There is no extra c200 warm-up or dropped initial/cold-tail sample. Failures are
registered as failures; they are not replaced or treated as performance parity.

## Before execution

Root must first finish other timing, builds and storage maintenance, verify
owned processes exited, and activate the exact generation/source in
`/workspace/shared/model-router-benchmark-window.json`. Do not use `--execute`
without that GO. The runner never activates a quiet window itself.

The external retained GEN17 harness is pinned by hash. It supplies existing
PostgreSQL18/Redis7.4 tools, `start_sub`/`sub_drain`, fixture seeds and lifecycle
coordination. No dependencies are installed and no binary is built. Existing
Sub binary, timing-client, mock and configuration-template hashes must match.
Both copied pricing-cache JSON and source fallback must match the pinned bundled
pricing hash; the cache's hash record must also agree.
The Sub source must be clean at
`ba81c7fd758e425d67f856d601147ef0c5263d3f`. Binary provenance means identical
to the recorded GEN17 executable, not a new reproducible-build proof.

```sh
python3 scripts/performance/sub2api_fresh_performance_pilot.py \
  --execute \
  --harness /workspace/scratch/381a7e57e000/router-fast-architecture-evaluation-artifact/harness \
  --source /workspace/scratch/381a7e57e000/model-router-hotpath-v2 \
  --expected-source ROOT_FROZEN_COMMIT \
  --sub-source /workspace/scratch/381a7e57e000/sub2api-comparison \
  --client /workspace/scratch/381a7e57e000/router-fast-architecture-evaluation-artifact/async-receipt-timing-client \
  --generation ROOT_APPROVED_GENERATION \
  --label sub2api-fresh-pilot-unique-lowercase-label
```

For the finite c200 case, add `--profile c200` and use a distinct label and a
separately authorized quiet generation. Omitting the flag preserves c32/60s.

`--node-summary PATH` optionally records a hash-qualified independent two-business
Node summary with valid finance and both-business-plus-primary CPU accounting.
It never computes a cross-run ratio or silently excludes the primary.
Run the script from the same checkout supplied by `--source`; its tracked source
must be clean and match the root-owned generation identity.
Shared-client/mock/SQL Go runtime, loader, libpq service/options and recovery-work
environment overrides are rejected before admission (including empty values);
the manifest lists the exact rejected variable names. Other shared-fixture
environment is inherited. The Sub process separately uses a minimal allowlist.

## Fixed profile and boundaries

- Existing `/tmp/sub2api-bench-20261026/sub2api`, standard/release mode.
- Existing paired services PG15462, Redis16399, TLS mock18453; **not** the old
  `sub2api-benchmark-runtime` standalone cluster. Fresh Sub database/config.
- PG app pool16/idle16; user and each of four active provider accounts cap64
  (`c32`) or cap256 (`c200`);
  original nonzero key quota/monetary windows and bundled gpt-4o-mini pricing.
- Fixed 10input/5output usage; exact Sub fee0.0000045 per successful response.
- 10 serial bootstrap, CHECKPOINT,128/c32 warm, exact DB drain, minimum1s gap.
- One existing timing-client binary; full retained raw samples for either profile.
- Runtime worker-pool sizes are unknown, not inferred from source defaults.
- No periodic SQL census, queue observer, profiler or inference hooks; only
  quiet-marker file checks every second during client and financial drain.
- CPU includes every thread of the Sub process through DB financial drain;
  excludes shared PG/Redis/mock/client. RSS snapshots are not private/peak RAM.
- PGSS includes recorded app-role calls through drain, not network roundtrips.
- Exact raw mock sends/completions, usage rows, billing dedup, fees, balance,
  key quota/5h window and token totals must agree before and after shutdown.
- Graceful gateway exit occurs while its dependencies still run. Forced kills,
  abnormal exits, incomplete cleanup or mismatched quiet release fail the run.

Cache queue emptiness is **unknown**, not zero. Sub's DB financial drain is not
equivalent to router finance+TPM reconciliation. GEN17 had periodic SQL sampling;
this fresh boundary-only protocol instead matches the current Node diagnostic.
Sub pooling, tariffs and financial safety semantics remain different. Use fresh
paired/reversed Node arms before making stable relative-performance claims.

Pure local/CI checks require no external fixture or services:

```sh
python3 -m unittest discover -s scripts/performance -p 'sub2api_fresh_*_test.py'
node --import tsx --test tests/ci/sub2api-fresh-diagnostic-gates.test.ts
```
