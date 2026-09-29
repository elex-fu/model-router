import type { Protocol } from '../config/types.js';

export interface ProviderProfile {
  id: string;
  protocol: Protocol;
  baseUrl?: string;
  endpoint: string;
  authMode: 'bearer' | 'x-api-key' | 'google';
  nativeResponses: boolean;
  compact: boolean;
  preserveReasoning: boolean;
  claudeOptimizations: boolean;
}

export const PROVIDER_PROFILES: Readonly<Record<string, ProviderProfile>> = {
  'kimi-platform': {
    id: 'kimi-platform',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    endpoint: 'chat/completions',
    authMode: 'bearer',
    nativeResponses: false,
    compact: false,
    preserveReasoning: true,
    claudeOptimizations: false,
  },
  'kimi-platform-global': {
    id: 'kimi-platform-global',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    endpoint: 'chat/completions',
    authMode: 'bearer',
    nativeResponses: false,
    compact: false,
    preserveReasoning: true,
    claudeOptimizations: false,
  },
  'kimi-code': {
    id: 'kimi-code',
    protocol: 'anthropic',
    baseUrl: 'https://api.kimi.com/coding/v1',
    endpoint: 'messages',
    authMode: 'x-api-key',
    nativeResponses: false,
    compact: false,
    preserveReasoning: true,
    claudeOptimizations: false,
  },
  'kimi-code-global': {
    id: 'kimi-code-global',
    protocol: 'anthropic',
    baseUrl: 'https://api.kimi.ai/coding/v1',
    endpoint: 'messages',
    authMode: 'x-api-key',
    nativeResponses: false,
    compact: false,
    preserveReasoning: true,
    claudeOptimizations: false,
  },
  'deepseek-chat': {
    id: 'deepseek-chat',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    endpoint: 'chat/completions',
    authMode: 'bearer',
    nativeResponses: false,
    compact: false,
    preserveReasoning: true,
    claudeOptimizations: false,
  },
  'deepseek-anthropic': {
    id: 'deepseek-anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic/v1',
    endpoint: 'messages',
    authMode: 'x-api-key',
    nativeResponses: false,
    compact: false,
    preserveReasoning: true,
    claudeOptimizations: false,
  },
  'custom-openai': {
    id: 'custom-openai',
    protocol: 'openai',
    endpoint: 'chat/completions',
    authMode: 'bearer',
    nativeResponses: false,
    compact: false,
    preserveReasoning: true,
    claudeOptimizations: false,
  },
  'custom-anthropic': {
    id: 'custom-anthropic',
    protocol: 'anthropic',
    endpoint: 'messages',
    authMode: 'x-api-key',
    nativeResponses: false,
    compact: false,
    preserveReasoning: true,
    claudeOptimizations: false,
  },
  'custom-responses': {
    id: 'custom-responses',
    protocol: 'responses',
    endpoint: 'responses',
    authMode: 'bearer',
    nativeResponses: true,
    compact: false,
    preserveReasoning: true,
    claudeOptimizations: false,
  },
};

/** Existing provider names remain valid; new presets are explicit. */
export function providerProfile(provider: string, protocol: Protocol): ProviderProfile {
  const preset = PROVIDER_PROFILES[provider];
  if (preset) return preset;
  if (provider === 'kimi')
    return protocol === 'anthropic' ? PROVIDER_PROFILES['kimi-code'] : PROVIDER_PROFILES['kimi-platform'];
  if (provider === 'deepseek')
    return protocol === 'anthropic' ? PROVIDER_PROFILES['deepseek-anthropic'] : PROVIDER_PROFILES['deepseek-chat'];
  return {
    id: provider,
    protocol,
    endpoint: protocol === 'anthropic' ? 'messages' : protocol === 'responses' ? 'responses' : 'chat/completions',
    authMode: 'bearer',
    nativeResponses: protocol === 'responses',
    compact: false,
    preserveReasoning: true,
    claudeOptimizations: provider === 'anthropic',
  };
}
