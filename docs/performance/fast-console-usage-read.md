# Fast journal customer usage compatibility

`SaasConsoleUsageQueryService` reads strict request/usage rows and compact fast
journal facts through one SQL projection. This is **read-time compatibility**:
there are no new gateway statements, legacy request/attempt/evidence writes,
background usage copies, or inferred monetary postings.

## Public contract

- Canonical request identity is the fast intent's `request_id`. Detail also
  accepts the intent UUID, but multiple matching identities fail closed. A
  same-tenant request UUID present in both storage backends fails closed rather
  than silently selecting a source or double-counting it.
- Existing public DTOs, model/status/mode/project/time filters, page limits, and
  opaque cursor shape are retained. Request cursors now preserve PostgreSQL
  microseconds; display timestamps remain millisecond ISO strings.
- Model/protocol come from immutable `authority_snapshot` provenance, never
  current aliases, routes, key authorization versions, or current prices.
- Fast detail has an empty `attempts` array: an intent is not a legacy attempt
  timeline or proof that response bytes reached the caller. Normalized usage
  facts use `fast-receipt:` or `fast-resolution:` IDs. No raw JSON, provider
  identities, prompt/body, operator reason/ticket/evidence, or credentials leave
  the public mapper.
- Request lists filter by request creation time. Usage summaries retain their
  existing **observation-time** semantics: the receipt timestamp, or the applied
  canonical resolution timestamp. Only one canonical observation is counted.
  An applied resolution may therefore move a fact between daily/time buckets;
  this is not request-day accounting or a financial reporting/export contract.
- Unknown/malformed counts remain null in detail and contribute zero to numeric
  totals; missing usage is not an assertion of zero actual provider usage.

## Independent execution and money axes

A succeeded receipt can still have pending money. Internal `pending_v2` and
`blocked_v2` retain the existing public pending and reconciliation-pending financial
semantics; receipt-time liability compaction alone never marks usage financially
acknowledged. The operator case API separately exposes original
`maxCostMinorUnits` and current `retainedLiabilityMinorUnits`; customer usage DTOs
do not conflate either with posted charges. Positive platform charges are
settled only after a completed job acknowledges a ledger entry matching tenant,
currency, amount, intent business key and exact receipt/resolution metadata.
Zero-charge successful jobs settle with no ledger entry. The exact known-unsent
failed/null-HTTP/zero-charge/empty-usage tuple releases only after job completion.
Failed non-2xx, unknown, and blocked outcomes do **not** automatically release or
settle. Expired intent authority with no receipt is unknown, never proof of
non-execution. BYOK always has `not_applicable` customer financial status and
still exposes actual usage.

Operator evidence overrides original usage only once the worker applies it.
Verified usage does not prove successful response delivery: original failed or
unknown execution remains failed or unknown even when its money is settled.
The existing unknown => execution reconciliation pending invariant is preserved;
that pending execution axis must not reopen a completed financial job.
Applied non-execution evidence maps to failed/released with resolved execution
reconciliation.

## Authorization and deployment

Existing authorization is intentionally unchanged: an active tenant member may
list/aggregate tenant-wide without a project selector; explicit project filters
and all detail lookups additionally require active project membership. The fast
projection checks the immutable tenant/project/API-key ownership tuple, without
requiring an old key to remain active to read legitimate history.

The control-plane role needs only the additional SELECT columns declared in the
privilege manifest and generated role mirrors. No new INSERT/UPDATE/DELETE or
credential decryption authority is granted. Role templates must be reapplied as
part of an authorized deployment; this change does not deploy them.

## Remaining compatibility scope

This adapter covers customer request history/detail, usage totals and daily
summary buckets only. Admin analytics, historical exports, webhook emissions,
financial reports and any direct legacy-table consumers are **not** backfilled
or made fast-aware by this change. Fast intent tenant/time indexes are a separate
next-migration scaling follow-up; migrations 143–146 remain immutable. No claim
of large-history read performance is made without those indexes and query-plan
validation. Gateway hot-path performance is unaffected by these read-only APIs.
