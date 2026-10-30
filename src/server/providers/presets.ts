/**
 * No-signing provider presets (plan C3): OpenRouter, Groq, SiliconFlow and
 * DeepSeek-official. These providers need nothing beyond URL/path
 * conventions, a default auth header style and a default base URL — pure
 * data plus small functions, no signing, no network.
 */

/** The auth header styles a preset can request. */
export type PresetAuthMode = 'bearer' | 'x-api-key' | 'custom-header';

export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly protocol: 'anthropic' | 'openai' | 'gemini' | 'responses';
  /** Default base URL used when the upstream configures none. */
  readonly defaultBaseUrl: string;
  /** Default endpoint path segment (protocol relative, no leading slash). */
  readonly endpoint: string;
  readonly authMode: PresetAuthMode;
  /** Required when authMode is 'custom-header'. */
  readonly authHeaderName?: string;
  /** Default models hint — a convenience list, never a whitelist. */
  readonly models: readonly string[];
  /**
   * Builds the absolute request URL. `baseUrl`/`endpoint` empty means "use
   * the preset defaults"; a leading slash on the endpoint is tolerated.
   * The model never rides these URLs (it stays in the body).
   */
  buildUrl(input: { readonly baseUrl?: string; readonly endpoint?: string; readonly model?: string | null }): string;
  /** The auth headers for one API key. */
  authHeaders(apiKey: string): Record<string, string>;
}

/** Joins a base URL and an endpoint path without double slashes. */
export function joinProviderUrl(baseUrl: string, endpoint: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const path = endpoint.trim().replace(/^\/+/, '');
  if (base === '') return `/${path}`;
  return path === '' ? base : `${base}/${path}`;
}

/** The auth header map for one auth style. */
export function presetAuthHeaders(
  authMode: PresetAuthMode,
  apiKey: string,
  authHeaderName?: string,
): Record<string, string> {
  switch (authMode) {
    case 'bearer':
      return { authorization: `Bearer ${apiKey}` };
    case 'x-api-key':
      return { 'x-api-key': apiKey };
    case 'custom-header': {
      const name = authHeaderName?.trim() ?? '';
      if (name === '') throw new Error(`provider preset ${authMode} requires authHeaderName`);
      return { [name.toLowerCase()]: apiKey };
    }
  }
}

function makePreset(definition: Omit<ProviderPreset, 'buildUrl' | 'authHeaders'>): ProviderPreset {
  return {
    ...definition,
    buildUrl: (input) =>
      joinProviderUrl(
        input.baseUrl !== undefined && input.baseUrl.trim() !== '' ? input.baseUrl : definition.defaultBaseUrl,
        input.endpoint !== undefined && input.endpoint.trim() !== '' ? input.endpoint : definition.endpoint,
      ),
    authHeaders: (apiKey) => presetAuthHeaders(definition.authMode, apiKey, definition.authHeaderName),
  };
}

/** The bundled no-signing presets, keyed by preset id. */
export const PROVIDER_PRESETS: Readonly<Record<string, ProviderPreset>> = Object.freeze({
  openrouter: makePreset({
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    endpoint: 'chat/completions',
    authMode: 'bearer',
    models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4o', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'],
  }),
  groq: makePreset({
    id: 'groq',
    label: 'Groq',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    endpoint: 'chat/completions',
    authMode: 'bearer',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b'],
  }),
  siliconflow: makePreset({
    id: 'siliconflow',
    label: 'SiliconFlow',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    endpoint: 'chat/completions',
    authMode: 'bearer',
    models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'],
  }),
  'deepseek-official': makePreset({
    id: 'deepseek-official',
    label: 'DeepSeek Official',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com',
    endpoint: 'chat/completions',
    authMode: 'bearer',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  }),
});

/** The preset ids, in definition order. */
export const PROVIDER_PRESET_IDS: readonly string[] = Object.freeze(Object.keys(PROVIDER_PRESETS));

/** Looks up one preset by id (case-insensitive); null when unknown. */
export function providerPreset(id: string): ProviderPreset | null {
  const direct = PROVIDER_PRESETS[id];
  if (direct !== undefined) return direct;
  const lowered = PROVIDER_PRESETS[id.toLowerCase()];
  return lowered !== undefined ? lowered : null;
}
