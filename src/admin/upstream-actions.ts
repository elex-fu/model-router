import { type UpstreamDefinition, upstreamSchema } from '../config/v2-schema.js';
import { ControlError, type ControlService } from '../control/service.js';
import { joinApiUrl } from '../providers/url.js';
import { normalizeUsage } from '../telemetry/usage.js';

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const redact = (value: unknown, secret: string | null): unknown => {
  if (!secret) return value;
  if (typeof value === 'string') return value.replaceAll(secret, '[redacted]');
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secret)]));
  return value;
};

export class UpstreamActions {
  private inFlight = 0;
  constructor(private readonly control: ControlService) {}

  private async selected(id: string): Promise<UpstreamDefinition> {
    const upstream = (await this.control.raw()).upstreams.find((item) => item.id === id);
    if (!upstream) throw new ControlError(404, 'NOT_FOUND', 'Upstream not found');
    return upstream;
  }

  private headers(upstream: UpstreamDefinition): { headers: Headers; secret: string | null } {
    const headers = new Headers({ accept: 'application/json' });
    if (upstream.protocol === 'anthropic')
      headers.set('anthropic-version', upstream.policy.anthropicVersion ?? '2023-06-01');
    if (upstream.auth.mode === 'none') return { headers, secret: null };
    if (!['bearer', 'x-api-key', 'custom-header'].includes(upstream.auth.mode))
      throw new ControlError(422, 'AUTH_UNSUPPORTED_FOR_TEST', 'This authentication mode requires a runtime adapter');
    // Validate again at the outbound boundary, including the reserved-header rules.
    const auth = upstreamSchema.shape.auth.safeParse(upstream.auth);
    if (!auth.success)
      throw new ControlError(422, 'INVALID_AUTH_HEADER', 'Configured authentication header is invalid');
    const credential = upstream.credentials.find((item) => item.enabled);
    if (!credential) throw new ControlError(422, 'CREDENTIAL_UNAVAILABLE', 'No enabled credential');
    const secret =
      credential.secret.type === 'inline'
        ? credential.secret.value
        : credential.secret.type === 'env'
          ? process.env[credential.secret.name]
          : this.control.store.secrets.get(credential.secret.id);
    if (!secret) throw new ControlError(422, 'CREDENTIAL_UNAVAILABLE', 'Credential reference cannot be resolved');
    const headerName =
      upstream.auth.mode === 'custom-header'
        ? auth.data.headerName!
        : upstream.auth.mode === 'bearer'
          ? 'authorization'
          : 'x-api-key';
    headers.set(headerName, upstream.auth.mode === 'bearer' ? `Bearer ${secret}` : secret);
    return { headers, secret };
  }

