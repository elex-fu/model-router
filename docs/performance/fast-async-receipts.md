# Opt-in in-memory final receipts

`MODEL_ROUTER_FAST_RECEIPT_MODE=memory-queue` moves the **final receipt** off the client terminal critical path. The default is `durable`: JSON's final byte and SSE DONE/end still wait for the receipt acknowledgement. Fast mode itself remains separately opt-in. This is not a deployment instruction or a measured performance claim.

## Durability and money contract

Both modes persist the pre-send intent and reserve maximum liability `M` before the one permitted upstream attempt. Authority, price, payload bounds and credential checks do not change. At complete upstream EOF, usage and exact charge `C` are validated against frozen intent pricing. The bounded queue must synchronously take ownership of that scalar evidence **before** the terminal gate is released; its SQL can start before terminal and need not wait for a remote HTTP acknowledgement.

In memory mode, a successful HTTP response **does not promise durable final usage**. SIGKILL/node loss between acceptance and receipt commit can destroy the only exact final evidence. The durable intent remains unresolved and backed by `M`; recovery must not invent usage, automatically refund it, guess a charge or send upstream again. Resolve only with the existing verified evidence workflow. This trade-off is explicit, not a durable queue/WAL.

The existing single SQL statement remains atomic: receipt + billing job + verified `M-C` return + release marker. It targets the original active allocation and epoch, never a successor owner. Until receipt acknowledgement, outstanding liability remains `M`; afterward it is `C` when the existing compaction conditions hold. Ledger posting remains a separate durable worker. `backing = available + sum(remaining liability)` is unchanged.

A complete captured receipt is never replaced with a conflicting `unknown` on uncertain ACK, including in default durable mode. The journal retries identical frozen parameters. Durable mode still withholds terminal on failure. Genuinely incomplete/invalid upstream evidence retains the existing conservative unknown-receipt path.

## Bounds and defaults

| Environment suffix after `MODEL_ROUTER_FAST_RECEIPT_` | Default | Meaning |
| --- | ---: | --- |
| `MAX_ENTRIES` | 256 | Total waiting + running + retry-held tasks, including post-durable rate reconciliation |
| `MAX_BYTES` | 2097152 | Envelope/canonical evidence budget (plus bounded per-entry object overhead); not a claim of exact JS heap bytes |
| `WORKERS` | 2 | Receipt SQL slots; a separate equally bounded Redis reconciliation phase cannot occupy these slots |
| `MAX_PER_TENANT` | 64 | Pending task count per tenant; map entries disappear when the tenant drains |
| `MAX_AGE_MS` | 5000 | Oldest **undurable** evidence age before new fast admission stops |
| `DRAIN_TIMEOUT_MS` | 10000 | Receipt/rate drain deadline; timeout is a visible shutdown failure, not successful discard |

All overrides require `MODE=memory-queue` and positive integer values; invalid configuration fails startup. Two SQL workers deliberately leave room for admission and ledger traffic in the typical 16-connection pool. Queue capacity is a safety ceiling, not a throughput recommendation or additional prepaid credit. Actual credit can run out long before this count. For rate `lambda` and extra receipt delay `delta`, extra occupied credit is approximately `lambda * delta * (M-C)` for homogeneous requests; do not mix currencies or use this mean approximation as an admission guarantee.

At count, byte or per-tenant exhaustion, already completed upstream work falls back to the synchronous receipt ACK **before** terminal. There is no drop/sample mode. Queue age/conflict pressure stops new attempts before Redis/intent; fullness also fails readiness. A missing split-admission capability also falls back synchronously. Default durable mode constructs no queue and adds no queue timers or Redis round trips.

## Retry, rate feedback and privacy

Uncertain receipt ACK retries the same frozen evidence/digest with bounded exponential backoff and jitter. No intent/upstream retry occurs. A digest conflict retains evidence, fails readiness and makes drain fail; it is not treated as transient or converted to a free request. Retry records stay inside the same total memory/count budget.

