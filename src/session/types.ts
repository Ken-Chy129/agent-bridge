export interface Session {
  id: string;
  agentId: string;
  cwd: string;
  model?: string;
  /** Claude Code session ID (used for --resume). */
  ccSessionId?: string;
  /** Feishu thread ID this session is bound to. */
  threadId?: string;
  /** Feishu chat ID (topic group). */
  chatId?: string;
  createdAt: number;
  updatedAt: number;
  /** 'managed' = daemon-owned, 'relay' = attached to external CC process */
  mode: 'managed' | 'relay';
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
