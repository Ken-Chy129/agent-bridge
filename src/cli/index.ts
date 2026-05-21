import { createInterface } from 'node:readline';
import { Command } from 'commander';
import { ClaudeAdapter } from '../agent/claude/adapter';
import { discoverCCSessions } from '../daemon/discover';
import { loop } from '../loop';
import {
  loadConfig,
  saveConfig,
  hasFeishuConfig,
  configPath,
} from '../feishu/config';
import { startFeishuBridge, type FeishuBridge } from '../feishu/channel';
import { formatForFeishu, threadTitle } from '../feishu/format';
import { runSetupWizard } from '../feishu/wizard';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

const program = new Command()
  .name('agent-bridge')
  .description('Bridge local coding agents to Feishu/Lark with daemon-hosted multi-view sessions')
  .version('0.1.0');

// --- chat ---

program
  .command('chat', { isDefault: true })
  .description('Start Claude Code with Feishu bridge')
  .option('-d, --dir <path>', 'Working directory', process.cwd())
  .option('-m, --model <model>', 'Model override')
  .option('-r, --resume <sessionId>', 'Resume a CC session by ID')
  .option('-c, --continue', 'Continue the most recent session')
  .option('--no-feishu', 'Disable Feishu bridge')
  .action(async (opts) => {
    const agent = new ClaudeAdapter();
    const claudeArgs: string[] = [];
    if (opts.continue) claudeArgs.push('--continue');

    // Feishu bridge (optional)
    let feishu: FeishuBridge | null = null;
    let feishuChatId: string | undefined;
    let threadMsgId: string | null = null;
    let firstPromptSeen = false;

    // Message queue: Feishu messages waiting to be processed
    let remoteResolve: ((msg: string | null) => void) | null = null;

    if (opts.feishu) {
      // Auto-trigger wizard on first run
      if (!hasFeishuConfig()) {
        try {
          const feishuCfg = await runSetupWizard();
          const cfg = loadConfig();
          cfg.feishu = feishuCfg;
          saveConfig(cfg);
          console.log(`配置已保存到 ${configPath()}\n`);
        } catch (err) {
          console.error(`[feishu] 扫码配置失败: ${err}. Continuing without Feishu.`);
        }
      }

      if (hasFeishuConfig()) {
        const cfg = loadConfig();
        feishuChatId = cfg.feishu!.chatId;

        try {
          feishu = await startFeishuBridge(cfg.feishu!, {
            onMessage: (msg: NormalizedMessage) => {
              if (feishuChatId && msg.chatId !== feishuChatId) return;
              const text = msg.content.trim();
              if (!text) return;
              console.error(`[feishu] received: ${text.slice(0, 60)}`);
              if (remoteResolve) {
                remoteResolve(text);
                remoteResolve = null;
              }
            },
          });
        } catch (err) {
          console.error(`[feishu] connection failed: ${err}. Continuing without Feishu.`);
        }
      }
    }

    const exitCode = await loop({
      cwd: opts.dir,
      agent,
      resumeSessionId: opts.resume,
      model: opts.model,
      claudeArgs,

      onSessionId: (sid) => {
        console.error(`[bridge] session: ${sid}`);
      },

      onScanMessage: async (msg) => {
        // Create thread on first user prompt
        if (!firstPromptSeen && msg.type === 'user' && feishu && feishuChatId) {
          firstPromptSeen = true;
          const content = (msg.raw as any).message?.content;
          const text = typeof content === 'string' ? content : '';
          const title = threadTitle(opts.dir, text);
          console.error(`[feishu] creating thread: ${title}`);
          threadMsgId = await feishu.createThread(feishuChatId, title);
        }

        // Push to Feishu
        if (feishu && feishuChatId) {
          const md = formatForFeishu(msg);
          if (md) {
            try {
              await feishu.sendMarkdown(feishuChatId, md, {
                replyTo: threadMsgId ?? undefined,
              });
            } catch (err) {
              console.error(`[feishu] send failed: ${err}`);
            }
          }
        }

        // Console log
        if (msg.type === 'user') {
          const content = (msg.raw as any).message?.content;
          const preview = typeof content === 'string'
            ? content.slice(0, 60)
            : JSON.stringify(content)?.slice(0, 60);
          console.error(`[bridge] scan: user → ${preview}`);
        } else if (msg.type === 'assistant') {
          console.error(`[bridge] scan: assistant message`);
        }
      },

      onRemoteEvent: async (evt) => {
        // In remote mode, stream-json events for Feishu real-time updates
        if (!feishu || !feishuChatId) return;
        if (evt.type === 'text') {
          try {
            await feishu.sendMarkdown(feishuChatId, evt.content, {
              replyTo: threadMsgId ?? undefined,
            });
          } catch {}
        }
      },

      onModeChange: (mode) => {
        if (mode === 'remote') {
          console.log('\n💬 会话已转到飞书，按 Ctrl+C 退出');
        } else {
          console.log('\n⌨️  切回终端模式');
        }
      },

      waitForRemoteMessage: feishu
        ? () => new Promise<string | null>((resolve) => { remoteResolve = resolve; })
        : undefined,
    });

    if (feishu) await feishu.disconnect();
    process.exit(exitCode);
  });

