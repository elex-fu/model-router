# Console integration contract

The React app calls same-origin `/admin/api/v1`. Development proxy defaults to `http://127.0.0.1:15006`; set `ADMIN_API_TARGET` and, if needed, `ADMIN_PUBLIC_ORIGIN` for the backend's Origin check. Run `npm run dev` from `web/`.

Responses use `{ data, meta? }`; errors use `{ error: { code, message, details? } }`. Session responses expose `csrfToken`; the client sends it as `X-CSRF-Token` on writes. Configuration writes send `If-Match: "cfg-N"` from `/system` or `/config` and show a conflict on HTTP 412. Login/bootstrap submit `{ name, password }` and bootstrap also submits `{ token }`.

The UI uses V2 `auth.mode` and the schema from `src/config/v2-schema.ts`. The Ollama quick choice is a custom OpenAI upstream at `http://127.0.0.1:11434/v1`, `chat/completions`, model `qwen2.5-coder:7b`, `auth: { mode: "none" }`, and no credentials. Its test button calls `POST /upstreams/:id/test` and then polls `GET /jobs/:jobId` when the response includes `jobId` or `id`.

Backend adapter DTOs (implemented management API):

| Endpoint | UI expects |
| --- | --- |
| `/overview` | logical request counts, token counts, P95, optional upstream health and recent errors |
| `/usage/summary` | request/attempt counts, token fields, missing usage, costs separated by currency |
| `/usage/timeseries` | array of `{ time, requests?, tokens?, errors? }` |
| `/usage/breakdown` | array of `{ id?, label, requests?, inputTokens?, outputTokens?, cost?, currency? }` |
| `/requests` | array of request rows; cursor in `meta.nextCursor` |
| `/requests/:id/attempts` | array of attempt rows |
| `/upstreams/:id/discover-models` | array of model definitions, without automatic publishing |
| `/playground/runs` | JSON `{ data: { runId?, output?, summary? } }` or SSE `data:` events with `delta`, `text`, `summary`, `runId`, or `error` |
| `/connect/templates` | `{ baseUrl, model, protocol, apiKey }` or a generated `snippet`; the UI keeps a placeholder proxy Key |
| `/maintenance/jobs`, `/exports`, `/upstreams/:id/test` | `{ jobId }`; `GET /jobs/:id` gives status, progress and error/result |
| `/capabilities` | object with `deviceFlowProviders` and optional `clientCredentialsProviders`, or provider capability array |

Time filters send offset ISO `from`/`to`, with half-open range semantics. Test traffic defaults to excluded from usage queries. Unavailable adapters must return a real error (for example 503); the UI never substitutes demonstration metrics or a fake successful mutation.

V2 accepts zero for `rpm` and `dailyTokens`, meaning an explicit deny limit. Quota adjustments send an integer `{ amount, reason, periodId? }` with an `Idempotency-Key` header; omitting `periodId` applies to an existing current period. The playground direct adapter is limited to native-protocol text generation; cross-protocol execution requires the core runtime executor.
