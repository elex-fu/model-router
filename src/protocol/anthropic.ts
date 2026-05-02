import type { ProtocolAdapter } from './adapter.js';

export class AnthropicAdapter implements ProtocolAdapter {
  needsTransform(): boolean {
    return false;
  }

  transformRequest(req: RequestInit): RequestInit {
    return req;
  }

  async transformResponse(res: Response): Promise<Response> {
    return res;
  }

  extractModel(body: any): string | undefined {
    return body?.model;
  }

  extractUsage(body: any): { inputTokens?: number; outputTokens?: number } {
    return {
      inputTokens: body?.usage?.input_tokens,
      outputTokens: body?.usage?.output_tokens,
    };
  }

  extractStreamUsage(events: string[]): { inputTokens?: number; outputTokens?: number } {
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for (const raw of events) {
      const event = this.parseSseEvent(raw);
      if (!event) continue;

      if (event.type === 'message_start') {
        inputTokens = event.message?.usage?.input_tokens;
      } else if (event.type === 'message_delta') {
        outputTokens = event.usage?.output_tokens;
      }
    }

    return { inputTokens, outputTokens };
  }

  private parseSseEvent(raw: string): any | null {
    const lines = raw.split('\n');
    let data = '';
    for (const line of lines) {
      if (line.startsWith('data:')) {
        data = line.slice(5).trimStart();
      }
    }
    if (!data || data === '[DONE]') return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
}
