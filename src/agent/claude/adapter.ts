import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type {
  AgentAdapter,
  AgentEvent,
  AgentPipe,
  AgentRun,
  AgentRunOptions,
} from '../types';

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

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      events: createReadStream(child.stdout),
      stop: () => killGracefully(child, stopGraceMs),
      waitForExit: (ms) => waitForExit(child, ms),
    };
  }

  pipe(opts: Omit<AgentRunOptions, 'prompt'>): AgentPipe {
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-mode', opts.permissionMode ?? 'bypassPermissions',
    ];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.model) args.push('--model', opts.model);

    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessByStdio<Writable, Readable, Readable>;

    let sessionId = opts.sessionId;
    const stopGraceMs = opts.stopGraceMs ?? 5000;

    const eventStream = createReadStream(child.stdout);

    // Wrap to capture sessionId from system events
    const trackedEvents = async function* () {
      for await (const evt of eventStream) {
        if (evt.type === 'system' && evt.sessionId) {
          sessionId = evt.sessionId;
        }
        yield evt;
      }
    };

    return {
      send(prompt: string) {
        const msg = JSON.stringify({ type: 'user', content: prompt });
        child.stdin.write(msg + '\n');
      },
      events: trackedEvents(),
      stop: () => killGracefully(child, stopGraceMs),
      get sessionId() { return sessionId; },
      get pid() { return child.pid; },
    };
  }
}

async function* createReadStream(
  stdout: Readable,
): AsyncGenerator<AgentEvent> {
  const rl = createInterface({ input: stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const evt = translateEvent(parsed);
    if (evt) yield evt;
  }
  rl.close();
}

function translateEvent(raw: unknown): AgentEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  switch (obj.type) {
    case 'assistant': {
      const msg = obj.message as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: string }> } | undefined;
      if (!msg?.content) return null;
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          return { type: 'text', content: block.text };
        }
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use',
            id: block.id ?? '',
            name: block.name ?? '',
            input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? ''),
          };
        }
      }
      return null;
    }
    case 'content_block_delta': {
      const delta = obj.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === 'text_delta' && delta.text) {
        return { type: 'text', content: delta.text };
      }
      return null;
    }
    case 'result':
      return { type: 'result', duration: obj.duration_ms as number | undefined };
    case 'system':
      return {
        type: 'system',
        sessionId: obj.session_id as string | undefined,
        cwd: obj.cwd as string | undefined,
      };
    default:
      return null;
  }
}

function killGracefully(
  child: { kill: (sig: string) => void; exitCode: number | null; signalCode: string | null; once: (evt: string, cb: () => void) => void },
  graceMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.kill('SIGTERM');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      resolve();
    }, graceMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function waitForExit(
  child: { exitCode: number | null; signalCode: string | null; once: (evt: string, cb: () => void) => void; removeListener: (evt: string, cb: () => void) => void },
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false); }, timeoutMs);
    child.once('exit', onExit);
  });
}
