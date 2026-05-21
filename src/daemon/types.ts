import type { Session } from '../session/types';

/** Operations the daemon exposes over its local API (Unix socket / HTTP). */
export interface DaemonApi {
  /** List all active sessions. */
  sessions(): Session[];

  /** Create a new daemon-hosted session, optionally binding to a Feishu thread. */
  createSession(opts: {
    agentId: string;
    cwd: string;
    chatId?: string;
    threadId?: string;
    model?: string;
  }): Promise<Session>;

  /** Send a user message to a session. */
  send(sessionId: string, prompt: string): void;

  /** Attach a Feishu thread to an existing session (for take-away). */
  bind(sessionId: string, chatId: string, threadId: string): void;

  /** Relay an external CC session (discovered from ~/.claude/sessions/). */
  relay(pid: number, chatId: string, threadId: string): Promise<Session>;

  /** Stop a session. */
  stop(sessionId: string): Promise<void>;

  /** Discover local Claude Code sessions from ~/.claude/sessions/. */
  discoverLocalSessions(): LocalSession[];
}

export interface LocalSession {
  pid: number;
  sessionId: string;
  cwd: string;
  status: string;
  startedAt: number;
  version: string;
}
