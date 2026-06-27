export class CodexChatHistoryStore {
  private chains = new Map<string, string>();

  setPreviousResponseId(sessionId: string, responseId: string): void {
    this.chains.set(sessionId, responseId);
  }
  getPreviousResponseId(sessionId: string): string | undefined {
    return this.chains.get(sessionId);
  }
}
