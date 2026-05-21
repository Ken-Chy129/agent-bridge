import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createSessionScanner } from './scanner';
import { startHookServer } from './hook/server';
import { generateHookSettings, cleanupHookSettings } from './hook/settings';
import type { AgentAdapter } from './agent/types';
import type { ScannedMessage } from './scanner';

export type Mode = 'local' | 'remote';

export interface LoopOptions {
  cwd: string;
  agent: AgentAdapter;
  resumeSessionId?: string;
  model?: string;
  claudeArgs?: string[];
  /** Called when the scanner picks up a new JSONL message (for Feishu relay). */
  onScanMessage?: (msg: ScannedMessage) => void;
  /** Called when session ID is discovered. */
  onSessionId?: (sessionId: string) => void;
  /** Called when mode changes. */
  onModeChange?: (mode: Mode) => void;
  /** Returns a promise that resolves when a remote message arrives. null = exit. */
  waitForRemoteMessage?: () => Promise<string | null>;
}

export async function loop(opts: LoopOptions): Promise<number> {
  let sessionId = opts.resumeSessionId ?? null;
  let mode: Mode = 'local';

  // Hook server to capture session ID from Claude
  const hookServer = await startHookServer((sid) => {
    sessionId = sid;
    scanner.initExisting(sid);
    opts.onSessionId?.(sid);
  });
  const hookSettingsPath = generateHookSettings(hookServer.port);

  // JSONL scanner for real-time relay
  const scanner = createSessionScanner({
    workingDirectory: opts.cwd,
    onMessage: (msg) => opts.onScanMessage?.(msg),
  });
  scanner.startPolling();

  if (sessionId) {
    scanner.initExisting(sessionId);
  }

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

          // Process the remote message that triggered the switch
          if (result.pendingMessage) {
            await runRemote({
              cwd: opts.cwd,
              sessionId: sessionId!,
              agent: opts.agent,
              prompt: result.pendingMessage,
              model: opts.model,
              onScanMessage: opts.onScanMessage,
            });
          }
        }
      } else {
        // Remote mode: wait for messages from Feishu
        const msg = await opts.waitForRemoteMessage?.();
        if (!msg) {
          return 0;
        }

        await runRemote({
          cwd: opts.cwd,
          sessionId: sessionId!,
          agent: opts.agent,
          prompt: msg,
          model: opts.model,
          onScanMessage: opts.onScanMessage,
        });

        // Check if user wants to switch back (non-blocking stdin check)
        // For now, stay in remote mode until explicit switch
      }
    }
  } finally {
    scanner.cleanup();
    hookServer.stop();
    cleanupHookSettings(hookSettingsPath);
  }
}

// --- Local mode: native CC TUI ---

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

    // Listen for remote messages — if one arrives, kill local and switch
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

// --- Remote mode: stream-json for Feishu ---

async function runRemote(opts: {
  cwd: string;
  sessionId: string;
  agent: AgentAdapter;
  prompt: string;
  model?: string;
  onScanMessage?: (msg: ScannedMessage) => void;
}): Promise<void> {
  const run = opts.agent.run({
    prompt: opts.prompt,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    model: opts.model,
  });

  try {
    for await (const evt of run.events) {
      // In remote mode, we rely on stream-json events for real-time Feishu updates.
      // The scanner also picks up JSONL changes, but stream-json is more granular.
      if (evt.type === 'result' || evt.type === 'error') break;
    }
  } finally {
    const exited = await run.waitForExit(2000);
    if (!exited) await run.stop();
  }
}
