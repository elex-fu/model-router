import type { ConfigV2 } from '../config/v2-schema.js';
import { ControlError } from '../control/service.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function connectTemplate(config: ConfigV2, modelInput: unknown, protocolInput: unknown) {
  const models = [...new Set(config.routes.filter((route) => route.enabled).flatMap((route) => route.publishedModels))];
  const model = modelInput === undefined ? (models[0] ?? null) : modelInput;
  if (model !== null && (typeof model !== 'string' || !models.includes(model)))
    throw new ControlError(422, 'MODEL_NOT_PUBLISHED', 'Select a published model');
  const protocol = protocolInput ?? 'openai';
  if (protocol !== 'openai' && protocol !== 'anthropic' && protocol !== 'responses')
    throw new ControlError(400, 'INVALID_PROTOCOL', 'Unknown client protocol');
  const suffix =
    protocol === 'anthropic' ? '/v1/messages' : protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions';
  const baseUrl = config.server.publicProxyBaseUrl.replace(/\/+$/, '');
  const endpoint = `${baseUrl}${suffix}`;
  const headers =
    protocol === 'anthropic'
      ? {
          'x-api-key': '<YOUR_MODEL_ROUTER_KEY>',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        }
      : { authorization: 'Bearer <YOUR_MODEL_ROUTER_KEY>', 'content-type': 'application/json' };
  const body =
    model === null
      ? null
      : protocol === 'anthropic'
        ? { model, max_tokens: 128, messages: [{ role: 'user', content: 'Hello' }] }
        : protocol === 'responses'
          ? { model, input: 'Hello' }
          : { model, messages: [{ role: 'user', content: 'Hello' }] };
  const curl =
    body === null
      ? null
      : `curl -sS ${quote(endpoint)} -X POST ${Object.entries(headers)
          .map(([name, value]) => `-H ${quote(`${name}: ${value}`)}`)
          .join(' ')} -d ${quote(JSON.stringify(body))}`;
  return { baseUrl, endpoint, protocol, model, publishedModels: models, headers, body, curl };
}
