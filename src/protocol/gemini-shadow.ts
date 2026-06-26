export interface GeminiToolCall {
  callId: string;
  name: string;
  args: any;
}

export class GeminiShadowStore {
  private toolCalls = new Map<string, GeminiToolCall>();

  remember(callId: string, name: string, args: any): void {
    this.toolCalls.set(callId, { callId, name, args });
  }

  get(callId: string): GeminiToolCall | undefined {
    return this.toolCalls.get(callId);
  }

  snapshot(): Record<string, GeminiToolCall> {
    return Object.fromEntries(this.toolCalls);
  }
}