// --- config ---

program
  .command('config')
  .description('Configure Feishu app (QR code wizard)')
  .option('--reset', 'Reset config and re-run wizard')
  .option('--chat-id <chatId>', 'Set topic group Chat ID directly')
  .action(async (opts) => {
    const cfg = loadConfig();

    if (opts.chatId) {
      if (!cfg.feishu) {
        console.error('No Feishu config. Run `agent-bridge config` first.');
        process.exit(1);
      }
      cfg.feishu.chatId = opts.chatId;
      saveConfig(cfg);
      console.log(`Chat ID → ${opts.chatId}`);
      return;
    }

    if (opts.reset || !hasFeishuConfig()) {
      const feishuCfg = await runSetupWizard();
      cfg.feishu = feishuCfg;
      saveConfig(cfg);
      console.log(`配置已保存到 ${configPath()}`);
      return;
    }

    // Show current config and offer actions
    const f = cfg.feishu!;
    console.log(`\nFeishu 配置 (${configPath()})\n`);
    console.log(`  App ID:   ${f.appId}`);
    console.log(`  Tenant:   ${f.tenant}`);
    console.log(`  Chat ID:  ${f.chatId ?? '(未设置)'}`);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> =>
      new Promise((r) => rl.question(q, (a) => r(a.trim())));

    console.log(`\n  1) 重新扫码配置应用`);
    console.log(`  2) 选择/创建话题群`);
    console.log(`  0) 退出`);

    const choice = await ask('\n选择 [0]: ');
    rl.close();

    if (choice === '1') {
      const feishuCfg = await runSetupWizard();
      cfg.feishu = feishuCfg;
      saveConfig(cfg);
      console.log(`配置已保存到 ${configPath()}`);
    } else if (choice === '2') {
      const { setupTopicGroup } = await import('../feishu/wizard');
      const chatId = await setupTopicGroup({
        appId: f.appId,
        appSecret: f.appSecret,
        tenant: f.tenant,
      });
      if (chatId) {
        cfg.feishu!.chatId = chatId;
        saveConfig(cfg);
        console.log(`配置已保存到 ${configPath()}`);
      }
    }
  });

// --- discover ---

program
  .command('discover')
  .description('List local Claude Code sessions')
  .action(() => {
    const sessions = discoverCCSessions();
    if (sessions.length === 0) {
      console.log('No active Claude Code sessions found.');
      return;
    }
    console.log(`Found ${sessions.length} session(s):\n`);
    for (const s of sessions) {
      const status = s.status === 'idle' ? 'idle' : s.status === 'busy' ? 'busy' : s.status;
      const age = Math.round((Date.now() - s.startedAt) / 60000);
      console.log(`  PID ${s.pid}  [${status}]  ${s.cwd}`);
      console.log(`    session: ${s.sessionId}  age: ${age}m  ver: ${s.version}`);
      console.log();
    }
  });

