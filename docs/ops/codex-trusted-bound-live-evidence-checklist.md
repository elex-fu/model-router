# Codex Trusted-Bound Profile — Operator Live-Evidence Checklist

Operator-facing procedure for admitting a Codex billing-bound contract into
the gateway (方案1 / M1, R8). The code ships with an **empty** reviewed
registry: no Codex dispatch can reserve usage or egress until an operator
collects live evidence from the real ChatGPT Codex backend and approves a
profile through the governance workflow. Nothing in this checklist lives in
code by design — real backend evidence is the operator's responsibility.

## What the runtime enforces (already proven, no operator action)

These invariants are covered by the R8 proof suite and need no live
verification, but they constrain what evidence is acceptable:

- **Fail-closed everywhere.** No approved profile ⇒ no admission hold ⇒ no
  credential unseal ⇒ no egress for `openai-codex` dispatches.
- **Exact-scope admission.** The profile scope is
  `(endpoint, productId, model, operation, transport, continuationMode)`;
  every axis must match exactly. Compact (`responses.compact`) and native
  WebSocket dispatches are separate scopes and need separate profiles.
- **Digest binding.** The admission digest is recomputed server-side from
  the stored canonical row; any drift fails closed. The signed compiler
  version (`cb1:…`) commits the full profile content and is re-validated at
  send time — a tampered version never unseals or egresses.
- **Hold = reviewed bounds.** The admission usage hold is exactly the
  profile's usage envelope — deployment ceilings and client claims cannot
  enlarge it.
- **Expiry margin.** Admission requires remaining validity > the request
  timeout margin; settlement lookups (`isDigestActive`) apply no margin by
  design.
- **TTL snapshot.** The gateway reads the ledger once per ~30 s; a retire
  takes effect at the next refresh, bounded by each profile's own expiry.

## Step 1 — Collect live evidence

For each scope you intend to admit, capture from real traffic against the
ChatGPT Codex backend:

1. **Scope axes.**
   - `endpoint`: `https://chatgpt.com/backend-api/codex/responses` (HTTP),
     its `/compact` suffix (compact), or the native WS endpoint.
   - `productId`: the Codex product/plan identifier used in routing.
   - `model`: the exact resolved model string (e.g. `gpt-5.2-codex`).
   - `operation`: `responses` or `responses.compact`.
   - `transport`: `http` or `websocket`.
   - `continuationMode`: `full` | `canonical-replay` | `remote-history` | `compact`.
2. **backendRevision.** A backend/session revision observable from live
   responses (headers or session metadata). Re-collect when ChatGPT ships a
   materially different backend — the revision is what makes stale evidence
   detectable.
3. **Usage envelope** (the actual billing bounds). From observed traffic:
   terminal `response.completed` usage events, per dimension, with
   headroom. Record `inputTotal/inputUncached/cacheRead/cacheWrite(5m/1h)/
   outputTotal/reasoningOutput` upper bounds as decimal strings, plus
   `feasibleInputBuckets`. Bounds must satisfy: uncached/cache-read ≤
   inputTotal; reasoningOutput ≤ outputTotal. Set unobserved cache
   dimensions to `0` (they are infeasible, not merely unseen) only if the
   plan genuinely cannot produce them; otherwise include them.
4. **Evidence references.** Keep request IDs / response IDs / HAR excerpts
   for the sessions the numbers came from; `evidenceReference` (≤512 chars)
   must point at a retrievable record (ticket, evidence repo entry).
   `evidenceVersion` identifies the evidence format (currently `proof-v1`).
5. **Validity window.** `validFromMs` ≤ now; `expiresAtMs` short enough to
   force re-verification (days, not quarters). The approval must be renewed
   by submitting a successor profile before expiry — the runtime fails
   closed on expiry, which is the intended behavior.

## Step 2 — Submit and approve

1. Submit the normalized profile via the platform admin API:
   `POST /admin/api/v1/codex-bounds/submit` (roles: `superadmin`,
   `operations`). The server recomputes the digest; a wire-supplied digest
   is never accepted. Duplicate content returns the existing state.
2. Review the pending row (`POST …/list` with `{"state":"pending"}`):
   scope axes, bounds, evidence reference, and validity window against your
   Step-1 records.
3. Approve: `POST …/approve` with `{"digest":"<64-hex>"}`. Approval records
   the approver and an audit event in the same transaction.
4. Verify the gateway sees it: the readiness fact
   (`collectCodexWorkflowFinancialReadiness`) reports the admitted profile
   count from the ledger; a live codex request must now admit and settle.
   If it does not, check readiness reason (ledger read failure / margin /
   expiry) before touching anything else.

## Step 3 — Operate

- **Backend drift / abuse**: `POST …/reject` (while pending) or
  `…/retire` (approved → retired). Retired profiles stop admitting at the
  next TTL refresh; already-settled usage is unaffected (`isDigestActive`
  is settlement-only).
- **Rotation**: submit the successor profile first, approve it, then retire
  the predecessor — overlapping validity keeps dispatches admitted.
- Never edit ledger rows directly; every state change must go through the
  audited workflow.
