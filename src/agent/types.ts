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

/**
 * Long-lived agent connection. Unlike AgentRun (one prompt → one response),
 * this represents a persistent bidirectional pipe to an agent process
 * started with stream-json input/output.
 */
export interface AgentPipe {
  send(prompt: string): void;
  events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  readonly sessionId: string | undefined;
  readonly pid: number | undefined;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;

  /** One-shot: spawn a process for a single prompt, then exit. */
  run(opts: AgentRunOptions): AgentRun;

  /** Long-lived: spawn a persistent process with bidirectional JSON pipe. */
  pipe(opts: Omit<AgentRunOptions, 'prompt'>): AgentPipe;
}
