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
  onRemoteEvent?: (evt: AgentEvent) => void;
  waitForRemoteMessage?: () => Promise<string | null>;
  /** Called when user presses a key in remote mode to switch back. */
  onSwitchBackRequested?: () => void;
}

export async function loop(opts: LoopOptions): Promise<number> {
  let sessionId = opts.resumeSessionId ?? null;
  let mode: Mode = 'local';

  const hookServer = await startHookServer({
    onSessionStart: (sid: string) => {
      sessionId = sid;
      scanner.initExisting(sid);
      opts.onSessionId?.(sid);
    },
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
            const switchBack = await runRemote({
              cwd: opts.cwd,
              sessionId: sessionId!,
              agent: opts.agent,
              prompt: result.pendingMessage,
              model: opts.model,
              onEvent: opts.onRemoteEvent,
              waitForRemoteMessage: opts.waitForRemoteMessage,
              listenForSwitchBack: true,
            });
            if (switchBack === 'switch-back') {
              mode = 'local';
              opts.onModeChange?.('local');
              continue;
            }
          }
          // Stay in remote mode, wait for more messages
          while (mode === 'remote') {
            const msg = await Promise.race([
              opts.waitForRemoteMessage?.() ?? new Promise<null>(() => {}),
              waitForKeypress().then(() => null as string | null),
            ]);

            if (msg === null) {
              // Keypress detected or exit signal
              mode = 'local';
              opts.onModeChange?.('local');
              break;
            }

            const switchBack = await runRemote({
              cwd: opts.cwd,
              sessionId: sessionId!,
              agent: opts.agent,
              prompt: msg,
              model: opts.model,
              onEvent: opts.onRemoteEvent,
              waitForRemoteMessage: opts.waitForRemoteMessage,
              listenForSwitchBack: true,
            });
            if (switchBack === 'switch-back') {
              mode = 'local';
              opts.onModeChange?.('local');
              break;
            }
          }
        }
      } else {
        // Should not reach here — remote loop is handled above
        mode = 'local';
        opts.onModeChange?.('local');
      }
    }
  } finally {
    scanner.cleanup();
    hookServer.stop();
    cleanupHookSettings(hookSettingsPath);
  }
}

function waitForKeypress(): Promise<void> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return;
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
      resolve();
    });
  });
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
  waitForRemoteMessage?: () => Promise<string | null>;
  listenForSwitchBack?: boolean;
}): Promise<'done' | 'switch-back'> {
  const run = opts.agent.run({
    prompt: opts.prompt,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    model: opts.model,
  });

  let switchBack = false;
  let keypressPromise: Promise<void> | null = null;

  if (opts.listenForSwitchBack && process.stdin.isTTY) {
    keypressPromise = waitForKeypress().then(() => { switchBack = true; });
  }

  try {
    for await (const evt of run.events) {
      opts.onEvent?.(evt);
      if (evt.type === 'result' || evt.type === 'error') break;
      if (switchBack) break;
    }
  } finally {
    const exited = await run.waitForExit(2000);
    if (!exited) await run.stop();
  }

  return switchBack ? 'switch-back' : 'done';
}
