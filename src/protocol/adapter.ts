export interface ProtocolAdapter {
  needsTransform(): boolean;
  transformRequest(req: RequestInit): RequestInit;
  transformResponse(res: Response): Promise<Response>;
  extractModel(body: any): string | undefined;
  extractUsage(body: any): { inputTokens?: number; outputTokens?: number };
  extractStreamUsage(events: string[]): { inputTokens?: number; outputTokens?: number };
}
