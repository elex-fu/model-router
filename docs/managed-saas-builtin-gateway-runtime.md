# Managed SaaS built-in gateway runtime

The standard gateway release includes its production runtime. Select it without
shipping an executable operator module:

```sh
MODEL_ROUTER_SAAS_GATEWAY_RUNTIME_MODULE=builtin
MODEL_ROUTER_SAAS_GATEWAY_BUILTIN_CONFIG=/run/model-router/gateway.json
```

The normal gateway PostgreSQL URL, deployment/environment ids, listener and
gateway decrypt-only KMS configuration remain required. The core creates the
listener, authentication, admission, wallet, evidence, scheduler, credential
unsealer and settlement services. Gateway selection never creates catalog
rights, account verification, customer prices or supplier costs.

## PostgreSQL prepared statements

`MODEL_ROUTER_SAAS_DB_PREPARED_STATEMENTS` accepts exactly `off` (the default)
or `native`. Empty or unknown values fail startup. Enable `native` only for a
direct/session-compatible PostgreSQL connection or a verified pooler that
supports protocol-level prepared statements. PgBouncer transaction pooling
requires nonzero `max_prepared_statements`; an unknown pooler should retain
`off`. See [PostgreSQL PREPARE](https://www.postgresql.org/docs/18/sql-prepare.html),
[node-postgres queries](https://node-postgres.com/features/queries), and
[PgBouncer configuration](https://www.pgbouncer.org/config.html#max_prepared_statements).

Native mode names eight fixed SELECTs: the final commercial dispatchable-route
view, the BYOK/platform scheduler eligibility reads, the initial BYOK/platform
supply reads, and dispatch proof's core plus tenant/platform authority reads.
Frozen descriptors are created once per module; names include the exact SQL's
SHA-256 and never contain tenant IDs or bound values. A connection prepares only
the descriptors it executes from this set. PostgreSQL chooses custom or generic plans in its normal
automatic mode. Fresh reads, ordered fences, parameters and volatile database
clocks execute on every request. No rows or authorization decisions are cached.

Programmatic `createSaasDatabase` callers may set `preparedStatements: 'native'`
or `'off'`; an explicit option wins over the environment. Injected pools ignore
the environment and need an explicit native option plus their own optional
`queryPrepared` capability. Missing capability preserves anonymous queries.
Off mode hides the capability from both database and transaction executors,
even if their injected adapters provide it. Executor decorators must forward
the optional capability to retain native planning; the preparation observer
does so. A native execution error propagates through the existing storage error
path and is never retried anonymously. Disable the flag and restart the gateway
to return to ordinary anonymous execution.

## HTTP request concurrency

`MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT` optionally limits active HTTP
inference handlers per gateway process. Unset or empty leaves the limit disabled.
A nonempty value must be a positive base-10 safe integer; malformed values fail
startup. Programmatic `gateway.maxHttpInFlight` takes precedence over a valid
environment value, but does not suppress an invalid environment configuration.
This is a core listener setting and is not supplied by runtime-module dependencies
or the `gateway.json` limits below.

When enabled, excess inference requests receive HTTP 429 with error code
`GATEWAY_CAPACITY_EXHAUSTED` and `Retry-After: 1` before authentication or database
work. A permit remains held until the original handler promise settles, including
work after response EOF or client cancellation. Health, metrics and control
routes are excluded; Responses WS has its own limits. For asynchronous image
submission, the permit covers the HTTP submission handler through its 202 return,
and does not count detached background dispatch. This limit does not replace
account leases, tenant quotas or database constraints.

No production value is established by the implementation. The proposed value of
8 is a measurement candidate and requires validation against the intended load.

## Built-in configuration

`gateway.json` has this exact versioned shape (paths are examples, no key
material belongs in this document):

```json
{
  "apiVersion": 2,
  "extensions": {
    "providerBundles": [{ "bundle": "kimi", "enabled": true }]
  },
  "signing": {
    "verifierKeyId": "gateway-v1",
    "privateKeyFile": "/run/secrets/gateway-signing.pem",
    "trustedPublicKeys": [
      {
        "keyId": "gateway-v1",
        "publicKeyFile": "/run/model-router/gateway-public.pem",
        "status": "active"
      }
    ]
  },
  "affinity": {
    "activeKeyVersion": "v1",
    "keys": [{ "version": "v1", "keyFile": "/run/secrets/affinity-v1.key" }]
  },
  "idempotencyKeyFile": "/run/secrets/idempotency.key",
  "limits": {
    "timeoutMs": 300000,
    "maxConcurrency": 16,
    "leaseTtlMs": 600000,
    "maxBodyBytes": 16777216,
    "maxInputTokens": 262144,
    "maxOutputTokens": 131072
  }
}
```

All paths must be absolute. Signing uses an Ed25519 private key and matching
trusted public key; active and retired verifier records support rotation. HMAC
files contain 32–4096 raw bytes. Secret files must have no group/other access
(for example mode `0600` or `0400`). Retain old affinity key versions until
persisted bindings expire. All gateway replicas must share these authorities.

The usage estimator requires the exact final provider payload bytes after
bridges and category transforms. Local text/function data must satisfy a
conservative bound of twice the UTF-8 byte count plus 4096 framing tokens within
`maxInputTokens`; lowering the configuration cannot make a larger request fit.
The built-in configuration requires at least 8192 input tokens so ordinary
text plus framing has a usable admission path.
It then reserves the configured input ceiling and the enforced native output
cap. Native requests with no explicit output limit receive 4096, capped by the
configured output ceiling. Actual usage settlement releases unused reservation.
The limits above are deployment ceilings, not evidence of a model's physical
context/output limits.

Remote history references, cached remote context, multimodal resources and
encrypted compaction continuations have no proven local byte bound and are
rejected before admission. Locally supplied function schemas and arguments
remain local data even when they use names such as `file_id`. The Codex transform
preserves `max_output_tokens`; enforcement by the actual OAuth endpoint and
complete physical input/output bounds remain unproven. The built-in runtime
therefore continues to report
`USAGE_BOUNDS_UNAVAILABLE` and keeps that bundle non-operational/non-sellable
until independently trusted usage bounds for the exact model and operation are
integrated. Its transport assembly is visible; it is not a completed commercial
Codex route.

## Provider selection

Known bundle ids are `kimi`, `anthropic-claude`, `openai-codex`, `google-gemini`,
`xai-grok`, `zhipu`, `minimax`, `opencode-go`, `openrouter`, `aws-bedrock` and
`google-vertex`. The Codex bundle accepts boolean parameter `nativeCompact`;
other provider parameters and all per-bundle secret references are rejected. Inference credentials are provisioned
through the existing account/credential services and unsealed only after the
complete claimed-evidence proof has been checked.

Kimi selects product `kimi-code`, catalog endpoint scope `messages`, native
protocol `anthropic`, and fixed target
`https://api.kimi.com/coding/v1/messages`. Both Anthropic Messages and the
implemented OpenAI Chat-to-Anthropic bridge are available. Other fixed native
bundles require the matching client protocol; the factory rejects unsupported
cross-protocol replies. CN and OpenCode Go use their existing adaptive native
protocol routing. Dedicated transports never silently fall back to generic HTTP.

Explicit Codex `parameters: { "nativeCompact": true }` enables a separate proof-authorized native compact transport to the fixed
`/backend-api/codex/responses/compact` target. Its HTTP capability predicate is
limited to active public aliases currently backed by the Codex product. The
default leaves compact undeclared because a generation capability does not
prove that a subscription accepts unary compact. Even an explicit declaration
remains unavailable when its input/output bound is unproven; ordinary
generation transports cannot swallow compact traffic. Live compact acceptance
still requires a usable Codex credential.

The gateway reads governed catalog/pricing/account inventory. Existing
control-plane registration, import validation, refresh, quota worker and pricing
workflows remain responsible for preparing that inventory. An assembled bundle
with missing inventory is shown as unavailable; assembly alone is not a live
provider result.

## Storage and sidecar extensions

The optional `extensions.media` selects `storage: "s3"`. Required parameters
are `endpoint`, `bucket`, and `region`; optional parameters are `forcePathStyle`,
`publicBaseUrl`, `keyPrefix`, `taskTtlMs`, and `executionTimeoutMs`. Endpoint and
public URLs must use HTTPS and contain no user information, query or fragment.
`secretReferences` must have exactly `accessKeyId` and `secretAccessKey`, each an
absolute `file:///...` secret reference or `env://ENVIRONMENT_NAME` reference.
This mounts the existing image media storage/lifecycle implementation. It does
not certify remote storage access without a live verification artifact.

The optional `extensions.tlsFingerprint` requires parameter
`sidecarSocketPath` and no secret references. `profile` is `default`, `random`,
or an exact existing PostgreSQL profile name. Construction and readiness check
that the Unix socket has a live listener. The deployment owns the sidecar
process; gateway shutdown does not stop it. Per-account bindings still choose
the actual fingerprint through the existing PostgreSQL resolver.

## Capability evidence

Readiness reports enabled, actually assembled, operational and verified states
separately. Built-in transport construction never creates a live verification
claim. `verificationRecordsFile` is an optional top-level absolute path to an
array of operator-maintained evidence records:

```json
[
  {
    "capability": "provider-bundle:kimi",
    "level": "live",
    "verifiedAt": "2026-10-21T00:00:00.000Z",
    "evidenceFile": "/run/model-router/verification/kimi-result.json",
    "evidenceSha256": "<64 lowercase hex characters>"
  }
]
```

Use `mock` for simulated results. Records must name a configured capability and
match the referenced artifact's SHA-256 digest. Malformed or mismatched records
fail readiness; observations older than 30 days become unverified. Artifacts
must contain redacted execution evidence sufficient for the capability being
claimed. A matching file digest authenticates the operator's saved record; it
does not independently prove the upstream run. The customer sellable projection
requires enabled, assembled, operational and live-verified states together.