// --- relay ---

program
  .command('relay [sessionId]')
  .description('Relay an existing Claude Code session to Feishu')
  .action(async (sessionId?: string) => {
    const allSessions = discoverCCSessions();

    let target = sessionId
      ? allSessions.find((s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId!))
      : null;

    if (!target && !sessionId) {
      if (allSessions.length === 0) {
        console.log('No active Claude Code sessions found.');
        process.exit(1);
      }
      if (allSessions.length === 1) {
        target = allSessions[0];
      } else {
        console.log('Multiple sessions found:\n');
        for (let i = 0; i < allSessions.length; i++) {
          const s = allSessions[i];
          console.log(`  ${i + 1}) PID ${s.pid} [${s.status}] ${s.cwd}`);
          console.log(`     session: ${s.sessionId}`);
        }
        console.log(`\nRun: agent-bridge relay <sessionId>`);
        process.exit(0);
      }
    }

    if (!target) {
      console.error(`Session not found: ${sessionId}`);
      process.exit(1);
    }

    console.log(`Relaying session ${target.sessionId.slice(0, 8)}...`);
    console.log(`  PID: ${target.pid} | cwd: ${target.cwd} | status: ${target.status}`);

    // Optional Feishu relay
    let feishu: FeishuBridge | null = null;
    let feishuChatId: string | undefined;
    let threadMsgId: string | null = null;
    let firstPromptSeen = false;

    if (hasFeishuConfig()) {
      const cfg = loadConfig();
      feishuChatId = cfg.feishu!.chatId;
      try {
        feishu = await startFeishuBridge(cfg.feishu!);
        console.log('  Feishu bridge connected.');
      } catch (err) {
        console.error(`  Feishu connection failed: ${err}. Console-only relay.`);
      }
    }

    console.log('  Watching JSONL for real-time updates. Ctrl+C to stop.\n');

    const { createSessionScanner } = await import('../scanner');
    const scanner = createSessionScanner({
      workingDirectory: target.cwd,
      onMessage: async (msg) => {
        const ts = new Date().toLocaleTimeString();

        // Create Feishu thread on first user message
        if (!firstPromptSeen && msg.type === 'user' && feishu && feishuChatId) {
          firstPromptSeen = true;
          const content = (msg.raw as any).message?.content;
          const text = typeof content === 'string' ? content : '';
          const title = threadTitle(target!.cwd, text);
          threadMsgId = await feishu.createThread(feishuChatId, title);
        }

        // Push to Feishu
        if (feishu && feishuChatId) {
          const md = formatForFeishu(msg);
          if (md) {
            try {
              await feishu.sendMarkdown(feishuChatId, md, {
                replyTo: threadMsgId ?? undefined,
              });
            } catch {}
          }
        }

        // Console output
        if (msg.type === 'user') {
          const content = (msg.raw as any).message?.content;
          const preview = typeof content === 'string'
            ? content.slice(0, 80)
            : JSON.stringify(content)?.slice(0, 80);
          console.log(`[${ts}] user → ${preview}`);
        } else if (msg.type === 'assistant') {
          const content = (msg.raw as any).message?.content;
          let preview = '';
          if (Array.isArray(content)) {
            const text = content.find((b: any) => b.type === 'text');
            if (text?.text) preview = text.text.slice(0, 80);
            const tools = content.filter((b: any) => b.type === 'tool_use');
            if (tools.length > 0) preview += ` [+${tools.length} tool calls]`;
          }
          console.log(`[${ts}] assistant → ${preview || '(message)'}`);
        }
      },
    });

    scanner.initExisting(target.sessionId);
    scanner.startPolling();

    process.on('SIGINT', async () => {
      scanner.cleanup();
      if (feishu) await feishu.disconnect();
      console.log('\nRelay stopped.');
      process.exit(0);
    });

    await new Promise(() => {});
  });

program.parse();
