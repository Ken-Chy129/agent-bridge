import type { Session, SessionStore } from './types';

export class MemorySessionStore implements SessionStore {
  private readonly data = new Map<string, Session>();

  list(): Session[] {
    return [...this.data.values()];
  }

  get(id: string): Session | undefined {
    return this.data.get(id);
  }

  getByThread(chatId: string, threadId: string): Session | undefined {
    for (const s of this.data.values()) {
      if (s.chatId === chatId && s.threadId === threadId) return s;
    }
    return undefined;
  }

  set(session: Session): void {
    this.data.set(session.id, session);
  }

  remove(id: string): void {
    this.data.delete(id);
  }

  async flush(): Promise<void> {
    // TODO: persist to ~/.agent-bridge/sessions.json
  }
}
