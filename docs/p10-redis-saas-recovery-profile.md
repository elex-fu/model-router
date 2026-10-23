# P10 disposable Redis / SaaS PostgreSQL authority recovery

Implementation is a narrow optional profile of the existing owned local stack. It runs three standard dist CLI gateways, an owned PostgreSQL cluster with the migrator/control-plane/gateway roles, an owned Redis process, and the synthetic loopback HTTPS provider. It performs no benchmark and makes no real-provider, builtin, production-KMS or full-R9 acceptance claim. Existing serial, cap and full performance branches and thresholds remain separate.

Prerequisites: a separately built and frozen current `dist`, installed dependencies, Node, OpenSSL, PostgreSQL 16+ binaries, Redis, writable private temporary storage, and the dedicated local execution slot. No external database role URLs are needed: the supervisor creates the disposable three-role database, applies the normal migrations and role template, and starts the ordinary CLI gateway role against it. PostgreSQL fsync and synchronous_commit remain on. Secrets travel through the existing private runtime files/environment and never through command arguments or the recovery artifact.

On this host the binary paths exist. Luna should run only after the targeted unit checks and a frozen build, with the cap and diagnostic sampling variables unset:

```sh
rtk proxy env -u MODEL_ROUTER_REQUEST_DIAGNOSTICS_SAMPLE_EVERY -u MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT node scripts/ops/run-current-r9.mjs --pg-bin /opt/homebrew/opt/postgresql@18/bin --redis-bin /opt/homebrew/bin/redis-server --diagnostic --recovery-profile --no-build --output-dir /private/tmp/model-router-p10-redis-recovery-NEW
```

Use a new output directory each time. Do not run this together with compilation, tests or performance workloads. This author has not executed the unit checks, build or local profile.

The profile creates U through a real partial SSE stream and broken connection. PG must record unknown execution, reconciliation-pending finance, an outstanding hold and key budget reservation, and a released provider lease. S then takes a genuine provider lease and enters dispatching while the mock delays its response. Once the active Redis capacity state is flushed/projected into PG, the profile explicitly saves and privately copies the old RDB. S completes normally; its daily/lifetime settled budget increments must exactly match its reported token usage and actual charge, and the wallet debit must equal that charge.

Only the owned Redis is killed with SIGKILL. After its real exit, the older RDB is restored into the same private directory and port with automatic saving disabled. The original CLI processes remain alive. Redis run ID must change, the shared PG generation must increase, and the new hash generation must equal PG authority. A fresh real request C then forces same-scope hydration. S must stay completed and the original unknown U must remain the sole active request.

Cross-instance canonical replay must return U's 202 unknown status and S's 200 completed status, both with their original canonical request ID and `response_replayed:false`. Mock request count and every projected PG request/attempt/evidence/lease/usage/ledger/wallet/hold/budget fact must remain identical across replay. No direct SQL creates financial outcomes or provider dispatches; recovery SQL observations run in read-only transactions with a statement timeout.

`redis-saas-recovery.json` records phase, fixed-field PG snapshots, run IDs/generation, the actual crash signal, and original-second soft quota windows before/after recovery. The profile requires an empty persistence queue at the snapshot boundaries. It does **not** inject or bound loss of unflushed soft quota mutations and does not claim general zero RPO. Expired 60-second buckets may age normally; cumulative PG budgets and financial facts remain a separate exact comparison. The U observation must finish before its ten-minute capacity deadline.

The supervisor retains its existing bounded owned-process cleanup and removes private runtime material. Failure keeps `ok:false` and the last recovery phase. The corresponding unit file tests flag rejection and assertion contracts only; it is not a substitute for the actual Redis/PostgreSQL/CLI run.

## Captured local evidence, 2026-10-24

Luna ran the documented profile after a fresh server build at source HEAD `62b98a50b95a3fa0080ddf8faac0b104bed8ddae`, using the frozen profile changes. Node 24.18.0, PostgreSQL 18.6 and Redis 8.10.2 were used. The actual artifact reports `ok:true`, `phase:complete`, Redis SIGKILL, generation 1→2, all three original gateways alive, exact PG financial/budget invariants and cross-instance U/S replay without another dispatch. S and C each settled 12 tokens and 28 charge units; U retained its original unknown hold/budget. Source, dist and harness hashes did not change; processes, PostgreSQL and private runtime cleanup all succeeded.

The retained local evidence directory is `/private/tmp/model-router-p10-redis-recovery-20261024-run-01` (`redis-saas-recovery.json` and `summary.json`). Pure unit checks were 5/5 before this run. This is a real owned local Redis/PostgreSQL/CLI recovery test against a synthetic loopback upstream. Unflushed mutation loss, general zero RPO, production HA/KMS, real-provider workflows and performance acceptance remain unproven.
