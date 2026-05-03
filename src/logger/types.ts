export interface LogEntry {
  id?: number;
  proxy_key_name: string;
  client_ip: string | null;
  client_protocol: 'anthropic' | 'openai' | null;
  upstream_protocol: 'anthropic' | 'openai' | null;
  request_model: string | null;
  actual_model: string | null;
  upstream_name: string | null;
  status_code: number | null;
  error_message: string | null;
  request_tokens: number | null;
  response_tokens: number | null;
  total_tokens: number | null;
  duration_ms: number | null;
  is_streaming: boolean;
  created_at?: string;
}

export interface StatsResult {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number;
}

export interface KeyStats {
  keyName: string;
  requests: number;
  errors: number;
  rateLimited: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  lastSeen: string | null;
}
