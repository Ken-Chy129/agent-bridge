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
import { startFeishuBridge, type FeishuBridge, type CardStream } from '../feishu/channel';
import { threadTitle } from '../feishu/format';
import { emptyCardState, reduceMessage, renderCardJson, appendText } from '../feishu/card-state';
import { addWorkingReaction, removeReaction } from '../feishu/reaction';
import { runSetupWizard } from '../feishu/wizard';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { registerServeCommand } from './serve';
import { SessionManager } from '../serve/session-manager';

const program = new Command()
  .name('agent-bridge')
  .description('Bridge local coding agents to Feishu/Lark with daemon-hosted multi-view sessions')
  .version('0.1.0');

// --- serve (daemon mode) ---
registerServeCommand(program);

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

    let feishu: FeishuBridge | null = null;
    let feishuChatId: string | undefined;
    let cardStream: CardStream | null = null;
    let cardState = emptyCardState();
    let threadMsgId: string | null = null;
    let cardUpdateTimer: NodeJS.Timeout | null = null;
    let remoteResolve: ((msg: string | null) => void) | null = null;
    let currentReactionId: string | undefined;
    let lastUserMsgId: string | null = null;

    const scheduleCardUpdate = (finished = false) => {
      if (!cardStream) return;
      if (cardUpdateTimer) clearTimeout(cardUpdateTimer);
      cardUpdateTimer = setTimeout(async () => {
        try { await cardStream!.update(renderCardJson(cardState, finished)); } catch {}
      }, finished ? 0 : 300);
    };

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
              // Don't log here — remote mode display handles it
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

    let inRemoteMode = false;

    const exitCode = await loop({
      cwd: opts.dir,
      agent,
      resumeSessionId: opts.resume,
      model: opts.model,
      claudeArgs,

      onSessionId: () => {},

      onScanMessage: async (msg) => {
        if (!feishu || !feishuChatId) return;
        // In remote mode, onRemoteEvent handles the card — skip scanner events
        if (inRemoteMode) return;

        // Threading: first user message → top-level (creates thread),
        // everything after → replyTo first message (stays in same thread).
        const threadOpts = threadMsgId
          ? { replyTo: threadMsgId, replyInThread: true }
          : {};

        if (msg.type === 'user') {
          const content = msg.content;
          let text = typeof content === 'string'
            ? content
            : (Array.isArray(content) ? content.find((b: any) => b.type === 'text')?.text : null);

          if (Array.isArray(content) && content.some((b: any) => b.type === 'tool_result')) return;

          // Extract base64 images from content blocks
          const images: { base64: string; mediaType: string }[] = [];
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'image' && block.source?.type === 'base64' && block.source?.data) {
                images.push({
                  base64: block.source.data,
                  mediaType: block.source.media_type || 'image/png',
                });
              }
            }
          }

          // Clean up image reference placeholders from text
          if (text) {
            text = text
              .replace(/\[Image: source: [^\]]+\]/g, '')
              .replace(/\[Image #\d+\]\s*/g, '')
              .trim();
          }
          if (!text && images.length === 0) return;

          // Remove previous reaction
          if (currentReactionId && lastUserMsgId) {
            removeReaction(feishu.channel, lastUserMsgId, currentReactionId).catch(() => {});
            currentReactionId = undefined;
          }

          try {
            let msgId: string | null = null;
            if (images.length > 0) {
              msgId = await feishu.sendPost(feishuChatId, text || '', images, threadOpts);
            } else {
              msgId = await feishu.sendText(feishuChatId, text!, threadOpts);
            }
            if (!threadMsgId && msgId) threadMsgId = msgId;
            if (msgId) {
              lastUserMsgId = msgId;
              currentReactionId = await addWorkingReaction(feishu.channel, msgId);
            }
          } catch {}
          return;
        }

        if (msg.type === 'assistant') {
          if (!cardStream) {
            cardState = emptyCardState();
            try {
              cardStream = await feishu.streamCard(feishuChatId, renderCardJson(cardState, false), threadOpts);
            } catch {}
          }

          cardState = reduceMessage(cardState, msg);
          const turnDone = msg.stopReason === 'end_turn';

          if (turnDone) {
            if (cardStream) {
              try { await cardStream.update(renderCardJson(cardState, true)); } catch {}
            }
            cardStream = null;
            cardState = emptyCardState();
            // Remove reaction on completion
            if (currentReactionId && lastUserMsgId) {
              removeReaction(feishu.channel, lastUserMsgId, currentReactionId).catch(() => {});
              currentReactionId = undefined;
            }
          } else {
            scheduleCardUpdate();
          }
        }
      },

      onRemoteEvent: async (evt) => {
        // Terminal display
        if (evt.type === 'text') {
          process.stdout.write(evt.content);
        } else if (evt.type === 'tool_use') {
          console.log(`\n  🔧 ${evt.name}`);
        } else if (evt.type === 'result') {
          console.log('\n\n  ✅ Done\n');
          console.log('  👉 Press any key to take back control\n');
        }

        // Feishu card
        if (!feishu || !feishuChatId) return;
        if (evt.type === 'text') {
          if (!cardStream) {
            cardState = emptyCardState();
            const threadOpts = threadMsgId
              ? { replyTo: threadMsgId, replyInThread: true }
              : {};
            try {
              cardStream = await feishu.streamCard(feishuChatId, renderCardJson(cardState, false), threadOpts);
            } catch {}
          }
          cardState = appendText(cardState, evt.content);
          scheduleCardUpdate();
        }
        if (evt.type === 'result') {
          if (cardStream) {
            try { await cardStream.update(renderCardJson(cardState, true)); } catch {}
          }
          cardStream = null;
          cardState = emptyCardState();
        }
      },

      onModeChange: (mode) => {
        inRemoteMode = mode === 'remote';
        cardStream = null;
        cardState = emptyCardState();
        if (mode === 'remote') {
          console.log('\n\n  📱 Remote Mode — Feishu is in control\n');
          console.log('  Press any key to take back control');
          console.log('  Ctrl+C to exit\n');
          console.log('  ─────────────────────────────────────\n');
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
  .option('--create-group [name]', 'Create a new topic group and set as default')
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

    if (opts.createGroup !== undefined) {
      if (!cfg.feishu) {
        console.error('No Feishu config. Run `agent-bridge config` first.');
        process.exit(1);
      }
      const { setupTopicGroup } = await import('../feishu/wizard');
      const chatId = await setupTopicGroup({
        appId: cfg.feishu.appId,
        appSecret: cfg.feishu.appSecret,
        tenant: cfg.feishu.tenant,
        inviteOpenId: cfg.feishu.operatorOpenId,
      });
      if (chatId) {
        cfg.feishu.chatId = chatId;
        saveConfig(cfg);
        console.log(`配置已保存到 ${configPath()}`);
      }
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
        inviteOpenId: f.operatorOpenId,
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
  .description('Bridge an existing Claude Code session to Feishu (two-way: reply in the thread to drive it)')
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

    if (!hasFeishuConfig()) {
      console.error('Feishu not configured. Run: agent-bridge config');
      process.exit(1);
    }
    const cfg = loadConfig();
    const chatId = cfg.feishu!.chatId;
    if (!chatId) {
      console.error('No topic group Chat ID. Run: agent-bridge config --create-group');
      process.exit(1);
    }

    const log = (msg: string) => console.log(`${new Date().toLocaleTimeString()} ${msg}`);

    let feishu: FeishuBridge;
    try {
      feishu = await startFeishuBridge(cfg.feishu!, {
        onMessage: (msg: NormalizedMessage) => {
          if (msg.chatId !== chatId) return;
          const text = msg.content.trim();
          if (!text) return;

          const raw = msg as any;
          const rootId = raw.rootId ?? raw.root_id;
          const userMsgId = raw.messageId ?? raw.message_id;

          // Relay mode serves only the adopted session: route threaded replies,
          // ignore non-threaded messages (no Feishu-initiated new sessions here).
          if (rootId) {
            manager.handleFeishuMessage(chatId, rootId, text, userMsgId).catch((err) => {
              log(`[error] handleFeishuMessage failed: ${err}`);
            });
          }
        },
      });
      console.log('  Feishu bridge connected.');
    } catch (err) {
      console.error(`Feishu connection failed: ${err}`);
      process.exit(1);
    }

    const manager = new SessionManager({
      feishu,
      chatId,
      defaultCwd: target.cwd,
      log,
    });

    if (target.status === 'busy') {
      console.warn('  ⚠️  Session is mid-output — Feishu will only show the tail of the current turn.');
    }

    const adopted = await manager.adoptLocalSession(target.sessionId, target.cwd, target.pid);
    if (!adopted) {
      console.error('  This session is already bridged by another agent-bridge process (serve or another relay). Stop that one first.');
      await feishu.disconnect();
      process.exit(1);
    }
    console.log('  Bridged to Feishu. Reply in the thread to drive the session.');
    console.log('  Keep this laptop awake. Ctrl+C to stop.\n');

    const shutdown = async () => {
      await manager.shutdown();
      await feishu.disconnect();
      console.log('\nRelay stopped.');
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await new Promise(() => {});
  });

program.parse();
