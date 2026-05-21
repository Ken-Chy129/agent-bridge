/**
 * Unified event stream from any coding agent (Claude Code, Codex, …).
 * The daemon consumes these and fans out to all connected views.
 */
export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; id: string; name: string; input: string }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean }
  | { type: 'system'; sessionId?: string; cwd?: string }
  | { type: 'usage'; costUsd?: number }
  | { type: 'result'; duration?: number }
  | { type: 'error'; message: string };

export interface AgentRunOptions {
  prompt: string;
  sessionId?: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  stopGraceMs?: number;
}

export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  run(opts: AgentRunOptions): AgentRun;
}
