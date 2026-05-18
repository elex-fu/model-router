# CLAUDE.md — model-router

Project-specific context for AI assistants working on model-router.

## Project Overview

model-router is a lightweight Node.js/TypeScript AI model proxy service. It unifies access for Claude Code, OpenAI SDK, and Codex CLI clients, supporting bidirectional Anthropic ↔ OpenAI protocol bridging, multi-key routing, modelMap rewriting, async SQLite logging, and circuit breaker failover.

## Architecture at a Glance

```
Client → HTTP Server → Auth → RateLimit → Router → CircuitBreaker → Bridge → KeyPool → Upstream fetch → Async Logger
```

Key components:
- `src/server/proxy.ts` — main request handler, orchestrates everything
- `src/server/index.ts` — server bootstrap, wires all singletons
- `src/protocol/bridge.ts` — 4 bridge implementations (a→a, o→o, a→o, o→a)
- `src/router/upstream.ts` — modelMap + upstream selection
- `src/server/keyPool.ts` — round-robin key scheduling with cooldown
- `src/server/circuitBreaker.ts` — per-upstream circuit breaker
- `src/server/oauth.ts` — OAuth client-credentials token resolver with caching
- `src/server/copilotOptimizer.ts` — Copilot-specific request optimizations
- `src/server/preprocess.ts` — Anthropic cache_control/thinking injection, billing header stripping
- `src/server/rectifier.ts` — thinking signature/budget error detection and auto-retry
- `src/limit/limiter.ts` — RPM + daily token quotas
- `src/logger/store.ts` — SQLite WAL-backed log storage
- `src/config/store.ts` — JSON config with mtime-based in-memory cache

## Conventions

### Code Style
- Use strict TypeScript; avoid `any` unless necessary for dynamic JSON bodies
- Prefer mutation-in-place for hot paths (preprocess/bridge transforms) to avoid GC pressure
- Use `node:test` + `node:assert/strict` for tests; run via `npm test`
- Integration tests live in `tests/integration/` and `tests/server/*.integration.test.ts`

### Proxy Handler Flow
When modifying `src/server/proxy.ts`, respect this order:
1. Path → clientProto (`/v1/messages` = anthropic, `/v1/chat/completions` / `/v1/responses*` = openai)
2. `/healthz` early return
3. IP blocking check
4. Proxy key auth (`authenticateProxyKey`)
5. Rate limiting (`KeyLimiter`)
6. Upstream selection (`selectUpstreams`)
7. Circuit breaker check
8. KeyPool round-robin
9. Bridge pick + preprocess + copilot optimize
10. Header build + auth injection (bearer / x-api-key / oauth / passThrough)
11. Fetch with undici Agent + AbortSignal
12. Response handling (non-streaming transform, streaming tee, rectifier retry)
13. Logging (success or failure)

### Auth Injection Priority
In `trySingleUpstream`, auth is applied in this priority:
1. `passThroughAuth` → forward client's original Authorization header
2. `oauth` + `oauthResolver` → fetch dynamic token
3. `authMode === 'x-api-key'` → `x-api-key: <apiKey>`
4. default → `Authorization: Bearer <apiKey>`

### Adding New Paths
If adding a new API path:
1. Update `clientProtocolFromPath` in `src/server/proxy.ts`
2. Check if bridges need updates (for cross-protocol paths)
3. Add integration tests in `tests/integration/proxy.test.ts`

### Upstream Config Fields
When adding new `UpstreamConfig` fields:
1. Add to `src/config/types.ts`
2. Ensure backward compatibility (field should be optional)
3. Add validation in CLI commands if user-facing
4. Document in README.md

### Testing
- Unit tests for pure logic (circuit breaker, oauth, copilot optimizer, limiter)
- Integration tests for end-to-end proxy behavior (use `startMockUpstream` + `startProxy` helpers)
- Run full suite before committing: `npm test`
- Current target: ~350+ tests, 0 failures

### Performance Considerations
- `collectBody` uses `Buffer.allocUnsafe` when Content-Length is known
- `ConfigStore.load()` caches config with mtime/size invalidation
- `undici Agent` is shared across all upstream fetches
- Same-protocol passthrough skips JSON parse/stringify
- Round-robin key selection replaced Fisher-Yates shuffle

### Security
- Never log full API keys; use `redactSecrets()` before writing to logs
- `passThroughAuth` requires careful proxy key setup (client's auth token must be registered as a proxy key)
- `--trust-proxy` should only be used behind a trusted reverse proxy

## Common Pitfalls

1. **Undici version**: Node 22 bundles undici 6.23.0. Do NOT install undici 8+ — it causes `fetch` failures.
2. **TypeScript `findLast`**: `src/server/copilotOptimizer.ts` uses `Array.findLast` which requires `es2023` lib. The project currently compiles with tsx which is lenient, but `npx tsc --noEmit` will flag it.
3. **Auth passthrough tests**: When testing `passThroughAuth`, the client's Authorization header must contain a valid proxy key. Register the OAuth token as a proxy key in test configs.
4. **OAuth resolver in tests**: `startProxy` in integration tests must receive `{ oauthResolver }` in options for `upstream.oauth` to work.
5. **Mock token servers**: `startMockUpstream` parses body as JSON. For form-urlencoded OAuth token endpoints, use `req.rawBody` (added to MockCall interface).
6. **KeyPool with empty apiKeys**: When `passThroughAuth` or `oauth` is used, `apiKeys` can be empty. The retry loop handles this via `usesClientAuth`.

## Important Files

| File | Purpose |
|------|---------|
| `src/server/proxy.ts` | Main proxy handler — be careful editing, most critical file |
| `src/server/index.ts` | Server startup — add new singletons here |
| `src/config/types.ts` | Source of truth for all config types |
| `src/protocol/bridge.ts` | Bridge selection + passthrough implementations |
| `tests/integration/proxy.test.ts` | Primary integration test suite |
