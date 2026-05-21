import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  private readonly binary: string;

  constructor(opts: { binary?: string } = {}) {
    this.binary = opts.binary ?? 'claude';
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    const args = [
      '-p', opts.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', opts.permissionMode ?? 'bypassPermissions',
    ];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.model) args.push('--model', opts.model);

    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stderr.on('data', () => {});

    let exitResolve: ((code: number | null) => void) | null = null;
    const exitPromise = new Promise<number | null>((r) => { exitResolve = r; });
    child.on('exit', (code) => exitResolve?.(code));

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      events: createEventStream(child.stdout),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            resolve();
          }, stopGraceMs);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      },
      async waitForExit(timeoutMs: number) {
        if (child.exitCode !== null || child.signalCode !== null) return true;
        return Promise.race([
          exitPromise.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
        ]);
      },
    };
  }
}

async function* createEventStream(stdout: Readable): AsyncGenerator<AgentEvent> {
  const rl = createInterface({ input: stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    yield* translate(parsed);
  }
  rl.close();
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function* translate(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const obj = raw as Record<string, unknown>;

  if (obj.type === 'system' && obj.subtype === 'init') {
    yield {
      type: 'system',
      sessionId: obj.session_id as string | undefined,
      cwd: obj.cwd as string | undefined,
    };
    return;
  }

  if (obj.type === 'assistant') {
    const msg = obj.message as { content?: ContentBlock[] } | undefined;
    if (!msg?.content) return;
    for (const block of msg.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        yield { type: 'text', content: block.text };
      } else if (block.type === 'tool_use' && block.id && block.name) {
        yield {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? ''),
        };
      }
    }
    return;
  }

  if (obj.type === 'user') {
    const msg = obj.message as { content?: ContentBlock[] } | undefined;
    if (!msg?.content) return;
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        yield {
          type: 'tool_result',
          id: block.tool_use_id,
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          isError: block.is_error === true,
        };
      }
    }
    return;
  }

  if (obj.type === 'result') {
    if (obj.total_cost_usd !== undefined) {
      yield { type: 'usage', costUsd: obj.total_cost_usd as number };
    }
    yield { type: 'result' };
  }
}