  private async request(
    upstream: UpstreamDefinition,
    endpoint: string,
    method: 'GET' | 'POST',
    body: unknown,
    signal?: AbortSignal,
  ) {
    if (this.inFlight >= 4)
      throw new ControlError(429, 'TOO_MANY_UPSTREAM_TESTS', 'Too many upstream checks are running');
    let url: URL;
    try {
      url = joinApiUrl(upstream.baseUrl, endpoint);
    } catch {
      throw new ControlError(422, 'INVALID_UPSTREAM_URL', 'Configured upstream URL or endpoint is invalid');
    }
    const { headers, secret } = this.headers(upstream);
    if (method === 'POST') headers.set('content-type', 'application/json');
    if (signal?.aborted) throw new ControlError(409, 'JOB_CANCELLED', 'Job cancelled');
    this.inFlight++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: controller.signal,
      });
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body)
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 1_000_000) {
            await response.body.cancel().catch(() => undefined);
            throw new ControlError(502, 'UPSTREAM_RESPONSE_TOO_LARGE', 'Upstream response exceeded 1 MB');
          }
          chunks.push(chunk);
        }
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown;
      try {
        parsed = redact(JSON.parse(raw), secret);
      } catch {
        parsed = {};
      }
      const error = object(object(parsed).error);
      const providerMessage = typeof error.message === 'string' ? error.message.slice(0, 500) : null;
      return {
        status: response.status,
        elapsedMs: Math.round(performance.now() - started),
        data: parsed,
        error: providerMessage?.replaceAll(secret ?? '\0', '[redacted]') ?? null,
      };
    } catch (error) {
      if (signal?.aborted) throw new ControlError(409, 'JOB_CANCELLED', 'Job cancelled');
      if (controller.signal.aborted) throw new ControlError(504, 'UPSTREAM_TIMEOUT', 'Upstream request timed out');
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      this.inFlight--;
    }
  }

  async discoverModels(
    upstreamId: string,
  ): Promise<{ upstreamId: string; models: Array<{ id: string; source: 'discovered' }>; status: number }> {
    const upstream = await this.selected(upstreamId);
    if (!upstream.endpoints.models)
      throw new ControlError(422, 'DISCOVERY_UNAVAILABLE', 'This upstream has no model-list endpoint');
    const response = await this.request(upstream, upstream.endpoints.models, 'GET', undefined);
    if (response.status < 200 || response.status >= 300)
      throw new ControlError(
        502,
        'UPSTREAM_DISCOVERY_FAILED',
        response.error ?? `Model list returned HTTP ${response.status}`,
        { upstreamStatus: response.status },
      );
    const data = object(response.data);
    if (!Array.isArray(data.data) && !Array.isArray(data.models))
      throw new ControlError(502, 'INVALID_MODEL_LIST', 'Upstream returned an unexpected model-list format');
    const list = Array.isArray(data.data) ? data.data : (data.models as unknown[]);
    const models = list
      .map((item) => object(item).id ?? object(item).name)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, 200)
      .map((id) => ({ id, source: 'discovered' as const }));
    return { upstreamId, models, status: response.status };
  }

  async test(upstreamId: string, modelId: string | undefined, signal: AbortSignal) {
    const upstream = await this.selected(upstreamId);
    if (upstream.protocol === 'gemini')
      throw new ControlError(422, 'TEST_UNAVAILABLE', 'Gemini test protocol is experimental');
    const model = modelId ?? upstream.models.find((item) => item.enabled)?.id;
    if (!model || !upstream.models.some((item) => item.id === model))
      throw new ControlError(422, 'UNKNOWN_MODEL', 'Select a configured upstream model');
    const body =
      upstream.protocol === 'anthropic'
        ? { model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16, stream: false }
        : upstream.protocol === 'responses'
          ? { model, input: 'Reply with OK.', max_output_tokens: 16, stream: false }
          : { model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16, stream: false };
    const response = await this.request(upstream, upstream.endpoints.generate, 'POST', body, signal);
    const data = object(response.data);
    const usage = normalizeUsage(upstream.protocol, data.usage, {
      provider: upstream.provider,
      inputIncludesCache: upstream.policy.inputIncludesCache,
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      upstreamId,
      model,
      status: response.status,
      durationMs: response.elapsedMs,
      usage,
      reportedModel: typeof data.model === 'string' ? data.model : null,
      error: response.error,
    };
  }

  /** Bounded native-protocol generation for the admin playground. Never accepts a cookie as credentials. */
  async generate(
    upstreamId: string,
    model: string,
    prompt: string,
    maxOutputTokens: number,
    temperature: number | undefined,
    signal: AbortSignal,
  ) {
    const upstream = await this.selected(upstreamId);
    if (!upstream.enabled || !upstream.models.some((item) => item.id === model && item.enabled))
      throw new ControlError(422, 'MODEL_UNAVAILABLE', 'Configured target model is unavailable');
    if (upstream.protocol === 'gemini')
      throw new ControlError(422, 'PROTOCOL_UNAVAILABLE', 'Gemini playground is unavailable');
    const body =
      upstream.protocol === 'anthropic'
        ? {
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxOutputTokens,
            stream: false,
            ...(temperature === undefined ? {} : { temperature }),
          }
        : upstream.protocol === 'responses'
          ? {
              model,
              input: prompt,
              max_output_tokens: maxOutputTokens,
              stream: false,
              ...(temperature === undefined ? {} : { temperature }),
            }
          : {
              model,
              messages: [{ role: 'user', content: prompt }],
              max_tokens: maxOutputTokens,
              stream: false,
              ...(temperature === undefined ? {} : { temperature }),
            };
    const response = await this.request(upstream, upstream.endpoints.generate, 'POST', body, signal);
    const data = object(response.data);
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const choice = object(choices[0]);
    const message = object(choice.message);
    const content = message.content;
    const anthropic = Array.isArray(data.content) ? data.content : [];
    const output = Array.isArray(data.output) ? data.output : [];
    const text =
      typeof content === 'string'
        ? content
        : typeof data.output_text === 'string'
          ? data.output_text
          : [
              ...anthropic,
              ...output.flatMap((item) =>
                Array.isArray(object(item).content) ? (object(item).content as unknown[]) : [],
              ),
            ]
              .map((item) => object(item).text)
              .filter((item): item is string => typeof item === 'string')
              .join('');
    const usage = normalizeUsage(upstream.protocol, data.usage, {
      provider: upstream.provider,
      inputIncludesCache: upstream.policy.inputIncludesCache,
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      output: text.slice(0, 100_000),
      model,
      upstreamId,
      durationMs: response.elapsedMs,
      usage,
      error: response.error,
    };
  }
}
