# Memory-queue final receipt: validation contract

This is a **planned functional and performance protocol**, not a passed test
report. Production changes belong to the queue/executor and Redis owners. The
GEN17 baseline, raw request population, failures from older generations, and
their qualifications remain immutable. Never describe the new mode as matching
the prior durable-before-terminal guarantee.

## Declared profiles

- Control: `MODEL_ROUTER_FAST_RECEIPT_MODE=durable` (also exercise omitted flag).
- Candidate: explicit `MODEL_ROUTER_FAST_RECEIPT_MODE=memory-queue`.
- Initial fixture: built-in estimator, automatic credit, prepared-off, DB pool16,
  capped concurrency64, TLS mock5ms, 10 input/5 output tokens, maximum524480 and
  actual charge35 minor units. No extra money cap or TPM changes.
- Record all resolved queue limits: entry/byte/per-tenant bounds, workers,
  maximum age and drain timeout. Final names/defaults are production contracts,
  not assumptions asserted by this plan.
- Functional preload is opt-in and never part of a clean timing population.
  It holds a real `pg.Client.query` **before invocation**, or hides a real driver
  ACK once. It does not fabricate SQL results or wrap journal/queue promises.

## Required actual HTTP cases

| Case | Observable boundary and financial assertions |
| --- | --- |
| Durable control JSON and SSE | While receipt SQL is held, final body completion / `[DONE]` is withheld. Release produces one receipt/marker/charge and one upstream send. |
| Queued JSON and SSE | Hold receipt SQL. External client observes complete successful EOF / `[DONE]`. Durable intent exists; no receipt, release marker, ledger or posted-wallet debit yet. Remaining liability H equals original M; backing=available+H. Redis slots released, original TPM262208 retained. |
| Ledger-only pause | Hold worker before claim, not receipt. EOF and receipt/marker complete; H equals actual35, not M. Posted wallet/ledger remain unchanged until worker resumes. |
| Queue full | Set capacity1/workers1, hold receipt. First queued response completes. Second uses synchronous fallback and must not complete terminal until its own receipt is durable. No silent drop or unbounded receipt retention. |
| Queue byte/per-tenant bound | Exercise independently from entry count. Assert bounded numeric snapshot and synchronous fallback or documented pre-intent denial; no successful terminal without either durable receipt or accepted bounded ownership. |
| Maximum age/conflict | Once readiness/precheck is closed, next request creates no intent and sends no upstream. A full-but-young queue may use the documented synchronous fallback. |
| Receipt ACK loss | Commit real receipt, hide driver ACK once, retry the same immutable receipt. Hash identity and all parameter bytes match. Receipt, release, charge and upstream each occur once. Duplicate reconciliation never refunds twice. |
| Persistent receipt failure | Terminal may already be complete only for a successfully accepted queue item. Liability remains conservative and queue remains bounded; subsequent admissions fail closed as documented. |
| SIGKILL after EOF, before SQL | Kill gateway with observed successful EOF and held receipt. Restart without replaying requests. Original durable intent and full M remain, no automatic refund or fabricated receipt/usage. Restart must not silently use the old drained Redis bypass. |
| SIGTERM | Stop new admission, complete/abort bounded in-flight handlers, drain receipt queue, drain journal, then retire free allocations. Record actual process exit and financial state; forced-kill or timeout is not graceful success. |
| Shutdown timeout | Keep receipt blocked beyond configured drain timeout. Error must be visible; unknown M retained. No successful retirement/reconciliation claimed for undurable evidence. |
| Cancellation/errors/BYOK | Retain unknown stakes on uncertain transport; no successful-usage reconciliation. BYOK remains no platform charge/funded-wallet requirement. |

## Split Redis release / reconciliation

Exercise actual releaseConcurrency and reconcileDurableUsage separately, not
merely their invocation counts. Slot release never refunds RPM/TPM. Only validated
durable successful usage can reconcile original token bucket, once. Cover both
call orders, duplicate calls, failed ACK retries, expired original bucket, new
bucket, Redis restart/generation loss and old transport lease horizon. Missing
original buckets must never decrement a newer bucket; failed operations remain
retryable but do not grant new admission. Check all tenant/project/key/account
slot sets and rate buckets; match durable receipts to actual input+output15.

## Evidence and timing policy

- Save immutable source/harness hashes and effective options, all attempts/status
  counts, raw upstream sends, before/held/after full financial census, Redis
  counters, cleanup exit codes and safe bounded event timestamps.
- `query_driver_ack` is observed by the injector, not necessarily delivered to
  the application. Node response `finish` is not external EOF. Queue acceptance
  requires its own supported observation; do not infer it from SQL timing.
- Receipt-to-settlement transaction start is not durable COMMIT lag. Instrument
  client ACK/first committed-state observation separately and label its bounds.
- Clean matched comparisons start only on an exact integrated source checkpoint
  and an explicitly active quiet window. Preserve matched-v2 warm population,
  fixed gap, cap, M, price, pools, prepared mode and all failed attempts.
- Count all app/background/drain PGSS recorded calls with its historical
  qualification. If measuring actual client adapter calls, label separately;
  complete internal trigger SQL is not automatically measured.
- Drain after client EOF is part of financial completion and whole-window cost.
  Report queue peak/backlog and undurable liability with the exact observation
  method. Never call post-EOF latency savings a free durability improvement.
- Stage gates: functional boundaries and crash conservation first; then matched
  serial JSON/SSE and c32 finite/sustained. No benchmark runs during preparation.
