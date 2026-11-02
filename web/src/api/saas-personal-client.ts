export interface PublicConnectionSettings {
  apiBaseUrl: string;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function jsonResponse(response: Response, failure: string): Promise<unknown> {
  if (!response.ok) throw new Error(failure);
  try {
    return await response.json() as unknown;
  } catch {
    throw new Error('服务响应格式无效，请稍后重试。');
  }
}

/** Existing public, non-secret deployment metadata. */
export async function getPublicConnectionSettings(signal?: AbortSignal): Promise<PublicConnectionSettings> {
  const response = await fetch('/settings/public', {
    headers: { Accept: 'application/json' },
    signal,
  });
  const body = asObject(await jsonResponse(response, '暂时无法读取接入地址。'));
  const data = asObject(body?.data);
  if (!data || typeof data.apiBaseUrl !== 'string' || data.apiBaseUrl.length > 2048) {
    throw new Error('接入地址响应无效。');
  }
  return { apiBaseUrl: data.apiBaseUrl };
}

/**
 * The gateway model endpoint authenticates the key itself. The secret is used
 * only for this request and is never put in a query key, cache or URL.
 */
export async function listGatewayModels(secret: string, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch('/v1/models', {
    headers: { Accept: 'application/json', Authorization: `Bearer ${secret}` },
    signal,
  });
  const body = asObject(await jsonResponse(response, 'Key 验证失败或暂时无法读取模型列表。'));
  if (body?.object !== 'list' || !Array.isArray(body.data)) {
    throw new Error('模型列表响应无效。');
  }
  const models = body.data.map((item) => asObject(item)?.id);
  if (models.some((model) => typeof model !== 'string' || model.length === 0 || model.length > 256)) {
    throw new Error('模型列表响应无效。');
  }
  return [...new Set(models as string[])].sort((left, right) => left.localeCompare(right));
}
