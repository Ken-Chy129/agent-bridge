import { spawn } from 'node:child_process';
import { createSessionScanner } from './scanner';
import { startHookServer } from './hook/server';
import { generateHookSettings, cleanupHookSettings } from './hook/settings';
import type { AgentAdapter, AgentEvent } from './agent/types';
import type { ScannedMessage } from './scanner';

export type Mode = 'local' | 'remote';

export interface LoopOptions {
  cwd: string;
  agent: AgentAdapter;
  resumeSessionId?: string;
  model?: string;
  claudeArgs?: string[];
  onScanMessage?: (msg: ScannedMessage) => void;
  onSessionId?: (sessionId: string) => void;
  onModeChange?: (mode: Mode) => void;
  /** Called on each stream-json event in remote mode (for Feishu streaming cards). */
  onRemoteEvent?: (evt: AgentEvent) => void;
  /** Returns a promise that resolves when a remote message arrives. null = exit. */
  waitForRemoteMessage?: () => Promise<string | null>;
}

export async function loop(opts: LoopOptions): Promise<number> {
  let sessionId = opts.resumeSessionId ?? null;
  let mode: Mode = 'local';

  const hookServer = await startHookServer((sid) => {
    sessionId = sid;
    scanner.initExisting(sid);
    opts.onSessionId?.(sid);
  });
  const hookSettingsPath = generateHookSettings(hookServer.port);

  const scanner = createSessionScanner({
    workingDirectory: opts.cwd,
    onMessage: (msg) => opts.onScanMessage?.(msg),
  });
  scanner.startPolling();

  if (sessionId) scanner.initExisting(sessionId);

  try {
    while (true) {
      if (mode === 'local') {
        const result = await runLocal({
          cwd: opts.cwd,
          sessionId,
          hookSettingsPath,
          claudeArgs: opts.claudeArgs,
          model: opts.model,
          waitForRemoteMessage: opts.waitForRemoteMessage,
        });

        if (result.type === 'exit') return result.code;
        if (result.type === 'switch') {
          mode = 'remote';
          opts.onModeChange?.('remote');
          if (result.pendingMessage) {
            await runRemote({
              cwd: opts.cwd,
              sessionId: sessionId!,
              agent: opts.agent,
              prompt: result.pendingMessage,
              model: opts.model,
              onEvent: opts.onRemoteEvent,
            });
          }
        }
      } else {
        const msg = await opts.waitForRemoteMessage?.();
        if (!msg) return 0;

        await runRemote({
          cwd: opts.cwd,
          sessionId: sessionId!,
          agent: opts.agent,
          prompt: msg,
          model: opts.model,
          onEvent: opts.onRemoteEvent,
        });
      }
    }
  } finally {
    scanner.cleanup();
    hookServer.stop();
    cleanupHookSettings(hookSettingsPath);
  }
}

interface LocalResult {
  type: 'exit' | 'switch';
  code: number;
  pendingMessage?: string;
}

async function runLocal(opts: {
  cwd: string;
  sessionId: string | null;
  hookSettingsPath: string;
  claudeArgs?: string[];
  model?: string;
  waitForRemoteMessage?: () => Promise<string | null>;
}): Promise<LocalResult> {
  const args: string[] = [];
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  if (opts.model) args.push('--model', opts.model);
  args.push('--settings', opts.hookSettingsPath);
  if (opts.claudeArgs) args.push(...opts.claudeArgs);

  return new Promise<LocalResult>((resolve) => {
    const child = spawn('claude', args, {
      cwd: opts.cwd,
      stdio: 'inherit',
    });

    let switchedByRemote = false;
    let pendingMessage: string | undefined;

    if (opts.waitForRemoteMessage) {
      opts.waitForRemoteMessage().then((msg) => {
        if (msg && child.exitCode === null) {
          switchedByRemote = true;
          pendingMessage = msg;
          child.kill('SIGTERM');
        }
      });
    }

    child.on('exit', (code) => {
      if (switchedByRemote) {
        resolve({ type: 'switch', code: code ?? 0, pendingMessage });
      } else {
        resolve({ type: 'exit', code: code ?? 0 });
      }
    });
  });
}

async function runRemote(opts: {
  cwd: string;
  sessionId: string;
  agent: AgentAdapter;
  prompt: string;
  model?: string;
  onEvent?: (evt: AgentEvent) => void;
}): Promise<void> {
  const run = opts.agent.run({
    prompt: opts.prompt,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    model: opts.model,
  });

  try {
    for await (const evt of run.events) {
      opts.onEvent?.(evt);
      if (evt.type === 'result' || evt.type === 'error') break;
    }
  } finally {
    const exited = await run.waitForExit(2000);
    if (!exited) await run.stop();
  }
}
