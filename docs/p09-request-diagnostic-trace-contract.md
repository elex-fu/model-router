# P09 request diagnostic trace wiring contract

`src/saas/gateway/request-diagnostic-trace.ts` is an opt-in in-memory helper. It performs no logging, SQL, payload capture, or queue flush. The caller retains the existing request identifier and attaches `snapshot()` to the existing ops bench request sample. Never include credentials, URLs, SQL text, arguments, or provider payloads. Disabled callers do not create a trace.

Wrap the request in `withRequestDiagnosticTrace`. AsyncLocalStorage carries the same trace across preparation, dispatch, and financial settlement. Database code may read `currentRequestDiagnosticTrace()` without changing database interfaces. Capture the trace at operation start; completion callbacks must finish that captured span, not look up whichever context happens to be current later.

Database owner wiring:

- Start `pool-checkout` immediately before `pool.connect()`, finish on success or rejection. This is actual client acquisition time, not PG wait events. Start a separate held-client lifetime only if needed; release is not the end of checkout wait.
- Instrument pool direct queries with explicit acquire/query/finally release if a checkout breakdown is required. A wrapper around `pool.query()` cannot truthfully separate queue wait and execution.
- Start `query` only after acquisition and finish in finally. Start `transaction` after checkout and finish after commit/rollback and release. Query wall time is included in transaction inclusive time and removed from transaction exclusive time.
- Preserve errors and client discard/release behavior. Do not change pool size or timeouts.

Transport/runtime owner wiring:

- Mark `upstream-send` immediately before the transport starts network send; begin `upstream-send` then finish at response headers. Mark `first-byte` at the first actual response body byte, not header arrival or first parsed text token. Begin `upstream-body` after headers and finish at EOF/error/cancel.
- Mark `eof` only on normal provider body exhaustion. Cancellation/error is not EOF. Do not infer financial settlement from EOF.
- Begin `settle` at financial settlement entry; finish in finally. Mark `settled` only after the financial authority acknowledges settlement success. Unknown outcome and failures leave it absent.

All marker values are milliseconds relative to request trace start. Missing markers stay absent. Repeated marks keep the first occurrence, so this minimal trace is for one upstream attempt; retries need separate attempt trace instances. Span finish is idempotent. Snapshot includes only completed spans and explicitly reports pending and dropped spans; incomplete/truncated traces cannot establish a complete breakdown.

Exclusive wall time uses interval unions and the documented priority `pool-checkout > query > transaction > settle > upstream-send > upstream-body`. Higher priority phases claim overlapping time first. Thus exclusive values can be summed without double counting even for concurrent SQL/settlement; they are attribution, not CPU time. Inclusive values must never be summed. Time outside observed spans remains unclassified. Existing prepared dispatch stage observers remain separate inclusive diagnostics.

Native PG pool/client, managed HTTP/default WS request context, generic HTTP transport body reader, and normal-success financial completion are wired. Composition and production options expose `requestDiagnostics.select/observe`; the deployment assembly must provide selective sampling and a nonblocking bounded diagnostic sink. Injected custom pools and category transports require their own equivalent instrumentation; absent markers do not prove those phases did not occur. No execution evidence has been collected by this patch author. It makes no latency, throughput, R9 acceptance, native provider, or deployment claim; P0 sections 6.1 and 6.2 and the original 30/10 ms limits remain unchanged.