Concurrency releases independently after actual upstream completion. Exact TPM reconciliation happens **only after durable successful receipt ACK**, against the original Redis bucket, binding and incarnation. It is idempotent and independent of concurrency release. Reconciliation failure never writes a replacement receipt or rolls back billing. Separate worker slots prevent a slow Redis operation from starving receipt SQL; reconciliation records still consume bounded queue capacity until resolved.

The queue retains allowlisted scalar usage, request/intent/tenant IDs, frozen price proof, liability currency and minimal admission-owned reconciliation capability. It never retains raw response bodies, original requests/clients, provider candidates, credential objects or transport handles. Workers run outside request AsyncLocalStorage. Observers receive numeric aggregate snapshots only, with liabilities grouped by currency rather than meaningless cross-currency sums.

`FastReceiptQueue.snapshot()` / production `fastReceiptQueueObserver` expose pending count, accounted bytes, receipt/reconciliation running counts, oldest total/undurable age, undurable count and per-currency `M`, acceptance/durable/completion counters, receipt/reconciliation retries, fallbacks, conflicts and last/max acceptance-to-durable ACK lag. These are local process metrics, not durable accounting or proof the remote client received bytes. Do not infer a ledger commit timestamp from PostgreSQL transaction-start timestamps.

## Shutdown and verification

Shutdown stops admission/readiness, waits for active handler handoff (not merely socket EOF), drains the receipt/reconciliation queue, then drains the durable journal and retires provably unused allocation credit, and finally closes Redis/DB owners. A handoff or queue timeout rejects shutdown and leaves financial dependencies unretired; the process supervisor may terminate with failure, leaving durable `M` for evidence-based recovery. No timeout claims evidence was safely flushed.

Focused tests cover strict/async JSON and fragmented SSE terminal gates, incomplete usage, terminal cancellation, full-queue synchronous fallback, duplicate/conflicting evidence, identical lost-ACK retry, no second send, frozen-price/privacy/ALS isolation, DB-vs-Redis worker separation, per-currency accounting metrics, readiness, handoff ordering and drain timeouts. Real PostgreSQL/Redis/native-HTTP crash, old-owner and performance qualification remain separate required gates. Previous GEN17 results are the baseline, not results for this feature.

### Bounded phase timings

The queue also maintains five flat numeric timing groups, each with `Count`, `SumMs`, `LastMs` and `MaxMs`: `receiptQueueWait`, `receiptAwait`, `reconciliationQueueWait`, `reconciliationAwait`, and `residence`. They use the same monotonic performance clock as queue age. No request IDs, timing-event arrays or per-request history are retained after completion; each pending entry adds only one phase-queued timestamp.

- Receipt queue wait runs from acceptance (or previous failed attempt finish) until that receipt attempt starts. Retry waits include backoff.
- Receipt await measures the entire journal port call through resolution/rejection, including any pool wait, commit acknowledgement, and the journal's internal identical-evidence retries. It is **not** PostgreSQL executor time alone.
- Reconciliation queue wait runs from durable ACK (or previous reconciliation attempt finish) until that Redis attempt starts. Reconciliation await measures the admission capability through resolution/rejection.
- Residence runs from queue acceptance until successful task removal. It excludes the final observer callback and does not fabricate a completed duration for a hung, retry-held or blocked-conflict entry.

Each settled attempt updates both phase timing groups and outcome counters before one synchronous observer notification. A histogram adapter may sample `LastMs` only when that group's `Count` advances by exactly one; larger gaps must be reported as missed observations. Lifetime `MaxMs` must not be mistaken for a post-reset window maximum. Completed jobs without exact TPM feedback increment `completedWithoutReconciliation` and produce **no** Redis duration samples. Existing `durable`, `retries`, `conflicts`, `reconciliationRetries` and `completed` deltas distinguish successful, retry and conflict attempts; `residenceCount = completed`. These counters do not change worker counts, queue bounds, fallback rules or default durable-mode execution.
