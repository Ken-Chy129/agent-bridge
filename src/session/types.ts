export interface Session {
  id: string;
  agentId: string;
  cwd: string;
  /** Feishu thread ID this session is bound to, if any. */
  threadId?: string;
  /** Feishu chat ID (topic group). */
  chatId?: string;
  createdAt: number;
  updatedAt: number;
  /** 'pipe' = daemon-hosted long-lived, 'relay' = attached to external CC process */
  mode: 'pipe' | 'relay';
  /** PID of the relay source (only for relay mode). */
  relayPid?: number;
}

export interface SessionStore {
  list(): Session[];
  get(id: string): Session | undefined;
  getByThread(chatId: string, threadId: string): Session | undefined;
  set(session: Session): void;
  remove(id: string): void;
  flush(): Promise<void>;
}
